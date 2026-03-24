#!/usr/bin/env bash
#
# cc-dispatch.sh — Multi-stage agent dispatcher for Atlas (Mac Mini)
#
# Polls GitHub for issues with dispatch labels and routes them to
# the appropriate Claude Code agent persona.
#
# Labels → Agents:
#   ready-for-cc        → generic CC (no agent)     → creates branch + PR
#   ready-for-impl      → implementer agent         → creates branch + PR
#   ready-for-red-team  → red-team agent            → posts issue comment
#   ready-for-security  → security-reviewer agent   → posts PR review
#   ready-for-qa        → qa-reviewer agent         → posts PR review
#
# Usage:
#   ./cc-dispatch.sh                    # One-shot: process all ready issues
#   ./cc-dispatch.sh --watch [SECONDS]  # Poll loop (default 300s = 5 min)
#   ./cc-dispatch.sh --dry-run          # Show what would happen, don't execute
#
# Requirements:
#   - gh CLI authenticated (gh auth login)
#   - claude CLI on PATH
#   - Git repo cloned at REPO_DIR
#
# Config: edit these or set env vars before running.

REPO="${GITHUB_DEFAULT_REPO:-ryanthegentry/402index}"
REPO_DIR="${REPO_DIR:-$HOME/projects/402index}"
LOG_DIR="${LOG_DIR:-$HOME/agent-state/dispatch-logs}"
DRY_RUN=false
WATCH=false
POLL_INTERVAL=300

# All dispatch labels the script watches for
DISPATCH_LABELS=(
    ready-for-cc
    ready-for-impl
    ready-for-red-team
    ready-for-security
    ready-for-qa
)

# ── Label → config mappings ──────────────────────────────────────
# Using functions instead of associative arrays for bash 3.x compat (macOS)

get_agent() {
    case "$1" in
        ready-for-cc)       echo "" ;;
        ready-for-impl)     echo "implementer" ;;
        ready-for-red-team) echo "red-team" ;;
        ready-for-security) echo "security-reviewer" ;;
        ready-for-qa)       echo "qa-reviewer" ;;
    esac
}

get_mode() {
    case "$1" in
        ready-for-cc|ready-for-impl)     echo "implement" ;;
        ready-for-red-team)              echo "review-issue" ;;
        ready-for-security|ready-for-qa) echo "review-pr" ;;
    esac
}

get_done_label() {
    case "$1" in
        ready-for-cc|ready-for-impl) echo "needs-review" ;;
        ready-for-red-team)          echo "red-team-complete" ;;
        ready-for-security|ready-for-qa) echo "" ;;
    esac
}

# ── Parse args ─────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --watch)
            WATCH=true
            if [[ "${2:-}" =~ ^[0-9]+$ ]]; then
                POLL_INTERVAL="$2"; shift
            fi
            shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# ── Helpers ────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { log "ERROR: $*" >&2; }

ensure_deps() {
    for cmd in gh claude git; do
        command -v "$cmd" &>/dev/null || { err "$cmd not found on PATH"; exit 1; }
    done
    gh auth status &>/dev/null || { err "gh not authenticated. Run: gh auth login"; exit 1; }
}

# Find the open PR associated with an issue number.
# Tries title search first, falls back to issue timeline API.
find_pr_for_issue() {
    local issue_number="$1"
    local pr_number

    # Search for open PRs referencing this issue number
    pr_number=$(gh pr list --repo "$REPO" --state open \
        --search "#${issue_number}" \
        --json number -q '.[0].number' 2>/dev/null)

    if [[ -n "$pr_number" ]]; then
        echo "$pr_number"
        return 0
    fi

    # Fallback: check issue timeline for cross-referenced PRs
    pr_number=$(gh api "repos/${REPO}/issues/${issue_number}/timeline" \
        --jq '[.[] | select(.event == "cross-referenced") | .source.issue | select(.pull_request != null) | .number] | last' 2>/dev/null)

    if [[ -n "$pr_number" && "$pr_number" != "null" ]]; then
        echo "$pr_number"
        return 0
    fi

    return 1
}

# Re-apply dispatch label on failure
rollback_issue() {
    local issue_number="$1"
    local dispatch_label="$2"
    local logfile="${3:-}"
    local exit_code="${4:-}"

    if [[ -n "$exit_code" && -n "$logfile" ]]; then
        gh issue comment "$issue_number" --repo "$REPO" \
            --body "⚠️ CC dispatch failed (exit ${exit_code}). Check logs: ${logfile}"
    fi

    gh issue edit "$issue_number" --repo "$REPO" \
        --remove-label "in-progress" --add-label "$dispatch_label"
}

mkdir -p "$LOG_DIR"

# ── Implement mode: branch → CC → commit → PR ────────────────────
dispatch_implement() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"
    local branch="fix/issue-${issue_number}"

    cd "$REPO_DIR" || { err "Can't cd to $REPO_DIR"; return 1; }
    git checkout main && git pull origin main

    # Create or switch to feature branch
    git checkout -b "$branch" 2>/dev/null || git checkout "$branch"

    local main_sha
    main_sha=$(git rev-parse main)

    # Build prompt — agent personas have their own system prompts
    local cc_prompt
    if [[ -n "$agent_flag" ]]; then
        cc_prompt="Fix GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

Follow your implementation protocol. Issue #${issue_number} in repo ${REPO}."
    else
        cc_prompt="Fix GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

INSTRUCTIONS:
1. Read the relevant source files and understand the problem.
2. Implement the fix with minimal, focused changes.
3. Run any existing tests to verify nothing breaks.
4. Do NOT commit yet — I will review the changes first.

When done, summarize what you changed and why."
    fi

    log "Starting CC implement session (logging to ${logfile})"
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile"
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC exited with code ${cc_exit} for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        git checkout main
        return 1
    fi

    # Check if CC made changes (agent may have committed, or left uncommitted)
    local has_new_commits=false
    local has_uncommitted=false

    if [ "$(git rev-parse HEAD)" != "$main_sha" ]; then
        has_new_commits=true
    fi
    if ! git diff --quiet || ! git diff --cached --quiet; then
        has_uncommitted=true
    fi

    if ! $has_new_commits && ! $has_uncommitted; then
        log "CC made no changes for issue #${issue_number}"
        gh issue comment "$issue_number" --repo "$REPO" \
            --body "CC analyzed the issue but made no code changes. May need manual intervention."
        rollback_issue "$issue_number" "$dispatch_label"
        git checkout main
        return 0
    fi

    # Stage and commit any uncommitted changes (skip if agent already committed)
    if $has_uncommitted; then
        git add -A
        git commit -m "fix: resolve issue #${issue_number} — ${issue_title}

Automated fix by Claude Code dispatch pipeline.
Closes #${issue_number}

Co-Authored-By: Claude Code <noreply@anthropic.com>"
    fi

    git push -u origin "$branch"

    local pr_url
    pr_url=$(gh pr create --repo "$REPO" \
        --title "fix: #${issue_number} — ${issue_title}" \
        --body "## Summary
Automated fix for #${issue_number}.

## Changes
See diff below. Generated by CC dispatch pipeline.

## Linked Issue
Closes #${issue_number}

---
*Dispatched by cc-dispatch.sh at $(date '+%Y-%m-%d %H:%M:%S')*" \
        --head "$branch" --base main)

    if [ -n "$pr_url" ]; then
        log "PR created: ${pr_url}"
        local pr_number
        pr_number=$(echo "$pr_url" | grep -o '[0-9]*$')
        if [[ -n "$done_label" ]]; then
            gh pr edit "$pr_number" --repo "$REPO" --add-label "$done_label" 2>/dev/null
        fi
        gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
        gh issue comment "$issue_number" --repo "$REPO" --body "PR opened: ${pr_url}"
    else
        err "Failed to create PR for issue #${issue_number}"
    fi

    git checkout main
}

# ── Review-issue mode: CC reviews spec, posts issue comment ───────
dispatch_review_issue() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"

    cd "$REPO_DIR" || { err "Can't cd to $REPO_DIR"; return 1; }

    local cc_prompt="Review GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

Follow your review protocol. Post findings as a comment on issue #${issue_number} in repo ${REPO}."

    log "Starting CC review-issue session (logging to ${logfile})"
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile"
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC review failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
    if [[ -n "$done_label" ]]; then
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$done_label"
    fi

    log "Review complete for issue #${issue_number}"
}

# ── Review-PR mode: CC reviews the linked PR ─────────────────────
dispatch_review_pr() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"

    cd "$REPO_DIR" || { err "Can't cd to $REPO_DIR"; return 1; }

    # Find the PR linked to this issue
    local pr_number
    pr_number=$(find_pr_for_issue "$issue_number")

    if [[ -z "$pr_number" ]]; then
        err "No open PR found for issue #${issue_number}"
        gh issue comment "$issue_number" --repo "$REPO" \
            --body "⚠️ CC dispatch: no open PR found to review for this issue."
        rollback_issue "$issue_number" "$dispatch_label"
        return 1
    fi

    log "Found PR #${pr_number} for issue #${issue_number}"

    local cc_prompt="Review PR #${pr_number} which addresses issue #${issue_number}: ${issue_title}

ISSUE SPEC:
${issue_body}

Follow your review protocol. PR #${pr_number} in repo ${REPO}."

    log "Starting CC review-pr session (logging to ${logfile})"
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile"
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC PR review failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Just remove in-progress — the review itself (APPROVE/REQUEST_CHANGES) is the output
    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
    if [[ -n "$done_label" ]]; then
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$done_label"
    fi

    log "PR review complete for issue #${issue_number} (PR #${pr_number})"
}

# ── Core dispatch (routes to the right mode) ──────────────────────
dispatch_issue() {
    local issue_number="$1"
    local issue_title="$2"
    local dispatch_label="$3"

    local agent mode done_label
    agent=$(get_agent "$dispatch_label")
    mode=$(get_mode "$dispatch_label")
    done_label=$(get_done_label "$dispatch_label")
    local logfile="${LOG_DIR}/issue-${issue_number}-${dispatch_label}-$(date '+%Y%m%d-%H%M%S').log"

    local agent_flag=""
    if [[ -n "$agent" ]]; then
        agent_flag="--agent $agent"
    fi

    log "Dispatching #${issue_number} [${dispatch_label} → ${mode}]: ${issue_title}"

    if $DRY_RUN; then
        log "[DRY RUN] agent=${agent:-generic} mode=${mode} done_label=${done_label:-none}"
        return 0
    fi

    # Swap label: dispatch → in-progress
    gh issue edit "$issue_number" --repo "$REPO" \
        --remove-label "$dispatch_label" --add-label "in-progress" 2>/dev/null

    # Read the full issue body
    local issue_body
    issue_body=$(gh issue view "$issue_number" --repo "$REPO" --json body -q '.body')

    # Route to the appropriate handler
    case "$mode" in
        implement)
            dispatch_implement "$issue_number" "$issue_title" "$issue_body" \
                "$agent_flag" "$dispatch_label" "$done_label" "$logfile"
            ;;
        review-issue)
            dispatch_review_issue "$issue_number" "$issue_title" "$issue_body" \
                "$agent_flag" "$dispatch_label" "$done_label" "$logfile"
            ;;
        review-pr)
            dispatch_review_pr "$issue_number" "$issue_title" "$issue_body" \
                "$agent_flag" "$dispatch_label" "$done_label" "$logfile"
            ;;
    esac
}

# ── Main loop ──────────────────────────────────────────────────────
run_once() {
    local total=0

    for label in "${DISPATCH_LABELS[@]}"; do
        log "Scanning ${REPO} for '${label}'..."

        local issues
        issues=$(gh issue list --repo "$REPO" --label "$label" --state open \
            --json number,title --jq '.[] | "\(.number)\t\(.title)"')

        if [ -z "$issues" ]; then
            continue
        fi

        while IFS=$'\t' read -r number title; do
            dispatch_issue "$number" "$title" "$label"
            total=$((total + 1))
        done <<< "$issues"
    done

    if [ "$total" -eq 0 ]; then
        log "No dispatch labels found. Nothing to do."
    else
        log "Dispatched ${total} issue(s)."
    fi
}

# ── Entry point ────────────────────────────────────────────────────
ensure_deps

if $WATCH; then
    log "Watch mode: polling every ${POLL_INTERVAL}s (${#DISPATCH_LABELS[@]} labels). Ctrl-C to stop."
    while true; do
        run_once
        log "Sleeping ${POLL_INTERVAL}s..."
        sleep "$POLL_INTERVAL"
    done
else
    run_once
fi

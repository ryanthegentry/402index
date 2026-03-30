#!/usr/bin/env bash
#
# cc-dispatch.sh — Multi-stage agent dispatcher for Atlas (Mac Mini)
#
# Polls GitHub for issues with dispatch labels and routes them to
# the appropriate Claude Code agent persona.
#
# Labels → Agents:
#   ready-for-chore     → generic CC (no agent)     → creates branch + PR
#   ready-for-impl      → implementer agent         → creates branch + PR
#   ready-for-red-team  → red-team agent            → posts findings on the issue (pre-impl spec review)
#   ready-for-security  → security-reviewer agent   → posts PR review
#   ready-for-qa        → qa-reviewer agent         → posts PR review
#   ready-for-revision  → implementer agent         → pushes fixes to existing PR
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
DEFAULT_BRANCH="${DEFAULT_BRANCH:-$(cd "$REPO_DIR" 2>/dev/null && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo master)}"
BOT_TOKEN_FILE="${BOT_TOKEN_FILE:-$HOME/.bot-token}"
DRY_RUN=false
WATCH=false
POLL_INTERVAL=300
MAX_REVISIONS=3

# All dispatch labels the script watches for
DISPATCH_LABELS=(
    ready-for-chore
    ready-for-impl
    ready-for-red-team
    ready-for-security
    ready-for-qa
    ready-for-revision
)

# ── Label → config mappings ──────────────────────────────────────
# Using functions instead of associative arrays for bash 3.x compat (macOS)

get_agent() {
    case "$1" in
        ready-for-chore)       echo "" ;;
        ready-for-impl)     echo "implementer" ;;
        ready-for-red-team) echo "red-team" ;;
        ready-for-security) echo "security-reviewer" ;;
        ready-for-qa)       echo "qa-reviewer" ;;
        ready-for-revision) echo "implementer" ;;
    esac
}

get_mode() {
    case "$1" in
        ready-for-chore|ready-for-impl)  echo "implement" ;;
        ready-for-red-team)              echo "review-issue" ;;
        ready-for-security|ready-for-qa) echo "review-pr" ;;
        ready-for-revision)              echo "revise" ;;
    esac
}

get_done_label() {
    case "$1" in
        ready-for-chore)                 echo "needs-review" ;;
        ready-for-impl)                  echo "" ;;  # chaining handles next step
        ready-for-red-team)              echo "red-team-complete" ;;
        ready-for-security|ready-for-qa) echo "" ;;
        ready-for-revision)              echo "" ;;
    esac
}

# Pipeline chaining: after a stage completes, what label triggers next?
#
# Flow: Issue → Red-team (spec review) → [HUMAN GATE] → Implementer → Security → QA → Merge
#       If security/QA request changes: → Revision → Security → QA → Merge
#
# Red-team reviews the spec and stops. Ryan + Cowork synthesize red-team
# findings into the issue body, then manually label ready-for-impl.
# From there, implementation → reviews → merge is fully automated.
get_next_stage_label() {
    case "$1" in
        ready-for-red-team)                echo "" ;;  # HUMAN GATE: Ryan synthesizes findings
        ready-for-chore|ready-for-impl)    echo "ready-for-security" ;;
        ready-for-security)                echo "ready-for-qa" ;;
        ready-for-qa)                      echo "ready-to-merge" ;;
        ready-for-revision)                echo "ready-for-security" ;;
    esac
}

# After a dispatch stage completes successfully, auto-chain to next stage
chain_next_stage() {
    local issue_number="$1"
    local current_label="$2"
    local next_label
    next_label=$(get_next_stage_label "$current_label")

    if [[ -n "$next_label" ]]; then
        log "Chaining: #${issue_number} → ${next_label}"
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$next_label"
    fi
}

# Parse review verdict from CC output text.
# The script tells agents to output VERDICT:APPROVE or VERDICT:REQUEST_CHANGES.
# Falls back to keyword matching if no explicit verdict marker found.
# Falls back to GitHub API as last resort.
parse_verdict_from_output() {
    local cc_output="$1"
    local pr_number="$2"

    # Priority 1: explicit verdict marker (most reliable — deterministic grep)
    if echo "$cc_output" | grep -q 'VERDICT:APPROVE'; then
        echo "APPROVED"
        return
    fi
    if echo "$cc_output" | grep -q 'VERDICT:REQUEST_CHANGES'; then
        echo "CHANGES_REQUESTED"
        return
    fi

    # Priority 2: keyword matching on review headers (agents format with these)
    if echo "$cc_output" | grep -qi 'APPROVED\|Security Review: APPROVED\|QA Review: APPROVED'; then
        # Make sure it's not "CHANGES REQUESTED" which also contains "APPROVED" substring? No it doesn't. Safe.
        if echo "$cc_output" | grep -qi 'CHANGES REQUESTED\|REQUEST_CHANGES\|CHANGES_REQUESTED'; then
            echo "CHANGES_REQUESTED"
            return
        fi
        echo "APPROVED"
        return
    fi
    if echo "$cc_output" | grep -qi 'CHANGES REQUESTED\|REQUEST_CHANGES\|CHANGES_REQUESTED'; then
        echo "CHANGES_REQUESTED"
        return
    fi

    # Priority 3: check GitHub API for formal review (agent might have posted one)
    local latest_state
    latest_state=$(gh pr view "$pr_number" --repo "$REPO" --json reviews \
        --jq '[.reviews[] | select(.author.login == "402index-bot")] | last | .state' 2>/dev/null)
    echo "${latest_state:-COMMENTED}"
}

# Submit a formal PR review on behalf of the bot.
# This is deterministic — the script always posts the review, not the agent.
submit_review() {
    local pr_number="$1"
    local verdict="$2"
    local review_body="$3"

    case "$verdict" in
        APPROVED)
            gh pr review "$pr_number" --repo "$REPO" --approve \
                --body "$review_body" 2>/dev/null
            ;;
        CHANGES_REQUESTED)
            gh pr review "$pr_number" --repo "$REPO" --request-changes \
                --body "$review_body" 2>/dev/null
            ;;
        *)
            # Unknown verdict — post as comment, don't approve or reject
            gh pr review "$pr_number" --repo "$REPO" --comment \
                --body "$review_body" 2>/dev/null
            ;;
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

    # Export bot token so claude --print subprocesses use the bot identity for gh commands
    if [[ -f "$BOT_TOKEN_FILE" ]]; then
        export GH_TOKEN
        GH_TOKEN=$(cat "$BOT_TOKEN_FILE")
        log "Bot token loaded from ${BOT_TOKEN_FILE}"
    else
        log "WARNING: Bot token not found at ${BOT_TOKEN_FILE} — agents will use default gh auth"
    fi
}

ensure_labels() {
    local labels=(
        "ready-for-chore:FBCA04:Dispatch: generic chore"
        "ready-for-impl:FBCA04:Dispatch: implementation"
        "ready-for-red-team:D93F0B:Dispatch: red-team review"
        "ready-for-security:D93F0B:Dispatch: security review"
        "ready-for-qa:D93F0B:Dispatch: QA review"
        "ready-for-revision:D93F0B:Dispatch: revision (address review feedback)"
        "ready-to-merge:0E8A16:Pipeline complete — ready for human merge"
        "in-progress:1D76DB:Agent working"
        "needs-review:0075CA:Implementation complete — needs review"
        "red-team-complete:0075CA:Red-team review complete"
        "needs-manual-review:B60205:Revision limit reached — needs human review"
    )
    for entry in "${labels[@]}"; do
        IFS=: read -r name color desc <<< "$entry"
        gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force 2>/dev/null
    done
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
    git checkout "$DEFAULT_BRANCH" && git pull origin "$DEFAULT_BRANCH"

    # Create or switch to feature branch
    git checkout -b "$branch" 2>/dev/null || git checkout "$branch"

    local main_sha
    main_sha=$(git rev-parse "$DEFAULT_BRANCH")

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
    local cc_output
    # shellcheck disable=SC2086
    cc_output=$(echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile")
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC exited with code ${cc_exit} for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        git checkout "$DEFAULT_BRANCH"
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
        git checkout "$DEFAULT_BRANCH"
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

    # Extract the implementer's summary from CC output (last ~80 lines before git noise)
    local cc_summary
    cc_summary=$(echo "$cc_output" | grep -v '^\[' | grep -v '^Enumerating\|^Counting\|^Compressing\|^Writing\|^Delta\|^Total\|^remote:\|^To github\|^branch\|^ \*' | tail -80)
    # Truncate to ~4000 chars to stay within GitHub's limits
    cc_summary="${cc_summary:0:4000}"

    local pr_url
    pr_url=$(gh pr create --repo "$REPO" \
        --title "fix: #${issue_number} — ${issue_title}" \
        --body "$(cat <<PRBODY
## Summary

Automated fix for #${issue_number}: ${issue_title}

## What changed

${cc_summary}

## Linked Issue

Closes #${issue_number}

---
*Dispatched by cc-dispatch.sh at $(date '+%Y-%m-%d %H:%M:%S')*
PRBODY
)" \
        --head "$branch" --base "$DEFAULT_BRANCH")

    if [ -n "$pr_url" ]; then
        log "PR created: ${pr_url}"
        local pr_number
        pr_number=$(echo "$pr_url" | grep -o '[0-9]*$')
        if [[ -n "$done_label" ]]; then
            gh pr edit "$pr_number" --repo "$REPO" --add-label "$done_label" 2>/dev/null
        fi
        gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
        gh issue comment "$issue_number" --repo "$REPO" --body "PR opened: ${pr_url}"
        chain_next_stage "$issue_number" "$dispatch_label"
    else
        err "Failed to create PR for issue #${issue_number}"
    fi

    git checkout "$DEFAULT_BRANCH"
}

# ── Review-issue mode: CC reviews spec, posts findings on the issue (pre-impl spec review) ──
dispatch_review_issue() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"

    cd "$REPO_DIR" || { err "Can't cd to $REPO_DIR"; return 1; }

    # Defensive: check if a PR already exists (e.g., someone labeled ready-for-red-team
    # after a PR was created). We still post to the issue regardless, but include this
    # info in the prompt so the agent knows.
    local pr_number
    pr_number=$(find_pr_for_issue "$issue_number")

    local cc_prompt="Review GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

Follow your review protocol. Post findings as a comment on issue #${issue_number} in repo ${REPO}."

    log "Starting CC review-issue session (logging to ${logfile})"
    local cc_output
    # shellcheck disable=SC2086
    cc_output=$(echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile")
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC review failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Always post CC output to the issue unconditionally
    local tmpfile
    tmpfile=$(mktemp)
    echo "$cc_output" | grep -v '^\[' | tail -100 > "$tmpfile"
    if [ -s "$tmpfile" ]; then
        head -c 4000 "$tmpfile" > "${tmpfile}.trunc" && mv "${tmpfile}.trunc" "$tmpfile"
        gh issue comment "$issue_number" --repo "$REPO" --body-file "$tmpfile" 2>/dev/null
    fi
    rm -f "$tmpfile"

    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
    if [[ -n "$done_label" ]]; then
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$done_label"
    fi
    chain_next_stage "$issue_number" "$dispatch_label"

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

    # Collect prior review context: PR comments + formal reviews
    local prior_pr
    prior_pr=$(gh pr view "$pr_number" --repo "$REPO" --json comments,reviews \
        --jq '([.comments[] | "**\(.author.login)** (comment):\n\(.body)"] + [.reviews[] | select(.body != "") | "**\(.author.login)** (review, \(.state)):\n\(.body)"]) | join("\n\n---\n\n")' 2>/dev/null)

    # Collect issue comments (where red-team posted findings)
    local prior_issue
    prior_issue=$(gh issue view "$issue_number" --repo "$REPO" --json comments \
        --jq '[.comments[] | "**\(.author.login)** (issue comment):\n\(.body)"] | join("\n\n---\n\n")' 2>/dev/null)

    local review_context=""
    if [[ -n "$prior_pr" || -n "$prior_issue" ]]; then
        review_context="
PRIOR REVIEW CONTEXT:"
        if [[ -n "$prior_issue" ]]; then
            review_context="${review_context}

ISSUE COMMENTS (including red-team findings):
${prior_issue}"
        fi
        if [[ -n "$prior_pr" ]]; then
            review_context="${review_context}

PR COMMENTS AND REVIEWS:
${prior_pr}"
        fi
        review_context="${review_context}

Consider these findings in your review. Do not duplicate work already covered, but verify the claims and check for anything missed."
    fi

    local cc_prompt="Review PR #${pr_number} which addresses issue #${issue_number}: ${issue_title}

ISSUE SPEC:
${issue_body}
${review_context}

Follow your review protocol. Analyze the code thoroughly.

IMPORTANT — OUTPUT FORMAT:
Do NOT run gh pr review yourself. Instead, output your verdict as a marker line:
  VERDICT:APPROVE        — if the code is safe and correct
  VERDICT:REQUEST_CHANGES — if there are security, correctness, or coverage issues

The dispatch script will submit the formal GitHub review on your behalf.
Include your full analysis above the verdict line. PR #${pr_number} in repo ${REPO}."

    log "Starting CC review-pr session (logging to ${logfile})"
    local cc_output
    # shellcheck disable=SC2086
    cc_output=$(echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile")
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC PR review failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Parse verdict from CC output (deterministic — no reliance on agent running gh commands)
    local verdict
    verdict=$(parse_verdict_from_output "$cc_output" "$pr_number")
    log "Parsed verdict: ${verdict}"

    # Extract clean review body from CC output
    local tmpfile
    tmpfile=$(mktemp)
    echo "$cc_output" | grep -v '^\[' | grep -v '^VERDICT:' | tail -100 > "$tmpfile"
    if [ -s "$tmpfile" ]; then
        head -c 4000 "$tmpfile" > "${tmpfile}.trunc" && mv "${tmpfile}.trunc" "$tmpfile"
        # Script submits the formal review — not the agent
        submit_review "$pr_number" "$verdict" "$(cat "$tmpfile")"
        log "Formal review submitted: ${verdict}"
    fi
    rm -f "$tmpfile"

    # Remove in-progress label
    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
    if [[ -n "$done_label" ]]; then
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$done_label"
    fi

    # Chain based on parsed verdict
    if [[ "$verdict" == "APPROVED" ]]; then
        chain_next_stage "$issue_number" "$dispatch_label"
    elif [[ "$verdict" == "CHANGES_REQUESTED" ]]; then
        log "Reviewer requested changes on PR #${pr_number} — routing to revision"
        gh issue edit "$issue_number" --repo "$REPO" --add-label "ready-for-revision"
    else
        log "Reviewer verdict unclear (${verdict}) — routing to revision for safety"
        gh issue edit "$issue_number" --repo "$REPO" --add-label "ready-for-revision"
    fi

    log "PR review complete for issue #${issue_number} (PR #${pr_number})"
}

# ── Revise mode: read review feedback, push fixes to existing PR ──
dispatch_revise() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"

    cd "$REPO_DIR" || { err "Can't cd to $REPO_DIR"; return 1; }

    # Find the existing PR
    local pr_number
    pr_number=$(find_pr_for_issue "$issue_number")
    if [[ -z "$pr_number" ]]; then
        err "No open PR found for issue #${issue_number} — cannot revise"
        rollback_issue "$issue_number" "$dispatch_label"
        return 1
    fi

    # Check revision count (count how many times ready-for-revision was applied)
    local revision_count
    revision_count=$(gh api "repos/${REPO}/issues/${issue_number}/events" \
        --jq '[.[] | select(.event == "labeled" and .label.name == "ready-for-revision")] | length' 2>/dev/null || echo "0")

    if [[ "$revision_count" -ge "$MAX_REVISIONS" ]]; then
        log "Max revisions (${MAX_REVISIONS}) reached for issue #${issue_number} — bailing to manual review"
        gh issue edit "$issue_number" --repo "$REPO" \
            --remove-label "in-progress" --add-label "needs-manual-review"
        gh issue comment "$issue_number" --repo "$REPO" \
            --body "⚠️ Max revision cycles (${MAX_REVISIONS}) reached. Needs human review."
        return 0
    fi

    log "Revision cycle ${revision_count}/${MAX_REVISIONS} for PR #${pr_number}"

    # Get the branch name from the PR
    local branch
    branch=$(gh pr view "$pr_number" --repo "$REPO" --json headRefName -q '.headRefName')

    # Checkout the existing branch and pull latest
    git fetch origin "$branch"
    git checkout "$branch"
    git pull origin "$branch"

    # Collect ALL review feedback: formal reviews + comments + issue comments
    local review_feedback
    review_feedback=$(gh pr view "$pr_number" --repo "$REPO" --json comments,reviews \
        --jq '([.reviews[] | select(.body != "") | "**\(.author.login)** (\(.state)):\n\(.body)"] + [.comments[] | "**\(.author.login)** (comment):\n\(.body)"]) | join("\n\n---\n\n")' 2>/dev/null)

    local cc_prompt="You are revising PR #${pr_number} for issue #${issue_number}: ${issue_title}

ISSUE SPEC:
${issue_body}

REVIEWER FEEDBACK (address ALL of these):
${review_feedback}

INSTRUCTIONS:
1. Read the reviewer feedback above carefully. Understand every finding.
2. For each finding, write or update a test that would catch the issue.
3. Implement the fixes.
4. Run npm test — all tests must pass.
5. Commit with message: fix: address review feedback for #${issue_number} (revision ${revision_count})
6. Do NOT create a new PR. Push to the existing branch.

This is revision ${revision_count} of ${MAX_REVISIONS}. If you cannot fully address all findings, comment on the PR explaining what remains and why."

    log "Starting CC revise session (logging to ${logfile})"
    local cc_output
    # shellcheck disable=SC2086
    cc_output=$(echo "$cc_prompt" | claude --print $agent_flag 2>&1 | tee "$logfile")
    local cc_exit=$?

    if [ $cc_exit -ne 0 ]; then
        err "CC revise failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        git checkout "$DEFAULT_BRANCH"
        return 1
    fi

    # Stage and commit any uncommitted changes
    if ! git diff --quiet || ! git diff --cached --quiet; then
        git add -A
        git commit -m "fix: address review feedback for #${issue_number} (revision ${revision_count})

Co-Authored-By: Claude Code <noreply@anthropic.com>"
    fi

    # Push to the existing branch (no new PR needed)
    git push origin "$branch"

    # Post revision summary to PR
    local tmpfile
    tmpfile=$(mktemp)
    echo "$cc_output" | grep -v '^\[' | tail -100 > "$tmpfile"
    if [ -s "$tmpfile" ]; then
        head -c 4000 "$tmpfile" > "${tmpfile}.trunc" && mv "${tmpfile}.trunc" "$tmpfile"
        gh pr comment "$pr_number" --repo "$REPO" --body-file "$tmpfile" 2>/dev/null
    fi
    rm -f "$tmpfile"

    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"

    # Chain back to security review
    chain_next_stage "$issue_number" "$dispatch_label"

    git checkout "$DEFAULT_BRANCH"
    log "Revision complete for issue #${issue_number} (PR #${pr_number})"
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
        revise)
            dispatch_revise "$issue_number" "$issue_title" "$issue_body" \
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
ensure_labels

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

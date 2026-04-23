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
#   - Branch protection: require "dispatch/review" status check to block
#     merge on failed bot reviews (configure in GitHub repo settings)
#
# Config: edit these or set env vars before running.

REPO="${GITHUB_DEFAULT_REPO:-ryanthegentry/402index}"
REPO_DIR="${REPO_DIR:-$HOME/projects/402index}"
LOG_DIR="${LOG_DIR:-$HOME/agent-state/dispatch-logs}"
AGENT_STATE_JOURNALS_DIR="${AGENT_STATE_JOURNALS_DIR:-$HOME/agent-state/projects/402index/journals}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:-$(cd "$REPO_DIR" 2>/dev/null && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo master)}"
BOT_TOKEN_FILE="${BOT_TOKEN_FILE:-$HOME/.bot-token}"
DRY_RUN=false
WATCH=false
POLL_INTERVAL=300
MAX_REVISIONS=3

# Per-stage session timeout (minutes). Wrapper subshells exceeding these are killed.
MAX_SESSION_MINUTES_REDTEAM=${MAX_SESSION_MINUTES_REDTEAM:-15}
MAX_SESSION_MINUTES_IMPL=${MAX_SESSION_MINUTES_IMPL:-90}
MAX_SESSION_MINUTES_SECURITY=${MAX_SESSION_MINUTES_SECURITY:-30}
MAX_SESSION_MINUTES_QA=${MAX_SESSION_MINUTES_QA:-30}
MAX_SESSION_MINUTES_CHORE=${MAX_SESSION_MINUTES_CHORE:-45}
MAX_SESSION_MINUTES_REVISION=${MAX_SESSION_MINUTES_REVISION:-90}
MIN_KILL_AGE_SECONDS=${MIN_KILL_AGE_SECONDS:-300}
KILL_GRACE_SECONDS=${KILL_GRACE_SECONDS:-15}
# Warning ratio — warn at (NUM/DEN) * threshold. Integer ratio for bash 3.x compat.
TIMEOUT_WARNING_RATIO_NUM=${TIMEOUT_WARNING_RATIO_NUM:-7}
TIMEOUT_WARNING_RATIO_DEN=${TIMEOUT_WARNING_RATIO_DEN:-10}

# MAX_CONCURRENT is a legacy env var — if set by the operator, apply_concurrency_config
# distributes it proportionally with a deprecation warning. Do NOT assign a default here;
# the detection logic in apply_concurrency_config must distinguish "user-set" from "unset".

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
# NOTE: Branch protection on master is pending a GitHub Pro upgrade (or making
# the repo public). Until then, required status checks and review requirements
# are not enforced by GitHub. The CI gate (wait_for_ci) in the review-pr
# handler provides in-pipeline enforcement as a substitute.
chain_next_stage() {
    local issue_number="$1"
    local current_label="$2"
    local next_label
    next_label=$(get_next_stage_label "$current_label")

    if [[ -n "$next_label" ]]; then
        log "Chaining: #${issue_number} → ${next_label}"
        local _chain_err
        if ! _chain_err=$(gh issue edit "$issue_number" --repo "$REPO" --add-label "$next_label" 2>&1 >/dev/null); then
            log "WARNING: chain_next_stage failed for issue #${issue_number} (${current_label} → ${next_label}) — gh: ${_chain_err}"
            return 1
        fi
    fi
}

# Wait for CI checks to pass on a PR. Returns 0 if all checks pass, 1 otherwise.
# Usage: wait_for_ci <pr_number> <issue_number> <timeout_seconds>
wait_for_ci() {
    local pr_number="$1"
    local issue_number="$2"
    local timeout="${3:-600}"  # default 10 minutes
    local interval=30
    local elapsed=0

    log "Waiting for CI checks on PR #${pr_number} (timeout: ${timeout}s)"

    while [[ $elapsed -lt $timeout ]]; do
        local status
        status=$(gh pr checks "$pr_number" --repo "$REPO" 2>&1) || true

        # Check if all checks have completed
        if echo "$status" | grep -qE 'fail|cancelled'; then
            log "CI failed on PR #${pr_number}"
            gh issue edit "$issue_number" --repo "$REPO" --add-label "ready-for-revision"
            gh issue comment "$issue_number" --repo "$REPO" \
                --body "⚠️ CI failed after QA approval on PR #${pr_number}. Routing to revision."
            return 1
        fi

        # All checks passed if no "pending" or "queued" entries remain
        if ! echo "$status" | grep -qiE 'pending|queued|in_progress|running'; then
            if echo "$status" | grep -qE 'pass'; then
                log "CI passed on PR #${pr_number}"
                return 0
            fi
        fi

        sleep "$interval"
        elapsed=$((elapsed + interval))
    done

    # Timeout
    log "CI timed out after ${timeout}s on PR #${pr_number}"
    gh issue edit "$issue_number" --repo "$REPO" --add-label "ready-for-revision"
    gh issue comment "$issue_number" --repo "$REPO" \
        --body "⚠️ CI did not complete within ${timeout}s after QA approval on PR #${pr_number}. Routing to revision."
    return 1
}

# Parse review verdict from CC output text.
# The script tells agents to output VERDICT:APPROVE or VERDICT:REQUEST_CHANGES.
# Falls back to keyword matching if no explicit verdict marker found.
# Falls back to GitHub API as last resort.
extract_verdict() {
    local output="$1"
    local pr_number="$2"

    # Get clean text from JSON envelope if present
    local text
    text=$(echo "$output" | jq -r '.result // empty' 2>/dev/null)
    [ -z "$text" ] && text="$output"

    # Tier 1: Explicit VERDICT marker (current format — exact match)
    local marker
    marker=$(echo "$text" | grep -oE 'VERDICT:(APPROVE|REQUEST_CHANGES)' | tail -1)
    if [ -n "$marker" ]; then
        echo "${marker#VERDICT:}"
        return 0
    fi

    # Tier 2: Common agent output patterns
    # Uses [[:space:]] instead of \s for POSIX ERE portability (macOS BSD grep)
    # Case-insensitive match requires "verdict" or "review" prefix to avoid false positives
    if echo "$text" | grep -qiE '(verdict|review)[:[:space:]]*approve[d]?' || echo "$text" | grep -q 'APPROVED'; then
        # Check for REQUEST_CHANGES first (takes priority over APPROVE in ambiguous output)
        if echo "$text" | grep -qiE '(verdict|review)[:[:space:]]*changes[[:space:]]*requested|REQUEST_CHANGES|CHANGES_REQUESTED|CHANGES REQUESTED'; then
            echo "REQUEST_CHANGES"
            return 0
        fi
        echo "APPROVE"
        return 0
    fi
    if echo "$text" | grep -qiE '(verdict|review)[:[:space:]]*changes[[:space:]]*requested|REQUEST_CHANGES|CHANGES_REQUESTED|CHANGES REQUESTED'; then
        echo "REQUEST_CHANGES"
        return 0
    fi

    # Tier 3: GitHub API fallback (last resort)
    local api_verdict
    api_verdict=$(gh api "repos/${REPO}/pulls/${pr_number}/reviews" \
        --jq '[.[] | select(.user.login == "402index-bot")] | last | .state' 2>/dev/null)
    case "$api_verdict" in
        APPROVED) echo "APPROVE"; return 0 ;;
        CHANGES_REQUESTED) echo "REQUEST_CHANGES"; return 0 ;;
    esac

    # No verdict found
    return 1
}

# Submit a formal PR review on behalf of the bot.
# Uses BOT_TOKEN so the review comes from 402index-bot (a different identity than
# the PR author, which is Ryan). This avoids GitHub's "can't review your own PR" error.
# Falls back to gh pr comment if the formal review fails for any reason.
submit_review() {
    local pr_number="$1"
    local verdict="$2"
    local review_body="$3"
    local review_ok=false
    local review_err=""

    if [[ -n "$BOT_TOKEN" ]]; then
        case "$verdict" in
            APPROVED)
                review_err=$(GH_TOKEN="$BOT_TOKEN" gh pr review "$pr_number" --repo "$REPO" --approve \
                    --body "$review_body" 2>&1) && review_ok=true
                ;;
            CHANGES_REQUESTED)
                review_err=$(GH_TOKEN="$BOT_TOKEN" gh pr review "$pr_number" --repo "$REPO" --request-changes \
                    --body "$review_body" 2>&1) && review_ok=true
                ;;
            *)
                review_err=$(GH_TOKEN="$BOT_TOKEN" gh pr review "$pr_number" --repo "$REPO" --comment \
                    --body "$review_body" 2>&1) && review_ok=true
                ;;
        esac
        if ! $review_ok; then
            log "Formal review failed for PR #${pr_number} (${verdict}): ${review_err}"
        fi
    else
        log "No bot token available — skipping formal review"
    fi

    # Fallback: if formal review failed (or no bot token), post as a regular comment
    if ! $review_ok; then
        log "Falling back to PR comment for PR #${pr_number}"
        local comment_err
        comment_err=$(gh pr comment "$pr_number" --repo "$REPO" \
            --body "**[${verdict}]** ${review_body}" 2>&1)
        if [[ $? -ne 0 ]]; then
            log "PR comment fallback also failed for PR #${pr_number}: ${comment_err}"
        fi
    fi
    $review_ok
}


# Set commit status on the PR HEAD SHA for the dispatch/review context.
# Used as a merge-blocking signal when branch protection is configured.
# Fails silently (|| true) to avoid blocking the pipeline on API errors.
set_review_status() {
    local pr_number="$1" state="$2" description="$3"
    local sha
    sha=$(gh pr view "$pr_number" --repo "$REPO" --json headRefOid -q .headRefOid 2>/dev/null)
    if [[ -n "$sha" ]]; then
        gh api "repos/${REPO}/statuses/${sha}" \
            -f state="$state" \
            -f context="dispatch/review" \
            -f description="$description" 2>/dev/null || true
    fi
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

# ── PID pool tracking (bash 3.x compatible — no associative arrays) ──
# Each PIDS_<POOL> variable stores space-separated PID:ISSUE:POOL:STARTTIME tuples.
PIDS_REDTEAM=""
PIDS_IMPL=""
PIDS_SECURITY=""
PIDS_QA=""
PIDS_CHORE=""
PIDS_REVISION=""

get_pool_name() {
    case "$1" in
        ready-for-red-team)  echo "REDTEAM" ;;
        ready-for-impl)      echo "IMPL" ;;
        ready-for-security)  echo "SECURITY" ;;
        ready-for-qa)        echo "QA" ;;
        ready-for-chore)     echo "CHORE" ;;
        ready-for-revision)  echo "REVISION" ;;
    esac
}

reap_pool() {
    local pool_var="PIDS_$1"
    local live=""
    for tuple in ${!pool_var}; do
        local pid="${tuple%%:*}"
        if kill -0 "$pid" 2>/dev/null; then
            live="$live $tuple"
        fi
    done
    eval "$pool_var=\"\${live# }\""
}

pool_count() {
    local pool_var="PIDS_$1"
    local val="${!pool_var}"
    if [[ -z "$val" ]]; then
        echo 0
    else
        echo "$val" | wc -w | tr -d ' '
    fi
}

reap_all_pools() {
    local pool
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        reap_pool "$pool"
    done
}

# Warned tracker — parallel arrays per pool (bash 3.x compat, no associative arrays)
WARNED_REDTEAM=""
WARNED_IMPL=""
WARNED_SECURITY=""
WARNED_QA=""
WARNED_CHORE=""
WARNED_REVISION=""

# kill_wrapper — terminate a stuck wrapper subshell with SIGTERM → SIGKILL escalation
# Args: pid issue pool elapsed_sec threshold_min logfile
kill_wrapper() {
    local pid="$1" issue="$2" pool="$3" elapsed_sec="$4" threshold_min="$5" logfile="$6"
    local elapsed_min=$((elapsed_sec / 60))
    local signal_used="SIGTERM"

    log "TIMEOUT: killing wrapper PID $pid for issue #$issue ($pool) after ${elapsed_min}m (limit: ${threshold_min}m)"
    kill "$pid" 2>/dev/null

    # Wait up to KILL_GRACE_SECONDS for natural exit (allows EXIT trap to fire)
    local i
    for i in $(seq 1 "$KILL_GRACE_SECONDS"); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done

    if kill -0 "$pid" 2>/dev/null; then
        # SIGKILL bypasses the EXIT trap (Defect 2 fix); duplicate trap cleanup here.
        signal_used="SIGKILL"
        log "ESCALATED: SIGKILL sent to wrapper PID $pid (did not exit within ${KILL_GRACE_SECONDS}s)"
        kill -9 "$pid" 2>/dev/null
        pkill -9 -P "$pid" 2>/dev/null
        # Explicit cleanup — trap did NOT fire on SIGKILL
        gh issue edit "$issue" --repo "$REPO" --remove-label "in-progress" 2>/dev/null
        git -C "$REPO_DIR" worktree list --porcelain 2>/dev/null | grep -o "${REPO_DIR}/.worktrees/issue-${issue}-[^ ]*" | while read -r wt; do
            git -C "$REPO_DIR" worktree remove --force "$wt" 2>/dev/null
        done
    fi

    # Post GitHub comment (hard requirement — suppress errors but always attempt)
    gh issue comment "$issue" --repo "$REPO" --body "$(cat <<EOFCOMMENT
Session timed out — dispatch auto-killed wrapper after **${elapsed_min}m** (stage: \`${pool}\`, limit: \`${threshold_min}m\`).

PID ${pid} terminated via ${signal_used}. Issue re-queued for next dispatch cycle.

<details><summary>Last 20 lines of session log</summary>

\`\`\`
$(tail -20 "${logfile}" 2>/dev/null || echo "(log file not available)")
\`\`\`

</details>
EOFCOMMENT
)" 2>/dev/null

    # Timeout counts against revision counter — add ready-for-revision label
    # so that revision_count increments and prevents infinite timeout loops (MAX_REVISIONS=3).
    # Label is intentionally kept (not removed) so the issue re-enters the dispatch pipeline.
    gh issue edit "$issue" --repo "$REPO" --add-label "ready-for-revision" 2>/dev/null

    # Remove entry from pool (pool is already uppercase from check_timeouts caller)
    local pool_var="PIDS_${pool}"
    local new_val=""
    for tuple in ${!pool_var}; do
        local tpid="${tuple%%:*}"
        if [[ "$tpid" != "$pid" ]]; then
            new_val="$new_val $tuple"
        fi
    done
    eval "$pool_var=\"\${new_val# }\""

    # Clear warned state (pool is already uppercase from check_timeouts caller)
    local warned_var="WARNED_${pool}"
    local new_warned=""
    for wpid in ${!warned_var}; do
        if [[ "$wpid" != "$pid" ]]; then
            new_warned="$new_warned $wpid"
        fi
    done
    eval "$warned_var=\"\${new_warned# }\""
}

# check_timeouts — iterate all pools, warn or kill overdue wrappers
check_timeouts() {
    local pool
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        local threshold_var="MAX_SESSION_MINUTES_${pool}"
        local threshold_min="${!threshold_var}"
        local threshold_sec=$((threshold_min * 60))
        local warn_sec=$((threshold_sec * TIMEOUT_WARNING_RATIO_NUM / TIMEOUT_WARNING_RATIO_DEN))
        local pool_var="PIDS_${pool}"
        local warned_var="WARNED_${pool}"
        local now
        now=$(date +%s)

        for tuple in ${!pool_var}; do
            local pid="${tuple%%:*}"
            local rest="${tuple#*:}"
            local issue="${rest%%:*}"
            rest="${rest#*:}"
            local tpool="${rest%%:*}"
            local start_time="${rest#*:}"
            local elapsed=$((now - start_time))

            if [[ "$elapsed" -lt "$MIN_KILL_AGE_SECONDS" ]]; then
                continue
            fi

            # Derive logfile path for the comment (best-effort match)
            local logfile=""
            local lf
            for lf in "${LOG_DIR}"/issue-${issue}-*.log; do
                [[ -f "$lf" ]] && logfile="$lf"
            done

            if [[ "$elapsed" -ge "$threshold_sec" ]]; then
                kill_wrapper "$pid" "$issue" "$pool" "$elapsed" "$threshold_min" "$logfile"
            elif [[ "$elapsed" -ge "$warn_sec" ]]; then
                # Check if already warned
                local already_warned=false
                for wpid in ${!warned_var}; do
                    if [[ "$wpid" == "$pid" ]]; then
                        already_warned=true
                        break
                    fi
                done
                if ! $already_warned; then
                    local elapsed_min=$((elapsed / 60))
                    log "WARNING: wrapper PID $pid for issue #$issue ($pool) running ${elapsed_min}m — approaching timeout at ${threshold_min}m"
                    local existing_warned="${!warned_var}"
                    if [[ -n "$existing_warned" ]]; then
                        eval "$warned_var=\"${existing_warned} ${pid}\""
                    else
                        eval "$warned_var=\"${pid}\""
                    fi
                fi
            fi
        done
    done
}

total_tracked_count() {
    local total=0
    local pool
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        local c
        c=$(pool_count "$pool")
        total=$((total + c))
    done
    echo "$total"
}

emit_status_line() {
    reap_all_pools
    check_timeouts

    local tracked
    tracked=$(total_tracked_count)

    # Build pools= field
    local pools_str=""
    local pool max_var
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        local c
        c=$(pool_count "$pool")
        max_var="MAX_CONCURRENT_${pool}"
        local max="${!max_var:-0}"
        local lpool
        lpool=$(echo "$pool" | tr '[:upper:]' '[:lower:]')
        if [[ -n "$pools_str" ]]; then
            pools_str="${pools_str},"
        fi
        pools_str="${pools_str}${lpool}:${c}/${max}"
    done

    # Build jobs= field
    local jobs_str=""
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        local pool_var="PIDS_$pool"
        for tuple in ${!pool_var}; do
            local pid issue pname start_time
            pid="${tuple%%:*}"
            local rest="${tuple#*:}"
            issue="${rest%%:*}"
            rest="${rest#*:}"
            pname="${rest%%:*}"
            start_time="${rest#*:}"
            local now elapsed_min
            now=$(date +%s)
            elapsed_min=$(( (now - start_time) / 60 ))
            if [[ -n "$jobs_str" ]]; then
                jobs_str="${jobs_str},"
            fi
            jobs_str="${jobs_str}#${issue}:${pname}:${elapsed_min}m:PID${pid}"
        done
    done

    local status_line="STATUS: in_flight=${tracked} pools=${pools_str}"
    if [[ "$tracked" -gt 0 && -n "$jobs_str" ]]; then
        status_line="${status_line} jobs=${jobs_str}"
    fi

    # Check for orphaned background jobs
    local bg_count
    bg_count=$(jobs -rp 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$bg_count" -gt "$tracked" ]]; then
        local orphan_count=$(( bg_count - tracked ))
        status_line="${status_line}; orphans=${orphan_count}"
    fi

    log "$status_line"
}

# ── Per-stage concurrency config ──────────────────────────────────

# Apply per-stage concurrency limits. Call once at startup.
# If per-stage vars are set, use them. If only MAX_CONCURRENT is set,
# distribute proportionally with a deprecation warning.
apply_concurrency_config() {
    local any_per_stage=false
    local pool
    for pool in REDTEAM IMPL SECURITY QA CHORE REVISION; do
        local var="MAX_CONCURRENT_${pool}"
        if [[ -n "${!var+x}" ]]; then
            any_per_stage=true
            break
        fi
    done

    if $any_per_stage; then
        # Per-stage vars take precedence — apply defaults for unset pools
        MAX_CONCURRENT_REDTEAM="${MAX_CONCURRENT_REDTEAM:-4}"
        MAX_CONCURRENT_IMPL="${MAX_CONCURRENT_IMPL:-2}"
        MAX_CONCURRENT_SECURITY="${MAX_CONCURRENT_SECURITY:-2}"
        MAX_CONCURRENT_QA="${MAX_CONCURRENT_QA:-2}"
        MAX_CONCURRENT_CHORE="${MAX_CONCURRENT_CHORE:-1}"
        MAX_CONCURRENT_REVISION="${MAX_CONCURRENT_REVISION:-1}"
        if [[ -n "${MAX_CONCURRENT:-}" ]]; then
            log "WARNING: MAX_CONCURRENT is set alongside per-stage vars — per-stage vars take precedence, MAX_CONCURRENT ignored"
        fi
    elif [[ -n "${MAX_CONCURRENT:-}" ]]; then
        # Legacy: distribute MAX_CONCURRENT proportionally
        log "DEPRECATION: MAX_CONCURRENT is deprecated — use per-stage vars (MAX_CONCURRENT_REDTEAM, etc.) instead"
        local mc="$MAX_CONCURRENT"
        # ceil(mc * 0.4) for redteam, ceil(mc * 0.3) for impl, rest split
        MAX_CONCURRENT_REDTEAM=$(( (mc * 4 + 9) / 10 ))
        MAX_CONCURRENT_IMPL=$(( (mc * 3 + 9) / 10 ))
        local remainder=$(( mc - MAX_CONCURRENT_REDTEAM - MAX_CONCURRENT_IMPL ))
        if [[ "$remainder" -lt 2 ]]; then remainder=2; fi
        MAX_CONCURRENT_SECURITY=$(( (remainder + 1) / 2 ))
        MAX_CONCURRENT_QA=$(( (remainder + 1) / 2 ))
        MAX_CONCURRENT_CHORE=1
        MAX_CONCURRENT_REVISION=1
    else
        # No config at all — use defaults
        MAX_CONCURRENT_REDTEAM=4
        MAX_CONCURRENT_IMPL=2
        MAX_CONCURRENT_SECURITY=2
        MAX_CONCURRENT_QA=2
        MAX_CONCURRENT_CHORE=1
        MAX_CONCURRENT_REVISION=1
    fi
}

# ── Fresh worktree enforcement (Defect 4) ─────────────────────────

get_branch_name_for_issue() {
    local issue_number="$1"
    local dispatch_label="$2"
    case "$dispatch_label" in
        ready-for-chore) echo "chore/issue-${issue_number}" ;;
        *)               echo "fix/issue-${issue_number}" ;;
    esac
}

is_commit_producing_stage() {
    case "$1" in
        ready-for-impl|ready-for-revision|ready-for-chore) return 0 ;;
        *) return 1 ;;
    esac
}

# Prepare the working tree for a commit-producing dispatch.
# Ensures HEAD is on the correct branch, rebased on origin/master.
# Returns 1 on conflict (labels issue dispatch-conflict).
prepare_branch_for_dispatch() {
    local issue_number="$1"
    local dispatch_label="$2"

    local branch_name
    branch_name=$(get_branch_name_for_issue "$issue_number" "$dispatch_label")

    # Fetch latest origin state
    git fetch origin "$DEFAULT_BRANCH" --quiet 2>/dev/null || true

    if git rev-parse --verify "origin/${branch_name}" &>/dev/null; then
        # Branch exists on remote — check it out and rebase
        git checkout "$branch_name" --quiet 2>/dev/null || git checkout -b "$branch_name" "origin/${branch_name}" --quiet
        git reset --hard "origin/${branch_name}" --quiet 2>/dev/null
        if ! git rebase "origin/${DEFAULT_BRANCH}" --quiet 2>/dev/null; then
            git rebase --abort 2>/dev/null || true
            log "ERROR: Rebase conflict for #${issue_number} on ${branch_name} — aborting dispatch"
            gh issue edit "$issue_number" --repo "$REPO" --add-label "dispatch-conflict" 2>/dev/null || true
            return 1
        fi
    else
        # Branch does not exist — create from origin/master
        git checkout -B "$branch_name" "origin/${DEFAULT_BRANCH}" --quiet
    fi

    # Verify HEAD is on the expected branch
    local current_branch
    current_branch=$(git rev-parse --abbrev-ref HEAD)
    if [[ "$current_branch" != "$branch_name" ]]; then
        log "ERROR: Expected HEAD on ${branch_name} but found ${current_branch}"
        return 1
    fi
}

# ── Helpers ────────────────────────────────────────────────────────
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
err() { log "ERROR: $*" >&2; }

ensure_deps() {
    for cmd in gh claude git jq; do
        command -v "$cmd" &>/dev/null || { err "$cmd not found on PATH"; exit 1; }
    done
    gh auth status &>/dev/null || { err "gh not authenticated. Run: gh auth login"; exit 1; }

    # Load bot token for review submission (NOT exported — agents use default gh auth
    # so PRs are created as Ryan, not the bot. This avoids GitHub's "can't review your
    # own PR" restriction when the bot tries to review a PR it authored.)
    if [[ -f "$BOT_TOKEN_FILE" ]]; then
        BOT_TOKEN=$(cat "$BOT_TOKEN_FILE")
        log "Bot token loaded from ${BOT_TOKEN_FILE}"
    else
        BOT_TOKEN=""
        log "WARNING: Bot token not found at ${BOT_TOKEN_FILE} — reviews will post as default gh user"
    fi

    # Clean orphaned worktrees from prior crashes
    (cd "$REPO_DIR" 2>/dev/null && git worktree prune 2>/dev/null) || true

    # Log rotation: remove old logs and status files
    find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null
    find "$LOG_DIR" -name "*.status" -mtime +7 -delete 2>/dev/null
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
        "review-failed:B60205:Bot review crashed — needs investigation"
        "dispatch-conflict:B60205:Rebase conflict — needs manual resolution"
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

# ── CC output validation ──────────────────────────────────────────
# Returns via global variables: VALIDATION_OK (true/false), VALIDATION_TRANSIENT (true/false)
validate_cc_output() {
    local output="$1" mode="$2"
    VALIDATION_OK=true
    VALIDATION_TRANSIENT=false

    # Negative patterns — known API/transport errors
    if printf '%s\n' "$output" | grep -qE 'API Error:|overloaded_error|rate_limit_error|server_error|ECONNREFUSED|ETIMEDOUT'; then
        VALIDATION_OK=false
        VALIDATION_TRANSIENT=true
        return
    fi

    # Empty or near-empty output
    if [[ -z "$output" ]]; then
        VALIDATION_OK=false
        VALIDATION_TRANSIENT=false
        return
    fi

    # Positive patterns — mode-specific expected content
    case "$mode" in
        review-pr)
            # Review handlers MUST produce a VERDICT line — missing verdict is transient (retryable)
            if ! extract_verdict "$output" "" >/dev/null 2>&1; then
                VALIDATION_OK=false
                VALIDATION_TRANSIENT=true
            fi
            ;;
        review-issue)
            # Issue reviews should contain substantive content (markdown headers, findings)
            # A raw error message won't have these
            if ! printf '%s\n' "$output" | grep -qE '^#+[[:space:]]|\*\*|^-[[:space:]]'; then
                VALIDATION_OK=false
                VALIDATION_TRANSIENT=false
            fi
            ;;
        implement|revise)
            # Implementation validation is handled by existing git-diff checks
            # (line 388 for implement, line 729 for revise) — no additional check needed
            ;;
    esac
}

mkdir -p "$LOG_DIR"

# ── Agent-state landing artifact check ──────────────────────────
# Detects whether a journal entry was created for this issue within 5 minutes.
# Emits a warning to stderr + PR comment if missing. Never blocks the pipeline.
# Usage: check_landing_artifact <issue_number> <pr_url>
check_landing_artifact() {
    local issue_number="$1" pr_url="$2"
    local match

    match=$(find "$AGENT_STATE_JOURNALS_DIR" -maxdepth 2 -type f -name "*.md" \
        -newermt "5 minutes ago" -print 2>/dev/null \
        | xargs grep -El "#${issue_number}\b|issue-${issue_number}\b" 2>/dev/null \
        | head -1) || true

    if [[ -n "$match" ]]; then
        log "Landing artifact found for issue #${issue_number}: ${match}"
    else
        echo "WARNING: agent-state landing artifact not found for issue #${issue_number} within 5 minutes of PR ${pr_url}. Run /anthropic-skills:session-landing manually to catch up." >&2
        gh pr comment "$pr_url" --repo "$REPO" \
            --body "WARNING: agent-state landing artifact not found for issue #${issue_number} within 5 minutes of PR ${pr_url}. Run /anthropic-skills:session-landing manually to catch up." 2>/dev/null || true
    fi

    return 0
}

# ── Post-PR bookkeeping helper ──────────────────────────────────
# Runs all bookkeeping after a PR is created or adopted. Each gh call is
# individually guarded — a single failure emits a WARNING but does not abort
# the remaining steps.
# Usage: post_pr_open_bookkeeping <issue_number> <pr_url> <pr_number> <dispatch_label> <done_label>
post_pr_open_bookkeeping() {
    local issue_number="$1" pr_url="$2" pr_number="$3"
    local dispatch_label="$4" done_label="$5"
    local _bk_err

    # (a) Add done_label to PR if set
    if [[ -n "$done_label" ]]; then
        if ! _bk_err=$(gh pr edit "$pr_number" --repo "$REPO" --add-label "$done_label" 2>&1 >/dev/null); then
            log "WARNING: Failed to add label '${done_label}' to PR #${pr_number} (issue #${issue_number}, ${pr_url}) — gh: ${_bk_err}"
        fi
    fi

    # (b) Remove in-progress from issue
    if ! _bk_err=$(gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress" 2>&1 >/dev/null); then
        log "WARNING: Failed to remove 'in-progress' from issue #${issue_number} (PR ${pr_url}) — gh: ${_bk_err}"
    fi

    # (c) Post PR comment on issue
    if ! _bk_err=$(gh issue comment "$issue_number" --repo "$REPO" --body "PR opened: ${pr_url}" 2>&1 >/dev/null); then
        log "WARNING: Failed to post PR comment on issue #${issue_number} (PR ${pr_url}) — gh: ${_bk_err}"
    fi

    # (d) Chain to next stage
    if ! _bk_err=$(chain_next_stage "$issue_number" "$dispatch_label" 2>&1); then
        log "WARNING: chain_next_stage failed for issue #${issue_number} / ${pr_url} — output: ${_bk_err}"
    fi

    # (e) Check for agent-state landing artifact
    check_landing_artifact "$issue_number" "$pr_url"
}

# ── Create-or-adopt PR helper ─────────────────────────────────────
# Attempts gh pr create; if that fails (e.g., PR already exists for the branch),
# falls back to adopting an existing PR via gh pr list --head. Runs
# post_pr_open_bookkeeping on success.
_create_or_adopt_pr() {
    local issue_number="$1" issue_title="$2" branch="$3"
    local cc_summary="$4" superseded_issue="$5"
    local dispatch_label="$6" done_label="$7"

    # Attempt to create the PR, capturing stderr for diagnostics
    local pr_url pr_create_stderr
    if pr_url=$(gh pr create --repo "$REPO" \
        --title "fix: #${issue_number} — ${issue_title}" \
        --body "$(cat <<PRBODY
## Summary

Automated fix for #${issue_number}: ${issue_title}

## What changed

${cc_summary}

## Linked Issue

Closes #${issue_number}${superseded_issue:+
Closes #${superseded_issue}}

---
*Dispatched by cc-dispatch.sh at $(date '+%Y-%m-%d %H:%M:%S')*
PRBODY
)" \
        --head "$branch" --base "$DEFAULT_BRANCH" 2>&1); then
        log "PR created: ${pr_url}"
    else
        pr_create_stderr="$pr_url"
        pr_url=""
        log "gh pr create failed for issue #${issue_number}: ${pr_create_stderr}"

        # Attempt to adopt an existing PR on this branch
        pr_url=$(gh pr list --repo "$REPO" --head "$branch" --state open --json url --jq '.[0].url') || true
        local adopted_number
        adopted_number=$(gh pr list --repo "$REPO" --head "$branch" --state open --json number --jq '.[0].number') || true

        if [[ -n "$pr_url" && -n "$adopted_number" ]]; then
            log "Adopted existing PR #${adopted_number}: ${pr_url}"
        else
            err "Failed to create or adopt PR for issue #${issue_number} (branch: ${branch}). Original error: ${pr_create_stderr}"
            return 1
        fi
    fi

    local pr_number
    pr_number=$(echo "$pr_url" | grep -o '[0-9]*$')
    post_pr_open_bookkeeping "$issue_number" "$pr_url" "$pr_number" "$dispatch_label" "$done_label"
}

# ── Implement mode: branch → CC → commit → PR ────────────────────
dispatch_implement() {
    local issue_number="$1" issue_title="$2" issue_body="$3"
    local agent_flag="$4" dispatch_label="$5" done_label="$6" logfile="$7"
    local branch="fix/issue-${issue_number}"

    # Check if this spec issue supersedes an original issue
    local superseded_issue=""
    superseded_issue=$(echo "$issue_body" | grep -oE 'Supersedes #[0-9]+' | head -1 | grep -oE '[0-9]+')
    if [[ -n "$superseded_issue" ]]; then
        log "Spec issue #${issue_number} supersedes original issue #${superseded_issue}"
    fi

    # Worktree is set up by caller — fetch and create branch from remote
    git fetch origin "$DEFAULT_BRANCH" --quiet
    git checkout -B "$branch" "origin/${DEFAULT_BRANCH}"

    local main_sha
    main_sha=$(git rev-parse "origin/${DEFAULT_BRANCH}")

    # Build prompt — agent personas have their own system prompts
    local cc_prompt
    if [[ -n "$agent_flag" ]]; then
        cc_prompt="Fix GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

Follow your implementation protocol. Issue #${issue_number} in repo ${REPO}.

IMPORTANT: Do NOT open a pull request. Push your branch only; the dispatch wrapper will create or adopt the PR."
    else
        cc_prompt="Fix GitHub issue #${issue_number}: ${issue_title}

ISSUE BODY:
${issue_body}

INSTRUCTIONS:
1. Read the relevant source files and understand the problem.
2. Implement the fix with minimal, focused changes.
3. Run any existing tests to verify nothing breaks.
4. Do NOT commit yet — I will review the changes first.

When done, summarize what you changed and why.

IMPORTANT: Do NOT open a pull request. Push your branch only; the dispatch wrapper will create or adopt the PR."
    fi

    log "Starting CC implement session (logging to ${logfile})"

    # Write header to logfile
    {
      echo "=== CC Session ==="
      echo "Issue: #${issue_number}"
      echo "Label: ${dispatch_label}"
      echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "=== Prompt ==="
      echo "$cc_prompt"
      echo "=== Output ==="
    } > "$logfile"

    # CC execution — append raw output to logfile, also write to .out file
    local cc_output
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
    local cc_exit=$?
    cat "${logfile}.out" >> "$logfile"

    # Read raw output into variable (no header contamination)
    cc_output=$(cat "${logfile}.out")
    rm -f "${logfile}.out"

    if [ $cc_exit -ne 0 ]; then
        err "CC exited with code ${cc_exit} for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Validate CC output and retry on transient failures
    validate_cc_output "$cc_output" "implement"
    local retries=0 max_retries=2
    while [[ "$VALIDATION_OK" != "true" && "$VALIDATION_TRANSIENT" == "true" && $retries -lt $max_retries ]]; do
        retries=$((retries + 1))
        local backoff=$(( 30 * retries ))
        log "Transient CC failure for #${issue_number} (attempt ${retries}/${max_retries}), retrying in ${backoff}s"
        sleep "$backoff"
        # shellcheck disable=SC2086
        echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
        cc_output=$(cat "${logfile}.out")
        echo "=== Retry ${retries} ===" >> "$logfile"
        cat "${logfile}.out" >> "$logfile"
        rm -f "${logfile}.out"
        validate_cc_output "$cc_output" "implement"
    done
    if [[ "$VALIDATION_OK" != "true" ]]; then
        err "CC output validation failed for #${issue_number} after ${retries} retries"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile"
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

    # Belt-and-suspenders: warn if commits don't reference this issue
    local foreign_commits
    foreign_commits=$(git log "origin/${DEFAULT_BRANCH}..HEAD" --oneline | grep -v "#${issue_number}" | head -5)
    if [[ -n "$foreign_commits" ]]; then
        log "WARNING: Branch has commits not mentioning #${issue_number}:"
        echo "$foreign_commits" | while read -r line; do log "  $line"; done
        log "This may indicate branch contamination from the worktree bug. PR will still be created."
    fi

    # Extract the implementer's summary from CC output (last ~80 lines before git noise)
    local cc_summary
    cc_summary=$(echo "$cc_output" | grep -v '^\[' | grep -v '^Enumerating\|^Counting\|^Compressing\|^Writing\|^Delta\|^Total\|^remote:\|^To github\|^branch\|^ \*' | tail -80)
    # Truncate to ~4000 chars to stay within GitHub's limits
    cc_summary="${cc_summary:0:4000}"

    # Assertion-flip guardrail: block if test assertions were modified without justification
    local _script_dir
    _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! "${_script_dir}/check-assertion-flips.sh" --base "origin/${DEFAULT_BRANCH}" --head HEAD 2>"${logfile}.af-err"; then
        local af_err
        af_err=$(cat "${logfile}.af-err")
        rm -f "${logfile}.af-err"
        log "ASSERTION-FLIP guardrail fired for issue #${issue_number}: ${af_err}"
        gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress" --add-label "ready-for-revision"
        gh issue comment "$issue_number" --repo "$REPO" \
            --body "$(printf '### ASSERTION-FLIP DETECTED\n\nThe assertion-flip guardrail blocked stage advancement.\n\n```\n%s\n```\n\nSee issue spec for BEHAVIOR-CHANGE / ASSERTION-REFACTOR keyword requirements.' "$af_err")"
        return 1
    fi
    rm -f "${logfile}.af-err"

    _create_or_adopt_pr "$issue_number" "$issue_title" "$branch" "$cc_summary" "$superseded_issue" "$dispatch_label" "$done_label"
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

Follow your review protocol. Analyze the issue thoroughly.

IMPORTANT — OUTPUT FORMAT:
Do NOT run gh issue comment yourself. Instead, output your full review findings directly.
The dispatch script will post your review as a comment on issue #${issue_number} in repo ${REPO} on your behalf."

    log "Starting CC review-issue session (logging to ${logfile})"

    # Write header to logfile
    {
      echo "=== CC Session ==="
      echo "Issue: #${issue_number}"
      echo "Label: ${dispatch_label}"
      echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "=== Prompt ==="
      echo "$cc_prompt"
      echo "=== Output ==="
    } > "$logfile"

    # CC execution — append raw output to logfile, also write to .out file
    local cc_output
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
    local cc_exit=$?
    cat "${logfile}.out" >> "$logfile"

    # Read raw output into variable (no header contamination)
    cc_output=$(cat "${logfile}.out")
    rm -f "${logfile}.out"

    if [ $cc_exit -ne 0 ]; then
        err "CC review failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Validate CC output and retry on transient failures
    validate_cc_output "$cc_output" "review-issue"
    local retries=0 max_retries=2
    while [[ "$VALIDATION_OK" != "true" && "$VALIDATION_TRANSIENT" == "true" && $retries -lt $max_retries ]]; do
        retries=$((retries + 1))
        local backoff=$(( 30 * retries ))
        log "Transient CC failure for #${issue_number} (attempt ${retries}/${max_retries}), retrying in ${backoff}s"
        sleep "$backoff"
        # shellcheck disable=SC2086
        echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
        cc_output=$(cat "${logfile}.out")
        echo "=== Retry ${retries} ===" >> "$logfile"
        cat "${logfile}.out" >> "$logfile"
        rm -f "${logfile}.out"
        validate_cc_output "$cc_output" "review-issue"
    done
    if [[ "$VALIDATION_OK" != "true" ]]; then
        err "CC output validation failed for #${issue_number} after ${retries} retries"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile"
        return 1
    fi

    # Agent generates the review; script posts it as a comment.
    # (Prompt instructs agent to output findings, not post them directly.)
    if [[ -n "$cc_output" ]]; then
        log "Posting review comment on issue #${issue_number}"
        local post_err tmpfile
        tmpfile=$(mktemp)
        printf '%s' "$cc_output" > "$tmpfile"
        post_err=$(gh issue comment "$issue_number" --repo "$REPO" \
            --body-file "$tmpfile" 2>&1)
        if [[ $? -ne 0 ]]; then
            err "Failed to post review on issue #${issue_number}: ${post_err}"
        fi
        rm -f "$tmpfile"
    else
        err "CC produced empty output for issue #${issue_number}"
    fi

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

ADDITIONAL REVIEW REQUIREMENTS:
- If the PR modifies files under src/queries/, verify that integration tests exist which create an in-memory SQLite DB, insert test rows, execute the generated SQL, and assert on results. Flag CHANGES_REQUESTED if missing.
- Check git log on the PR branch. Verify that at least one commit adds/modifies test files and precedes the commit that modifies source files. If all test changes come in the same commit as or after implementation, flag for TDD non-compliance.

IMPORTANT — OUTPUT FORMAT:
Do NOT run gh pr review yourself. The dispatch script will submit the formal GitHub review on your behalf.

Include your full analysis, then end with your verdict on its own line using this EXACT format:

VERDICT:APPROVE
or
VERDICT:REQUEST_CHANGES

This marker line is machine-parsed. It MUST appear exactly as shown — no markdown headers, no prose, just VERDICT:APPROVE or VERDICT:REQUEST_CHANGES on its own line at the end of your response. PR #${pr_number} in repo ${REPO}."

    # Set pending commit status before CC runs
    set_review_status "$pr_number" "pending" "Bot review in progress"

    log "Starting CC review-pr session (logging to ${logfile})"

    # Write header to logfile
    {
      echo "=== CC Session ==="
      echo "Issue: #${issue_number}"
      echo "Label: ${dispatch_label}"
      echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "=== Prompt ==="
      echo "$cc_prompt"
      echo "=== Output ==="
    } > "$logfile"

    # CC execution — JSON envelope isolates clean output from tool-use logging
    local cc_output
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude -p $agent_flag \
        --output-format json > "${logfile}.out" 2>&1
    local cc_exit=$?
    cat "${logfile}.out" >> "$logfile"

    # Read raw output into variable (no header contamination)
    cc_output=$(cat "${logfile}.out")
    rm -f "${logfile}.out"

    if [ $cc_exit -ne 0 ]; then
        err "CC PR review failed (exit ${cc_exit}) for issue #${issue_number}"
        set_review_status "$pr_number" "failure" "Bot review crashed (exit ${cc_exit})"
        gh pr edit "$pr_number" --repo "$REPO" --add-label "review-failed" 2>/dev/null || true
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Validate CC output and retry on transient failures
    validate_cc_output "$cc_output" "review-pr"
    local retries=0 max_retries=2
    while [[ "$VALIDATION_OK" != "true" && "$VALIDATION_TRANSIENT" == "true" && $retries -lt $max_retries ]]; do
        retries=$((retries + 1))
        local backoff=$(( 30 * retries ))
        log "Transient CC failure for #${issue_number} (attempt ${retries}/${max_retries}), retrying in ${backoff}s"
        sleep "$backoff"
        # shellcheck disable=SC2086
        echo "$cc_prompt" | claude -p $agent_flag \
            --output-format json > "${logfile}.out" 2>&1
        cc_output=$(cat "${logfile}.out")
        echo "=== Retry ${retries} ===" >> "$logfile"
        cat "${logfile}.out" >> "$logfile"
        rm -f "${logfile}.out"
        validate_cc_output "$cc_output" "review-pr"
    done
    if [[ "$VALIDATION_OK" != "true" ]]; then
        err "CC output validation failed for #${issue_number} after ${retries} retries"
        set_review_status "$pr_number" "error" "CC output validation failed"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile"
        return 1
    fi

    # Parse verdict from CC output (deterministic — no reliance on agent running gh commands)
    local raw_verdict verdict
    raw_verdict=$(extract_verdict "$cc_output" "$pr_number")
    # Map extract_verdict output to GitHub API values for submit_review
    case "$raw_verdict" in
        APPROVE) verdict="APPROVED" ;;
        REQUEST_CHANGES) verdict="CHANGES_REQUESTED" ;;
        *) verdict="$raw_verdict" ;;
    esac
    log "Parsed verdict: ${verdict}"

    # Extract clean review body from JSON envelope
    local review_body
    review_body=$(echo "$cc_output" | jq -r '.result // empty' 2>/dev/null)
    if [ -z "$review_body" ]; then
        # Fallback: treat entire output as text (non-JSON output edge case)
        review_body=$(echo "$cc_output" | grep -v '^\[')
    fi

    # Log both raw JSON and extracted review for debugging
    {
        echo "=== Extracted Review ==="
        echo "$review_body" | head -50
        echo "=== Extracted Verdict ==="
        echo "${raw_verdict:-NONE}"
    } >> "$logfile"

    local tmpfile
    tmpfile=$(mktemp)
    echo "$review_body" | grep -v '^VERDICT:' | tail -100 > "$tmpfile"
    if [ -s "$tmpfile" ]; then
        head -c 65536 "$tmpfile" > "${tmpfile}.trunc" && mv "${tmpfile}.trunc" "$tmpfile"
        # Script submits the formal review — not the agent
        if submit_review "$pr_number" "$verdict" "$(cat "$tmpfile")"; then
            set_review_status "$pr_number" "success" "Bot review complete: ${verdict}"
            log "Formal review submitted: ${verdict}"
        else
            set_review_status "$pr_number" "error" "Review submission failed"
            log "Review submission failed for PR #${pr_number}"
        fi
    else
        set_review_status "$pr_number" "error" "Bot produced empty review output"
        log "Empty review body — aborting review chain for PR #${pr_number}"
        rollback_issue "$issue_number" "$dispatch_label"
        rm -f "$tmpfile"
        return 1
    fi
    rm -f "$tmpfile"

    # Remove in-progress label
    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"
    if [[ -n "$done_label" ]]; then
        gh issue edit "$issue_number" --repo "$REPO" --add-label "$done_label"
    fi

    # Chain based on parsed verdict
    if [[ "$verdict" == "APPROVED" ]]; then
        # After QA approval, wait for CI before labeling ready-to-merge
        if [[ "$dispatch_label" == "ready-for-qa" ]]; then
            if wait_for_ci "$pr_number" "$issue_number" 600; then
                chain_next_stage "$issue_number" "$dispatch_label"
            fi
            # If CI failed/timed out, wait_for_ci already labeled ready-for-revision
        else
            chain_next_stage "$issue_number" "$dispatch_label"
        fi
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

    # Worktree is set up by caller — no cd needed

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

    # Worktree is fresh — fetch and checkout the branch
    git fetch origin "$branch" --quiet
    git checkout "$branch"

    # Capture HEAD before CC runs (to detect no-change revisions)
    local head_before
    head_before=$(git rev-parse HEAD)

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

    # Write header to logfile
    {
      echo "=== CC Session ==="
      echo "Issue: #${issue_number}"
      echo "Label: ${dispatch_label}"
      echo "Started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
      echo "=== Prompt ==="
      echo "$cc_prompt"
      echo "=== Output ==="
    } > "$logfile"

    # CC execution — append raw output to logfile, also write to .out file
    local cc_output
    # shellcheck disable=SC2086
    echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
    local cc_exit=$?
    cat "${logfile}.out" >> "$logfile"

    # Read raw output into variable (no header contamination)
    cc_output=$(cat "${logfile}.out")
    rm -f "${logfile}.out"

    if [ $cc_exit -ne 0 ]; then
        err "CC revise failed (exit ${cc_exit}) for issue #${issue_number}"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile" "$cc_exit"
        return 1
    fi

    # Validate CC output and retry on transient failures
    validate_cc_output "$cc_output" "revise"
    local retries=0 max_retries=2
    while [[ "$VALIDATION_OK" != "true" && "$VALIDATION_TRANSIENT" == "true" && $retries -lt $max_retries ]]; do
        retries=$((retries + 1))
        local backoff=$(( 30 * retries ))
        log "Transient CC failure for #${issue_number} (attempt ${retries}/${max_retries}), retrying in ${backoff}s"
        sleep "$backoff"
        # shellcheck disable=SC2086
        echo "$cc_prompt" | claude --print $agent_flag > "${logfile}.out" 2>&1
        cc_output=$(cat "${logfile}.out")
        echo "=== Retry ${retries} ===" >> "$logfile"
        cat "${logfile}.out" >> "$logfile"
        rm -f "${logfile}.out"
        validate_cc_output "$cc_output" "revise"
    done
    if [[ "$VALIDATION_OK" != "true" ]]; then
        err "CC output validation failed for #${issue_number} after ${retries} retries"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile"
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

    # Gate: bail if revision produced no commits
    local head_after
    head_after=$(git rev-parse HEAD)
    if [[ "$head_before" == "$head_after" ]]; then
        log "Revision produced no changes for issue #${issue_number} — rolling back"
        rollback_issue "$issue_number" "$dispatch_label" "$logfile"
        return 1
    fi

    # Post revision summary to PR
    local tmpfile
    tmpfile=$(mktemp)
    echo "$cc_output" | grep -v '^\[' | tail -100 > "$tmpfile"
    if [ -s "$tmpfile" ]; then
        head -c 65536 "$tmpfile" > "${tmpfile}.trunc" && mv "${tmpfile}.trunc" "$tmpfile"
        gh pr comment "$pr_number" --repo "$REPO" --body-file "$tmpfile" 2>/dev/null
    fi
    rm -f "$tmpfile"

    gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress"

    # Assertion-flip guardrail: block if test assertions were modified without justification
    local _script_dir
    _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if ! "${_script_dir}/check-assertion-flips.sh" --base "origin/${DEFAULT_BRANCH}" --head HEAD 2>"${logfile}.af-err"; then
        local af_err
        af_err=$(cat "${logfile}.af-err")
        rm -f "${logfile}.af-err"
        log "ASSERTION-FLIP guardrail fired for issue #${issue_number}: ${af_err}"
        gh issue edit "$issue_number" --repo "$REPO" --add-label "ready-for-revision"
        gh pr comment "$pr_number" --repo "$REPO" \
            --body "$(printf '### ASSERTION-FLIP DETECTED\n\nThe assertion-flip guardrail blocked stage advancement.\n\n```\n%s\n```\n\nSee issue spec for BEHAVIOR-CHANGE / ASSERTION-REFACTOR keyword requirements.' "$af_err")"
        return 1
    fi
    rm -f "${logfile}.af-err"

    # Chain back to security review
    chain_next_stage "$issue_number" "$dispatch_label"

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

    # Intra-cycle dedup: skip if already dispatched this scan cycle
    if [[ "$dispatched_this_cycle" == *" ${issue_number} "* ]]; then
        log "Skipping #${issue_number} — already dispatched this cycle"
        return 2
    fi
    dispatched_this_cycle="${dispatched_this_cycle}${issue_number} "

    log "Dispatching #${issue_number} [${dispatch_label} → ${mode}]: ${issue_title}"

    if $DRY_RUN; then
        log "[DRY RUN] agent=${agent:-generic} mode=${mode} done_label=${done_label:-none}"
        return 0
    fi

    # Skip if already being handled by a background job
    local issue_labels
    issue_labels=$(gh issue view "$issue_number" --repo "$REPO" --json labels -q '[.labels[].name] | join(",")' 2>/dev/null)
    if echo "$issue_labels" | grep -q "in-progress"; then
        log "Skipping #${issue_number} — already in-progress"
        return 2
    fi

    # Check per-pool concurrency (reap stale PIDs first)
    local pool_name
    pool_name=$(get_pool_name "$dispatch_label")
    if [[ -n "$pool_name" ]]; then
        reap_pool "$pool_name"
        local pool_running pool_max_var pool_max
        pool_running=$(pool_count "$pool_name")
        pool_max_var="MAX_CONCURRENT_${pool_name}"
        pool_max="${!pool_max_var:-0}"
        if [[ "$pool_running" -ge "$pool_max" ]]; then
            local lpool
            lpool=$(echo "$pool_name" | tr '[:upper:]' '[:lower:]')
            log "Pool ${lpool} at capacity (${pool_running}/${pool_max}) — skipping #${issue_number}"
            return 2
        fi
    fi

    # Swap label: dispatch → in-progress (before spawning background job to prevent double-dispatch)
    gh issue edit "$issue_number" --repo "$REPO" \
        --remove-label "$dispatch_label" --add-label "in-progress" 2>/dev/null

    # Read the full issue body
    local issue_body
    issue_body=$(gh issue view "$issue_number" --repo "$REPO" --json body -q '.body')

    # Spawn handler in background subshell
    (
        # Unified EXIT trap: kill children first, then clean state (Defect 2 — kill claude child before state cleanup)
        local workdir=""
        trap '
            pkill -P $BASHPID 2>/dev/null
            sleep 1
            pkill -9 -P $BASHPID 2>/dev/null
            gh issue edit "$issue_number" --repo "$REPO" --remove-label "in-progress" 2>/dev/null
            [[ -n "$workdir" ]] && git -C "$REPO_DIR" worktree remove --force "$workdir" 2>/dev/null
        ' EXIT

        # For implement and revise: create isolated worktree
        if [[ "$mode" == "implement" || "$mode" == "revise" ]]; then
            mkdir -p "${REPO_DIR}/.worktrees"
            workdir=$(mktemp -d "${REPO_DIR}/.worktrees/issue-${issue_number}-XXXXXX")
            git -C "$REPO_DIR" worktree add --detach "$workdir" "$DEFAULT_BRANCH" --quiet
            cd "$workdir"

            # For commit-producing stages: enforce correct branch (Defect 4 fix)
            if is_commit_producing_stage "$dispatch_label"; then
                if ! prepare_branch_for_dispatch "$issue_number" "$dispatch_label"; then
                    log "Branch preparation failed for #${issue_number} — aborting dispatch"
                    exit 1
                fi
            fi
        fi

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
        local handler_exit=$?
        local status=$( [[ $handler_exit -eq 0 ]] && echo "success" || echo "failed" )

        # Write status file on completion
        echo "status=${status} issue=${issue_number} mode=${mode} ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            > "${LOG_DIR}/issue-${issue_number}.status"
    ) &
    local spawned_pid=$!
    log "Background job spawned for #${issue_number} (PID ${spawned_pid})"

    # Track PID in the appropriate pool
    local pool_name
    pool_name=$(get_pool_name "$dispatch_label")
    if [[ -n "$pool_name" ]]; then
        local pool_var="PIDS_${pool_name}"
        local start_time
        start_time=$(date +%s)
        local lpool
        lpool=$(echo "$pool_name" | tr '[:upper:]' '[:lower:]')
        local existing="${!pool_var}"
        if [[ -n "$existing" ]]; then
            eval "$pool_var=\"${existing} ${spawned_pid}:${issue_number}:${lpool}:${start_time}\""
        else
            eval "$pool_var=\"${spawned_pid}:${issue_number}:${lpool}:${start_time}\""
        fi
    fi
}

# ── Main loop ──────────────────────────────────────────────────────
run_once() {
    local spawned=0
    local skipped=0
    dispatched_this_cycle=" "

    # Emit STATUS line at the start of each cycle
    emit_status_line

    for label in "${DISPATCH_LABELS[@]}"; do
        log "Scanning ${REPO} for '${label}'..."

        local issues
        issues=$(gh issue list --repo "$REPO" --label "$label" --state open \
            --json number,title --jq '.[] | "\(.number)\t\(.title)"')

        if [ -z "$issues" ]; then
            continue
        fi

        while IFS=$'\t' read -r number title; do
            local rc=0
            dispatch_issue "$number" "$title" "$label" || rc=$?
            if [[ "$rc" -eq 0 ]]; then
                spawned=$((spawned + 1))
            elif [[ "$rc" -eq 2 ]]; then
                skipped=$((skipped + 1))
            fi
        done <<< "$issues"
    done

    local total=$((spawned + skipped))
    if [ "$total" -eq 0 ]; then
        log "No dispatch labels found. Nothing to do."
    elif [ "$skipped" -eq 0 ]; then
        log "Dispatched ${spawned} issue(s)."
    else
        log "Dispatched ${spawned} issue(s); skipped ${skipped} (concurrency/in-progress)."
    fi
}

# ── Entry point ────────────────────────────────────────────────────
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    ensure_deps
    ensure_labels
    apply_concurrency_config

    # Kill all background agents on shutdown
    trap 'log "Shutting down — killing background agents"; kill $(jobs -rp) 2>/dev/null; wait; exit 130' INT TERM

    if $WATCH; then
        log "Watch mode: polling every ${POLL_INTERVAL}s (${#DISPATCH_LABELS[@]} labels, pools: redteam=${MAX_CONCURRENT_REDTEAM} impl=${MAX_CONCURRENT_IMPL} security=${MAX_CONCURRENT_SECURITY} qa=${MAX_CONCURRENT_QA} chore=${MAX_CONCURRENT_CHORE} revision=${MAX_CONCURRENT_REVISION}). Ctrl-C to stop."
        while true; do
            run_once
            log "Sleeping ${POLL_INTERVAL}s..."
            sleep "$POLL_INTERVAL"
        done
    else
        run_once
        # Wait for all background jobs to complete in one-shot mode
        wait
    fi
fi

#!/usr/bin/env bash
#
# check-assertion-flips.sh — Detect assertion modifications in test files
#
# Parses git diff output for hunks where an existing assertion was removed
# and a new assertion was added (a "flip"). Requires a structured justification
# keyword in commit messages to proceed.
#
# Usage:
#   ./scripts/check-assertion-flips.sh [--base <ref>] [--head <ref>] [--help]
#
# Options:
#   --base <ref>   Base ref for diff (default: origin/master)
#   --head <ref>   Head ref for diff (default: HEAD)
#   --help         Show this help message
#
# Exit codes:
#   0  No unjustified assertion flips detected
#   1  Assertion flip detected without valid justification
#
# Justification keywords (must appear in commit message body, not subject):
#   BEHAVIOR-CHANGE: <summary>     — intentional behavioral contract change
#   ASSERTION-REFACTOR: <summary>  — cosmetic change (rename, method swap, formatting)

set -euo pipefail

BASE="origin/master"
HEAD="HEAD"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --base) BASE="$2"; shift 2 ;;
        --head) HEAD="$2"; shift 2 ;;
        --help)
            sed -n '2,/^[^#]/{ /^#/{ s/^# //; s/^#$//; p; }; }' "$0"
            exit 0
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

# Assertion regex — scoped to the 11 methods actually used in this repo
ASSERT_RE='assert\.(equal|ok|deepEqual|strictEqual|deepStrictEqual|notEqual|notDeepEqual|throws|doesNotThrow|match|fail)'

# Step 1: Get the diff for test files only, parse for hunk-level assertion flips
diff_output=$(git diff "${BASE}..${HEAD}" -- ':(glob)test/**/*.test.js' 2>/dev/null || true)

if [[ -z "$diff_output" ]]; then
    exit 0
fi

# Step 2: Use awk to detect hunks with both - and + assertion lines
flips=$(echo "$diff_output" | awk -v re="$ASSERT_RE" '
    /^diff --git/ {
        # Emit previous hunk if it was a flip
        if (is_test && has_minus && has_plus) {
            print file "|" hunk_line "|" minus_line "|" plus_line
        }
        has_minus = 0; has_plus = 0; minus_line = ""; plus_line = ""; hunk_line = ""
        file = $NF
        sub(/^b\//, "", file)
        is_test = (file ~ /^test\/.*\.test\.js$/)
    }
    /^@@/ && is_test {
        if (has_minus && has_plus) {
            print file "|" hunk_line "|" minus_line "|" plus_line
        }
        has_minus = 0; has_plus = 0; minus_line = ""; plus_line = ""
        hunk_line = $0
    }
    is_test && /^-/ && !/^---/ {
        line = $0
        sub(/^-/, "", line)
        gsub(/^[ \t]+/, "", line)
        if (match(line, re)) {
            has_minus = 1
            if (minus_line == "") minus_line = $0
        }
    }
    is_test && /^\+/ && !/^\+\+\+/ {
        line = $0
        sub(/^\+/, "", line)
        gsub(/^[ \t]+/, "", line)
        if (match(line, re)) {
            has_plus = 1
            if (plus_line == "") plus_line = $0
        }
    }
    END {
        if (is_test && has_minus && has_plus) {
            print file "|" hunk_line "|" minus_line "|" plus_line
        }
    }
')

if [[ -z "$flips" ]]; then
    exit 0
fi

# Step 3: Check commit messages for valid justification keywords
log_output=$(git log "${BASE}..${HEAD}" --format='%B' 2>/dev/null || true)

# Check for BEHAVIOR-CHANGE: with non-empty content after colon
if echo "$log_output" | grep -qE 'BEHAVIOR-CHANGE:[[:space:]]+[^[:space:]]'; then
    exit 0
fi

# Check for ASSERTION-REFACTOR: with non-empty content after colon
if echo "$log_output" | grep -qE 'ASSERTION-REFACTOR:[[:space:]]+[^[:space:]]'; then
    exit 0
fi

# Step 4: Emit actionable error
echo "ASSERTION-FLIP DETECTED — justification required" >&2
echo "" >&2

echo "$flips" | while IFS='|' read -r file hunk minus plus; do
    echo "File: ${file}" >&2
    echo "Hunk starting at: ${hunk}" >&2
    echo "" >&2
    echo "  ${minus}" >&2
    echo "  ${plus}" >&2
    echo "" >&2
done

cat >&2 << 'MSG'
To proceed, add one of the following to your commit message body (not subject):
  BEHAVIOR-CHANGE: <explain what user-facing behavior is intentionally changing>
  ASSERTION-REFACTOR: <explain why this is cosmetic, not behavioral>
MSG

exit 1

#!/usr/bin/env bash
#
# setup-bot-credentials.sh — Configure 402index-bot credentials on Atlas
#
# Run this once on Atlas after creating the bot PAT.
# Usage: ./scripts/setup-bot-credentials.sh <YOUR_BOT_PAT>
#
# What it does:
#   1. Stores the bot PAT in ~/.bot-token (chmod 600)
#   2. Creates a git credential file for the bot (chmod 600)
#   3. Configures this repo to use bot credentials for push
#   4. Verifies gh auth works with the token
#   5. Prints the tmux command to start dispatch

set -euo pipefail

TOKEN="${1:-}"

if [[ -z "$TOKEN" ]]; then
    echo "Usage: $0 <BOT_PAT_TOKEN>"
    echo "  The classic PAT from the 402index-bot GitHub account."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Setting up 402index-bot credentials ==="

# 1. Store token securely
TOKEN_FILE="$HOME/.bot-token"
echo "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "[✓] Token stored at $TOKEN_FILE"

# 2. Create git credential file for bot
CRED_FILE="$HOME/.git-credentials-402bot"
echo "https://402index-bot:${TOKEN}@github.com" > "$CRED_FILE"
chmod 600 "$CRED_FILE"
echo "[✓] Git credentials at $CRED_FILE"

# 3. Configure this repo to use bot credentials
cd "$REPO_DIR"
git config credential.helper "store --file $CRED_FILE"
git config credential.https://github.com.useHttpPath true
echo "[✓] Repo git config updated"

# 4. Verify gh auth
echo ""
echo "=== Verifying gh auth ==="
GH_TOKEN="$TOKEN" gh auth status 2>&1 || {
    echo "[✗] gh auth failed. Check that the PAT has 'repo' scope."
    exit 1
}
echo "[✓] gh auth verified"

# 5. Add GH_TOKEN_BOT to shell profile if not already there
SHELL_RC="$HOME/.zshrc"
if [[ ! -f "$SHELL_RC" ]]; then
    SHELL_RC="$HOME/.bashrc"
fi
if ! grep -q 'GH_TOKEN_BOT' "$SHELL_RC" 2>/dev/null; then
    echo "" >> "$SHELL_RC"
    echo "# 402index-bot dispatch token" >> "$SHELL_RC"
    echo "export GH_TOKEN_BOT=\"\$(cat $TOKEN_FILE)\"" >> "$SHELL_RC"
    echo "[✓] Added GH_TOKEN_BOT to $SHELL_RC"
else
    echo "[~] GH_TOKEN_BOT already in $SHELL_RC, skipping"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "To start the dispatch loop:"
echo "  tmux new-session -d -s dispatch 'export GH_TOKEN=\"\$(cat $TOKEN_FILE)\"; cd $REPO_DIR && ./scripts/cc-dispatch.sh --watch 300'"
echo ""
echo "To verify:"
echo "  tmux attach -t dispatch"
echo ""
echo "For persistence across reboots, add to crontab:"
echo "  @reboot sleep 30 && tmux new-session -d -s dispatch 'export GH_TOKEN=\"\$(cat $TOKEN_FILE)\"; cd $REPO_DIR && ./scripts/cc-dispatch.sh --watch 300'"

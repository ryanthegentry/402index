#!/bin/bash
# Runs under macOS bash 3.2. Usage: ./demo.sh happy|fail
set -eu

cd "$(dirname "$0")"

case "${1:-}" in
  happy|fail) ;;
  *) echo "usage: ./demo.sh happy|fail"; exit 2 ;;
esac

if [ -z "${ROUTER_STATE_KEY:-}" ] || [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "ROUTER_STATE_KEY and STRIPE_SECRET_KEY must be set (see ~/.402index-router.env)"
  exit 1
fi

# Caps raised from the PRD defaults per Ryan's 2026-07-29 correction:
# Boltz's 333-sat floor makes 200/5000 unworkable.
export ROUTER_MAX_SATS_PER_JOB="${ROUTER_MAX_SATS_PER_JOB_OVERRIDE:-2000}"
export ROUTER_MAX_TOTAL_SATS="${ROUTER_MAX_TOTAL_SATS_OVERRIDE:-20000}"
export SETTLEMENT_ADAPTER="${SETTLEMENT_ADAPTER:-golem}"
# Proven by hand end-to-end (T0). llm402.ai's whole family 502s on delivery
# through l402.space tonight; per the 3-dead rule this is the live fallback.
export ROUTER_PROVEN_FALLBACKS="${ROUTER_PROVEN_FALLBACKS:-https://lightningfaucet.com/api/l402/llm-prompt}"

npx tsc
exec node demo/demo.mjs "$1"

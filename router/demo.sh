#!/bin/bash
# Runs under macOS bash 3.2. Usage: ./demo.sh happy|fail
set -eu

cd "$(dirname "$0")"

case "${1:-}" in
  live|happy|compare|fail|books) ;;
  *) echo "usage: ./demo.sh live|compare|fail|books   (happy = live)"; exit 2 ;;
esac

# The env file is the operational source of truth — a long-lived shell can
# carry stale exports from before an edit.
if [ -f "$HOME/.402index-router.env" ]; then
  set -a
  . "$HOME/.402index-router.env"
  set +a
fi
if [ -z "${ROUTER_STATE_KEY:-}" ] || [ -z "${STRIPE_SECRET_KEY:-}" ]; then
  echo "ROUTER_STATE_KEY and STRIPE_SECRET_KEY must be set (see ~/.402index-router.env)"
  exit 1
fi

# Caps per Ryan's 2026-07-29 multirail pre-flight: 1500/12000 (the ledger
# backfill counts 3,352 historical sats against the total).
export ROUTER_MAX_SATS_PER_JOB="${ROUTER_MAX_SATS_PER_JOB:-1500}"
export ROUTER_MAX_TOTAL_SATS="${ROUTER_MAX_TOTAL_SATS:-12000}"
export SETTLEMENT_ADAPTER="${SETTLEMENT_ADAPTER:-golem}"
# The compare scenario forces the gateway leg; everything else runs the
# default direct-first order.
if [ "$1" = "compare" ]; then
  export ROUTER_ROUTE_ORDER="l402space"
fi
# Proven by hand end-to-end (T0). llm402.ai's whole family 502s on delivery
# through l402.space tonight; per the 3-dead rule this is the live fallback.
export ROUTER_PROVEN_FALLBACKS="${ROUTER_PROVEN_FALLBACKS:-https://lightningfaucet.com/api/l402/llm-prompt}"

npx tsc
exec node demo/demo.mjs "$1"

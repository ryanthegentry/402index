/**
 * What to say when the L402 gateway cannot mint a challenge.
 *
 * Two call sites reach this — the export.csv route and the free-tier rate limiter — and
 * before 2026-08-03 they disagreed. export.csv answered with a bare 402 telling the caller
 * to add `?l402=require`; `?l402=require` answered with `429 Rate limit exceeded, try again
 * later`. During the Boltz outage that pair formed a loop: the 402 sent the agent to the
 * 429, and the 429 told it to come back in 60 seconds, forever.
 *
 * The honest answer is 503. The paywall is not asking for payment (it cannot take any) and
 * the caller has not exhausted anything. `reason` is machine-readable so an agent can tell
 * this apart from a real rate limit without parsing prose.
 */

/**
 * How long to tell a client to wait. Deliberately not 60s: the failure this covers is an
 * upstream outage of unknown length, and a minute-scale Retry-After reads as "nearly fixed".
 * Five minutes is long enough to stop hot-retry loops and short enough that a client polling
 * politely still notices recovery quickly.
 */
export const GATEWAY_UNAVAILABLE_RETRY_AFTER_SECONDS = 300

/**
 * Send the 503 for "the Lightning gateway is down".
 *
 * No WWW-Authenticate header: that header exists to carry a challenge, and there isn't one.
 * Emitting an empty or stale one would leave clients trying to pay an invoice we never made.
 *
 * @param {import('express').Response} res
 * @param {string} [detail] Optional operator-facing hint appended to the message.
 */
export function sendGatewayUnavailable(res, detail) {
  const message =
    'The Lightning payment gateway is unavailable, so no invoice can be issued right now. ' +
    'This is an upstream outage, not a rate limit — retrying sooner will not help. ' +
    'Unpaid free-tier endpoints are unaffected.'

  return res
    .status(503)
    .set('Retry-After', String(GATEWAY_UNAVAILABLE_RETRY_AFTER_SECONDS))
    .json({
      error: 'Service Unavailable',
      reason: 'l402_gateway_unavailable',
      message: detail ? `${message} (${detail})` : message,
      retry_after: GATEWAY_UNAVAILABLE_RETRY_AFTER_SECONDS,
    })
}

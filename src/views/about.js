import { layout } from './layout.js'

export function aboutPage() {
  return layout('About', `
    <div class="container">
      <div class="about-content">
        <h1>What is 402 Index?</h1>
        <p>
          402 Index is a protocol-agnostic directory of paid APIs designed for AI agents.
          We index services that use <strong>L402</strong> (Lightning Network paywalls) and
          <strong>x402</strong> (crypto micropayments via Coinbase/Base) protocols.
        </p>
        <p>
          AI agents need to discover, evaluate, and pay for API services autonomously.
          402 Index provides the discovery layer — a searchable directory with real-time
          health monitoring, pricing information, and schema documentation.
        </p>

        <h2>How it works</h2>
        <p>
          We aggregate services from multiple sources:
        </p>
        <p>
          <strong>x402 Bazaar</strong> — Coinbase's auto-registration directory for x402-enabled endpoints.
          We poll this hourly and normalize the data into our schema.
        </p>
        <p>
          <strong>Satring</strong> — A small directory of L402 (Lightning) paywalled services.
        </p>
        <p>
          <strong>Exclusive listings</strong> — Manually curated services submitted via YAML files.
          These are the highest-quality listings, reviewed by the 402 Index team.
        </p>
        <p>
          Every service is health-checked every 15 minutes. For paid API services,
          a <code>402 Payment Required</code> response means the service is healthy —
          the paywall is active and working.
        </p>

        <h2>Methodology</h2>

        <p>
          Every number on 402 Index is independently verified. We don't take any source's word
          for it — we check every endpoint ourselves, every 15 minutes.
        </p>

        <p>
          <strong>Endpoints indexed</strong> is the total count of unique paid API endpoints
          we track across all sources. This includes every service registered in x402 Bazaar,
          Satring, L402 Apps, and our exclusive listings.
        </p>

        <p>
          <strong>Payment-verified</strong> endpoints are the subset that pass our independent
          payment verification. What this means depends on the protocol:
        </p>

        <p>
          For <strong>L402</strong> endpoints: we send an HTTP request and confirm the service
          returns <code>402 Payment Required</code> with a valid <code>WWW-Authenticate: L402</code>
          header containing a properly formatted macaroon/token and a BOLT11 Lightning invoice.
          If the paywall is active and the credentials parse correctly, the endpoint is payment-verified.
        </p>

        <p>
          For <strong>x402</strong> endpoints: we send an HTTP request and check for a
          <code>PAYMENT-REQUIRED</code> response header containing a valid base64-encoded JSON
          payload. We validate that the <code>accepts[]</code> array includes a recognized payment
          scheme, a known asset contract address (e.g., USDC on Base), a valid <code>payTo</code>
          address, and a reachable facilitator URL. If any of these checks fail, the endpoint is
          indexed but not payment-verified.
        </p>

        <p>
          <strong>Health status</strong> reflects whether the endpoint is reachable and responding
          correctly:
        </p>

        <p>
          <span style="color:var(--green)">&#9679;</span> <strong>Healthy</strong> — responded with
          HTTP 402 (paywall active) within the timeout window on the last check.<br>
          <span style="color:var(--yellow)">&#9679;</span> <strong>Degraded</strong> — responding, but
          with unexpected status codes, slow response times, or intermittent failures.<br>
          <span style="color:var(--red)">&#9679;</span> <strong>Down</strong> — not responding or
          returning errors on consecutive checks.
        </p>

        <p>
          <strong>Why do some sources show a large gap between "indexed" and "payment-verified"?</strong>
          Auto-registration directories may catalog endpoints when they first process a payment,
          but don't continuously verify that the payment infrastructure remains active. 402 Index
          checks every endpoint every 15 minutes. If an endpoint no longer returns valid payment
          headers, it stays indexed (we still track it) but loses its payment-verified status.
          This ongoing verification is what makes 402 Index useful for AI agents that need to
          make autonomous spending decisions — they can trust that a payment-verified endpoint
          will actually accept payment right now.
        </p>

        <h2>For API providers</h2>
        <p>
          Want to list your paid API on 402 Index? There are a few ways to get started:
        </p>
        <p>
          <strong>1. Add x402 to your API.</strong> The
          <a href="https://www.x402.org/" target="_blank">x402 protocol</a> lets you add
          crypto micropayments to any HTTP endpoint. Your service will be auto-discovered
          via the Bazaar and indexed here.
        </p>
        <p>
          <strong>2. Add L402 to your API.</strong> Use
          <a href="https://l402.org/" target="_blank">L402</a> to paywall your API with
          Lightning Network micropayments.
        </p>
        <p>
          <strong>3. Register via API.</strong> Agents and developers can register L402 endpoints
          programmatically. Your endpoint must return HTTP <code>402</code> with a
          <code>WWW-Authenticate: L402</code> header on unauthenticated requests.
          Registrations are verified automatically and reviewed before going live.
        </p>
        <pre>curl -X POST https://402index.io/api/v1/register \\
  -H 'Content-Type: application/json' \\
  -d '{
  "url": "https://api.example.com/resource",
  "name": "My L402 API",
  "protocol": "L402",
  "provider": "My Org"
}'</pre>
        <p>
          See the <a href="/api-docs">API docs</a> for the full field reference.
        </p>
        <p>
          <strong>4. Email us a listing.</strong> Send a YAML file describing your service
          to <a href="mailto:hello@402index.io">hello@402index.io</a> for manual review.
        </p>
        <pre>name: "My Weather API"
url: "https://api.example.com/weather"
protocol: L402
price_sats: 5
price_usd: 0.002
payment_asset: "BTC/Lightning"
category: "real-time-data/weather"
description: "Weather forecasts from NOAA data"
provider: "Example Corp"</pre>

        <h2>For AI agent developers</h2>
        <p>
          Use our <a href="/api-docs">REST API</a> to query the directory programmatically.
          Filter by protocol, category, price, health status, and more.
        </p>
        <pre>GET /api/v1/services?health=healthy&category=real-time-data&max_price_usd=0.01</pre>
        <p>
          An MCP server is available for direct integration with Claude, GPT, and other AI assistants.
          See the <a href="/api-docs">API docs</a> for details.
        </p>

        <p style="margin-top:24px">
          402 Index is an open directory of paid APIs for AI agents.
        </p>
      </div>
    </div>
  `)
}

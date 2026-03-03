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
          <strong>3. Submit a YAML listing.</strong> Create a YAML file describing your service
          and send it to <a href="mailto:hello@402index.io">hello@402index.io</a>.
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
        <p>
          <strong>4. Register via API.</strong> Agents and developers can register L402 endpoints
          programmatically. Your endpoint must be L402-spec-compliant — it needs to return
          HTTP <code>402</code> with a <code>WWW-Authenticate: L402</code> header on
          unauthenticated requests.
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
          The endpoint is verified automatically — we probe your URL to confirm it returns
          a valid L402 challenge before listing it. See the <a href="/api-docs">API docs</a>
          for the full field reference.
        </p>

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

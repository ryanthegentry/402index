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
          Want to list your paid API on 402 Index? There are two ways:
        </p>
        <p>
          <strong>1. Use the Golem gateway.</strong> If you have a standard REST API,
          you can wrap it with <a href="https://golem.network">Golem</a> to add L402 or x402
          payment support. Your service will automatically appear in 402 Index.
        </p>
        <p>
          <strong>2. Submit a YAML listing.</strong> Create a YAML file describing your service
          and submit a pull request to our
          <a href="https://github.com/402index/402index">GitHub repo</a>.
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
          Use our <a href="/api/v1/health">REST API</a> to query the directory programmatically.
          Filter by protocol, category, price, health status, and more.
        </p>
        <pre>GET /api/v1/services?health=healthy&category=real-time-data&max_price_usd=0.01</pre>
        <p>
          An MCP server is coming soon for direct integration with Claude, GPT, and other AI assistants.
        </p>

        <h2>About</h2>
        <p>
          402 Index is built by <a href="https://bixi.com">BIXI</a> as part of the
          <a href="https://golem.network">Golem</a> project — infrastructure for
          AI agents to autonomously discover and pay for services.
        </p>
      </div>
    </div>
  `)
}

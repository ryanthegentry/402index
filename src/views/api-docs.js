import { layout } from './layout.js'

function escapeHtml(str) {
  if (!str) return ''
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function apiDocsPage() {
  return layout('API Documentation', `
    <div class="container">
      <div class="docs-content">
        <h1>402 Index API</h1>
        <p class="docs-subtitle">Programmatic access to the paid API directory. Free, no auth required.</p>

        <h2>Base URL</h2>
        <div class="base-url">https://402index.io/api/v1</div>

        <h2>Endpoints</h2>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/services</span>
          </div>
          <p>List and search services with filtering, sorting, and pagination.</p>
          <table class="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td>protocol</td><td>string</td><td>Filter by protocol: <code>l402</code> or <code>x402</code></td></tr>
              <tr><td>category</td><td>string</td><td>Filter by category (prefix match — <code>crypto</code> matches <code>crypto/nft</code>)</td></tr>
              <tr><td>health</td><td>string</td><td>Filter by health: <code>healthy</code>, <code>degraded</code>, <code>down</code>, <code>unknown</code></td></tr>
              <tr><td>source</td><td>string</td><td>Filter by source: <code>bazaar</code>, <code>satring</code>, <code>exclusive</code></td></tr>
              <tr><td>featured</td><td>boolean</td><td>Only featured services: <code>true</code></td></tr>
              <tr><td>q</td><td>string</td><td>Search by name or description</td></tr>
              <tr><td>max_price_usd</td><td>number</td><td>Maximum price in USD</td></tr>
              <tr><td>sort</td><td>string</td><td>Sort by: <code>name</code>, <code>price</code>, <code>latency</code>, <code>uptime</code></td></tr>
              <tr><td>order</td><td>string</td><td>Sort order: <code>asc</code> or <code>desc</code></td></tr>
              <tr><td>limit</td><td>integer</td><td>Results per page (default 50, max 200)</td></tr>
              <tr><td>offset</td><td>integer</td><td>Pagination offset</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/services?protocol=l402&amp;health=healthy</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/services/:id</span>
          </div>
          <p>Get full details for a single service, including recent health check history.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/services/1</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/categories</span>
          </div>
          <p>List all categories with service counts, organized as a tree with subcategories.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/categories</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method">GET</span>
            <span class="endpoint-path">/api/v1/health</span>
          </div>
          <p>System health and sync status. Returns service counts by protocol, health status, and source, plus last sync timestamps.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/health</div>
        </div>

        <h2>Response Format</h2>
        <p>The services list endpoint returns JSON with the following structure:</p>
        <div class="response-sample">${escapeHtml(JSON.stringify({
          services: [
            {
              id: 1,
              name: 'Example Weather API',
              description: 'Real-time weather data from NOAA',
              url: 'https://api.example.com/weather',
              protocol: 'L402',
              price_sats: 5,
              price_usd: 0.002,
              payment_asset: 'BTC/Lightning',
              payment_network: 'lightning',
              category: 'real-time-data/weather',
              provider: 'Example Corp',
              source: 'exclusive',
              featured: 1,
              health_status: 'healthy',
              uptime_30d: 0.997,
              latency_p50_ms: 245,
              last_checked: '2025-02-28T12:00:00Z',
              registered_at: '2025-01-15T08:30:00Z'
            }
          ],
          total: 7595,
          limit: 50,
          offset: 0
        }, null, 2))}</div>

        <div class="coming-soon">
          <h3>MCP Server — Coming Soon</h3>
          <p>An MCP server is coming for direct integration with Claude, GPT, and other AI assistants.
          The MCP server will allow agents to discover and evaluate paid APIs without leaving their workflow.</p>
        </div>
      </div>
    </div>
    <script>
    function copyExample(btn) {
      const block = btn.parentElement
      const text = block.textContent.replace('Copy', '').trim()
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!'
        setTimeout(function() { btn.textContent = 'Copy' }, 1500)
      })
    }
    </script>
  `)
}

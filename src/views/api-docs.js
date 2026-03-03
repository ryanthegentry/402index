import { layout } from './layout.js'
import { escapeHtml } from './helpers.js'

export function apiDocsPage() {
  return layout('API Documentation', `
    <div class="container">
      <div class="docs-content">
        <h1>402 Index API</h1>
        <p class="docs-subtitle">Programmatic access to the paid API directory. Free tier available, L402 payments for higher limits.</p>

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
              <tr><td>source</td><td>string</td><td>Filter by source: <code>bazaar</code>, <code>satring</code>, <code>l402apps</code>, <code>exclusive</code>, <code>self-registered</code></td></tr>
              <tr><td>featured</td><td>boolean</td><td>Only featured services: <code>true</code></td></tr>
              <tr><td>q</td><td>string</td><td>Search by name or description</td></tr>
              <tr><td>max_price_usd</td><td>number</td><td>Maximum price in USD</td></tr>
              <tr><td>payment_asset</td><td>string</td><td>Filter by payment asset (e.g. <code>USDC</code>, <code>BTC/Lightning</code>)</td></tr>
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
          <p>System health and sync status. Returns endpoint counts, distinct service/provider counts by protocol, health status breakdowns, source counts, and last sync timestamps.</p>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>GET /api/v1/health</div>
        </div>

        <div class="endpoint">
          <div class="endpoint-header">
            <span class="endpoint-method" style="background:#49cc90">POST</span>
            <span class="endpoint-path">/api/v1/register</span>
          </div>
          <p>Register an L402 endpoint. The URL is probed to verify L402 compliance before listing. Rate limited to 10 registrations per hour per IP.</p>
          <table class="params-table">
            <thead>
              <tr><th>Parameter</th><th>Type</th><th>Description</th></tr>
            </thead>
            <tbody>
              <tr><td>url</td><td>string</td><td><strong>Required.</strong> The endpoint URL to register</td></tr>
              <tr><td>name</td><td>string</td><td><strong>Required.</strong> Display name for the service</td></tr>
              <tr><td>protocol</td><td>string</td><td><strong>Required.</strong> Currently only <code>L402</code> is supported</td></tr>
              <tr><td>description</td><td>string</td><td>Description of what the service does</td></tr>
              <tr><td>price_sats</td><td>integer</td><td>Price per request in satoshis</td></tr>
              <tr><td>price_usd</td><td>number</td><td>Price per request in USD</td></tr>
              <tr><td>payment_asset</td><td>string</td><td>Payment asset (e.g. <code>BTC/Lightning</code>)</td></tr>
              <tr><td>payment_network</td><td>string</td><td>Payment network (e.g. <code>lightning</code>)</td></tr>
              <tr><td>category</td><td>string</td><td>Category (e.g. <code>crypto/bitcoin</code>). Defaults to <code>uncategorized</code></td></tr>
              <tr><td>provider</td><td>string</td><td>Organization or developer name</td></tr>
              <tr><td>contact_email</td><td>string</td><td>Contact email (not displayed publicly)</td></tr>
            </tbody>
          </table>
          <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>curl -X POST https://402index.io/api/v1/register \\
  -H 'Content-Type: application/json' \\
  -d '{
  "url": "https://api.example.com/resource",
  "name": "My L402 API",
  "protocol": "L402",
  "provider": "My Org"
}'</div>
          <p style="margin-top:12px"><strong>Response codes:</strong></p>
          <table class="params-table">
            <thead>
              <tr><th>Status</th><th>Meaning</th></tr>
            </thead>
            <tbody>
              <tr><td><code>201</code></td><td>Created. Returns the service record and verification details.</td></tr>
              <tr><td><code>400</code></td><td>Missing required fields or invalid protocol.</td></tr>
              <tr><td><code>422</code></td><td>L402 verification failed. The response includes actionable details: wrong HTTP status, missing <code>WWW-Authenticate</code> header, unreachable endpoint, or SSRF blocked.</td></tr>
              <tr><td><code>429</code></td><td>Rate limit exceeded (10 registrations per hour per IP).</td></tr>
            </tbody>
          </table>
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

        <h2>Rate Limits &amp; L402 Payments</h2>
        <p>API endpoints are rate-limited to ensure fair usage. Pay via Lightning Network to unlock higher limits.</p>
        <table class="params-table">
          <thead>
            <tr><th>Tier</th><th>Limit</th><th>How</th></tr>
          </thead>
          <tbody>
            <tr><td>Free</td><td>100 req/min per IP</td><td>No auth needed</td></tr>
            <tr><td>L402</td><td>1,000 req/min per IP</td><td><code>Authorization: L402 &lt;macaroon&gt;:&lt;preimage&gt;</code></td></tr>
          </tbody>
        </table>
        <p>When you exceed the free tier, the API returns <code>402 Payment Required</code> with a Lightning invoice in the <code>WWW-Authenticate</code> header. Pay the invoice, then include the L402 token in subsequent requests.</p>
        <p>Exempt from rate limiting: <code>/</code>, <code>/about</code>, <code>/api-docs</code>, <code>/service/*</code>, <code>/api/v1/health</code></p>
        <p><em>402 Index is the first service listed in its own directory — we eat our own dog food.</em></p>

        <div class="info-callout">
          <h3>MCP Server — Available</h3>
          <p>An MCP server is available for direct integration with Claude, GPT, and other AI assistants.
          See the <code>mcp-server/</code> directory for setup instructions.</p>
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

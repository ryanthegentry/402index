import { layout } from './layout.js'

export function verifyPage() {
  return layout('Verify Your Domain', `
    <div class="container">
      <div class="about-content">
        <h1>Claim Your Listings on 402 Index</h1>
        <p>
          If your API endpoints are already indexed on 402 Index (e.g., from Bazaar, Satring, or self-registration),
          you can verify domain ownership to edit your listings directly &mdash; update names, descriptions,
          categories, and pricing without contacting us.
        </p>

        <h2>1. Find your domain</h2>
        <p>
          Your domain is the hostname of your API endpoints. For example, if your endpoint URL is
          <code>https://api.example.com/v1/chat</code>, your domain is <code>api.example.com</code>.
        </p>
        <p>
          You can search the <a href="/directory">directory</a> to find your listings, or use the
          <a href="/api-docs">API</a> to query by URL.
        </p>

        <h2>2. Claim your domain</h2>
        <p>
          Initiate a claim by sending a POST request with your domain. You'll receive a unique
          verification token and instructions.
        </p>
        <pre>curl -X POST https://402index.io/api/v1/claim \\
  -H 'Content-Type: application/json' \\
  -d '{"domain": "api.example.com"}'</pre>
        <p><strong>Response:</strong></p>
        <pre>{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4e5f6...  (64 hex characters)",
  "verification_hash": "e3b0c44298fc1c14...  (SHA-256 of the token)",
  "verification_url": "https://api.example.com/.well-known/402index-verify.txt",
  "instructions": "Place a text file at the URL above containing only this hash: e3b0c442..."
}</pre>
        <p>
          Save the <code>verification_token</code> &mdash; this becomes your ongoing credential
          for editing listings. The claim expires after 72 hours if not verified.
        </p>

        <h2>3. Place the verification file</h2>
        <p>
          Create a file at <code>/.well-known/402index-verify.txt</code> on your domain containing
          <strong>only</strong> the <code>verification_hash</code> (the SHA-256 hash, not the raw token).
          This ensures the raw token is never exposed publicly.
        </p>

        <h3>Express / Node.js</h3>
        <pre>app.get('/.well-known/402index-verify.txt', (req, res) => {
  res.type('text/plain').send('YOUR_VERIFICATION_HASH_HERE')
})</pre>

        <h3>Nginx</h3>
        <pre>location = /.well-known/402index-verify.txt {
    return 200 'YOUR_VERIFICATION_HASH_HERE';
    default_type text/plain;
}</pre>

        <h3>Static hosting (Vercel, Netlify, S3)</h3>
        <p>
          Create the file <code>public/.well-known/402index-verify.txt</code> (or equivalent
          static directory) with the hash as its only content.
        </p>

        <h2>4. Verify</h2>
        <p>
          Once the file is in place, trigger verification:
        </p>
        <pre>curl -X POST https://402index.io/api/v1/claim/verify \\
  -H 'Content-Type: application/json' \\
  -d '{"domain": "api.example.com"}'</pre>
        <p><strong>Response:</strong></p>
        <pre>{
  "domain": "api.example.com",
  "status": "verified",
  "services_count": 12
}</pre>
        <p>
          We fetch your verification file, compare the hash against the SHA-256 of your stored token, and mark your domain as verified.
          The file must be served directly (no redirects) and must be under 1KB.
        </p>

        <h2>5. Edit your listings</h2>
        <p>
          With a verified domain, you can update any service whose URL hostname matches your domain.
          Include your <code>domain</code> and <code>verification_token</code> in every request:
        </p>
        <pre>curl -X PATCH https://402index.io/api/v1/services/SERVICE_ID \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4e5f6...",
  "description": "Updated description for my API",
  "category": "ai/text",
  "price_usd": 0.01
}'</pre>

        <h3>What you can edit</h3>
        <table class="params-table">
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Constraints</th></tr>
          </thead>
          <tbody>
            <tr><td><code>name</code></td><td>string</td><td>Max 200 characters</td></tr>
            <tr><td><code>description</code></td><td>string</td><td>Max 2000 characters</td></tr>
            <tr><td><code>category</code></td><td>string</td><td>Max 100 characters</td></tr>
            <tr><td><code>price_usd</code></td><td>number</td><td>Non-negative</td></tr>
            <tr><td><code>price_sats</code></td><td>integer</td><td>Non-negative integer</td></tr>
            <tr><td><code>payment_asset</code></td><td>string</td><td>Max 50 characters (e.g. BTC, USDC)</td></tr>
            <tr><td><code>payment_network</code></td><td>string</td><td>Max 50 characters (e.g. Lightning, Base)</td></tr>
          </tbody>
        </table>

        <h2>6. Delete your listings</h2>
        <p>
          Verified domain owners can soft-delete any service whose URL matches their domain.
          Deleted listings are hidden from the directory, health checks, pollers, and API queries.
          They are permanently purged after 30 days. Contact <a href="mailto:hello@402index.io">hello@402index.io</a> to restore a deleted listing before purge.
        </p>

        <h3>Single delete</h3>
        <pre>curl -X DELETE https://402index.io/api/v1/services/SERVICE_ID \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4e5f6..."
}'</pre>

        <h3>Bulk delete (up to 25 at once)</h3>
        <pre>curl -X POST https://402index.io/api/v1/services/bulk-delete \\
  -H 'Content-Type: application/json' \\
  -d '{
  "ids": [101, 102, 103],
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4e5f6..."
}'</pre>
        <p>
          Bulk delete returns which IDs were deleted, which were skipped (wrong domain, not found),
          and reasons for each skip.
        </p>

        <h2>7. Revoke access</h2>
        <p>
          If your token is compromised or you want to rotate credentials, revoke it:
        </p>
        <pre>curl -X POST https://402index.io/api/v1/claim/revoke \\
  -H 'Content-Type: application/json' \\
  -d '{
  "domain": "api.example.com",
  "verification_token": "a1b2c3d4e5f6..."
}'</pre>
        <p>
          This invalidates the token immediately. To regain access, start the claim flow
          again from step 2. You'll receive a new token and hash, and will need to update your verification file.
        </p>

        <p style="margin-top:32px">
          Questions? Email <a href="mailto:hello@402index.io">hello@402index.io</a> or
          check the <a href="/api-docs">API docs</a> for the full endpoint reference.
        </p>
      </div>
    </div>
  `)
}

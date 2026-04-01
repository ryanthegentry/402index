import { styles } from './styles.js'
import { escapeHtml, safeJsonEmbed } from './helpers.js'

export function layout(title, content, meta = {}) {
  const description = escapeHtml(meta.description || 'Protocol-agnostic directory of paid APIs (L402, x402, MPP) for AI agents. Indexed, verified, and searchable.')
  const ogTitle = escapeHtml(meta.ogTitle || (title === '402 Index' ? '402 Index' : `${title} — 402 Index`))
  const ogUrl = escapeHtml(meta.ogUrl || 'https://402index.io')
  const canonicalTag = meta.canonical ? `\n  <link rel="canonical" href="https://402index.io${meta.canonical}" />` : ''
  const jsonLdTag = meta.jsonLd ? `\n  <script type="application/ld+json">${safeJsonEmbed(meta.jsonLd)}</script>` : ''
  const googleVerification = process.env.GOOGLE_SITE_VERIFICATION ? `\n  <meta name="google-site-verification" content="${escapeHtml(process.env.GOOGLE_SITE_VERIFICATION)}" />` : ''
  const plausibleScript = process.env.PLAUSIBLE_DOMAIN ? `\n  <script defer data-domain="${escapeHtml(process.env.PLAUSIBLE_DOMAIN)}" src="https://plausible.io/js/script.js"></script>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#0f1117">
  <meta name="description" content="${description}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${description}">
  <meta property="og:image" content="https://402index.io/og-image.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content="https://402index.io/og-image.png" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:site_name" content="402 Index">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${description}">${googleVerification}${canonicalTag}${jsonLdTag}${plausibleScript}
  <title>${title === '402 Index' ? '402 Index' : `${escapeHtml(title)} — 402 Index`}</title>
  <style>${styles}</style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo"><span>402</span>index</a>
      <nav>
        <a href="/">Overview</a>
        <a href="/stats">Stats</a>
        <a href="/directory">Directory</a>
        <a href="/about">About</a>
        <a href="/verify">Verify</a>
        <a href="/api-docs">API</a>
      </nav>
      <button class="nav-toggle" onclick="document.querySelector('nav').classList.toggle('nav-open')" aria-label="Toggle navigation">
        <span></span><span></span><span></span>
      </button>
    </div>
  </header>
  <main>${content}</main>
  <footer>
    <div class="container">
      <span>402 Index — paid API directory for AI agents</span>
      <div class="footer-sources">
        Data sources:
        <a href="https://satring.com" target="_blank" rel="noopener">Satring</a> ·
        <a href="https://x402.org/bazaar" target="_blank" rel="noopener">x402 Bazaar</a> ·
        <a href="https://l402apps.com" target="_blank" rel="noopener">L402 Apps</a> ·
        <a href="https://paysponge.com" target="_blank" rel="noopener">Sponge</a> ·
        <a href="https://mpp.dev" target="_blank" rel="noopener">MPP/Tempo</a>
      </div>
    </div>
  </footer>
</body>
</html>`
}

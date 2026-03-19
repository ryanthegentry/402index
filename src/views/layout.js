import { styles } from './styles.js'

export function layout(title, content, meta = {}) {
  const description = meta.description || 'Protocol-agnostic directory of paid APIs (L402, x402, MPP) for AI agents. Indexed, verified, and searchable.'
  const ogTitle = meta.ogTitle || (title === '402 Index' ? '402 Index' : `${title} — 402 Index`)
  const ogUrl = meta.ogUrl || 'https://402index.io'
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
  <meta property="og:url" content="${ogUrl}">
  <meta property="og:site_name" content="402 Index">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${description}">
  <title>${title === '402 Index' ? '402 Index' : `${title} — 402 Index`}</title>
  <style>${styles}</style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo"><span>402</span>index</a>
      <nav>
        <a href="/">Overview</a>
        <a href="/directory">Directory</a>
        <a href="/about">About</a>
        <a href="/api-docs">API</a>
      </nav>
    </div>
  </header>
  ${content}
  <footer>
    <div class="container">
      <span>402 Index — paid API directory for AI agents</span>
    </div>
  </footer>
</body>
</html>`
}

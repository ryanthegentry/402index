import { styles } from './styles.js'

export function layout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — 402 Index</title>
  <style>${styles}</style>
</head>
<body>
  <header>
    <div class="container">
      <a href="/" class="logo"><span>402</span>index</a>
      <nav>
        <a href="/">Directory</a>
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

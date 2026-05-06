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
        <a href="#getting-started" id="getting-started-link">Getting Started</a>
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
  <div class="gs-backdrop" id="gs-backdrop" style="display:none">
    <div class="gs-modal" role="dialog" aria-modal="true" aria-labelledby="gs-headline">
      <button class="gs-close" id="gs-close" aria-label="Close">&times;</button>
      <h2 id="gs-headline">Discover the best paid APIs on the agentic web</h2>
      <p class="gs-subhead">Two ways to give your agent the 402 Index toolkit.</p>
      <div class="gs-section">
        <h3>Install the MCP server</h3>
        <p>Direct programmatic discovery of every L402, x402, and MPP endpoint we index. Works in Claude Desktop, Claude Code, Cursor, Cline, Windsurf, Gemini CLI, and Codex.</p>
        <div class="example-block"><button class="copy-btn" onclick="copyExample(this)">Copy</button>npm install -g @402index/mcp-server</div>
        <a href="https://github.com/ryanthegentry/402index/tree/master/mcp-server" target="_blank" rel="noopener">README on GitHub &rarr;</a>
      </div>
      <div class="gs-section">
        <h3>Read the skill</h3>
        <p>Teach your agent how to navigate 402 Index intelligently &mdash; search, filter, pay, and fall back across rails.</p>
        <a href="https://402index.io/SKILL.md" target="_blank" rel="noopener">SKILL.md &rarr;</a>
        <p class="gs-helper">To install manually: save to ~/.claude/skills/402index/SKILL.md. A one-line plugin install is coming soon.</p>
      </div>
      <div class="gs-footer-ctas">
        <a href="/directory" class="gs-cta">Browse Directory</a>
        <a href="/api-docs" class="gs-cta">Read Docs</a>
      </div>
    </div>
  </div>
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
  <script>
  (function() {
    var backdrop = document.getElementById('gs-backdrop');
    var closeBtn = document.getElementById('gs-close');
    var trigger = document.getElementById('getting-started-link');

    function openModal(e) {
      e.preventDefault();
      document.querySelector('nav').classList.remove('nav-open');
      backdrop.style.display = '';
      closeBtn.focus();
      if (window.plausible) plausible('Getting Started Opened');
      document.addEventListener('keydown', onKey);
    }

    function closeModal() {
      backdrop.style.display = 'none';
      trigger.focus();
      document.removeEventListener('keydown', onKey);
    }

    function onKey(e) {
      if (e.key === 'Escape') { closeModal(); return; }
      if (e.key !== 'Tab') return;
      var focusable = backdrop.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    function copyExample(btn) {
      var block = btn.parentElement;
      var text = block.textContent.replace('Copy', '').trim();
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied!';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
      if (window.plausible) plausible('Install Command Copied');
    }
    window.copyExample = copyExample;

    trigger.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    backdrop.addEventListener('click', function(e) {
      if (e.target === backdrop) closeModal();
    });
  })();
  </script>
</body>
</html>`
}

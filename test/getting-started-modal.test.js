import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { layout } from '../src/views/layout.js'

describe('Getting Started modal', () => {
  const html = layout('Test Page', '<p>test</p>')

  it('nav link is the first <a> inside <nav>', () => {
    const navMatch = html.match(/<nav>([\s\S]*?)<\/nav>/)
    assert.ok(navMatch, 'Expected <nav> element in layout output')
    const navContent = navMatch[1]
    const firstAnchor = navContent.match(/<a\s[^>]*>/)
    assert.ok(firstAnchor, 'Expected at least one <a> inside <nav>')
    assert.ok(
      firstAnchor[0].includes('id="getting-started-link"'),
      'First <a> in nav must have id="getting-started-link"'
    )
    assert.ok(
      firstAnchor[0].includes('href="#getting-started"'),
      'First <a> in nav must have href="#getting-started"'
    )
    assert.ok(
      navContent.match(/<a[^>]*id="getting-started-link"[^>]*>Getting Started<\/a>/),
      'First nav link text must be "Getting Started"'
    )
  })

  it('modal has correct ARIA attributes', () => {
    assert.ok(
      html.includes('role="dialog"'),
      'Modal must have role="dialog"'
    )
    assert.ok(
      html.includes('aria-modal="true"'),
      'Modal must have aria-modal="true"'
    )
    assert.ok(
      html.includes('aria-labelledby="gs-headline"'),
      'Modal must have aria-labelledby="gs-headline"'
    )
  })

  it('install command is inside an .example-block', () => {
    const exampleBlockPattern = /class="example-block"[^>]*>[\s\S]*?npm install -g @402index\/mcp-server[\s\S]*?<\/div>/
    assert.ok(
      exampleBlockPattern.test(html),
      'Install command "npm install -g @402index/mcp-server" must appear inside an .example-block'
    )
  })

  it('SKILL.md link points to https://402index.io/SKILL.md', () => {
    assert.ok(
      html.includes('href="https://402index.io/SKILL.md"'),
      'Must contain link to https://402index.io/SKILL.md'
    )
  })

  it('footer CTAs link to /directory and /api-docs inside the modal', () => {
    // Extract modal content (between role="dialog" and its closing)
    const modalMatch = html.match(/role="dialog"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)
    assert.ok(modalMatch, 'Expected modal markup with role="dialog"')
    const modalContent = modalMatch[0]
    assert.ok(
      modalContent.includes('href="/directory"'),
      'Modal must contain a link to /directory'
    )
    assert.ok(
      modalContent.includes('href="/api-docs"'),
      'Modal must contain a link to /api-docs'
    )
  })

  it('copy button uses copyExample(this) onclick inside the modal', () => {
    const modalMatch = html.match(/role="dialog"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)
    assert.ok(modalMatch, 'Expected modal markup')
    const modalContent = modalMatch[0]
    assert.ok(
      /button[^>]*class="copy-btn"[^>]*onclick="copyExample\(this\)"/.test(modalContent),
      'Modal must contain a <button> with class="copy-btn" and onclick="copyExample(this)"'
    )
  })

  it('close button exists inside the modal', () => {
    const modalMatch = html.match(/role="dialog"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/)
    assert.ok(modalMatch, 'Expected modal markup')
    const modalContent = modalMatch[0]
    assert.ok(
      /button[^>]*class="gs-close"/.test(modalContent) || /class="gs-close"[^>]*>/.test(modalContent),
      'Modal must contain a close button with class="gs-close"'
    )
  })
})

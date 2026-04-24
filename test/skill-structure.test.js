import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const skill = readFileSync(`${ROOT}/SKILL.md`, 'utf8')
const lines = skill.split('\n')

describe('SKILL.md structure', () => {
  it('frontmatter contains version: 0.1.0 between name: and description:', () => {
    const fmStart = lines.indexOf('---')
    const fmEnd = lines.indexOf('---', fmStart + 1)
    const fm = lines.slice(fmStart + 1, fmEnd)
    const nameIdx = fm.findIndex(l => l.startsWith('name:'))
    const descIdx = fm.findIndex(l => l.startsWith('description:'))
    const versionIdx = fm.findIndex(l => l.trim() === 'version: 0.1.0')
    assert.ok(versionIdx !== -1, 'version: 0.1.0 must exist in frontmatter')
    assert.ok(versionIdx > nameIdx, 'version must come after name:')
    assert.ok(versionIdx < descIdx, 'version must come before description:')
  })

  it('### Known-good endpoints (fallback) exists between ## Quick Start and ## Step 1', () => {
    const quickStartIdx = lines.findIndex(l => l.trim() === '## Quick Start')
    const step1Idx = lines.findIndex(l => l.trim() === '## Step 1: Discover — Find the Right Endpoint')
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1, '### Known-good endpoints (fallback) heading must exist')
    assert.ok(fallbackIdx > quickStartIdx, 'fallback heading must be after ## Quick Start')
    assert.ok(fallbackIdx < step1Idx, 'fallback heading must be before ## Step 1')
  })

  it('fallback sub-section contains a last_verified date in YYYY-MM-DD format', () => {
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1, 'fallback heading must exist')
    // Scan from fallback heading to next ## heading
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const section = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2).join('\n')
    assert.match(section, /\d{4}-\d{2}-\d{2}/, 'must contain a YYYY-MM-DD date')
  })

  it('fallback table contains all four required URLs', () => {
    const urls = [
      'faucet.mutinynet.com/api/l402',
      'api.nansen.ai/api/v1/tgm/who-bought-sold',
      'llm402.ai/v1/chat/completions/Kimi-K2.6',
      'mpp.api.agentmail.to/v0/inboxes',
    ]
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1)
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const section = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2).join('\n')
    for (const url of urls) {
      assert.ok(section.includes(url), `fallback section must contain ${url}`)
    }
  })

  it('fallback table covers all three protocols: L402, x402, MPP', () => {
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1)
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const section = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2).join('\n')
    // Check protocol column cells — look for these strings in table rows
    const tableRows = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2)
      .filter(l => l.startsWith('|') && !l.includes('---'))
    const protocolCells = tableRows.map(r => {
      const cells = r.split('|').map(c => c.trim())
      return cells[2] || '' // Protocol(s) column
    }).join(' ')
    assert.ok(protocolCells.includes('L402'), 'must cover L402 protocol')
    assert.ok(protocolCells.includes('x402'), 'must cover x402 protocol')
    assert.ok(protocolCells.includes('MPP'), 'must cover MPP protocol')
  })

  it('llm402 Kimi-K2.6 row is marked as dual-rail with both L402 and x402', () => {
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1)
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const tableRows = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2)
      .filter(l => l.startsWith('|') && /kimi/i.test(l))
    assert.ok(tableRows.length > 0, 'must have a Kimi-K2.6 row')
    const kimiRow = tableRows[0]
    assert.ok(/dual.?rail/i.test(kimiRow), 'Kimi row must contain "dual-rail"')
    const cells = kimiRow.split('|').map(c => c.trim())
    const protocolCell = cells[2] || ''
    assert.ok(protocolCell.includes('L402') && protocolCell.includes('x402'),
      'Kimi protocol cell must list both L402 and x402')
  })

  it('llm402 row shows pricing for both rails', () => {
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1)
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const tableRows = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2)
      .filter(l => l.startsWith('|') && /kimi/i.test(l))
    assert.ok(tableRows.length > 0)
    const kimiRow = tableRows[0]
    assert.ok(kimiRow.includes('21 sats'), 'Kimi row must show 21 sats for L402 rail')
    assert.ok(kimiRow.includes('0.0079') || kimiRow.includes('42 sats'),
      'Kimi row must show x402 price (0.0079 or 42 sats)')
  })

  it('prose explains dual-rail concept', () => {
    const fallbackIdx = lines.findIndex(l => l.trim() === '### Known-good endpoints (fallback)')
    assert.ok(fallbackIdx !== -1)
    const nextH2 = lines.findIndex((l, i) => i > fallbackIdx && /^## /.test(l))
    const section = lines.slice(fallbackIdx, nextH2 === -1 ? undefined : nextH2).join('\n')
    const hasDualRailExplanation =
      section.includes('registered twice') ||
      section.includes('both rails') ||
      section.includes('dual-rail coverage')
    assert.ok(hasDualRailExplanation,
      'must contain "registered twice", "both rails", or "dual-rail coverage"')
  })

  it('does NOT contain "Claude Code (or any agent)"', () => {
    assert.ok(!skill.includes('Claude Code (or any agent)'),
      'SKILL.md must not contain "Claude Code (or any agent)"')
  })

  it('contains "An agent cannot generate images on its own"', () => {
    assert.ok(skill.includes('An agent cannot generate images on its own'),
      'SKILL.md must contain "An agent cannot generate images on its own"')
  })
})

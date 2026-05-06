import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { styles } from '../src/views/styles.js'

describe('Getting Started modal styles', () => {
  it('.gs-backdrop has z-index >= 1000', () => {
    const backdropMatch = styles.match(/\.gs-backdrop\s*\{[^}]*\}/)
    assert.ok(backdropMatch, 'styles must contain .gs-backdrop rule')
    const zIndexMatch = backdropMatch[0].match(/z-index\s*:\s*(\d+)/)
    assert.ok(zIndexMatch, '.gs-backdrop must have a z-index')
    assert.ok(
      parseInt(zIndexMatch[1], 10) >= 1000,
      `.gs-backdrop z-index must be >= 1000, got ${zIndexMatch[1]}`
    )
  })

  it('.gs-modal has z-index greater than .gs-backdrop', () => {
    const backdropMatch = styles.match(/\.gs-backdrop\s*\{[^}]*\}/)
    assert.ok(backdropMatch, 'styles must contain .gs-backdrop rule')
    const backdropZ = parseInt(backdropMatch[0].match(/z-index\s*:\s*(\d+)/)[1], 10)

    const modalMatch = styles.match(/\.gs-modal\s*\{[^}]*\}/)
    assert.ok(modalMatch, 'styles must contain .gs-modal rule')
    const modalZ = parseInt(modalMatch[0].match(/z-index\s*:\s*(\d+)/)[1], 10)

    assert.ok(
      modalZ > backdropZ,
      `.gs-modal z-index (${modalZ}) must be greater than .gs-backdrop z-index (${backdropZ})`
    )
  })

  it('@media (max-width: 480px) targets the modal', () => {
    // Find all @media (max-width: 480px) blocks and check if any target .gs-modal
    const mobileRules = [...styles.matchAll(/@media\s*\(\s*max-width\s*:\s*480px\s*\)\s*\{/g)]
    assert.ok(mobileRules.length > 0, 'styles must contain @media (max-width: 480px) rule')
    // Check full content after each match for .gs-modal
    const hasGsModal = mobileRules.some(m => {
      const after = styles.slice(m.index)
      // Find the matching closing brace by counting braces
      let depth = 0
      let entered = false
      for (let i = 0; i < after.length; i++) {
        if (after[i] === '{') { depth++; entered = true }
        if (after[i] === '}') depth--
        if (entered && depth === 0) return after.slice(0, i).includes('.gs-modal')
      }
      return false
    })
    assert.ok(hasGsModal, '@media (max-width: 480px) rule must target .gs-modal')
  })
})

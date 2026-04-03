import { test, expect } from '@playwright/test'

// Dynamic import of the handler generator — this file must exist for tests to run
const { generateHandlerTests } = await import('../../scripts/generate-handler-tests.js')

const testCases = generateHandlerTests()

test.describe('Inline handler smoke tests', () => {
  test('generator finds at least 27 handlers', () => {
    expect(testCases.length).toBeGreaterThanOrEqual(27)
  })

  for (const tc of testCases) {
    test(`${tc.file} — ${tc.type} on ${tc.selector} fires without error`, async ({ page }) => {
      const errors = []
      page.on('pageerror', err => errors.push(err.message))
      page.on('console', msg => {
        if (msg.type() === 'error') errors.push(msg.text())
      })

      await page.goto(tc.route)

      const el = page.locator(tc.selector).first()
      await expect(el).toBeVisible({ timeout: 5000 })

      // Snapshot DOM before interaction
      const before = await page.content()

      if (tc.type === 'click') {
        await el.click()
      } else if (tc.type === 'change') {
        // For select elements, pick the last option to trigger onchange
        const tag = await el.evaluate(e => e.tagName.toLowerCase())
        if (tag === 'select') {
          const options = await el.locator('option').all()
          if (options.length > 1) {
            const val = await options[options.length - 1].getAttribute('value')
            await el.selectOption(val)
          }
        } else {
          await el.fill('test')
        }
      }

      // Allow time for handler side-effects
      await page.waitForTimeout(500)

      // Assert no console errors fired
      expect(errors, `Console errors on ${tc.file} ${tc.selector}`).toEqual([])

      // Assert DOM changed (handler had an effect)
      const after = await page.content()
      expect(after).not.toBe(before)
    })
  }
})

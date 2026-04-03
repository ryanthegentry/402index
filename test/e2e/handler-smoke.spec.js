import { test, expect } from '@playwright/test'

// Dynamic import of the handler generator — this file must exist for tests to run
const { generateHandlerTests } = await import('../../scripts/generate-handler-tests.js')

const testCases = generateHandlerTests()

test.describe('Inline handler smoke tests', () => {
  test('generator finds at least 26 handlers', () => {
    expect(testCases.length).toBeGreaterThanOrEqual(26)
  })

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i]
    test(`[${i}] ${tc.file} — ${tc.type} on ${tc.selector} fires without error`, async ({ page, context }) => {
      const errors = []
      page.on('pageerror', err => errors.push(err.message))
      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = msg.text()
          // Clipboard writeText fails in test contexts — not a handler bug
          if (text.includes('Clipboard') || text.includes('clipboard')) return
          errors.push(text)
        }
      })

      // Grant clipboard permissions for copy button tests
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])

      // Some elements are only visible on mobile viewports
      if (tc.selector.includes('nav-toggle') || tc.selector.includes('filter-toggle')) {
        await page.setViewportSize({ width: 375, height: 667 })
      }

      await page.goto(tc.route, { waitUntil: 'domcontentloaded' })

      const el = page.locator(tc.selector).nth(tc.nth)
      await expect(el).toBeAttached({ timeout: 5000 })

      if (tc.type === 'click') {
        // For handlers that navigate (location.href, form.submit), just verify
        // the handler fires without JS errors — don't assert DOM change
        const navigates = tc.handler.includes('location.href')
        if (navigates) {
          const [response] = await Promise.all([
            page.waitForNavigation({ timeout: 5000 }).catch(() => null),
            el.click({ force: true }),
          ])
          // Navigation happened = handler fired successfully
        } else {
          await el.click({ force: true })
          await page.waitForTimeout(300)
        }
      } else if (tc.type === 'change') {
        // onchange handlers on selects/checkboxes typically submit the form
        const tag = await el.evaluate(e => e.tagName.toLowerCase())
        const inputType = await el.evaluate(e => e.type || '')

        if (tag === 'select') {
          const options = await el.locator('option').all()
          if (options.length > 1) {
            const val = await options[options.length - 1].getAttribute('value')
            await Promise.all([
              page.waitForNavigation({ timeout: 5000 }).catch(() => null),
              el.selectOption(val),
            ])
          }
        } else if (inputType === 'checkbox') {
          await Promise.all([
            page.waitForNavigation({ timeout: 5000 }).catch(() => null),
            el.check({ force: true }),
          ])
        } else {
          await el.fill('test')
        }
      }

      // Assert no JS errors fired during handler interaction
      expect(errors, `Console errors on ${tc.file} ${tc.selector}`).toEqual([])
    })
  }
})

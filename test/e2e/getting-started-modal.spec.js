import { test, expect } from '@playwright/test'

test.describe('Getting Started modal behavior', () => {
  test('clicking #getting-started-link opens modal with .gs-open class', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await expect(page.locator('.gs-backdrop')).toHaveClass(/gs-open/)
  })

  test('clicking #gs-close closes the modal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await expect(page.locator('.gs-backdrop')).toHaveClass(/gs-open/)
    await page.click('#gs-close')
    await expect(page.locator('.gs-backdrop')).not.toHaveClass(/gs-open/)
  })

  test('clicking backdrop (not .gs-modal) closes modal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await expect(page.locator('.gs-backdrop')).toHaveClass(/gs-open/)
    // Click top-left corner of backdrop (outside the centered modal)
    await page.locator('.gs-backdrop').click({ position: { x: 5, y: 5 } })
    await expect(page.locator('.gs-backdrop')).not.toHaveClass(/gs-open/)
  })

  test('pressing Escape closes modal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await expect(page.locator('.gs-backdrop')).toHaveClass(/gs-open/)
    await page.keyboard.press('Escape')
    await expect(page.locator('.gs-backdrop')).not.toHaveClass(/gs-open/)
  })

  test('opening modal focuses the close button', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await expect(page.locator('#gs-close')).toBeFocused()
  })

  test('closing modal returns focus to #getting-started-link', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')
    await page.click('#gs-close')
    await expect(page.locator('#getting-started-link')).toBeFocused()
  })

  test('Tab traps focus within modal', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.click('#getting-started-link')

    // Get all focusable elements inside the backdrop
    const focusable = page.locator('.gs-backdrop').locator('a[href], button, [tabindex]:not([tabindex="-1"])')
    const count = await focusable.count()
    expect(count).toBeGreaterThanOrEqual(2)

    // Tab from last focusable → should wrap to first
    await focusable.last().focus()
    await page.keyboard.press('Tab')
    await expect(focusable.first()).toBeFocused()

    // Shift-Tab from first → should wrap to last
    await page.keyboard.press('Shift+Tab')
    await expect(focusable.last()).toBeFocused()
  })
})

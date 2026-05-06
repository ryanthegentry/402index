import { test, expect } from '@playwright/test'

const VIEWPORTS = [1024, 1200, 1280, 1366, 1440]

test.describe('Agent Discovery filter chips do not overflow panel', () => {
  for (const width of VIEWPORTS) {
    test(`at ${width}px viewport, all filter groups stay inside .demo-search`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/', { waitUntil: 'domcontentloaded' })

      const panel = page.locator('.demo-search').first()
      const lastFilterSelect = panel.locator('.demo-filter-group').last().locator('select')

      await expect(panel).toBeVisible()
      await expect(lastFilterSelect).toBeVisible()

      const panelBox = await panel.boundingBox()
      const filterBox = await lastFilterSelect.boundingBox()

      expect(panelBox).not.toBeNull()
      expect(filterBox).not.toBeNull()
      expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
      expect(filterBox.x).toBeGreaterThanOrEqual(panelBox.x)
    })
  }
})

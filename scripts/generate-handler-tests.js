/**
 * generate-handler-tests.js
 *
 * Scans src/views/*.js for inline onclick/onchange attributes and generates
 * an array of test case objects for Playwright smoke tests.
 *
 * Each test case: { file, route, selector, handler, type, nth }
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VIEWS_DIR = join(__dirname, '..', 'src', 'views')

// Map view filenames → routes for testing
const ROUTE_MAP = {
  'home.js': '/directory',
  'api-docs.js': '/api-docs',
  'opportunities.js': '/opportunities',
  'layout.js': '/',
}

/**
 * Extract inline event handlers from view files via regex.
 * Handles template literals with escapeHtml() wrappers and other expressions.
 */
export function generateHandlerTests() {
  const testCases = []
  const viewFiles = readdirSync(VIEWS_DIR).filter(f => f.endsWith('.js'))

  for (const file of viewFiles) {
    const route = ROUTE_MAP[file]
    if (!route) continue // skip files not in the route map

    const source = readFileSync(join(VIEWS_DIR, file), 'utf8')

    // Match on(click|change)="..." — handle both single and double quotes
    // The regex captures: the surrounding HTML tag to build a selector,
    // the event type, and the handler code
    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Find all onclick/onchange attributes on this line
      const handlerRe = /on(click|change)="([^"]+)"/g
      let match
      while ((match = handlerRe.exec(line)) !== null) {
        const type = match[1] === 'click' ? 'click' : 'change'
        const handler = match[2]

        // Build a CSS selector from context on this line
        const selector = buildSelector(line, match.index, file, i + 1)

        testCases.push({
          file,
          route,
          selector,
          handler,
          type,
        })
      }
    }
  }

  // Assign nth index per (route, selector) group so tests target the right element
  const counts = {}
  for (const tc of testCases) {
    const key = `${tc.route}::${tc.selector}`
    counts[key] = (counts[key] || 0)
    tc.nth = counts[key]
    counts[key]++
  }

  return testCases
}

/**
 * Build a CSS selector for the element containing the handler.
 * Examines the HTML tag on the same line to extract tag name, class, name attr, etc.
 */
function buildSelector(line, handlerPos, file, lineNum) {
  // Find the opening tag that contains this handler
  // Walk backwards from handlerPos to find '<tagname'
  const before = line.substring(0, handlerPos)
  const tagMatch = before.match(/<(\w+)(?:\s[^>]*)?$/)

  if (!tagMatch) {
    // Fallback: use a generic attribute selector
    return `[onclick], [onchange]`
  }

  const tag = tagMatch[1]
  const fullTag = line.substring(tagMatch.index)

  // Try to extract identifying attributes in priority order
  const nameMatch = fullTag.match(/name="([^"]+)"/)
  if (nameMatch) {
    return `${tag}[name="${nameMatch[1]}"]`
  }

  const classMatch = fullTag.match(/class="([^"]+)"/)
  if (classMatch) {
    return `${tag}.${classMatch[1].split(/\s+/).join('.')}`
  }

  const ariaLabelMatch = fullTag.match(/aria-label="([^"]+)"/)
  if (ariaLabelMatch) {
    return `${tag}[aria-label="${ariaLabelMatch[1]}"]`
  }

  // For table rows with onclick containing location.href, use tr[onclick]
  if (tag === 'tr') {
    return 'tr[onclick]'
  }

  // For copy buttons, use the class
  if (tag === 'button' && fullTag.includes('copy-btn')) {
    return 'button.copy-btn'
  }

  // Fallback
  return `${tag}[on${line.includes('onclick') ? 'click' : 'change'}]`
}

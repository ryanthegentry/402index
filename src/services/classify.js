import db from '../db.js'

const DEMO_KEYWORDS = new Set([
  'demo', 'test', 'example', 'starter', 'template', 'tutorial', 'hello', 'sample', 'placeholder',
])

const TEMPLATE_THRESHOLD = 5

export function flagTemplates(database = db) {
  const rows = database.prepare('SELECT id, url FROM services').all()
  const byPathname = new Map()

  for (const row of rows) {
    let pathname
    try {
      pathname = new URL(row.url).pathname
    } catch {
      continue
    }
    if (!byPathname.has(pathname)) byPathname.set(pathname, [])
    byPathname.get(pathname).push(row)
  }

  const update = database.prepare('UPDATE services SET is_template = 1 WHERE id = ?')
  let count = 0

  const txn = database.transaction(() => {
    for (const [, group] of byPathname) {
      const distinctHosts = new Set()
      for (const row of group) {
        try {
          distinctHosts.add(new URL(row.url).hostname)
        } catch { /* skip */ }
      }
      if (distinctHosts.size >= TEMPLATE_THRESHOLD) {
        for (const row of group) {
          update.run(row.id)
          count++
        }
      }
    }
  })
  txn()

  return count
}

export function flagDemos(database = db) {
  const rows = database.prepare('SELECT id, url FROM services').all()
  const update = database.prepare('UPDATE services SET is_demo = 1 WHERE id = ?')
  let count = 0

  const txn = database.transaction(() => {
    for (const row of rows) {
      let hostname
      try {
        hostname = new URL(row.url).hostname
      } catch {
        continue
      }
      const segments = hostname.split('.').flatMap(s => s.split('-'))
      if (segments.some(seg => DEMO_KEYWORDS.has(seg))) {
        update.run(row.id)
        count++
      }
    }
  })
  txn()

  return count
}

export function classifyServices(database = db) {
  database.prepare('UPDATE services SET is_template = 0, is_demo = 0').run()
  const templates = flagTemplates(database)
  const demos = flagDemos(database)
  console.log(`[classify] Classified: ${templates} templates, ${demos} demos`)
}

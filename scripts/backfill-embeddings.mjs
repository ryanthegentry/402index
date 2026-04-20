#!/usr/bin/env node

// Operator-invoked backfill script for service_embeddings.
// NOT wired into boot, cron, or CI. Run manually:
//   node scripts/backfill-embeddings.mjs --yes [--dry-run] [--force] [--batch-size N] [--rate-limit N]

import db from '../src/db.js'
import { composeEmbeddingInput } from '../src/services/embeddings.js'

const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    yes: false,
    dryRun: false,
    force: false,
    batchSize: 50,
    rateLimit: 3000,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yes') args.yes = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--force') args.force = true
    else if (arg === '--batch-size' && argv[i + 1]) args.batchSize = parseInt(argv[++i], 10)
    else if (arg === '--rate-limit' && argv[i + 1]) args.rateLimit = parseInt(argv[++i], 10)
  }
  return args
}

// ─── OpenAI caller with retries ──────────────────────────────────────────────

async function callOpenAIWithRetry(text, apiKey) {
  const delays = [1000, 2000, 4000]
  let lastErr

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: MODEL, input: text }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(`OpenAI ${res.status}: ${body?.error?.message || 'unknown'}`)
      }

      const body = await res.json()
      const values = body.data?.[0]?.embedding
      if (!values || values.length !== DIMENSIONS) {
        throw new Error('unexpected response shape from OpenAI')
      }

      return new Float32Array(values)
    } catch (err) {
      lastErr = err
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, delays[attempt]))
      }
    }
  }

  throw lastErr
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv)

  if (!args.yes) {
    console.log('Usage: node scripts/backfill-embeddings.mjs --yes [--dry-run] [--force] [--batch-size N] [--rate-limit N]')
    console.log('')
    console.log('Flags:')
    console.log('  --yes          Required to proceed (safety gate)')
    console.log('  --dry-run      Print counts and exit without calling OpenAI')
    console.log('  --force        Re-embed rows that already have embeddings')
    console.log('  --batch-size N Rows per batch (default 50)')
    console.log('  --rate-limit N Milliseconds between batches (default 3000)')
    process.exit(1)
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is not set')
    process.exit(1)
  }

  // Query for services needing embeddings
  const query = args.force
    ? 'SELECT id, name, description, category FROM services ORDER BY id ASC'
    : `SELECT s.id, s.name, s.description, s.category
       FROM services s
       LEFT JOIN service_embeddings se ON se.service_id = s.id
       WHERE se.service_id IS NULL
       ORDER BY s.id ASC`

  const services = db.prepare(query).all()

  // Count orphans
  const orphanCount = db.prepare(
    'SELECT COUNT(*) as c FROM service_embeddings WHERE service_id NOT IN (SELECT id FROM services)'
  ).get().c

  if (args.dryRun) {
    console.log(JSON.stringify({ would_embed: services.length, would_delete_orphans: orphanCount }))
    process.exit(0)
  }

  const startTime = Date.now()
  let embedded = 0
  let skipped = 0
  let failed = 0

  const upsert = db.prepare(`
    INSERT INTO service_embeddings (service_id, embedding, model, embedded_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(service_id) DO UPDATE SET
      embedding = excluded.embedding,
      model = excluded.model,
      embedded_at = excluded.embedded_at
  `)

  // Process in batches
  for (let i = 0; i < services.length; i += args.batchSize) {
    const batch = services.slice(i, i + args.batchSize)

    for (const service of batch) {
      const inputText = composeEmbeddingInput(service)

      try {
        const embedding = await callOpenAIWithRetry(inputText, apiKey)
        const blob = Buffer.from(embedding.buffer)
        const embeddedAt = Math.floor(Date.now() / 1000)
        upsert.run(service.id, blob, MODEL, embeddedAt)
        embedded++
      } catch (err) {
        console.error(`[backfill] failed service_id=${service.id}: ${err.message}`)
        failed++
      }
    }

    // Rate limit between batches (not after the last one)
    if (args.rateLimit > 0 && i + args.batchSize < services.length) {
      await new Promise(r => setTimeout(r, args.rateLimit))
    }
  }

  // Orphan cleanup pass
  const orphanResult = db.prepare(
    'DELETE FROM service_embeddings WHERE service_id NOT IN (SELECT id FROM services)'
  ).run()
  const orphansDeleted = orphanResult.changes

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000)
  const summary = { embedded, skipped: services.length - embedded - failed, failed, orphans_deleted: orphansDeleted, elapsed_seconds: elapsedSeconds }
  console.log(JSON.stringify(summary))

  process.exit(failed > 0 ? 2 : 0)
}

try {
  await main()
} catch (err) {
  console.error(`[backfill] Fatal: ${err.message}`)
  process.exit(1)
}

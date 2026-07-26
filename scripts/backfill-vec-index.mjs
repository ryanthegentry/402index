#!/usr/bin/env node

// Operator-invoked backfill for the sqlite-vec KNN index (vec_service_embeddings).
// NOT wired into boot, cron, or CI. Run manually:
//   node scripts/backfill-vec-index.mjs --yes [--dry-run] [--rebuild] [--batch-size N] [--pause-ms N]
//
// Why this is a script and not a startup step: on 2026-04-15 an FTS5 backfill that
// ran at boot interleaved with concurrent poller writes through sync triggers and
// corrupted the virtual table's shadow tables, taking the site down for ~2h50m. vec0
// has shadow tables too. This copies vectors that already exist in service_embeddings
// into the index in bounded batches, each in its own transaction, with a pause
// between them so the poller and health checker keep getting their turn at the
// write lock. It reads no network and calls no API.

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function printUsage() {
  console.log('Usage: node scripts/backfill-vec-index.mjs --yes [--dry-run] [--rebuild] [--batch-size N] [--pause-ms N]')
  console.log('')
  console.log('Flags:')
  console.log('  --help, -h       Show this help message')
  console.log('  --yes            Required to proceed (safety gate)')
  console.log('  --dry-run        Print what would happen and exit without writing')
  console.log('  --rebuild        Drop and recreate the index before loading (use after a dimension change)')
  console.log('  --batch-size N   Rows per transaction (default 500)')
  console.log('  --pause-ms N     Milliseconds to sleep between batches (default 50)')
}

function parseArgs(argv) {
  const args = { help: false, yes: false, dryRun: false, rebuild: false, batchSize: 500, pauseMs: 50 }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--yes') args.yes = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--rebuild') args.rebuild = true
    else if (arg === '--batch-size' && argv[i + 1]) args.batchSize = parseInt(argv[++i], 10)
    else if (arg === '--pause-ms' && argv[i + 1]) args.pauseMs = parseInt(argv[++i], 10)
  }
  return args
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) { printUsage(); process.exit(0) }
  if (!args.yes && !args.dryRun) {
    console.error('Refusing to run without --yes (or --dry-run).')
    printUsage()
    process.exit(1)
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1) {
    console.error(`Invalid --batch-size: ${args.batchSize}`)
    process.exit(1)
  }
  if (!Number.isInteger(args.pauseMs) || args.pauseMs < 0) {
    console.error(`Invalid --pause-ms: ${args.pauseMs}`)
    process.exit(1)
  }

  const dbMod = await import('../src/db.js')
  const db = dbMod.default
  const { SQLITE_VEC_AVAILABLE, ensureVecIndex, VEC_DIMENSIONS, getVecIndexStats } = dbMod

  if (!SQLITE_VEC_AVAILABLE) {
    console.error('sqlite-vec is not available in this process — nothing to backfill.')
    process.exit(1)
  }

  if (args.rebuild) {
    if (args.dryRun) {
      console.log('[dry-run] would DROP TABLE vec_service_embeddings and recreate it')
    } else {
      console.log('Dropping and recreating vec_service_embeddings...')
      db.exec('DROP TABLE IF EXISTS vec_service_embeddings')
    }
  }
  if (!args.dryRun) ensureVecIndex(db)

  const before = getVecIndexStats(db)
  console.log(`service_embeddings rows : ${before.embeddings}`)
  console.log(`vec index rows          : ${before.indexed}`)

  // Only load what is missing, so a interrupted run resumes where it stopped.
  const missing = db.prepare(`
    SELECT se.service_id, se.embedding
    FROM service_embeddings se
    WHERE NOT EXISTS (
      SELECT 1 FROM vec_service_embeddings v WHERE v.service_id = se.service_id
    )
  `)

  const pending = missing.all()
  console.log(`rows to index           : ${pending.length}`)

  if (args.dryRun) {
    console.log(`[dry-run] would index ${pending.length} rows in ${Math.ceil(pending.length / args.batchSize)} batches of ${args.batchSize}`)
    process.exit(0)
  }
  if (pending.length === 0) {
    console.log('Index already complete — nothing to do.')
    process.exit(0)
  }

  const ins = db.prepare('INSERT INTO vec_service_embeddings(service_id, embedding) VALUES (?, ?)')
  const del = db.prepare('DELETE FROM vec_service_embeddings WHERE service_id = ?')
  const writeBatch = db.transaction((batch) => {
    for (const row of batch) {
      del.run(row.service_id)
      ins.run(row.service_id, row.embedding)
    }
  })

  let indexed = 0, skipped = 0
  const started = Date.now()

  for (let i = 0; i < pending.length; i += args.batchSize) {
    const raw = pending.slice(i, i + args.batchSize)
    // Drop malformed vectors rather than letting one bad blob abort the batch.
    const batch = []
    for (const row of raw) {
      const bytes = row.embedding?.byteLength ?? 0
      if (bytes !== VEC_DIMENSIONS * 4) {
        console.warn(`  skipping ${row.service_id}: ${bytes} bytes, expected ${VEC_DIMENSIONS * 4}`)
        skipped++
        continue
      }
      batch.push(row)
    }

    if (batch.length > 0) {
      try {
        writeBatch(batch)
        indexed += batch.length
      } catch (err) {
        console.warn(`  batch at offset ${i} failed (${err.message}) — retrying row by row`)
        for (const row of batch) {
          try { writeBatch([row]); indexed++ } catch (rowErr) {
            console.warn(`  skipping ${row.service_id}: ${rowErr.message}`)
            skipped++
          }
        }
      }
    }

    const done = Math.min(i + args.batchSize, pending.length)
    if (done % (args.batchSize * 10) === 0 || done === pending.length) {
      const rate = indexed / ((Date.now() - started) / 1000 || 1)
      console.log(`  ${done}/${pending.length} (${indexed} indexed, ${skipped} skipped, ${rate.toFixed(0)}/s)`)
    }

    // Yield the write lock so pollers and health checks are not starved.
    if (args.pauseMs > 0 && done < pending.length) await sleep(args.pauseMs)
  }

  const after = getVecIndexStats(db)
  console.log('')
  console.log(`Indexed ${indexed} rows in ${((Date.now() - started) / 1000).toFixed(1)}s (${skipped} skipped)`)
  console.log(`vec index rows now      : ${after.indexed} / ${after.embeddings} embeddings`)
  // Malformed blobs can never be indexed, so they are not "remaining work" — saying
  // otherwise would send the operator into a re-run loop that can never converge.
  const stillPending = after.embeddings - after.indexed - skipped
  if (stillPending > 0) {
    console.log(`${stillPending} rows still unindexed — re-run to pick up the remainder.`)
  } else if (skipped > 0) {
    console.log(`Index is complete. ${skipped} row(s) have malformed vectors and were skipped permanently — re-embed them with scripts/backfill-embeddings.mjs --force.`)
  } else {
    console.log('Index is complete.')
  }
  process.exit(0)
}

main().catch(err => {
  console.error(`backfill-vec-index failed: ${err.message}`)
  process.exit(1)
})

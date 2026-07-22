/**
 * Process-level backstops so a stray async failure cannot take the server down.
 *
 * Node exits on an unhandled promise rejection. On 2026-07-22 a SQLITE_FULL error escaped an
 * uncaught `.then()` in the scheduler and killed the process twice in twelve hours while HTTP
 * traffic was being served fine. Individual call sites still catch their own errors — this only
 * exists so that missing one is a logged bug rather than an outage.
 */

/**
 * @param {object} [deps]
 * @param {NodeJS.Process} [deps.proc] process to attach to (injectable for tests)
 * @param {Console} [deps.logger] logger to report through
 * @returns {{unhandledRejection: Function, uncaughtException: Function}} the installed handlers
 */
export function installProcessGuards({ proc = process, logger = console } = {}) {
  const unhandledRejection = (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason)
    logger.error(`[process] Unhandled promise rejection (kept alive): ${message}`)
  }

  const uncaughtException = (err) => {
    logger.error(`[process] Uncaught exception (kept alive): ${err?.stack || err?.message || err}`)
  }

  proc.on('unhandledRejection', unhandledRejection)
  proc.on('uncaughtException', uncaughtException)

  return { unhandledRejection, uncaughtException }
}

/**
 * Runs the stale-session reconciler at boot (shortly after SRS hooks settle)
 * and on a fixed interval, so sessions orphaned by an SRS restart get closed
 * even if nobody is watching.
 */
import { reconcileStaleSessions } from '../services/reconcile'

const SWEEP_INTERVAL_MS = 30_000

export default defineNitroPlugin(() => {
  // `bun run generate` imports the server bundle (plugins included) into the
  // CLI process to prerender — starting background loops there keeps the
  // process alive forever and the build hits the platform's timeout.
  if (import.meta.prerender) return

  const sweep = () => reconcileStaleSessions().catch(() => {})
  // unref: never the sole reason the process stays up (matches 01-retention)
  setTimeout(sweep, 5_000).unref?.()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref?.()
})

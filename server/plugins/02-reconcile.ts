/**
 * Runs the stale-session reconciler at boot (shortly after SRS hooks settle)
 * and on a fixed interval, so sessions orphaned by an SRS restart get closed
 * even if nobody is watching.
 */
import { reconcileStaleSessions } from '../services/reconcile'

const SWEEP_INTERVAL_MS = 30_000

export default defineNitroPlugin(() => {
  const sweep = () => reconcileStaleSessions().catch(() => {})
  setTimeout(sweep, 5_000)
  setInterval(sweep, SWEEP_INTERVAL_MS)
})

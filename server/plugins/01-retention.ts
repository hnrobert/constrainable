/**
 * Starts the retention sweeper: an initial pass ~30s after boot, then hourly.
 * retentionDays / orphan age are read live from config each run, so a config
 * change affects the next sweep without a restart.
 */
import { runRetention } from '../services/retention'

export default defineNitroPlugin(() => {
  const tick = (): void => {
    try {
      const r = runRetention()
      if (r.deleted || r.orphans) {
        console.log(`[retention] deleted=${r.deleted} orphans=${r.orphans}`)
      }
    } catch (err) {
      console.error('[retention] sweep failed:', err)
    }
  }

  const initial = setTimeout(tick, 30_000)
  const interval = setInterval(tick, 3_600_000)

  // don't keep the event loop alive solely for retention
  initial.unref?.()
  interval.unref?.()
})

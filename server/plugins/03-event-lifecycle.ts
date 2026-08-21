/**
 * Event lifecycle ticker: auto-start scheduled windows, auto-end + cut
 * streams at window close. Short cadence (20s) — mid-stream cutoff precision
 * and status labels only; admission correctness is per-connection in
 * access-control (withinWindow), so a missed tick never admits late streams.
 */
import { runEventLifecycle } from '../services/event-lifecycle'

export default defineNitroPlugin(() => {
  // no background loops during prerender (see 02-reconcile for the why)
  if (import.meta.prerender) return

  const tick = (): void => {
    try {
      const r = runEventLifecycle()
      if (r.started || r.ended || r.killed) {
        console.log(
          `[event-lifecycle] started=${r.started} ended=${r.ended} streamsCut=${r.killed}`,
        )
      }
    } catch (err) {
      console.error('[event-lifecycle] tick failed:', err)
    }
  }

  setTimeout(tick, 15_000)
  setInterval(tick, 20_000)
})

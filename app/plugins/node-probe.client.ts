/**
 * Latency probe + auto-assignment, run once per visit (full page load) for
 * logged-in users. The browser measures round-trip time to every registered
 * node's PUBLIC origin (no-cors fetch — we only need the timing, not the
 * body) and POSTs the snapshot; the server upserts it (the admin matrix shows
 * each user's latest visit) and assigns a node on the user's FIRST visit
 * (lowest latency among nodes under quota — see services/node-assignment.ts).
 *
 * Silent by design: failures (logged out, nodes unreachable, no public
 * origins in single-server deployments) are expected and non-events.
 */
import { useAuth } from '#imports'

const PROBE_TIMEOUT_MS = 5_000

export default defineNuxtPlugin(async (nuxtApp) => {
  const auth = useAuth()
  if (!auth.probed.value) await auth.fetchSession().catch(() => null)
  if (!auth.user.value) return

  let view: { assigned: string | null; probe: { nodeId: string; publicOrigin: string }[] } | null =
    null
  try {
    view = await $fetch('/api/nodes/assignment')
  } catch {
    return
  }
  if (!view) return

  // Nothing to probe (single-server: nodes have no public origin) — but a
  // first visit still needs an assignment, so report the empty snapshot.
  const latencies: { nodeId: string; latencyMs: number }[] = []
  await Promise.all(
    (view.probe ?? []).map(async (t) => {
      const ms = await probeOnce(t.publicOrigin)
      if (ms != null) latencies.push({ nodeId: t.nodeId, latencyMs: ms })
    }),
  )

  await $fetch('/api/nodes/measure', {
    method: 'POST',
    body: { latencies },
  }).catch(() => null)
})

/** One no-cors round trip; resolves the measured ms (null on failure/timeout). */
async function probeOnce(publicOrigin: string): Promise<number | null> {
  const started = performance.now()
  try {
    await fetch(`${publicOrigin}/crossdomain.xml`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return Math.round(performance.now() - started)
  } catch {
    return null
  }
}

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
import { probeAll } from '~/composables/useNodeLatency'

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
  const measured = await probeAll(view.probe ?? [])
  const latencies = Object.entries(measured).map(([nodeId, latencyMs]) => ({ nodeId, latencyMs }))

  await $fetch('/api/nodes/measure', {
    method: 'POST',
    body: { latencies },
  }).catch(() => null)
})

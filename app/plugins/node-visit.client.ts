/**
 * Visit ping: tells the backend this user just loaded the app. Triggers
 * first-visit node assignment and offline-node reassignment (see
 * services/node-assignment.ts recordVisit) — no latency probing anymore
 * (WebRTC-only playback has no per-node HTTP endpoint to probe; allocation
 * falls back to load-ordering, admins/self-selection can pin explicitly).
 */
import { useAuth } from '#imports'

export default defineNuxtPlugin(async () => {
  const auth = useAuth()
  if (!auth.probed.value) await auth.fetchSession().catch(() => null)
  if (!auth.user.value) return
  await $fetch('/api/nodes/measure', {
    method: 'POST',
    body: { latencies: [] },
  }).catch(() => null)
})

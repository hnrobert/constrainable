/**
 * Record the browser's latency snapshot for this visit (feeds the admin
 * latency matrix). Also the ONE-TIME backfill: a user who somehow has no node
 * yet (registered before this model / while no node was online) is assigned
 * their best node here — with fresh browser RTTs — and never auto-changed
 * again. Any logged-in user; body: { latencies: [{ nodeId, latencyMs }] }.
 * Returns the user's (possibly newly assigned) nodeId.
 */
import { recordVisit } from '../../services/node-assignment'

export default defineEventHandler(async (event) => {
  const auth = requireUser(event)
  const body = await readBody<{ latencies?: { nodeId?: string; latencyMs?: number }[] }>(event)
  const latencies = Array.isArray(body?.latencies)
    ? body.latencies
        .filter((l) => typeof l?.nodeId === 'string' && l!.nodeId !== '')
        .map((l) => ({ nodeId: String(l!.nodeId), latencyMs: Number(l!.latencyMs) || 0 }))
    : []
  const assigned = recordVisit(auth.userId, latencies)
  return { assigned }
})

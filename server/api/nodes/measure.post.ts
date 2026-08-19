/**
 * Record the browser's latency snapshot for this visit and auto-assign a node
 * on the user's FIRST visit (latency-first, quota-aware — see
 * services/node-assignment.ts). Any logged-in user; body:
 *   { latencies: [{ nodeId, latencyMs }] }
 * Returns the (possibly newly assigned) nodeId.
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

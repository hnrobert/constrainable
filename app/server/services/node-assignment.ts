/**
 * User → media-node assignment. Automatic selection happens EXACTLY ONCE per
 * user — at registration (server/api/auth/register.post.ts), where the
 * allocator picks the most suitable node by current load:
 *
 * - candidates = currently REGISTERED nodes (an offline node can't serve)
 * - prefer nodes under quota (node_settings.maxUsers), least load first
 * - every node at capacity → the one with the LOWEST assigned/maxUsers ratio
 *   (the cap is a soft allocation guide, never a user-facing failure)
 *
 * After that the assignment is stable forever: nothing reassigns
 * automatically (a node going offline does NOT move its users — they see it
 * offline on /nodes and can switch manually). Users self-serve via
 * POST /api/nodes/select; admins via PATCH /api/users/:id { nodeId }.
 *
 * recordVisit keeps a ONE-TIME backfill for users with NO node yet: accounts
 * created before this model existed, or registered while zero nodes were
 * online. Their first latency report assigns them once (browser-measured RTT
 * beats the registration-time load order), and never again after that.
 */
import { listNodes, getNode, rtmpAuthority } from './media-node-registry'
import { NodeSettingsRepository } from '../repositories/node-settings.repository'
import { NodeLatenciesRepository } from '../repositories/node-latencies.repository'
import { UsersRepository } from '../repositories/users.repository'

export interface AssignmentView {
  assigned: string | null
  /** the assigned node's OBS ingest authority, host[:port] ("" = via app host) */
  assignedRtmpAuthority: string
  /** the assigned node's public reachability, handed through to browsers */
  assignedPublic: {
    origin: string
    rtmpPort: number
    probeUdpPort: number
    srsUdpPort: number
  }
}

/** What the client needs on load: its assignment + the probe list. */
export function assignmentView(userId: number): AssignmentView {
  const user = UsersRepository.findById(userId)
  const assigned = user?.nodeId ?? null
  const node = assigned ? getNode(assigned) : undefined
  return {
    assigned,
    assignedRtmpAuthority: node ? rtmpAuthority(node) : '',
    assignedPublic: {
      origin: node?.publicOrigin ?? '',
      rtmpPort: node?.publicRtmpPort ?? 1935,
      probeUdpPort: node?.publicProbeUdpPort ?? 0,
      srsUdpPort: node?.publicSrsUdpPort ?? 0,
    },
  }
}

/**
 * Record a visit's latency snapshot (feeds the admin latency matrix). If —
 * and only if — the user has no node yet, this is their one-time automatic
 * assignment. Returns the user's nodeId after the (possible) backfill.
 */
export function recordVisit(userId: number, latencies: { nodeId: string; latencyMs: number }[]): string | null {
  const known = new Set(listNodes().map((n) => n.nodeId))
  for (const l of latencies) {
    // clamp: bogus client values can't poison the table
    if (!known.has(l.nodeId)) continue
    const ms = Math.max(0, Math.min(60_000, Math.round(Number(l.latencyMs) || 0)))
    NodeLatenciesRepository.upsert(userId, l.nodeId, ms)
  }

  const user = UsersRepository.findById(userId)
  if (!user) return null

  // One-time backfill: never-assigned users get their pick here (with fresh
  // browser latencies). Everyone else keeps their node no matter what.
  if (!user.nodeId) {
    const pick = allocate(userId)
    if (pick) {
      UsersRepository.updateNode(userId, pick)
      console.log(`[assign] ${user.email}: no node yet → assigned ${pick}`)
      return pick
    }
  }
  return user.nodeId
}

/**
 * The allocator: best node for this user right now.
 *   1. candidates = currently REGISTERED nodes (an offline node can't serve)
 *   2. score = latency if measured this visit, else +∞ (registration-time
 *      assignment never has samples — load order alone decides)
 *   3. prefer nodes under quota (assigned < maxUsers), best score first
 *   4. all full → the node with the LOWEST assigned/maxUsers ratio, so the
 *      overload spreads as evenly (minimally) as possible
 */
export function allocate(userId: number): string | null {
  const nodes = listNodes()
  if (nodes.length === 0) return null

  const measured = new Map(NodeLatenciesRepository.forUser(userId).map((l) => [l.nodeId, l.latencyMs]))
  const candidates = nodes.map((n) => {
    const max = NodeSettingsRepository.getMaxUsers(n.nodeId)
    const assigned = NodeSettingsRepository.assignedCount(n.nodeId)
    return {
      nodeId: n.nodeId,
      latency: measured.get(n.nodeId) ?? Number.POSITIVE_INFINITY,
      ratio: assigned / Math.max(1, max),
      underQuota: assigned < max,
    }
  })

  // under-quota by latency (ties → lower load ratio); measured beats unmeasured
  const free = candidates.filter((c) => c.underQuota).sort((a, b) => a.latency - b.latency || a.ratio - b.ratio)
  if (free.length > 0) return free[0]!.nodeId

  // everything at capacity → least-overloaded (minimal overshoot per node)
  const overflow = candidates.sort((a, b) => a.ratio - b.ratio || a.latency - b.latency)
  return overflow[0]?.nodeId ?? null
}

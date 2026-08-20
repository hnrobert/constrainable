/** A node offline longer than this loses its users to reassignment.
 *  (NODE_REASSIGN_GRACE_MS overrides — for tests.) */
const OFFLINE_GRACE_MS = Number(process.env.NODE_REASSIGN_GRACE_MS || 5 * 60 * 1000)

/**
 * User → media-node assignment. Two paths:
 *
 * - AUTO (first visit): the browser probes every registered node and reports
 *   latencies; the allocator picks the best node — lowest latency among nodes
 *   still under their AUTO quota (node_settings.maxUsers). When EVERY node is
 *   at capacity it overfills the least-loaded one (assigned/maxUsers ratio),
 *   so each node exceeds its limit by as little as possible — the cap is a
 *   soft allocation guide, never a user-facing failure.
 * - MANUAL (admin): PATCH /api/users/:id { nodeId } — ignores the quota.
 *
 * Assignments are NOT permanent bindings: a node offline beyond
 * OFFLINE_GRACE_MS loses its users — they are reallocated on their next
 * visit (and admins can move anyone anytime).
 */
import { listNodes, getNode, nodeOfflineForMs, rtmpAuthority } from './media-node-registry'
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
 * Record a visit's latency snapshot and (re)assign if the user has no node.
 * Returns the (possibly new) assigned nodeId.
 */
export function recordVisit(
  userId: number,
  latencies: { nodeId: string; latencyMs: number }[],
): string | null {
  const known = new Set(listNodes().map((n) => n.nodeId))
  for (const l of latencies) {
    // clamp: bogus client values can't poison the table
    if (!known.has(l.nodeId)) continue
    const ms = Math.max(0, Math.min(60_000, Math.round(Number(l.latencyMs) || 0)))
    NodeLatenciesRepository.upsert(userId, l.nodeId, ms)
  }

  const user = UsersRepository.findById(userId)
  if (!user) return null

  // Assigned but the node has been gone too long → reassign (users are NOT
  // permanently bound; the grace period avoids churn on brief reconnects).
  if (user.nodeId) {
    const offlineFor = nodeOfflineForMs(user.nodeId)
    if (offlineFor != null && offlineFor > OFFLINE_GRACE_MS) {
      const next = allocate(userId)
      if (next && next !== user.nodeId) {
        UsersRepository.updateNode(userId, next)
        console.log(
          `[assign] ${user.email}: ${user.nodeId} offline ${Math.round(offlineFor / 1000)}s → reassigned to ${next}`,
        )
        return next
      }
    }
    return user.nodeId
  }

  const pick = allocate(userId)
  if (pick) UsersRepository.updateNode(userId, pick)
  return pick
}

/**
 * The allocator: best node for this user right now.
 *   1. candidates = currently REGISTERED nodes (an offline node can't serve)
 *   2. score = latency if measured this visit, else +∞ (single-server
 *      deployments never measure — load order alone decides)
 *   3. prefer nodes under quota (assigned < maxUsers), best score first
 *   4. all full → the node with the LOWEST assigned/maxUsers ratio, so the
 *      overload spreads as evenly (minimally) as possible
 */
export function allocate(userId: number): string | null {
  const nodes = listNodes()
  if (nodes.length === 0) return null

  const measured = new Map(
    NodeLatenciesRepository.forUser(userId).map((l) => [l.nodeId, l.latencyMs]),
  )
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
  const free = candidates
    .filter((c) => c.underQuota)
    .sort((a, b) => a.latency - b.latency || a.ratio - b.ratio)
  if (free.length > 0) return free[0]!.nodeId

  // everything at capacity → least-overloaded (minimal overshoot per node)
  const overflow = candidates.sort((a, b) => a.ratio - b.ratio || a.latency - b.latency)
  return overflow[0]?.nodeId ?? null
}

/**
 * User-facing node list for self-selection (/nodes page): each node's OBS
 * address, load (assignment quota), the CALLER's last-measured latency, and
 * which node is currently theirs. requireUser — the admin view with more
 * detail lives at /api/media-nodes.
 */
import { getAuth, requireUser } from '../../utils/auth'
import { listNodes } from '../../services/media-node-registry'
import { NodeSettingsRepository } from '../../repositories/node-settings.repository'
import { NodeLatenciesRepository } from '../../repositories/node-latencies.repository'
import { UsersRepository } from '../../repositories/users.repository'
import { obsServerUrl } from '#shared/rtmp'

export default defineEventHandler((event) => {
  const auth = requireUser(event)
  const me = UsersRepository.findById(auth.userId)
  const myLatencies = new Map(
    NodeLatenciesRepository.forUser(auth.userId).map((l) => [l.nodeId, l.latencyMs]),
  )

  return listNodes().map((n) => ({
    nodeId: n.nodeId,
    /** OBS server URL (null = single-server: push via the app's host) */
    rtmpUrl: n.publicRtmpAuthority ? obsServerUrl(n.publicRtmpAuthority) : null,
    /** node load: assigned users vs auto-assign cap */
    assigned: NodeSettingsRepository.assignedCount(n.nodeId),
    maxUsers: NodeSettingsRepository.getMaxUsers(n.nodeId),
    /** caller's last-measured latency (null = never measured) */
    latencyMs: myLatencies.get(n.nodeId) ?? null,
    isMine: me?.nodeId === n.nodeId,
    /** browser-reachable base (used by the client-side latency test) */
    publicOrigin: n.publicOrigin,
  }))
})

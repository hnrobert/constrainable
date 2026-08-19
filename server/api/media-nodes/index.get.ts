/**
 * Admin: list currently-registered media nodes (Go backends) with their
 * assignment quota state — public origins, OBS ingest URL, version, active
 * streams, connection time, auto-assign cap, and the users currently
 * assigned to each node (for per-node reassignment on the nodes page).
 */
import { listNodes } from '../../services/media-node-registry'
import { NodeSettingsRepository } from '../../repositories/node-settings.repository'
import { UsersRepository } from '../../repositories/users.repository'

function rtmpUrl(n: { publicOrigin: string; publicRtmpPort: number }): string | null {
  if (!n.publicOrigin) return null
  const host = new URL(n.publicOrigin).hostname
  return `rtmp://${host}${n.publicRtmpPort === 1935 ? '' : `:${n.publicRtmpPort}`}/live`
}

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listNodes().map((n) => ({
    nodeId: n.nodeId,
    publicOrigin: n.publicOrigin,
    rtmpUrl: rtmpUrl(n),
    version: n.version,
    activeStreams: n.activeStreams,
    connectedAt: n.connectedAt,
    maxUsers: NodeSettingsRepository.getMaxUsers(n.nodeId),
    assignedUsers: NodeSettingsRepository.assignedCount(n.nodeId),
    users: UsersRepository.findAll()
      .filter((u) => u.nodeId === n.nodeId)
      .slice(0, 200)
      .map((u) => ({ id: u.id, email: u.email })),
  }))
})

/**
 * The admin node-list snapshot: registry rows joined with quota state and
 * assigned users. Shared by GET /api/media-nodes and the `nodes:changed`
 * bus event (forwarded to admin dashboards over Socket.IO — the nodes page
 * updates in realtime instead of polling).
 */
import { listNodes, rtmpAuthority } from './media-node-registry'
import { NodeSettingsRepository } from '../repositories/node-settings.repository'
import { UsersRepository } from '../repositories/users.repository'
import { emit } from '../utils/bus'
import type { MediaNodeSnapshot } from '#shared/events'
import { obsServerUrl } from '#shared/rtmp'

export function nodesSnapshot(): MediaNodeSnapshot[] {
  return listNodes().map((n) => ({
    nodeId: n.nodeId,
    rtmpUrl: n.publicOrigin ? obsServerUrl(rtmpAuthority(n)) : null,
    publicOrigin: n.publicOrigin,
    publicRtmpPort: n.publicRtmpPort,
    publicProbeUdpPort: n.publicProbeUdpPort,
    publicSrsUdpPort: n.publicSrsUdpPort,
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
}

/** Push the fresh list to every connected admin dashboard. */
export function emitNodesChanged(): void {
  emit('nodes:changed', nodesSnapshot())
}

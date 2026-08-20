/**
 * The admin node-list snapshot: registry rows joined with quota state and
 * assigned users. Shared by GET /api/media-nodes and the `nodes:changed`
 * bus event (forwarded to admin dashboards over Socket.IO — the nodes page
 * updates in realtime instead of polling).
 */
import { listNodes } from './media-node-registry'
import { NodeSettingsRepository } from '../repositories/node-settings.repository'
import { UsersRepository } from '../repositories/users.repository'
import { emit } from '../utils/bus'
import type { MediaNodeSnapshot } from '#shared/events'
import { obsServerUrl } from '#shared/rtmp'

/** the node's OBS ingest URL from its reported authority host[:port]
 *  (a redundant :1935 is omitted — shared/rtmp.ts) */
function rtmpUrl(n: { publicRtmpAuthority: string }): string | null {
  return n.publicRtmpAuthority ? obsServerUrl(n.publicRtmpAuthority) : null
}

export function nodesSnapshot(): MediaNodeSnapshot[] {
  return listNodes().map((n) => ({
    nodeId: n.nodeId,
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
}

/** Push the fresh list to every connected admin dashboard. */
export function emitNodesChanged(): void {
  emit('nodes:changed', nodesSnapshot())
}

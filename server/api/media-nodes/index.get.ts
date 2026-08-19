/**
 * Admin: list currently-registered media nodes (Go backends) with their
 * assignment quota state — origin, hostname, version, active stream count,
 * connection time, advertised public origin, auto-assign cap and how many
 * users are pinned to the node.
 */
import { listNodes } from '../../services/media-node-registry'
import { NodeSettingsRepository } from '../../repositories/node-settings.repository'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return listNodes().map((n) => ({
    ...n,
    maxUsers: NodeSettingsRepository.getMaxUsers(n.nodeId),
    assignedUsers: NodeSettingsRepository.assignedCount(n.nodeId),
  }))
})

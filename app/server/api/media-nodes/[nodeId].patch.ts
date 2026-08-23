/**
 * Admin: set a node's AUTO-assignment quota (node_settings.max_users — the
 * cap the first-visit allocator honors; manual assignment ignores it). The
 * node need not be online: settings persist by nodeId and apply whenever it
 * registers. Body: { maxUsers: number } (1..100000).
 */
import { createError, getRouterParam } from 'h3'
import { NodeSettingsRepository } from '../../repositories/node-settings.repository'
import { emitNodesChanged } from '../../services/media-node-snapshot'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const nodeId = String(getRouterParam(event, 'nodeId') ?? '').trim()
  if (!nodeId || nodeId.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'nodeId is required' })
  }
  const body = await readBody<{ maxUsers?: number }>(event)
  const maxUsers = Number(body?.maxUsers)
  if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 100_000) {
    throw createError({ statusCode: 400, statusMessage: 'maxUsers must be an integer in 1..100000' })
  }
  const row = NodeSettingsRepository.upsert(nodeId, maxUsers)
  emitNodesChanged()
  return { ok: true, nodeId: row.nodeId, maxUsers: row.maxUsers }
})

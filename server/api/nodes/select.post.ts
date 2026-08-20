/**
 * Explicit node self-selection: pins the caller's ingest node. A selected
 * node is a LOCK — publishing via any other node is refused at publish:start
 * (see media-node-events). There is no "automatic" option: the one automatic
 * assignment happens at registration; from here on the only way a user's
 * node changes is this endpoint (or an admin's PATCH). Body: { nodeId }.
 */
import { createError } from 'h3'
import { getNode } from '../../services/media-node-registry'
import { UsersRepository } from '../../repositories/users.repository'
import { audit } from '../../services/audit'

export default defineEventHandler(async (event) => {
  const auth = requireUser(event)
  const body = await readBody<{ nodeId?: string | null }>(event)
  const nodeId = String(body?.nodeId ?? '').trim()

  if (!nodeId) {
    throw createError({ statusCode: 400, statusMessage: 'nodeId is required' })
  }
  if (!getNode(nodeId)) {
    throw createError({ statusCode: 400, statusMessage: 'node is not currently online' })
  }

  const user = UsersRepository.findById(auth.userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  UsersRepository.updateNode(auth.userId, nodeId)
  audit('info', 'publish', `self-selected node for ${user.email}: ${nodeId}`, {
    actor: user.email,
    streamName: user.email,
    detail: { userId: auth.userId, nodeId, self: true },
  })
  return { ok: true, nodeId }
})

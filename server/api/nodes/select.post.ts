/**
 * Explicit node self-selection: pins the caller's ingest node. A selected
 * node is a LOCK — publishing via any other node is refused at publish:start
 * (see media-node-events). Body: { nodeId: string } or { nodeId: null } to
 * return to automatic allocation on next visit.
 */
import { createError } from 'h3'
import { getNode } from '../../services/media-node-registry'
import { UsersRepository } from '../../repositories/users.repository'
import { audit } from '../../services/audit'

export default defineEventHandler(async (event) => {
  const auth = requireUser(event)
  const body = await readBody<{ nodeId?: string | null }>(event)
  const nodeId = body?.nodeId === null ? null : String(body?.nodeId ?? '').trim()

  if (nodeId !== null) {
    if (!getNode(nodeId)) {
      throw createError({ statusCode: 400, statusMessage: 'node is not currently online' })
    }
  }

  const user = UsersRepository.findById(auth.userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  UsersRepository.updateNode(auth.userId, nodeId)
  audit('info', 'publish', `self-selected node for ${user.email}: ${nodeId ?? '(auto)'}`, {
    actor: user.email,
    streamName: user.email,
    detail: { userId: auth.userId, nodeId, self: true },
  })
  return { ok: true, nodeId }
})

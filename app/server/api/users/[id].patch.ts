/**
 * Update a user's role, group membership and/or pinned ingest node
 * (admin-only). Body is partial:
 *   { role?: 'admin'|'user', groupIds?: number[], nodeId?: string|null }
 * `groupIds` replaces the user's membership wholesale when present. `nodeId`
 * pins the user's media node manually (bypasses the auto-assign quota);
 * null clears it so the next visit re-runs the allocator. The node must be
 * currently registered (or null).
 */
import { createError } from 'h3'
import { setUserGroups, setUserRole } from '../../services/groups'
import { getNode } from '../../services/media-node-registry'
import { UsersRepository } from '../../repositories/users.repository'
import { audit } from '../../services/audit'
import { emitNodesChanged } from '../../services/media-node-snapshot'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid user id' })
  }
  const body = await readBody(event)

  // Admin-authored announcement aimed at this user (shown on their dashboard
  // home as "Announcement for you"). string sets, null clears; 4000-char cap.
  if ('announcement' in (body ?? {})) {
    const raw = body.announcement
    if (typeof raw !== 'string' && raw !== null) {
      throw createError({ statusCode: 400, statusMessage: 'announcement must be a string or null' })
    }
    const target = UsersRepository.findById(id)
    if (!target) throw createError({ statusCode: 404, statusMessage: 'user not found' })
    const announcement = raw === null ? null : raw.slice(0, 4000)
    UsersRepository.updateAnnouncement(id, announcement)
    audit('info', 'admin', `announcement ${announcement ? 'set for' : 'cleared for'} ${target.email}`, {
      actor: event.context.auth ? (UsersRepository.findById(event.context.auth.userId)?.email ?? null) : null,
      detail: { userId: id },
    })
  }

  if (body?.role != null) {
    const role = String(body.role)
    if (role !== 'admin' && role !== 'user') {
      throw createError({ statusCode: 400, statusMessage: 'role must be admin or user' })
    }
    setUserRole(id, role)
  }
  if (Array.isArray(body?.groupIds)) {
    const groupIds = body.groupIds.map((g: unknown) => Number(g)).filter((g: number) => Number.isInteger(g) && g > 0)
    setUserGroups(id, groupIds)
  }
  if ('nodeId' in (body ?? {})) {
    const nodeId = body.nodeId === null ? null : String(body.nodeId)
    if (nodeId !== null && !getNode(nodeId)) {
      throw createError({ statusCode: 400, statusMessage: 'node is not currently registered' })
    }
    const user = UsersRepository.findById(id)
    if (!user) throw createError({ statusCode: 404, statusMessage: 'user not found' })
    UsersRepository.updateNode(id, nodeId)
    audit('info', 'admin', `node assignment for ${user.email}: ${nodeId ?? '(cleared)'}`, {
      detail: { userId: id, nodeId },
    })
    emitNodesChanged()
  }
  return { ok: true }
})

/**
 * Hard-delete a user account (admin-only, from the Users panel). Guards:
 *   - you cannot delete YOURSELF (a mistyped self-delete would end the
 *     session's own admin access mid-flight)
 *   - you cannot delete the LAST remaining admin (lockout)
 * Node latencies and group memberships cascade with the row; historical
 * publish sessions / recordings / audit entries stay (they key on the email
 * string, on purpose — the audit trail must survive its actor).
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'
import { audit } from '../../services/audit'
import { emitNodesChanged } from '../../services/media-node-snapshot'

export default defineEventHandler((event) => {
  const auth = requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid user id' })
  }
  if (auth.userId === id) {
    throw createError({ statusCode: 400, statusMessage: 'you cannot delete your own account' })
  }
  const target = UsersRepository.findById(id)
  if (!target) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  if (target.role === 'admin' && UsersRepository.countByRole('admin') <= 1) {
    throw createError({ statusCode: 400, statusMessage: 'cannot delete the last admin' })
  }

  UsersRepository.remove(id)
  audit('warn', 'admin', `user deleted: ${target.email}`, {
    actor: UsersRepository.findById(auth.userId)?.email ?? null,
    detail: { userId: id, role: target.role },
  })
  // node occupancy changed if the user was pinned/assigned
  emitNodesChanged()
  return { ok: true }
})

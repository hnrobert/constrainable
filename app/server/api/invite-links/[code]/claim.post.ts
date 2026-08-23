/**
 * An existing (logged-in) user claims an invite to join its group. Any authed
 * user may call this — not admin-only. The claim is idempotent (re-claiming a
 * group you're already in is a no-op success). Returns the joined group name,
 * or 404 if the code is unknown/invalid/expired/exhausted.
 */
import { createError } from 'h3'
import { consumeInvite } from '../../../services/invites'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  const code = String(getRouterParam(event, 'code') ?? '')
  const group = consumeInvite(code, auth.userId)
  if (!group) throw createError({ statusCode: 404, statusMessage: 'invite is invalid or expired' })
  return { ok: true, groupId: group.id, groupName: group.name }
})

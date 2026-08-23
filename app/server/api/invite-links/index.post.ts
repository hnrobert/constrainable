/**
 * Create an invite link (admin-only). Body: { groupId, maxUses?, ttlHours?,
 * note? }. Returns the new link with its plaintext code (shown once in the UI).
 */
import { createError } from 'h3'
import { createInvite } from '../../services/invites'
import type { InviteLinkInput } from '#shared/groups'

export default defineEventHandler(async (event) => {
  const auth = requireAdmin(event)
  const body = await readBody(event)
  const groupId = Number(body?.groupId)
  if (!Number.isInteger(groupId) || groupId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'groupId is required' })
  }
  const input: InviteLinkInput = {
    groupId,
    maxUses: body?.maxUses != null ? Number(body.maxUses) : null,
    ttlHours: body?.ttlHours != null ? Number(body.ttlHours) : null,
    note: body?.note != null ? String(body.note) : null,
  }
  return createInvite(input, auth.userId)
})

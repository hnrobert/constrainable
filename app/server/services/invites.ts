/**
 * Invite-link business logic: creation, listing, deactivation, and the
 * consume/claim flow used by registration (`consumeInvite`) and the existing-
 * user join endpoint. Codes are 24-char hex, opaque and unguessable (per the
 * unnc-freshmen-verifier-gateway convention).
 */
import { randomBytes } from 'node:crypto'
import { createError } from 'h3'
import { GroupsRepository } from '../repositories/groups.repository'
import { InviteLinksRepository } from '../repositories/invite-links.repository'
import { audit } from './audit'
import type { Group } from '../database/schema'
import type { InviteLinkInput, InviteLinkView } from '#shared/groups'

const CODE_BYTES = 12 // → 24 hex chars
const CODE_HEX_LEN = CODE_BYTES * 2

/** Generate a unique 24-hex invite code (retries on the vanishingly rare collision). */
function generateUniqueCode(): string {
  for (let i = 0; i < 8; i++) {
    const code = randomBytes(CODE_BYTES).toString('hex')
    if (code.length === CODE_HEX_LEN && !InviteLinksRepository.findByCode(code)) return code
  }
  throw createError({ statusCode: 500, statusMessage: 'could not generate a unique invite code' })
}

function ttlToExpiresAt(ttlHours?: number | null): Date | null {
  if (ttlHours == null) return null
  const expires = new Date(Date.now() + Math.round(ttlHours * 3600_000))
  return Number.isNaN(expires.getTime()) ? null : expires
}

function rowToView(row: ReturnType<typeof InviteLinksRepository.findAll>[number]): InviteLinkView {
  const group = GroupsRepository.findById(row.groupId)
  return {
    id: row.id,
    code: row.code,
    groupId: row.groupId,
    groupName: group?.name ?? '(deleted)',
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
    active: row.active,
    note: row.note,
    createdAt: row.createdAt.getTime(),
  }
}

export function listInvites(): InviteLinkView[] {
  return InviteLinksRepository.findAll().map(rowToView)
}

export function createInvite(input: InviteLinkInput, createdBy: number): InviteLinkView {
  if (!GroupsRepository.findById(input.groupId)) {
    throw createError({ statusCode: 404, statusMessage: 'group not found' })
  }
  if (input.maxUses != null && input.maxUses < 1) {
    throw createError({ statusCode: 400, statusMessage: 'maxUses must be at least 1' })
  }
  const code = generateUniqueCode()
  const row = InviteLinksRepository.insert({
    code,
    groupId: input.groupId,
    createdBy,
    maxUses: input.maxUses ?? null,
    expiresAt: ttlToExpiresAt(input.ttlHours),
    active: true,
    note: input.note ?? null,
  })
  audit('info', 'admin', `invite created for group #${input.groupId}`, {
    detail: { inviteId: row.id, groupId: input.groupId, maxUses: input.maxUses ?? null },
  })
  return rowToView(row)
}

export function deactivateInvite(id: number): void {
  const existing = InviteLinksRepository.findAll().find((r) => r.id === id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'invite not found' })
  InviteLinksRepository.update(id, { active: false })
  audit('warn', 'admin', `invite deactivated: ${existing.code}`, { detail: { inviteId: id } })
}

export function removeInvite(id: number): void {
  const existing = InviteLinksRepository.findAll().find((r) => r.id === id)
  if (!existing) throw createError({ statusCode: 404, statusMessage: 'invite not found' })
  InviteLinksRepository.remove(id)
  audit('warn', 'admin', `invite deleted: ${existing.code}`, { detail: { inviteId: id } })
}

/**
 * Consume an invite for a user: validate active + not-expired + under-maxUses,
 * then join the user to the group and increment the counter.
 *
 * Idempotent: if the user is already a member, the group is returned without
 * touching the counter (so re-using a link, or using a now-depleted one by an
 * existing member, is a no-op success). Returns the joined group, or null when
 * the code is unknown/invalid and the user is not already a member.
 *
 * Never throws on invalid input — registration treats an unusable invite as a
 * soft skip, so we signal failure via null.
 */
export function consumeInvite(code: string, userId: number): Group | null {
  const invite = InviteLinksRepository.findByCode(code.trim())
  if (!invite) return null
  const group = GroupsRepository.findById(invite.groupId)
  if (!group) return null

  // Already a member → idempotent no-op (no counter bump).
  if (GroupsRepository.findUserGroupIds(userId).includes(invite.groupId)) return group

  const expired = invite.expiresAt ? invite.expiresAt.getTime() < Date.now() : false
  const exhausted = invite.maxUses != null && invite.usedCount >= invite.maxUses
  if (!invite.active || expired || exhausted) return null

  GroupsRepository.addUserToGroup(userId, invite.groupId)
  InviteLinksRepository.incrementUsed(invite.id)
  audit('info', 'admin', `invite consumed → group "${group.name}"`, {
    detail: { inviteId: invite.id, groupId: group.id, userId },
  })
  return group
}

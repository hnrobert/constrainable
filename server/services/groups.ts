/**
 * Groups + membership business logic. Owns group CRUD DTO mapping, user↔group
 * assignment, role changes, and the authorization predicate `canViewEvent`
 * (consumed by the events catalog endpoints).
 */
import { createError } from 'h3'
import { GroupsRepository } from '../repositories/groups.repository'
import { UsersRepository } from '../repositories/users.repository'
import { audit } from './audit'
import type { EventVisibility } from '#shared/event-view'
import type { GroupView, UserWithGroupsView } from '#shared/groups'
import type { User } from '../database/schema'
import { NodeLatenciesRepository } from '../repositories/node-latencies.repository'

function toGroupView(id: number): GroupView {
  const g = GroupsRepository.findById(id)
  if (!g) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    memberCount: GroupsRepository.countMembers(g.id),
    createdAt: g.createdAt.getTime(),
  }
}

function getRow(id: number) {
  const g = GroupsRepository.findById(id)
  if (!g) throw createError({ statusCode: 404, statusMessage: 'group not found' })
  return g
}

export function listGroups(): GroupView[] {
  return GroupsRepository.findAll().map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    memberCount: GroupsRepository.countMembers(g.id),
    createdAt: g.createdAt.getTime(),
  }))
}

export function getGroup(id: number): GroupView {
  return toGroupView(id)
}

export function createGroup(input: { name: string; description?: string | null }): GroupView {
  const name = input.name.trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'group name is required' })
  if (GroupsRepository.findByName(name)) {
    throw createError({ statusCode: 409, statusMessage: 'group name already used' })
  }
  const row = GroupsRepository.insert({ name, description: input.description ?? null })
  audit('info', 'admin', `group created: ${name}`, { detail: { groupId: row.id } })
  return toGroupView(row.id)
}

export function updateGroup(id: number, patch: { name?: string; description?: string | null }): GroupView {
  const existing = getRow(id)
  const set: Record<string, unknown> = {}
  if (patch.name != null) {
    const name = patch.name.trim()
    if (!name) throw createError({ statusCode: 400, statusMessage: 'group name cannot be empty' })
    if (name !== existing.name && GroupsRepository.findByName(name)) {
      throw createError({ statusCode: 409, statusMessage: 'group name already used' })
    }
    set.name = name
  }
  if (patch.description !== undefined) set.description = patch.description
  if (Object.keys(set).length) GroupsRepository.update(id, set)
  audit('info', 'admin', `group updated: ${existing.name}`, { detail: { groupId: id, fields: Object.keys(set) } })
  return toGroupView(id)
}

export function deleteGroup(id: number): void {
  const existing = getRow(id)
  GroupsRepository.remove(id)
  audit('warn', 'admin', `group deleted: ${existing.name}`, { detail: { groupId: id } })
}

/** Every user with their group memberships (admin user-management page). */
export function listUsersWithGroups(): UserWithGroupsView[] {
  const latencies = NodeLatenciesRepository.matrix()
  return UsersRepository.findAll().map((u: User) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    groups: GroupsRepository.findGroupsForUser(u.id).map((g) => ({ id: g.id, name: g.name })),
    nodeId: u.nodeId ?? null,
    latencies: Object.fromEntries(latencies.get(u.id) ?? []),
    createdAt: u.createdAt.getTime(),
  }))
}

/** Replace a user's group membership wholesale. */
export function setUserGroups(userId: number, groupIds: number[]): void {
  const user = UsersRepository.findById(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  GroupsRepository.setUserGroups(userId, groupIds)
  audit('info', 'admin', `groups set for ${user.email}`, {
    detail: { userId, groupIds },
  })
}

/** Promote/demote a user (admin ⇄ user). */
export function setUserRole(userId: number, role: 'admin' | 'user'): void {
  const user = UsersRepository.findById(userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'user not found' })
  if (user.role === role) return
  UsersRepository.updateRole(userId, role)
  audit('warn', 'admin', `role changed: ${user.email} → ${role}`, { detail: { userId, role } })
}

/**
 * Authorization predicate for event visibility.
 *   admin                → always true
 *   visibility 'public'  → anyone (incl. logged-out)
 *   logged-out           → false (registered/groups both require a session)
 *   visibility 'registered' → any logged-in user
 *   visibility 'groups'  → member of at least one of the event's groups
 */
export function canViewEvent(
  auth: { userId: number; role: 'admin' | 'user' } | null | undefined,
  event: { visibility: EventVisibility; groupIds: number[] },
): boolean {
  if (auth?.role === 'admin') return true
  if (event.visibility === 'public') return true
  if (!auth) return false
  if (event.visibility === 'registered') return true
  return GroupsRepository.userInAnyGroup(auth.userId, event.groupIds)
}

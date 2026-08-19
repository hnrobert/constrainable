/**
 * Group + invite-link view models (mirrors server services/groups.ts +
 * invites.ts) and the event-visibility enum set, shared by endpoints and pages.
 */
import type { EventVisibility } from './event-view'

export const EVENT_VISIBILITIES: readonly EventVisibility[] = ['public', 'registered', 'groups']

export interface GroupView {
  id: number
  name: string
  description: string | null
  memberCount: number
  createdAt: number
}

export interface UserWithGroupsView {
  id: number
  email: string
  role: 'admin' | 'user'
  groups: { id: number; name: string }[]
  /** pinned ingest node (null = not yet auto-assigned) */
  nodeId: string | null
  /** last-visit latency snapshot: nodeId → ms (drives the admin matrix) */
  latencies: Record<string, number>
  createdAt: number
}

export interface InviteLinkView {
  id: number
  code: string
  groupId: number
  groupName: string
  maxUses: number | null
  usedCount: number
  expiresAt: number | null
  active: boolean
  note: string | null
  createdAt: number
}

/** Invite creation input from the admin UI. */
export interface InviteLinkInput {
  groupId: number
  maxUses?: number | null
  /** hours from now until expiry; null/undefined = no expiry */
  ttlHours?: number | null
  note?: string | null
}

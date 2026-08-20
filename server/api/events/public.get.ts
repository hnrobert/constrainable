/**
 * Public events for the homepage (allowlisted — no auth). Returns only events
 * with visibility 'public'. Used by the landing page for logged-out visitors.
 * Other visibility tiers ('registered', 'groups') never appear here.
 */
import { EventsRepository } from '../../repositories/events.repository'
import { GroupsRepository } from '../../repositories/groups.repository'
import type { EventGroupRef, EventView, EventVisibility } from '#shared/event-view'
import type { LimitsOverride } from '#shared/config'

export default defineEventHandler((): EventView[] => {
  return EventsRepository.findAll()
    .filter((e) => e.visibility === ('public' as EventVisibility))
    .map((e) => {
      const groupRows: EventGroupRef[] = GroupsRepository.findGroupsForEvent(e.id).map((g) => ({
        id: g.id,
        name: g.name,
      }))
      return {
        id: e.id,
        name: e.name,
        slug: e.slug,
        description: e.description,
        startsAt: e.startsAt ? e.startsAt.getTime() : null,
        endsAt: e.endsAt ? e.endsAt.getTime() : null,
        status: e.status,
        limitsOverride: e.limitsOverride ? (JSON.parse(e.limitsOverride) as LimitsOverride) : null,
        recordEnabled: e.recordEnabled,
        strictLimits: e.strictLimits,
        requireAccountAuth: e.requireAccountAuth,
        visibility: e.visibility,
        groups: groupRows,
        publishTokenPreview: e.publishTokenPrefix ?? null,
        publishKeyPreview: e.publishKey ? `${e.publishKey.slice(0, 4)}…` : null,
        streamGuide: e.streamGuide ?? null,
        createdAt: e.createdAt.getTime(),
        updatedAt: e.updatedAt.getTime(),
      }
    })
})

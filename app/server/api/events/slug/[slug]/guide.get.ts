/**
 * Participant push-streaming guide for one event, keyed by slug. Retired keys
 * (the event was renamed) redirect: the response carries `redirectTo` so the
 * page swaps to the new key's URL. A retired key stops redirecting the moment
 * a new event claims it. Public surface
 * (allowlisted) but visibility-gated: public events need no session; registered
 * needs any login; groups needs membership. Draft/archived events 404 (no
 * existence leak). The payload is identical for every viewer of the same event:
 * it carries the shared publish key plus a hint to use each contestant's own
 * account email as the stream name.
 */
import { createError } from 'h3'
import { EventsRepository } from '../../../../repositories/events.repository'
import { EventSlugAliasesRepository } from '../../../../repositories/event-slug-aliases.repository'
import { GroupsRepository } from '../../../../repositories/groups.repository'
import { canViewEvent } from '../../../../services/groups'
import { getLimitsFor } from '../../../../utils/config-store'
import { guideRtmpServer } from '../../../../utils/rtmp-server'
import type { EventGuide } from '#shared/event-view'

export default defineEventHandler((event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'missing slug' })

  let row = EventsRepository.findBySlug(slug)
  let redirectTo: string | null = null
  if (!row) {
    // Retired key? Serve the renamed event's guide with a redirect marker.
    const alias = EventSlugAliasesRepository.findByOldSlug(slug)
    if (alias) {
      const target = EventsRepository.findById(alias.eventId)
      if (target && target.slug !== slug) {
        row = target
        redirectTo = target.slug
      }
    }
  }
  // Still missing / draft / archived → 404 (don't leak that the event exists).
  if (!row || row.status === 'draft' || row.status === 'archived') {
    throw createError({ statusCode: 404, statusMessage: 'event not found' })
  }

  const groupIds = GroupsRepository.findGroupsForEvent(row.id).map((g) => g.id)
  if (!canViewEvent(event.context.auth, { visibility: row.visibility, groupIds })) {
    throw createError({ statusCode: 403, statusMessage: 'not authorized for this event' })
  }

  // RTMP's default port is 1935, so when the ingest front-door (the RTMP gateway)
  // owns 1935 we omit it — contestants paste a clean `rtmp://host/live` with no
  // port. One URL for ALL events: the gateway challenges every publisher, and
  // clients without credentials (requireAccountAuth off) pass through openly —
  // auth-required events are enforced at publish via the per-event policy.
  // Host/port derivation lives in utils/rtmp-server.ts (shared with the
  // id-keyed variant of this endpoint).
  const server = guideRtmpServer(event)

  return {
    redirectTo,
    name: row.name,
    slug: row.slug,
    server,
    publishKey: row.publishKey ?? null,
    limits: getLimitsFor(row),
    startsAt: row.startsAt ? row.startsAt.getTime() : null,
    endsAt: row.endsAt ? row.endsAt.getTime() : null,
    requireAccountAuth: row.requireAccountAuth,
    streamGuide: row.streamGuide ?? null,
  } satisfies EventGuide & { redirectTo: string | null }
})

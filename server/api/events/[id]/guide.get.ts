/**
 * Id-keyed variant of the participant guide (see …/slug/[slug]/guide.get.ts)
 * for the dashboard's event pages (Overview / Manual tabs): identical payload
 * — shared publish key, merged output limits, streaming window, RTMP server —
 * but addressed by numeric event id. That keeps the client fetch URL STABLE
 * (the slug is only known after the event loads, so a slug-keyed fetch fires
 * once with an empty slug during SSR and only recovers after hydration; with
 * this endpoint the SSR HTML already carries the real per-event limits).
 * Requires a session (server middleware); visibility-gated like the slug
 * endpoint. Draft/archived events 404 — callers degrade gracefully.
 */
import { createError } from 'h3'
import { EventsRepository } from '../../../repositories/events.repository'
import { GroupsRepository } from '../../../repositories/groups.repository'
import { canViewEvent } from '../../../services/groups'
import { getLimitsFor } from '../../../utils/config-store'
import { guideRtmpServer } from '../../../utils/rtmp-server'
import type { EventGuide } from '#shared/event-view'

export default defineEventHandler((event): EventGuide => {
  const id = Number(getRouterParam(event, 'id'))
  const row = EventsRepository.findById(Number.isInteger(id) ? id : 0)
  // Missing / draft / archived → 404 (don't leak that the event exists).
  if (!row || row.status === 'draft' || row.status === 'archived') {
    throw createError({ statusCode: 404, statusMessage: 'event not found' })
  }

  const groupIds = GroupsRepository.findGroupsForEvent(row.id).map((g) => g.id)
  if (!canViewEvent(event.context.auth, { visibility: row.visibility, groupIds })) {
    throw createError({ statusCode: 403, statusMessage: 'not authorized for this event' })
  }

  return {
    name: row.name,
    slug: row.slug,
    server: guideRtmpServer(event),
    publishKey: row.publishKey ?? null,
    limits: getLimitsFor(row),
    startsAt: row.startsAt ? row.startsAt.getTime() : null,
    endsAt: row.endsAt ? row.endsAt.getTime() : null,
    requireAccountAuth: row.requireAccountAuth,
    streamGuide: row.streamGuide ?? null,
  }
})

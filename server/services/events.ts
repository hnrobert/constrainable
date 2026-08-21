/**
 * Event CRUD (business logic). An event scopes a set of students/keys/sessions/
 * recordings. DB access goes through EventsRepository + GroupsRepository; this
 * layer owns slug derivation, validation, visibility/group scoping, DTO mapping,
 * and audit.
 */
import { createError } from 'h3'
import { EventsRepository } from '../repositories/events.repository'
import { EventSlugAliasesRepository } from '../repositories/event-slug-aliases.repository'
import { GroupsRepository } from '../repositories/groups.repository'
import type { Event } from '../database/schema'
import type { EventStatus } from '#shared/event-view'
import { limitsOverrideSchema, type LimitsOverride } from '#shared/config'
import type { EventGroupRef, EventVisibility } from '#shared/event-view'
import { generateToken, hashToken } from '../utils/token'
import { audit } from './audit'

export interface EventView {
  id: number
  name: string
  slug: string
  description: string | null
  startsAt: number | null
  endsAt: number | null
  status: Event['status']
  limitsOverride: LimitsOverride | null
  recordEnabled: boolean
  /** strict limits: violations stop the stream and ban the publisher from the event */
  strictLimits: boolean
  /** also enforce limits on MEASURED data (5s deltas); default off */
  enforceMeasuredLimits: boolean
  /**
   * When true, OBS publishers must authenticate with their website account via
   * the Go RTMP gateway (authmod challenge-response); SRS event auth unchanged.
   */
  requireAccountAuth: boolean
  visibility: EventVisibility
  /** groups linked to this event (meaningful when visibility === 'groups'). */
  groups: EventGroupRef[]
  /** fingerprint (prefix) of the per-event publish token, or null if none set. */
  publishTokenPreview: string | null
  /** fingerprint (prefix) of the shared publish key, or null if none set. */
  publishKeyPreview: string | null
  /** admin-authored custom instructions shown on the participant guide. */
  streamGuide: string | null
  createdAt: number
  updatedAt: number
}

export interface EventInput {
  name?: string
  slug?: string
  description?: string | null
  startsAt?: number | null
  endsAt?: number | null
  status?: Event['status']
  limitsOverride?: LimitsOverride | null
  recordEnabled?: boolean
  strictLimits?: boolean
  enforceMeasuredLimits?: boolean
  /** toggles OBS "Use authentication" enforcement (account auth via the gateway). */
  requireAccountAuth?: boolean
  visibility?: EventVisibility
  /** admin-authored custom instructions shown on the participant guide. */
  streamGuide?: string | null
  /** group ids to scope the event to (applied when visibility === 'groups'). */
  groupIds?: number[]
}

function toView(e: Event): EventView {
  const groupRows = GroupsRepository.findGroupsForEvent(e.id)
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
    enforceMeasuredLimits: e.enforceMeasuredLimits,
    requireAccountAuth: e.requireAccountAuth,
    visibility: e.visibility,
    groups: groupRows.map((g) => ({ id: g.id, name: g.name })),
    publishTokenPreview: e.publishTokenPrefix ?? null,
    publishKeyPreview: e.publishKey ? `${e.publishKey.slice(0, 4)}…` : null,
    streamGuide: e.streamGuide ?? null,
    createdAt: e.createdAt.getTime(),
    updatedAt: e.updatedAt.getTime(),
  }
}

function getRow(id: number): Event {
  const row = EventsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'event not found' })
  return row
}

function toTs(ms: number | null | undefined): Date | null {
  if (ms == null) return null
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d
}

function ensureSlugUnique(slug: string, exceptId?: number): void {
  if (EventsRepository.findBySlugExcept(slug, exceptId)) {
    throw createError({ statusCode: 409, statusMessage: 'slug already used' })
  }
}

export function listEvents(): EventView[] {
  return EventsRepository.findAll().map(toView)
}

/** Catalog visible to NON-admins: draft/scheduled are admin-only until live. */
export function listEventsForUser(): EventView[] {
  return EventsRepository.findAll()
    .filter((e) => e.status !== 'draft' && e.status !== 'scheduled')
    .map(toView)
}

export function getEvent(id: number): EventView {
  return toView(getRow(id))
}

/**
 * The event key (stored as `slug`): unique, lowercased `[a-z0-9_-]+`. It is the
 * guide URL path AND the OBS stream key — the strict charset makes it
 * URL-safe and OBS→gateway→SRS round-trip-safe with no further validation.
 */
const EVENT_KEY_RE = /^[a-z0-9_-]+$/

function validEventKey(slug: string): string {
  if (!EVENT_KEY_RE.test(slug)) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Event key may only contain lowercase letters, digits, _ and -',
    })
  }
  return slug
}


/** Scheduled events must carry a full window; end must follow start. */
function assertWindow(
  status: EventStatus | undefined,
  startsAt: Date | number | null,
  endsAt: Date | number | null,
): void {
  const s = startsAt ? new Date(startsAt).getTime() : null
  const e = endsAt ? new Date(endsAt).getTime() : null
  if (status === 'scheduled' && (!s || !e)) {
    throw createError({ statusCode: 400, statusMessage: 'scheduled events need both a start and an end time' })
  }
  if (s && e && e <= s) {
    throw createError({ statusCode: 400, statusMessage: 'end time must be after the start time' })
  }
}

export function createEvent(input: EventInput): EventView {
  const name = (input.name ?? '').trim()
  if (!name) throw createError({ statusCode: 400, statusMessage: 'name is required' })
  const slug = validEventKey((input.slug ?? '').trim())
  ensureSlugUnique(slug)

  const limitsOverride =
    input.limitsOverride != null ? JSON.stringify(limitsOverrideSchema.parse(input.limitsOverride)) : null

  assertWindow(input.status, input.startsAt ?? null, input.endsAt ?? null)

  const row = EventsRepository.insert({
    name,
    slug,
    // the event key IS the stream key (retrievable by design — shown on the guide)
    publishKey: slug,
    description: input.description ?? null,
    startsAt: toTs(input.startsAt),
    endsAt: toTs(input.endsAt),
    status: input.status ?? 'draft',
    limitsOverride,
    recordEnabled: input.recordEnabled ?? true,
    strictLimits: input.strictLimits ?? false,
    enforceMeasuredLimits: input.enforceMeasuredLimits ?? false,
    // account auth is mandatory for every event (single-URL gateway design)
    requireAccountAuth: true,
    visibility: input.visibility ?? 'registered',
  })

  if (input.groupIds) GroupsRepository.setEventGroups(row.id, input.groupIds)
  // the new event now owns this key outright — retire any alias to it
  EventSlugAliasesRepository.remove(slug)

  audit('info', 'admin', `event created: ${name}`, {
    eventId: row.id,
    detail: { slug, visibility: row.visibility },
  })
  return toView(row)
}

export function updateEvent(id: number, patch: EventInput): EventView {
  const existing = getRow(id)
  const set: Record<string, unknown> = { updatedAt: new Date() }

  if (patch.name != null) {
    const name = patch.name.trim()
    if (!name) throw createError({ statusCode: 400, statusMessage: 'name cannot be empty' })
    set.name = name
  }
  if (patch.slug != null) {
    const slug = validEventKey(patch.slug.trim())
    if (slug !== existing.slug) {
      ensureSlugUnique(slug, id)
      set.slug = slug
      // the event key IS the stream key — keep the publish key in lockstep
      set.publishKey = slug
      // the retired key keeps working: redirect old → new until someone else
      // claims the old key with a new event
      EventSlugAliasesRepository.set(existing.slug, id)
      EventSlugAliasesRepository.remove(slug)
    }
  }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.startsAt !== undefined) set.startsAt = toTs(patch.startsAt)
  if (patch.endsAt !== undefined) set.endsAt = toTs(patch.endsAt)
  if (patch.status != null) set.status = patch.status
  assertWindow(
    (set.status as EventStatus | undefined) ?? existing.status,
    ((set.startsAt as Date | undefined) ?? existing.startsAt ?? null) as Date | null,
    ((set.endsAt as Date | undefined) ?? existing.endsAt ?? null) as Date | null,
  )
  if (patch.recordEnabled != null) set.recordEnabled = patch.recordEnabled
  if (patch.strictLimits != null) set.strictLimits = patch.strictLimits
  if (patch.enforceMeasuredLimits != null) set.enforceMeasuredLimits = patch.enforceMeasuredLimits
  if (patch.visibility != null) set.visibility = patch.visibility
  if (patch.limitsOverride !== undefined) {
    set.limitsOverride =
      patch.limitsOverride == null ? null : JSON.stringify(limitsOverrideSchema.parse(patch.limitsOverride))
  }
  if (patch.streamGuide !== undefined) set.streamGuide = patch.streamGuide

  EventsRepository.update(id, set)
  if (patch.groupIds !== undefined) GroupsRepository.setEventGroups(id, patch.groupIds)
  audit('info', 'admin', `event updated: ${existing.name}`, {
    eventId: id,
    detail: { fields: Object.keys(set), groupScope: patch.groupIds !== undefined },
  })
  return toView(getRow(id))
}

export function deleteEvent(id: number): void {
  const existing = getRow(id)
  EventSlugAliasesRepository.removeByEvent(id)
  EventsRepository.remove(id)
  audit('warn', 'admin', `event deleted: ${existing.name}`, { eventId: id })
}

/**
 * Allowed publish-token charset: URL-unreserved characters that pass through
 * URLSearchParams parsing unchanged (covers base64url A-Za-z0-9_- plus . and ~).
 * Anything else (spaces, &, =, +, #, …) would corrupt `?token=` round-tripping
 * through OBS → SRS → parseToken.
 */
const PUBLISH_TOKEN_RE = /^[A-Za-z0-9._~-]+$/
/** min length == the prefix-index width, so on_publish lookup always works */
const PUBLISH_TOKEN_MIN = 8
const PUBLISH_TOKEN_MAX = 128

/**
 * Set the per-event publish token. With `custom`, the caller-chosen string is
 * validated and stored verbatim; without it a random one is generated. The
 * plaintext is returned once; only its argon2id hash + 8-char prefix (for
 * on_publish lookup and display) are stored. A publisher may then push
 * `${streamName}?token=${publishToken}` inside the event's time window.
 */
export async function rotatePublishToken(
  id: number,
  custom?: string,
): Promise<{ token: string; preview: string; isCustom: boolean }> {
  const existing = getRow(id)
  let token: string
  let isCustom = false
  if (custom != null && custom.trim() !== '') {
    const c = custom.trim()
    if (c.length < PUBLISH_TOKEN_MIN || c.length > PUBLISH_TOKEN_MAX) {
      throw createError({
        statusCode: 400,
        statusMessage: `Token length must be ${PUBLISH_TOKEN_MIN}–${PUBLISH_TOKEN_MAX} characters`,
      })
    }
    if (!PUBLISH_TOKEN_RE.test(c)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Token may only contain letters, digits, and . _ - ~',
      })
    }
    token = c
    isCustom = true
  } else {
    token = generateToken()
  }
  const hash = await hashToken(token)
  const prefix = token.slice(0, 8)
  EventsRepository.update(id, {
    publishTokenHash: hash,
    publishTokenPrefix: prefix,
    updatedAt: new Date(),
  })
  audit('info', 'admin', `publish token ${isCustom ? 'set (custom)' : 'rotated'}: ${existing.name}`, {
    eventId: id,
  })
  return { token, preview: prefix, isCustom }
}

/** Clear (revoke) the per-event publish token. */
export function clearPublishToken(id: number): void {
  const existing = getRow(id)
  EventsRepository.update(id, {
    publishTokenHash: null,
    publishTokenPrefix: null,
    updatedAt: new Date(),
  })
  audit('warn', 'admin', `publish token cleared: ${existing.name}`, { eventId: id })
}

/**
 * Set the shared per-event publish key. With `custom`, the caller-chosen string
 * is validated and stored verbatim; without it a random one is generated. Unlike
 * the publish token, this key is stored in plaintext so it can be redisplayed on
 * the participant guide — it is a shared credential handed to everyone allowed
 * to view the event, not a per-person secret. A publisher pastes the key as the
 * OBS stream key ALONE; the RTMP gateway derives the stream NAME per publisher
 * (authenticated account email, else connection IP) and relays
 * `<name>?token=<publishKey>` to SRS, so the whole class can stream concurrently
 * with one shared key. Reuses the publish-token charset/length rules so the key
 * round-trips cleanly through OBS → gateway → SRS → parseToken.
 */
export async function setPublishKey(
  id: number,
  custom?: string,
): Promise<{ key: string; isCustom: boolean }> {
  const existing = getRow(id)
  let key: string
  let isCustom = false
  if (custom != null && custom.trim() !== '') {
    const c = custom.trim()
    if (c.length < PUBLISH_TOKEN_MIN || c.length > PUBLISH_TOKEN_MAX) {
      throw createError({
        statusCode: 400,
        statusMessage: `Key length must be ${PUBLISH_TOKEN_MIN}–${PUBLISH_TOKEN_MAX} characters`,
      })
    }
    if (!PUBLISH_TOKEN_RE.test(c)) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Key may only contain letters, digits, and . _ - ~',
      })
    }
    key = c
    isCustom = true
  } else {
    key = generateToken()
  }
  EventsRepository.update(id, { publishKey: key, updatedAt: new Date() })
  audit('info', 'admin', `publish key ${isCustom ? 'set (custom)' : 'generated'}: ${existing.name}`, {
    eventId: id,
  })
  return { key, isCustom }
}

/** Clear (unset) the shared per-event publish key. */
export function clearPublishKey(id: number): void {
  const existing = getRow(id)
  EventsRepository.update(id, { publishKey: null, updatedAt: new Date() })
  audit('warn', 'admin', `publish key cleared: ${existing.name}`, { eventId: id })
}

/** Full publish key (retrievable by design — used by the admin reveal + guide). */
export function getPublishKey(id: number): string | null {
  return getRow(id).publishKey ?? null
}

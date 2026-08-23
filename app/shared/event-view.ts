/**
 * Event catalog item + create/update input (mirrors server services/events.ts).
 * Visibility controls who may see an event; group scoping applies when
 * visibility === 'groups' (see event_groups).
 */
import type { Limits } from './config'

export type EventStatus = 'draft' | 'scheduled' | 'live' | 'ended' | 'archived'
export type EventVisibility = 'public' | 'registered' | 'groups'

export interface EventGroupRef {
  id: number
  name: string
}

export interface EventView {
  id: number
  name: string
  slug: string
  description: string | null
  startsAt: number | null
  endsAt: number | null
  status: EventStatus
  limitsOverride: Record<string, number | null> | null
  recordEnabled: boolean
  /** strict limits: violations stop the stream and ban the publisher from the event */
  strictLimits: boolean
  /** also enforce limits on MEASURED data (5s deltas); default off — declared onMetaData is the baseline gate */
  enforceMeasuredLimits: boolean
  /**
   * When true, OBS publishers must authenticate with their website account
   * (email + login password) via OBS' "Use authentication" fields. The Go RTMP
   * gateway does the authmod challenge-response; SRS event auth is unchanged.
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
  status?: EventStatus
  limitsOverride?: Record<string, number | null> | null
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

/**
 * Participant push-streaming guide for one event. Identical for every viewer of
 * the same event. The stream key the contestant pastes into OBS is the shared
 * publish key ALONE — the RTMP gateway derives the stream name per publisher
 * (their account email when authenticated, else the connection IP), so
 * concurrent publishing works with one shared key and no per-user prefix.
 */
export interface EventGuide {
  name: string
  slug: string
  /** RTMP server URL the contestant enters in OBS (rtmp://host/live). */
  server: string
  /** shared publish key (pasted as the OBS stream key), or null if the organizer hasn't set one. */
  publishKey: string | null
  /** recommended OBS output limits (global merged with the event override). */
  limits: Limits
  startsAt: number | null
  endsAt: number | null
  /**
   * When true, the guide instructs contestants to enable OBS'
   * "Use authentication" and enter their account email + login password (the Go
   * RTMP gateway verifies them); when false, only the shared publish key is used.
   */
  requireAccountAuth: boolean
  /** admin-authored custom instructions, or null. */
  streamGuide: string | null
}

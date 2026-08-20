/**
 * Streaming-ban business logic (小黑屋). A ban permanently blocks an account
 * email from publishing — either everywhere (site-wide, eventId null) or in
 * one event. Enforcement happens in the RTMP gateway via the salt (stage 2:
 * site-wide) and policy (publish: both scopes) endpoints. There is no
 * time-based un-ban; admins lift bans explicitly from the blacklist UI.
 */
import { createError } from 'h3'
import { StreamBansRepository } from '../repositories/stream-bans.repository'
import { audit } from './audit'

export interface StreamBanView {
  id: number
  email: string
  /** null = site-wide */
  eventId: number | null
  reason: string | null
  bannedBy: string | null
  createdAt: number
}

function toView(b: {
  id: number
  email: string
  eventId: number | null
  reason: string | null
  bannedBy: string | null
  createdAt: Date
}): StreamBanView {
  return {
    id: b.id,
    email: b.email,
    eventId: b.eventId ?? null,
    reason: b.reason ?? null,
    bannedBy: b.bannedBy ?? null,
    createdAt: b.createdAt.getTime(),
  }
}

export function listBans(eventId?: number | null): StreamBanView[] {
  return (eventId != null ? StreamBansRepository.listByEvent(eventId) : StreamBansRepository.listAll()).map(
    toView,
  )
}

export function isSiteWideBanned(email: string): boolean {
  return !!StreamBansRepository.findSiteWide(email.trim().toLowerCase())
}

export function isBlocked(email: string, eventId: number | null | undefined): boolean {
  return !!StreamBansRepository.findBlocking(email.trim().toLowerCase(), eventId)
}

export function ban(input: {
  email: string
  eventId?: number | null
  reason?: string | null
  bannedBy?: string | null
}): StreamBanView {
  const email = input.email.trim().toLowerCase()
  if (!email) throw createError({ statusCode: 400, statusMessage: 'email is required' })
  const eventId = input.eventId ?? null
  const existing = eventId == null
    ? StreamBansRepository.findSiteWide(email)
    : StreamBansRepository.listByEvent(eventId).find((b) => b.email === email)
  if (existing) {
    return toView(existing)
  }
  const row = StreamBansRepository.insert({
    email,
    eventId,
    reason: input.reason ?? null,
    bannedBy: input.bannedBy ?? null,
  })
  audit('warn', 'admin', `stream ban (${eventId == null ? 'site-wide' : `event ${eventId}`}): ${email}`, {
    actor: email,
    streamName: email,
    detail: { email, eventId, reason: input.reason ?? null, bannedBy: input.bannedBy ?? null },
  })
  return toView(row)
}

export function unban(id: number, actor?: string | null): void {
  const row = StreamBansRepository.listAll().find((b) => b.id === id)
  StreamBansRepository.remove(id)
  if (row) {
    audit('info', 'admin', `stream ban lifted: ${row.email}`, {
      actor: row.email,
      streamName: row.email,
      detail: { email: row.email, eventId: row.eventId ?? null, by: actor ?? null },
    })
  }
}

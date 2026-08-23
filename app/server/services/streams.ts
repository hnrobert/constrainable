/**
 * Active-session snapshot for the realtime panel. The live updates arrive over
 * Socket.IO; this gives the table its initial contents (any session not yet
 * ended). Optional eventId filter. DB access via PublishSessionsRepository.
 */
import { PublishSessionsRepository } from '../repositories/publish-sessions.repository'
import type { SessionSnapshot, SessionStatus } from '#shared/events'

export function listActiveSessions(eventId?: number | null): SessionSnapshot[] {
  return PublishSessionsRepository.findActive(eventId).map<SessionSnapshot>((r) => ({
    sessionId: r.id,
    eventId: r.eventId ?? null,
    streamName: r.streamName,
    status: r.status as SessionStatus,
    srsClientId: r.srsClientId ?? null,
    nodeId: r.nodeId ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    fps: r.fps ?? null,
    videoBitrateKbps: r.videoBitrateKbps ?? null,
    audioBitrateKbps: r.audioBitrateKbps ?? null,
    compliant: r.compliant,
    rejectReason: r.rejectReason ?? null,
    startedAt: r.startedAt.getTime(),
    endedAt: null,
  }))
}

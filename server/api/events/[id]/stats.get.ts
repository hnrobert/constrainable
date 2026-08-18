/**
 * Per-event statistics for the Insights tab: publish-session aggregates,
 * unique users, stream time, violations/rejections, and recording totals.
 */
import { PublishSessionsRepository } from '../../../repositories/publish-sessions.repository'
import { RecordingsRepository } from '../../../repositories/recordings.repository'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid event id' })
  }

  const sessions = PublishSessionsRepository.findAllByEvent(id)
  const recordings = RecordingsRepository.findByEvent(id)

  const users = new Set(sessions.map((s) => s.streamName))
  const streamMs = sessions.reduce((acc, s) => {
    const end = s.endedAt ? s.endedAt.getTime() : Date.now()
    return acc + Math.max(0, end - s.startedAt.getTime())
  }, 0)

  const recent = sessions.slice(0, 10).map((s) => ({
    id: s.id,
    streamName: s.streamName,
    status: s.status,
    compliant: s.compliant,
    width: s.width ?? null,
    height: s.height ?? null,
    fps: s.fps ?? null,
    bitrateKbps: s.bitrateKbps ?? null,
    startedAt: s.startedAt.getTime(),
    endedAt: s.endedAt ? s.endedAt.getTime() : null,
  }))

  return {
    sessions: sessions.length,
    live: sessions.filter((s) => !s.endedAt).length,
    uniqueUsers: users.size,
    streamHours: Math.round((streamMs / 3_600_000) * 10) / 10,
    violations: sessions.filter((s) => s.status === 'violating' || s.status === 'killed').length,
    rejected: sessions.filter((s) => s.status === 'rejected').length,
    complianceRate:
      sessions.length === 0
        ? null
        : Math.round(
            (sessions.filter((s) => s.compliant).length / sessions.length) * 1000,
          ) / 10,
    recordings: {
      count: recordings.length,
      totalBytes: recordings.reduce((a, r) => a + r.sizeBytes, 0),
      totalDurationSec: Math.round(recordings.reduce((a, r) => a + (r.durationSec ?? 0), 0)),
    },
    recent,
  }
})

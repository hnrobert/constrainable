/**
 * Recording catalog: list/filter, metadata, on-disk path resolution, delete.
 * Files live under env.recordDir/{date}/{name}_{ts}.mp4 (or .flv fallback);
 * `filePath` stored in DB is relative to recordDir. DB access goes through
 * RecordingsRepository; this layer owns filtering, file I/O, and DTO mapping.
 */
import { statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createError } from 'h3'
import { RecordingsRepository } from '../repositories/recordings.repository'
import type { Recording } from '../database/schema'
import { env } from '../utils/env'
import { audit } from './audit'

export interface RecordingView {
  id: number
  eventId: number | null
  sessionId: number | null
  streamName: string
  studentLabel: string | null
  filePath: string
  sizeBytes: number
  durationSec: number | null
  avgFps: number | null
  width: number | null
  height: number | null
  startedAt: number
  endedAt: number | null
  retainedUntil: number | null
  createdAt: number
}

export interface RecordingFilters {
  eventId?: number | null
  date?: string | null // YYYY-MM-DD (local day)
  q?: string | null // matches streamName or studentLabel
}

function toView(r: Recording): RecordingView {
  return {
    id: r.id,
    eventId: r.eventId ?? null,
    sessionId: r.sessionId ?? null,
    streamName: r.streamName,
    studentLabel: r.studentLabel ?? null,
    filePath: r.filePath,
    sizeBytes: r.sizeBytes,
    durationSec: r.durationSec ?? null,
    avgFps: r.avgFps ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt ? r.endedAt.getTime() : null,
    retainedUntil: r.retainedUntil ? r.retainedUntil.getTime() : null,
    createdAt: r.createdAt.getTime(),
  }
}

function localDay(ms: number): string {
  const d = new Date(ms)
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mo}-${da}`
}

export function listRecordings(filters: RecordingFilters = {}): RecordingView[] {
  let rows = RecordingsRepository.findAll()

  if (filters.eventId && filters.eventId > 0) {
    rows = rows.filter((r) => r.eventId === filters.eventId)
  }
  if (filters.date) {
    rows = rows.filter((r) => localDay(r.startedAt.getTime()) === filters.date)
  }
  if (filters.q) {
    const q = filters.q.toLowerCase()
    rows = rows.filter(
      (r) =>
        r.streamName.toLowerCase().includes(q) ||
        (r.studentLabel ?? '').toLowerCase().includes(q),
    )
  }
  return rows.map(toView)
}

export function getRecording(id: number): RecordingView {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  return toView(row)
}

export interface ResolvedFile {
  absPath: string
  filename: string
  mime: string
  size: number
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.flv': 'video/x-flv',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
}

/** All segment paths (relative to RECORD_DIR) for a recording, chronological. */
export function resolveSegments(id: number): string[] {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  const segs: string[] = row.segments ? JSON.parse(row.segments) : [row.filePath]
  return segs.filter((rel) => {
    try {
      statSync(join(env.recordDir, rel))
      return true
    } catch {
      return false
    }
  })
}

export function resolveRecordingFile(id: number): ResolvedFile {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  const absPath = join(env.recordDir, row.filePath)
  let size: number
  try {
    size = statSync(absPath).size
  } catch {
    throw createError({ statusCode: 410, statusMessage: 'recording file missing on disk' })
  }
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase()
  return {
    absPath,
    filename: row.filePath.split('/').pop() ?? `recording-${id}${ext}`,
    mime: MIME[ext] ?? 'application/octet-stream',
    size,
  }
}

export function deleteRecording(id: number): void {
  const row = RecordingsRepository.findById(id)
  if (!row) throw createError({ statusCode: 404, statusMessage: 'recording not found' })
  for (const rel of row.segments ? JSON.parse(row.segments) : [row.filePath]) {
    try {
      rmSync(join(env.recordDir, rel), { force: true })
    } catch {
      // file already gone — still drop the row
    }
  }
  RecordingsRepository.remove(id)
  audit('warn', 'recording', `recording deleted: ${row.streamName}`, {
    eventId: row.eventId ?? undefined,
    streamName: row.streamName,
    detail: { id, filePath: row.filePath },
  })
}

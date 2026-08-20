/**
 * Stream a recording for inline <video> playback or download (?download).
 *
 * Recordings are stored as real-time MKV segments (no stop-time transcoding).
 * Serving glues them ON DEMAND with a single `-c copy` ffmpeg pass:
 *   - playback: all segments → fragmented MP4 pipe (browser-native, playable
 *     while streaming, no seek index needed)
 *   - download: all segments → merged Matroska pipe
 * Legacy single-file .mp4 rows are served raw with full HTTP Range support.
 */
import { createReadStream } from 'node:fs'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { env } from '../../../utils/env'
import {
  resolveRecordingFile,
  resolveSegments,
  hostingNodeIdOf,
  materializeRemoteSegments,
} from '../../../services/recordings'
import { RecordingsRepository } from '../../../repositories/recordings.repository'

function pipeFfmpeg(event: any, args: string[], mime: string, downloadName?: string): Promise<any> {
  const proc = Bun.spawn([env.ffmpegPath, '-v', 'error', ...args], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  setHeader(event, 'content-type', mime)
  setHeader(event, 'cache-control', 'private, max-age=0')
  if (downloadName) {
    setHeader(event, 'content-disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`)
  }
  // Viewer left → stop pulling from disk
  event.node.req.on('close', () => {
    try {
      proc.kill()
    } catch {
      /* already dead */
    }
  })
  return sendStream(event, Readable.fromWeb(proc.stdout as unknown as Parameters<typeof Readable.fromWeb>[0]))
}

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }

  const segs = resolveSegments(id)
  const f = resolveRecordingFile(id)
  const isDownload = getQuery(event).download !== undefined

  // NODE-HOSTED recording: the segment files live on a media node's disk —
  // relay them over the socket into a temp dir first, then serve the copies
  // through the exact same local pipeline below. Temp cleanup on finish.
  const row = RecordingsRepository.findById(id)!
  const hostNode = hostingNodeIdOf(row)
  let segAbsPaths: string[] = segs.map((rel) => join(env.recordDir, rel))
  let remoteDir: string | null = null
  if (hostNode) {
    if (segs.length === 0) {
      throw createError({ statusCode: 410, statusMessage: 'recording has no segments' })
    }
    const m = await materializeRemoteSegments(hostNode, segs, id)
    segAbsPaths = m.absPaths
    remoteDir = m.dir
  }
  event.node.res.on('finish', () => {
    if (remoteDir) {
      try {
        rmSync(remoteDir, { force: true, recursive: true })
      } catch {
        /* ignore */
      }
    }
  })

  // Modern MKV segments (or multi-segment): glue on demand, zero transcode.
  // Single-segment FLV from a node is also glued (mp4 for play / mkv for
  // download) — the raw-serve branch below needs a LOCAL file for ranges.
  if (f.absPath.endsWith('.mkv') || segs.length > 1 || hostNode) {
    const tmpDir = join(env.recordDir, '_tmp')
    mkdirSync(tmpDir, { recursive: true })
    const list = join(tmpDir, `concat_${id}_${Date.now()}.txt`)
    writeFileSync(
      list,
      // ABSOLUTE paths: the concat demuxer resolves entries relative to the
      // LIST FILE's directory (not cwd) — a relative RECORD_DIR broke this.
      segAbsPaths.map((abs) => `file '${resolve(abs).replaceAll("'", "'\\''")}'`).join('\n'),
    )
    event.node.res.on('finish', () => {
      try {
        rmSync(list, { force: true })
      } catch {
        /* ignore */
      }
    })
    if (isDownload) {
      return pipeFfmpeg(
        event,
        ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'matroska', 'pipe:1'],
        'video/x-matroska',
        `${segs[0]!.split('/').pop()!.replace(/\.mkv$/, '')}_merged.mkv`,
      )
    }
    return pipeFfmpeg(
      event,
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-c',
        'copy',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
      ],
      'video/mp4',
    )
  }

  // Legacy single MP4: raw serve with Range support.
  setHeader(event, 'content-type', f.mime)
  setHeader(event, 'accept-ranges', 'bytes')
  setHeader(event, 'cache-control', 'private, max-age=0')
  if (isDownload) {
    setHeader(
      event,
      'content-disposition',
      `attachment; filename="${encodeURIComponent(f.filename)}"`,
    )
  }
  const range = getRequestHeader(event, 'range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? Number.parseInt(m[1], 10) : 0
    const end = m && m[2] ? Number.parseInt(m[2], 10) : f.size - 1
    if (!Number.isFinite(start) || start > end || start >= f.size) {
      setResponseStatus(event, 416)
      setHeader(event, 'content-range', `bytes */${f.size}`)
      return null
    }
    setResponseStatus(event, 206)
    setHeader(event, 'content-range', `bytes ${start}-${end}/${f.size}`)
    setHeader(event, 'content-length', end - start + 1)
    return sendStream(event, createReadStream(f.absPath, { start, end }))
  }
  setHeader(event, 'content-length', f.size)
  return sendStream(event, createReadStream(f.absPath))
})

/**
 * Serve a recording for inline <video> playback or download (?download).
 *
 * Recordings are stored as real-time segments (no stop-time transcoding).
 * Serving glues them ON DEMAND with a single `-c copy` ffmpeg pass into a
 * CACHED file under RECORD_DIR/_glue (playback: faststart MP4; download:
 * merged Matroska) and serves that file with FULL HTTP Range support.
 *
 * The cache is not a nicety — it is why this is a file and not an ffmpeg
 * stdout pipe: Safari's <video> (AVFoundation) probes the URL with
 * "Range: bytes=0-1" and REFUSES a rangeless 200-chunked entity (verified in
 * production 2026-08-27: pipe responses played in Chrome, errored in Safari).
 * A real file answers 206/Content-Range/Content-Length like the legacy
 * single-file branch always did.
 *
 * Lifecycle: each request re-arms a delayed unlink (one viewing session's
 * many range requests all hit the cache), and an hourly sweep drops
 * anything left behind by restarts.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import type { H3Event } from 'h3'
import { env } from '../../../utils/env'
import {
  resolveRecordingFile,
  resolveSegments,
  hostingNodeIdOf,
  materializeRemoteSegments,
} from '../../../services/recordings'
import { RecordingsRepository } from '../../../repositories/recordings.repository'

const GLUE_GRACE_MS = 30 * 60_000
const GLUE_SWEEP_MS = 60 * 60_000

function glueDir(): string {
  const dir = join(env.recordDir, '_glue')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** re-armed on every request — in-flight viewing sessions keep their file */
function scheduleGlueUnlink(path: string): void {
  setTimeout(() => {
    try {
      rmSync(path, { force: true })
    } catch {
      /* already gone */
    }
  }, GLUE_GRACE_MS).unref?.()
}

// restart leftovers: files whose viewers vanished with the process
setInterval(() => {
  try {
    for (const name of readdirSync(glueDir())) {
      const p = join(glueDir(), name)
      try {
        if (Date.now() - statSync(p).mtimeMs > GLUE_GRACE_MS) rmSync(p, { force: true })
      } catch {
        /* raced with the delayed unlink */
      }
    }
  } catch {
    /* dir not created yet */
  }
}, GLUE_SWEEP_MS).unref?.()

/** Serve a local file with full Range semantics (the <video> contract). */
function serveFile(event: H3Event, absPath: string, mime: string, size: number, downloadName?: string): Promise<void> {
  setHeader(event, 'content-type', mime)
  setHeader(event, 'accept-ranges', 'bytes')
  setHeader(event, 'cache-control', 'private, max-age=0')
  if (downloadName) {
    setHeader(event, 'content-disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`)
  }
  const range = getRequestHeader(event, 'range')
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m && m[1] ? Number.parseInt(m[1], 10) : 0
    const end = m && m[2] ? Number.parseInt(m[2], 10) : size - 1
    if (!Number.isFinite(start) || start > end || start >= size) {
      setResponseStatus(event, 416)
      setHeader(event, 'content-range', `bytes */${size}`)
      return Promise.resolve()
    }
    setResponseStatus(event, 206)
    setHeader(event, 'content-range', `bytes ${start}-${end}/${size}`)
    setHeader(event, 'content-length', end - start + 1)
    return sendStream(event, createReadStream(absPath, { start, end }))
  }
  setHeader(event, 'content-length', size)
  return sendStream(event, createReadStream(absPath))
}

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'invalid id' })
  }

  // Dedup: rows written before the merge was made idempotent can list a
  // segment twice — the concat demuxer would play it twice.
  const segs = [...new Set(resolveSegments(id))]
  const f = resolveRecordingFile(id)
  const isDownload = getQuery(event).download !== undefined

  // Modern multi-segment rows (and every node-hosted one): glue on demand
  // into a CACHED file, then serve it with ranges. Single-file legacy .mp4
  // rows skip straight to the raw serve below.
  const row = RecordingsRepository.findById(id)!
  const hostNode = hostingNodeIdOf(row)
  if (f.absPath.endsWith('.mkv') || segs.length > 1 || hostNode) {
    if (hostNode && segs.length === 0) {
      throw createError({ statusCode: 410, statusMessage: 'recording has no segments' })
    }
    const ext = isDownload ? 'mkv' : 'mp4'
    const hash = Bun.hash(segs.join('|')).toString(36)
    const glued = join(glueDir(), `rec-${id}-${hash}.${ext}`)

    if (!existsSync(glued)) {
      // Resolve the segment files: local rows straight off disk; node-hosted
      // rows relayed into a temp dir first (removed again once the glue is
      // done — only the glued file is served afterwards).
      let segAbsPaths = segs.map((rel) => join(env.recordDir, rel))
      let remoteDir: string | null = null
      if (hostNode) {
        const m = await materializeRemoteSegments(hostNode, segs, id)
        segAbsPaths = m.absPaths
        remoteDir = m.dir
      }
      const tmpDir = join(env.recordDir, '_tmp')
      mkdirSync(tmpDir, { recursive: true })
      const list = join(tmpDir, `concat_${id}_${Date.now()}.txt`)
      writeFileSync(
        list,
        // ABSOLUTE paths: the concat demuxer resolves entries relative to the
        // LIST FILE's directory (not cwd) — a relative RECORD_DIR broke this.
        segAbsPaths.map((abs) => `file '${resolve(abs).replaceAll("'", "'\\''")}'`).join('\n'),
      )
      const out = `${glued}.${process.pid}.${Date.now()}.part`
      const args = isDownload
        ? ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-f', 'matroska', out]
        : [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            list,
            '-c',
            'copy',
            // faststart puts the moov box up front — instantly playable AND
            // seekable once ranges answer 206s
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            out,
          ]
      const proc = Bun.spawn([env.ffmpegPath, '-v', 'error', ...args], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const errTail = await new Response(proc.stderr).text()
      const code = await proc.exited
      rmSync(list, { force: true })
      if (code !== 0 || !existsSync(out)) {
        rmSync(out, { force: true })
        if (remoteDir) rmSync(remoteDir, { force: true, recursive: true })
        throw createError({ statusCode: 500, statusMessage: `ffmpeg concat failed: ${errTail.slice(-200)}` })
      }
      renameSync(out, glued)
      if (remoteDir) rmSync(remoteDir, { force: true, recursive: true })
    }

    scheduleGlueUnlink(glued)
    const size = statSync(glued).size
    if (isDownload) {
      const downloadName = `${segs[0]!.split('/').pop()!.replace(/\.(mkv|flv)$/, '')}_merged.mkv`
      return serveFile(event, glued, 'video/x-matroska', size, downloadName)
    }
    return serveFile(event, glued, 'video/mp4', size)
  }

  // Legacy single MP4: raw serve with Range support.
  return serveFile(event, f.absPath, f.mime, f.size, isDownload ? f.filename : undefined)
})

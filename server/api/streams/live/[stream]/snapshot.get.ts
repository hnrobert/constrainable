/**
 * Latest-frame snapshot for a live stream: ffmpeg pulls ONE video frame from
 * SRS and pipes it out as JPEG. Powers the grid view's poster images (a still
 * of "right now" per tile) without mounting a full FLV player per stream.
 * Stream names are gateway-sanitized (no `@`), so the RTMP pull URL is
 * ffmpeg-safe. Admin-only; 3s in-memory cache per stream to keep tile refreshes
 * from spawning an ffmpeg per click.
 */
import { createError, getRouterParam, sendStream } from 'h3'
import { Readable } from 'node:stream'
import { env } from '../../../../utils/env'
import { buildFlvPullUrl } from '../../../../utils/srs-url'
import { signMediaUrl } from '../../../../utils/signed-url'
import { resolveFlvBase, getHostingNode } from '../../../../services/media-node-registry'

const cache = new Map<string, { ts: number; bytes: Uint8Array }>()
const TTL_MS = 3_000

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const stream = decodeURIComponent(String(getRouterParam(event, 'stream') ?? '')).trim()
  if (!stream || stream.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'stream is required' })
  }

  // Remote nodes: pull through the node's auth-gated play entry with a
  // self-signed URL (this app verifies its own signature on play:auth) — the
  // SRS sidecar never has to be exposed for snapshots. Local/single-server:
  // the internal FLV base as before.
  const hosted = getHostingNode(stream)
  const pullUrl = hosted?.publicOrigin
    ? signMediaUrl(hosted.publicOrigin, `/live/${encodeURIComponent(stream)}.flv`)
    : buildFlvPullUrl(stream, resolveFlvBase(stream))

  const hit = cache.get(stream)
  if (hit && Date.now() - hit.ts < TTL_MS) {
    setHeader(event, 'content-type', 'image/jpeg')
    setHeader(event, 'cache-control', 'no-store')
    return sendStream(event, Readable.from(Buffer.from(hit.bytes)))
  }

  const cmd = [
    env.ffmpegPath,
    '-v',
    'error',
    // FLV pull (RTMP starves on low-fps streams, see srs-url.ts); tiny analysis
    // budget so the frame arrives immediately.
    '-probesize',
    '65536',
    '-analyzeduration',
    '2000000',
    '-i',
    pullUrl,
    '-frames:v',
    '1',
    '-q:v',
    '4',
    '-f',
    'image2',
    'pipe:1',
  ]
  const proc = Bun.spawn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  const buf = new Uint8Array(
    await new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer(),
  )
  // 8s cap: kill a hung pull (stream just ended, SRS hiccup) instead of hanging the request
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already dead */
    }
  }, 8_000)
  await proc.exited
  clearTimeout(timer)

  const bytes = buf
  if (bytes.length < 100) {
    throw createError({ statusCode: 502, statusMessage: 'no frame available (stream live?)' })
  }
  cache.set(stream, { ts: Date.now(), bytes })
  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'no-store')
  return sendStream(event, Readable.from(Buffer.from(bytes)))
})

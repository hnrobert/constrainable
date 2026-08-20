/**
 * Latest-frame snapshot for a live stream (admin grid posters). Admin-only;
 * 3s in-memory cache per stream to keep tile refreshes from spawning an
 * ffmpeg per click. The capture itself lives in services/frame.ts.
 */
import { createError, getRouterParam, sendStream } from 'h3'
import { Readable } from 'node:stream'
import { captureLatestFrame } from '../../../../services/frame'

const cache = new Map<string, { ts: number; bytes: Uint8Array }>()
const TTL_MS = 3_000

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const stream = decodeURIComponent(String(getRouterParam(event, 'stream') ?? '')).trim()
  if (!stream || stream.includes('/')) {
    throw createError({ statusCode: 400, statusMessage: 'stream is required' })
  }

  const hit = cache.get(stream)
  if (hit && Date.now() - hit.ts < TTL_MS) {
    setHeader(event, 'content-type', 'image/jpeg')
    setHeader(event, 'cache-control', 'no-store')
    return sendStream(event, Readable.from(Buffer.from(hit.bytes)))
  }

  const bytes = await captureLatestFrame(stream)
  if (bytes.length < 100) {
    throw createError({ statusCode: 502, statusMessage: 'no frame available (stream live?)' })
  }
  cache.set(stream, { ts: Date.now(), bytes })
  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'no-store')
  return sendStream(event, Readable.from(Buffer.from(bytes)))
})

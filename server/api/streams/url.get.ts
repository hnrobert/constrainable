/**
 * Resolve browser→SRS FLV/WHEP playback URLs for a live stream. Admin-only:
 * live monitoring is reserved for proctors (requireAdmin). The browser still
 * hits SRS directly.
 */
import { createError } from 'h3'
import { buildPlaybackUrls } from '../../utils/srs-url'

export default defineEventHandler((event) => {
  requireAdmin(event)
  const q = getQuery(event)
  const streamName = String(q.streamName ?? '').trim()
  if (!streamName) {
    throw createError({ statusCode: 400, statusMessage: 'streamName is required' })
  }
  return buildPlaybackUrls(streamName)
})

/**
 * Resolve playback info for a live stream — WebRTC only: the WHEP signaling
 * URL (same-origin, ADMIN-GATED — media can never start without an
 * authenticated session) + ICE servers for the browser's peer connection.
 * Media itself flows directly browser ↔ the hosting node's SRS over UDP.
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

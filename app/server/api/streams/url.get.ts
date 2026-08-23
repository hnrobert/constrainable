/**
 * Resolve playback info for a live stream — WebRTC only: the WHEP signaling
 * URL (same-origin — media can never start without an authenticated session)
 * + ICE servers for the browser's peer connection. Media itself flows
 * directly browser ↔ the hosting node's SRS over UDP.
 *
 * ADMIN may watch any stream; a regular user only their OWN (their account
 * email IS their stream name — this is what the /live self-view rides on).
 */
import { createError } from 'h3'
import { buildPlaybackUrls } from '../../utils/srs-url'
import { getAuth } from '../../utils/auth'
import { UsersRepository } from '../../repositories/users.repository'

export default defineEventHandler((event) => {
  const auth = getAuth(event)
  if (!auth) throw createError({ statusCode: 403, statusMessage: 'login required' })
  const q = getQuery(event)
  const streamName = String(q.streamName ?? '').trim()
  if (!streamName) {
    throw createError({ statusCode: 400, statusMessage: 'streamName is required' })
  }
  const isAdmin = auth.role === 'admin'
  const ownEmail = UsersRepository.findById(auth.userId)?.email
  if (!isAdmin && streamName !== ownEmail) {
    throw createError({ statusCode: 403, statusMessage: 'you can only watch your own stream' })
  }
  return buildPlaybackUrls(streamName)
})

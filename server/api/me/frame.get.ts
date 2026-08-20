/**
 * The logged-in user's OWN latest live frame (self-view page). The stream
 * name for account publishers IS their email, so this only ever captures the
 * caller's own stream — no authorization surface. No server cache: the page
 * refreshes on explicit user click only.
 */
import { createError, sendStream } from 'h3'
import { Readable } from 'node:stream'
import { getAuth } from '../../utils/auth'
import { UsersRepository } from '../../repositories/users.repository'
import { PublishSessionsRepository } from '../../repositories/publish-sessions.repository'
import { captureLatestFrame } from '../../services/frame'

export default defineEventHandler(async (event) => {
  const auth = getAuth(event)
  if (!auth) throw createError({ statusCode: 403, statusMessage: 'login required' })
  const user = UsersRepository.findById(auth.userId)
  if (!user?.email) throw createError({ statusCode: 404, statusMessage: 'user not found' })

  const session = PublishSessionsRepository.findActiveByStream(user.email)
  if (!session) {
    throw createError({ statusCode: 404, statusMessage: 'you are not streaming right now' })
  }

  const bytes = await captureLatestFrame(user.email)
  if (bytes.length < 100) {
    throw createError({ statusCode: 502, statusMessage: 'no frame available yet — try again in a moment' })
  }
  setHeader(event, 'content-type', 'image/jpeg')
  setHeader(event, 'cache-control', 'no-store')
  return sendStream(event, Readable.from(Buffer.from(bytes)))
})

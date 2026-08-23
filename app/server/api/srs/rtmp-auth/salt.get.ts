/**
 * Stage-2 salt lookup for the RTMP gateway, plus the site-wide ban flag: a
 * banned account's OBS reconnect carries its email in the dance — refusing at
 * this stage with a fatal auth error stops it at CONNECT time, before any
 * publish attempt. Event-scoped bans can't be checked here (the event is only
 * known at publish); the policy endpoint covers both scopes. Unknown users get
 * a random salt (byte-identical challenge, no enumeration). Token-gated.
 */
import { createError, getHeader, getQuery } from 'h3'
import { env } from '../../../utils/env'
import { UsersRepository } from '../../../repositories/users.repository'
import { isSiteWideBanned } from '../../../services/stream-bans'

export default defineEventHandler((event) => {
  if (env.mediaNodeAuthToken !== '' && getHeader(event, 'x-rtmp-auth') !== env.mediaNodeAuthToken) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  const email = String(getQuery(event).email ?? '')
    .trim()
    .toLowerCase()
  const user = email ? UsersRepository.findByEmail(email) : undefined
  const banned = !!email && isSiteWideBanned(email)
  if (!user?.authmodSalt) {
    return { salt: randomSalt(), banned }
  }
  return { salt: user.authmodSalt, banned }
})

function randomSalt(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

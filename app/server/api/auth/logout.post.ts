/** Logout: clear the session cookie. */
import { clearSessionCookie } from '../../utils/session'
import { audit } from '../../services/audit'
import { UsersRepository } from '../../repositories/users.repository'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  setCookie(event, clearSessionCookie.name, '', clearSessionCookie.options)
  if (auth) {
    const email = UsersRepository.findById(auth.userId)?.email ?? `uid ${auth.userId}`
    audit('info', 'auth', `logout: ${email}`, { actor: email, detail: { userId: auth.userId } })
  }
  return { ok: true }
})

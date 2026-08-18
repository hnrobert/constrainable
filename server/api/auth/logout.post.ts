/** Logout: clear the session cookie. */
import { clearSessionCookie } from '../../utils/session'
import { audit } from '../../services/audit'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  setCookie(event, clearSessionCookie.name, '', clearSessionCookie.options)
  if (auth) audit('info', 'auth', `logout (uid ${auth.userId})`, { detail: { userId: auth.userId } })
  return { ok: true }
})

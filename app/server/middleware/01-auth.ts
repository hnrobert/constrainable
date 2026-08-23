/**
 * Single authentication gate. On every request it:
 *   1. Parses the JWT `sid` cookie → the caller's identity (uid).
 *   2. Resolves the CURRENT role from the DB (the cookie only proves identity
 *      — a role baked into the token would make panel promotions/demotions
 *      lag until re-login: a freshly promoted admin was still `user`, and a
 *      demoted admin kept admin until expiry). A cookie whose user no longer
 *      exists is treated as logged out.
 *   3. Lets the allowlist through unauthenticated (SRS hooks, the auth
 *      endpoints, the public-key + public-events endpoints, health, the public
 *      pages `/` `/login` `/invite`, and static/Nuxt internals).
 *   4. Lets any authenticated session through (admin OR regular user).
 *   5. Otherwise: 401 JSON for /api/*, or 302 → /login for page requests.
 *
 * Admin-gating is NOT done here — it lives per-handler via requireAdmin() — so
 * regular users can reach their authorized catalog & dashboard. Pure-HTTP
 * intranet, so the cookie has no Secure (see session.ts). This is the real
 * security boundary; client-side guards are only UX.
 */
import { createError, getCookie, sendRedirect } from 'h3'
import { readSessionCookie } from '../utils/session'
import { UsersRepository } from '../repositories/users.repository'

// Exact paths that never require a session.
const ALLOW_EXACT = new Set(['/', '/login', '/invite', '/favicon.ico'])
// Prefixes that never require a session.
const ALLOW_PREFIX = [
  '/api/srs/',
  '/api/auth/',
  '/api/events/public',
  // participant guide page + its visibility-gated data endpoint
  '/e/',
  '/api/events/slug/',
  '/api/health',
  // client crash reporter (must be reachable even when the app is broken)
  '/api/client-errors',
  '/favicon.svg',
  '/_nuxt/',
  '/__nuxt',
  '/socket/',
]

export default defineEventHandler(async (event) => {
  // 1. cookie → identity; DB → the authoritative CURRENT role (one PK select)
  const cookie = getCookie(event, 'sid')
  const payload = cookie ? await readSessionCookie(cookie) : null
  if (payload) {
    const user = UsersRepository.findById(payload.uid)
    event.context.auth = user ? { userId: user.id, role: user.role } : null
  }

  const path = (event.path ?? '').split('?')[0] ?? ''

  // 2. allowlist
  if (ALLOW_EXACT.has(path) || ALLOW_PREFIX.some((p) => path.startsWith(p))) return

  // 3. any authenticated session → through
  if (event.context.auth) return

  // 4. enforce
  if (path.startsWith('/api/')) {
    throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  }
  // page request → send to login (preserves the intended destination)
  return sendRedirect(event, `/login?redirect=${encodeURIComponent(path)}`, 302)
})

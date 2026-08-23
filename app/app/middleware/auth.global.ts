/**
 * Client UX gate. The server middleware (server/middleware/01-auth.ts) is the
 * real boundary; this mirrors it for SPA navigations so an expired session
 * redirects to /login instead of surfacing 401s.
 *
 * The session itself is fetched once by the SSR plugin
 * (app/plugins/auth.server.ts) and hydrated from the payload on the client, so
 * `user` is already populated by the time this runs — NO await here. (A previous
 * version did `await fetchSession()` in this global middleware; that awaited
 * middleware wrapped the whole route — layout included — in a Suspense boundary
 * and caused a dev-only client hydration mismatch on the <Default> layout.)
 *
 *   - `/`, `/login`, `/invite` are public (outsiders reach the landing page and
 *     the invite-join flow).
 *   - A logged-in user hitting `/login` is sent to `/dashboard`.
 *   - Everything else (all `/dashboard/**`) requires a session.
 *   - A non-admin on an admin-only dashboard route is sent to `/dashboard`.
 */
const PUBLIC = ['/', '/login', '/invite']
// Dashboard sub-routes reserved for admins (regular users get redirected away).
const ADMIN_ONLY = [
  '/dashboard/streams',
  '/dashboard/nodes',
  '/dashboard/config',
  '/dashboard/mail',
  '/dashboard/audit',
  '/dashboard/users',
  '/dashboard/groups',
]

export default defineNuxtRouteMiddleware((to) => {
  const { user } = useAuth()

  // Logged-in user on the login page → go to the dashboard (both roles land there).
  if (to.path === '/login' && user.value) {
    return navigateTo('/dashboard', { replace: true })
  }

  if (PUBLIC.includes(to.path)) return

  // Authenticated non-admin on an admin-only route → back to the dashboard home.
  if (
    user.value &&
    user.value.role !== 'admin' &&
    (to.meta.adminOnly || ADMIN_ONLY.some((p) => to.path === p || to.path.startsWith(p + '/')))
  ) {
    return navigateTo('/dashboard', { replace: true })
  }

  // No session at all → login (client-side only; a hard load is handled by the
  // server middleware so SSR still works).
  if (!user.value && import.meta.client) {
    return navigateTo(`/login?redirect=${encodeURIComponent(to.fullPath)}`, { replace: true })
  }
})

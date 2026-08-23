/**
 * The caller's own dashboard-home state: their private note (users.
 * dashboard_notice), the admin-authored announcement aimed at them (users.
 * announcement), and the admin-configured site notice (config
 * dashboard.notice). Any logged-in session (the server middleware already
 * gated /api/me behind auth — no anonymous reach). Kept separate from
 * /api/auth/session, which is pre-auth and stays user-identity-only.
 */
import { UsersRepository } from '../../repositories/users.repository'
import { getConfig } from '../../utils/config-store'

export default defineEventHandler((event) => {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'authentication required' })

  const user = UsersRepository.findById(auth.userId)
  return {
    dashboardNotice: user?.dashboardNotice ?? null,
    announcement: user?.announcement ?? null,
    siteNotice: getConfig().dashboard.notice,
  }
})

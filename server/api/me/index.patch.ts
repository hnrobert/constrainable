/**
 * Update the caller's OWN dashboard note (users.dashboard_notice) — the only
 * self-service field. Body: { dashboardNotice: string | null } (null/'' clears
 * the note card). Capped at 4000 chars; rendered client-side by RichText with
 * html:false, so user content can't inject markup.
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'

const MAX_LEN = 4000

export default defineEventHandler(async (event) => {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'authentication required' })

  const body = await readBody(event)
  const raw = body?.dashboardNotice
  // undefined = not provided → 400 (this endpoint exists for exactly this field)
  if (typeof raw !== 'string' && raw !== null) {
    throw createError({ statusCode: 400, statusMessage: 'dashboardNotice must be a string or null' })
  }
  const notice = raw === null ? null : raw.slice(0, MAX_LEN)
  UsersRepository.updateDashboardNotice(auth.userId, notice)
  return { dashboardNotice: notice }
})

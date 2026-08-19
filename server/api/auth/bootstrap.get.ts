/**
 * Tells the (unauthenticated) login page about pre-login state: whether the
 * system is still in bootstrap mode (no users yet) and the admin-authored
 * registration notice (config registration.notice, '' = hidden). When
 * bootstrap is true the first registration becomes the super admin and is
 * EXEMPT from the email-verification code + whitelist (mail may not be
 * configured yet), so the register UI hides the code step. Auto-allowlisted
 * (lives under /api/auth/).
 */
import { UsersRepository } from '../../repositories/users.repository'
import { getConfig } from '../../utils/config-store'

export default defineEventHandler(() => {
  return {
    bootstrap: UsersRepository.isEmpty(),
    registerNotice: getConfig().registration.notice,
  }
})

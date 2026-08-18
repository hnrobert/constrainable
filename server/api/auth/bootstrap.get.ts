/**
 * Tells the (unauthenticated) login page whether the system is still in
 * bootstrap mode (no users yet). When true, the first registration becomes the
 * super admin and is EXEMPT from the email-verification code + whitelist (mail
 * may not be configured yet), so the register UI hides the code step. Auto-
 * allowlisted (lives under /api/auth/).
 */
import { UsersRepository } from '../../repositories/users.repository'

export default defineEventHandler(() => {
  return { bootstrap: UsersRepository.isEmpty() }
})

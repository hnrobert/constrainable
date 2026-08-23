/** Admin: read the site mail config (secrets redacted → has* flags). */
import { mailConfigToClient } from '../../utils/mail-config'

export default defineEventHandler((event) => {
  requireAdmin(event)
  return mailConfigToClient()
})

/**
 * Admin: save the site mail config. A PUT with empty `senderPassword` /
 * `postAuthToken` preserves the stored secret (so the admin can edit other
 * fields without re-entering the password). Returns the redacted config.
 */
import { saveMailConfig, mailConfigToClient } from '../../utils/mail-config'
import { audit } from '../../services/audit'

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event)
  const next = saveMailConfig(body ?? {})
  audit('info', 'config', 'mail config updated', {
    detail: {
      provider: next.provider,
      hasPassword: next.senderPassword.length > 0,
      hasPostAuthToken: next.postAuthToken.length > 0,
    },
  })
  return mailConfigToClient(next)
})

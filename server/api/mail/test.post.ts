/**
 * Admin: send a test email to `to` using the current site mail config. Per-
 * recipient rate-limited (1/min, 10/day). Lets the admin verify SMTP/webhook
 * connectivity right after editing the config.
 */
import { createError } from 'h3'
import { EMAIL_RE, normalizeEmail } from '../../utils/registration'
import { checkAccountSend, checkEmailSend, throwEmailLimit } from '../../utils/email-limit'
import { getMailConfig, isMailConfigured } from '../../utils/mail-config'
import { sendMailWithConfig } from '../../services/mail'
import { renderCardEmail } from 'email-poster/template'
import { ingestMailTheme } from '../../utils/mail-template'
import { audit } from '../../services/audit'

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event)
  const body = await readBody(event)
  const to = normalizeEmail(String(body?.to ?? ''))
  if (!EMAIL_RE.test(to)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid recipient email format' })
  }

  // Rate limits: per sender (aggregated across their sends) and per recipient.
  const accountLimit = checkAccountSend(admin.userId)
  if (!accountLimit.allowed) throwEmailLimit(accountLimit)
  const limit = checkEmailSend('test', to)
  if (!limit.allowed) throwEmailLimit(limit)

  if (!isMailConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Mail service is not configured' })
  }

  try {
    await sendMailWithConfig(getMailConfig(), {
      to,
      subject: '[Constrainable Ingest] Test email',
      body: renderCardEmail(
        {
          title: 'Test email',
          bodyHtml:
            '<p>This is a test email from Constrainable Ingest. If you received it, your mail configuration is working correctly.</p>',
          preheader: 'Constrainable Ingest test email',
        },
        ingestMailTheme(),
      ),
      html: true,
    })
  } catch (err) {
    audit('error', 'config', `mail test failed → ${to}`, {
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
    throw createError({
      statusCode: 502,
      statusMessage: 'Send failed: ' + (err instanceof Error ? err.message : String(err)),
    })
  }

  audit('info', 'config', `mail test sent → ${to}`)
  return { ok: true }
})

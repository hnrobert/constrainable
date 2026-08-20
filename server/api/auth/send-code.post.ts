/**
 * Step 1 of two-step email registration: email a 6-digit verification code.
 * Auto-allowlisted (lives under /api/auth/). The code is keyed by
 * `${email}:${session}` so concurrent tabs don't collide; step 2 (register)
 * consumes it. Bootstrap mode (no users yet) short-circuits — the first admin
 * needs no code — so the frontend simply won't call this until a user exists.
 */
import { createError } from 'h3'
import { randomInt } from 'node:crypto'
import { UsersRepository } from '../../repositories/users.repository'
import {
  EMAIL_RE,
  describeEmailRules,
  isDisallowedEmail,
  normalizeEmail,
  passesWhitelist,
} from '../../utils/registration'
import { issueCode } from '../../utils/email-code'
import { checkEmailSend, throwEmailLimit } from '../../utils/email-limit'
import { getMailConfig, isMailConfigured } from '../../utils/mail-config'
import { sendMailWithConfig } from '../../services/mail'
import { renderCodeEmail } from 'email-poster/template'
import { ingestMailTheme, VERIFICATION_CODE_SUBJECT } from '../../utils/mail-template'
import { audit } from '../../services/audit'

const CODE_MINUTES = 10

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = normalizeEmail(String(body?.email ?? ''))
  const session = String(body?.session ?? '')

  if (!EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid email format' })
  }
  if (!session) {
    throw createError({ statusCode: 400, statusMessage: 'Missing session identifier' })
  }

  // Bootstrap: no users yet → first admin needs no code.
  if (UsersRepository.isEmpty()) {
    return { ok: true, bootstrap: true }
  }

  // Disallowed mailing-list addresses never get a code (403, like the verifier).
  // Surface the rules so the user can self-correct — the policy is not a secret,
  // and this does not weaken anti-enumeration (the existence check below is still
  // silent; these rejections are about the email pattern, not account existence).
  if (isDisallowedEmail(email)) {
    const rules = describeEmailRules()
    throw createError({
      statusCode: 403,
      statusMessage: `This email address is not allowed to register${rules ? ` (${rules})` : ''}`,
    })
  }
  // Domain whitelist (bootstrap is exempt — handled above).
  if (!passesWhitelist(email)) {
    const rules = describeEmailRules()
    throw createError({
      statusCode: 403,
      statusMessage: `This email domain is not allowed to register${rules ? ` (${rules})` : ''}`,
    })
  }
  // Don't reveal whether an account already exists (anti-enumeration), and don't
  // spam existing users — return the same OK the success path does (verifier parity).
  if (UsersRepository.findByEmail(email)) {
    return { ok: true }
  }
  // Mail must be configured before we rate-limit/send: an un-sendable request
  // shouldn't count against the recipient's quota (verifier order).
  if (!isMailConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Mail service is not configured, please contact the admin' })
  }

  const limit = checkEmailSend('code', email)
  if (!limit.allowed) throwEmailLimit(limit)

  const code = String(randomInt(100000, 1000000))
  issueCode(email, session, code)

  try {
    const F = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
    await sendMailWithConfig(getMailConfig(), {
      to: email,
      subject: VERIFICATION_CODE_SUBJECT,
      body: renderCodeEmail(
        {
          code,
          title: 'Registration verification code',
          leadHtml: `<p style="${F}font-size:15px;line-height:1.65;color:#404040;">You are registering an account. Please use the verification code below to complete verification:</p>`,
          hintHtml: `<p style="${F}font-size:13px;line-height:1.6;color:#737373;">The code is valid for ${CODE_MINUTES} minutes. If this wasn't you, please ignore this email.</p>`,
          preheader: `Your registration verification code is ${code}`,
        },
        ingestMailTheme(),
      ),
      html: true,
    })
  } catch (err) {
    audit('error', 'auth', `verification code send failed: ${email}`, {
      actor: email,
      detail: { error: err instanceof Error ? err.message : String(err) },
    })
    throw createError({ statusCode: 502, statusMessage: 'Failed to send verification code, please try again later or contact the admin' })
  }

  audit('info', 'auth', `verification code sent: ${email}`, { actor: email })
  return { ok: true }
})

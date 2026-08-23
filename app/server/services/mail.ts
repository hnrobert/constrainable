/**
 * Outbound transactional email. Two transports, picked by `config.provider`:
 *   - 'smtp': Nodemailer direct SMTP (implicit-TLS `secure` for :465, or
 *     STARTTLS `requireTLS` for :587/:25; auth only when usePassword).
 *   - 'post': HTTP POST webhook via email-poster. The payload shape is the
 *     FieldMap in `postFieldMap` (logical field → downstream key), edited in the
 *     admin UI; when empty it migrates from the legacy `postSchema` discriminator
 *     ('powerautomate' → the custom_example shape, otherwise smtogo).
 *
 * Ported from unnc-freshmen-verifier-gateway/server/utils/mail.ts (TypeORM
 * removed; MailConfig comes from shared/mail.ts via mail-config.ts).
 */
import { randomBytes } from 'node:crypto'
import nodemailer from 'nodemailer'
import { EmailPoster, PRESETS, type FieldMap } from 'email-poster'
import type { MailConfig } from '#shared/mail'
import { EMAIL_RE } from '../utils/registration'

export interface SendMailInput {
  to: string
  subject: string
  body: string
  /** Send `body` as text/html instead of text/plain. */
  html?: boolean
}

/** Envelope From. When authenticated it must match the SMTP login (senderEmail);
 *  the display name is what the recipient sees. */
function fromAddress(c: MailConfig): string {
  const display = c.senderDisplay.trim()
  if (c.usePassword) {
    return display && display !== c.senderEmail ? `${display} <${c.senderEmail}>` : c.senderEmail
  }
  return display || c.senderEmail
}

function validate(c: MailConfig, input: SendMailInput): void {
  if (!EMAIL_RE.test(input.to)) throw new Error('Invalid recipient email format')
  if (input.to.length > c.maxLenRecipientEmail) {
    throw new Error(`Recipient email too long (max ${c.maxLenRecipientEmail})`)
  }
  if (input.subject.length > c.maxLenSubject) {
    throw new Error(`Subject too long (max ${c.maxLenSubject})`)
  }
}

/**
 * Resolve the effective email-poster FieldMap for a config. The stored
 * `postFieldMap` JSON is authoritative when present; otherwise migrate from the
 * legacy `postSchema` discriminator ('powerautomate' → custom_example, i.e.
 * {email, subject, content}; otherwise smtogo's {from, to, subject, html}).
 * Malformed JSON falls back to the migration path so a corrupt row never blocks
 * sending.
 */
function resolveFieldMapFromConfig(c: MailConfig): FieldMap {
  const raw = c.postFieldMap?.trim()
  if (raw) {
    try {
      return JSON.parse(raw) as FieldMap
    } catch {
      // fall through to legacy migration
    }
  }
  return c.postSchema === 'powerautomate' ? PRESETS.custom_example : PRESETS.smtogo
}

/**
 * Send via an HTTP POST webhook through email-poster. The field map is fully
 * editable from the admin UI; the two legacy shapes (smtogo / Custom Example)
 * are the migration defaults, so payloads are byte-identical to the previous
 * hand-rolled implementation.
 *
 * Wire-compat is deliberately pinned — do NOT relax without auditing all call
 * sites: `retry.maxAttempts: 1` (legacy was a single fetch with no retry) and
 * `parseMessageId: false` (legacy synthesized `<post-<hex>@webhook>` without
 * reading the response body). Both reproduce the old on-the-wire behavior.
 */
async function sendViaPost(c: MailConfig, input: SendMailInput): Promise<string> {
  if (!c.postUrl) throw new Error('Webhook URL not configured')
  validate(c, input)
  const poster = new EmailPoster({
    postUrl: c.postUrl,
    preset: 'none',
    fields: resolveFieldMapFromConfig(c),
    fromAddress: fromAddress(c),
    headers: c.postAuthToken ? { Authorization: `Bearer ${c.postAuthToken}` } : {},
    // Legacy parity: one attempt (no retry), always-synthesized message id.
    retry: { maxAttempts: 1 },
    recipients: { serialize: 'comma' },
    parseMessageId: false,
  })
  try {
    const { messageId } = await poster.send({
      to: input.to,
      subject: input.subject,
      body: input.body,
      type: input.html ? 'html' : 'text',
    })
    return messageId
  } catch (e) {
    // email-poster formats HTTP failures as "Webhook returned <status>: <detail>";
    // surface that verbatim, fall back for non-Error throws.
    throw new Error(e instanceof Error ? e.message : 'Webhook send failed', { cause: e })
  }
}

/** Send using an explicit config. Returns the message id. */
export async function sendMailWithConfig(c: MailConfig, input: SendMailInput): Promise<string> {
  if (c.provider === 'post') return sendViaPost(c, input)
  if (!c.host) throw new Error('SMTP server not configured')
  validate(c, input)
  const transporter = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.useSsl, // implicit TLS (direct socket TLS, e.g. :465)
    requireTLS: c.useTls, // force STARTTLS (e.g. :587/:25)
    auth: c.usePassword ? { user: c.senderEmail, pass: c.senderPassword } : undefined,
  })
  try {
    const info = await transporter.sendMail({
      from: fromAddress(c),
      to: input.to,
      subject: input.subject,
      messageId: c.senderDomain ? `<${randomBytes(12).toString('hex')}@${c.senderDomain}>` : undefined,
      ...(input.html ? { html: input.body } : { text: input.body }),
    })
    return info.messageId
  } finally {
    transporter.close()
  }
}

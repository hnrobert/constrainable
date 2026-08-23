/**
 * Site mail/SMTP config — read-through cache over the `mail` row of app_config
 * (kept in its own key so the SMTP secret never flows through the main config
 * blob's GET). Mirrors the gateway's mail-config singleton: redact secrets on
 * read, preserve them on write when the incoming value is empty.
 */
import { AppConfigRepository } from '../repositories/app-config.repository'
import { mailConfigSchema, type MailConfig, type MailConfigClient } from '#shared/mail'

const KEY = 'mail'
let _cache: MailConfig | null = null

/** The full config (with secrets). Lazy read-through; zod defaults on no row. */
export function getMailConfig(): MailConfig {
  if (_cache) return _cache
  const row = AppConfigRepository.findKey(KEY)
  try {
    _cache = mailConfigSchema.parse(row ? JSON.parse(row.value) : {})
  } catch (err) {
    console.error('[mail] config load failed, using defaults:', err)
    _cache = mailConfigSchema.parse({})
  }
  return _cache
}

/** Drop the cache so the next getMailConfig() re-reads the DB. */
export function invalidateMailConfig(): void {
  _cache = null
}

/** Is there a usable sender configured? (enough to actually send a message.) */
export function isMailConfigured(): boolean {
  const c = getMailConfig()
  if (c.provider === 'post') return c.postUrl.trim().length > 0
  return c.host.trim().length > 0
}

/**
 * Upsert the site mail config. `senderPassword`/`postAuthToken` are only
 * overwritten when a non-empty value is supplied, so "save without re-entering
 * the secret" leaves the stored value intact. Validates the whole thing with
 * zod, persists, and invalidates the cache.
 */
export function saveMailConfig(patch: Partial<MailConfig>): MailConfig {
  const current = getMailConfig()
  const merged: MailConfig = { ...current, ...patch }
  // preserve secrets when the incoming value is empty
  if (!patch.senderPassword) merged.senderPassword = current.senderPassword
  if (!patch.postAuthToken) merged.postAuthToken = current.postAuthToken

  const next = mailConfigSchema.parse(merged)
  AppConfigRepository.upsertKey(KEY, JSON.stringify(next))
  invalidateMailConfig()
  return next
}

/** Config safe to return to the admin UI — drops secrets, exposes has* flags. */
export function mailConfigToClient(c: MailConfig = getMailConfig()): MailConfigClient {
  return {
    provider: c.provider,
    host: c.host,
    port: c.port,
    useSsl: c.useSsl,
    useTls: c.useTls,
    usePassword: c.usePassword,
    senderEmail: c.senderEmail,
    senderDisplay: c.senderDisplay,
    senderDomain: c.senderDomain,
    hasPassword: c.senderPassword.length > 0,
    maxLenRecipientEmail: c.maxLenRecipientEmail,
    maxLenSubject: c.maxLenSubject,
    maxLenBody: c.maxLenBody,
    postUrl: c.postUrl,
    postSchema: c.postSchema,
    postFieldMap: c.postFieldMap,
    postSchemas: c.postSchemas,
    hasPostAuthToken: c.postAuthToken.length > 0,
  }
}

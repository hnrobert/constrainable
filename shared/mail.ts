import { z } from 'zod'

/**
 * Site-wide mail/SMTP sender config. Stored as one JSON row (`key = 'mail'` in
 * app_config, held by server/utils/mail-config.ts), super-admin-owned, editable
 * in the Mail settings page. Two providers:
 *   - 'smtp': Nodemailer direct SMTP (host/port/SSL/STARTTLS/auth).
 *   - 'post': HTTP POST webhook relaying to a downstream mailer. The payload
 *     shape is a field map (logical field → downstream JSON key) edited by the
 *     visual interface editor (`postFieldMap`, an email-poster FieldMap as JSON);
 *     when empty it falls back to the legacy `postSchema` discriminator
 *     ('powerautomate' → the Custom Example shape {email,content,subject},
 *     otherwise smtogo's {from,to,subject,html}).
 *
 * `senderPassword` and `postAuthToken` are secrets: never returned by the GET
 * endpoint (mail-config.ts redacts them to '' + has* flags); a PUT with an empty
 * value preserves the stored secret.
 */
export const mailConfigSchema = z.object({
  provider: z.enum(['smtp', 'post']).default('smtp'),
  // --- SMTP ---
  host: z.string().default(''),
  port: z.number().int().min(0).max(65535).default(587),
  useSsl: z.boolean().default(false),
  useTls: z.boolean().default(true),
  usePassword: z.boolean().default(true),
  senderEmail: z.string().default(''),
  senderDisplay: z.string().default(''),
  senderDomain: z.string().default(''),
  senderPassword: z.string().default(''),
  maxLenRecipientEmail: z.number().int().min(1).default(320),
  maxLenSubject: z.number().int().min(1).default(200),
  maxLenBody: z.number().int().min(1).default(50_000),
  // --- HTTP POST webhook ---
  postUrl: z.string().default(''),
  postSchema: z.enum(['smtogo', 'powerautomate']).default('smtogo'),
  postAuthToken: z.string().default(''),
  /**
   * email-poster FieldMap as JSON (logical field → downstream key), edited by the
   * visual interface editor. When empty, the effective map is derived from
   * `postSchema` for backward compatibility ('powerautomate' → the custom_example
   * preset, otherwise smtogo). Once non-empty, this is authoritative.
   */
  postFieldMap: z.string().default(''),
  /**
   * The post-schemas library (email-poster `PostSchema[]`) as JSON — the named
   * field maps the operator switches between / adds / renames / deletes in the
   * editor. Stored server-side (shared across admins, not per-browser). The
   * active webhook format is `postFieldMap`; this is the palette behind it.
   * Empty string = never stored (the editor seeds the built-in defaults on first
   * use and persists them here); `'[]'` = explicitly cleared (stays empty).
   */
  postSchemas: z.string().default(''),
})

export type MailConfig = z.infer<typeof mailConfigSchema>

/** Shape returned to the admin UI — secrets dropped, has* flags added. */
export type MailConfigClient = Omit<MailConfig, 'senderPassword' | 'postAuthToken'> & {
  hasPassword: boolean
  hasPostAuthToken: boolean
}

/**
 * Site email branding for the email-poster preset templates
 * (`email-poster/template`). The primary color mirrors the UI's `--primary`
 * (oklch 0.62 0.19 256 ≈ #3B82F6); there is no logo, so emails carry just the
 * brand title and the no-reply footer.
 */
import type { EmailTheme } from 'email-poster/template'

/** The site theme for all outgoing preset emails. */
export function ingestMailTheme(): EmailTheme {
  return {
    brandTitle: 'Constrainable Ingest',
    primaryColor: '#3B82F6',
    footerHtml: 'This email was sent automatically; please do not reply.',
  }
}

export const VERIFICATION_CODE_SUBJECT = '[Constrainable Ingest]Registration verification code'

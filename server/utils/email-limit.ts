/**
 * Rate limiting for outbound transactional emails — two independent dimensions:
 *
 *  • Per-target (recipient address), per flow: 1/minute, {@link EMAIL_DAILY_LIMIT}/day.
 *    Applied to every user-initiated send (registration code, mail test) so one
 *    address can't be spammed. {@link checkEmailSend}
 *  • Per-account (the authenticated sender), aggregated across all flows:
 *    6/min, 24/day. Applies to admin-initiated sends (mail test).
 *    {@link checkAccountSend}
 *
 * The sliding-window engine lives in email-poster (`createEmailLimiter`); this
 * module binds it to the site's names and shapes the 429 via `createError`.
 * In-memory, single-instance; counters are sliding windows of timestamps.
 */
import { createError } from 'h3'
import { createEmailLimiter, type EmailLimitResult } from 'email-poster'

export type { EmailLimitResult }

export const EMAIL_DAILY_LIMIT = 10

const limiter = createEmailLimiter()

/** Per-recipient cap for `flow` ('code' | 'test'). 1/min, 10/day. */
export function checkEmailSend(flow: string, email: string, now: Date = new Date()): EmailLimitResult {
  return limiter.checkTarget(flow, email, now)
}

/** Per-account cap (aggregated across flows). 6/min, 24/day. */
export function checkAccountSend(userId: number | string, now: Date = new Date()): EmailLimitResult {
  return limiter.checkAccount(userId, now)
}

/** Throw the HTTP error for a blocked send (wording for the UI). */
export function throwEmailLimit(r: EmailLimitResult): never {
  const statusMessage =
    r.reason === 'minute'
      ? `Sending too frequently — please wait ${r.retryInSeconds ?? 60} seconds and try again`
      : r.scope === 'address'
        ? `Daily send limit reached (${r.dailyLimit}/day)`
        : `Daily send limit reached for your account (${r.dailyLimit}/day)`
  throw createError({ statusCode: 429, statusMessage })
}

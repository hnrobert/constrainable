/**
 * In-memory store for short-lived registration email-verification codes. Each
 * entry is keyed by `${email}:${session}` — the `session` is a client-chosen flow
 * token, so multiple tabs / concurrent registrations for the same email don't
 * collide. Codes are one-shot and TTL-bound. Single-instance only; a restart
 * simply invalidates in-flight codes (the user re-requests).
 *
 * Ported verbatim from unnc-freshmen-verifier-gateway/server/utils/emailCode.ts
 * (runtime-agnostic — no DB, no framework).
 */
import { timingSafeEqual } from 'node:crypto'

const CODE_TTL_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 5
const codes = new Map<string, { code: string; expiresAt: number; attempts: number }>()

function key(email: string, session: string): string {
  return `${email}:${session}`
}

/** Drop expired entries. Called opportunistically on issue/consume. */
function sweep(now = Date.now()): void {
  for (const [k, v] of codes) if (v.expiresAt <= now) codes.delete(k)
}

/** Store (or overwrite) a verification code for the email+session, TTL 10 min. */
export function issueCode(email: string, session: string, code: string): void {
  sweep()
  codes.set(key(email, session), { code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 })
}

/**
 * Verify the code. Constant-time compare. A correct guess consumes the entry
 * (one-shot). A wrong guess counts toward `MAX_ATTEMPTS`; once exhausted the
 * entry is dropped so the user must re-request — this caps brute-forcing of the
 * 6-digit code (the register endpoint is otherwise unthrottled per attempt).
 */
export function consumeCode(email: string, session: string, code: string): boolean {
  sweep()
  const k = key(email, session)
  const entry = codes.get(k)
  if (!entry) return false
  const a = Buffer.from(code)
  const b = Buffer.from(entry.code)
  const ok = a.length === b.length && timingSafeEqual(a, b)
  if (ok) {
    codes.delete(k)
    return true
  }
  entry.attempts += 1
  if (entry.attempts >= MAX_ATTEMPTS) codes.delete(k)
  else codes.set(k, entry)
  return false
}

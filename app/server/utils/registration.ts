/**
 * Registration email validation helpers. Mirrors the restriction approach of
 * unnc-freshmen-verifier-gateway: a format check, a configurable disallowed-
 * substring blocklist (mailing-list accounts), and a picomatch domain whitelist
 * (admin-controlled). The whitelist + blocklist are read from the runtime config
 * blob (shared/config.ts → `registration`), cached/invalidated by config-store.
 */
import picomatch from 'picomatch'
import { getConfig } from './config-store'

/** Basic email shape — same as the gateway. */
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** Trim + lowercase; the canonical form stored & looked up everywhere. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * True for addresses the system never accepts — institutional mailing-list
 * accounts (student/staff) that aren't individual recipients. Patterns come from
 * `registration.disallowedPatterns` (default `['student','staff']`); each is a
 * case-insensitive substring test (plain substring, not regex, to stay safe
 * against admin-entered special characters).
 */
export function isDisallowedEmail(email: string, patterns?: string[]): boolean {
  const list = patterns ?? getConfig().registration.disallowedPatterns
  const lower = email.toLowerCase()
  return list.some((p) => p && lower.includes(p.toLowerCase()))
}

/**
 * True if `email` matches any whitelist glob (case-insensitive picomatch), e.g.
 * `*@nottingham.edu.cn`, `*@*.nottingham.edu.cn`, `{john,jane}@x.com`. An empty
 * pattern list never matches — callers treat enabled+empty as "allow all".
 */
export function emailMatchesWhitelist(email: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return picomatch.isMatch(email.toLowerCase(), patterns, { nocase: true })
}

/** The current whitelist config from the runtime config blob. */
export function getEmailWhitelist(): { enabled: boolean; patterns: string[] } {
  return getConfig().registration.emailWhitelist
}

/**
 * Whether `email` passes the whitelist gate. When the whitelist is disabled, or
 * enabled but empty (no patterns), everyone passes. When enabled with patterns,
 * the email must match at least one. (The bootstrap super-admin registration
 * bypasses this entirely — checked in the register handler.)
 */
export function passesWhitelist(email: string): boolean {
  const wl = getEmailWhitelist()
  if (!wl.enabled) return true
  if (wl.patterns.length === 0) return true
  return emailMatchesWhitelist(email, wl.patterns)
}

/**
 * Human-readable summary of the registration email rules currently in effect,
 * surfaced in rejection messages so the rejected user can see what IS allowed.
 * Lists the whitelist patterns (typically domain globs, e.g. `*@x.edu`) and the
 * disallowed substrings. Returns '' when no rule is configured — though in
 * practice a rejection only fires when at least one rule matches, so this is
 * non-empty on the 403 paths. Showing the policy is safe: it reveals no account
 * data, only the registration rules (anti-enumeration protects the *existence*
 * check, which stays silent).
 */
export function describeEmailRules(): string {
  const reg = getConfig().registration
  const clauses: string[] = []
  const wl = reg.emailWhitelist
  if (wl?.enabled && wl.patterns.length) {
    clauses.push(`allowed email patterns: ${wl.patterns.join(', ')}`)
  }
  // The disallowed-substring blocklist is intentionally NOT surfaced in the hint.
  // Uncomment to also show "must not contain: …" alongside the allowed patterns.
  // const blocked = (reg.disallowedPatterns ?? []).filter((p) => !!p && p.trim() !== '')
  // if (blocked.length) {
  //   clauses.push(`must not contain: ${blocked.join(', ')}`)
  // }
  return clauses.join('; ')
}

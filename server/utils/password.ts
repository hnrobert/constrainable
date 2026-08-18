/**
 * Password hashing — argon2id with a per-password random salt, mirroring
 * unnc-freshmen-verifier-gateway (server/utils/auth.ts). We use the pure-JS
 * @noble/hashes implementation (no native binding, Bun-friendly) and store the
 * salt+hash as `saltHex:hashHex`. Argon2id params are the RFC 9106 first profile
 * (t=2, m=19456 KiB ≈ 19 MB, p=1).
 *
 * Compatibility: hashes previously produced by `Bun.password` are PHC strings
 * (`$argon2id$…`) with no ':' — verifyPassword transparently accepts those too,
 * so accounts created before this change still log in (the login handler
 * re-hashes them to the new format on the next successful login).
 */
import { argon2id } from '@noble/hashes/argon2.js'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const ARGON_OPTS = { t: 2, m: 19456, p: 1 } as const
const LEGACY_PHC_PREFIX = '$argon2'

export const hashPassword = (plain: string): string => {
  const salt = randomBytes(16)
  const hash = argon2id(Buffer.from(plain, 'utf8'), salt, ARGON_OPTS)
  return `${salt.toString('hex')}:${Buffer.from(hash).toString('hex')}`
}

export function verifyPassword(plain: string, stored: string): boolean | Promise<boolean> {
  // Legacy Bun.password PHC string → defer to Bun's verifier.
  if (stored.startsWith(LEGACY_PHC_PREFIX)) {
    return Bun.password.verify(plain, stored)
  }
  const sep = stored.indexOf(':')
  if (sep < 0) return false
  const saltHex = stored.slice(0, sep)
  const hashHex = stored.slice(sep + 1)
  const salt = Buffer.from(saltHex, 'hex')
  if (salt.length === 0) return false
  const a = Buffer.from(argon2id(Buffer.from(plain, 'utf8'), salt, ARGON_OPTS))
  const b = Buffer.from(hashHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** True when `stored` is a legacy Bun.password PHC string (needs re-hash). */
export const isLegacyHash = (stored: string): boolean => stored.startsWith(LEGACY_PHC_PREFIX)

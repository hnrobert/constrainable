/**
 * Stream-key token utilities. The plaintext token is shown to the student ONCE
 * (as the OBS stream key suffix `?token=...`); only its argon2id hash is stored.
 */
import { hashPassword, verifyPassword } from './password'

/** Cryptographic random token, URL-safe (RTMP-param safe). */
export function generateToken(byteLen = 24): string {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  // base64url, no padding
  const b64 = btoa(String.fromCharCode(...bytes))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Display preview like `abcd…wxyz` for the admin list (never the full token). */
export function tokenPreview(token: string): string {
  if (token.length <= 10) return token
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

export const hashToken = async (token: string): Promise<string> => hashPassword(token)
export const verifyToken = async (token: string, hash: string): Promise<boolean> => verifyPassword(token, hash)

/** Build a stream name from a student number, falling back to a random slug. */
export function streamNameFor(studentNumber?: string | null): string {
  const base = (studentNumber ?? '').replace(/[^a-zA-Z0-9_-]/g, '')
  if (base) return base
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')
}

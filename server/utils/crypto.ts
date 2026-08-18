/**
 * Symmetric encryption-at-rest (AES-256-GCM) for secrets the app must later
 * decrypt — currently the RTMP authmod verifier, a password-equivalent that must
 * not leak from a bare DB dump. The key is derived (SHA-256) from
 * `env.verifierSecret`. Ciphertext is packed as base64(iv[12] || tag[16] || ct).
 *
 * This is the repo's first symmetric at-rest utility: RSA (utils/rsa.ts) handles
 * only transit, argon2id (utils/password.ts) is one-way. Encrypting at rest
 * raises the bar to "need both the DB AND verifierSecret" — it does NOT make the
 * stored value safe to expose, and a fully compromised host still leaks it.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from './env'

const KEY = (): Buffer => createHash('sha256').update(env.verifierSecret).digest()

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decrypt(packed: string): string {
  const buf = Buffer.from(packed, 'base64')
  if (buf.length < 29) throw new Error('ciphertext too short')
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', KEY(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

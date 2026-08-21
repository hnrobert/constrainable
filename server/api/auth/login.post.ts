/**
 * Login: the client posts an RSA-encrypted password (base64). We decrypt it,
 * verify against the stored hash (new salt:hex format or legacy Bun.password
 * PHC), issue a JWT session cookie, and return the user. A legacy hash that
 * verifies is transparently re-hashed to the new salt:hex format and persisted.
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'
import { hashPassword, isLegacyHash, verifyPassword } from '../../utils/password'
import { mintAuthmod } from '../../utils/authmod'
import { rsaDecrypt } from '../../utils/rsa'
import { createSessionCookie } from '../../utils/session'
import { audit } from '../../services/audit'
import { normalizeEmail } from '../../utils/registration'
import { getConfig } from '../../utils/config-store'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = normalizeEmail(String(body?.email ?? ''))
  const cipher = String(body?.password ?? '')
  if (!email || !cipher) {
    throw createError({ statusCode: 400, statusMessage: 'Email and password are required' })
  }

  let plain: string
  try {
    plain = rsaDecrypt(cipher)
  } catch {
    // Malformed/missing ciphertext — don't reveal which check failed.
    throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
  }

  const user = UsersRepository.findByEmail(email)
  const ok = user ? await verifyPassword(plain, user.passwordHash) : false
  if (!user || !ok) {
    audit('warn', 'auth', `failed login: ${email}`, { actor: email })
    throw createError({ statusCode: 401, statusMessage: 'Invalid email or password' })
  }

  // Upgrade a legacy Bun.password hash to the new salt:hex format, in place.
  if (isLegacyHash(user.passwordHash)) {
    UsersRepository.updatePassword(user.id, hashPassword(plain))
  }

  // Lazily mint the RTMP authmod verifier for accounts created before this
  // column existed. Plaintext `plain` is in scope here; there is no password-
  // change endpoint, so this runs at most once per user.
  if (!user.authmodVerifier) {
    const authmod = mintAuthmod(user.email, plain)
    UsersRepository.setAuthmod(user.id, authmod.salt, authmod.verifierCipher)
  }

  const cookie = await createSessionCookie(user.id, user.role)
  setCookie(event, cookie.name, cookie.value, cookie.options)
  audit('info', 'auth', `login: ${email}`, { actor: email, detail: { userId: user.id } })
  // The admin login-notice rides along when configured: the client stashes it
  // for the one-shot popup that fires on landing (cookie-restored sessions
  // never get this field, so the popup stays login-only).
  const loginNotice = getConfig().dashboard.loginNotice
  return { id: user.id, email: user.email, role: user.role, ...(loginNotice ? { loginNotice } : {}) }
})

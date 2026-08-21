/**
 * Change the caller's OWN password. Both passwords arrive RSA-encrypted
 * (same envelope as login — see usePasswordCipher); the CURRENT password is
 * verified before anything is written. On success the RTMP authmod verifier
 * is re-minted from the new plaintext (OBS sign-in uses the new password
 * immediately; the old challenge-response no longer verifies). Existing
 * sessions stay valid — the sid JWT carries no password material.
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'
import { verifyPassword, hashPassword } from '../../utils/password'
import { mintAuthmod } from '../../utils/authmod'
import { rsaDecrypt } from '../../utils/rsa'

const MIN_PASSWORD = 6

export default defineEventHandler(async (event) => {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  const user = UsersRepository.findById(auth.userId)
  if (!user) throw createError({ statusCode: 404, statusMessage: 'account not found' })

  const body = await readBody(event)
  let currentPlain: string
  let nextPlain: string
  try {
    currentPlain = rsaDecrypt(String(body?.currentPassword ?? ''))
    nextPlain = rsaDecrypt(String(body?.newPassword ?? ''))
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'invalid password payload' })
  }

  if (!(await verifyPassword(currentPlain, user.passwordHash))) {
    throw createError({ statusCode: 403, statusMessage: 'current password is incorrect' })
  }
  if (nextPlain.length < MIN_PASSWORD) {
    throw createError({
      statusCode: 400,
      statusMessage: `new password must be at least ${MIN_PASSWORD} characters`,
    })
  }
  if (nextPlain === currentPlain) {
    throw createError({ statusCode: 400, statusMessage: 'new password must differ from the current one' })
  }

  const authmod = mintAuthmod(user.email, nextPlain)
  UsersRepository.updatePassword(user.id, hashPassword(nextPlain))
  UsersRepository.setAuthmod(user.id, authmod.salt, authmod.verifierCipher)
  return { ok: true }
})

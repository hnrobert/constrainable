/**
 * Step 2 of two-step email registration. Auto-allowlisted (lives under /api/auth/).
 *
 * The password arrives RSA-encrypted (base64); we decrypt before validating
 * length on the plaintext. The FIRST user to register (empty users table)
 * becomes the super admin and is EXEMPT from the code + whitelist (mail may not
 * be configured yet) — mirroring unnc-freshmen-verifier-gateway's bootstrap.
 * Every later registrant is a regular 'user'. An optional `invite` code, if
 * valid, auto-joins the new account to the invite's group. On success a JWT
 * session cookie is set so the caller is logged in immediately.
 */
import { createError } from 'h3'
import { UsersRepository } from '../../repositories/users.repository'
import { hashPassword } from '../../utils/password'
import { mintAuthmod } from '../../utils/authmod'
import { rsaDecrypt } from '../../utils/rsa'
import { createSessionCookie } from '../../utils/session'
import { audit } from '../../services/audit'
import { consumeInvite } from '../../services/invites'
import {
  EMAIL_RE,
  describeEmailRules,
  isDisallowedEmail,
  normalizeEmail,
  passesWhitelist,
} from '../../utils/registration'
import { consumeCode } from '../../utils/email-code'

const MIN_PASSWORD = 6

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = normalizeEmail(String(body?.email ?? ''))
  const cipher = String(body?.password ?? '')
  const code = String(body?.code ?? '')
  const session = String(body?.session ?? '')
  const invite = String(body?.invite ?? '').trim()

  if (!EMAIL_RE.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid email format' })
  }

  // Decrypt the password (client encrypts with the server's RSA public key)
  // before applying the plaintext length rule.
  let password: string
  try {
    password = rsaDecrypt(cipher)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid password payload' })
  }
  if (password.length < MIN_PASSWORD) {
    throw createError({ statusCode: 400, statusMessage: `Password must be at least ${MIN_PASSWORD} characters` })
  }
  if (isDisallowedEmail(email)) {
    const rules = describeEmailRules()
    throw createError({ statusCode: 403, statusMessage: `This email address is not allowed to register${rules ? ` (${rules})` : ''}` })
  }
  if (UsersRepository.findByEmail(email)) {
    throw createError({ statusCode: 409, statusMessage: 'This email is already registered' })
  }

  const isFirst = UsersRepository.isEmpty()

  // Non-bootstrap registrations must pass the whitelist and a valid code.
  if (!isFirst) {
    if (!passesWhitelist(email)) {
      const rules = describeEmailRules()
      throw createError({ statusCode: 403, statusMessage: `This email domain is not allowed to register${rules ? ` (${rules})` : ''}` })
    }
    if (!session || !consumeCode(email, session, code)) {
      throw createError({ statusCode: 400, statusMessage: 'Verification code is invalid or expired' })
    }
  }

  const role = isFirst ? 'admin' : 'user'
  const passwordHash = hashPassword(password)
  // RTMP authmod verifier: base64(md5(email+salt+password)), AES-encrypted at
  // rest. Minted now (plaintext `password` is in scope) so OBS "Use
  // authentication" can later prove account ownership without the password ever
  // traveling. See server/utils/authmod.ts.
  const authmod = mintAuthmod(email, password)
  const user = UsersRepository.insert({ email, passwordHash, role, authmodSalt: authmod.salt, authmodVerifier: authmod.verifierCipher })

  // Best-effort invite consumption: join the invite's group if the code is valid.
  // An invalid/expired invite must NOT block registration — just skip it.
  let joinedGroup: string | null = null
  if (invite) {
    try {
      const g = consumeInvite(invite, user.id)
      if (g) joinedGroup = g.name
    } catch (err) {
      audit('warn', 'auth', `invite consume failed at register: ${email}`, {
        actor: email,
        detail: { invite, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  const cookie = await createSessionCookie(user.id, user.role)
  setCookie(event, cookie.name, cookie.value, cookie.options)
  audit('info', 'auth', `register: ${email} (${role})`, {
    actor: email,
    detail: { userId: user.id, role, first: isFirst, verified: !isFirst, joinedGroup },
  })
  return { id: user.id, email: user.email, role: user.role }
})

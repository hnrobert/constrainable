/**
 * Stateless JWT sessions. The cookie carries a signed JWT (HS256, `jose`) with
 * { uid, role, exp }. Stateless: no sessions table; logout is just clearing
 * the cookie.
 *
 * Cookie flags: HttpOnly always. Same-origin deployments (default) use
 * SameSite=Lax without Secure (documented threat model: trusted internal
 * network over plain HTTP). Split deployments (frontend served from another
 * origin, CORS_ORIGINS set) must send the cookie on cross-site API calls —
 * that requires SameSite=None, which browsers only honor together with
 * Secure, i.e. the API must be reached over HTTPS (the CDN scenario is).
 */
import { SignJWT, jwtVerify } from 'jose'
import { env } from './env'

export type Role = 'admin' | 'user'

export interface SessionPayload {
  uid: number
  role: Role
  exp: number // unix seconds
}

const COOKIE_NAME = 'sid'
const MAX_AGE_SEC = 7 * 24 * 60 * 60 // 7 days

/** cross-origin split deployment (CORS_ORIGINS set) → SameSite=None; Secure */
const CROSS_ORIGIN = env.corsOrigins.length > 0

const secretKey = (): Uint8Array => new TextEncoder().encode(env.jwtSecret)

export interface CookieSpec {
  name: string
  value: string
  options: {
    httpOnly: true
    sameSite: 'lax' | 'none'
    secure?: boolean
    path: '/'
    maxAge: number
  }
}

export async function createSessionCookie(uid: number, role: Role): Promise<CookieSpec> {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_SEC
  const token = await new SignJWT({ uid, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secretKey())
  return {
    name: COOKIE_NAME,
    value: token,
    options: {
      httpOnly: true,
      sameSite: CROSS_ORIGIN ? 'none' : 'lax',
      secure: CROSS_ORIGIN || undefined,
      path: '/',
      maxAge: MAX_AGE_SEC,
    },
  }
}

export async function readSessionCookie(value: string | undefined): Promise<SessionPayload | null> {
  if (!value) return null
  try {
    const { payload } = await jwtVerify(value, secretKey())
    if (typeof payload.uid !== 'number') return null
    if (payload.role !== 'admin' && payload.role !== 'user') return null
    if (typeof payload.exp !== 'number') return null
    return { uid: payload.uid, role: payload.role, exp: payload.exp }
  } catch {
    // expired, bad signature, or malformed → treat as logged out
    return null
  }
}

export const clearSessionCookie = {
  name: COOKIE_NAME,
  options: {
    httpOnly: true as const,
    sameSite: CROSS_ORIGIN ? ('none' as const) : ('lax' as const),
    secure: CROSS_ORIGIN || undefined,
    path: '/' as const,
    maxAge: 0,
  },
}

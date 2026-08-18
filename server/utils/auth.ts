/**
 * Auth context type + accessors. The 01-auth middleware populates
 * event.context.auth from the JWT session cookie. It only enforces "any logged-
 * in user"; management-only routes call requireAdmin() here for the 403 gate.
 */
import { createError, type H3Event } from 'h3'

export interface AuthContext {
  userId: number
  role: 'admin' | 'user'
}

declare module 'h3' {
  interface H3EventContext {
    auth: AuthContext | null
  }
}

export function getAuth(event: H3Event): AuthContext | null {
  return event.context.auth ?? null
}

/**
 * Per-handler admin gate. Throws 403 for non-admins (including logged-in
 * regular users) and 403 for the unauthenticated (the middleware normally
 * catches the latter first, but this is safe either way).
 */
export function requireAdmin(event: H3Event): AuthContext {
  const auth = event.context.auth
  if (!auth || auth.role !== 'admin') {
    throw createError({ statusCode: 403, statusMessage: 'admin privileges required' })
  }
  return auth
}

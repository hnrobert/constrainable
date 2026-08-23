/**
 * Auth state shared across the app. The server middleware is the real gate;
 * this composable drives UX (header user/logout, client-side redirect on
 * expired sessions).
 *
 * Email is the login identifier. Registration is two-step: send-code emails a
 * 6-digit code keyed by a client-chosen `session` token, then register consumes
 * it. The first registration (bootstrap) needs no code. Passwords are RSA-
 * encrypted on the client before transmission (see usePasswordCipher). An invite
 * code (from `?invite=`) stashed in sessionStorage is auto-attached to register.
 */
export interface SessionUser {
  id: number
  email: string
  role: 'admin' | 'user'
}

export interface BootstrapStatus {
  /** true when no users exist yet → next registrant becomes super admin, no code needed. */
  bootstrap: boolean
  /** admin-authored notice for the registration form ('' = hidden). */
  registerNotice: string
}

/** Auth responses carry the admin login-notice when one is configured; it is
 *  stashed here and consumed by LoginNoticeDialog on the landing page. */
const LOGIN_NOTICE_KEY = 'ci:login-notice'
function stashLoginNotice(u: { loginNotice?: string }): void {
  if (import.meta.client && u.loginNotice) sessionStorage.setItem(LOGIN_NOTICE_KEY, u.loginNotice)
}

const INVITE_KEY = 'ci:invite'

/** Stash an invite code so the next register() auto-joins its group. */
export function setPendingInvite(code: string): void {
  if (import.meta.client && code) sessionStorage.setItem(INVITE_KEY, code)
}
/** Read (and clear) the stashed invite code. Returns '' when none. */
export function takePendingInvite(): string {
  if (!import.meta.client) return ''
  const v = sessionStorage.getItem(INVITE_KEY) ?? ''
  sessionStorage.removeItem(INVITE_KEY)
  return v
}
/** Peek the stashed invite code without clearing (for UI hints). */
export function peekPendingInvite(): string {
  if (!import.meta.client) return ''
  return sessionStorage.getItem(INVITE_KEY) ?? ''
}

export function useAuth() {
  const user = useState<SessionUser | null>('auth:user', () => null)
  const probed = useState<boolean>('auth:probed', () => false)

  const isAuthenticated = computed(() => !!user.value)
  const isAdmin = computed(() => user.value?.role === 'admin')

  async function fetchSession(): Promise<SessionUser | null> {
    // On the server $fetch does NOT forward the incoming browser cookie
    // automatically (only useFetch does) — forward it manually so SSR hydrates
    // the real session. On the client the browser sends cookies itself.
    const { cookie } = useRequestHeaders(['cookie'])
    try {
      const u = await $fetch<SessionUser | null>('/api/auth/session', {
        headers: cookie ? { cookie } : undefined,
      })
      user.value = u
      probed.value = true
      return u
    } catch {
      user.value = null
      probed.value = true
      return null
    }
  }

  async function login(email: string, password: string): Promise<SessionUser> {
    const cipher = await encryptPassword(password)
    const u = await $fetch<SessionUser & { loginNotice?: string }>('/api/auth/login', {
      method: 'POST',
      body: { email, password: cipher },
    })
    stashLoginNotice(u)
    user.value = u
    probed.value = true
    return u
  }

  /** Step 1: email a verification code. `session` is a client flow token. */
  async function sendCode(email: string, session: string): Promise<{ ok: boolean; bootstrap?: boolean }> {
    return await $fetch<{ ok: boolean; bootstrap?: boolean }>('/api/auth/send-code', {
      method: 'POST',
      body: { email, session },
    })
  }

  /**
   * Step 2 (or bootstrap): create the account. In bootstrap mode (first user)
   * `code`/`session` are ignored by the server. The password is RSA-encrypted
   * on the client first. A stashed invite code (set from `?invite=`) is auto-
   * attached so the new account joins the invite's group. On success the caller
   * is logged in immediately.
   */
  async function register(email: string, password: string, code: string, session: string): Promise<SessionUser> {
    const cipher = await encryptPassword(password)
    const invite = takePendingInvite()
    const u = await $fetch<SessionUser & { loginNotice?: string }>('/api/auth/register', {
      method: 'POST',
      body: { email, password: cipher, code, session, ...(invite ? { invite } : {}) },
    })
    stashLoginNotice(u)
    user.value = u
    probed.value = true
    return u
  }

  /** Pre-login state: bootstrap mode (first registrant = super admin) + registration notice. */
  async function fetchBootstrap(): Promise<BootstrapStatus> {
    try {
      // URL widened to `string` to bypass Nuxt's typed-route union (the literal
      // form trips TS's recursion limit once the route registry grows).
      return await $fetch<BootstrapStatus>('/api/auth/bootstrap' as string)
    } catch {
      return { bootstrap: false, registerNotice: '' }
    }
  }

  async function logout(): Promise<void> {
    try {
      await $fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      user.value = null
      await navigateTo('/login')
    }
  }

  return {
    user,
    probed,
    isAuthenticated,
    isAdmin,
    fetchSession,
    login,
    sendCode,
    register,
    fetchBootstrap,
    logout,
  }
}

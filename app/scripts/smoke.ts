/**
 * End-to-end smoke test for the auth/roles/groups/invites restructure (plan §8).
 *
 * Boots the BUILT server (`.output/server/index.mjs`) on a throwaway SQLite DB +
 * port, then exercises the flows over HTTP exactly as a browser would:
 *   - fetches the RSA public key and encrypts passwords client-side (node:crypto,
 *     matching the server's RSA-OAEP/SHA-256 decrypt),
 *   - registers the bootstrap super-admin (RSA password → JWT cookie),
 *   - admin: creates groups, an invite link, and events of each visibility,
 *   - asserts the public/registered/groups visibility + authorization filtering,
 *   - inserts a regular user directly in SQLite + mints a matching JWT (the
 *     2nd-user register path is mail-gated, so we bypass it) to test the invite
 *     claim endpoint + canViewEvent as a non-admin,
 *   - checks the stored password hash is `saltHex:hashHex`,
 *   - checks removed routes (/viewer, /api/viewer) 404.
 *
 * Run: bun run scripts/smoke.ts
 */
import { spawn } from 'node:child_process'
import { constants, createPublicKey, publicEncrypt } from 'node:crypto'
import { rmSync, existsSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { SignJWT, jwtVerify } from 'jose'

const PORT = 3099
const BASE = `http://127.0.0.1:${PORT}`
const DB_PATH = '/tmp/ci-smoke.db'
const JWT_SECRET = 'smoke-secret-4f2a'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? '  — ' + extra : ''}`)
  }
}

// --- HTTP helpers ---------------------------------------------------------
type Res = { status: number; body: any; headers: Headers }
async function req(
  path: string,
  opts: { method?: string; body?: any; cookie?: string; redirect?: 'manual' | 'follow' } = {},
): Promise<Res> {
  const r = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body != null ? { 'content-type': 'application/json' } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
    },
    body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    redirect: opts.redirect ?? 'manual',
  })
  const text = await r.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* keep text */
  }
  return { status: r.status, body, headers: r.headers }
}
function cookieJar(headers: Headers): string {
  const sc = headers.get('set-cookie')
  if (!sc) return ''
  return sc.split(';')[0]! // "sid=..."
}

// --- Client-side RSA password encryption (mirrors usePasswordCipher) ------
async function encryptPassword(jwk: JsonWebKey, plain: string): Promise<string> {
  const pub = createPublicKey({ key: jwk, format: 'jwk' })
  const enc = publicEncrypt(
    { key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(plain, 'utf8'),
  )
  return enc.toString('base64')
}

// --- Mint a JWT matching the server's session cookie (HS256, same secret) -
async function mintSid(uid: number, role: 'admin' | 'user'): Promise<string> {
  return new SignJWT({ uid, role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(JWT_SECRET))
}

// --- Boot the server ------------------------------------------------------
rmSync(DB_PATH, { force: true })
rmSync(`${DB_PATH}-wal`, { force: true })
rmSync(`${DB_PATH}-shm`, { force: true })

console.log('Booting built server on port', PORT)
const server = spawn('bun', ['.output/server/index.mjs'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    NODE_ENV: 'production',
    DB_PATH,
    JWT_SECRET,
    NITRO_PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
server.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`))

async function waitForReady(timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await req('/api/auth/pubkey')
      if (r.status === 200) return true
    } catch {
      /* not up yet */
    }
    await Bun.sleep(400)
  }
  return false
}

async function main(): Promise<void> {
  if (!(await waitForReady())) {
    console.error('SERVER FAILED TO START')
    failed++
    return
  }
  console.log('\n== Smoke checks ==')

  // 1. Public key endpoint is allowlisted (no auth).
  const pk = await req('/api/auth/pubkey')
  check('GET /api/auth/pubkey is public (200, has jwk.n)', pk.status === 200 && !!pk.body?.jwk?.n)

  const jwk = pk.body.jwk as JsonWebKey

  // 2. Unauthed catalog is gated.
  const unauthEvents = await req('/api/events')
  check('Unauthed GET /api/events → 401', unauthEvents.status === 401, `got ${unauthEvents.status}`)

  const unauthDash = await req('/dashboard')
  check('Unauthed GET /dashboard → 302 to /login', unauthDash.status === 302 && (unauthDash.headers.get('location') || '').includes('/login'), `got ${unauthDash.status} → ${unauthDash.headers.get('location')}`)

  // 3. Bootstrap super-admin registration (RSA-encrypted password, no code).
  const adminPw = await encryptPassword(jwk, 'admin-pass-123')
  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: { email: 'admin@example.com', password: adminPw },
  })
  check('Bootstrap register → 200 role=admin', reg.status === 200 && reg.body?.role === 'admin', `got ${reg.status} ${JSON.stringify(reg.body)}`)
  const adminCookie = cookieJar(reg.headers)
  check('Register sets a sid cookie', !!adminCookie)

  // 4. Session reflects the admin.
  const sess = await req('/api/auth/session', { cookie: adminCookie })
  check('GET /api/auth/session → admin', sess.status === 200 && sess.body?.role === 'admin', `got ${sess.status}`)

  // 5. JWT actually verifies under the shared secret (stateless).
  const sid = adminCookie.split('=')[1] ?? ''
  const verified = await jwtVerify(sid, new TextEncoder().encode(JWT_SECRET))
  check('sid cookie is a verifiable HS256 JWT with uid+role', verified.payload.role === 'admin' && typeof verified.payload.uid === 'number')

  // 6. Admin: create groups A + B.
  const gA = await req('/api/groups', { method: 'POST', body: { name: 'Cohort A' }, cookie: adminCookie })
  check('Admin create group A → 200', gA.status === 200 && !!gA.body?.id, `got ${gA.status}`)
  const gB = await req('/api/groups', { method: 'POST', body: { name: 'Cohort B' }, cookie: adminCookie })
  check('Admin create group B → 200', gB.status === 200 && !!gB.body?.id, `got ${gB.status}`)
  const groupAId = gA.body?.id as number
  const groupBId = gB.body?.id as number

  // 7. Admin: invite link for group A.
  const inv = await req('/api/invite-links', { method: 'POST', body: { groupId: groupAId, note: 'smoke' }, cookie: adminCookie })
  check('Admin create invite link → 200 with code', inv.status === 200 && !!inv.body?.code, `got ${inv.status}`)
  const inviteCode = inv.body?.code as string

  // 8. Admin: events of every visibility.
  const eGroup = await req('/api/events', { method: 'POST', body: { name: 'Group Event', visibility: 'groups', groupIds: [groupAId] }, cookie: adminCookie })
  check('Create groups-scoped event → 200', eGroup.status === 200 && eGroup.body?.visibility === 'groups', `got ${eGroup.status}`)
  const ePub = await req('/api/events', { method: 'POST', body: { name: 'Public Event', visibility: 'public' }, cookie: adminCookie })
  check('Create public event → 200', ePub.status === 200 && ePub.body?.visibility === 'public', `got ${ePub.status}`)
  const eReg = await req('/api/events', { method: 'POST', body: { name: 'Registered Event', visibility: 'registered' }, cookie: adminCookie })
  check('Create registered event → 200', eReg.status === 200 && eReg.body?.visibility === 'registered', `got ${eReg.status}`)
  const eGroupB = await req('/api/events', { method: 'POST', body: { name: 'Group B Event', visibility: 'groups', groupIds: [groupBId] }, cookie: adminCookie })
  check('Create group-B event → 200', eGroupB.status === 200, `got ${eGroupB.status}`)

  // 9. Public catalog: only the public event.
  const pubList = await req('/api/events/public')
  const pubNames = (pubList.body as any[]).map((e) => e.name)
  check('Public catalog includes Public Event', pubNames.includes('Public Event'), `got ${pubNames.join(', ')}`)
  check('Public catalog EXCLUDES groups/registered events', !pubNames.includes('Group Event') && !pubNames.includes('Registered Event') && !pubNames.includes('Group B Event'))

  // 10. Admin sees all events.
  const adminList = await req('/api/events', { cookie: adminCookie })
  const adminNames = (adminList.body as any[]).map((e) => e.name)
  check('Admin sees all 4 events', adminNames.includes('Group Event') && adminNames.includes('Public Event') && adminNames.includes('Registered Event') && adminNames.includes('Group B Event'), `got ${adminNames.join(', ')}`)

  // 11. Homepage (public) renders the public event.
  const home = await req('/')
  check('Homepage renders (200) and lists Public Event', home.status === 200 && String(home.body).includes('Public Event'))

  // 12. Removed routes 404 even when authenticated (the middleware gate would
  //     otherwise intercept an unauthed hit with 302/401 before Nuxt's 404).
  const viewerPage = await req('/viewer', { cookie: adminCookie })
  check('GET /viewer → 404 (removed)', viewerPage.status === 404, `got ${viewerPage.status}`)
  const viewerApi = await req('/api/viewer/events', { cookie: adminCookie })
  check('GET /api/viewer/events → 404 (removed)', viewerApi.status === 404, `got ${viewerApi.status}`)

  // 13. Password hash stored as saltHex:hashHex (argon2id), NOT plaintext/PHC.
  const db = new Database(DB_PATH, { readonly: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  const row = db.query('SELECT password_hash AS h FROM users WHERE email = ?').get('admin@example.com') as { h: string } | null
  const hash = row?.h ?? ''
  check('Stored password is saltHex:hashHex (two hex halves)', /^[0-9a-f]{32}:[0-9a-f]+$/.test(hash), `got ${hash.slice(0, 20)}…`)
  check('Stored password is NOT the plaintext', hash !== 'admin-pass-123')

  // 14. Create a regular 'user' directly in SQLite (register path is mail-gated)
  //     + mint a matching JWT so we can act as a non-admin.
  const rw = new Database(DB_PATH)
  rw.exec('PRAGMA busy_timeout = 5000;')
  const now = Date.now()
  rw.run('INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, ?, ?)', [
    'viewer@example.com',
    'nobody:cares',
    'user',
    now,
  ])
  const u2 = rw.query('SELECT id FROM users WHERE email = ?').get('viewer@example.com') as { id: number } | null
  const userId = u2?.id ?? 0
  check('Seeded a regular user row', userId > 0)
  const userCookie = `sid=${await mintSid(userId, 'user')}`
  rw.close()
  db.close()

  // 15. Before joining, the user sees public + registered but NOT either group event.
  const preList = await req('/api/events', { cookie: userCookie })
  const preNames = (preList.body as any[]).map((e) => e.name)
  check('Pre-join user sees Public + Registered events', preNames.includes('Public Event') && preNames.includes('Registered Event'), `got ${preNames.join(', ')}`)
  check('Pre-join user does NOT see group events', !preNames.includes('Group Event') && !preNames.includes('Group B Event'), `got ${preNames.join(', ')}`)

  // 16. Claim the group-A invite as the existing user.
  const claim = await req(`/api/invite-links/${encodeURIComponent(inviteCode)}/claim`, { method: 'POST', cookie: userCookie })
  check('Claim invite → 200 joined Cohort A', claim.status === 200 && claim.body?.groupName === 'Cohort A', `got ${claim.status} ${JSON.stringify(claim.body)}`)

  // 17. Now the user sees group-A's event too, but still NOT group-B's.
  const postList = await req('/api/events', { cookie: userCookie })
  const postNames = (postList.body as any[]).map((e) => e.name)
  check('Post-join user now sees Group Event', postNames.includes('Group Event'), `got ${postNames.join(', ')}`)
  check('Post-join user still does NOT see Group B Event', !postNames.includes('Group B Event'), `got ${postNames.join(', ')}`)

  // 18. Idempotent re-claim is a success (no double-count, no error).
  const claim2 = await req(`/api/invite-links/${encodeURIComponent(inviteCode)}/claim`, { method: 'POST', cookie: userCookie })
  check('Re-claim (idempotent) → 200', claim2.status === 200, `got ${claim2.status}`)

  // 19. Regular user cannot reach admin endpoints (requireAdmin → 403).
  const forbidden = await req('/api/groups', { cookie: userCookie })
  check('Non-admin GET /api/groups → 403', forbidden.status === 403, `got ${forbidden.status}`)
  const forbiddenCreate = await req('/api/events', { method: 'POST', body: { name: 'x' }, cookie: userCookie })
  check('Non-admin POST /api/events → 403', forbiddenCreate.status === 403, `got ${forbiddenCreate.status}`)

  // 20. Login works with the RSA-encrypted password (round-trip).
  const loginPw = await encryptPassword(jwk, 'admin-pass-123')
  const login = await req('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: loginPw } })
  check('Login with RSA-encrypted password → 200 admin', login.status === 200 && login.body?.role === 'admin', `got ${login.status} ${JSON.stringify(login.body)}`)
  check('Login sets a fresh sid cookie', !!cookieJar(login.headers))

  // 21. Wrong password fails (anti-enumeration: generic 401).
  const badPw = await encryptPassword(jwk, 'wrong-password-999')
  const badLogin = await req('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: badPw } })
  check('Login with wrong password → 401', badLogin.status === 401, `got ${badLogin.status}`)
}

main()
  .then(() => {
    console.log(`\n== ${passed} passed, ${failed} failed ==`)
    server.kill('SIGTERM')
    setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500)
  })
  .catch((err) => {
    console.error('SMOKE TEST CRASHED:', err)
    server.kill('SIGTERM')
    setTimeout(() => process.exit(2), 500)
  })

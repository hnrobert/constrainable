#!/usr/bin/env bun
/**
 * scripts/stress-streams.ts — concurrent RTMP ingest stress test for the
 * constrainable-ingest compose stack.
 *
 * It pushes N concurrent ffmpeg streams (a looped clip with `-c copy`, so the
 * pushers use ~zero CPU and one machine can emulate dozens of OBS clients) at
 * the running stack and samples, while the streams are live:
 *   - how many streams are actually live on SRS (vs requested),
 *   - how many the app has registered as a publish session and marked compliant,
 *   - the app container's CPU% and memory (via `docker stats`),
 *   - how many recorders the app has spawned (capped by record.maxConcurrency).
 *
 * Two authorization modes:
 *   - auth  — find/create an event, mint its per-event publish token, and push
 *             every stream as `<stream>?token=<token>` (the real OBS path; any
 *             stream name is accepted under one event token).
 *   - open  — temporarily set access.rejectUnknownPublishers=false and push with
 *             no token (isolates raw ingest/recording capacity). Restored on exit.
 *
 * Usage:
 *   bun run scripts/stress-streams.ts --count 20                 # single run, auth mode
 *   bun run scripts/stress-streams.ts --ramp 5,10,20,40,60 --mode open
 *   bun run scripts/stress-streams.ts --count 30 --mode auth --hold 30
 *
 * Defaults target the local compose stack (app :31954, SRS RTMP :1935, SRS API
 * :1985, admin uid 1, dev session secret). Flags let you retarget another env.
 */
import { SignJWT } from 'jose'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
type Args = {
  count: number
  ramp: number[]
  mode: 'auth' | 'open'
  hold: number
  clip: string
  rtmp: string
  app: string
  srs: string
  secret: string
  uid: number
  eventName: string
}
function parseArgs(): Args {
  const a: Args = {
    count: 10,
    ramp: [],
    mode: 'auth',
    hold: 15,
    clip: '/tmp/test-stream.mp4',
    rtmp: 'rtmp://127.0.0.1:1935/live',
    app: 'http://127.0.0.1:31954',
    srs: 'http://127.0.0.1:1985',
    secret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
    uid: Number(process.env.STRESS_ADMIN_UID || 1),
    eventName: 'Stress Load Test',
  }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[++i]
    switch (k) {
      case '--count': a.count = Number(v); break
      case '--ramp': a.ramp = String(v).split(',').map((s) => Number(s.trim())); break
      case '--mode': a.mode = v === 'open' ? 'open' : 'auth'; break
      case '--hold': a.hold = Number(v); break
      case '--clip': a.clip = v; break
      case '--rtmp': a.rtmp = v; break
      case '--app': a.app = v.replace(/\/$/, ''); break
      case '--srs': a.srs = v.replace(/\/$/, ''); break
      case '--secret': a.secret = v; break
      case '--uid': a.uid = Number(v); break
      case '--event': a.eventName = v; break
      case '--help': case '-h':
        console.log(`Usage: bun run scripts/stress-streams.ts [--count N | --ramp 5,10,20]
  --mode auth|open   auth = per-event publish token (default); open = rejectUnknownPublishers=false
  --hold SEC         seconds to hold streams while sampling (default 15)
  --clip PATH        source clip (default /tmp/test-stream.mp4)
  --app URL          app base (default http://127.0.0.1:31954)
  --srs URL          SRS HTTP API base (default http://127.0.0.1:1985)
  --rtmp URL         RTMP target without stream key (default rtmp://127.0.0.1:1935/live)
  --secret STR       session signing secret (default $SESSION_SECRET or dev secret)
  --uid N            admin user id to mint a sid for (default 1)`)
        process.exit(0)
    }
  }
  if (!a.ramp.length) a.ramp = [a.count]
  return a
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function mintSid(secret: string, uid: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + 3600
  return new SignJWT({ uid, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret))
}

async function appJson(app: string, sid: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${app}${path}`, {
    ...init,
    headers: { cookie: `sid=${sid}`, 'content-type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function srsStreams(srs: string): Promise<any[]> {
  // CRITICAL: the SRS HTTP API defaults to a page size of 10. Without ?count=
  // it silently hides every stream past the 10th, which presents as a phantom
  // concurrency cap (streams/clients both "stuck at 10"). Always pass a large,
  // explicit count. Wrapped because AbortSignal.timeout() throws on timeout and
  // an uncaught throw here killed the whole run under load.
  try {
    const res = await fetch(`${srs}/api/v1/streams/?count=1000`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) return []
    const j = await res.json()
    return j.streams ?? []
  } catch {
    return []
  }
}

/** Peak-ish snapshot of the app container's CPU% and RSS via `docker stats`. */
async function containerStats(container = 'ingest-app'): Promise<{ cpu: number; memMiB: number } | null> {
  // Explicit args array: Bun's `$` template mangles the {{.CPUPerc}} braces.
  try {
    const proc = Bun.spawn(['docker', 'stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', container], { stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    // "12.34% 123.4MiB / 8GiB"
    const m = out.trim().match(/([\d.]+)%\s+([\d.]+)(Ki|Mi|Gi)?B\s*\//i)
    if (!m) return null
    let mem = Number(m[2])
    const unit = (m[3] || 'Mi').toLowerCase()
    if (unit === 'gi') mem *= 1024
    else if (unit === 'ki') mem /= 1024
    return { cpu: Number(m[1]), memMiB: mem }
  } catch {
    return null
  }
}

async function ensureClip(path: string): Promise<void> {
  if (await Bun.file(path).exists()) {
    console.log(`[clip] using existing ${path}`)
    return
  }
  console.log(`[clip] generating ${path} (640x360/25fps/30s, H264+AAC)…`)
  const proc = Bun.spawn(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a', 'aac', '-shortest', '-movflags', '+faststart', path], { stdout: 'ignore', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`clip generation failed (exit ${code})`)
}

/** find or create an event; rotate its publish token; return the plaintext token. */
async function ensureAuthEvent(args: Args, sid: string): Promise<{ eventId: number; token: string }> {
  const all = await appJson(args.app, sid, '/api/events')
  const found = (all as any[]).find((e) => e.name === args.eventName)
  const eventId = found ? found.id : (await appJson(args.app, sid, '/api/events', {
    method: 'POST', body: JSON.stringify({ name: args.eventName, status: 'active', visibility: 'public', recordEnabled: true }),
  })).id
  const tok = await appJson(args.app, sid, `/api/events/${eventId}/publish-token`, {
    method: 'POST', body: '{}',
  })
  return { eventId, token: tok.token }
}

// ---------------------------------------------------------------------------
// A single ramp stage
// ---------------------------------------------------------------------------
type Sub = { proc: import('bun').Subprocess<'ignore', 'ignore', 'ignore'>; stream: string }
type Sample = { t: number; srsLive: number; appSessions: number; compliant: number; recording: number; cpu: number | null; memMiB: number | null }

async function runStage(args: Args, sid: string, n: number, token: string | null): Promise<void> {
  console.log(`\n===== stage: ${n} concurrent stream(s) [${args.mode}] =====`)
  const subs: Sub[] = []
  const myStreams = new Set<string>()
  const urlFor = (i: number) => {
    const name = `stress-${i}-${Math.random().toString(36).slice(2, 6)}`
    const key = token ? `${name}?token=${token}` : name
    return { name, url: `${args.rtmp}/${key}` }
  }

  // launch N pushers
  for (let i = 0; i < n; i++) {
    const { name, url } = urlFor(i)
    try {
      const proc = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', args.clip, '-c', 'copy', '-f', 'flv', url], {
        stdout: 'ignore', stderr: 'ignore',
      })
      subs.push({ proc, stream: name })
      myStreams.add(name)
    } catch (e) {
      console.error(`[launch] pusher ${i} failed: ${e}`)
    }
  }

  const samples: Sample[] = []
  const killAll = async () => { for (const s of subs) { try { s.proc.kill() } catch {} } }

  try {
    // ramp-up: wait until SRS sees all n of OUR streams (or 30s). We match by
    // stream name (SRS carries leftover entries from prior runs/recordings, so
    // a raw entry count is meaningless).
    const rampStart = Date.now()
    while (Date.now() - rampStart < 30_000) {
      const names = new Set((await srsStreams(args.srs)).map((s: any) => String(s.name)))
      const have = [...myStreams].filter((n) => names.has(n)).length
      if (have >= n) { console.log(`[ramp] all ${n} live on SRS in ${((Date.now() - rampStart) / 1000).toFixed(1)}s`); break }
      await Bun.sleep(1000)
    }

    // hold + sample. "live" = OUR streams whose recv_bytes grew since the last
    // sample. SRS's publish.active flag flaps false even for streams that are
    // actively publishing (it reads false mid-publish and right after connect),
    // so recv_bytes growth is the only reliable "is it actually publishing"
    // signal. We scope the check to this stage's own stream names so leftover
    // entries and recorder pulls don't inflate the count.
    const holdUntil = Date.now() + args.hold * 1000
    let prevRecv = new Map<string, number>()
    while (Date.now() < holdUntil) {
      const [streams, sessions, st] = await Promise.all([srsStreams(args.srs), appJson(args.app, sid, '/api/streams').catch(() => []), containerStats()])
      const curRecv = new Map<string, number>(streams.filter((s: any) => myStreams.has(String(s.name))).map((s: any) => [String(s.name), s.recv_bytes || 0]))
      let live = 0
      for (const [name, rb] of curRecv) { const prev = prevRecv.get(name); if (prev === undefined ? rb > 0 : rb > prev) live++ }
      prevRecv = curRecv
      const sessArr = sessions as any[]
      const compliant = sessArr.filter((s) => s.compliant).length
      const recording = sessArr.filter((s) => s.status === 'recording' || s.status === 'compliant').length
      samples.push({ t: Date.now(), srsLive: live, appSessions: sessArr.length, compliant, recording, cpu: st?.cpu ?? null, memMiB: st?.memMiB ?? null })
      process.stdout.write(`  live=${live}/${n} streams=${streams.length} sessions=${sessArr.length} compliant=${compliant} cpu=${st?.cpu?.toFixed(0) ?? '?'}% mem=${st?.memMiB?.toFixed(0) ?? '?'}MiB\r`)
      await Bun.sleep(3000)
    }
    console.log(' '.repeat(80))

    // summary
    const peak = (f: (s: Sample) => number) => Math.max(...samples.map(f))
    const last = samples[samples.length - 1]
    console.log(`  requested=${n} peakSrsLive=${peak((s) => s.srsLive)} peakSessions=${peak((s) => s.appSessions)} peakCompliant=${peak((s) => s.compliant)} peakCpu=${peak((s) => s.cpu ?? 0).toFixed(0)}% peakMem=${peak((s) => s.memMiB ?? 0).toFixed(0)}MiB`)
    if (last) console.log(`  final: live=${last.srsLive} sessions=${last.appSessions} compliant=${last.compliant}`)
  } finally {
    await killAll()
    console.log(`[teardown] stopped ${subs.length} pushers; waiting for recordings to finalize…`)
    await Bun.sleep(8000) // let on_unpublish + FLV->MP4 remux settle
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs()
  console.log(`stress-streams: mode=${args.mode} ramp=${args.ramp.join(',')} hold=${args.hold}s app=${args.app} srs=${args.srs} rtmp=${args.rtmp}`)
  await ensureClip(args.clip)
  const sid = await mintSid(args.secret, args.uid)

  // setup auth/open
  let eventId: number | null = null
  let token: string | null = null
  let prevReject: boolean | null = null
  if (args.mode === 'auth') {
    const r = await ensureAuthEvent(args, sid)
    eventId = r.eventId; token = r.token
    console.log(`[auth] event ${eventId} publish-token=${token.slice(0, 8)}…`)
  } else {
    const cfg = await appJson(args.app, sid, '/api/config')
    prevReject = cfg.access?.rejectUnknownPublishers
    await appJson(args.app, sid, '/api/config', { method: 'PATCH', body: JSON.stringify({ access: { rejectUnknownPublishers: false } }) })
    console.log(`[open] set rejectUnknownPublishers=false (was ${prevReject}); will restore on exit`)
  }

  try {
    for (const n of args.ramp) {
      await runStage(args, sid, n, token)
    }
  } finally {
    if (prevReject !== null) {
      try {
        await appJson(args.app, sid, '/api/config', { method: 'PATCH', body: JSON.stringify({ access: { rejectUnknownPublishers: prevReject } }) })
        console.log(`[open] restored rejectUnknownPublishers=${prevReject}`)
      } catch (e) { console.error(`[open] FAILED to restore config: ${e}`) }
    }
  }
  console.log('\nstress-streams: done.')
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })

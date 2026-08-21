#!/usr/bin/env bun
/**
 * scripts/stress-http.ts — HTTP-tier virtual-user load test for a running
 * constrainable-app instance (local or production).
 *
 * Simulates N concurrent USERS (not raw RPS): each virtual user browses the
 * public surface in a realistic loop — landing page, login form + pubkey +
 * bootstrap, event catalog, health — with a few seconds of "reading" between
 * actions. That matches the real pattern: contestants sit on pages while the
 * dashboard polls occasionally. No credentials are used; authenticated-surface
 * stress is a separate exercise (stress-streams.ts for ingest).
 *
 * Reports per-stage: request count, RPS, p50/p95/p99 latency, error rate,
 * slowest endpoints. Safe by design: only GETs on public, allowlisted routes.
 *
 * Usage:
 *   bun run scripts/stress-http.ts --base https://ingest.hnrobert.space --ramp 10,30,60
 *   bun run scripts/stress-http.ts --count 60 --hold 60
 */
import process from 'node:process'

type Endpoint = { path: string; weight: number }

const ENDPOINTS: Endpoint[] = [
  { path: '/', weight: 3 },
  { path: '/login', weight: 2 },
  { path: '/api/health', weight: 2 },
  { path: '/api/events/public', weight: 3 },
  { path: '/api/auth/pubkey', weight: 1 },
  { path: '/api/auth/bootstrap', weight: 1 },
]

type Args = { base: string; ramp: number[]; hold: number; think: [number, number] }
function parseArgs(): Args {
  const a: Args = { base: 'https://ingest.hnrobert.space', ramp: [60], hold: 60, think: [1500, 5000] }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]; const v = argv[++i]
    if (k === '--base') a.base = v.replace(/\/$/, '')
    else if (k === '--count') a.ramp = [Number(v)]
    else if (k === '--ramp') a.ramp = String(v).split(',').map((s) => Number(s.trim()))
    else if (k === '--hold') a.hold = Number(v)
    else if (k === '--think') a.think = String(v).split(',').map(Number) as [number, number]
    else if (k === '--help' || k === '-h') {
      console.log('Usage: bun run scripts/stress-http.ts [--base URL] [--ramp 10,30,60] [--hold SEC] [--think MIN,MAX ms]')
      process.exit(0)
    }
  }
  return a
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo)
const pick = () => {
  const total = ENDPOINTS.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const e of ENDPOINTS) { r -= e.weight; if (r <= 0) return e }
  return ENDPOINTS[0]!
}

type LatSample = { path: string; ms: number; ok: boolean; status: number }
const records: LatSample[] = []

async function oneGet(base: string, path: string): Promise<LatSample> {
  const t0 = performance.now()
  try {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' })
    await res.arrayBuffer() // drain so timing includes the full body
    return { path, ms: performance.now() - t0, ok: res.status < 400, status: res.status }
  } catch (e: any) {
    return { path, ms: performance.now() - t0, ok: false, status: e?.name === 'AbortError' ? 'timeout' : 0 }
  }
}

let think: [number, number] = [1500, 5000]
async function virtualUser(base: string, stopAt: number): Promise<void> {
  while (Date.now() < stopAt) {
    const rec = await oneGet(base, pick().path)
    records.push(rec)
    await sleep(rand(think[0], think[1]))
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return Math.round(sorted[i]!)
}

async function runStage(base: string, n: number, holdSec: number): Promise<void> {
  console.log(`\n===== stage: ${n} concurrent users × ${holdSec}s =====`)
  const recsBefore = records.length
  const t0 = Date.now()
  const stopAt = t0 + holdSec * 1000
  const vus = Array.from({ length: n }, () => virtualUser(base, stopAt))
  // progress line every 5s until the stage ends
  const prog = setInterval(() => {
    const mine = records.slice(recsBefore)
    const errs = mine.filter((r) => !r.ok).length
    process.stdout.write(`  ${((Date.now() - t0) / 1000).toFixed(0)}s reqs=${mine.length} errs=${errs}\r`)
  }, 5000)
  await Promise.all(vus)
  clearInterval(prog)
  console.log(' '.repeat(60))

  const mine = records.slice(recsBefore)
  const dur = (Date.now() - t0) / 1000
  const lat = mine.map((r) => r.ms).sort((a, b) => a - b)
  const errs = mine.filter((r) => !r.ok)
  console.log(`  reqs=${mine.length} rps=${(mine.length / dur).toFixed(1)} ` +
    `p50=${percentile(lat, 50)}ms p95=${percentile(lat, 95)}ms p99=${percentile(lat, 99)}ms ` +
    `max=${Math.round(lat[lat.length - 1] ?? 0)}ms errors=${errs.length}(${((errs.length / Math.max(1, mine.length)) * 100).toFixed(1)}%)`)
  // per-endpoint breakdown
  const byPath = new Map<string, { n: number; ms: number[]; errs: number }>()
  for (const r of mine) {
    const e = byPath.get(r.path) ?? { n: 0, ms: [], errs: 0 }
    e.n++; e.ms.push(r.ms); if (!r.ok) e.errs++
    byPath.set(r.path, e)
  }
  for (const [path, e] of [...byPath].sort((a, b) => b[1].n - a[1].n)) {
    const s = e.ms.sort((a, b) => a - b)
    console.log(`    ${path.padEnd(24)} n=${String(e.n).padStart(5)} p50=${percentile(s, 50)}ms p95=${percentile(s, 95)}ms errs=${e.errs}`)
  }
  if (errs.length) {
    const byStatus = new Map<string, number>()
    for (const e of errs) byStatus.set(String(e.status), (byStatus.get(String(e.status)) ?? 0) + 1)
    console.log(`    error statuses:`, [...byStatus].map(([k, v]) => `${k}×${v}`).join(' '))
  }
}

async function main() {
  const args = parseArgs()
  think = args.think
  console.log(`stress-http: base=${args.base} ramp=${args.ramp.join(',')} hold=${args.hold}s think=${think.join('-')}ms`)
  // warm DNS/TLS so stage-1 numbers aren't skewed by cold connect
  await oneGet(args.base, '/api/health')
  for (const n of args.ramp) await runStage(args.base, n, args.hold)
  console.log('\nstress-http: done.')
}

main().catch((e) => { console.error('fatal:', e); process.exit(1) })

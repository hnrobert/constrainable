/**
 * Browser-side latency probe for media nodes, shared by the visit-time
 * auto-assignment plugin and the user-facing node-selection page: one no-cors
 * round trip per node (timing only — the body is never read).
 */
const PROBE_TIMEOUT_MS = 5_000

export async function probeNodeLatency(publicOrigin: string): Promise<number | null> {
  if (import.meta.client && location.protocol === 'https:' && publicOrigin.startsWith('http://')) {
    return null // mixed content — the browser would block it
  }
  const started = performance.now()
  try {
    await fetch(`${publicOrigin}/crossdomain.xml`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return Math.round(performance.now() - started)
  } catch {
    return null
  }
}

/** Probe a whole list in parallel: [{nodeId, publicOrigin}] → nodeId→ms. */
export async function probeAll(
  targets: { nodeId: string; publicOrigin: string }[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(
    targets.map(async (t) => {
      const ms = await probeNodeLatency(t.publicOrigin)
      if (ms != null) out[t.nodeId] = ms
    }),
  )
  return out
}

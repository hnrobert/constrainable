<script setup lang="ts">
/**
 * Ingest node picker + browser latency test — the single UI for choosing which
 * node you publish through. Embedded on the dashboard events page (where
 * regular users pick a node for their events) and on the standalone /nodes
 * page. A pinned node is a LOCK: publishing via any other node is refused at
 * publish time; the OBS address on every event guide page follows the choice.
 *
 * "Test latency" runs a REAL browser→node ICE check against each node's STUN
 * responder (node/probe.go, UDP publicProbeUdpPort — new firmware) and reads
 * candidate-pair currentRoundTripTime from getStats(). Nodes without the
 * responder (old firmware) show n/a until updated. Samples are recorded via
 * /api/nodes/measure (feeds the admin latency matrix; users with no node yet
 * get their one-time automatic assignment there).
 */
interface NodeRow {
  nodeId: string
  rtmpUrl: string | null
  assigned: number
  maxUsers: number
  publicOrigin: string
  publicRtmpPort: number
  publicProbeUdpPort: number
  publicSrsUdpPort: number
  isMine: boolean
}

const toast = useToast()
const { data: nodes, refresh, status: nodesStatus } = useFetch<NodeRow[]>('/api/nodes')

/* ------------------------------ latency test ----------------------------- */
// Results live in app-wide state (NOT per-instance refs): leaving and
// re-entering the events page remounts this picker — plain refs would wipe
// the table. useState keeps the last results visible across navigations.
const rtts = useState<Record<string, number | null> | null>('nodes:rtts', () => null)
const outcomes = useState<Record<string, 'ms' | 'timeout' | 'n/a'>>('nodes:outcomes', () => ({}))
const pinging = ref(false)

/** show one node's result the moment its probe resolves (progressive fill-in) */
function reportResult(id: string, ms: number | null, probed: boolean): void {
  rtts.value = { ...(rtts.value ?? {}), [id]: ms }
  outcomes.value = { ...outcomes.value, [id]: ms != null ? 'ms' : probed ? 'timeout' : 'n/a' }
}

/** True browser→node RTT via an ICE check; null = no answer within 4s. */
async function browserProbe(nodeId: string): Promise<number | null> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  try {
    pc.createDataChannel('probe')
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    // responseType:'text' — ofetch hands non-JSON content-types back as a
    // BLOB, and setRemoteDescription(Blob) throws (silently caught → n/a).
    const answer = await $fetch<string>(`/api/nodes/probe-ice/${encodeURIComponent(nodeId)}`, {
      method: 'POST',
      responseType: 'text',
      headers: { 'content-type': 'application/sdp' },
      body: offer.sdp ?? '',
    })
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    const deadline = Date.now() + 4000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      const stats = await pc.getStats()
      let rtt: number | null = null
      stats.forEach((r) => {
        const s = r as unknown as Record<string, unknown>
        if (
          s.type === 'candidate-pair' &&
          (s.state === 'succeeded' || Number(s.responsesReceived ?? 0) > 0) &&
          s.currentRoundTripTime != null
        ) {
          rtt = Math.round(Number(s.currentRoundTripTime) * 1000)
        }
      })
      if (rtt != null) return rtt
    }
    return null
  } catch {
    return null
  } finally {
    pc.close()
  }
}

async function pingNodes(): Promise<void> {
  if (pinging.value) return
  pinging.value = true
  const list = nodes.value ?? []
  // NOTE: no blanket reset — previous results stay visible while the re-test
  // runs; each node's slot flips the moment its fresh probe settles.
  try {
    const latencies: { nodeId: string; latencyMs: number }[] = []
    await Promise.all(
      list.map(async (n) => {
        // no responder (old firmware): n/a immediately, nothing to probe
        if (!(n.publicProbeUdpPort > 0)) {
          reportResult(n.nodeId, null, false)
          return
        }
        const ms = await browserProbe(n.nodeId)
        reportResult(n.nodeId, ms, true)
        if (ms != null) latencies.push({ nodeId: n.nodeId, latencyMs: ms })
      }),
    )
    if (latencies.length) {
      await $fetch('/api/nodes/measure', { method: 'POST', body: { latencies } }).catch(() => null)
    }
  } catch (e: any) {
    toast.error('Latency test failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    pinging.value = false
  }
}

// Auto-test once per mount, but only once the node list has actually loaded
// (useFetch resolves after mount on client-side navigation — testing at mount
// time probed an empty list, which is why returning to the page showed "—").
let autoRan = false
watch(
  () => nodes.value,
  (list) => {
    if (autoRan || !list || list.length === 0 || pinging.value) return
    autoRan = true
    void pingNodes()
  },
  { immediate: true },
)

function rttChip(
  ms: number | null | undefined,
  outcome?: 'ms' | 'timeout' | 'n/a',
): { label: string; cls: string } {
  if (ms != null) {
    if (ms < 50) return { label: `${ms} ms`, cls: 'text-ok font-semibold' }
    if (ms < 150) return { label: `${ms} ms`, cls: 'text-foreground' }
    return { label: `${ms} ms`, cls: 'text-warn font-semibold' }
  }
  if (outcome === 'timeout') return { label: 'timeout', cls: 'text-warn font-semibold' }
  if (outcome === 'n/a') return { label: 'n/a', cls: 'text-muted-foreground' }
  return { label: '—', cls: 'text-muted-foreground' }
}

/* ------------------------------- selection ------------------------------- */
const selecting = ref<string | null>(null)
async function select(n: NodeRow): Promise<void> {
  selecting.value = n.nodeId
  try {
    await $fetch('/api/nodes/select', {
      method: 'POST',
      body: { nodeId: n.nodeId },
    })
    toast.success(`Streaming locked to ${n.nodeId}`)
    await Promise.all([refresh(), refreshAssignment()])
  } catch (e: any) {
    toast.error('Select failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    selecting.value = null
  }
}

const { data: assignment, refresh: refreshAssignment } = useFetch<{ assigned: string | null }>(
  '/api/nodes/assignment',
  { default: () => ({ assigned: null }) },
)
const myNode = computed(() => (nodes.value ?? []).find((n) => n.isMine) ?? null)
/** assigned but its row isn't in the online list → the node is offline
 *  (only judged once the node list has actually loaded — no pending flash) */
const offlineMine = computed(() => {
  if (nodesStatus.value !== 'success') return null
  const id = assignment.value.assigned
  return id && !myNode.value && !(nodes.value ?? []).some((n) => n.nodeId === id) ? id : null
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <span v-if="myNode" class="text-sm">
        Your node: <strong class="font-medium">{{ myNode.nodeId }}</strong>
        <span class="ml-2 text-xs text-muted-foreground">switch anytime by picking another node below</span>
      </span>
      <span v-else-if="offlineMine" class="text-sm text-warn">
        Your node <strong class="font-medium">{{ offlineMine }}</strong> is currently offline — pick
        another node below to stream now.
      </span>
      <span v-else class="text-sm text-muted-foreground">
        No ingest node assigned to you yet — choose one below.
      </span>
      <Button variant="outline" size="sm" class="ml-auto" :disabled="pinging" @click="pingNodes">
        {{ pinging ? 'Testing…' : 'Re-test latency' }}
      </Button>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b text-left text-muted-foreground">
            <th class="py-2 pr-4 font-medium">Node</th>
            <th class="py-2 pr-4 font-medium">OBS address</th>
            <th class="py-2 pr-4 font-medium">Latency</th>
            <th class="py-2 pr-4 font-medium">Load</th>
            <th class="py-2 font-medium" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in nodes ?? []" :key="n.nodeId" class="border-b last:border-0">
            <td class="py-2.5 pr-4">
              <span class="font-medium">{{ n.nodeId }}</span>
              <Badge v-if="n.isMine" variant="success" class="ml-2">yours</Badge>
            </td>
            <td class="py-2.5 pr-4">
              <code v-if="n.rtmpUrl" class="font-mono text-xs">{{ n.rtmpUrl }}</code>
              <span v-else class="text-xs text-muted-foreground">via site host</span>
            </td>
            <td class="py-2.5 pr-4">
              <span
                v-if="rtts"
                class="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums"
                :class="rttChip(rtts[n.nodeId], outcomes[n.nodeId]).cls"
                :title="n.publicProbeUdpPort > 0 ? (rtts[n.nodeId] != null ? 'measured from your browser (ICE)' : 'no answer within the probe window (4s)') : 'node firmware has no probe responder — update it to measure'"
              >{{ rttChip(rtts[n.nodeId], outcomes[n.nodeId]).label }}</span>
              <span v-else class="text-xs text-muted-foreground">—</span>
            </td>
            <td class="py-2.5 pr-4 tabular-nums" :class="{ 'text-destructive': n.assigned > n.maxUsers }">
              {{ n.assigned }} / {{ n.maxUsers }}
            </td>
            <td class="py-2.5 text-right">
              <Button
                v-if="!n.isMine"
                size="sm"
                variant="outline"
                :disabled="selecting === n.nodeId"
                @click="select(n)"
              >Use this node</Button>
              <span v-else class="text-xs text-muted-foreground">selected</span>
            </td>
          </tr>
          <tr v-if="!(nodes ?? []).length">
            <td colspan="5" class="py-6 text-center text-muted-foreground">
              No ingest nodes are online right now.
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

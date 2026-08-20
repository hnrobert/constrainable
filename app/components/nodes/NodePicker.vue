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
 * /api/nodes/measure (feeds the latency-first allocator + admin matrix).
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
const { data: nodes, refresh } = useFetch<NodeRow[]>('/api/nodes')

/* ------------------------------ latency test ----------------------------- */
const rtts = ref<Record<string, number | null> | null>(null)
const pinging = ref(false)

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
  pinging.value = true
  try {
    const list = nodes.value ?? []
    // probe every node in parallel; ones without the responder get null → n/a
    const results = await Promise.all(
      list.map(async (n) => ({
        id: n.nodeId,
        ms: n.publicProbeUdpPort > 0 ? await browserProbe(n.nodeId) : null,
      })),
    )
    rtts.value = Object.fromEntries(results.map((r) => [r.id, r.ms]))

    const latencies = results
      .filter((r) => r.ms != null)
      .map((r) => ({ nodeId: r.id, latencyMs: r.ms as number }))
    if (latencies.length) {
      await $fetch('/api/nodes/measure', { method: 'POST', body: { latencies } }).catch(() => null)
    }
  } catch (e: any) {
    toast.error('Latency test failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    pinging.value = false
  }
}

function rttChip(ms: number | null | undefined): { label: string; cls: string } {
  if (ms == null) return { label: 'n/a', cls: 'text-muted-foreground' }
  if (ms < 50) return { label: `${ms} ms`, cls: 'text-ok font-semibold' }
  if (ms < 150) return { label: `${ms} ms`, cls: 'text-foreground' }
  return { label: `${ms} ms`, cls: 'text-warn font-semibold' }
}

/* ------------------------------- selection ------------------------------- */
const selecting = ref<string | null>(null)
async function select(n: NodeRow | null): Promise<void> {
  selecting.value = n?.nodeId ?? 'auto'
  try {
    await $fetch('/api/nodes/select', {
      method: 'POST',
      body: { nodeId: n?.nodeId ?? null },
    })
    toast.success(n ? `Streaming locked to ${n.nodeId}` : 'Back to automatic node choice')
    await refresh()
  } catch (e: any) {
    toast.error('Select failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    selecting.value = null
  }
}

const myNode = computed(() => (nodes.value ?? []).find((n) => n.isMine) ?? null)
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <span v-if="myNode" class="text-sm">
        Your node: <strong class="font-medium">{{ myNode.nodeId }}</strong>
        <Button variant="link" class="h-auto p-0 text-xs" :disabled="selecting === 'auto'" @click="select(null)">switch to automatic</Button>
      </span>
      <span v-else class="text-sm text-muted-foreground">
        No node selected — automatic (least-loaded) allocation applies.
      </span>
      <Button variant="outline" size="sm" class="ml-auto" :disabled="pinging" @click="pingNodes">
        {{ pinging ? 'Testing…' : 'Test latency' }}
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
                :class="rttChip(rtts[n.nodeId]).cls"
                :title="n.publicProbeUdpPort > 0 ? 'measured from your browser (ICE)' : 'node firmware has no probe responder — update it to measure'"
              >{{ rttChip(rtts[n.nodeId]).label }}</span>
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

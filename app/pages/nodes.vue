<script setup lang="ts">
/**
 * User-facing ingest node selection. Users test the route to every node
 * (latency probe), see each node's load (assigned / auto-assign cap), and
 * pin themselves to one. A pinned node is a LOCK: publishing via any other
 * node is refused at publish time with this page's address in the message.
 * The OBS address on every event guide page follows the selection.
 */
interface NodeRow {
  nodeId: string
  rtmpUrl: string | null
  assigned: number
  maxUsers: number
  latencyMs: number | null
  isMine: boolean
  publicOrigin: string
}

definePageMeta({ layout: 'default' })
useAuth().fetchSession().catch(() => null)

const toast = useToast()
const { data: nodes, refresh } = useFetch<NodeRow[]>('/api/nodes')

const testing = ref(false)
const fresh = ref<Record<string, number>>({})

async function testLatency(): Promise<void> {
  testing.value = true
  fresh.value = {}
  try {
    fresh.value = await probeAll((nodes.value ?? []).filter((n) => n.publicOrigin))
    if (!Object.keys(fresh.value).length) {
      toast.error('No node responded — none are reachable from this network')
    } else {
      // record the snapshot server-side (keeps the admin latency matrix fresh)
      await $fetch('/api/nodes/measure', {
        method: 'POST',
        body: {
          latencies: Object.entries(fresh.value).map(([nodeId, latencyMs]) => ({ nodeId, latencyMs })),
        },
      }).catch(() => null)
      await refresh()
      toast.success('Latency test complete')
    }
  } finally {
    testing.value = false
  }
}

function latencyOf(n: NodeRow): number | null {
  return fresh.value[n.nodeId] ?? n.latencyMs
}

function bestNodeId(): string | null {
  const entries = Object.entries(fresh.value)
  if (!entries.length) return null
  return entries.sort((a, b) => a[1] - b[1])[0]![0]
}

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
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Ingest Nodes</h1>
      <p class="text-muted-foreground">
        Test the route to every ingest node and pin yourself to the best one. Once selected you can
        only stream through that node — the OBS address on your event guide page follows your
        choice.
      </p>
    </div>

    <Card>
      <CardContent class="flex flex-wrap items-center gap-3 pt-6">
        <Button :disabled="testing || !(nodes ?? []).length" @click="testLatency">
          {{ testing ? 'Testing…' : 'Test latency now' }}
        </Button>
        <span v-if="myNode" class="text-sm">
          Your node: <strong class="font-medium">{{ myNode.nodeId }}</strong>
          <Button variant="link" class="h-auto p-0 text-xs" :disabled="selecting === 'auto'" @click="select(null)">switch to automatic</Button>
        </span>
        <span v-else class="text-sm text-muted-foreground">
          No node selected — automatic (lowest latency) allocation applies.
        </span>
      </CardContent>
    </Card>

    <Card>
      <CardContent>
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
                <template v-if="latencyOf(n) != null">
                  <span :class="{ 'font-semibold text-green-600 dark:text-green-400': n.nodeId === bestNodeId() }">{{ latencyOf(n) }} ms</span>
                  <span v-if="n.nodeId === bestNodeId()" class="ml-1 text-xs text-muted-foreground">best</span>
                </template>
                <span v-else class="text-muted-foreground">—</span>
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
      </CardContent>
    </Card>
  </div>
</template>

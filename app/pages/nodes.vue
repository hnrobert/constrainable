<script setup lang="ts">
/**
 * User-facing ingest node selection: pick a node (or stay automatic) and see
 * each node's load (assigned / auto-assign cap). A pinned node is a LOCK:
 * publishing via any other node is refused at publish time with this page's
 * address in the message. The OBS address on every event guide page follows
 * the selection.
 */
interface NodeRow {
  nodeId: string
  rtmpUrl: string | null
  assigned: number
  maxUsers: number
  isMine: boolean
}

definePageMeta({ layout: 'default' })
useAuth().fetchSession().catch(() => null)

const toast = useToast()
const { data: nodes, refresh } = useFetch<NodeRow[]>('/api/nodes')

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
        Pin yourself to an ingest node (allocation is load-ordered automatically when you leave
        it unselected). Once selected you can only stream through that node — the OBS address on
        your event guide page follows your choice.
      </p>
    </div>

    <Card>
      <CardContent class="flex flex-wrap items-center gap-3 pt-6">
        <span v-if="myNode" class="text-sm">
          Your node: <strong class="font-medium">{{ myNode.nodeId }}</strong>
          <Button variant="link" class="h-auto p-0 text-xs" :disabled="selecting === 'auto'" @click="select(null)">switch to automatic</Button>
        </span>
        <span v-else class="text-sm text-muted-foreground">
          No node selected — automatic (least-loaded) allocation applies.
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
              <td colspan="4" class="py-6 text-center text-muted-foreground">
                No ingest nodes are online right now.
              </td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  </div>
</template>

<script lang="ts">
/** One registered media node (mirrors server MediaNodeInfo + quota state). */
export interface NodeRow {
  nodeId: string
  origin: string
  publicOrigin: string
  rtmpPort: number
  hostname: string
  version: string
  connectedAt: number
  activeStreams: number
  srsFlvBase: string
  /** auto-assignment quota (node_settings; manual assignment ignores it) */
  maxUsers: number
  /** users currently pinned to this node */
  assignedUsers: number
}
</script>

<script setup lang="ts">
/**
 * Admin: the list of currently-registered media nodes (Go backends), from
 * GET /api/media-nodes. The AUTO-ASSIGN CAP is editable inline (PATCH
 * /api/media-nodes/:nodeId); rows update when the parent re-polls — a node
 * dropping offline mid-event should be visible within seconds.
 */
import type { DataTableColumn } from '~/components/DataTable.vue'

const props = defineProps<{ nodes: NodeRow[] }>()
const emit = defineEmits<{ edited: [] }>()

const toast = useToast()
const columns: DataTableColumn[] = [
  { key: 'nodeId', header: 'Node' },
  { key: 'hostname', header: 'Host' },
  { key: 'version', header: 'Version', class: 'text-muted-foreground' },
  { key: 'activeStreams', header: 'Streams' },
  { key: 'quota', header: 'Assigned / auto cap' },
  { key: 'connectedAt', header: 'Uptime' },
  { key: 'srsFlvBase', header: 'FLV base (internal)', class: 'text-muted-foreground' },
]

/** per-row working copies of the cap, populated on first edit */
const capDraft = ref<Record<string, number>>({})
function capOf(n: NodeRow): number {
  return capDraft.value[n.nodeId] ?? n.maxUsers
}
function setCap(n: NodeRow, v: string | number | null): void {
  const num = typeof v === 'string' ? Number(v) : v
  if (num != null && Number.isInteger(num) && num >= 1) capDraft.value[n.nodeId] = num
}
const savingId = ref<string | null>(null)

async function saveCap(n: NodeRow): Promise<void> {
  const maxUsers = capDraft.value[n.nodeId]
  if (maxUsers == null || maxUsers === n.maxUsers) return
  savingId.value = n.nodeId
  try {
    await $fetch(`/api/media-nodes/${encodeURIComponent(n.nodeId)}`, {
      method: 'PATCH',
      body: { maxUsers },
    })
    toast.success(`Auto-assign cap for ${n.nodeId}: ${maxUsers}`)
    delete capDraft.value[n.nodeId]
    emit('edited')
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    savingId.value = null
  }
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
</script>

<template>
  <DataTable
    :columns="columns"
    :rows="props.nodes"
    :row-key="(n: NodeRow) => n.nodeId"
    empty="No media nodes connected — check that the media-node container is up and can reach this backend (API_ORIGIN)."
  >
    <template #cell-nodeId="{ row }">
      <div class="flex flex-col">
        <span class="font-medium">{{ row.nodeId }}</span>
        <span v-if="row.publicOrigin" class="font-mono text-[10px] text-muted-foreground">{{ row.publicOrigin }}</span>
      </div>
    </template>
    <template #cell-activeStreams="{ row }">
      <Badge :variant="row.activeStreams > 0 ? 'success' : 'secondary'">{{ row.activeStreams }}</Badge>
    </template>
    <template #cell-quota="{ row }">
      <div class="flex items-center gap-1.5">
        <span
          class="tabular-nums"
          :class="row.assignedUsers > row.maxUsers ? 'font-semibold text-destructive' : ''"
        >{{ row.assignedUsers }}</span>
        <span class="text-muted-foreground">/</span>
        <Input
          type="number"
          min="1"
          class="h-8 w-20"
          :model-value="capOf(row)"
          :disabled="savingId === row.nodeId"
          @update:model-value="setCap(row, $event)"
        />
        <Button
          size="sm"
          variant="outline"
          class="h-8"
          :disabled="capOf(row) === row.maxUsers || savingId === row.nodeId"
          @click="saveCap(row)"
        >Set</Button>
      </div>
    </template>
    <template #cell-connectedAt="{ row }">{{ fmtDuration(row.connectedAt) }}</template>
  </DataTable>
</template>

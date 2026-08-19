<script lang="ts">
/** One registered media node (admin /api/media-nodes row). */
export interface NodeRow {
  nodeId: string
  publicOrigin: string
  /** OBS ingest URL (null = single-server: users push via the app's host) */
  rtmpUrl: string | null
  version: string
  activeStreams: number
  connectedAt: number
  /** auto-assignment quota (node_settings; manual assignment ignores it) */
  maxUsers: number
  /** users currently assigned to this node */
  assignedUsers: number
  users: { id: number; email: string }[]
}
</script>

<script setup lang="ts">
/**
 * Admin: registered media nodes with per-node user assignment. The cap is
 * editable inline; the detail row lists assigned users with a move control
 * (another node, or back to auto). Users are NOT permanently bound — a node
 * offline >5 min loses them to automatic reassignment on their next visit.
 */
import type { DataTableColumn } from '~/components/DataTable.vue'

const props = defineProps<{ nodes: NodeRow[] }>()
const emit = defineEmits<{ edited: [] }>()

const toast = useToast()
const columns: DataTableColumn[] = [
  { key: 'nodeId', header: 'Node' },
  { key: 'rtmpUrl', header: 'OBS ingest' },
  { key: 'version', header: 'Version', class: 'text-muted-foreground' },
  { key: 'activeStreams', header: 'Streams' },
  { key: 'quota', header: 'Assigned / auto cap' },
  { key: 'connectedAt', header: 'Uptime' },
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

/** move a user to another node (or back to auto) */
const AUTO = 'auto'
const movingId = ref<number | null>(null)
async function moveUser(u: { id: number; email: string }, nodeId: string | null): Promise<void> {
  movingId.value = u.id
  try {
    await $fetch(`/api/users/${u.id}`, { method: 'PATCH', body: { nodeId } })
    toast.success(`${u.email} → ${nodeId ?? 'auto'}`)
    emit('edited')
  } catch (e: any) {
    toast.error('Move failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    movingId.value = null
  }
}

const expanded = ref<Set<string>>(new Set())
function toggle(n: NodeRow): void {
  const next = new Set(expanded.value)
  if (next.has(n.nodeId)) next.delete(n.nodeId)
  else next.add(n.nodeId)
  expanded.value = next
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
    :detail-when="(n: NodeRow) => expanded.has(n.nodeId)"
    empty="No media nodes connected — check that the media-node container is up and can reach this backend (API_ORIGIN)."
  >
    <template #cell-nodeId="{ row }">
      <button class="flex flex-col text-left" @click="toggle(row)">
        <span class="font-medium underline decoration-dotted underline-offset-4">{{ row.nodeId }}</span>
        <span class="font-mono text-[10px] text-muted-foreground">
          {{ expanded.has(row.nodeId) ? '▾' : '▸' }} {{ row.assignedUsers }} user{{ row.assignedUsers === 1 ? '' : 's' }}
        </span>
      </button>
    </template>
    <template #cell-rtmpUrl="{ row }">
      <span v-if="row.rtmpUrl" class="font-mono text-xs">{{ row.rtmpUrl }}</span>
      <span v-else class="text-xs text-muted-foreground">via app host (single-server)</span>
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

    <template #detail="{ row }">
      <div class="space-y-1.5 px-4 py-2">
        <p v-if="!row.users.length" class="text-xs text-muted-foreground">No users assigned to this node.</p>
        <div
          v-for="u in row.users"
          :key="u.id"
          class="flex items-center justify-between gap-3 rounded-md border/50 px-2 py-1"
        >
          <span class="text-sm">{{ u.email }}</span>
          <div class="flex items-center gap-1.5">
            <Select
              :disabled="movingId === u.id"
              @update:model-value="(v: any) => v !== undefined && v !== row.nodeId && moveUser(u, v === AUTO ? null : String(v))"
            >
              <SelectTrigger class="h-8 w-44"><SelectValue placeholder="Move to…" /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="AUTO">auto (lowest latency)</SelectItem>
                <SelectItem v-for="n in props.nodes.filter((x) => x.nodeId !== row.nodeId)" :key="n.nodeId" :value="n.nodeId">
                  {{ n.nodeId }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </template>
  </DataTable>
</template>

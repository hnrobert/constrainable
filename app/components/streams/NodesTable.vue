<script lang="ts">
/** One registered media node (mirrors server MediaNodeInfo). */
export interface NodeRow {
  nodeId: string
  origin: string
  rtmpPort: number
  srtPort: number
  hostname: string
  version: string
  connectedAt: number
  activeStreams: number
  srsFlvBase: string
}
</script>

<script setup lang="ts">
/**
 * Admin: the list of currently-registered media nodes (Go backends), from
 * GET /api/media-nodes. Rows update when the parent re-polls — a node
 * dropping offline mid-event should be visible within seconds.
 */
import type { DataTableColumn } from '~/components/DataTable.vue'

const props = defineProps<{ nodes: NodeRow[] }>()

const columns: DataTableColumn[] = [
  { key: 'nodeId', header: 'Node' },
  { key: 'hostname', header: 'Host' },
  { key: 'version', header: 'Version', class: 'text-muted-foreground' },
  { key: 'activeStreams', header: 'Streams' },
  { key: 'connectedAt', header: 'Uptime' },
  { key: 'srsFlvBase', header: 'FLV base (internal)', class: 'text-muted-foreground' },
]

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
      <span class="font-medium">{{ row.nodeId }}</span>
    </template>
    <template #cell-activeStreams="{ row }">
      <Badge :variant="row.activeStreams > 0 ? 'success' : 'secondary'">{{ row.activeStreams }}</Badge>
    </template>
    <template #cell-connectedAt="{ row }">{{ fmtDuration(row.connectedAt) }}</template>
  </DataTable>
</template>

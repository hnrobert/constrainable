<script setup lang="ts">
/**
 * Per-event recordings (lives under the event's own route). Same-user segments
 * are merged server-side into one chronological file — each row is one user's
 * full recording for this event. Player + delete reuse the shared recordings
 * components.
 */
import type { RecordingView } from '#shared/recordings'
import type { DataTableColumn } from '~/components/DataTable.vue'

const route = useRoute()
const id = Number(route.params.id)

const { data: event } = useFetch<{ name: string }>(`/api/events/${id}`)
const { data: recordings, refresh } = useFetch<RecordingView[]>('/api/recordings', {
  params: { eventId: id },
})

const selected = ref<RecordingView | null>(null)

const columns: DataTableColumn[] = [
  { key: 'streamName', header: 'User' },
  { key: 'sizeBytes', header: 'Size' },
  { key: 'durationSec', header: 'Duration' },
  { key: 'bitrate', header: 'Bitrate' },
  { key: 'avgFps', header: 'Avg FPS' },
  { key: 'resolution', header: 'Resolution', class: 'text-muted-foreground' },
  { key: 'startedAt', header: 'Start time', class: 'text-muted-foreground' },
  { key: 'endedAt', header: 'End time', class: 'text-muted-foreground' },
  { key: 'actions', header: '', headClass: 'w-0' },
]

function fmtDuration(sec: number | null): string {
  if (!sec) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
    : `${m}m ${String(s).padStart(2, '0')}s`
}
function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString('en-US', { hour12: false }) : '—'
}
function resolution(r: RecordingView): string {
  return r.width && r.height ? `${r.width}×${r.height}` : '—'
}
/** derived average bitrate from cumulative size ÷ cumulative duration */
function bitrate(r: RecordingView): string {
  if (!r.durationSec || r.durationSec <= 0) return '—'
  return `${Math.round((r.sizeBytes * 8) / 1000 / r.durationSec)} kbps`
}
async function onDeleted(): Promise<void> {
  selected.value = null
  await refresh()
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold">Recordings</h2>
      <p class="text-muted-foreground">
        Archived recordings of compliant streams for this event. A user's re-publishes are merged into one chronological file.
      </p>
    </div>

    <RecordingsPlayer v-if="selected" :recording="selected" @deleted="onDeleted" />

    <Card>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="recordings ?? []"
          :row-key="(r: RecordingView) => r.id"
          empty="No recordings for this event yet."
        >
          <template #cell-streamName="{ row }">
            <span class="font-medium">{{ row.streamName }}</span>
          </template>
          <template #cell-sizeBytes="{ row }">{{ fmtSize(row.sizeBytes) }}</template>
          <template #cell-durationSec="{ row }">{{ fmtDuration(row.durationSec) }}</template>
          <template #cell-bitrate="{ row }">{{ bitrate(row) }}</template>
          <template #cell-avgFps="{ row }">{{ row.avgFps != null ? row.avgFps.toFixed(2) : '—' }}</template>
          <template #cell-resolution="{ row }">{{ resolution(row) }}</template>
          <template #cell-startedAt="{ row }">{{ fmtTime(row.startedAt) }}</template>
          <template #cell-endedAt="{ row }">{{ fmtTime(row.endedAt) }}</template>
          <template #cell-actions="{ row }">
            <Button size="sm" variant="outline" @click="selected = row">Play</Button>
          </template>
        </DataTable>
      </CardContent>
    </Card>
  </div>
</template>

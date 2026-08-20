<script setup lang="ts">
definePageMeta({ layout: 'default', adminOnly: true })
/**
 * Insights tab — per-event statistics: headline cards (sessions, users, stream
 * time, compliance, violations, recordings) plus the 10 most recent sessions.
 */
import type { DataTableColumn } from '~/components/DataTable.vue'

interface RecentSession {
  id: number
  streamName: string
  status: string
  compliant: boolean
  width: number | null
  height: number | null
  fps: number | null
  bitrateKbps: number | null
  startedAt: number
  endedAt: number | null
}
interface Stats {
  sessions: number
  live: number
  uniqueUsers: number
  streamHours: number
  violations: number
  rejected: number
  complianceRate: number | null
  recordings: { count: number; totalBytes: number; totalDurationSec: number }
  recent: RecentSession[]
}

const route = useRoute()
const id = Number(route.params.id)
const { data: stats } = useFetch<Stats>(`/api/events/${id}/stats`)

function fmtSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
function fmtTime(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString('en-US', { hour12: false }) : '—'
}

const statusVariant: Record<string, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  allowed: 'warning',
  compliant: 'success',
  violating: 'destructive',
  killed: 'destructive',
  rejected: 'secondary',
  ended: 'secondary',
}

const columns: DataTableColumn[] = [
  { key: 'streamName', header: 'User', class: 'font-medium' },
  { key: 'status', header: 'Status' },
  { key: 'resolution', header: 'Resolution' },
  { key: 'fps', header: 'Framerate' },
  { key: 'bitrateKbps', header: 'Bitrate' },
  { key: 'startedAt', header: 'Started', class: 'text-muted-foreground' },
  { key: 'endedAt', header: 'Ended', class: 'text-muted-foreground' },
]
</script>

<template>
  <div class="space-y-6">
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Sessions</p>
          <p class="text-2xl font-semibold">{{ stats?.sessions ?? '…' }}</p>
          <p v-if="stats?.live" class="text-xs text-ok">{{ stats.live }} live</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Users</p>
          <p class="text-2xl font-semibold">{{ stats?.uniqueUsers ?? '…' }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Stream time</p>
          <p class="text-2xl font-semibold">{{ stats ? `${stats.streamHours}h` : '…' }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Compliance</p>
          <p class="text-2xl font-semibold">
            {{ stats?.complianceRate != null ? `${stats.complianceRate}%` : '—' }}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Violations</p>
          <p class="text-2xl font-semibold">{{ stats?.violations ?? '…' }}</p>
          <p v-if="stats?.rejected" class="text-xs text-muted-foreground">{{ stats.rejected }} rejected</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Recordings</p>
          <p class="text-2xl font-semibold">{{ stats?.recordings.count ?? '…' }}</p>
          <p v-if="stats?.recordings.count" class="text-xs text-muted-foreground">
            {{ fmtSize(stats.recordings.totalBytes) }} · {{ fmtDur(stats.recordings.totalDurationSec) }}
          </p>
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Recent sessions</CardTitle>
        <CardDescription>The 10 most recent publish attempts for this event.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="stats?.recent ?? []"
          :row-key="(r: RecentSession) => r.id"
          empty="No sessions yet."
        >
          <template #cell-status="{ row }">
            <Badge :variant="statusVariant[row.status] ?? 'secondary'">{{ row.status }}</Badge>
          </template>
          <template #cell-resolution="{ row }">
            {{ row.width && row.height ? `${row.width}×${row.height}` : '—' }}
          </template>
          <template #cell-fps="{ row }">{{ row.fps != null ? row.fps.toFixed(2) : '—' }}</template>
          <template #cell-bitrateKbps="{ row }">
            {{ row.bitrateKbps != null ? `${row.bitrateKbps} kbps` : '—' }}
          </template>
          <template #cell-startedAt="{ row }">{{ fmtTime(row.startedAt) }}</template>
          <template #cell-endedAt="{ row }">{{ fmtTime(row.endedAt) }}</template>
        </DataTable>
      </CardContent>
    </Card>
  </div>
</template>

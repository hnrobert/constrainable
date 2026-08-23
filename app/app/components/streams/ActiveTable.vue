<script setup lang="ts">
import type { SessionSnapshot, SessionStatus } from '#shared/events'
import type { DataTableColumn } from '~/components/DataTable.vue'

const props = defineProps<{
  sessions: SessionSnapshot[]
  /** eventId → display label (event name), for the Event column */
  eventLabels: Record<number, string>
}>()
const emit = defineEmits<{ watch: [streamName: string] }>()

const toast = useToast()
const confirm = useConfirm()

/** Sessions with a live publisher that can be banned+disconnected. */
function bannable(s: SessionSnapshot): boolean {
  // local sessions route by SRS client id, media-node sessions by node
  return ['pending', 'allowed', 'compliant', 'violating'].includes(s.status) && (!!s.srsClientId || !!s.nodeId)
}

function ban(s: SessionSnapshot): void {
  // stream names are the account email (gateway identity) for authed publishers
  confirm.ask(
    `Ban ${s.streamName} from streaming site-wide and disconnect them now? The ban is permanent — lifted only from the blacklist.`,
    async () => {
      try {
        await $fetch(
          `/api/streams/clients/${encodeURIComponent(s.srsClientId ?? '-')}?email=${encodeURIComponent(s.streamName)}`,
          { method: 'DELETE' },
        )
        toast.success(`Banned ${s.streamName} (site-wide)`)
        // the row disappears on its own via the session:stop socket event
      } catch (e: any) {
        toast.error('Ban failed: ' + (e?.data?.statusMessage || e?.message || ''))
      }
    },
    { actionLabel: 'Ban' },
  )
}

const statusVariant: Record<SessionStatus, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  pending: 'secondary',
  allowed: 'warning',
  compliant: 'success',
  violating: 'destructive',
  killed: 'destructive',
  rejected: 'secondary',
  ended: 'secondary',
}
const statusLabel: Record<SessionStatus, string> = {
  pending: 'Pending',
  allowed: 'Publishing',
  compliant: 'Compliant',
  violating: 'Violating',
  killed: 'Kicked',
  rejected: 'Rejected',
  ended: 'Ended',
}

function resolution(s: SessionSnapshot): string {
  if (s.width && s.height) return `${s.width}×${s.height}`
  return '—'
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour12: false })
}

const columns: DataTableColumn[] = [
  { key: 'event', header: 'Event' },
  { key: 'streamName', header: 'User', class: 'font-medium' },
  { key: 'resolution', header: 'Resolution' },
  { key: 'fps', header: 'Framerate' },
  { key: 'videoBitrateKbps', header: 'Video / Audio kbps' },
  { key: 'status', header: 'Status' },
  { key: 'startedAt', header: 'Started', class: 'text-muted-foreground' },
  { key: 'actions', header: 'Action', headClass: 'w-0' },
]
</script>

<template>
  <DataTable
    :columns="columns"
    :rows="props.sessions"
    :row-key="(s: SessionSnapshot) => s.sessionId"
    empty="No active streams."
  >
    <template #cell-status="{ row }">
      <Badge :variant="statusVariant[row.status]">{{ statusLabel[row.status] }}</Badge>
    </template>
    <template #cell-event="{ row }">{{ props.eventLabels[row.eventId ?? -1] ?? '—' }}</template>
    <template #cell-resolution="{ row }">{{ resolution(row) }}</template>
    <template #cell-fps="{ row }">{{ row.fps != null ? row.fps.toFixed(2) : '—' }}</template>
    <template #cell-videoBitrateKbps="{ row }">
      <!-- video rate always means the OBS Video Bitrate field; audio (declared
           rate) shows alongside when the node reports it -->
      <span v-if="row.videoBitrateKbps != null">
        {{ row.videoBitrateKbps
        }}<span v-if="row.audioBitrateKbps != null" class="text-muted-foreground"> / {{ row.audioBitrateKbps }}</span>
        <span class="text-muted-foreground"> kbps</span>
      </span>
      <span v-else>{{ row.audioBitrateKbps != null ? `— / ${row.audioBitrateKbps} kbps` : '—' }}</span>
    </template>
    <template #cell-startedAt="{ row }">{{ fmtTime(row.startedAt) }}</template>
    <template #cell-actions="{ row }">
      <div class="flex justify-end gap-1.5">
        <Button size="sm" variant="outline" @click="emit('watch', row.streamName)">Watch</Button>
        <Button v-if="bannable(row)" size="sm" variant="destructive" @click="ban(row)">Ban</Button>
      </div>
    </template>
  </DataTable>
  <ConfirmDialog
    v-model:open="confirm.state.open"
    :message="confirm.state.message"
    :action-label="confirm.state.actionLabel"
    :destructive="confirm.state.destructive"
    @accept="confirm.accept"
  />
</template>

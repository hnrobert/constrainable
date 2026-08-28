<script setup lang="ts">
import type { RecordingView } from '#shared/recordings'

const props = defineProps<{ recording: RecordingView }>()
const emit = defineEmits<{ deleted: [id: number] }>()
const toast = useToast()
const confirm = useConfirm()

const src = computed(() => `/api/recordings/${props.recording.id}/file`)
const downloadUrl = computed(() => `/api/recordings/${props.recording.id}/file?download`)
const removing = ref(false)

/** hosting node disconnected — play/download impossible, delete keeps files */
const nodeOffline = computed(() => props.recording.nodeOnline === false)

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function onPlaybackError(): void {
  toast.error(
    'Playback failed — the hosting node may have gone offline, or a segment is missing. Retry or use Download.',
  )
}

function remove(): void {
  confirm.ask(
    nodeOffline.value
      ? `Delete recording "${props.recording.streamName}"? The hosting node is OFFLINE — only the record is removed; the files stay on the node's disk until it reconnects and someone deletes them again.`
      : `Delete recording "${props.recording.streamName}"? The file will also be deleted.`,
    async () => {
      removing.value = true
      try {
        await $fetch(`/api/recordings/${props.recording.id}`, { method: 'DELETE' })
        toast.success('Recording deleted')
        emit('deleted', props.recording.id)
      } catch (e: unknown) {
        const err = e as { data?: { statusMessage?: string }; message?: string }
        toast.error('Delete failed: ' + (err?.data?.statusMessage || err?.message || ''))
      } finally {
        removing.value = false
      }
    },
    { actionLabel: 'Delete' },
  )
}
</script>

<template>
  <div>
    <Card>
      <CardContent class="flex flex-col gap-2 p-4">
        <div
          v-if="nodeOffline"
          class="rounded-lg bg-black/95 max-h-[60vh] min-h-40 flex flex-col items-center justify-center gap-2 p-6 text-center"
        >
          <span class="text-sm font-medium text-destructive">Hosting node offline</span>
          <span class="text-xs text-muted-foreground max-w-md">
            The recording's files live on node <code>{{ recording.nodeId }}</code> and cannot be streamed or downloaded
            while it is disconnected. Playback becomes available again once the node reconnects.
          </span>
        </div>
        <video
          v-else
          controls
          preload="metadata"
          :src="src"
          class="w-full rounded-lg bg-black max-h-[60vh]"
          @error="onPlaybackError"
        />
        <div class="flex flex-wrap items-center justify-between gap-3 mt-1">
          <div>
            <strong>{{ recording.streamName }}</strong>
            <span v-if="recording.studentLabel" class="text-muted-foreground"> · {{ recording.studentLabel }}</span>
            <span v-if="nodeOffline" class="text-destructive text-xs"> · node offline</span>
            <div class="text-xs text-muted-foreground">
              {{ fmtSize(recording.sizeBytes) }}
              <span v-if="recording.width && recording.height"> · {{ recording.width }}×{{ recording.height }}</span>
              · {{ new Date(recording.startedAt).toLocaleString('en-US', { hour12: false }) }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Button v-if="!nodeOffline" as-child variant="outline" size="sm">
              <a :href="downloadUrl" target="_blank">Download</a>
            </Button>
            <Button v-else variant="outline" size="sm" disabled title="Node offline">Download</Button>
            <Button variant="destructive" size="sm" :disabled="removing" @click="remove">
              {{ removing ? 'Deleting…' : 'Delete' }}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>

    <ConfirmDialog
      v-model:open="confirm.state.open"
      :message="confirm.state.message"
      :action-label="confirm.state.actionLabel"
      :destructive="confirm.state.destructive"
      @accept="confirm.accept"
    />
  </div>
</template>

<script setup lang="ts">
import type { RecordingView } from '#shared/recordings'

const props = defineProps<{ recording: RecordingView }>()
const emit = defineEmits<{ deleted: [id: number] }>()
const toast = useToast()
const confirm = useConfirm()

const src = computed(() => `/api/recordings/${props.recording.id}/file`)
const downloadUrl = computed(() => `/api/recordings/${props.recording.id}/file?download`)
const removing = ref(false)

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function remove(): void {
  confirm.ask(
    `Delete recording "${props.recording.streamName}"? The file will also be deleted.`,
    async () => {
      removing.value = true
      try {
        await $fetch(`/api/recordings/${props.recording.id}`, { method: 'DELETE' })
        toast.success('Recording deleted')
        emit('deleted', props.recording.id)
      } catch (e: any) {
        toast.error('Delete failed: ' + (e?.data?.statusMessage || e?.message || ''))
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
        <video controls preload="metadata" :src="src" class="w-full rounded-lg bg-black max-h-[60vh]" />
        <div class="flex flex-wrap items-center justify-between gap-3 mt-1">
          <div>
            <strong>{{ recording.streamName }}</strong>
            <span v-if="recording.studentLabel" class="text-muted-foreground"> · {{ recording.studentLabel }}</span>
            <div class="text-xs text-muted-foreground">
              {{ fmtSize(recording.sizeBytes) }}
              <span v-if="recording.width && recording.height"> · {{ recording.width }}×{{ recording.height }}</span>
              · {{ new Date(recording.startedAt).toLocaleString('en-US', { hour12: false }) }}
            </div>
          </div>
          <div class="flex items-center gap-2">
            <Button as-child variant="outline" size="sm">
              <a :href="downloadUrl" target="_blank">Download</a>
            </Button>
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

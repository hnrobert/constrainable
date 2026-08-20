<script setup lang="ts">
/**
 * Self-view: the logged-in user's OWN live stream, latest frame only. The
 * server captures one frame on demand (/api/me/frame — bound to the caller's
 * email, so no one else's stream is ever reachable); NOTHING auto-refreshes —
 * the user clicks "Refresh" to fetch the current frame.
 */
definePageMeta({ layout: 'default' })
useAuth().fetchSession().catch(() => null)

const frameUrl = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const fetchedAt = ref<number | null>(null)

async function refresh(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const blob = await $fetch<Blob>('/api/me/frame', { responseType: 'blob' })
    if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
    frameUrl.value = URL.createObjectURL(blob)
    fetchedAt.value = Date.now()
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Frame unavailable'
    frameUrl.value = null
  } finally {
    loading.value = false
  }
}

onUnmounted(() => {
  if (frameUrl.value) URL.revokeObjectURL(frameUrl.value)
})
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">My Live View</h1>
      <p class="text-muted-foreground">
        The latest frame from your own stream, exactly as the server receives it. Nothing updates
        automatically — click Refresh to fetch the current picture.
      </p>
    </div>

    <Card>
      <CardContent class="space-y-4 pt-6">
        <div class="flex items-center gap-3">
          <Button :disabled="loading" @click="refresh">
            {{ loading ? 'Capturing…' : 'Refresh frame' }}
          </Button>
          <span v-if="fetchedAt" class="text-xs text-muted-foreground">
            captured at {{ new Date(fetchedAt).toLocaleTimeString('en-US', { hour12: false }) }}
          </span>
        </div>

        <div
          class="flex min-h-[240px] items-center justify-center overflow-hidden rounded-md border bg-muted/30"
        >
          <img v-if="frameUrl" :src="frameUrl" alt="Your latest stream frame" class="max-h-[540px] w-auto max-w-full" >
          <div v-else-if="loading" class="text-sm text-muted-foreground">Pulling one frame from your stream…</div>
          <div v-else-if="error" class="max-w-sm text-center text-sm text-muted-foreground">{{ error }}</div>
          <div v-else class="text-sm text-muted-foreground">
            Start streaming in OBS, then press “Refresh frame”.
          </div>
        </div>
      </CardContent>
    </Card>
  </div>
</template>

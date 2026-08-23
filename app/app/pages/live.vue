<script setup lang="ts">
/**
 * Self-view: the logged-in user's OWN live stream, played live over WebRTC
 * (StreamsPlayer — media flows browser↔their ingest node directly; the WHEP
 * signaling endpoint allows a regular user to watch exactly their own stream,
 * keyed by account email). Replaces the old server-captured still frame:
 * the picture you see is the real thing, in real time.
 */
definePageMeta({ layout: 'default' })
const { user } = useAuth()
useAuth()
  .fetchSession()
  .catch(() => null)

const streamName = computed(() => user.value?.email ?? '')
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">My Live View</h1>
      <p class="text-muted-foreground">
        Your own stream, live over WebRTC — exactly as the server receives it. Start streaming in OBS and the picture
        connects by itself.
      </p>
    </div>

    <StreamsPlayer v-if="streamName" :stream-name="streamName" />
    <Card v-else>
      <CardContent class="pt-6 text-sm text-muted-foreground"> Sign in to see your own stream. </CardContent>
    </Card>
  </div>
</template>

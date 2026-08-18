<script setup lang="ts">
import type mpegtsTypes from 'mpegts.js'

// Admin live player. Plays a single live stream by name; URLs come from the
// admin-only /api/streams/url endpoint. Browser connects to SRS directly.
const props = defineProps<{ streamName: string }>()

type Mode = 'flv' | 'webrtc'
const mode = ref<Mode>('flv')
const videoEl = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'loading' | 'playing' | 'error'>('idle')
const errorMsg = ref('')
const urls = ref<{ flv: string; whep: string } | null>(null)

let mpegPlayer: mpegtsTypes.Player | null = null
let pc: RTCPeerConnection | null = null

async function resolveUrls(): Promise<void> {
  status.value = 'loading'
  try {
    urls.value = await $fetch<{ flv: string; whep: string }>('/api/streams/url', {
      params: { streamName: props.streamName },
    })
  } catch (e: any) {
    status.value = 'error'
    errorMsg.value = e?.data?.statusMessage || e?.message || 'Unable to fetch playback URL'
  }
}

function teardown(): void {
  if (mpegPlayer) {
    try {
      mpegPlayer.pause()
      mpegPlayer.unload()
      mpegPlayer.detachMediaElement()
      mpegPlayer.destroy()
    } catch {
      /* ignore */
    }
    mpegPlayer = null
  }
  if (pc) {
    try {
      pc.getSenders().forEach((s) => s.track?.stop())
      pc.close()
    } catch {
      /* ignore */
    }
    pc = null
  }
  if (videoEl.value) videoEl.value.srcObject = null
}

async function startFlv(): Promise<void> {
  teardown()
  if (!urls.value) return
  status.value = 'loading'
  errorMsg.value = ''
  try {
    const mpegts = (await import('mpegts.js')).default
    mpegPlayer = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: urls.value.flv },
      { enableStashBuffer: false, stashInitialSize: 128 },
    )
    mpegPlayer.on(mpegts.Events.ERROR, (errType, errDetail) => {
      status.value = 'error'
      errorMsg.value = `FLV error: ${errType} ${errDetail ?? ''}`
    })
    mpegPlayer.attachMediaElement(videoEl.value!)
    mpegPlayer.load()
    await mpegPlayer.play()
    status.value = 'playing'
  } catch (e: any) {
    status.value = 'error'
    errorMsg.value = 'FLV playback failed: ' + (e?.message ?? String(e))
  }
}

async function startWebrtc(): Promise<void> {
  teardown()
  if (!urls.value || !videoEl.value) return
  status.value = 'loading'
  errorMsg.value = ''
  try {
    pc = new RTCPeerConnection()
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.ontrack = (e) => {
      videoEl.value!.srcObject = e.streams[0] ?? null
      videoEl.value!.play().catch(() => {})
    }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const resp = await fetch(urls.value.whep, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer.sdp,
    })
    if (!resp.ok) throw new Error(`WHEP ${resp.status}`)
    const answerSdp = await resp.text()
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    status.value = 'playing'
  } catch (e: any) {
    status.value = 'error'
    errorMsg.value = 'WebRTC failed, switch back to FLV: ' + (e?.message ?? String(e))
  }
}

async function switchMode(m: Mode): Promise<void> {
  mode.value = m
  if (m === 'flv') await startFlv()
  else await startWebrtc()
}

onMounted(async () => {
  await resolveUrls()
  if (urls.value) await startFlv()
})

onBeforeUnmount(teardown)

watch(
  () => props.streamName,
  async () => {
    await resolveUrls()
    if (urls.value) await (mode.value === 'flv' ? startFlv() : startWebrtc())
  },
)
</script>

<template>
  <Card>
    <CardContent class="flex flex-col gap-2 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" class="font-mono text-xs">{{ props.streamName }}</Badge>
        <Badge :variant="status === 'playing' ? 'success' : status === 'loading' ? 'warning' : status === 'error' ? 'destructive' : 'secondary'">
          {{ status === 'playing' ? 'Playing' : status === 'loading' ? 'Loading…' : status === 'error' ? 'Error' : 'Idle' }}
        </Badge>
        <div class="ml-auto flex gap-1.5">
          <Button size="sm" :variant="mode === 'flv' ? 'default' : 'outline'" @click="switchMode('flv')">FLV</Button>
          <Button size="sm" :variant="mode === 'webrtc' ? 'default' : 'outline'" @click="switchMode('webrtc')">WebRTC</Button>
        </div>
      </div>
      <video ref="videoEl" class="w-full aspect-video rounded-lg bg-black" autoplay muted playsinline controls />
      <Badge v-if="errorMsg" variant="destructive">{{ errorMsg }}</Badge>
      <p class="text-xs text-muted-foreground">The browser connects directly to SRS for playback. If WebRTC doesn't work, use FLV.</p>
    </CardContent>
  </Card>
</template>

<script setup lang="ts">
/**
 * Admin live player — WebRTC ONLY. The SDP exchange rides the app's
 * admin-gated same-origin WHEP proxy (/api/streams/whep — media can never
 * start without an authenticated session); the media flows directly
 * browser ↔ the hosting node's SRS over UDP (ICE candidate from the node).
 *
 * Failure UX: a watchdog (wall-clock — ICE may hang forever on blackholed
 * UDP) surfaces a terminal error with the reason; the user retries. The
 * attempt token keeps late ICE events from resurrecting a torn-down pc.
 */
import type { IceServer } from '#shared/rtmp'

const props = defineProps<{ streamName: string }>()

const videoEl = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'loading' | 'playing' | 'error'>('idle')
const errorMsg = ref('')
const urls = ref<{ whep: string; iceServers: IceServer[] } | null>(null)

let pc: RTCPeerConnection | null = null
let attempt = 0

/** wall-clock cap — Chrome can sit in `checking` 30s+ on blackholed UDP */
const WHEP_CONNECT_TIMEOUT_MS = 8_000
let watchdog: ReturnType<typeof setTimeout> | undefined

async function resolveUrls(): Promise<void> {
  status.value = 'loading'
  try {
    urls.value = await $fetch<{ whep: string; iceServers: IceServer[] }>('/api/streams/url', {
      params: { streamName: props.streamName },
    })
  } catch (e: any) {
    status.value = 'error'
    errorMsg.value = e?.data?.statusMessage || e?.message || 'Unable to fetch playback URL'
  }
}

function teardown(): void {
  if (watchdog) clearTimeout(watchdog)
  watchdog = undefined
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

async function startWebrtc(): Promise<void> {
  teardown()
  if (!urls.value || !videoEl.value) return
  const a = ++attempt
  status.value = 'loading'
  errorMsg.value = ''
  try {
    pc = new RTCPeerConnection({ iceServers: urls.value.iceServers ?? [] })
    // video-then-audio order matches SRS's answer m-lines — do not reorder
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })

    pc.ontrack = (e) => {
      if (a !== attempt) return
      if (!videoEl.value) return
      videoEl.value.srcObject = e.streams[0] ?? null
      videoEl.value.play().catch(() => {})
    }

    pc.onconnectionstatechange = () => {
      if (a !== attempt || !pc) return
      const st = pc.connectionState
      if (st === 'connected') {
        if (watchdog) clearTimeout(watchdog)
        watchdog = undefined
        status.value = 'playing'
      } else if (st === 'failed') {
        fail(`WebRTC connection failed (UDP to the node blocked?)`, a)
      }
    }

    watchdog = setTimeout(() => {
      if (a !== attempt || !pc) return
      if (pc.connectionState !== 'connected') fail('connect timeout — is udp open to the node?', a)
    }, WHEP_CONNECT_TIMEOUT_MS)

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
    // status → playing ONLY on connectionstate 'connected' (above)
  } catch (e: any) {
    if (a !== attempt) return
    fail(e?.message ?? String(e), a)
  }
}

function fail(reason: string, a: number): void {
  if (a !== attempt) return
  teardown()
  status.value = 'error'
  errorMsg.value = `WebRTC: ${reason}`
}

onMounted(async () => {
  await resolveUrls()
  if (urls.value) await startWebrtc()
})

onBeforeUnmount(teardown)

watch(
  () => props.streamName,
  async () => {
    await resolveUrls()
    if (urls.value) await startWebrtc()
  },
)
</script>

<template>
  <Card>
    <CardContent class="flex flex-col gap-2 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" class="font-mono text-xs">{{ props.streamName }}</Badge>
        <Badge :variant="status === 'playing' ? 'success' : status === 'loading' ? 'warning' : status === 'error' ? 'destructive' : 'secondary'">
          {{ status === 'playing' ? 'Playing · WebRTC' : status === 'loading' ? 'Connecting…' : status === 'error' ? 'Error' : 'Idle' }}
        </Badge>
        <Button v-if="status === 'error'" size="sm" variant="outline" class="ml-auto" @click="startWebrtc">Retry</Button>
      </div>
      <video ref="videoEl" class="w-full aspect-video rounded-lg bg-black" autoplay muted playsinline controls />
      <Badge v-if="errorMsg" variant="destructive">{{ errorMsg }}</Badge>
      <p class="text-xs text-muted-foreground">
        Media flows directly from the ingest node over UDP (WebRTC); the connection setup is authorized by your session. Playback needs UDP open to the node's host.
      </p>
    </CardContent>
  </Card>
</template>

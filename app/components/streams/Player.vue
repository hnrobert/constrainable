<script setup lang="ts">
import type mpegtsTypes from 'mpegts.js'

/**
 * Admin live player with a playback LADDER:
 *
 *   Auto (default) → WebRTC first (browser ↔ node's SRS directly over UDP,
 *   low latency, zero app bandwidth) → automatic fallback to FLV (same-origin
 *   app proxy) when WebRTC can't connect within the watchdog window, ICE
 *   fails, or the connection drops. Manual Auto/WebRTC/FLV override above.
 *
 * Race safety: every async continuation (WHEP fetch, ICE state callbacks,
 * watchdog/grace timers) captures the monotonic `attempt` token at start and
 * no-ops when stale — a late ICE success after fallback can never hijack the
 * video element, and rapid mode/stream switching never runs two engines.
 */
import type { IceServer } from '#shared/rtmp'

const props = defineProps<{ streamName: string }>()

type Pref = 'auto' | 'flv' | 'webrtc'
type Engine = 'none' | 'webrtc' | 'flv'

const pref = ref<Pref>('auto')
const engine = ref<Engine>('none')
const videoEl = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'loading' | 'playing' | 'error'>('idle')
const errorMsg = ref('')
const fallbackReason = ref('')
const urls = ref<{ flv: string; whep: string; iceServers: IceServer[] } | null>(null)

let mpegPlayer: mpegtsTypes.Player | null = null
let pc: RTCPeerConnection | null = null
let attempt = 0

/** wall-clock caps — Chrome can sit in `checking` 30s+ on blackholed UDP */
const WHEP_CONNECT_TIMEOUT_MS = 5_000
const ICE_DISCONNECT_GRACE_MS = 5_000
let watchdog: ReturnType<typeof setTimeout> | undefined
let graceTimer: ReturnType<typeof setTimeout> | undefined

function clearTimers(): void {
  if (watchdog) clearTimeout(watchdog)
  watchdog = undefined
  if (graceTimer) clearTimeout(graceTimer)
  graceTimer = undefined
}

async function resolveUrls(): Promise<void> {
  status.value = 'loading'
  try {
    urls.value = await $fetch<{ flv: string; whep: string; iceServers: IceServer[] }>(
      '/api/streams/url',
      { params: { streamName: props.streamName } },
    )
  } catch (e: any) {
    status.value = 'error'
    errorMsg.value = e?.data?.statusMessage || e?.message || 'Unable to fetch playback URL'
  }
}

function teardown(): void {
  clearTimers()
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
  // LAST and load-bearing: srcObject overrides src per spec — a leftover
  // stream would black-screen the mpegts fallback
  if (videoEl.value) videoEl.value.srcObject = null
}

function play(): Promise<void> {
  return pref.value === 'flv' ? startFlv() : startWebrtc()
}

async function startFlv(): Promise<void> {
  teardown()
  engine.value = 'flv'
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

/** single-flight WebRTC→FLV fallback; token-guarded against stale callers */
function fallbackToFlv(reason: string, a: number): void {
  if (a !== attempt) return // superseded by a newer attempt
  if (engine.value !== 'webrtc') return // already fell back / switched
  fallbackReason.value = reason
  console.warn(`[player] WebRTC → FLV fallback: ${reason}`)
  void startFlv()
}

async function startWebrtc(): Promise<void> {
  teardown()
  engine.value = 'webrtc'
  fallbackReason.value = ''
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
        clearTimers()
        status.value = 'playing'
      } else if (st === 'failed') {
        fallbackToFlv('WebRTC connection failed', a)
      } else if (st === 'disconnected') {
        // also the stream-ended path (SRS peer dies when OBS stops)
        if (graceTimer) clearTimeout(graceTimer)
        graceTimer = setTimeout(() => {
          if (a !== attempt || !pc) return
          if (pc.connectionState !== 'connected') fallbackToFlv('connection lost', a)
        }, ICE_DISCONNECT_GRACE_MS)
      }
    }

    // wall-clock watchdog: mandatory — ICE may never reach `failed` on
    // blackholed UDP (Chrome hangs in checking, Safari stays in new)
    watchdog = setTimeout(() => {
      if (a !== attempt || !pc) return
      if (pc.connectionState !== 'connected') fallbackToFlv('WebRTC connect timeout', a)
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
    fallbackToFlv(`WHEP/SDP error: ${e?.message ?? String(e)}`, a)
  }
}

async function switchPref(m: Pref): Promise<void> {
  pref.value = m
  await play()
}

const engineLabel = computed(() => {
  if (engine.value === 'webrtc') return 'WebRTC'
  if (engine.value === 'flv') {
    return fallbackReason.value ? `FLV · fell back: ${fallbackReason.value}` : 'FLV'
  }
  return '—'
})

onMounted(async () => {
  await resolveUrls()
  if (urls.value) await play()
})

onBeforeUnmount(teardown)

watch(
  () => props.streamName,
  async () => {
    await resolveUrls()
    if (urls.value) await play()
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
        <Badge v-if="engine !== 'none'" variant="outline" class="text-xs">{{ engineLabel }}</Badge>
        <div class="ml-auto flex gap-1.5">
          <Button size="sm" :variant="pref === 'auto' ? 'default' : 'outline'" @click="switchPref('auto')">Auto</Button>
          <Button size="sm" :variant="pref === 'webrtc' ? 'default' : 'outline'" @click="switchPref('webrtc')">WebRTC</Button>
          <Button size="sm" :variant="pref === 'flv' ? 'default' : 'outline'" @click="switchPref('flv')">FLV</Button>
        </div>
      </div>
      <video ref="videoEl" class="w-full aspect-video rounded-lg bg-black" autoplay muted playsinline controls />
      <Badge v-if="errorMsg" variant="destructive">{{ errorMsg }}</Badge>
      <p class="text-xs text-muted-foreground">
        Auto tries WebRTC first (direct to the ingest node, low latency) and falls back to FLV through the server when it can't connect.
      </p>
    </CardContent>
  </Card>
</template>

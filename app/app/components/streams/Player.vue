<script setup lang="ts">
/**
 * Admin live player — WebRTC ONLY. The SDP exchange rides the app's
 * admin-gated same-origin WHEP proxy (/api/streams/whep — media can never
 * start without an authenticated session); the media flows directly
 * browser ↔ the hosting node's SRS over UDP (ICE candidate from the node).
 *
 * Failure UX: two watchdogs (wall-clock — ICE may hang forever on blackholed
 * UDP, and SRS's rtmp→rtc bridge + the publisher's keyframe interval can
 * legitimately delay the FIRST frame by seconds) surface terminal errors with
 * the reason; the user retries. The attempt token keeps late ICE events from
 * resurrecting a torn-down pc.
 *
 * "Playing" is honest: it flips only when the FIRST FRAME is decoded
 * (video resize event, videoWidth>0) — never on ICE connect alone, which
 * used to show a black video labelled Playing while the bridge/keyframe was
 * still pending.
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
/** after ICE connects: first frame must land within this. Covers SRS's lazy
 * rtmp→rtc bridge spin-up plus up to ~2 publisher keyframe intervals. */
const FIRST_FRAME_TIMEOUT_MS = 12_000
let watchdog: ReturnType<typeof setTimeout> | undefined
let frameWatchdog: ReturnType<typeof setTimeout> | undefined
let onFirstFrame: (() => void) | null = null

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
  if (frameWatchdog) clearTimeout(frameWatchdog)
  frameWatchdog = undefined
  if (onFirstFrame && videoEl.value) {
    videoEl.value.removeEventListener('resize', onFirstFrame)
    onFirstFrame = null
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

    let merged: MediaStream | null = null
    pc.ontrack = (e) => {
      if (a !== attempt) return
      if (!videoEl.value) return
      // SRS answers may carry no msid (streams[] empty) — fall back to a
      // locally merged MediaStream so the video still renders.
      merged ??= new MediaStream()
      merged.addTrack(e.track)
      videoEl.value.srcObject = merged
      videoEl.value.play().catch(() => {})
    }

    pc.onconnectionstatechange = () => {
      if (a !== attempt || !pc) return
      const st = pc.connectionState
      if (st === 'connected') {
        if (watchdog) clearTimeout(watchdog)
        watchdog = undefined
        // ICE is up — now WAIT for an actual decoded frame (see header): the
        // rtmp→rtc bridge + keyframe interval can black-screen for seconds.
        const v = videoEl.value
        if (v && v.videoWidth > 0) {
          status.value = 'playing'
          return
        }
        onFirstFrame = () => {
          if (a !== attempt || !videoEl.value || videoEl.value.videoWidth === 0) return
          if (frameWatchdog) clearTimeout(frameWatchdog)
          frameWatchdog = undefined
          status.value = 'playing'
        }
        v?.addEventListener('resize', onFirstFrame)
        frameWatchdog = setTimeout(async () => {
          if (a !== attempt || !pc) return
          // Diagnostics in the error: distinguishes "video RTP arriving but
          // undecodable" (codec/B-frames) from "nothing arriving at all"
          // (bridge/candidate), so the paste tells us which side to fix.
          let diag = ''
          try {
            const stats = await pc.getStats()
            let vBytes = 0,
              vFrames: number | string = '-',
              aBytes = 0
            stats.forEach((r) => {
              const x = r as unknown as Record<string, unknown>
              if (x.type !== 'inbound-rtp') return
              if (x.kind === 'video') {
                vBytes = Number(x.bytesReceived ?? 0)
                vFrames = Number(x.framesDecoded ?? 0)
              }
              if (x.kind === 'audio') aBytes = Number(x.bytesReceived ?? 0)
            })
            diag = ` [recv: video ${vBytes}B/${vFrames}f, audio ${aBytes}B]`
          } catch {
            /* stats unavailable */
          }
          fail(
            'connected but no video frames' +
              diag +
              ' — if video bytes flow with 0 frames decoded, the publisher uses B-frames: set bf=0 in OBS (Output → Advanced → x264 options) and keyframe interval 2s; if nothing arrives, the node is still bridging — retry',
            a,
          )
        }, FIRST_FRAME_TIMEOUT_MS)
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
        <Badge
          :variant="
            status === 'playing'
              ? 'success'
              : status === 'loading'
                ? 'warning'
                : status === 'error'
                  ? 'destructive'
                  : 'secondary'
          "
        >
          {{
            status === 'playing'
              ? 'Playing · WebRTC'
              : status === 'loading'
                ? 'Connecting…'
                : status === 'error'
                  ? 'Error'
                  : 'Idle'
          }}
        </Badge>
        <Button v-if="status === 'error'" size="sm" variant="outline" class="ml-auto" @click="startWebrtc"
          >Retry</Button
        >
      </div>
      <video ref="videoEl" class="w-full aspect-video rounded-lg bg-black" autoplay muted playsinline controls />
      <Badge v-if="errorMsg" variant="destructive">{{ errorMsg }}</Badge>
      <p class="text-xs text-muted-foreground">
        Media flows directly from the ingest node over UDP (WebRTC); the connection setup is authorized by your session.
        Playback needs UDP open to the node's host.
      </p>
    </CardContent>
  </Card>
</template>

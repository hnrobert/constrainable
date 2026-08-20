<script setup lang="ts">
/**
 * Grid (tile) view of live sessions. Hovering a tile lazily starts a live
 * WebRTC player in it; leaving tears it down. "Play all" mounts players on
 * every tile of the current page at once (heavy — that's the point).
 * Posters are captured CLIENT-SIDE from the played video (canvas snapshot,
 * cached per stream) — there is no server-side frame endpoint; before a
 * stream has been played once the tile shows just its status badge.
 * Pagination, per-row tile count and sorting are owned by the page and passed
 * down as precomputed props.
 */
import type { SessionSnapshot } from '#shared/events'

const props = defineProps<{
  /** already filtered/sorted/paginated by the page */
  page: SessionSnapshot[]
}>()
const emit = defineEmits<{ watch: [streamName: string] }>()

const tileRefs = new Map<string, HTMLVideoElement | null>()
/** lifecycle: a pc exists for the tile */
const playing = ref<Set<string>>(new Set())
/** honest playback: the tile video goes opaque only once a frame is DECODED —
 *  before that the snapshot poster stays visible instead of a black box
 *  (SRS's lazy rtmp→rtc bridge + keyframe wait can delay frames by seconds) */
const framed = ref<Set<string>>(new Set())
/** last captured frame per stream (JPEG data URL) — the tile poster */
const posters = ref(new Map<string, string>())

/** Draw the tile's current video frame to a canvas → cached JPEG poster. */
function capturePoster(name: string): void {
  const video = tileRefs.get(name)
  if (!video || video.videoWidth === 0) return
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d')?.drawImage(video, 0, 0)
  posters.value.set(name, canvas.toDataURL('image/jpeg', 0.72))
}
const playAll = ref(false)
const players = new Map<string, RTCPeerConnection>()

async function startTile(name: string) {
  if (playing.value.has(name)) return
  const video = tileRefs.get(name)
  if (!video) return
  playing.value.add(name)
  try {
    const urls = await $fetch<{ whep: string; iceServers: IceServer[] }>('/api/streams/url', {
      params: { streamName: name },
    })
    const pc = new RTCPeerConnection({ iceServers: urls.iceServers ?? [] })
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    let merged: MediaStream | null = null
    pc.ontrack = (e) => {
      // no-msid SRS answers → merge tracks locally so the video renders
      merged ??= new MediaStream()
      merged.addTrack(e.track)
      video.srcObject = merged
      video.play().catch(() => {})
    }
    video.addEventListener('resize', () => {
      if (video.videoWidth > 0) {
        framed.value.add(name)
        capturePoster(name)
      }
    }, { once: true })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const resp = await fetch(urls.whep, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp' },
      body: offer.sdp,
    })
    if (!resp.ok) throw new Error(`WHEP ${resp.status}`)
    const answer = await resp.text()
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
    players.set(name, pc)
  } catch {
    stopTile(name)
  }
}

function stopTile(name: string) {
  capturePoster(name) // keep the last real frame as the poster
  playing.value.delete(name)
  framed.value.delete(name)
  const p = players.get(name)
  if (p) {
    try {
      p.getSenders().forEach((s) => s.track?.stop())
      p.close()
    } catch {
      /* ignore */
    }
    players.delete(name)
  }
  const video = tileRefs.get(name)
  if (video) video.srcObject = null
}

function onEnter(name: string) {
  if (playAll.value) return
  startTile(name)
}
function onLeave(name: string) {
  if (playAll.value) return
  stopTile(name)
}

function togglePlayAll() {
  playAll.value = !playAll.value
  if (playAll.value) {
    for (const s of props.page) startTile(s.streamName)
  } else {
    for (const name of [...players.keys()]) stopTile(name)
  }
}

// page turned / playAll enabled later: mount players for visible tiles
watch(
  () => props.page,
  (pg) => {
    if (!playAll.value) return
    const visible = new Set(pg.map((s) => s.streamName))
    for (const name of [...players.keys()]) if (!visible.has(name)) stopTile(name)
    for (const s of pg) startTile(s.streamName)
  },
  { deep: true },
)

onBeforeUnmount(() => {
  for (const name of [...players.keys()]) stopTile(name)
})

const statusVariant: Record<string, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  pending: 'secondary',
  allowed: 'warning',
  compliant: 'success',
  violating: 'destructive',
}
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        Hover a tile to play it live; the poster is the stream's latest frame.
      </p>
      <Button size="sm" :variant="playAll ? 'default' : 'outline'" @click="togglePlayAll">
        {{ playAll ? 'Stop all' : 'Play all (this page)' }}
      </Button>
    </div>
    <div class="grid gap-3" :style="{ gridTemplateColumns: `repeat(var(--tiles-per-row), minmax(0, 1fr))` }">
      <div
        v-for="s in page"
        :key="s.sessionId"
        class="group overflow-hidden rounded-lg border bg-card"
        @mouseenter="onEnter(s.streamName)"
        @mouseleave="onLeave(s.streamName)"
      >
        <div class="relative aspect-video bg-black">
          <img
            v-if="posters.get(s.streamName)"
            :src="posters.get(s.streamName)"
            :alt="s.streamName"
            class="absolute inset-0 size-full object-contain"
          />
          <video
            :ref="(el) => tileRefs.set(s.streamName, el as HTMLVideoElement | null)"
            class="absolute inset-0 size-full object-contain"
            :class="framed.has(s.streamName) ? 'opacity-100' : 'opacity-0'"
            autoplay
            muted
            playsinline
          />
          <Badge
            v-if="statusVariant[s.status]"
            :variant="statusVariant[s.status]"
            class="absolute left-2 top-2"
          >
            {{ s.status }}
          </Badge>
        </div>
        <div class="flex items-center justify-between gap-2 px-2.5 py-2">
          <div class="min-w-0">
            <p class="truncate font-medium">{{ s.streamName }}</p>
            <p class="text-xs text-muted-foreground">
              {{ s.width && s.height ? `${s.width}×${s.height}` : '—' }} ·
              {{ s.bitrateKbps != null ? `${s.bitrateKbps} kbps` : '—' }} ·
              {{ new Date(s.startedAt).toLocaleTimeString('en-US', { hour12: false }) }}
            </p>
          </div>
          <Button size="sm" variant="outline" @click="emit('watch', s.streamName)">Open</Button>
        </div>
      </div>
    </div>
  </div>
</template>

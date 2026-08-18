<script setup lang="ts">
/**
 * Grid (tile) view of live sessions. Each tile shows the stream's LATEST FRAME
 * (snapshot JPEG) on mount; hovering a tile lazily starts a live FLV player in
 * it, leaving tears it down. "Play all" mounts players on every tile of the
 * current page at once (heavy — that's the point). Pagination, per-row tile
 * count and sorting are owned by the page and passed down as precomputed props.
 */
import type mpegtsTypes from 'mpegts.js'
import type { SessionSnapshot } from '#shared/events'

const props = defineProps<{
  /** already filtered/sorted/paginated by the page */
  page: SessionSnapshot[]
}>()
const emit = defineEmits<{ watch: [streamName: string] }>()

const tileRefs = new Map<string, HTMLVideoElement | null>()
const playing = ref<Set<string>>(new Set())
const playAll = ref(false)
const players = new Map<string, mpegtsTypes.Player>()

async function startTile(name: string) {
  if (playing.value.has(name)) return
  const video = tileRefs.get(name)
  if (!video) return
  playing.value.add(name)
  try {
    const mpegts = (await import('mpegts.js')).default
    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: `/api/streams/live/${encodeURIComponent(name)}` },
      { enableStashBuffer: false, stashInitialSize: 128 },
    )
    player.attachMediaElement(video)
    player.load()
    await Promise.resolve(player.play()).catch(() => {})
    players.set(name, player)
  } catch {
    stopTile(name)
  }
}

function stopTile(name: string) {
  playing.value.delete(name)
  const p = players.get(name)
  if (p) {
    try {
      p.pause()
      p.unload()
      p.detachMediaElement()
      p.destroy()
    } catch {
      /* ignore */
    }
    players.delete(name)
  }
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

function snapshotUrl(name: string): string {
  return `/api/streams/live/${encodeURIComponent(name)}/snapshot?ts=${Date.now()}`
}

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
            :src="snapshotUrl(s.streamName)"
            :alt="s.streamName"
            class="absolute inset-0 size-full object-contain"
            loading="lazy"
            @error="($event.target as HTMLImageElement).style.opacity = '0'"
          />
          <video
            :ref="(el) => tileRefs.set(s.streamName, el as HTMLVideoElement | null)"
            class="absolute inset-0 size-full object-contain"
            :class="playing.has(s.streamName) ? 'opacity-100' : 'opacity-0'"
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

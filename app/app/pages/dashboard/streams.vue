<script setup lang="ts">
import type { SessionSnapshot, ViolationSnapshot, RecordingSnapshot } from '#shared/events'
import type { EventView } from '#shared/event-view'
const toast = useToast()

// seed from the API (SSR), then live-update over the socket
const { data } = useFetch<SessionSnapshot[]>('/api/streams')
const { data: events } = useFetch<EventView[]>('/api/events')

const sessions = ref<Map<number, SessionSnapshot>>(new Map())
const connected = ref(false)
const lastViolation = ref<ViolationSnapshot | null>(null)
const watching = ref<string | null>(null)
const manualStream = ref('')

function watchStream(name: string): void {
  watching.value = name.trim() || null
}

const list = computed(() => [...sessions.value.values()].sort((a, b) => b.startedAt - a.startedAt))
const eventLabels = computed<Record<number, string>>(() =>
  Object.fromEntries((events.value ?? []).map((e) => [e.id, e.name])),
)

function upsert(s: SessionSnapshot): void {
  sessions.value.set(s.sessionId, s)
}

onMounted(() => {
  if (data.value) for (const s of data.value) sessions.value.set(s.sessionId, s)

  const socket = useSocket()
  socket.on('connect', () => (connected.value = true))
  socket.on('disconnect', () => (connected.value = false))
  socket.on('session:start', (s: SessionSnapshot) => upsert(s))
  socket.on('session:metric', (s: SessionSnapshot) => upsert(s))
  socket.on('session:violation', (s: ViolationSnapshot) => {
    upsert(s)
    lastViolation.value = s
    toast.error(`Violation: ${s.streamName} (${s.reasons.join('; ')})`)
  })
  socket.on('session:stop', (s: SessionSnapshot) => {
    sessions.value.delete(s.sessionId)
  })
  socket.on('recording:ready', (r: RecordingSnapshot) => toast.success(`Recording ready: ${r.streamName}`))
  socket.on('config:changed', () => toast.info('Runtime config hot-reloaded'))
})

onBeforeUnmount(() => disposeSocket())

// ---- view + grid controls ----
type ViewMode = 'list' | 'grid'
const view = ref<ViewMode>('list')
const perRow = ref(4)
const pageSize = ref(12)
const sortBy = ref<'newest' | 'oldest' | 'user-asc' | 'user-desc'>('newest')
const pageNo = ref(1)

const sorted = computed(() => {
  const arr = [...list.value]
  switch (sortBy.value) {
    case 'oldest':
      return arr.sort((a, b) => a.startedAt - b.startedAt)
    case 'user-asc':
      return arr.sort((a, b) => a.streamName.localeCompare(b.streamName))
    case 'user-desc':
      return arr.sort((a, b) => b.streamName.localeCompare(a.streamName))
    default:
      return arr.sort((a, b) => b.startedAt - a.startedAt)
  }
})
const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize.value)))
const gridPage = computed(() => {
  const clamped = Math.min(pageNo.value, totalPages.value)
  return sorted.value.slice((clamped - 1) * pageSize.value, clamped * pageSize.value)
})
watch([pageSize, sortBy], () => (pageNo.value = 1))
</script>

<template>
  <div class="space-y-6" :style="{ '--tiles-per-row': perRow }">
    <div class="flex items-start justify-between gap-3">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold">Live Streams</h1>
        <p class="text-muted-foreground">Active sessions and real-time metrics with instant violation alerts.</p>
      </div>
      <Badge :variant="connected ? 'success' : 'warning'">
        {{ connected ? '● Connected' : '○ Connecting…' }}
      </Badge>
    </div>

    <!-- view toggle + grid controls -->
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="flex rounded-md border p-0.5">
        <Button size="sm" :variant="view === 'list' ? 'default' : 'ghost'" @click="view = 'list'">List</Button>
        <Button size="sm" :variant="view === 'grid' ? 'default' : 'ghost'" @click="view = 'grid'">Grid</Button>
      </div>
      <template v-if="view === 'grid'">
        <div class="flex items-center gap-1.5 text-sm">
          <span class="text-muted-foreground">Per row</span>
          <Select v-model.number="perRow">
            <SelectTrigger class="w-20"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="n in [2, 3, 4, 6]" :key="n" :value="n">{{ n }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-1.5 text-sm">
          <span class="text-muted-foreground">Per page</span>
          <Input v-model.number="pageSize" type="number" min="1" max="48" class="w-20" />
        </div>
        <div class="flex items-center gap-1.5 text-sm">
          <span class="text-muted-foreground">Sort</span>
          <Select v-model="sortBy">
            <SelectTrigger class="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Started: newest first</SelectItem>
              <SelectItem value="oldest">Started: oldest first</SelectItem>
              <SelectItem value="user-asc">User: A → Z</SelectItem>
              <SelectItem value="user-desc">User: Z → A</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Button size="sm" variant="outline" :disabled="pageNo <= 1" @click="pageNo--">‹</Button>
          {{ Math.min(pageNo, totalPages) }} / {{ totalPages }}
          <Button size="sm" variant="outline" :disabled="pageNo >= totalPages" @click="pageNo++">›</Button>
        </div>
      </template>
    </div>

    <Card v-if="view === 'list'">
      <CardContent>
        <StreamsActiveTable :sessions="list" :event-labels="eventLabels" @watch="watchStream" />
      </CardContent>
    </Card>

    <Card v-else>
      <CardContent>
        <StreamsGrid :page="gridPage" @watch="watchStream" />
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Watch Live</CardTitle>
        <CardDescription>
          Click "Watch" in the table above, or enter a stream name to play manually. The browser connects directly to
          SRS.
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <Input
            v-model="manualStream"
            placeholder="Stream name"
            class="max-w-[320px]"
            @keyup.enter="watchStream(manualStream)"
          />
          <Button @click="watchStream(manualStream)">Play</Button>
          <Button v-if="watching" variant="outline" @click="watching = null">Close</Button>
        </div>
        <StreamsPlayer v-if="watching" :stream-name="watching" />
      </CardContent>
    </Card>

    <Card v-if="lastViolation" class="border-destructive">
      <CardContent class="text-sm">
        <strong>Last violation:</strong>
        {{ lastViolation.streamName }} —
        {{ lastViolation.reasons.join('; ') }}
        <span class="text-muted-foreground"
          >({{ new Date(lastViolation.startedAt).toLocaleTimeString('en-US', { hour12: false }) }})</span
        >
      </CardContent>
    </Card>
  </div>
</template>

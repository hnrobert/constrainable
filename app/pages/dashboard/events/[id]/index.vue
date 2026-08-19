<script setup lang="ts">
/**
 * Overview tab — the event's "README": the admin's announcement (streamGuide)
 * pinned on top, then the OBS connection tutorial (same data the public /e/<slug>
 * guide shows: server, event key, account authentication, output limits).
 */
import type { EventView } from '#shared/event-view'
import type { EventGuide } from '#shared/event-view'

const route = useRoute()
const id = Number(route.params.id)
const toast = useToast()
const { user } = useAuth()
const email = computed(() => user.value?.email ?? null)

const { data: event } = useFetch<EventView>(`/api/events/${id}`)
const slug = computed(() => event.value?.slug ?? '')
const { data: guide } = useFetch<EventGuide>(
  () => `/api/events/slug/${slug.value}/guide`,
)

async function copy(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('Copy failed, please copy manually')
  }
}

const liveCount = ref<number | null>(null)
onMounted(async () => {
  try {
    const streams = await $fetch<{ sessionId: number }[]>('/api/streams', {
      params: { eventId: id },
    })
    liveCount.value = streams.length
  } catch {
    /* transient */
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- quick facts row -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Live now</p>
          <p class="text-2xl font-semibold">{{ liveCount ?? '…' }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Event key</p>
          <p class="mt-1 break-all font-mono text-sm font-semibold">{{ event?.slug }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Recording</p>
          <p class="text-2xl font-semibold">{{ event?.recordEnabled ? 'On' : 'Off' }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="p-4">
          <p class="text-xs text-muted-foreground">Auth required</p>
          <p class="text-2xl font-semibold">{{ event?.requireAccountAuth ? 'Yes' : 'No' }}</p>
        </CardContent>
      </Card>
    </div>

    <!-- admin announcement -->
    <Card v-if="event?.streamGuide" class="border-primary/40">
      <CardHeader>
        <CardTitle>Announcement</CardTitle>
        <CardDescription>Posted by the organizer</CardDescription>
      </CardHeader>
      <CardContent>
        <RichText :source="event.streamGuide" />
      </CardContent>
    </Card>

    <!-- connection tutorial -->
    <template v-if="guide">
      <Card>
        <CardHeader>
          <CardTitle>OBS connection</CardTitle>
          <CardDescription>Same instructions as the participant guide (/e/{{ slug }}).</CardDescription>
          <CardAction>
            <Button as-child variant="outline" size="sm">
              <NuxtLink :to="`/dashboard/events/${id}/manual`">Full manual (with screenshots)</NuxtLink>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-1.5">
            <Label>Server</Label>
            <div class="flex items-center gap-2">
              <code class="font-mono text-sm">{{ guide.server }}</code>
              <Button variant="link" class="h-auto p-0 text-xs" @click="copy(guide.server, 'Copied server address')">Copy</Button>
            </div>
          </div>
          <div class="space-y-1.5">
            <Label>Stream key (the event key)</Label>
            <div class="flex flex-wrap items-center gap-2">
              <code class="break-all font-mono text-sm">{{ guide.publishKey }}</code>
              <Button variant="link" class="h-auto p-0 text-xs" @click="copy(guide.publishKey ?? '', 'Copied stream key')">Copy</Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Paste the key as-is — the server identifies you automatically by your OBS sign-in.
            </p>
          </div>
          <div class="space-y-1.5">
            <Label>Username / Password</Label>
            <p class="text-sm text-muted-foreground">
              In <strong>Settings → Stream</strong> turn on <strong>Use authentication</strong> and enter your
              account email (<code class="font-mono">{{ email ?? '<your-account-email>' }}</code>) and website
              password. The password is never sent in plain text — OBS proves it via a challenge-response.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recommended output settings</CardTitle></CardHeader>
        <CardContent>
          <ul class="space-y-1.5 text-sm text-muted-foreground">
            <li>Resolution: up to <code>{{ guide.limits.maxWidth }}×{{ guide.limits.maxHeight }}</code></li>
            <li>Frame rate: up to <code>{{ guide.limits.maxFps }} fps</code></li>
            <li>Video bitrate: up to <code>{{ guide.limits.maxBitrateKbps }} kbps</code></li>
          </ul>
          <p class="mt-3 text-xs text-muted-foreground">
            Streams above these caps are flagged and may be disconnected.
          </p>
        </CardContent>
      </Card>

      <Card v-if="guide.startsAt || guide.endsAt">
        <CardHeader><CardTitle>When you can stream</CardTitle></CardHeader>
        <CardContent class="space-y-1 text-sm text-muted-foreground">
          <p v-if="guide.startsAt">Opens: {{ new Date(guide.startsAt).toLocaleString('en-US', { hour12: false }) }}</p>
          <p v-if="guide.endsAt">Closes: {{ new Date(guide.endsAt).toLocaleString('en-US', { hour12: false }) }}</p>
        </CardContent>
      </Card>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * Participant push-streaming guide for one event, keyed by slug — the quick
 * reference. The full illustrated walkthrough lives one level down at
 * /e/<slug>/manual. Identical for every viewer of the same event. The
 * organizer's shared publish key IS the OBS stream key — no username prefix.
 * The RTMP gateway derives each publisher's stream name (their account email
 * when authenticated, else the connection IP), so the whole class streams
 * concurrently with one shared key. The server address shown comes from
 * useObsConfig() — it follows the viewer's assigned ingest node and its public
 * RTMP port (1935 omitted), so it can differ between participants.
 */
import type { EventGuide } from '#shared/event-view'

definePageMeta({ layout: 'public' })

const route = useRoute()
const slug = computed(() => String(route.params.slug ?? ''))
const { user } = useAuth()
const toast = useToast()

// Node/port-aware RTMP address (assigned node → its public port; 1935 omitted).
const { server } = useObsConfig()

// No top-level await: keeps this a sync component (avoids the Suspense/hydration
// pitfall documented on pages/index.vue / dashboard/events/[id].vue).
const { data: guide, error: fetchError } = useFetch<EventGuide>(
  () => `/api/events/slug/${slug.value}/guide`,
)

const statusCode = computed(
  () => (fetchError.value as { statusCode?: number } | null)?.statusCode,
)
const notFound = computed(() => statusCode.value === 404)
const unauthorized = computed(() => statusCode.value === 403)

// Retired key (event renamed) → swap the URL to the event's current key.
// The alias dies server-side once a new event claims this key.
watch(
  () => (guide.value as { redirectTo?: string | null } | null)?.redirectTo,
  (to) => {
    if (to) navigateTo(`/e/${to}`, { replace: true })
  },
  { immediate: true },
)

const publishKey = computed(() => guide.value?.publishKey ?? null)
const email = computed(() => user.value?.email ?? null)
const requireAuth = computed(() => guide.value?.requireAccountAuth ?? true)

async function copy(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('Copy failed, please copy manually')
  }
}

function fmt(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString() : ''
}
</script>

<template>
  <div class="space-y-6">
    <!-- not found / draft / archived -->
    <Card v-if="notFound">
      <CardHeader><CardTitle>Event not found</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <p class="text-sm text-muted-foreground">This event doesn't exist or isn't available.</p>
        <Button as-child variant="link" class="h-auto p-0"><NuxtLink to="/">Back to home</NuxtLink></Button>
      </CardContent>
    </Card>

    <!-- registered/groups event the viewer can't see -->
    <Card v-else-if="unauthorized">
      <CardHeader><CardTitle>Sign in required</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <p class="text-sm text-muted-foreground">
          You need to sign in to view this event's streaming guide.
        </p>
        <Button as-child><NuxtLink to="/login">Sign in</NuxtLink></Button>
      </CardContent>
    </Card>

    <template v-else-if="guide">
      <div class="space-y-1">
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Push-streaming guide
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">{{ guide.name }}</h1>
        <p class="text-sm text-muted-foreground">
          Quick reference for connecting your streaming software.
          <NuxtLink
            :to="`/e/${slug}/manual`"
            class="font-medium underline underline-offset-2 hover:text-foreground"
          >
            New to this? Read the full step-by-step manual with screenshots →
          </NuxtLink>
        </p>
      </div>

      <!-- organizer hasn't published a key yet -->
      <Card v-if="!publishKey">
        <CardContent class="pt-6 text-sm text-muted-foreground">
          The organizer hasn't published a stream key for this event yet. Check back later.
        </CardContent>
      </Card>

      <template v-else>
        <!-- OBS connection -->
        <Card>
          <CardHeader><CardTitle>OBS connection</CardTitle></CardHeader>
          <CardContent class="space-y-4">
            <div class="space-y-1.5">
              <Label>Server</Label>
              <div class="flex items-center gap-2">
                <code class="font-mono text-sm">{{ server }}</code>
                <Button variant="link" class="h-auto p-0 text-xs" @click="copy(server, 'Copied server address')">Copy</Button>
              </div>
              <p class="text-xs text-muted-foreground">
                Derived from the ingest server assigned to you — it can differ from other
                participants, so copy it from here rather than a screenshot.
              </p>
            </div>

            <div class="space-y-1.5">
              <Label>Stream key</Label>
              <div class="flex flex-wrap items-center gap-2">
                <code class="break-all font-mono text-sm">{{ publishKey }}</code>
                <Button variant="link" class="h-auto p-0 text-xs" @click="copy(publishKey ?? '', 'Copied stream key')">Copy</Button>
              </div>
              <p class="text-xs text-muted-foreground">
                Paste the key as-is — the server identifies you automatically (by your OBS sign-in when
                authentication is enabled for this event).
              </p>
            </div>
          </CardContent>
        </Card>

        <!-- OBS authentication — only events with requireAccountAuth need real
             account credentials; others pass the challenge without them -->
        <Card v-if="requireAuth">
          <CardHeader><CardTitle>OBS authentication</CardTitle></CardHeader>
          <CardContent class="space-y-3">
            <p class="text-sm text-muted-foreground">
              The server challenges every publisher, so <strong>Use authentication</strong> in
              <strong>Settings → Stream</strong> must be ON:
            </p>
            <div class="space-y-1.5">
              <Label>Username</Label>
              <div class="flex items-center gap-2">
                <code class="font-mono text-sm">{{ email ?? '<your-account-email>' }}</code>
                <Button v-if="email" variant="link" class="h-auto p-0 text-xs" @click="copy(email ?? '', 'Copied username')">Copy</Button>
              </div>
              <p class="text-xs text-muted-foreground">Your account email.</p>
            </div>
            <div class="space-y-1.5">
              <Label>Password</Label>
              <p class="text-sm text-muted-foreground">
                Your website login password. It is never sent in plain text — OBS proves it
                to the server through a challenge-response.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card v-else>
          <CardHeader><CardTitle>OBS authentication</CardTitle></CardHeader>
          <CardContent>
            <p class="text-sm text-muted-foreground">
              Not required for this event — leave <strong>Use authentication</strong> off and use
              just the server address and stream key above.
            </p>
          </CardContent>
        </Card>

        <!-- recommended output settings -->
        <Card>
          <CardHeader><CardTitle>Recommended output settings</CardTitle></CardHeader>
          <CardContent>
            <ul class="space-y-1.5 text-sm text-muted-foreground">
              <li>Resolution: up to <code>{{ guide.limits.maxWidth }}×{{ guide.limits.maxHeight }}</code></li>
              <li>Frame rate: up to <code>{{ guide.limits.maxFps }} fps</code></li>
              <li>Video bitrate: up to <code>{{ guide.limits.maxBitrateKbps }} kbps</code></li>
            </ul>
            <p class="mt-3 text-xs text-muted-foreground">
              Streams that exceed these limits are flagged and may be disconnected. Set your canvas FPS to
              at least 2 (30 recommended) — a 1 FPS canvas fails to connect.
            </p>
          </CardContent>
        </Card>

        <!-- time window -->
        <Card v-if="guide.startsAt || guide.endsAt">
          <CardHeader><CardTitle>When you can stream</CardTitle></CardHeader>
          <CardContent class="space-y-1 text-sm text-muted-foreground">
            <p v-if="guide.startsAt">Opens: {{ fmt(guide.startsAt) }}</p>
            <p v-if="guide.endsAt">Closes: {{ fmt(guide.endsAt) }}</p>
            <p class="pt-1 text-xs">Publishing is rejected outside this window.</p>
          </CardContent>
        </Card>

        <!-- organizer's custom instructions -->
        <Card v-if="guide.streamGuide">
          <CardHeader><CardTitle>Notes from the organizer</CardTitle></CardHeader>
          <CardContent>
            <p class="whitespace-pre-wrap text-sm">{{ guide.streamGuide }}</p>
          </CardContent>
        </Card>

        <!-- step by step -->
        <Card>
          <CardHeader><CardTitle>Setup steps (OBS Studio)</CardTitle></CardHeader>
          <CardContent>
            <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Open OBS Studio → <strong>Settings → Stream</strong>.</li>
              <li>Set <strong>Service</strong> to <em>Custom…</em> and paste the <strong>Server</strong> above.</li>
              <li>Paste the <strong>Stream key</strong> above.</li>
              <li v-if="requireAuth">
                Turn on <strong>Use authentication</strong> and enter your <strong>account email</strong>
                and <strong>website password</strong> — see the OBS authentication card.
              </li>
              <li>In <strong>Settings → Video / Output</strong>, keep resolution, FPS, and bitrate within the recommended values.</li>
              <li>Click <strong>Start Streaming</strong>. Your stream appears once it connects.</li>
            </ol>
            <p class="mt-3 text-xs text-muted-foreground">
              Never installed OBS or prefer screenshots for every click? Open the
              <NuxtLink :to="`/e/${slug}/manual`" class="underline underline-offset-2">full streaming manual</NuxtLink>.
              Events with sign-in need a client that supports RTMP authentication — plain
              command-line tools (e.g. stock ffmpeg) don't.
            </p>
          </CardContent>
        </Card>
      </template>
    </template>
  </div>
</template>

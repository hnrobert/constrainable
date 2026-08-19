<script setup lang="ts">
/**
 * Manual tab — the full step-by-step streaming tutorial for this event: the
 * web version of the organizer's OBS handout. Generic by design: every
 * connection value (RTMP server, stream key, account sign-in, output caps,
 * streaming window) is derived from THIS event, so the same page serves any
 * event on any ingest topology. The RTMP server comes from useObsConfig() —
 * it follows the viewer's assigned media node and its public RTMP port, and a
 * 1935 port is omitted (`rtmp://host/live`), so the address may differ from
 * other participants' or change between events; the page always shows the
 * authoritative one.
 *
 * The tutorial is paginated (?page=N, browser back/forward works) with AT
 * MOST TWO screenshots per page — see ANCHORS for the section → page map the
 * chips and inline links jump through. The tutorial renders even while the
 * event is a draft — only the shared stream key needs the event to be live
 * (the slug guide endpoint 404s drafts), degrading to a "not published yet"
 * note.
 */
import type { EventView, EventGuide } from '#shared/event-view'

const route = useRoute()
const router = useRouter()
const id = Number(route.params.id)
const { user } = useAuth()
const toast = useToast()

const { data: event } = useFetch<EventView>(`/api/events/${id}`)
const slug = computed(() => event.value?.slug ?? '')
// 404s for draft/archived events — sections depending on it degrade gracefully.
const { data: guide } = useFetch<EventGuide>(
  () => `/api/events/slug/${slug.value}/guide`,
)

// Node/port-aware RTMP address (assigned node → its public port; 1935 omitted).
const { server } = useObsConfig()

const publishKey = computed(() => guide.value?.publishKey ?? null)
const email = computed(() => user.value?.email ?? null)
const requireAuth = computed(() => event.value?.requireAccountAuth ?? true)
const limits = computed(
  () =>
    guide.value?.limits ?? {
      maxWidth: 1920,
      maxHeight: 1080,
      maxFps: 60,
      maxBitrateKbps: 6000,
    },
)
const startsAt = computed(() => event.value?.startsAt ?? null)
const endsAt = computed(() => event.value?.endsAt ?? null)

/* ------------------------------ pagination ------------------------------- */
// Page map (≤ 2 screenshots each): 1 values/overview · 2 install · 3 capture
// 1–2 · 4 capture 3–done · 5 volume + open settings · 6 stream + output ·
// 7 video + apply · 8 other software + going live + troubleshooting.
const PAGE_COUNT = 8

const ANCHORS: Record<string, number> = {
  values: 1,
  install: 2,
  capture: 3,
  'capture-b': 4,
  volume: 5,
  settings: 5,
  'settings-b': 6,
  'settings-c': 7,
  'other-software': 8,
  'go-live': 8,
  troubleshooting: 8,
}

const page = computed({
  get: () => {
    const n = Number(route.query.page)
    return Number.isInteger(n) && n >= 1 && n <= PAGE_COUNT ? n : 1
  },
  set: (n) => {
    void router.push({ query: pageQuery(n) })
  },
})

function pageQuery(n: number): Record<string, string | undefined> {
  // `page: undefined` DROPS the key — a spread alone would keep the old value
  // and a jump back to page 1 would silently no-op.
  return { ...route.query, page: n > 1 ? String(n) : undefined }
}

/** Prev/Next — swap the page and start reading from the top. */
async function go(n: number): Promise<void> {
  if (n < 1 || n > PAGE_COUNT || n === page.value) return
  await router.push({ query: pageQuery(n) })
  window.scrollTo({ top: 0 })
}

/** Chip / inline link — flip to the page holding the anchor, then scroll to it. */
async function jump(anchor: string): Promise<void> {
  const target = ANCHORS[anchor] ?? 1
  if (target !== page.value) await router.push({ query: pageQuery(target) })
  await nextTick()
  document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

// The chips are the pages — exactly one per page, in order (they use go(), not
// jump(): a chip IS a page, so it lands on the page top like Prev/Next).
const sections = [
  { page: 1, label: 'Your values' },
  { page: 2, label: '1 · Install' },
  { page: 3, label: '2 · Capture (1/2)' },
  { page: 4, label: '2 · Capture (2/2)' },
  { page: 5, label: '3 · Volume' },
  { page: 6, label: '4 · Stream / Output' },
  { page: 7, label: '4 · Video / Apply' },
  { page: 8, label: '5 · Going live' },
]

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
  <div v-if="event" class="space-y-6">
    <!-- page chips — one per page, in reading order; clicking lands on the page
         top (same behavior as Prev/Next) -->
    <nav class="flex flex-wrap gap-2" aria-label="Manual pages">
      <button
        v-for="s in sections"
        :key="s.page"
        type="button"
        class="rounded-full border px-3 py-1 text-xs transition-colors"
        :class="
          s.page === page
            ? 'border-primary/60 text-foreground'
            : 'text-muted-foreground hover:border-primary/50 hover:text-foreground'
        "
        @click="go(s.page)"
      >
        {{ s.label }}
      </button>
    </nav>

    <!-- ================ PAGE 1 · values + overview (0 screenshots) ================ -->
    <template v-if="page === 1">
      <!-- intro -->
      <div class="space-y-1">
        <p class="text-sm text-muted-foreground">
          Hand this to everyone who will stream for <strong>{{ event.name }}</strong> — it walks
          them through setting up their streaming software step by step, each step with a
          screenshot to compare against their own screen.
        </p>
        <Button as-child variant="link" class="h-auto p-0 text-sm">
          <NuxtLink :to="`/e/${slug}`" target="_blank">
            Open the public quick reference (/e/{{ slug }}) ↗
          </NuxtLink>
        </Button>
      </div>

      <!-- organizer's custom instructions -->
      <Card v-if="event.streamGuide" class="border-primary/40">
        <CardHeader>
          <CardTitle>Notes from the organizer</CardTitle>
          <CardDescription>Read this first — specifics for {{ event.name }}.</CardDescription>
        </CardHeader>
        <CardContent>
          <RichText :source="event.streamGuide" />
        </CardContent>
      </Card>

      <!-- your connection values -->
      <Card id="values" class="scroll-mt-6">
        <CardHeader>
          <CardTitle>Your connection values</CardTitle>
          <CardDescription>
            Everything the steps refer to. Copy each value exactly — don't retype by hand.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <!-- organizer hasn't published a key yet -->
          <p v-if="!publishKey" class="text-sm text-muted-foreground">
            The organizer hasn't published a stream key for this event yet — the steps are still
            worth reading, but check back later for the key.
          </p>

          <div class="space-y-1.5">
            <Label>Server</Label>
            <div class="flex items-center gap-2">
              <code class="font-mono text-sm">{{ server }}</code>
              <Button variant="link" class="h-auto p-0 text-xs" @click="copy(server, 'Copied server address')">Copy</Button>
            </div>
            <p class="text-xs text-muted-foreground">
              This address follows the ingest server assigned to you — it can differ from other
              participants or change between events, so always copy it from this manual.
            </p>
          </div>

          <div class="space-y-1.5">
            <Label>Stream key</Label>
            <div class="flex flex-wrap items-center gap-2">
              <code v-if="publishKey" class="break-all font-mono text-sm">{{ publishKey }}</code>
              <code v-else class="font-mono text-sm text-muted-foreground">— not published yet —</code>
              <Button
                v-if="publishKey"
                variant="link"
                class="h-auto p-0 text-xs"
                @click="copy(publishKey, 'Copied stream key')"
              >
                Copy
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Shared by everyone streaming to this event. Paste it as-is — the server identifies
              you automatically.
            </p>
          </div>

          <div v-if="requireAuth" class="space-y-1.5">
            <Label>Username</Label>
            <div class="flex items-center gap-2">
              <code class="font-mono text-sm">{{ email ?? '<your-account-email>' }}</code>
              <Button v-if="email" variant="link" class="h-auto p-0 text-xs" @click="copy(email ?? '', 'Copied username')">Copy</Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Your account email on this website — sign in to see yours filled in.
            </p>
          </div>

          <p v-if="requireAuth" class="text-sm text-muted-foreground">
            <strong>Password:</strong> your website login password. It is never sent in plain text —
            your streaming software proves it to the server through a challenge-response.
          </p>
          <p v-else class="text-sm text-muted-foreground">
            This event doesn't require signing in inside your streaming software — leave
            <strong>Use authentication</strong> off and just use the server address and stream key.
          </p>
        </CardContent>
      </Card>

      <!-- overview -->
      <Card>
        <CardHeader>
          <CardTitle>What you will do</CardTitle>
          <CardDescription>
            The setup is done once — afterwards going live is a single click.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li><a href="#install" class="underline underline-offset-2" @click.prevent="jump('install')">Download and install</a> OBS Studio</li>
            <li><a href="#capture" class="underline underline-offset-2" @click.prevent="jump('capture')">Add a Display Capture</a> source so your screen is captured</li>
            <li><a href="#volume" class="underline underline-offset-2" @click.prevent="jump('volume')">Turn up the system volume</a> so audio is captured</li>
            <li><a href="#settings" class="underline underline-offset-2" @click.prevent="jump('settings')">Configure the streaming settings</a> with your connection values</li>
            <li><a href="#go-live" class="underline underline-offset-2" @click.prevent="jump('go-live')">Go live</a> whenever the event window is open</li>
          </ol>
          <p class="mt-3 text-xs text-muted-foreground">
            The manual is split into {{ PAGE_COUNT }} short pages (at most two screenshots each) —
            the chips at the top match the pages one-to-one, or use Next at the bottom. Match your
            screen with each picture — if it looks the same, you are on the right track.
          </p>
        </CardContent>
      </Card>
    </template>

    <!-- ================ PAGE 2 · install (1 screenshot) ================ -->
    <Card v-else-if="page === 2" id="install" class="scroll-mt-6">
      <CardHeader>
        <CardTitle>1 · Download and install OBS Studio</CardTitle>
        <CardDescription>
          From the official website only:
          <a
            href="https://obsproject.com/download"
            target="_blank"
            rel="noopener"
            class="font-medium underline underline-offset-2"
          >https://obsproject.com/download</a>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="grid gap-6 md:grid-cols-2">
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">Windows</h3>
            <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Double-click the downloaded <code>.exe</code> file.</li>
              <li>Follow the installer's instructions and finish the setup.</li>
              <li>Launch <strong>OBS</strong> from the Start menu.</li>
            </ol>
          </div>
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">macOS</h3>
            <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Double-click the downloaded <code>.dmg</code> file to open it.</li>
              <li><strong>Drag the OBS icon</strong> into the <strong>Applications</strong> folder.</li>
              <li>If macOS blocks it: <strong>right-click</strong> the OBS icon and choose <strong>Open</strong>.</li>
            </ol>
          </div>
        </div>

        <!-- Linux on its own FULL-WIDTH row so the command block never needs a
             horizontal scrollbar (a squeezed 1/3 column used to clip it) -->
        <div class="space-y-2">
          <h3 class="text-sm font-semibold">Linux (Ubuntu / Debian)</h3>
          <p class="text-sm text-muted-foreground">Run these commands line by line:</p>
          <pre class="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs leading-relaxed">sudo add-apt-repository ppa:obsproject/obs-studio
sudo apt update
sudo apt install obs-studio</pre>
          <p class="text-sm text-muted-foreground">Start OBS any time by running <code>obs-studio</code>.</p>
        </div>
        <p class="text-xs text-muted-foreground">
          Using Arch or another distribution? Then you are a true system master — you can surely
          figure it out yourself.
        </p>

        <div class="space-y-3">
          <h3 class="text-sm font-semibold">1.2 · Verify the installation</h3>
          <p class="text-sm text-muted-foreground">
            Open OBS. If you see a window similar to this, the installation was
            <strong>successful</strong>:
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/obs_opened.png"
              alt="OBS Studio freshly opened — empty sources, scenes and a preview area"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">OBS successfully opened.</figcaption>
          </figure>
        </div>
      </CardContent>
    </Card>

    <!-- ================ PAGE 3 · display capture, steps 1–2 (2 screenshots) ================ -->
    <Card v-else-if="page === 3" id="capture" class="scroll-mt-6">
      <CardHeader>
        <CardTitle>2 · Add a Display Capture</CardTitle>
        <CardDescription>
          So your streaming software captures your whole screen — steps 1–2 of 4
          (continues on the next page).
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="space-y-3">
          <h3 class="text-sm font-semibold">Step 1</h3>
          <p class="text-sm text-muted-foreground">
            Click the <strong>'+'</strong> button at the bottom-left of the OBS window to add a
            new source.
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/add_source.png"
              alt="The sources panel with its + button highlighted"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Click the + button to add a source.</figcaption>
          </figure>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-semibold">Step 2</h3>
          <p class="text-sm text-muted-foreground">
            In the pop-up menu, choose <strong>Display Capture</strong>, then click
            <strong>Add a new Display Capture</strong>.
          </p>
          <p class="text-xs text-muted-foreground">
            On a non-English system the entry has a translated name (e.g. 屏幕捕获) — pick the one
            that captures the entire display, not a single window.
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/choose_display_capture.png"
              alt="The add-source menu with Display Capture highlighted"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Choose Display Capture.</figcaption>
          </figure>
        </div>
      </CardContent>
    </Card>

    <!-- ================ PAGE 4 · display capture, step 3 + done (2 screenshots) ================ -->
    <Card v-else-if="page === 4" id="capture-b" class="scroll-mt-6">
      <CardHeader>
        <CardTitle>2 · Add a Display Capture <span class="text-muted-foreground">(continued)</span></CardTitle>
        <CardDescription>Steps 3–4 of 4.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="space-y-3">
          <h3 class="text-sm font-semibold">Step 3</h3>
          <p class="text-sm text-muted-foreground">
            In the window that opens, click the <strong>Display</strong> drop-down and select the
            monitor you will use during the event.
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/select_display.png"
              alt="The Display Capture properties with the Display drop-down open"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Select your display.</figcaption>
          </figure>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-semibold">Done</h3>
          <p class="text-sm text-muted-foreground">
            After all the steps above, your OBS window should look like this — the preview shows
            your own screen:
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/display_capture_done.png"
              alt="OBS with a Display Capture source listed and the screen shown in the preview"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Your screen is now captured.</figcaption>
          </figure>
        </div>
      </CardContent>
    </Card>

    <!-- ================ PAGE 5 · volume + open settings (2 screenshots) ================ -->
    <template v-else-if="page === 5">
      <Card id="volume" class="scroll-mt-6">
        <CardHeader>
          <CardTitle>3 · Set the volume</CardTitle>
          <CardDescription>Make sure your system sound is captured.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <ul class="space-y-1.5 text-sm text-muted-foreground">
            <li>Drag the <strong>Desktop Audio</strong> slider upwards.</li>
            <li>(Optional) Do the same for <strong>Mic/Aux</strong>.</li>
          </ul>
          <figure class="space-y-1.5">
            <img
              src="/manual/desktop_volume.png"
              alt="The OBS audio mixer with the Desktop Audio slider being raised"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Turn up the desktop volume.</figcaption>
          </figure>
        </CardContent>
      </Card>

      <Card id="settings" class="scroll-mt-6">
        <CardHeader>
          <CardTitle>4 · Configure the streaming settings</CardTitle>
          <CardDescription>
            Where your connection values get entered — this part runs across the next three pages.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <h3 class="text-sm font-semibold">4.0 · Open Settings</h3>
          <p class="text-sm text-muted-foreground">
            Click the <strong>Settings</strong> button to open the settings window.
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/open_settings.png"
              alt="The OBS toolbar with the Settings button highlighted"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Open the settings window.</figcaption>
          </figure>
        </CardContent>
      </Card>
    </template>

    <!-- ================ PAGE 6 · stream + output (2 screenshots) ================ -->
    <Card v-else-if="page === 6" id="settings-b" class="scroll-mt-6">
      <CardHeader>
        <CardTitle>4 · Configure the streaming settings <span class="text-muted-foreground">(continued)</span></CardTitle>
        <CardDescription>Stream and Output panels.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="space-y-3">
          <h3 class="text-sm font-semibold">4.1 · Stream</h3>
          <p class="text-sm text-muted-foreground">
            Click <strong>Stream</strong> in the left panel, then:
          </p>
          <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Set <strong>Service</strong> to <code>Custom…</code></li>
            <li>
              Paste the <strong>Server</strong>:
              <code class="break-all font-mono text-foreground">{{ server }}</code>
            </li>
            <li>
              Paste the <strong>Stream Key</strong> from
              <a href="#values" class="underline underline-offset-2" @click.prevent="jump('values')">Your connection values</a>
              (page 1).
            </li>
            <li v-if="requireAuth">
              Tick <strong>Use authentication</strong> and enter the <strong>Username</strong>
              (<code class="font-mono">{{ email ?? '<your-account-email>' }}</code>) and your
              website <strong>Password</strong>.
            </li>
          </ol>
          <p v-if="!requireAuth" class="text-sm text-muted-foreground">
            This event doesn't require signing in — leave <strong>Use authentication</strong>
            unticked.
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/stream_settings.png"
              alt="OBS stream settings: Service set to Custom, server and key filled in, Use authentication ticked"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">
              The screenshot shows example values — always use the ones from
              <a href="#values" class="underline underline-offset-2" @click.prevent="jump('values')">Your connection values</a>.
            </figcaption>
          </figure>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-semibold">4.2 · Output</h3>
          <p class="text-sm text-muted-foreground">
            Click <strong>Output</strong> in the left panel, then:
          </p>
          <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Change <strong>Output Mode</strong> to <strong>Advanced</strong>.</li>
            <li>
              Set the <strong>Video Encoder</strong> to <strong>H.264</strong> — every option that
              includes H.264 in its name is suitable.
            </li>
            <li>
              Set the <strong>Bitrate</strong> — up to
              <code>{{ limits.maxBitrateKbps }} kbps</code> for this event.
            </li>
          </ol>
          <figure class="space-y-1.5">
            <img
              src="/manual/output_settings.png"
              alt="OBS output settings in Advanced mode with the x264 encoder and bitrate field"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">
              Example values shown — keep the bitrate at or below
              {{ limits.maxBitrateKbps }} kbps.
            </figcaption>
          </figure>
        </div>
      </CardContent>
    </Card>

    <!-- ================ PAGE 7 · video + apply (2 screenshots) ================ -->
    <Card v-else-if="page === 7" id="settings-c" class="scroll-mt-6">
      <CardHeader>
        <CardTitle>4 · Configure the streaming settings <span class="text-muted-foreground">(continued)</span></CardTitle>
        <CardDescription>Video panel — and the most important step.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-6">
        <div class="space-y-3">
          <h3 class="text-sm font-semibold">4.3 · Video</h3>
          <p class="text-sm text-muted-foreground">
            Click <strong>Video</strong> in the left panel, then:
          </p>
          <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Set the <strong>Output (Scaled) Resolution</strong> — at most
              <code>{{ limits.maxWidth }}×{{ limits.maxHeight }}</code> for this event.
            </li>
            <li>
              Set both <strong>Base (Canvas)</strong> and <strong>Output (Scaled)</strong> FPS —
              at most <code>{{ limits.maxFps }} fps</code>, and at least 2 (30 recommended).
            </li>
          </ol>
          <figure class="space-y-1.5">
            <img
              src="/manual/video_settings.png"
              alt="OBS video settings with base and output resolution and FPS fields"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">
              Example values shown — stay within {{ limits.maxWidth }}×{{ limits.maxHeight }} and
              {{ limits.maxFps }} fps.
            </figcaption>
          </figure>
          <p class="text-xs text-muted-foreground">
            Streams that exceed these limits are flagged and may be disconnected. A 1 FPS canvas
            fails to connect entirely.
          </p>
        </div>

        <div class="space-y-3">
          <h3 class="text-sm font-semibold">The most important step</h3>
          <p class="text-sm text-muted-foreground">
            Click <strong>Apply</strong>, then <strong>OK</strong> — otherwise you will have to
            redo all the settings above!
          </p>
          <figure class="space-y-1.5">
            <img
              src="/manual/apply_ok.png"
              alt="The OBS settings window with Apply and OK highlighted in the bottom-right"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Click Apply, then OK.</figcaption>
          </figure>
        </div>
      </CardContent>
    </Card>

    <!-- ================ PAGE 8 · other software + going live + troubleshooting (1 screenshot) ================ -->
    <template v-else-if="page === 8">
      <Card id="other-software" class="scroll-mt-6">
        <CardHeader>
          <CardTitle>Using other streaming software</CardTitle>
          <CardDescription>
            The steps above use OBS Studio, but any tool that can push to a custom RTMP server
            works — use the same connection values.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>This event's value</TableHead>
                <TableHead>OBS Studio</TableHead>
                <TableHead>Streamlabs Desktop</TableHead>
                <TableHead>Other tools (vMix, PRISM, …)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell class="font-medium">Server</TableCell>
                <TableCell>Settings → Stream → Server</TableCell>
                <TableCell>Stream settings → Custom RTMP → Server URL</TableCell>
                <TableCell>RTMP server / URL / address</TableCell>
              </TableRow>
              <TableRow>
                <TableCell class="font-medium">Stream key</TableCell>
                <TableCell>Settings → Stream → Stream Key</TableCell>
                <TableCell>Stream settings → Custom RTMP → Stream key</TableCell>
                <TableCell>Stream key / name</TableCell>
              </TableRow>
              <TableRow>
                <TableCell class="font-medium">Username</TableCell>
                <TableCell>Use authentication → Username</TableCell>
                <TableCell>Custom RTMP → Username</TableCell>
                <TableCell>User / login</TableCell>
              </TableRow>
              <TableRow>
                <TableCell class="font-medium">Password</TableCell>
                <TableCell>Use authentication → Password</TableCell>
                <TableCell>Custom RTMP → Password</TableCell>
                <TableCell>Password</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          <p class="text-xs text-muted-foreground">
            Events that require sign-in need a client that can answer the server's RTMP
            authentication challenge (OBS Studio, Streamlabs Desktop, vMix, …). Plain
            command-line tools such as stock <code>ffmpeg</code> cannot — they only work for
            events where signing in is not required. Whatever you use, keep the output within the
            limits from step 4 and prefer an H.264 encoder.
          </p>
        </CardContent>
      </Card>

      <Card id="go-live" class="scroll-mt-6">
        <CardHeader>
          <CardTitle>5 · Going live</CardTitle>
          <CardDescription>
            All the settings above are done once. Whenever you stream, all you do is:
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <ol class="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>Open OBS.</li>
            <li>Click the <strong>Start Streaming</strong> button in the bottom-right corner.</li>
            <li>Make sure the status shows <strong>LIVE</strong> — your stream is being received.</li>
          </ol>
          <figure class="space-y-1.5">
            <img
              src="/manual/start_streaming.png"
              alt="The OBS main window with the Start Streaming button in the bottom-right corner"
              class="w-full rounded-lg border"
              loading="lazy"
            />
            <figcaption class="text-xs text-muted-foreground">Click Start Streaming to begin.</figcaption>
          </figure>

          <div v-if="startsAt || endsAt" class="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <p v-if="startsAt"><span class="font-medium text-foreground">Opens:</span> {{ fmt(startsAt) }}</p>
            <p v-if="endsAt"><span class="font-medium text-foreground">Closes:</span> {{ fmt(endsAt) }}</p>
            <p class="pt-1 text-xs">Publishing is rejected outside this window.</p>
          </div>
        </CardContent>
      </Card>

      <Card id="troubleshooting" class="scroll-mt-6">
        <CardHeader><CardTitle>Common issues</CardTitle></CardHeader>
        <CardContent>
          <ul class="space-y-2 text-sm text-muted-foreground">
            <li>
              <span class="font-medium text-foreground">Failed to connect / could not access the server —</span>
              re-copy the
              <a href="#values" class="underline underline-offset-2" @click.prevent="jump('values')">Server address and stream key</a>,
              check the event window above, and (if this event requires sign-in) your account
              email and password.
            </li>
            <li>
              <span class="font-medium text-foreground">Stream flagged or disconnected —</span>
              your resolution, FPS or bitrate is above the event limits; see step 4.2 / 4.3.
            </li>
            <li>
              <span class="font-medium text-foreground">Preview is black —</span>
              make sure the Display Capture source was added and the right monitor selected (step 2).
            </li>
          </ul>
        </CardContent>
      </Card>

      <!-- closing -->
      <Card class="border-primary/40">
        <CardContent class="space-y-1 pt-6 text-center">
          <p class="text-lg font-semibold">You are all set</p>
          <p class="text-sm text-muted-foreground">
            Everything is configured. You are ready to stream for
            <strong>{{ event.name }}</strong>. Good luck!
          </p>
        </CardContent>
      </Card>
    </template>

    <!-- pagination — persistent -->
    <div class="flex items-center justify-between gap-3 border-t pt-4">
      <Button variant="outline" size="sm" :disabled="page === 1" @click="go(page - 1)">
        ← Previous
      </Button>
      <p class="text-xs text-muted-foreground">Page {{ page }} of {{ PAGE_COUNT }}</p>
      <Button variant="outline" size="sm" :disabled="page === PAGE_COUNT" @click="go(page + 1)">
        Next →
      </Button>
    </div>
  </div>
</template>

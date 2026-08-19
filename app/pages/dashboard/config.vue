<script setup lang="ts">
import type { AppConfig } from '#shared/config'

const toast = useToast()

// Sync fetch (NO top-level await) so this page doesn't drag the dashboard
// layout into an async Suspense boundary — that caused a client hydration
// mismatch (server rendered the full layout, client rendered a comment
// placeholder). Nuxt still awaits the registered useFetch promise during SSR
// and serializes the result into the payload; the watch below populates the
// editable form on both server and client once data resolves.
const { data } = useFetch<AppConfig>('/api/config')

// editable copy; re-synced from the server value whenever data resolves.
const form = ref<AppConfig | null>(null)
// flush:'sync' is essential: the watcher must populate `form` at the instant
// `data` is assigned during SSR, before the render pass — the default pre-flush
// queue doesn't drain in time, so the form cards would be absent from server
// HTML (hydration mismatch). On the client, data hydrates from the payload
// synchronously during setup, so this runs before first render there too.
watch(
  data,
  (d) => {
    if (d) form.value = structuredClone(toRaw(d))
  },
  { immediate: true, flush: 'sync' },
)

const saving = ref(false)
const saved = ref(false)

type Kind = 'number' | 'text' | 'select' | 'bool'
interface Field {
  path: string
  label: string
  hint?: string
  kind: Kind
  options?: { value: string; label: string }[]
}
interface Section {
  title: string
  fields: Field[]
}

const sections: Section[] = [
  {
    title: 'Resolution / Framerate / Bitrate Limits',
    fields: [
      { path: 'limits.maxWidth', label: 'Max width (px)', kind: 'number', hint: '0 = no limit' },
      { path: 'limits.maxHeight', label: 'Max height (px)', kind: 'number', hint: '0 = no limit' },
      { path: 'limits.maxFps', label: 'Max framerate (fps)', kind: 'number', hint: '0 = no limit' },
      { path: 'limits.maxBitrateKbps', label: 'Max bitrate (kbps)', kind: 'number', hint: '0 = no limit' },
    ],
  },
  {
    title: 'Probe (ffprobe)',
    fields: [
      { path: 'probe.waitMs', label: 'Wait before first probe (ms)', kind: 'number' },
      { path: 'probe.retries', label: 'Retry count on failure', kind: 'number' },
      { path: 'probe.retryIntervalMs', label: 'Retry interval (ms)', kind: 'number' },
      { path: 'probe.timeoutMs', label: 'Single probe timeout (ms)', kind: 'number' },
      { path: 'probe.pollIntervalMs', label: 'Polling interval (ms)', kind: 'number', hint: 'Interval between probes for active sessions' },
    ],
  },
  {
    title: 'Concurrency',
    fields: [
      { path: 'concurrency.probeMax', label: 'ffprobe max concurrency', kind: 'number' },
    ],
  },
  {
    title: 'Recording',
    fields: [
      { path: 'record.enabled', label: 'Enable recording', kind: 'bool' },
      { path: 'record.maxConcurrency', label: 'ffmpeg recording max concurrency', kind: 'number' },
      { path: 'record.retentionDays', label: 'Recording retention days', kind: 'number', hint: '0 = retain forever; takes effect on next cleanup' },
      { path: 'record.remuxTimeoutMs', label: 'FLV→MP4 remux timeout (ms)', kind: 'number' },
    ],
  },
  {
    title: 'SRS Connection (Advanced)',
    fields: [
      { path: 'srs.apiBase', label: 'SRS HTTP API', kind: 'text' },
      { path: 'srs.rtmpHost', label: 'SRS RTMP host', kind: 'text', hint: 'Server pull address (in-container hostname)' },
    ],
  },
]

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj: any, path: string, val: any): void {
  const ks = path.split('.')
  const last = ks.pop()!
  ks.reduce((o, k) => o[k], obj)[last] = val
}
function onInput(path: string, kind: Kind, raw: any): void {
  let v: any = raw
  if (kind === 'number') v = raw === '' ? 0 : Number(raw)
  setPath(form.value, path, v)
}

// Registration email whitelist + disallowed patterns are string arrays — edited
// as line-separated textareas, split/joined here. Empty whitelist + enabled is
// treated as "allow all" server-side (can't lock the app out).
const whitelistText = computed<string>({
  get: () => form.value?.registration.emailWhitelist.patterns.join('\n') ?? '',
  set: (v) => {
    if (!form.value) return
    form.value.registration.emailWhitelist.patterns = v
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  },
})
const disallowedText = computed<string>({
  get: () => form.value?.registration.disallowedPatterns.join('\n') ?? '',
  set: (v) => {
    if (!form.value) return
    form.value.registration.disallowedPatterns = v
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  },
})

const dirty = computed(
  () =>
    form.value != null &&
    data.value != null &&
    JSON.stringify(form.value) !== JSON.stringify(data.value),
)

async function save(): Promise<boolean> {
  if (!form.value) return false
  saving.value = true
  saved.value = false
  try {
    const updated = await $fetch<AppConfig>('/api/config', { method: 'PATCH', body: form.value })
    data.value = updated
    form.value = structuredClone(updated)
    toast.success('Configuration saved and hot-reloaded')
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    return true
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || 'Unknown error'))
    return false
  } finally {
    saving.value = false
  }
}
function reset(): void {
  if (data.value) form.value = structuredClone(toRaw(data.value))
}

// Warn before leaving with unsaved changes; the SaveBar + dialog provide the UI.
const { confirmLeave, proceed } = useUnsavedLeaveGuard(dirty, saving)
async function saveAndLeave(): Promise<void> {
  if (await save()) proceed()
}
function discardAndLeave(): void {
  reset()
  proceed()
}
</script>

<template>
  <div class="space-y-6 pb-24">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold">Runtime Configuration</h1>
        <p class="text-muted-foreground">Hot-reloads on save: new sessions use the new values immediately; active sessions pick them up on the next probe.</p>
      </div>
      <Badge v-if="dirty" variant="warning">Unsaved changes</Badge>
    </div>

    <div v-if="form" class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-4">
      <Card v-for="s in sections" :key="s.title">
        <CardHeader><CardTitle>{{ s.title }}</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <FieldRow
            v-for="f in s.fields"
            :key="f.path"
            :label="f.label"
            :hint="f.hint"
            :inline="f.kind !== 'select' && f.kind !== 'number' && f.kind !== 'text'"
          >
            <Select
              v-if="f.kind === 'select'"
              :model-value="getPath(form, f.path)"
              @update:model-value="onInput(f.path, 'select', $event)"
            >
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in f.options" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-else-if="f.kind === 'number' || f.kind === 'text'"
              :type="f.kind === 'number' ? 'number' : 'text'"
              :model-value="getPath(form, f.path)"
              @update:model-value="onInput(f.path, f.kind, $event)"
            />
            <Checkbox
              v-else
              :model-value="getPath(form, f.path)"
              @update:model-value="setPath(form, f.path, $event)"
            />
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Registration Notice</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <FieldRow label="Notice shown on the registration form">
            <Textarea
              v-model="form.registration.notice"
              rows="5"
              class="w-full"
              placeholder="e.g. Registration is limited to contestants of Demo Showdown —&#10;sign up with your university email before Friday 18:00."
            />
            <template #hint>
              Markdown supported — line breaks, lists, LaTeX formulas (<code>$x^2$</code>) and
              <code>mermaid</code> diagrams. Rendered as a panel atop the register form; leave
              empty to hide it. Hot-reloads on save.
            </template>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Registration Email Restrictions</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <FieldRow label="Enable email whitelist" inline hint="When enabled, only emails matching the wildcards below may register; leave empty to allow all">
            <Checkbox v-model="form.registration.emailWhitelist.enabled" />
          </FieldRow>
          <FieldRow label="Allowed email wildcards (one per line)">
            <Textarea v-model="whitelistText" rows="4" class="w-full" placeholder="*@nottingham.edu.cn&#10;*@*.nottingham.edu.cn" />
            <template #hint>picomatch wildcards, e.g. <code class="rounded bg-muted px-1 text-[0.85em]">*@nottingham.edu.cn</code>. The first admin registration is exempt.</template>
          </FieldRow>
          <FieldRow label="Disallowed email patterns (one per line)">
            <Textarea v-model="disallowedText" rows="3" class="w-full" placeholder="student&#10;staff" />
            <template #hint>Emails containing these words (case-insensitive) are always rejected, e.g. institutional mailing lists <code class="rounded bg-muted px-1 text-[0.85em]">student</code> / <code class="rounded bg-muted px-1 text-[0.85em]">staff</code>.</template>
          </FieldRow>
        </CardContent>
      </Card>
    </div>

    <SaveBar :dirty="dirty" :saving="saving" :saved="saved" @save="save" @discard="reset" />
    <UnsavedLeaveDialog
      :open="confirmLeave"
      :saving="saving"
      @stay="confirmLeave = false"
      @discard="discardAndLeave"
      @save="saveAndLeave"
    />
  </div>
</template>

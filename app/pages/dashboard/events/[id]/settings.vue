<script setup lang="ts">
definePageMeta({ layout: 'default', adminOnly: true })
import type { EventView, EventStatus, EventVisibility } from '#shared/event-view'
import type { GroupView } from '#shared/groups'
import type { DataTableColumn } from '~/components/DataTable.vue'

const route = useRoute()
const id = Number(route.params.id)
const toast = useToast()
const confirm = useConfirm()
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

// Sync fetch (NO top-level await) so this page doesn't drag the dashboard
// layout into an async Suspense boundary (client hydration mismatch). Nuxt
// still awaits the registered useFetch promises during SSR and serializes the
// results; the template reads event directly (populated on SSR for direct
// reads), and the watchEffect below (flush:'sync') populates the editable
// `settings` copy at the instant `event` is assigned, before the render pass.
const { data: event, refresh: refreshEvent } = useFetch<EventView>(`/api/events/${id}`)

// ---- settings (admin-only) ----
const settings = ref<EventView | null>(null)
const selectedGroupIds = ref<number[]>([])
const allGroups = ref<GroupView[]>([])
// flush:'sync' (with watch, not watchEffect) so settings/selectedGroupIds
// populate at the moment `event` is assigned during SSR, before the render pass.
// watchEffect's flush:'sync' does NOT re-fire on the SSR assignment the way
// watch's does, so the editable copy stayed null server-side (card content
// absent → hydration mismatch). The !settings guard makes this one-shot init.
watch(
  event,
  (e) => {
    if (e && !settings.value) {
      settings.value = structuredClone(toRaw(e))
      selectedGroupIds.value = e.groups.map((g) => g.id)
    }
  },
  { immediate: true, flush: 'sync' },
)
// Groups catalog is admin-only; fetch lazily on the client for admins only.
onMounted(async () => {
  if (!isAdmin.value) return
  try {
    allGroups.value = await $fetch<GroupView[]>('/api/groups')
  } catch {
    /* non-admin or transient — leave empty */
  }
})

function sameSet(a: number[], b: number[]): boolean {
  return a.slice().sort().join(',') === b.slice().sort().join(',')
}
const settingsDirty = computed(() => {
  if (!settings.value || !event.value) return false
  const s = settings.value
  const e = event.value
  const scalarChanged =
    s.name !== e.name ||
    s.slug !== e.slug ||
    s.description !== e.description ||
    s.status !== e.status ||
    s.recordEnabled !== e.recordEnabled ||
    s.strictLimits !== e.strictLimits ||
    s.visibility !== e.visibility ||
    s.streamGuide !== e.streamGuide
  const lo = e.limitsOverride ?? {}
  const limitsChanged =
    Number(limits.maxWidth || 0) !== (lo.maxWidth ?? 0) ||
    Number(limits.maxHeight || 0) !== (lo.maxHeight ?? 0) ||
    Number(limits.maxFps || 0) !== (lo.maxFps ?? 0) ||
    Number(limits.maxBitrateKbps || 0) !== (lo.maxBitrateKbps ?? 0)
  return scalarChanged || limitsChanged || !sameSet(selectedGroupIds.value, e.groups.map((g) => g.id))
})

const visibilityLabel: Record<EventVisibility, string> = {
  public: 'Public',
  registered: 'Registered users',
  groups: 'Specific groups',
}

const saving = ref(false)
const saved = ref(false)
// per-event stream caps (limitsOverride; blank = inherit global)
const limits = reactive({ maxWidth: '', maxHeight: '', maxFps: '', maxBitrateKbps: '' })
watch(
  event,
  (e) => {
    if (!e) return
    limits.maxWidth = e.limitsOverride?.maxWidth != null ? String(e.limitsOverride.maxWidth) : ''
    limits.maxHeight = e.limitsOverride?.maxHeight != null ? String(e.limitsOverride.maxHeight) : ''
    limits.maxFps = e.limitsOverride?.maxFps != null ? String(e.limitsOverride.maxFps) : ''
    limits.maxBitrateKbps =
      e.limitsOverride?.maxBitrateKbps != null ? String(e.limitsOverride.maxBitrateKbps) : ''
  },
  { immediate: true, flush: 'sync' },
)
function limitsPayload(): Record<string, number | null> {
  const num = (v: string | number): number | null => {
    // number inputs can emit numbers, not just strings
    const t = String(v ?? '').trim()
    const n = Number(t)
    return t !== '' && Number.isFinite(n) && n >= 0 ? n : null
  }
  return {
    maxWidth: num(limits.maxWidth),
    maxHeight: num(limits.maxHeight),
    maxFps: num(limits.maxFps),
    maxBitrateKbps: num(limits.maxBitrateKbps),
  }
}
/** Event key charset: lowercase letters, digits, underscore, hyphen — nothing else. */
const EVENT_KEY_RE = /^[a-z0-9_-]+$/
const eventKeyValid = computed(() => EVENT_KEY_RE.test(settings.value?.slug ?? ''))
async function saveSettings(): Promise<boolean> {
  if (!settings.value) return false
  if (!eventKeyValid.value) {
    toast.error('Event key may only contain lowercase letters, digits, _ and -')
    return false
  }
  saving.value = true
  saved.value = false
  try {
    const s = settings.value
    const updated = await $fetch<EventView>(`/api/events/${id}`, {
      method: 'PATCH',
      body: {
        name: s.name,
        slug: s.slug,
        description: s.description,
        status: s.status,
        recordEnabled: s.recordEnabled,
        strictLimits: s.strictLimits,
        visibility: s.visibility,
        streamGuide: s.streamGuide,
        limitsOverride: limitsPayload(),
        groupIds: selectedGroupIds.value,
      },
    })
    event.value = updated
    settings.value = structuredClone(updated)
    selectedGroupIds.value = updated.groups.map((g) => g.id)
    toast.success('Event updated')
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    return true
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || ''))
    return false
  } finally {
    saving.value = false
  }
}
function resetSettings(): void {
  if (event.value) {
    settings.value = structuredClone(toRaw(event.value))
    selectedGroupIds.value = event.value.groups.map((g) => g.id)
    const lo = event.value.limitsOverride ?? {}
    limits.maxWidth = lo.maxWidth != null ? String(lo.maxWidth) : ''
    limits.maxHeight = lo.maxHeight != null ? String(lo.maxHeight) : ''
    limits.maxFps = lo.maxFps != null ? String(lo.maxFps) : ''
    limits.maxBitrateKbps = lo.maxBitrateKbps != null ? String(lo.maxBitrateKbps) : ''
  }
}

// Warn before leaving with unsaved settings; the SaveBar + dialog provide the UI.
const { confirmLeave, proceed } = useUnsavedLeaveGuard(settingsDirty, saving)
async function saveAndLeave(): Promise<void> {
  if (await saveSettings()) proceed()
}
function discardAndLeave(): void {
  resetSettings()
  proceed()
}



async function copy(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(label)
  } catch {
    toast.error('Copy failed, please copy manually')
  }
}

const statusOptions: { value: EventStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'live', label: 'Live' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' },
]

</script>

<template>
  <div v-if="event" class="space-y-6 pb-24">
    <Card v-if="isAdmin">
      <CardHeader><CardTitle>Event settings</CardTitle></CardHeader>
      <CardContent v-if="settings" class="space-y-4">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>Display Name</Label>
            <Input v-model="settings.name" />
          </div>
          <div class="space-y-1.5">
            <Label>Event key</Label>
            <Input v-model="settings.slug" />
            <p v-if="!eventKeyValid" class="text-xs text-destructive">
              Lowercase letters, digits, <code>_</code> and <code>-</code> only.
            </p>
            <p class="text-xs text-muted-foreground">
              Also the guide URL (<code>/e/&lt;event-key&gt;</code>) and the OBS stream key contestants paste.
            </p>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label>Description</Label>
            <!-- description is string | null; bind explicitly so null renders
                 empty but is preserved untouched on save (native-input parity). -->
            <Input
              :model-value="settings.description ?? ''"
              @update:model-value="settings.description = String($event)"
            />
          </div>
          <div class="space-y-1.5">
            <Label>Status</Label>
            <Select v-model="settings.status">
              <SelectTrigger class="w-full"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label>Visibility</Label>
            <Select v-model="settings.visibility">
              <SelectTrigger class="w-full"><SelectValue placeholder="Visibility" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="registered">Registered users</SelectItem>
                <SelectItem value="public">Public (anyone, incl. homepage)</SelectItem>
                <SelectItem value="groups">Specific groups</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="settings.visibility === 'groups'" class="space-y-1.5 sm:col-span-2">
            <Label>Allowed groups</Label>
            <div class="flex flex-col gap-2">
              <!-- Native checkbox here: reka Checkbox only models a boolean, but
                   this is an array binding (selectedGroupIds). Keeping <input> preserves
                   the exact multi-select semantics without changing script logic. -->
              <label v-for="g in allGroups" :key="g.id" class="flex items-center gap-2 text-sm">
                <input type="checkbox" :value="g.id" v-model="selectedGroupIds" class="size-4" />
                <span>{{ g.name }} <span class="text-muted-foreground">({{ g.memberCount }})</span></span>
              </label>
              <p v-if="!allGroups.length" class="text-xs text-muted-foreground">No groups exist yet — create some on the Groups page first.</p>
            </div>
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label>Participant guide instructions</Label>
            <Textarea
              :model-value="settings.streamGuide ?? ''"
              @update:model-value="settings.streamGuide = String($event) || null"
              rows="6"
              placeholder="Optional notes shown on the participant guide (e.g. join 5 min early, use wired ethernet…)"
            />
            <p class="text-xs text-muted-foreground">
              Markdown supported — headings, lists, tables, LaTeX formulas (<code>$x^2$</code>,
              <code>$$…$$</code>) and fenced <code>mermaid</code> diagrams.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- streaming settings -->
    <Card v-if="isAdmin && settings">
      <CardHeader><CardTitle>Streaming</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <div class="flex items-center gap-2">
          <Checkbox v-model="settings.recordEnabled" id="record-enabled" />
          <Label for="record-enabled" class="cursor-pointer">Enable recording for this event</Label>
        </div>
        <p class="text-xs text-muted-foreground">
          Compliant publishes are archived in real time as MKV — no processing happens when a stream stops.
          A user's re-publishes append to the same recording.
        </p>
        <div class="flex items-start gap-2">
          <Checkbox v-model="settings.strictLimits" id="strict-limits" class="mt-1" />
          <Label for="strict-limits" class="cursor-pointer">
            Strict limits
            <span class="block text-xs font-normal text-muted-foreground">
              A stream violating the limits below is stopped immediately and the publisher is
              banned from this event (same as a manual ban — every reconnect is refused).
            </span>
          </Label>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>Max width (px)</Label>
            <Input v-model="limits.maxWidth" type="number" min="0" placeholder="Inherit global" />
          </div>
          <div class="space-y-1.5">
            <Label>Max height (px)</Label>
            <Input v-model="limits.maxHeight" type="number" min="0" placeholder="Inherit global" />
          </div>
          <div class="space-y-1.5">
            <Label>Max framerate (fps)</Label>
            <Input v-model="limits.maxFps" type="number" min="0" step="any" placeholder="Inherit global" />
          </div>
          <div class="space-y-1.5">
            <Label>Max bitrate (kbps)</Label>
            <Input v-model="limits.maxBitrateKbps" type="number" min="0" placeholder="Inherit global" />
          </div>
          <p class="text-xs text-muted-foreground sm:col-span-2">
            Streams above these caps are flagged (or kicked, per the enforcement mode); blank fields inherit the global config.
          </p>
        </div>
      </CardContent>
    </Card>

    <SaveBar :dirty="settingsDirty" :saving="saving" :saved="saved" @save="saveSettings" @discard="resetSettings" />
    <UnsavedLeaveDialog
      :open="confirmLeave"
      :saving="saving"
      @stay="confirmLeave = false"
      @discard="discardAndLeave"
      @save="saveAndLeave"
    />

    <ConfirmDialog
      v-model:open="confirm.state.open"
      :message="confirm.state.message"
      :action-label="confirm.state.actionLabel"
      :destructive="confirm.state.destructive"
      @accept="confirm.accept"
    />
  </div>
</template>

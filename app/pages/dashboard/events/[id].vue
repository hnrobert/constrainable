<script setup lang="ts">
/**
 * GitHub-repo-style event shell: a header (name, event key, status, window)
 * plus a tab bar routing to child pages —
 *   Overview  (/dashboard/events/:id)        connection tutorial + announcement
 *   Manual    (…/manual)                     full step-by-step streaming tutorial
 *   Insights  (…/insights)                   statistics
 *   Records   (…/recordings)                 playback of archived recordings
 *   Bans      (…/bans)                       streaming bans
 *   Settings  (…/settings)                   admin-only configuration
 * The wrapper only renders chrome + <NuxtPage/>; each tab owns its data.
 */
import type { EventView, EventVisibility } from '#shared/event-view'

const route = useRoute()
const id = Number(route.params.id)
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const { data: event } = useFetch<EventView>(`/api/events/${id}`)

const visibilityLabel: Record<EventVisibility, string> = {
  public: 'Public',
  registered: 'Registered users',
  groups: 'Specific groups',
}

const tabs = computed(() => {
  const base = [
    { to: `/dashboard/events/${id}`, label: 'Overview', exact: true },
    { to: `/dashboard/events/${id}/manual`, label: 'Manual', exact: false },
  ]
  if (isAdmin.value) {
    base.push(
      { to: `/dashboard/events/${id}/insights`, label: 'Insights', exact: false },
      { to: `/dashboard/events/${id}/recordings`, label: 'Records', exact: false },
      { to: `/dashboard/events/${id}/bans`, label: 'Bans', exact: false },
      { to: `/dashboard/events/${id}/settings`, label: 'Settings', exact: false },
    )
  }
  return base
})

const activeTab = computed(
  () =>
    tabs.value.find((t) => (t.exact ? route.path === t.to : route.path.startsWith(t.to)))?.label ??
    'Overview',
)

function fmtWindow(e: EventView): string {
  const f = (ms: number | null) => (ms ? new Date(ms).toLocaleString('en-US', { hour12: false }) : null)
  const s = f(e.startsAt)
  const en = f(e.endsAt)
  if (!s && !en) return ''
  return `${s ?? '…'} → ${en ?? '…'}`
}
const statusVariant: Record<string, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary',
  scheduled: 'warning',
  live: 'success',
  ended: 'secondary',
  archived: 'destructive',
}
</script>

<template>
  <div v-if="event" class="space-y-6">
    <!-- repo-style header -->
    <div class="space-y-1">
      <NuxtLink to="/dashboard/events" class="text-sm text-muted-foreground hover:text-foreground">← Back to events</NuxtLink>
      <div class="flex flex-wrap items-center gap-3">
        <h1 class="text-2xl font-semibold tracking-tight">{{ event.name }}</h1>
        <Badge :variant="statusVariant[event.status] ?? 'secondary'">{{ event.status }}</Badge>
        <Badge variant="outline" class="font-mono text-xs">{{ event.slug }}</Badge>
      </div>
      <p v-if="event.description" class="text-muted-foreground">{{ event.description }}</p>
      <p class="text-xs text-muted-foreground">
        Visibility: {{ visibilityLabel[event.visibility] }}
        <template v-if="event.visibility === 'groups' && event.groups.length">
          · {{ event.groups.map((g) => g.name).join(', ') }}
        </template>
        <template v-if="fmtWindow(event)">
          · Window: {{ fmtWindow(event) }}
        </template>
      </p>
    </div>

    <!-- GitHub-style tab bar -->
    <nav class="flex gap-1 border-b" aria-label="Event sections">
      <NuxtLink
        v-for="t in tabs"
        :key="t.to"
        :to="t.to"
        class="-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors"
        :class="
          activeTab === t.label
            ? 'border-primary text-primary'
            : 'border-transparent text-muted-foreground hover:text-foreground'
        "
      >
        {{ t.label }}
      </NuxtLink>
    </nav>

    <NuxtPage />
  </div>
</template>

<script setup lang="ts">
import { Pencil, Plus, Trash2, Megaphone } from 'lucide-vue-next'
import type { EventView, EventStatus } from '#shared/event-view'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'default' })

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')
const toast = useToast()

// /api/events is authorization-filtered server-side: admins see all, regular
// users see only the events they may view.
const { data: events } = useFetch<EventView[]>('/api/events')

/* ------------------------------- notices -------------------------------- */
// Three dashboard-home notices, newest scope first: the admin-configured site
// notice (config dashboard.notice, identical for everyone), the admin-authored
// announcement aimed at THIS user (users.announcement, set from the Users
// page), and the user's own private note (users.dashboard_notice).
interface MeState {
  dashboardNotice: string | null
  announcement: string | null
  siteNotice: string
}
const { data: me } = useFetch<MeState>('/api/me')
const siteNotice = computed(() => me.value?.siteNotice ?? '')
const myAnnouncement = computed(() => me.value?.announcement ?? '')

// personal note: view state + inline edit state (declared before the watch
// that reads `editing` in its immediate callback)
const personalNote = ref('')
const editing = ref(false)
const draft = ref('')
const savingNote = ref(false)
watch(
  () => me.value?.dashboardNotice,
  (v) => {
    if (!editing.value) personalNote.value = v ?? ''
  },
  // flush:'sync' — the default pre-flush queue doesn't drain during SSR before
  // the render pass (same pitfall as config.vue / settings.vue), so the note
  // card would be missing from server HTML.
  { immediate: true, flush: 'sync' },
)

function startEdit(): void {
  draft.value = personalNote.value
  editing.value = true
}

async function saveNote(next: string | null): Promise<void> {
  savingNote.value = true
  try {
    const r = await $fetch<{ dashboardNotice: string | null }>('/api/me', {
      method: 'PATCH',
      body: { dashboardNotice: next },
    })
    personalNote.value = r.dashboardNotice ?? ''
    if (me.value) me.value.dashboardNotice = r.dashboardNotice
    editing.value = false
    toast.success(next ? 'Note saved' : 'Note cleared')
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    savingNote.value = false
  }
}

const statusLabel: Record<EventStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
}
const statusVariant: Record<EventStatus, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary',
  scheduled: 'warning',
  live: 'success',
  ended: 'secondary',
  archived: 'destructive',
}

const quickLinks: { to: string; label: string }[] = [
  { to: '/dashboard/events', label: 'Events' },
  { to: '/dashboard/streams', label: 'Live streams' },
  { to: '/dashboard/users', label: 'Users' },
  { to: '/dashboard/groups', label: 'Groups & invites' },
  { to: '/dashboard/config', label: 'Config' },
]

const columns: DataTableColumn[] = [
  { key: 'name', header: 'Event', class: 'font-medium' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: '', headClass: 'w-0' },
]
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Dashboard</h1>
      <p class="text-muted-foreground">
        Welcome, {{ user?.email }}.
        <template v-if="isAdmin">You have admin access — full event and system management.</template>
        <template v-else>You can view the schedule and details for events you have access to.</template>
      </p>
    </div>

    <!-- admin-configured site notice (Config → Dashboard Notice) -->
    <Card v-if="siteNotice" class="border-primary/40">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><Megaphone :size="16" /> Notice</CardTitle>
        <CardDescription>From the site administrators</CardDescription>
      </CardHeader>
      <CardContent>
        <RichText :source="siteNotice" />
      </CardContent>
    </Card>

    <!-- admin-authored announcement aimed at THIS user (Users page → 📢) -->
    <Card v-if="myAnnouncement" class="border-primary/40">
      <CardHeader>
        <CardTitle class="flex items-center gap-2"><Megaphone :size="16" /> Announcement for you</CardTitle>
        <CardDescription>From the administrators, for your attention</CardDescription>
      </CardHeader>
      <CardContent>
        <RichText :source="myAnnouncement" />
      </CardContent>
    </Card>

    <!-- personal note — private to this user, editable inline -->
    <Card v-if="editing">
      <CardHeader>
        <CardTitle>Your note</CardTitle>
        <CardDescription>Private — visible only to you on this dashboard</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <Textarea
          v-model="draft"
          rows="4"
          placeholder="Your personal reminder (Markdown, formulas and mermaid supported)…"
        />
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="editing = false">Cancel</Button>
          <Button size="sm" :disabled="savingNote" @click="saveNote(draft.trim() || null)">
            {{ savingNote ? 'Saving…' : 'Save' }}
          </Button>
        </div>
      </CardContent>
    </Card>
    <Card v-else-if="personalNote">
      <CardHeader>
        <CardTitle>Your note</CardTitle>
        <CardDescription>Private — visible only to you on this dashboard</CardDescription>
        <CardAction>
          <div class="flex gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Edit note" @click="startEdit">
              <Pencil :size="14" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear note"
              :disabled="savingNote"
              @click="saveNote(null)"
            >
              <Trash2 :size="14" />
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <RichText :source="personalNote" />
      </CardContent>
    </Card>
    <div v-else>
      <Button variant="outline" size="sm" @click="startEdit">
        <Plus :size="14" /> Add a personal note
      </Button>
    </div>

    <Card v-if="isAdmin">
      <CardHeader><CardTitle>Management</CardTitle></CardHeader>
      <CardContent>
        <div class="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          <NuxtLink
            v-for="q in quickLinks"
            :key="q.to"
            :to="q.to"
            class="block rounded-lg border p-3 text-sm transition-colors hover:border-primary hover:text-primary"
          >
            {{ q.label }} →
          </NuxtLink>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex items-center justify-between">
          <CardTitle>{{ isAdmin ? 'All events' : 'Your events' }}</CardTitle>
          <NuxtLink to="/dashboard/events" class="text-sm text-muted-foreground hover:text-foreground">
            View all →
          </NuxtLink>
        </div>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="events ?? []"
          :row-key="(e: EventView) => e.id"
          empty="No events available."
        >
          <template #cell-status="{ row }">
            <Badge :variant="statusVariant[row.status]">{{ statusLabel[row.status] }}</Badge>
          </template>
          <template #cell-actions="{ row }">
            <Button as-child size="sm">
              <NuxtLink :to="`/dashboard/events/${row.id}`">{{ isAdmin ? 'Manage' : 'View' }}</NuxtLink>
            </Button>
          </template>
        </DataTable>
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
import type { EventView, EventStatus } from '#shared/event-view'
import type { DataTableColumn } from '~/components/DataTable.vue'

const toast = useToast()
const { data: events, refresh } = useFetch<EventView[]>('/api/events')
const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

const creating = ref(false)
const saving = ref(false)
const form = reactive({ name: '', slug: '', description: '' })

const statusVariant: Record<EventStatus, 'secondary' | 'warning' | 'success' | 'destructive'> = {
  draft: 'secondary',
  scheduled: 'warning',
  live: 'success',
  ended: 'secondary',
  archived: 'destructive',
}
const statusLabel: Record<EventStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live',
  ended: 'Ended',
  archived: 'Archived',
}

const columns: DataTableColumn[] = [
  // The classic fluid-ellipsis column: `w-full max-w-0 truncate` makes the auto
  // table layout size this column to EXACTLY the space left by the others
  // (max-w-0 caps its preferred width, w-full claims everything left), with
  // overflow shown as an ellipsis. The table therefore always fits its card —
  // no horizontal scrollbar however long the event name.
  {
    key: 'name',
    header: 'Name',
    class: 'w-full max-w-0 truncate font-medium',
    headClass: 'w-full max-w-0',
  },
  { key: 'slug', header: 'Event key', class: 'font-mono text-muted-foreground' },
  { key: 'status', header: 'Status' },
  { key: 'actions', header: '', headClass: 'w-0' },
]

/** Event key charset: lowercase letters, digits, underscore, hyphen — nothing else. */
const EVENT_KEY_RE = /^[a-z0-9_-]+$/

async function create(): Promise<void> {
  if (!form.name.trim()) {
    toast.error('Please fill in the event name')
    return
  }
  if (!form.slug.trim() || !EVENT_KEY_RE.test(form.slug.trim())) {
    toast.error('Event key is required (lowercase letters, digits, _ and - only)')
    return
  }
  saving.value = true
  try {
    await $fetch('/api/events', {
      method: 'POST',
      body: { name: form.name, slug: form.slug.trim(), description: form.description || undefined },
    })
    toast.success('Event created')
    form.name = ''
    form.slug = ''
    form.description = ''
    creating.value = false
    await refresh()
  } catch (e: any) {
    toast.error('Create failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold">Events</h1>
        <p class="text-muted-foreground">Each event has its own stream keys and config overrides.</p>
      </div>
      <Button v-if="isAdmin" @click="creating = !creating">
        {{ creating ? 'Cancel' : '+ New event' }}
      </Button>
    </div>

    <Card v-if="creating">
      <CardHeader><CardTitle>New event</CardTitle></CardHeader>
      <CardContent class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <Label>Name *</Label>
            <Input v-model="form.name" placeholder="e.g. 2026 Regional" />
          </div>
          <div class="space-y-1.5">
            <Label>Event key *</Label>
            <Input v-model="form.slug" placeholder="e.g. regional-2026" />
            <p class="text-xs text-muted-foreground">
              Lowercase letters, digits, <code>_</code> and <code>-</code> only. Doubles as the guide URL and the OBS stream key.
            </p>
          </div>
          <div class="space-y-1.5 col-span-full">
            <Label>Description</Label>
            <Input v-model="form.description" />
          </div>
        </div>
        <div class="flex justify-end">
          <Button :disabled="saving" @click="create">{{ saving ? 'Creating…' : 'Create' }}</Button>
        </div>
      </CardContent>
    </Card>

    <!-- ingest node pick + browser latency test — every user, before streaming -->
    <Card>
      <CardHeader>
        <CardTitle>Your ingest node</CardTitle>
        <CardDescription>
          Pick the node you publish through (and test each node's latency from your own network)
          — the OBS address on every event guide follows this choice.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NodesNodePicker />
      </CardContent>
    </Card>

    <Card>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="events ?? []"
          :row-key="(e: EventView) => e.id"
          empty="No events yet."
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

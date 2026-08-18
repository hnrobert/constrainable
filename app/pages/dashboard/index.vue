<script setup lang="ts">
import type { EventView, EventStatus } from '#shared/event-view'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'default' })

const { user } = useAuth()
const isAdmin = computed(() => user.value?.role === 'admin')

// /api/events is authorization-filtered server-side: admins see all, regular
// users see only the events they may view.
const { data: events } = useFetch<EventView[]>('/api/events')

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

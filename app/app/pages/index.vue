<script setup lang="ts">
import type { EventView, EventStatus } from '#shared/event-view'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'public' })

const { user } = useAuth()
// No top-level `await`: keeps this a SYNCHRONOUS component (no <Suspense>
// boundary). An async (suspensing) page rendered through the layout's <slot/>
// triggered a client-side `renderSlot` with no active rendering instance on
// hydration (`null is not an object: currentRenderingInstance.ce`). Nuxt's SSR
// renderer still awaits the registered useFetch promise, so the data is
// populated server-side and serialized into the payload.
const { data: events } = useFetch<EventView[]>('/api/events/public')

const statusLabel: Record<EventStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  live: 'Live now',
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

function when(e: EventView): string {
  if (!e.startsAt) return '—'
  const s = new Date(e.startsAt).toLocaleString('en-US', { hour12: false })
  if (!e.endsAt) return s
  return `${s} → ${new Date(e.endsAt).toLocaleString('en-US', { hour12: false })}`
}

const columns: DataTableColumn[] = [
  // fluid-ellipsis column (same trick as the events dashboard): max-w-0 caps
  // its preferred width, w-full claims the space the other columns leave —
  // long event names ellipsize instead of stretching the table sideways
  {
    key: 'name',
    header: 'Event',
    class: 'w-full max-w-0 truncate font-medium',
    headClass: 'w-full max-w-0',
  },
  { key: 'when', header: 'When', class: 'whitespace-nowrap text-muted-foreground' },
  { key: 'status', header: 'Status' },
]
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-3">
      <h1 class="text-3xl font-bold tracking-tight">Constrainable Ingest</h1>
      <p class="max-w-2xl leading-relaxed text-muted-foreground">
        ICPC proctoring stream ingest and event management. Browse public events below, or sign in to access your
        schedule and details.
      </p>
      <div>
        <Button as-child>
          <NuxtLink v-if="user" to="/dashboard">Go to dashboard</NuxtLink>
          <NuxtLink v-else to="/login">Sign in / Register</NuxtLink>
        </Button>
      </div>
    </section>

    <Card>
      <CardHeader><CardTitle>Public events</CardTitle></CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="events ?? []"
          :row-key="(e: EventView) => e.id"
          empty="No public events right now. Check back later."
        >
          <template #cell-name="{ row }">
            <div class="font-medium">{{ row.name }}</div>
            <div v-if="row.description" class="text-xs text-muted-foreground">{{ row.description }}</div>
          </template>
          <template #cell-when="{ row }">
            <span class="text-muted-foreground">{{ when(row) }}</span>
          </template>
          <template #cell-status="{ row }">
            <Badge :variant="statusVariant[row.status]">{{ statusLabel[row.status] }}</Badge>
          </template>
        </DataTable>
      </CardContent>
    </Card>
  </div>
</template>

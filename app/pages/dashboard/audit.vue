<script setup lang="ts">
import type { AuditView } from '#shared/audit'
import type { DataTableColumn } from '~/components/DataTable.vue'
import { AUDIT_CATEGORIES, AUDIT_LEVELS } from '#shared/audit'

// Events feed the filter dropdown and resolve eventId → name in the table.
const { data: events } = useFetch<{ id: number; name: string }[]>('/api/events')
const eventName = computed(() => {
  const m = new Map<number, string>()
  for (const e of events.value ?? []) m.set(e.id, e.name)
  return m
})

// "All" filter options use a non-empty sentinel — reka-ui forbids an empty
// SelectItem value (empty is reserved for clearing the selection). apply() maps
// each sentinel back to '' so the API treats it as "no filter".
const ALL = 'all'

const filters = reactive<{ level: string; category: string; eventId: string; q: string }>({
  level: ALL,
  category: ALL,
  eventId: ALL,
  q: '',
})
// applied filters drive the query; updated on search.
const applied = ref({ level: '', category: '', eventId: '', q: '' })
const { data, refresh, pending } = useFetch<AuditView[]>('/api/audit', { query: applied })

function apply(): void {
  applied.value = {
    level: filters.level === ALL ? '' : filters.level,
    category: filters.category === ALL ? '' : filters.category,
    eventId: filters.eventId === ALL ? '' : filters.eventId,
    q: filters.q,
  }
}
function resetFilters(): void {
  filters.level = ALL
  filters.category = ALL
  filters.eventId = ALL
  filters.q = ''
  apply()
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { hour12: false })
}
const levelVariant: Record<string, 'success' | 'warning' | 'destructive'> = {
  info: 'success',
  warn: 'warning',
  error: 'destructive',
}
function prettyDetail(d: unknown): string {
  if (d == null) return ''
  return typeof d === 'string' ? d : JSON.stringify(d, null, 2)
}

const columns: DataTableColumn[] = [
  { key: 'ts', header: 'Time', class: 'whitespace-nowrap text-xs text-muted-foreground' },
  { key: 'level', header: 'Level' },
  { key: 'category', header: 'Category', class: 'text-muted-foreground' },
  { key: 'eventId', header: 'Event', class: 'text-muted-foreground' },
  { key: 'streamName', header: 'Stream', class: 'text-muted-foreground' },
  { key: 'message', header: 'Message' },
]

function hasDetail(row: AuditView): boolean {
  return row.detail != null
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Audit log</h1>
      <p class="text-muted-foreground">Append-only record of auth, publish, access, config, recording, and admin events.</p>
    </div>

    <Card>
      <CardContent class="space-y-4 pt-6">
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-35 space-y-1.5">
            <Label>Level</Label>
            <Select v-model="filters.level">
              <SelectTrigger class="w-full"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">All</SelectItem>
                <SelectItem v-for="l in AUDIT_LEVELS" :key="l" :value="l">{{ l }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="min-w-35 space-y-1.5">
            <Label>Category</Label>
            <Select v-model="filters.category">
              <SelectTrigger class="w-full"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">All</SelectItem>
                <SelectItem v-for="c in AUDIT_CATEGORIES" :key="c" :value="c">{{ c }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="min-w-35 space-y-1.5">
            <Label>Event</Label>
            <Select v-model="filters.eventId">
              <SelectTrigger class="w-full"><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem :value="ALL">All</SelectItem>
                <SelectItem v-for="e in events" :key="e.id" :value="String(e.id)">{{ e.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="min-w-45 flex-1 space-y-1.5">
            <Label>Search (message / stream)</Label>
            <Input type="text" v-model="filters.q" placeholder="Message or stream name…" @keyup.enter="apply" />
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <Button variant="outline" @click="resetFilters">Clear</Button>
          <Button @click="apply">Search</Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex items-center justify-between">
          <CardTitle>Showing {{ data?.length ?? 0 }} (newest first, max 200)</CardTitle>
          <Button variant="outline" size="sm" :disabled="pending" @click="refresh()">{{ pending ? 'Refreshing…' : 'Refresh' }}</Button>
        </div>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="data ?? []"
          :row-key="(row: AuditView) => row.id"
          :detail-when="hasDetail"
          empty="No audit entries."
        >
          <template #cell-ts="{ row }">{{ fmtDate(row.ts) }}</template>
          <template #cell-level="{ row }">
            <Badge :variant="levelVariant[row.level] ?? 'secondary'">{{ row.level }}</Badge>
          </template>
          <template #cell-eventId="{ row }">
            {{ row.eventId ? (eventName.get(row.eventId) ?? `#${row.eventId}`) : '—' }}
          </template>
          <template #cell-streamName="{ row }">{{ row.streamName ?? '—' }}</template>
          <template #detail="{ row }">
            <pre class="m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-dashed bg-muted/40 px-3 py-2 text-xs">{{ prettyDetail(row.detail) }}</pre>
          </template>
        </DataTable>
      </CardContent>
    </Card>
  </div>
</template>

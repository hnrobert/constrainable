<script setup lang="ts">
/**
 * My Audit — the signed-in user's own operation history: logins, publishes,
 * node picks… every audit entry written with THEIR account email as actor.
 * The all-events view is the admin-only "Admin Audit" page (/dashboard/audit).
 */
import type { AuditPageView, AuditView } from '#shared/audit'
import type { DataTableColumn } from '~/components/DataTable.vue'
import { AUDIT_CATEGORIES, AUDIT_LEVELS } from '#shared/audit'

// "All" filter options use a non-empty sentinel — reka-ui forbids an empty
// SelectItem value. apply() maps it back to '' so the API sees "no filter".
const ALL = 'all'

const filters = reactive<{ level: string; category: string; q: string }>({
  level: ALL,
  category: ALL,
  q: '',
})
// applied filters + paging drive the query; updated on search / pager.
const applied = ref({ level: '', category: '', q: '' })
const page = ref(1)
const pageSize = ref(50)
const query = computed(() => ({ ...applied.value, page: page.value, pageSize: pageSize.value }))
const { data, refresh, pending } = useFetch<AuditPageView>('/api/audit/mine', { query })
const rows = computed(() => data.value?.entries ?? [])

function apply(): void {
  page.value = 1 // new filter set → back to the first page
  applied.value = {
    level: filters.level === ALL ? '' : filters.level,
    category: filters.category === ALL ? '' : filters.category,
    q: filters.q,
  }
}
function resetFilters(): void {
  filters.level = ALL
  filters.category = ALL
  filters.q = ''
  apply()
}
function onPageSize(n: number): void {
  pageSize.value = n
  page.value = 1
}
// filters shrank the result set while deep in the pages → jump back to the
// (new) last page instead of showing an empty one
watch(
  () => data.value,
  (d) => {
    if (!d || d.entries.length > 0) return
    const last = Math.max(1, Math.ceil(d.total / d.pageSize))
    if (page.value > last) page.value = last
  },
)

function fmtDate(ms: number): string {
  // compact, column-friendly: 'Aug 20, 2026, 19:49:54'
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
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
  { key: 'message', header: 'Message' },
]

function hasDetail(row: AuditView): boolean {
  return row.detail != null
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">My audit</h1>
      <p class="text-muted-foreground">
        Everything tied to your account — your sign-ins and node picks, plus your complete
        streaming trail: publishes, and WHY one was rejected, flagged, banned or disconnected
        (newest first, paged).
      </p>
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
          <div class="min-w-45 flex-1 space-y-1.5">
            <Label>Search (message)</Label>
            <Input type="text" v-model="filters.q" placeholder="Message…" @keyup.enter="apply" />
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
          <CardTitle>{{ data?.total ?? 0 }} entries</CardTitle>
          <Button variant="outline" size="sm" :disabled="pending" @click="refresh()">{{ pending ? 'Refreshing…' : 'Refresh' }}</Button>
        </div>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="rows"
          :row-key="(row: AuditView) => row.id"
          :detail-when="hasDetail"
          empty="No entries yet — your sign-ins and streaming activity will appear here."
        >
          <template #cell-ts="{ row }">{{ fmtDate(row.ts) }}</template>
          <template #cell-level="{ row }">
            <Badge :variant="levelVariant[row.level] ?? 'secondary'">{{ row.level }}</Badge>
          </template>
          <template #detail="{ row }">
            <pre class="m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-dashed bg-muted/40 px-3 py-2 text-xs">{{ prettyDetail(row.detail) }}</pre>
          </template>
        </DataTable>
        <div class="mt-4 border-t pt-3">
          <AuditPager
            :page="page"
            :page-size="pageSize"
            :total="data?.total ?? 0"
            :pending="pending"
            @update:page="page = $event"
            @update:page-size="onPageSize"
          />
        </div>
      </CardContent>
    </Card>
  </div>
</template>

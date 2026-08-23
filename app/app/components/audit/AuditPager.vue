<script setup lang="ts">
/**
 * Pager shared by the two audit pages: "Showing a–b of N" summary, a
 * per-page size select (client preference; default 50 upstream), and
 * first/prev/next/last navigation. Pure presentational — the page owns the
 * fetch, so emits are wired straight into query state.
 */
const props = defineProps<{
  page: number
  pageSize: number
  total: number
  pending?: boolean
}>()
const emit = defineEmits<{ 'update:page': [n: number]; 'update:pageSize': [n: number] }>()

const PAGE_SIZES = [20, 50, 100, 200]

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))
const from = computed(() => (props.total === 0 ? 0 : (props.page - 1) * props.pageSize + 1))
const to = computed(() => Math.min(props.page * props.pageSize, props.total))

// Select values are strings (reka rejects non-string semantics downstream)
const sizeSelect = computed({
  get: () => String(props.pageSize),
  set: (v: string) => emit('update:pageSize', Number(v) || 50),
})
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
    <div class="flex items-center gap-3 text-sm text-muted-foreground">
      <span class="tabular-nums">{{ total === 0 ? 'No entries' : `Showing ${from}–${to} of ${total}` }}</span>
      <div class="flex items-center gap-1.5">
        <span class="text-xs">Per page</span>
        <Select v-model="sizeSelect">
          <SelectTrigger class="h-8 w-19"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="s in PAGE_SIZES" :key="s" :value="String(s)">{{ s }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" :disabled="pending || page <= 1" @click="emit('update:page', 1)">«</Button>
      <Button variant="outline" size="sm" :disabled="pending || page <= 1" @click="emit('update:page', page - 1)"
        >Prev</Button
      >
      <span class="min-w-24 text-center text-sm tabular-nums">Page {{ page }} / {{ pageCount }}</span>
      <Button
        variant="outline"
        size="sm"
        :disabled="pending || page >= pageCount"
        @click="emit('update:page', page + 1)"
        >Next</Button
      >
      <Button
        variant="outline"
        size="sm"
        :disabled="pending || page >= pageCount"
        @click="emit('update:page', pageCount)"
        >»</Button
      >
    </div>
  </div>
</template>

<script lang="ts">
import type { HTMLAttributes } from 'vue'

/** A single column descriptor for <DataTable>. */
export interface DataTableColumn {
  /** Unique column key. Used to (a) read the default cell value via row[key] and
   * (b) name the cell-override slot `#cell-<key>`. For slot-only columns
   * (badges, actions) this can be any unique string. */
  key: string
  header?: string
  /** Class applied to every body cell in this column. */
  class?: HTMLAttributes['class']
  /** Class applied to the header cell (<th>). */
  headClass?: HTMLAttributes['class']
}
</script>

<script setup lang="ts" generic="T">
/**
 * Prebuilt, reusable, column-driven table built on the shadcn-vue Table
 * primitives. Pass a `columns` config and a `rows` array; the default cell
 * content is `row[key]`, and any column's cell can be overridden with a
 * `#cell-<key>` slot (for badges, buttons, selects, links, …). The empty state
 * and the overflow/scroll wrapper are handled consistently.
 *
 * Slot-based rather than TanStack Table: every table in this app renders
 * interactive cells (Select/Checkbox/Button in users, NuxtLink in events) that
 * read far more cleanly as templates than as h() render functions, and none need
 * client-side sorting/pagination yet. TanStack can be layered on later if that
 * changes — the slot surface would stay the same.
 */
withDefaults(
  defineProps<{
    columns: DataTableColumn[]
    rows: T[]
    /** Stable per-row key (DB id, sessionId, …) for the v-for :key. */
    rowKey: (row: T) => string | number
    empty?: string
    /** When provided, each row for which this returns true gets a second,
     *  full-width "detail" row rendering the `#detail` slot — e.g. an
     *  expandable JSON blob under an audit entry. Omit for ordinary tables. */
    detailWhen?: (row: T) => boolean
    /** Optional per-row class (or data-state) — e.g. return
     *  `selected ? 'bg-muted' : undefined` to highlight the active row. */
    rowClass?: (row: T) => HTMLAttributes['class']
  }>(),
  { empty: 'No data.' },
)

// Default cell fallback: read row[key]. Overridden per-column via #cell-<key>.
function valueAt(row: T, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key]
}
</script>

<template>
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead v-for="col in columns" :key="col.key" :class="col.headClass">
          {{ col.header }}
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableEmpty v-if="!rows.length" :colspan="columns.length">{{ empty }}</TableEmpty>
      <template v-for="(row, i) in rows" :key="rowKey(row)">
        <TableRow :class="rowClass?.(row)">
          <TableCell v-for="col in columns" :key="col.key" :class="col.class">
            <slot :name="`cell-${col.key}`" :row="row" :index="i">
              {{ valueAt(row, col.key) }}
            </slot>
          </TableCell>
        </TableRow>
        <TableRow v-if="detailWhen?.(row)">
          <TableCell :colspan="columns.length" class="p-0">
            <slot name="detail" :row="row" :index="i" />
          </TableCell>
        </TableRow>
      </template>
    </TableBody>
  </Table>
</template>

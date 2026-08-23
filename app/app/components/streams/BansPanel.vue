<script setup lang="ts">
/**
 * Streaming blacklist panel (小黑屋). Scope selector: this event / site-wide.
 * Bans are permanent; rows list email, scope, reason, who, when — with a lift
 * (unban) action. Reused by the event Bans tab (eventId pinned) and the Users
 * page (site-wide list).
 */
import type { DataTableColumn } from '~/components/DataTable.vue'

export interface BanRow {
  id: number
  email: string
  eventId: number | null
  reason: string | null
  bannedBy: string | null
  createdAt: number
}

const props = defineProps<{
  /** when set, the panel manages THIS event's scope (plus shows site-wide rows) */
  eventId?: number
}>()

const toast = useToast()
const confirm = useConfirm()

const email = ref('')
const reason = ref('')
const scope = ref<'event' | 'site'>(props.eventId != null ? 'event' : 'site')
const adding = ref(false)

const { data: bans, refresh } = useFetch<BanRow[]>('/api/bans', {
  params: computed(() => (props.eventId != null ? { eventId: props.eventId } : {})),
})

const visible = computed(() =>
  (bans.value ?? []).filter((b) => (props.eventId != null ? b.eventId === props.eventId || b.eventId === null : true)),
)

async function addBan(): Promise<void> {
  const e = email.value.trim()
  if (!e) {
    toast.error('Enter the account email to ban')
    return
  }
  adding.value = true
  try {
    await $fetch('/api/bans', {
      method: 'POST',
      body: {
        email: e,
        eventId: scope.value === 'event' && props.eventId != null ? props.eventId : null,
        reason: reason.value.trim() || null,
      },
    })
    toast.success(`Banned ${e} (${scope.value === 'event' ? 'this event' : 'site-wide'})`)
    email.value = ''
    reason.value = ''
    await refresh()
  } catch (err: any) {
    toast.error('Ban failed: ' + (err?.data?.statusMessage || err?.message || ''))
  } finally {
    adding.value = false
  }
}

function lift(b: BanRow): void {
  const scopeLabel = b.eventId === null ? 'site-wide' : 'this event'
  confirm.ask(
    `Lift the ${scopeLabel} ban on ${b.email}? They will be able to stream again immediately.`,
    async () => {
      try {
        await $fetch(`/api/bans/${b.id}`, { method: 'DELETE' })
        toast.success(`Unbanned ${b.email}`)
        await refresh()
      } catch (e: any) {
        toast.error('Unban failed: ' + (e?.data?.statusMessage || e?.message || ''))
      }
    },
    { actionLabel: 'Unban' },
  )
}

const columns: DataTableColumn[] = [
  { key: 'email', header: 'User', class: 'font-medium' },
  { key: 'scope', header: 'Scope' },
  { key: 'reason', header: 'Reason', class: 'text-muted-foreground' },
  { key: 'createdAt', header: 'Banned at', class: 'text-muted-foreground' },
  { key: 'actions', header: '', headClass: 'w-0' },
]
</script>

<template>
  <div class="space-y-4">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div class="space-y-1.5">
        <Label>Account email</Label>
        <Input v-model="email" placeholder="user@example.com" @keyup.enter="addBan" />
      </div>
      <div class="space-y-1.5">
        <Label>Reason (optional)</Label>
        <Input v-model="reason" placeholder="e.g. streamed prohibited content" @keyup.enter="addBan" />
      </div>
      <div class="flex items-end gap-2">
        <div v-if="eventId != null" class="space-y-1.5">
          <Label>Scope</Label>
          <Select v-model="scope">
            <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="event">This event</SelectItem>
              <SelectItem value="site">Site-wide</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button :disabled="adding" @click="addBan">{{ adding ? 'Banning…' : 'Ban' }}</Button>
      </div>
    </div>

    <DataTable :columns="columns" :rows="visible" :row-key="(b: BanRow) => b.id" empty="No streaming bans.">
      <template #cell-scope="{ row }">
        <Badge :variant="row.eventId === null ? 'destructive' : 'warning'">
          {{ row.eventId === null ? 'Site-wide' : 'This event' }}
        </Badge>
      </template>
      <template #cell-reason="{ row }">{{ row.reason ?? '—' }}</template>
      <template #cell-createdAt="{ row }">
        {{ new Date(row.createdAt).toLocaleString('en-US', { hour12: false }) }}
      </template>
      <template #cell-actions="{ row }">
        <Button size="sm" variant="outline" @click="lift(row)">Unban</Button>
      </template>
    </DataTable>

    <ConfirmDialog
      v-model:open="confirm.state.open"
      :message="confirm.state.message"
      :action-label="confirm.state.actionLabel"
      :destructive="confirm.state.destructive"
      @accept="confirm.accept"
    />
  </div>
</template>

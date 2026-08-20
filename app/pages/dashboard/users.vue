<script setup lang="ts">
import { Megaphone, Trash2 } from 'lucide-vue-next'
import type { UserWithGroupsView, GroupView } from '#shared/groups'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'default' })

const toast = useToast()
const confirm = useConfirm()
const { data: users, refresh } = useFetch<UserWithGroupsView[]>('/api/users')
const { data: groups } = useFetch<GroupView[]>('/api/groups')
/** registered media nodes (for the assignment select) */
const { data: mediaNodes, refresh: refreshNodes } = useFetch<{ nodeId: string; hostname: string; assignedUsers: number; maxUsers: number }[]>('/api/media-nodes')

// Editable per-user working copies (role + selected group ids), populated
// lazily on first edit. The template reads the live user values as a fallback
// when no draft exists yet (roleOf/inGroup), so rendering never depends on a
// watcher having run first — SSR-safe even though the users list resolves
// asynchronously after setup.
const draft = ref<Record<number, { role: 'admin' | 'user'; groupIds: number[]; nodeId: string | null }>>({})
function ensureDraft(u: UserWithGroupsView): void {
  if (!draft.value[u.id]) {
    draft.value[u.id] = { role: u.role, groupIds: u.groups.map((g) => g.id), nodeId: u.nodeId }
  }
}
/** Select value: sentinel for "no node" (reka rejects empty SelectItem values).
 *  There is no auto option — clearing means the user gets their one-time
 *  backfill assignment on their next latency report. */
const NONE = '(none)'
function nodeOf(u: UserWithGroupsView): string {
  return draft.value[u.id]?.nodeId ?? u.nodeId ?? NONE
}
function setNode(u: UserWithGroupsView, v: unknown): void {
  ensureDraft(u)
  draft.value[u.id]!.nodeId = v === NONE || typeof v !== 'string' ? null : v
}
/** Latency chips: sorted ascending, unknown-last. */
function latencyChips(u: UserWithGroupsView): { nodeId: string; ms: number }[] {
  return Object.entries(u.latencies ?? {})
    .map(([nodeId, ms]) => ({ nodeId, ms }))
    .sort((a, b) => a.ms - b.ms)
}
function roleOf(u: UserWithGroupsView): 'admin' | 'user' {
  return draft.value[u.id]?.role ?? u.role
}
function inGroup(u: UserWithGroupsView, groupId: number): boolean {
  const d = draft.value[u.id]
  return d ? d.groupIds.includes(groupId) : u.groups.some((g) => g.id === groupId)
}
function setRole(u: UserWithGroupsView, role: unknown): void {
  ensureDraft(u)
  if (role === 'admin' || role === 'user') draft.value[u.id]!.role = role
}
function toggleGroup(u: UserWithGroupsView, groupId: number): void {
  ensureDraft(u)
  const d = draft.value[u.id]!
  const i = d.groupIds.indexOf(groupId)
  if (i >= 0) d.groupIds.splice(i, 1)
  else d.groupIds.push(groupId)
}

function dirty(u: UserWithGroupsView): boolean {
  const d = draft.value[u.id]
  if (!d) return false
  if (d.role !== u.role) return true
  if ((d.nodeId ?? null) !== (u.nodeId ?? null)) return true
  return d.groupIds.slice().sort().join(',') !== u.groups.map((g) => g.id).sort().join(',')
}

const saving = ref(false)
const saved = ref(false)
const anyDirty = computed(() => (users.value ?? []).some((u) => dirty(u)))
async function saveAll(): Promise<boolean> {
  const dirtyUsers = (users.value ?? []).filter((u) => dirty(u))
  if (!dirtyUsers.length) return false
  saving.value = true
  saved.value = false
  try {
    await Promise.all(
      dirtyUsers.map((u) => {
        const d = draft.value[u.id]!
        return $fetch(`/api/users/${u.id}`, {
          method: 'PATCH',
          body: { role: d.role, groupIds: d.groupIds, nodeId: d.nodeId },
        })
      }),
    )
    toast.success(`Updated ${dirtyUsers.length} user${dirtyUsers.length > 1 ? 's' : ''}`)
    await Promise.all([refresh(), refreshNodes()])
    draft.value = {}
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    return true
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || ''))
    await refresh() // resync drafts with server state on partial failure
    return false
  } finally {
    saving.value = false
  }
}
function resetAll(): void {
  draft.value = {}
}

// Warn before leaving with unsaved edits; the SaveBar + dialog provide the UI.
const { confirmLeave, proceed } = useUnsavedLeaveGuard(anyDirty, saving)
async function saveAndLeave(): Promise<void> {
  if (await saveAll()) proceed()
}
function discardAndLeave(): void {
  resetAll()
  proceed()
}

const columns: DataTableColumn[] = [
  { key: 'email', header: 'Email', class: 'font-medium' },
  { key: 'role', header: 'Role' },
  { key: 'groups', header: 'Groups' },
  { key: 'node', header: 'Node' },
  { key: 'createdAt', header: 'Created' },
  { key: 'actions', header: '', headClass: 'w-0' },
]

/* --------------------- per-user dashboard announcement ------------------- */
// Admin-authored notice aimed at ONE user — shown on their dashboard home as
// "Announcement for you". Edited in a per-row dialog; saved immediately via
// PATCH /api/users/:id (independent of the row drafts / SaveBar below).
const announceOpen = ref(false)
const announceTarget = ref<UserWithGroupsView | null>(null)
const announceDraft = ref('')
const announceSaving = ref(false)

function openAnnouncement(u: UserWithGroupsView): void {
  announceTarget.value = u
  announceDraft.value = u.announcement ?? ''
  announceOpen.value = true
}

async function saveAnnouncement(next: string | null): Promise<void> {
  // Capture the target FIRST — closing the dialog nulls announceTarget, and a
  // Save that raced the close used to read null and silently save nothing.
  const target = announceTarget.value
  if (!target) return
  announceSaving.value = true
  try {
    await $fetch(`/api/users/${target.id}`, {
      method: 'PATCH',
      body: { announcement: next },
    })
    toast.success(next ? 'Announcement saved' : 'Announcement cleared')
    announceOpen.value = false
    announceTarget.value = null
    await refresh()
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    announceSaving.value = false
  }
}

/** Delete a user (server guards: not yourself, not the last admin). */
function deleteUser(u: UserWithGroupsView): void {
  confirm.ask(`Delete ${u.email}? Their group memberships and latency data go with the account; historical sessions and audit entries stay.`, async () => {
    try {
      await $fetch(`/api/users/${u.id}`, { method: 'DELETE' })
      delete draft.value[u.id]
      toast.info(`${u.email} deleted`)
      await Promise.all([refresh(), refreshNodes()])
    } catch (e: any) {
      toast.error('Delete failed: ' + (e?.data?.statusMessage || e?.message || ''))
    }
  }, { actionLabel: 'Delete', destructive: true })
}
</script>

<template>
  <div class="space-y-6 pb-24">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Users</h1>
      <p class="text-muted-foreground">Manage roles and group membership. The first registered account is the super admin.</p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Streaming bans (site-wide blacklist)</CardTitle>
        <CardDescription>Banned accounts can never publish anywhere. Manage the list below.</CardDescription>
      </CardHeader>
      <CardContent>
        <StreamsBansPanel />
      </CardContent>
    </Card>

    <Card>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="users ?? []"
          :row-key="(u: UserWithGroupsView) => u.id"
          empty="No users yet."
        >
          <template #cell-role="{ row }">
            <div class="flex items-center gap-2">
              <Select
                :model-value="roleOf(row)"
                :disabled="saving"
                @update:model-value="setRole(row, $event)"
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </template>
          <template #cell-groups="{ row }">
            <div class="flex max-w-[320px] flex-col gap-1">
              <label v-for="g in groups" :key="g.id" class="flex items-center gap-1.5 text-xs">
                <Checkbox
                  :model-value="inGroup(row, g.id)"
                  :disabled="saving"
                  @update:model-value="toggleGroup(row, g.id)"
                />
                <span>{{ g.name }}</span>
              </label>
              <span v-if="!groups || !groups.length" class="text-xs text-muted-foreground">No groups defined.</span>
            </div>
          </template>
          <template #cell-node="{ row }">
            <div class="flex max-w-65 flex-col gap-1.5">
              <Select
                :model-value="nodeOf(row)"
                :disabled="saving"
                @update:model-value="setNode(row, $event)"
              >
                <SelectTrigger class="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="NONE">unassigned</SelectItem>
                  <SelectItem v-for="n in mediaNodes ?? []" :key="n.nodeId" :value="n.nodeId">
                    {{ n.nodeId }} ({{ n.assignedUsers }}/{{ n.maxUsers }})
                  </SelectItem>
                </SelectContent>
              </Select>
              <div v-if="latencyChips(row).length" class="flex flex-wrap gap-1">
                <span
                  v-for="l in latencyChips(row)"
                  :key="l.nodeId"
                  class="rounded-sm bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
                  :class="{ 'text-foreground font-semibold': l.nodeId === nodeOf(row) }"
                >{{ l.nodeId }} {{ l.ms }}ms</span>
              </div>
              <span v-else class="text-[10px] text-muted-foreground">no latency data yet</span>
            </div>
          </template>
          <template #cell-createdAt="{ row }">
            <span class="text-xs text-muted-foreground">{{ new Date(row.createdAt).toLocaleDateString('en-US') }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                :aria-label="`Announcement for ${row.email}`"
                :class="row.announcement ? 'text-primary' : 'text-muted-foreground'"
                @click="openAnnouncement(row)"
              >
                <Megaphone :size="14" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-destructive"
                :aria-label="`Delete ${row.email}`"
                @click="deleteUser(row)"
              >
                <Trash2 :size="14" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <SaveBar :dirty="anyDirty" :saving="saving" :saved="saved" @save="saveAll" @discard="resetAll" />
    <UnsavedLeaveDialog
      :open="confirmLeave"
      :saving="saving"
      @stay="confirmLeave = false"
      @discard="discardAndLeave"
      @save="saveAndLeave"
    />

    <ConfirmDialog
      v-model:open="confirm.state.open"
      :message="confirm.state.message"
      :action-label="confirm.state.actionLabel"
      :destructive="confirm.state.destructive"
      @accept="confirm.accept"
    />

    <!-- per-user dashboard announcement editor -->
    <AlertDialog v-model:open="announceOpen">
      <AlertDialogContent class="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Announcement for {{ announceTarget?.email }}</AlertDialogTitle>
          <AlertDialogDescription>
            Shown on this user's dashboard home as "Announcement for you". Markdown supported.
            Leave empty / clear to remove.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea
          v-model="announceDraft"
          rows="5"
          placeholder="e.g. Your streams will be reviewed before the final — please keep the canvas visible."
        />
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="announceSaving">Cancel</AlertDialogCancel>
          <Button
            variant="outline"
            :disabled="announceSaving || !announceDraft.trim()"
            @click="saveAnnouncement(null)"
          >
            Clear
          </Button>
          <!-- Plain button on purpose: AlertDialogAction auto-closes the dialog
               on click, which used to null the target before the save ran. -->
          <Button :disabled="announceSaving" @click="saveAnnouncement(announceDraft.trim() || null)">
            {{ announceSaving ? 'Saving…' : 'Save' }}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

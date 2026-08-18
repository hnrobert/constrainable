<script setup lang="ts">
import type { UserWithGroupsView, GroupView } from '#shared/groups'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'default' })

const toast = useToast()
const confirm = useConfirm()
const { data: users, refresh } = useFetch<UserWithGroupsView[]>('/api/users')
const { data: groups } = useFetch<GroupView[]>('/api/groups')

// Editable per-user working copies (role + selected group ids), populated
// lazily on first edit. The template reads the live user values as a fallback
// when no draft exists yet (roleOf/inGroup), so rendering never depends on a
// watcher having run first — SSR-safe even though the users list resolves
// asynchronously after setup.
const draft = ref<Record<number, { role: 'admin' | 'user'; groupIds: number[] }>>({})
function ensureDraft(u: UserWithGroupsView): void {
  if (!draft.value[u.id]) {
    draft.value[u.id] = { role: u.role, groupIds: u.groups.map((g) => g.id) }
  }
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
        return $fetch(`/api/users/${u.id}`, { method: 'PATCH', body: { role: d.role, groupIds: d.groupIds } })
      }),
    )
    toast.success(`Updated ${dirtyUsers.length} user${dirtyUsers.length > 1 ? 's' : ''}`)
    await refresh()
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
  { key: 'createdAt', header: 'Created' },
]
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
          <template #cell-createdAt="{ row }">
            <span class="text-xs text-muted-foreground">{{ new Date(row.createdAt).toLocaleDateString('en-US') }}</span>
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
  </div>
</template>

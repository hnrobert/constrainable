<script setup lang="ts">
import type { GroupView, InviteLinkView, InviteLinkInput } from '#shared/groups'
import type { DataTableColumn } from '~/components/DataTable.vue'

definePageMeta({ layout: 'default' })

const toast = useToast()
const confirm = useConfirm()
const { data: groups, refresh: refreshGroups } = useFetch<GroupView[]>('/api/groups')
const { data: invites, refresh: refreshInvites } = useFetch<InviteLinkView[]>('/api/invite-links')

async function reloadAll(): Promise<void> {
  await Promise.all([refreshGroups(), refreshInvites()])
}

// --- Group CRUD -----------------------------------------------------------
const newGroupName = ref('')
const newGroupDesc = ref('')
const creatingGroup = ref(false)
async function createGroup(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name) {
    toast.error('Group name is required')
    return
  }
  creatingGroup.value = true
  try {
    await $fetch('/api/groups', { method: 'POST', body: { name, description: newGroupDesc.value.trim() || null } })
    newGroupName.value = ''
    newGroupDesc.value = ''
    toast.success('Group created')
    await reloadAll()
  } catch (e: any) {
    toast.error('Create failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    creatingGroup.value = false
  }
}

// Inline edit state per group id.
const editId = ref<number | null>(null)
const editName = ref('')
const editDesc = ref('')
const editOrig = ref<{ name: string; description: string }>({ name: '', description: '' })
function startEdit(g: GroupView): void {
  editId.value = g.id
  editName.value = g.name
  editDesc.value = g.description ?? ''
  editOrig.value = { name: g.name, description: g.description ?? '' }
}
function cancelEdit(): void {
  editId.value = null
}
const editDirty = computed(
  () =>
    editId.value !== null && (editName.value !== editOrig.value.name || editDesc.value !== editOrig.value.description),
)
const saving = ref(false)
const saved = ref(false)
async function saveEdit(): Promise<boolean> {
  if (editId.value === null) return false
  const name = editName.value.trim()
  if (!name) {
    toast.error('Group name is required')
    return false
  }
  saving.value = true
  saved.value = false
  try {
    const id = editId.value
    await $fetch(`/api/groups/${id}`, { method: 'PATCH', body: { name, description: editDesc.value.trim() || null } })
    toast.success('Group updated')
    editId.value = null
    await reloadAll()
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    return true
  } catch (e: any) {
    toast.error('Update failed: ' + (e?.data?.statusMessage || e?.message || ''))
    return false
  } finally {
    saving.value = false
  }
}

// Warn before leaving with an unsaved inline edit; the SaveBar + dialog provide the UI.
const { confirmLeave, proceed } = useUnsavedLeaveGuard(editDirty, saving)
async function saveAndLeave(): Promise<void> {
  if (await saveEdit()) proceed()
}
function discardAndLeave(): void {
  cancelEdit()
  proceed()
}
function removeGroup(g: GroupView): void {
  confirm.ask(
    `Delete group "${g.name}"? This removes it from all events and members.`,
    async () => {
      try {
        await $fetch(`/api/groups/${g.id}`, { method: 'DELETE' })
        toast.success('Group deleted')
        await reloadAll()
      } catch (e: any) {
        toast.error('Delete failed: ' + (e?.data?.statusMessage || e?.message || ''))
      }
    },
    { actionLabel: 'Delete' },
  )
}

// --- Invite links ---------------------------------------------------------
const inviteGroupId = ref<number | null>(null)
const inviteMaxUses = ref('')
const inviteTtlHours = ref('')
const inviteNote = ref('')
const creatingInvite = ref(false)
// The most recently created invite's shareable URL (code is shown once).
const lastInviteUrl = ref('')

async function createInvite(): Promise<void> {
  const groupId = inviteGroupId.value
  if (!groupId) {
    toast.error('Select a target group')
    return
  }
  const input: InviteLinkInput = { groupId }
  const mu = inviteMaxUses.value.trim()
  if (mu) {
    const n = Number(mu)
    if (!Number.isInteger(n) || n <= 0) {
      toast.error('Max uses must be a positive whole number')
      return
    }
    input.maxUses = n
  }
  const ttl = inviteTtlHours.value.trim()
  if (ttl) {
    const n = Number(ttl)
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('TTL must be a positive number of hours')
      return
    }
    input.ttlHours = n
  }
  const note = inviteNote.value.trim()
  if (note) input.note = note

  creatingInvite.value = true
  try {
    const created = await $fetch<InviteLinkView>('/api/invite-links', { method: 'POST', body: input })
    lastInviteUrl.value = inviteUrl(created.code)
    inviteMaxUses.value = ''
    inviteTtlHours.value = ''
    inviteNote.value = ''
    toast.success('Invite link created')
    await reloadAll()
  } catch (e: any) {
    toast.error('Create failed: ' + (e?.data?.statusMessage || e?.message || ''))
  } finally {
    creatingInvite.value = false
  }
}

function inviteUrl(code: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return `${origin}/invite?code=${code}`
}
async function copyInvite(url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url)
    toast.success('Invite link copied')
  } catch {
    toast.error('Copy failed — select and copy manually')
  }
}
function removeInvite(inv: InviteLinkView): void {
  confirm.ask(
    `Delete invite link for ${inv.groupName}?`,
    async () => {
      try {
        await $fetch(`/api/invite-links/${inv.id}`, { method: 'DELETE' })
        toast.success('Invite link deleted')
        await reloadAll()
      } catch (e: any) {
        toast.error('Delete failed: ' + (e?.data?.statusMessage || e?.message || ''))
      }
    },
    { actionLabel: 'Delete' },
  )
}

// --- Formatting helpers ---------------------------------------------------
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { hour12: false })
}
function fmtExpires(ms: number | null): string {
  if (!ms) return 'never'
  return new Date(ms).toLocaleString('en-US', { hour12: false })
}
function isExpired(ms: number | null): boolean {
  return ms != null && ms < Date.now()
}

const groupColumns: DataTableColumn[] = [
  { key: 'name', header: 'Name' },
  { key: 'description', header: 'Description' },
  { key: 'memberCount', header: 'Members' },
  { key: 'createdAt', header: 'Created' },
  { key: 'actions', header: '', headClass: 'w-0' },
]

const inviteColumns: DataTableColumn[] = [
  { key: 'groupName', header: 'Group', class: 'font-medium' },
  { key: 'uses', header: 'Uses' },
  { key: 'expiresAt', header: 'Expires', class: 'text-xs text-muted-foreground' },
  { key: 'state', header: 'State' },
  { key: 'note', header: 'Note', class: 'text-xs text-muted-foreground' },
  { key: 'createdAt', header: 'Created', class: 'text-xs text-muted-foreground' },
  { key: 'actions', header: '', headClass: 'w-0' },
]
</script>

<template>
  <div class="space-y-6 pb-24">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Groups &amp; invites</h1>
      <p class="text-muted-foreground">
        Organize users into groups, then restrict events to specific groups. Invite links let new registrants or
        existing users join a group automatically.
      </p>
    </div>

    <!-- Groups -->
    <Card>
      <CardHeader><CardTitle>Groups</CardTitle></CardHeader>
      <CardContent class="space-y-4">
        <DataTable
          :columns="groupColumns"
          :rows="groups ?? []"
          :row-key="(g: GroupView) => g.id"
          empty="No groups yet."
        >
          <template #cell-name="{ row }">
            <Input v-if="editId === row.id" v-model="editName" :disabled="saving" />
            <span v-else class="font-medium">{{ row.name }}</span>
          </template>
          <template #cell-description="{ row }">
            <Input v-if="editId === row.id" v-model="editDesc" :disabled="saving" placeholder="optional" />
            <span v-else class="text-muted-foreground">{{ row.description || '—' }}</span>
          </template>
          <template #cell-memberCount="{ row }">
            <span :class="{ 'text-muted-foreground': editId === row.id }">{{ row.memberCount }}</span>
          </template>
          <template #cell-createdAt="{ row }">
            <span v-if="editId !== row.id" class="text-xs text-muted-foreground">{{ fmtDate(row.createdAt) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div v-if="editId !== row.id" class="flex justify-end gap-2">
              <Button size="sm" variant="outline" @click="startEdit(row)">Edit</Button>
              <Button size="sm" variant="destructive" @click="removeGroup(row)">Delete</Button>
            </div>
          </template>
        </DataTable>

        <div class="flex flex-wrap items-center gap-2">
          <Input
            v-model="newGroupName"
            placeholder="New group name"
            class="min-w-45 flex-1"
            @keyup.enter="createGroup"
          />
          <Input v-model="newGroupDesc" placeholder="Description (optional)" class="min-w-45 flex-1" />
          <Button :disabled="creatingGroup" @click="createGroup">
            {{ creatingGroup ? 'Adding…' : 'Add group' }}
          </Button>
        </div>
      </CardContent>
    </Card>

    <!-- Invite links -->
    <Card>
      <CardHeader><CardTitle>Invite links</CardTitle></CardHeader>
      <CardContent class="space-y-4">
        <div
          v-if="lastInviteUrl"
          class="flex flex-col items-start gap-1.5 rounded-md border border-ok/50 p-3 text-sm text-ok"
        >
          <span>New link created — copy it now (shown once):</span>
          <code class="break-all text-xs">{{ lastInviteUrl }}</code>
          <Button variant="link" class="h-auto p-0 text-xs" @click="copyInvite(lastInviteUrl)">Copy</Button>
        </div>

        <DataTable
          :columns="inviteColumns"
          :rows="invites ?? []"
          :row-key="(inv: InviteLinkView) => inv.id"
          empty="No invite links yet."
        >
          <template #cell-uses="{ row }">
            {{ row.usedCount }}{{ row.maxUses != null ? ' / ' + row.maxUses : ' / ∞' }}
          </template>
          <template #cell-expiresAt="{ row }">
            {{ fmtExpires(row.expiresAt) }}
          </template>
          <template #cell-state="{ row }">
            <Badge v-if="!row.active" variant="destructive">inactive</Badge>
            <Badge v-else-if="isExpired(row.expiresAt)" variant="destructive">expired</Badge>
            <Badge v-else-if="row.maxUses != null && row.usedCount >= row.maxUses" variant="warning">exhausted</Badge>
            <Badge v-else variant="success">active</Badge>
          </template>
          <template #cell-note="{ row }">
            {{ row.note || '—' }}
          </template>
          <template #cell-createdAt="{ row }">
            {{ fmtDate(row.createdAt) }}
          </template>
          <template #cell-actions="{ row }">
            <div class="flex justify-end gap-2">
              <Button variant="link" class="h-auto p-0 text-xs" @click="copyInvite(inviteUrl(row.code))"
                >Copy link</Button
              >
              <Button size="sm" variant="destructive" @click="removeInvite(row)">Delete</Button>
            </div>
          </template>
        </DataTable>

        <div v-if="groups && groups.length" class="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] items-end gap-3">
          <div class="space-y-1.5">
            <Label>Target group</Label>
            <Select v-model="inviteGroupId">
              <SelectTrigger class="w-full"><SelectValue placeholder="Select a group…" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label>Max uses (blank = unlimited)</Label>
            <Input v-model="inviteMaxUses" inputmode="numeric" placeholder="∞" />
          </div>
          <div class="space-y-1.5">
            <Label>Expires in (hours, blank = never)</Label>
            <Input v-model="inviteTtlHours" inputmode="decimal" placeholder="24" />
          </div>
          <div class="space-y-1.5">
            <Label>Note (optional)</Label>
            <Input v-model="inviteNote" placeholder="e.g. Spring cohort" />
          </div>
          <div class="col-span-full">
            <Button :disabled="creatingInvite" @click="createInvite">
              {{ creatingInvite ? 'Creating…' : 'Create invite link' }}
            </Button>
          </div>
        </div>
        <p v-else class="text-xs text-muted-foreground">Create a group first before generating invite links.</p>
      </CardContent>
    </Card>

    <SaveBar :dirty="editDirty" :saving="saving" :saved="saved" @save="saveEdit" @discard="cancelEdit" />
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

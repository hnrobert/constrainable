<script setup lang="ts">
/**
 * User settings — self-service password change. Any logged-in user; the
 * current password is required (verified server-side) and both fields travel
 * RSA-encrypted exactly like login (usePasswordCipher). Changing the password
 * also re-mints the RTMP authmod verifier server-side, so OBS sign-in uses
 * the NEW password from that moment.
 */
definePageMeta({ layout: 'default' })
useAuth()
  .fetchSession()
  .catch(() => null)

const { user, logout } = useAuth()
const toast = useToast()
const currentPassword = ref('')
const newPassword = ref('')
const confirm = ref('')
const saving = ref(false)

const mismatch = computed(() => confirm.value !== '' && newPassword.value !== confirm.value)
const tooShort = computed(() => newPassword.value !== '' && newPassword.value.length < 6)
const sameAsCurrent = computed(() => newPassword.value !== '' && newPassword.value === currentPassword.value)
const canSave = computed(
  () =>
    currentPassword.value !== '' &&
    newPassword.value !== '' &&
    confirm.value !== '' &&
    !mismatch.value &&
    !tooShort.value &&
    !sameAsCurrent.value &&
    !saving.value,
)

async function changePassword(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  try {
    const currentCipher = await encryptPassword(currentPassword.value)
    const newCipher = await encryptPassword(newPassword.value)
    await $fetch('/api/me/password', {
      method: 'POST',
      body: { currentPassword: currentCipher, newPassword: newCipher },
    })
    toast.success('Password changed — use it next time you sign in (and in OBS)')
    currentPassword.value = ''
    newPassword.value = ''
    confirm.value = ''
  } catch (e: any) {
    toast.error(e?.data?.statusMessage || e?.message || 'Change failed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">My settings</h1>
      <p class="text-muted-foreground">
        Signed in as <code class="font-mono text-sm">{{ user?.email }}</code>
        <Badge class="ml-2 uppercase" variant="secondary">{{ user?.role }}</Badge>
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>
          Requires your current password. The new one applies to the website AND to OBS' "Use authentication" sign-in
          immediately.
        </CardDescription>
      </CardHeader>
      <CardContent class="max-w-md space-y-4">
        <div class="space-y-1.5">
          <Label for="cur">Current password</Label>
          <Input id="cur" v-model="currentPassword" type="password" autocomplete="current-password" />
        </div>
        <div class="space-y-1.5">
          <Label for="new">New password</Label>
          <Input id="new" v-model="newPassword" type="password" autocomplete="new-password" />
          <p v-if="tooShort" class="text-xs text-destructive">At least 6 characters.</p>
          <p v-else-if="sameAsCurrent" class="text-xs text-destructive">Must differ from the current password.</p>
        </div>
        <div class="space-y-1.5">
          <Label for="conf">Confirm new password</Label>
          <Input id="conf" v-model="confirm" type="password" autocomplete="new-password" />
          <p v-if="mismatch" class="text-xs text-destructive">The two passwords do not match.</p>
        </div>
        <Button :disabled="!canSave" @click="changePassword">
          {{ saving ? 'Changing…' : 'Change password' }}
        </Button>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Sign out</CardTitle>
        <CardDescription>End this session on all open tabs of this browser.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" @click="logout">Sign out</Button>
      </CardContent>
    </Card>
  </div>
</template>

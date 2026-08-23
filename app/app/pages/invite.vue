<script setup lang="ts">
import { setPendingInvite } from '~/composables/useAuth'

definePageMeta({ layout: 'public' })

const route = useRoute()
const router = useRouter()
const toast = useToast()
const { user } = useAuth()

const code = computed(() => (typeof route.query.code === 'string' ? route.query.code.trim() : ''))

// If there's no code at all, this isn't a real invite visit — bounce home.
onMounted(() => {
  if (!code.value) {
    router.replace('/')
  }
})

// Unauthenticated visitors: stash the code and send them to register/login.
// The composable re-attaches it on register(); existing users can also claim
// from the dashboard, but the primary invite path is sign-in → claim.
const claiming = ref(false)
const joined = ref<{ groupId: number; groupName: string } | null>(null)

async function claim(): Promise<void> {
  if (!code.value || claiming.value) return
  claiming.value = true
  try {
    const res = await $fetch<{ ok: true; groupId: number; groupName: string }>(
      `/api/invite-links/${encodeURIComponent(code.value)}/claim`,
      { method: 'POST' },
    )
    joined.value = { groupId: res.groupId, groupName: res.groupName }
    toast.success(`You joined ${res.groupName}`)
  } catch (e: any) {
    toast.error('Invite is invalid or expired')
  } finally {
    claiming.value = false
  }
}

function goSignIn(): void {
  if (code.value) setPendingInvite(code.value)
  router.push({ path: '/login', query: code.value ? { invite: code.value } : undefined })
}
</script>

<template>
  <section class="mx-auto w-full max-w-md space-y-4">
    <Card v-if="!code">
      <CardContent class="pt-6">
        <p class="text-muted-foreground">No invite code provided.</p>
      </CardContent>
    </Card>

    <!-- Already joined (or already a member — idempotent success). -->
    <Card v-else-if="joined" class="border-ok/50">
      <CardHeader><CardTitle>You're in 🎉</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <p>
          You joined the group <strong>{{ joined.groupName }}</strong
          >.
        </p>
        <p class="text-sm text-muted-foreground">Events restricted to this group will now appear on your dashboard.</p>
        <Button as-child><NuxtLink to="/dashboard">Go to dashboard</NuxtLink></Button>
      </CardContent>
    </Card>

    <!-- Logged-in user: claim directly. -->
    <Card v-else-if="user">
      <CardHeader><CardTitle>Join a group</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <p>
          Signed in as <strong>{{ user.email }}</strong> — claim this invite to join its group.
        </p>
        <Button :disabled="claiming" @click="claim">
          {{ claiming ? 'Claiming…' : 'Join group' }}
        </Button>
      </CardContent>
    </Card>

    <!-- Not logged in: stash the invite, send to auth. -->
    <Card v-else>
      <CardHeader><CardTitle>You're invited</CardTitle></CardHeader>
      <CardContent class="space-y-3">
        <p>Register or sign in to accept this invite and join its group.</p>
        <Button @click="goSignIn">Sign in / Register</Button>
      </CardContent>
    </Card>
  </section>
</template>

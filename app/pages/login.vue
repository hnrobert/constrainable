<script setup lang="ts">
import { setPendingInvite } from '~/composables/useAuth'

definePageMeta({ layout: false })

const { login, register, sendCode, fetchBootstrap } = useAuth()
const toast = useToast()
const route = useRoute()

const mode = ref<'login' | 'register'>('login')
const email = ref('')
const password = ref('')
const confirm = ref('')
const code = ref('')
const loading = ref(false)
const error = ref('')

// bootstrap = no users yet → first registrant is super admin, no code needed.
const bootstrap = ref(false)
const inviteCode = ref('')
onMounted(async () => {
  bootstrap.value = await fetchBootstrap()
  // Stash an invite code from ?invite= so register() auto-joins its group.
  const inv = typeof route.query.invite === 'string' ? route.query.invite.trim() : ''
  if (inv) {
    inviteCode.value = inv
    setPendingInvite(inv)
  }
})

// client flow token keying the verification code (email:session); generated once
// per registration attempt.
const session = ref('')
const sendingCode = ref(false)
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

function newSession(): string {
  if (import.meta.client && globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Both admins and regular users land on the dashboard after authenticating.
const HOME = '/dashboard'

async function doSendCode(): Promise<void> {
  error.value = ''
  const e = email.value.trim()
  if (!e) {
    error.value = 'Please enter your email first'
    return
  }
  if (!session.value) session.value = newSession()
  sendingCode.value = true
  try {
    const r = await sendCode(e, session.value)
    if (r.bootstrap) {
      bootstrap.value = true
      toast.info('No admin exists yet; the first registration does not require a verification code')
      return
    }
    toast.success('Verification code sent, please check your inbox (valid for 10 minutes)')
    cooldown.value = 60
    cooldownTimer = setInterval(() => {
      cooldown.value -= 1
      if (cooldown.value <= 0 && cooldownTimer) {
        clearInterval(cooldownTimer)
        cooldownTimer = null
      }
    }, 1000)
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || 'Failed to send verification code'
  } finally {
    sendingCode.value = false
  }
}

async function submit(): Promise<void> {
  error.value = ''
  if (!email.value.trim() || !password.value) {
    error.value = 'Please enter your email and password'
    return
  }
  if (mode.value === 'register' && password.value !== confirm.value) {
    error.value = 'The two passwords do not match'
    return
  }
  if (mode.value === 'register' && !bootstrap.value && !code.value.trim()) {
    error.value = 'Please enter the email verification code'
    return
  }
  loading.value = true
  try {
    const u =
      mode.value === 'login'
        ? await login(email.value.trim(), password.value)
        : await register(email.value.trim(), password.value, code.value.trim(), session.value)
    toast.success(mode.value === 'login' ? 'Signed in successfully' : 'Registered successfully')
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : HOME
    await navigateTo(redirect, { replace: true })
  } catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || (mode.value === 'login' ? 'Sign in failed' : 'Registration failed')
  } finally {
    loading.value = false
  }
}

function switchMode(next: 'login' | 'register'): void {
  mode.value = next
  error.value = ''
  confirm.value = ''
  code.value = ''
}

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer)
})
</script>

<template>
  <div class="flex min-h-screen items-center justify-center p-4">
    <Card class="w-full max-w-sm">
      <CardContent class="flex flex-col gap-4 pt-6">
        <div class="space-y-1 text-center">
          <h1 class="text-xl font-semibold">Constrainable Ingest</h1>
          <p class="text-sm text-muted-foreground">{{ mode === 'login' ? 'Sign in' : 'Register account' }}</p>
        </div>

        <div
          v-if="inviteCode"
          class="rounded-md border border-ok/50 bg-ok/10 p-2.5 text-xs text-ok"
        >
          Joining via invite — your account will be added to the invite's group.
        </div>

        <!-- Segmented Sign in / Register toggle. -->
        <div class="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            :class="[
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              mode === 'login' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            ]"
            @click="switchMode('login')"
          >
            Sign in
          </button>
          <button
            type="button"
            :class="[
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              mode === 'register' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            ]"
            @click="switchMode('register')"
          >
            Register
          </button>
        </div>

        <form class="flex flex-col gap-3" @submit.prevent="submit">
          <div class="space-y-1.5">
            <Label for="login-email">Email</Label>
            <Input id="login-email" v-model="email" type="email" autocomplete="email" autofocus />
          </div>
          <div class="space-y-1.5">
            <Label for="login-password">Password</Label>
            <Input id="login-password" v-model="password" type="password" autocomplete="current-password" />
          </div>
          <div v-if="mode === 'register'" class="space-y-1.5">
            <Label for="login-confirm">Confirm password</Label>
            <Input id="login-confirm" v-model="confirm" type="password" autocomplete="new-password" />
          </div>

          <!-- Two-step verification code (skipped for the bootstrap super-admin). -->
          <div v-if="mode === 'register' && !bootstrap" class="flex items-end gap-2">
            <div class="flex-1 space-y-1.5">
              <Label for="login-code">Email verification code</Label>
              <Input id="login-code" v-model="code" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" />
            </div>
            <Button type="button" variant="outline" :disabled="sendingCode || cooldown > 0" @click="doSendCode">
              {{ cooldown > 0 ? `${cooldown}s` : sendingCode ? 'Sending…' : 'Get code' }}
            </Button>
          </div>

          <p v-if="mode === 'register'" class="text-xs leading-relaxed text-muted-foreground">
            <template v-if="bootstrap">
              No admin exists yet: the first registered user becomes the super admin (no email verification code required). Please use a personal email you can receive mail at.
            </template>
            <template v-else>
              You must first request an email verification code; after registration you become a regular user (event schedule and details only).
            </template>
          </p>

          <p v-if="error" class="text-sm font-medium text-destructive">{{ error }}</p>
          <Button type="submit" :disabled="loading">
            {{ loading ? 'Processing…' : mode === 'login' ? 'Sign in' : 'Register' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </div>
</template>

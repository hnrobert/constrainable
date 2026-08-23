<script setup lang="ts">
import type { MailConfigClient } from '#shared/mail'

const toast = useToast()

// Sync fetch (NO top-level await) so this page doesn't drag the dashboard
// layout into an async Suspense boundary (client hydration mismatch). Nuxt
// still awaits the registered useFetch promise during SSR and serializes the
// result; syncFromConfig (via the watch) re-syncs the editable form when data
// resolves.
const { data } = useFetch<MailConfigClient>('/api/mail/config')

// editable copy of the non-secret fields; secrets are entered into separate
// boxes and only sent when non-empty (server preserves the stored value then).
const form = reactive({
  provider: 'smtp',
  host: '',
  port: 587,
  useSsl: false,
  useTls: true,
  usePassword: true,
  senderEmail: '',
  senderDisplay: '',
  senderDomain: '',
  postUrl: '',
  postSchema: 'smtogo',
  postFieldMap: '',
})
const senderPassword = ref('')
const postAuthToken = ref('')

/** Webhook payload shape — visual selector backed by postFieldMap (authoritative). */
const PA_FIELD_MAP = '{"to":"email","subject":"subject","body":"content"}'
const SMTOGO_FIELD_MAP = '{"from":"from","to":"to","subject":"subject","bodyHtml":"html"}'
const postShape = ref<'powerautomate' | 'smtogo'>('smtogo')
function shapeOf(fieldMap: string, schema: string): 'powerautomate' | 'smtogo' {
  if (fieldMap.includes('"email"')) return 'powerautomate'
  if (fieldMap.trim()) return 'smtogo'
  return schema === 'powerautomate' ? 'powerautomate' : 'smtogo'
}
function applyPostShape(v: unknown): void {
  const pa = v === 'powerautomate'
  form.postFieldMap = pa ? PA_FIELD_MAP : SMTOGO_FIELD_MAP
  form.postSchema = pa ? 'powerautomate' : 'smtogo' // keep the legacy field in sync
}
const hasPassword = ref(false)
const hasPostAuthToken = ref(false)

const saving = ref(false)
const saved = ref(false)
const testing = ref(false)
const testTo = ref('')

// Copy the server config into the editable form + secret-presence flags.
function syncFromConfig(c: MailConfigClient): void {
  form.provider = c.provider ?? 'smtp'
  form.host = c.host ?? ''
  form.port = c.port ?? 587
  form.useSsl = c.useSsl ?? false
  form.useTls = c.useTls ?? true
  form.usePassword = c.usePassword ?? true
  form.senderEmail = c.senderEmail ?? ''
  form.senderDisplay = c.senderDisplay ?? ''
  form.senderDomain = c.senderDomain ?? ''
  form.postUrl = c.postUrl ?? ''
  form.postSchema = c.postSchema ?? 'smtogo'
  form.postFieldMap = c.postFieldMap ?? ''
  postShape.value = shapeOf(form.postFieldMap, form.postSchema)
  hasPassword.value = c.hasPassword ?? false
  hasPostAuthToken.value = c.hasPostAuthToken ?? false
}

// Re-sync whenever the server value resolves (SSR + client). testTo is seeded
// from the sender email only on first load, so a user-entered test recipient
// survives a save (which re-triggers this watch via data.value = updated).
let testToInitialized = false
// flush:'sync' so the form is populated at the moment `data` is assigned during
// SSR, before the render pass (the default pre-flush queue doesn't drain in
// time on the server). On the client, data hydrates from the payload
// synchronously during setup, so this runs before first render there too.
watch(
  data,
  (d) => {
    if (!d) return
    syncFromConfig(d)
    if (!testToInitialized) {
      testTo.value = d.senderEmail ?? ''
      testToInitialized = true
    }
  },
  { immediate: true, flush: 'sync' },
)

const dirty = computed(() => {
  if (!data.value) return false
  for (const k of Object.keys(form) as (keyof typeof form)[]) {
    if ((form[k] as unknown) !== (data.value as Record<string, unknown>)[k]) return true
  }
  return senderPassword.value !== '' || postAuthToken.value !== ''
})

async function save(): Promise<boolean> {
  saving.value = true
  saved.value = false
  try {
    const updated = await $fetch<MailConfigClient>('/api/mail/config', {
      method: 'PUT',
      body: { ...form, senderPassword: senderPassword.value, postAuthToken: postAuthToken.value },
    })
    data.value = updated
    // the watch re-syncs form + secret-presence flags from `updated` (clearing
    // dirty); clear the secret inputs so they don't keep flagging dirty.
    senderPassword.value = ''
    postAuthToken.value = ''
    toast.success('Mail configuration saved')
    saved.value = true
    setTimeout(() => {
      saved.value = false
    }, 2000)
    return true
  } catch (e: any) {
    toast.error('Save failed: ' + (e?.data?.statusMessage || e?.message || 'Unknown error'))
    return false
  } finally {
    saving.value = false
  }
}

async function sendTest(): Promise<void> {
  if (!testTo.value.trim()) {
    toast.error('Please enter a test recipient email')
    return
  }
  testing.value = true
  try {
    await $fetch('/api/mail/test', { method: 'POST', body: { to: testTo.value.trim() } })
    toast.success('Test email sent, please check your inbox')
  } catch (e: any) {
    toast.error('Send failed: ' + (e?.data?.statusMessage || e?.message || 'Unknown error'))
  } finally {
    testing.value = false
  }
}

// Warn before leaving with unsaved changes; the SaveBar + dialog provide the UI.
const { confirmLeave, proceed } = useUnsavedLeaveGuard(dirty, saving)
function reset(): void {
  if (data.value) syncFromConfig(data.value)
  senderPassword.value = ''
  postAuthToken.value = ''
}
async function saveAndLeave(): Promise<void> {
  if (await save()) proceed()
}
function discardAndLeave(): void {
  reset()
  proceed()
}
</script>

<template>
  <div class="space-y-6 pb-24">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div class="space-y-1">
        <h1 class="text-2xl font-semibold">Mail Configuration</h1>
        <p class="text-muted-foreground">
          Used to send registration verification codes and system notifications. Configuration is stored in the database
          (not environment variables).
        </p>
      </div>
      <Badge v-if="dirty" variant="warning">Unsaved changes</Badge>
    </div>

    <div class="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-stretch gap-4">
      <Card>
        <CardHeader><CardTitle>Delivery Method</CardTitle></CardHeader>
        <CardContent>
          <FieldRow label="Provider">
            <Select v-model="form.provider">
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="smtp">SMTP (direct connection to mail server, recommended)</SelectItem>
                <SelectItem value="post">HTTP Webhook (forward to downstream automation/mail service)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
        </CardContent>
      </Card>

      <Card v-if="form.provider === 'smtp'">
        <CardHeader><CardTitle>SMTP</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <FieldRow label="Server (host)">
            <Input v-model="form.host" placeholder="smtp.example.com" />
          </FieldRow>
          <FieldRow label="Port">
            <Input v-model.number="form.port" type="number" />
          </FieldRow>
          <FieldRow label="Implicit TLS (SSL)" inline hint="direct TLS, typically port 465">
            <Checkbox v-model="form.useSsl" />
          </FieldRow>
          <FieldRow label="STARTTLS" inline hint="upgrade to TLS, typically port 587/25">
            <Checkbox v-model="form.useTls" />
          </FieldRow>
          <FieldRow label="Requires login authentication" inline>
            <Checkbox v-model="form.usePassword" />
          </FieldRow>
          <FieldRow label="Sender email (login account)">
            <Input v-model="form.senderEmail" placeholder="noreply@example.com" />
          </FieldRow>
          <FieldRow label="Sender display name">
            <Input v-model="form.senderDisplay" placeholder="Proctoring Ingest Platform" />
          </FieldRow>
          <FieldRow label="Sender domain (Message-ID, optional)">
            <Input v-model="form.senderDomain" placeholder="example.com" />
          </FieldRow>
          <FieldRow label="SMTP password">
            <Input
              v-model="senderPassword"
              type="password"
              autocomplete="new-password"
              placeholder="Leave blank to keep unchanged"
            />
            <template v-if="hasPassword" #hint>(set; leave blank to keep unchanged)</template>
          </FieldRow>
        </CardContent>
      </Card>

      <Card v-if="form.provider === 'post'">
        <CardHeader><CardTitle>HTTP Webhook</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <FieldRow label="Webhook URL">
            <Input v-model="form.postUrl" placeholder="https://..." />
          </FieldRow>
          <FieldRow
            label="Payload format"
            hint="must match the fields your downstream flow reads — a mismatch sends to an empty address and the flow still reports success"
          >
            <Select v-model="postShape" @update:model-value="applyPostShape">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="powerautomate">Power Automate (email / subject / content)</SelectItem>
                <SelectItem value="smtogo">SMToGo-style (from / to / subject / html)</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="Bearer Token (auth, optional)">
            <Input
              v-model="postAuthToken"
              type="password"
              autocomplete="new-password"
              placeholder="Leave blank to keep unchanged"
            />
            <template v-if="hasPostAuthToken" #hint>(set; leave blank to keep unchanged)</template>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Send Test</CardTitle></CardHeader>
        <CardContent class="space-y-3">
          <p class="text-sm text-muted-foreground">
            Send a test email to the specified address using the current configuration (limit: 1/min, 10/day).
          </p>
          <div class="space-y-1.5">
            <Label>Test recipient</Label>
            <Input v-model="testTo" type="email" placeholder="you@example.com" />
          </div>
          <Button variant="outline" :disabled="testing" @click="sendTest">
            {{ testing ? 'Sending…' : 'Send test email' }}
          </Button>
        </CardContent>
      </Card>
    </div>

    <SaveBar :dirty="dirty" :saving="saving" :saved="saved" @save="save" @discard="reset" />
    <UnsavedLeaveDialog
      :open="confirmLeave"
      :saving="saving"
      @stay="confirmLeave = false"
      @discard="discardAndLeave"
      @save="saveAndLeave"
    />
  </div>
</template>

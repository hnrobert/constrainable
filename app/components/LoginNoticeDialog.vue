<script setup lang="ts">
/**
 * One-shot popup with the admin-authored login notice (Config → Dashboard
 * Notice → "Login popup notice"). Fired ONLY by an explicit login or
 * registration: useAuth stashes the markdown in sessionStorage during the
 * auth round-trip, and this component consumes it once on mount — a
 * cookie/JWT-restored session never sets the key, so returning visitors
 * don't see the popup. Empty config = nothing stashed, nothing rendered.
 */
const open = ref(false)
const notice = ref('')

onMounted(() => {
  notice.value = sessionStorage.getItem('ci:login-notice') ?? ''
  sessionStorage.removeItem('ci:login-notice') // consume — one shot per login
  if (notice.value) open.value = true
})
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent class="max-w-lg">
      <AlertDialogHeader>
        <AlertDialogTitle>Notice</AlertDialogTitle>
        <AlertDialogDescription class="sr-only">A notice from the organizers</AlertDialogDescription>
      </AlertDialogHeader>
      <div class="max-h-[65vh] overflow-y-auto">
        <RichText :source="notice" />
      </div>
      <AlertDialogFooter>
        <AlertDialogAction>Got it</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

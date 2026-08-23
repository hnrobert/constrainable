<script setup lang="ts">
/**
 * Three-action modal shown by `useUnsavedLeaveGuard` when the user tries to
 * leave a page with unsaved changes. Stay/Discard/Save & leave. Teleported to
 * <body> and z-[60] so it sits above the sidebar (z-50) and SaveBar (z-50).
 * Closing the dialog (overlay/ESC) = Stay.
 */
defineProps<{ open: boolean; saving?: boolean }>()
defineEmits<{ stay: []; discard: []; save: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
        @click.self="$emit('stay')"
      >
        <Card class="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Unsaved changes</CardTitle>
            <CardDescription> Save your changes before leaving, discard them, or stay on this page. </CardDescription>
          </CardHeader>
          <CardContent class="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" class="sm:flex-1" @click="$emit('stay')">Stay</Button>
            <Button variant="outline" class="sm:flex-1" :disabled="saving" @click="$emit('discard')"> Discard </Button>
            <Button class="sm:flex-1" :disabled="saving" @click="$emit('save')">Save &amp; leave</Button>
          </CardContent>
        </Card>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

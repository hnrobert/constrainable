<script setup lang="ts">
// Sync the global toast host's theme with the active color mode (toggled in the
// dashboard sidebar). useDark shares the 'ci.theme' storage key with the
// no-FOUC head script + the sidebar toggle.
const isDark = useDark({ storageKey: 'ci.theme' })
const toasterTheme = computed<'dark' | 'light'>(() => (isDark.value ? 'dark' : 'light'))
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <!-- Global toast host: vue-sonner, client-only (auto-registered by the
       `vue-sonner/nuxt` module). Replaces the old per-layout <UiAppToast>
       in-page element; pages fire toasts via useToast(). -->
  <Toaster position="top-right" :theme="toasterTheme" rich-colors close-button />
</template>

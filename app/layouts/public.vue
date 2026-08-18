<script setup lang="ts">
// Minimal shell for public pages (landing + invite). Shows a brand link and an
// auth-aware CTA (Sign in / Dashboard). No management nav.
const { user } = useAuth()
</script>

<template>
  <div class="min-h-screen">
    <header class="flex items-center justify-between border-b bg-card px-5 py-3">
      <NuxtLink to="/" class="text-base font-semibold hover:text-primary">Constrainable Ingest</NuxtLink>
      <Button as-child size="sm">
        <NuxtLink v-if="user" to="/dashboard">Dashboard</NuxtLink>
        <NuxtLink v-else to="/login">Sign in</NuxtLink>
      </Button>
    </header>
    <main class="mx-auto w-full max-w-4xl p-5 py-8">
      <slot />
    </main>
  </div>
</template>

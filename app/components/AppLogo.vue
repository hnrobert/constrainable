<script setup lang="ts">
/**
 * The brand mark shown top-left in every app shell — dashboard sidebar header,
 * mobile top bar, public page header. Renders the site favicon as a logo tile
 * next to the product name. To rebrand, drop the new asset into public/ and
 * point this one place at it.
 */
</script>

<template>
  <NuxtLink to="/" class="flex items-center gap-2 font-semibold">
    <img src="/favicon.svg" alt="" class="h-7 w-7 rounded-md bg-muted p-0.5" />
    Constrainable Ingest
  </NuxtLink>
</template>

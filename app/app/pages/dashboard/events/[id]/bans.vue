<script setup lang="ts">
definePageMeta({ layout: 'default', adminOnly: true })
/**
 * Bans tab — the event-scoped blacklist (小黑屋). Site-wide rows are shown for
 * context (they block this event too); lifting and adding both scopes happen
 * in the shared panel component.
 */
const route = useRoute()
const id = Number(route.params.id)
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold">Streaming bans</h2>
      <p class="text-muted-foreground">
        Banned accounts can never publish — in this event (scoped bans) or anywhere on the site
        (site-wide bans, shown below for context). Bans are permanent until lifted here.
      </p>
    </div>
    <Card>
      <CardContent>
        <StreamsBansPanel :event-id="id" />
      </CardContent>
    </Card>
  </div>
</template>

<script setup lang="ts">
/**
 * Standalone ingest-node page (linked from the event guides' "change ingest
 * node"). The picker itself lives in components/nodes/NodePicker.vue and is
 * also embedded on the dashboard events page.
 */
definePageMeta({ layout: 'default' })
useAuth()
  .fetchSession()
  .catch(() => null)
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Ingest Nodes</h1>
      <p class="text-muted-foreground">
        Your ingest node was chosen for you when you registered; you can switch to any node below. Once selected you can
        only stream through that node — the OBS address on your event guide page follows your choice.
      </p>
    </div>

    <Card>
      <CardContent class="pt-6">
        <NodesNodePicker />
      </CardContent>
    </Card>
  </div>
</template>

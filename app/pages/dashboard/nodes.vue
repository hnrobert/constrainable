<script setup lang="ts">
import type { NodeRow } from '~/components/streams/NodesTable.vue'

// registered media nodes — poll: a node dropping offline mid-event matters
const { data: nodes, refresh: refreshNodes } = useFetch<NodeRow[]>('/api/media-nodes')
let nodesTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nodesTimer = setInterval(() => {
    refreshNodes()
  }, 10_000)
})
onBeforeUnmount(() => {
  if (nodesTimer) clearInterval(nodesTimer)
})
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Media Nodes</h1>
      <p class="text-muted-foreground">
        Registered ingest nodes with their OBS addresses, quotas and user assignments. Users are not
        permanently bound: a node offline for over 5 minutes loses its users to automatic
        reassignment on their next visit.
      </p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center justify-between">
          Nodes
          <Badge :variant="(nodes?.length ?? 0) > 0 ? 'success' : 'secondary'">
            {{ nodes?.length ?? 0 }} connected
          </Badge>
        </CardTitle>
        <CardDescription>
          The auto-assign cap limits first-visit allocation (lowest latency first; overflow spreads
          to the least-loaded node). Click a node to manage its assigned users. Re-polled every 10 s.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StreamsNodesTable :nodes="nodes ?? []" @edited="refreshNodes()" />
      </CardContent>
    </Card>
  </div>
</template>

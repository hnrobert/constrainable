<script setup lang="ts">
import type { MediaNodeSnapshot } from '#shared/events'

// initial render from the API, then LIVE updates: every registry/quota/
// assignment change pushes a fresh full list over the socket (nodes:changed)
const { data: nodes, refresh: refreshNodes } = useFetch<MediaNodeSnapshot[]>('/api/media-nodes')
onMounted(() => {
  const socket = useSocket()
  socket.on('nodes:changed', (list: MediaNodeSnapshot[]) => {
    nodes.value = list
  })
  // after a socket reconnect the list may be stale — refetch once
  socket.on('connect', () => {
    refreshNodes()
  })
})
onBeforeUnmount(() => disposeSocket())
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold">Media Nodes</h1>
      <p class="text-muted-foreground">
        Registered ingest nodes with their OBS addresses, quotas and user assignments. Users are not permanently bound:
        a node offline for over 5 minutes loses its users to automatic reassignment on their next visit.
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
          The auto-assign cap limits first-visit allocation (lowest latency first; overflow spreads to the least-loaded
          node). Click a node to manage its assigned users. Live-updated over the socket.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <StreamsNodesTable :nodes="nodes ?? []" @edited="refreshNodes()" />
      </CardContent>
    </Card>
  </div>
</template>

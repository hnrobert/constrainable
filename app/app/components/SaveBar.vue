<script setup lang="ts">
/**
 * Sticky bottom save/discard bar — the shared "modify & save" affordance for
 * config pages. Slides up while there are unsaved changes, and again right
 * after a successful save to flash "✓ Saved" before retracting. Pure
 * presentation: every page supplies its own dirty/save/discard logic.
 *
 * `lg:left-64` clears the fixed 16rem sidebar on desktop; on mobile it spans
 * the full width. Pages add `pb-24` so the bar never covers their content.
 */
defineProps<{ dirty: boolean; saving: boolean; saved: boolean }>()
defineEmits<{ save: []; discard: [] }>()
</script>

<template>
  <Transition name="savebar">
    <div
      v-if="dirty || saved"
      class="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/95 backdrop-blur lg:left-64"
    >
      <div
        class="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8"
      >
        <span class="text-sm text-muted-foreground">
          <template v-if="saved">✓ Saved</template>
          <template v-else>You have unsaved changes</template>
        </span>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" :disabled="saving || saved" @click="$emit('discard')">
            Discard
          </Button>
          <Button size="sm" :disabled="saving || saved" @click="$emit('save')">
            {{ saving ? 'Saving…' : saved ? 'Saved' : 'Save changes' }}
          </Button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.savebar-enter-active,
.savebar-leave-active {
  transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s;
}
.savebar-enter-from,
.savebar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>

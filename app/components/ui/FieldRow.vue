<script setup lang="ts">
/**
 * Shared labelled field row for the config/mail cards. Default layout is
 * Label → control band → optional hint, so rows share one vertical rhythm.
 * The control band is `min-h-9` + `items-center`: an h-9 Input/Select fills it
 * exactly, while a lone size-4 Checkbox centers in the same 36px.
 *
 * `inline` puts label and control on ONE line (label left, control right) —
 * the right shape for checkboxes: "Enable recording          ☑".
 */
defineProps<{ label?: string; hint?: string; inline?: boolean }>()
</script>

<template>
  <div>
    <div v-if="inline" class="flex min-h-9 items-center justify-between gap-3">
      <Label v-if="label" class="cursor-pointer">{{ label }}</Label>
      <slot />
    </div>
    <template v-else>
      <div class="space-y-1.5">
        <Label v-if="label">{{ label }}</Label>
        <div class="flex min-h-9 items-center gap-2">
          <slot />
        </div>
      </div>
    </template>
    <!-- plain string hint via prop, or rich markup (e.g. <code>) via #hint -->
    <p v-if="hint || $slots.hint" class="mt-1.5 text-xs text-muted-foreground">
      <template v-if="$slots.hint"><slot name="hint" /></template>
      <template v-else>{{ hint }}</template>
    </p>
  </div>
</template>

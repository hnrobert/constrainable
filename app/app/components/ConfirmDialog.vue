<script setup lang="ts">
// Generic confirm dialog backed by the shadcn alert-dialog primitives. Driven
// by app/composables/useConfirm() — pages set `confirm.ask(message, run)` and
// wire `confirm.confirmOpen` / `confirm.confirmMessage` / `confirm.accept`.
const props = withDefaults(
  defineProps<{
    open: boolean
    message: string
    title?: string
    actionLabel?: string
    destructive?: boolean
  }>(),
  { title: 'Are you sure?', actionLabel: 'Confirm', destructive: true },
)

const emit = defineEmits<{ 'update:open': [boolean]; accept: [] }>()
</script>

<template>
  <AlertDialog :open="props.open" @update:open="emit('update:open', $event)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{{ props.title }}</AlertDialogTitle>
        <AlertDialogDescription>{{ props.message }}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel @click="emit('update:open', false)">Cancel</AlertDialogCancel>
        <AlertDialogAction
          :class="props.destructive ? 'bg-destructive text-white hover:bg-destructive/90' : ''"
          @click="emit('accept')"
        >
          {{ props.actionLabel }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

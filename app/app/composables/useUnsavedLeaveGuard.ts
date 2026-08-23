import type { Ref } from 'vue'

/**
 * Prompt before navigating away with unsaved changes. While `isDirty` is true
 * (and a save isn't in flight), the route leave is cancelled, the intended
 * destination is stashed, and `confirmLeave` flips true — bind it to
 * `<UnsavedLeaveDialog>`.
 *
 * `proceed()` re-runs navigation to the stashed destination. The page calls it
 * after Discard (dirty cleared) or a successful Save-and-leave; the re-triggered
 * guard then sees a clean state and lets the navigation through, so the user
 * actually lands on the page they originally clicked instead of being stranded.
 *
 * No `beforeunload` guard: this is an intranet SPA, route-leave only. Mirrors
 * verifier-gateway's composable of the same name.
 */
export function useUnsavedLeaveGuard(isDirty: Ref<boolean>, saving: Ref<boolean>) {
  const confirmLeave = ref(false)
  const pendingTo = ref<string | null>(null)

  onBeforeRouteLeave((to) => {
    if (isDirty.value && !saving.value) {
      pendingTo.value = to.fullPath
      confirmLeave.value = true
      return false
    }
  })

  function proceed(): void {
    const dest = pendingTo.value
    confirmLeave.value = false
    pendingTo.value = null
    if (dest) navigateTo(dest)
  }

  return { confirmLeave, proceed }
}

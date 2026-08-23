/**
 * Generic confirm-dialog state for pages that need a destructive confirm
 * (replaces native window.confirm). Pair with the <ConfirmDialog> component:
 *
 *   const confirm = useConfirm()
 *   confirm.ask('Delete this?', async () => {
 *     await $fetch('/api/...', { method: 'DELETE' })
 *     toast.success('Deleted')
 *   })
 *   // optional per-call label / tone:
 *   confirm.ask('Regenerate token?', run, { actionLabel: 'Regenerate', destructive: true })
 *
 *   <ConfirmDialog v-model:open="confirm.state.open"
 *                  :message="confirm.state.message"
 *                  :action-label="confirm.state.actionLabel"
 *                  :destructive="confirm.state.destructive"
 *                  @accept="confirm.accept" />
 *
 * `state` is reactive (not a ref) so `confirm.state.open` / `.message` unwrap
 * to primitives in the template. The action closure owns its own try/catch +
 * toast; on accept the pending run is captured then cleared, so reka-ui's
 * AlertDialogAction auto-close can't race the handler.
 *
 * Migrating an inline guard `if (!confirm(msg)) return` followed by a body:
 * move the body into the callback and drop the early return:
 *
 *   function doThing(x) {
 *     confirm.ask(msg, async () => { ...former body... })
 *   }
 */
export function useConfirm() {
  const state = reactive({
    open: false,
    message: '',
    actionLabel: 'Confirm',
    destructive: true,
  })
  let pendingRun: (() => Promise<void>) | null = null

  function ask(
    message: string,
    run: () => Promise<void>,
    opts?: { actionLabel?: string; destructive?: boolean },
  ): void {
    state.message = message
    state.actionLabel = opts?.actionLabel ?? 'Confirm'
    state.destructive = opts?.destructive ?? true
    pendingRun = run
    state.open = true
  }

  function cancel(): void {
    state.open = false
    pendingRun = null
  }

  async function accept(): Promise<void> {
    const run = pendingRun
    state.open = false
    pendingRun = null
    if (run) await run()
  }

  return { state, ask, cancel, accept }
}

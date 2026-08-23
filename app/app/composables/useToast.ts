/**
 * Toast notifications backed by vue-sonner and rendered by the global
 * <Toaster> mounted once in app.vue (via the `vue-sonner/nuxt` module).
 *
 * Thin wrapper kept so the existing call sites stay unchanged:
 *   const toast = useToast()
 *   toast.success(msg) / toast.error(msg) / toast.info(msg)
 * No per-page toast element is rendered anywhere.
 */
import { toast as sonner } from 'vue-sonner'

export function useToast() {
  return {
    success: (message: string): void => {
      sonner.success(message)
    },
    info: (message: string): void => {
      sonner.info(message)
    },
    error: (message: string, timeout = 6000): void => {
      sonner.error(message, { duration: timeout })
    },
  }
}

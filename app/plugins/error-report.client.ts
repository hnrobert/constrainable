/**
 * Client crash reporter (dev debugging): forwards unhandled errors and promise
 * rejections — with their full stack, component trace, and current URL — to
 * POST /api/client-errors so a client-only crash (e.g. a hydration failure on
 * one user's browser state) can be diagnosed from the server logs instead of
 * being unreproducible elsewhere.
 */
export default defineNuxtPlugin((nuxtApp) => {
  const report = (kind: string, err: unknown, extra?: string) => {
    const e = err as { message?: string; stack?: string } | null
    try {
      $fetch('/api/client-errors', {
        method: 'POST',
        body: {
          kind,
          message: e?.message ?? String(err),
          stack: (e?.stack ?? '') + (extra ? `\n[vue-info] ${extra}` : ''),
          url: location.href,
          ua: navigator.userAgent,
          ts: Date.now(),
        },
      }).catch(() => {})
    } catch {
      /* never let reporting itself throw */
    }
  }
  window.addEventListener('error', (ev) => report('error', ev.error ?? ev.message))
  window.addEventListener('unhandledrejection', (ev) => report('unhandledrejection', ev.reason))
  // Vue catches render errors internally and routes them to Nuxt's error page —
  // they never surface as window errors. This hook sees them, with `info`
  // naming the lifecycle/render phase that threw.
  nuxtApp.hook('vue:error', (err, _instance, info) => report('vue:error', err, info))
})

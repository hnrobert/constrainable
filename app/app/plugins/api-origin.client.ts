/**
 * Split-deployment API routing. When API_ORIGIN is set (frontend served from
 * a different origin than the API — e.g. static pages on a CDN), every
 * client-side /api/* request is rewritten to the API origin and sent with
 * credentials so the JWT session cookie travels. Unset → same-origin, this
 * plugin does nothing.
 *
 * Patches window.fetch rather than $fetch: ofetch resolves globalThis.fetch
 * at CALL time (it wraps `(...args) => _globalThis.fetch(...args)`), so one
 * patch covers $fetch, useFetch, AND third-party loaders like mpegts.js'
 * fetch-stream loader — regardless of module-load order. Socket.IO is handled
 * separately in useSocket.ts (its polling transport may use XHR, which never
 * goes through fetch).
 */
export default defineNuxtPlugin((nuxtApp) => {
  const apiOrigin = String(nuxtApp.$config.public.apiOrigin || '').replace(/\/+$/, '')
  if (!apiOrigin || !apiOrigin.startsWith('http')) return

  const origFetch = window.fetch.bind(window)
  // (cast: lib.dom's `typeof fetch` also carries preconnect; the wrapper only
  // implements the call signature — preconnect is irrelevant for /api/* routing)
  const wrapped = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw: string =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    // relative /api/* → absolute on the API origin; same-origin absolute
    // /api/* (Request objects resolve their url at construction) → re-origined
    let target: string | null = null
    if (raw.startsWith('/api/')) {
      target = apiOrigin + raw
    } else if (/^https?:\/\//.test(raw)) {
      const u = new URL(raw)
      if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
        target = apiOrigin + u.pathname + u.search
      }
    }
    if (target === null) return origFetch(input as RequestInfo, init)

    if (input instanceof Request) {
      // copy-construct keeps method/headers/body; only the URL changes
      return origFetch(new Request(target, input), { ...init, credentials: 'include' })
    }
    return origFetch(target, { ...init, credentials: 'include' })
  }
  window.fetch = wrapped as typeof window.fetch
})

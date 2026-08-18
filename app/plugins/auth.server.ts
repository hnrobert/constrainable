/**
 * SSR-only session hydration. Fetches the session once during server init so the
 * nav + route guards have the real user at render time. The populated useState
 * ('auth:user' / 'auth:probed') is serialized into the payload and hydrates on
 * the client — so the client never needs to await a fetch.
 *
 * Why a server plugin and not `await fetchSession()` in global middleware: an
 * awaited global middleware wraps the entire route — layout *and* page — in a
 * Suspense boundary, which made the <Default> layout async-hydrate on the client
 * and produced a dev-only hydration node mismatch (server rendered the layout
 * `<div>`, client rendered a `Symbol(v-cmt)` placeholder). A `.server.ts` plugin
 * is absent from the client bundle, so it cannot create a client Suspense
 * boundary; the client simply hydrates the pre-populated state synchronously.
 *
 * fetchSession forwards the incoming browser cookie via useRequestHeaders so SSR
 * sees the real session (on the client, cookies are sent by the browser itself).
 */
export default defineNuxtPlugin(async () => {
  const { fetchSession } = useAuth()
  await fetchSession()
})

/**
 * Sink for the client crash reporter (app/plugins/error-report.client.ts).
 * Logs loudly to the dev server console — enough for diagnosis; no storage.
 */
export default defineEventHandler(async (event) => {
  const b = await readBody<{
    kind?: string
    message?: string
    stack?: string
    url?: string
    ua?: string
  }>(event).catch(() => null)
  if (!b?.message) return { ok: false }
  console.error(
    `[client-crash] ${b.kind ?? '?'} ${b.url ?? '?'} :: ${b.message}\n${(b.stack ?? '').split('\n').slice(0, 12).join('\n')}\n[ua] ${b.ua ?? ''}`,
  )
  return { ok: true }
})

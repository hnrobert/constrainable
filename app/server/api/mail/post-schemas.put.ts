/**
 * Admin: save the post-schemas library (the named field-map palette behind the
 * editor). The active webhook format stays in `postFieldMap` (saved with the
 * rest of the mail config); schemas are persisted here independently so the
 * editor can auto-sync them as the operator adds / renames / deletes. Stored
 * server-side — shared across admins, not per-browser.
 */
import { z } from 'zod'
import { saveMailConfig } from '../../utils/mail-config'
import { audit } from '../../services/audit'

const postSchemaEntry = z.object({
  id: z.string(),
  name: z.string(),
  fields: z.record(z.string(), z.string()).default({}),
})

const bodySchema = z.object({
  schemas: z.array(postSchemaEntry),
})

export default defineEventHandler(async (event) => {
  requireAdmin(event)
  const body = await readBody(event)
  const parsed = bodySchema.parse(body ?? {})
  saveMailConfig({ postSchemas: JSON.stringify(parsed.schemas) })
  audit('info', 'config', 'mail post schemas updated', { detail: { count: parsed.schemas.length } })
  return { ok: true }
})

/** Audit log read model + filters (GET /api/audit, app/pages/audit.vue). */
import type { AuditCategory, AuditLevel } from './events'

/**
 * One audit log row, as returned to the client. `ts` is epoch ms; `detail` is
 * the parsed JSON payload (or the raw string when it failed to parse, or null).
 */
export interface AuditView {
  id: number
  /** epoch ms */
  ts: number
  level: AuditLevel
  category: AuditCategory
  /** who performed the action (account email); null = system/background */
  actor: string | null
  eventId: number | null
  streamName: string | null
  message: string
  detail: unknown
}

/** Query filters for GET /api/audit. All optional. */
export interface AuditFilters {
  level?: AuditLevel | null
  category?: AuditCategory | null
  eventId?: number | null
  /** only entries performed by this account (email) — drives "My audit" */
  actor?: string | null
  /** case-insensitive match on message or stream name */
  q?: string | null
  /** max rows to return (server clamps to [1, AUDIT_MAX_LIMIT]) */
  limit?: number | null
}

/** Allowed enum values, reused by the endpoint (validation) + the page (filters). */
export const AUDIT_LEVELS: readonly AuditLevel[] = ['info', 'warn', 'error']
export const AUDIT_CATEGORIES: readonly AuditCategory[] = [
  'auth',
  'publish',
  'access',
  'config',
  'recording',
  'system',
  'admin',
]

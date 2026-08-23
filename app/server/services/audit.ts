/**
 * Audit log writer. Persists via AuditLogRepository and emits an `audit:created`
 * event for the realtime panel. Business logic over the repository layer.
 */
import { AuditLogRepository } from '../repositories/audit-log.repository'
import { emit } from '../utils/bus'
import type { AuditCategory, AuditLevel } from '#shared/events'
import type { AuditFilters, AuditView, AuditPageView } from '#shared/audit'
import type { AuditEntry } from '../database/schema'

export interface AuditInput {
  /** the acting account's email (drives the per-user "My audit" view) */
  actor?: string | null
  eventId?: number | null
  streamName?: string | null
  detail?: unknown
}

export function audit(level: AuditLevel, category: AuditCategory, message: string, opts: AuditInput = {}): void {
  const row = AuditLogRepository.insert({
    level,
    category,
    message,
    actor: opts.actor ?? null,
    eventId: opts.eventId ?? null,
    streamName: opts.streamName ?? null,
    detail: opts.detail != null ? JSON.stringify(opts.detail) : null,
  })

  emit('audit:created', {
    id: row.id,
    ts: row.ts.getTime(),
    level,
    category,
    actor: row.actor ?? null,
    eventId: row.eventId ?? null,
    streamName: row.streamName ?? null,
    message,
    detail: opts.detail,
  })
}

const AUDIT_MAX_PAGE_SIZE = 1000
const AUDIT_DEFAULT_PAGE_SIZE = 50

/** Map a DB row to the client view: epoch-ms timestamp + parsed JSON detail. */
function toAuditView(row: AuditEntry): AuditView {
  let detail: unknown = null
  if (row.detail) {
    try {
      detail = JSON.parse(row.detail)
    } catch {
      detail = row.detail
    }
  }
  return {
    id: row.id,
    ts: row.ts.getTime(),
    level: row.level,
    category: row.category,
    actor: row.actor ?? null,
    eventId: row.eventId ?? null,
    streamName: row.streamName ?? null,
    message: row.message,
    detail,
  }
}

/**
 * Newest-first filtered read of the audit log. Server-side filtering + a clamped
 * LIMIT keep large logs cheap (the table is append-only and unbounded). The
 * endpoint validates level/category against the known enum sets before calling,
 * so they are already well-typed here.
 */
export function listAudit(filters: AuditFilters = {}): AuditPageView {
  const pageSize = Math.min(Math.max(filters.pageSize ?? AUDIT_DEFAULT_PAGE_SIZE, 1), AUDIT_MAX_PAGE_SIZE)
  const page = Math.max(filters.page ?? 1, 1)
  const where = {
    level: filters.level ?? null,
    category: filters.category ?? null,
    eventId: filters.eventId ?? null,
    actor: filters.actor ?? null,
    involvedEmail: filters.involvedEmail ?? null,
    q: filters.q ?? null,
  }
  const total = AuditLogRepository.countFiltered(where)
  const rows = AuditLogRepository.findMany({ ...where, limit: pageSize, offset: (page - 1) * pageSize })
  return { entries: rows.map(toAuditView), total, page, pageSize }
}

/**
 * Drizzle + bun:sqlite singleton with TypeORM-style auto-sync.
 *
 * Instead of versioned migration files, the schema is synced by `drizzle-kit
 * push`: it diffs `schema.ts` against the live SQLite file and applies DDL
 * directly (create on a fresh DB, additive/alter on schema changes). This
 * mirrors TypeORM's `synchronize: true` and keeps the repo free of generated
 * SQL files.
 *
 * The sync runs SYNCHRONOUSLY inside createClient(), at db.ts module load —
 * not as a top-level await (Nitro transpiles server code to es2019, which has
 * no top-level await) and not deferred to a Nitro plugin (too late). Some
 * server modules read `app_config` at import time (e.g. stream-lifecycle.ts
 * seeds its probe semaphore from getConfig() at module top-level), which
 * evaluates during bundle load, before any plugin. Because every config reader
 * imports `db`, ESM evaluation order guarantees createClient() — and thus the
 * schema — is ready before that first read. The client itself is cached on
 * globalThis (survives HMR), so the sync runs once.
 */
import { Database } from 'bun:sqlite'
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite'
import { getTableColumns, isTable, type Table } from 'drizzle-orm'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './schema'
import { env } from '../utils/env'

/**
 * Every schema.ts table with its column names, read at module load. drizzle-kit
 * push can exit 0 while applying NOTHING (non-TTY prompt abort — verified live:
 * the NAS silently missed users.announcement and served 500s). An exit-code
 * check alone can't tell sync from no-op; we verify tables AND columns instead.
 */
const SCHEMA_TABLES: { name: string; columns: string[] }[] = (Object.values(schema) as unknown[])
  .filter((t): t is Table => isTable(t))
  .map((t) => ({
    name: (t as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]!,
    columns: Object.values(getTableColumns(t)).map((c) => c.name),
  }))

export type DB = BunSQLiteDatabase<typeof schema>

const globalForDb = globalThis as unknown as { __ingestDb?: DB; __ingestDbReady?: boolean }

/**
 * Sync schema.ts → DB via `drizzle-kit push` (synchronous, non-interactive).
 * Idempotent at the call site (guarded by `__ingestDbReady`). Safe changes
 * apply with stdin ignored; prompts can't hang.
 */
function syncSchema(): void {
  const r = Bun.spawnSync({
    // NO --force on purpose: push INTERACTIVELY prompts even for plain column
    // adds (verified live — a piped stdin makes the prompt abort with exit 0
    // and NOTHING is applied). Additive gaps are healed safely by
    // ensureColumns below (ADD COLUMN only); ambiguous/destructive diffs
    // (rename/type/drop) stay ABORTED and surface as a loud boot error from
    // verifySchema instead of being force-applied against live data.
    cmd: ['bun', 'x', 'drizzle-kit', 'push', '--config', 'drizzle.config.ts'],
    cwd: process.cwd(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  if (r.exitCode !== 0) {
    const out = `${r.stdout?.toString() ?? ''}\n${r.stderr?.toString() ?? ''}`.trim()
    throw new Error(`drizzle-kit push failed (exit ${r.exitCode})\n${out}`)
  }
  // push's "Changes applied"/"No changes detected" banner is unreliable in
  // non-TTY mode, so we don't parse it. Use `bun run db:push` interactively
  // to see exactly what each sync does.
  console.log('[db] schema synced via drizzle-kit push')
}

/**
 * Confirm every schema.ts table AND column exists in the live DB. Catches the
 * silent-abort case described above: push returns exit 0 but a conflict (column
 * rename, type change) blocked the DDL, leaving tables/columns missing. Rather
 * than serving 500s from the first handler that touches a missing table, fail
 * the boot loudly with the exact remediation.
 */
function verifySchema(sqlite: Database): void {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[]
  const live = new Set(rows.map((r) => r.name))
  const missing = SCHEMA_TABLES.map((t) => t.name).filter((n) => !live.has(n))
  if (missing.length > 0) {
    throw new Error(
      `[db] schema sync produced no error but table(s) still missing: ${missing.join(', ')}. ` +
        `drizzle-kit push likely aborted on a conflict needing a TTY. ` +
        `Run \`bun run db:push\` in your terminal to resolve interactively, then restart.`,
    )
  }
  const missingCols = missingColumns(sqlite)
  if (missingCols.length > 0) {
    throw new Error(
      `[db] schema sync produced no error but column(s) still missing: ${missingCols.join(', ')}. ` +
        `This needs a non-additive change (rename/type) — run \`bun run db:push\` interactively, then restart.`,
    )
  }
}

/** schema.ts columns absent from the live DB, as "table.column" strings. */
function missingColumns(sqlite: Database): string[] {
  const out: string[] = []
  for (const table of SCHEMA_TABLES) {
    const live = new Set(
      (sqlite.prepare(`PRAGMA table_info('${table.name}')`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    for (const col of table.columns) if (!live.has(col)) out.push(`${table.name}.${col}`)
  }
  return out
}

/**
 * Additive self-heal for columns `drizzle-kit push` silently skipped (its
 * non-TTY abort is all-or-nothing, so ONE ambiguous change anywhere blocks
 * every additive column too — e.g. a prod DB left without `strict_limits`
 * while the code inserts it, 500ing event creation). Only ever emits
 * `ALTER TABLE … ADD COLUMN` — never drops, renames or retypes anything.
 * NOT NULL columns need a renderable default; anything else is left for
 * verifySchema to fail loudly on.
 */
function ensureColumns(sqlite: Database): void {
  const added: string[] = []
  for (const t of (Object.values(schema) as unknown[]).filter((x): x is Table => isTable(x))) {
    const name = (t as unknown as Record<symbol, string>)[Symbol.for('drizzle:Name')]!
    const live = new Set(
      (sqlite.prepare(`PRAGMA table_info('${name}')`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    for (const col of Object.values(getTableColumns(t)) as unknown as Record<string, any>[]) {
      if (live.has(col.name)) continue
      let ddl = `ALTER TABLE '${name}' ADD COLUMN '${col.name}' ${col.getSQLType()}`
      if (col.notNull) {
        if (!col.hasDefault) continue // can't backfill — verifySchema reports it
        ddl += ' NOT NULL'
      }
      if (col.hasDefault && col.default !== undefined) {
        const d = col.default
        if (typeof d === 'number') ddl += ` DEFAULT ${d}`
        else if (typeof d === 'boolean') ddl += ` DEFAULT ${d ? 'true' : 'false'}`
        else if (typeof d === 'string') ddl += ` DEFAULT '${d.replace(/'/g, "''")}'`
        else if (col.notNull) continue // sql-literal default we can't render
      }
      sqlite.run(ddl)
      added.push(`${name}.${col.name}`)
    }
  }
  if (added.length > 0) console.log(`[db] self-healed missing column(s): ${added.join(', ')}`)
}

/**
 * Idempotent data fixes that `drizzle-kit push` (pure DDL) can't express. Each
 * step guards on the current row state so it's a no-op once applied. Runs on
 * the raw sqlite handle right after syncSchema(), once per process.
 */
function runDataMigrations(sqlite: Database): void {
  // role enum narrowed admin|viewer → admin|user: convert legacy accounts.
  // SQLite CHECK constraints aren't retroactive on existing rows, so any
  // 'viewer' rows from before the enum change survive until rewritten here.
  try {
    const r = sqlite.run('UPDATE users SET role = ? WHERE role = ?', ['user', 'viewer'])
    if (r.changes > 0) console.log(`[db] migrated ${r.changes} legacy viewer→user role(s)`)
  } catch (err) {
    // E.g. a fresh DB where the users table exists but is empty — ignore.
    console.warn('[db] role migration skipped:', err instanceof Error ? err.message : err)
  }
}

function createClient(): DB {
  mkdirSync(dirname(env.dbPath), { recursive: true })
  const sqlite = new Database(env.dbPath, { create: true })
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  sqlite.exec('PRAGMA busy_timeout = 5000;')
  sqlite.exec('PRAGMA synchronous = NORMAL;')
  // Tables must exist before this client is handed out (see file header).
  if (!globalForDb.__ingestDbReady) {
    syncSchema()
    // belt-and-braces after push --force: additive ADD COLUMN for anything it
    // still skipped, THEN verify tables + columns and fail loud if short.
    ensureColumns(sqlite)
    verifySchema(sqlite)
    runDataMigrations(sqlite)
    globalForDb.__ingestDbReady = true
  }
  return drizzle(sqlite, { schema })
}

/**
 * Shared drizzle instance (auto-imported into server context as `db`).
 * Evaluating this export runs createClient() — and thus the schema sync — at
 * module load, gating every transitive importer on the tables existing.
 */
export const db: DB = (globalForDb.__ingestDb ??= createClient())

/**
 * Ensure the schema is synced. In practice a no-op: createClient() already
 * synced synchronously at module load. Kept for the 00-db startup plugin
 * (which awaits it for the `[db] ready` log) and any explicit caller.
 */
export async function ensureDbReady(): Promise<void> {
  if (globalForDb.__ingestDbReady) return
  syncSchema()
  globalForDb.__ingestDbReady = true
}

/**
 * Retention sweeper. Periodically (hourly, from a plugin):
 *   - delete recordings older than config.record.retentionDays (0 = keep forever)
 *     along with their on-disk files;
 *   - remove stale orphan files under records/_tmp (left by crashed ffmpeg).
 */
import { readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RecordingsRepository } from '../repositories/recordings.repository'
import { env } from '../utils/env'
import { getConfig } from '../utils/config-store'
import { audit } from './audit'

export interface RetentionResult {
  deleted: number
  orphans: number
}

export function runRetention(): RetentionResult {
  const cfg = getConfig()
  let deleted = 0

  if (cfg.record.retentionDays > 0) {
    const cutoff = new Date(Date.now() - cfg.record.retentionDays * 86_400_000)
    const expired = RecordingsRepository.findExpired(cutoff)
    for (const r of expired) {
      for (const rel of r.segments ? JSON.parse(r.segments) : [r.filePath]) {
        try {
          rmSync(join(env.recordDir, rel), { force: true })
        } catch {
          // file already gone
        }
      }
      RecordingsRepository.remove(r.id)
      deleted += 1
    }
    if (deleted > 0) {
      audit('info', 'recording', `retention deleted ${deleted} expired recording(s)`, {
        detail: { retentionDays: cfg.record.retentionDays },
      })
    }
  }

  const orphans = cleanOrphanTmp()
  return { deleted, orphans }
}

/** Remove _tmp files older than maxAgeMs (default 1h) — crash-recovery. */
function cleanOrphanTmp(maxAgeMs = 3_600_000): number {
  const dir = join(env.recordDir, '_tmp')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const name of entries) {
    const p = join(dir, name)
    try {
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) {
        rmSync(p, { force: true })
        n += 1
      }
    } catch {
      // race / unreadable — skip
    }
  }
  return n
}

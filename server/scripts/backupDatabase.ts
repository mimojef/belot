/**
 * backupDatabase.ts — Production CLI wrapper за онлайн дневен SQLite backup.
 *
 * Цялата логика е в `src/db/backupHelpers.ts → runDatabaseBackup()`.
 * Този файл разрешава production пътищата, логва резултата и задава
 * `process.exitCode` при грешка.
 *
 * Употреба:
 *   tsx scripts/backupDatabase.ts                       (dev)
 *   node dist-scripts/scripts/backupDatabase.js         (production)
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stat } from 'node:fs/promises'
import { getServerDatabaseFilePath } from '../src/db/ensureServerDatabaseReady.js'
import { formatBytes, runDatabaseBackup } from '../src/db/backupHelpers.js'

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function serverRoot(): string {
  const dir = scriptDir()
  // dist-scripts/scripts/ → две нива нагоре до server/
  if (dir.replace(/\\/g, '/').includes('/dist-scripts/')) {
    return resolve(dir, '..', '..')
  }
  // scripts/ → едно ниво нагоре до server/
  return resolve(dir, '..')
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const root       = serverRoot()
  const sourceFile = getServerDatabaseFilePath(root)
  const backupDir  = join(root, 'database', 'backups', 'daily')
  const dateStr    = todayIso()

  const { finalPath, log } = await runDatabaseBackup({ sourceFile, backupDir, dateStr })

  // Логване на събитията от backup flow-а
  for (const entry of log) {
    if (entry.startsWith('STALE_TMP_REMOVED')) {
      console.log('[backup] Намерен stale .tmp файл — изтрит преди старт.')
    } else if (entry.startsWith('SKIP:')) {
      const s = await stat(finalPath)
      console.log(`[backup] ${entry} (${formatBytes(s.size)})`)
    } else if (entry.startsWith('REPLACE:')) {
      console.warn(`[backup] ${entry}`)
    } else if (entry.startsWith('OK:')) {
      const s = await stat(finalPath)
      console.log(`[backup] ✓ Завършен: ${entry.slice(4)} (${formatBytes(s.size)}) — integrity_check: ok`)
    } else if (entry.startsWith('DELETED:')) {
      console.log(`[backup] Изтрити стари backups: ${entry.slice(9)}`)
    }
  }
}

main().catch(err => {
  console.error('[backup] ГРЕШКА:', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})

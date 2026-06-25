/**
 * checkDbBackupVerify.ts — Production CLI wrapper за верификация на backup.
 *
 * Намира най-новия дневен backup, копира го в изолиран tmpdir,
 * верифицира копието и изтрива tmpdir. Production базата не се докосва.
 *
 * Употреба:
 *   tsx scripts/checkDbBackupVerify.ts                  (dev)
 *   node dist-scripts/scripts/checkDbBackupVerify.js    (production)
 *
 * Exit code 0 → успех, 1 → провал.
 */

import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  BACKUP_DAILY_NAME_RE,
  REQUIRED_TABLES,
  verifyIsolatedDb,
} from '../src/db/backupHelpers.js'

// ── Path helpers ──────────────────────────────────────────────────────────────

function scriptDir(): string {
  return dirname(fileURLToPath(import.meta.url))
}

function serverRoot(): string {
  const dir = scriptDir()
  if (dir.replace(/\\/g, '/').includes('/dist-scripts/')) {
    return resolve(dir, '..', '..')
  }
  return resolve(dir, '..')
}

// ── findLatestBackup ──────────────────────────────────────────────────────────

async function findLatestBackup(backupDir: string): Promise<string> {
  let entries: string[]
  try {
    entries = await readdir(backupDir)
  } catch {
    throw new Error(`Директорията с backups не съществува: ${backupDir}`)
  }

  const dailyFiles = entries.filter(f => BACKUP_DAILY_NAME_RE.test(f)).sort()
  if (dailyFiles.length === 0) {
    throw new Error(`Няма дневни backup файлове в: ${backupDir}`)
  }

  return join(backupDir, dailyFiles[dailyFiles.length - 1]!)
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const backupDir    = join(serverRoot(), 'database', 'backups', 'daily')
  const latestBackup = await findLatestBackup(backupDir)

  const backupStat = await stat(latestBackup)
  console.log(`[verify] Верификация на: ${latestBackup}`)
  console.log(
    `[verify] Размер: ${(backupStat.size / 1_048_576).toFixed(2)} МБ,` +
    ` Дата: ${backupStat.mtime.toISOString().slice(0, 19).replace('T', ' ')} UTC`,
  )

  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-backup-verify-'))
  const tmpDb  = join(tmpDir, 'verify.sqlite')

  try {
    await copyFile(latestBackup, tmpDb)
    console.log('[verify] Копиран в изолиран tmpdir.')

    const result   = verifyIsolatedDb(tmpDb)
    const failures: string[] = []

    if (!result.integrityOk) {
      failures.push('integrity_check: не е ok')
    } else {
      console.log('[verify] PASS  integrity_check: ok')
    }

    for (const table of REQUIRED_TABLES) {
      if (!result.tables.includes(table)) {
        failures.push(`Липсваща таблица: ${table}`)
      } else {
        console.log(`[verify] PASS  Таблица съществува: ${table}`)
      }
    }

    if (result.migrationCount === 0) {
      failures.push('server_migrations е празна — невалиден backup')
    }

    console.log(`[verify] INFO  Миграции: ${result.migrationCount}`)
    console.log(`[verify] INFO  Акаунти: ${result.accountCount}`)
    console.log(`[verify] INFO  Профили: ${result.profileCount}`)
    console.log(`[verify] INFO  Портфейли: ${result.walletCount}`)

    if (failures.length > 0) {
      for (const f of failures) console.error(`[verify] FAIL  ${f}`)
      throw new Error(`Верификацията провали: ${failures.join('; ')}`)
    }

    console.log('[verify] ✓ Верификацията е успешна.')
  } finally {
    // Изтрий tmpdir винаги — production базата никога не е докосната
    await rm(tmpDir, { recursive: true, force: true })
  }
}

// Изпълни само при директен старт, не при import
const isMain =
  process.argv[1] != null &&
  fileURLToPath(import.meta.url).replace(/\\/g, '/') ===
    (await import('node:path')).resolve(process.argv[1]).replace(/\\/g, '/')

if (isMain) {
  main().catch(err => {
    console.error('[verify] ГРЕШКА:', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}

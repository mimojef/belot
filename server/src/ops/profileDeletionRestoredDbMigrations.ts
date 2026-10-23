// Самоизтриване, Етап 4E2 — миграции на ВЪЗСТАНОВЕНА база преди
// съгласуването с регистъра на изтриванията.
//
// Executor-ът изисква схемата на текущата версия (напр. 20261027_001 —
// snapshot колоните на Ludo/кампаниите). Backup отпреди такава миграция
// трябва първо да бъде мигриран със СЪЩАТА версия на сървъра, която ще
// работи в production, и едва тогава съгласуван. Reconcile отказва (exit 2,
// restored_db_migrations_pending), докато има неприложени миграции.
//
// `migrate` работи САМО върху копие: живата база (server/database/data/
// belot-v2.sqlite) се мигрира от самия сървър при старт и тук се отказва.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureServerDatabaseReady, getServerDatabaseFilePath } from '../db/ensureServerDatabaseReady.js'

/** server/ (от src/ops или dist/ops). */
export function getOpsServerRootPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
}

export function getOpsMigrationsDirectoryPath(): string {
  return join(getOpsServerRootPath(), 'database', 'migrations')
}

/** Миграциите на текущата версия, които липсват във възстановената база (по ред на прилагане). */
export async function listPendingMigrationsForDatabase(
  dbPath: string,
  migrationsDirectoryPath: string = getOpsMigrationsDirectoryPath(),
): Promise<string[]> {
  const files = readdirSync(migrationsDirectoryPath)
    .filter((name) => extname(name).toLowerCase() === '.sql')
    .sort((a, b) => a.localeCompare(b, 'en'))
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hasTable = database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'server_migrations';`).get() !== undefined
    if (!hasTable) return files
    const applied = new Set((database.prepare('SELECT filename FROM server_migrations;').all() as Array<{ filename: string }>).map((row) => row.filename))
    return files.filter((name) => !applied.has(name))
  } finally {
    database.close()
  }
}

function canonicalPath(path: string): string {
  const real = realpathSync.native(path)
  return process.platform === 'win32' ? real.toLowerCase() : real
}

export class RestoredDbMigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
  }
}

/**
 * Прилага миграциите на текущата версия към възстановено копие.
 * liveDbPath — само за тестове (по подразбиране живата база на сървъра).
 */
export async function migrateRestoredDatabase(
  dbPath: string,
  options: { liveDbPath?: string } = {},
): Promise<{ applied: string[]; pendingAfter: string[] }> {
  const target = resolve(dbPath)
  if (!existsSync(target)) throw new RestoredDbMigrationError('db_missing', 'възстановената база не съществува (нищо не се създава)')
  const livePath = options.liveDbPath ?? process.env.PROFILE_DELETION_LIVE_DB_PATH ?? getServerDatabaseFilePath()
  if (existsSync(livePath) && canonicalPath(livePath) === canonicalPath(target)) {
    throw new RestoredDbMigrationError('live_db_refused', 'това е живата база — тя се мигрира от сървъра при старт')
  }
  const pendingBefore = await listPendingMigrationsForDatabase(target)
  await ensureServerDatabaseReady({ serverRootOverride: getOpsServerRootPath(), databaseFilePathOverride: target })
  const pendingAfter = await listPendingMigrationsForDatabase(target)
  return { applied: pendingBefore.filter((name) => !pendingAfter.includes(name)), pendingAfter }
}

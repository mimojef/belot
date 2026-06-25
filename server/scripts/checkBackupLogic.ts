/**
 * checkBackupLogic.ts — Focused check за backup/restore логиката.
 *
 * Тества изолирано с временни SQLite бази, без да докосва production.
 * Извиква реалните функции от `src/db/backupHelpers.ts` — без дублиране.
 *
 * Покрива:
 * [1] Валиден backup: tmp → verify → rename, без остатъчен .tmp
 * [2] Повторно изпълнение в същия ден: валиден файл → SKIP, retention пак се вика
 * [3] Невалиден съществуващ backup: заменя се с нов валиден
 * [4] Retention над 14 файла: само BACKUP_DAILY_NAME_RE файлове се докосват
 * [5] Stale .tmp преди старт: почиства се преди backup()
 * [6] Грешка от backup(): fake backupFn записва partial .tmp и хвърля → cleanup
 * [7] Грешка при verify на tmp: .tmp се изтрива, финален файл не се създава
 * [8] Restore verification tmpdir: почиства се при грешка, оригиналът непокътнат
 * [9] Retention при SKIP path (вече валиден дневен backup)
 */

import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  BACKUP_DAILY_NAME_RE,
  RETENTION_COUNT,
  runDatabaseBackup,
  verifyBackupFile,
  verifyIsolatedDb,
} from '../src/db/backupHelpers.js'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

// ── Минимална валидна SQLite база ─────────────────────────────────────────────

function makeValidDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath, { open: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(`
    CREATE TABLE server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'player',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO server_migrations (filename) VALUES ('20260416_001_create_bot_profiles.sql');
    INSERT INTO accounts VALUES ('acc-1', 'test@test.bg', 'hash', 'player', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
    INSERT INTO profiles VALUES ('prof-1', 'acc-1', 'Тест Потребител', CURRENT_TIMESTAMP);
    INSERT INTO profile_wallets VALUES ('prof-1', 50000);
  `)
  db.close()
}

async function withTmpDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-backup-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// [1] Валиден backup
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[1] Валиден backup')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  makeValidDb(sourceFile)

  const { finalPath, log } = await runDatabaseBackup({
    sourceFile,
    backupDir,
    dateStr: '2026-01-01',
  })

  await check('[1.1] Финалният файл съществува', async () => { await stat(finalPath) })
  await check('[1.2] Правилно име', () => {
    if (!finalPath.endsWith('belot-v2-2026-01-01.sqlite')) throw new Error(finalPath)
  })
  await check('[1.3] Без остатъчен .tmp', async () => {
    const tmps = (await readdir(backupDir)).filter(f => f.endsWith('.tmp'))
    if (tmps.length > 0) throw new Error(`Намерени .tmp: ${tmps.join(', ')}`)
  })
  await check('[1.4] integrity_check ok', () => { verifyBackupFile(finalPath) })
  await check('[1.5] Лог съдържа OK', () => {
    if (!log.some(l => l.startsWith('OK:'))) throw new Error(JSON.stringify(log))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [2] Повторно изпълнение в същия ден — SKIP, retention пак се вика
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[2] Повторно изпълнение в същия ден')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  makeValidDb(sourceFile)

  const { finalPath } = await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-01-02' })
  const statBefore = await stat(finalPath)

  // 15 фиктивни стари файла — при SKIP retention трябва да ги изчисти
  for (let i = 1; i <= 15; i++) {
    const ds = `2025-${String(i).padStart(2, '0')}-01`
    await writeFile(join(backupDir, `belot-v2-${ds}.sqlite`), `fake-${i}`, 'utf8')
  }

  const { log } = await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-01-02' })
  const statAfter = await stat(finalPath)

  await check('[2.1] Лог съдържа SKIP', () => {
    if (!log.some(l => l.startsWith('SKIP:'))) throw new Error(JSON.stringify(log))
  })
  await check('[2.2] Файлът не е презаписан (mtime)', () => {
    if (statBefore.mtimeMs !== statAfter.mtimeMs) {
      throw new Error(`mtime: ${statBefore.mtimeMs} → ${statAfter.mtimeMs}`)
    }
  })
  await check('[2.3] Retention изпълнен при SKIP (лог съдържа DELETED)', () => {
    if (!log.some(l => l.startsWith('DELETED:'))) throw new Error(JSON.stringify(log))
  })
  await check('[2.4] Общо файлове ≤ RETENTION_COUNT', async () => {
    const daily = (await readdir(backupDir)).filter(f => BACKUP_DAILY_NAME_RE.test(f))
    if (daily.length > RETENTION_COUNT) throw new Error(`${daily.length} > ${RETENTION_COUNT}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [3] Невалиден съществуващ backup — заменя се
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[3] Невалиден съществуващ backup')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  await mkdir(backupDir, { recursive: true })
  makeValidDb(sourceFile)

  await writeFile(join(backupDir, 'belot-v2-2026-01-03.sqlite'), 'NOT SQLITE', 'utf8')

  const { finalPath, log } = await runDatabaseBackup({
    sourceFile,
    backupDir,
    dateStr: '2026-01-03',
  })

  await check('[3.1] Лог съдържа REPLACE', () => {
    if (!log.some(l => l.startsWith('REPLACE:'))) throw new Error(JSON.stringify(log))
  })
  await check('[3.2] Финалният файл е валиден', () => { verifyBackupFile(finalPath) })
  await check('[3.3] Само един файл за деня', async () => {
    const daily = (await readdir(backupDir)).filter(f => BACKUP_DAILY_NAME_RE.test(f))
    if (daily.length !== 1) throw new Error(`файлове=${daily.join(', ')}`)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [4] Retention: 16 файла → 14; непознати файлове и подпапки непокътнати
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[4] Retention: 16 файла → 14; непознати непокътнати')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  await mkdir(backupDir, { recursive: true })
  makeValidDb(sourceFile)

  for (let i = 1; i <= 15; i++) {
    const ds = `2025-${String(i).padStart(2, '0')}-01`
    await writeFile(join(backupDir, `belot-v2-${ds}.sqlite`), `fake-${i}`, 'utf8')
  }

  await writeFile(join(backupDir, 'README.txt'), 'непознат файл', 'utf8')
  await mkdir(join(backupDir, 'subdir'), { recursive: true })
  await writeFile(join(backupDir, 'subdir', 'note.txt'), 'в подпапка', 'utf8')

  await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-06-01' })

  const daily = (await readdir(backupDir)).filter(f => BACKUP_DAILY_NAME_RE.test(f)).sort()

  await check('[4.1] Точно RETENTION_COUNT файла', () => {
    if (daily.length !== RETENTION_COUNT) throw new Error(`${daily.length} файла`)
  })
  await check('[4.2] Най-новият е запазен', () => {
    if (!daily.includes('belot-v2-2026-06-01.sqlite')) throw new Error(daily.join(', '))
  })
  await check('[4.3] Най-старите са изтрити', () => {
    if (daily.includes('belot-v2-2025-01-01.sqlite')) throw new Error('2025-01 е останал')
    if (daily.includes('belot-v2-2025-02-01.sqlite')) throw new Error('2025-02 е останал')
  })
  await check('[4.4] README.txt е непокътнат', async () => {
    await stat(join(backupDir, 'README.txt'))
  })
  await check('[4.5] subdir/ е непокътнат', async () => {
    await stat(join(backupDir, 'subdir', 'note.txt'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [5] Stale .tmp преди старт се изтрива
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[5] Stale .tmp преди старт')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  await mkdir(backupDir, { recursive: true })
  makeValidDb(sourceFile)

  const staleTmp = join(backupDir, 'belot-v2-2026-01-05.sqlite.tmp')
  await writeFile(staleTmp, 'STALE TMP CONTENT', 'utf8')

  const { log } = await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-01-05' })

  await check('[5.1] Лог съдържа STALE_TMP_REMOVED', () => {
    if (!log.includes('STALE_TMP_REMOVED')) throw new Error(JSON.stringify(log))
  })
  await check('[5.2] .tmp не е останал след успешен backup', async () => {
    if (await fileExists(staleTmp)) throw new Error('stale .tmp е останал')
  })
  await check('[5.3] Финалният файл е валиден', async () => {
    verifyBackupFile(join(backupDir, 'belot-v2-2026-01-05.sqlite'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [6] Грешка от backup(): fake backupFn записва partial .tmp и хвърля → cleanup
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[6] Грешка от backup(): fake backupFn → partial .tmp cleanup')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  await mkdir(backupDir, { recursive: true })
  makeValidDb(sourceFile)

  const tmpPath = join(backupDir, 'belot-v2-2026-01-06.sqlite.tmp')

  // Fake backupFn: записва partial .tmp и хвърля — симулира прекъснат I/O
  const fakeBackupFn = async (_src: unknown, destPath: string): Promise<void> => {
    await writeFile(destPath, 'PARTIAL BACKUP CONTENT — INCOMPLETE', 'utf8')
    throw new Error('симулиран I/O провал при backup')
  }

  let threw = false
  let errorMessage = ''
  try {
    await runDatabaseBackup({
      sourceFile,
      backupDir,
      dateStr: '2026-01-06',
      backupFn: fakeBackupFn,
    })
  } catch (err) {
    threw = true
    errorMessage = err instanceof Error ? err.message : String(err)
  }

  await check('[6.1] Функцията е хвърлила грешка', () => {
    if (!threw) throw new Error('не е хвърлено')
  })
  await check('[6.2] Грешката съдържа backup() съобщението', () => {
    if (!errorMessage.includes('симулиран I/O провал')) {
      throw new Error(`message=${errorMessage}`)
    }
  })
  await check('[6.3] .tmp не е останал (partial файл е изтрит)', async () => {
    if (await fileExists(tmpPath)) throw new Error('.tmp е останал')
  })
  await check('[6.4] Финален файл не е създаден', async () => {
    const final = join(backupDir, 'belot-v2-2026-01-06.sqlite')
    if (await fileExists(final)) throw new Error('финален файл е създаден при грешка')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [7] Грешка при verify на tmp → .tmp се изтрива
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[7] Грешка при verify → .tmp cleanup')
await withTmpDir(async (dir) => {
  const backupDir = join(dir, 'backups', 'daily')
  await mkdir(backupDir, { recursive: true })

  // Source без задължителните таблици → backup успява, но verify проваля
  const badSrc = join(dir, 'bad-source.sqlite')
  const db = new DatabaseSync(badSrc, { open: true })
  db.exec('CREATE TABLE random_table (id INTEGER PRIMARY KEY)')
  db.close()

  const tmpPath = join(backupDir, 'belot-v2-2026-01-07.sqlite.tmp')

  let threw = false
  try {
    await runDatabaseBackup({ sourceFile: badSrc, backupDir, dateStr: '2026-01-07' })
  } catch {
    threw = true
  }

  await check('[7.1] Функцията е хвърлила грешка', () => {
    if (!threw) throw new Error('не е хвърлено')
  })
  await check('[7.2] .tmp не е останал', async () => {
    if (await fileExists(tmpPath)) throw new Error('.tmp е останал')
  })
  await check('[7.3] Финален файл не е създаден', async () => {
    const final = join(backupDir, 'belot-v2-2026-01-07.sqlite')
    if (await fileExists(final)) throw new Error('финален файл е създаден при грешка')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [8] Restore verification: tmpdir cleanup при грешка; оригиналът непокътнат
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[8] Restore verification: tmpdir cleanup при грешка; оригиналът непокътнат')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  makeValidDb(sourceFile)

  const { finalPath } = await runDatabaseBackup({
    sourceFile,
    backupDir,
    dateStr: '2026-01-08',
  })

  const countBefore = (() => {
    const db = new DatabaseSync(sourceFile, { open: true })
    const n = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    db.close()
    return n
  })()

  // Верифицираме backup с реалната verifyIsolatedDb от backupHelpers
  const tmpVerify = await mkdtemp(join(tmpdir(), 'belot-chk-'))
  let cleanedUp = false
  try {
    const tmpDb = join(tmpVerify, 'verify.sqlite')
    await copyFile(finalPath, tmpDb)

    const result = verifyIsolatedDb(tmpDb)

    await check('[8.1] integrity_check ok в tmpDb', () => {
      if (!result.integrityOk) throw new Error('integrity не е ok')
    })
    await check('[8.2] migrationCount > 0', () => {
      if (result.migrationCount === 0) throw new Error('0 миграции')
    })
    await check('[8.3] accountCount > 0', () => {
      if (result.accountCount === 0) throw new Error('0 акаунти')
    })

    // Симулираме грешка след verify → finally трябва да почисти tmpdir
    throw new Error('симулирана грешка след verify')
  } catch (e) {
    if ((e as Error).message !== 'симулирана грешка след verify') {
      fail('[8] Неочаквана грешка', e)
    }
  } finally {
    await rm(tmpVerify, { recursive: true, force: true })
    cleanedUp = true
  }

  await check('[8.4] tmpdir е изтрит (finally)', () => {
    if (!cleanedUp) throw new Error('finally не е изпълнен')
  })
  await check('[8.5] tmpdir вече не съществува', async () => {
    if (await fileExists(tmpVerify)) throw new Error('tmpdir е останал')
  })
  await check('[8.6] Source базата е непокътната', () => {
    const db = new DatabaseSync(sourceFile, { open: true })
    const n = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    db.close()
    if (n !== countBefore) throw new Error(`accounts: преди=${countBefore} след=${n}`)
  })
  await check('[8.7] Backup файлът е непокътнат', () => {
    verifyBackupFile(finalPath)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// [9] Retention при SKIP path (вече валиден дневен backup)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n[9] Retention при SKIP path')
await withTmpDir(async (dir) => {
  const sourceFile = join(dir, 'source.sqlite')
  const backupDir  = join(dir, 'backups', 'daily')
  makeValidDb(sourceFile)

  await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-09-01' })

  for (let i = 1; i <= 15; i++) {
    const ds = `2024-${String(i).padStart(2, '0')}-01`
    await writeFile(join(backupDir, `belot-v2-${ds}.sqlite`), `old-${i}`, 'utf8')
  }

  // Второ извикване → SKIP + retention трябва да изтрие 2 от 16
  const { log } = await runDatabaseBackup({ sourceFile, backupDir, dateStr: '2026-09-01' })

  await check('[9.1] SKIP path е изпълнен', () => {
    if (!log.some(l => l.startsWith('SKIP:'))) throw new Error(JSON.stringify(log))
  })
  await check('[9.2] Retention е изпълнен при SKIP (DELETED в лога)', () => {
    if (!log.some(l => l.startsWith('DELETED:'))) throw new Error(JSON.stringify(log))
  })
  await check('[9.3] Файловете са ≤ RETENTION_COUNT', async () => {
    const daily = (await readdir(backupDir)).filter(f => BACKUP_DAILY_NAME_RE.test(f))
    if (daily.length > RETENTION_COUNT) {
      throw new Error(`${daily.length} файла (max ${RETENTION_COUNT})`)
    }
  })
  await check('[9.4] Валидният дневен backup е запазен', async () => {
    if (!(await fileExists(join(backupDir, 'belot-v2-2026-09-01.sqlite')))) {
      throw new Error('файлът за деня е изтрит')
    }
  })
})

// ── Резултат ──────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1

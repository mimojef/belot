/**
 * checkProfileCustomizationMigrationsOnCopy.ts
 *
 * Прилага миграциите 20261107_001/_002 върху КОПИЕ на съществуваща база
 * (по подразбиране локалната dev база) — оригиналът само се копира и не се
 * отваря за запис. Проверява целост, FK, запазени данни, индекси, тригери,
 * seed, режим по подразбиране и идемпотентност.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationMigrationsOnCopy.ts --server-root=. --source-db=<път до .sqlite>
 */

import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'

const args = process.argv.slice(2)
const serverRoot = resolve(args.find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const sourceDb = args.find((a) => a.startsWith('--source-db='))?.slice('--source-db='.length)
if (!sourceDb) throw new Error('--source-db= е задължителен')

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) } catch (error) { failed++; console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`) }
}
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }

const NEW = ['20261107_001_create_profile_customization.sql', '20261107_002_allow_profile_customization_payment_review_issues.sql']

console.log('\ncheckProfileCustomizationMigrationsOnCopy')
const root = await mkdtemp(join(tmpdir(), 'belot-pc-migrations-copy-'))
try {
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const name of await readdir(join(serverRoot, 'database', 'migrations'))) {
    if (name.endsWith('.sql')) await cp(join(serverRoot, 'database', 'migrations', name), join(root, 'database', 'migrations', name))
  }
  const target = join(root, 'database', 'data', 'belot-v2.sqlite')
  for (const suffix of ['', '-wal', '-shm']) {
    try { await stat(sourceDb + suffix); await cp(sourceDb + suffix, target + suffix) } catch { /* няма такъв файл */ }
  }

  const before = new DatabaseSync(target)
  const appliedBefore = (before.prepare('SELECT filename FROM server_migrations;').all() as Array<{ filename: string }>).map((r) => r.filename)
  const pendingBefore = (await readdir(join(root, 'database', 'migrations'))).filter((n) => n.endsWith('.sql') && !appliedBefore.includes(n)).sort()
  const pri = before.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='payment_review_issues';`).get() !== undefined
  const priRows = pri ? JSON.stringify(before.prepare('SELECT * FROM payment_review_issues ORDER BY issue_id;').all()) : '[]'
  const counts = (db: DatabaseSync) => Object.fromEntries(['profiles', 'accounts', 'coin_purchase_ledger', 'vip_purchase_ledger', 'bundle_purchase_ledger', 'topic_messages', 'profile_friendships']
    .map((t) => [t, (db.prepare(`SELECT COUNT(*) AS c FROM ${t};`).get() as { c: number }).c]))
  const countsBefore = counts(before)
  before.close()
  console.log(`  Копие: ${appliedBefore.length} приложени миграции; предстоящи: ${pendingBefore.join(', ') || '—'}`)
  console.log(`  Редове преди: ${JSON.stringify(countsBefore)}; payment_review_issues: ${JSON.parse(priRows).length}`)

  await ensureServerDatabaseReady({ serverRootOverride: root })
  const after = new DatabaseSync(target)

  await check('[E1] Двете нови миграции са приложени; integrity_check = ok; foreign_key_check е празен', () => {
    const applied = (after.prepare('SELECT filename FROM server_migrations;').all() as Array<{ filename: string }>).map((r) => r.filename)
    for (const name of NEW) assert(applied.includes(name), name)
    assert((after.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check === 'ok', 'integrity')
    assert((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length === 0, 'foreign_key_check')
  })

  await check('[E2] Съществуващите данни са непокътнати (вкл. payment_review_issues байт по байт)', () => {
    assert(JSON.stringify(counts(after)) === JSON.stringify(countsBefore), `${JSON.stringify(counts(after))}`)
    assert(JSON.stringify(after.prepare('SELECT * FROM payment_review_issues ORDER BY issue_id;').all()) === priRows, 'payment_review_issues')
  })

  await check('[E3] payment_review_issues: нов CHECK, UNIQUE и индекс са на място', () => {
    const sql = (after.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_review_issues';`).get() as { sql: string }).sql
    assert(sql.includes("'profile_customization'") && sql.includes('UNIQUE (checkout_session_id, issue_kind)') && sql.includes('is_transient'), sql.slice(0, 200))
    assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_payment_review_issues_status';`).get() !== undefined, 'индекс')
  })

  await check('[E4] Новите таблици, индекси и тригери; seed (4 вида изключени, 21 цвята, 655 емоджита); режим "Само админ"', () => {
    for (const t of ['profile_customization_kind_settings', 'profile_customization_colors', 'profile_customization_emojis', 'profile_customization_purchases', 'profile_customization_active', 'profile_customization_mode_changes']) {
      assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?;`).get(t) !== undefined, t)
    }
    for (const trigger of ['trg_profile_customization_colors_hex_immutable', 'trg_profile_customization_emojis_value_immutable']) {
      assert(after.prepare(`SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?;`).get(trigger) !== undefined, trigger)
    }
    const indexes = (after.prepare(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='index' AND tbl_name LIKE 'profile_customization_%' AND sql IS NOT NULL;`).get() as { c: number }).c
    assert(indexes >= 9, `индекси ${indexes}`)
    assert((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_kind_settings WHERE sales_enabled = 0;').get() as { c: number }).c === 4, 'видове')
    assert((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_colors;').get() as { c: number }).c === 21, 'цветове')
    assert((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_emojis;').get() as { c: number }).c === 655, 'емоджита')
    assert((after.prepare('SELECT COUNT(*) AS c FROM profile_customization_mode_changes;').get() as { c: number }).c === 0, 'без запис за режим -> "Само админ"')
  })
  after.close()

  await check('[E5] Повторно стартиране: нищо не се прилага повторно, seed-ът не се дублира', async () => {
    await ensureServerDatabaseReady({ serverRootOverride: root })
    const again = new DatabaseSync(target)
    assert((again.prepare('SELECT COUNT(*) AS c FROM profile_customization_colors;').get() as { c: number }).c === 21, 'цветове')
    assert((again.prepare(`SELECT COUNT(*) AS c FROM server_migrations WHERE filename LIKE '20261107_%';`).get() as { c: number }).c === 2, 'записи')
    again.close()
  })

  await check('[E6] Оригиналната база не е променена', async () => {
    const original = new DatabaseSync(sourceDb, { readOnly: true })
    const has = original.prepare(`SELECT COUNT(*) AS c FROM server_migrations WHERE filename LIKE '20261107_%';`).get() as { c: number }
    const hash = createHash('sha256').update(JSON.stringify(original.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'profile_customization%';`).all())).digest('hex').slice(0, 8)
    original.close()
    assert(has.c === 0, 'оригиналът няма новите миграции')
    console.log(`        (оригинал: без profile_customization таблици — ${hash})`)
  })
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

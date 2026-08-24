/**
 * checkYellowCoinGiftLimit.ts
 *
 * Checks за 60-дневния rolling лимит за получени жълтици и migration CASCADE fix.
 *
 * [0]  Migration запазва съществуващи ledger редове
 * [1]  Реалният migration файл: след DELETE на приятелство ledger остава, friendship_id → NULL
 * [2]  Получател с 0 получени — подарък 30 000 се приема
 * [3]  Получател с 25 000 получени — подарък 5 000 се приема (точно на лимита)
 * [4]  Получател с 25 000 получени — подарък 6 000 се отказва (PARTIAL, кратно на 1 000)
 *        sender balance непроменен, recipient balance непроменен, без ledger ред
 * [5]  Подаръци от различни изпращачи се сумират по получателя
 * [6]  Подарък на повече от 60 дни не участва в лимита
 * [7]  Подарък в текущите 60 дни участва в лимита
 * [8]  nextReleaseAt е най-старият created_at + 60 дни (строг ISO UTC)
 * [9]  nextReleaseAmount сумира всички редове с еднакъв най-ранен created_at
 * [10] При точно 30 000 получени — RECIPIENT_WINDOW_LIMIT_FULL
 * [11] При частичен оставащ лимит — RECIPIENT_WINDOW_LIMIT_PARTIAL
 * [12] Sender 24-часов лимит 200 000 продължава да работи
 * [13] Insufficient balance — няма частични промени
 * [14] Concurrency: два едновременни подаръка — точно един минава, един се отказва с FULL
 * [15] Точна 60-дневна граница: created_at = datetime('now','-60 days') не участва в прозореца
 * [16] amount = 999 → отказ (под минимума)
 * [17] amount = 1 000 → приема се (минималната допустима сума)
 * [18] amount = 30 000 → приема се (максималната допустима сума)
 * [19] amount = 30 001 → отказ (над максимума)
 * [20] amount = 1 500 → отказ (некратно на 1 000)
 * [35] Pika sender: amount = 100 000 → приема се (нов single-операция максимум)
 * [36] Pika sender: amount = 100 001 → отказ (над новия максимум)
 * [37] Pika sender: нормален подарък (30 000) веднага след предходна операция
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import type { PlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createYellowCoinGiftStore } from '../src/db/yellowCoinGiftStore.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const cascadeMigrationPath = resolve(
  serverRoot,
  'database/migrations/20260630_001_fix_gift_ledger_cascade.sql',
)
const recipientLimitExemptMigrationPath = resolve(
  serverRoot,
  'database/migrations/20260804_001_add_yellow_coin_gift_recipient_limit_exempt.sql',
)
const PIKA_BYPASS_PROFILE_ID = '4c146064-85af-4e6e-b08f-08faa39b167e'

// ─── Worker thread за concurrency тест ─────────────────────────────────────

type WorkerResult = { ok: boolean; code?: string; message?: string; error?: string }

if (!isMainThread) {
  const { dbPath, friendshipId, senderProfileId, amount, pikaTeamGiftBypassProfileId } = workerData as {
    dbPath: string
    friendshipId: string
    senderProfileId: string
    amount: number
    pikaTeamGiftBypassProfileId?: string | null
  }

  let store: Awaited<ReturnType<typeof createYellowCoinGiftStore>> | null = null
  try {
    store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId,
    })
    const result = store.sendGift(senderProfileId, friendshipId, amount)
    const msg: WorkerResult = {
      ok: result.ok,
      code: 'code' in result ? result.code : undefined,
      message: 'message' in result ? (result as { message: string }).message : undefined,
    }
    parentPort?.postMessage(msg)
  } catch (err) {
    parentPort?.postMessage({ ok: false, error: String(err) } satisfies WorkerResult)
  } finally {
    try { store?.close() } catch { /* ignore */ }
  }

  process.exit(0)
}

// ─── Брояч ─────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-gift-limit-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Минимален stub за PlayerProgressStore — само getPublicProfile се ползва от sendGift
function makeMockProgressStore(): PlayerProgressStore {
  return {
    getPublicProfile: (profileId) => ({
      profileId,
      displayName: profileId,
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
      completedGamesCount: null,
      wonGamesCount: null,
      currentRankGames: null,
      nextRankGames: null,
      gamesUntilNextRank: null,
      rankProgressRatio: null,
      averageRating: null,
      totalRatingsCount: null,
      yellowCoinsBalance: null,
      gender: null,
      galleryImages: [],
      likesCount: null,
      hasLikedByMe: null,
      isBlockedByMe: null,
    }),
  } as unknown as PlayerProgressStore
}

// Сгражда минимална schema нужна за yellowCoinGiftStore
function buildBaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      profile_kind TEXT NOT NULL DEFAULT 'human',
      status TEXT NOT NULL DEFAULT 'active',
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0
        CHECK (yellow_coins_balance >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profile_friendships (
      friendship_id TEXT PRIMARY KEY,
      requester_profile_id TEXT NOT NULL,
      addressee_profile_id TEXT NOT NULL,
      lower_profile_id TEXT NOT NULL,
      higher_profile_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'blocked')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT NULL,
      kind TEXT NOT NULL DEFAULT 'friend'
        CHECK (kind IN ('friend', 'pika_support', 'vip_dm')),
      CHECK (requester_profile_id <> addressee_profile_id),
      CHECK (lower_profile_id <> higher_profile_id),
      UNIQUE (lower_profile_id, higher_profile_id),
      FOREIGN KEY (requester_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (addressee_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (lower_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (higher_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
  `)
}

// Прилага migration 008 (оригиналната схема с ON DELETE CASCADE)
function applyOriginalGiftLedgerSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS yellow_coin_gift_ledger (
      gift_id TEXT PRIMARY KEY,
      friendship_id TEXT NOT NULL,
      sender_profile_id TEXT NOT NULL,
      recipient_profile_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      sender_balance_after INTEGER NOT NULL CHECK (sender_balance_after >= 0),
      recipient_balance_after INTEGER NOT NULL CHECK (recipient_balance_after >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (sender_profile_id <> recipient_profile_id),
      FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE CASCADE,
      FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_sender
      ON yellow_coin_gift_ledger(sender_profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_recipient
      ON yellow_coin_gift_ledger(recipient_profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_yellow_coin_gift_ledger_friendship
      ON yellow_coin_gift_ledger(friendship_id, created_at);
  `)
}

// Прилага реален migration файл (обвит в BEGIN/COMMIT, както го прави runner-ът)
async function applyMigrationFile(db: DatabaseSync, migrationPath: string): Promise<void> {
  const sql = await readFile(migrationPath, 'utf8')
  db.exec('BEGIN;')
  try {
    db.exec(sql)
    db.exec('COMMIT;')
  } catch (err) {
    db.exec('ROLLBACK;')
    throw err
  }
}

async function applyNewMigration(db: DatabaseSync): Promise<void> {
  await applyMigrationFile(db, cascadeMigrationPath)
  await applyMigrationFile(db, recipientLimitExemptMigrationPath)
}

async function applyRecipientLimitExemptMigration(db: DatabaseSync): Promise<void> {
  await applyMigrationFile(db, recipientLimitExemptMigrationPath)
}

// Помощна функция за новата gift ledger схема (нова схема след migration)
function applyNewGiftLedgerSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE yellow_coin_gift_ledger (
      gift_id TEXT PRIMARY KEY,
      friendship_id TEXT NULL,
      sender_profile_id TEXT NOT NULL,
      recipient_profile_id TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      sender_balance_after INTEGER NOT NULL CHECK (sender_balance_after >= 0),
      recipient_balance_after INTEGER NOT NULL CHECK (recipient_balance_after >= 0),
      recipient_limit_exempt INTEGER NOT NULL DEFAULT 0 CHECK (recipient_limit_exempt IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (sender_profile_id <> recipient_profile_id),
      FOREIGN KEY (friendship_id) REFERENCES profile_friendships(friendship_id) ON DELETE SET NULL,
      FOREIGN KEY (sender_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (recipient_profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gift_recipient ON yellow_coin_gift_ledger(recipient_profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_gift_sender ON yellow_coin_gift_ledger(sender_profile_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_gift_friendship ON yellow_coin_gift_ledger(friendship_id, created_at);
  `)
}

function hasRecipientLimitExemptColumn(db: DatabaseSync): boolean {
  return (db.prepare(`PRAGMA table_info(yellow_coin_gift_ledger);`).all() as Array<{ name: string }>)
    .some((row) => row.name === 'recipient_limit_exempt')
}

// Seed helpers
function seedProfile(db: DatabaseSync, profileId: string, balance: number = 0): void {
  db.exec(`INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('${profileId}', '${profileId}')`)
  db.exec(`INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('${profileId}', ${balance})`)
}

function seedFriendship(db: DatabaseSync, id: string, p1: string, p2: string): void {
  const lower = p1 < p2 ? p1 : p2
  const higher = p1 < p2 ? p2 : p1
  db.exec(`INSERT OR IGNORE INTO profile_friendships
    (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind)
    VALUES ('${id}', '${p1}', '${p2}', '${lower}', '${higher}', 'accepted', 'friend')`)
}

function seedGiftLedger(
  db: DatabaseSync,
  giftId: string,
  friendshipId: string,
  sender: string,
  recipient: string,
  amount: number,
  createdAt: string,
  recipientLimitExempt: 0 | 1 = 0,
): void {
  if (hasRecipientLimitExemptColumn(db)) {
    db.exec(`INSERT INTO yellow_coin_gift_ledger
      (gift_id, friendship_id, sender_profile_id, recipient_profile_id, amount,
       sender_balance_after, recipient_balance_after, recipient_limit_exempt, created_at)
      VALUES ('${giftId}', '${friendshipId}', '${sender}', '${recipient}', ${amount},
       0, ${amount}, ${recipientLimitExempt}, '${createdAt}')`)
    return
  }

  db.exec(`INSERT INTO yellow_coin_gift_ledger
    (gift_id, friendship_id, sender_profile_id, recipient_profile_id, amount,
     sender_balance_after, recipient_balance_after, created_at)
    VALUES ('${giftId}', '${friendshipId}', '${sender}', '${recipient}', ${amount},
     0, ${amount}, '${createdAt}')`)
}

// UTC timestamp N дни назад като SQLite CURRENT_TIMESTAMP формат "YYYY-MM-DD HH:MM:SS"
// Използва UTC милисекунди — без DST влияние.
function utcDaysAgo(n: number): string {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

// Преобразува SQLite "YYYY-MM-DD HH:MM:SS" в строг ISO 8601 UTC "YYYY-MM-DDTHH:MM:SS.000Z"
function toExpectedIso(sqliteTs: string): string {
  return sqliteTs.replace(' ', 'T') + '.000Z'
}

async function withPikaBypassEnv(value: string | null, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.PIKA_TEAM_GIFT_BYPASS_PROFILE_ID
  try {
    if (value === null) {
      delete process.env.PIKA_TEAM_GIFT_BYPASS_PROFILE_ID
    } else {
      process.env.PIKA_TEAM_GIFT_BYPASS_PROFILE_ID = value
    }
    await fn()
  } finally {
    if (previous === undefined) {
      delete process.env.PIKA_TEAM_GIFT_BYPASS_PROFILE_ID
    } else {
      process.env.PIKA_TEAM_GIFT_BYPASS_PROFILE_ID = previous
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('\n=== checkYellowCoinGiftLimit ===\n')

await withTempDir(async (dir) => {
  // ── [0] Migration запазва данни ─────────────────────────────────────────
  await check('[0] Migration запазва съществуващи ledger редове', async () => {
    const dbPath = join(dir, 'test0.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyOriginalGiftLedgerSchema(db)

    seedProfile(db, 'sender-0', 100_000)
    seedProfile(db, 'recipient-0', 0)
    seedFriendship(db, 'fs-0', 'sender-0', 'recipient-0')
    seedGiftLedger(db, 'gift-0', 'fs-0', 'sender-0', 'recipient-0', 5_000, utcDaysAgo(5))
    db.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.exec('PRAGMA foreign_keys = ON;')
    await applyNewMigration(db2)

    const row = db2.prepare('SELECT * FROM yellow_coin_gift_ledger WHERE gift_id = ?').get('gift-0') as Record<string, unknown> | undefined
    db2.close()

    assert(row !== undefined, 'Редът трябва да съществува след migration')
    assertEqual(row!['amount'] as number, 5_000, 'amount непроменен')
    assertEqual(row!['friendship_id'] as string, 'fs-0', 'friendship_id непроменен')
    assertEqual(row!['recipient_limit_exempt'] as number, 0, 'recipient_limit_exempt default 0')
  })

  // ── [1] Реален migration файл: DELETE приятелство → ledger остава, friendship_id → NULL
  await check('[1] Реален migration: DELETE на приятелство → ledger остава, friendship_id → NULL', async () => {
    const dbPath = join(dir, 'test1.sqlite')

    // 1. buildBaseSchema
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)

    // 2. applyOriginalGiftLedgerSchema (с ON DELETE CASCADE)
    applyOriginalGiftLedgerSchema(db)

    // 3-5. Seed
    seedProfile(db, 'sender-1', 100_000)
    seedProfile(db, 'recipient-1', 0)
    seedFriendship(db, 'fs-1', 'sender-1', 'recipient-1')
    seedGiftLedger(db, 'gift-1', 'fs-1', 'sender-1', 'recipient-1', 1_000, utcDaysAgo(3))
    db.close()

    // 6. applyNewMigration чрез реалния файл
    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.exec('PRAGMA foreign_keys = ON;')
    await applyNewMigration(db2)
    db2.close()

    // 7. DELETE FROM profile_friendships (в отделна connection след migration)
    const db3 = new DatabaseSync(dbPath, { open: true })
    db3.exec('PRAGMA foreign_keys = ON;')
    db3.exec("DELETE FROM profile_friendships WHERE friendship_id = 'fs-1'")

    // 8. Проверки
    const row = db3.prepare(
      'SELECT friendship_id, amount, sender_profile_id, recipient_profile_id, created_at FROM yellow_coin_gift_ledger WHERE gift_id = ?'
    ).get('gift-1') as Record<string, unknown> | undefined
    db3.close()

    assert(row !== undefined, 'Ledger редът трябва да остане след изтриване на приятелство')
    assert(row!['friendship_id'] === null, `friendship_id трябва да е NULL, но е: ${String(row!['friendship_id'])}`)
    assertEqual(row!['amount'] as number, 1_000, 'amount непроменен')
    assertEqual(row!['sender_profile_id'] as string, 'sender-1', 'sender_profile_id непроменен')
    assertEqual(row!['recipient_profile_id'] as string, 'recipient-1', 'recipient_profile_id непроменен')
    assert(typeof row!['created_at'] === 'string' && (row!['created_at'] as string).length > 0, 'created_at е запазен')
  })

  // ── [2] Получател с 0 → подарък 30 000 се приема ───────────────────────
  await check('[2] Получател с 0 получени — подарък 30 000 се приема', async () => {
    const dbPath = join(dir, 'test2.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-2', 100_000)
    seedProfile(db, 'recipient-2', 0)
    seedFriendship(db, 'fs-2', 'sender-2', 'recipient-2')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-2', 'fs-2', 30_000)
    store.close()

    assert(result.ok === true, `Очаква се ok:true, но: ${JSON.stringify(result)}`)
  })

  // ── [3] Получател с 25 000 → подарък 5 000 се приема (на лимита) ────────
  await check('[3] Получател с 25 000 — подарък 5 000 се приема', async () => {
    const dbPath = join(dir, 'test3.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-3', 100_000)
    seedProfile(db, 'other-3', 100_000)
    seedProfile(db, 'recipient-3', 0)
    seedFriendship(db, 'fs-3a', 'sender-3', 'recipient-3')
    seedFriendship(db, 'fs-3b', 'other-3', 'recipient-3')
    seedGiftLedger(db, 'gift-3-old', 'fs-3b', 'other-3', 'recipient-3', 25_000, utcDaysAgo(10))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-3', 'fs-3a', 5_000)
    store.close()

    assert(result.ok === true, `Очаква се ok:true (точно на лимита), но: ${JSON.stringify(result)}`)
  })

  // ── [4] Получател с 25 000 → подарък 6 000 се отказва ──────────────────
  await check('[4] Получател с 25 000 — подарък 6 000 се отказва (PARTIAL)', async () => {
    const dbPath = join(dir, 'test4.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-4', 100_000)
    seedProfile(db, 'recipient-4', 0)
    seedFriendship(db, 'fs-4', 'sender-4', 'recipient-4')
    seedGiftLedger(db, 'gift-4-old', 'fs-4', 'sender-4', 'recipient-4', 25_000, utcDaysAgo(5))
    db.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    const senderBalanceBefore = (db2.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('sender-4') as { yellow_coins_balance: number }).yellow_coins_balance
    const recipientBalanceBefore = (db2.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('recipient-4') as { yellow_coins_balance: number }).yellow_coins_balance
    const ledgerCountBefore = (db2.prepare('SELECT COUNT(*) as c FROM yellow_coin_gift_ledger').get() as { c: number }).c
    db2.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-4', 'fs-4', 6_000)
    store.close()

    const db3 = new DatabaseSync(dbPath, { open: true })
    const senderBalanceAfter = (db3.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('sender-4') as { yellow_coins_balance: number }).yellow_coins_balance
    const recipientBalanceAfter = (db3.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('recipient-4') as { yellow_coins_balance: number }).yellow_coins_balance
    const ledgerCountAfter = (db3.prepare('SELECT COUNT(*) as c FROM yellow_coin_gift_ledger').get() as { c: number }).c
    db3.close()

    assert(result.ok === false, 'Очаква се ok:false')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_PARTIAL', `Очаква се PARTIAL, но: ${JSON.stringify(result)}`)
    assertEqual(senderBalanceAfter, senderBalanceBefore, 'sender balance непроменен')
    assertEqual(recipientBalanceAfter, recipientBalanceBefore, 'recipient balance непроменен')
    assertEqual(ledgerCountAfter, ledgerCountBefore, 'няма нов ledger ред')
  })

  // ── [5] Подаръци от различни изпращачи се сумират ───────────────────────
  await check('[5] Подаръци от различни изпращачи се сумират по получателя', async () => {
    const dbPath = join(dir, 'test5.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-5a', 100_000)
    seedProfile(db, 'sender-5b', 100_000)
    seedProfile(db, 'sender-5c', 100_000)
    seedProfile(db, 'recipient-5', 0)
    seedFriendship(db, 'fs-5a', 'sender-5a', 'recipient-5')
    seedFriendship(db, 'fs-5b', 'sender-5b', 'recipient-5')
    seedFriendship(db, 'fs-5c', 'sender-5c', 'recipient-5')
    // Три различни изпращача, общо 27 000 получени
    seedGiftLedger(db, 'g5a', 'fs-5a', 'sender-5a', 'recipient-5', 10_000, utcDaysAgo(10))
    seedGiftLedger(db, 'g5b', 'fs-5b', 'sender-5b', 'recipient-5', 10_000, utcDaysAgo(8))
    seedGiftLedger(db, 'g5c', 'fs-5c', 'sender-5c', 'recipient-5', 7_000, utcDaysAgo(5))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    // 27 000 + 5 000 = 32 000 > 30 000
    const result = store.sendGift('sender-5a', 'fs-5a', 5_000)
    store.close()

    assert(result.ok === false, 'Очаква се отказ (27 000 + 5 000 = 32 000 > 30 000)')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_PARTIAL', `Код: ${JSON.stringify(result)}`)
  })

  // ── [6] Подарък > 60 дни не участва ─────────────────────────────────────
  await check('[6] Подарък на повече от 60 дни не участва в лимита', async () => {
    const dbPath = join(dir, 'test6.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-6', 100_000)
    seedProfile(db, 'recipient-6', 0)
    seedFriendship(db, 'fs-6', 'sender-6', 'recipient-6')
    // 61 дни назад — извън прозореца
    seedGiftLedger(db, 'g6-old', 'fs-6', 'sender-6', 'recipient-6', 30_000, utcDaysAgo(61))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-6', 'fs-6', 30_000)
    store.close()

    assert(result.ok === true, `Подарък > 60 дни не трябва да участва; got: ${JSON.stringify(result)}`)
  })

  // ── [7] Подарък в 60-дневния прозорец участва ───────────────────────────
  await check('[7] Подарък в текущите 60 дни участва в лимита', async () => {
    const dbPath = join(dir, 'test7.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-7', 100_000)
    seedProfile(db, 'recipient-7', 0)
    seedFriendship(db, 'fs-7', 'sender-7', 'recipient-7')
    // 59 дни назад — в прозореца
    seedGiftLedger(db, 'g7', 'fs-7', 'sender-7', 'recipient-7', 30_000, utcDaysAgo(59))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-7', 'fs-7', 1_000)
    store.close()

    assert(result.ok === false, 'Подарък от 59 дни трябва да участва (лимитът е достигнат)')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Код: ${JSON.stringify(result)}`)
  })

  // ── [8] nextReleaseAt е MIN(created_at) + 60 дни (строг ISO UTC) ─────────
  await check('[8] nextReleaseAt е най-старият created_at + 60 дни (строг ISO UTC)', async () => {
    const dbPath = join(dir, 'test8.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-8', 100_000)
    seedProfile(db, 'recipient-8', 0)
    seedFriendship(db, 'fs-8', 'sender-8', 'recipient-8')

    // Динамични дати: oldest = 50 дни назад, newer = 20 дни назад
    const oldestMs = Date.now() - 50 * 24 * 60 * 60 * 1000
    const newerMs = Date.now() - 20 * 24 * 60 * 60 * 1000
    const oldestSqlite = new Date(oldestMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    const newerSqlite = new Date(newerMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

    seedGiftLedger(db, 'g8a', 'fs-8', 'sender-8', 'recipient-8', 20_000, oldestSqlite)
    seedGiftLedger(db, 'g8b', 'fs-8', 'sender-8', 'recipient-8', 10_000, newerSqlite)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-8', 'fs-8', 1_000)
    store.close()

    assert(result.ok === false && 'nextReleaseAt' in result, 'Очаква се error с nextReleaseAt')

    // Очакван nextReleaseAt = oldest + 60 дни, строг ISO UTC
    const expectedReleaseMs = oldestMs + 60 * 24 * 60 * 60 * 1000
    const expectedRelease = new Date(expectedReleaseMs).toISOString().replace(/\.\d{3}Z$/, '.000Z')
    const actualRelease = (result as { nextReleaseAt: string | null }).nextReleaseAt
    assertEqual(actualRelease, expectedRelease, 'nextReleaseAt')
  })

  // ── [9] nextReleaseAmount сумира всички с еднакъв oldest created_at ─────
  await check('[9] nextReleaseAmount сумира всички с еднакъв oldest created_at', async () => {
    const dbPath = join(dir, 'test9.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-9a', 100_000)
    seedProfile(db, 'sender-9b', 100_000)
    seedProfile(db, 'recipient-9', 0)
    seedFriendship(db, 'fs-9a', 'sender-9a', 'recipient-9')
    seedFriendship(db, 'fs-9b', 'sender-9b', 'recipient-9')

    // Динамични дати: sharedOldest = 50 дни назад, newer = 20 дни назад
    const sharedOldest = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    const newerTs = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')

    // Двама изпращача на един и същи timestamp — трябва да се сумират
    seedGiftLedger(db, 'g9a', 'fs-9a', 'sender-9a', 'recipient-9', 8_000, sharedOldest)
    seedGiftLedger(db, 'g9b', 'fs-9b', 'sender-9b', 'recipient-9', 7_000, sharedOldest)
    seedGiftLedger(db, 'g9c', 'fs-9a', 'sender-9a', 'recipient-9', 15_000, newerTs)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-9a', 'fs-9a', 1_000)
    store.close()

    assert(result.ok === false && 'nextReleaseAmount' in result, 'Очаква се error с nextReleaseAmount')
    const actual = (result as { nextReleaseAmount: number }).nextReleaseAmount
    // 8 000 + 7 000 = 15 000 (двата на еднакъв timestamp)
    assertEqual(actual, 15_000, 'nextReleaseAmount трябва да е 15 000')
  })

  // ── [10] FULL при точно 30 000 ───────────────────────────────────────────
  await check('[10] При точно 30 000 получени — RECIPIENT_WINDOW_LIMIT_FULL', async () => {
    const dbPath = join(dir, 'test10.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-10', 100_000)
    seedProfile(db, 'recipient-10', 0)
    seedFriendship(db, 'fs-10', 'sender-10', 'recipient-10')
    seedGiftLedger(db, 'g10', 'fs-10', 'sender-10', 'recipient-10', 30_000, utcDaysAgo(5))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-10', 'fs-10', 1_000)
    store.close()

    assert(result.ok === false, 'Очаква се отказ')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
    const err = result as { remainingAllowance: number }
    assertEqual(err.remainingAllowance, 0, 'remainingAllowance трябва да е 0')
  })

  // ── [11] PARTIAL при частичен оставащ лимит ─────────────────────────────
  await check('[11] При частичен оставащ лимит — RECIPIENT_WINDOW_LIMIT_PARTIAL', async () => {
    const dbPath = join(dir, 'test11.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-11', 100_000)
    seedProfile(db, 'recipient-11', 0)
    seedFriendship(db, 'fs-11', 'sender-11', 'recipient-11')
    seedGiftLedger(db, 'g11', 'fs-11', 'sender-11', 'recipient-11', 20_000, utcDaysAgo(3))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-11', 'fs-11', 15_000)
    store.close()

    assert(result.ok === false, 'Очаква се отказ')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_PARTIAL', `Очаква се PARTIAL, но: ${JSON.stringify(result)}`)
    const err = result as { remainingAllowance: number; attemptedAmount: number }
    assertEqual(err.remainingAllowance, 10_000, 'remainingAllowance трябва да е 10 000')
    assertEqual(err.attemptedAmount, 15_000, 'attemptedAmount трябва да е 15 000')
  })

  // ── [12] Sender 24-часов лимит продължава да работи ─────────────────────
  await check('[12] Sender 24-часов лимит 200 000 продължава да работи', async () => {
    const dbPath = join(dir, 'test12.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-12', 1_000_000)
    seedProfile(db, 'recipient-12', 0)
    seedFriendship(db, 'fs-12', 'sender-12', 'recipient-12')
    // 195 000 изпратени от sender-12 преди 1 час (UTC)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    seedGiftLedger(db, 'g12-sent', 'fs-12', 'sender-12', 'recipient-12', 195_000, oneHourAgo)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    // 195 000 + 10 000 = 205 000 > 200 000 → дневен лимит
    const result = store.sendGift('sender-12', 'fs-12', 10_000)
    store.close()

    assert(result.ok === false, 'Очаква се отказ заради sender daily limit')
    assert(!('code' in result), 'Дневният лимит не трябва да връща code (само message)')
    assert(
      'message' in result && (result as { message: string }).message.includes('Дневният лимит'),
      `Съобщение: ${JSON.stringify(result)}`,
    )
  })

  // ── [13] Insufficient balance — без частични промени ────────────────────
  await check('[13] Insufficient balance — sender balance непроменен', async () => {
    const dbPath = join(dir, 'test13.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-13', 500)
    seedProfile(db, 'recipient-13', 0)
    seedFriendship(db, 'fs-13', 'sender-13', 'recipient-13')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-13', 'fs-13', 1_000)
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    const senderBal = (db2.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('sender-13') as { yellow_coins_balance: number }).yellow_coins_balance
    const recipientBal = (db2.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get('recipient-13') as { yellow_coins_balance: number }).yellow_coins_balance
    const ledgerCount = (db2.prepare('SELECT COUNT(*) as c FROM yellow_coin_gift_ledger').get() as { c: number }).c
    db2.close()

    assert(result.ok === false, 'Очаква се отказ')
    assertEqual(senderBal, 500, 'sender balance непроменен')
    assertEqual(recipientBal, 0, 'recipient balance непроменен')
    assertEqual(ledgerCount, 0, 'без ledger ред')
  })

  // ── [14] Concurrency: точно един минава, един се отказва с FULL ──────────
  await check('[14] Concurrency: два едновременни подаръка — точно един минава с FULL отказ', async () => {
    const dbPath = join(dir, 'test14.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-14a', 100_000)
    seedProfile(db, 'sender-14b', 100_000)
    seedProfile(db, 'recipient-14', 0)
    seedFriendship(db, 'fs-14a', 'sender-14a', 'recipient-14')
    seedFriendship(db, 'fs-14b', 'sender-14b', 'recipient-14')
    // 15 000 вече получени — оставащ лимит: 15 000
    seedGiftLedger(db, 'g14-pre', 'fs-14a', 'sender-14a', 'recipient-14', 15_000, utcDaysAgo(5))
    // WAL mode + busy_timeout преди да стартират worker-ите, за да е готов файлът
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.close()

    // Двата worker-а опитват едновременно по 15 000.
    // Само ЕДИН може да мине (лимитът е точно 15 000), другият трябва да получи FULL.
    const workerScript = fileURLToPath(import.meta.url)

    const results = await Promise.all([
      new Promise<WorkerResult>((resolve) => {
        const w = new Worker(workerScript, {
          workerData: { dbPath, friendshipId: 'fs-14a', senderProfileId: 'sender-14a', amount: 15_000 },
        })
        let msg: WorkerResult | null = null
        w.on('message', (m: WorkerResult) => { msg = m })
        w.on('error', (err) => resolve({ ok: false, error: String(err) }))
        w.on('exit', () => resolve(msg ?? { ok: false, error: 'Worker exited without message' }))
      }),
      new Promise<WorkerResult>((resolve) => {
        const w = new Worker(workerScript, {
          workerData: { dbPath, friendshipId: 'fs-14b', senderProfileId: 'sender-14b', amount: 15_000 },
        })
        let msg: WorkerResult | null = null
        w.on('message', (m: WorkerResult) => { msg = m })
        w.on('error', (err) => resolve({ ok: false, error: String(err) }))
        w.on('exit', () => resolve(msg ?? { ok: false, error: 'Worker exited without message' }))
      }),
    ])

    // Финалното получено в DB; checkpoint за освобождаване на WAL преди temp dir cleanup
    const db2 = new DatabaseSync(dbPath, { open: true })
    const totalReceived = (db2.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM yellow_coin_gift_ledger WHERE recipient_profile_id = 'recipient-14' AND created_at > datetime('now', '-60 days') AND recipient_limit_exempt = 0"
    ).get() as { total: number }).total
    db2.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db2.close()

    const successCount = results.filter((r) => r.ok).length
    const failCount = results.filter((r) => !r.ok).length

    console.log(`    → success=${successCount} fail=${failCount} total=${totalReceived}`)
    console.log(`    → r[0]=${JSON.stringify(results[0])}`)
    console.log(`    → r[1]=${JSON.stringify(results[1])}`)

    // Нито един worker не трябва да е crashнал с unhandled JS exception
    for (const r of results) {
      assert(!r.error, `Worker crashна с неочаквана грешка: ${String(r.error)}`)
    }

    assertEqual(successCount, 1, 'Точно един подарък трябва да е минал')
    assertEqual(failCount, 1, 'Точно един подарък трябва да е отказан')
    assertEqual(totalReceived, 30_000, 'Точно 30 000 трябва да са получени в DB')

    // Отказаният трябва да е с RECIPIENT_WINDOW_LIMIT_FULL.
    // SQLITE_BUSY/database is locked не е допустим резултат — означава, че busy_timeout
    // не е действал правилно.
    const failedResult = results.find((r) => !r.ok)!
    const msgLower = (failedResult.message ?? '').toLowerCase()
    assert(
      !msgLower.includes('sqlite_busy') && !msgLower.includes('database is locked'),
      `SQLITE_BUSY достигна теста — busy_timeout не е действал (${failedResult.message ?? ''})`,
    )
    assertEqual(failedResult.code, 'RECIPIENT_WINDOW_LIMIT_FULL', 'Отказаният трябва да е с FULL код')
  })

  // ── [15] Точна 60-дневна граница ─────────────────────────────────────────
  await check('[15] Точна граница: created_at = datetime(now,-60 days) не участва в прозореца', async () => {
    const dbPath = join(dir, 'test15.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-15', 100_000)
    seedProfile(db, 'recipient-15', 0)
    seedFriendship(db, 'fs-15', 'sender-15', 'recipient-15')

    // Записваме подарък с created_at точно = datetime('now', '-60 days') чрез SQLite
    db.exec(`
      INSERT INTO yellow_coin_gift_ledger
        (gift_id, friendship_id, sender_profile_id, recipient_profile_id, amount,
         sender_balance_after, recipient_balance_after, created_at)
      VALUES ('g15-boundary', 'fs-15', 'sender-15', 'recipient-15', 30000,
        0, 30000, datetime('now', '-60 days'))
    `)
    db.close()

    // SQL условието е created_at > datetime('now', '-60 days') (строго >)
    // Подарък точно на границата НЕ трябва да участва → лимитът не е достигнат
    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-15', 'fs-15', 30_000)
    store.close()

    assert(
      result.ok === true,
      `Подарък точно на 60-дневната граница не трябва да участва (строго >); got: ${JSON.stringify(result)}`,
    )
  })

  // ── [16]–[20] normalizeGiftAmount граници и стъпка ──────────────────────
  //
  // Тези тестове използват самостоятелна DB без ledger данни.
  // При amount = 999, 30 001, 1 500 — normalizeGiftAmount трябва да върне null
  // преди изобщо да се стигне до recipient limit логиката.

  await check('[16] amount = 999 → отказ (под минимума)', async () => {
    const dbPath = join(dir, 'test16.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-16', 100_000)
    seedProfile(db, 'recipient-16', 0)
    seedFriendship(db, 'fs-16', 'sender-16', 'recipient-16')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-16', 'fs-16', 999)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за 999')
    assert(!('code' in result), 'Невалидна сума не трябва да дава limit code')
    assertEqual((result as { message: string }).message, 'Сумата трябва да е между 1 000 и 30 000 жълтици.', 'message [16]')
  })

  await check('[17] amount = 1 000 → приема се (минималната допустима сума)', async () => {
    const dbPath = join(dir, 'test17.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-17', 100_000)
    seedProfile(db, 'recipient-17', 0)
    seedFriendship(db, 'fs-17', 'sender-17', 'recipient-17')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-17', 'fs-17', 1_000)
    store.close()

    assert(result.ok === true, `Очаква се ok:true за 1 000, но: ${JSON.stringify(result)}`)
  })

  await check('[18] amount = 30 000 → приема се (максималната допустима сума)', async () => {
    const dbPath = join(dir, 'test18.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-18', 100_000)
    seedProfile(db, 'recipient-18', 0)
    seedFriendship(db, 'fs-18', 'sender-18', 'recipient-18')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-18', 'fs-18', 30_000)
    store.close()

    assert(result.ok === true, `Очаква се ok:true за 30 000, но: ${JSON.stringify(result)}`)
  })

  await check('[19] amount = 30 001 → отказ (над максимума)', async () => {
    const dbPath = join(dir, 'test19.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-19', 100_000)
    seedProfile(db, 'recipient-19', 0)
    seedFriendship(db, 'fs-19', 'sender-19', 'recipient-19')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-19', 'fs-19', 30_001)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за 30 001')
    assert(!('code' in result), 'Невалидна сума не трябва да дава limit code')
    assertEqual((result as { message: string }).message, 'Сумата трябва да е между 1 000 и 30 000 жълтици.', 'message [19]')
  })

  await check('[20] amount = 1 500 → отказ (некратно на 1 000)', async () => {
    const dbPath = join(dir, 'test20.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'sender-20', 100_000)
    seedProfile(db, 'recipient-20', 0)
    seedFriendship(db, 'fs-20', 'sender-20', 'recipient-20')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-20', 'fs-20', 1_500)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за 1 500 (некратно на 1 000)')
    assert(!('code' in result), 'Некратна сума не трябва да дава limit code')
    assertEqual((result as { message: string }).message, 'Сумата трябва да е между 1 000 и 30 000 жълтици.', 'message [20]')
  })

  await check('[21] Configured Pika sender bypass-ва recipient rolling limit и пише marker=1', async () => {
    const dbPath = join(dir, 'test21.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'ordinary-21', 100_000)
    seedProfile(db, 'recipient-21', 0)
    seedFriendship(db, 'fs-21a', 'ordinary-21', 'recipient-21')
    seedFriendship(db, 'fs-21b', PIKA_BYPASS_PROFILE_ID, 'recipient-21')
    seedGiftLedger(db, 'g21-ordinary', 'fs-21a', 'ordinary-21', 'recipient-21', 30_000, utcDaysAgo(2))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-21b', 30_000)
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    const rows = db2.prepare(`
      SELECT amount, recipient_limit_exempt
      FROM yellow_coin_gift_ledger
      WHERE recipient_profile_id = ?
      ORDER BY created_at ASC
    `).all('recipient-21') as Array<{ amount: number; recipient_limit_exempt: number }>
    const ordinaryTotal = (db2.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM yellow_coin_gift_ledger
      WHERE recipient_profile_id = ? AND recipient_limit_exempt = 0
    `).get('recipient-21') as { total: number }).total
    db2.close()

    assert(result.ok === true, `Очаква се Pika gift да мине, но: ${JSON.stringify(result)}`)
    assertEqual(rows.length, 2, 'history пази ordinary и exempt ред')
    assertEqual(rows[0]!.recipient_limit_exempt, 0, 'ordinary marker=0')
    assertEqual(rows[1]!.recipient_limit_exempt, 1, 'Pika marker=1')
    assertEqual(ordinaryTotal, 30_000, 'ordinary rolling sum не включва Pika gift')
  })

  await check('[22] След Pika gift recipient остава FULL за друг ordinary sender', async () => {
    const dbPath = join(dir, 'test22.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'ordinary-22a', 100_000)
    seedProfile(db, 'ordinary-22b', 100_000)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'recipient-22', 0)
    seedFriendship(db, 'fs-22a', 'ordinary-22a', 'recipient-22')
    seedFriendship(db, 'fs-22b', 'ordinary-22b', 'recipient-22')
    seedFriendship(db, 'fs-22p', PIKA_BYPASS_PROFILE_ID, 'recipient-22')
    seedGiftLedger(db, 'g22-ordinary', 'fs-22a', 'ordinary-22a', 'recipient-22', 30_000, utcDaysAgo(2))
    seedGiftLedger(db, 'g22-pika', 'fs-22p', PIKA_BYPASS_PROFILE_ID, 'recipient-22', 30_000, utcDaysAgo(1), 1)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift('ordinary-22b', 'fs-22b', 1_000)
    store.close()

    assert(result.ok === false, 'Очаква се FULL отказ за ordinary sender')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
  })

  await check('[23] 20 000 ordinary + 50 000 exempt оставят още 10 000 ordinary allowance', async () => {
    const dbPath = join(dir, 'test23.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'ordinary-23a', 100_000)
    seedProfile(db, 'ordinary-23b', 100_000)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'recipient-23', 0)
    seedFriendship(db, 'fs-23a', 'ordinary-23a', 'recipient-23')
    seedFriendship(db, 'fs-23b', 'ordinary-23b', 'recipient-23')
    seedGiftLedger(db, 'g23-ordinary', 'fs-23a', 'ordinary-23a', 'recipient-23', 20_000, utcDaysAgo(3))
    seedGiftLedger(db, 'g23-exempt', 'fs-23a', PIKA_BYPASS_PROFILE_ID, 'recipient-23', 50_000, utcDaysAgo(2), 1)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const first = store.sendGift('ordinary-23b', 'fs-23b', 10_000)
    const second = store.sendGift('ordinary-23b', 'fs-23b', 1_000)
    store.close()

    assert(first.ok === true, `Очаква се 10 000 да минат, но: ${JSON.stringify(first)}`)
    assert(second.ok === false, 'Следващите 1 000 трябва да се откажат')
    assert('code' in second && second.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(second)}`)
  })

  await check('[24] Друг profile с pika_team роля няма bypass без exact UUID match', async () => {
    const dbPath = join(dir, 'test24.sqlite')
    const otherPikaProfileId = '11111111-1111-4111-8111-111111111111'
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, otherPikaProfileId, 100_000)
    seedProfile(db, 'ordinary-24', 100_000)
    seedProfile(db, 'recipient-24', 0)
    seedFriendship(db, 'fs-24a', 'ordinary-24', 'recipient-24')
    seedFriendship(db, 'fs-24p', otherPikaProfileId, 'recipient-24')
    seedGiftLedger(db, 'g24-ordinary', 'fs-24a', 'ordinary-24', 'recipient-24', 30_000, utcDaysAgo(1))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(otherPikaProfileId, 'fs-24p', 1_000)
    store.close()

    assert(result.ok === false, 'Друг pika_team profile не трябва да bypass-ва')
    assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
  })

  await check('[25] Admin/subadmin/chat admin/top chat admin profile-и нямат implicit bypass', async () => {
    const dbPath = join(dir, 'test25.sqlite')
    const senders = [
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    ]
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'ordinary-25', 100_000)
    seedProfile(db, 'recipient-25', 0)
    seedFriendship(db, 'fs-25-base', 'ordinary-25', 'recipient-25')
    seedGiftLedger(db, 'g25-ordinary', 'fs-25-base', 'ordinary-25', 'recipient-25', 30_000, utcDaysAgo(1))
    for (const [index, sender] of senders.entries()) {
      seedProfile(db, sender, 100_000)
      seedFriendship(db, `fs-25-${index}`, sender, 'recipient-25')
    }
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    for (const [index, sender] of senders.entries()) {
      const result = store.sendGift(sender, `fs-25-${index}`, 1_000)
      assert(result.ok === false, `sender ${sender} не трябва да мине`)
      assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
    }
    store.close()
  })

  await check('[26] Липсваща env стойност fail-closed: няма bypass', async () => {
    await withPikaBypassEnv(null, async () => {
      const dbPath = join(dir, 'test26.sqlite')
      const db = new DatabaseSync(dbPath, { open: true })
      db.exec('PRAGMA foreign_keys = ON;')
      buildBaseSchema(db)
      applyNewGiftLedgerSchema(db)
      seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
      seedProfile(db, 'ordinary-26', 100_000)
      seedProfile(db, 'recipient-26', 0)
      seedFriendship(db, 'fs-26a', 'ordinary-26', 'recipient-26')
      seedFriendship(db, 'fs-26p', PIKA_BYPASS_PROFILE_ID, 'recipient-26')
      seedGiftLedger(db, 'g26-ordinary', 'fs-26a', 'ordinary-26', 'recipient-26', 30_000, utcDaysAgo(1))
      db.close()

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
      const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-26p', 1_000)
      store.close()

      assert(result.ok === false, 'Липсваща env стойност не трябва да bypass-ва')
      assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
    })
  })

  await check('[27] Празна env стойност fail-closed: няма bypass', async () => {
    await withPikaBypassEnv('   ', async () => {
      const dbPath = join(dir, 'test27.sqlite')
      const db = new DatabaseSync(dbPath, { open: true })
      db.exec('PRAGMA foreign_keys = ON;')
      buildBaseSchema(db)
      applyNewGiftLedgerSchema(db)
      seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
      seedProfile(db, 'ordinary-27', 100_000)
      seedProfile(db, 'recipient-27', 0)
      seedFriendship(db, 'fs-27a', 'ordinary-27', 'recipient-27')
      seedFriendship(db, 'fs-27p', PIKA_BYPASS_PROFILE_ID, 'recipient-27')
      seedGiftLedger(db, 'g27-ordinary', 'fs-27a', 'ordinary-27', 'recipient-27', 30_000, utcDaysAgo(1))
      db.close()

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
      const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-27p', 1_000)
      store.close()

      assert(result.ok === false, 'Празна env стойност не трябва да bypass-ва')
      assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
    })
  })

  await check('[28] Невалиден UUID в env fail-closed: няма bypass', async () => {
    await withPikaBypassEnv('not-a-uuid', async () => {
      const dbPath = join(dir, 'test28.sqlite')
      const db = new DatabaseSync(dbPath, { open: true })
      db.exec('PRAGMA foreign_keys = ON;')
      buildBaseSchema(db)
      applyNewGiftLedgerSchema(db)
      seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
      seedProfile(db, 'ordinary-28', 100_000)
      seedProfile(db, 'recipient-28', 0)
      seedFriendship(db, 'fs-28a', 'ordinary-28', 'recipient-28')
      seedFriendship(db, 'fs-28p', PIKA_BYPASS_PROFILE_ID, 'recipient-28')
      seedGiftLedger(db, 'g28-ordinary', 'fs-28a', 'ordinary-28', 'recipient-28', 30_000, utcDaysAgo(1))
      db.close()

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
      const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-28p', 1_000)
      store.close()

      assert(result.ok === false, 'Невалиден env UUID не трябва да bypass-ва')
      assert('code' in result && result.code === 'RECIPIENT_WINDOW_LIMIT_FULL', `Очаква се FULL, но: ${JSON.stringify(result)}`)
    })
  })

  await check('[29] Exact UUID в env активира bypass', async () => {
    await withPikaBypassEnv(PIKA_BYPASS_PROFILE_ID, async () => {
      const dbPath = join(dir, 'test29.sqlite')
      const db = new DatabaseSync(dbPath, { open: true })
      db.exec('PRAGMA foreign_keys = ON;')
      buildBaseSchema(db)
      applyNewGiftLedgerSchema(db)
      seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
      seedProfile(db, 'ordinary-29', 100_000)
      seedProfile(db, 'recipient-29', 0)
      seedFriendship(db, 'fs-29a', 'ordinary-29', 'recipient-29')
      seedFriendship(db, 'fs-29p', PIKA_BYPASS_PROFILE_ID, 'recipient-29')
      seedGiftLedger(db, 'g29-ordinary', 'fs-29a', 'ordinary-29', 'recipient-29', 30_000, utcDaysAgo(1))
      db.close()

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
      const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-29p', 1_000)
      store.close()

      assert(result.ok === true, `Exact env UUID трябва да bypass-ва, но: ${JSON.stringify(result)}`)
    })
  })

  await check('[30] Pika sender с недостатъчен баланс се отказва въпреки bypass', async () => {
    const dbPath = join(dir, 'test30.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 500)
    seedProfile(db, 'ordinary-30', 100_000)
    seedProfile(db, 'recipient-30', 0)
    seedFriendship(db, 'fs-30a', 'ordinary-30', 'recipient-30')
    seedFriendship(db, 'fs-30p', PIKA_BYPASS_PROFILE_ID, 'recipient-30')
    seedGiftLedger(db, 'g30-ordinary', 'fs-30a', 'ordinary-30', 'recipient-30', 30_000, utcDaysAgo(1))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-30p', 1_000)
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    const ledgerCount = (db2.prepare(`SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger`).get() as { c: number }).c
    db2.close()

    assert(result.ok === false, 'Недостатъчен баланс трябва да отказва')
    assert(!('code' in result), 'Balance отказът не трябва да е recipient limit code')
    assertEqual(ledgerCount, 1, 'няма частичен exempt ledger ред')
  })

  await check('[31] Невалидна сума се отказва и за Pika sender', async () => {
    const dbPath = join(dir, 'test31.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'recipient-31', 0)
    seedFriendship(db, 'fs-31', PIKA_BYPASS_PROFILE_ID, 'recipient-31')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-31', 1_500)
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    const ledgerCount = (db2.prepare(`SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger`).get() as { c: number }).c
    db2.close()

    assert(result.ok === false, 'Невалидна сума трябва да се откаже')
    assert(!('code' in result), 'Невалидна сума не трябва да дава recipient limit code')
    assertEqual(ledgerCount, 0, 'без ledger ред')
  })

  await check('[32] Friendship guard остава защитен и за Pika sender', async () => {
    const dbPath = join(dir, 'test32.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'recipient-32', 0)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'missing-friendship', 1_000)
    store.close()

    assert(result.ok === false, 'Липсващо приятелство трябва да се откаже')
    assert(!('code' in result), 'Friendship guard не трябва да е recipient limit code')
  })

  await check('[33] Concurrency: exempt и ordinary gift не си пречат неправилно', async () => {
    const dbPath = join(dir, 'test33.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'ordinary-33a', 100_000)
    seedProfile(db, 'ordinary-33b', 100_000)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 100_000)
    seedProfile(db, 'recipient-33', 0)
    seedFriendship(db, 'fs-33a', 'ordinary-33a', 'recipient-33')
    seedFriendship(db, 'fs-33b', 'ordinary-33b', 'recipient-33')
    seedFriendship(db, 'fs-33p', PIKA_BYPASS_PROFILE_ID, 'recipient-33')
    seedGiftLedger(db, 'g33-pre', 'fs-33a', 'ordinary-33a', 'recipient-33', 20_000, utcDaysAgo(1))
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.close()

    const workerScript = fileURLToPath(import.meta.url)
    const results = await Promise.all([
      new Promise<WorkerResult>((resolve) => {
        const w = new Worker(workerScript, {
          workerData: {
            dbPath,
            friendshipId: 'fs-33b',
            senderProfileId: 'ordinary-33b',
            amount: 10_000,
            pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
          },
        })
        let msg: WorkerResult | null = null
        w.on('message', (m: WorkerResult) => { msg = m })
        w.on('error', (err) => resolve({ ok: false, error: String(err) }))
        w.on('exit', () => resolve(msg ?? { ok: false, error: 'Worker exited without message' }))
      }),
      new Promise<WorkerResult>((resolve) => {
        const w = new Worker(workerScript, {
          workerData: {
            dbPath,
            friendshipId: 'fs-33p',
            senderProfileId: PIKA_BYPASS_PROFILE_ID,
            amount: 30_000,
            pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
          },
        })
        let msg: WorkerResult | null = null
        w.on('message', (m: WorkerResult) => { msg = m })
        w.on('error', (err) => resolve({ ok: false, error: String(err) }))
        w.on('exit', () => resolve(msg ?? { ok: false, error: 'Worker exited without message' }))
      }),
    ])

    const db2 = new DatabaseSync(dbPath, { open: true })
    const ordinaryTotal = (db2.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM yellow_coin_gift_ledger
      WHERE recipient_profile_id = 'recipient-33'
        AND created_at > datetime('now', '-60 days')
        AND recipient_limit_exempt = 0
    `).get() as { total: number }).total
    const exemptTotal = (db2.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM yellow_coin_gift_ledger
      WHERE recipient_profile_id = 'recipient-33'
        AND recipient_limit_exempt = 1
    `).get() as { total: number }).total
    db2.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db2.close()

    for (const r of results) {
      assert(!r.error, `Worker crashна: ${String(r.error)}`)
      assert(r.ok === true, `И двата gifts трябва да минат: ${JSON.stringify(results)}`)
    }
    assertEqual(ordinaryTotal, 30_000, 'ordinary rolling sum остава точно 30 000')
    assertEqual(exemptTotal, 30_000, 'exempt gift е записан отделно')
  })

  await check('[34] Migration върху стара cascade schema добавя колоната с default 0 и flow-ът работи', async () => {
    const dbPath = join(dir, 'test34.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyOriginalGiftLedgerSchema(db)
    seedProfile(db, 'sender-34', 100_000)
    seedProfile(db, 'recipient-34', 0)
    seedFriendship(db, 'fs-34', 'sender-34', 'recipient-34')
    seedGiftLedger(db, 'g34-old', 'fs-34', 'sender-34', 'recipient-34', 5_000, utcDaysAgo(1))
    await applyMigrationFile(db, cascadeMigrationPath)
    await applyRecipientLimitExemptMigration(db)
    const oldRow = db.prepare(`SELECT recipient_limit_exempt FROM yellow_coin_gift_ledger WHERE gift_id = ?`).get('g34-old') as { recipient_limit_exempt: number }
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore())
    const result = store.sendGift('sender-34', 'fs-34', 1_000)
    store.close()

    assertEqual(oldRow.recipient_limit_exempt, 0, 'старият ред получава default 0')
    assert(result.ok === true, `Gift flow трябва да работи след migration, но: ${JSON.stringify(result)}`)
  })

  // ── [35]–[37] Pika sender единична-операция таван 100 000 (perf/limit follow-up) ──

  await check('[35] Pika sender: amount = 100 000 → приема се (нов single-операция максимум)', async () => {
    const dbPath = join(dir, 'test35.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 200_000)
    seedProfile(db, 'recipient-35', 0)
    seedFriendship(db, 'fs-35', PIKA_BYPASS_PROFILE_ID, 'recipient-35')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-35', 100_000)
    store.close()

    assert(result.ok === true, `Очаква се ok:true за Pika sender 100 000, но: ${JSON.stringify(result)}`)
  })

  await check('[36] Pika sender: amount = 100 001 → отказ (над новия максимум)', async () => {
    const dbPath = join(dir, 'test36.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 200_000)
    seedProfile(db, 'recipient-36', 0)
    seedFriendship(db, 'fs-36', PIKA_BYPASS_PROFILE_ID, 'recipient-36')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    const result = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-36', 100_001)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за Pika sender 100 001')
    assert(!('code' in result), 'Невалидна сума не трябва да дава limit code')
    assertEqual(
      (result as { message: string }).message,
      'Сумата трябва да е между 1 000 и 100 000 жълтици.',
      'message [36]',
    )
  })

  await check('[37] Pika sender: нормален подарък (30 000, над стария лимит) веднага след предходна операция', async () => {
    const dbPath = join(dir, 'test37.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, PIKA_BYPASS_PROFILE_ID, 200_000)
    seedProfile(db, 'recipient-37a', 0)
    seedProfile(db, 'recipient-37b', 0)
    seedFriendship(db, 'fs-37a', PIKA_BYPASS_PROFILE_ID, 'recipient-37a')
    seedFriendship(db, 'fs-37b', PIKA_BYPASS_PROFILE_ID, 'recipient-37b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), {
      pikaTeamGiftBypassProfileId: PIKA_BYPASS_PROFILE_ID,
    })
    // Първа операция: 100 000 (новия максимум) към recipient-37a.
    const first = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-37a', 100_000)
    // Веднага след това — второ, нормално подаряване (30 000, над СТАРИЯ
    // single-операция лимит) към ДРУГ получател — трябва да е разрешено
    // веднага, без изчакване (изискване: "да остане възможно след това да
    // се направи ново подаряване", без нов daily/hourly/aggregate лимит
    // отвъд вече съществуващия recipient-window bypass).
    const second = store.sendGift(PIKA_BYPASS_PROFILE_ID, 'fs-37b', 30_000)
    store.close()

    assert(first.ok === true, `Първата операция (100 000) трябва да мине, но: ${JSON.stringify(first)}`)
    assert(second.ok === true, `Веднага следващата операция (30 000, нов получател) трябва да мине, но: ${JSON.stringify(second)}`)
  })
})

// ─── Финален резултат ───────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}

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
import type { AdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createYellowCoinGiftStore } from '../src/db/yellowCoinGiftStore.js'

// Съвпада с production DEFAULT_SETTINGS.pikaTeamDailyGiftLimit / migration
// seed (adminSettingsStore.ts, 200 000) — единствен консистентен default,
// не независима тестова стойност. Повечето тестове тук explicit подават
// собствен лимит; този default важи само за тестове, за които pika_team
// daily лимитът е ирелевантен (recipient window, legacy sender rolling-24h
// и т.н.).
const DEFAULT_MOCK_PIKA_TEAM_DAILY_GIFT_LIMIT = 200_000

// Минимален stub за AdminSettingsStore — само getSettings().pikaTeamDailyGiftLimit
// се ползва от sendGiftCore §4.5 (виж yellowCoinGiftStore.ts).
function makeMockAdminSettingsStore(
  pikaTeamDailyGiftLimit: number = DEFAULT_MOCK_PIKA_TEAM_DAILY_GIFT_LIMIT,
): AdminSettingsStore {
  return {
    getSettings: () => ({
      signupBonusYellowCoins: 100_000,
      profileNameChangePrice: 50_000,
      vipPrice30DaysCents: 789,
      vipPrice180DaysCents: 3_989,
      vipPrice365DaysCents: 6_989,
      pikaTeamDailyGiftLimit,
    }),
  } as unknown as AdminSettingsStore
}

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
  const {
    dbPath,
    friendshipId,
    senderProfileId,
    amount,
    pikaTeamGiftBypassProfileId,
    isRoleBasedPikaTeamSender,
    pikaTeamDailyGiftLimit,
  } = workerData as {
    dbPath: string
    friendshipId: string
    senderProfileId: string
    amount: number
    pikaTeamGiftBypassProfileId?: string | null
    isRoleBasedPikaTeamSender?: boolean
    pikaTeamDailyGiftLimit?: number
  }

  let store: Awaited<ReturnType<typeof createYellowCoinGiftStore>> | null = null
  try {
    store = await createYellowCoinGiftStore(
      dbPath,
      makeMockProgressStore(),
      makeMockAdminSettingsStore(pikaTeamDailyGiftLimit),
      { pikaTeamGiftBypassProfileId },
    )
    const result = store.sendGift(senderProfileId, friendshipId, amount, isRoleBasedPikaTeamSender ?? false)
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

// Пуска sendGift в отделен worker thread (за истински concurrency race теста
// [51]) — mirror на inline worker извикванията при [14]/[33] по-горе, но
// параметризиран за pika_team role-based теста (isRoleBasedPikaTeamSender +
// pikaTeamDailyGiftLimit подадени explicit през workerData).
function runGiftInWorker(
  dbPath: string,
  friendshipId: string,
  senderProfileId: string,
  amount: number,
  pikaTeamGiftBypassProfileId: string | null,
  isRoleBasedPikaTeamSender: boolean,
  pikaTeamDailyGiftLimit: number = 100_000,
): Promise<WorkerResult> {
  const workerScript = fileURLToPath(import.meta.url)
  return new Promise<WorkerResult>((resolve) => {
    const w = new Worker(workerScript, {
      workerData: {
        dbPath,
        friendshipId,
        senderProfileId,
        amount,
        pikaTeamGiftBypassProfileId,
        isRoleBasedPikaTeamSender,
        pikaTeamDailyGiftLimit,
      },
    })
    let msg: WorkerResult | null = null
    w.on('message', (m: WorkerResult) => { msg = m })
    w.on('error', (err) => resolve({ ok: false, error: String(err) }))
    w.on('exit', () => resolve(msg ?? { ok: false, error: 'Worker exited without message' }))
  })
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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
    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

      const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(), {
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

  // ── [60]-[68] role='admin' unlimited gifting bypass ─────────────────────
  // isRoleBasedAdminSender се подава explicit true (5-ти позиционен аргумент
  // на sendGift), симулирайки route caller-а с
  // isAdminGiftUnlimitedSession(session)===true (index.ts). Проверява
  // задачата: admin bypass-ва max amount/step/min, sender daily лимит и
  // recipient 60-дневен window лимит, но НЕ баланс/positive-integer/recipient
  // проверките.

  await check('[60] admin sender: amount = 30 001 (над стандартния 30 000 max) → приема се', async () => {
    const dbPath = join(dir, 'test60.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-60', 1_000_000)
    seedProfile(db, 'recipient-60', 0)
    seedFriendship(db, 'fs-60', 'admin-60', 'recipient-60')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-60', 'fs-60', 30_001, false, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true, но: ${JSON.stringify(result)}`)
  })

  await check('[61] admin sender: amount = 100 001 (над pika_team-овия 100 000 max) → приема се при достатъчен баланс', async () => {
    const dbPath = join(dir, 'test61.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-61', 1_000_000)
    seedProfile(db, 'recipient-61', 0)
    seedFriendship(db, 'fs-61', 'admin-61', 'recipient-61')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-61', 'fs-61', 100_001, false, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true, но: ${JSON.stringify(result)}`)
  })

  await check('[62] admin sender: recipient вече достигнал стандартния 60-дневен 30 000 cap → приема се', async () => {
    const dbPath = join(dir, 'test62.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-62', 1_000_000)
    seedProfile(db, 'recipient-62', 0)
    seedFriendship(db, 'fs-62', 'admin-62', 'recipient-62')
    // recipient-62 вече е на максимума от друг sender
    seedGiftLedger(db, 'g62-pre', 'fs-62', 'admin-62', 'recipient-62', 30_000, utcDaysAgo(5))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-62', 'fs-62', 5_000, false, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true (admin bypass-ва recipient window), но: ${JSON.stringify(result)}`)
  })

  await check('[63] admin sender: няма daily gifting cap (над стандартния 200 000 rolling-24h)', async () => {
    const dbPath = join(dir, 'test63.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-63', 10_000_000)
    seedProfile(db, 'recipient-63', 0)
    seedFriendship(db, 'fs-63', 'admin-63', 'recipient-63')
    // 195 000 вече изпратени преди 1 час — над обикновения sender rolling лимит
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
    seedGiftLedger(db, 'g63-sent', 'fs-63', 'admin-63', 'recipient-63', 195_000, oneHourAgo, 1)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    // 195 000 + 50 000 = 245 000 > 200 000 — за normal/pika_team sender това би отказало
    const result = store.sendGift('admin-63', 'fs-63', 50_000, false, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true (admin няма daily cap), но: ${JSON.stringify(result)}`)
  })

  await check('[64] admin sender: insufficient balance → отказ', async () => {
    const dbPath = join(dir, 'test64.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-64', 500)
    seedProfile(db, 'recipient-64', 0)
    seedFriendship(db, 'fs-64', 'admin-64', 'recipient-64')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-64', 'fs-64', 1_000, false, true)
    store.close()

    assert(result.ok === false, 'Очаква се отказ поради недостатъчен баланс')
    assert(
      'message' in result && (result as { message: string }).message.includes('достатъчно жълтици'),
      `Съобщение: ${JSON.stringify(result)}`,
    )
  })

  await check('[65] admin sender: amount = 0 → отказ', async () => {
    const dbPath = join(dir, 'test65.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-65', 1_000_000)
    seedProfile(db, 'recipient-65', 0)
    seedFriendship(db, 'fs-65', 'admin-65', 'recipient-65')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-65', 'fs-65', 0, false, true)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за amount = 0')
    assert(!('code' in result), 'Невалидна сума не трябва да дава limit code')
  })

  await check('[66] admin sender: amount = -5 (отрицателна) → отказ', async () => {
    const dbPath = join(dir, 'test66.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-66', 1_000_000)
    seedProfile(db, 'recipient-66', 0)
    seedFriendship(db, 'fs-66', 'admin-66', 'recipient-66')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-66', 'fs-66', -5, false, true)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за отрицателна сума')
  })

  await check('[67] admin sender: amount = 1 (некратно на 1 000, под старите MIN 1 000) → приема се', async () => {
    const dbPath = join(dir, 'test67.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-67', 1_000_000)
    seedProfile(db, 'recipient-67', 0)
    seedFriendship(db, 'fs-67', 'admin-67', 'recipient-67')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('admin-67', 'fs-67', 1, false, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true (всяко положително цяло число), но: ${JSON.stringify(result)}`)
  })

  await check('[68] normal player sender: amount = 30 001 остава BLOCK (admin bypass-ът не разширява други роли)', async () => {
    const dbPath = join(dir, 'test68.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'player-68', 1_000_000)
    seedProfile(db, 'recipient-68', 0)
    seedFriendship(db, 'fs-68', 'player-68', 'recipient-68')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('player-68', 'fs-68', 30_001)
    store.close()

    assert(result.ok === false, 'Очаква се отказ за обикновен player над 30 000')
    assertEqual(
      (result as { message: string }).message,
      'Сумата трябва да е между 1 000 и 30 000 жълтици.',
      'message [68]',
    )
  })

  // ── pika_team календарен-ден (Europe/Sofia) дневен лимит ────────────────
  // Отделни тестове от §12/§35-37 по-горе — тук isRoleBasedPikaTeamSender се
  // подава explicit true (4-ти позиционен аргумент на sendGift), симулирайки
  // route caller-а с isPikaTeamGiftMaxAmountSession(session)===true. Легacy
  // pikaTeamGiftBypassProfileId (§35-37) НЕ участва тук — role-based пътят е
  // независим механизъм (виж yellowCoinGiftStore.ts §4.5 коментара).

  await check('[38] pika_team sender: сума под дневния лимит се приема', async () => {
    const dbPath = join(dir, 'test38.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-38', 1_000_000)
    seedProfile(db, 'recipient-38', 0)
    seedFriendship(db, 'fs-38', 'pika-38', 'recipient-38')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const result = store.sendGift('pika-38', 'fs-38', 30_000, true)
    store.close()

    assert(result.ok === true, `Очаква се ok:true, но: ${JSON.stringify(result)}`)
  })

  await check('[39] pika_team sender: точно достигане на лимита е позволено', async () => {
    const dbPath = join(dir, 'test39.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-39', 1_000_000)
    seedProfile(db, 'recipient-39a', 0)
    seedProfile(db, 'recipient-39b', 0)
    seedFriendship(db, 'fs-39a', 'pika-39', 'recipient-39a')
    seedFriendship(db, 'fs-39b', 'pika-39', 'recipient-39b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const first = store.sendGift('pika-39', 'fs-39a', 80_000, true)
    const second = store.sendGift('pika-39', 'fs-39b', 20_000, true)
    store.close()

    assert(first.ok === true, `80 000 трябва да мине, но: ${JSON.stringify(first)}`)
    assert(second.ok === true, `Точно 20 000 (limit-used) трябва да мине, но: ${JSON.stringify(second)}`)
  })

  await check('[40] pika_team sender: следващият gift след достигане на лимита е отказан', async () => {
    const dbPath = join(dir, 'test40.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-40', 1_000_000)
    seedProfile(db, 'recipient-40a', 0)
    seedProfile(db, 'recipient-40b', 0)
    seedFriendship(db, 'fs-40a', 'pika-40', 'recipient-40a')
    seedFriendship(db, 'fs-40b', 'pika-40', 'recipient-40b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const first = store.sendGift('pika-40', 'fs-40a', 100_000, true)
    const second = store.sendGift('pika-40', 'fs-40b', 1_000, true)
    store.close()

    assert(first.ok === true, `Първите 100 000 трябва да минат, но: ${JSON.stringify(first)}`)
    assert(second.ok === false, 'Следващият gift след достигане на лимита трябва да е отказан')
    assertEqual(
      (second as { code: string }).code,
      'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED',
      'code [40]',
    )
    assertEqual((second as { remaining: number }).remaining, 0, 'remaining [40]')
  })

  await check('[41] pika_team sender: gift, който би надвишил remaining частично, се отказва изцяло', async () => {
    const dbPath = join(dir, 'test41.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-41', 1_000_000)
    seedProfile(db, 'recipient-41a', 0)
    seedProfile(db, 'recipient-41b', 0)
    seedFriendship(db, 'fs-41a', 'pika-41', 'recipient-41a')
    seedFriendship(db, 'fs-41b', 'pika-41', 'recipient-41b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const first = store.sendGift('pika-41', 'fs-41a', 80_000, true)
    // remaining = 20 000, опит за 21 000 → пълен отказ, не partial 20 000.
    const second = store.sendGift('pika-41', 'fs-41b', 21_000, true)
    store.close()

    assert(first.ok === true, `80 000 трябва да мине, но: ${JSON.stringify(first)}`)
    assert(second.ok === false, '21 000 (над remaining 20 000) трябва да се отказва изцяло')
    assertEqual((second as { code: string }).code, 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED', 'code [41]')
    assertEqual((second as { remaining: number }).remaining, 20_000, 'remaining [41]')

    const balanceDb = new DatabaseSync(dbPath, { open: true })
    const balanceRow = (balanceDb.prepare(
      'SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?',
    ).get('pika-41') as { yellow_coins_balance: number } | undefined)?.yellow_coins_balance
    balanceDb.close()
    assertEqual(balanceRow, 920_000, 'sender balance не трябва да намалее при отказан gift [41]')
  })

  await check('[42] Два различни pika_team profiles имат независими дневни лимити', async () => {
    const dbPath = join(dir, 'test42.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-42a', 1_000_000)
    seedProfile(db, 'pika-42b', 1_000_000)
    seedProfile(db, 'recipient-42a', 0)
    seedProfile(db, 'recipient-42b', 0)
    seedFriendship(db, 'fs-42a', 'pika-42a', 'recipient-42a')
    seedFriendship(db, 'fs-42b', 'pika-42b', 'recipient-42b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const firstA = store.sendGift('pika-42a', 'fs-42a', 100_000, true)
    // pika-42a изчерпа лимита си — pika-42b трябва да остане с пълен 100 000.
    const firstB = store.sendGift('pika-42b', 'fs-42b', 100_000, true)
    store.close()

    assert(firstA.ok === true, `pika-42a 100 000 трябва да мине, но: ${JSON.stringify(firstA)}`)
    assert(firstB.ok === true, `pika-42b 100 000 (независим лимит) трябва да мине, но: ${JSON.stringify(firstB)}`)
  })

  await check('[43] Gift от предишния календарен ден (Europe/Sofia) НЕ участва в днешния used', async () => {
    const dbPath = join(dir, 'test43.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-43', 1_000_000)
    seedProfile(db, 'recipient-43a', 0)
    seedProfile(db, 'recipient-43b', 0)
    seedFriendship(db, 'fs-43a', 'pika-43', 'recipient-43a')
    seedFriendship(db, 'fs-43b', 'pika-43', 'recipient-43b')
    // Ledger ред от преди 48 часа (гарантирано преди днешната Sofia полунощ,
    // независимо от текущия момент/timezone на теста — 24ч назад НЕ е
    // достатъчно, защото Sofia day boundary може да падне произволно спрямо
    // "сега") — не трябва да участва в днешния used.
    seedGiftLedger(db, 'gift-43-old', 'fs-43a', 'pika-43', 'recipient-43a', 100_000, utcDaysAgo(2))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    // Ако вчерашният gift грешно се броеше, remaining би бил 0 и това би
    // отказало — очакваме ok:true, значи used=0 за днешния Sofia ден.
    const result = store.sendGift('pika-43', 'fs-43b', 100_000, true)
    store.close()

    assert(result.ok === true, `Вчерашен gift не трябва да намалява днешния лимит, но: ${JSON.stringify(result)}`)
  })

  await check('[44] Failed/rejected gift не се брои в дневния used', async () => {
    const dbPath = join(dir, 'test44.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-44', 1_000)
    seedProfile(db, 'recipient-44a', 0)
    seedProfile(db, 'recipient-44b', 0)
    seedFriendship(db, 'fs-44a', 'pika-44', 'recipient-44a')
    seedFriendship(db, 'fs-44b', 'pika-44', 'recipient-44b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    // Опит за 100 000 с баланс само 1 000 → insufficient balance, failed
    // (не достига до ledger insert), не трябва да участва в used.
    const failedAttempt = store.sendGift('pika-44', 'fs-44a', 100_000, true)
    const status = store.getPikaTeamDailyGiftLimitStatus('pika-44')
    store.close()

    assert(failedAttempt.ok === false, 'Insufficient balance трябва да откаже gift-а')
    assertEqual(status.used, 0, 'Failed gift не трябва да е добавен към used [44]')
    assertEqual(status.remaining, 100_000, 'remaining трябва да остане пълен [44]')
  })

  await check('[45] Друг economy transaction type (не gift) не се брои в pika_team дневния лимит', async () => {
    const dbPath = join(dir, 'test45.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-45', 1_000_000)
    seedProfile(db, 'recipient-45', 0)
    seedFriendship(db, 'fs-45', 'pika-45', 'recipient-45')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const status = store.getPikaTeamDailyGiftLimitStatus('pika-45')
    store.close()

    // yellow_coin_gift_ledger съдържа само gift операции по конструкция
    // (различните economy типове имат собствени ledger таблици — виж
    // match_economy_ledger, coin_purchase_ledger и т.н., виж CLAUDE.md
    // инспекцията) — used трябва да е 0 без seed-нат gift ред.
    assertEqual(status.used, 0, 'used трябва да е 0 без gift ledger редове [45]')
  })

  await check('[46] Gift от друг pika_team sender не се брои към текущия', async () => {
    const dbPath = join(dir, 'test46.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-46a', 1_000_000)
    seedProfile(db, 'pika-46b', 1_000_000)
    seedProfile(db, 'recipient-46', 0)
    seedFriendship(db, 'fs-46a', 'pika-46a', 'recipient-46')
    seedFriendship(db, 'fs-46b', 'pika-46b', 'recipient-46')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    store.sendGift('pika-46a', 'fs-46a', 100_000, true)
    const statusB = store.getPikaTeamDailyGiftLimitStatus('pika-46b')
    store.close()

    assertEqual(statusB.used, 0, 'pika-46a-ият gift не трябва да участва в pika-46b used [46]')
    assertEqual(statusB.remaining, 100_000, 'pika-46b remaining трябва да остане пълен [46]')
  })

  await check('[47] admin (role=admin) не е ограничен от pika_team дневния лимит', async () => {
    const dbPath = join(dir, 'test47.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'admin-47', 100_000)
    seedProfile(db, 'recipient-47', 0)
    seedFriendship(db, 'fs-47', 'admin-47', 'recipient-47')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(0))
    // isRoleBasedPikaTeamSender=false (route би подал false за role='admin')
    // — лимит 0 не важи, обикновеният MAX_GIFT_AMOUNT (30 000) важи.
    const result = store.sendGift('admin-47', 'fs-47', 30_000, false)
    store.close()

    assert(result.ok === true, `admin не трябва да е ограничен от pika_team лимита, но: ${JSON.stringify(result)}`)
  })

  await check('[48] limit = 0 блокира gift от pika_team', async () => {
    const dbPath = join(dir, 'test48.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-48', 1_000_000)
    seedProfile(db, 'recipient-48', 0)
    seedFriendship(db, 'fs-48', 'pika-48', 'recipient-48')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(0))
    const result = store.sendGift('pika-48', 'fs-48', 1_000, true)
    store.close()

    assert(result.ok === false, 'limit=0 трябва да блокира всеки pika_team gift')
    assertEqual((result as { code: string }).code, 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED', 'code [48]')
    assertEqual((result as { limit: number }).limit, 0, 'limit [48]')
  })

  await check('[49] Намаляване на лимита влиза в сила веднага (нов store instance = fresh admin settings read)', async () => {
    const dbPath = join(dir, 'test49.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-49', 1_000_000)
    seedProfile(db, 'recipient-49a', 0)
    seedProfile(db, 'recipient-49b', 0)
    seedFriendship(db, 'fs-49a', 'pika-49', 'recipient-49a')
    seedFriendship(db, 'fs-49b', 'pika-49', 'recipient-49b')
    db.close()

    const storeHigh = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const first = storeHigh.sendGift('pika-49', 'fs-49a', 80_000, true)
    storeHigh.close()

    // Admin намалява лимита на 80 000 — used вече е 80 000, remaining=0.
    const storeLow = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(80_000))
    const second = storeLow.sendGift('pika-49', 'fs-49b', 1_000, true)
    storeLow.close()

    assert(first.ok === true, `Първите 80 000 трябва да минат, но: ${JSON.stringify(first)}`)
    assert(second.ok === false, 'Намаленият лимит трябва да важи веднага')
    assertEqual((second as { remaining: number }).remaining, 0, 'remaining [49]')
  })

  await check('[50] Увеличаване на лимита влиза в сила веднага', async () => {
    const dbPath = join(dir, 'test50.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-50', 1_000_000)
    seedProfile(db, 'recipient-50a', 0)
    seedProfile(db, 'recipient-50b', 0)
    seedFriendship(db, 'fs-50a', 'pika-50', 'recipient-50a')
    seedFriendship(db, 'fs-50b', 'pika-50', 'recipient-50b')
    db.close()

    const storeLow = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(80_000))
    const first = storeLow.sendGift('pika-50', 'fs-50a', 80_000, true)
    storeLow.close()

    // Admin увеличава лимита на 100 000 — remaining веднага става 20 000.
    const storeHigh = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const second = storeHigh.sendGift('pika-50', 'fs-50b', 20_000, true)
    storeHigh.close()

    assert(first.ok === true, `Първите 80 000 трябва да минат, но: ${JSON.stringify(first)}`)
    assert(second.ok === true, `Увеличеният лимит трябва да важи веднага, но: ${JSON.stringify(second)}`)
  })

  await check('[51] Concurrent requests не могат заедно да надвишат дневния лимит', async () => {
    const dbPath = join(dir, 'test51.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-51', 1_000_000)
    seedProfile(db, 'recipient-51a', 0)
    seedProfile(db, 'recipient-51b', 0)
    seedFriendship(db, 'fs-51a', 'pika-51', 'recipient-51a')
    seedFriendship(db, 'fs-51b', 'pika-51', 'recipient-51b')
    db.close()

    const results = await Promise.all([
      runGiftInWorker(dbPath, 'fs-51a', 'pika-51', 80_000, null, true),
      runGiftInWorker(dbPath, 'fs-51b', 'pika-51', 80_000, null, true),
    ])

    const successCount = results.filter((r) => r.ok).length
    const totalSuccessAmount = results
      .filter((r) => r.ok)
      .reduce((sum) => sum + 80_000, 0)

    assert(successCount === 1, `Очаква се точно 1 успешен от 2те 80 000 заявки (limit=100 000), но: ${JSON.stringify(results)}`)
    assert(totalSuccessAmount <= 100_000, 'Общата успешна сума не трябва да надвишава лимита')
  })

  await check('[52] Server restart не влияе на дневния used (persistent ledger source of truth)', async () => {
    const dbPath = join(dir, 'test52.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-52', 1_000_000)
    seedProfile(db, 'recipient-52', 0)
    seedFriendship(db, 'fs-52', 'pika-52', 'recipient-52')
    db.close()

    const store1 = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    store1.sendGift('pika-52', 'fs-52', 60_000, true)
    store1.close()

    // Симулира server restart — нов store instance върху СЪЩИЯ dbPath.
    const store2 = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(100_000))
    const status = store2.getPikaTeamDailyGiftLimitStatus('pika-52')
    store2.close()

    assert(status.used === 60_000, `used трябва да остане 60 000 след 'restart', но: ${JSON.stringify(status)}`)
  })

  // ── Взаимодействие между стария rolling-24h DAILY_GIFT_LIMIT (200 000, за
  // всички sender-и) и новия pika_team calendar-day лимит — регресионни
  // тестове за конкретния конфликт: §4 (стар) преди корекцията се
  // изпълняваше безусловно и спираше pika_team при 200 000 rolling-24h,
  // независимо от configured pikaTeamDailyGiftLimit. §4 сега explicit
  // skip-ва isRoleBasedPikaTeamSender (виж yellowCoinGiftStore.ts коментара).

  await check('[53] normal player все още се блокира от стария 200 000 rolling-24h sender limit', async () => {
    const dbPath = join(dir, 'test53.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'player-53', 1_000_000)
    seedProfile(db, 'recipient-53a', 0)
    seedProfile(db, 'recipient-53b', 0)
    seedProfile(db, 'recipient-53c', 0)
    seedProfile(db, 'recipient-53d', 0)
    seedProfile(db, 'recipient-53e', 0)
    seedProfile(db, 'recipient-53f', 0)
    seedProfile(db, 'recipient-53g', 0)
    seedFriendship(db, 'fs-53a', 'player-53', 'recipient-53a')
    seedFriendship(db, 'fs-53b', 'player-53', 'recipient-53b')
    seedFriendship(db, 'fs-53c', 'player-53', 'recipient-53c')
    seedFriendship(db, 'fs-53d', 'player-53', 'recipient-53d')
    seedFriendship(db, 'fs-53e', 'player-53', 'recipient-53e')
    seedFriendship(db, 'fs-53f', 'player-53', 'recipient-53f')
    seedFriendship(db, 'fs-53g', 'player-53', 'recipient-53g')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(1_000_000))
    // Нормален player (isRoleBasedPikaTeamSender=false, default): 6× 30 000
    // = 180 000, после опит за 30 000 → общо 210 000 > 200 000, отказ.
    const gifts = [
      store.sendGift('player-53', 'fs-53a', 30_000),
      store.sendGift('player-53', 'fs-53b', 30_000),
      store.sendGift('player-53', 'fs-53c', 30_000),
      store.sendGift('player-53', 'fs-53d', 30_000),
      store.sendGift('player-53', 'fs-53e', 30_000),
      store.sendGift('player-53', 'fs-53f', 30_000),
    ]
    const overflow = store.sendGift('player-53', 'fs-53g', 30_000)
    store.close()

    assert(gifts.every((g) => g.ok === true), `Първите 6× 30 000 (180 000) трябва да минат, но: ${JSON.stringify(gifts)}`)
    assert(overflow.ok === false, 'normal player трябва да се блокира от стария 200 000 rolling-24h limit')
    assert(!('code' in overflow), 'Стария DAILY_GIFT_LIMIT отказ няма code поле')
    assertEqual(
      (overflow as { message: string }).message,
      `Дневният лимит за подаръци е ${200_000} жълтици.`,
      'message [53]',
    )
  })

  await check('[54] pika_team с daily limit 1 000 000 подарява успешно над 200 000 в същия календарен ден', async () => {
    const dbPath = join(dir, 'test54.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-54', 2_000_000)
    for (let i = 0; i < 8; i++) {
      seedProfile(db, `recipient-54-${i}`, 0)
      seedFriendship(db, `fs-54-${i}`, 'pika-54', `recipient-54-${i}`)
    }
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(1_000_000))
    // 8× 100 000 (max single-операция за pika_team) = 800 000, явно над
    // старите 200 000 rolling-24h, но под новия 1 000 000 calendar-day лимит.
    const results: Array<ReturnType<typeof store.sendGift>> = []
    for (let i = 0; i < 8; i++) {
      results.push(store.sendGift('pika-54', `fs-54-${i}`, 100_000, true))
    }
    store.close()

    assert(
      results.every((r) => r.ok === true),
      `Всичките 8× 100 000 (800 000 общо, над старите 200 000) трябва да минат за pika_team, но: ${JSON.stringify(results)}`,
    )
  })

  await check('[55] pika_team се блокира точно при новия configurable daily limit, не при старите 200 000', async () => {
    const dbPath = join(dir, 'test55.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-55', 2_000_000)
    for (let i = 0; i < 11; i++) {
      seedProfile(db, `recipient-55-${i}`, 0)
      seedFriendship(db, `fs-55-${i}`, 'pika-55', `recipient-55-${i}`)
    }
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(1_000_000))
    // 10× 100 000 = 1 000 000 (точно на новия лимит) — всички трябва да минат
    // (280 000ти надолу вече е над старите 200 000, доказвайки, че старият
    // rolling-24h не спира pika_team). После 11-ти опит за 1 000 → отказ с
    // PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED, не с стария generic съобщение.
    const results: Array<ReturnType<typeof store.sendGift>> = []
    for (let i = 0; i < 10; i++) {
      results.push(store.sendGift('pika-55', `fs-55-${i}`, 100_000, true))
    }
    const overflow = store.sendGift('pika-55', 'fs-55-10', 1_000, true)
    store.close()

    assert(
      results.every((r) => r.ok === true),
      `10× 100 000 = 1 000 000 (точно на новия лимит) трябва да мине, но: ${JSON.stringify(results)}`,
    )
    assert(overflow.ok === false, 'Опит след достигане на новия лимит трябва да се отказва')
    assertEqual(
      (overflow as { code: string }).code,
      'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED',
      'code [55] — трябва да е новия pika_team код, не стария generic DAILY_GIFT_LIMIT отказ',
    )
    assertEqual((overflow as { remaining: number }).remaining, 0, 'remaining [55]')
  })

  await check('[56] Промяна на pika_team daily limit не променя лимита на normal player (200 000 непроменен)', async () => {
    const dbPath = join(dir, 'test56.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'player-56', 1_000_000)
    for (let i = 0; i < 7; i++) {
      seedProfile(db, `recipient-56-${i}`, 0)
      seedFriendship(db, `fs-56-${i}`, 'player-56', `recipient-56-${i}`)
    }
    db.close()

    // Admin вдига pikaTeamDailyGiftLimit драстично на 5 000 000 — normal
    // player (isRoleBasedPikaTeamSender=false) не трябва да усети разлика,
    // все още спрян на стария 200 000.
    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(5_000_000))
    const gifts = [
      store.sendGift('player-56', 'fs-56-0', 30_000),
      store.sendGift('player-56', 'fs-56-1', 30_000),
      store.sendGift('player-56', 'fs-56-2', 30_000),
      store.sendGift('player-56', 'fs-56-3', 30_000),
      store.sendGift('player-56', 'fs-56-4', 30_000),
      store.sendGift('player-56', 'fs-56-5', 30_000),
    ]
    const overflow = store.sendGift('player-56', 'fs-56-6', 30_000)
    store.close()

    assert(gifts.every((g) => g.ok === true), `Първите 180 000 трябва да минат, но: ${JSON.stringify(gifts)}`)
    assert(overflow.ok === false, 'normal player все още трябва да е спрян на стария 200 000, независимо от pikaTeamDailyGiftLimit=5 000 000')
    assert(!('code' in overflow), 'Все още стария generic DAILY_GIFT_LIMIT отказ (без code)')
  })

  await check('[57] pika_team calendar-day reset в 00:00 Europe/Sofia работи и след §4 skip-корекцията', async () => {
    const dbPath = join(dir, 'test57.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    seedProfile(db, 'pika-57', 1_000_000)
    seedProfile(db, 'recipient-57a', 0)
    seedProfile(db, 'recipient-57b', 0)
    seedProfile(db, 'recipient-57c', 0)
    seedFriendship(db, 'fs-57a', 'pika-57', 'recipient-57a')
    seedFriendship(db, 'fs-57b', 'pika-57', 'recipient-57b')
    seedFriendship(db, 'fs-57c', 'pika-57', 'recipient-57c')
    // "Вчерашен" gift (48ч назад, гарантирано преди днешната Sofia полунощ)
    // от 100 000 — под стария rolling-24h WOULD-BE прозорец (24ч), но и без
    // значение вече, тъй като §4 изцяло се skip-ва за pika_team. Проверява,
    // че calendar-day reset-ът остава коректен и не се бърка с §4 24h logic.
    seedGiftLedger(db, 'gift-57-old', 'fs-57a', 'pika-57', 'recipient-57a', 100_000, utcDaysAgo(2))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(150_000))
    // Ако вчерашният gift грешно участваше (независимо дали през §4 или
    // §4.5), сборът 100 000 (вчера) + 100 000 (днес) + 50 000 (днес) би
    // надвишил limit=150 000 при третия опит. Две операции (не една 150 000
    // — над MAX_GIFT_AMOUNT_PIKA_TEAM_SENDER=100 000 single-операция таван)
    // сумиращи точно до 150 000 днес. Очакваме и двете ok:true — used за
    // днешния Sofia ден стартира от 0, вчерашният gift не участва.
    const first = store.sendGift('pika-57', 'fs-57b', 100_000, true)
    const second = store.sendGift('pika-57', 'fs-57c', 50_000, true)
    const status = store.getPikaTeamDailyGiftLimitStatus('pika-57')
    store.close()

    assert(first.ok === true, `Днешен gift 100 000 трябва да мине, вчерашния 100 000 не участва: ${JSON.stringify(first)}`)
    assert(second.ok === true, `Днешен gift 50 000 (общо 150 000 = limit) трябва да мине: ${JSON.stringify(second)}`)
    assertEqual(status.used, 150_000, 'used след двата today gift-а трябва да е точно 150 000 [57]')
    assertEqual(status.remaining, 0, 'remaining [57]')
  })

  await check('[58] End-to-end (реален adminSettingsStore, не mock): fresh DB effective limit = 200 000, admin update веднага ефективен', async () => {
    const dbPath = join(dir, 'test58.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    seedProfile(db, 'pika-58', 2_000_000)
    // fs-58-0..2 се ползват за fresh-DB default проверката, fs-58-3..8 за
    // update-веднага-ефективен проверката по-долу — 9 recipients общо.
    for (let i = 0; i < 9; i++) {
      seedProfile(db, `recipient-58-${i}`, 0)
      seedFriendship(db, `fs-58-${i}`, 'pika-58', `recipient-58-${i}`)
    }
    db.close()

    // Реален adminSettingsStore (не makeMockAdminSettingsStore) — без нито
    // едно updateSettings извикване, значи fresh/default стойност. Conservative
    // rollout изискване: fresh DB не трябва автоматично да разреши повече от
    // legacy 200 000 sender rolling-24h лимита само защото функционалността е
    // deploy-ната.
    const adminSettingsStore = await createAdminSettingsStore(dbPath)
    const giftStore1 = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)

    // 2× 100 000 = 200 000 (точно на default лимита) трябва да мине.
    const withinDefault = [
      giftStore1.sendGift('pika-58', 'fs-58-0', 100_000, true),
      giftStore1.sendGift('pika-58', 'fs-58-1', 100_000, true),
    ]
    // 3-ти опит за 1 000 (над default 200 000) трябва да се отказва.
    const overDefault = giftStore1.sendGift('pika-58', 'fs-58-2', 1_000, true)
    giftStore1.close()

    assert(
      withinDefault.every((r) => r.ok === true),
      `2× 100 000 (общо 200 000, default limit) трябва да мине: ${JSON.stringify(withinDefault)}`,
    )
    assert(overDefault.ok === false, 'Опит над default 200 000 (fresh DB, без admin update) трябва да се отказва')
    assertEqual(
      (overDefault as { code: string }).code,
      'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED',
      'code [58] fresh DB отказ',
    )
    assertEqual((overDefault as { limit: number }).limit, 200_000, 'limit [58] трябва да е точно default-a 200 000')

    // Admin увеличава лимита на 1 000 000 — веднага ефективен, без restart
    // (нов store instance върху СЪЩИЯ adminSettingsStore/dbPath, mirror на
    // "промяна влиза в сила веднага" изискването).
    const updateResult = adminSettingsStore.updateSettings({ pikaTeamDailyGiftLimit: 1_000_000 })
    assert(updateResult.ok === true, `Admin update трябва да успее: ${JSON.stringify(updateResult)}`)

    const giftStore2 = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)
    // used вече е 200 000 (от преди) — remaining спрямо новия 1 000 000
    // лимит е 800 000. Изпращаме допълнителни 6× 100 000 = 600 000, всички
    // трябва да минат (общо used става 800 000, все още под 1 000 000).
    const results: Array<ReturnType<typeof giftStore2.sendGift>> = []
    for (let i = 3; i < 9; i++) {
      results.push(giftStore2.sendGift('pika-58', `fs-58-${i}`, 100_000, true))
    }
    const status = giftStore2.getPikaTeamDailyGiftLimitStatus('pika-58')
    giftStore2.close()
    adminSettingsStore.close()

    assert(
      results.every((r) => r.ok === true),
      `Допълнителни 600 000 (общо 800 000, под новия 1 000 000 лимит) трябва да минат веднага след admin update: ${JSON.stringify(results)}`,
    )
    assertEqual(status.limit, 1_000_000, 'limit [58] след update трябва да е 1 000 000')
    assertEqual(status.used, 800_000, 'used [58] след update трябва да е 800 000 (200 000 преди + 600 000 след)')
  })

  await check('[59] SAME store instance (без recreate/restart): admin update влиза в сила веднага в рамките на same calendar day', async () => {
    const dbPath = join(dir, 'test59.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyNewGiftLedgerSchema(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    seedProfile(db, 'pika-59', 3_000_000)
    for (let i = 0; i < 12; i++) {
      seedProfile(db, `recipient-59-${i}`, 0)
      seedFriendship(db, `fs-59-${i}`, 'pika-59', `recipient-59-${i}`)
    }
    db.close()

    // Lifecycle точно по заявката: create adminSettingsStore ВЕДНЪЖ, create
    // yellowCoinGiftStore ВЕДНЪЖ — НИКОГА не се пресъздава/restart-ва по-
    // долу. Единствената променлива между стъпките е adminSettingsStore.
    // updateSettings(...) (реален store, не mock) върху СЪЩИЯ dbPath/process.
    const adminSettingsStore = await createAdminSettingsStore(dbPath)
    adminSettingsStore.updateSettings({ pikaTeamDailyGiftLimit: 10_000 })
    const giftStore = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)

    // A. limit=10 000, gift 10 000 → ALLOWED (used става точно 10 000, remaining 0)
    const giftA = giftStore.sendGift('pika-59', 'fs-59-0', 10_000, true)
    assert(giftA.ok === true, `[A] gift 10 000 при limit=10 000 (used=0) трябва да мине: ${JSON.stringify(giftA)}`)

    // A.1 Следващ gift (used=10 000=limit, remaining=0) → BLOCKED, БЕЗ да
    // пипаме store/adminSettingsStore instance-ите.
    const blockedA = giftStore.sendGift('pika-59', 'fs-59-1', 1_000, true)
    assert(blockedA.ok === false, '[A] Следващ gift при remaining=0 трябва да е BLOCKED')
    assertEqual((blockedA as { code: string }).code, 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED', 'code [A]')
    assertEqual((blockedA as { limit: number }).limit, 10_000, 'limit [A]')
    assertEqual((blockedA as { used: number }).used, 10_000, 'used [A]')
    assertEqual((blockedA as { remaining: number }).remaining, 0, 'remaining [A]')

    // B. Admin update → 25 000, БЕЗ restart/нов store/смяна на деня. Gift
    // 15 000 (over СТАРИЯ 10 000 лимит, но under новия remaining=15 000)
    // → ALLOWED веднага, ползвайки СЪЩИЯ giftStore instance.
    const updateB = adminSettingsStore.updateSettings({ pikaTeamDailyGiftLimit: 25_000 })
    assert(updateB.ok === true, `[B] Admin update до 25 000 трябва да успее: ${JSON.stringify(updateB)}`)

    const giftB = giftStore.sendGift('pika-59', 'fs-59-2', 15_000, true)
    assert(
      giftB.ok === true,
      `[B] Gift 15 000 веднага след admin update (limit=25 000, used=10 000, remaining=15 000) трябва да е ALLOWED, СЪЩИЯ store instance, без restart: ${JSON.stringify(giftB)}`,
    )

    // C. След B: used=25 000, remaining=0.
    const statusC = giftStore.getPikaTeamDailyGiftLimitStatus('pika-59')
    assertEqual(statusC.limit, 25_000, 'limit [C]')
    assertEqual(statusC.used, 25_000, 'used [C] трябва да е точно 25 000 (10 000 + 15 000)')
    assertEqual(statusC.remaining, 0, 'remaining [C]')

    // D. Admin update → 20 000 (decrease под вече used=25 000). used
    // ОСТАВА 25 000 (не rollback, не се пипат стари gifts), remaining=0,
    // следващ gift → BLOCKED. Пак СЪЩИЯ giftStore instance.
    const updateD = adminSettingsStore.updateSettings({ pikaTeamDailyGiftLimit: 20_000 })
    assert(updateD.ok === true, `[D] Admin update до 20 000 трябва да успее: ${JSON.stringify(updateD)}`)

    const statusD = giftStore.getPikaTeamDailyGiftLimitStatus('pika-59')
    assertEqual(statusD.limit, 20_000, 'limit [D] веднага след decrease')
    assertEqual(statusD.used, 25_000, 'used [D] НЕ трябва да намалее (стари gifts не се rollback-ват)')
    assertEqual(statusD.remaining, 0, 'remaining [D] трябва да е 0 (used > нов по-нисък limit)')

    const blockedD = giftStore.sendGift('pika-59', 'fs-59-3', 1_000, true)
    assert(blockedD.ok === false, '[D] Gift веднага след decrease под used трябва да е BLOCKED')
    assertEqual((blockedD as { code: string }).code, 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED', 'code [D]')
    assertEqual((blockedD as { used: number }).used, 25_000, 'used [D.1] в самия blocked отговор')
    assertEqual((blockedD as { remaining: number }).remaining, 0, 'remaining [D.1] в самия blocked отговор')

    // E. Admin update → 35 000 (повторно increase). remaining веднага
    // става 10 000 (35 000 - 25 000). Gift 10 000 → ALLOWED веднага.
    const updateE = adminSettingsStore.updateSettings({ pikaTeamDailyGiftLimit: 35_000 })
    assert(updateE.ok === true, `[E] Admin update до 35 000 трябва да успее: ${JSON.stringify(updateE)}`)

    const statusEBefore = giftStore.getPikaTeamDailyGiftLimitStatus('pika-59')
    assertEqual(statusEBefore.remaining, 10_000, '[E] remaining веднага след increase, преди новия gift')

    const giftE = giftStore.sendGift('pika-59', 'fs-59-4', 10_000, true)
    assert(
      giftE.ok === true,
      `[E] Gift 10 000 веднага след повторен admin increase (remaining=10 000) трябва да е ALLOWED: ${JSON.stringify(giftE)}`,
    )

    // Gift над remaining (тук вече 0) трябва да се отказва изцяло.
    const blockedE = giftStore.sendGift('pika-59', 'fs-59-5', 1_000, true)
    assert(blockedE.ok === false, '[E] Gift над remaining=0 (след E gift-а) трябва да е BLOCKED')

    // F. used=35 000, remaining=0.
    const statusF = giftStore.getPikaTeamDailyGiftLimitStatus('pika-59')
    assertEqual(statusF.limit, 35_000, 'limit [F]')
    assertEqual(statusF.used, 35_000, 'used [F] трябва да е точно 35 000 (25 000 + 10 000)')
    assertEqual(statusF.remaining, 0, 'remaining [F]')

    giftStore.close()
    adminSettingsStore.close()

    // G/H: Целият сценарий по-горе се изпълни без нито едно от: нов
    // yellowCoinGiftStore instance, нов adminSettingsStore instance, restart
    // на process, смяна на calendar ден (всички gifts са в рамките на
    // текущия момент на теста — getSofiaDayStartUtcSqliteString() е
    // детерминиран спрямо реалния "сега", без manipulation на created_at/
    // system clock тук) — доказва, че midnight reset логиката НЕ участва в
    // Admin setting activation-a (§4.5 винаги чете adminSettingsStore.
    // getSettings() fresh, а calendar-day boundary-то е ортогонално на
    // limit стойността, виж yellowCoinGiftStore.ts §4.5 коментара).
  })
})

// ─── Финален резултат ───────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}

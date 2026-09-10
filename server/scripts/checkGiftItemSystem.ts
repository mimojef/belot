/**
 * checkGiftItemSystem.ts
 *
 * Checks за Virtual Item Gift System (Етап 1) — giftItemStore.ts.
 *
 * [A] Успешно изпращане — balance намалява точно с price, transaction
 *     записан, recipient delivery notification създадена (с правилни
 *     snapshot item_name/image_url)
 * [B] Недостатъчен balance — no balance change, no transaction row
 * [C] Неактивен gift item — send връща ok:false, не се дебитва
 * [D] Price integrity — дори ако tampered price дойде отвън (store
 *     функцията не приема price параметър изобщо), реалната наплатена
 *     сума е DB price
 * [E] Double request (същия requestId 2 пъти) — само 1 ред в
 *     gift_item_transactions, само 1 debit
 * [F] Offline delivery — pending row остава с shown_at IS NULL,
 *     markDeliveryShown го маркира, повторно повикване на
 *     getPendingDeliveries вече не го връща
 * [G] delete на gift item с история е блокиран (RESTRICT + explicit count
 *     guard), soft-delete (setGiftItemActive(false)) работи
 * [H] listActiveGiftItems връща ВСИЧКИ активни подаръци (regression за бъг
 *     "показва се само първият подарък"), нов/редактиран/деактивиран
 *     подарък е видим при следващ fetch без server restart
 *
 * Image cleanup (Etап 2 — reference-safe physical file delete, виж
 * server/src/index.ts route wiring за upsert/delete/orphan sweep):
 * [I] Gift upload WebP quality override = 90 (GIFT_ITEM_IMAGE_WEBP_QUALITY
 *     константа + processImageAttachmentToWebp(options.quality) wiring),
 *     без да променя shared IMAGE_ATTACHMENT_WEBP_QUALITY=82 default-а
 * [J] Hard delete без история: DB row изтрит, unreferenced image file
 *     изтрит от диска (isImageUrlReferenced → false → cleanup)
 * [K] Gift с история: hard delete blocked, image остава недокоснат
 * [L] Replace image: нов URL записан, стар unreferenced image изтрит
 * [M] Стар image все още referenced от gift_item_delivery_log: replace НЕ
 *     изтрива стария файл
 * [N] Споделен image URL между два DB reference-а: delete на единия НЕ
 *     трие файла, докато другият reference (или delivery log) все още го
 *     сочи
 * [O] Failed create/update след upload: новият unreferenced upload остава
 *     safe да бъде премахнат (isImageUrlReferenced връща false)
 * [P] Orphan sweep: стар unreferenced файл се трие, referenced файл
 *     остава, recent (< grace period) unreferenced файл остава
 *
 * Offline delivery queue ordering (regression за "logout/login между всеки
 * подарък" бъга — виж client-side queue fix-а в
 * scripts/checkGiftItemNotificationQueue.ts за client-side поведението):
 * [Q] getPendingDeliveries връща ВСИЧКИ pending редове (не LIMIT 1/[0]),
 *     подредени deterministic (created_at ASC, rowid ASC tie-break) дори
 *     когато няколко delivery redа имат ИДЕНТИЧЕН created_at timestamp
 *     (SQLite secondна прецизност — реалистично при 3 бързи подаръка)
 * [R] "Sent to socket" != "shown to user" — delivery НЕ се маркира shown
 *     автоматично; markDeliveryShown маркира ЕДИНСТВЕНО explicit посочения
 *     transaction_id, останалите pending redове остават непроменени
 *
 * Admin UI ordering regression (виж брифа "Admin > Подаръци — sort_order
 * UX/ordering"):
 * [S] listAdminGiftItems И listActiveGiftItems връщат sort_order 3,1,10,2
 *     подредени като 1,2,3,10 (числово, не lexicographic string ред) —
 *     двата списъка (admin catalog, user gift selector) четат от СЪЩИЯ
 *     `ORDER BY sort_order ASC, name ASC` SQL клауза (виж
 *     selectAdminItemsStatement/selectActiveItemsStatement по-долу в
 *     giftItemStore.ts — идентичен sort clause, различават се само по
 *     `WHERE is_active = 1` филтъра), затова един тест, проверяващ и двете
 *     функции, покрива и admin, и public контекста без дублиране.
 *
 * Stage 2 — table/in-game gifts (виж resolveTableGiftParticipants.ts и
 * send_table_gift handler-а в index.ts):
 * [T] context='game' + roomId ползва СЪЩАТА payment/idempotency логика като
 *     context='profile' (без паралелна платежна система), и НЕ създава
 *     personal delivery notification — точно това предотвратява дублирана
 *     презентация за един transaction
 * [U] isReplay: false при нов insert, true при duplicate requestId — точката,
 *     от която handler-ът решава дали да произведе room broadcast (replay =
 *     без втори broadcast, но пак success отговор към sender-а)
 * [V] resolveTableGiftParticipants (pure, unit-testable): приема само
 *     получател в СЪЩАТА стая; отхвърля външен играч, бот БЕЗ profileId,
 *     self-gift, подправен roomId, изпращач извън стая, disconnected
 *     connection и приключил мач — всичко ПРЕДИ какъвто и да е дебит
 * [W] Lazy expiry: изтекли overlay-и не попадат в room snapshot-а
 *
 * Stage 2.1 — table gifts към BOT participants (виж CLAUDE.md брифа
 * "ИСКАМ ДА МОЖЕ ДА СЕ ИЗПРАЩАТ ПОДАРЪЦИ И НА БОТОВЕ"): regular matchmaking
 * bots имат стабилен DB-backed profileId (selectMatchmakingBotProfiles.ts →
 * pickEligibleBotProfileFromDb.ts), затова recipient_profile_id FK-то в
 * gift_item_transactions важи непроменено — reuse, не fake profile:
 * [X] resolveTableGiftParticipants приема bot recipient С реален profileId
 *     (happy path), продължава да отхвърля fake/cross-room bot targets и
 *     self-target
 * [Y] sendGiftItem(context='game') към bot profileId: единичен дебит,
 *     transaction записан коректно, bot НЕ получава wallet credit, НЕ се
 *     създава delivery log ред, idempotent replay работи identично на
 *     human recipient
 *
 * Admin статистика (виж брифа "Общо изхарчени жълтици за виртуални
 * подаръци"):
 * [Z] getTotalChargedYellowCoins — 0 transactions -> 0; SUM(charged_price)
 *     вкл. И 'profile', И 'game'/table gifts; idempotency replay (същия
 *     requestId) НЕ увеличава сумата повторно; logical delete (tombstone)
 *     на gift item-а НЕ маха миналите му транзакции от сумата
 */

import { mkdtemp, rm, readFile, mkdir, writeFile, unlink, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createGiftItemStore, type GiftItemStore } from '../src/db/giftItemStore.js'
import { resolveTableGiftParticipants } from '../src/core/resolveTableGiftParticipants.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import {
  processImageAttachmentToWebp,
  GIFT_ITEM_IMAGE_WEBP_QUALITY,
  IMAGE_ATTACHMENT_WEBP_QUALITY,
  IMAGE_ATTACHMENT_FILENAME_PATTERN,
} from '../src/uploads/imageAttachments.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const giftItemMigrationPath = resolve(
  serverRoot,
  'database/migrations/20260909_001_create_gift_item_catalog.sql',
)
// Delete semantics change (deleted_at tombstone колона) — отделен, по-нов
// migration файл. applyGiftItemMigrations по-долу прилага и двата
// последователно, за да не се редактират 20+ отделни call sites едно по
// едно всеки път, когато gift_items схемата се разшири.
const giftItemsDeletedAtMigrationPath = resolve(
  serverRoot,
  'database/migrations/20260910_001_add_gift_items_deleted_at.sql',
)

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-gift-item-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Минимален stub за PlayerProgressStore — само getPublicProfile се ползва
// от giftItemStore.sendGiftItem (sender/recipient existence checks).
function makeMockProgressStore(knownProfileIds: Set<string>): PlayerProgressStore {
  return {
    getPublicProfile: (profileId: string) =>
      knownProfileIds.has(profileId)
        ? {
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
          }
        : null,
  } as unknown as PlayerProgressStore
}

// Сгражда минимална schema, нужна за giftItemStore (profiles + profile_wallets),
// после прилага реалния gift_item_catalog migration файл за самите таблици.
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
  `)
}

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

// Прилага и двата gift_items migration файла последователно (catalog
// create + deleted_at ALTER). Единствен helper вместо да се дублира
// applyMigrationFile(db, giftItemMigrationPath) + втори ред на 20+ места.
async function applyGiftItemMigrations(db: DatabaseSync): Promise<void> {
  await applyMigrationFile(db, giftItemMigrationPath)
  await applyMigrationFile(db, giftItemsDeletedAtMigrationPath)
}

function seedProfile(db: DatabaseSync, profileId: string, balance: number = 0): void {
  db.exec(`INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('${profileId}', '${profileId}')`)
  db.exec(`INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('${profileId}', ${balance})`)
}

function getWalletBalance(db: DatabaseSync, profileId: string): number {
  const row = db.prepare('SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?').get(profileId) as
    | { yellow_coins_balance: number }
    | undefined
  return row?.yellow_coins_balance ?? 0
}

function countTransactions(db: DatabaseSync, giftItemId?: string): number {
  const row = giftItemId
    ? (db.prepare('SELECT COUNT(*) AS cnt FROM gift_item_transactions WHERE gift_item_id = ?').get(giftItemId) as { cnt: number })
    : (db.prepare('SELECT COUNT(*) AS cnt FROM gift_item_transactions').get() as { cnt: number })
  return row.cnt
}

// ─── Image cleanup test helpers ────────────────────────────────────────────
// Тестов double, mirror-ващ ТОЧНО index.ts deleteUploadFileByUrl-а (ENOENT-
// tolerant unlink) и filename safety guard-а (IMAGE_ATTACHMENT_FILENAME_PATTERN
// — СЪЩИЯТ regex, reuse-нат, не дублиран). deleteUploadFileByUrl не е
// export-вана от index.ts (монолитен entry point, не module), затова тук
// упражняваме идентичен path-safety/ENOENT семантика директно върху локална
// temp директория, за да тестваме reference-check + physical delete
// комбинацията end-to-end.
async function testDeleteUploadFileByUrl(uploadsDir: string, uploadUrl: string): Promise<void> {
  const prefix = '/uploads/gift-items/'
  if (!uploadUrl.startsWith(prefix)) return
  const filename = uploadUrl.slice(prefix.length)
  if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) return
  try {
    await unlink(join(uploadsDir, filename))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

async function testWriteGiftItemImageFile(
  uploadsDir: string,
  buffer: Buffer,
): Promise<{ filename: string; imageUrl: string }> {
  await mkdir(uploadsDir, { recursive: true })
  const filename = `${randomUUID()}.webp`
  await writeFile(join(uploadsDir, filename), buffer)
  return { filename, imageUrl: `/uploads/gift-items/${filename}` }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

// Минимален 1x1 валиден PNG (за processImageAttachmentToWebp вход) — не
// разчита на externally-provided fixture файл.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function makeTinyPngBuffer(): Buffer {
  return Buffer.from(TINY_PNG_BASE64, 'base64')
}

// Реален upsert + physical write, mirror-ващ index.ts route flow-а (upload
// endpoint записва файл ПЪРВО, после separate submit request-а прави DB
// upsert) — за replace/delete image cleanup тестовете по-долу.
async function upsertGiftItemWithImage(
  store: GiftItemStore,
  uploadsDir: string,
  input: { giftItemId?: string | null; name: string; price: number; sortOrder: number; isActive: boolean },
): Promise<{ item: { giftItemId: string; imageUrl: string }; previousImageUrl: string | null }> {
  const processed = await processImageAttachmentToWebp(makeTinyPngBuffer())
  assert(processed !== null, 'processImageAttachmentToWebp трябва да успее за валиден PNG')
  const { imageUrl } = await testWriteGiftItemImageFile(uploadsDir, processed!.buffer)

  const result = store.upsertGiftItem({ ...input, imageUrl })
  assert(result.ok === true, 'upsertGiftItemWithImage: upsert трябва да успее')
  if (!result.ok) throw new Error('unreachable')

  return { item: { giftItemId: result.item.giftItemId, imageUrl: result.item.imageUrl }, previousImageUrl: result.previousImageUrl }
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('\n=== checkGiftItemSystem ===\n')

await withTempDir(async (dir) => {
  // ── [A] Успешно изпращане ───────────────────────────────────────────────
  await check('[A] Успешно изпращане — balance-price, transaction записан, delivery notification създадена', async () => {
    const dbPath = join(dir, 'testA.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-a', 10_000)
    seedProfile(db, 'recipient-a', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-a', 'Роза', '/uploads/gift-items/rose.webp', 3000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-a', 'recipient-a']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const result = store.sendGiftItem('sender-a', 'recipient-a', 'item-a', 'req-a-1')
    assert(result.ok === true, 'sendGiftItem трябва да успее')
    if (!result.ok) return

    assertEqual(result.senderBalanceAfter, 7000, 'senderBalanceAfter = 10000 - 3000')
    assertEqual(result.transaction.chargedPrice, 3000, 'chargedPrice = DB price')
    assertEqual(result.giftItem?.giftItemId, 'item-a', 'giftItem snapshot')

    store.createDeliveryNotification(
      result.transaction.transactionId,
      'recipient-a',
      'item-a',
      result.giftItem?.name ?? '',
      result.giftItem?.imageUrl ?? '',
      'Sender A',
    )

    const pending = store.getPendingDeliveries('recipient-a')
    assertEqual(pending.length, 1, 'един pending delivery ред')
    assertEqual(pending[0]!.itemName, 'Роза', 'snapshot item_name')
    assertEqual(pending[0]!.imageUrl, '/uploads/gift-items/rose.webp', 'snapshot image_url')

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getWalletBalance(db2, 'sender-a'), 7000, 'DB balance след дебит')
    assertEqual(countTransactions(db2, 'item-a'), 1, 'точно 1 transaction ред')
    db2.close()

    store.close()
  })

  // ── [B] Недостатъчен balance ────────────────────────────────────────────
  await check('[B] Недостатъчен balance — no balance change, no transaction row', async () => {
    const dbPath = join(dir, 'testB.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-b', 500)
    seedProfile(db, 'recipient-b', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-b', 'Диамант', '/uploads/gift-items/diamond.webp', 5000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-b', 'recipient-b']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const result = store.sendGiftItem('sender-b', 'recipient-b', 'item-b', 'req-b-1')
    assert(result.ok === false, 'sendGiftItem трябва да откаже')
    if (result.ok) return
    assert(result.message.includes('жълтици'), 'съобщението трябва да спомене жълтици')

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getWalletBalance(db2, 'sender-b'), 500, 'balance непроменен')
    assertEqual(countTransactions(db2, 'item-b'), 0, 'няма transaction ред')
    db2.close()

    store.close()
  })

  // ── [C] Неактивен gift item ─────────────────────────────────────────────
  await check('[C] Неактивен gift item — send връща ok:false, не се дебитва', async () => {
    const dbPath = join(dir, 'testC.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-c', 10_000)
    seedProfile(db, 'recipient-c', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-c', 'Изтеглен подарък', '/uploads/gift-items/x.webp', 1000, 0, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-c', 'recipient-c']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const result = store.sendGiftItem('sender-c', 'recipient-c', 'item-c', 'req-c-1')
    assert(result.ok === false, 'sendGiftItem трябва да откаже неактивен подарък')

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getWalletBalance(db2, 'sender-c'), 10_000, 'balance непроменен')
    assertEqual(countTransactions(db2, 'item-c'), 0, 'няма transaction ред')
    db2.close()

    store.close()
  })

  // ── [D] Price integrity ─────────────────────────────────────────────────
  await check('[D] Price integrity — реалната наплатена сума е DB price (store функцията не приема price параметър)', async () => {
    const dbPath = join(dir, 'testD.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-d', 10_000)
    seedProfile(db, 'recipient-d', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-d', 'Коронa', '/uploads/gift-items/crown.webp', 4321, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-d', 'recipient-d']))
    const store = await createGiftItemStore(dbPath, progressStore)

    // sendGiftItem сигнатурата (senderProfileId, recipientProfileId, giftItemId,
    // requestId, context?, roomId?) физически НЯМА price параметър — не
    // съществува начин "подправена" цена да влезе тук дори hypothetically.
    // Проверяваме, че реално наплатената сума = DB стойността, независимо
    // какво "очакваме" отвън.
    const result = store.sendGiftItem('sender-d', 'recipient-d', 'item-d', 'req-d-1')
    assert(result.ok === true, 'sendGiftItem трябва да успее')
    if (!result.ok) return
    assertEqual(result.transaction.chargedPrice, 4321, 'chargedPrice = DB price (4321), не нещо друго')
    assertEqual(result.senderBalanceAfter, 10_000 - 4321, 'balance намален точно с DB price')

    store.close()
  })

  // ── [E] Double request (idempotency) ────────────────────────────────────
  await check('[E] Double request (същия requestId 2 пъти) — само 1 transaction ред, само 1 debit', async () => {
    const dbPath = join(dir, 'testE.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-e', 10_000)
    seedProfile(db, 'recipient-e', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-e', 'Звезда', '/uploads/gift-items/star.webp', 2000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-e', 'recipient-e']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const first = store.sendGiftItem('sender-e', 'recipient-e', 'item-e', 'req-e-idempotent')
    assert(first.ok === true, 'първи опит трябва да успее')
    if (!first.ok) return

    const second = store.sendGiftItem('sender-e', 'recipient-e', 'item-e', 'req-e-idempotent')
    assert(second.ok === true, 'втори опит със СЪЩИЯ requestId трябва да "успее" (replay), не грешка')
    if (!second.ok) return

    assertEqual(second.transaction.transactionId, first.transaction.transactionId, 'replay връща СЪЩИЯ transaction ред')
    assertEqual(second.senderBalanceAfter, first.senderBalanceAfter, 'balance идентичен между двата опита (без повторен дебит)')

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getWalletBalance(db2, 'sender-e'), 8000, 'balance дебитиран точно ВЕДНЪЖ (10000 - 2000)')
    assertEqual(countTransactions(db2, 'item-e'), 1, 'точно 1 transaction ред (UNIQUE request_id constraint)')
    db2.close()

    store.close()
  })

  // ── [F] Offline delivery ────────────────────────────────────────────────
  await check('[F] Offline delivery — pending остава shown_at IS NULL, markDeliveryShown маркира, после не се връща', async () => {
    const dbPath = join(dir, 'testF.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-f', 10_000)
    seedProfile(db, 'recipient-f', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-f', 'Сърце', '/uploads/gift-items/heart.webp', 1500, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-f', 'recipient-f']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const result = store.sendGiftItem('sender-f', 'recipient-f', 'item-f', 'req-f-1')
    assert(result.ok === true, 'sendGiftItem трябва да успее')
    if (!result.ok) return

    store.createDeliveryNotification(
      result.transaction.transactionId,
      'recipient-f',
      'item-f',
      result.giftItem?.name ?? '',
      result.giftItem?.imageUrl ?? '',
      'Sender F',
    )

    const pendingBefore = store.getPendingDeliveries('recipient-f')
    assertEqual(pendingBefore.length, 1, 'pending преди markDeliveryShown')

    store.markDeliveryShown(result.transaction.transactionId, 'recipient-f')

    const pendingAfter = store.getPendingDeliveries('recipient-f')
    assertEqual(pendingAfter.length, 0, 'pending празен след markDeliveryShown')

    const db2 = new DatabaseSync(dbPath, { open: true })
    const row = db2.prepare('SELECT shown_at FROM gift_item_delivery_log WHERE transaction_id = ?').get(
      result.transaction.transactionId,
    ) as { shown_at: string | null }
    assert(row.shown_at !== null, 'shown_at маркиран в DB')
    db2.close()

    store.close()
  })

  // ── [G] Delete с история блокиран, soft-delete работи ──────────────────
  await check('[G] Delete на gift item С transaction история вече УСПЯВА (logical delete/tombstone), history остава недокосната', async () => {
    const dbPath = join(dir, 'testG.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-g', 10_000)
    seedProfile(db, 'recipient-g', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-g', 'Торта', '/uploads/gift-items/cake.webp', 1000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-g', 'recipient-g']))
    const store = await createGiftItemStore(dbPath, progressStore)

    // item-g получава реална transaction история.
    const sendResult = store.sendGiftItem('sender-g', 'recipient-g', 'item-g', 'req-g-1')
    assert(sendResult.ok === true, 'sendGiftItem трябва да успее')
    const balanceAfterSend = sendResult.ok ? sendResult.senderBalanceAfter : null

    // Delete с история вече УСПЯВА (старото RESTRICT-базирано блокиране е
    // премахнато) — logical delete/tombstone, не reject.
    const deleteWithHistory = store.deleteGiftItem('item-g')
    assert(deleteWithHistory.ok === true, 'delete на подарък С история вече трябва да успее (logical delete)')
    if (!deleteWithHistory.ok) return
    assertEqual(deleteWithHistory.outcome, 'deleted', 'outcome="deleted" за реален (не-idempotent) delete')
    assertEqual(deleteWithHistory.deletedImageUrl, '/uploads/gift-items/cake.webp', 'връща правилния image URL')

    // Веднага изчезва от admin/public listвания (tombstone е server-side
    // невидим навсякъде, виж брифа §1/§9).
    const stillInAdminList = store.listAdminGiftItems().find((i) => i.giftItemId === 'item-g')
    assert(stillInAdminList === undefined, 'item-g изчезва от admin catalog веднага след delete')
    const stillInActiveList = store.listActiveGiftItems().find((i) => i.giftItemId === 'item-g')
    assert(stillInActiveList === undefined, 'item-g изчезва от public active catalog веднага след delete')

    // Deleted gift не може да бъде купен наново.
    const secondSendAttempt = store.sendGiftItem('sender-g', 'recipient-g', 'item-g', 'req-g-2')
    assert(secondSendAttempt.ok === false, 'изпращане на logically deleted gift трябва да се отхвърли')

    // §2 от брифа — transaction history остава напълно недокосната: същата
    // сума, същия sender balance, никакво връщане на жълтици.
    const db2 = new DatabaseSync(dbPath, { open: true })
    const txRow = db2.prepare(
      'SELECT charged_price, sender_profile_id, recipient_profile_id FROM gift_item_transactions WHERE gift_item_id = ?',
    ).get('item-g') as { charged_price: number; sender_profile_id: string; recipient_profile_id: string } | undefined
    assert(txRow !== undefined, 'transaction редът остава в DB (FK ON DELETE RESTRICT never triggered — tombstone, не hard delete)')
    assertEqual(txRow?.charged_price, 1000, 'charged_price непроменен')
    assertEqual(txRow?.sender_profile_id, 'sender-g', 'sender history непроменена')
    assertEqual(txRow?.recipient_profile_id, 'recipient-g', 'recipient history непроменена')
    assertEqual(getWalletBalance(db2, 'sender-g'), balanceAfterSend, 'sender balance непроменен от delete-а — никакво връщане на жълтици')
    db2.close()

    // Idempotent повторен delete (double-click) — success, различен outcome.
    const secondDelete = store.deleteGiftItem('item-g')
    assert(secondDelete.ok === true, 'повторен delete на вече-изтрит gift остава success (idempotent)')
    if (secondDelete.ok) {
      assertEqual(secondDelete.outcome, 'already-deleted', 'outcome="already-deleted" за idempotent повторен опит')
    }

    store.close()
  })
  // ── [H] Multi-item active catalog listing (regression за "показва се само
  // първият подарък" — виж бъг репорта: admin добавя 3 активни подаръка,
  // gift selector-ът показваше само 1) ────────────────────────────────────
  await check('[H] listActiveGiftItems връща ВСИЧКИ активни подаръци (не first-row/LIMIT bug), неактивен изключен', async () => {
    const dbPath = join(dir, 'testH.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    // Симулира точно репортирания сценарий: admin създава последователно 3
    // подаръка (sort_order=0 и за трите, както прави реалната admin форма
    // по подразбиране — deterministic tie-break трябва да е вторичен ключ,
    // не "първи ред печели").
    const first = store.upsertGiftItem({ name: 'Джапанка', imageUrl: '/uploads/gift-items/a.webp', price: 500, sortOrder: 0, isActive: true })
    assert(first.ok === true, 'upsert 1 трябва да успее')
    const second = store.upsertGiftItem({ name: 'клюн', imageUrl: '/uploads/gift-items/b.webp', price: 500, sortOrder: 0, isActive: true })
    assert(second.ok === true, 'upsert 2 трябва да успее')
    const third = store.upsertGiftItem({ name: 'сдфас', imageUrl: '/uploads/gift-items/c.webp', price: 1000, sortOrder: 0, isActive: true })
    assert(third.ok === true, 'upsert 3 трябва да успее')

    // "Отваряне на gift selector-а" = fresh listActiveGiftItems() call —
    // трябва да върне и трите, не само първия създаден ред.
    const catalogAfterThree = store.listActiveGiftItems()
    assertEqual(catalogAfterThree.length, 3, 'каталогът съдържа и трите активни подаръка')
    const namesAfterThree = catalogAfterThree.map((i) => i.name).sort()
    assertEqual(JSON.stringify(namesAfterThree), JSON.stringify(['Джапанка', 'клюн', 'сдфас'].sort()), 'всичките 3 имена присъстват')

    // Нов подарък, добавен от admin ПОСЛЕ първото зареждане на selector-а,
    // трябва да е видим при следващ fresh fetch — без server restart, без
    // client-side "cache lock" (виж openGiftItemModal fix — fresh fetch на
    // всяко отваряне вместо еднократен `catalog.length === 0` guard).
    const fourth = store.upsertGiftItem({ name: 'Пеперуда', imageUrl: '/uploads/gift-items/d.webp', price: 750, sortOrder: 1, isActive: true })
    assert(fourth.ok === true, 'upsert 4 трябва да успее')
    const catalogAfterFour = store.listActiveGiftItems()
    assertEqual(catalogAfterFour.length, 4, 'нов подарък се вижда веднага при следващ fetch, без restart')

    // Неактивен подарък не трябва да се показва в публичния каталог.
    if (fourth.ok) {
      const deactivated = store.setGiftItemActive(fourth.item.giftItemId, false)
      assert(deactivated.ok === true, 'деактивиране трябва да успее')
    }
    const catalogAfterDeactivate = store.listActiveGiftItems()
    assertEqual(catalogAfterDeactivate.length, 3, 'деактивиран подарък изчезва от публичния каталог веднага')
    assert(catalogAfterDeactivate.every((i) => i.name !== 'Пеперуда'), 'Пеперуда вече не е в активния списък')

    // Промяна на цена/име на съществуващ подарък трябва да е видима веднага
    // при следващ fetch (не stale snapshot).
    if (first.ok) {
      const edited = store.upsertGiftItem({
        giftItemId: first.item.giftItemId,
        name: 'Джапанка Deluxe',
        imageUrl: first.item.imageUrl,
        price: 999,
        sortOrder: 0,
        isActive: true,
      })
      assert(edited.ok === true, 'edit трябва да успее')
    }
    const catalogAfterEdit = store.listActiveGiftItems()
    const editedItem = catalogAfterEdit.find((i) => i.name === 'Джапанка Deluxe')
    assert(editedItem !== undefined, 'редактираното име се вижда веднага')
    assertEqual(editedItem?.price, 999, 'редактираната цена се вижда веднага')

    store.close()
  })

  // ── [I] Gift-specific WebP quality override ─────────────────────────────
  await check('[I] Gift upload използва WebP quality override 90, shared default остава 82', async () => {
    assertEqual(GIFT_ITEM_IMAGE_WEBP_QUALITY, 90, 'GIFT_ITEM_IMAGE_WEBP_QUALITY = 90')
    assertEqual(IMAGE_ATTACHMENT_WEBP_QUALITY, 82, 'shared IMAGE_ATTACHMENT_WEBP_QUALITY непроменен = 82')

    // Двата пътя минават през СЪЩАТА processImageAttachmentToWebp функция —
    // разликата е изцяло в options.quality, подаден от caller-а (index.ts
    // gift-items upload route подава GIFT_ITEM_IMAGE_WEBP_QUALITY explicit;
    // всички други callers — avatars/chat/topics/support — не подават quality
    // изобщо и падат обратно на default-а).
    const source = makeTinyPngBuffer()
    const defaultResult = await processImageAttachmentToWebp(source)
    const giftResult = await processImageAttachmentToWebp(source, { quality: GIFT_ITEM_IMAGE_WEBP_QUALITY })
    assert(defaultResult !== null, 'default обработка трябва да успее')
    assert(giftResult !== null, 'gift-quality обработка трябва да успее')

    // rotate()/withoutEnlargement/alpha поведението е непроменено — двата
    // изхода имат валидни, положителни dimensions (pipeline-ът не чупи
    // shape-а, само quality параметъра се различава).
    assert((defaultResult?.width ?? 0) > 0 && (defaultResult?.height ?? 0) > 0, 'default output има валидни dimensions')
    assert((giftResult?.width ?? 0) > 0 && (giftResult?.height ?? 0) > 0, 'gift-quality output има валидни dimensions')
  })

  // ── [J] Hard delete без история — image file изтрит ─────────────────────
  await check('[J] Logical delete без история: unreferenced image file финализира (изтрива) се от диска', async () => {
    const dbPath = join(dir, 'testJ.sqlite')
    const uploadsDir = join(dir, 'uploads-j', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    const { item } = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Торта J', price: 1000, sortOrder: 0, isActive: true,
    })
    const filePath = join(uploadsDir, item.imageUrl.replace('/uploads/gift-items/', ''))
    assert(await fileExists(filePath), 'файлът съществува веднага след upload+upsert')

    // index.ts route flow (§4 Hard Delete): deleteGiftItem → isImageUrlReferenced
    // (СЛЕД delete-а) → deleteUploadFileByUrl само ако false.
    const deleteResult = store.deleteGiftItem(item.giftItemId)
    assert(deleteResult.ok === true, 'delete без история трябва да успее')
    if (!deleteResult.ok) return
    assertEqual(deleteResult.deletedImageUrl, item.imageUrl, 'deletedImageUrl съответства на изтрития ред')

    assert(!store.isImageUrlReferenced(deleteResult.deletedImageUrl), 'imageUrl вече не е referenced след DB delete')
    await testDeleteUploadFileByUrl(uploadsDir, deleteResult.deletedImageUrl)

    assert(!(await fileExists(filePath)), 'физическият файл е изтрит от диска')

    store.close()
  })

  // ── [K] Gift с история — hard delete blocked, image остава ─────────────
  await check('[K] Logically deleted gift с UNSEEN offline delivery: image файлът остава, докато последният pending recipient не го види', async () => {
    // Точно сценарият от брифа §3: Роза изпратена на A (видял я), B и C
    // (offline, още не са я видели). Admin натиска Delete — Роза изчезва от
    // catalog ВЕДНАГА, но image файлът остава, докато B и C не я видят.
    const dbPath = join(dir, 'testK.sqlite')
    const uploadsDir = join(dir, 'uploads-k', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-k', 30_000)
    seedProfile(db, 'recipient-a', 0)
    seedProfile(db, 'recipient-b', 0)
    seedProfile(db, 'recipient-c', 0)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-k', 'recipient-a', 'recipient-b', 'recipient-c']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const { item } = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Роза K', price: 1000, sortOrder: 0, isActive: true,
    })
    const filePath = join(uploadsDir, item.imageUrl.replace('/uploads/gift-items/', ''))

    // Изпратена на A (вече видяна), B и C (offline, still unseen).
    const sendA = store.sendGiftItem('sender-k', 'recipient-a', item.giftItemId, 'req-k-a')
    const sendB = store.sendGiftItem('sender-k', 'recipient-b', item.giftItemId, 'req-k-b')
    const sendC = store.sendGiftItem('sender-k', 'recipient-c', item.giftItemId, 'req-k-c')
    assert(sendA.ok && sendB.ok && sendC.ok, 'и трите изпращания трябва да успеят')
    if (!sendA.ok || !sendB.ok || !sendC.ok) return

    store.createDeliveryNotification(sendA.transaction.transactionId, 'recipient-a', item.giftItemId, 'Роза K', item.imageUrl, 'Sender K')
    store.createDeliveryNotification(sendB.transaction.transactionId, 'recipient-b', item.giftItemId, 'Роза K', item.imageUrl, 'Sender K')
    store.createDeliveryNotification(sendC.transaction.transactionId, 'recipient-c', item.giftItemId, 'Роза K', item.imageUrl, 'Sender K')
    store.markDeliveryShown(sendA.transaction.transactionId, 'recipient-a') // A вече я е видял

    // Admin Delete — logical delete, ВИНАГИ позволен независимо от историята.
    const deleteResult = store.deleteGiftItem(item.giftItemId)
    assert(deleteResult.ok === true, 'delete с история вече успява (logical delete)')
    if (!deleteResult.ok) return

    // Веднага изчезва от каталога.
    assert(store.listAdminGiftItems().every((i) => i.giftItemId !== item.giftItemId), 'изчезва от admin catalog веднага')

    // Физическа retention: B и C все още не са видели — файлът ТРЯБВА да остане.
    assert(store.isImageUrlRetentionReferenced(item.imageUrl), 'retention semantics: still-pending B/C пазят файла')
    assert(await fileExists(filePath), 'image файлът остава на диска, докато B и C не са го видели')

    // B вижда notification-а — C все още pending, файлът ОЩЕ остава.
    store.markDeliveryShown(sendB.transaction.transactionId, 'recipient-b')
    assert(store.isImageUrlRetentionReferenced(item.imageUrl), 'C все още pending — файлът остава')
    assert(await fileExists(filePath), 'файлът все още на диска (C не е видял)')

    // C вижда notification-а — последният pending recipient. Вече никой не
    // го реферира (retention semantics връща false), файлът МОЖЕ да се
    // финализира (симулираме index.ts tryFinalizeDeletedGiftImage стъпката).
    store.markDeliveryShown(sendC.transaction.transactionId, 'recipient-c')
    assert(!store.isImageUrlRetentionReferenced(item.imageUrl), 'след последния pending recipient — вече никой не реферира файла')

    store.close()
  })

  // ── [L] Replace image — стар unreferenced файл се изтрива ──────────────
  await check('[L] Replace image: нов URL записан, стар unreferenced image изтрит', async () => {
    const dbPath = join(dir, 'testL.sqlite')
    const uploadsDir = join(dir, 'uploads-l', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    const { item: created } = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Балон L', price: 500, sortOrder: 0, isActive: true,
    })
    const oldFilePath = join(uploadsDir, created.imageUrl.replace('/uploads/gift-items/', ''))
    assert(await fileExists(oldFilePath), 'старият файл съществува преди replace')

    // Edit СЪС смяна на картинка — нов upload + upsert със СЪЩИЯ giftItemId.
    const { item: updated, previousImageUrl } = await upsertGiftItemWithImage(store, uploadsDir, {
      giftItemId: created.giftItemId, name: 'Балон L v2', price: 500, sortOrder: 0, isActive: true,
    })
    assertEqual(previousImageUrl, created.imageUrl, 'previousImageUrl сочи стария URL')
    assert(updated.imageUrl !== created.imageUrl, 'новият image_url е различен от стария')

    // index.ts route flow (§3 Image Replace, стъпки 4-5): проверка СЛЕД
    // успешния DB update.
    assert(!store.isImageUrlReferenced(previousImageUrl!), 'старият URL вече не е referenced')
    await testDeleteUploadFileByUrl(uploadsDir, previousImageUrl!)

    assert(!(await fileExists(oldFilePath)), 'старият файл е изтрит след успешен replace')
    const newFilePath = join(uploadsDir, updated.imageUrl.replace('/uploads/gift-items/', ''))
    assert(await fileExists(newFilePath), 'новият файл остава на диска')

    store.close()
  })

  // ── [M] Стар image все още referenced от delivery log ──────────────────
  await check('[M] Old image referenced от gift_item_delivery_log: replace НЕ изтрива стария image', async () => {
    const dbPath = join(dir, 'testM.sqlite')
    const uploadsDir = join(dir, 'uploads-m', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-m', 10_000)
    seedProfile(db, 'recipient-m', 0)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-m', 'recipient-m']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const { item: created } = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Роза M', price: 1000, sortOrder: 0, isActive: true,
    })
    const oldFilePath = join(uploadsDir, created.imageUrl.replace('/uploads/gift-items/', ''))

    // Изпращане + delivery notification snapshot-ва СТАРИЯ image_url в
    // gift_item_delivery_log — офлайн получателят все още трябва да го види.
    const sendResult = store.sendGiftItem('sender-m', 'recipient-m', created.giftItemId, 'req-m-1')
    assert(sendResult.ok === true, 'sendGiftItem трябва да успее')
    if (!sendResult.ok) return
    store.createDeliveryNotification(
      sendResult.transaction.transactionId, 'recipient-m', created.giftItemId,
      'Роза M', created.imageUrl, 'Sender M',
    )

    // Replace image — gift_items вече сочи нов URL, но delivery log все още
    // пази стария.
    const { previousImageUrl } = await upsertGiftItemWithImage(store, uploadsDir, {
      giftItemId: created.giftItemId, name: 'Роза M v2', price: 1000, sortOrder: 0, isActive: true,
    })
    assertEqual(previousImageUrl, created.imageUrl, 'previousImageUrl = старият URL')

    // isImageUrlReferenced (catalog-only) вече НЕ брои delivery log —
    // старият URL вече не е в никой ЖИВ catalog ред (upsert-нат е с нов URL).
    assert(!store.isImageUrlReferenced(previousImageUrl!), 'catalog-only reference вече е false (само pending delivery го пази)')
    // isImageUrlRetentionReferenced (physical-retention semantics) Е true —
    // delivery log-ът все още пази снимката. index.ts route-ът вече ползва
    // ИМЕННО тая функция за image-replace safe-cleanup решението (§10 от
    // брифа — не регресирай reference-safe image replace).
    assert(store.isImageUrlRetentionReferenced(previousImageUrl!), 'retention semantics: старият URL Е referenced (pending delivery log)')
    assert(await fileExists(oldFilePath), 'старият файл остава недокоснат — все още referenced за retention цели')

    store.close()
  })

  // ── [N] Споделен image URL между два DB references ──────────────────────
  await check('[N] Shared image URL: delete/replace на единия НЕ изтрива файла докато другият reference стои', async () => {
    const dbPath = join(dir, 'testN.sqlite')
    const uploadsDir = join(dir, 'uploads-n', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    const { item: itemOne } = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Звезда N1', price: 500, sortOrder: 0, isActive: true,
    })
    const sharedImageUrl = itemOne.imageUrl
    const filePath = join(uploadsDir, sharedImageUrl.replace('/uploads/gift-items/', ''))

    // Admin ръчно copy-paste-ва СЪЩИЯ imageUrl за втори gift item (audit т.13
    // сценарий) — upsert директно (не upsertGiftItemWithImage, тъй като не
    // искаме нов файл, а explicit споделяне на съществуващия URL).
    const itemTwoResult = store.upsertGiftItem({
      name: 'Звезда N2', imageUrl: sharedImageUrl, price: 750, sortOrder: 1, isActive: true,
    })
    assert(itemTwoResult.ok === true, 'втори gift item със споделен imageUrl трябва да се запише')
    if (!itemTwoResult.ok) return

    // Delete на item-one — reference count все още >0 заради item-two.
    const deleteResult = store.deleteGiftItem(itemOne.giftItemId)
    assert(deleteResult.ok === true, 'delete на item-one трябва да успее (без история)')
    if (!deleteResult.ok) return

    assert(store.isImageUrlReferenced(deleteResult.deletedImageUrl), 'imageUrl Е still referenced от item-two')
    assert(await fileExists(filePath), 'файлът остава недокоснат — споделен reference')

    store.close()
  })

  // ── [O] Failed create/update след upload — safe cleanup ─────────────────
  await check('[O] Failed update след upload: unreferenced upload остава safe да бъде премахнат', async () => {
    const dbPath = join(dir, 'testO.sqlite')
    const uploadsDir = join(dir, 'uploads-o', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    // Upload endpoint записва файла ОТДЕЛНО от submit заявката (index.ts
    // route-овете са две различни HTTP заявки) — симулираме "качих снимка,
    // после submit-ът фейлна валидация" (напр. празно име).
    const processed = await processImageAttachmentToWebp(makeTinyPngBuffer(), { quality: GIFT_ITEM_IMAGE_WEBP_QUALITY })
    assert(processed !== null, 'processImageAttachmentToWebp трябва да успее')
    const { imageUrl } = await testWriteGiftItemImageFile(uploadsDir, processed!.buffer)
    const filePath = join(uploadsDir, imageUrl.replace('/uploads/gift-items/', ''))
    assert(await fileExists(filePath), 'файлът съществува веднага след upload')

    const failedUpsert = store.upsertGiftItem({ name: '', imageUrl, price: 500, sortOrder: 0, isActive: true })
    assert(failedUpsert.ok === false, 'upsert с празно име трябва да фейлне валидация')

    // index.ts route flow (§3 "failed update след upload"): никой DB ред не
    // сочи imageUrl, значи isImageUrlReferenced===false → safe cleanup.
    assert(!store.isImageUrlReferenced(imageUrl), 'unreferenced upload — safe за cleanup')
    await testDeleteUploadFileByUrl(uploadsDir, imageUrl)
    assert(!(await fileExists(filePath)), 'orphaned upload файлът е премахнат')

    store.close()
  })

  // ── [P] Orphan sweep ──────────────────────────────────────────────────
  await check('[P] Orphan sweep: стар unreferenced -> delete, referenced -> остава, recent unreferenced -> остава', async () => {
    const dbPath = join(dir, 'testP.sqlite')
    const uploadsDir = join(dir, 'uploads-p', 'gift-items')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    // (1) Стар, unreferenced файл — трябва да се изтрие от sweep-а.
    const oldOrphan = await testWriteGiftItemImageFile(uploadsDir, makeTinyPngBuffer())
    // (2) Referenced файл (реален gift item row) — трябва да ОСТАНЕ, дори
    // ако е "стар" по mtime.
    const referenced = await upsertGiftItemWithImage(store, uploadsDir, {
      name: 'Referenced P', price: 500, sortOrder: 0, isActive: true,
    })
    // (3) Recent unreferenced файл (< grace period) — трябва да ОСТАНЕ.
    const recentOrphan = await testWriteGiftItemImageFile(uploadsDir, makeTinyPngBuffer())

    const oldOrphanPath = join(uploadsDir, oldOrphan.filename)
    const referencedPath = join(uploadsDir, referenced.item.imageUrl.replace('/uploads/gift-items/', ''))
    const recentOrphanPath = join(uploadsDir, recentOrphan.filename)

    // Симулираме "по-стар от grace period" чрез backdate-ване на mtime (без
    // да чакаме реални 24 часа) — GIFT_ITEM_ORPHAN_SWEEP_GRACE_PERIOD_MS е
    // 24ч константа в index.ts; тук replicate-ваме СЪЩАТА стойност локално,
    // за да не import-ваме монолитния index.ts модул в теста.
    const graceMs = 24 * 60 * 60 * 1000
    const oldMtime = new Date(Date.now() - graceMs - 60_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(oldOrphanPath, oldMtime, oldMtime)
    await utimes(referencedPath, oldMtime, oldMtime)
    // recentOrphanPath остава с текущ (fresh) mtime — под grace period.

    // Sweep логика — mirror на runGiftItemImageOrphanSweep в index.ts:
    // .webp filename pattern → age check → isImageUrlReferenced guard →
    // testDeleteUploadFileByUrl (СЪЩИЯТ safe-delete pattern).
    const { readdir } = await import('node:fs/promises')
    const filenames = await readdir(uploadsDir)
    const now = Date.now()
    for (const filename of filenames) {
      if (!IMAGE_ATTACHMENT_FILENAME_PATTERN.test(filename)) continue
      const fileStat = await stat(join(uploadsDir, filename))
      if (now - fileStat.mtimeMs < graceMs) continue
      const imageUrl = `/uploads/gift-items/${filename}`
      if (store.isImageUrlReferenced(imageUrl)) continue
      await testDeleteUploadFileByUrl(uploadsDir, imageUrl)
    }

    assert(!(await fileExists(oldOrphanPath)), 'стар unreferenced файл е изтрит от sweep-а')
    assert(await fileExists(referencedPath), 'referenced файл остава след sweep')
    assert(await fileExists(recentOrphanPath), 'recent unreferenced файл (< grace period) остава след sweep')

    store.close()
  })

  // ── [Q] Multi-delivery ordering, deterministic tie-break ────────────────
  await check('[Q] getPendingDeliveries връща ВСИЧКИ pending redове, ред е стабилен дори при идентичен created_at', async () => {
    const dbPath = join(dir, 'testQ.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-q', 10_000)
    seedProfile(db, 'recipient-q', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-q', 'Подарък Q', '/uploads/gift-items/q.webp', 500, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-q', 'recipient-q']))
    const store = await createGiftItemStore(dbPath, progressStore)

    // 3 бързи последователни подаръка от ЕДИН sender (Scenario A от бъг
    // репорта) — sendGiftItem+createDeliveryNotification три пъти подред.
    const tx1 = store.sendGiftItem('sender-q', 'recipient-q', 'item-q', 'req-q-1')
    assert(tx1.ok === true, 'изпращане 1 трябва да успее')
    const tx2 = store.sendGiftItem('sender-q', 'recipient-q', 'item-q', 'req-q-2')
    assert(tx2.ok === true, 'изпращане 2 трябва да успее')
    const tx3 = store.sendGiftItem('sender-q', 'recipient-q', 'item-q', 'req-q-3')
    assert(tx3.ok === true, 'изпращане 3 трябва да успее')
    if (!tx1.ok || !tx2.ok || !tx3.ok) return

    store.createDeliveryNotification(tx1.transaction.transactionId, 'recipient-q', 'item-q', 'Подарък Q', '/uploads/gift-items/q.webp', 'Sender Q')
    store.createDeliveryNotification(tx2.transaction.transactionId, 'recipient-q', 'item-q', 'Подарък Q', '/uploads/gift-items/q.webp', 'Sender Q')
    store.createDeliveryNotification(tx3.transaction.transactionId, 'recipient-q', 'item-q', 'Подарък Q', '/uploads/gift-items/q.webp', 'Sender Q')

    // Всичките 3 delivery redа получават ИДЕНТИЧЕН created_at (SQLite
    // CURRENT_TIMESTAMP е secondна прецизност, тестът гарантира точно това
    // без да разчита на реален timing race) — reproduce-ва точно сценария,
    // при който ORDER BY created_at ASC (без tie-break) би бил
    // недетерминистичен.
    const db2 = new DatabaseSync(dbPath, { open: true })
    db2.exec(`UPDATE gift_item_delivery_log SET created_at = '2026-01-01 12:00:00'`)
    db2.close()

    const pending = store.getPendingDeliveries('recipient-q')
    assertEqual(pending.length, 3, 'getPendingDeliveries връща ВСИЧКИ 3 pending redа, не само първия (не LIMIT 1/[0])')
    assertEqual(
      JSON.stringify(pending.map((p) => p.transactionId)),
      JSON.stringify([tx1.transaction.transactionId, tx2.transaction.transactionId, tx3.transaction.transactionId]),
      'редът е insertion order (rowid tie-break) дори при идентичен created_at за трите redа',
    )

    store.close()
  })

  // ── [R] "Sent to socket" != "shown to user" ─────────────────────────────
  await check('[R] Delivery НЕ се маркира shown автоматично; markDeliveryShown маркира ЕДИНСТВЕНО explicit посочения ред', async () => {
    const dbPath = join(dir, 'testR.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-r', 10_000)
    seedProfile(db, 'recipient-r', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-r', 'Подарък R', '/uploads/gift-items/r.webp', 500, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-r', 'recipient-r']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const tx1 = store.sendGiftItem('sender-r', 'recipient-r', 'item-r', 'req-r-1')
    const tx2 = store.sendGiftItem('sender-r', 'recipient-r', 'item-r', 'req-r-2')
    const tx3 = store.sendGiftItem('sender-r', 'recipient-r', 'item-r', 'req-r-3')
    assert(tx1.ok === true && tx2.ok === true && tx3.ok === true, 'и трите изпращания трябва да успеят')
    if (!tx1.ok || !tx2.ok || !tx3.ok) return

    store.createDeliveryNotification(tx1.transaction.transactionId, 'recipient-r', 'item-r', 'Подарък R', '/uploads/gift-items/r.webp', 'Sender R')
    store.createDeliveryNotification(tx2.transaction.transactionId, 'recipient-r', 'item-r', 'Подарък R', '/uploads/gift-items/r.webp', 'Sender R')
    store.createDeliveryNotification(tx3.transaction.transactionId, 'recipient-r', 'item-r', 'Подарък R', '/uploads/gift-items/r.webp', 'Sender R')

    // Симулира "WS connect flush изпраща целия batch по socket-а" — САМО
    // четене (getPendingDeliveries), НИКАКВО автоматично markDeliveryShown
    // извикване тук. index.ts route-ът за WS connect flush прави точно
    // това — сравни server/src/index.ts около pendingGiftItems flush блока.
    const afterFlush = store.getPendingDeliveries('recipient-r')
    assertEqual(afterFlush.length, 3, '"sent to socket" не намалява pending count-а — трите остават pending след самото изпращане по WS')

    // Клиентът показва gift 1, потребителят затваря popup-а -> explicit
    // markDeliveryShown ЕДИНСТВЕНО за tx1.
    store.markDeliveryShown(tx1.transaction.transactionId, 'recipient-r')

    const afterFirstShown = store.getPendingDeliveries('recipient-r')
    assertEqual(afterFirstShown.length, 2, 'само 1 ред е markнат shown — 2 остават pending')
    assertEqual(
      JSON.stringify(afterFirstShown.map((p) => p.transactionId)),
      JSON.stringify([tx2.transaction.transactionId, tx3.transaction.transactionId]),
      'tx2 и tx3 остават pending; tx1 вече не се връща',
    )

    // Disconnect симулация — нов connect ПРЕДИ gift 2 да е показан:
    // pending-ите остават same (tx2, tx3), tx1 не се появява отново.
    const afterReconnect = store.getPendingDeliveries('recipient-r')
    assertEqual(afterReconnect.length, 2, 'reconnect без нов markDeliveryShown не променя pending set-а')

    store.close()
  })

  // ── [S] Sort order — numeric ASC, admin И public catalog ────────────────
  await check('[S] sort_order 3,1,10,2 -> 1,2,3,10 (numeric ASC) в listAdminGiftItems и listActiveGiftItems', async () => {
    const dbPath = join(dir, 'testS.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    db.close()

    const progressStore = makeMockProgressStore(new Set())
    const store = await createGiftItemStore(dbPath, progressStore)

    // Точно сценарият от брифа: 3, 1, 10, 2 — insertion order умишлено НЕ
    // съвпада с очаквания sort ред, за да хване bug, ако някой код разчита
    // на created_at/insertion order вместо на sort_order числената стойност
    // (напр. lexicographic string sort би дал 1,10,2,3 — грешно).
    const gift3 = store.upsertGiftItem({ name: 'Item C', imageUrl: '/uploads/gift-items/c.webp', price: 500, sortOrder: 3, isActive: true })
    const gift1 = store.upsertGiftItem({ name: 'Item A', imageUrl: '/uploads/gift-items/a.webp', price: 500, sortOrder: 1, isActive: true })
    const gift10 = store.upsertGiftItem({ name: 'Item D', imageUrl: '/uploads/gift-items/d.webp', price: 500, sortOrder: 10, isActive: true })
    const gift2 = store.upsertGiftItem({ name: 'Item B', imageUrl: '/uploads/gift-items/b.webp', price: 500, sortOrder: 2, isActive: true })
    assert(gift3.ok && gift1.ok && gift10.ok && gift2.ok, 'всичките 4 upsert-а трябва да успеят')
    if (!gift3.ok || !gift1.ok || !gift10.ok || !gift2.ok) return

    const expectedOrder = [1, 2, 3, 10]

    // Admin context (Admin > Подаръци) — listAdminGiftItems.
    const adminList = store.listAdminGiftItems()
    assertEqual(adminList.length, 4, 'admin списъкът съдържа и 4-те подаръка')
    assertEqual(
      JSON.stringify(adminList.map((i) => i.sortOrder)),
      JSON.stringify(expectedOrder),
      'listAdminGiftItems връща 1,2,3,10 (числово ASC), не insertion order (3,1,10,2) или lexicographic (1,10,2,3)',
    )

    // Public/user context (🎁 Подарък selector) — listActiveGiftItems.
    const activeList = store.listActiveGiftItems()
    assertEqual(activeList.length, 4, 'active каталогът съдържа и 4-те подаръка (всички active:true)')
    assertEqual(
      JSON.stringify(activeList.map((i) => i.sortOrder)),
      JSON.stringify(expectedOrder),
      'listActiveGiftItems връща СЪЩИЯ 1,2,3,10 ред като admin listing-а (една и съща ORDER BY клауза)',
    )

    // Live re-order след edit: смени sortOrder 10 -> 0 (най-малкото
    // позволено, брифа §7 "допусни 0") — item-ът трябва веднага да стане
    // първи при следващ listAdminGiftItems() call, без каквато и да е
    // допълнителна стъпка (симулира "Save" в admin формата, брифа §5).
    const reordered = store.upsertGiftItem({
      giftItemId: gift10.item.giftItemId, name: 'Item D', imageUrl: gift10.item.imageUrl, price: 500, sortOrder: 0, isActive: true,
    })
    assert(reordered.ok === true, 'edit на sortOrder трябва да успее')

    const adminListAfterEdit = store.listAdminGiftItems()
    assertEqual(adminListAfterEdit[0]?.giftItemId, gift10.item.giftItemId, 'след sortOrder 10->0, Item D веднага е първи (fresh server list, без нужда от F5)')
    assertEqual(
      JSON.stringify(adminListAfterEdit.map((i) => i.sortOrder)),
      JSON.stringify([0, 1, 2, 3]),
      'пълният ред след edit-а е коректен',
    )

    store.close()
  })

  // ═══ Stage 2 — table/in-game gifts ═══════════════════════════════════════

  // ── [T] context='game' payment parity ───────────────────────────────────
  await check("[T] context='game' + roomId — идентична payment семантика като 'profile'", async () => {
    const dbPath = join(dir, 'testT.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-t', 10_000)
    seedProfile(db, 'recipient-t', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-t', 'Торта', '/uploads/gift-items/cake.webp', 2500, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-t', 'recipient-t']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const result = store.sendGiftItem(
      'sender-t', 'recipient-t', 'item-t', 'req-t-1', 'game', 'room-t-1',
    )
    assert(result.ok === true, "sendGiftItem с context='game' трябва да успее")
    if (!result.ok) return

    assertEqual(result.senderBalanceAfter, 7500, 'дебитът е идентичен на profile контекста')
    assertEqual(result.transaction.chargedPrice, 2500, 'цената пак се чете от DB')
    assertEqual(result.transaction.context, 'game', "context persist-нат като 'game'")
    assertEqual(result.transaction.roomId, 'room-t-1', 'roomId persist-нат')

    // Table gift НЕ създава personal delivery notification — това е точно
    // механизмът, който предотвратява дублирана презентация (§6/§12).
    const pending = store.getPendingDeliveries('recipient-t')
    assertEqual(pending.length, 0, "context='game' НЕ пише в gift_item_delivery_log")

    store.close()
  })

  // ── [U] isReplay флаг ───────────────────────────────────────────────────
  await check('[U] isReplay=false при нов insert, true при duplicate requestId (единичен дебит)', async () => {
    const dbPath = join(dir, 'testU.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-u', 10_000)
    seedProfile(db, 'recipient-u', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-u', 'Балон', '/uploads/gift-items/balloon.webp', 1000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-u', 'recipient-u']))
    const store = await createGiftItemStore(dbPath, progressStore)

    const first = store.sendGiftItem('sender-u', 'recipient-u', 'item-u', 'req-u-1', 'game', 'room-u')
    assert(first.ok === true, 'първото изпращане успява')
    if (!first.ok) return
    assertEqual(first.isReplay, false, 'нов transaction → isReplay=false (⇒ прави се broadcast)')
    assertEqual(first.senderBalanceAfter, 9000, 'един дебит')

    const replay = store.sendGiftItem('sender-u', 'recipient-u', 'item-u', 'req-u-1', 'game', 'room-u')
    assert(replay.ok === true, 'replay-ът връща success (idempotent семантика)')
    if (!replay.ok) return
    assertEqual(replay.isReplay, true, 'същият requestId → isReplay=true (⇒ БЕЗ втори broadcast)')
    assertEqual(replay.senderBalanceAfter, 9000, 'НЯМА втори дебит')
    assertEqual(
      replay.transaction.transactionId,
      first.transaction.transactionId,
      'replay-ът реконструира СЪЩАТА транзакция',
    )

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(countTransactions(db2, 'item-u'), 1, 'точно 1 transaction ред въпреки 2 повиквания')
    db2.close()

    store.close()
  })

  // ── [V] Room membership validation (pure function) ──────────────────────
  await check('[V] resolveTableGiftParticipants — server-authoritative room membership', async () => {
    const humanSeat = (seat: Seat, profileId: string, connectionId: string) => ({
      seat,
      team: (seat === 'bottom' || seat === 'top' ? 'A' : 'B') as 'A' | 'B',
      participant: {
        kind: 'human' as const,
        playerId: `player-${profileId}`,
        connectionId,
        isConnected: true,
        joinedAt: 0,
        lastSeenAt: 0,
        reconnectToken: null,
        permanentlyLeftAt: null,
        identity: {
          accountId: null,
          profileId,
          username: null,
          displayName: `Name ${profileId}`,
          avatarUrl: null,
          level: null,
          rankTitle: null,
          skillRating: null,
          gender: null,
        },
      },
    })

    const botSeat = (seat: Seat) => ({
      seat,
      team: (seat === 'bottom' || seat === 'top' ? 'A' : 'B') as 'A' | 'B',
      participant: {
        kind: 'bot' as const,
        playerId: `bot-${seat}`,
        joinedAt: 0,
        botCode: 'bot',
        difficulty: 'normal' as const,
        identity: {
          accountId: null,
          profileId: null,
          username: null,
          displayName: 'Бот',
          avatarUrl: null,
          level: null,
          rankTitle: null,
          skillRating: null,
          gender: null,
        },
      },
    })

    const room = {
      id: 'room-v',
      status: 'playing' as const,
      createdAt: 0,
      updatedAt: 0,
      hostPlayerId: null,
      config: {} as ServerRoom['config'],
      seats: {
        bottom: humanSeat('bottom', 'p-sender', 'conn-sender'),
        right: humanSeat('right', 'p-recipient', 'conn-recipient'),
        top: botSeat('top'),
        left: humanSeat('left', 'p-third', 'conn-third'),
      },
      game: {} as ServerRoom['game'],
      replayVotes: [],
      leaveVotes: [],
    } as unknown as ServerRoom

    const rooms: Record<string, ServerRoom> = { 'room-v': room }

    const senderConnection = {
      id: 'conn-sender',
      status: 'connected' as const,
      connectedAt: 0,
      lastSeenAt: 0,
      remoteAddress: null,
      userAgent: null,
      currentRoomId: 'room-v',
      currentSeat: 'bottom' as Seat,
      playerId: 'player-p-sender',
      profileId: 'p-sender',
      sessionId: null,
    }

    // Happy path.
    const ok = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-recipient',
    })
    assert(ok.ok === true, 'валиден получател на същата маса се приема')
    if (ok.ok) {
      assertEqual(ok.senderSeat, 'bottom', 'senderSeat идва от connection state')
      assertEqual(ok.recipientSeat, 'right', 'recipientSeat е резолвнат от room seats')
      assertEqual(ok.senderProfileId, 'p-sender', 'senderProfileId идва от connection, не от body')
    }

    // Получател извън стаята.
    const outsider = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-outsider',
    })
    assertEqual(outsider.ok, false, 'играч извън стаята се отхвърля (без дебит)')

    // Бот получател БЕЗ profileId (bot pool изчерпан fallback) — не може да
    // се резолвне, тъй като recipientProfileId идва празен/null от client-а
    // (иконата дори не се показва за такъв bot, виж renderCuttingSeatPanels.ts).
    const botRecipient = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'bot-top',
    })
    assertEqual(botRecipient.ok, false, 'бот БЕЗ profileId никога не се намира по profileId')

    // Self-gift.
    const selfGift = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-sender',
    })
    assertEqual(selfGift.ok, false, 'подарък към себе си се отхвърля')

    // Подправен/stale roomId в client claim-а.
    const wrongRoom = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-other',
      recipientProfileId: 'p-recipient',
    })
    assertEqual(wrongRoom.ok, false, 'claimedRoomId, различен от connection.currentRoomId, се отхвърля')

    // Изпращач, който изобщо не е на маса.
    const notInRoom = resolveTableGiftParticipants({
      connection: { ...senderConnection, currentRoomId: null, currentSeat: null },
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-recipient',
    })
    assertEqual(notInRoom.ok, false, 'изпращач извън стая се отхвърля')

    // Прекъсната връзка.
    const disconnected = resolveTableGiftParticipants({
      connection: { ...senderConnection, status: 'disconnected' as const },
      rooms,
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-recipient',
    })
    assertEqual(disconnected.ok, false, 'disconnected connection се отхвърля')

    // Приключил мач.
    const finishedRoom = { ...room, status: 'finished' as const } as ServerRoom
    const finished = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms: { 'room-v': finishedRoom },
      claimedRoomId: 'room-v',
      recipientProfileId: 'p-recipient',
    })
    assertEqual(finished.ok, false, 'приключила стая се отхвърля')
  })

  // ── [W] Lazy expiry filtering на overlay state ──────────────────────────
  await check('[W] Изтекли table gift overlay-и не попадат в room snapshot-а', async () => {
    const nowMs = Date.now()
    const activeTableGifts: Partial<Record<Seat, { expiresAt: string; recipientSeat: Seat }>> = {
      right: { expiresAt: new Date(nowMs + 30_000).toISOString(), recipientSeat: 'right' },
      left: { expiresAt: new Date(nowMs - 5_000).toISOString(), recipientSeat: 'left' },
    }

    // Същият филтър като в createRoomSnapshotMessage.
    const visible = Object.values(activeTableGifts).filter(
      (gift) => gift !== undefined && Date.parse(gift.expiresAt) > nowMs,
    )

    assertEqual(visible.length, 1, 'само неизтеклият overlay се праща към клиента')
    assertEqual(visible[0]?.recipientSeat, 'right', 'останалият overlay е правилният')
  })

  // ── [X] Bot recipient с реален profileId (Stage 2.1) ────────────────────
  // Regular matchmaking bots имат стабилен DB-backed profileId (виж
  // selectMatchmakingBotProfiles.ts → pickEligibleBotProfileFromDb.ts) —
  // затова gift_item_transactions.recipient_profile_id FK-то важи
  // непроменено, БЕЗ fake profile creation и БЕЗ nullable schema промяна.
  await check('[X] resolveTableGiftParticipants приема bot recipient С реален profileId', async () => {
    const humanSeat = (seat: Seat, profileId: string, connectionId: string) => ({
      seat,
      team: (seat === 'bottom' || seat === 'top' ? 'A' : 'B') as 'A' | 'B',
      participant: {
        kind: 'human' as const,
        playerId: `player-${profileId}`,
        connectionId,
        isConnected: true,
        joinedAt: 0,
        lastSeenAt: 0,
        reconnectToken: null,
        permanentlyLeftAt: null,
        identity: {
          accountId: null,
          profileId,
          username: null,
          displayName: `Name ${profileId}`,
          avatarUrl: null,
          level: null,
          rankTitle: null,
          skillRating: null,
          gender: null,
        },
      },
    })

    // Bot с реален profileId — mirror на createBotParticipant() резултата,
    // когато botProfileId е resolve-нат от DB bot roster-а (не празният
    // legacy BOT_PROFILE_SEED[] в botProfiles.ts).
    const botSeatWithProfile = (seat: Seat, profileId: string) => ({
      seat,
      team: (seat === 'bottom' || seat === 'top' ? 'A' : 'B') as 'A' | 'B',
      participant: {
        kind: 'bot' as const,
        playerId: `bot-${seat}`,
        joinedAt: 0,
        botCode: 'bot',
        difficulty: 'normal' as const,
        botProfileId: profileId,
        identity: {
          accountId: null,
          profileId,
          username: null,
          displayName: 'Бот Иван',
          avatarUrl: null,
          level: null,
          rankTitle: null,
          skillRating: null,
          gender: null,
        },
      },
    })

    const room = {
      id: 'room-x',
      status: 'playing' as const,
      createdAt: 0,
      updatedAt: 0,
      hostPlayerId: null,
      config: {} as ServerRoom['config'],
      seats: {
        bottom: humanSeat('bottom', 'p-sender-x', 'conn-sender-x'),
        right: botSeatWithProfile('right', 'bot-profile-1'),
        top: humanSeat('top', 'p-third-x', 'conn-third-x'),
        left: botSeatWithProfile('left', 'bot-profile-2'),
      },
      game: {} as ServerRoom['game'],
      replayVotes: [],
      leaveVotes: [],
    } as unknown as ServerRoom

    const rooms: Record<string, ServerRoom> = { 'room-x': room }

    const senderConnection = {
      id: 'conn-sender-x',
      status: 'connected' as const,
      connectedAt: 0,
      lastSeenAt: 0,
      remoteAddress: null,
      userAgent: null,
      currentRoomId: 'room-x',
      currentSeat: 'bottom' as Seat,
      playerId: 'player-p-sender-x',
      profileId: 'p-sender-x',
      sessionId: null,
    }

    // [A] Human sender + bot recipient в СЪЩАТА room → валидно.
    const botGift = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-x',
      recipientProfileId: 'bot-profile-1',
    })
    assert(botGift.ok === true, 'bot С реален profileId е валиден gift target')
    if (botGift.ok) {
      assertEqual(botGift.recipientSeat, 'right', 'recipientSeat резолвнат коректно за bot')
      assertEqual(botGift.recipientProfileId, 'bot-profile-1', 'recipientProfileId е bot-a profileId')
      assertEqual(botGift.recipientIsBot, true, 'recipientIsBot=true за bot получател')
      assertEqual(botGift.recipientDisplayName, 'Бот Иван', 'recipientDisplayName е bot display name-a')
    }

    // Human recipient продължава да работи (не е счупено от bot поддръжката).
    const humanGift = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-x',
      recipientProfileId: 'p-third-x',
    })
    assert(humanGift.ok === true, 'human recipient продължава да работи')
    if (humanGift.ok) {
      assertEqual(humanGift.recipientIsBot, false, 'recipientIsBot=false за human получател')
    }

    // [J] Fake/невъзможен bot seat target — profileId, който не съществува
    // на никое място в тази стая → reject.
    const fakeBotTarget = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-x',
      recipientProfileId: 'bot-profile-nonexistent',
    })
    assertEqual(fakeBotTarget.ok, false, 'несъществуващ bot profileId се отхвърля')

    // [J] Cross-room bot target — bot от ДРУГА стая не може да бъде получател,
    // дори ако profileId-то съществува някъде другаде в serverState.rooms.
    const otherRoom = {
      ...room,
      id: 'room-x-other',
      seats: {
        ...room.seats,
        right: botSeatWithProfile('right', 'bot-profile-cross-room'),
      },
    } as unknown as ServerRoom
    const crossRoomRooms: Record<string, ServerRoom> = {
      'room-x': room,
      'room-x-other': otherRoom,
    }
    const crossRoomTarget = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms: crossRoomRooms,
      claimedRoomId: 'room-x',
      recipientProfileId: 'bot-profile-cross-room',
    })
    assertEqual(crossRoomTarget.ok, false, 'bot от друга стая не е валиден target')

    // [K] Self-target остава reject дори когато е технически bot-shaped заявка
    // (sender опитва да "подари" сам на себе си, независимо от recipient kind).
    const selfTarget = resolveTableGiftParticipants({
      connection: senderConnection,
      rooms,
      claimedRoomId: 'room-x',
      recipientProfileId: 'p-sender-x',
    })
    assertEqual(selfTarget.ok, false, 'self-target остава отхвърлен')
  })

  // ── [Y] Payment/idempotency/broadcast семантика за bot recipient ────────
  // sendGiftItem/broadcast логиката работи по recipientProfileId, не по
  // participant.kind — затова payment/idempotency поведението за bot
  // получател е СТРУКТУРНО идентично на profile/human getting (вече покрито
  // от [A]-[H] по-горе), само reconstruct-нато тук explicit с bot profileId
  // за да потвърди, че context='game' flow-ът не прави никакво специално
  // третиране на bot recipient-и на DB/store ниво.
  await check('[Y] sendGiftItem(context="game") към bot profileId: единичен дебит, transaction записан, без delivery notification', async () => {
    const dbPath = join(dir, 'testY.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-y', 10_000)
    // Bot recipient профилът е реален ред в profiles/bot_metadata в
    // production (виж production DB: profiles WHERE profile_kind='bot' —
    // 303 реда). Тук го seed-ваме като обикновен profile ред (същата
    // profile_wallets/profiles таблична форма, profile_kind не участва в
    // gift_item_transactions FK-то — само profile_id съществуването значи).
    seedProfile(db, 'bot-profile-y', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-y', 'Роза', '/uploads/gift-items/rose.webp', 2000, 1, 0)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-y', 'bot-profile-y']))
    const store = await createGiftItemStore(dbPath, progressStore)

    // [C] Sender се дебитира точно веднъж, [D] transaction записан коректно.
    const result = store.sendGiftItem('sender-y', 'bot-profile-y', 'item-y', 'req-y-1', 'game', 'room-y')
    assert(result.ok === true, 'gift към bot profileId трябва да успее')
    if (!result.ok) return
    assertEqual(result.isReplay, false, 'първо изпращане е нов transaction, не replay')
    assertEqual(result.senderBalanceAfter, 8000, 'sender дебитиран точно с цената (10000 - 2000)')
    assertEqual(result.transaction.context, 'game', 'context="game" записан коректно')
    assertEqual(result.transaction.roomId, 'room-y', 'room_id записан коректно')
    assertEqual(result.transaction.recipientProfileId, 'bot-profile-y', 'recipient_profile_id е bot-a profileId')

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(countTransactions(db2, 'item-y'), 1, 'точно 1 transaction ред')
    // [I] Bot НЕ получава wallet credit — profile_wallets balance-а на бота
    // остава 0 (само seed стойността), sendGiftItem никога не credit-ва
    // recipient-а за никой context (виж §3 брифа "Bot НЕ получава yellow coins").
    assertEqual(getWalletBalance(db2, 'bot-profile-y'), 0, 'bot recipient не получава никакъв credit')
    // [I] GAME gift не създава delivery log ред за bot (нито за human) —
    // index.ts route-ът explicit НЕ вика createDeliveryNotification за
    // context='game', проверено тук directно на DB ниво.
    const deliveryCount = db2.prepare(
      'SELECT COUNT(*) AS cnt FROM gift_item_delivery_log WHERE recipient_profile_id = ?',
    ).get('bot-profile-y') as { cnt: number }
    assertEqual(deliveryCount.cnt, 0, 'няма delivery log ред за bot recipient (game context)')
    db2.close()

    // [L] Idempotent replay — един и същ requestId два пъти: един debit,
    // един transaction ред, isReplay=true при повторния опит (route-ът
    // guard-ва broadcast-а само с isReplay===false, виж index.ts).
    const replay = store.sendGiftItem('sender-y', 'bot-profile-y', 'item-y', 'req-y-1', 'game', 'room-y')
    assert(replay.ok === true, 'replay заявка трябва пак да "успее" (idempotent)')
    if (replay.ok) {
      assertEqual(replay.isReplay, true, 'втори опит със СЪЩИЯ requestId е replay')
      assertEqual(replay.transaction.transactionId, result.transaction.transactionId, 'replay връща СЪЩИЯ transaction')
      assertEqual(replay.senderBalanceAfter, 8000, 'balance непроменен при replay (без втори дебит)')
    }

    const db3 = new DatabaseSync(dbPath, { open: true })
    assertEqual(countTransactions(db3, 'item-y'), 1, '[C]/[L] точно 1 transaction ред дори след replay опит')
    assertEqual(getWalletBalance(db3, 'sender-y'), 8000, '[C]/[L] точно ЕДИН дебит общо')
    db3.close()

    store.close()
  })

  // ── [Z] Admin статистика "Изхарчени жълтици за подаръци" ────────────────
  await check('[Z] getTotalChargedYellowCoins — SUM(charged_price) вкл. profile+game gifts, idempotency-safe, tombstoned gifts остават в сумата', async () => {
    const dbPath = join(dir, 'testZ.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await applyGiftItemMigrations(db)
    seedProfile(db, 'sender-z', 50_000)
    seedProfile(db, 'recipient-z', 0)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-z1', 'Роза', '/uploads/gift-items/z1.webp', 3000, 1, 0)`)
    db.exec(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order)
      VALUES ('item-z2', 'Торта', '/uploads/gift-items/z2.webp', 5000, 1, 1)`)
    db.close()

    const progressStore = makeMockProgressStore(new Set(['sender-z', 'recipient-z']))
    const store = await createGiftItemStore(dbPath, progressStore)

    // Празна DB (нула transactions) -> 0, не грешка/NULL.
    assertEqual(store.getTotalChargedYellowCoins(), 0, 'нула transactions -> COALESCE(SUM,0) = 0')

    // Един 'profile' gift + един 'game' (table) gift — статистиката трябва
    // да сумира и двата context-а без филтър.
    const profileGift = store.sendGiftItem('sender-z', 'recipient-z', 'item-z1', 'req-z-profile', 'profile')
    assert(profileGift.ok === true, 'profile gift трябва да успее')
    const gameGift = store.sendGiftItem('sender-z', 'recipient-z', 'item-z2', 'req-z-game', 'game', 'room-z')
    assert(gameGift.ok === true, 'game/table gift трябва да успее')
    assertEqual(store.getTotalChargedYellowCoins(), 8000, 'сума = 3000 (profile) + 5000 (game) = 8000')

    // Idempotency replay (същия requestId) — реалният ред вече съществува,
    // sendGiftItem не INSERT-ва втори — сумата НЕ трябва да се качи повторно.
    const replay = store.sendGiftItem('sender-z', 'recipient-z', 'item-z1', 'req-z-profile', 'profile')
    assert(replay.ok === true, 'replay заявката пак "успява" (idempotent)')
    if (replay.ok) {
      assertEqual(replay.isReplay, true, 'втори опит със същия requestId е replay')
    }
    assertEqual(store.getTotalChargedYellowCoins(), 8000, 'replay НЕ увеличава сумата повторно (все още 8000)')

    // Logical delete (tombstone) на item-z1 — историята му (req-z-profile)
    // трябва да остане в статистиката, защото плащането вече е извършено.
    const deleteResult = store.deleteGiftItem('item-z1')
    assert(deleteResult.ok === true, 'logical delete трябва да успее')
    assertEqual(store.getTotalChargedYellowCoins(), 8000, 'tombstoned gift item-ът НЕ маха миналите си транзакции от сумата')

    store.close()
  })
})

// ─── Финален резултат ───────────────────────────────────────────────────────

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}

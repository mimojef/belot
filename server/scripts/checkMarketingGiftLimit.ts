/**
 * checkMarketingGiftLimit.ts
 *
 * Regression за marketing role gift-coins permission model — mirror на
 * checkYellowCoinGiftLimit.ts (pika_team), но за role='marketing' и фокус
 * изрично върху ТОЧНО тези изисквания от marketing permission model брифа §2/§3:
 *
 *  [1]  marketing: non-friend direct gift (sendGiftToProfile bypass) → ALLOW
 *  [2]  marketing: accepted-friend gift (sendGift) → ALLOW
 *  [3]  marketing: amount = 100 000 (per-transaction max) → ALLOW
 *  [4]  marketing: amount = 100 001 (над max) → DENY
 *  [5]  marketing: в рамките на marketingDailyGiftLimit → ALLOW
 *  [6]  marketing: над marketingDailyGiftLimit → DENY, code MARKETING_DAILY_GIFT_LIMIT_EXCEEDED
 *  [7]  pika_team usage НЕ намалява marketing-овия allowance (независими pools)
 *  [8]  marketing usage НЕ намалява pika_team-овия allowance (независими pools)
 *  [9]  normal player sender (без флагове) НЕ получава privileged bypass/max/limit
 *  [10] Sofia calendar-day reset работи за marketing (вчерашен gift не участва в днешния used)
 *  [11] Admin update на marketingDailyGiftLimit е веднага ефективен, НЕ променя pikaTeamDailyGiftLimit
 *  [12] Recipient 60-дневен window се bypass-ва за marketing sender (mirror на pika_team)
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerProgressStore } from '../src/db/playerProgressStore.js'
import type { AdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createYellowCoinGiftStore } from '../src/db/yellowCoinGiftStore.js'

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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-marketing-gift-limit-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Минимален stub за AdminSettingsStore — само getSettings().pikaTeamDailyGiftLimit/
// marketingDailyGiftLimit се ползват от sendGiftCore §4.5/§4.6.
function makeMockAdminSettingsStore(
  pikaTeamDailyGiftLimit: number = 200_000,
  marketingDailyGiftLimit: number = 200_000,
): AdminSettingsStore {
  return {
    getSettings: () => ({
      signupBonusYellowCoins: 100_000,
      profileNameChangePrice: 50_000,
      vipPrice30DaysCents: 789,
      vipPrice180DaysCents: 3_989,
      vipPrice365DaysCents: 6_989,
      pikaTeamDailyGiftLimit,
      marketingDailyGiftLimit,
    }),
  } as unknown as AdminSettingsStore
}

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
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (yellow_coins_balance >= 0),
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
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      responded_at TEXT NULL,
      kind TEXT NOT NULL DEFAULT 'friend' CHECK (kind IN ('friend', 'pika_support', 'vip_dm')),
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

function applyGiftLedgerSchema(db: DatabaseSync): void {
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
  friendshipId: string | null,
  sender: string,
  recipient: string,
  amount: number,
  createdAt: string,
): void {
  db.exec(`INSERT INTO yellow_coin_gift_ledger
    (gift_id, friendship_id, sender_profile_id, recipient_profile_id, amount,
     sender_balance_after, recipient_balance_after, recipient_limit_exempt, created_at)
    VALUES ('${giftId}', ${friendshipId ? `'${friendshipId}'` : 'NULL'}, '${sender}', '${recipient}', ${amount},
     0, ${amount}, 1, '${createdAt}')`)
}

function utcDaysAgo(n: number): string {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')
}

await withTempDir(async (dir) => {
  await check('[1] marketing: non-friend direct gift (sendGiftToProfile bypass) → ALLOW', async () => {
    const dbPath = join(dir, 'test1.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-1', 1_000_000)
    seedProfile(db, 'stranger-1', 0)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    // isRoleBasedPikaTeamSender=false, isRoleBasedAdminSender=false, isRoleBasedMarketingSender=true
    const result = store.sendGiftToProfile('mkt-1', 'stranger-1', 30_000, false, false, true)
    store.close()

    assert(result.ok === true, `Marketing direct bypass трябва да работи без приятелство: ${JSON.stringify(result)}`)
  })

  await check('[2] marketing: accepted-friend gift (sendGift) → ALLOW', async () => {
    const dbPath = join(dir, 'test2.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-2', 1_000_000)
    seedProfile(db, 'friend-2', 0)
    seedFriendship(db, 'fs-2', 'mkt-2', 'friend-2')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('mkt-2', 'fs-2', 30_000, false, false, true)
    store.close()

    assert(result.ok === true, `Marketing friend gift трябва да работи: ${JSON.stringify(result)}`)
  })

  await check('[3] marketing: amount = 100 000 (per-transaction max) → ALLOW', async () => {
    const dbPath = join(dir, 'test3.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-3', 1_000_000)
    seedProfile(db, 'friend-3', 0)
    seedFriendship(db, 'fs-3', 'mkt-3', 'friend-3')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('mkt-3', 'fs-3', 100_000, false, false, true)
    store.close()

    assert(result.ok === true, `100 000 трябва да е в рамките на marketing per-tx max: ${JSON.stringify(result)}`)
  })

  await check('[4] marketing: amount = 100 001 (над per-transaction max) → DENY', async () => {
    const dbPath = join(dir, 'test4.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-4', 1_000_000)
    seedProfile(db, 'friend-4', 0)
    seedFriendship(db, 'fs-4', 'mkt-4', 'friend-4')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore())
    const result = store.sendGift('mkt-4', 'fs-4', 100_001, false, false, true)
    store.close()

    assert(result.ok === false, '100 001 трябва да се отказва (над marketing per-tx max)')
  })

  await check('[5] marketing: в рамките на marketingDailyGiftLimit → ALLOW', async () => {
    const dbPath = join(dir, 'test5.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-5', 1_000_000)
    seedProfile(db, 'friend-5', 0)
    seedFriendship(db, 'fs-5', 'mkt-5', 'friend-5')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(200_000, 50_000))
    const result = store.sendGift('mkt-5', 'fs-5', 50_000, false, false, true)
    store.close()

    assert(result.ok === true, `50 000 трябва да мине при marketingDailyGiftLimit=50 000: ${JSON.stringify(result)}`)
  })

  await check('[6] marketing: над marketingDailyGiftLimit → DENY, code MARKETING_DAILY_GIFT_LIMIT_EXCEEDED', async () => {
    const dbPath = join(dir, 'test6.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-6', 1_000_000)
    seedProfile(db, 'friend-6a', 0)
    seedProfile(db, 'friend-6b', 0)
    seedFriendship(db, 'fs-6a', 'mkt-6', 'friend-6a')
    seedFriendship(db, 'fs-6b', 'mkt-6', 'friend-6b')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(200_000, 50_000))
    const first = store.sendGift('mkt-6', 'fs-6a', 50_000, false, false, true)
    const second = store.sendGift('mkt-6', 'fs-6b', 1_000, false, false, true)
    store.close()

    assert(first.ok === true, `Първият 50 000 (= limit) трябва да мине: ${JSON.stringify(first)}`)
    assert(second.ok === false, 'Втори gift над изчерпан marketingDailyGiftLimit трябва да се отказва')
    assertEqual((second as { code: string }).code, 'MARKETING_DAILY_GIFT_LIMIT_EXCEEDED', 'code [6]')
  })

  await check('[7] pika_team usage НЕ намалява marketing-овия allowance (независими pools)', async () => {
    const dbPath = join(dir, 'test7.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'pika-7', 1_000_000)
    seedProfile(db, 'mkt-7', 1_000_000)
    seedProfile(db, 'friend-7a', 0)
    seedProfile(db, 'friend-7b', 0)
    seedFriendship(db, 'fs-7a', 'pika-7', 'friend-7a')
    seedFriendship(db, 'fs-7b', 'mkt-7', 'friend-7b')
    db.close()

    const adminSettingsStore = makeMockAdminSettingsStore(50_000, 50_000)
    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)
    // pika_team-ят изхарчва изцяло своя 50 000 pool.
    const pikaGift = store.sendGift('pika-7', 'fs-7a', 50_000, true, false, false)
    // marketing-ът (РАЗЛИЧЕН профил) все още трябва да има пълния си 50 000 allowance.
    const mktGift = store.sendGift('mkt-7', 'fs-7b', 50_000, false, false, true)
    store.close()

    assert(pikaGift.ok === true, `pika_team gift трябва да мине: ${JSON.stringify(pikaGift)}`)
    assert(mktGift.ok === true, `marketing allowance не трябва да е засегнат от pika_team usage: ${JSON.stringify(mktGift)}`)
  })

  await check('[8] marketing usage НЕ намалява pika_team-овия allowance (независими pools)', async () => {
    const dbPath = join(dir, 'test8.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'pika-8', 1_000_000)
    seedProfile(db, 'mkt-8', 1_000_000)
    seedProfile(db, 'friend-8a', 0)
    seedProfile(db, 'friend-8b', 0)
    seedFriendship(db, 'fs-8a', 'mkt-8', 'friend-8a')
    seedFriendship(db, 'fs-8b', 'pika-8', 'friend-8b')
    db.close()

    const adminSettingsStore = makeMockAdminSettingsStore(50_000, 50_000)
    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)
    const mktGift = store.sendGift('mkt-8', 'fs-8a', 50_000, false, false, true)
    const pikaGift = store.sendGift('pika-8', 'fs-8b', 50_000, true, false, false)
    store.close()

    assert(mktGift.ok === true, `marketing gift трябва да мине: ${JSON.stringify(mktGift)}`)
    assert(pikaGift.ok === true, `pika_team allowance не трябва да е засегнат от marketing usage: ${JSON.stringify(pikaGift)}`)
  })

  await check('[9] normal player sender (без флагове) остава на нормалния 30 000 max за sendGift И sendGiftToProfile — няма privileged bypass на amount cap-а', async () => {
    // Забележка: самата friendship-проверка е ЧИСТО route-level gate
    // (isPikaTeamGiftFriendshipBypassSession / isMarketingGiftFriendshipBypassSession
    // в authStore.ts/index.ts) — store-ът (sendGiftToProfile) е "дели ядрото"
    // helper и explicit НЕ прави собствена role/friendship проверка (виж
    // doc коментара на sendGiftToProfile в yellowCoinGiftStore.ts: "тук няма
    // собствена role проверка"). Тук тестваме САМО store-level amount cap-а.
    const dbPath = join(dir, 'test9.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'player-9', 1_000_000)
    seedProfile(db, 'stranger-9', 0)
    seedProfile(db, 'friend-9', 0)
    seedFriendship(db, 'fs-9', 'player-9', 'friend-9')
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(50_000, 50_000))
    const overNormalMaxDirect = store.sendGiftToProfile('player-9', 'stranger-9', 30_001)
    const overNormalMax = store.sendGift('player-9', 'fs-9', 30_001)
    store.close()

    assert(overNormalMaxDirect.ok === false, 'Normal player sendGiftToProfile трябва да е ограничен до normal 30 000 max, не marketing-овия 100 000')
    assert(overNormalMax.ok === false, 'Normal player sendGift трябва да е ограничен до normal 30 000 max, не 100 000')
  })

  await check('[10] Sofia calendar-day reset работи за marketing (вчерашен gift не участва в днешния used)', async () => {
    const dbPath = join(dir, 'test10.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-10', 1_000_000)
    seedProfile(db, 'recipient-10a', 0)
    seedProfile(db, 'recipient-10b', 0)
    seedFriendship(db, 'fs-10a', 'mkt-10', 'recipient-10a')
    seedFriendship(db, 'fs-10b', 'mkt-10', 'recipient-10b')
    // "Вчерашен" ledger ред (48ч назад, гарантирано преди днешната Sofia полунощ).
    seedGiftLedger(db, 'gift-10-old', 'fs-10a', 'mkt-10', 'recipient-10a', 100_000, utcDaysAgo(2))
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(200_000, 100_000))
    const result = store.sendGift('mkt-10', 'fs-10b', 100_000, false, false, true)
    const status = store.getMarketingDailyGiftLimitStatus('mkt-10')
    store.close()

    assert(result.ok === true, `Вчерашен marketing gift не трябва да намалява днешния лимит: ${JSON.stringify(result)}`)
    assertEqual(status.used, 100_000, 'used трябва да отчита само днешния gift [10]')
  })

  await check('[11] Admin update на marketingDailyGiftLimit е веднага ефективен, НЕ променя pikaTeamDailyGiftLimit', async () => {
    const dbPath = join(dir, 'test11.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    db.exec(`
      CREATE TABLE IF NOT EXISTS admin_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    seedProfile(db, 'mkt-11', 2_000_000)
    seedProfile(db, 'recipient-11a', 0)
    seedProfile(db, 'recipient-11b', 0)
    seedFriendship(db, 'fs-11a', 'mkt-11', 'recipient-11a')
    seedFriendship(db, 'fs-11b', 'mkt-11', 'recipient-11b')
    db.close()

    const adminSettingsStore = await createAdminSettingsStore(dbPath)
    const defaultSettings = adminSettingsStore.getSettings()
    assertEqual(defaultSettings.marketingDailyGiftLimit, 200_000, 'fresh DB default marketingDailyGiftLimit трябва да е 200 000')
    assertEqual(defaultSettings.pikaTeamDailyGiftLimit, 200_000, 'fresh DB default pikaTeamDailyGiftLimit трябва да остане 200 000')

    const giftStore = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)
    const withinDefault = giftStore.sendGift('mkt-11', 'fs-11a', 100_000, false, false, true)
    assert(withinDefault.ok === true, `100 000 в рамките на default 200 000 трябва да мине: ${JSON.stringify(withinDefault)}`)

    const updateResult = adminSettingsStore.updateSettings({ marketingDailyGiftLimit: 5_000 })
    assert(updateResult.ok === true, `Admin update трябва да успее: ${JSON.stringify(updateResult)}`)
    assertEqual(adminSettingsStore.getSettings().pikaTeamDailyGiftLimit, 200_000, 'pikaTeamDailyGiftLimit не трябва да се промени от marketingDailyGiftLimit update')

    const giftStore2 = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), adminSettingsStore)
    // used вече е 100 000 (от преди) — remaining спрямо новия 5 000 лимит e 0 (used > limit).
    const overNewLimit = giftStore2.sendGift('mkt-11', 'fs-11b', 1_000, false, false, true)
    giftStore.close()
    giftStore2.close()
    adminSettingsStore.close()

    assert(overNewLimit.ok === false, 'След admin decrease на marketingDailyGiftLimit до 5 000 (под вече използваните 100 000), нов gift трябва да се отказва')
    assertEqual((overNewLimit as { code: string }).code, 'MARKETING_DAILY_GIFT_LIMIT_EXCEEDED', 'code [11]')
  })

  await check('[12] Recipient 60-дневен window се bypass-ва за marketing sender (mirror на pika_team)', async () => {
    const dbPath = join(dir, 'test12.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA foreign_keys = ON;')
    buildBaseSchema(db)
    applyGiftLedgerSchema(db)
    seedProfile(db, 'mkt-12', 1_000_000)
    seedProfile(db, 'recipient-12', 0)
    seedProfile(db, 'other-sender-12', 0)
    seedFriendship(db, 'fs-12a', 'mkt-12', 'recipient-12')
    // recipient-12 вече е на 30 000/60-дни window cap (non-exempt предходен gift).
    db.exec(`INSERT INTO yellow_coin_gift_ledger
      (gift_id, friendship_id, sender_profile_id, recipient_profile_id, amount,
       sender_balance_after, recipient_balance_after, recipient_limit_exempt, created_at)
      VALUES ('gift-12-prior', NULL, 'other-sender-12', 'recipient-12', 30_000, 0, 30_000, 0, '${utcDaysAgo(1)}')`)
    db.close()

    const store = await createYellowCoinGiftStore(dbPath, makeMockProgressStore(), makeMockAdminSettingsStore(200_000, 200_000))
    const result = store.sendGift('mkt-12', 'fs-12a', 50_000, false, false, true)
    store.close()

    assert(result.ok === true, `Marketing sender трябва да bypass-ва recipient window cap-а: ${JSON.stringify(result)}`)
  })
})

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}

/**
 * Focused check: getAdminPaymentListByPeriod() + GET /api/admin/payments endpoint
 *
 * Store-level checks (in-process, no HTTP):
 *   [1]  Empty DB → total=0, rows=[]
 *   [2]  paid record appears with all JOIN fields
 *   [2b] paid record with credited_at NULL is excluded everywhere including allTime
 *   [3]  Period grouping uses credited_at, not created_at
 *   [4]  today: Sofia calendar day boundary (fixed clock)
 *   [4b] yesterday: Sofia calendar day boundary
 *   [4c] DST boundary: EEST→EET (last Sunday of October 2026)
 *   [5]  last7days: calendar-based (today + 6 prior days), not rolling 168h
 *   [5b] last7days: day-7 in, day-8 out
 *   [6]  thisMonth: from Sofia midnight on the 1st
 *   [7]  allTime: includes all paid records with non-null credited_at
 *   [8]  Pagination: limit/offset, total stable across pages
 *   [9]  Sort: credited_at DESC, purchase_id DESC (stable)
 *   [10] summary.totalsByCurrency covers full period, not just the page
 *   [11] summary (getAdminPaymentStats) and list use identical boundaries
 *   [12] hidden_at records included (admin sees all paid)
 *   [13] Missing profile (LEFT JOIN): displayName=null, profileKind=null
 *   [14] Missing account (profile without account_id): email=null
 *   [15] getAdminPaymentStats() uses Sofia boundaries (not UTC)
 *   [15b] credited_at NULL excluded from stats as well
 *
 * HTTP endpoint checks (live server):
 *   [16] 401 without cookie
 *   [17] 403 with non-admin cookie
 *   [18] 400 + errorCode=INVALID_PERIOD for invalid/missing period
 *   [19] 200 + correct shape for each valid period
 *   [20] limit clamping: >100 → 100; absent → 50
 *   [20b] limit=0 → 400 INVALID_LIMIT
 *   [20c] limit=abc → 400 INVALID_LIMIT
 *   [20d] limit=1.5 → 400 INVALID_LIMIT
 *   [20e] limit=10abc → 400 INVALID_LIMIT
 *   [20f] limit=-1 → 400 INVALID_LIMIT
 *   [21] offset absent → 0
 *   [21b] offset=abc → 400 INVALID_OFFSET
 *   [21c] offset=-1 → 400 INVALID_OFFSET
 *   [21d] offset=1.5 → 400 INVALID_OFFSET
 *   [21e] offset=10abc → 400 INVALID_OFFSET
 *   [22] pagination.hasMore correct
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createCoinPurchaseStore, ADMIN_PAYMENT_PERIODS } from '../src/db/coinPurchaseStore.js'
import { getSofiaDayBoundsUtc, sofiaMidnightUtc, toSqliteUtc } from '../src/db/sofiaDayBounds.js'

// ─── Брояч ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function makeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human',
      username TEXT NULL,
      normalized_username TEXT NULL,
      display_name TEXT NOT NULL,
      normalized_display_name TEXT NOT NULL,
      avatar_url TEXT NULL,
      level INTEGER NOT NULL DEFAULT 1,
      rank_title TEXT NULL,
      skill_rating INTEGER NOT NULL DEFAULT 1000,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'player',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT NULL
    );
    CREATE TABLE IF NOT EXISTS coin_packages (
      package_id TEXT PRIMARY KEY,
      package_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS coin_purchase_ledger (
      purchase_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      package_id TEXT,
      package_key_snapshot TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL,
      price_cents INTEGER NOT NULL,
      currency TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      credited_at TEXT,
      hidden_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function insertPaid(
  db: DatabaseSync,
  opts: {
    purchaseId?: string
    profileId: string
    creditedAt: string | null
    createdAt?: string
    priceCents?: number
    currency?: string
    hiddenAt?: string | null
  },
): string {
  const id = opts.purchaseId ?? randomUUID()
  const createdAt = opts.createdAt ?? opts.creditedAt ?? '2026-06-15 10:00:00'
  const credited = opts.creditedAt ? `'${opts.creditedAt}'` : 'NULL'
  const hidden   = opts.hiddenAt   ? `'${opts.hiddenAt}'`   : 'NULL'
  db.exec(`
    INSERT INTO coin_purchase_ledger (
      purchase_id, profile_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, price_cents, currency, provider, status,
      credited_at, hidden_at, created_at, updated_at
    ) VALUES (
      '${id}', '${opts.profileId}', 'starter', 'Starter Pack',
      100, ${opts.priceCents ?? 499}, '${opts.currency ?? 'eur'}', 'stripe', 'paid',
      ${credited}, ${hidden}, '${createdAt}', '${createdAt}'
    )
  `)
  return id
}

function insertProfile(db: DatabaseSync, profileId: string, accountId: string | null, displayName: string): void {
  const aid = accountId ? `'${accountId}'` : 'NULL'
  db.exec(`
    INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name)
    VALUES ('${profileId}', ${aid}, '${displayName}', '${displayName.toLowerCase()}')
  `)
}

function insertAccount(db: DatabaseSync, accountId: string, email: string): void {
  db.exec(`
    INSERT INTO accounts (account_id, email, password_hash, role)
    VALUES ('${accountId}', '${email}', 'x', 'player')
  `)
}

async function retryRmDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 200))
  }
}

async function withDb(fn: (dbPath: string, db: DatabaseSync) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-payments-'))
  const dbPath = join(dir, 'test.sqlite')
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: false })
  db.exec('PRAGMA journal_mode = WAL;')
  makeSchema(db)
  try {
    await fn(dbPath, db)
  } finally {
    try { db.close() } catch { /* already closed */ }
    await retryRmDir(dir)
  }
}

// ─── [1] Empty DB ─────────────────────────────────────────────────────────────

console.log('\n[1] Empty DB → total=0, rows=[]')
await withDb(async (dbPath, db) => {
  db.close()
  const store = await createCoinPurchaseStore(dbPath)
  try {
    const fixedNow = new Date('2026-06-15T12:00:00Z')
    for (const period of ADMIN_PAYMENT_PERIODS) {
      const r = store.getAdminPaymentListByPeriod({ period, limit: 50, offset: 0, now: fixedNow })
      await check(`[1.${period}] total=0`, () => { if (r.total !== 0) throw new Error(`total=${r.total}`) })
      await check(`[1.${period}] rows=[]`, () => { if (r.rows.length !== 0) throw new Error(`rows.length=${r.rows.length}`) })
    }
  } finally { store.close() }
})

// ─── [2] paid record — all JOIN fields ────────────────────────────────────────

console.log('\n[2] Paid record with JOIN: all fields populated')
await withDb(async (dbPath, db) => {
  insertAccount(db, 'acc1', 'player@test.com')
  insertProfile(db, 'p1', 'acc1', 'Тест Играч')
  const creditedAt = '2026-06-15 10:00:00'
  const id = insertPaid(db, { profileId: 'p1', creditedAt, priceCents: 999, currency: 'eur' })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const fixedNow = new Date('2026-06-15T12:00:00Z')
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0, now: fixedNow })
    await check('[2.1] total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    const row = r.rows[0]!
    await check('[2.2] purchaseId', () => { if (row.purchaseId !== id) throw new Error(`purchaseId=${row.purchaseId}`) })
    await check('[2.3] profileId=p1', () => { if (row.profileId !== 'p1') throw new Error(`profileId=${row.profileId}`) })
    await check('[2.4] accountId=acc1', () => { if (row.accountId !== 'acc1') throw new Error(`accountId=${row.accountId}`) })
    await check('[2.5] displayName', () => { if (row.displayName !== 'Тест Играч') throw new Error(`displayName=${row.displayName}`) })
    await check('[2.6] email', () => { if (row.email !== 'player@test.com') throw new Error(`email=${row.email}`) })
    await check('[2.7] priceCents=999', () => { if (row.priceCents !== 999) throw new Error(`priceCents=${row.priceCents}`) })
    await check('[2.8] currency=EUR (uppercase)', () => { if (row.currency !== 'EUR') throw new Error(`currency=${row.currency}`) })
    await check('[2.9] status=paid', () => { if (row.status !== 'paid') throw new Error(`status=${row.status}`) })
    await check('[2.10] creditedAt set', () => { if (!row.creditedAt) throw new Error('creditedAt null') })
    await check('[2.11] hiddenAt=null', () => { if (row.hiddenAt !== null) throw new Error(`hiddenAt=${row.hiddenAt}`) })
    await check('[2.12] totalsByCurrency.EUR=999', () => {
      if (r.totalsByCurrency['EUR'] !== 999) throw new Error(`totalsByCurrency.EUR=${r.totalsByCurrency['EUR']}`)
    })
  } finally { store.close() }
})

// ─── [2b] paid + credited_at NULL → excluded everywhere ───────────────────────

console.log('\n[2b] paid record with credited_at=NULL excluded from all periods including allTime')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p2b', null, 'P2b')
  // A legitimate paid record
  insertPaid(db, { purchaseId: 'real-paid',   profileId: 'p2b', creditedAt: '2026-06-15 10:00:00' })
  // A paid record with credited_at=NULL (data anomaly — must never appear)
  insertPaid(db, { purchaseId: 'null-credit', profileId: 'p2b', creditedAt: null })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const fixedNow = new Date('2026-06-15T12:00:00Z')
    for (const period of ADMIN_PAYMENT_PERIODS) {
      const r = store.getAdminPaymentListByPeriod({ period, limit: 50, offset: 0, now: fixedNow })
      await check(`[2b.${period}] null-credit excluded`, () => {
        if (r.rows.some(x => x.purchaseId === 'null-credit')) {
          throw new Error('null-credit appeared in results')
        }
      })
    }
    // allTime must contain exactly 1 (the real paid record)
    const allTime = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0, now: fixedNow })
    await check('[2b.allTime total=1]', () => {
      if (allTime.total !== 1) throw new Error(`total=${allTime.total}`)
    })
  } finally { store.close() }
})

// ─── [3] credited_at used for period, NOT created_at ──────────────────────────

console.log('\n[3] Period grouping uses credited_at, not created_at')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p3', null, 'P3')
  const fixedNow   = new Date('2026-06-15T12:00:00Z')
  const bounds     = getSofiaDayBoundsUtc(fixedNow)
  const creditedAt = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 2 * 3_600_000))
  const createdAt  = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
  insertPaid(db, { profileId: 'p3', creditedAt, createdAt })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const today     = store.getAdminPaymentListByPeriod({ period: 'today',     limit: 50, offset: 0, now: fixedNow })
    const yesterday = store.getAdminPaymentListByPeriod({ period: 'yesterday', limit: 50, offset: 0, now: fixedNow })
    await check('[3.1] today: total=0 (credited_at is yesterday)', () => {
      if (today.total !== 0) throw new Error(`today.total=${today.total}`)
    })
    await check('[3.2] yesterday: total=1 (credited_at is yesterday)', () => {
      if (yesterday.total !== 1) throw new Error(`yesterday.total=${yesterday.total}`)
    })
  } finally { store.close() }
})

// ─── [4] today: Sofia calendar day boundary ───────────────────────────────────

console.log('\n[4] today: Sofia calendar day boundary (fixed clock 2026-06-15T12:00Z)')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p4', null, 'P4')
  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)
  const inToday    = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))
  const inYest     = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() - 1_000))
  const inTomorrow = toSqliteUtc(new Date(new Date(bounds.tomorrowStart + 'Z').getTime() + 1_000))
  insertPaid(db, { purchaseId: 'p4-today',    profileId: 'p4', creditedAt: inToday })
  insertPaid(db, { purchaseId: 'p4-yest',     profileId: 'p4', creditedAt: inYest })
  insertPaid(db, { purchaseId: 'p4-tomorrow', profileId: 'p4', creditedAt: inTomorrow })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'today', limit: 50, offset: 0, now: fixedNow })
    await check('[4.1] today: total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    await check('[4.2] today: correct row', () => {
      if (r.rows[0]?.purchaseId !== 'p4-today') throw new Error(`row=${r.rows[0]?.purchaseId}`)
    })
  } finally { store.close() }
})

// ─── [4b] yesterday boundary ──────────────────────────────────────────────────

console.log('\n[4b] yesterday: Sofia calendar day boundary')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p4b', null, 'P4b')
  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)
  const inYest   = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 3_600_000))
  const inToday  = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))
  const before   = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() - 1_000))
  insertPaid(db, { purchaseId: 'p4b-yest',   profileId: 'p4b', creditedAt: inYest })
  insertPaid(db, { purchaseId: 'p4b-today',  profileId: 'p4b', creditedAt: inToday })
  insertPaid(db, { purchaseId: 'p4b-before', profileId: 'p4b', creditedAt: before })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'yesterday', limit: 50, offset: 0, now: fixedNow })
    await check('[4b.1] yesterday: total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    await check('[4b.2] yesterday: correct row', () => {
      if (r.rows[0]?.purchaseId !== 'p4b-yest') throw new Error(`row=${r.rows[0]?.purchaseId}`)
    })
  } finally { store.close() }
})

// ─── [4c] DST boundary ────────────────────────────────────────────────────────

console.log('\n[4c] DST boundary: EEST→EET (2026-10-25)')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p4c', null, 'P4c')
  const fixedNow = new Date('2026-10-25T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)
  const sofiaOct25Midnight = sofiaMidnightUtc(2026, 10, 25)
  const inToday = toSqliteUtc(new Date(sofiaOct25Midnight.getTime() + 30 * 60_000))
  const inYest  = toSqliteUtc(new Date(sofiaOct25Midnight.getTime() - 30 * 60_000))
  insertPaid(db, { purchaseId: 'dst-today', profileId: 'p4c', creditedAt: inToday })
  insertPaid(db, { purchaseId: 'dst-yest',  profileId: 'p4c', creditedAt: inYest })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const today     = store.getAdminPaymentListByPeriod({ period: 'today',     limit: 50, offset: 0, now: fixedNow })
    const yesterday = store.getAdminPaymentListByPeriod({ period: 'yesterday', limit: 50, offset: 0, now: fixedNow })
    await check('[4c.1] DST today: total=1', () => { if (today.total !== 1) throw new Error(`today.total=${today.total}`) })
    await check('[4c.2] DST today: correct row', () => {
      if (today.rows[0]?.purchaseId !== 'dst-today') throw new Error(`row=${today.rows[0]?.purchaseId}`)
    })
    await check('[4c.3] DST yesterday: total=1', () => { if (yesterday.total !== 1) throw new Error(`yesterday.total=${yesterday.total}`) })
    await check('[4c.4] DST yesterday: correct row', () => {
      if (yesterday.rows[0]?.purchaseId !== 'dst-yest') throw new Error(`row=${yesterday.rows[0]?.purchaseId}`)
    })
    await check('[4c.5] todayStart is not UTC midnight (Sofia TZ applied)', () => {
      if (bounds.todayStart === '2026-10-25 00:00:00') throw new Error('todayStart is UTC midnight')
    })
  } finally { store.close() }
})

// ─── [5] last7days: calendar-based ────────────────────────────────────────────

console.log('\n[5] last7days: calendar-based (today + 6 prior days)')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p5', null, 'P5')
  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const d1 = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 15).getTime() + 3_600_000))
  const d7 = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 9).getTime()  + 3_600_000))
  const d8 = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 8).getTime()  + 3_600_000))
  insertPaid(db, { purchaseId: '7d-d1', profileId: 'p5', creditedAt: d1 })
  insertPaid(db, { purchaseId: '7d-d7', profileId: 'p5', creditedAt: d7 })
  insertPaid(db, { purchaseId: '7d-d8', profileId: 'p5', creditedAt: d8 })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'last7days', limit: 50, offset: 0, now: fixedNow })
    await check('[5.1] last7days: total=2 (d1+d7 in, d8 out)', () => {
      if (r.total !== 2) throw new Error(`total=${r.total}`)
    })
    await check('[5.2] d1 included', () => { if (!r.rows.some(x => x.purchaseId === '7d-d1')) throw new Error('d1 missing') })
    await check('[5.3] d7 included', () => { if (!r.rows.some(x => x.purchaseId === '7d-d7')) throw new Error('d7 missing') })
    await check('[5.4] d8 excluded', () => { if (r.rows.some(x => x.purchaseId === '7d-d8')) throw new Error('d8 should be excluded') })
  } finally { store.close() }
})

// ─── [5b] last7days — day 9 Sofia (Sofia midnight) is in window ───────────────

console.log('\n[5b] last7days: June 9 Sofia midnight (+30min) is inside window')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p5b', null, 'P5b')
  const fixedNow   = new Date('2026-06-15T00:00:00Z')
  const june9sofia = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 9).getTime() + 30 * 60_000))
  insertPaid(db, { purchaseId: '7b-in', profileId: 'p5b', creditedAt: june9sofia })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'last7days', limit: 50, offset: 0, now: fixedNow })
    await check('[5b.1] June 9 (day 7) inside last7days', () => {
      if (r.total !== 1) throw new Error(`total=${r.total}`)
    })
  } finally { store.close() }
})

// ─── [6] thisMonth ────────────────────────────────────────────────────────────

console.log('\n[6] thisMonth: from Sofia midnight on the 1st')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p6', null, 'P6')
  const fixedNow    = new Date('2026-06-15T12:00:00Z')
  const inMonth     = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 3).getTime()  + 3_600_000))
  const onFirst     = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 1).getTime()  + 60_000))
  const beforeFirst = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 6, 1).getTime()  - 1_000))
  const nextMonth   = toSqliteUtc(new Date(sofiaMidnightUtc(2026, 7, 1).getTime()  + 3_600_000))
  insertPaid(db, { purchaseId: 'm-in',        profileId: 'p6', creditedAt: inMonth })
  insertPaid(db, { purchaseId: 'm-first',     profileId: 'p6', creditedAt: onFirst })
  insertPaid(db, { purchaseId: 'm-before',    profileId: 'p6', creditedAt: beforeFirst })
  insertPaid(db, { purchaseId: 'm-nextmonth', profileId: 'p6', creditedAt: nextMonth })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'thisMonth', limit: 50, offset: 0, now: fixedNow })
    await check('[6.1] thisMonth: total=2', () => { if (r.total !== 2) throw new Error(`total=${r.total}`) })
    await check('[6.2] m-before excluded',   () => { if (r.rows.some(x => x.purchaseId === 'm-before'))    throw new Error('m-before should be excluded') })
    await check('[6.3] m-nextmonth excluded', () => { if (r.rows.some(x => x.purchaseId === 'm-nextmonth')) throw new Error('m-nextmonth should be excluded') })
  } finally { store.close() }
})

// ─── [7] allTime ──────────────────────────────────────────────────────────────

console.log('\n[7] allTime: includes all paid with non-null credited_at')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p7', null, 'P7')
  insertPaid(db, { purchaseId: 'at-1', profileId: 'p7', creditedAt: '2020-01-01 00:00:00' })
  insertPaid(db, { purchaseId: 'at-2', profileId: 'p7', creditedAt: '2023-06-15 10:00:00' })
  insertPaid(db, { purchaseId: 'at-3', profileId: 'p7', creditedAt: '2026-06-15 10:00:00' })
  insertPaid(db, { purchaseId: 'at-null', profileId: 'p7', creditedAt: null })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0 })
    await check('[7.1] allTime: total=3 (null excluded)', () => { if (r.total !== 3) throw new Error(`total=${r.total}`) })
    await check('[7.2] at-null not in rows', () => {
      if (r.rows.some(x => x.purchaseId === 'at-null')) throw new Error('at-null appeared')
    })
  } finally { store.close() }
})

// ─── [8] Pagination ───────────────────────────────────────────────────────────

console.log('\n[8] Pagination: limit/offset, total stable')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p8', null, 'P8')
  for (let i = 0; i < 7; i++) {
    insertPaid(db, { profileId: 'p8', creditedAt: `2026-06-15 ${String(10 + i).padStart(2, '0')}:00:00` })
  }
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const p1 = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 3, offset: 0 })
    const p2 = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 3, offset: 3 })
    const p3 = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 3, offset: 6 })
    await check('[8.1] total=7 across all pages', () => {
      if (p1.total !== 7) throw new Error(`p1.total=${p1.total}`)
      if (p2.total !== 7) throw new Error(`p2.total=${p2.total}`)
      if (p3.total !== 7) throw new Error(`p3.total=${p3.total}`)
    })
    await check('[8.2] page1: 3 rows', () => { if (p1.rows.length !== 3) throw new Error(`p1=${p1.rows.length}`) })
    await check('[8.3] page2: 3 rows', () => { if (p2.rows.length !== 3) throw new Error(`p2=${p2.rows.length}`) })
    await check('[8.4] page3: 1 row',  () => { if (p3.rows.length !== 1) throw new Error(`p3=${p3.rows.length}`) })
    await check('[8.5] pages non-overlapping', () => {
      const ids1 = new Set(p1.rows.map(r => r.purchaseId))
      const ids2 = new Set(p2.rows.map(r => r.purchaseId))
      const ids3 = new Set(p3.rows.map(r => r.purchaseId))
      if ([...ids2].some(id => ids1.has(id))) throw new Error('overlap p1/p2')
      if ([...ids3].some(id => ids1.has(id))) throw new Error('overlap p1/p3')
      if ([...ids3].some(id => ids2.has(id))) throw new Error('overlap p2/p3')
    })
  } finally { store.close() }
})

// ─── [9] Sort ─────────────────────────────────────────────────────────────────

console.log('\n[9] Sort: credited_at DESC, purchase_id DESC (stable)')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p9', null, 'P9')
  insertPaid(db, { purchaseId: 'sort-aaa', profileId: 'p9', creditedAt: '2026-06-15 10:00:00' })
  insertPaid(db, { purchaseId: 'sort-zzz', profileId: 'p9', creditedAt: '2026-06-15 10:00:00' })
  insertPaid(db, { purchaseId: 'sort-old', profileId: 'p9', creditedAt: '2026-06-14 10:00:00' })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0 })
    await check('[9.1] first: sort-zzz', () => {
      if (r.rows[0]?.purchaseId !== 'sort-zzz') throw new Error(`first=${r.rows[0]?.purchaseId}`)
    })
    await check('[9.2] second: sort-aaa', () => {
      if (r.rows[1]?.purchaseId !== 'sort-aaa') throw new Error(`second=${r.rows[1]?.purchaseId}`)
    })
    await check('[9.3] last: sort-old', () => {
      const last = r.rows[r.rows.length - 1]
      if (last?.purchaseId !== 'sort-old') throw new Error(`last=${last?.purchaseId}`)
    })
  } finally { store.close() }
})

// ─── [10] totalsByCurrency covers full period ──────────────────────────────────

console.log('\n[10] summary.totalsByCurrency: full period, not just page')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p10', null, 'P10')
  for (let i = 0; i < 5; i++) {
    insertPaid(db, { profileId: 'p10', creditedAt: `2026-06-15 1${i}:00:00`, priceCents: 100, currency: 'eur' })
  }
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const p1 = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 2, offset: 0 })
    await check('[10.1] totalsByCurrency.EUR=500', () => {
      if (p1.totalsByCurrency['EUR'] !== 500) throw new Error(`EUR=${p1.totalsByCurrency['EUR']}`)
    })
    await check('[10.2] total=5', () => { if (p1.total !== 5) throw new Error(`total=${p1.total}`) })
    await check('[10.3] rows=2 (page 1)',  () => { if (p1.rows.length !== 2) throw new Error(`rows=${p1.rows.length}`) })
  } finally { store.close() }
})

// ─── [11] summary and list: identical boundaries ──────────────────────────────

console.log('\n[11] summary (getAdminPaymentStats) and list use identical boundaries')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p11', null, 'P11')
  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)
  const inToday = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))
  const inYest  = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 3_600_000))
  insertPaid(db, { purchaseId: '11-today', profileId: 'p11', creditedAt: inToday, priceCents: 200 })
  insertPaid(db, { purchaseId: '11-yest',  profileId: 'p11', creditedAt: inYest,  priceCents: 100 })
  // A null-credited record — must not affect either summary or list
  insertPaid(db, { purchaseId: '11-null',  profileId: 'p11', creditedAt: null,    priceCents: 999 })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const stats     = store.getAdminPaymentStats(fixedNow)
    const listToday = store.getAdminPaymentListByPeriod({ period: 'today',     limit: 50, offset: 0, now: fixedNow })
    const listYest  = store.getAdminPaymentListByPeriod({ period: 'yesterday', limit: 50, offset: 0, now: fixedNow })
    const listAll   = store.getAdminPaymentListByPeriod({ period: 'allTime',   limit: 50, offset: 0, now: fixedNow })
    await check('[11.1] stats.today.count === list today total', () => {
      if (stats.today.count !== listToday.total) throw new Error(`stats=${stats.today.count}, list=${listToday.total}`)
    })
    await check('[11.2] stats.today.totalCents === list today EUR', () => {
      if (stats.today.totalCents !== (listToday.totalsByCurrency['EUR'] ?? 0)) {
        throw new Error(`stats=${stats.today.totalCents}, list=${listToday.totalsByCurrency['EUR']}`)
      }
    })
    await check('[11.3] stats.yesterday.count === list yesterday total', () => {
      if (stats.yesterday.count !== listYest.total) throw new Error(`stats=${stats.yesterday.count}, list=${listYest.total}`)
    })
    await check('[11.4] allTime excludes null-credited (total=2)', () => {
      if (listAll.total !== 2) throw new Error(`allTime.total=${listAll.total}`)
    })
    await check('[11.5] stats.allTime excludes null-credited (count=2)', () => {
      if (stats.allTime.count !== 2) throw new Error(`stats.allTime.count=${stats.allTime.count}`)
    })
  } finally { store.close() }
})

// ─── [12] hidden_at included ──────────────────────────────────────────────────

console.log('\n[12] hidden_at: admin list includes paid records regardless of hidden_at')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p12', null, 'P12')
  insertPaid(db, { purchaseId: 'hidden-paid', profileId: 'p12', creditedAt: '2026-06-15 10:00:00', hiddenAt: '2026-06-15 11:00:00' })
  insertPaid(db, { purchaseId: 'visible',     profileId: 'p12', creditedAt: '2026-06-15 10:00:00' })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0 })
    await check('[12.1] total=2', () => { if (r.total !== 2) throw new Error(`total=${r.total}`) })
    await check('[12.2] hidden-paid present with hiddenAt set', () => {
      const row = r.rows.find(x => x.purchaseId === 'hidden-paid')
      if (!row) throw new Error('hidden-paid missing')
      if (!row.hiddenAt) throw new Error('hiddenAt should be set')
    })
    await check('[12.3] visible: hiddenAt=null', () => {
      const row = r.rows.find(x => x.purchaseId === 'visible')
      if (!row) throw new Error('visible missing')
      if (row.hiddenAt !== null) throw new Error(`hiddenAt=${row.hiddenAt}`)
    })
  } finally { store.close() }
})

// ─── [13] Missing profile (LEFT JOIN) ─────────────────────────────────────────

console.log('\n[13] Missing profile: displayName=null, profileKind=null')
await withDb(async (dbPath, db) => {
  db.exec(`
    INSERT INTO coin_purchase_ledger (
      purchase_id, profile_id, package_key_snapshot, title_snapshot,
      yellow_coins_amount, price_cents, currency, provider, status,
      credited_at, created_at, updated_at
    ) VALUES (
      'orphan-1', 'ghost-profile', 'starter', 'Starter Pack',
      100, 499, 'eur', 'stripe', 'paid',
      '2026-06-15 10:00:00', '2026-06-15 10:00:00', '2026-06-15 10:00:00'
    )
  `)
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0 })
    await check('[13.1] total=1', () => { if (r.total !== 1) throw new Error(`total=${r.total}`) })
    const row = r.rows[0]!
    await check('[13.2] displayName=null', () => { if (row.displayName !== null) throw new Error(`displayName=${row.displayName}`) })
    await check('[13.3] profileKind=null', () => { if (row.profileKind !== null) throw new Error(`profileKind=${row.profileKind}`) })
    await check('[13.4] accountId=null',   () => { if (row.accountId !== null)   throw new Error(`accountId=${row.accountId}`) })
    await check('[13.5] email=null',       () => { if (row.email !== null)       throw new Error(`email=${row.email}`) })
  } finally { store.close() }
})

// ─── [14] Missing account ─────────────────────────────────────────────────────

console.log('\n[14] Missing account: profile without account_id → email=null')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p14-no-acc', null, 'NoAccount')
  insertPaid(db, { purchaseId: 'no-acc', profileId: 'p14-no-acc', creditedAt: '2026-06-15 10:00:00' })
  db.close()

  const store = await createCoinPurchaseStore(dbPath)
  try {
    const r = store.getAdminPaymentListByPeriod({ period: 'allTime', limit: 50, offset: 0 })
    const row = r.rows[0]!
    await check('[14.1] email=null',       () => { if (row.email !== null)       throw new Error(`email=${row.email}`) })
    await check('[14.2] accountId=null',   () => { if (row.accountId !== null)   throw new Error(`accountId=${row.accountId}`) })
    await check('[14.3] displayName set',  () => { if (row.displayName !== 'NoAccount') throw new Error(`displayName=${row.displayName}`) })
    await check('[14.4] profileKind set',  () => { if (row.profileKind !== 'human') throw new Error(`profileKind=${row.profileKind}`) })
  } finally { store.close() }
})

// ─── [15] getAdminPaymentStats uses Sofia boundaries ──────────────────────────

console.log('\n[15] getAdminPaymentStats() uses Sofia boundaries (not UTC)')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p15', null, 'P15')
  const sofiaMidnightJune15 = sofiaMidnightUtc(2026, 6, 15)
  const justAfterMidnight   = toSqliteUtc(new Date(sofiaMidnightJune15.getTime() + 30 * 60_000))
  insertPaid(db, { profileId: 'p15', creditedAt: justAfterMidnight, priceCents: 300 })
  db.close()

  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const store = await createCoinPurchaseStore(dbPath)
  try {
    const stats = store.getAdminPaymentStats(fixedNow)
    await check('[15.1] stats.today.count=1', () => {
      if (stats.today.count !== 1) throw new Error(`today.count=${stats.today.count}`)
    })
    await check('[15.2] stats.yesterday.count=0', () => {
      if (stats.yesterday.count !== 0) throw new Error(`yesterday.count=${stats.yesterday.count}`)
    })
  } finally { store.close() }
})

// ─── [15b] credited_at NULL excluded from stats ────────────────────────────────

console.log('\n[15b] credited_at NULL excluded from getAdminPaymentStats()')
await withDb(async (dbPath, db) => {
  insertProfile(db, 'p15b', null, 'P15b')
  insertPaid(db, { profileId: 'p15b', creditedAt: '2026-06-15 10:00:00', priceCents: 500 })
  insertPaid(db, { profileId: 'p15b', creditedAt: null,                  priceCents: 999 })
  db.close()

  const fixedNow = new Date('2026-06-15T12:00:00Z')
  const store = await createCoinPurchaseStore(dbPath)
  try {
    const stats = store.getAdminPaymentStats(fixedNow)
    await check('[15b.1] allTime.count=1 (null excluded)', () => {
      if (stats.allTime.count !== 1) throw new Error(`allTime.count=${stats.allTime.count}`)
    })
    await check('[15b.2] allTime.totalCents=500 (null excluded)', () => {
      if (stats.allTime.totalCents !== 500) throw new Error(`allTime.totalCents=${stats.allTime.totalCents}`)
    })
  } finally { store.close() }
})

// ─── HTTP endpoint checks ─────────────────────────────────────────────────────

console.log('\n[16-22] HTTP: GET /api/admin/payments')

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'AdminPaymentsCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

type HttpResult = { status: number; body: unknown }

function httpGet(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers.Cookie = cookie
    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: 8000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* */ }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout')))
    req.on('error', reject)
    req.end()
  })
}

const sourceRoot = resolve(process.argv.slice(2).find(a => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log(`  Server root: ${sourceRoot}`)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-admin-payments-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'),  join(serverDir, 'src'),  { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>(r => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

const iso = await makeIsolated(sourceRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpGet(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const adminEmail    = `admin-payments-${runId}@example.test`
  const nonAdminEmail = `player-payments-${runId}@example.test`

  const regAdmin = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'PayAdmin', gender: 'male' }),
  })
  if (regAdmin.status !== 200) throw new Error(`Register admin ${regAdmin.status}`)

  const regPlayer = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: nonAdminEmail, password: PASSWORD, displayName: 'PayPlayer', gender: 'male' }),
  })
  if (regPlayer.status !== 200) throw new Error(`Register player ${regPlayer.status}`)

  const db2 = new DatabaseSync(iso.dbFile)
  db2.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  db2.close()

  const loginAdmin = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const h2 = loginAdmin.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (h2.getSetCookie?.()[0] ?? loginAdmin.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('No Set-Cookie on admin login')

  const loginPlayer = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: nonAdminEmail, password: PASSWORD }),
  })
  const h3 = loginPlayer.headers as Headers & { getSetCookie?: () => string[] }
  const playerCookie = (h3.getSetCookie?.()[0] ?? loginPlayer.headers.get('set-cookie'))?.split(';')[0]
  if (!playerCookie) throw new Error('No Set-Cookie on player login')

  // [16] 401 without cookie
  await check('[16] 401 without cookie', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=today')
    if (r.status !== 401) throw new Error(`status=${r.status}`)
    if ((r.body as { ok: boolean }).ok !== false) throw new Error('ok should be false')
  })

  // [17] 403 with non-admin cookie
  await check('[17] 403 with player cookie', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=today', playerCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // [18] 400 for invalid/missing period
  await check('[18a] 400 for invalid period', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=BOGUS', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { ok: boolean; errorCode?: string }
    if (b.ok !== false) throw new Error('ok should be false')
    if (b.errorCode !== 'INVALID_PERIOD') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[18b] 400 for missing period', async () => {
    const r = await httpGet(port, '/api/admin/payments', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_PERIOD') throw new Error(`errorCode=${b.errorCode}`)
  })

  // [19] 200 + correct shape for each valid period
  for (const period of ADMIN_PAYMENT_PERIODS) {
    await check(`[19.${period}] 200 + valid shape`, async () => {
      const r = await httpGet(port, `/api/admin/payments?period=${period}`, adminCookie)
      if (r.status !== 200) throw new Error(`status=${r.status}`)
      const b = r.body as {
        ok: boolean; period: string
        purchases: unknown[]
        pagination: { limit: number; offset: number; total: number; hasMore: boolean }
        summary: { totalsByCurrency: Record<string, number> }
      }
      if (!b.ok) throw new Error('ok=false')
      if (b.period !== period) throw new Error(`period=${b.period}`)
      if (!Array.isArray(b.purchases)) throw new Error('purchases not array')
      if (typeof b.pagination?.total !== 'number') throw new Error('pagination.total not number')
      if (typeof b.pagination?.hasMore !== 'boolean') throw new Error('pagination.hasMore not boolean')
      if (typeof b.summary?.totalsByCurrency !== 'object') throw new Error('summary.totalsByCurrency not object')
    })
  }

  // [20] limit clamping and validation
  await check('[20] limit absent → 50', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { pagination: { limit: number } }
    if (b.pagination.limit !== 50) throw new Error(`limit=${b.pagination.limit}`)
  })
  await check('[20] limit=200 → clamped to 100', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=200', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { pagination: { limit: number } }
    if (b.pagination.limit !== 100) throw new Error(`limit=${b.pagination.limit}`)
  })
  await check('[20b] limit=0 → 400 INVALID_LIMIT', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=0', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_LIMIT') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[20c] limit=abc → 400 INVALID_LIMIT', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=abc', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_LIMIT') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[20d] limit=1.5 → 400 INVALID_LIMIT', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=1.5', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_LIMIT') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[20e] limit=10abc → 400 INVALID_LIMIT', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=10abc', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_LIMIT') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[20f] limit=-1 → 400 INVALID_LIMIT', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=-1', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_LIMIT') throw new Error(`errorCode=${b.errorCode}`)
  })

  // [21] offset validation
  await check('[21] offset absent → 0', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=10', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { pagination: { offset: number } }
    if (b.pagination.offset !== 0) throw new Error(`offset=${b.pagination.offset}`)
  })
  await check('[21b] offset=abc → 400 INVALID_OFFSET', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&offset=abc', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_OFFSET') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[21c] offset=-1 → 400 INVALID_OFFSET', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&offset=-1', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_OFFSET') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[21d] offset=1.5 → 400 INVALID_OFFSET', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&offset=1.5', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_OFFSET') throw new Error(`errorCode=${b.errorCode}`)
  })
  await check('[21e] offset=10abc → 400 INVALID_OFFSET', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&offset=10abc', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
    const b = r.body as { errorCode?: string }
    if (b.errorCode !== 'INVALID_OFFSET') throw new Error(`errorCode=${b.errorCode}`)
  })

  // [22] pagination.hasMore
  await check('[22] pagination.hasMore=false on empty DB', async () => {
    const r = await httpGet(port, '/api/admin/payments?period=allTime&limit=50&offset=0', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const b = r.body as { pagination: { hasMore: boolean } }
    if (b.pagination.hasMore !== false) throw new Error(`hasMore=${b.pagination.hasMore}`)
  })

} catch (err) {
  fail('HTTP test error', err)
  if (srv) console.error('\n[server output]\n' + srv.output().slice(-3000))
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

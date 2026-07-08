import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSiteVisitStore } from '../src/db/siteVisitStore.js'
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

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function withTempDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-visitor-summary-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_visitors (
        anonymous_visitor_id TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        first_profile_id TEXT NULL,
        last_profile_id TEXT NULL,
        first_ip_address TEXT NULL,
        last_ip_address TEXT NULL,
        first_user_agent TEXT NULL,
        last_user_agent TEXT NULL,
        last_device_type TEXT NULL CHECK (last_device_type IN ('mobile', 'desktop', 'tablet', 'unknown')),
        last_os_type TEXT NULL CHECK (last_os_type IN ('android', 'ios', 'windows', 'macos', 'linux', 'chromeos', 'unknown')),
        first_referrer TEXT NULL,
        last_referrer TEXT NULL,
        first_source TEXT NULL,
        last_source TEXT NULL
      );
      CREATE TABLE IF NOT EXISTS site_visit_events (
        page_view_id TEXT PRIMARY KEY,
        anonymous_visitor_id TEXT NOT NULL,
        profile_id TEXT NULL,
        path TEXT NOT NULL,
        navigation_type TEXT NOT NULL CHECK (
          navigation_type IN ('navigate', 'reload', 'back_forward', 'spa')
        ),
        referrer TEXT NULL,
        source TEXT NULL,
        utm_source TEXT NULL,
        utm_medium TEXT NULL,
        utm_campaign TEXT NULL,
        utm_term TEXT NULL,
        utm_content TEXT NULL,
        ip_address TEXT NULL,
        user_agent TEXT NULL,
        view_layout TEXT NULL CHECK (view_layout IN ('mobile', 'desktop')),
        is_entry INTEGER NOT NULL DEFAULT 0 CHECK (is_entry IN (0, 1)),
        occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (anonymous_visitor_id) REFERENCES site_visitors(anonymous_visitor_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_site_visit_events_occurred_at ON site_visit_events(occurred_at);
    `)
    db.close()
    await fn(dbPath)
  } finally {
    await retryRm(dir)
  }
}

// Insert visitor + one event at the given UTC SQLite timestamp string.
function insertVisitorAt(db: DatabaseSync, visitorId: string, utcTs: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?);
  `).run(visitorId, utcTs, utcTs)
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES (?, ?, '/lobby', 'navigate', ?);
  `).run(randomUUID(), visitorId, utcTs)
}

// Offset a Date by hours (positive = future, negative = past).
function offsetHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000)
}

// Offset a Date by minutes.
function offsetMinutes(d: Date, m: number): Date {
  return new Date(d.getTime() + m * 60_000)
}

// ─── [1] Празна история → нули ────────────────────────────────────────────────

console.log('\n[1] getVisitorSummary() — празна таблица')
await withTempDb(async (dbPath) => {
  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary()
    await check('[1.1] today = 0',      () => { if (summary.today     !== 0) throw new Error(`today=${summary.today}`) })
    await check('[1.2] yesterday = 0',  () => { if (summary.yesterday !== 0) throw new Error(`yesterday=${summary.yesterday}`) })
    await check('[1.3] last7days = 0',  () => { if (summary.last7days  !== 0) throw new Error(`last7days=${summary.last7days}`) })
    await check('[1.4] last30days = 0', () => { if (summary.last30days !== 0) throw new Error(`last30days=${summary.last30days}`) })
  } finally {
    store.close()
  }
})

// ─── [2] Посетители в различни периоди (фиксиран clock) ─────────────────────
//
// Use a fixed `now` so the test is independent of the real current time.
// now = 2026-06-27 10:00:00 UTC → Sofia: 13:00 EEST (UTC+3) on 27 June 2026.
// Bounds:
//   yesterdayStart = 2026-06-25 21:00:00 UTC  (midnight 26 Jun Sofia)
//   todayStart     = 2026-06-26 21:00:00 UTC  (midnight 27 Jun Sofia)
//   tomorrowStart  = 2026-06-27 21:00:00 UTC  (midnight 28 Jun Sofia)

console.log('\n[2] getVisitorSummary() — посетители в различни периоди (fixed clock)')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  const todayVisitor     = randomUUID()  // within today's Sofia range
  const yesterdayVisitor = randomUUID()  // within yesterday's Sofia range
  const week5dVisitor    = randomUUID()  // 5 days before now (UTC)
  const month20dVisitor  = randomUUID()  // 20 days before now (UTC)
  const oldVisitor       = randomUUID()  // 40 days before now → outside 30d

  // todayStart + 2h → safely within today
  insertVisitorAt(db, todayVisitor,     toSqliteUtc(offsetHours(new Date(bounds.todayStart + 'Z'), 2)))
  // yesterdayStart + 2h → safely within yesterday
  insertVisitorAt(db, yesterdayVisitor, toSqliteUtc(offsetHours(new Date(bounds.yesterdayStart + 'Z'), 2)))
  insertVisitorAt(db, week5dVisitor,    toSqliteUtc(new Date(fixedNow.getTime() - 5  * 86_400_000)))
  insertVisitorAt(db, month20dVisitor,  toSqliteUtc(new Date(fixedNow.getTime() - 20 * 86_400_000)))
  insertVisitorAt(db, oldVisitor,       toSqliteUtc(new Date(fixedNow.getTime() - 40 * 86_400_000)))
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[2.1] today = 1 (само todayVisitor)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
    await check('[2.2] yesterday = 1 (yesterdayVisitor)', () => {
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[2.3] last7days >= 3 (today + yesterday + 5d)', () => {
      if (summary.last7days < 3) throw new Error(`last7days=${summary.last7days}`)
    })
    await check('[2.4] last30days >= 4 (today + yesterday + 5d + 20d)', () => {
      if (summary.last30days < 4) throw new Error(`last30days=${summary.last30days}`)
    })
    await check('[2.5] last30days не включва 40-дневния посетител', () => {
      if (summary.last30days >= 5) throw new Error(`last30days=${summary.last30days} (очакван < 5)`)
    })
  } finally {
    store.close()
  }
})

// ─── [3] Един посетител с много events се брои веднъж ────────────────────────

console.log('\n[3] getVisitorSummary() — duplicate visitor се брои веднъж')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)
  const ts       = toSqliteUtc(offsetHours(new Date(bounds.todayStart + 'Z'), 1))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const visitorId = randomUUID()
  insertVisitorAt(db, visitorId, ts)
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at)
    VALUES (?, ?, '/shop', 'spa', ?)
  `).run(randomUUID(), visitorId, ts)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[3.1] today = 1 при множество events от един visitor', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [4] Граничен тест за yesterday ──────────────────────────────────────────
//
// Visitor exactly at yesterdayStart  → in yesterday, NOT in today.
// Visitor exactly at todayStart      → in today, NOT in yesterday.

console.log('\n[4] Граничен тест: yesterdayStart и todayStart')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const atYesterdayStart = randomUUID()
  const atTodayStart     = randomUUID()
  insertVisitorAt(db, atYesterdayStart, bounds.yesterdayStart)  // exactly at yesterdayStart
  insertVisitorAt(db, atTodayStart,     bounds.todayStart)      // exactly at todayStart
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[4.1] visitor @ yesterdayStart → yesterday=1', () => {
      // Only atYesterdayStart is in [yesterdayStart, todayStart)
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[4.2] visitor @ todayStart → today=1', () => {
      // Only atTodayStart is in [todayStart, tomorrowStart)
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
    await check('[4.3] visitor @ todayStart не е в yesterday', () => {
      // atTodayStart must NOT be in [yesterdayStart, todayStart)
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday} (expected 1, only atYesterdayStart)`)
    })
  } finally {
    store.close()
  }
})

// ─── [5] Днес използва полунощ по Europe/Sofia, не UTC ───────────────────────
//
// Event at 22:30 UTC (= 01:30 Sofia EEST next calendar day) → NOT in today (Sofia).
// Event at 20:30 UTC (= 23:30 Sofia EEST same calendar day) → in today (Sofia).
//
// fixedNow = 2026-06-27T10:00:00Z → todayStart = 2026-06-26T21:00:00Z
//                                     tomorrowStart = 2026-06-27T21:00:00Z

console.log('\n[5] Днес използва Sofia полунощ, не UTC полунощ')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  // 2026-06-27 20:30 UTC = 23:30 Sofia EEST → still 27 June Sofia → in today
  const inSofiaToday = randomUUID()
  insertVisitorAt(db, inSofiaToday, '2026-06-27 20:30:00')

  // 2026-06-27 22:00 UTC = 01:00 Sofia EEST on 28 June → NOT today (tomorrow Sofia)
  const inSofiaTomorrow = randomUUID()
  insertVisitorAt(db, inSofiaTomorrow, '2026-06-27 22:00:00')

  // 2026-06-27 00:30 UTC = 03:30 Sofia EEST (still 27 June Sofia) → in today
  const alsoInSofiaToday = randomUUID()
  insertVisitorAt(db, alsoInSofiaToday, '2026-06-27 00:30:00')

  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[5.1] todayStart = 2026-06-26 21:00:00 (Sofia midnight EEST)', () => {
      if (bounds.todayStart !== '2026-06-26 21:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
    })
    await check('[5.2] tomorrowStart = 2026-06-27 21:00:00', () => {
      if (bounds.tomorrowStart !== '2026-06-27 21:00:00') throw new Error(`tomorrowStart=${bounds.tomorrowStart}`)
    })
    await check('[5.3] today = 2 (inSofiaToday + alsoInSofiaToday)', () => {
      if (summary.today !== 2) throw new Error(`today=${summary.today}`)
    })
    await check('[5.4] inSofiaTomorrow не е в today', () => {
      // inSofiaTomorrow is at 22:00 UTC = after tomorrowStart → not in today
      if (summary.today !== 2) throw new Error(`today=${summary.today} (expected 2)`)
    })
  } finally {
    store.close()
  }
})

// ─── [6] Летен ден UTC+3 (EEST) ──────────────────────────────────────────────

console.log('\n[6] DST: летен ден UTC+3 (EEST) — 15 юли 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-07-15T12:00:00Z')  // noon UTC = 15:00 Sofia EEST
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  await check('[6.1] todayStart = 2026-07-14 21:00:00 UTC (midnight Sofia EEST)', () => {
    if (bounds.todayStart !== '2026-07-14 21:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })
  await check('[6.2] yesterdayStart = 2026-07-13 21:00:00 UTC', () => {
    if (bounds.yesterdayStart !== '2026-07-13 21:00:00') throw new Error(`yesterdayStart=${bounds.yesterdayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const yv = randomUUID()
  const tv = randomUUID()
  insertVisitorAt(db, yv, toSqliteUtc(offsetHours(new Date(bounds.yesterdayStart + 'Z'), 2)))
  insertVisitorAt(db, tv, toSqliteUtc(offsetHours(new Date(bounds.todayStart + 'Z'), 2)))
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[6.3] yesterday = 1 (летен ден)', () => {
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[6.4] today = 1 (летен ден)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [7] Зимен ден UTC+2 (EET) ───────────────────────────────────────────────

console.log('\n[7] DST: зимен ден UTC+2 (EET) — 15 януари 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-01-15T12:00:00Z')  // noon UTC = 14:00 Sofia EET
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  await check('[7.1] todayStart = 2026-01-14 22:00:00 UTC (midnight Sofia EET)', () => {
    if (bounds.todayStart !== '2026-01-14 22:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })
  await check('[7.2] yesterdayStart = 2026-01-13 22:00:00 UTC', () => {
    if (bounds.yesterdayStart !== '2026-01-13 22:00:00') throw new Error(`yesterdayStart=${bounds.yesterdayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const yv = randomUUID()
  const tv = randomUUID()
  insertVisitorAt(db, yv, toSqliteUtc(offsetHours(new Date(bounds.yesterdayStart + 'Z'), 2)))
  insertVisitorAt(db, tv, toSqliteUtc(offsetHours(new Date(bounds.todayStart + 'Z'), 2)))
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[7.3] yesterday = 1 (зимен ден)', () => {
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[7.4] today = 1 (зимен ден)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [8] DST spring преход — 29 март 2026 ────────────────────────────────────
// At 03:00 EET (= 01:00 UTC) clocks spring forward to 04:00 EEST.
// Midnight 29 Mar Sofia is at 22:00 UTC 28 Mar (still EET = UTC+2).
// `now` = 29 Mar 10:00 UTC (afternoon Sofia in EEST).

console.log('\n[8] DST spring преход — 29 март 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-03-29T10:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  await check('[8.1] todayStart = 2026-03-28 22:00:00 UTC (midnight 29 Mar Sofia in EET)', () => {
    if (bounds.todayStart !== '2026-03-28 22:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })
  await check('[8.2] yesterdayStart = 2026-03-27 22:00:00 UTC (midnight 28 Mar Sofia in EET)', () => {
    if (bounds.yesterdayStart !== '2026-03-27 22:00:00') throw new Error(`yesterdayStart=${bounds.yesterdayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // Within yesterday Sofia (28 Mar): 22:30 UTC 27 Mar = 00:30 Sofia
  insertVisitorAt(db, randomUUID(), '2026-03-27 22:30:00')
  // Within today Sofia (29 Mar): 22:30 UTC 28 Mar = 00:30 Sofia
  insertVisitorAt(db, randomUUID(), '2026-03-28 22:30:00')
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[8.3] yesterday = 1 (spring transition)', () => {
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[8.4] today = 1 (spring transition)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [9] DST fall преход — 25 октомври 2026 ──────────────────────────────────
// At 04:00 EEST (= 01:00 UTC) clocks fall back to 03:00 EET.
// Midnight 25 Oct Sofia is at 21:00 UTC 24 Oct (still EEST = UTC+3).
// `now` = 25 Oct 12:00 UTC (afternoon Sofia in EET after transition).

console.log('\n[9] DST fall преход — 25 октомври 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-10-25T12:00:00Z')
  const bounds   = getSofiaDayBoundsUtc(fixedNow)

  await check('[9.1] todayStart = 2026-10-24 21:00:00 UTC (midnight 25 Oct Sofia in EEST)', () => {
    if (bounds.todayStart !== '2026-10-24 21:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })
  await check('[9.2] yesterdayStart = 2026-10-23 21:00:00 UTC (midnight 24 Oct Sofia in EEST)', () => {
    if (bounds.yesterdayStart !== '2026-10-23 21:00:00') throw new Error(`yesterdayStart=${bounds.yesterdayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // Within yesterday Sofia (24 Oct): 21:30 UTC 23 Oct = 00:30 Sofia EEST
  insertVisitorAt(db, randomUUID(), '2026-10-23 21:30:00')
  // Within today Sofia (25 Oct): 21:30 UTC 24 Oct = 00:30 Sofia EEST
  insertVisitorAt(db, randomUUID(), '2026-10-24 21:30:00')
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[9.3] yesterday = 1 (fall transition)', () => {
      if (summary.yesterday !== 1) throw new Error(`yesterday=${summary.yesterday}`)
    })
    await check('[9.4] today = 1 (fall transition)', () => {
      if (summary.today !== 1) throw new Error(`today=${summary.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [9b] Детерминизъм на rolling периоди (фиксирана дата 2024-01-15) ───────
//
// fixedNow = 2024-01-15T12:00:00Z — ~2.5 г. преди реалната дата (юни 2026).
// Ако реализацията използва SQLite datetime('now') или системния clock,
// никой от тези посетители не би бил върнат (данните са от 2023-2024 г.).
//
// Правила:
//   last7days  = occurred_at >= fixedNow − 7×24h   (без горна граница)
//   last30days = occurred_at >= fixedNow − 30×24h  (без горна граница)
//
// Очаквани стойности:
//   last7days  = 2  (−5d ✓, −7d точно ✓, −7d−1s ✗, −20d ✗, −30d ✗, −30d−1s ✗, −40d ✗)
//   last30days = 5  (−5d ✓, −7d ✓, −7d−1s ✓, −20d ✓, −30d точно ✓, −30d−1s ✗, −40d ✗)

console.log('\n[9b] Детерминизъм на rolling периоди — fixed clock 2024-01-15')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2024-01-15T12:00:00Z')

  const ms = (n: number) => fixedNow.getTime() - n
  const DAY = 86_400_000

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // − 5 дни: вътре в 7d и 30d
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(5 * DAY))))
  // − 7 дни точно: на границата на 7d (включена с >=)
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(7 * DAY))))
  // − 7 дни − 1 секунда: извън 7d, вътре в 30d
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(7 * DAY + 1_000))))
  // − 20 дни: извън 7d, вътре в 30d
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(20 * DAY))))
  // − 30 дни точно: на границата на 30d (включена с >=)
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(30 * DAY))))
  // − 30 дни − 1 секунда: извън 30d
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(30 * DAY + 1_000))))
  // − 40 дни: извън и двата прозореца
  insertVisitorAt(db, randomUUID(), toSqliteUtc(new Date(ms(40 * DAY))))
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getVisitorSummary(fixedNow)
    await check('[9b.1] last7days = 2 (−5d и −7d точно)', () => {
      if (summary.last7days !== 2) throw new Error(`last7days=${summary.last7days}, очаквано 2`)
    })
    await check('[9b.2] last30days = 5 (−5d, −7d, −7d−1s, −20d, −30d)', () => {
      if (summary.last30days !== 5) throw new Error(`last30days=${summary.last30days}, очаквано 5`)
    })
    await check('[9b.3] −7d−1s не е в last7days', () => {
      // Ако last7days > 2, значи границата е неправилно включена
      if (summary.last7days > 2) throw new Error(`last7days=${summary.last7days} (прекалено много)`)
    })
    await check('[9b.4] −30d−1s и −40d не са в last30days', () => {
      if (summary.last30days > 5) throw new Error(`last30days=${summary.last30days} (прекалено много)`)
    })
  } finally {
    store.close()
  }
})

// ─── [10] HTTP endpoint — /api/admin/stats включва visitors ──────────────────

console.log('\n[10] /api/admin/stats endpoint — visitors присъства и е валиден')

const PASSWORD = 'VisitorSummarySmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
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
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          resolve({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    req.end()
  })
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log(`  Server root: ${sourceServerRoot}`)

// On Windows, SQLite WAL files can briefly remain locked after the child exits.
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 250))
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-visitor-summary-http-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

function startServer(serverDir: string, port: number): RunningServer {
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

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n  Чакам сървъра на порт ${port}...`)
  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpGet(port, '/health')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const adminEmail = `visitor-summary-${runId}@example.test`

  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'SummaryAdmin', gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Регистрацията върна ${regRes.status}`)

  const db = new DatabaseSync(isolated.databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(adminEmail)
  db.close()

  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: PASSWORD }),
  })
  const loginExt = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const adminCookie = (loginExt.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!adminCookie) throw new Error('Липсва Set-Cookie при admin login.')

  {
    const r = await httpGet(port, '/api/admin/stats')
    await check('[10.1] без cookie → 403', () => {
      if (r.status !== 403) throw new Error(`Получен ${r.status}, очакван 403`)
    })
  }

  {
    const r = await httpGet(port, '/api/admin/stats', adminCookie)
    const b = r.body as Record<string, unknown>
    await check('[10.2] status 200', () => {
      if (r.status !== 200) throw new Error(`Получен ${r.status}, очакван 200`)
    })
    await check('[10.3] ok: true', () => {
      if (b.ok !== true) throw new Error(`ok=${String(b.ok)}`)
    })
    const stats = b.stats as Record<string, unknown> | undefined
    await check('[10.4] stats.visitors е обект', () => {
      if (!stats?.visitors || typeof stats.visitors !== 'object' || Array.isArray(stats.visitors)) {
        throw new Error(`visitors=${String(stats?.visitors)}`)
      }
    })
    const visitors = stats?.visitors as Record<string, unknown> | undefined
    await check('[10.5] visitors.today е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.today) || (visitors.today as number) < 0) {
        throw new Error(`today=${String(visitors?.today)}`)
      }
    })
    await check('[10.6] visitors.yesterday е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.yesterday) || (visitors.yesterday as number) < 0) {
        throw new Error(`yesterday=${String(visitors?.yesterday)}`)
      }
    })
    await check('[10.7] visitors.last7days е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.last7days) || (visitors.last7days as number) < 0) {
        throw new Error(`last7days=${String(visitors?.last7days)}`)
      }
    })
    await check('[10.8] visitors.last30days е integer ≥ 0', () => {
      if (!Number.isInteger(visitors?.last30days) || (visitors.last30days as number) < 0) {
        throw new Error(`last30days=${String(visitors?.last30days)}`)
      }
    })
    await check('[10.9] last30days >= last7days >= yesterday (монотонност)', () => {
      const v = visitors as { today: number; yesterday: number; last7days: number; last30days: number }
      if (v.last30days < v.last7days) throw new Error(`last30days(${v.last30days}) < last7days(${v.last7days})`)
      if (v.last7days < v.yesterday)  throw new Error(`last7days(${v.last7days}) < yesterday(${v.yesterday})`)
    })

    await check('[10.10] stats.registeredProfiles е обект', () => {
      if (!stats?.registeredProfiles || typeof stats.registeredProfiles !== 'object' || Array.isArray(stats.registeredProfiles)) {
        throw new Error(`registeredProfiles=${String(stats?.registeredProfiles)}`)
      }
    })
    const registeredProfiles = stats?.registeredProfiles as Record<string, unknown> | undefined
    await check('[10.11] registeredProfiles.total е integer >= 1 (admin профилът от теста)', () => {
      if (!Number.isInteger(registeredProfiles?.total) || (registeredProfiles.total as number) < 1) {
        throw new Error(`total=${String(registeredProfiles?.total)}`)
      }
    })
    await check('[10.12] registeredProfiles.today е integer >= 1 (admin профилът е регистриран днес)', () => {
      if (!Number.isInteger(registeredProfiles?.today) || (registeredProfiles.today as number) < 1) {
        throw new Error(`today=${String(registeredProfiles?.today)}`)
      }
    })
    await check('[10.13] registeredProfiles.yesterday е integer ≥ 0', () => {
      if (!Number.isInteger(registeredProfiles?.yesterday) || (registeredProfiles.yesterday as number) < 0) {
        throw new Error(`yesterday=${String(registeredProfiles?.yesterday)}`)
      }
    })
    await check('[10.14] registeredProfiles.total >= today + yesterday', () => {
      const p = registeredProfiles as { total: number; today: number; yesterday: number }
      if (p.total < p.today + p.yesterday) {
        throw new Error(`total(${p.total}) < today(${p.today}) + yesterday(${p.yesterday})`)
      }
    })
  }

} catch (err) {
  fail('Непредвидена грешка в HTTP теста', err)
  if (server) console.error('\n[server output]\n' + server.output().slice(-2000))
  console.error(err)
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

// ─── [11] Frontend source — типове и маркиране на „Регистрирани профили“ ────

console.log('\n[11] Frontend source checks — registeredProfiles')

const clientPath = join(sourceServerRoot, '..', 'src', 'app', 'network', 'createGameServerClient.ts')
const clientSource = await readFile(clientPath, 'utf8')

await check('[11.1] AdminRegisteredProfilesStats е дефиниран', () => {
  if (!clientSource.includes('AdminRegisteredProfilesStats')) {
    throw new Error('Липсва AdminRegisteredProfilesStats')
  }
})
await check('[11.2] AdminStatsSnapshot съдържа registeredProfiles поле', () => {
  if (!clientSource.includes('registeredProfiles: AdminRegisteredProfilesStats')) {
    throw new Error('Липсва registeredProfiles: AdminRegisteredProfilesStats в AdminStatsSnapshot')
  }
})
await check('[11.3] totalProfiles е премахнат от AdminStatsSnapshot', () => {
  if (clientSource.includes('totalProfiles')) {
    throw new Error('totalProfiles все още присъства в createGameServerClient.ts')
  }
})

const lobbyScreenPath = join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const lobbyScreenSource = await readFile(lobbyScreenPath, 'utf8')

await check('[11.4] HTML съдържа "РЕГИСТРИРАНИ ПРОФИЛИ" заглавие', () => {
  if (!lobbyScreenSource.includes('Регистрирани профили')) {
    throw new Error('Липсва "Регистрирани профили" в renderLobbyScreen.ts')
  }
})
await check('[11.5] HTML съдържа "общо"', () => {
  if (!lobbyScreenSource.includes('>общо<')) {
    throw new Error('Липсва "общо" етикет')
  }
})
await check('[11.6] HTML съдържа "днес"', () => {
  if (!lobbyScreenSource.includes('>днес<')) {
    throw new Error('Липсва "днес" етикет')
  }
})
await check('[11.7] HTML съдържа "вчера"', () => {
  if (!lobbyScreenSource.includes('>вчера<')) {
    throw new Error('Липсва "вчера" етикет')
  }
})
await check('[11.8] rendering използва registeredProfiles с fallback към 0', () => {
  if (!lobbyScreenSource.includes('stats.registeredProfiles?.total ?? 0')) {
    throw new Error('Липсва fallback stats.registeredProfiles?.total ?? 0')
  }
})

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}

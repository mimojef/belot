import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSiteVisitStore } from '../src/db/siteVisitStore.js'
import { getSofiaDayBoundsUtc, toSqliteUtc } from '../src/db/sofiaDayBounds.js'

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
  const dir = await mkdtemp(join(tmpdir(), 'belot-viewlayout-'))
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
      CREATE INDEX IF NOT EXISTS idx_site_visit_events_layout_entry_time
        ON site_visit_events(view_layout, is_entry, occurred_at);
    `)
    db.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function insertEvent(
  db: DatabaseSync,
  visitorId: string,
  navType: string,
  layout: string | null,
  utcTs: string,
  isEntry: 0 | 1 = 0,
): void {
  db.prepare(`
    INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at)
    VALUES (?, ?, ?)
  `).run(visitorId, utcTs, utcTs)
  db.prepare(`
    INSERT INTO site_visit_events
      (page_view_id, anonymous_visitor_id, path, navigation_type, view_layout, is_entry, occurred_at)
    VALUES (?, ?, '/lobby', ?, ?, ?, ?)
  `).run(randomUUID(), visitorId, navType, layout, isEntry, utcTs)
}

// ─── [1] Таблицата приема mobile, desktop и NULL ───────────────────────────

console.log('\n[1] CHECK constraint: mobile, desktop, NULL')
await withTempDb(async (dbPath) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  const v1 = randomUUID()
  const v2 = randomUUID()
  const v3 = randomUUID()

  await check('[1.1] view_layout = "mobile" се приема', () => {
    insertEvent(db, v1, 'navigate', 'mobile', '2026-01-01 10:00:00')
  })
  await check('[1.2] view_layout = "desktop" се приема', () => {
    insertEvent(db, v2, 'navigate', 'desktop', '2026-01-01 10:00:01')
  })
  await check('[1.3] view_layout = NULL се приема', () => {
    insertEvent(db, v3, 'navigate', null, '2026-01-01 10:00:02')
  })
  await check('[1.4] невалидна стойност се отхвърля от CHECK constraint', () => {
    let threw = false
    try {
      insertEvent(db, randomUUID(), 'navigate', 'tablet', '2026-01-01 10:00:03')
    } catch {
      threw = true
    }
    if (!threw) throw new Error('CHECK constraint не хвърли грешка за "tablet"')
  })
  db.close()
})

// ─── [2] recordPageView записва view_layout коректно ─────────────────────────

console.log('\n[2] recordPageView записва view_layout')
await withTempDb(async (dbPath) => {
  const store = await createSiteVisitStore(dbPath)
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  try {
    const pid1 = randomUUID()
    const pid2 = randomUUID()
    const pid3 = randomUUID()
    const vid = randomUUID()

    store.recordPageView({
      pageViewId: pid1, anonymousVisitorId: vid, profileId: null, path: '/lobby',
      navigationType: 'navigate', referrer: null, source: 'direct',
      attributionReferrer: null, attributionSource: null,
      utm: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null },
      ipAddress: null, userAgent: null, viewLayout: 'mobile', isEntry: true,
    })
    store.recordPageView({
      pageViewId: pid2, anonymousVisitorId: vid, profileId: null, path: '/lobby',
      navigationType: 'reload', referrer: null, source: 'direct',
      attributionReferrer: null, attributionSource: null,
      utm: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null },
      ipAddress: null, userAgent: null, viewLayout: 'desktop', isEntry: true,
    })
    store.recordPageView({
      pageViewId: pid3, anonymousVisitorId: vid, profileId: null, path: '/lobby',
      navigationType: 'navigate', referrer: null, source: 'direct',
      attributionReferrer: null, attributionSource: null,
      utm: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null },
      ipAddress: null, userAgent: null, viewLayout: null, isEntry: false,
    })

    type EventRow = { view_layout: string | null; is_entry: number }
    const r1 = db.prepare(`SELECT view_layout, is_entry FROM site_visit_events WHERE page_view_id = ?`).get(pid1) as EventRow
    const r2 = db.prepare(`SELECT view_layout, is_entry FROM site_visit_events WHERE page_view_id = ?`).get(pid2) as EventRow
    const r3 = db.prepare(`SELECT view_layout, is_entry FROM site_visit_events WHERE page_view_id = ?`).get(pid3) as EventRow

    await check('[2.1] view_layout = "mobile" е записан', () => {
      if (r1.view_layout !== 'mobile') throw new Error(`view_layout=${String(r1.view_layout)}`)
    })
    await check('[2.2] view_layout = "desktop" е записан', () => {
      if (r2.view_layout !== 'desktop') throw new Error(`view_layout=${String(r2.view_layout)}`)
    })
    await check('[2.3] view_layout = NULL е записан', () => {
      if (r3.view_layout !== null) throw new Error(`view_layout=${String(r3.view_layout)}`)
    })
    await check('[2.4] is_entry = 1 при isEntry: true', () => {
      if (r1.is_entry !== 1) throw new Error(`is_entry=${r1.is_entry}`)
    })
    await check('[2.5] is_entry = 1 при isEntry: true (reload)', () => {
      if (r2.is_entry !== 1) throw new Error(`is_entry=${r2.is_entry}`)
    })
    await check('[2.6] is_entry = 0 при isEntry: false', () => {
      if (r3.is_entry !== 0) throw new Error(`is_entry=${r3.is_entry}`)
    })
  } finally {
    db.close()
    store.close()
  }
})

// ─── [3] getViewLayoutSummary — основна логика ────────────────────────────────
//
// fixedNow = 2026-06-27T10:00:00Z → Sofia EEST (UTC+3)
// todayStart     = 2026-06-26 21:00:00 UTC
// tomorrowStart  = 2026-06-27 21:00:00 UTC
// yesterdayStart = 2026-06-25 21:00:00 UTC

console.log('\n[3] getViewLayoutSummary — основна логика (fixed clock)')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  // today: 2 mobile navigate, 1 desktop navigate, 1 mobile reload — all entries
  const todayTs = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
  insertEvent(db, randomUUID(), 'navigate', 'mobile',  todayTs, 1)
  insertEvent(db, randomUUID(), 'navigate', 'mobile',  todayTs, 1)
  insertEvent(db, randomUUID(), 'navigate', 'desktop', todayTs, 1)
  insertEvent(db, randomUUID(), 'reload',   'mobile',  todayTs, 1)

  // yesterday: 1 desktop navigate — entry
  const yesterdayTs = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 2 * 3_600_000))
  insertEvent(db, randomUUID(), 'navigate', 'desktop', yesterdayTs, 1)

  // 5 days ago (within 7d and 30d): 1 mobile navigate — entry
  const fiveDaysAgo = toSqliteUtc(new Date(fixedNow.getTime() - 5 * 86_400_000))
  insertEvent(db, randomUUID(), 'navigate', 'mobile', fiveDaysAgo, 1)

  // 20 days ago (within 30d only): 1 desktop navigate — entry
  const twentyDaysAgo = toSqliteUtc(new Date(fixedNow.getTime() - 20 * 86_400_000))
  insertEvent(db, randomUUID(), 'navigate', 'desktop', twentyDaysAgo, 1)

  // spa events — is_entry=0 (default), must NOT be counted
  insertEvent(db, randomUUID(), 'spa', 'mobile',  todayTs)
  insertEvent(db, randomUUID(), 'spa', 'desktop', todayTs)

  // NULL layout — must NOT be counted (is_entry=0 by default)
  insertEvent(db, randomUUID(), 'navigate', null, todayTs)

  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)

    await check('[3.1] today.mobile = 3 (2 navigate + 1 reload)', () => {
      if (summary.today.mobile !== 3) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[3.2] today.desktop = 1', () => {
      if (summary.today.desktop !== 1) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
    await check('[3.3] yesterday.mobile = 0', () => {
      if (summary.yesterday.mobile !== 0) throw new Error(`yesterday.mobile=${summary.yesterday.mobile}`)
    })
    await check('[3.4] yesterday.desktop = 1', () => {
      if (summary.yesterday.desktop !== 1) throw new Error(`yesterday.desktop=${summary.yesterday.desktop}`)
    })
    await check('[3.5] last7days.mobile >= 3 (today 3 + 5d 1)', () => {
      if (summary.last7days.mobile < 4) throw new Error(`last7days.mobile=${summary.last7days.mobile}`)
    })
    await check('[3.6] last7days.desktop >= 2 (today 1 + yesterday 1)', () => {
      if (summary.last7days.desktop < 2) throw new Error(`last7days.desktop=${summary.last7days.desktop}`)
    })
    await check('[3.7] last30days.desktop > last7days.desktop (20d event included)', () => {
      if (summary.last30days.desktop <= summary.last7days.desktop) {
        throw new Error(`last30days.desktop=${summary.last30days.desktop} last7days.desktop=${summary.last7days.desktop}`)
      }
    })
  } finally {
    store.close()
  }
})

// ─── [4] SPA events не се броят ───────────────────────────────────────────────

console.log('\n[4] SPA navigation_type се изключва от getViewLayoutSummary')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // Only spa events with view_layout set
  insertEvent(db, randomUUID(), 'spa', 'mobile', ts)
  insertEvent(db, randomUUID(), 'spa', 'desktop', ts)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[4.1] today.mobile = 0 (само spa events)', () => {
      if (summary.today.mobile !== 0) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[4.2] today.desktop = 0 (само spa events)', () => {
      if (summary.today.desktop !== 0) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [5] NULL layout events не влизат в статистиката ─────────────────────────

console.log('\n[5] NULL view_layout се изключва')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  insertEvent(db, randomUUID(), 'navigate', null, ts)
  insertEvent(db, randomUUID(), 'reload',   null, ts)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[5.1] today.mobile = 0 при само NULL layout events', () => {
      if (summary.today.mobile !== 0) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[5.2] today.desktop = 0 при само NULL layout events', () => {
      if (summary.today.desktop !== 0) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [6] COUNT(*) — един visitor с много navigate се брои N пъти ─────────────

console.log('\n[6] COUNT(*) без DISTINCT — един visitor, много влизания')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const vid = randomUUID()
  // Same visitor, 3 separate entry events (new tab, reload, back_forward)
  insertEvent(db, vid, 'navigate',     'desktop', ts, 1)
  insertEvent(db, vid, 'reload',       'desktop', ts, 1)
  insertEvent(db, vid, 'back_forward', 'desktop', ts, 1)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[6.1] today.desktop = 3 (един visitor, 3 отделни влизания)', () => {
      if (summary.today.desktop !== 3) throw new Error(`today.desktop=${summary.today.desktop}`)
    })

    // Verify existing visitor summary still uses DISTINCT (not affected)
    const visitors = store.getVisitorSummary(fixedNow)
    await check('[6.2] getVisitorSummary().today = 1 (COUNT DISTINCT остава непроменен)', () => {
      if (visitors.today !== 1) throw new Error(`visitors.today=${visitors.today}`)
    })
  } finally {
    store.close()
  }
})

// ─── [7] navigate + reload + back_forward се включват ─────────────────────────

console.log('\n[7] Всички entry navigation types се включват')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  insertEvent(db, randomUUID(), 'navigate',     'mobile', ts, 1)
  insertEvent(db, randomUUID(), 'reload',       'mobile', ts, 1)
  insertEvent(db, randomUUID(), 'back_forward', 'mobile', ts, 1)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[7.1] today.mobile = 3 (navigate + reload + back_forward — all entries)', () => {
      if (summary.today.mobile !== 3) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
  } finally {
    store.close()
  }
})

// ─── [8] Граница yesterday/today по Europe/Sofia ──────────────────────────────
//
// fixedNow = 2026-06-27T10:00:00Z
// yesterdayStart = 2026-06-25 21:00:00 UTC  (midnight 26 Jun Sofia EEST)
// todayStart     = 2026-06-26 21:00:00 UTC  (midnight 27 Jun Sofia EEST)

console.log('\n[8] Граница yesterday/today по Europe/Sofia')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // Event exactly at yesterdayStart → in yesterday
  insertEvent(db, randomUUID(), 'navigate', 'mobile', bounds.yesterdayStart, 1)
  // Event exactly at todayStart → in today
  insertEvent(db, randomUUID(), 'navigate', 'desktop', bounds.todayStart, 1)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[8.1] event @ yesterdayStart → yesterday.mobile = 1', () => {
      if (summary.yesterday.mobile !== 1) throw new Error(`yesterday.mobile=${summary.yesterday.mobile}`)
    })
    await check('[8.2] event @ todayStart → today.desktop = 1', () => {
      if (summary.today.desktop !== 1) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
    await check('[8.3] event @ yesterdayStart не е в today', () => {
      if (summary.today.mobile !== 0) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[8.4] event @ todayStart не е в yesterday', () => {
      if (summary.yesterday.desktop !== 0) throw new Error(`yesterday.desktop=${summary.yesterday.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [9] DST: летен ден EEST (UTC+3) ─────────────────────────────────────────

console.log('\n[9] DST: летен ден EEST — 15 юли 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-07-15T12:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)

  await check('[9.1] todayStart = 2026-07-14 21:00:00 UTC', () => {
    if (bounds.todayStart !== '2026-07-14 21:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
  insertEvent(db, randomUUID(), 'navigate', 'mobile', ts, 1)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[9.2] today.mobile = 1 (летен ден)', () => {
      if (summary.today.mobile !== 1) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
  } finally {
    store.close()
  }
})

// ─── [10] DST: зимен ден EET (UTC+2) ─────────────────────────────────────────

console.log('\n[10] DST: зимен ден EET — 15 януари 2026')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-01-15T12:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)

  await check('[10.1] todayStart = 2026-01-14 22:00:00 UTC', () => {
    if (bounds.todayStart !== '2026-01-14 22:00:00') throw new Error(`todayStart=${bounds.todayStart}`)
  })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
  insertEvent(db, randomUUID(), 'navigate', 'desktop', ts, 1)
  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[10.2] today.desktop = 1 (зимен ден)', () => {
      if (summary.today.desktop !== 1) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [13] isEntry семантика — само entry events се броят ─────────────────────
//
// Тества, че is_entry = 0 (SPA pushState и in-app popstate) не влизат
// в getViewLayoutSummary(), докато is_entry = 1 (startup load) влиза.

console.log('\n[13] isEntry семантика')
await withTempDb(async (dbPath) => {
  const fixedNow = new Date('2026-06-27T10:00:00Z')
  const bounds = getSofiaDayBoundsUtc(fixedNow)
  const ts = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 3_600_000))

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')

  // 1 startup load (isEntry=1) → трябва да се брои
  insertEvent(db, randomUUID(), 'navigate', 'mobile', ts, 1)

  // in-app popstate (back_forward, isEntry=0) → не трябва да се брои
  insertEvent(db, randomUUID(), 'back_forward', 'mobile', ts, 0)

  // SPA pushState (spa, isEntry=0) → не трябва да се брои
  insertEvent(db, randomUUID(), 'spa', 'mobile', ts, 0)

  // reload at startup (isEntry=1) → трябва да се брои
  insertEvent(db, randomUUID(), 'reload', 'desktop', ts, 1)

  // back_forward at startup (isEntry=1) → трябва да се брои (browser restored session)
  insertEvent(db, randomUUID(), 'back_forward', 'desktop', ts, 1)

  db.close()

  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary(fixedNow)
    await check('[13.1] navigate isEntry=1 се брои (today.mobile ≥ 1)', () => {
      if (summary.today.mobile < 1) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[13.2] in-app popstate isEntry=0 НЕ се брои (today.mobile = 1)', () => {
      if (summary.today.mobile !== 1) throw new Error(`today.mobile=${summary.today.mobile} (очаква се 1, в-app popstate не трябва да влиза)`)
    })
    await check('[13.3] SPA pushState isEntry=0 НЕ се брои в mobile', () => {
      if (summary.today.mobile !== 1) throw new Error(`today.mobile=${summary.today.mobile} (spa трябва да е изключен)`)
    })
    await check('[13.4] reload isEntry=1 се брои в desktop', () => {
      if (summary.today.desktop < 1) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
    await check('[13.5] back_forward при startup (isEntry=1) се брои в desktop', () => {
      if (summary.today.desktop < 2) throw new Error(`today.desktop=${summary.today.desktop} (трябва reload + back_forward = 2)`)
    })
    await check('[13.6] today.desktop = 2 (reload + back_forward startup, без SPA)', () => {
      if (summary.today.desktop !== 2) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [11] Празна таблица → нули ──────────────────────────────────────────────

console.log('\n[11] Празна таблица → нули')
await withTempDb(async (dbPath) => {
  const store = await createSiteVisitStore(dbPath)
  try {
    const summary = store.getViewLayoutSummary()
    await check('[11.1] today.mobile = 0', () => {
      if (summary.today.mobile !== 0) throw new Error(`today.mobile=${summary.today.mobile}`)
    })
    await check('[11.2] today.desktop = 0', () => {
      if (summary.today.desktop !== 0) throw new Error(`today.desktop=${summary.today.desktop}`)
    })
    await check('[11.3] last30days.mobile = 0', () => {
      if (summary.last30days.mobile !== 0) throw new Error(`last30days.mobile=${summary.last30days.mobile}`)
    })
    await check('[11.4] last30days.desktop = 0', () => {
      if (summary.last30days.desktop !== 0) throw new Error(`last30days.desktop=${summary.last30days.desktop}`)
    })
  } finally {
    store.close()
  }
})

// ─── [12] HTTP endpoint — /api/visits/page-view приема viewLayout ─────────────

console.log('\n[12] HTTP endpoint: page-view приема viewLayout')

const PASSWORD = 'ViewLayoutSmoke1!'
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

function httpJson(
  port: number,
  pathname: string,
  method: string,
  body?: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = {
      'User-Agent': 'viewlayout-smoke/1.0',
      'X-Forwarded-For': '203.0.113.99',
      ...extraHeaders,
    }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }
    if (cookie) headers.Cookie = cookie
    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let parsed: unknown = null
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* ok */ }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)
console.log(`  Server root: ${sourceServerRoot}`)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>(r => setTimeout(r, 250))
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-viewlayout-http-'))
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

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    anonymousVisitorId: randomUUID(),
    pageViewId: randomUUID(),
    path: '/lobby',
    navigationType: 'navigate',
    referrer: null,
    utm: {},
    viewLayout: 'desktop',
    ...overrides,
  }
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
        const r = await httpJson(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.\n')

  // [12.1] viewLayout = 'mobile' → записан
  {
    const p = makePayload({ viewLayout: 'mobile' })
    const r = await httpJson(port, '/api/visits/page-view', 'POST', p)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[12.1] viewLayout "mobile" → 200 recorded', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) {
        throw new Error(`${r.status} ${JSON.stringify(b)}`)
      }
    })
    const db = new DatabaseSync(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT view_layout FROM site_visit_events WHERE page_view_id = ?`).get(p.pageViewId) as { view_layout: string | null } | undefined
      await check('[12.2] view_layout = "mobile" е в БД', () => {
        if (row?.view_layout !== 'mobile') throw new Error(`view_layout=${String(row?.view_layout)}`)
      })
    } finally {
      db.close()
    }
  }

  // [12.3] viewLayout = 'desktop' → записан
  {
    const p = makePayload({ viewLayout: 'desktop' })
    const r = await httpJson(port, '/api/visits/page-view', 'POST', p)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[12.3] viewLayout "desktop" → 200 recorded', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) {
        throw new Error(`${r.status} ${JSON.stringify(b)}`)
      }
    })
    const db = new DatabaseSync(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT view_layout FROM site_visit_events WHERE page_view_id = ?`).get(p.pageViewId) as { view_layout: string | null } | undefined
      await check('[12.4] view_layout = "desktop" е в БД', () => {
        if (row?.view_layout !== 'desktop') throw new Error(`view_layout=${String(row?.view_layout)}`)
      })
    } finally {
      db.close()
    }
  }

  // [12.5] lipsvashcho viewLayout → NULL в БД (стар клиент)
  {
    const p = makePayload()
    delete (p as Record<string, unknown>).viewLayout
    const r = await httpJson(port, '/api/visits/page-view', 'POST', p)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[12.5] липсващ viewLayout → 200 recorded (NULL в БД)', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) {
        throw new Error(`${r.status} ${JSON.stringify(b)}`)
      }
    })
    const db = new DatabaseSync(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT view_layout FROM site_visit_events WHERE page_view_id = ?`).get(p.pageViewId) as { view_layout: string | null } | undefined
      await check('[12.6] view_layout = NULL при липсващо поле', () => {
        if (row?.view_layout !== null) throw new Error(`view_layout=${String(row?.view_layout)}`)
      })
    } finally {
      db.close()
    }
  }

  // [12.7] невалиден viewLayout → NULL (не 400), приема се gracefully
  {
    const p = makePayload({ viewLayout: 'tablet' })
    const r = await httpJson(port, '/api/visits/page-view', 'POST', p)
    const b = r.body as { ok?: boolean; recorded?: boolean }
    await check('[12.7] невалиден viewLayout ("tablet") → 200 recorded (нормализира се до NULL)', () => {
      if (r.status !== 200 || b.ok !== true || b.recorded !== true) {
        throw new Error(`${r.status} ${JSON.stringify(b)}`)
      }
    })
    const db = new DatabaseSync(isolated.databaseFile)
    try {
      const row = db.prepare(`SELECT view_layout FROM site_visit_events WHERE page_view_id = ?`).get(p.pageViewId) as { view_layout: string | null } | undefined
      await check('[12.8] невалиден viewLayout → view_layout = NULL в БД', () => {
        if (row?.view_layout !== null) throw new Error(`view_layout=${String(row?.view_layout)}`)
      })
    } finally {
      db.close()
    }
  }

  // [12.9] /api/admin/stats включва viewLayout поле
  {
    const runId = `${Date.now()}-${process.pid}`
    const adminEmail = `viewlayout-admin-${runId}@example.test`
    const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: PASSWORD, displayName: 'LayoutAdmin', gender: 'male' }),
    })
    if (regRes.status !== 200) {
      fail('[12.9] регистрация на admin', new Error(`status=${regRes.status}`))
    } else {
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

      if (!adminCookie) {
        fail('[12.9] admin cookie', new Error('Липсва Set-Cookie при login.'))
      } else {
        const statsRes = await httpJson(port, '/api/admin/stats', 'GET', undefined, adminCookie)
        const statsBody = statsRes.body as Record<string, unknown>
        const stats = statsBody.stats as Record<string, unknown> | undefined
        const viewLayout = stats?.viewLayout as Record<string, unknown> | undefined
        const today = viewLayout?.today as Record<string, unknown> | undefined

        await check('[12.9] /api/admin/stats съдържа viewLayout обект', () => {
          if (!viewLayout || typeof viewLayout !== 'object') {
            throw new Error(`viewLayout=${String(viewLayout)}`)
          }
        })
        await check('[12.10] viewLayout.today.mobile е integer ≥ 0', () => {
          if (!Number.isInteger(today?.mobile) || (today.mobile as number) < 0) {
            throw new Error(`today.mobile=${String(today?.mobile)}`)
          }
        })
        await check('[12.11] viewLayout.today.desktop е integer ≥ 0', () => {
          if (!Number.isInteger(today?.desktop) || (today.desktop as number) < 0) {
            throw new Error(`today.desktop=${String(today?.desktop)}`)
          }
        })
        await check('[12.12] visitors (COUNT DISTINCT) все още присъства и не е нарушен', () => {
          const visitors = stats?.visitors as Record<string, unknown> | undefined
          if (!Number.isInteger(visitors?.today) || !Number.isInteger(visitors?.last7days)) {
            throw new Error(`visitors=${JSON.stringify(visitors)}`)
          }
        })
      }
    }
  }

} catch (err) {
  fail('Непредвидена грешка в HTTP тестовете', err)
  if (server) console.error('\n[server output]\n' + server.output().slice(-2000))
  console.error(err)
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

// ─── Резюме ───────────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}

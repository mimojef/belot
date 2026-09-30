/**
 * checkProfileVisitHistoryRetention.ts
 *
 * Regression за Фаза 2 на site_visit_events retention оптимизацията:
 *   * adminProfileRiskStore / profileHardDeleteService / siteVisitStore
 *     forensic helper-ите четат историческите profile<->visitor/IP връзки от
 *     compact profile_visitor_links / profile_ip_links;
 *   * raw site_visit_events retention 90 → 35 дни, site_visitors отделно 365
 *     дни по last_seen_at;
 *   * batch-нат async purge с кратък busy_timeout и контролиран SQLITE_BUSY
 *     retry.
 *
 * Старият raw алгоритъм е fixtures/legacyRawAdminProfileRiskStore.ts
 * (точното съдържание на adminProfileRiskStore.ts преди Фаза 2) — 1:1
 * сравнение върху една и съща база. Реална SQLite база с всички migrations.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createSiteVisitStore, type RecordSitePageViewInput, type SiteVisitStore } from '../src/db/siteVisitStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { createAdminProfileRiskStore } from '../src/db/adminProfileRiskStore.js'
import { backfillProfileVisitLinks, createProfileVisitLinkReader, createProfileVisitLinkWriter, type ProfileVisitLinkWriter } from '../src/db/profileVisitLinks.js'
import { verifyProfileVisitLinks } from '../src/db/profileVisitLinkVerification.js'
import { toSqliteUtc } from '../src/db/sofiaDayBounds.js'
import { createLegacyRawAdminProfileRiskStore } from './fixtures/legacyRawAdminProfileRiskStore.js'

let passed = 0
let failed = 0

const seenTags = new Set<string>()
const failedTags = new Set<string>()
const tagPassed = (tag: string) => seenTags.has(tag) && !failedTags.has(tag)

function check(label: string, condition: boolean, details = ''): void {
  const tag = /^\[(\d+)\]/.exec(label)?.[1]
  if (tag !== undefined) {
    seenTags.add(tag)
    if (!condition) failedTags.add(tag)
  }
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

const serverRootPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')

async function createMigratedDatabase(prefix: string): Promise<{ dbPath: string; db: DatabaseSync }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const dbPath = join(dir, 'server.db')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(`CREATE TABLE IF NOT EXISTS server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
  const files = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const filename of files) {
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith('-- MANUAL_TRANSACTION_MIGRATION')) {
      db.exec(sql)
    } else {
      db.exec('BEGIN;')
      try {
        db.exec(sql)
        db.exec('COMMIT;')
      } catch (error) {
        try { db.exec('ROLLBACK;') } catch {}
        throw new Error(`migration ${filename}: ${String(error)}`)
      }
    }
    db.prepare(`INSERT OR IGNORE INTO server_migrations (filename) VALUES (?);`).run(filename)
  }
  return { dbPath, db }
}

function insertProfile(db: DatabaseSync, profileId: string, role = 'player'): void {
  db.prepare(`INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'hash', ?, 'active');`)
    .run(profileId, `${profileId}@example.test`, role)
  db.prepare(`INSERT OR IGNORE INTO profiles (profile_id, account_id, display_name, normalized_display_name, profile_kind, status) VALUES (?, ?, ?, ?, 'human', 'active');`)
    .run(profileId, profileId, profileId, profileId.toLowerCase())
}

// Премахва профил БЕЗ admin hard delete (както playerProgressStore трие
// temporary профили) — raw profile_id става NULL, compact редовете остават.
function removeProfileDirectly(db: DatabaseSync, profileId: string): void {
  db.prepare(`DELETE FROM profiles WHERE profile_id = ?;`).run(profileId)
  db.prepare(`DELETE FROM accounts WHERE account_id = ?;`).run(profileId)
}

function pageView(overrides: Partial<RecordSitePageViewInput> & Pick<RecordSitePageViewInput, 'anonymousVisitorId' | 'profileId' | 'ipAddress'>): RecordSitePageViewInput {
  return {
    pageViewId: randomUUID(),
    path: '/lobby',
    navigationType: 'navigate',
    referrer: null,
    source: null,
    attributionReferrer: null,
    attributionSource: null,
    utm: { utmSource: null, utmMedium: null, utmCampaign: null, utmTerm: null, utmContent: null },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    viewLayout: 'desktop',
    isEntry: true,
    lastDeviceType: 'desktop',
    lastOsType: 'windows',
    ...overrides,
  }
}

const NOW = new Date()
const DAY_MS = 86_400_000
const ago = (days: number, extraSeconds = 0) => toSqliteUtc(new Date(NOW.getTime() - days * DAY_MS + extraSeconds * 1000))

type HistoricalEvent = {
  visitorId: string
  profileId: string | null
  ip: string | null
  at: string
  navigationType?: 'navigate' | 'reload'
  viewLayout?: 'mobile' | 'desktop' | null
  isEntry?: boolean
  source?: string | null
  referrer?: string | null
  deviceType?: string
}

// Page view с explicit clock — същото като recordPageView (site_visitors
// upsert + raw event + compact dual-write в една транзакция), но occurred_at/
// first_seen_at/last_seen_at са подадени, за да можем да строим история.
function recordHistoricalEvent(db: DatabaseSync, writer: ProfileVisitLinkWriter, event: HistoricalEvent): string {
  const id = randomUUID()
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`
      INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_profile_id, last_profile_id,
        first_ip_address, last_ip_address, first_referrer, last_referrer, first_source, last_source, last_device_type, last_os_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'windows')
      ON CONFLICT (anonymous_visitor_id) DO UPDATE SET
        first_seen_at = min(site_visitors.first_seen_at, excluded.first_seen_at),
        last_profile_id = CASE WHEN excluded.last_seen_at >= site_visitors.last_seen_at THEN excluded.last_profile_id ELSE site_visitors.last_profile_id END,
        last_seen_at = max(site_visitors.last_seen_at, excluded.last_seen_at);
    `).run(event.visitorId, event.at, event.at, event.profileId, event.profileId, event.ip, event.ip,
      event.referrer ?? null, event.referrer ?? null, event.source ?? null, event.source ?? null, event.deviceType ?? 'desktop')
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, ip_address, occurred_at, view_layout, is_entry, source, referrer)
      VALUES (?, ?, ?, '/lobby', ?, ?, ?, ?, ?, ?, ?);
    `).run(id, event.visitorId, event.profileId, event.navigationType ?? 'navigate', event.ip, event.at,
      event.viewLayout === undefined ? 'desktop' : event.viewLayout, event.isEntry === false ? 0 : 1, event.source ?? null, event.referrer ?? null)
    writer.recordLinksForEvent(id)
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch {}
    throw error
  }
  return id
}

const countRows = (db: DatabaseSync, sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n
const dumpLinks = (db: DatabaseSync) => JSON.stringify({
  v: db.prepare(`SELECT * FROM profile_visitor_links ORDER BY profile_id, anonymous_visitor_id;`).all(),
  i: db.prepare(`SELECT * FROM profile_ip_links ORDER BY profile_id, ip_address;`).all(),
})
const dumpRiskChecks = (db: DatabaseSync) => JSON.stringify(db.prepare(`
  SELECT profile_id, risk_detected, linked_profiles_count, check_complete FROM admin_profile_risk_checks ORDER BY profile_id;
`).all())
const normalizeDetailed = (rows: Array<{ profileId: string; sharedVisitorIdsCount: number; sharedIpCount: number }>) =>
  JSON.stringify(rows.map((row) => [row.profileId, row.sharedVisitorIdsCount, row.sharedIpCount]).sort())
const rawLatestActivity = (db: DatabaseSync, visitorId: string) =>
  (db.prepare(`SELECT MAX(occurred_at) AS mx FROM site_visit_events WHERE anonymous_visitor_id = ?;`).get(visitorId) as { mx: string | null }).mx

// Детерминиран pseudo-random граф изцяло В raw прозореца (1..30 дни назад),
// за да може старият raw алгоритъм да служи като reference.
const GRAPH_PROFILES = Array.from({ length: 14 }, (_, i) => `g-${String(i).padStart(2, '0')}`)
const GRAPH_VISITORS = Array.from({ length: 10 }, (_, i) => `gdev-${i}`)
const GRAPH_IPS = Array.from({ length: 8 }, (_, i) => `203.0.113.${20 + i}`)
// g-13 се премахва (temporary profile pattern) — никога не е target на risk check.
const ACTIVE_GRAPH_PROFILES = GRAPH_PROFILES.filter((id) => id !== 'g-13')

async function buildGraphDatabase(prefix: string): Promise<{ dbPath: string; db: DatabaseSync }> {
  const created = await createMigratedDatabase(prefix)
  const { db } = created
  GRAPH_PROFILES.forEach((id) => insertProfile(db, id))
  const writer = createProfileVisitLinkWriter(db)
  let seed = 11
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n) }
  for (let i = 0; i < 500; i += 1) {
    recordHistoricalEvent(db, writer, {
      visitorId: GRAPH_VISITORS[rand(GRAPH_VISITORS.length)]!,
      profileId: rand(7) === 0 ? null : GRAPH_PROFILES[rand(GRAPH_PROFILES.length)]!,
      ip: rand(12) === 0 ? null : GRAPH_IPS[rand(GRAPH_IPS.length)]!,
      at: ago(1 + rand(29), -rand(80_000)),
    })
  }
  // Profile, премахнат без admin hard delete (temporary profile pattern).
  recordHistoricalEvent(db, writer, { visitorId: GRAPH_VISITORS[0]!, profileId: 'g-13', ip: GRAPH_IPS[0]!, at: ago(3) })
  removeProfileDirectly(db, 'g-13')
  return created
}

// ═══ 1–4. Raw (legacy) vs compact: linked profiles, shared IP, latest activity, recheck ═══
{
  const { dbPath, db } = await buildGraphDatabase('belot-phase2-graph-')
  const legacy = await createLegacyRawAdminProfileRiskStore(dbPath)
  const riskStore = await createAdminProfileRiskStore(dbPath)
  const reader = createProfileVisitLinkReader(db)
  const store = await createSiteVisitStore(dbPath)

  let detailedEqual = true
  let nonEmpty = 0
  let withSharedIp = 0
  for (const profileId of GRAPH_PROFILES) {
    const raw = legacy.getDetailedLinkedProfiles(profileId)
    const compact = riskStore.getDetailedLinkedProfiles(profileId)
    if (normalizeDetailed(raw) !== normalizeDetailed(compact)) {
      detailedEqual = false
      console.error(`    ${profileId}: raw=${normalizeDetailed(raw)} compact=${normalizeDetailed(compact)}`)
    }
    if (raw.length > 0) nonEmpty += 1
    withSharedIp += raw.filter((row) => row.sharedIpCount > 0).length
  }
  check(`[1] raw linked profiles == compact linked profiles (legacy vs production, ${nonEmpty} профила с връзки)`, detailedEqual && nonEmpty > 5)
  check('[1] премахнат профил не е linked profile нито в raw, нито в compact',
    GRAPH_PROFILES.every((id) => !riskStore.getDetailedLinkedProfiles(id).some((row) => row.profileId === 'g-13') &&
      !legacy.getDetailedLinkedProfiles(id).some((row) => row.profileId === 'g-13')))
  check('[1] compact историята на премахнатия профил остава (forensic)', reader.findVisitorLinksForProfileIncludingDeleted('g-13').length > 0)

  check(`[2] shared IP equivalence покрита (${withSharedIp} linked двойки със sharedIpCount > 0)`, withSharedIp > 0)
  let hasIpEqual = true
  for (const profileId of GRAPH_PROFILES) {
    for (const ip of GRAPH_IPS) {
      const raw = db.prepare(`SELECT 1 FROM site_visit_events WHERE profile_id = ? AND ip_address = ? LIMIT 1;`).get(profileId, ip) !== undefined
      if (raw !== store.hasProfileEventFromIp(profileId, ip)) hasIpEqual = false
    }
  }
  check('[2] siteVisitStore.hasProfileEventFromIp: raw == compact за всички profile×IP', hasIpEqual)
  let visitorProfilesEqual = true
  for (const visitorId of GRAPH_VISITORS) {
    const raw = (db.prepare(`SELECT DISTINCT profile_id FROM site_visit_events WHERE anonymous_visitor_id = ? AND profile_id IS NOT NULL;`).all(visitorId) as Array<{ profile_id: string }>)
      .map((row) => row.profile_id).sort()
    if (JSON.stringify(raw) !== JSON.stringify(store.findProfileIdsForVisitorId(visitorId).sort())) visitorProfilesEqual = false
  }
  check('[2] siteVisitStore.findProfileIdsForVisitorId: raw == compact за всички visitors', visitorProfilesEqual)

  let latestEqual = true
  let guestNewerThanProfiled = 0
  const activity = reader.findLatestActivityAtForVisitorIds(GRAPH_VISITORS)
  const profiledOnly = reader.findLatestEvidenceAtForVisitorIds(GRAPH_VISITORS)
  for (const visitorId of GRAPH_VISITORS) {
    const raw = rawLatestActivity(db, visitorId)
    if ((activity.get(visitorId) ?? null) !== raw) {
      latestEqual = false
      console.error(`    ${visitorId}: raw=${raw} activity=${activity.get(visitorId)} site_visitors=${JSON.stringify(db.prepare(`SELECT last_seen_at FROM site_visitors WHERE anonymous_visitor_id = ?;`).get(visitorId))}`)
    }
    if ((profiledOnly.get(visitorId) ?? '') < (raw ?? '')) guestNewerThanProfiled += 1
  }
  check('[3] findLatestActivityAtForVisitorIds == стария raw MAX(occurred_at) за всички visitors', latestEqual)
  check(`[3] сценарият реално съдържа guest активност, по-нова от profiled evidence (${guestNewerThanProfiled} visitors) — само compact evidence би се разминал`, guestNewerThanProfiled > 0)

  legacy.close()
  riskStore.close()
  store.close()
  db.close()
}

// [4] Recheck / cache invalidation: СЪЩАТА последователност в две идентични
// бази — legacy raw store срещу production (compact) store.
{
  const runSequence = async (useLegacy: boolean): Promise<{ checks: string[]; guestPartnerInvalidated: boolean; profiledOnlyWouldMiss: boolean }> => {
    const { dbPath, db } = await buildGraphDatabase(useLegacy ? 'belot-phase2-legacy-' : 'belot-phase2-compact-')
    const writer = createProfileVisitLinkWriter(db)
    // Детерминиран guest сценарий: visitor 'guest-dev' свързва g-guest-a и
    // g-guest-b стари profiled събития; по-късно — САМО guest page view.
    insertProfile(db, 'g-guest-a')
    insertProfile(db, 'g-guest-b')
    recordHistoricalEvent(db, writer, { visitorId: 'guest-dev', profileId: 'g-guest-a', ip: '198.51.100.70', at: ago(25) })
    recordHistoricalEvent(db, writer, { visitorId: 'guest-dev', profileId: 'g-guest-b', ip: '198.51.100.71', at: ago(24) })

    const risk = useLegacy ? await createLegacyRawAdminProfileRiskStore(dbPath) : await createAdminProfileRiskStore(dbPath)
    const firstHalf = ACTIVE_GRAPH_PROFILES.slice(0, 7)
    const secondHalf = ACTIVE_GRAPH_PROFILES.slice(7)
    const snapshots: string[] = []

    risk.computeAndCacheRiskForProfiles([...firstHalf, 'g-guest-b'])
    snapshots.push(dumpRiskChecks(db))
    // Всички checks „стават“ отпреди 15 дни — част от shared evidence е по-нова.
    db.prepare(`UPDATE admin_profile_risk_checks SET checked_at = ?;`).run(ago(15))
    recordHistoricalEvent(db, writer, { visitorId: 'guest-dev', profileId: null, ip: '198.51.100.72', at: ago(5) })
    risk.computeAndCacheRiskForProfiles([...secondHalf, 'g-guest-a'])
    snapshots.push(dumpRiskChecks(db))
    const guestPartnerInvalidated = (db.prepare(`SELECT check_complete FROM admin_profile_risk_checks WHERE profile_id = 'g-guest-b';`).get() as { check_complete: number }).check_complete === 0
    const profiledOnlyWouldMiss = (createProfileVisitLinkReader(db).findLatestEvidenceAtForVisitorIds(['guest-dev']).get('guest-dev') ?? '') <= ago(15)

    for (const profileId of ['g-01', 'g-08', 'g-guest-b']) risk.recheckSingleProfile(profileId)
    snapshots.push(dumpRiskChecks(db))
    // Вече напълно проверени профили без нова evidence → без ping-pong.
    risk.computeAndCacheRiskForProfiles(ACTIVE_GRAPH_PROFILES)
    snapshots.push(dumpRiskChecks(db))
    risk.close()
    db.close()
    return { checks: snapshots, guestPartnerInvalidated, profiledOnlyWouldMiss }
  }

  const legacyRun = await runSequence(true)
  const compactRun = await runSequence(false)
  let allEqual = true
  legacyRun.checks.forEach((snapshot, index) => {
    if (snapshot !== compactRun.checks[index]) {
      allEqual = false
      console.error(`    step ${index}: legacy=${snapshot}\n             compact=${compactRun.checks[index]}`)
    }
  })
  check('[4] admin_profile_risk_checks (risk/count/check_complete) след compute → invalidation → recheck → recompute: legacy raw == compact', allEqual)
  check('[4] guest-only нова активност invalidate-ва fully-checked partner (и в двата алгоритъма)', legacyRun.guestPartnerInvalidated && compactRun.guestPartnerInvalidated)
  check('[4] …а само profiled compact evidence НЕ би го хванал (затова findLatestActivityAtForVisitorIds)', compactRun.profiledOnlyWouldMiss)
}

// ═══ 5–6. Hard delete + compact history след raw retention ═════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-delete-')
  for (const id of ['admin', 'x', 'y', 'z', 'tmp']) insertProfile(db, id, id === 'admin' ? 'admin' : 'player')
  const writer = createProfileVisitLinkWriter(db)
  // Стара (60 дни) история — единствената връзка x <-> y.
  recordHistoricalEvent(db, writer, { visitorId: 'old-dev', profileId: 'x', ip: '192.0.2.10', at: ago(60) })
  recordHistoricalEvent(db, writer, { visitorId: 'old-dev', profileId: 'x', ip: '192.0.2.10', at: ago(59) })
  recordHistoricalEvent(db, writer, { visitorId: 'old-dev', profileId: 'y', ip: '192.0.2.10', at: ago(58) })
  recordHistoricalEvent(db, writer, { visitorId: 'old-dev', profileId: 'tmp', ip: '192.0.2.11', at: ago(50) })
  // Скорошна история (1 час) — x и z на един IP, различни устройства.
  recordHistoricalEvent(db, writer, { visitorId: 'x-dev', profileId: 'x', ip: '192.0.2.99', at: ago(0, -3600) })
  recordHistoricalEvent(db, writer, { visitorId: 'z-dev', profileId: 'z', ip: '192.0.2.99', at: ago(0, -1800) })
  removeProfileDirectly(db, 'tmp')

  const store = await createSiteVisitStore(dbPath)
  const purge = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchPauseMs: 0, now: NOW })
  check('[5] raw retention изтри старата история (x<->y връзката вече я няма в raw)', purge.deletedEvents === 4 &&
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE anonymous_visitor_id = 'old-dev';`) === 0, JSON.stringify(purge))

  const legacy = await createLegacyRawAdminProfileRiskStore(dbPath)
  const riskStore = await createAdminProfileRiskStore(dbPath)
  check('[5] стария raw алгоритъм вече НЕ вижда x<->y (raw retention не стига)', legacy.getDetailedLinkedProfiles('y').length === 0)
  check('[5] compact алгоритъмът вижда x<->y (shared visitor 1, shared IP 1)',
    normalizeDetailed(riskStore.getDetailedLinkedProfiles('y')) === normalizeDetailed([{ profileId: 'x', sharedVisitorIdsCount: 1, sharedIpCount: 1 }]))
  const yCheck = riskStore.recheckSingleProfile('y')
  check('[5] recheck(y) преди delete: risk + 1 linked (x), check_complete=1', yCheck.riskDetected && yCheck.linkedProfilesCount === 1 && yCheck.checkComplete)
  const zCheck = riskStore.recheckSingleProfile('z')
  check('[5] z (само общ IP, различен visitor) не е linked — IP не създава linked profile, както и досега', !zCheck.riskDetected)

  const linksBefore = dumpLinks(db)
  const hardDeleteService = await createProfileHardDeleteService(dbPath, { deleteUploadFileByUrl: async () => {} })
  const deletion = await hardDeleteService.hardDeleteProfile({ targetProfileId: 'x', actorProfileId: 'admin', actorAccountId: 'admin', reason: 'Фаза 2 регресионен тест' })
  check('[5] hard delete успешен', deletion.ok === true, JSON.stringify(deletion))
  check('[5] compact visitor/IP връзките (вкл. отпреди raw retention) оцеляват НЕПРОМЕНЕНИ — без CASCADE загуба', dumpLinks(db) === linksBefore)
  check('[5] risk cache на y е invalidated чрез compact връзката (raw вече я няма)',
    (db.prepare(`SELECT check_complete FROM admin_profile_risk_checks WHERE profile_id = 'y';`).get() as { check_complete: number }).check_complete === 0)
  const snapshotRows = db.prepare(`SELECT anonymous_visitor_id, ip_address, event_count FROM admin_profile_deletion_visitor_snapshots WHERE deleted_profile_id = 'x';`).all() as Array<{ anonymous_visitor_id: string; ip_address: string; event_count: number }>
  check('[5] deletion snapshot механизмът е непроменен (raw прозорецът: x-dev/192.0.2.99 ×1)',
    snapshotRows.length === 1 && snapshotRows[0]!.anonymous_visitor_id === 'x-dev' && snapshotRows[0]!.event_count === 1, JSON.stringify(snapshotRows))
  check('[5] findDeletedProfileIdsForVisitorId(old-dev) = [x] — стар мост през compact, temporary профилът НЕ е hard-deleted',
    JSON.stringify(hardDeleteService.findDeletedProfileIdsForVisitorId('old-dev')) === '["x"]', JSON.stringify(hardDeleteService.findDeletedProfileIdsForVisitorId('old-dev')))
  check('[5] findDeletedProfileIdsForVisitorId(x-dev) = [x] веднъж (snapshot + compact, без дубликат)',
    JSON.stringify(hardDeleteService.findDeletedProfileIdsForVisitorId('x-dev')) === '["x"]')
  check('[5] findDeletedProfileIdsForIp(recent) = [x] веднъж; стар IP (>48h) → []',
    JSON.stringify(hardDeleteService.findDeletedProfileIdsForIp('192.0.2.99')) === '["x"]' && hardDeleteService.findDeletedProfileIdsForIp('192.0.2.10').length === 0)
  backfillProfileVisitLinks(db)
  check('[5] backfill след delete (snapshot merge) НЕ удвоява compact event_count', dumpLinks(db) === linksBefore)
  const verify = verifyProfileVisitLinks(db)
  check('[5] verification OK след purge + hard delete', verify.ok, verify.failures.join(' | '))

  check('[6] изтритият профил НЕ се показва като active linked profile', !riskStore.getDetailedLinkedProfiles('y').some((row) => row.profileId === 'x'))
  const yAfter = riskStore.recheckSingleProfile('y')
  check('[6] recheck(y) след delete: без risk, 0 linked', !yAfter.riskDetected && yAfter.linkedProfilesCount === 0)
  const reader = createProfileVisitLinkReader(db)
  check('[6] forensic reader (вкл. изтрити) пази старата x<->old-dev връзка (2 събития)',
    reader.findVisitorLinksForProfileIncludingDeleted('x').some((link) => link.anonymousVisitorId === 'old-dev' && link.eventCount === 2))

  hardDeleteService.close()
  legacy.close()
  riskStore.close()
  store.close()
  db.close()
}

// ═══ 7. 35-дневна граница ══════════════════════════════════════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-boundary-')
  insertProfile(db, 'b')
  const writer = createProfileVisitLinkWriter(db)
  const ids = {
    beforeCutoff: recordHistoricalEvent(db, writer, { visitorId: 'b-dev', profileId: 'b', ip: '192.0.2.1', at: ago(35, -1) }),
    atCutoff: recordHistoricalEvent(db, writer, { visitorId: 'b-dev', profileId: 'b', ip: '192.0.2.1', at: ago(35) }),
    afterCutoff: recordHistoricalEvent(db, writer, { visitorId: 'b-dev', profileId: 'b', ip: '192.0.2.1', at: ago(35, 1) }),
    day34: recordHistoricalEvent(db, writer, { visitorId: 'b-dev', profileId: 'b', ip: '192.0.2.1', at: ago(34) }),
  }
  const store = await createSiteVisitStore(dbPath)
  const result = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchPauseMs: 0, now: NOW })
  const exists = (id: string) => countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE page_view_id = ?;`, id) === 1
  check(`[7] cutoff = now − 35 дни (${result.eventCutoff})`, result.eventCutoff === ago(35))
  check('[7] събитие 1s преди cutoff-а се трие; точно на cutoff-а и след него остават',
    !exists(ids.beforeCutoff) && exists(ids.atCutoff) && exists(ids.afterCutoff) && exists(ids.day34) && result.deletedEvents === 1)
  store.close()
  db.close()
}

// ═══ 8–9. 30-дневните Admin статистики остават пълни; site_visitors остава ═══
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-stats-')
  const writer = createProfileVisitLinkWriter(db)
  const statProfiles = Array.from({ length: 6 }, (_, i) => `s-${i}`)
  statProfiles.forEach((id) => insertProfile(db, id))
  const sources = [null, 'facebook', 'google', 'instagram']
  const referrers = [null, 'https://www.facebook.com/post', 'https://google.com/search', null]
  let seed = 3
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n) }
  // 40 visitors, събития разпръснати в последните 90 дни (хронологично).
  for (let v = 0; v < 40; v += 1) {
    const visitorId = `sv-${v}`
    const firstDaysAgo = 1 + rand(89)
    const sourceIndex = rand(sources.length)
    const profileId = rand(3) === 0 ? null : statProfiles[rand(statProfiles.length)]!
    const deviceType = rand(2) === 0 ? 'mobile' : 'desktop'
    for (let e = 0; e < 1 + rand(8); e += 1) {
      const daysAgo = Math.max(0, firstDaysAgo - rand(firstDaysAgo + 1))
      recordHistoricalEvent(db, writer, {
        visitorId,
        profileId,
        ip: `198.51.100.${v}`,
        at: ago(daysAgo, -rand(50_000)),
        navigationType: rand(4) === 0 ? 'reload' : 'navigate',
        viewLayout: deviceType === 'mobile' ? 'mobile' : 'desktop',
        isEntry: rand(3) !== 0,
        source: sources[sourceIndex] ?? null,
        referrer: referrers[sourceIndex] ?? null,
        deviceType,
      })
    }
  }
  // Гарантирани събития днес / вчера.
  recordHistoricalEvent(db, writer, { visitorId: 'sv-today', profileId: null, ip: '198.51.100.200', at: ago(0, -60), source: 'facebook', referrer: 'https://facebook.com' })
  recordHistoricalEvent(db, writer, { visitorId: 'sv-yesterday', profileId: 's-1', ip: '198.51.100.201', at: ago(1), navigationType: 'reload' })

  const store = await createSiteVisitStore(dbPath)
  const periods = ['today', 'yesterday', '7d', '30d'] as const
  const snapshotStats = (s: SiteVisitStore) => JSON.stringify({
    summary: s.getVisitorSummary(NOW),
    layout: s.getViewLayoutSummary(NOW),
    lists: periods.flatMap((period) => (['all', 'guest', 'registered'] as const).flatMap((type) =>
      (['all', 'mobile', 'desktop'] as const).map((device) => s.getVisitorList({ period, type, device, os: 'all', limit: 200, offset: 0 }, NOW)))),
    sources: periods.map((period) => s.getVisitorSources({ period, type: 'all', device: 'all', os: 'all' }, NOW)),
  })
  const before = snapshotStats(store)
  const visitorsBefore = countRows(db, `SELECT COUNT(*) AS n FROM site_visitors;`)
  const oldOnlyVisitors = countRows(db, `SELECT COUNT(*) AS n FROM site_visitors v WHERE NOT EXISTS (SELECT 1 FROM site_visit_events e WHERE e.anonymous_visitor_id = v.anonymous_visitor_id AND e.occurred_at >= ?);`, ago(35))
  const result = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchPauseMs: 0, batchSize: 7, now: NOW })
  const after = snapshotStats(store)
  const parsed = JSON.parse(before) as { summary: { last30days: number; today: number; yesterday: number }; lists: Array<{ total: number }> }
  check(`[8] purge реално изтри стари raw събития (${result.deletedEvents}, ${result.eventBatches} batch-а)`, result.deletedEvents > 0 && result.outcome === 'completed')
  check(`[8] today/yesterday/7d/30d, mobile/desktop, visitor list, page views/reloads и sources са ИДЕНТИЧНИ преди/след purge (30d=${parsed.summary.last30days}, today=${parsed.summary.today}, yesterday=${parsed.summary.yesterday})`,
    before === after && parsed.summary.last30days > 0 && parsed.summary.today > 0 && parsed.summary.yesterday > 0)
  check(`[9] site_visitors остава след raw-event purge (${oldOnlyVisitors} visitors вече без raw събития)`,
    countRows(db, `SELECT COUNT(*) AS n FROM site_visitors;`) === visitorsBefore && oldOnlyVisitors > 0 && result.deletedVisitors === 0)
  store.close()
  db.close()
}

// ═══ 10. site_visitors се трие едва след 365 дни ═══════════════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-visitors-')
  const insertVisitor = (id: string, lastSeen: string) =>
    db.prepare(`INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_source) VALUES (?, ?, ?, 'old');`).run(id, lastSeen, lastSeen)
  insertVisitor('v-366', ago(366))
  insertVisitor('v-364', ago(364))
  insertVisitor('v-40', ago(40))
  // Visitor с остаряло last_seen_at, но със скорошно raw събитие (напр.
  // регистрация — authStore не обновява last_seen_at): НЕ се трие, иначе
  // ON DELETE CASCADE би изтрил и събитието.
  insertVisitor('v-400-with-event', ago(400))
  db.prepare(`INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, path, navigation_type, occurred_at) VALUES (?, 'v-400-with-event', '/register', 'navigate', ?);`).run(randomUUID(), ago(3))
  const store = await createSiteVisitStore(dbPath)
  const result = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchPauseMs: 0, now: NOW })
  const has = (id: string) => countRows(db, `SELECT COUNT(*) AS n FROM site_visitors WHERE anonymous_visitor_id = ?;`, id) === 1
  check('[10] visitor с last_seen_at > 365 дни се трие; 364 и 40 дни остават', !has('v-366') && has('v-364') && has('v-40') && result.deletedVisitors === 1, JSON.stringify(result))
  check('[10] visitor със скорошно raw събитие НЕ се трие (събитието оцелява)', has('v-400-with-event') &&
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE anonymous_visitor_id = 'v-400-with-event';`) === 1)
  check(`[10] visitorCutoff = now − 365 дни (${result.visitorCutoff})`, result.visitorCutoff === ago(365))
  insertVisitor('v-20', ago(20))
  const clamped = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 10, batchPauseMs: 0, now: NOW })
  check('[10] visitorRetentionDays никога не е по-кратък от eventRetentionDays (10 → 35: v-20 остава, v-40 се трие)',
    clamped.visitorCutoff === ago(35) && has('v-20') && !has('v-40'))
  store.close()
  db.close()
}

// ═══ 11–12. Връщащ се visitor след > 35 дни ═══════════════════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-returning-')
  insertProfile(db, 'r')
  const writer = createProfileVisitLinkWriter(db)
  recordHistoricalEvent(db, writer, { visitorId: 'returning', profileId: null, ip: '192.0.2.50', at: ago(60), source: 'facebook', referrer: 'https://www.facebook.com/ad' })
  recordHistoricalEvent(db, writer, { visitorId: 'returning', profileId: 'r', ip: '192.0.2.50', at: ago(59) })
  const store = await createSiteVisitStore(dbPath)
  await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchPauseMs: 0, now: NOW })
  check('[11] след purge raw събитията на visitor-а ги няма, site_visitors редът остава',
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE anonymous_visitor_id = 'returning';`) === 0 &&
    countRows(db, `SELECT COUNT(*) AS n FROM site_visitors WHERE anonymous_visitor_id = 'returning';`) === 1)

  const newTodayBefore = store.getVisitorSummary(new Date()).newToday
  store.recordPageView(pageView({ anonymousVisitorId: 'returning', profileId: 'r', ipAddress: '192.0.2.51', attributionSource: 'google', attributionReferrer: 'https://google.com' }))
  store.recordPageView(pageView({ anonymousVisitorId: 'brand-new', profileId: null, ipAddress: '192.0.2.52', attributionSource: 'instagram', attributionReferrer: 'https://instagram.com' }))
  const summary = store.getVisitorSummary(new Date())
  check('[11] връщащ се visitor (>35 дни) НЕ се брои като „нов“ — само brand-new', summary.newToday - newTodayBefore === 1 && summary.today >= 2,
    `newToday ${newTodayBefore} → ${summary.newToday}`)
  const returning = db.prepare(`SELECT first_seen_at, first_source, first_referrer, last_source FROM site_visitors WHERE anonymous_visitor_id = 'returning';`).get() as { first_seen_at: string; first_source: string; first_referrer: string; last_source: string }
  check('[12] first_seen_at/first_source/first_referrer са запазени; last_source е обновен',
    returning.first_seen_at === ago(60) && returning.first_source === 'facebook' && returning.first_referrer === 'https://www.facebook.com/ad' && returning.last_source === 'google', JSON.stringify(returning))
  const todaySources = store.getVisitorSources({ period: 'today', type: 'all', device: 'all', os: 'all' })
  check('[12] Admin „източници“ днес отчитат first source (Facebook за връщащия се, Instagram за новия)',
    todaySources.rows.some((row) => row.label === 'Facebook' && row.visitors === 1) && todaySources.rows.some((row) => row.label === 'Instagram' && row.visitors === 1) &&
    !todaySources.rows.some((row) => row.label === 'Google'), JSON.stringify(todaySources.rows))
  store.close()
  db.close()
}

// ═══ 13, 15, 16. Batch purge, продължаване, идемпотентност, compact непипнат ═══
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-batch-')
  insertProfile(db, 'bp-1')
  insertProfile(db, 'bp-2')
  const writer = createProfileVisitLinkWriter(db)
  for (let i = 0; i < 1234; i += 1) {
    recordHistoricalEvent(db, writer, { visitorId: `bdev-${i % 50}`, profileId: i % 3 === 0 ? null : (i % 2 === 0 ? 'bp-1' : 'bp-2'), ip: `192.0.2.${i % 40}`, at: ago(40 + (i % 50), -i) })
  }
  for (let i = 0; i < 10; i += 1) {
    recordHistoricalEvent(db, writer, { visitorId: `bdev-${i}`, profileId: 'bp-1', ip: '192.0.2.200', at: ago(i) })
  }
  const linksBefore = dumpLinks(db)
  const store = await createSiteVisitStore(dbPath)
  const sleeps: number[] = []
  const sleep = async (ms: number) => { sleeps.push(ms) }

  const stopped = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, now: NOW, sleep, shouldContinue: () => false })
  check('[13] shouldContinue=false → outcome stopped, нищо изтрито', stopped.outcome === 'stopped' && stopped.deletedEvents === 0)

  const limited = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, maxBatchesPerRun: 5, now: NOW, sleep })
  check('[13] batch-ове по 100: maxBatchesPerRun=5 → outcome batch_limit, точно 500 изтрити', limited.outcome === 'batch_limit' && limited.deletedEvents === 500 && limited.eventBatches === 5, JSON.stringify(limited))
  check('[13] пауза (event loop yield) между batch-овете', sleeps.length >= 4 && sleeps.every((ms) => ms === 100))
  check('[16] compact visitor/IP links НЕ са пипнати от частичния purge', dumpLinks(db) === linksBefore)

  const continued = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, now: NOW, sleep })
  check('[15] следващият run продължава и завършва остатъка (734 = 7 пълни + 1 частичен batch)',
    continued.outcome === 'completed' && continued.deletedEvents === 734 && continued.eventBatches === 8, JSON.stringify(continued))
  check('[15] всички стари събития са изтрити, 10-те скорошни остават',
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE occurred_at < ?;`, ago(35)) === 0 &&
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events;`) === 10)
  const again = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, now: NOW, sleep })
  check('[15] повторен run е идемпотентен (0 изтрити, completed)', again.outcome === 'completed' && again.deletedEvents === 0 && again.deletedVisitors === 0)
  check('[16] compact visitor/IP links НЕ са пипнати от целия purge', dumpLinks(db) === linksBefore)
  check('[16] site_visitors на изчистените visitors остават (365-дневен срок)', countRows(db, `SELECT COUNT(*) AS n FROM site_visitors;`) === 50)
  store.close()
  db.close()
}

// ═══ 14. Busy DB поведение ═════════════════════════════════════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-phase2-busy-')
  const writer = createProfileVisitLinkWriter(db)
  const seedOld = (count: number) => {
    for (let i = 0; i < count; i += 1) recordHistoricalEvent(db, writer, { visitorId: `busy-${i % 5}`, profileId: null, ip: null, at: ago(50, -i) })
  }
  seedOld(300)
  const store = await createSiteVisitStore(dbPath)
  const holder = new DatabaseSync(dbPath)
  holder.exec('PRAGMA journal_mode = WAL;')

  // (a) Lock-ът се освобождава по време на втория retry → run-ът завършва.
  holder.exec('BEGIN IMMEDIATE;')
  holder.exec(`INSERT INTO site_visitors (anonymous_visitor_id) VALUES ('lock-holder');`)
  let retrySleeps = 0
  const releasingSleep = async () => {
    retrySleeps += 1
    if (retrySleeps === 2) holder.exec('COMMIT;')
  }
  const recovered = await store.purgeOlderThanDays({
    eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, batchPauseMs: 0, now: NOW,
    batchBusyTimeoutMs: 50, busyRetryDelayMs: 0, maxBusyRetriesPerBatch: 5, sleep: releasingSleep,
  })
  check('[14] SQLITE_BUSY → контролиран async retry, после completed (2 retry-а, всички 300 изтрити)',
    recovered.outcome === 'completed' && recovered.busyRetries === 2 && recovered.deletedEvents === 300, JSON.stringify(recovered))

  // (b) Lock-ът НЕ се освобождава → outcome busy, без exception, bounded време.
  seedOld(120)
  holder.exec('BEGIN IMMEDIATE;')
  holder.exec(`INSERT INTO site_visitors (anonymous_visitor_id) VALUES ('lock-holder-2');`)
  const startedAt = Date.now()
  let threw = false
  let gaveUp: Awaited<ReturnType<SiteVisitStore['purgeOlderThanDays']>> | null = null
  try {
    gaveUp = await store.purgeOlderThanDays({
      eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, batchPauseMs: 0, now: NOW,
      batchBusyTimeoutMs: 50, busyRetryDelayMs: 0, maxBusyRetriesPerBatch: 2, sleep: async () => {},
    })
  } catch {
    threw = true
  }
  const elapsedMs = Date.now() - startedAt
  check(`[14] постоянен lock → outcome busy без exception, 0 изтрити, bounded (${elapsedMs}ms за 3 опита × 50ms busy_timeout)`,
    !threw && gaveUp?.outcome === 'busy' && gaveUp.busyRetries === 2 && gaveUp.deletedEvents === 0 && elapsedMs < 2000, JSON.stringify(gaveUp))
  holder.exec('COMMIT;')

  const pageViewResult = store.recordPageView(pageView({ anonymousVisitorId: 'after-busy', profileId: null, ipAddress: '192.0.2.77' }))
  check('[14] след busy отказа нормалните writes (recordPageView) работят', pageViewResult.recorded === true)
  // busy_timeout на връзката е върнат на 5000ms за нормалните writes: друг
  // ПРОЦЕС държи write lock ~400ms → recordPageView изчаква и минава (с
  // оставен 50ms cleanup timeout би хвърлил SQLITE_BUSY).
  const lockHolder = spawn(process.execPath, ['--no-warnings', '-e', `
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(process.argv[1])
    db.exec('BEGIN IMMEDIATE;')
    db.exec("INSERT INTO site_visitors (anonymous_visitor_id) VALUES ('lock-holder-3');")
    process.stdout.write('locked\\n')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    db.exec('COMMIT;')
    db.close()
  `, dbPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise<void>((resolve) => lockHolder.stdout!.once('data', () => resolve()))
  const lockedAt = Date.now()
  let waitedWrite = false
  try {
    waitedWrite = store.recordPageView(pageView({ anonymousVisitorId: 'after-busy-2', profileId: null, ipAddress: '192.0.2.78' })).recorded === true
  } catch (error) {
    console.error(`    recordPageView под lock: ${String(error)}`)
  }
  const waitedMs = Date.now() - lockedAt
  await new Promise<void>((resolve) => lockHolder.once('exit', () => resolve()))
  check(`[14] cleanup-ът връща busy_timeout=5000 за нормалните writes (recordPageView изчака чужд lock ${waitedMs}ms и мина)`, waitedWrite && waitedMs >= 200)
  const finalRun = await store.purgeOlderThanDays({ eventRetentionDays: 35, visitorRetentionDays: 365, batchSize: 100, batchPauseMs: 0, now: NOW })
  check('[15] след busy отказа следващият run довършва остатъка (120)', finalRun.outcome === 'completed' && finalRun.deletedEvents === 120, JSON.stringify(finalRun))
  holder.close()
  store.close()
  db.close()
}

// ═══ 17. EXPLAIN QUERY PLAN — compact reads и batch purge ═════════════════
{
  const { db } = await createMigratedDatabase('belot-phase2-plan-')
  const plan = (sql: string) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail)
  const plans: Array<[string, string[]]> = [
    ['visitor ids по profile', plan(`SELECT l.profile_id, l.anonymous_visitor_id FROM profile_visitor_links l JOIN profiles p ON p.profile_id = l.profile_id WHERE l.profile_id IN ('a', 'b')`)],
    ['profiles по visitor ids', plan(`SELECT l.anonymous_visitor_id, l.profile_id FROM profile_visitor_links l JOIN profiles p ON p.profile_id = l.profile_id WHERE l.anonymous_visitor_id IN ('a', 'b')`)],
    ['latest evidence по visitor', plan(`SELECT anonymous_visitor_id, MAX(last_seen_at) FROM profile_visitor_links WHERE anonymous_visitor_id IN ('a', 'b') GROUP BY anonymous_visitor_id`)],
    ['latest activity site_visitors', plan(`SELECT anonymous_visitor_id, last_seen_at FROM site_visitors WHERE anonymous_visitor_id IN ('a', 'b')`)],
    ['detailed: target visitor ids', plan(`SELECT l.anonymous_visitor_id FROM profile_visitor_links l JOIN profiles tp ON tp.profile_id = l.profile_id WHERE l.profile_id = 'a'`)],
    ['detailed: candidates', plan(`SELECT DISTINCT l.profile_id, p.username, p.display_name FROM profile_visitor_links l JOIN profiles p ON p.profile_id = l.profile_id WHERE l.anonymous_visitor_id IN ('a', 'b') AND l.profile_id != 'x'`)],
    ['detailed: shared visitor count', plan(`SELECT l.profile_id, COUNT(*) FROM profile_visitor_links l WHERE l.profile_id IN ('a', 'b') AND l.anonymous_visitor_id IN ('c', 'd') GROUP BY l.profile_id`)],
    ['detailed: shared IP count', plan(`SELECT c.profile_id, COUNT(*) FROM profile_ip_links c JOIN profile_ip_links t ON t.ip_address = c.ip_address AND t.profile_id = 'x' WHERE c.profile_id IN ('a', 'b') GROUP BY c.profile_id`)],
    ['hasProfileEventFromIp', plan(`SELECT 1 FROM profile_ip_links l WHERE l.profile_id = 'a' AND l.ip_address = 'b' AND EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = l.profile_id) LIMIT 1`)],
    ['deleted ids по visitor (union)', plan(`SELECT deleted_profile_id FROM admin_profile_deletion_visitor_snapshots WHERE anonymous_visitor_id = 'a' UNION SELECT l.profile_id FROM profile_visitor_links l WHERE l.anonymous_visitor_id = 'a' AND EXISTS (SELECT 1 FROM admin_profile_deletions d WHERE d.deleted_profile_id = l.profile_id) AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = l.profile_id)`)],
    ['deleted ids по IP (union)', plan(`SELECT l.profile_id FROM profile_ip_links l WHERE l.ip_address = 'a' AND l.last_seen_at >= datetime('now', '-48 hours') AND EXISTS (SELECT 1 FROM admin_profile_deletions d WHERE d.deleted_profile_id = l.profile_id) AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = l.profile_id)`)],
  ]
  let compactNoScan = true
  for (const [label, lines] of plans) {
    console.log(`    [plan] ${label}: ${lines.join(' | ')}`)
    if (lines.some((line) => /^SCAN (l|c|t|profile_visitor_links|profile_ip_links|site_visitors)\b/.test(line))) compactNoScan = false
  }
  check('[17] compact profile/visitor/IP lookups: без full SCAN върху profile_visitor_links/profile_ip_links/site_visitors', compactNoScan)

  const purgeEventsPlan = plan(`DELETE FROM site_visit_events WHERE rowid IN (SELECT rowid FROM site_visit_events WHERE occurred_at < '2026-01-01 00:00:00' ORDER BY occurred_at LIMIT 500)`)
  const purgeVisitorsPlan = plan(`DELETE FROM site_visitors WHERE rowid IN (SELECT v.rowid FROM site_visitors v WHERE v.last_seen_at < '2026-01-01 00:00:00' AND NOT EXISTS (SELECT 1 FROM site_visit_events e WHERE e.anonymous_visitor_id = v.anonymous_visitor_id) ORDER BY v.last_seen_at LIMIT 500)`)
  console.log(`    [plan] purge events batch: ${purgeEventsPlan.join(' | ')}`)
  console.log(`    [plan] purge visitors batch: ${purgeVisitorsPlan.join(' | ')}`)
  check('[17] batch purge на events ползва idx_site_visit_events_occurred_at (без temp B-tree за ORDER BY)',
    purgeEventsPlan.some((line) => line.includes('idx_site_visit_events_occurred_at')) && !purgeEventsPlan.some((line) => line.includes('TEMP B-TREE')))
  check('[17] batch purge на visitors ползва idx_site_visitors_last_seen_at + idx_site_visit_events_visitor_time',
    purgeVisitorsPlan.some((line) => line.includes('idx_site_visitors_last_seen_at')) && purgeVisitorsPlan.some((line) => line.includes('idx_site_visit_events_visitor_time')))
  db.close()
}

// ═══ 18–19. Фаза 2A / 2B: production конфигурацията от index.ts ══════════
const indexSource = await readFile(join(serverRootPath, 'src', 'index.ts'), 'utf8')
const constantValues = (name: string) => [...indexSource.matchAll(new RegExp(`^const ${name} = (\\d+)\\s*$`, 'gm'))].map((match) => Number(match[1]))
const configuredEventRetentionDays = constantValues('SITE_VISIT_RETENTION_DAYS')
const configuredVisitorRetentionDays = constantValues('SITE_VISITOR_RETENTION_DAYS')
const EVENT_RETENTION_DAYS = configuredEventRetentionDays[0] ?? NaN
const VISITOR_RETENTION_DAYS = configuredVisitorRetentionDays[0] ?? NaN

// [18] Първи startup с production стойностите (Фаза 2A: 90 / 365) спрямо
// стария единичен purge (purgeOlderThanDays(90) преди Фаза 2) върху ДВЕ
// идентични бази: събитията — точно същите; visitors — само по-малко
// изтрити (orphan visitors на 90–365 дни вече се пазят); compact — непипнат.
{
  const buildRetentionFixture = async (prefix: string) => {
    const created = await createMigratedDatabase(prefix)
    const { db } = created
    insertProfile(db, 'ret-p')
    const writer = createProfileVisitLinkWriter(db)
    // Възрасти далеч от границите (≥ 1 ден), за да не зависим от секундата
    // между datetime('now') и JS часовника.
    const ages = [0.5, 3, 20, 34, 36, 60, 88, 92, 120, 200, 364, 366, 400]
    ages.forEach((age, index) => {
      recordHistoricalEvent(db, writer, { visitorId: `ret-v${index}`, profileId: index % 2 === 0 ? 'ret-p' : null, ip: `192.0.2.${index}`, at: ago(age) })
      recordHistoricalEvent(db, writer, { visitorId: `ret-v${index}`, profileId: null, ip: `192.0.2.${index}`, at: ago(age + 0.25) })
    })
    return created
  }
  const legacy = await buildRetentionFixture('belot-phase2a-legacy-')
  const current = await buildRetentionFixture('belot-phase2a-current-')
  const dumpIds = (db: DatabaseSync) => ({
    events: (db.prepare(`SELECT anonymous_visitor_id || '|' || occurred_at AS k FROM site_visit_events ORDER BY k;`).all() as Array<{ k: string }>).map((row) => row.k),
    visitors: (db.prepare(`SELECT anonymous_visitor_id AS k FROM site_visitors ORDER BY k;`).all() as Array<{ k: string }>).map((row) => row.k),
  })
  const linksBefore = dumpLinks(current.db)

  // Точният стар purge (HEAD 1e26564 siteVisitStore.purgeOlderThanDays(90)).
  legacy.db.exec('BEGIN IMMEDIATE;')
  legacy.db.prepare(`DELETE FROM site_visit_events WHERE occurred_at < datetime('now', ?);`).run('-90 days')
  legacy.db.prepare(`
    DELETE FROM site_visitors
    WHERE last_seen_at < datetime('now', ?)
      AND NOT EXISTS (SELECT 1 FROM site_visit_events e WHERE e.anonymous_visitor_id = site_visitors.anonymous_visitor_id LIMIT 1);
  `).run('-90 days')
  legacy.db.exec('COMMIT;')

  const store = await createSiteVisitStore(current.dbPath)
  const result = await store.purgeOlderThanDays({ eventRetentionDays: EVENT_RETENTION_DAYS, visitorRetentionDays: VISITOR_RETENTION_DAYS, batchPauseMs: 0 })
  const legacyState = dumpIds(legacy.db)
  const currentState = dumpIds(current.db)
  if (EVENT_RETENTION_DAYS === 90) {
    check(`[18] Фаза 2A (${EVENT_RETENTION_DAYS}/${VISITOR_RETENTION_DAYS}): изтритите raw събития са ТОЧНО същите като при стария 90-дневен purge (${result.deletedEvents})`,
      JSON.stringify(legacyState.events) === JSON.stringify(currentState.events) && result.deletedEvents > 0 && result.outcome === 'completed')
    const extraKept = currentState.visitors.filter((id) => !legacyState.visitors.includes(id))
    check(`[18] Фаза 2A: site_visitors — само ПО-МАЛКО изтрити (запазени допълнително: ${extraKept.join(', ')}; изтрити: ${result.deletedVisitors})`,
      legacyState.visitors.every((id) => currentState.visitors.includes(id)) &&
      JSON.stringify(extraKept) === JSON.stringify(['ret-v10', 'ret-v7', 'ret-v8', 'ret-v9']) &&
      !currentState.visitors.includes('ret-v11') && !currentState.visitors.includes('ret-v12'))
  } else {
    check(`[18] Фаза 2B (${EVENT_RETENTION_DAYS}/${VISITOR_RETENTION_DAYS}): raw събития по-стари от ${EVENT_RETENTION_DAYS} дни са изтрити (повече от стария 90-дневен purge)`,
      currentState.events.length < legacyState.events.length)
  }
  check('[18] compact visitor/IP links непроменени от първия startup cleanup', dumpLinks(current.db) === linksBefore)
  store.close()
  legacy.db.close()
  current.db.close()
}

// [19] Фаза 2B = само смяна на SITE_VISIT_RETENTION_DAYS (90 → 35).
{
  check(`[19] index.ts дефинира точно по една SITE_VISIT_RETENTION_DAYS (${configuredEventRetentionDays}) и SITE_VISITOR_RETENTION_DAYS (${configuredVisitorRetentionDays})`,
    configuredEventRetentionDays.length === 1 && configuredVisitorRetentionDays.length === 1)
  check('[19] SITE_VISIT_RETENTION_DAYS е 90 (Фаза 2A) или 35 (Фаза 2B) и покрива 30-дневния Admin прозорец', [90, 35].includes(EVENT_RETENTION_DAYS) && EVENT_RETENTION_DAYS > 30)
  check('[19] SITE_VISITOR_RETENTION_DAYS = 365', VISITOR_RETENTION_DAYS === 365)
  const runnerStart = indexSource.indexOf('async function runSiteVisitRetentionCleanup')
  const runner = indexSource.slice(runnerStart, indexSource.indexOf('\n}', runnerStart))
  check('[19] cleanup runner-ът подава точно константите (без други literal срокове) + shouldContinue при shutdown',
    runnerStart >= 0 && runner.includes('eventRetentionDays: SITE_VISIT_RETENTION_DAYS,') && runner.includes('visitorRetentionDays: SITE_VISITOR_RETENTION_DAYS,') &&
    runner.includes('shouldContinue: () => !isServerShuttingDown') && !/RetentionDays:\s*\d/.test(runner))
  check('[19] overlap guard: паралелен run не стартира', runner.includes('isSiteVisitRetentionCleanupRunning') && runner.includes('finally'))
  const storeSource = await readFile(join(serverRootPath, 'src', 'db', 'siteVisitStore.ts'), 'utf8')
  check('[19] siteVisitStore purge не съдържа hardcoded срок (cutoff-ите са bound параметри, не datetime(\'now\', …))',
    !/DELETE FROM site_visit_events[\s\S]{0,200}datetime\('now'/.test(storeSource) && !/DELETE FROM site_visitors[\s\S]{0,300}datetime\('now'/.test(storeSource))
  // Поведението при стойността на Фаза 2B (35) е покрито от [5], [7], [8],
  // [9], [11]–[16] — всички викат същия purgeOlderThanDays с eventRetentionDays: 35.
  check('[19] 2B стойността (35) е покрита от [7] границата и [8] 30-дневните статистики (тези проверки минаха по-горе)', tagPassed('7') && tagPassed('8'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

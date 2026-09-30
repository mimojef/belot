/**
 * checkProfileVisitLinks.ts
 *
 * Regression за Фаза 1 на site_visit_events retention оптимизацията:
 * compact profile_visitor_links / profile_ip_links (dual-write, backfill,
 * verification, hard-delete forensic поведение). Реална SQLite база с всички
 * migrations, реални siteVisitStore / authStore / profileHardDeleteService /
 * adminProfileRiskStore.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createSiteVisitStore, type RecordSitePageViewInput } from '../src/db/siteVisitStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { createAdminProfileRiskStore } from '../src/db/adminProfileRiskStore.js'
import { backfillProfileVisitLinks, createProfileVisitLinkReader, createProfileVisitLinkWriter } from '../src/db/profileVisitLinks.js'
import { verifyProfileVisitLinks } from '../src/db/profileVisitLinkVerification.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
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

type LinkRow = { first_seen_at: string; last_seen_at: string; event_count: number }
const visitorLink = (db: DatabaseSync, profileId: string, visitorId: string) =>
  db.prepare(`SELECT first_seen_at, last_seen_at, event_count FROM profile_visitor_links WHERE profile_id = ? AND anonymous_visitor_id = ?;`).get(profileId, visitorId) as LinkRow | undefined
const ipLink = (db: DatabaseSync, profileId: string, ip: string) =>
  db.prepare(`SELECT first_seen_at, last_seen_at, event_count FROM profile_ip_links WHERE profile_id = ? AND ip_address = ?;`).get(profileId, ip) as LinkRow | undefined
const countRows = (db: DatabaseSync, sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n
const dumpLinks = (db: DatabaseSync) => JSON.stringify({
  v: db.prepare(`SELECT * FROM profile_visitor_links ORDER BY profile_id, anonymous_visitor_id;`).all(),
  i: db.prepare(`SELECT * FROM profile_ip_links ORDER BY profile_id, ip_address;`).all(),
})

// Raw event с explicit occurred_at (симулира история / извънреден ред).
function insertRawEvent(db: DatabaseSync, input: { visitorId: string; profileId: string | null; ip: string | null; at: string; id?: string }): string {
  const id = input.id ?? randomUUID()
  db.prepare(`INSERT OR IGNORE INTO site_visitors (anonymous_visitor_id) VALUES (?);`).run(input.visitorId)
  db.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, ip_address, occurred_at, is_entry)
    VALUES (?, ?, ?, '/lobby', 'navigate', ?, ?, 1);
  `).run(id, input.visitorId, input.profileId, input.ip, input.at)
  return id
}

// ═══ 1. Dual-write през siteVisitStore.recordPageView ═════════════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-dual-')
  const store = await createSiteVisitStore(dbPath)
  for (const id of ['p1', 'p2']) insertProfile(db, id)

  store.recordPageView(pageView({ anonymousVisitorId: 'v1', profileId: 'p1', ipAddress: '198.51.100.1' }))
  check('[1] първи event → visitor link с count=1', visitorLink(db, 'p1', 'v1')?.event_count === 1)
  check('[1] първи event → IP link с count=1', ipLink(db, 'p1', '198.51.100.1')?.event_count === 1)
  const rawFirst = db.prepare(`SELECT occurred_at FROM site_visit_events WHERE profile_id = 'p1';`).get() as { occurred_at: string }
  check('[1] first/last_seen_at са копирани от raw occurred_at', visitorLink(db, 'p1', 'v1')?.first_seen_at === rawFirst.occurred_at && visitorLink(db, 'p1', 'v1')?.last_seen_at === rawFirst.occurred_at)

  store.recordPageView(pageView({ anonymousVisitorId: 'v1', profileId: 'p1', ipAddress: '198.51.100.1' }))
  check('[2] втори event same profile+visitor → един ред, count=2',
    countRows(db, `SELECT COUNT(*) AS n FROM profile_visitor_links WHERE profile_id = 'p1';`) === 1 && visitorLink(db, 'p1', 'v1')?.event_count === 2)
  check('[2] IP link count=2', ipLink(db, 'p1', '198.51.100.1')?.event_count === 2)

  store.recordPageView(pageView({ anonymousVisitorId: 'v1', profileId: 'p2', ipAddress: '198.51.100.1' }))
  check('[3] same visitor, втори profile → втори link ред', visitorLink(db, 'p2', 'v1')?.event_count === 1 &&
    countRows(db, `SELECT COUNT(*) AS n FROM profile_visitor_links WHERE anonymous_visitor_id = 'v1';`) === 2)

  store.recordPageView(pageView({ anonymousVisitorId: 'v1', profileId: 'p1', ipAddress: '203.0.113.9' }))
  check('[4] same profile, нов IP → нов IP link', ipLink(db, 'p1', '203.0.113.9')?.event_count === 1 &&
    countRows(db, `SELECT COUNT(*) AS n FROM profile_ip_links WHERE profile_id = 'p1';`) === 2)
  check('[4] visitor link count=3 (3 events на p1/v1)', visitorLink(db, 'p1', 'v1')?.event_count === 3)

  const ipLinksBefore = countRows(db, `SELECT COUNT(*) AS n FROM profile_ip_links;`)
  store.recordPageView(pageView({ anonymousVisitorId: 'v2', profileId: 'p1', ipAddress: null }))
  check('[5] NULL IP → visitor link да, IP link не', visitorLink(db, 'p1', 'v2')?.event_count === 1 && countRows(db, `SELECT COUNT(*) AS n FROM profile_ip_links;`) === ipLinksBefore)

  const writer = createProfileVisitLinkWriter(db)
  for (const blankIp of ['', '   ']) {
    const id = insertRawEvent(db, { visitorId: 'v3', profileId: 'p1', ip: blankIp, at: '2026-09-01 10:00:00' })
    writer.recordLinksForEvent(id)
  }
  check('[5] празен / whitespace IP → без IP link', countRows(db, `SELECT COUNT(*) AS n FROM profile_ip_links;`) === ipLinksBefore && visitorLink(db, 'p1', 'v3')?.event_count === 2)

  const linksBeforeGuest = dumpLinks(db)
  store.recordPageView(pageView({ anonymousVisitorId: 'v1', profileId: null, ipAddress: '198.51.100.1' }))
  check('[6] guest event (profile NULL) → без compact промяна', dumpLinks(db) === linksBeforeGuest)

  const duplicate = pageView({ anonymousVisitorId: 'v1', profileId: 'p1', ipAddress: '198.51.100.1' })
  store.recordPageView(duplicate)
  const countAfterFirst = visitorLink(db, 'p1', 'v1')?.event_count
  const duplicateResult = store.recordPageView(duplicate)
  check('[7] дублиран page_view_id → count не се увеличава',
    duplicateResult.ok === true && duplicateResult.recorded === false && visitorLink(db, 'p1', 'v1')?.event_count === countAfterFirst)

  // [8] first/last при извънреден ред на timestamps + [9] точен count.
  insertProfile(db, 'p3')
  const order = ['2026-09-10 12:00:00', '2026-09-05 08:00:00', '2026-09-20 18:30:00', '2026-09-01 00:00:01', '2026-09-15 09:09:09']
  for (const at of order) writer.recordLinksForEvent(insertRawEvent(db, { visitorId: 'v4', profileId: 'p3', ip: '192.0.2.50', at }))
  const ordered = visitorLink(db, 'p3', 'v4')
  check('[8] first_seen_at = най-ранното', ordered?.first_seen_at === '2026-09-01 00:00:01', JSON.stringify(ordered))
  check('[8] last_seen_at = най-късното', ordered?.last_seen_at === '2026-09-20 18:30:00', JSON.stringify(ordered))
  check('[9] event_count е точен (5)', ordered?.event_count === 5 && ipLink(db, 'p3', '192.0.2.50')?.event_count === 5)

  const verify = verifyProfileVisitLinks(db)
  check('[14] verification: dual-written данни = raw история', verify.ok, verify.failures.join(' | '))

  store.close()
  db.close()
}

// ═══ 10. Регистрация (authStore, direct mode) → СЪЩИЯТ dual-write ═════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-reg-')
  const progressStore = await createPlayerProgressStore(dbPath)
  const authStore = await createAuthStore(dbPath, progressStore, {
    getRegistrationVerificationMode: () => 'direct',
    registrationVerificationCodeSecret: 'profile-visit-links-test-secret-0123456789abcdef',
  })
  const registrationVisitorId = randomUUID()
  const result = authStore.register({
    email: `visit-links-${randomUUID().slice(0, 8)}@example.test`,
    password: 'secret123',
    displayName: `VisitLink${randomUUID().slice(0, 6)}`,
    visitorId: registrationVisitorId,
    ipAddress: '198.51.100.77',
    userAgent: 'Mozilla/5.0',
  })
  const profileId = result.ok && result.mode === 'direct' ? result.session.profile.profileId : null
  check('[10] direct регистрация успешна', profileId !== null, JSON.stringify(result))
  if (profileId !== null) {
    const rawRegistrationEvent = db.prepare(`SELECT occurred_at FROM site_visit_events WHERE profile_id = ? AND anonymous_visitor_id = ?;`).get(profileId, registrationVisitorId) as { occurred_at: string } | undefined
    check('[10] регистрацията записва raw event', rawRegistrationEvent !== undefined)
    check('[10] регистрацията dual-write-ва visitor link (count=1)', visitorLink(db, profileId, registrationVisitorId)?.event_count === 1 &&
      visitorLink(db, profileId, registrationVisitorId)?.first_seen_at === rawRegistrationEvent?.occurred_at)
    check('[10] регистрацията dual-write-ва IP link', ipLink(db, profileId, '198.51.100.77')?.event_count === 1)
  }
  db.close()
}

// ═══ 11. Hard delete не унищожава compact forensic историята ═════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-delete-')
  const store = await createSiteVisitStore(dbPath)
  insertProfile(db, 'admin', 'admin')
  insertProfile(db, 'victim')
  insertProfile(db, 'buddy')
  store.recordPageView(pageView({ anonymousVisitorId: 'shared-device', profileId: 'victim', ipAddress: '198.51.100.20' }))
  store.recordPageView(pageView({ anonymousVisitorId: 'shared-device', profileId: 'victim', ipAddress: '198.51.100.21' }))
  store.recordPageView(pageView({ anonymousVisitorId: 'shared-device', profileId: 'buddy', ipAddress: '198.51.100.20' }))
  const linksBefore = dumpLinks(db)

  const hardDeleteService = await createProfileHardDeleteService(dbPath, { deleteUploadFileByUrl: async () => {} })
  const deletion = await hardDeleteService.hardDeleteProfile({ targetProfileId: 'victim', actorProfileId: 'admin', actorAccountId: 'admin', reason: 'Регресионен тест за forensic история' })
  check('[11] hard delete успешен', deletion.ok === true, JSON.stringify(deletion))
  check('[11] профилът е изтрит', countRows(db, `SELECT COUNT(*) AS n FROM profiles WHERE profile_id = 'victim';`) === 0)
  check('[11] raw site_visit_events.profile_id е SET NULL (текущо поведение, непроменено)',
    countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE profile_id = 'victim';`) === 0)
  check('[11] compact visitor/IP връзките на изтрития профил ОЦЕЛЯВАТ непроменени', dumpLinks(db) === linksBefore)

  const reader = createProfileVisitLinkReader(db)
  check('[11] forensic reader (вкл. изтрити) вижда visitor връзката', reader.findVisitorLinksForProfileIncludingDeleted('victim').some((link) => link.anonymousVisitorId === 'shared-device' && link.eventCount === 2))
  check('[11] forensic reader (вкл. изтрити) вижда и двата IP-та', reader.findIpLinksForProfileIncludingDeleted('victim').length === 2)
  check('[11] current-only reader НЕ връща изтрития профил като linked (mirror на raw)', !reader.getDetailedLinkedProfiles('buddy').some((row) => row.profileId === 'victim'))
  const verify = verifyProfileVisitLinks(db)
  check('[11] verification OK — изтритият профил е допустим „extra“', verify.ok && verify.visitor.deletedProfileExtras === 1 && verify.ip.deletedProfileExtras === 2, verify.failures.join(' | '))

  hardDeleteService.close()
  store.close()
  db.close()
}

// ═══ 12–17. Backfill, equivalence, verification, retention ══════════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-backfill-')
  const profiles = Array.from({ length: 12 }, (_, i) => `bf-${String(i).padStart(2, '0')}`)
  profiles.forEach((id) => insertProfile(db, id))

  // „Стара“ история БЕЗ dual-write (преди deploy-а): детерминиран pseudo-random граф.
  let seed = 7
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  const visitors = Array.from({ length: 8 }, (_, i) => `dev-${i}`)
  const ips = Array.from({ length: 6 }, (_, i) => `203.0.113.${10 + i}`)
  for (let i = 0; i < 400; i += 1) {
    const day = String(1 + rand(28)).padStart(2, '0')
    const hour = String(rand(24)).padStart(2, '0')
    insertRawEvent(db, {
      visitorId: visitors[rand(visitors.length)]!,
      profileId: rand(10) === 0 ? null : profiles[rand(profiles.length)]!,
      ip: rand(12) === 0 ? null : ips[rand(ips.length)]!,
      at: `2026-08-${day} ${hour}:00:${String(i % 60).padStart(2, '0')}`,
    })
  }
  check('[12] преди backfill compact е празен (историята е само raw)', countRows(db, `SELECT COUNT(*) AS n FROM profile_visitor_links;`) === 0)
  check('[12] verification FAIL-ва ясно при липсващи compact връзки', !verifyProfileVisitLinks(db).ok)

  // Нови (dual-written) събития след „deploy“, преди backfill.
  const store = await createSiteVisitStore(dbPath)
  for (let i = 0; i < 30; i += 1) {
    store.recordPageView(pageView({ anonymousVisitorId: visitors[i % visitors.length]!, profileId: profiles[i % profiles.length]!, ipAddress: ips[i % ips.length]! }))
  }

  const firstRun = backfillProfileVisitLinks(db, { batchSize: 5 })
  check('[12] backfill обработва на batch-ове', firstRun.batches >= 3, JSON.stringify(firstRun))
  const afterFirst = dumpLinks(db)
  const verifyAfterFirst = verifyProfileVisitLinks(db)
  check('[13] backfill върху вече dual-written данни НЕ удвоява event_count (compact = raw)', verifyAfterFirst.ok, verifyAfterFirst.failures.join(' | '))

  backfillProfileVisitLinks(db, { batchSize: 5 })
  backfillProfileVisitLinks(db, { batchSize: 1000 })
  check('[12] backfill е идемпотентен (2 повторни пускания, различен batch size → идентични таблици)', dumpLinks(db) === afterFirst)

  const rawTotal = countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE profile_id IS NOT NULL AND length(anonymous_visitor_id) > 0;`)
  const compactTotal = countRows(db, `SELECT COALESCE(SUM(event_count), 0) AS n FROM profile_visitor_links;`)
  check('[13] SUM(event_count) = брой raw събития с профил', rawTotal === compactTotal, `raw=${rawTotal} compact=${compactTotal}`)

  // [14] Raw-vs-compact equivalence срещу РЕАЛНИЯ production алгоритъм.
  const riskStore = await createAdminProfileRiskStore(dbPath)
  const reader = createProfileVisitLinkReader(db)
  const normalize = (rows: Array<{ profileId: string; sharedVisitorIdsCount: number; sharedIpCount: number }>) =>
    JSON.stringify(rows.map((row) => [row.profileId, row.sharedVisitorIdsCount, row.sharedIpCount]).sort())
  let detailedEqual = true
  let nonEmptyComparisons = 0
  for (const profileId of profiles) {
    const rawRows = riskStore.getDetailedLinkedProfiles(profileId)
    const compactRows = reader.getDetailedLinkedProfiles(profileId)
    if (normalize(rawRows) !== normalize(compactRows)) {
      detailedEqual = false
      console.error(`    ${profileId}: raw=${normalize(rawRows)} compact=${normalize(compactRows)}`)
    }
    if (rawRows.length > 0) nonEmptyComparisons += 1
  }
  check(`[14] adminProfileRiskStore.getDetailedLinkedProfiles (raw) = compact reader за всички профили (${nonEmptyComparisons} с връзки)`, detailedEqual && nonEmptyComparisons > 0)

  let recheckEqual = true
  for (const profileId of profiles) {
    const rawCheck = riskStore.recheckSingleProfile(profileId)
    const compactLinked = reader.getDetailedLinkedProfiles(profileId).length
    if (rawCheck.linkedProfilesCount !== compactLinked || rawCheck.riskDetected !== (compactLinked > 0)) recheckEqual = false
  }
  check('[14] risk recheck (linked count / riskDetected) raw = compact', recheckEqual)

  const rawVisitorIds = db.prepare(`SELECT DISTINCT profile_id, anonymous_visitor_id FROM site_visit_events WHERE profile_id IS NOT NULL;`).all() as Array<{ profile_id: string; anonymous_visitor_id: string }>
  const compactVisitorIds = reader.findVisitorIdsForProfiles(profiles)
  check('[14] visitor ids по profile: raw = compact', rawVisitorIds.every((row) => compactVisitorIds.get(row.profile_id)?.has(row.anonymous_visitor_id)) &&
    [...compactVisitorIds.values()].reduce((sum, set) => sum + set.size, 0) === rawVisitorIds.length)

  const verify = verifyProfileVisitLinks(db, { sampleSize: 50 })
  check(`[14] verification A–E OK (visitor links=${verify.visitor.rawUniqueLinks}, ip links=${verify.ip.rawUniqueLinks}, samples=${verify.linkedProfileSamples}/${verify.sharedIpSamples})`,
    verify.ok && verify.visitor.exactMatches === verify.visitor.rawUniqueLinks && verify.ip.exactMatches === verify.ip.rawUniqueLinks, verify.failures.join(' | '))

  // [15] Verification хваща tampering.
  const bumped = db.prepare(`SELECT profile_id, anonymous_visitor_id FROM profile_visitor_links LIMIT 1;`).get() as { profile_id: string; anonymous_visitor_id: string }
  db.prepare(`UPDATE profile_visitor_links SET event_count = event_count + 1 WHERE profile_id = ? AND anonymous_visitor_id = ?;`).run(bumped.profile_id, bumped.anonymous_visitor_id)
  check('[15] verification FAIL при грешен event_count', !verifyProfileVisitLinks(db).ok)
  backfillProfileVisitLinks(db)
  const tampered = db.prepare(`SELECT profile_id, anonymous_visitor_id FROM profile_visitor_links LIMIT 1;`).get() as { profile_id: string; anonymous_visitor_id: string }
  db.prepare(`DELETE FROM profile_visitor_links WHERE profile_id = ? AND anonymous_visitor_id = ?;`).run(tampered.profile_id, tampered.anonymous_visitor_id)
  const missing = verifyProfileVisitLinks(db)
  check('[15] verification FAIL при липсваща връзка', !missing.ok && missing.failures.some((f) => f.includes('липсва compact')))
  backfillProfileVisitLinks(db)
  const shiftedIp = db.prepare(`SELECT profile_id, ip_address FROM profile_ip_links LIMIT 1;`).get() as { profile_id: string; ip_address: string }
  db.prepare(`UPDATE profile_ip_links SET last_seen_at = '2099-01-01 00:00:00' WHERE profile_id = ? AND ip_address = ?;`).run(shiftedIp.profile_id, shiftedIp.ip_address)
  check('[15] verification FAIL при грешен last_seen_at', !verifyProfileVisitLinks(db).ok)
  db.prepare(`UPDATE profile_ip_links SET last_seen_at = (SELECT MAX(occurred_at) FROM site_visit_events WHERE profile_id = ? AND ip_address = ?) WHERE profile_id = ? AND ip_address = ?;`)
    .run(shiftedIp.profile_id, shiftedIp.ip_address, shiftedIp.profile_id, shiftedIp.ip_address)
  check('[15] след възстановяване verification отново OK', verifyProfileVisitLinks(db).ok)

  // [16] Retention симулация: raw събитията преди 15.08 са изтрити (както би
  // направил purge); compact пази историята, verification остава OK.
  const compactBeforePurge = dumpLinks(db)
  const purged = db.prepare(`DELETE FROM site_visit_events WHERE occurred_at < '2026-08-15 00:00:00';`).run() as { changes: number }
  check('[16] симулиран purge изтри стари raw събития', Number(purged.changes) > 0)
  check('[16] compact историята не се променя от raw purge', dumpLinks(db) === compactBeforePurge)
  const afterPurge = verifyProfileVisitLinks(db, { sampleSize: 50 })
  check(`[16] verification OK след purge (purged-history=${afterPurge.visitor.purgedHistoryMatches}, purged-only=${afterPurge.visitor.purgedOnlyExtras})`,
    afterPurge.ok && afterPurge.visitor.purgedHistoryMatches > 0, afterPurge.failures.join(' | '))

  // [17] Backfill след purge не намалява compact историята (max правило).
  backfillProfileVisitLinks(db)
  check('[17] backfill след purge не намалява event_count/first_seen_at', dumpLinks(db) === compactBeforePurge)

  riskStore.close()
  store.close()
  db.close()
}

// ═══ 18–21. Hard-deleted профили: backfill от deletion snapshots ═════════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-deleted-')
  insertProfile(db, 'admin', 'admin')
  for (const id of ['del-a', 'del-b', 'del-c']) insertProfile(db, id)
  const hardDeleteService = await createProfileHardDeleteService(dbPath, { deleteUploadFileByUrl: async () => {} })

  // [18] Профил, изтрит ПРЕДИ Фаза 1: raw историята е записана без dual-write.
  const deletedHistory: Array<{ visitorId: string; ip: string | null; at: string }> = [
    { visitorId: 'shared-pc', ip: '198.51.100.1', at: '2026-08-02 10:00:00' },
    { visitorId: 'shared-pc', ip: '198.51.100.1', at: '2026-08-05 11:00:00' },
    { visitorId: 'shared-pc', ip: '198.51.100.2', at: '2026-08-07 12:00:00' },
    { visitorId: 'shared-pc', ip: null, at: '2026-08-09 13:00:00' },
    { visitorId: 'phone-a', ip: '198.51.100.2', at: '2026-08-03 09:00:00' },
    { visitorId: 'phone-a', ip: '   ', at: '2026-08-10 09:30:00' },
  ]
  for (const event of deletedHistory) insertRawEvent(db, { visitorId: event.visitorId, profileId: 'del-a', ip: event.ip, at: event.at })
  insertRawEvent(db, { visitorId: 'shared-pc', profileId: 'del-b', ip: '198.51.100.1', at: '2026-08-04 08:00:00' })
  const expectedVisitor = db.prepare(`
    SELECT anonymous_visitor_id AS k, MIN(occurred_at) AS f, MAX(occurred_at) AS l, COUNT(*) AS n
    FROM site_visit_events WHERE profile_id = 'del-a' GROUP BY anonymous_visitor_id ORDER BY k;
  `).all()
  const expectedIp = db.prepare(`
    SELECT ip_address AS k, MIN(occurred_at) AS f, MAX(occurred_at) AS l, COUNT(*) AS n
    FROM site_visit_events WHERE profile_id = 'del-a' AND ip_address IS NOT NULL AND length(trim(ip_address)) > 0
    GROUP BY ip_address ORDER BY k;
  `).all()

  const deletionA = await hardDeleteService.hardDeleteProfile({ targetProfileId: 'del-a', actorProfileId: 'admin', actorAccountId: 'admin', reason: 'Регресионен тест: изтрит преди Фаза 1' })
  check('[18] hard delete преди Фаза 1 успешен', deletionA.ok === true, JSON.stringify(deletionA))
  check('[18] raw profile_id е NULL (raw фазата не вижда профила)', countRows(db, `SELECT COUNT(*) AS n FROM site_visit_events WHERE profile_id = 'del-a';`) === 0)
  check('[18] deletion snapshot е записан', countRows(db, `SELECT COUNT(*) AS n FROM admin_profile_deletion_visitor_snapshots WHERE deleted_profile_id = 'del-a';`) > 0)
  check('[18] преди backfill compact няма нищо за изтрития профил', countRows(db, `SELECT COUNT(*) AS n FROM profile_visitor_links WHERE profile_id = 'del-a';`) === 0)

  const backfillResult = backfillProfileVisitLinks(db)
  const actualVisitor = db.prepare(`SELECT anonymous_visitor_id AS k, first_seen_at AS f, last_seen_at AS l, event_count AS n FROM profile_visitor_links WHERE profile_id = 'del-a' ORDER BY k;`).all()
  const actualIp = db.prepare(`SELECT ip_address AS k, first_seen_at AS f, last_seen_at AS l, event_count AS n FROM profile_ip_links WHERE profile_id = 'del-a' ORDER BY k;`).all()
  check('[18] backfill възстановява visitor връзките на изтрития профил ТОЧНО (first/last/count)', JSON.stringify(actualVisitor) === JSON.stringify(expectedVisitor), `${JSON.stringify(actualVisitor)} vs ${JSON.stringify(expectedVisitor)}`)
  check('[18] backfill възстановява IP връзките ТОЧНО (NULL/празни IP изключени)', JSON.stringify(actualIp) === JSON.stringify(expectedIp), `${JSON.stringify(actualIp)} vs ${JSON.stringify(expectedIp)}`)
  check('[18] backfill отчита snapshot фазата', backfillResult.deletedSnapshotVisitorLinkRowsWritten === 2 && backfillResult.deletedSnapshotIpLinkRowsWritten === 2, JSON.stringify(backfillResult))

  const reader = createProfileVisitLinkReader(db)
  check('[18] current-only reader НЕ показва изтрития профил (както raw днес)', !reader.getDetailedLinkedProfiles('del-b').some((row) => row.profileId === 'del-a'))
  check('[18] forensic reader вижда изтрития профил', reader.findVisitorLinksForProfileIncludingDeleted('del-a').length === 2)

  // [19] Изтрит СЛЕД deploy-а на Фаза 1, но ПРЕДИ backfill-а: стари raw (N) + dual-written (M).
  const store = await createSiteVisitStore(dbPath)
  for (const at of ['2026-08-01 07:00:00', '2026-08-02 07:00:00', '2026-08-03 07:00:00']) {
    insertRawEvent(db, { visitorId: 'laptop-c', profileId: 'del-c', ip: '192.0.2.7', at })
  }
  store.recordPageView(pageView({ anonymousVisitorId: 'laptop-c', profileId: 'del-c', ipAddress: '192.0.2.7' }))
  store.recordPageView(pageView({ anonymousVisitorId: 'laptop-c', profileId: 'del-c', ipAddress: '192.0.2.7' }))
  check('[19] преди изтриване compact има само dual-written (M=2)', visitorLink(db, 'del-c', 'laptop-c')?.event_count === 2)
  const deletionC = await hardDeleteService.hardDeleteProfile({ targetProfileId: 'del-c', actorProfileId: 'admin', actorAccountId: 'admin', reason: 'Регресионен тест: изтрит преди backfill' })
  check('[19] hard delete успешен', deletionC.ok === true)
  backfillProfileVisitLinks(db)
  check('[19] след backfill: count = N+M = 5 (от snapshot-а), first = най-старото raw', visitorLink(db, 'del-c', 'laptop-c')?.event_count === 5 &&
    visitorLink(db, 'del-c', 'laptop-c')?.first_seen_at === '2026-08-01 07:00:00' && ipLink(db, 'del-c', '192.0.2.7')?.event_count === 5,
  JSON.stringify(visitorLink(db, 'del-c', 'laptop-c')))

  // [20] Идемпотентност на двете фази.
  const afterBackfill = dumpLinks(db)
  backfillProfileVisitLinks(db)
  backfillProfileVisitLinks(db, { batchSize: 1 })
  check('[20] повторен backfill (вкл. snapshot фазата) → идентични таблици', dumpLinks(db) === afterBackfill)

  // [21] Snapshot ред за профил, който още съществува, се игнорира (raw е източникът).
  db.prepare(`INSERT INTO admin_profile_deletion_visitor_snapshots (snapshot_id, deleted_profile_id, anonymous_visitor_id, ip_address, first_seen_at, last_seen_at, event_count)
    VALUES (?, 'del-b', 'ghost-visitor', '203.0.113.99', '2026-07-01 00:00:00', '2026-07-02 00:00:00', 99);`).run(randomUUID())
  backfillProfileVisitLinks(db)
  check('[21] snapshot за съществуващ профил НЕ се слива в compact', visitorLink(db, 'del-b', 'ghost-visitor') === undefined && ipLink(db, 'del-b', '203.0.113.99') === undefined)

  const verify = verifyProfileVisitLinks(db)
  check('[18–21] verification OK (изтритите профили са допустими „extras“)', verify.ok, verify.failures.join(' | '))

  hardDeleteService.close()
  store.close()
  db.close()
}

// ═══ 22. Guest latest-activity семантика (1:1 с raw MAX(occurred_at)) ═════
{
  const { dbPath, db } = await createMigratedDatabase('belot-visit-links-guest-')
  const store = await createSiteVisitStore(dbPath)
  const progressStore = await createPlayerProgressStore(dbPath)
  const authStore = await createAuthStore(dbPath, progressStore, {
    getRegistrationVerificationMode: () => 'direct',
    registrationVerificationCodeSecret: 'profile-visit-links-test-secret-0123456789abcdef',
  })
  insertProfile(db, 'gp')
  const reader = createProfileVisitLinkReader(db)
  const rawLatest = (visitorId: string) => (db.prepare(`SELECT MAX(occurred_at) AS at FROM site_visit_events WHERE anonymous_visitor_id = ?;`).get(visitorId) as { at: string | null }).at
  const backdate = (visitorId: string, at: string) => {
    db.prepare(`UPDATE site_visit_events SET occurred_at = ? WHERE anonymous_visitor_id = ?;`).run(at, visitorId)
    db.prepare(`UPDATE profile_visitor_links SET first_seen_at = ?, last_seen_at = ? WHERE anonymous_visitor_id = ?;`).run(at, at, visitorId)
    db.prepare(`UPDATE profile_ip_links SET first_seen_at = ?, last_seen_at = ?;`).run(at, at)
    db.prepare(`UPDATE site_visitors SET first_seen_at = ?, last_seen_at = ? WHERE anonymous_visitor_id = ?;`).run(at, at, visitorId)
  }

  // (a) profiled page view (стар) → по-късен guest page view на същия visitor.
  const guestVisitor = randomUUID()
  store.recordPageView(pageView({ anonymousVisitorId: guestVisitor, profileId: 'gp', ipAddress: '198.51.100.40' }))
  backdate(guestVisitor, '2026-09-01 10:00:00')
  store.recordPageView(pageView({ anonymousVisitorId: guestVisitor, profileId: null, ipAddress: '198.51.100.40' }))
  const rawA = rawLatest(guestVisitor)
  check('[22a] raw latest = guest page view (по-нов от profiled)', rawA !== null && rawA > '2026-09-01 10:00:00')
  check('[22a] profiled-only compact latest ≠ raw (документирана разлика)', reader.findLatestEvidenceAtForVisitorIds([guestVisitor]).get(guestVisitor) === '2026-09-01 10:00:00')
  check('[22a] findLatestActivityAtForVisitorIds = raw (guest включен чрез site_visitors.last_seen_at)', reader.findLatestActivityAtForVisitorIds([guestVisitor]).get(guestVisitor) === rawA,
    `${reader.findLatestActivityAtForVisitorIds([guestVisitor]).get(guestVisitor)} vs ${rawA}`)

  // (b) стар page view → регистрация (authStore НЕ обновява site_visitors.last_seen_at).
  const registrationVisitor = randomUUID()
  store.recordPageView(pageView({ anonymousVisitorId: registrationVisitor, profileId: null, ipAddress: '198.51.100.41' }))
  backdate(registrationVisitor, '2026-09-02 10:00:00')
  const registration = authStore.register({
    email: `latest-${randomUUID().slice(0, 8)}@example.test`, password: 'secret123', displayName: `Latest${randomUUID().slice(0, 6)}`,
    visitorId: registrationVisitor, ipAddress: '198.51.100.41', userAgent: 'Mozilla/5.0',
  })
  check('[22b] регистрация успешна', registration.ok === true, JSON.stringify(registration))
  const rawB = rawLatest(registrationVisitor)
  const siteVisitorB = (db.prepare(`SELECT last_seen_at FROM site_visitors WHERE anonymous_visitor_id = ?;`).get(registrationVisitor) as { last_seen_at: string }).last_seen_at
  check('[22b] site_visitors.last_seen_at НЕ се обновява от регистрацията (затова не е достатъчен сам)', siteVisitorB === '2026-09-02 10:00:00' && rawB !== null && rawB > siteVisitorB)
  check('[22b] findLatestActivityAtForVisitorIds = raw (регистрацията е покрита от link-а)', reader.findLatestActivityAtForVisitorIds([registrationVisitor]).get(registrationVisitor) === rawB)

  // (c) обикновен случай + непознат visitor.
  const plainVisitor = randomUUID()
  store.recordPageView(pageView({ anonymousVisitorId: plainVisitor, profileId: 'gp', ipAddress: '198.51.100.42' }))
  check('[22c] обикновен profiled visitor: activity = raw', reader.findLatestActivityAtForVisitorIds([plainVisitor]).get(plainVisitor) === rawLatest(plainVisitor))
  check('[22c] непознат visitor → няма стойност (както raw)', !reader.findLatestActivityAtForVisitorIds(['unknown-visitor']).has('unknown-visitor'))

  store.close()
  db.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

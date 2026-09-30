// Компактна дългосрочна история profile <-> anonymous visitor и profile <-> IP
// (Фаза 1 на site_visit_events retention оптимизацията — виж
// 20260930_001_create_profile_visit_links.sql за схемата и защо таблиците
// нямат FOREIGN KEY-и).
//
// Три части, споделени от всички call sites (без дублирана SQL логика):
//   * writer  — dual-write за ЕДИН вече вмъкнат site_visit_events ред;
//               вика се в СЪЩАТА транзакция като raw INSERT-а
//               (siteVisitStore.recordPageView, authStore регистрацията);
//   * reader  — compact еквиваленти на raw заявките в adminProfileRiskStore.
//               Фаза 1: НЕ се ползват от production readers — само от
//               verification script-а и тестовете;
//   * backfill — идемпотентен merge от текущата raw история, на batch-ове.

import type { ProfileId } from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// Изключения, общи за dual-write, backfill и verification — една дефиниция.
const VISITOR_LINK_EVENT_FILTER = `profile_id IS NOT NULL AND length(anonymous_visitor_id) > 0`
const IP_LINK_EVENT_FILTER = `profile_id IS NOT NULL AND ip_address IS NOT NULL AND length(trim(ip_address)) > 0`

export const PROFILE_VISIT_LINK_EVENT_FILTERS = {
  visitor: VISITOR_LINK_EVENT_FILTER,
  ip: IP_LINK_EVENT_FILTER,
} as const

// ─── Writer ────────────────────────────────────────────────────────────────

export type ProfileVisitLinkWriter = {
  /**
   * Upsert-ва compact link редовете за ВЕЧЕ вмъкнат raw event (page_view_id).
   * Timestamp-ът се копира от самия raw ред (occurred_at), затова compact
   * first/last_seen_at съвпадат точно с MIN/MAX върху raw историята.
   * Caller-ът ТРЯБВА да държи отворена транзакция и да го вика само когато
   * raw INSERT-ът реално е вмъкнал ред (не при INSERT OR IGNORE дубликат) —
   * иначе event_count би се увеличил двойно.
   */
  recordLinksForEvent: (pageViewId: string) => void
}

export function createProfileVisitLinkWriter(database: SqliteDatabase): ProfileVisitLinkWriter {
  const upsertVisitorLinkFromEventStatement = database.prepare(`
    INSERT INTO profile_visitor_links (profile_id, anonymous_visitor_id, first_seen_at, last_seen_at, event_count)
    SELECT profile_id, anonymous_visitor_id, occurred_at, occurred_at, 1
    FROM site_visit_events
    WHERE page_view_id = ? AND ${VISITOR_LINK_EVENT_FILTER}
    ON CONFLICT (profile_id, anonymous_visitor_id) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = event_count + 1;
  `)

  const upsertIpLinkFromEventStatement = database.prepare(`
    INSERT INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count)
    SELECT profile_id, ip_address, occurred_at, occurred_at, 1
    FROM site_visit_events
    WHERE page_view_id = ? AND ${IP_LINK_EVENT_FILTER}
    ON CONFLICT (profile_id, ip_address) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = event_count + 1;
  `)

  return {
    recordLinksForEvent(pageViewId: string): void {
      upsertVisitorLinkFromEventStatement.run(pageViewId)
      upsertIpLinkFromEventStatement.run(pageViewId)
    },
  }
}

// ─── Reader (compact еквиваленти; Фаза 1 — без production call site) ──────

export type CompactDetailedLinkedProfileRow = {
  profileId: ProfileId
  username: string | null
  displayName: string
  sharedVisitorIdsCount: number
  sharedIpCount: number
}

export type CompactReadOptions = {
  /**
   * Ако е подаден, вземат се само link редове с last_seen_at >= стойността.
   * Ползва се от verification-а, за да сравни compact историята със СЪЩИЯ
   * прозорец, който raw site_visit_events още пази (след retention purge).
   */
  minLastSeenAt?: string | null
}

export type ProfileVisitLinkReader = {
  /** visitor ids по profile (CURRENT профили — mirror на raw, където profile_id е SET NULL след hard delete). */
  findVisitorIdsForProfiles: (profileIds: ProfileId[], options?: CompactReadOptions) => Map<ProfileId, Set<string>>
  /** CURRENT profile ids по visitor id (mirror на adminProfileRiskStore.findProfilesForVisitorIds). */
  findProfilesForVisitorIds: (visitorIds: string[], options?: CompactReadOptions) => Map<string, Set<ProfileId>>
  /**
   * MAX(last_seen_at) по visitor id измежду profile връзките (само събития с
   * профил). Разлика от raw adminProfileRiskStore.findLatestEvidenceAtForVisitorIds:
   * raw гледа и guest (profile_id NULL) page views на visitor-а. За 1:1
   * заместител виж findLatestActivityAtForVisitorIds.
   */
  findLatestEvidenceAtForVisitorIds: (visitorIds: string[]) => Map<string, string>
  /**
   * 1:1 заместител на raw MAX(occurred_at) по visitor id (вкл. guest page
   * views) без raw събитията: max(site_visitors.last_seen_at, MAX(profile
   * link last_seen_at)).
   *   * site_visitors.last_seen_at се обновява от ВСЕКИ recordPageView (guest
   *     и с профил) в същата транзакция като raw INSERT-а;
   *   * регистрационното събитие (authStore) НЕ обновява site_visitors
   *     (INSERT OR IGNORE), но винаги е с профил → покрито от link-а.
   * Допустима разлика: occurred_at (INSERT default) и last_seen_at (UPDATE
   * CURRENT_TIMESTAMP) са отделни statements в една транзакция — могат да
   * се разминат с 1 секунда само ако секундата се смени между тях.
   */
  findLatestActivityAtForVisitorIds: (visitorIds: string[]) => Map<string, string>
  /** Mirror на adminProfileRiskStore.getDetailedLinkedProfiles върху compact таблиците. */
  getDetailedLinkedProfiles: (targetProfileId: ProfileId, options?: CompactReadOptions) => CompactDetailedLinkedProfileRow[]
  /** CURRENT profile ids, видени с този IP. */
  findProfileIdsForIp: (ipAddress: string, options?: CompactReadOptions) => ProfileId[]
  /** Forensic: всички visitor връзки на профил, ВКЛЮЧИТЕЛНО hard-deleted. */
  findVisitorLinksForProfileIncludingDeleted: (profileId: ProfileId) => Array<{
    anonymousVisitorId: string
    firstSeenAt: string
    lastSeenAt: string
    eventCount: number
  }>
  /** Forensic: всички IP връзки на профил, ВКЛЮЧИТЕЛНО hard-deleted. */
  findIpLinksForProfileIncludingDeleted: (profileId: ProfileId) => Array<{
    ipAddress: string
    firstSeenAt: string
    lastSeenAt: string
    eventCount: number
  }>
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

function sinceFilter(alias: string, options?: CompactReadOptions): { sql: string; params: string[] } {
  const since = options?.minLastSeenAt ?? null
  return since === null
    ? { sql: '', params: [] }
    : { sql: `AND ${alias}.last_seen_at >= ?`, params: [since] }
}

export function createProfileVisitLinkReader(database: SqliteDatabase): ProfileVisitLinkReader {
  function findVisitorIdsForProfiles(profileIds: ProfileId[], options?: CompactReadOptions): Map<ProfileId, Set<string>> {
    const result = new Map<ProfileId, Set<string>>()
    const ids = [...new Set(profileIds)]
    if (ids.length === 0) return result
    const since = sinceFilter('l', options)
    const rows = database.prepare(`
      SELECT l.profile_id, l.anonymous_visitor_id
      FROM profile_visitor_links l
      JOIN profiles p ON p.profile_id = l.profile_id
      WHERE l.profile_id IN (${placeholders(ids.length)}) ${since.sql}
    `).all(...ids, ...since.params) as Array<{ profile_id: string; anonymous_visitor_id: string }>
    for (const row of rows) {
      let set = result.get(row.profile_id)
      if (!set) result.set(row.profile_id, set = new Set<string>())
      set.add(row.anonymous_visitor_id)
    }
    return result
  }

  function findProfilesForVisitorIds(visitorIds: string[], options?: CompactReadOptions): Map<string, Set<ProfileId>> {
    const result = new Map<string, Set<ProfileId>>()
    const ids = [...new Set(visitorIds)]
    if (ids.length === 0) return result
    const since = sinceFilter('l', options)
    const rows = database.prepare(`
      SELECT l.anonymous_visitor_id, l.profile_id
      FROM profile_visitor_links l
      JOIN profiles p ON p.profile_id = l.profile_id
      WHERE l.anonymous_visitor_id IN (${placeholders(ids.length)}) ${since.sql}
    `).all(...ids, ...since.params) as Array<{ anonymous_visitor_id: string; profile_id: string }>
    for (const row of rows) {
      let set = result.get(row.anonymous_visitor_id)
      if (!set) result.set(row.anonymous_visitor_id, set = new Set<ProfileId>())
      set.add(row.profile_id)
    }
    return result
  }

  function findLatestEvidenceAtForVisitorIds(visitorIds: string[]): Map<string, string> {
    const result = new Map<string, string>()
    const ids = [...new Set(visitorIds)]
    if (ids.length === 0) return result
    const rows = database.prepare(`
      SELECT anonymous_visitor_id, MAX(last_seen_at) AS latestEvidenceAt
      FROM profile_visitor_links
      WHERE anonymous_visitor_id IN (${placeholders(ids.length)})
      GROUP BY anonymous_visitor_id
    `).all(...ids) as Array<{ anonymous_visitor_id: string; latestEvidenceAt: string }>
    for (const row of rows) result.set(row.anonymous_visitor_id, row.latestEvidenceAt)
    return result
  }

  function findLatestActivityAtForVisitorIds(visitorIds: string[]): Map<string, string> {
    const result = findLatestEvidenceAtForVisitorIds(visitorIds)
    const ids = [...new Set(visitorIds)]
    if (ids.length === 0) return result
    const rows = database.prepare(`
      SELECT anonymous_visitor_id, last_seen_at
      FROM site_visitors
      WHERE anonymous_visitor_id IN (${placeholders(ids.length)})
    `).all(...ids) as Array<{ anonymous_visitor_id: string; last_seen_at: string }>
    for (const row of rows) {
      const current = result.get(row.anonymous_visitor_id)
      if (current === undefined || row.last_seen_at > current) result.set(row.anonymous_visitor_id, row.last_seen_at)
    }
    return result
  }

  function getDetailedLinkedProfiles(targetProfileId: ProfileId, options?: CompactReadOptions): CompactDetailedLinkedProfileRow[] {
    const since = sinceFilter('l', options)
    const visitorIds = (database.prepare(`
      SELECT l.anonymous_visitor_id FROM profile_visitor_links l
      WHERE l.profile_id = ? ${since.sql}
    `).all(targetProfileId, ...since.params) as Array<{ anonymous_visitor_id: string }>).map((row) => row.anonymous_visitor_id)
    if (visitorIds.length === 0) return []

    const candidates = database.prepare(`
      SELECT DISTINCT l.profile_id AS profileId, p.username AS username, p.display_name AS displayName
      FROM profile_visitor_links l
      JOIN profiles p ON p.profile_id = l.profile_id
      WHERE l.anonymous_visitor_id IN (${placeholders(visitorIds.length)})
        AND l.profile_id != ? ${since.sql}
    `).all(...visitorIds, targetProfileId, ...since.params) as Array<{ profileId: string; username: string | null; displayName: string }>
    if (candidates.length === 0) return []

    const candidateIds = candidates.map((row) => row.profileId)
    const sharedVisitorCounts = new Map((database.prepare(`
      SELECT l.profile_id AS profileId, COUNT(*) AS sharedCount
      FROM profile_visitor_links l
      WHERE l.profile_id IN (${placeholders(candidateIds.length)})
        AND l.anonymous_visitor_id IN (${placeholders(visitorIds.length)}) ${since.sql}
      GROUP BY l.profile_id
    `).all(...candidateIds, ...visitorIds, ...since.params) as Array<{ profileId: string; sharedCount: number }>)
      .map((row) => [row.profileId, row.sharedCount]))

    const ipSinceTarget = sinceFilter('t', options)
    const ipSinceCandidate = sinceFilter('c', options)
    const sharedIpCounts = new Map((database.prepare(`
      SELECT c.profile_id AS profileId, COUNT(*) AS sharedCount
      FROM profile_ip_links c
      JOIN profile_ip_links t ON t.ip_address = c.ip_address AND t.profile_id = ? ${ipSinceTarget.sql}
      WHERE c.profile_id IN (${placeholders(candidateIds.length)}) ${ipSinceCandidate.sql}
      GROUP BY c.profile_id
    `).all(targetProfileId, ...ipSinceTarget.params, ...candidateIds, ...ipSinceCandidate.params) as Array<{ profileId: string; sharedCount: number }>)
      .map((row) => [row.profileId, row.sharedCount]))

    return candidates.map((row) => ({
      profileId: row.profileId,
      username: row.username,
      displayName: row.displayName,
      sharedVisitorIdsCount: sharedVisitorCounts.get(row.profileId) ?? 0,
      sharedIpCount: sharedIpCounts.get(row.profileId) ?? 0,
    }))
  }

  function findProfileIdsForIp(ipAddress: string, options?: CompactReadOptions): ProfileId[] {
    const since = sinceFilter('l', options)
    return (database.prepare(`
      SELECT l.profile_id FROM profile_ip_links l
      JOIN profiles p ON p.profile_id = l.profile_id
      WHERE l.ip_address = ? ${since.sql}
    `).all(ipAddress, ...since.params) as Array<{ profile_id: string }>).map((row) => row.profile_id)
  }

  function findVisitorLinksForProfileIncludingDeleted(profileId: ProfileId) {
    return (database.prepare(`
      SELECT anonymous_visitor_id, first_seen_at, last_seen_at, event_count
      FROM profile_visitor_links WHERE profile_id = ?
    `).all(profileId) as Array<{ anonymous_visitor_id: string; first_seen_at: string; last_seen_at: string; event_count: number }>)
      .map((row) => ({ anonymousVisitorId: row.anonymous_visitor_id, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, eventCount: row.event_count }))
  }

  function findIpLinksForProfileIncludingDeleted(profileId: ProfileId) {
    return (database.prepare(`
      SELECT ip_address, first_seen_at, last_seen_at, event_count
      FROM profile_ip_links WHERE profile_id = ?
    `).all(profileId) as Array<{ ip_address: string; first_seen_at: string; last_seen_at: string; event_count: number }>)
      .map((row) => ({ ipAddress: row.ip_address, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at, eventCount: row.event_count }))
  }

  return {
    findVisitorIdsForProfiles,
    findProfilesForVisitorIds,
    findLatestEvidenceAtForVisitorIds,
    findLatestActivityAtForVisitorIds,
    getDetailedLinkedProfiles,
    findProfileIdsForIp,
    findVisitorLinksForProfileIncludingDeleted,
    findIpLinksForProfileIncludingDeleted,
  }
}

// ─── Backfill ──────────────────────────────────────────────────────────────

export type ProfileVisitLinkBackfillResult = {
  batches: number
  profilesProcessed: number
  visitorLinkRowsWritten: number
  ipLinkRowsWritten: number
  deletedSnapshotVisitorLinkRowsWritten: number
  deletedSnapshotIpLinkRowsWritten: number
}

/**
 * Идемпотентен merge на текущата raw история в compact таблиците, на
 * batch-ове по profile_id (keyset), всеки batch в собствена BEGIN IMMEDIATE
 * транзакция — кратки write lock-ове, без една огромна транзакция.
 *
 * Merge правило за съществуващ ред:
 *   first_seen_at = min(existing, raw MIN)
 *   last_seen_at  = max(existing, raw MAX)
 *   event_count   = max(existing, raw COUNT)
 *
 * max() (не сума) прави повторното пускане безопасно И не удвоява вече
 * dual-written събития: raw историята съдържа И dual-written редовете, така
 * че raw COUNT >= dual-written count, докато всички dual-written събития са
 * още в raw; ако retention purge вече е изтрил част от тях, compact count е
 * по-големият и се запазва. Батчът чете raw и compact атомарно в една
 * транзакция, така че паралелен dual-write не може да бъде пропуснат или
 * преброен двойно.
 *
 * Втора фаза — hard-deleted профили: след hard delete raw
 * site_visit_events.profile_id е SET NULL, затова raw фазата не ги вижда.
 * Единственият оцелял източник е admin_profile_deletion_visitor_snapshots
 * (записан от profileHardDeleteService В МОМЕНТА на изтриване, преди
 * cascade-а; въведен в същия commit като самия hard delete — всеки hard
 * delete има snapshot). Редовете там са (profile, visitor, ip) → MIN/MAX/
 * COUNT върху raw събитията към момента на изтриване, т.е. точно това, което
 * raw историята е съдържала. Агрегацията по visitor (SUM по IP групите) и по
 * IP (SUM по visitor групите) възстановява compact връзките ТОЧНО, без
 * измислени данни. Само профили, които вече НЕ съществуват в profiles.
 * Същото merge правило (max count) — идемпотентно и безопасно за профили,
 * изтрити след deploy-а на Фаза 1 (compact вече има dual-written редове).
 */
export function backfillProfileVisitLinks(
  database: SqliteDatabase,
  options: { batchSize?: number; onBatch?: (info: { batch: number; profilesInBatch: number; lastProfileId: string }) => void } = {},
): ProfileVisitLinkBackfillResult {
  const batchSize = Number.isInteger(options.batchSize) && (options.batchSize ?? 0) > 0 ? options.batchSize! : 500

  const selectBatchProfileIdsStatement = database.prepare(`
    SELECT DISTINCT profile_id
    FROM site_visit_events
    WHERE profile_id IS NOT NULL AND profile_id > ?
    ORDER BY profile_id
    LIMIT ?;
  `)

  const mergeVisitorLinksStatement = database.prepare(`
    INSERT INTO profile_visitor_links (profile_id, anonymous_visitor_id, first_seen_at, last_seen_at, event_count)
    SELECT profile_id, anonymous_visitor_id, MIN(occurred_at), MAX(occurred_at), COUNT(*)
    FROM site_visit_events
    WHERE profile_id > ? AND profile_id <= ? AND ${VISITOR_LINK_EVENT_FILTER}
    GROUP BY profile_id, anonymous_visitor_id
    ON CONFLICT (profile_id, anonymous_visitor_id) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = max(event_count, excluded.event_count);
  `)

  const mergeIpLinksStatement = database.prepare(`
    INSERT INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count)
    SELECT profile_id, ip_address, MIN(occurred_at), MAX(occurred_at), COUNT(*)
    FROM site_visit_events
    WHERE profile_id > ? AND profile_id <= ? AND ${IP_LINK_EVENT_FILTER}
    GROUP BY profile_id, ip_address
    ON CONFLICT (profile_id, ip_address) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = max(event_count, excluded.event_count);
  `)

  const mergeDeletedSnapshotVisitorLinksStatement = database.prepare(`
    INSERT INTO profile_visitor_links (profile_id, anonymous_visitor_id, first_seen_at, last_seen_at, event_count)
    SELECT s.deleted_profile_id, s.anonymous_visitor_id, MIN(s.first_seen_at), MAX(s.last_seen_at), SUM(s.event_count)
    FROM admin_profile_deletion_visitor_snapshots s
    WHERE length(s.anonymous_visitor_id) > 0
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = s.deleted_profile_id)
    GROUP BY s.deleted_profile_id, s.anonymous_visitor_id
    ON CONFLICT (profile_id, anonymous_visitor_id) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = max(event_count, excluded.event_count);
  `)

  const mergeDeletedSnapshotIpLinksStatement = database.prepare(`
    INSERT INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count)
    SELECT s.deleted_profile_id, s.ip_address, MIN(s.first_seen_at), MAX(s.last_seen_at), SUM(s.event_count)
    FROM admin_profile_deletion_visitor_snapshots s
    WHERE s.ip_address IS NOT NULL AND length(trim(s.ip_address)) > 0
      AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.profile_id = s.deleted_profile_id)
    GROUP BY s.deleted_profile_id, s.ip_address
    ON CONFLICT (profile_id, ip_address) DO UPDATE SET
      first_seen_at = min(first_seen_at, excluded.first_seen_at),
      last_seen_at = max(last_seen_at, excluded.last_seen_at),
      event_count = max(event_count, excluded.event_count);
  `)

  const result: ProfileVisitLinkBackfillResult = {
    batches: 0,
    profilesProcessed: 0,
    visitorLinkRowsWritten: 0,
    ipLinkRowsWritten: 0,
    deletedSnapshotVisitorLinkRowsWritten: 0,
    deletedSnapshotIpLinkRowsWritten: 0,
  }
  let afterProfileId = ''

  for (;;) {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const profileIds = (selectBatchProfileIdsStatement.all(afterProfileId, batchSize) as Array<{ profile_id: string }>)
        .map((row) => row.profile_id)
      if (profileIds.length === 0) {
        database.exec('COMMIT;')
        break
      }
      const lastProfileId = profileIds[profileIds.length - 1]!
      const visitorChanges = mergeVisitorLinksStatement.run(afterProfileId, lastProfileId) as { changes?: number }
      const ipChanges = mergeIpLinksStatement.run(afterProfileId, lastProfileId) as { changes?: number }
      database.exec('COMMIT;')

      result.batches += 1
      result.profilesProcessed += profileIds.length
      result.visitorLinkRowsWritten += Number(visitorChanges.changes ?? 0)
      result.ipLinkRowsWritten += Number(ipChanges.changes ?? 0)
      options.onBatch?.({ batch: result.batches, profilesInBatch: profileIds.length, lastProfileId })
      afterProfileId = lastProfileId
      if (profileIds.length < batchSize) break
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  // Втора фаза — hard-deleted профили (виж doc коментара). Snapshot
  // таблицата е малка (записва се само при рядкото admin hard delete) —
  // една кратка транзакция.
  database.exec('BEGIN IMMEDIATE;')
  try {
    const visitorChanges = mergeDeletedSnapshotVisitorLinksStatement.run() as { changes?: number }
    const ipChanges = mergeDeletedSnapshotIpLinksStatement.run() as { changes?: number }
    database.exec('COMMIT;')
    result.deletedSnapshotVisitorLinkRowsWritten = Number(visitorChanges.changes ?? 0)
    result.deletedSnapshotIpLinkRowsWritten = Number(ipChanges.changes ?? 0)
  } catch (error) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // Preserve the original failure.
    }
    throw error
  }

  return result
}

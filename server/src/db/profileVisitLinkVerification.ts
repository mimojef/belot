// Read-only сравнение raw site_visit_events <-> compact profile_visitor_links /
// profile_ip_links (Фаза 1). Ползва се от scripts/verifyProfileVisitLinks.ts
// (срещу реална база) и от scripts/checkProfileVisitLinks.ts (тестове).
//
// Retention-aware правило: raw историята пази само последните N дни
// (siteVisitStore.purgeOlderThanDays), а compact историята е дългосрочна и
// оцелява hard delete. Затова:
//   * rawFloor = MIN(occurred_at) в site_visit_events — най-старото, което raw
//     още пази. Всяка връзка с last_seen_at >= rawFloor и CURRENT профил
//     ТРЯБВА да я има и в raw (последното ѝ събитие не е изтрито), и обратно.
//   * За връзка с first_seen_at >= rawFloor нищо не е изтрито → first/last/
//     count трябва да съвпадат ТОЧНО. Иначе (стари събития вече purged):
//     compact first <= raw MIN, compact count >= raw COUNT, last съвпада.
//   * Compact връзка без raw еквивалент е допустима само ако профилът е
//     hard-deleted или всичките ѝ събития са по-стари от rawFloor.
// Всичко се чете в ЕДНА read транзакция (WAL snapshot) — безопасно срещу
// паралелни page-view записи на жив сървър.

import { PROFILE_VISIT_LINK_EVENT_FILTERS, createProfileVisitLinkReader } from './profileVisitLinks.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

type LinkKind = 'visitor' | 'ip'

type RawAggregate = { min: string; max: string; count: number }
type CompactRow = { first: string; last: string; count: number; isCurrent: boolean }

export type ProfileVisitLinkVerificationReport = {
  ok: boolean
  rawFloor: string | null
  rawEventCount: number
  visitor: LinkComparisonStats
  ip: LinkComparisonStats
  linkedProfileSamples: number
  sharedIpSamples: number
  failures: string[]
  samples: string[]
}

export type LinkComparisonStats = {
  rawUniqueLinks: number
  compactUniqueLinks: number
  compactComparableLinks: number
  exactMatches: number
  purgedHistoryMatches: number
  deletedProfileExtras: number
  purgedOnlyExtras: number
}

const MAX_FAILURE_DETAILS = 25

export function verifyProfileVisitLinks(
  database: SqliteDatabase,
  options: { sampleSize?: number } = {},
): ProfileVisitLinkVerificationReport {
  const sampleSize = Number.isInteger(options.sampleSize) && (options.sampleSize ?? 0) > 0 ? options.sampleSize! : 200
  const failures: string[] = []
  const samples: string[] = []
  let failureCount = 0
  const fail = (message: string) => {
    failureCount += 1
    if (failures.length < MAX_FAILURE_DETAILS) failures.push(message)
  }

  database.exec('BEGIN;')
  try {
    const rawFloor = (database.prepare(`SELECT MIN(occurred_at) AS floor FROM site_visit_events;`).get() as { floor: string | null }).floor
    const rawEventCount = (database.prepare(`SELECT COUNT(*) AS n FROM site_visit_events;`).get() as { n: number }).n

    const compare = (kind: LinkKind): LinkComparisonStats => {
      const keyColumn = kind === 'visitor' ? 'anonymous_visitor_id' : 'ip_address'
      const table = kind === 'visitor' ? 'profile_visitor_links' : 'profile_ip_links'
      const filter = PROFILE_VISIT_LINK_EVENT_FILTERS[kind]

      const raw = new Map<string, RawAggregate>()
      for (const row of database.prepare(`
        SELECT profile_id AS profileId, ${keyColumn} AS linkKey,
               MIN(occurred_at) AS mn, MAX(occurred_at) AS mx, COUNT(*) AS n
        FROM site_visit_events WHERE ${filter}
        GROUP BY profile_id, ${keyColumn};
      `).iterate() as Iterable<{ profileId: string; linkKey: string; mn: string; mx: string; n: number }>) {
        raw.set(`${row.profileId}\u0000${row.linkKey}`, { min: row.mn, max: row.mx, count: row.n })
      }

      const compact = new Map<string, CompactRow>()
      for (const row of database.prepare(`
        SELECT l.profile_id AS profileId, l.${keyColumn} AS linkKey, l.first_seen_at AS firstSeen,
               l.last_seen_at AS lastSeen, l.event_count AS n, (p.profile_id IS NOT NULL) AS isCurrent
        FROM ${table} l LEFT JOIN profiles p ON p.profile_id = l.profile_id;
      `).iterate() as Iterable<{ profileId: string; linkKey: string; firstSeen: string; lastSeen: string; n: number; isCurrent: number }>) {
        compact.set(`${row.profileId}\u0000${row.linkKey}`, { first: row.firstSeen, last: row.lastSeen, count: row.n, isCurrent: row.isCurrent === 1 })
      }

      const stats: LinkComparisonStats = {
        rawUniqueLinks: raw.size,
        compactUniqueLinks: compact.size,
        compactComparableLinks: 0,
        exactMatches: 0,
        purgedHistoryMatches: 0,
        deletedProfileExtras: 0,
        purgedOnlyExtras: 0,
      }
      const label = (key: string) => key.replace('\u0000', ' <-> ')

      for (const [key, r] of raw) {
        const c = compact.get(key)
        if (c === undefined) {
          fail(`[${kind}] липсва compact връзка за ${label(key)} (raw count=${r.count})`)
          continue
        }
        if (c.last !== r.max) {
          fail(`[${kind}] last_seen_at разлика за ${label(key)}: compact=${c.last} raw=${r.max}`)
          continue
        }
        const nothingPurged = rawFloor === null || c.first >= rawFloor
        if (nothingPurged) {
          if (c.first !== r.min || c.count !== r.count) {
            fail(`[${kind}] точна разлика за ${label(key)}: compact first=${c.first} count=${c.count}, raw min=${r.min} count=${r.count}`)
            continue
          }
          stats.exactMatches += 1
        } else {
          if (c.first > r.min || c.count < r.count) {
            fail(`[${kind}] purged-history разлика за ${label(key)}: compact first=${c.first} count=${c.count}, raw min=${r.min} count=${r.count}`)
            continue
          }
          stats.purgedHistoryMatches += 1
        }
      }

      for (const [key, c] of compact) {
        const comparable = c.isCurrent && (rawFloor === null || c.last >= rawFloor)
        if (comparable) stats.compactComparableLinks += 1
        if (raw.has(key)) continue
        if (!c.isCurrent) {
          stats.deletedProfileExtras += 1
        } else if (rawFloor !== null && c.last < rawFloor) {
          stats.purgedOnlyExtras += 1
        } else {
          fail(`[${kind}] compact връзка ${label(key)} (last=${c.last}, count=${c.count}) няма raw събития, а не е нито изтрит профил, нито purged`)
        }
      }

      if (stats.compactComparableLinks !== stats.rawUniqueLinks) {
        fail(`[${kind}] брой уникални връзки: raw=${stats.rawUniqueLinks}, compact (current, в raw прозореца)=${stats.compactComparableLinks}`)
      }
      return stats
    }

    const visitor = compare('visitor')
    const ip = compare('ip')

    // D. Linked-profile equivalence: raw алгоритъм (mirror на
    // adminProfileRiskStore.getDetailedLinkedProfiles, с изключени празни IP-та)
    // срещу compact reader-а в СЪЩИЯ прозорец (minLastSeenAt = rawFloor).
    const reader = createProfileVisitLinkReader(database)
    const sampleTargets = (database.prepare(`
      SELECT profile_id FROM (
        SELECT l.profile_id, COUNT(*) AS weight
        FROM profile_visitor_links l
        JOIN profile_visitor_links o ON o.anonymous_visitor_id = l.anonymous_visitor_id AND o.profile_id != l.profile_id
        JOIN profiles p ON p.profile_id = l.profile_id
        GROUP BY l.profile_id
        ORDER BY weight DESC, l.profile_id
        LIMIT ?
      )
      UNION
      SELECT profile_id FROM (
        SELECT l.profile_id FROM profile_visitor_links l JOIN profiles p ON p.profile_id = l.profile_id
        GROUP BY l.profile_id ORDER BY l.profile_id LIMIT ?
      );
    `).all(Math.ceil(sampleSize / 2), Math.floor(sampleSize / 2)) as Array<{ profile_id: string }>).map((row) => row.profile_id)

    const rawTargetVisitors = database.prepare(`
      SELECT DISTINCT anonymous_visitor_id FROM site_visit_events
      WHERE profile_id = ? AND ${PROFILE_VISIT_LINK_EVENT_FILTERS.visitor};
    `)
    const rawTargetIps = database.prepare(`
      SELECT DISTINCT ip_address FROM site_visit_events
      WHERE profile_id = ? AND ${PROFILE_VISIT_LINK_EVENT_FILTERS.ip};
    `)

    const rawDetailed = (target: string): string => {
      const visitorIds = (rawTargetVisitors.all(target) as Array<{ anonymous_visitor_id: string }>).map((r) => r.anonymous_visitor_id)
      if (visitorIds.length === 0) return '[]'
      const vp = visitorIds.map(() => '?').join(', ')
      const candidates = (database.prepare(`
        SELECT DISTINCT sve.profile_id AS profileId
        FROM site_visit_events sve JOIN profiles p ON p.profile_id = sve.profile_id
        WHERE sve.anonymous_visitor_id IN (${vp}) AND sve.profile_id IS NOT NULL AND sve.profile_id != ?;
      `).all(...visitorIds, target) as Array<{ profileId: string }>).map((r) => r.profileId)
      if (candidates.length === 0) return '[]'
      const cp = candidates.map(() => '?').join(', ')
      const sharedVisitors = new Map((database.prepare(`
        SELECT profile_id AS profileId, COUNT(DISTINCT anonymous_visitor_id) AS n FROM site_visit_events
        WHERE profile_id IN (${cp}) AND anonymous_visitor_id IN (${vp}) GROUP BY profile_id;
      `).all(...candidates, ...visitorIds) as Array<{ profileId: string; n: number }>).map((r) => [r.profileId, r.n]))
      const targetIps = new Set((rawTargetIps.all(target) as Array<{ ip_address: string }>).map((r) => r.ip_address))
      const sharedIps = new Map<string, number>()
      for (const row of database.prepare(`
        SELECT DISTINCT profile_id AS profileId, ip_address AS ip FROM site_visit_events
        WHERE profile_id IN (${cp}) AND ${PROFILE_VISIT_LINK_EVENT_FILTERS.ip};
      `).all(...candidates) as Array<{ profileId: string; ip: string }>) {
        if (targetIps.has(row.ip)) sharedIps.set(row.profileId, (sharedIps.get(row.profileId) ?? 0) + 1)
      }
      return JSON.stringify(candidates.sort().map((id) => [id, sharedVisitors.get(id) ?? 0, sharedIps.get(id) ?? 0]))
    }

    const compactDetailed = (target: string): string =>
      JSON.stringify(reader.getDetailedLinkedProfiles(target, { minLastSeenAt: rawFloor })
        .map((row) => [row.profileId, row.sharedVisitorIdsCount, row.sharedIpCount] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))

    for (const target of sampleTargets) {
      const rawResult = rawDetailed(target)
      const compactResult = compactDetailed(target)
      if (rawResult !== compactResult) {
        fail(`[linked-profiles] ${target}: raw=${rawResult} compact=${compactResult}`)
      } else if (samples.length < 5 && rawResult !== '[]') {
        samples.push(`[linked-profiles] ${target}: ${rawResult}`)
      }
    }

    // E. Shared-IP equivalence: IP-та с най-много профили + детерминирани други.
    const sampleIps = (database.prepare(`
      SELECT ip_address FROM (
        SELECT ip_address, COUNT(*) AS n FROM profile_ip_links GROUP BY ip_address ORDER BY n DESC, ip_address LIMIT ?
      )
      UNION
      SELECT ip_address FROM (SELECT DISTINCT ip_address FROM profile_ip_links ORDER BY ip_address LIMIT ?);
    `).all(Math.ceil(sampleSize / 2), Math.floor(sampleSize / 2)) as Array<{ ip_address: string }>).map((row) => row.ip_address)

    const rawProfilesForIp = database.prepare(`
      SELECT DISTINCT profile_id AS profileId FROM site_visit_events
      WHERE ip_address = ? AND ${PROFILE_VISIT_LINK_EVENT_FILTERS.ip}
        AND profile_id IN (SELECT profile_id FROM profiles);
    `)
    for (const ip of sampleIps) {
      const rawResult = JSON.stringify((rawProfilesForIp.all(ip) as Array<{ profileId: string }>).map((r) => r.profileId).sort())
      const compactResult = JSON.stringify(reader.findProfileIdsForIp(ip, { minLastSeenAt: rawFloor }).sort())
      if (rawResult !== compactResult) {
        fail(`[shared-ip] ${ip}: raw=${rawResult} compact=${compactResult}`)
      }
    }

    database.exec('COMMIT;')

    if (failureCount > failures.length) {
      failures.push(`… и още ${failureCount - failures.length} разлики`)
    }

    return {
      ok: failureCount === 0,
      rawFloor,
      rawEventCount,
      visitor,
      ip,
      linkedProfileSamples: sampleTargets.length,
      sharedIpSamples: sampleIps.length,
      failures,
      samples,
    }
  } catch (error) {
    try {
      database.exec('ROLLBACK;')
    } catch {
      // Preserve the original failure.
    }
    throw error
  }
}

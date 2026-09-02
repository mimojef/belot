import type { ProfileId } from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type CachedProfileRiskCheck = {
  checkedAt: string
  riskDetected: boolean
  linkedProfilesCount: number
}

export type DetailedLinkedProfileRow = {
  profileId: ProfileId
  username: string | null
  displayName: string
  sharedVisitorIdsCount: number
  sharedIpCount: number
}

export type AdminProfileRiskStore = {
  /**
   * Batch lookup на вече кеширани резултати за списък от profile ids —
   * ползва се от list-view endpoint-а, за да различи кои профили вече имат
   * cache ред (skip recompute) от кои нямат (нужен computeAndCacheRiskForProfiles).
   * Единствена заявка (WHERE profile_id IN (...)), не N+1.
   */
  getCachedChecks: (profileIds: ProfileId[]) => Map<ProfileId, CachedProfileRiskCheck>
  /**
   * За всеки target profile id БЕЗ вече съществуващ cache ред: намира дали
   * споделя anonymous_visitor_id с друг профил (site_visit_events), и ако
   * да — маркира И target-а, И всеки намерен "linked partner" като
   * risk_detected=1 (spec §6 — старият профил light-ва се червено веднага
   * щом нов свързан профил бъде открит, без explicit recheck на стария).
   * Bounded batch заявки (не 1 SELECT per profile).
   */
  computeAndCacheRiskForProfiles: (targetProfileIds: ProfileId[]) => void
  /** Forced recheck за един профил — презаписва cache реда му, после same upsert логика за linked partners. Ползва се от "Провери отново". */
  recheckSingleProfile: (targetProfileId: ProfileId) => CachedProfileRiskCheck
  /**
   * On-demand detailed breakdown за profile popup "Свързани профили"
   * секцията — само за 1 target, bounded към малката linked група (НЕ
   * global scan). Изключва hard-deleted профили (join към profiles).
   */
  getDetailedLinkedProfiles: (targetProfileId: ProfileId) => DetailedLinkedProfileRow[]
  close: () => void
}

export async function createAdminProfileRiskStore(databaseFilePath: string): Promise<AdminProfileRiskStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const upsertCheckStatement = database.prepare(`
    INSERT INTO admin_profile_risk_checks (profile_id, checked_at, risk_detected, linked_profiles_count)
    VALUES (?, CURRENT_TIMESTAMP, ?, ?)
    ON CONFLICT (profile_id) DO UPDATE SET
      checked_at = CURRENT_TIMESTAMP,
      risk_detected = excluded.risk_detected,
      linked_profiles_count = excluded.linked_profiles_count;
  `)

  const deleteCheckStatement = database.prepare(`
    DELETE FROM admin_profile_risk_checks WHERE profile_id = ?;
  `)

  function toCachedCheck(row: { checked_at: string; risk_detected: number; linked_profiles_count: number }): CachedProfileRiskCheck {
    return {
      checkedAt: row.checked_at,
      riskDetected: row.risk_detected === 1,
      linkedProfilesCount: row.linked_profiles_count,
    }
  }

  // Batch SELECT WHERE profile_id IN (...) — брой placeholder-и е динамичен
  // спрямо входния масив, prepared statement е построен ad-hoc за всеки
  // batch размер (стандартен SQLite IN(...) pattern, няма готов "IN" bind).
  function getCachedChecks(profileIds: ProfileId[]): Map<ProfileId, CachedProfileRiskCheck> {
    const result = new Map<ProfileId, CachedProfileRiskCheck>()
    const uniqueIds = [...new Set(profileIds)].filter((id) => id.trim().length > 0)
    if (uniqueIds.length === 0) return result

    const placeholders = uniqueIds.map(() => '?').join(', ')
    const rows = database.prepare(`
      SELECT profile_id, checked_at, risk_detected, linked_profiles_count
      FROM admin_profile_risk_checks
      WHERE profile_id IN (${placeholders})
    `).all(...uniqueIds) as Array<{
      profile_id: string
      checked_at: string
      risk_detected: number
      linked_profiles_count: number
    }>

    for (const row of rows) {
      result.set(row.profile_id, toCachedCheck(row))
    }
    return result
  }

  // Batch намира visitor ids за дадени target profile ids — query A от
  // проучването (EXPLAIN QUERY PLAN потвърди: SEARCH USING INDEX
  // idx_site_visit_events_profile_time, без нов индекс).
  function findVisitorIdsForProfiles(profileIds: ProfileId[]): Map<ProfileId, Set<string>> {
    const result = new Map<ProfileId, Set<string>>()
    if (profileIds.length === 0) return result

    const placeholders = profileIds.map(() => '?').join(', ')
    const rows = database.prepare(`
      SELECT DISTINCT profile_id, anonymous_visitor_id
      FROM site_visit_events
      WHERE profile_id IN (${placeholders})
    `).all(...profileIds) as Array<{ profile_id: string; anonymous_visitor_id: string }>

    for (const row of rows) {
      let set = result.get(row.profile_id)
      if (!set) {
        set = new Set<string>()
        result.set(row.profile_id, set)
      }
      set.add(row.anonymous_visitor_id)
    }
    return result
  }

  // Batch намира ДРУГИ profile ids, споделящи поне един от дадените visitor
  // ids (query B от проучването — SEARCH USING INDEX
  // idx_site_visit_events_visitor_time, без нов индекс). Връща за всеки
  // visitor id множеството от profile ids, видени с него (за in-memory
  // group-иране по target по-долу).
  function findProfilesForVisitorIds(visitorIds: string[]): Map<string, Set<ProfileId>> {
    const result = new Map<string, Set<ProfileId>>()
    if (visitorIds.length === 0) return result

    const placeholders = visitorIds.map(() => '?').join(', ')
    const rows = database.prepare(`
      SELECT DISTINCT anonymous_visitor_id, profile_id
      FROM site_visit_events
      WHERE anonymous_visitor_id IN (${placeholders})
        AND profile_id IS NOT NULL
    `).all(...visitorIds) as Array<{ anonymous_visitor_id: string; profile_id: string }>

    for (const row of rows) {
      let set = result.get(row.anonymous_visitor_id)
      if (!set) {
        set = new Set<ProfileId>()
        result.set(row.anonymous_visitor_id, set)
      }
      set.add(row.profile_id)
    }
    return result
  }

  /**
   * Централна изчислителна логика, споделена от computeAndCacheRiskForProfiles
   * и recheckSingleProfile — за дадени target profile ids (вече знаем, че
   * трябва да бъдат computed/recomputed):
   * 1. Batch намира visitor ids на targets (1 заявка).
   * 2. Batch намира всички други профили, споделящи тези visitor ids (1 заявка).
   * 3. In-memory group-ира по target, upsert-ва target-а с risk резултата.
   * 4. За всеки намерен linked partner (различен от target-ите си), upsert-ва
   *    и него с risk_detected=1 (spec §6 логика) — без recursion/recheck.
   */
  function computeAndUpsert(targetProfileIds: ProfileId[]): void {
    if (targetProfileIds.length === 0) return

    const visitorIdsByTarget = findVisitorIdsForProfiles(targetProfileIds)

    const allVisitorIds = new Set<string>()
    for (const set of visitorIdsByTarget.values()) {
      for (const v of set) allVisitorIds.add(v)
    }

    const profilesByVisitorId = allVisitorIds.size > 0
      ? findProfilesForVisitorIds([...allVisitorIds])
      : new Map<string, Set<ProfileId>>()

    // linked partner profileId -> Set от target profileIds, с които го
    // свързахме (нужно само за да знаем кого да upsert-нем накрая; broят
    // linked profiles за partner-а самия не се гарантира точен тук — spec
    // explicit позволява груба стойност, детайлният breakdown идва от
    // getDetailedLinkedProfiles при popup click).
    const linkedPartnerIds = new Set<ProfileId>()

    for (const targetProfileId of targetProfileIds) {
      const visitorIds = visitorIdsByTarget.get(targetProfileId)
      if (!visitorIds || visitorIds.size === 0) {
        upsertCheckStatement.run(targetProfileId, 0, 0)
        continue
      }

      const linkedForTarget = new Set<ProfileId>()
      for (const visitorId of visitorIds) {
        const profilesForVisitor = profilesByVisitorId.get(visitorId)
        if (!profilesForVisitor) continue
        for (const otherProfileId of profilesForVisitor) {
          if (otherProfileId !== targetProfileId) {
            linkedForTarget.add(otherProfileId)
          }
        }
      }

      if (linkedForTarget.size === 0) {
        upsertCheckStatement.run(targetProfileId, 0, 0)
        continue
      }

      upsertCheckStatement.run(targetProfileId, 1, linkedForTarget.size)
      for (const partnerId of linkedForTarget) {
        linkedPartnerIds.add(partnerId)
      }
    }

    // Upsert-ни linked partner-ите, които НЕ бяха самите те в target batch-а
    // (тези вече бяха upsert-нати по-горе с точен linkedForTarget count).
    // linked_profiles_count тук е грубо "поне 1" — точното число не е
    // критично на този етап (виж doc-коментара по-горе), само risk_detected
    // трябва да светне надеждно.
    const targetSet = new Set(targetProfileIds)
    for (const partnerId of linkedPartnerIds) {
      if (targetSet.has(partnerId)) continue
      upsertCheckStatement.run(partnerId, 1, 1)
    }
  }

  function computeAndCacheRiskForProfiles(targetProfileIds: ProfileId[]): void {
    const uniqueIds = [...new Set(targetProfileIds)].filter((id) => id.trim().length > 0)
    if (uniqueIds.length === 0) return

    const alreadyCached = getCachedChecks(uniqueIds)
    const uncachedIds = uniqueIds.filter((id) => !alreadyCached.has(id))
    if (uncachedIds.length === 0) return

    computeAndUpsert(uncachedIds)
  }

  function recheckSingleProfile(targetProfileId: ProfileId): CachedProfileRiskCheck {
    // Forced — изтрий стария ред (ако има) и рекомпутирай, независимо от
    // memoization-а по-горе.
    deleteCheckStatement.run(targetProfileId)
    computeAndUpsert([targetProfileId])

    const row = database.prepare(`
      SELECT checked_at, risk_detected, linked_profiles_count
      FROM admin_profile_risk_checks
      WHERE profile_id = ?
    `).get(targetProfileId) as { checked_at: string; risk_detected: number; linked_profiles_count: number } | undefined

    return row ? toCachedCheck(row) : { checkedAt: new Date().toISOString(), riskDetected: false, linkedProfilesCount: 0 }
  }

  function getDetailedLinkedProfiles(targetProfileId: ProfileId): DetailedLinkedProfileRow[] {
    const visitorIdRows = database.prepare(`
      SELECT DISTINCT anonymous_visitor_id
      FROM site_visit_events
      WHERE profile_id = ?
    `).all(targetProfileId) as Array<{ anonymous_visitor_id: string }>

    const visitorIds = visitorIdRows.map((r) => r.anonymous_visitor_id)
    if (visitorIds.length === 0) return []

    const visitorPlaceholders = visitorIds.map(() => '?').join(', ')

    // CURRENT (не hard-deleted) profiles, различни от target-а, споделящи
    // поне един visitor id — join към profiles за да изключим orphan
    // profile_id referenced само в стари site_visit_events редове на вече
    // изтрит профил (FK на site_visit_events.profile_id е ON DELETE SET
    // NULL, така че такива редове вече имат profile_id=NULL и не се
    // хващат тук, но join-ът е defensive допълнителна гаранция).
    const candidateRows = database.prepare(`
      SELECT DISTINCT sve.profile_id AS profileId, p.username AS username, p.display_name AS displayName
      FROM site_visit_events sve
      JOIN profiles p ON p.profile_id = sve.profile_id
      WHERE sve.anonymous_visitor_id IN (${visitorPlaceholders})
        AND sve.profile_id IS NOT NULL
        AND sve.profile_id != ?
    `).all(...visitorIds, targetProfileId) as Array<{ profileId: string; username: string | null; displayName: string }>

    if (candidateRows.length === 0) return []

    const candidateIds = candidateRows.map((r) => r.profileId)

    // sharedVisitorIdsCount за всеки candidate — заявката е scoped само към
    // target-ните visitor ids И candidate-ните profile ids (малка bounded
    // linked група), не global scan.
    const candidatePlaceholders = candidateIds.map(() => '?').join(', ')
    const sharedVisitorRows = database.prepare(`
      SELECT profile_id AS profileId, COUNT(DISTINCT anonymous_visitor_id) AS sharedCount
      FROM site_visit_events
      WHERE profile_id IN (${candidatePlaceholders})
        AND anonymous_visitor_id IN (${visitorPlaceholders})
      GROUP BY profile_id
    `).all(...candidateIds, ...visitorIds) as Array<{ profileId: string; sharedCount: number }>

    const sharedVisitorCountByProfile = new Map<string, number>()
    for (const row of sharedVisitorRows) {
      sharedVisitorCountByProfile.set(row.profileId, row.sharedCount)
    }

    // sharedIpCount — non-null ip_address стойности, видени И за target-а,
    // И за всеки candidate. Scoped само към target+тази малка candidate
    // група (не global scan) — 2 малки заявки: target-овите IP-та, после
    // candidate-ите IP-та само измежду тях.
    const targetIpRows = database.prepare(`
      SELECT DISTINCT ip_address FROM site_visit_events
      WHERE profile_id = ? AND ip_address IS NOT NULL
    `).all(targetProfileId) as Array<{ ip_address: string }>
    const targetIps = new Set(targetIpRows.map((r) => r.ip_address))

    const sharedIpCountByProfile = new Map<string, number>()
    if (targetIps.size > 0) {
      const candidateIpRows = database.prepare(`
        SELECT profile_id AS profileId, ip_address AS ipAddress
        FROM site_visit_events
        WHERE profile_id IN (${candidatePlaceholders})
          AND ip_address IS NOT NULL
      `).all(...candidateIds) as Array<{ profileId: string; ipAddress: string }>

      const ipsByProfile = new Map<string, Set<string>>()
      for (const row of candidateIpRows) {
        let set = ipsByProfile.get(row.profileId)
        if (!set) {
          set = new Set<string>()
          ipsByProfile.set(row.profileId, set)
        }
        set.add(row.ipAddress)
      }
      for (const [profileId, ips] of ipsByProfile) {
        let count = 0
        for (const ip of ips) {
          if (targetIps.has(ip)) count += 1
        }
        sharedIpCountByProfile.set(profileId, count)
      }
    }

    return candidateRows.map((row) => ({
      profileId: row.profileId,
      username: row.username,
      displayName: row.displayName,
      sharedVisitorIdsCount: sharedVisitorCountByProfile.get(row.profileId) ?? 0,
      sharedIpCount: sharedIpCountByProfile.get(row.profileId) ?? 0,
    }))
  }

  function close(): void {
    database.close()
  }

  return {
    getCachedChecks,
    computeAndCacheRiskForProfiles,
    recheckSingleProfile,
    getDetailedLinkedProfiles,
    close,
  }
}

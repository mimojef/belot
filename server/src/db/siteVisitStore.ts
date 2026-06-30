import { getSofiaDayBoundsUtc, toSqliteUtc } from './sofiaDayBounds.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type SiteVisitNavigationType = 'navigate' | 'reload' | 'back_forward' | 'spa'

export type SiteVisitUtmParams = {
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
}

export type SiteVisitViewLayout = 'mobile' | 'desktop'
export type VisitorDeviceFilter = 'all' | 'mobile' | 'desktop' | 'tablet' | 'unknown'

export type RecordSitePageViewInput = {
  pageViewId: string
  anonymousVisitorId: string
  profileId: string | null
  path: string
  navigationType: SiteVisitNavigationType
  referrer: string | null
  source: string | null
  attributionReferrer: string | null
  attributionSource: string | null
  utm: SiteVisitUtmParams
  ipAddress: string | null
  userAgent: string | null
  viewLayout: SiteVisitViewLayout | null
  isEntry: boolean
  lastDeviceType: string | null
}

export type RecordSitePageViewResult =
  | { ok: true; recorded: true }
  | { ok: true; recorded: false; duplicate: true }

export type VisitorSummary = {
  today: number
  yesterday: number
  last7days: number
  last30days: number
}

export type ViewLayoutPeriodCounts = {
  mobile: number
  desktop: number
}

export type ViewLayoutSummary = {
  today: ViewLayoutPeriodCounts
  yesterday: ViewLayoutPeriodCounts
  last7days: ViewLayoutPeriodCounts
  last30days: ViewLayoutPeriodCounts
}

export type VisitorListPeriod = 'today' | 'yesterday' | '7d' | '30d'
export type VisitorListType = 'all' | 'guest' | 'registered'

export type VisitorListRow = {
  anonymousVisitorId: string
  isRegistered: boolean
  displayName: string | null
  email: string | null
  lastIpAddress: string | null
  lastDeviceType: string | null
  firstSource: string | null
  firstReferrer: string | null
  firstSeenAt: string
  lastSeenAt: string
  pageViews: number
  reloads: number
}

export type VisitorListResult = {
  rows: VisitorListRow[]
  total: number
}

export type VisitorSourceRow = {
  label: string
  visitors: number
  percent: number
}

export type VisitorSourcesResult = {
  rows: VisitorSourceRow[]
  total: number
}

export type SiteVisitStore = {
  recordPageView: (input: RecordSitePageViewInput) => RecordSitePageViewResult
  getVisitorSummary: (now?: Date) => VisitorSummary
  getViewLayoutSummary: (now?: Date) => ViewLayoutSummary
  getVisitorList: (params: {
    period: VisitorListPeriod
    type: VisitorListType
    device: VisitorDeviceFilter
    limit: number
    offset: number
  }, now?: Date) => VisitorListResult
  getVisitorSources: (params: { period: VisitorListPeriod; type: VisitorListType; device: VisitorDeviceFilter }, now?: Date) => VisitorSourcesResult
  purgeOlderThanDays: (days: number) => { deletedEvents: number; deletedVisitors: number }
  close: () => void
}

export async function createSiteVisitStore(databaseFilePath: string): Promise<SiteVisitStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const insertVisitorStatement = database.prepare(`
    INSERT OR IGNORE INTO site_visitors (
      anonymous_visitor_id,
      first_profile_id,
      last_profile_id,
      first_ip_address,
      last_ip_address,
      first_user_agent,
      last_user_agent,
      first_referrer,
      last_referrer,
      first_source,
      last_source,
      last_device_type
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const insertEventStatement = database.prepare(`
    INSERT OR IGNORE INTO site_visit_events (
      page_view_id,
      anonymous_visitor_id,
      profile_id,
      path,
      navigation_type,
      referrer,
      source,
      utm_source,
      utm_medium,
      utm_campaign,
      utm_term,
      utm_content,
      ip_address,
      user_agent,
      view_layout,
      is_entry
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const updateVisitorSeenStatement = database.prepare(`
    UPDATE site_visitors
    SET last_seen_at = CURRENT_TIMESTAMP,
        last_profile_id = ?,
        last_ip_address = ?,
        last_user_agent = ?,
        last_device_type = ?
    WHERE anonymous_visitor_id = ?;
  `)

  const updateVisitorLastTouchStatement = database.prepare(`
    UPDATE site_visitors
    SET last_seen_at = CURRENT_TIMESTAMP,
        last_profile_id = ?,
        last_ip_address = ?,
        last_user_agent = ?,
        last_device_type = ?,
        last_referrer = ?,
        last_source = ?
    WHERE anonymous_visitor_id = ?;
  `)

  // Counts distinct visitors in a half-open UTC interval [since, until).
  const countInRangeStmt = database.prepare(`
    SELECT COUNT(DISTINCT anonymous_visitor_id) AS n
    FROM site_visit_events
    WHERE occurred_at >= ? AND occurred_at < ?;
  `)

  // Counts distinct visitors from a rolling UTC start to the present (no upper bound).
  const countSinceStmt = database.prepare(`
    SELECT COUNT(DISTINCT anonymous_visitor_id) AS n
    FROM site_visit_events
    WHERE occurred_at >= ?;
  `)

  // Counts app-entry page-views by view_layout in a half-open UTC interval.
  // is_entry = 1 means the initial load (navigate/reload at startup, or
  // back_forward as the very first event). SPA pushState and in-app popstate
  // events are stored with is_entry = 0. Old rows default to 0 and are excluded.
  const countLayoutInRangeStmt = database.prepare(`
    SELECT view_layout, COUNT(*) AS n
    FROM site_visit_events
    WHERE view_layout IN ('mobile', 'desktop')
      AND is_entry = 1
      AND occurred_at >= ?
      AND occurred_at < ?
    GROUP BY view_layout;
  `)

  // Same as above but without an upper bound (for rolling 7d/30d periods).
  const countLayoutSinceStmt = database.prepare(`
    SELECT view_layout, COUNT(*) AS n
    FROM site_visit_events
    WHERE view_layout IN ('mobile', 'desktop')
      AND is_entry = 1
      AND occurred_at >= ?
    GROUP BY view_layout;
  `)

  const purgeEventsStatement = database.prepare(`
    DELETE FROM site_visit_events
    WHERE occurred_at < datetime('now', ?);
  `)

  const purgeOrphanVisitorsStatement = database.prepare(`
    DELETE FROM site_visitors
    WHERE last_seen_at < datetime('now', ?)
      AND NOT EXISTS (
        SELECT 1
        FROM site_visit_events e
        WHERE e.anonymous_visitor_id = site_visitors.anonymous_visitor_id
        LIMIT 1
      );
  `)

  function getChanges(result: unknown): number {
    return typeof result === 'object' && result !== null && 'changes' in result && typeof result.changes === 'number'
      ? result.changes
      : 0
  }

  function recordPageView(input: RecordSitePageViewInput): RecordSitePageViewResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      insertVisitorStatement.run(
        input.anonymousVisitorId,
        input.profileId,
        input.profileId,
        input.ipAddress,
        input.ipAddress,
        input.userAgent,
        input.userAgent,
        input.attributionReferrer,
        input.attributionReferrer,
        input.attributionSource ?? input.source,
        input.attributionSource ?? input.source,
        input.lastDeviceType,
      )

      const insertEventResult = insertEventStatement.run(
        input.pageViewId,
        input.anonymousVisitorId,
        input.profileId,
        input.path,
        input.navigationType,
        input.referrer,
        input.source,
        input.utm.utmSource,
        input.utm.utmMedium,
        input.utm.utmCampaign,
        input.utm.utmTerm,
        input.utm.utmContent,
        input.ipAddress,
        input.userAgent,
        input.viewLayout,
        input.isEntry ? 1 : 0,
      )

      if (getChanges(insertEventResult) === 0) {
        database.exec('ROLLBACK;')
        return { ok: true, recorded: false, duplicate: true }
      }

      if (input.attributionReferrer !== null || input.attributionSource !== null) {
        updateVisitorLastTouchStatement.run(
          input.profileId,
          input.ipAddress,
          input.userAgent,
          input.lastDeviceType,
          input.attributionReferrer,
          input.attributionSource,
          input.anonymousVisitorId,
        )
      } else {
        updateVisitorSeenStatement.run(
          input.profileId,
          input.ipAddress,
          input.userAgent,
          input.lastDeviceType,
          input.anonymousVisitorId,
        )
      }

      database.exec('COMMIT;')
      return { ok: true, recorded: true }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  // Builds a parameterized WHERE clause fragment for the given period.
  // 'today'/'yesterday' use Sofia calendar day boundaries (half-open [start, end)).
  // '7d'/'30d' are rolling from the given `now` — never the SQLite real clock.
  // Returns { sql: fragment with ? placeholders, params: values in order }.
  type TimeFilter = { sql: string; params: string[] }
  function buildSofiaTimeFilter(alias: string, period: VisitorListPeriod, now: Date): TimeFilter {
    const bounds = getSofiaDayBoundsUtc(now)
    const col = `${alias}.occurred_at`
    switch (period) {
      case 'today':
        return { sql: `${col} >= ? AND ${col} < ?`, params: [bounds.todayStart, bounds.tomorrowStart] }
      case 'yesterday':
        return { sql: `${col} >= ? AND ${col} < ?`, params: [bounds.yesterdayStart, bounds.todayStart] }
      case '7d': {
        const since = toSqliteUtc(new Date(now.getTime() - 7 * 86_400_000))
        return { sql: `${col} >= ?`, params: [since] }
      }
      case '30d': {
        const since = toSqliteUtc(new Date(now.getTime() - 30 * 86_400_000))
        return { sql: `${col} >= ?`, params: [since] }
      }
    }
  }

  function countInRange(since: string, until: string): number {
    const row = countInRangeStmt.get(since, until) as { n: number } | undefined
    return row?.n ?? 0
  }

  function countSince(since: string): number {
    const row = countSinceStmt.get(since) as { n: number } | undefined
    return row?.n ?? 0
  }

  function getVisitorSummary(now: Date = new Date()): VisitorSummary {
    const bounds = getSofiaDayBoundsUtc(now)
    const last7Start  = toSqliteUtc(new Date(now.getTime() - 7  * 86_400_000))
    const last30Start = toSqliteUtc(new Date(now.getTime() - 30 * 86_400_000))
    return {
      today:      countInRange(bounds.todayStart,     bounds.tomorrowStart),
      yesterday:  countInRange(bounds.yesterdayStart, bounds.todayStart),
      last7days:  countSince(last7Start),
      last30days: countSince(last30Start),
    }
  }

  function getViewLayoutSummary(now: Date = new Date()): ViewLayoutSummary {
    const bounds = getSofiaDayBoundsUtc(now)
    const last7Start  = toSqliteUtc(new Date(now.getTime() - 7  * 86_400_000))
    const last30Start = toSqliteUtc(new Date(now.getTime() - 30 * 86_400_000))

    type LayoutRow = { view_layout: string; n: number }

    function toCounts(rows: LayoutRow[]): ViewLayoutPeriodCounts {
      let mobile = 0
      let desktop = 0
      for (const row of rows) {
        if (row.view_layout === 'mobile') mobile = row.n
        else if (row.view_layout === 'desktop') desktop = row.n
      }
      return { mobile, desktop }
    }

    return {
      today:     toCounts(countLayoutInRangeStmt.all(bounds.todayStart,     bounds.tomorrowStart) as LayoutRow[]),
      yesterday: toCounts(countLayoutInRangeStmt.all(bounds.yesterdayStart, bounds.todayStart)    as LayoutRow[]),
      last7days:  toCounts(countLayoutSinceStmt.all(last7Start)  as LayoutRow[]),
      last30days: toCounts(countLayoutSinceStmt.all(last30Start) as LayoutRow[]),
    }
  }

  function getVisitorList(params: {
    period: VisitorListPeriod
    type: VisitorListType
    device: VisitorDeviceFilter
    limit: number
    offset: number
  }, now: Date = new Date()): VisitorListResult {
    const filter = buildSofiaTimeFilter('e', params.period, now)

    const typeFilter =
      params.type === 'guest'      ? 'AND v.last_profile_id IS NULL' :
      params.type === 'registered' ? 'AND v.last_profile_id IS NOT NULL' :
      ''

    const deviceFilter =
      params.device === 'mobile'   ? 'AND v.last_device_type = \'mobile\'' :
      params.device === 'desktop'  ? 'AND v.last_device_type = \'desktop\'' :
      params.device === 'tablet'   ? 'AND v.last_device_type = \'tablet\'' :
      params.device === 'unknown'  ? 'AND (v.last_device_type = \'unknown\' OR v.last_device_type IS NULL)' :
      ''

    const baseQuery = `
      FROM site_visitors v
      LEFT JOIN profiles p ON p.profile_id = v.last_profile_id
      LEFT JOIN accounts a ON a.account_id = p.account_id
      WHERE EXISTS (
        SELECT 1 FROM site_visit_events e
        WHERE e.anonymous_visitor_id = v.anonymous_visitor_id
          AND ${filter.sql}
      )
      ${typeFilter}
      ${deviceFilter}
    `

    // filter.sql appears once in baseQuery → 1× params
    const countRow = database.prepare(`SELECT COUNT(*) AS n ${baseQuery}`).get(...filter.params) as { n: number }
    const total = countRow?.n ?? 0

    type RawRow = {
      anonymous_visitor_id: string
      last_profile_id: string | null
      display_name: string | null
      email: string | null
      last_ip_address: string | null
      last_device_type: string | null
      first_source: string | null
      first_referrer: string | null
      first_seen_at: string
      last_seen_at: string
      page_views: number
      reloads: number
    }

    const safeLimit = Math.max(1, Math.min(200, params.limit))
    const safeOffset = Math.max(0, params.offset)

    // filter.sql appears 3×: page_views subquery, reloads subquery, baseQuery WHERE EXISTS
    const tripleParams = [...filter.params, ...filter.params, ...filter.params]

    const rows = database.prepare(`
      SELECT
        v.anonymous_visitor_id,
        v.last_profile_id,
        p.display_name,
        a.email,
        v.last_ip_address,
        v.last_device_type,
        v.first_source,
        v.first_referrer,
        v.first_seen_at,
        v.last_seen_at,
        (SELECT COUNT(*) FROM site_visit_events e
          WHERE e.anonymous_visitor_id = v.anonymous_visitor_id
            AND ${filter.sql}) AS page_views,
        (SELECT COUNT(*) FROM site_visit_events e
          WHERE e.anonymous_visitor_id = v.anonymous_visitor_id
            AND e.navigation_type = 'reload'
            AND ${filter.sql}) AS reloads
      ${baseQuery}
      ORDER BY v.last_seen_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `).all(...tripleParams) as RawRow[]

    return {
      total,
      rows: rows.map((r) => ({
        anonymousVisitorId: r.anonymous_visitor_id,
        isRegistered: r.last_profile_id !== null,
        displayName: r.display_name,
        email: r.email,
        lastIpAddress: r.last_ip_address,
        lastDeviceType: r.last_device_type,
        firstSource: r.first_source,
        firstReferrer: r.first_referrer,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        pageViews: r.page_views,
        reloads: r.reloads,
      })),
    }
  }

  function getVisitorSources(params: { period: VisitorListPeriod; type: VisitorListType; device: VisitorDeviceFilter }, now: Date = new Date()): VisitorSourcesResult {
    const filter = buildSofiaTimeFilter('e', params.period, now)

    const typeFilter =
      params.type === 'guest'      ? 'AND v.last_profile_id IS NULL' :
      params.type === 'registered' ? 'AND v.last_profile_id IS NOT NULL' :
      ''

    const deviceFilter =
      params.device === 'mobile'   ? 'AND v.last_device_type = \'mobile\'' :
      params.device === 'desktop'  ? 'AND v.last_device_type = \'desktop\'' :
      params.device === 'tablet'   ? 'AND v.last_device_type = \'tablet\'' :
      params.device === 'unknown'  ? 'AND (v.last_device_type = \'unknown\' OR v.last_device_type IS NULL)' :
      ''

    type RawRow = { referrer: string | null; source: string | null; n: number }
    // filter.sql appears once → 1× params
    const raw = database.prepare(`
      SELECT
        v.first_referrer AS referrer,
        v.first_source   AS source,
        COUNT(DISTINCT v.anonymous_visitor_id) AS n
      FROM site_visitors v
      WHERE EXISTS (
        SELECT 1 FROM site_visit_events e
        WHERE e.anonymous_visitor_id = v.anonymous_visitor_id
          AND ${filter.sql}
      )
      ${typeFilter}
      ${deviceFilter}
      GROUP BY v.first_referrer, v.first_source
    `).all(...filter.params) as RawRow[]

    // Normalizes source/referrer to a human-readable label.
    // Priority: first_source (UTM/explicit) → hostname from first_referrer → 'Директно'.
    // Known aliases are collapsed to canonical names; unknown values shown as-is.
    function normalize(referrer: string | null, source: string | null): string {
      const raw = (source ?? extractHostname(referrer) ?? '').toLowerCase().trim()
      if (!raw || raw === 'direct') return 'Директно'
      if (raw === 'pika.bg' || raw === 'localhost') return 'Pika.bg'
      if (raw === 'facebook' || raw === 'fb' || raw === 'facebook_ads' ||
          /(?:^|\.)facebook\.com$/.test(raw)) return 'Facebook'
      if (raw === 'instagram' || raw === 'ig' ||
          /(?:^|\.)instagram\.com$/.test(raw)) return 'Instagram'
      if (raw === 'google' || raw === 'google_ads' || raw === 'googleadservices' ||
          /(?:^|\.)google\.[a-z]{2,}$/.test(raw)) return 'Google'
      // Unknown UTM source or domain — show as-is but title-cased if it looks like a keyword.
      return source != null ? source : (extractHostname(referrer) ?? 'Директно')
    }

    function extractHostname(referrer: string | null): string | null {
      if (!referrer) return null
      try {
        const url = referrer.includes('://') ? referrer : `https://${referrer}`
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        return referrer
      }
    }

    // Aggregate by normalized label. Each visitor counted once.
    const labelCounts = new Map<string, number>()
    for (const row of raw) {
      const label = normalize(row.referrer, row.source)
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + row.n)
    }

    const total = [...labelCounts.values()].reduce((a, b) => a + b, 0)

    // Sort by visitors DESC; 'Директно' always last among equals (stable tie-break).
    const sorted = [...labelCounts.entries()].sort(([aLabel, aCount], [bLabel, bCount]) => {
      if (bCount !== aCount) return bCount - aCount
      if (aLabel === 'Директно') return 1
      if (bLabel === 'Директно') return -1
      return aLabel.localeCompare(bLabel, 'bg')
    })

    const rows: VisitorSourceRow[] = sorted.map(([label, visitors]) => ({
      label,
      visitors,
      percent: total > 0 ? Math.round((visitors / total) * 100) : 0,
    }))

    return { rows, total }
  }

  function purgeOlderThanDays(days: number): { deletedEvents: number; deletedVisitors: number } {
    const normalizedDays = Number.isInteger(days) && days > 0 ? days : 90
    const cutoffModifier = `-${normalizedDays} days`
    database.exec('BEGIN IMMEDIATE;')
    try {
      const deletedEvents = getChanges(purgeEventsStatement.run(cutoffModifier))
      const deletedVisitors = getChanges(purgeOrphanVisitorsStatement.run(cutoffModifier))
      database.exec('COMMIT;')
      return { deletedEvents, deletedVisitors }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Preserve the original failure.
      }
      throw error
    }
  }

  function close(): void {
    database.close()
  }

  return {
    recordPageView,
    getVisitorSummary,
    getViewLayoutSummary,
    getVisitorList,
    getVisitorSources,
    purgeOlderThanDays,
    close,
  }
}

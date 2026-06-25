type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type SiteVisitNavigationType = 'navigate' | 'reload' | 'back_forward' | 'spa'

export type SiteVisitUtmParams = {
  utmSource: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmTerm: string | null
  utmContent: string | null
}

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

export type SiteVisitStore = {
  recordPageView: (input: RecordSitePageViewInput) => RecordSitePageViewResult
  getVisitorSummary: () => VisitorSummary
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
      last_source
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
      user_agent
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
      ?
    );
  `)

  const updateVisitorSeenStatement = database.prepare(`
    UPDATE site_visitors
    SET last_seen_at = CURRENT_TIMESTAMP,
        last_profile_id = ?,
        last_ip_address = ?,
        last_user_agent = ?
    WHERE anonymous_visitor_id = ?;
  `)

  const updateVisitorLastTouchStatement = database.prepare(`
    UPDATE site_visitors
    SET last_seen_at = CURRENT_TIMESTAMP,
        last_profile_id = ?,
        last_ip_address = ?,
        last_user_agent = ?,
        last_referrer = ?,
        last_source = ?
    WHERE anonymous_visitor_id = ?;
  `)

  const visitorCountStatement = database.prepare(`
    SELECT COUNT(DISTINCT anonymous_visitor_id) AS n
    FROM site_visit_events
    WHERE occurred_at >= datetime('now', ?);
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
          input.attributionReferrer,
          input.attributionSource,
          input.anonymousVisitorId,
        )
      } else {
        updateVisitorSeenStatement.run(
          input.profileId,
          input.ipAddress,
          input.userAgent,
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

  function countVisitors(modifier: string): number {
    const row = visitorCountStatement.get(modifier) as { n: number } | undefined
    return row?.n ?? 0
  }

  function getVisitorSummary(): VisitorSummary {
    return {
      today:     countVisitors('start of day'),
      yesterday: countVisitors('-1 days, start of day'),
      last7days:  countVisitors('-7 days'),
      last30days: countVisitors('-30 days'),
    }
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
    purgeOlderThanDays,
    close,
  }
}

import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type AdCampaignActorRole = 'admin' | 'pika_team'

export type AdCampaignActor = {
  profileId: string
  role: AdCampaignActorRole
}

export type AdCampaignManagementRow = {
  campaignId: string
  imageUrl: string
  targetUrl: string | null
  createdAt: string
  createdByProfileId: string | null
  createdByRole: AdCampaignActorRole
  createdByDisplayName: string | null
  dispatchCount: number
  lastDispatchAt: string | null
}

export type AdCampaignPendingDispatch = {
  dispatchId: string
  campaignId: string
  imageUrl: string
  targetUrl: string | null
  sentAt: string
}

export type AdCampaignEventType =
  | 'campaign_created'
  | 'campaign_deleted'
  | 'dispatch_created'
  | 'receipt_dismissed'
  | 'receipt_clicked'

export type AdCampaignEventRow = {
  eventSeq: number
  eventType: AdCampaignEventType
  campaignId: string | null
  dispatchId: string | null
  profileId: string | null
  createdAt: string
}

export type AdCampaignsStore = {
  listForManagement: () => AdCampaignManagementRow[]
  createCampaign: (input: {
    imageUrl: string
    imageFilename: string
    targetUrl: string | null
    actor: AdCampaignActor
  }) => { ok: true; campaign: AdCampaignManagementRow; eventSeq: number } | { ok: false; message: string }
  getActiveCampaignById: (campaignId: string) => { campaignId: string; imageUrl: string; targetUrl: string | null } | null
  getManagementRowById: (campaignId: string) => AdCampaignManagementRow | null
  sendCampaign: (
    campaignId: string,
    actor: AdCampaignActor,
  ) =>
    | { ok: true; dispatchId: string; sentAt: string; campaign: AdCampaignManagementRow; eventSeq: number }
    | { ok: false; message: string }
  softDeleteCampaign: (
    campaignId: string,
    actor: AdCampaignActor,
  ) => { ok: true; imageFilename: string; eventSeq: number } | { ok: false; message: string }
  listPendingDispatchesForProfile: (profileId: string) => AdCampaignPendingDispatch[]
  markDispatchShown: (dispatchId: string, profileId: string) => void
  markDispatchDismissed: (
    dispatchId: string,
    profileId: string,
  ) => { ok: true; campaignId: string; eventSeq: number } | { ok: false; message: string }
  markDispatchClicked: (
    dispatchId: string,
    profileId: string,
  ) => { ok: true; campaignId: string; eventSeq: number } | { ok: false; message: string }
  pollEvents: (sinceSeq: number, limit: number) => AdCampaignEventRow[]
  getMaxEventSeq: () => number
  close: () => void
}

type ManagementRowRaw = {
  campaign_id: string
  image_url: string
  target_url: string | null
  created_at: string
  created_by_profile_id: string | null
  created_by_role: AdCampaignActorRole
  created_by_display_name: string | null
  dispatch_count: number
  last_dispatch_at: string | null
}

function rowToManagementRow(row: ManagementRowRaw): AdCampaignManagementRow {
  return {
    campaignId: row.campaign_id,
    imageUrl: row.image_url,
    targetUrl: row.target_url,
    createdAt: row.created_at,
    createdByProfileId: row.created_by_profile_id,
    createdByRole: row.created_by_role,
    createdByDisplayName: row.created_by_display_name,
    dispatchCount: row.dispatch_count,
    lastDispatchAt: row.last_dispatch_at,
  }
}

export async function createAdCampaignsStore(
  databaseFilePath: string,
): Promise<AdCampaignsStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const MANAGEMENT_ROW_SELECT = `
    SELECT
      c.campaign_id,
      c.image_url,
      c.target_url,
      c.created_at,
      c.created_by_profile_id,
      c.created_by_role,
      p.display_name AS created_by_display_name,
      COUNT(d.dispatch_id) AS dispatch_count,
      MAX(d.sent_at) AS last_dispatch_at
    FROM ad_campaigns c
    LEFT JOIN ad_campaign_dispatches d ON d.campaign_id = c.campaign_id
    LEFT JOIN profiles p ON p.profile_id = c.created_by_profile_id
    WHERE c.deleted_at IS NULL
  `

  const selectManagementListStatement = database.prepare(`
    ${MANAGEMENT_ROW_SELECT}
    GROUP BY c.campaign_id
    ORDER BY c.created_at DESC;
  `)

  const selectManagementRowByIdStatement = database.prepare(`
    ${MANAGEMENT_ROW_SELECT}
      AND c.campaign_id = ?
    GROUP BY c.campaign_id;
  `)

  const selectActiveCampaignByIdStatement = database.prepare(`
    SELECT campaign_id, image_url, target_url
    FROM ad_campaigns
    WHERE campaign_id = ? AND deleted_at IS NULL;
  `)

  const selectCampaignForDeleteStatement = database.prepare(`
    SELECT image_filename, deleted_at
    FROM ad_campaigns
    WHERE campaign_id = ?;
  `)

  const insertCampaignStatement = database.prepare(`
    INSERT INTO ad_campaigns (campaign_id, image_url, image_filename, target_url, created_by_profile_id, created_by_role)
    VALUES (?, ?, ?, ?, ?, ?);
  `)

  const insertDispatchStatement = database.prepare(`
    INSERT INTO ad_campaign_dispatches (dispatch_id, campaign_id, sent_by_profile_id, sent_by_role)
    VALUES (?, ?, ?, ?);
  `)

  const selectDispatchSentAtStatement = database.prepare(`
    SELECT sent_at FROM ad_campaign_dispatches WHERE dispatch_id = ?;
  `)

  const softDeleteCampaignStatement = database.prepare(`
    UPDATE ad_campaigns
    SET deleted_at = CURRENT_TIMESTAMP, deleted_by_profile_id = ?, deleted_by_role = ?
    WHERE campaign_id = ? AND deleted_at IS NULL;
  `)

  const selectPendingDispatchesStatement = database.prepare(`
    SELECT d.dispatch_id, d.campaign_id, c.image_url, c.target_url, d.sent_at
    FROM ad_campaign_dispatches d
    JOIN ad_campaigns c ON c.campaign_id = d.campaign_id
    LEFT JOIN ad_campaign_receipts r ON r.dispatch_id = d.dispatch_id AND r.profile_id = ?
    WHERE c.deleted_at IS NULL AND r.dismissed_at IS NULL AND r.clicked_at IS NULL
    ORDER BY d.sent_at ASC;
  `)

  const selectDispatchCampaignIdStatement = database.prepare(`
    SELECT campaign_id FROM ad_campaign_dispatches WHERE dispatch_id = ?;
  `)

  const upsertReceiptShownStatement = database.prepare(`
    INSERT INTO ad_campaign_receipts (dispatch_id, profile_id, shown_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(dispatch_id, profile_id) DO UPDATE SET
      shown_at = COALESCE(ad_campaign_receipts.shown_at, excluded.shown_at);
  `)

  const upsertReceiptDismissedStatement = database.prepare(`
    INSERT INTO ad_campaign_receipts (dispatch_id, profile_id, dismissed_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(dispatch_id, profile_id) DO UPDATE SET
      dismissed_at = COALESCE(ad_campaign_receipts.dismissed_at, excluded.dismissed_at);
  `)

  const upsertReceiptClickedStatement = database.prepare(`
    INSERT INTO ad_campaign_receipts (dispatch_id, profile_id, clicked_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(dispatch_id, profile_id) DO UPDATE SET
      clicked_at = COALESCE(ad_campaign_receipts.clicked_at, excluded.clicked_at);
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO ad_campaign_events (event_type, campaign_id, dispatch_id, profile_id)
    VALUES (?, ?, ?, ?);
  `)

  const selectEventsSinceStatement = database.prepare(`
    SELECT event_seq, event_type, campaign_id, dispatch_id, profile_id, created_at
    FROM ad_campaign_events
    WHERE event_seq > ?
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  const selectMaxEventSeqStatement = database.prepare(`
    SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM ad_campaign_events;
  `)

  function listForManagement(): AdCampaignManagementRow[] {
    return (selectManagementListStatement.all() as ManagementRowRaw[]).map(rowToManagementRow)
  }

  function getManagementRowById(campaignId: string): AdCampaignManagementRow | null {
    const row = selectManagementRowByIdStatement.get(campaignId) as ManagementRowRaw | undefined
    return row ? rowToManagementRow(row) : null
  }

  function createCampaign(input: {
    imageUrl: string
    imageFilename: string
    targetUrl: string | null
    actor: AdCampaignActor
  }): { ok: true; campaign: AdCampaignManagementRow; eventSeq: number } | { ok: false; message: string } {
    const campaignId = randomUUID()
    let eventSeq: number

    try {
      database.exec('BEGIN;')
      insertCampaignStatement.run(
        campaignId,
        input.imageUrl,
        input.imageFilename,
        input.targetUrl,
        input.actor.profileId,
        input.actor.role,
      )
      const eventResult = insertEventStatement.run('campaign_created', campaignId, null, null)
      eventSeq = Number(eventResult.lastInsertRowid)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка при създаване на кампанията.' }
    }

    const campaign = getManagementRowById(campaignId)
    if (!campaign) {
      return { ok: false, message: 'Кампанията не беше записана.' }
    }

    return { ok: true, campaign, eventSeq }
  }

  function getActiveCampaignById(campaignId: string): { campaignId: string; imageUrl: string; targetUrl: string | null } | null {
    const row = selectActiveCampaignByIdStatement.get(campaignId) as
      | { campaign_id: string; image_url: string; target_url: string | null }
      | undefined

    if (!row) return null

    return { campaignId: row.campaign_id, imageUrl: row.image_url, targetUrl: row.target_url }
  }

  function sendCampaign(
    campaignId: string,
    actor: AdCampaignActor,
  ):
    | { ok: true; dispatchId: string; sentAt: string; campaign: AdCampaignManagementRow; eventSeq: number }
    | { ok: false; message: string } {
    const activeCampaign = getActiveCampaignById(campaignId)
    if (!activeCampaign) {
      return { ok: false, message: 'Кампанията не съществува.' }
    }

    const dispatchId = randomUUID()
    let eventSeq: number

    try {
      database.exec('BEGIN;')
      insertDispatchStatement.run(dispatchId, campaignId, actor.profileId, actor.role)
      const eventResult = insertEventStatement.run('dispatch_created', campaignId, dispatchId, null)
      eventSeq = Number(eventResult.lastInsertRowid)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка при изпращане на кампанията.' }
    }

    const sentAtRow = selectDispatchSentAtStatement.get(dispatchId) as { sent_at: string } | undefined
    const campaign = getManagementRowById(campaignId)

    if (!sentAtRow || !campaign) {
      return { ok: false, message: 'Изпращането не беше записано.' }
    }

    return { ok: true, dispatchId, sentAt: sentAtRow.sent_at, campaign, eventSeq }
  }

  function softDeleteCampaign(
    campaignId: string,
    actor: AdCampaignActor,
  ): { ok: true; imageFilename: string; eventSeq: number } | { ok: false; message: string } {
    const existing = selectCampaignForDeleteStatement.get(campaignId) as
      | { image_filename: string; deleted_at: string | null }
      | undefined

    if (!existing) {
      return { ok: false, message: 'Кампанията не съществува.' }
    }
    if (existing.deleted_at !== null) {
      return { ok: false, message: 'Кампанията вече е изтрита.' }
    }

    let eventSeq: number

    try {
      database.exec('BEGIN;')
      const result = softDeleteCampaignStatement.run(actor.profileId, actor.role, campaignId)
      if ((result.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Кампанията вече е изтрита.' }
      }
      const eventResult = insertEventStatement.run('campaign_deleted', campaignId, null, null)
      eventSeq = Number(eventResult.lastInsertRowid)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка при изтриване на кампанията.' }
    }

    return { ok: true, imageFilename: existing.image_filename, eventSeq }
  }

  function listPendingDispatchesForProfile(profileId: string): AdCampaignPendingDispatch[] {
    const rows = selectPendingDispatchesStatement.all(profileId) as Array<{
      dispatch_id: string
      campaign_id: string
      image_url: string
      target_url: string | null
      sent_at: string
    }>

    return rows.map((row) => ({
      dispatchId: row.dispatch_id,
      campaignId: row.campaign_id,
      imageUrl: row.image_url,
      targetUrl: row.target_url,
      sentAt: row.sent_at,
    }))
  }

  function getDispatchCampaignId(dispatchId: string): string | null {
    const row = selectDispatchCampaignIdStatement.get(dispatchId) as { campaign_id: string } | undefined
    return row?.campaign_id ?? null
  }

  function markDispatchShown(dispatchId: string, profileId: string): void {
    if (getDispatchCampaignId(dispatchId) === null) return
    try {
      upsertReceiptShownStatement.run(dispatchId, profileId)
    } catch {
      // best-effort analytics timestamp — не влияе на delivery state machine-а.
    }
  }

  function markDispatchDismissed(
    dispatchId: string,
    profileId: string,
  ): { ok: true; campaignId: string; eventSeq: number } | { ok: false; message: string } {
    const campaignId = getDispatchCampaignId(dispatchId)
    if (campaignId === null) {
      return { ok: false, message: 'Изпращането не съществува.' }
    }

    let eventSeq: number

    try {
      database.exec('BEGIN;')
      upsertReceiptDismissedStatement.run(dispatchId, profileId)
      const eventResult = insertEventStatement.run('receipt_dismissed', campaignId, dispatchId, profileId)
      eventSeq = Number(eventResult.lastInsertRowid)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка.' }
    }

    return { ok: true, campaignId, eventSeq }
  }

  function markDispatchClicked(
    dispatchId: string,
    profileId: string,
  ): { ok: true; campaignId: string; eventSeq: number } | { ok: false; message: string } {
    const campaignId = getDispatchCampaignId(dispatchId)
    if (campaignId === null) {
      return { ok: false, message: 'Изпращането не съществува.' }
    }

    let eventSeq: number

    try {
      database.exec('BEGIN;')
      upsertReceiptClickedStatement.run(dispatchId, profileId)
      const eventResult = insertEventStatement.run('receipt_clicked', campaignId, dispatchId, profileId)
      eventSeq = Number(eventResult.lastInsertRowid)
      database.exec('COMMIT;')
    } catch (err) {
      try { database.exec('ROLLBACK;') } catch { /* ignore */ }
      return { ok: false, message: err instanceof Error ? err.message : 'Грешка.' }
    }

    return { ok: true, campaignId, eventSeq }
  }

  function pollEvents(sinceSeq: number, limit: number): AdCampaignEventRow[] {
    const rows = selectEventsSinceStatement.all(sinceSeq, limit) as Array<{
      event_seq: number
      event_type: AdCampaignEventType
      campaign_id: string | null
      dispatch_id: string | null
      profile_id: string | null
      created_at: string
    }>

    return rows.map((row) => ({
      eventSeq: row.event_seq,
      eventType: row.event_type,
      campaignId: row.campaign_id,
      dispatchId: row.dispatch_id,
      profileId: row.profile_id,
      createdAt: row.created_at,
    }))
  }

  function getMaxEventSeq(): number {
    const row = selectMaxEventSeqStatement.get() as { max_seq: number }
    return row.max_seq
  }

  function close(): void {
    database.close()
  }

  return {
    listForManagement,
    createCampaign,
    getActiveCampaignById,
    getManagementRowById,
    sendCampaign,
    softDeleteCampaign,
    listPendingDispatchesForProfile,
    markDispatchShown,
    markDispatchDismissed,
    markDispatchClicked,
    pollEvents,
    getMaxEventSeq,
    close,
  }
}

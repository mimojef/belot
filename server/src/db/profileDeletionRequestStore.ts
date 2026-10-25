// Самоизтриване на профили — Етап 3: подаване, токени за отмяна, отмяна и
// "остави заявката активна" върху profile_deletion_requests (20261024_001) и
// profile_deletion_restore_tokens (20261025_001).
//
// Единственият източник на истината за "скрит" профил остава
// profile_deletion_requests (виж profileDeletionVisibility.ts);
// profiles.status НЕ се пипа. Тук НЕ се трият данни — окончателното
// изтриване е в profileDeletionExecutor.ts (Етап 4).
//
// Всички времена са каноничен UTC ISO от часовника на SQLite
// (strftime('%Y-%m-%dT%H:%M:%fZ','now')), за да няма разминаване между
// процесите и с тригерите в базата.

import { randomUUID } from 'node:crypto'
import { generateRawResetToken, hashResetToken, hmacRateLimitSubject, validateRateLimitSecret } from './authHelpers.js'
import { createProfileDeletionParticipationChecks, type PersistedActiveGameEvidence } from './profileDeletionParticipationChecks.js'
import {
  computeProfileDeletionSchedule,
  PROFILE_DELETION_ACTIVE_REQUEST_STATUSES,
  PROFILE_DELETION_GRACE_PERIOD_DAYS,
} from './profileDeletionSchedule.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/** Валидност на токена за отмяна — достатъчно за избор в popup-а, без да остава дълго жив. */
export const PROFILE_DELETION_RESTORE_TOKEN_TTL_MS = 10 * 60 * 1000

const RESTORE_TOKEN_FORMAT_RE = /^[A-Za-z0-9_-]{43}$/
const ACTIVE_STATUS_SQL_LIST = PROFILE_DELETION_ACTIVE_REQUEST_STATUSES.map((status) => `'${status}'`).join(', ')

export type ProfileDeletionPendingRequest = {
  requestId: string
  profileId: string
  requestedAt: string
  scheduledFor: string
  /** Етап 4G — срокът на ТАЗИ заявка от базата: 30 (нови) или 45 (исторически). */
  gracePeriodDays: number
}

export type CreateProfileDeletionRequestResult =
  | { ok: true; request: ProfileDeletionPendingRequest; eventSeq: number }
  | { ok: false; code: 'already_pending' | 'profile_not_eligible' | 'active_tournament' | 'active_tournament_organizer' | 'active_game' | 'active_ban' }

export type IssueProfileDeletionRestoreTokenResult =
  | { ok: true; restoreToken: string; expiresAt: string; request: ProfileDeletionPendingRequest }
  | { ok: false; code: 'no_pending_request' | 'cancellation_pending' }

/**
 * Етап 4J1 — отмяната е ПРИЕТА (трайна защита срещу изтриване в базата);
 * окончателна е едва след записа в регистъра и offsite потвърждението
 * (core/profileDeletionCancellationFinalizer.ts). alreadyAccepted — заявката
 * вече има приета отмяна (повторно подаване, без втора логическа отмяна).
 */
export type CancelProfileDeletionResult =
  | { ok: true; profileId: string; requestId: string; cancellationId: string; alreadyAccepted: boolean }
  | { ok: false; code: 'invalid_token' | 'window_closed' | 'deletion_proven' }

export type KeepProfileDeletionResult = { ok: true } | { ok: false; code: 'invalid_token' }

export type ProfileDeletionVisibilityEvent = {
  eventSeq: number
  requestId: string
  profileId: string
  eventType: 'requested' | 'cancelled'
}

export type ProfileDeletionRequestStore = {
  getPendingRequest: (profileId: string) => ProfileDeletionPendingRequest | null
  createRequest: (input: { profileId: string; accountId: string }) => CreateProfileDeletionRequestResult
  issueRestoreToken: (profileId: string) => IssueProfileDeletionRestoreTokenResult
  /**
   * isDeletionProven — регистърът съдържа доказано изтриване на заявката
   * (възстановена, още не reconcile-ната база) -> отказ.
   */
  cancelWithToken: (rawToken: string, options?: { isDeletionProven?: (requestId: string) => boolean }) => CancelProfileDeletionResult
  keepWithToken: (rawToken: string) => KeepProfileDeletionResult
  /**
   * Етап 4 — системна отмяна, когато процес открие, че профилът е бил приет
   * в игра в собствената му памет МЕЖДУ проверката и записа на заявката
   * (race между процесите). Само pending и само преди scheduled_for.
   * Етап 4J1 — също двуфазна (приета -> окончателна).
   * Етап 4K2 — също при възстановена игра след рестарт; в СЪЩАТА транзакция
   * се записва и еднократното уведомление. isDeletionProven се проверява
   * вътре в транзакцията (регистърът доказва необратимо решение -> отказ).
   */
  cancelForActiveParticipation: (
    requestId: string,
    options?: { isDeletionProven?: (requestId: string) => boolean },
  ) => { ok: true; cancellationId: string } | { ok: false; code: 'not_allowed' | 'deletion_proven' }
  /** Етап 4K2 — активни (pending, преди срока, без lease) заявки без приета отмяна. */
  listPendingRequestsWithoutCancellation: (limit: number) => Array<{ requestId: string; profileId: string }>
  /** Етап 4K2 — дали приетата отмяна е автоматична (има уведомление за нея). */
  hasAutoCancellationNotice: (cancellationId: string) => boolean
  /**
   * Етап 4K2 — маркира като показани уведомленията за ОКОНЧАТЕЛНИ автоматични
   * отмени на профила; true, ако е имало поне едно непоказано (еднократно).
   */
  takeAutoCancellationNotice: (profileId: string) => boolean
  /**
   * Споделен между процесите rate limit (registration_rate_limit_events,
   * HMAC субект). true = ограничено (не се записва нов опит). Без валиден
   * secret — fail-closed (true).
   */
  isRateLimited: (input: { scope: string; subject: string; windowSeconds: number; maxEvents: number }) => boolean
  /** true, ако в персистираните snapshot-и има активен Белот/Не се сърди човече/Свара с този профил (или snapshot-ът е нечетим — fail-closed). */
  hasActiveGameSnapshot: (profileId: string) => boolean
  /** Етап 4K2 — тристепенно: само 'present' е положително доказателство. */
  assessPersistedActiveGame: (profileId: string) => PersistedActiveGameEvidence
  findActiveTournamentDependency: (profileId: string) => 'participant' | 'organizer' | null
  listVisibilityEventsAfter: (afterEventSeq: number, limit: number) => ProfileDeletionVisibilityEvent[]
  getMaxEventSeq: () => number
  /** Профилите, с които има ред в profile_friendships (всякакъв статус/вид) — за realtime известия. */
  listRelationshipCounterpartIds: (profileId: string) => string[]
  close: () => void
}

export async function createProfileDeletionRequestStore(
  databaseFilePath: string,
  options: { rateLimitSecret: string },
): Promise<ProfileDeletionRequestStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const rateLimitSecret = options.rateLimitSecret
  const isRateLimitSecretValid = validateRateLimitSecret(rateLimitSecret)

  const selectNowStatement = database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`)

  const selectPendingRequestStatement = database.prepare(`
    SELECT request_id, profile_id, requested_at, scheduled_for, grace_period_days
    FROM profile_deletion_requests
    WHERE profile_id = ? AND status = 'pending'
    LIMIT 1;
  `)

  // Етап 4E6B (бизнес правило): докато профилът има активен бан, заявка за
  // самоизтриване не може да бъде подадена. Същата семантика като
  // profileBanStore.getActiveBan (lifted_at IS NULL И banned_until > сега по
  // часовника на SQLite).
  const selectActiveBanStatement = database.prepare(`
    SELECT 1 FROM profile_bans
    WHERE profile_id = ? AND lifted_at IS NULL AND banned_until > CURRENT_TIMESTAMP
    LIMIT 1;
  `)

  const selectActiveRequestStatement = database.prepare(`
    SELECT request_id FROM profile_deletion_requests
    WHERE profile_id = ? AND status IN (${ACTIVE_STATUS_SQL_LIST})
    LIMIT 1;
  `)

  const selectProfileIdentityStatement = database.prepare(`
    SELECT profile_id, account_id, created_at, profile_kind, is_temporary
    FROM profiles
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const insertRequestStatement = database.prepare(`
    INSERT INTO profile_deletion_requests (
      request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO profile_deletion_events (request_id, profile_id, event_type, actor_kind, detail_json)
    VALUES (?, ?, ?, 'user', ?);
  `)

  const supersedeTokensStatement = database.prepare(`
    UPDATE profile_deletion_restore_tokens
    SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), consumed_reason = 'superseded'
    WHERE request_id = ? AND consumed_at IS NULL;
  `)

  const insertTokenStatement = database.prepare(`
    INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at)
    VALUES (?, ?, ?, ?);
  `)

  const selectTokenStatement = database.prepare(`
    SELECT t.token_hash, t.request_id, t.profile_id, t.expires_at, t.consumed_at,
           r.status AS request_status, r.scheduled_for, r.profile_id AS request_profile_id
    FROM profile_deletion_restore_tokens t
    JOIN profile_deletion_requests r ON r.request_id = t.request_id
    WHERE t.token_hash = ?
    LIMIT 1;
  `)

  const consumeTokenStatement = database.prepare(`
    UPDATE profile_deletion_restore_tokens
    SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), consumed_reason = ?
    WHERE token_hash = ? AND consumed_at IS NULL;
  `)

  // Етап 4J1 — приемане на отмяната (фаза 1). Статусът на заявката не се
  // променя тук; тригерът проверява срока, lease-а и необратимата граница.
  const insertCancellationStatement = database.prepare(`
    INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, previous_status)
    VALUES (?, ?, ?, ?, 'pending');
  `)

  const selectCancellationForRequestStatement = database.prepare(`
    SELECT cancellation_id FROM profile_deletion_cancellations WHERE request_id = ? LIMIT 1;
  `)

  const insertAutoCancellationNoticeStatement = database.prepare(`
    INSERT INTO profile_deletion_auto_cancellation_notices (cancellation_id) VALUES (?);
  `)

  const selectAutoCancellationNoticeStatement = database.prepare(`
    SELECT 1 FROM profile_deletion_auto_cancellation_notices WHERE cancellation_id = ? LIMIT 1;
  `)

  const deliverAutoCancellationNoticesStatement = database.prepare(`
    UPDATE profile_deletion_auto_cancellation_notices
    SET delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE delivered_at IS NULL
      AND cancellation_id IN (
        SELECT c.cancellation_id FROM profile_deletion_cancellations c
        WHERE c.profile_id = ? AND c.finalized_at IS NOT NULL
      );
  `)

  const selectPendingWithoutCancellationStatement = database.prepare(`
    SELECT r.request_id, r.profile_id
    FROM profile_deletion_requests r
    WHERE r.status = 'pending'
      AND r.lease_owner IS NULL
      AND r.db_deleted_at IS NULL
      AND r.scheduled_for > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      AND NOT EXISTS (SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = r.request_id)
    ORDER BY r.requested_at, r.request_id
    LIMIT ?;
  `)

  const countRateLimitEventsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM registration_rate_limit_events
    WHERE scope = ? AND subject_hash = ? AND created_at > datetime('now', ? || ' seconds');
  `)

  const insertRateLimitEventStatement = database.prepare(`
    INSERT INTO registration_rate_limit_events (event_id, scope, subject_hash) VALUES (?, ?, ?);
  `)

  const participationChecks = createProfileDeletionParticipationChecks(database)

  const selectRequestByIdStatement = database.prepare(`
    SELECT request_id, profile_id, status FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;
  `)

  const selectVisibilityEventsStatement = database.prepare(`
    SELECT event_seq, request_id, profile_id, event_type
    FROM profile_deletion_events
    WHERE event_seq > ? AND event_type IN ('requested', 'cancelled')
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  const selectMaxEventSeqStatement = database.prepare(`SELECT COALESCE(MAX(event_seq), 0) AS seq FROM profile_deletion_events;`)

  const selectCounterpartsStatement = database.prepare(`
    SELECT DISTINCT CASE WHEN requester_profile_id = ? THEN addressee_profile_id ELSE requester_profile_id END AS counterpart
    FROM profile_friendships
    WHERE requester_profile_id = ? OR addressee_profile_id = ?;
  `)

  function dbNow(): string {
    return (selectNowStatement.get() as { now: string }).now
  }

  function toPendingRequest(row: { request_id: string; profile_id: string; requested_at: string; scheduled_for: string; grace_period_days: number }): ProfileDeletionPendingRequest {
    return {
      requestId: row.request_id,
      profileId: row.profile_id,
      requestedAt: row.requested_at,
      scheduledFor: row.scheduled_for,
      gracePeriodDays: Number(row.grace_period_days),
    }
  }

  function getPendingRequest(profileId: string): ProfileDeletionPendingRequest | null {
    const row = selectPendingRequestStatement.get(profileId) as Parameters<typeof toPendingRequest>[0] | undefined
    return row ? toPendingRequest(row) : null
  }

  function rollbackQuietly(): void {
    try { database.exec('ROLLBACK;') } catch { /* няма отворена транзакция */ }
  }

  function createRequest(input: { profileId: string; accountId: string }): CreateProfileDeletionRequestResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const profile = selectProfileIdentityStatement.get(input.profileId) as
        | { profile_id: string; account_id: string | null; created_at: string; profile_kind: string; is_temporary: number }
        | undefined
      if (
        profile === undefined ||
        profile.account_id === null ||
        profile.account_id !== input.accountId ||
        profile.profile_kind !== 'human' ||
        profile.is_temporary !== 0
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'profile_not_eligible' }
      }
      if (selectActiveRequestStatement.get(input.profileId) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_pending' }
      }
      if (selectActiveBanStatement.get(profile.profile_id) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'active_ban' }
      }
      // Етап 4: проверките, видими за всички процеси, са ВЪТРЕ в writer
      // lock-а. Турнирно записване в друг процес е или преди нас (виждаме го
      // тук), или след нас (тригерът върху tournament_entries го отказва).
      // Етап 4K — отделни кодове (активна игра / турнирно участие).
      if (participationChecks.hasPersistedActiveGame(profile.profile_id)) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'active_game' }
      }
      const tournamentDependency = participationChecks.findActiveTournamentDependency(profile.profile_id)
      if (tournamentDependency !== null) {
        database.exec('ROLLBACK;')
        return { ok: false, code: tournamentDependency === 'organizer' ? 'active_tournament_organizer' : 'active_tournament' }
      }
      // Етап 4G — срокът тече от часовника на базата в момента на приемане
      // (клиентският часовник не участва); повторна заявка при вече активна
      // се отказва по-горе (already_pending), т.е. срокът не може да бъде
      // удължен/съкратен с повторно подаване.
      const schedule = computeProfileDeletionSchedule(new Date(dbNow()))
      const requestId = randomUUID()
      insertRequestStatement.run(requestId, profile.profile_id, profile.account_id, profile.created_at, schedule.requestedAt, schedule.scheduledFor, PROFILE_DELETION_GRACE_PERIOD_DAYS)
      const eventResult = insertEventStatement.run(requestId, profile.profile_id, 'requested', JSON.stringify({ source: 'self' })) as { lastInsertRowid: number | bigint }
      database.exec('COMMIT;')
      return {
        ok: true,
        request: {
          requestId,
          profileId: profile.profile_id,
          requestedAt: schedule.requestedAt,
          scheduledFor: schedule.scheduledFor,
          gracePeriodDays: PROFILE_DELETION_GRACE_PERIOD_DAYS,
        },
        eventSeq: Number(eventResult.lastInsertRowid),
      }
    } catch (error) {
      rollbackQuietly()
      // Конкурентна заявка от друг процес между проверката и INSERT-а —
      // partial unique индексът е последната защита.
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        return { ok: false, code: 'already_pending' }
      }
      throw error
    }
  }

  function issueRestoreToken(profileId: string): IssueProfileDeletionRestoreTokenResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const row = selectPendingRequestStatement.get(profileId) as Parameters<typeof toPendingRequest>[0] | undefined
      if (row === undefined || row.scheduled_for <= now) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'no_pending_request' }
      }
      if (selectCancellationForRequestStatement.get(row.request_id) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'cancellation_pending' }
      }
      supersedeTokensStatement.run(row.request_id)
      const restoreToken = generateRawResetToken()
      const expiresAt = new Date(Date.parse(now) + PROFILE_DELETION_RESTORE_TOKEN_TTL_MS).toISOString()
      insertTokenStatement.run(hashResetToken(restoreToken), row.request_id, row.profile_id, expiresAt)
      database.exec('COMMIT;')
      return { ok: true, restoreToken, expiresAt, request: toPendingRequest(row) }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  type TokenRow = {
    token_hash: string
    request_id: string
    profile_id: string
    expires_at: string
    consumed_at: string | null
    request_status: string
    scheduled_for: string
    request_profile_id: string
  }

  /** Общата проверка за cancel/keep — вика се ВЪТРЕ в отворена транзакция. */
  function loadUsableToken(rawToken: string, now: string): { row: TokenRow } | { error: 'invalid_token' | 'window_closed' } {
    if (typeof rawToken !== 'string' || !RESTORE_TOKEN_FORMAT_RE.test(rawToken)) return { error: 'invalid_token' }
    const row = selectTokenStatement.get(hashResetToken(rawToken)) as TokenRow | undefined
    if (
      row === undefined ||
      row.consumed_at !== null ||
      row.expires_at <= now ||
      row.request_status !== 'pending' ||
      row.profile_id !== row.request_profile_id
    ) {
      return { error: 'invalid_token' }
    }
    if (row.scheduled_for <= now) return { error: 'window_closed' }
    return { row }
  }

  function cancelWithToken(rawToken: string, options: { isDeletionProven?: (requestId: string) => boolean } = {}): CancelProfileDeletionResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const loaded = loadUsableToken(rawToken, dbNow())
      if ('error' in loaded) {
        database.exec('ROLLBACK;')
        return { ok: false, code: loaded.error }
      }
      const { row } = loaded
      const existing = selectCancellationForRequestStatement.get(row.request_id) as { cancellation_id: string } | undefined
      if (existing === undefined && options.isDeletionProven?.(row.request_id) === true) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'deletion_proven' }
      }
      const consumed = consumeTokenStatement.run('cancelled', row.token_hash) as { changes: number }
      if (Number(consumed.changes) !== 1) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'invalid_token' }
      }
      let cancellationId = existing?.cancellation_id ?? null
      if (cancellationId === null) {
        cancellationId = randomUUID()
        insertCancellationStatement.run(cancellationId, row.request_id, row.profile_id, 'user')
      }
      database.exec('COMMIT;')
      return { ok: true, profileId: row.profile_id, requestId: row.request_id, cancellationId, alreadyAccepted: existing !== undefined }
    } catch (error) {
      rollbackQuietly()
      // Тригерът в базата е последната защита за прозореца за отмяна.
      if (error instanceof Error && error.message.includes('profile_deletion_cancel_window_closed')) {
        return { ok: false, code: 'window_closed' }
      }
      if (error instanceof Error && error.message.includes('profile_deletion_cancellation_not_allowed')) {
        return { ok: false, code: 'invalid_token' }
      }
      throw error
    }
  }

  function keepWithToken(rawToken: string): KeepProfileDeletionResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const loaded = loadUsableToken(rawToken, dbNow())
      if ('error' in loaded) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'invalid_token' }
      }
      const consumed = consumeTokenStatement.run('kept', loaded.row.token_hash) as { changes: number }
      database.exec('COMMIT;')
      return Number(consumed.changes) === 1 ? { ok: true } : { ok: false, code: 'invalid_token' }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function cancelForActiveParticipation(
    requestId: string,
    options: { isDeletionProven?: (requestId: string) => boolean } = {},
  ): { ok: true; cancellationId: string } | { ok: false; code: 'not_allowed' | 'deletion_proven' } {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectRequestByIdStatement.get(requestId) as { request_id: string; profile_id: string; status: string } | undefined
      if (row === undefined || row.status !== 'pending' || selectCancellationForRequestStatement.get(requestId) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_allowed' }
      }
      // Етап 4K2 — вътре в writer lock-а: решението на worker-а се записва в
      // регистъра ПРЕДИ освобождаването на lease-а, затова тук то вече е видимо.
      if (options.isDeletionProven?.(requestId) === true) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'deletion_proven' }
      }
      const cancellationId = randomUUID()
      insertCancellationStatement.run(cancellationId, requestId, row.profile_id, 'system')
      insertAutoCancellationNoticeStatement.run(cancellationId)
      database.exec('COMMIT;')
      return { ok: true, cancellationId }
    } catch (error) {
      rollbackQuietly()
      if (error instanceof Error && (error.message.includes('profile_deletion_cancel_window_closed') || error.message.includes('profile_deletion_cancellation_not_allowed'))) {
        return { ok: false, code: 'not_allowed' }
      }
      throw error
    }
  }

  function listPendingRequestsWithoutCancellation(limit: number): Array<{ requestId: string; profileId: string }> {
    return (selectPendingWithoutCancellationStatement.all(Math.max(1, Math.min(1000, limit))) as Array<{ request_id: string; profile_id: string }>)
      .map((row) => ({ requestId: row.request_id, profileId: row.profile_id }))
  }

  function takeAutoCancellationNotice(profileId: string): boolean {
    const result = deliverAutoCancellationNoticesStatement.run(profileId) as { changes: number }
    return Number(result.changes) > 0
  }

  function isRateLimited(input: { scope: string; subject: string; windowSeconds: number; maxEvents: number }): boolean {
    if (!isRateLimitSecretValid) return true
    const subjectHash = hmacRateLimitSubject(input.scope, input.subject, rateLimitSecret)
    const row = countRateLimitEventsStatement.get(input.scope, subjectHash, `-${input.windowSeconds}`) as { cnt: number }
    if (row.cnt >= input.maxEvents) return true
    insertRateLimitEventStatement.run(randomUUID(), input.scope, subjectHash)
    return false
  }

  function hasActiveGameSnapshot(profileId: string): boolean {
    return participationChecks.hasPersistedActiveGame(profileId)
  }

  function listVisibilityEventsAfter(afterEventSeq: number, limit: number): ProfileDeletionVisibilityEvent[] {
    return (selectVisibilityEventsStatement.all(afterEventSeq, limit) as Array<{ event_seq: number; request_id: string; profile_id: string; event_type: 'requested' | 'cancelled' }>)
      .map((row) => ({ eventSeq: row.event_seq, requestId: row.request_id, profileId: row.profile_id, eventType: row.event_type }))
  }

  function getMaxEventSeq(): number {
    return (selectMaxEventSeqStatement.get() as { seq: number }).seq
  }

  function listRelationshipCounterpartIds(profileId: string): string[] {
    return (selectCounterpartsStatement.all(profileId, profileId, profileId) as Array<{ counterpart: string }>).map((row) => row.counterpart)
  }

  return {
    getPendingRequest,
    createRequest,
    issueRestoreToken,
    cancelWithToken,
    keepWithToken,
    cancelForActiveParticipation,
    listPendingRequestsWithoutCancellation,
    hasAutoCancellationNotice: (cancellationId) => selectAutoCancellationNoticeStatement.get(cancellationId) !== undefined,
    takeAutoCancellationNotice,
    isRateLimited,
    hasActiveGameSnapshot,
    assessPersistedActiveGame: (profileId) => participationChecks.assessPersistedActiveGame(profileId),
    findActiveTournamentDependency: (profileId) => participationChecks.findActiveTournamentDependency(profileId),
    listVisibilityEventsAfter,
    getMaxEventSeq,
    listRelationshipCounterpartIds,
    close: () => database.close(),
  }
}

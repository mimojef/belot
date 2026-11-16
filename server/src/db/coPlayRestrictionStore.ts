// „Забрана за съвместна игра“ (Етап 1) — store + кеш в паметта.
//
// Двустранна административна забрана между ДВА АКАУНТА (всички настоящи и
// бъдещи профили на акаунтите). Администраторът избира два профила; те се
// пазят само за историята, а идентичността/уникалността е по accountId.
//
// Кеш (единственият източник за проверките в честите пътища — без SQL):
//   * незатворените забрани по двойка акаунти (двете посоки) — зареждат се
//     при старт и се обновяват САМО след успешен COMMIT на налагане/отмяна;
//   * изтеклите забрани не действат дори да са в кеша (сравнение с часовника
//     при всяко четене) и отпадат от кеша при първото четене — без job;
//   * profileId -> accountId (неизменна връзка) се запомня при първото
//     поискване и се търси в базата само когато има поне една забрана в кеша.
//
// Глобален флаг CO_PLAY_RESTRICTIONS_ENABLED (по подразбиране изключен):
// при изключен флаг проверките (isRestrictedBetweenProfiles /
// findRestrictedProfileIds) винаги пропускат ограниченията; записаните
// забрани и историята им се пазят. Сменя се от администратор без рестарт.

import { randomUUID } from 'node:crypto'
import { escapeSqlLikePattern, normalizeProfileSearchTerm } from './normalizeProfileIdentityText.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

/** Игри, за които може да има забрана. Засега само Белот (бъдещо: 'svara', 'ludo'). */
export const CO_PLAY_GAMES = ['belot'] as const
export type CoPlayGame = (typeof CO_PLAY_GAMES)[number]

export const CO_PLAY_RESTRICTIONS_ENABLED_SETTING_KEY = 'co_play_restrictions_enabled'
export const CO_PLAY_MAX_DURATION_DAYS = 3650
export const CO_PLAY_MAX_REASON_LENGTH = 500
export const CO_PLAY_MS_PER_DAY = 24 * 60 * 60 * 1000

const PROFILE_ACCOUNT_MEMO_LIMIT = 200_000
const SEARCH_PROFILE_LIMIT = 50

export type CoPlayRestrictionStatus = 'active' | 'expired' | 'lifted'

export type CoPlayRestrictionProfileRef = {
  profileId: string
  accountId: string
  displayNameSnapshot: string
  /** Текущото име (null — профилът вече не съществува). */
  currentDisplayName: string | null
}

export type CoPlayRestrictionView = {
  restrictionId: string
  gameScope: CoPlayGame
  status: CoPlayRestrictionStatus
  /** Двата избрани профила (историята); редът е по accountId, не по избора. */
  profiles: [CoPlayRestrictionProfileRef, CoPlayRestrictionProfileRef]
  reason: string
  durationDays: number | null
  isIndefinite: boolean
  createdAt: string
  createdByProfileId: string | null
  createdByDisplayName: string | null
  expiresAt: string | null
  endedAt: string | null
  /** 'lifted' — предсрочна отмяна; 'expired' — изтекъл срок (затворен при ново налагане). */
  endKind: 'lifted' | 'expired' | null
  liftedByProfileId: string | null
  liftedByDisplayName: string | null
  liftReason: string | null
}

export type CoPlayRestrictionAuditAction = 'impose' | 'lift' | 'close_expired' | 'settings_update' | 'enforcement_removed'

export type CoPlayRestrictionAuditView = {
  auditId: string
  restrictionId: string | null
  action: CoPlayRestrictionAuditAction
  actorProfileId: string | null
  actorDisplayName: string | null
  createdAt: string
  details: Record<string, unknown> | null
}

export type CoPlayRestrictionSettings = {
  enabled: boolean
  updatedAt: string | null
  updatedByProfileId: string | null
}

export type ImposeCoPlayRestrictionErrorCode =
  | 'invalid_profiles'
  | 'same_profile'
  | 'profile_not_found'
  | 'profile_not_eligible'
  | 'same_account'
  | 'invalid_reason'
  | 'invalid_duration'
  | 'invalid_game'
  | 'already_restricted'

export type ImposeCoPlayRestrictionResult =
  | { ok: true; restriction: CoPlayRestrictionView }
  | { ok: false; code: ImposeCoPlayRestrictionErrorCode; message: string; existingRestrictionId?: string }

export type LiftCoPlayRestrictionErrorCode = 'not_found' | 'not_active' | 'invalid_reason'

export type LiftCoPlayRestrictionResult =
  | { ok: true; restriction: CoPlayRestrictionView }
  | { ok: false; code: LiftCoPlayRestrictionErrorCode; message: string; status?: CoPlayRestrictionStatus }

export type ListCoPlayRestrictionsInput = {
  status?: CoPlayRestrictionStatus | 'all'
  /** profileId (точно съвпадение) или част от името на профил. */
  profileQuery?: string | null
  limit?: number
  offset?: number
}

export type CoPlayRestrictionStore = {
  /** Глобалният флаг (от паметта). */
  isEnabled: () => boolean
  getSettings: () => CoPlayRestrictionSettings
  setEnabled: (input: { enabled: boolean; actorProfileId: string }) => { ok: true; changed: boolean; settings: CoPlayRestrictionSettings }
  /**
   * Проверка за честите пътища (само памет). false при изключен флаг, при
   * еднакви акаунти, при профил без акаунт (бот/гост) и при изтекла забрана.
   */
  isRestrictedBetweenProfiles: (profileIdA: string, profileIdB: string, game?: CoPlayGame) => boolean
  /** Кои от otherProfileIds са забранени с profileId (празно при изключен флаг). */
  findRestrictedProfileIds: (profileId: string, otherProfileIds: readonly string[], game?: CoPlayGame) => string[]
  /** Активна забрана между профилите НЕЗАВИСИМО от флага (администрация/диагностика). */
  getActiveRestrictionIdBetweenProfiles: (profileIdA: string, profileIdB: string, game?: CoPlayGame) => string | null
  /**
   * Бърз път (само памет): флагът е включен И има поне една активна забрана в
   * кеша. false -> проверките за съвместна игра не правят нищо.
   */
  isEnforcementActive: () => boolean
  /**
   * Активна забрана между два АКАУНТА (само памет, без SQL; accountId идва от
   * сървърната сесия). null при изключен флаг, null/еднакъв акаунт или
   * изтекла забрана.
   */
  getEnforcedRestrictionIdBetweenAccounts: (accountIdA: string | null | undefined, accountIdB: string | null | undefined, game?: CoPlayGame) => string | null
  /** Одит на действие по прилагане (премахване от чакалня и т.н.) — рядко, не в честите пътища. */
  recordEnforcementAudit: (input: { restrictionId: string | null; actorProfileId: string | null; details: Record<string, unknown> }) => void
  imposeRestriction: (input: {
    firstProfileId: string
    secondProfileId: string
    reason: string
    /** null = безсрочна. */
    durationDays: number | null
    game?: CoPlayGame
    actorProfileId: string
  }) => ImposeCoPlayRestrictionResult
  liftRestriction: (input: { restrictionId: string; actorProfileId: string; reason?: string | null }) => LiftCoPlayRestrictionResult
  getRestriction: (restrictionId: string) => CoPlayRestrictionView | null
  listRestrictions: (input: ListCoPlayRestrictionsInput) => { items: CoPlayRestrictionView[]; total: number }
  listAudit: (input: { restrictionId?: string | null; limit?: number; offset?: number }) => { items: CoPlayRestrictionAuditView[]; total: number }
  /** Презарежда флага и незатворените забрани от базата (при старт и при несъответствие). */
  reload: () => void
  /** Брой забрани в кеша (диагностика/тестове). */
  getCachedRestrictionCount: () => number
  close: () => void
}

type RestrictionRow = {
  restriction_id: string
  account_low_id: string
  account_high_id: string
  game_scope: string
  selected_profile_low_id: string
  selected_profile_high_id: string
  selected_profile_low_name_snapshot: string
  selected_profile_high_name_snapshot: string
  reason: string
  duration_days: number | null
  created_at: string
  created_by_profile_id: string | null
  expires_at: string | null
  ended_at: string | null
  end_kind: 'lifted' | 'expired' | null
  lifted_by_profile_id: string | null
  lift_reason: string | null
  low_current_name?: string | null
  high_current_name?: string | null
  created_by_name?: string | null
  lifted_by_name?: string | null
}

type CacheEntry = { restrictionId: string; expiresAtMs: number | null }

function isCoPlayGame(value: unknown): value is CoPlayGame {
  return typeof value === 'string' && (CO_PLAY_GAMES as readonly string[]).includes(value)
}

function parseIsoMs(value: string | null): number | null {
  if (value === null) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function computeCoPlayRestrictionStatus(
  row: Pick<RestrictionRow, 'ended_at' | 'end_kind' | 'expires_at'>,
  nowMs: number,
): CoPlayRestrictionStatus {
  if (row.end_kind === 'lifted') return 'lifted'
  if (row.end_kind === 'expired') return 'expired'
  const expiresAtMs = parseIsoMs(row.expires_at)
  if (expiresAtMs !== null && expiresAtMs <= nowMs) return 'expired'
  return 'active'
}

export async function createCoPlayRestrictionStore(
  databaseFilePath: string,
  options: { now?: () => number } = {},
): Promise<CoPlayRestrictionStore> {
  const now = options.now ?? (() => Date.now())
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const RESTRICTION_COLUMNS = `
    r.restriction_id, r.account_low_id, r.account_high_id, r.game_scope,
    r.selected_profile_low_id, r.selected_profile_high_id,
    r.selected_profile_low_name_snapshot, r.selected_profile_high_name_snapshot,
    r.reason, r.duration_days, r.created_at, r.created_by_profile_id,
    r.expires_at, r.ended_at, r.end_kind, r.lifted_by_profile_id, r.lift_reason,
    pl.display_name AS low_current_name, ph.display_name AS high_current_name,
    pc.display_name AS created_by_name, pf.display_name AS lifted_by_name`
  const RESTRICTION_JOINS = `
    LEFT JOIN profiles pl ON pl.profile_id = r.selected_profile_low_id
    LEFT JOIN profiles ph ON ph.profile_id = r.selected_profile_high_id
    LEFT JOIN profiles pc ON pc.profile_id = r.created_by_profile_id
    LEFT JOIN profiles pf ON pf.profile_id = r.lifted_by_profile_id`

  const selectProfileStatement = database.prepare(`
    SELECT profile_id, account_id, profile_kind, display_name FROM profiles WHERE profile_id = ? LIMIT 1;
  `)
  const selectProfileAccountStatement = database.prepare(`
    SELECT account_id, profile_kind FROM profiles WHERE profile_id = ? LIMIT 1;
  `)
  const selectOpenRestrictionsStatement = database.prepare(`
    SELECT restriction_id, account_low_id, account_high_id, game_scope, expires_at
    FROM co_play_restrictions
    WHERE ended_at IS NULL;
  `)
  const selectOpenRestrictionForPairStatement = database.prepare(`
    SELECT restriction_id, expires_at FROM co_play_restrictions
    WHERE account_low_id = ? AND account_high_id = ? AND game_scope = ? AND ended_at IS NULL
    LIMIT 1;
  `)
  const selectRestrictionByIdStatement = database.prepare(`
    SELECT ${RESTRICTION_COLUMNS} FROM co_play_restrictions r ${RESTRICTION_JOINS}
    WHERE r.restriction_id = ? LIMIT 1;
  `)
  const insertRestrictionStatement = database.prepare(`
    INSERT INTO co_play_restrictions (
      restriction_id, account_low_id, account_high_id, game_scope,
      selected_profile_low_id, selected_profile_high_id,
      selected_profile_low_name_snapshot, selected_profile_high_name_snapshot,
      reason, duration_days, created_at, created_by_profile_id, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
  `)
  const closeExpiredStatement = database.prepare(`
    UPDATE co_play_restrictions SET ended_at = expires_at, end_kind = 'expired'
    WHERE restriction_id = ? AND ended_at IS NULL AND expires_at IS NOT NULL;
  `)
  const liftStatement = database.prepare(`
    UPDATE co_play_restrictions
    SET ended_at = ?, end_kind = 'lifted', lifted_by_profile_id = ?, lift_reason = ?
    WHERE restriction_id = ? AND ended_at IS NULL;
  `)
  const insertAuditStatement = database.prepare(`
    INSERT INTO co_play_restriction_audit (audit_id, restriction_id, action, actor_profile_id, created_at, details_json)
    VALUES (?, ?, ?, ?, ?, ?);
  `)
  const selectSettingStatement = database.prepare(`
    SELECT setting_value, updated_at, updated_by_profile_id FROM co_play_restriction_settings WHERE setting_key = ? LIMIT 1;
  `)
  const upsertSettingStatement = database.prepare(`
    INSERT INTO co_play_restriction_settings (setting_key, setting_value, updated_at, updated_by_profile_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      setting_value = excluded.setting_value,
      updated_at = excluded.updated_at,
      updated_by_profile_id = excluded.updated_by_profile_id;
  `)
  const searchProfileAccountsStatement = database.prepare(`
    SELECT DISTINCT account_id FROM profiles
    WHERE account_id IS NOT NULL
      AND (profile_id = ? OR normalized_display_name LIKE ? ESCAPE '\\')
    LIMIT ${SEARCH_PROFILE_LIMIT};
  `)

  // ─── Състояние в паметта ──────────────────────────────────────────────
  let enabled = false
  let settingsUpdatedAt: string | null = null
  let settingsUpdatedBy: string | null = null
  const restrictionsByAccount = new Map<string, Map<string, Map<CoPlayGame, CacheEntry>>>()
  let cachedRestrictionCount = 0
  const accountByProfile = new Map<string, string | null>()

  function cacheSet(accountA: string, accountB: string, game: CoPlayGame, entry: CacheEntry): void {
    let added = false
    for (const [from, to] of [[accountA, accountB], [accountB, accountA]] as const) {
      let byOther = restrictionsByAccount.get(from)
      if (byOther === undefined) {
        byOther = new Map()
        restrictionsByAccount.set(from, byOther)
      }
      let byGame = byOther.get(to)
      if (byGame === undefined) {
        byGame = new Map()
        byOther.set(to, byGame)
      }
      if (from === accountA && !byGame.has(game)) added = true
      byGame.set(game, entry)
    }
    if (added) cachedRestrictionCount += 1
  }

  function cacheDelete(accountA: string, accountB: string, game: CoPlayGame): void {
    let removed = false
    for (const [from, to] of [[accountA, accountB], [accountB, accountA]] as const) {
      const byOther = restrictionsByAccount.get(from)
      const byGame = byOther?.get(to)
      if (byGame === undefined || !byGame.delete(game)) continue
      if (from === accountA) removed = true
      if (byGame.size === 0) byOther!.delete(to)
      if (byOther!.size === 0) restrictionsByAccount.delete(from)
    }
    if (removed) cachedRestrictionCount -= 1
  }

  /** Активен запис между акаунтите; изтеклият се маха от кеша при четенето. */
  function getActiveCacheEntry(accountA: string, accountB: string, game: CoPlayGame, nowMs: number): CacheEntry | null {
    const entry = restrictionsByAccount.get(accountA)?.get(accountB)?.get(game)
    if (entry === undefined) return null
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= nowMs) {
      cacheDelete(accountA, accountB, game)
      return null
    }
    return entry
  }

  /** profileId -> accountId (null за бот/гост/несъществуващ). Само при нужда. */
  function resolveAccountId(profileId: string): string | null {
    const memo = accountByProfile.get(profileId)
    if (memo !== undefined) return memo
    const row = selectProfileAccountStatement.get(profileId) as { account_id: string | null; profile_kind: string } | undefined
    const accountId = row !== undefined && row.profile_kind === 'human' && row.account_id !== null ? row.account_id : null
    // Несъществуващ профил не се запомня (може да бъде създаден по-късно).
    if (row !== undefined) {
      if (accountByProfile.size >= PROFILE_ACCOUNT_MEMO_LIMIT) accountByProfile.clear()
      accountByProfile.set(profileId, accountId)
    }
    return accountId
  }

  function loadFromDatabase(): void {
    const setting = selectSettingStatement.get(CO_PLAY_RESTRICTIONS_ENABLED_SETTING_KEY) as
      | { setting_value: string; updated_at: string; updated_by_profile_id: string | null }
      | undefined
    enabled = setting?.setting_value === '1'
    settingsUpdatedAt = setting?.updated_at ?? null
    settingsUpdatedBy = setting?.updated_by_profile_id ?? null

    restrictionsByAccount.clear()
    cachedRestrictionCount = 0
    const nowMs = now()
    const rows = selectOpenRestrictionsStatement.all() as Array<{
      restriction_id: string
      account_low_id: string
      account_high_id: string
      game_scope: string
      expires_at: string | null
    }>
    for (const row of rows) {
      if (!isCoPlayGame(row.game_scope)) continue
      const expiresAtMs = parseIsoMs(row.expires_at)
      if (row.expires_at !== null && (expiresAtMs === null || expiresAtMs <= nowMs)) continue
      cacheSet(row.account_low_id, row.account_high_id, row.game_scope, { restrictionId: row.restriction_id, expiresAtMs })
    }
  }

  function appendAudit(
    restrictionId: string | null,
    action: CoPlayRestrictionAuditAction,
    actorProfileId: string | null,
    createdAt: string,
    details: Record<string, unknown> | null,
  ): void {
    insertAuditStatement.run(randomUUID(), restrictionId, action, actorProfileId, createdAt, details === null ? null : JSON.stringify(details))
  }

  function toView(row: RestrictionRow, nowMs: number): CoPlayRestrictionView {
    return {
      restrictionId: row.restriction_id,
      gameScope: row.game_scope as CoPlayGame,
      status: computeCoPlayRestrictionStatus(row, nowMs),
      profiles: [
        {
          profileId: row.selected_profile_low_id,
          accountId: row.account_low_id,
          displayNameSnapshot: row.selected_profile_low_name_snapshot,
          currentDisplayName: row.low_current_name ?? null,
        },
        {
          profileId: row.selected_profile_high_id,
          accountId: row.account_high_id,
          displayNameSnapshot: row.selected_profile_high_name_snapshot,
          currentDisplayName: row.high_current_name ?? null,
        },
      ],
      reason: row.reason,
      durationDays: row.duration_days,
      isIndefinite: row.duration_days === null,
      createdAt: row.created_at,
      createdByProfileId: row.created_by_profile_id,
      createdByDisplayName: row.created_by_name ?? null,
      expiresAt: row.expires_at,
      endedAt: row.ended_at,
      endKind: row.end_kind,
      liftedByProfileId: row.lifted_by_profile_id,
      liftedByDisplayName: row.lifted_by_name ?? null,
      liftReason: row.lift_reason,
    }
  }

  function getRestriction(restrictionId: string): CoPlayRestrictionView | null {
    const row = selectRestrictionByIdStatement.get(restrictionId) as RestrictionRow | undefined
    return row === undefined ? null : toView(row, now())
  }

  /**
   * Изпълнява fn в BEGIN IMMEDIATE транзакция; кешът се променя от onCommitted
   * САМО след успешен COMMIT. При грешка в onCommitted — пълно презареждане
   * (базата е източникът на истина).
   */
  function runTransaction<T>(fn: () => { result: T; onCommitted?: () => void } | { rollback: T }): T {
    database.exec('BEGIN IMMEDIATE;')
    let outcome: { result: T; onCommitted?: () => void } | { rollback: T }
    try {
      outcome = fn()
      if ('rollback' in outcome) {
        database.exec('ROLLBACK;')
        return outcome.rollback
      }
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch { /* вече затворена */ }
      throw error
    }
    try {
      outcome.onCommitted?.()
    } catch (error) {
      console.error('[co-play] cache update failed; reloading', error instanceof Error ? error.message : String(error))
      loadFromDatabase()
    }
    return outcome.result
  }

  function normalizeReason(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (trimmed.length === 0 || trimmed.length > CO_PLAY_MAX_REASON_LENGTH) return null
    return trimmed
  }

  function imposeRestriction(input: Parameters<CoPlayRestrictionStore['imposeRestriction']>[0]): ImposeCoPlayRestrictionResult {
    const game = input.game ?? 'belot'
    if (!isCoPlayGame(game)) return { ok: false, code: 'invalid_game', message: 'Невалидна игра.' }
    const firstProfileId = typeof input.firstProfileId === 'string' ? input.firstProfileId.trim() : ''
    const secondProfileId = typeof input.secondProfileId === 'string' ? input.secondProfileId.trim() : ''
    if (firstProfileId.length === 0 || secondProfileId.length === 0) {
      return { ok: false, code: 'invalid_profiles', message: 'Изберете два профила.' }
    }
    if (firstProfileId === secondProfileId) {
      return { ok: false, code: 'same_profile', message: 'Изберете два различни профила.' }
    }
    const reason = normalizeReason(input.reason)
    if (reason === null) {
      return { ok: false, code: 'invalid_reason', message: `Причината е задължителна (до ${CO_PLAY_MAX_REASON_LENGTH} знака).` }
    }
    const durationDays = input.durationDays
    if (
      durationDays !== null &&
      (typeof durationDays !== 'number' || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > CO_PLAY_MAX_DURATION_DAYS)
    ) {
      return { ok: false, code: 'invalid_duration', message: `Срокът трябва да е цяло число дни от 1 до ${CO_PLAY_MAX_DURATION_DAYS} или безсрочен.` }
    }

    const first = selectProfileStatement.get(firstProfileId) as
      | { profile_id: string; account_id: string | null; profile_kind: string; display_name: string }
      | undefined
    const second = selectProfileStatement.get(secondProfileId) as typeof first
    if (first === undefined || second === undefined) {
      return { ok: false, code: 'profile_not_found', message: 'Профилът не беше намерен.' }
    }
    if (first.profile_kind !== 'human' || second.profile_kind !== 'human' || first.account_id === null || second.account_id === null) {
      return { ok: false, code: 'profile_not_eligible', message: 'Забрана може да се наложи само между профили на регистрирани акаунти.' }
    }
    if (first.account_id === second.account_id) {
      return { ok: false, code: 'same_account', message: 'Двата профила са от един и същ акаунт.' }
    }

    // Двустранност: двойката е подредена по accountId, независимо от избора.
    const [low, high] = first.account_id < second.account_id ? [first, second] : [second, first]
    const accountLow = low.account_id as string
    const accountHigh = high.account_id as string

    return runTransaction<ImposeCoPlayRestrictionResult>(() => {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const open = selectOpenRestrictionForPairStatement.get(accountLow, accountHigh, game) as
        | { restriction_id: string; expires_at: string | null }
        | undefined
      let closedExpiredId: string | null = null
      if (open !== undefined) {
        const openExpiresAtMs = parseIsoMs(open.expires_at)
        if (open.expires_at === null || (openExpiresAtMs !== null && openExpiresAtMs > nowMs)) {
          return {
            rollback: {
              ok: false,
              code: 'already_restricted',
              message: 'Между тези акаунти вече има активна забрана.',
              existingRestrictionId: open.restriction_id,
            },
          }
        }
        // Изтекла, но незатворена — затваря се като „изтекла“ (историята остава).
        closeExpiredStatement.run(open.restriction_id)
        appendAudit(open.restriction_id, 'close_expired', input.actorProfileId, nowIso, { expiresAt: open.expires_at })
        closedExpiredId = open.restriction_id
      }

      const restrictionId = randomUUID()
      const expiresAtIso = durationDays === null ? null : new Date(nowMs + durationDays * CO_PLAY_MS_PER_DAY).toISOString()
      insertRestrictionStatement.run(
        restrictionId,
        accountLow,
        accountHigh,
        game,
        low.profile_id,
        high.profile_id,
        low.display_name,
        high.display_name,
        reason,
        durationDays,
        nowIso,
        input.actorProfileId,
        expiresAtIso,
      )
      appendAudit(restrictionId, 'impose', input.actorProfileId, nowIso, {
        game,
        selectedProfileIds: [firstProfileId, secondProfileId],
        accountIds: [accountLow, accountHigh],
        reason,
        durationDays,
        expiresAt: expiresAtIso,
        replacedExpiredRestrictionId: closedExpiredId,
      })
      const restriction = getRestriction(restrictionId) as CoPlayRestrictionView
      return {
        result: { ok: true, restriction },
        onCommitted: () => {
          cacheSet(accountLow, accountHigh, game, { restrictionId, expiresAtMs: parseIsoMs(expiresAtIso) })
        },
      }
    })
  }

  function liftRestriction(input: { restrictionId: string; actorProfileId: string; reason?: string | null }): LiftCoPlayRestrictionResult {
    let liftReason: string | null = null
    if (input.reason !== undefined && input.reason !== null) {
      const trimmed = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (trimmed.length > CO_PLAY_MAX_REASON_LENGTH) {
        return { ok: false, code: 'invalid_reason', message: `Причината за отмяна е до ${CO_PLAY_MAX_REASON_LENGTH} знака.` }
      }
      liftReason = trimmed.length > 0 ? trimmed : null
    }

    return runTransaction<LiftCoPlayRestrictionResult>(() => {
      const nowMs = now()
      const nowIso = new Date(nowMs).toISOString()
      const row = selectRestrictionByIdStatement.get(input.restrictionId) as RestrictionRow | undefined
      if (row === undefined) {
        return { rollback: { ok: false, code: 'not_found', message: 'Забраната не беше намерена.' } }
      }
      const status = computeCoPlayRestrictionStatus(row, nowMs)
      if (status !== 'active') {
        return {
          rollback: {
            ok: false,
            code: 'not_active',
            status,
            message: status === 'lifted' ? 'Забраната вече е отменена.' : 'Забраната вече е изтекла.',
          },
        }
      }
      liftStatement.run(nowIso, input.actorProfileId, liftReason, row.restriction_id)
      appendAudit(row.restriction_id, 'lift', input.actorProfileId, nowIso, { reason: liftReason })
      const restriction = getRestriction(row.restriction_id) as CoPlayRestrictionView
      return {
        result: { ok: true, restriction },
        onCommitted: () => {
          if (isCoPlayGame(row.game_scope)) cacheDelete(row.account_low_id, row.account_high_id, row.game_scope)
        },
      }
    })
  }

  function getSettings(): CoPlayRestrictionSettings {
    return { enabled, updatedAt: settingsUpdatedAt, updatedByProfileId: settingsUpdatedBy }
  }

  function setEnabled(input: { enabled: boolean; actorProfileId: string }): { ok: true; changed: boolean; settings: CoPlayRestrictionSettings } {
    const nextEnabled = input.enabled === true
    if (nextEnabled === enabled) return { ok: true, changed: false, settings: getSettings() }
    const previous = enabled
    return runTransaction(() => {
      const nowIso = new Date(now()).toISOString()
      upsertSettingStatement.run(CO_PLAY_RESTRICTIONS_ENABLED_SETTING_KEY, nextEnabled ? '1' : '0', nowIso, input.actorProfileId)
      appendAudit(null, 'settings_update', input.actorProfileId, nowIso, {
        setting: 'CO_PLAY_RESTRICTIONS_ENABLED',
        from: previous,
        to: nextEnabled,
      })
      return {
        result: { ok: true as const, changed: true, settings: { enabled: nextEnabled, updatedAt: nowIso, updatedByProfileId: input.actorProfileId } },
        onCommitted: () => {
          enabled = nextEnabled
          settingsUpdatedAt = nowIso
          settingsUpdatedBy = input.actorProfileId
        },
      }
    })
  }

  function getActiveRestrictionIdBetweenProfiles(profileIdA: string, profileIdB: string, game: CoPlayGame = 'belot'): string | null {
    if (cachedRestrictionCount === 0 || profileIdA === profileIdB) return null
    const accountA = resolveAccountId(profileIdA)
    const accountB = resolveAccountId(profileIdB)
    if (accountA === null || accountB === null || accountA === accountB) return null
    return getActiveCacheEntry(accountA, accountB, game, now())?.restrictionId ?? null
  }

  function isEnforcementActive(): boolean {
    return enabled && cachedRestrictionCount > 0
  }

  function getEnforcedRestrictionIdBetweenAccounts(
    accountIdA: string | null | undefined,
    accountIdB: string | null | undefined,
    game: CoPlayGame = 'belot',
  ): string | null {
    if (!enabled || cachedRestrictionCount === 0) return null
    if (typeof accountIdA !== 'string' || typeof accountIdB !== 'string' || accountIdA === accountIdB) return null
    return getActiveCacheEntry(accountIdA, accountIdB, game, now())?.restrictionId ?? null
  }

  function recordEnforcementAudit(input: { restrictionId: string | null; actorProfileId: string | null; details: Record<string, unknown> }): void {
    appendAudit(input.restrictionId, 'enforcement_removed', input.actorProfileId, new Date(now()).toISOString(), input.details)
  }

  function isRestrictedBetweenProfiles(profileIdA: string, profileIdB: string, game: CoPlayGame = 'belot'): boolean {
    if (!enabled) return false
    return getActiveRestrictionIdBetweenProfiles(profileIdA, profileIdB, game) !== null
  }

  function findRestrictedProfileIds(profileId: string, otherProfileIds: readonly string[], game: CoPlayGame = 'belot'): string[] {
    if (!enabled || cachedRestrictionCount === 0 || otherProfileIds.length === 0) return []
    const account = resolveAccountId(profileId)
    if (account === null || !restrictionsByAccount.has(account)) return []
    const nowMs = now()
    const restricted: string[] = []
    for (const otherProfileId of otherProfileIds) {
      if (otherProfileId === profileId) continue
      const otherAccount = resolveAccountId(otherProfileId)
      if (otherAccount === null || otherAccount === account) continue
      if (getActiveCacheEntry(account, otherAccount, game, nowMs) !== null) restricted.push(otherProfileId)
    }
    return restricted
  }

  function clampLimit(value: number | undefined, fallback: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback
    return Math.min(value, max)
  }
  function clampOffset(value: number | undefined): number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
  }

  function listRestrictions(input: ListCoPlayRestrictionsInput): { items: CoPlayRestrictionView[]; total: number } {
    const nowMs = now()
    const nowIso = new Date(nowMs).toISOString()
    const status = input.status ?? 'all'
    const where: string[] = []
    const params: Array<string | number> = []
    if (status === 'active') {
      where.push('r.ended_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > ?)')
      params.push(nowIso)
    } else if (status === 'expired') {
      where.push("(r.end_kind = 'expired' OR (r.ended_at IS NULL AND r.expires_at IS NOT NULL AND r.expires_at <= ?))")
      params.push(nowIso)
    } else if (status === 'lifted') {
      where.push("r.end_kind = 'lifted'")
    }
    const query = typeof input.profileQuery === 'string' ? input.profileQuery.trim() : ''
    if (query.length > 0) {
      const term = normalizeProfileSearchTerm(query)
      const accounts = (searchProfileAccountsStatement.all(query, `%${escapeSqlLikePattern(term)}%`) as Array<{ account_id: string }>)
        .map((row) => row.account_id)
      if (accounts.length === 0) return { items: [], total: 0 }
      const placeholders = accounts.map(() => '?').join(', ')
      where.push(`(r.account_low_id IN (${placeholders}) OR r.account_high_id IN (${placeholders}))`)
      params.push(...accounts, ...accounts)
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
    const total = (database.prepare(`SELECT COUNT(*) AS n FROM co_play_restrictions r ${whereSql};`).get(...params) as { n: number }).n
    const limit = clampLimit(input.limit, 50, 200)
    const offset = clampOffset(input.offset)
    const rows = database.prepare(`
      SELECT ${RESTRICTION_COLUMNS} FROM co_play_restrictions r ${RESTRICTION_JOINS}
      ${whereSql}
      ORDER BY r.created_at DESC, r.restriction_id DESC
      LIMIT ? OFFSET ?;
    `).all(...params, limit, offset) as RestrictionRow[]
    return { items: rows.map((row) => toView(row, nowMs)), total }
  }

  function listAudit(input: { restrictionId?: string | null; limit?: number; offset?: number }): { items: CoPlayRestrictionAuditView[]; total: number } {
    const restrictionId = typeof input.restrictionId === 'string' && input.restrictionId.length > 0 ? input.restrictionId : null
    const whereSql = restrictionId === null ? '' : 'WHERE a.restriction_id = ?'
    const params: Array<string | number> = restrictionId === null ? [] : [restrictionId]
    const total = (database.prepare(`SELECT COUNT(*) AS n FROM co_play_restriction_audit a ${whereSql};`).get(...params) as { n: number }).n
    const rows = database.prepare(`
      SELECT a.audit_id, a.restriction_id, a.action, a.actor_profile_id, a.created_at, a.details_json, p.display_name AS actor_name
      FROM co_play_restriction_audit a
      LEFT JOIN profiles p ON p.profile_id = a.actor_profile_id
      ${whereSql}
      ORDER BY a.created_at DESC, a.rowid DESC
      LIMIT ? OFFSET ?;
    `).all(...params, clampLimit(input.limit, 100, 500), clampOffset(input.offset)) as Array<{
      audit_id: string
      restriction_id: string | null
      action: CoPlayRestrictionAuditAction
      actor_profile_id: string | null
      created_at: string
      details_json: string | null
      actor_name: string | null
    }>
    return {
      total,
      items: rows.map((row) => {
        let details: Record<string, unknown> | null = null
        if (row.details_json !== null) {
          try { details = JSON.parse(row.details_json) as Record<string, unknown> } catch { details = null }
        }
        return {
          auditId: row.audit_id,
          restrictionId: row.restriction_id,
          action: row.action,
          actorProfileId: row.actor_profile_id,
          actorDisplayName: row.actor_name,
          createdAt: row.created_at,
          details,
        }
      }),
    }
  }

  loadFromDatabase()

  return {
    isEnabled: () => enabled,
    getSettings,
    setEnabled,
    isRestrictedBetweenProfiles,
    findRestrictedProfileIds,
    getActiveRestrictionIdBetweenProfiles,
    isEnforcementActive,
    getEnforcedRestrictionIdBetweenAccounts,
    recordEnforcementAudit,
    imposeRestriction,
    liftRestriction,
    getRestriction,
    listRestrictions,
    listAudit,
    reload: loadFromDatabase,
    getCachedRestrictionCount: () => cachedRestrictionCount,
    close: () => database.close(),
  }
}

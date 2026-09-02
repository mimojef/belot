import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type ActiveProfileBan = {
  banId: string
  profileId: ProfileId
  bannedAt: string
  bannedUntil: string
  reason: string
  bannedByProfileId: ProfileId | null
  remainingDays: number
}

export type BanProfileErrorCode = 'not_found' | 'self' | 'already_banned' | 'invalid_days' | 'invalid_reason'
export type UnbanProfileErrorCode = 'not_found' | 'no_active_ban'

export type BanProfileResult =
  | { ok: true; ban: ActiveProfileBan }
  | { ok: false; code: BanProfileErrorCode; message: string }

export type UnbanProfileResult =
  | { ok: true }
  | { ok: false; code: UnbanProfileErrorCode; message: string }

export type ProfileBanStore = {
  /**
   * Активен бан за профил — последният (по created_at) ред с lifted_at IS
   * NULL И banned_until > CURRENT_TIMESTAMP. Изчислено at query time (без
   * cron) — изтекъл бан просто спира да се връща тук, историята му остава
   * в profile_bans непокътната.
   */
  getActiveBan: (profileId: ProfileId) => ActiveProfileBan | null
  banProfile: (input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    days: number
    reason: string
  }) => BanProfileResult
  unbanProfile: (input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
  }) => UnbanProfileResult
  close: () => void
}

const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_BAN_DAYS = 3650

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

function computeRemainingDays(bannedUntilIso: string, nowMs: number): number {
  const untilMs = new Date(bannedUntilIso).getTime()
  if (!Number.isFinite(untilMs)) return 0
  return Math.max(0, Math.ceil((untilMs - nowMs) / MS_PER_DAY))
}

export async function createProfileBanStore(databaseFilePath: string): Promise<ProfileBanStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectProfileExistsStatement = database.prepare(`
    SELECT profile_id FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  // "Активен" бан = последният ред (MAX created_at), lifted_at IS NULL, и
  // banned_until все още в бъдещето — изчислено срещу CURRENT_TIMESTAMP на
  // самата SQLite база (същия clock, който banned_at/created_at ползват),
  // не срещу Date.now() на Node процеса, за да няма clock skew разминаване.
  const selectActiveBanStatement = database.prepare(`
    SELECT ban_id, profile_id, banned_at, banned_until, reason, banned_by_profile_id
    FROM profile_bans
    WHERE profile_id = ?
      AND lifted_at IS NULL
      AND banned_until > CURRENT_TIMESTAMP
    ORDER BY banned_at DESC
    LIMIT 1;
  `)

  const insertBanStatement = database.prepare(`
    INSERT INTO profile_bans (
      ban_id, profile_id, banned_until, reason, banned_by_profile_id
    ) VALUES (?, ?, ?, ?, ?);
  `)

  const selectBanByIdStatement = database.prepare(`
    SELECT ban_id, profile_id, banned_at, banned_until, reason, banned_by_profile_id
    FROM profile_bans
    WHERE ban_id = ?
    LIMIT 1;
  `)

  const liftBanStatement = database.prepare(`
    UPDATE profile_bans
    SET lifted_at = CURRENT_TIMESTAMP, lifted_by_profile_id = ?
    WHERE ban_id = ?
      AND lifted_at IS NULL;
  `)

  function toActiveBan(row: {
    ban_id: string
    profile_id: string
    banned_at: string
    banned_until: string
    reason: string
    banned_by_profile_id: string | null
  }): ActiveProfileBan {
    return {
      banId: row.ban_id,
      profileId: row.profile_id,
      bannedAt: dbDateToUtc(row.banned_at),
      bannedUntil: dbDateToUtc(row.banned_until),
      reason: row.reason,
      bannedByProfileId: row.banned_by_profile_id,
      remainingDays: computeRemainingDays(dbDateToUtc(row.banned_until), Date.now()),
    }
  }

  function getActiveBan(profileId: ProfileId): ActiveProfileBan | null {
    const row = selectActiveBanStatement.get(profileId) as
      | {
          ban_id: string
          profile_id: string
          banned_at: string
          banned_until: string
          reason: string
          banned_by_profile_id: string | null
        }
      | undefined
    return row === undefined ? null : toActiveBan(row)
  }

  function banProfile(input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
    days: number
    reason: string
  }): BanProfileResult {
    if (input.targetProfileId === input.actorProfileId) {
      return { ok: false, code: 'self', message: 'Не можеш да банваш себе си.' }
    }

    if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_BAN_DAYS) {
      return { ok: false, code: 'invalid_days', message: `Срокът трябва да е цяло число между 1 и ${MAX_BAN_DAYS} дни.` }
    }

    const reason = input.reason.trim()
    if (reason.length === 0 || reason.length > 2000) {
      return { ok: false, code: 'invalid_reason', message: 'Причината е задължителна (до 2000 символа).' }
    }

    const profileRow = selectProfileExistsStatement.get(input.targetProfileId) as { profile_id: string } | undefined
    if (profileRow === undefined) {
      return { ok: false, code: 'not_found', message: 'Профилът не беше намерен.' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      // Re-check вътре в транзакцията — race-safe спрямо конкурентен
      // повторен ban опит. Явен, ясен behavior (spec §11 "already banned"):
      // отказваме нов ban, докато вече има активен — admin трябва първо да
      // UNBAN-не, за да промени срок/причина (никакъв тих overwrite).
      const existingActive = selectActiveBanStatement.get(input.targetProfileId) as
        | { ban_id: string }
        | undefined
      if (existingActive !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_banned', message: 'Профилът вече има активен бан.' }
      }

      const banId = randomUUID()
      const bannedUntil = toSqliteDateTimeString(new Date(Date.now() + input.days * MS_PER_DAY))
      insertBanStatement.run(banId, input.targetProfileId, bannedUntil, reason, input.actorProfileId)
      database.exec('COMMIT;')

      const row = selectBanByIdStatement.get(banId) as {
        ban_id: string
        profile_id: string
        banned_at: string
        banned_until: string
        reason: string
        banned_by_profile_id: string | null
      }
      return { ok: true, ban: toActiveBan(row) }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      throw error
    }
  }

  function unbanProfile(input: {
    targetProfileId: ProfileId
    actorProfileId: ProfileId
  }): UnbanProfileResult {
    const profileRow = selectProfileExistsStatement.get(input.targetProfileId) as { profile_id: string } | undefined
    if (profileRow === undefined) {
      return { ok: false, code: 'not_found', message: 'Профилът не беше намерен.' }
    }

    database.exec('BEGIN IMMEDIATE;')
    try {
      const activeBan = selectActiveBanStatement.get(input.targetProfileId) as { ban_id: string } | undefined
      if (activeBan === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'no_active_ban', message: 'Профилът няма активен бан.' }
      }

      const changeResult = liftBanStatement.run(input.actorProfileId, activeBan.ban_id)
      if (changeResult.changes === 0) {
        // Race — вдигнат е междувременно от друга заявка. Идемпотентно ok:true.
        database.exec('ROLLBACK;')
        return { ok: true }
      }

      database.exec('COMMIT;')
      return { ok: true }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      throw error
    }
  }

  function close(): void {
    database.close()
  }

  return {
    getActiveBan,
    banProfile,
    unbanProfile,
    close,
  }
}

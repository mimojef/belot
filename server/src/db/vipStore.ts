import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type VipGrantReason = 'launch_gift' | 'purchase' | 'admin_grant'

export type VipIntervalUnit = 'days' | 'months' | 'years'

/**
 * Календарен период, не преизчислени дни — "6 месеца" трябва да остане
 * "6 календарни месеца", не фиксирано приближение "180 дни" (месеците имат
 * различна дължина, годините имат високосни дни). Платените VIP планове
 * (1/6/12 месеца) се изразяват директно в тези единици, не се конвертират
 * в дни никъде по пътя. Месечно/годишно добавяне ползва subscription-style
 * clamp semantics — виж addCalendarInterval по-долу.
 */
export type VipInterval = {
  unit: VipIntervalUnit
  amount: number
}

export type VipStatusSnapshot = {
  isActive: boolean
  activeUntil: string | null
}

export type ClaimLaunchGiftResult =
  | { ok: true; status: VipStatusSnapshot }
  | { ok: false; code: 'already_claimed'; status: VipStatusSnapshot }

export type VipStore = {
  getStatus: (profileId: ProfileId) => VipStatusSnapshot
  hasClaimedLaunchGift: (profileId: ProfileId) => boolean
  claimLaunchGift: (profileId: ProfileId, interval: VipInterval) => ClaimLaunchGiftResult
  /**
   * grantedByProfileId — admin-a, извършващ grant-а (audit trail в
   * vip_grants.granted_by_profile_id). Null за self-service grants
   * (launch_gift/purchase) — само admin_grant подава реален actor.
   */
  grantVip: (
    profileId: ProfileId,
    reason: VipGrantReason,
    interval: VipInterval,
    grantedByProfileId?: ProfileId | null,
  ) => VipStatusSnapshot
  close: () => void
}

type VipStatusRow = {
  active_until: string
}

function toStatusSnapshot(row: VipStatusRow | undefined, now: Date): VipStatusSnapshot {
  if (!row) {
    return { isActive: false, activeUntil: null }
  }

  const activeUntilIso = dbDateToUtc(row.active_until)
  return {
    isActive: new Date(activeUntilIso).getTime() > now.getTime(),
    activeUntil: activeUntilIso,
  }
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, monthIndex0: number): number {
  if (monthIndex0 === 1 && isLeapYear(year)) {
    return 29
  }
  return DAYS_IN_MONTH[monthIndex0]
}

/**
 * Добавя календарен период към `base` (UTC) със subscription-style clamp
 * semantics — деня се "clamp"-ва към последния валиден ден на целевия
 * месец, ако оригиналният ден не съществува там. Час/минута/секунда се
 * запазват точно. Не разчита на SQLite `datetime(x, '+N months')`, чието
 * поведение при month rollover е overflow в следващия месец, не clamp
 * (напр. SQLite дава 2026-01-31 + 1 month => 2026-03-03, не 2026-02-28).
 *
 * Примери:
 *   2026-01-31 + 1 month  => 2026-02-28 (non-leap February clamp)
 *   2028-01-31 + 1 month  => 2028-02-29 (leap February clamp)
 *   2028-02-29 + 1 year   => 2029-02-28 (Feb 29 не съществува в 2029)
 *   2026-08-31 + 6 months => 2027-02-28
 *   days: чисто UTC-millisecond добавяне, не е засегнато от clamp логиката.
 */
export function addCalendarInterval(base: Date, interval: VipInterval): Date {
  if (interval.unit === 'days') {
    return new Date(base.getTime() + interval.amount * 24 * 60 * 60 * 1000)
  }

  const totalMonthsToAdd = interval.unit === 'years' ? interval.amount * 12 : interval.amount

  const year = base.getUTCFullYear()
  const month = base.getUTCMonth()
  const day = base.getUTCDate()

  const targetMonthIndex = month + totalMonthsToAdd
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12

  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth))

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    clampedDay,
    base.getUTCHours(),
    base.getUTCMinutes(),
    base.getUTCSeconds(),
    base.getUTCMilliseconds(),
  ))
}

function toSqliteDateTimeString(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

export async function createVipStore(databaseFilePath: string): Promise<VipStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectStatusStatement = database.prepare(`
    SELECT active_until FROM vip_status WHERE profile_id = ? LIMIT 1;
  `)

  const selectLaunchGiftGrantStatement = database.prepare(`
    SELECT grant_id FROM vip_grants WHERE profile_id = ? AND reason = 'launch_gift' LIMIT 1;
  `)

  const insertGrantStatement = database.prepare(`
    INSERT INTO vip_grants (
      grant_id, profile_id, reason, interval_unit, interval_amount,
      granted_by_profile_id, resulting_active_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?);
  `)

  const upsertStatusStatement = database.prepare(`
    INSERT INTO vip_status (profile_id, active_until, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id) DO UPDATE SET
      active_until = excluded.active_until,
      updated_at = CURRENT_TIMESTAMP;
  `)

  function getStatus(profileId: ProfileId): VipStatusSnapshot {
    const row = selectStatusStatement.get(profileId) as VipStatusRow | undefined
    return toStatusSnapshot(row, new Date())
  }

  function hasClaimedLaunchGift(profileId: ProfileId): boolean {
    return selectLaunchGiftGrantStatement.get(profileId) !== undefined
  }

  function applyGrant(
    profileId: ProfileId,
    reason: VipGrantReason,
    interval: VipInterval,
    grantedByProfileId: ProfileId | null,
  ): void {
    // Текущият active_until (ако е в бъдещето) е базата за удължаване; ако
    // вече е изтекъл или липсва, новият период тръгва от сега. Изчислението
    // на новата дата е чист JS (addCalendarInterval), не SQL datetime()
    // modifier — така гарантираме subscription-style clamp semantics,
    // независимо от SQLite версия/поведение. Всичко остава в същата
    // BEGIN IMMEDIATE транзакция, отворена от повикващата функция.
    const currentRow = selectStatusStatement.get(profileId) as VipStatusRow | undefined
    const now = new Date()
    const currentActiveUntil = currentRow ? new Date(dbDateToUtc(currentRow.active_until)) : null
    const extensionBase = currentActiveUntil && currentActiveUntil.getTime() > now.getTime()
      ? currentActiveUntil
      : now

    const newActiveUntil = addCalendarInterval(extensionBase, interval)
    const newActiveUntilSqlite = toSqliteDateTimeString(newActiveUntil)

    // resulting_active_until се пази директно на grant реда — audit trail-ът
    // трябва да знае ТОЧНО какъв active_until е произвел всеки конкретен
    // grant, без крехък replay на историята (vip_status се презаписва).
    const grantId = randomUUID()
    insertGrantStatement.run(
      grantId,
      profileId,
      reason,
      interval.unit,
      interval.amount,
      grantedByProfileId,
      newActiveUntilSqlite,
    )

    upsertStatusStatement.run(profileId, newActiveUntilSqlite)
  }

  function claimLaunchGift(profileId: ProfileId, interval: VipInterval): ClaimLaunchGiftResult {
    try {
      database.exec('BEGIN IMMEDIATE;')

      if (selectLaunchGiftGrantStatement.get(profileId) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'already_claimed', status: getStatus(profileId) }
      }

      applyGrant(profileId, 'launch_gift', interval, null)

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }

      // Partial unique index (idx_vip_grants_launch_gift_once) хваща и concurrent
      // double-submit заявки, стигнали едновременно до INSERT — SQLITE_CONSTRAINT тук.
      return { ok: false, code: 'already_claimed', status: getStatus(profileId) }
    }

    return { ok: true, status: getStatus(profileId) }
  }

  function grantVip(
    profileId: ProfileId,
    reason: VipGrantReason,
    interval: VipInterval,
    grantedByProfileId: ProfileId | null = null,
  ): VipStatusSnapshot {
    database.exec('BEGIN IMMEDIATE;')
    try {
      applyGrant(profileId, reason, interval, grantedByProfileId)
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      throw error
    }

    return getStatus(profileId)
  }

  function close(): void {
    database.close()
  }

  return {
    getStatus,
    hasClaimedLaunchGift,
    claimLaunchGift,
    grantVip,
    close,
  }
}

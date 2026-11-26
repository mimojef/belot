// Етап 4В: match_rooms е ЕДИНСТВЕНИЯТ общ каталог на входовете за всички
// игри (Белот, „Свара“, „Не се сърди човече“ и бъдещите): вход, минимално
// ниво, активност и обща комисиона (site_commission_bps). Наградите се
// изчисляват от общата формула (prizeFormula.ts) по схемата на всяка игра.
// prize_amount вече НЕ е финансово правило: пази ръчната (legacy) награда
// само за маси, създадени преди Етап 4В (boot-backfill / исторически път).

import { BELOT_PAID_ENTRIES, computeBelotPrizePerWinner } from '../economy/belotFinancialTerms.js'
import { checkCommissionBpsPolicy } from '../economy/entryLevelPolicy.js'
import { DEFAULT_SITE_COMMISSION_BPS } from '../economy/prizeFormula.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type MatchRoomSnapshot = {
  stakeAmount: number
  minLevel: number
  /** Наградата за всеки победител в Белот — изчислена по формулата (0 — неизчислима). */
  prizeAmount: number
  isEnabled: boolean
  /** Етап 4В: общата комисиона на входа за всички игри (bps, 1000–5000). */
  siteCommissionBps: number
}

export type MatchRoomsStore = {
  listRooms: () => MatchRoomSnapshot[]
  getRoom: (stakeAmount: number) => MatchRoomSnapshot | null
  upsertRoom: (input: {
    stakeAmount: number
    minLevel: number
    isEnabled: boolean
    /** undefined — без промяна (нов вход → 20%); null — 20% по подразбиране. */
    siteCommissionBps?: number | null
  }) => { ok: true; room: MatchRoomSnapshot } | { ok: false; message: string }
  deleteRoom: (stakeAmount: number) => boolean
  /** Наградата за победител в Белот по формулата (null — няма вход / неизчислима). */
  getPrizeAmount: (stakeAmount: number) => number | null
  /** Условия за фиксиране на нова Белот маса (формула + комисиона). */
  getBelotPrizeTerms: (stakeAmount: number) => { prizePerWinner: number; siteCommissionBps: number } | null
  /** Ръчната (legacy) prize_amount — САМО за маси отпреди Етап 4В. */
  getLegacyPrizeAmount: (stakeAmount: number) => number | null
  /**
   * Етап 3А: суровата стойност на match_rooms.site_commission_bps по вход —
   * САМО за общия информационен каталог. Липсващ ключ = NULL (не е
   * конфигурирана). Не участва в изплащанията. Валидацията е в каталога.
   */
  getSiteCommissionBpsByStake: () => ReadonlyMap<number, unknown>
  getEnabledStakes: () => number[]
  reload: () => void
}

type MatchRoomRow = {
  stake_amount: number
  min_level: number
  prize_amount: number
  is_enabled: number
}

/** NULL (база без миграция 20261126_005) → 20%; невалидна стойност → null (входът е неизползваем). */
function effectiveCommissionBps(raw: unknown): number | null {
  if (raw === undefined || raw === null) return DEFAULT_SITE_COMMISSION_BPS
  return checkCommissionBpsPolicy(raw).length === 0 ? raw as number : null
}

function rowToSnapshot(row: MatchRoomRow & { site_commission_bps?: unknown }): MatchRoomSnapshot {
  const bps = effectiveCommissionBps(row.site_commission_bps)
  const prize = bps === null ? null : computeBelotPrizePerWinner(row.stake_amount, bps)
  return {
    stakeAmount: row.stake_amount,
    minLevel: row.min_level,
    prizeAmount: prize ?? 0,
    // Невалидна комисиона / неизчислима награда → входът не се предлага (fail-closed).
    isEnabled: row.is_enabled === 1 && prize !== null,
    siteCommissionBps: bps ?? DEFAULT_SITE_COMMISSION_BPS,
  }
}

export async function createMatchRoomsStore(databaseFilePath: string): Promise<MatchRoomsStore> {
  const sqliteModule = await import('node:sqlite')
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  db.exec('PRAGMA journal_mode = WAL;')

  // In-memory cache — reloaded on every write
  let cache: MatchRoomSnapshot[] = []
  let legacyPrizeByStake: ReadonlyMap<number, number> = new Map()
  let commissionByStake: ReadonlyMap<number, unknown> = new Map()

  // Колоната идва от миграция 20261126_001; при база без нея (стари тестови
  // схеми) store-ът работи както преди и всички комисиони са NULL.
  function hasSiteCommissionColumn(): boolean {
    const columns = db.prepare(`PRAGMA table_info(match_rooms)`).all() as Array<{ name: string }>
    return columns.some((column) => column.name === 'site_commission_bps')
  }

  function loadCache(): void {
    const withCommission = hasSiteCommissionColumn()
    const rows = db.prepare(
      `SELECT stake_amount, min_level, prize_amount, is_enabled${withCommission ? ', site_commission_bps' : ''}
       FROM match_rooms
       ORDER BY stake_amount ASC`,
    ).all() as Array<MatchRoomRow & { site_commission_bps?: unknown }>
    cache = rows.map(rowToSnapshot)
    legacyPrizeByStake = new Map(rows.map((row) => [row.stake_amount, row.prize_amount]))
    const commissions = new Map<number, unknown>()
    for (const row of rows) {
      if (row.site_commission_bps !== undefined && row.site_commission_bps !== null) {
        commissions.set(row.stake_amount, row.site_commission_bps)
      }
    }
    commissionByStake = commissions
  }

  loadCache()

  function listRooms(): MatchRoomSnapshot[] {
    return cache
  }

  function getRoom(stakeAmount: number): MatchRoomSnapshot | null {
    return cache.find((r) => r.stakeAmount === stakeAmount) ?? null
  }

  function getPrizeAmount(stakeAmount: number): number | null {
    const prize = getRoom(stakeAmount)?.prizeAmount ?? 0
    return prize > 0 ? prize : null
  }

  function getBelotPrizeTerms(stakeAmount: number): { prizePerWinner: number; siteCommissionBps: number } | null {
    const room = getRoom(stakeAmount)
    if (!room || room.prizeAmount <= 0) return null
    return { prizePerWinner: room.prizeAmount, siteCommissionBps: room.siteCommissionBps }
  }

  function getEnabledStakes(): number[] {
    return cache.filter((r) => r.isEnabled).map((r) => r.stakeAmount)
  }

  function upsertRoom(input: {
    stakeAmount: number
    minLevel: number
    isEnabled: boolean
    siteCommissionBps?: number | null
  }): { ok: true; room: MatchRoomSnapshot } | { ok: false; message: string } {
    if (!Number.isInteger(input.stakeAmount) || input.stakeAmount < 1) {
      return { ok: false, message: 'Залогът трябва да е цяло положително число.' }
    }
    if (!Number.isInteger(input.minLevel) || input.minLevel < 1) {
      return { ok: false, message: 'Минималното ниво трябва да е поне 1.' }
    }
    const existing = getRoom(input.stakeAmount)
    const bps = input.siteCommissionBps === undefined
      ? (existing?.siteCommissionBps ?? DEFAULT_SITE_COMMISSION_BPS)
      : (input.siteCommissionBps ?? DEFAULT_SITE_COMMISSION_BPS)
    if (checkCommissionBpsPolicy(bps).length > 0) {
      return { ok: false, message: 'Комисионата трябва да е между 10% и 50%.' }
    }
    // База без колоната (стара тестова схема) → само комисионата по подразбиране.
    const withCommission = hasSiteCommissionColumn()
    if (!withCommission && bps !== DEFAULT_SITE_COMMISSION_BPS) {
      return { ok: false, message: 'Комисионата не може да се запише (липсва колона).' }
    }
    const belotPrize = computeBelotPrizePerWinner(input.stakeAmount, bps)
    if (belotPrize === null) {
      return { ok: false, message: `Наградата не може да се изчисли за вход ${input.stakeAmount} (${BELOT_PAID_ENTRIES} играчи).` }
    }

    try {
      db.exec('BEGIN IMMEDIATE;')
      // prize_amount: за нов вход — изчислената награда (NOT NULL колона);
      // за съществуващ — НЕ се пипа (legacy стойност за маси отпреди Етап 4В).
      if (withCommission) {
        db.prepare(
          `INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, site_commission_bps, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(stake_amount) DO UPDATE SET
             min_level           = excluded.min_level,
             is_enabled          = excluded.is_enabled,
             site_commission_bps = excluded.site_commission_bps,
             updated_at          = CURRENT_TIMESTAMP`,
        ).run(input.stakeAmount, input.minLevel, belotPrize, input.isEnabled ? 1 : 0, bps)
      } else {
        db.prepare(
          `INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, updated_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(stake_amount) DO UPDATE SET
             min_level  = excluded.min_level,
             is_enabled = excluded.is_enabled,
             updated_at = CURRENT_TIMESTAMP`,
        ).run(input.stakeAmount, input.minLevel, belotPrize, input.isEnabled ? 1 : 0)
      }
      db.exec('COMMIT;')

      loadCache()
      const room = getRoom(input.stakeAmount)!
      return { ok: true, room }
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch { /* няма активна транзакция */ }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
  }

  function deleteRoom(stakeAmount: number): boolean {
    const result = db.prepare(`DELETE FROM match_rooms WHERE stake_amount = ?`).run(stakeAmount)
    loadCache()
    return (result.changes as number) > 0
  }

  function reload(): void {
    loadCache()
  }

  return {
    listRooms,
    getRoom,
    upsertRoom,
    deleteRoom,
    getPrizeAmount,
    getBelotPrizeTerms,
    getLegacyPrizeAmount: (stakeAmount) => legacyPrizeByStake.get(stakeAmount) ?? null,
    getSiteCommissionBpsByStake: () => commissionByStake,
    getEnabledStakes,
    reload,
  }
}

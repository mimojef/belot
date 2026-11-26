import { randomUUID } from 'node:crypto'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type MatchRoomSnapshot = {
  stakeAmount: number
  minLevel: number
  prizeAmount: number
  isEnabled: boolean
}

export type MatchRoomsStore = {
  listRooms: () => MatchRoomSnapshot[]
  getRoom: (stakeAmount: number) => MatchRoomSnapshot | null
  upsertRoom: (input: {
    stakeAmount: number
    minLevel: number
    prizeAmount: number
    isEnabled: boolean
  }) => { ok: true; room: MatchRoomSnapshot } | { ok: false; message: string }
  deleteRoom: (stakeAmount: number) => boolean
  getPrizeAmount: (stakeAmount: number) => number | null
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

function rowToSnapshot(row: MatchRoomRow): MatchRoomSnapshot {
  return {
    stakeAmount: row.stake_amount,
    minLevel: row.min_level,
    prizeAmount: row.prize_amount,
    isEnabled: row.is_enabled === 1,
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
    return getRoom(stakeAmount)?.prizeAmount ?? null
  }

  function getEnabledStakes(): number[] {
    return cache.filter((r) => r.isEnabled).map((r) => r.stakeAmount)
  }

  function upsertRoom(input: {
    stakeAmount: number
    minLevel: number
    prizeAmount: number
    isEnabled: boolean
  }): { ok: true; room: MatchRoomSnapshot } | { ok: false; message: string } {
    if (!Number.isInteger(input.stakeAmount) || input.stakeAmount < 1) {
      return { ok: false, message: 'Залогът трябва да е цяло положително число.' }
    }
    if (!Number.isInteger(input.minLevel) || input.minLevel < 1) {
      return { ok: false, message: 'Минималното ниво трябва да е поне 1.' }
    }
    if (!Number.isInteger(input.prizeAmount) || input.prizeAmount < 1) {
      return { ok: false, message: 'Наградата трябва да е цяло положително число.' }
    }

    try {
      db.prepare(
        `INSERT INTO match_rooms (stake_amount, min_level, prize_amount, is_enabled, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(stake_amount) DO UPDATE SET
           min_level    = excluded.min_level,
           prize_amount = excluded.prize_amount,
           is_enabled   = excluded.is_enabled,
           updated_at   = CURRENT_TIMESTAMP`,
      ).run(
        input.stakeAmount,
        input.minLevel,
        input.prizeAmount,
        input.isEnabled ? 1 : 0,
      )

      loadCache()
      const room = getRoom(input.stakeAmount)!
      return { ok: true, room }
    } catch (error) {
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
    getSiteCommissionBpsByStake: () => commissionByStake,
    getEnabledStakes,
    reload,
  }
}

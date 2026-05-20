import { randomUUID } from 'node:crypto'
import type { PlayerPublicProfileSnapshot, ProfileId } from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TableExitPenaltySnapshot = {
  penaltyId: string
  roomId: string
  profileId: ProfileId
  stakeAmount: number
  penaltyAmount: number
  chargedAmount: number
  balanceAfter: number
  createdAt: string
}

export type TableExitPenaltyStore = {
  applyPenalty: (
    profileId: ProfileId,
    roomId: string,
    stakeAmount: number,
  ) =>
    | {
        ok: true
        penalty: TableExitPenaltySnapshot
        profile: PlayerPublicProfileSnapshot | null
      }
    | { ok: false; message: string }
  close: () => void
}

type WalletRow = {
  yellow_coins_balance: number
}

type PenaltyRow = {
  penalty_id: string
  room_id: string
  profile_id: string
  stake_amount: number
  penalty_amount: number
  charged_amount: number
  balance_after: number
  created_at: string
}

function toPenaltySnapshot(row: PenaltyRow): TableExitPenaltySnapshot {
  return {
    penaltyId: row.penalty_id,
    roomId: row.room_id,
    profileId: row.profile_id,
    stakeAmount: row.stake_amount,
    penaltyAmount: row.penalty_amount,
    chargedAmount: row.charged_amount,
    balanceAfter: row.balance_after,
    createdAt: dbDateToUtc(row.created_at),
  }
}

export async function createTableExitPenaltyStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<TableExitPenaltyStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      0
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const selectWalletStatement = database.prepare(`
    SELECT yellow_coins_balance
    FROM profile_wallets
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const debitWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance - ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND yellow_coins_balance >= ?;
  `)

  const insertPenaltyStatement = database.prepare(`
    INSERT INTO table_exit_penalties (
      penalty_id,
      room_id,
      profile_id,
      stake_amount,
      penalty_amount,
      charged_amount,
      balance_after
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
    ON CONFLICT(room_id, profile_id) DO NOTHING;
  `)

  const selectPenaltyStatement = database.prepare(`
    SELECT
      penalty_id,
      room_id,
      profile_id,
      stake_amount,
      penalty_amount,
      charged_amount,
      balance_after,
      created_at
    FROM table_exit_penalties
    WHERE room_id = ?
      AND profile_id = ?
    LIMIT 1;
  `)

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as WalletRow | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function applyPenalty(
    profileId: ProfileId,
    roomId: string,
    stakeAmountRaw: number,
  ):
    | {
        ok: true
        penalty: TableExitPenaltySnapshot
        profile: PlayerPublicProfileSnapshot | null
      }
    | { ok: false; message: string } {
    if (!Number.isInteger(stakeAmountRaw) || stakeAmountRaw <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за санкция при напускане.',
      }
    }

    const penaltyAmount = stakeAmountRaw
    const penaltyId = randomUUID()

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)

      const existingPenalty = selectPenaltyStatement.get(
        roomId,
        profileId,
      ) as PenaltyRow | undefined

      if (existingPenalty) {
        database.exec('COMMIT;')

        return {
          ok: true,
          penalty: toPenaltySnapshot(existingPenalty),
          profile: playerProgressStore.getPublicProfile(profileId),
        }
      }

      const currentBalance = getWalletBalance(profileId)
      const chargedAmount = Math.min(currentBalance, penaltyAmount)

      if (chargedAmount > 0) {
        const debitResult = debitWalletStatement.run(
          chargedAmount,
          profileId,
          chargedAmount,
        ) as { changes?: number }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return {
            ok: false,
            message: 'Санкцията при напускане не беше начислена.',
          }
        }
      }

      const balanceAfter = getWalletBalance(profileId)

      insertPenaltyStatement.run(
        penaltyId,
        roomId,
        profileId,
        stakeAmountRaw,
        penaltyAmount,
        chargedAmount,
        balanceAfter,
      )

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }

      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : 'Санкцията при напускане не беше записана.',
      }
    }

    const penaltyRow = selectPenaltyStatement.get(
      roomId,
      profileId,
    ) as PenaltyRow | undefined

    if (!penaltyRow) {
      return {
        ok: false,
        message: 'Санкцията при напускане не беше намерена след запис.',
      }
    }

    return {
      ok: true,
      penalty: toPenaltySnapshot(penaltyRow),
      profile: playerProgressStore.getPublicProfile(profileId),
    }
  }

  function close(): void {
    database.close()
  }

  return {
    applyPenalty,
    close,
  }
}

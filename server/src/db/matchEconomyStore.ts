import { randomUUID } from 'node:crypto'
import type { ProfileId, ServerRoom, Team } from '../core/serverTypes.js'
import {
  SERVER_SEAT_ORDER,
  SERVER_TEAM_A_SEATS,
} from '../core/serverTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const BOT_WALLET_REFILL_THRESHOLD = 5_000
const BOT_WALLET_REFILL_AMOUNT = 50_000

export type MatchEconomyStore = {
  hasEnoughBalance: (profileId: ProfileId, amount: number) => boolean
  topUpDepletedBotWallets: (room: ServerRoom) => void
  collectQueueStake: (
    queueEntryId: string,
    profileId: ProfileId,
    stakeAmount: number,
  ) => { ok: true } | { ok: false; message: string }
  refundQueueStake: (
    queueEntryId: string,
    profileId: ProfileId,
    stakeAmount: number,
  ) => { ok: true } | { ok: false; message: string }
  collectRoomStakes: (
    room: ServerRoom,
    stakeAmount: number,
  ) => { ok: true } | { ok: false; message: string }
  collectBotStakes: (
    room: ServerRoom,
    stakeAmount: number,
  ) => { ok: true } | { ok: false; message: string }
  payoutMatchWinners: (room: ServerRoom) => { ok: true } | { ok: false; message: string }
  close: () => void
}

type WalletRow = {
  yellow_coins_balance: number
}

let getPrizeForStake: (stakeAmount: number) => number | null = () => null

export function setMatchPrizeResolver(resolver: (stakeAmount: number) => number | null): void {
  getPrizeForStake = resolver
}

function getPrizeAmount(stakeAmount: number): number {
  return getPrizeForStake(stakeAmount) ?? stakeAmount
}

type MatchEconomyEntryType = 'stake_debit' | 'stake_refund' | 'winner_payout'

function getTeamBySeat(seat: (typeof SERVER_SEAT_ORDER)[number]): Team {
  return SERVER_TEAM_A_SEATS.includes(seat) ? 'A' : 'B'
}

function getMatchWinnerTeam(room: ServerRoom): Team | null {
  const authoritativeState = room.game.authoritativeState

  if (
    authoritativeState === null ||
    !('phase' in authoritativeState) ||
    authoritativeState.phase !== 'match-ended' ||
    authoritativeState.matchEnded === null
  ) {
    return null
  }

  return authoritativeState.matchEnded.winnerTeam
}

function getHumanProfileIds(room: ServerRoom): ProfileId[] {
  const profileIds: ProfileId[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant
    const profileId =
      participant?.identity.profileId ?? participant?.publicProfile?.profileId ?? null

    if (participant?.kind === 'human' && profileId !== null) {
      profileIds.push(profileId)
    }
  }

  return profileIds
}

function getBotProfileIds(room: ServerRoom): ProfileId[] {
  const profileIds: ProfileId[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant
    const profileId = participant?.kind === 'bot' ? (participant.botProfileId ?? null) : null

    if (profileId !== null) {
      profileIds.push(profileId)
    }
  }

  return profileIds
}

function getWinningProfileIds(room: ServerRoom, winnerTeam: Team): ProfileId[] {
  const profileIds: ProfileId[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    if (getTeamBySeat(seat) !== winnerTeam) {
      continue
    }

    const participant = room.seats[seat].participant

    if (participant?.kind === 'human') {
      const profileId =
        participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
      if (profileId !== null) profileIds.push(profileId)
    } else if (participant?.kind === 'bot') {
      const profileId = participant.botProfileId ?? null
      if (profileId !== null) profileIds.push(profileId)
    }
  }

  return profileIds
}

export async function createMatchEconomyStore(
  databaseFilePath: string,
  options: { getPrize?: (stakeAmount: number) => number | null } = {},
): Promise<MatchEconomyStore> {
  if (options.getPrize) {
    setMatchPrizeResolver(options.getPrize)
  }
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

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const insertLedgerStatement = database.prepare(`
    INSERT INTO match_economy_ledger (
      ledger_id,
      room_id,
      profile_id,
      entry_type,
      amount,
      balance_after
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
    ON CONFLICT(room_id, profile_id, entry_type) DO NOTHING;
  `)

  const selectLedgerStatement = database.prepare(`
    SELECT ledger_id
    FROM match_economy_ledger
    WHERE room_id = ?
      AND profile_id = ?
      AND entry_type = ?
    LIMIT 1;
  `)

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as WalletRow | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function hasLedgerEntry(
    roomId: string,
    profileId: ProfileId,
    entryType: MatchEconomyEntryType,
  ): boolean {
    return Boolean(selectLedgerStatement.get(roomId, profileId, entryType))
  }

  function hasEnoughBalance(profileId: ProfileId, amount: number): boolean {
    if (!Number.isInteger(amount) || amount < 0) {
      return false
    }

    ensureWalletStatement.run(profileId)
    return getWalletBalance(profileId) >= amount
  }

  function collectQueueStake(
    queueEntryId: string,
    profileId: ProfileId,
    stakeAmount: number,
  ): { ok: true } | { ok: false; message: string } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за игра.',
      }
    }

    const ledgerScopeId = `queue:${queueEntryId}`

    if (hasLedgerEntry(ledgerScopeId, profileId, 'stake_debit')) {
      return { ok: true }
    }

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)

      const debitResult = debitWalletStatement.run(
        stakeAmount,
        profileId,
        stakeAmount,
      ) as { changes?: number }

      if ((debitResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Нямаш достатъчно жълтици за този залог.',
        }
      }

      insertLedgerStatement.run(
        randomUUID(),
        ledgerScopeId,
        profileId,
        'stake_debit',
        stakeAmount,
        getWalletBalance(profileId),
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
          error instanceof Error ? error.message : 'Залогът не беше начислен.',
      }
    }

    return { ok: true }
  }

  function refundQueueStake(
    queueEntryId: string,
    profileId: ProfileId,
    stakeAmount: number,
  ): { ok: true } | { ok: false; message: string } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за връщане.',
      }
    }

    const ledgerScopeId = `queue:${queueEntryId}`

    if (!hasLedgerEntry(ledgerScopeId, profileId, 'stake_debit')) {
      return { ok: true }
    }

    if (hasLedgerEntry(ledgerScopeId, profileId, 'stake_refund')) {
      return { ok: true }
    }

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)
      creditWalletStatement.run(stakeAmount, profileId)
      insertLedgerStatement.run(
        randomUUID(),
        ledgerScopeId,
        profileId,
        'stake_refund',
        stakeAmount,
        getWalletBalance(profileId),
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
          error instanceof Error ? error.message : 'Залогът не беше върнат.',
      }
    }

    return { ok: true }
  }

  function collectRoomStakes(
    room: ServerRoom,
    stakeAmount: number,
  ): { ok: true } | { ok: false; message: string } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за игра.',
      }
    }

    const scope = `${room.id}:v${room.game.stateVersion}`
    const profileIds = getHumanProfileIds(room)

    try {
      database.exec('BEGIN;')

      for (const profileId of profileIds) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(scope, profileId, 'stake_debit')) {
          continue
        }

        const debitResult = debitWalletStatement.run(
          stakeAmount,
          profileId,
          stakeAmount,
        ) as { changes?: number }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return {
            ok: false,
            message: 'Някой от играчите няма достатъчно жълтици за залога.',
          }
        }

        insertLedgerStatement.run(
          randomUUID(),
          scope,
          profileId,
          'stake_debit',
          stakeAmount,
          getWalletBalance(profileId),
        )
      }

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
          error instanceof Error ? error.message : 'Залозите не бяха начислени.',
      }
    }

    return { ok: true }
  }

  function topUpDepletedBotWallets(room: ServerRoom): void {
    const botProfileIds = getBotProfileIds(room)
    if (botProfileIds.length === 0) return

    try {
      database.exec('BEGIN;')
      for (const profileId of botProfileIds) {
        ensureWalletStatement.run(profileId)
        const balance = getWalletBalance(profileId)
        if (balance < BOT_WALLET_REFILL_THRESHOLD) {
          creditWalletStatement.run(BOT_WALLET_REFILL_AMOUNT - balance, profileId)
        }
      }
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      console.error('[match-economy] bot wallet top-up failed:', error)
    }
  }

  function collectBotStakes(
    room: ServerRoom,
    stakeAmount: number,
  ): { ok: true } | { ok: false; message: string } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return { ok: false, message: 'Невалиден залог за бот.' }
    }

    const scope = `${room.id}:v${room.game.stateVersion}`
    const botProfileIds = getBotProfileIds(room)

    if (botProfileIds.length === 0) {
      return { ok: true }
    }

    try {
      database.exec('BEGIN;')

      for (const profileId of botProfileIds) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(scope, profileId, 'stake_debit')) {
          continue
        }

        const debitResult = debitWalletStatement.run(
          stakeAmount,
          profileId,
          stakeAmount,
        ) as { changes?: number }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return { ok: false, message: 'Бот няма достатъчно баланс за залога.' }
        }

        insertLedgerStatement.run(
          randomUUID(),
          scope,
          profileId,
          'stake_debit',
          stakeAmount,
          getWalletBalance(profileId),
        )
      }

      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Залозите за ботовете не бяха начислени.',
      }
    }

    return { ok: true }
  }

  function payoutMatchWinners(room: ServerRoom): { ok: true } | { ok: false; message: string } {
    const stakeAmount = room.config.stakeAmount ?? null
    const winnerTeam = getMatchWinnerTeam(room)

    if (winnerTeam === null || stakeAmount === null) {
      return { ok: true }
    }

    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за изплащане.',
      }
    }

    const prizeAmount = getPrizeAmount(stakeAmount)
    const winnerProfileIds = getWinningProfileIds(room, winnerTeam)
    const scope = `${room.id}:v${room.game.stateVersion}`

    try {
      database.exec('BEGIN;')

      for (const profileId of winnerProfileIds) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(scope, profileId, 'winner_payout')) {
          continue
        }

        creditWalletStatement.run(prizeAmount, profileId)
        insertLedgerStatement.run(
          randomUUID(),
          scope,
          profileId,
          'winner_payout',
          prizeAmount,
          getWalletBalance(profileId),
        )
      }

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
          error instanceof Error ? error.message : 'Наградите не бяха изплатени.',
      }
    }

    return { ok: true }
  }

  function close(): void {
    database.close()
  }

  return {
    hasEnoughBalance,
    topUpDepletedBotWallets,
    collectQueueStake,
    refundQueueStake,
    collectRoomStakes,
    collectBotStakes,
    payoutMatchWinners,
    close,
  }
}

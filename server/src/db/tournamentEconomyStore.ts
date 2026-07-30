// Финансов слой за турнирно записване/напускане/отмяна — атомарен debit/credit
// на profile_wallets + idempotent tournament_economy_ledger. Огледало на
// matchEconomyStore.ts (collectQueueStake/refundQueueStake/collectRoomStakes
// pattern), но за tournament domain — НЕ смесва room match economy scope
// (room_id-базиран ledger) с tournament economy scope (idempotency_key-базиран
// ledger, виж migration 20260730_002).
//
// Пише директно в tournaments/tournament_entries/tournament_economy_ledger/
// tournament_events в рамките на ЕДНА SQLite транзакция — не минава през
// tournamentStore.ts cross-store извиквания, защото entry INSERT/UPDATE и
// wallet debit/credit трябва да са atomically all-or-nothing заедно.

import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { dbDateToUtc } from './dbDate.js'
import { verifyPassword as verifyTournamentPassword } from './authHelpers.js'
import type {
  TournamentEntryJoinedAs,
  TournamentEntryRecord,
  TournamentEntryStatus,
  TournamentId,
  TournamentRecord,
  TournamentStatus,
  TournamentVisibility,
} from '../tournament/tournamentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

type TournamentLedgerEntryType = 'entry_fee_debit' | 'entry_fee_refund'

export type JoinTournamentSoloResult =
  | {
      ok: true
      alreadyJoined: boolean
      entry: TournamentEntryRecord
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'tournament_not_open'
        | 'tournament_full'
        | 'rejoin_not_allowed'
        | 'already_participating_elsewhere'
        | 'insufficient_funds'
        | 'requires_password'
    }

export type LeaveTournamentResult =
  | {
      ok: true
      alreadyRefunded: boolean
      refundedAmount: number
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason: 'entry_not_found' | 'not_own_entry' | 'tournament_not_open' | 'entry_not_confirmed'
    }

export type CancelOpenTournamentResult =
  | {
      ok: true
      alreadyCancelled: boolean
      refundedEntries: number
      totalRefunded: number
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason: 'tournament_not_found' | 'not_creator' | 'tournament_not_open'
    }

export type TournamentEconomyStore = {
  joinTournamentSoloAtomically: (
    tournamentId: TournamentId,
    profileId: ProfileId,
    options?: { password?: string | null },
  ) => JoinTournamentSoloResult
  leaveTournamentAndRefundAtomically: (
    tournamentId: TournamentId,
    profileId: ProfileId,
  ) => LeaveTournamentResult
  cancelOpenTournamentAndRefundAtomically: (
    tournamentId: TournamentId,
    creatorProfileId: ProfileId,
    cancelReason: string,
  ) => CancelOpenTournamentResult
  close: () => void
}

type TournamentRow = {
  tournament_id: string
  kind: string
  name: string
  creator_profile_id: string
  visibility: string
  password_hash: string | null
  entry_fee: number
  player_capacity: number
  start_mode: string
  scheduled_start_at: string | null
  status: string
  cancel_reason: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
}

type TournamentEntryRow = {
  entry_id: string
  tournament_id: string
  profile_id: string
  team_id: string | null
  joined_as: string
  status: string
  created_at: string
  updated_at: string
  withdrawn_at: string | null
  refunded_at: string | null
}

type WalletRow = {
  yellow_coins_balance: number
}

type ActiveAccountEntryRow = {
  entry_id: string
}

function toTournamentRecord(row: TournamentRow): TournamentRecord {
  return {
    tournamentId: row.tournament_id,
    kind: row.kind as TournamentRecord['kind'],
    name: row.name,
    creatorProfileId: row.creator_profile_id,
    visibility: row.visibility as TournamentVisibility,
    passwordHash: row.password_hash,
    entryFee: row.entry_fee,
    playerCapacity: row.player_capacity,
    startMode: row.start_mode as TournamentRecord['startMode'],
    scheduledStartAt: row.scheduled_start_at !== null ? dbDateToUtc(row.scheduled_start_at) : null,
    status: row.status as TournamentStatus,
    cancelReason: row.cancel_reason,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
    startedAt: row.started_at !== null ? dbDateToUtc(row.started_at) : null,
    finishedAt: row.finished_at !== null ? dbDateToUtc(row.finished_at) : null,
  }
}

function toTournamentEntryRecord(row: TournamentEntryRow): TournamentEntryRecord {
  return {
    entryId: row.entry_id,
    tournamentId: row.tournament_id,
    profileId: row.profile_id,
    teamId: row.team_id,
    joinedAs: row.joined_as as TournamentEntryJoinedAs,
    status: row.status as TournamentEntryStatus,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
    withdrawnAt: row.withdrawn_at !== null ? dbDateToUtc(row.withdrawn_at) : null,
    refundedAt: row.refunded_at !== null ? dbDateToUtc(row.refunded_at) : null,
  }
}

function entryFeeDebitKey(tournamentId: TournamentId, profileId: ProfileId): string {
  return `tournament:${tournamentId}:profile:${profileId}:entry-fee-debit`
}

function entryFeeRefundKey(tournamentId: TournamentId, profileId: ProfileId): string {
  return `tournament:${tournamentId}:profile:${profileId}:entry-fee-refund`
}

export async function createTournamentEconomyStore(
  databaseFilePath: string,
): Promise<TournamentEconomyStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectTournamentByIdStatement = database.prepare(`
    SELECT
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      cancel_reason, created_at, updated_at, started_at, finished_at
    FROM tournaments
    WHERE tournament_id = ?
    LIMIT 1;
  `)

  const selectTournamentForUpdateStatement = database.prepare(`
    SELECT
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, status,
      cancel_reason, created_at, updated_at, started_at, finished_at
    FROM tournaments
    WHERE tournament_id = ?
    LIMIT 1;
  `)

  const updateTournamentStatusStatement = database.prepare(`
    UPDATE tournaments
    SET status = ?, cancel_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE tournament_id = ? AND creator_profile_id = ? AND status = 'open';
  `)

  const countConfirmedEntriesStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_entries
    WHERE tournament_id = ? AND status = 'confirmed';
  `)

  const selectEntryByTournamentAndProfileStatement = database.prepare(`
    SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
           created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE tournament_id = ? AND profile_id = ?
    LIMIT 1;
  `)

  const selectEntryByIdStatement = database.prepare(`
    SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
           created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE entry_id = ?
    LIMIT 1;
  `)

  const selectActiveEntryForAccountStatement = database.prepare(`
    SELECT te.entry_id
    FROM tournament_entries te
    JOIN profiles entry_profile
      ON entry_profile.profile_id = te.profile_id
    JOIN profiles joining_profile
      ON joining_profile.profile_id = ?
    WHERE te.status IN ('confirmed', 'finalist')
      AND entry_profile.account_id IS NOT NULL
      AND joining_profile.account_id IS NOT NULL
      AND entry_profile.account_id = joining_profile.account_id
    LIMIT 1;
  `)

  const selectConfirmedEntriesStatement = database.prepare(`
    SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
           created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE tournament_id = ? AND status = 'confirmed'
    ORDER BY created_at ASC;
  `)

  const insertEntryStatement = database.prepare(`
    INSERT INTO tournament_entries (
      entry_id, tournament_id, profile_id, team_id, joined_as, status
    ) VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
  `)

  const updateEntryToRefundedStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'refunded', withdrawn_at = CURRENT_TIMESTAMP, refunded_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
  `)

  // Creator/system cancellation: withdrawn_at остава NULL, за да се различава
  // от доброволно напускане (продуктово изискване 3.7).
  const updateEntryToRefundedByCancelStatement = database.prepare(`
    UPDATE tournament_entries
    SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id, yellow_coins_balance
    ) VALUES (?, 0)
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
    SET yellow_coins_balance = yellow_coins_balance - ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND yellow_coins_balance >= ?;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const insertLedgerStatement = database.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(idempotency_key) DO NOTHING;
  `)

  const selectLedgerByKeyStatement = database.prepare(`
    SELECT ledger_id, amount
    FROM tournament_economy_ledger
    WHERE idempotency_key = ?
    LIMIT 1;
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO tournament_events (
      event_id, tournament_id, event_type, actor_profile_id, actor_role, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as WalletRow | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function getLedgerByKey(key: string): { ledgerId: string; amount: number } | null {
    const row = selectLedgerByKeyStatement.get(key) as { ledger_id: string; amount: number } | undefined
    return row ? { ledgerId: row.ledger_id, amount: row.amount } : null
  }

  function insertEvent(
    tournamentId: TournamentId,
    eventType: string,
    actorProfileId: ProfileId | null,
    actorRole: 'player' | 'system',
    payload: Record<string, unknown> | null,
  ): void {
    insertEventStatement.run(
      randomUUID(),
      tournamentId,
      eventType,
      actorProfileId,
      actorRole,
      payload !== null ? JSON.stringify(payload) : null,
    )
  }

  return {
    joinTournamentSoloAtomically(
      tournamentId: TournamentId,
      profileId: ProfileId,
      options: { password?: string | null } = {},
    ): JoinTournamentSoloResult {
      // Pre-check извън транзакцията (не намалява коректността — всичко
      // критично се пре-проверява вътре в BEGIN IMMEDIATE по-долу; целта е
      // само бърз early-return без да отваряме транзакция за очевидни грешки).
      const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournamentRow === undefined) {
        return { ok: false, reason: 'tournament_not_found' }
      }

      const debitKey = entryFeeDebitKey(tournamentId, profileId)

      // Идемпотентност: ако вече има confirmed entry + debit ledger, връщаме
      // success без нов debit (retry-safe за клиентски network грешки).
      const existingEntryRow = selectEntryByTournamentAndProfileStatement.get(
        tournamentId,
        profileId,
      ) as TournamentEntryRow | undefined

      if (existingEntryRow !== undefined) {
        if (existingEntryRow.status === 'confirmed') {
          const ledger = getLedgerByKey(debitKey)
          if (ledger !== null) {
            return {
              ok: true,
              alreadyJoined: true,
              entry: toTournamentEntryRecord(existingEntryRow),
              walletBalance: getWalletBalance(profileId),
              tournament: toTournamentRecord(tournamentRow),
            }
          }
        }
        // refunded/withdrawn/eliminated/finalist/champion — терминален
        // резултат, не позволяваме повторно записване във V1.
        return { ok: false, reason: 'rejoin_not_allowed' }
      }

      let result: JoinTournamentSoloResult

      try {
        database.exec('BEGIN IMMEDIATE;')

        const freshTournament = selectTournamentForUpdateStatement.get(tournamentId) as
          | TournamentRow
          | undefined

        if (freshTournament === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_not_found' }
        }
        if (freshTournament.status !== 'open') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_not_open' }
        }

        const isCreator = freshTournament.creator_profile_id === profileId
        if (freshTournament.visibility === 'password' && !isCreator) {
          const providedPassword = options.password ?? null
          if (
            providedPassword === null ||
            freshTournament.password_hash === null ||
            !verifyTournamentPassword(providedPassword, freshTournament.password_hash)
          ) {
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'requires_password' }
          }
        }

        // Re-check вътре в транзакцията (TOCTOU защита между pre-check и BEGIN) —
        // покрива рядкия race, при който два паралелни join-а от СЪЩИЯ profile
        // минават pre-check-а едновременно, преди първият да commit-не.
        const existingInTx = selectEntryByTournamentAndProfileStatement.get(
          tournamentId,
          profileId,
        ) as TournamentEntryRow | undefined
        if (existingInTx !== undefined) {
          database.exec('ROLLBACK;')
          if (existingInTx.status === 'confirmed') {
            // Другият паралелен join вече е commit-нал успешно — идемпотентен
            // success, не грешка (виж продуктово изискване: retry след
            // мрежов проблем не трябва да получи 409).
            const ledger = getLedgerByKey(debitKey)
            if (ledger !== null) {
              return {
                ok: true,
                alreadyJoined: true,
                entry: toTournamentEntryRecord(existingInTx),
                walletBalance: getWalletBalance(profileId),
                tournament: toTournamentRecord(tournamentRow),
              }
            }
          }
          return { ok: false, reason: 'rejoin_not_allowed' }
        }

        const activeAccountEntry = selectActiveEntryForAccountStatement.get(
          profileId,
        ) as ActiveAccountEntryRow | undefined
        if (activeAccountEntry !== undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participating_elsewhere' }
        }

        const confirmedCount = (
          countConfirmedEntriesStatement.get(tournamentId) as { count: number }
        ).count
        const playerCapacity = Math.min(freshTournament.player_capacity, 8)
        if (confirmedCount >= playerCapacity) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_full' }
        }

        const entryFee = freshTournament.entry_fee

        ensureWalletStatement.run(profileId)
        const debitResult = debitWalletStatement.run(entryFee, profileId, entryFee) as {
          changes?: number
        }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'insufficient_funds' }
        }

        const entryId = randomUUID()
        try {
          insertEntryStatement.run(entryId, tournamentId, profileId)
        } catch {
          // UNIQUE(tournament_id, profile_id) или
          // idx_tournament_entries_one_active_per_profile constraint violation
          // — друг активен entry (в този или друг турнир) вече съществува за
          // profile-a; race condition, hванат от partial UNIQUE index-а.
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participating_elsewhere' }
        }

        insertLedgerStatement.run(
          randomUUID(),
          debitKey,
          tournamentId,
          profileId,
          'entry_fee_debit' satisfies TournamentLedgerEntryType,
          entryFee,
          getWalletBalance(profileId),
        )

        insertEvent(tournamentId, 'entry_confirmed', profileId, 'player', {
          entryFee,
          joinedAs: 'solo',
        })

        database.exec('COMMIT;')

        const entryRow = selectEntryByIdStatement.get(entryId) as TournamentEntryRow

        result = {
          ok: true,
          alreadyJoined: false,
          entry: toTournamentEntryRecord(entryRow),
          walletBalance: getWalletBalance(profileId),
          tournament: toTournamentRecord(freshTournament),
        }
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // surface original failure
        }
        throw error
      }

      return result
    },

    leaveTournamentAndRefundAtomically(
      tournamentId: TournamentId,
      profileId: ProfileId,
    ): LeaveTournamentResult {
      const entryRow = selectEntryByTournamentAndProfileStatement.get(
        tournamentId,
        profileId,
      ) as TournamentEntryRow | undefined

      if (entryRow === undefined) {
        return { ok: false, reason: 'entry_not_found' }
      }

      const refundKey = entryFeeRefundKey(tournamentId, profileId)

      if (entryRow.status === 'refunded') {
        const ledger = getLedgerByKey(refundKey)
        if (ledger !== null) {
          const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
          return {
            ok: true,
            alreadyRefunded: true,
            refundedAmount: ledger.amount,
            walletBalance: getWalletBalance(profileId),
            tournament: toTournamentRecord(tournamentRow),
          }
        }
      }

      if (entryRow.status !== 'confirmed') {
        return { ok: false, reason: 'entry_not_confirmed' }
      }

      let result: LeaveTournamentResult

      try {
        database.exec('BEGIN IMMEDIATE;')

        const freshTournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow
        if (freshTournament.status !== 'open') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_not_open' }
        }

        const freshEntry = selectEntryByTournamentAndProfileStatement.get(
          tournamentId,
          profileId,
        ) as TournamentEntryRow

        if (freshEntry.status === 'refunded') {
          // Race: друг паралелен leave вече е приключил.
          const ledger = getLedgerByKey(refundKey)
          database.exec('ROLLBACK;')
          return {
            ok: true,
            alreadyRefunded: true,
            refundedAmount: ledger?.amount ?? 0,
            walletBalance: getWalletBalance(profileId),
            tournament: toTournamentRecord(freshTournament),
          }
        }
        if (freshEntry.status !== 'confirmed') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'entry_not_confirmed' }
        }

        const debitKey = entryFeeDebitKey(tournamentId, profileId)
        const debitLedger = getLedgerByKey(debitKey)
        // Реалната платена сума идва от debit ledger-а, не от mutable
        // tournament.entryFee (защитава срещу бъдещи entryFee промени).
        const refundAmount = debitLedger?.amount ?? freshTournament.entry_fee

        ensureWalletStatement.run(profileId)
        creditWalletStatement.run(refundAmount, profileId)

        insertLedgerStatement.run(
          randomUUID(),
          refundKey,
          tournamentId,
          profileId,
          'entry_fee_refund' satisfies TournamentLedgerEntryType,
          refundAmount,
          getWalletBalance(profileId),
        )

        const updateResult = updateEntryToRefundedStatement.run(freshEntry.entry_id) as {
          changes?: number
        }
        if ((updateResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'entry_not_confirmed' }
        }

        insertEvent(tournamentId, 'entry_withdrawn_and_refunded', profileId, 'player', {
          refundedAmount: refundAmount,
        })

        database.exec('COMMIT;')

        result = {
          ok: true,
          alreadyRefunded: false,
          refundedAmount: refundAmount,
          walletBalance: getWalletBalance(profileId),
          tournament: toTournamentRecord(freshTournament),
        }
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // surface original failure
        }
        throw error
      }

      return result
    },

    cancelOpenTournamentAndRefundAtomically(
      tournamentId: TournamentId,
      creatorProfileId: ProfileId,
      cancelReason: string,
    ): CancelOpenTournamentResult {
      const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournamentRow === undefined) {
        return { ok: false, reason: 'tournament_not_found' }
      }
      if (tournamentRow.creator_profile_id !== creatorProfileId) {
        return { ok: false, reason: 'not_creator' }
      }
      if (tournamentRow.status === 'cancelled') {
        return {
          ok: true,
          alreadyCancelled: true,
          refundedEntries: 0,
          totalRefunded: 0,
          walletBalance: getWalletBalance(creatorProfileId),
          tournament: toTournamentRecord(tournamentRow),
        }
      }
      if (tournamentRow.status !== 'open') {
        return { ok: false, reason: 'tournament_not_open' }
      }

      let result: CancelOpenTournamentResult

      try {
        database.exec('BEGIN IMMEDIATE;')

        const statusUpdateResult = updateTournamentStatusStatement.run(
          'cancelled',
          cancelReason,
          tournamentId,
          creatorProfileId,
        ) as { changes?: number }

        if ((statusUpdateResult.changes ?? 0) === 0) {
          // Race: друг паралелен cancel вече е приключил, или статус вече не е open.
          const freshTournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow
          database.exec('ROLLBACK;')
          if (freshTournament.status === 'cancelled') {
            return {
              ok: true,
              alreadyCancelled: true,
              refundedEntries: 0,
              totalRefunded: 0,
              walletBalance: getWalletBalance(creatorProfileId),
              tournament: toTournamentRecord(freshTournament),
            }
          }
          return { ok: false, reason: 'tournament_not_open' }
        }

        const confirmedEntries = selectConfirmedEntriesStatement.all(
          tournamentId,
        ) as TournamentEntryRow[]

        let refundedEntries = 0
        let totalRefunded = 0

        for (const entry of confirmedEntries) {
          const refundKey = entryFeeRefundKey(tournamentId, entry.profile_id)

          if (getLedgerByKey(refundKey) !== null) {
            continue // вече refund-нат (idempotent skip)
          }

          const debitKey = entryFeeDebitKey(tournamentId, entry.profile_id)
          const debitLedger = getLedgerByKey(debitKey)
          const refundAmount = debitLedger?.amount ?? tournamentRow.entry_fee

          ensureWalletStatement.run(entry.profile_id)
          creditWalletStatement.run(refundAmount, entry.profile_id)

          insertLedgerStatement.run(
            randomUUID(),
            refundKey,
            tournamentId,
            entry.profile_id,
            'entry_fee_refund' satisfies TournamentLedgerEntryType,
            refundAmount,
            getWalletBalance(entry.profile_id),
          )

          updateEntryToRefundedByCancelStatement.run(entry.entry_id)

          refundedEntries += 1
          totalRefunded += refundAmount
        }

        insertEvent(tournamentId, 'tournament_cancelled_by_creator', creatorProfileId, 'player', {
          refundedEntries,
          totalRefunded,
        })

        database.exec('COMMIT;')

        const finalTournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow

        result = {
          ok: true,
          alreadyCancelled: false,
          refundedEntries,
          totalRefunded,
          walletBalance: getWalletBalance(creatorProfileId),
          tournament: toTournamentRecord(finalTournament),
        }
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // surface original failure
        }
        throw error
      }

      return result
    },

    close(): void {
      database.close()
    },
  }
}

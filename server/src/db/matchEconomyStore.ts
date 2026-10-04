import { randomUUID } from 'node:crypto'
import type { ProfileId, ServerRoom, Team } from '../core/serverTypes.js'
import {
  SERVER_SEAT_ORDER,
  SERVER_TEAM_A_SEATS,
} from '../core/serverTypes.js'
import { escapeSqlLikePattern } from './normalizeProfileIdentityText.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// Transient-vs-permanent classification for technical-abort refund failures
// (root-cause audit follow-up — "refund retry exhaustion" fix, §2 of the
// brief: classify with concrete codebase types, not fragile string
// matching where it can be avoided). Mirrors the exact
// SQLITE_BUSY(5)/SQLITE_LOCKED(6) detection already proven in
// siteVisitStore.ts's isSqliteBusyError — same node:sqlite error shape
// (numeric `errcode`, extended codes folded via `& 0xff`); duplicated
// locally because every store file in this codebase already owns its own
// copy of this exact helper rather than sharing one (established
// convention here, not a new one). The string-regex fallback only covers
// the case where `errcode` is absent — it is the SAME fallback
// siteVisitStore.ts already relies on in production, not a new fragile
// heuristic.
export function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const errcode = (error as { errcode?: unknown }).errcode
  if (typeof errcode === 'number') {
    const primaryCode = errcode & 0xff
    return primaryCode === 5 || primaryCode === 6
  }
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /database (?:table )?is locked/i.test(message)
}

// A thrown exception from the refund write transaction below is classified
// 'transient' ONLY when it is a positively-identified lock/busy condition —
// exactly the class of failure a DB outage/contention produces, and the
// class this fix's retry policy exists to ride out. Any OTHER thrown
// exception (corrupted file, disk full, unexpected constraint violation)
// is NOT assumed safe to retry forever — it is classified 'permanent' so
// it surfaces as a loud terminal admin-required state instead of silently
// retrying an error nobody has proven is recoverable. Structural data
// problems (missing debit row, unreadable amount) never reach this
// function at all — they are caught by an explicit pre-check BEFORE the
// try/catch (see refundParticipantScopedStake's amount===null branch) and
// classified 'permanent' directly, with no DB exception involved.
export function classifyRefundThrowAsRetryKind(error: unknown): 'transient' | 'permanent' {
  return isSqliteBusyError(error) ? 'transient' : 'permanent'
}

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
  payoutMatchWinners: (
    room: ServerRoom,
  ) =>
    | { ok: true; awardedPerSeat: Partial<Record<import('../core/serverTypes.js').Seat, number>> }
    | { ok: false; message: string }
  /**
   * Technical-abort refund [1/2] — ROOM-SCOPED debits (root-cause audit:
   * "zombie Belot room / session_in_game lock", economy-safety follow-up).
   * Finds every stake_debit ledger row whose scope starts with
   * `${roomId}:v` (ЛЮБОЙ stateVersion suffix — виж getRoomStakeLedgerScope
   * коментара защо текущия room.game.stateVersion не може да се ползва за
   * reconstruct-ване на оригиналния scope) that has NEITHER a matching
   * stake_refund NOR a winner_payout for the exact same (scope, profileId)
   * — т.е. пари, които са излезли и никога не са се върнали в каквато и да
   * е форма. Покрива: private-room human stakes (collectRoomStakes),
   * private-room/matchmaking bot stakes (collectBotStakes) — ВСИЧКИ от тях
   * са room-scoped по дефиниция. НЕ покрива matchmaking HUMAN stakes (виж
   * refundParticipantScopedStake за тях — queue-scoped, различен namespace).
   * Idempotent: втори опит намира нула недовършени редове и връща празен
   * масив, не хвърля, не refund-ва повторно.
   */
  refundUnsettledRoomScopedStakes: (
    roomId: string,
  ) =>
    | { ok: true; refunds: Array<{ profileId: ProfileId; amount: number; scope: string }> }
    | { ok: false; message: string; kind: 'transient' | 'permanent' }
  /**
   * Technical-abort refund [2/2] — PARTICIPANT-SCOPED debit (за matchmaking
   * human stakes, чийто ledger scope е `queue:${entryId}` — НЕ room-scoped,
   * затова не се намира от refundUnsettledRoomScopedStakes по-горе). Scope-ът
   * идва от HumanRoomParticipant.stakeLedgerScope (записан при room creation
   * от createMatchedRoomFromEntries.ts) — caller-ът (abortQuarantinedRoom)
   * никога не вика това за participant без такъв scope (виж
   * evaluateAutoAbortEligibility — legacy rooms без scope са explicitly
   * excluded от auto-abort). Idempotent: ако refund вече съществува (или
   * debit никога не е съществувал), връща refunded:false без промяна.
   */
  refundParticipantScopedStake: (
    scope: string,
    profileId: ProfileId,
  ) =>
    | { ok: true; refunded: boolean; amount: number | null }
    | { ok: false; message: string; kind: 'transient' | 'permanent' }
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

// Единствен source of truth за room-scoped ledger scope string — ВСИЧКИ
// room-scoped debit/payout пътища (collectRoomStakes/collectBotStakes/
// payoutMatchWinners) ТРЯБВА да минават през тази функция, не да inline-ват
// шаблона. Критично за technical-abort refund-а (виж
// refundUnsettledRoomScopedStakes по-долу): scope-ът вгражда
// room.game.stateVersion ВЪВ МОМЕНТА НА ДЕБИТА (ниска стойност, при room
// start), не текущата stateVersion на stuck room-а (която може да е 75+
// tick-а по-късно) — затова refund-ът НЕ reconstruct-ва scope от текущия
// room обект, а чете го директно от вече записаните ledger редове чрез LIKE
// pattern (виж долу). Тази функция остава единствен authoritative формат.
export function getRoomStakeLedgerScope(room: ServerRoom): string {
  return `${room.id}:v${room.game.stateVersion}`
}

function getTeamBySeat(seat: (typeof SERVER_SEAT_ORDER)[number]): Team {
  return SERVER_TEAM_A_SEATS.includes(seat) ? 'A' : 'B'
}

function isTemporaryBotProfileId(profileId: ProfileId): boolean {
  return profileId.startsWith('temp-bot-')
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

    if (profileId !== null && !isTemporaryBotProfileId(profileId)) {
      profileIds.push(profileId)
    }
  }

  return profileIds
}

type WinningSeatEntry = { seat: (typeof SERVER_SEAT_ORDER)[number]; profileId: ProfileId }

function getWinningSeatEntries(room: ServerRoom, winnerTeam: Team): WinningSeatEntry[] {
  const entries: WinningSeatEntry[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    if (getTeamBySeat(seat) !== winnerTeam) {
      continue
    }

    const participant = room.seats[seat].participant

    if (participant?.kind === 'human') {
      const profileId =
        participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
      if (profileId !== null) entries.push({ seat, profileId })
    } else if (participant?.kind === 'bot') {
      const profileId = participant.botProfileId ?? null
      if (profileId !== null && !isTemporaryBotProfileId(profileId)) entries.push({ seat, profileId })
    }
  }

  return entries
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

  const selectLedgerAmountStatement = database.prepare(`
    SELECT amount
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

  function getLedgerAmount(
    roomId: string,
    profileId: ProfileId,
    entryType: MatchEconomyEntryType,
  ): number | null {
    const row = selectLedgerAmountStatement.get(roomId, profileId, entryType) as
      | { amount: number }
      | undefined
    return row?.amount ?? null
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

    const scope = getRoomStakeLedgerScope(room)
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

    const scope = getRoomStakeLedgerScope(room)
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

  function payoutMatchWinners(
    room: ServerRoom,
  ):
    | { ok: true; awardedPerSeat: Partial<Record<(typeof SERVER_SEAT_ORDER)[number], number>> }
    | { ok: false; message: string } {
    const stakeAmount = room.config.stakeAmount ?? null
    const winnerTeam = getMatchWinnerTeam(room)

    if (winnerTeam === null || stakeAmount === null) {
      return { ok: true, awardedPerSeat: {} }
    }

    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return {
        ok: false,
        message: 'Невалиден залог за изплащане.',
      }
    }

    const prizeAmount = getPrizeAmount(stakeAmount)
    const winningSeatEntries = getWinningSeatEntries(room, winnerTeam)
    const scope = getRoomStakeLedgerScope(room)
    const awardedPerSeat: Partial<Record<(typeof SERVER_SEAT_ORDER)[number], number>> = {}

    try {
      database.exec('BEGIN;')

      for (const { seat, profileId } of winningSeatEntries) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(scope, profileId, 'winner_payout')) {
          // Already credited — read the historical amount from the ledger, not the current admin prize
          const historicalAmount = getLedgerAmount(scope, profileId, 'winner_payout')
          if (historicalAmount !== null) {
            awardedPerSeat[seat] = historicalAmount
          } else {
            console.error(
              `[match-economy] winner_payout ledger entry exists but amount unreadable room=${scope} profile=${profileId}`,
            )
          }
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
        awardedPerSeat[seat] = prizeAmount
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

    return { ok: true, awardedPerSeat }
  }

  // §1/§2 technical-abort refund (root-cause audit, economy-safety
  // follow-up) — всички stake_debit редове, чиито room_id scope съвпада с
  // `${roomId}:v%` (room-scoped — private-room humans + bots от ВСЕКИ room
  // тип), БЕЗ matching stake_refund/winner_payout за СЪЩОТО (scope,
  // profile_id). LIKE pattern-ът escape-ва roomId (UUID-и нямат % / _, но
  // defensive — established конвенция, виж tournamentEconomyStore.ts).
  const selectUnrefundedRoomScopedDebitsStatement = database.prepare(`
    SELECT room_id, profile_id, amount
    FROM match_economy_ledger AS debit
    WHERE debit.room_id LIKE ? ESCAPE '\\'
      AND debit.entry_type = 'stake_debit'
      AND NOT EXISTS (
        SELECT 1 FROM match_economy_ledger AS refund
        WHERE refund.room_id = debit.room_id
          AND refund.profile_id = debit.profile_id
          AND refund.entry_type = 'stake_refund'
      )
      AND NOT EXISTS (
        SELECT 1 FROM match_economy_ledger AS payout
        WHERE payout.room_id = debit.room_id
          AND payout.profile_id = debit.profile_id
          AND payout.entry_type = 'winner_payout'
      );
  `)

  function refundUnsettledRoomScopedStakes(
    roomId: string,
  ):
    | { ok: true; refunds: Array<{ profileId: ProfileId; amount: number; scope: string }> }
    | { ok: false; message: string; kind: 'transient' | 'permanent' } {
    const likePattern = `${escapeSqlLikePattern(roomId)}:v%`
    const rows = selectUnrefundedRoomScopedDebitsStatement.all(likePattern) as Array<{
      room_id: string
      profile_id: ProfileId
      amount: number
    }>

    if (rows.length === 0) {
      return { ok: true, refunds: [] }
    }

    const refunds: Array<{ profileId: ProfileId; amount: number; scope: string }> = []

    try {
      database.exec('BEGIN;')

      for (const row of rows) {
        ensureWalletStatement.run(row.profile_id)
        creditWalletStatement.run(row.amount, row.profile_id)
        insertLedgerStatement.run(
          randomUUID(),
          row.room_id,
          row.profile_id,
          'stake_refund',
          row.amount,
          getWalletBalance(row.profile_id),
        )
        refunds.push({ profileId: row.profile_id, amount: row.amount, scope: row.room_id })
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
          error instanceof Error ? error.message : 'Room-scoped залозите не бяха върнати.',
        kind: classifyRefundThrowAsRetryKind(error),
      }
    }

    return { ok: true, refunds }
  }

  function refundParticipantScopedStake(
    scope: string,
    profileId: ProfileId,
  ):
    | { ok: true; refunded: boolean; amount: number | null }
    | { ok: false; message: string; kind: 'transient' | 'permanent' } {
    if (!hasLedgerEntry(scope, profileId, 'stake_debit')) {
      return { ok: true, refunded: false, amount: null }
    }

    if (
      hasLedgerEntry(scope, profileId, 'stake_refund') ||
      hasLedgerEntry(scope, profileId, 'winner_payout')
    ) {
      return { ok: true, refunded: false, amount: getLedgerAmount(scope, profileId, 'stake_refund') }
    }

    const amount = getLedgerAmount(scope, profileId, 'stake_debit')

    if (amount === null) {
      // Structural data inconsistency, never a thrown DB exception — a
      // stake_debit ledger ROW exists (checked above) but its amount
      // column cannot be read back. No retry can fix a row that is
      // already there and already unreadable — always 'permanent'.
      return {
        ok: false,
        message: `stake_debit amount unreadable scope=${scope} profile=${profileId}`,
        kind: 'permanent',
      }
    }

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(profileId)
      creditWalletStatement.run(amount, profileId)
      insertLedgerStatement.run(
        randomUUID(),
        scope,
        profileId,
        'stake_refund',
        amount,
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
        kind: classifyRefundThrowAsRetryKind(error),
      }
    }

    return { ok: true, refunded: true, amount }
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
    refundUnsettledRoomScopedStakes,
    refundParticipantScopedStake,
    close,
  }
}

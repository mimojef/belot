import { randomUUID } from 'node:crypto'
import type { ProfileId, ServerRoom, Team } from '../core/serverTypes.js'
import {
  SERVER_SEAT_ORDER,
  SERVER_TEAM_A_SEATS,
} from '../core/serverTypes.js'
import { escapeSqlLikePattern } from './normalizeProfileIdentityText.js'
import { resolvePinnedBelotPrize } from '../economy/belotFinancialTerms.js'

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
    | { ok: false; message: string; held?: HeldPayoutNotice }
  /**
   * Етап 3Б.2: записва (идемпотентно) задържано изплащане в
   * belot_held_payouts. Ползва се за повторен опит, когато първоначалният
   * запис в payoutMatchWinners не е успял.
   */
  recordHeldPayout: (record: HeldPayoutRecord) => { ok: true } | { ok: false; message: string }
  /**
   * Етап 3Б.2: за възстановена при старт маса — ако мачът е приключил, а
   * изплащането би било задържано и още не е регистрирано, го регистрира.
   */
  registerHeldPayoutForRestoredRoom: (room: ServerRoom) => { status: 'not-held' | 'recorded' } | { status: 'failed'; message: string }
  /**
   * Етап 3Б.2 (диагностика при старт): завършени платени Белот мачове по
   * belot_match_completion_ledger (записан ПРЕДИ изплащането), които нямат
   * winner_payout и нямат ред в belot_held_payouts → регистрира ги като
   * 'payout-missing' за ръчна проверка. НИКОГА не начислява жълтици.
   * Изключени: турнири (залог 0), гост мачове, временни ботове.
   */
  registerMissingPayoutsFromCompletionLedger: () => MissingPayoutDiagnosticReport
  getHeldPayout: (matchScope: string) => HeldPayoutRow | null
  listHeldPayouts: (filter?: { status?: HeldPayoutStatus }) => HeldPayoutRow[]
  /**
   * Етап 3Б.2: ръчно уреждане от администратор (сървърен механизъм; без UI).
   * Една транзакция: движение на жълтици + ledger + смяна на статуса, само от
   * 'pending_review'. Никога текущото prize_amount — наградата се подава
   * изрично след проверка и се записва заедно с доказателството.
   */
  settleHeldPayout: (input: SettleHeldPayoutInput) => SettleHeldPayoutResult
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
  /**
   * Етап 3Б.1: записва (в една транзакция) връзката „queue:<entryId> вход →
   * създадена маса“ за всички хора в новата маса. Идемпотентно (INSERT OR
   * IGNORE). При грешка нищо не се записва и извикващият НЕ създава масата.
   */
  bindQueueStakesToRoom: (
    roomId: string,
    bindings: ReadonlyArray<{ queueScope: string; profileId: ProfileId }>,
  ) => { ok: true } | { ok: false; message: string }
  /**
   * Етап 3Б.1: при старт — класифицира всеки невърнат queue:<id> вход и
   * връща САМО доказано осиротелите (виж QueueStakeReconciliationReport).
   * Трябва да се вика след възстановяването на активните маси и преди
   * сървърът да приема връзки / да тиктака опашката.
   */
  reconcileOrphanedQueueStakes: (input: {
    activeRooms: ReadonlyArray<{ roomId: string; queueStakes: ReadonlyArray<{ queueScope: string; profileId: ProfileId }> }>
  }) => QueueStakeReconciliationReport
  close: () => void
}

export const MATCHMAKING_STAKE_BINDINGS_MIGRATION = '20261126_002_matchmaking_stake_bindings.sql'

// ─── Етап 3Б.2: регистър на задържаните изплащания ──────────────────────

export type HeldPayoutStatus = 'pending_review' | 'settled_payout' | 'settled_refund' | 'closed_no_action'

export type HeldPayoutReason = 'invalid' | 'stake-mismatch' | 'payout-missing'

export type MissingPayoutDiagnosticReport = {
  /** Завършени платени мачове без winner_payout и без ред в регистъра. */
  found: number
  registered: string[]
  failed: Array<{ matchScope: string; message: string }>
}

export type HeldPayoutParticipant = {
  /** null — случай, възстановен от belot_match_completion_ledger (няма място). */
  seat: (typeof SERVER_SEAT_ORDER)[number] | null
  team: Team
  /** 'unknown' — възстановен от belot_match_completion_ledger. */
  kind: 'human' | 'bot' | 'unknown'
  profileId: ProfileId | null
  stakeLedgerScope: string | null
  isWinner: boolean
}

export type HeldPayoutStakeDebit = { scope: string; profileId: ProfileId; amount: number }

export type HeldPayoutRecord = {
  matchScope: string
  roomId: string
  stakeAmount: number
  rulesVersion: string | null
  holdReason: HeldPayoutReason
  financialTermsJson: string
  winnerTeam: Team
  participants: HeldPayoutParticipant[]
  winners: Array<{ seat: (typeof SERVER_SEAT_ORDER)[number] | null; profileId: ProfileId }>
  stakeDebits: HeldPayoutStakeDebit[]
  context: Record<string, unknown>
}

export type HeldPayoutNotice = { matchScope: string; recorded: true } | { matchScope: string; recorded: false; record: HeldPayoutRecord; error: string }

export type HeldPayoutRow = Omit<HeldPayoutRecord, 'context'> & {
  context: Record<string, unknown>
  status: HeldPayoutStatus
  holdCount: number
  heldAt: string
  lastHeldAt: string
  resolvedAt: string | null
  resolvedBy: string | null
  resolutionNote: string | null
  resolutionPrizePerWinner: number | null
  resolutionEvidence: string | null
}

export type SettleHeldPayoutInput =
  | { matchScope: string; action: 'payout'; prizePerWinner: number; resolvedBy: string; note: string; evidence: string }
  | { matchScope: string; action: 'refund'; resolvedBy: string; note: string; evidence?: string }
  | { matchScope: string; action: 'close'; resolvedBy: string; note: string; evidence?: string }

export type SettleHeldPayoutErrorCode =
  | 'invalid-input'
  | 'not-found'
  | 'not-pending'
  | 'no-recipients'
  | 'prize-exceeds-pot'
  | 'already-paid'
  | 'already-refunded'
  | 'debit-mismatch'
  | 'db-error'

export type SettleHeldPayoutResult =
  | { ok: true; status: HeldPayoutStatus; movements: Array<{ profileId: ProfileId; amount: number; entryType: 'winner_payout' | 'stake_refund'; scope: string }> }
  | { ok: false; code: SettleHeldPayoutErrorCode; message: string }

/** Белот: 4 платени входа — горна граница на общата ръчна награда. */
const BELOT_PAID_ENTRIES = 4

export type QueueStakeItem = {
  queueScope: string
  profileId: ProfileId | null
  amount: number
  debitedAt: string
}

export type QueueStakeAmbiguousReason =
  /** Удържан преди проследяването на връзките — не може да се докаже, че не е използван в мач. */
  | 'pre-tracking-debit'
  /** Няма информация кога е започнало проследяването (миграцията липсва в server_migrations). */
  | 'no-tracking-epoch'
  /** Има връзка към маса, която я няма, а няма и запис за завършен мач. */
  | 'bound-room-missing-without-completion'
  /** Профилът е изтрит (profile_id = NULL) — няма къде да се върне. */
  | 'deleted-profile'

export type QueueStakeReconciliationReport = {
  trackingEpoch: string | null
  refunded: QueueStakeItem[]
  inActiveRoom: QueueStakeItem[]
  consumedByCompletedMatch: QueueStakeItem[]
  ambiguous: Array<QueueStakeItem & { reason: QueueStakeAmbiguousReason }>
  refundFailed: Array<QueueStakeItem & { message: string; kind: 'transient' | 'permanent' }>
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

export type RoomPayoutPrizeResolution =
  | { ok: true; prize: number; source: 'financial-terms' | 'legacy-current-prize' }
  | { ok: false; reason: 'invalid' | 'stake-mismatch' }

/**
 * Етап 3Б: наградата за изплащане.
 *   - валидни room.config.financialTerms → записаната награда (винаги);
 *   - полето ЛИПСВА (историческа маса) → досегашният път (текущото prize_amount);
 *   - полето е налично, но повредено/несъответстващо → ok:false. Текущото
 *     prize_amount НЕ се ползва като резерва; payoutMatchWinners задържа
 *     изплащането без запис в базата.
 */
export function resolveRoomPayoutPrizeAmount(room: ServerRoom, stakeAmount: number): RoomPayoutPrizeResolution {
  const pinned = resolvePinnedBelotPrize(room.config)
  if (pinned.prize !== null) return { ok: true, prize: pinned.prize, source: 'financial-terms' }
  if (pinned.reason === 'missing') return { ok: true, prize: getPrizeAmount(stakeAmount), source: 'legacy-current-prize' }
  return { ok: false, reason: pinned.reason }
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
    | { ok: false; message: string; held?: HeldPayoutNotice } {
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

    const prizeResolution = resolveRoomPayoutPrizeAmount(room, stakeAmount)
    const winningSeatEntries = getWinningSeatEntries(room, winnerTeam)

    if (!prizeResolution.ok) {
      // Задържане: портфейли и ledger не се пипат — няма произволна сума и
      // няма маркиране като платено. Случаят се записва в
      // belot_held_payouts (Етап 3Б.2) за ръчно уреждане.
      const matchScope = getRoomStakeLedgerScope(room)
      console.error(
        `[match-economy] PAYOUT HELD room=${room.id} scope=${matchScope} reason=${prizeResolution.reason}`
          + ` stake=${stakeAmount} winners=${winningSeatEntries.map((entry) => entry.profileId).join(',')}`
          + ` financialTerms=${JSON.stringify(room.config.financialTerms ?? null)}`,
      )
      let record: HeldPayoutRecord | null = null
      let held: HeldPayoutNotice
      try {
        record = buildHeldPayoutRecord(room, stakeAmount, winnerTeam, winningSeatEntries, prizeResolution.reason)
        const recorded = recordHeldPayout(record)
        held = recorded.ok
          ? { matchScope, recorded: true }
          : { matchScope, recorded: false, record, error: recorded.message }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        held = record === null
          ? { matchScope, recorded: false, record: buildMinimalHeldPayoutRecord(room, stakeAmount, winnerTeam, winningSeatEntries, prizeResolution.reason), error: message }
          : { matchScope, recorded: false, record, error: message }
      }
      return {
        ok: false,
        message: `Изплащането е задържано: невалидни финансови условия на масата (${prizeResolution.reason}).`,
        held,
      }
    }

    // Етап 3Б.2: мач, вече регистриран като задържан, се урежда САМО ръчно
    // (settleHeldPayout) — никога автоматично, дори ако условията изглеждат
    // валидни при по-късно извикване.
    try {
      const heldRow = selectHeldPayoutStatusStatement().get(getRoomStakeLedgerScope(room)) as { status: string } | undefined
      if (heldRow !== undefined) {
        return { ok: false, message: `Мачът е в регистъра на задържаните изплащания (status=${heldRow.status}) — урежда се ръчно.` }
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Регистърът на задържаните изплащания не беше прочетен.' }
    }

    const prizeAmount = prizeResolution.prize
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

  function bindQueueStakesToRoom(
    roomId: string,
    bindings: ReadonlyArray<{ queueScope: string; profileId: ProfileId }>,
  ): { ok: true } | { ok: false; message: string } {
    if (bindings.length === 0) return { ok: true }
    try {
      // ON CONFLICT DO NOTHING — игнорира САМО дублирането (идемпотентност);
      // `INSERT OR IGNORE` би пропуснал тихо и ред, нарушаващ CHECK.
      const insertBinding = database.prepare(`
        INSERT INTO matchmaking_stake_bindings (queue_scope, profile_id, room_id)
        VALUES (?, ?, ?)
        ON CONFLICT(queue_scope, profile_id) DO NOTHING;
      `)
      database.exec('BEGIN;')
      for (const binding of bindings) {
        insertBinding.run(binding.queueScope, binding.profileId, roomId)
      }
      database.exec('COMMIT;')
      return { ok: true }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      return { ok: false, message: error instanceof Error ? error.message : 'Връзката вход → маса не беше записана.' }
    }
  }

  function reconcileOrphanedQueueStakes(input: {
    activeRooms: ReadonlyArray<{ roomId: string; queueStakes: ReadonlyArray<{ queueScope: string; profileId: ProfileId }> }>
  }): QueueStakeReconciliationReport {
    const report: QueueStakeReconciliationReport = {
      trackingEpoch: null,
      refunded: [],
      inActiveRoom: [],
      consumedByCompletedMatch: [],
      ambiguous: [],
      refundFailed: [],
    }

    const epochRow = database.prepare(`SELECT applied_at FROM server_migrations WHERE filename = ? LIMIT 1;`)
      .get(MATCHMAKING_STAKE_BINDINGS_MIGRATION) as { applied_at: string } | undefined
    report.trackingEpoch = epochRow?.applied_at ?? null

    const activeRoomIds = new Set(input.activeRooms.map((room) => room.roomId))
    const activeStakeKeys = new Set(
      input.activeRooms.flatMap((room) => room.queueStakes.map((stake) => `${stake.queueScope}\u0000${stake.profileId}`)),
    )

    // Невърнати queue:<id> дебити (range по индекса на room_id вместо LIKE).
    // completed_room = има ли запис за завършен мач на свързаната маса за
    // същия профил.
    const rows = database.prepare(`
      SELECT
        debit.room_id AS queue_scope,
        debit.profile_id AS profile_id,
        debit.amount AS amount,
        debit.created_at AS created_at,
        binding.room_id AS bound_room_id,
        EXISTS (
          SELECT 1 FROM belot_match_completion_ledger AS completion
          WHERE completion.room_id = binding.room_id
            AND completion.profile_id = debit.profile_id
        ) AS has_completion
      FROM match_economy_ledger AS debit
      LEFT JOIN matchmaking_stake_bindings AS binding
        ON binding.queue_scope = debit.room_id
       AND binding.profile_id = debit.profile_id
      WHERE debit.room_id >= 'queue:' AND debit.room_id < 'queue;'
        AND debit.entry_type = 'stake_debit'
        AND NOT EXISTS (
          SELECT 1 FROM match_economy_ledger AS settled
          WHERE settled.room_id = debit.room_id
            AND settled.profile_id IS debit.profile_id
            AND settled.entry_type IN ('stake_refund', 'winner_payout')
        )
      ORDER BY debit.created_at ASC, debit.room_id ASC;
    `).all() as Array<{
      queue_scope: string
      profile_id: ProfileId | null
      amount: number
      created_at: string
      bound_room_id: string | null
      has_completion: number
    }>

    for (const row of rows) {
      const item: QueueStakeItem = {
        queueScope: row.queue_scope,
        profileId: row.profile_id,
        amount: row.amount,
        debitedAt: row.created_at,
      }

      if (row.profile_id === null) {
        report.ambiguous.push({ ...item, reason: 'deleted-profile' })
        continue
      }
      if (activeStakeKeys.has(`${row.queue_scope}\u0000${row.profile_id}`)) {
        report.inActiveRoom.push(item)
        continue
      }
      if (row.bound_room_id !== null) {
        if (activeRoomIds.has(row.bound_room_id)) report.inActiveRoom.push(item)
        else if (row.has_completion === 1) report.consumedByCompletedMatch.push(item)
        else report.ambiguous.push({ ...item, reason: 'bound-room-missing-without-completion' })
        continue
      }
      if (report.trackingEpoch === null) {
        report.ambiguous.push({ ...item, reason: 'no-tracking-epoch' })
        continue
      }
      // Строго СЛЕД прилагането на миграцията: вход от същата секунда може да
      // е от стария процес (без връзки) → не се приема за доказан.
      if (!(row.created_at > report.trackingEpoch)) {
        report.ambiguous.push({ ...item, reason: 'pre-tracking-debit' })
        continue
      }

      // Доказано осиротял: проследяван, без връзка към маса, без активна маса,
      // без refund/payout. Връщане през съществуващия атомарен/идемпотентен път.
      const refund = refundParticipantScopedStake(row.queue_scope, row.profile_id)
      if (!refund.ok) {
        report.refundFailed.push({ ...item, message: refund.message, kind: refund.kind })
      } else if (refund.refunded) {
        report.refunded.push(item)
      }
    }

    return report
  }

  // ─── Етап 3Б.2: регистър на задържаните изплащания ─────────────────────

  let cachedHeldStatusStatement: ReturnType<typeof database.prepare> | null = null
  function selectHeldPayoutStatusStatement(): ReturnType<typeof database.prepare> {
    cachedHeldStatusStatement ??= database.prepare(`SELECT status FROM belot_held_payouts WHERE match_scope = ? LIMIT 1;`)
    return cachedHeldStatusStatement
  }

  function listHeldPayoutParticipants(room: ServerRoom, winnerTeam: Team): HeldPayoutParticipant[] {
    const participants: HeldPayoutParticipant[] = []
    for (const seat of SERVER_SEAT_ORDER) {
      const participant = room.seats[seat].participant
      if (participant === null) continue
      const team = getTeamBySeat(seat)
      const profileId = participant.kind === 'human'
        ? participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
        : participant.botProfileId ?? null
      participants.push({
        seat,
        team,
        kind: participant.kind,
        profileId,
        stakeLedgerScope: participant.kind === 'human' ? participant.stakeLedgerScope ?? null : null,
        isWinner: team === winnerTeam,
      })
    }
    return participants
  }

  function buildMinimalHeldPayoutRecord(
    room: ServerRoom,
    stakeAmount: number,
    winnerTeam: Team,
    winningSeatEntries: WinningSeatEntry[],
    holdReason: 'invalid' | 'stake-mismatch',
  ): HeldPayoutRecord {
    const terms = room.config.financialTerms as unknown
    const rulesVersion = typeof terms === 'object' && terms !== null && typeof (terms as { rulesVersion?: unknown }).rulesVersion === 'string'
      ? (terms as { rulesVersion: string }).rulesVersion
      : null
    return {
      matchScope: getRoomStakeLedgerScope(room),
      roomId: room.id,
      stakeAmount,
      rulesVersion,
      holdReason,
      financialTermsJson: JSON.stringify(terms === undefined ? null : terms),
      winnerTeam,
      participants: listHeldPayoutParticipants(room, winnerTeam),
      winners: winningSeatEntries.map(({ seat, profileId }) => ({ seat, profileId })),
      stakeDebits: [],
      context: {
        isPrivate: room.config.isPrivate,
        isPrivateTableOrigin: room.config.isPrivateTableOrigin === true,
        stateVersion: room.game.stateVersion,
      },
    }
  }

  /**
   * Входовете на ТОЗИ мач (не на предишни „Преиграй“ рундове на същата маса):
   *   - room-scoped дебит с най-голямата версия ≤ текущата stateVersion
   *     (частни маси, ботове, „Преиграй“ — collectRoomStakes/collectBotStakes
   *     вграждат stateVersion в момента на дебита);
   *   - иначе — queue-scoped дебитът на участника (първи мач от опашката).
   */
  function findMatchStakeDebits(room: ServerRoom, participants: HeldPayoutParticipant[]): HeldPayoutStakeDebit[] {
    const prefix = `${room.id}:v`
    const roomDebits = database.prepare(`
      SELECT room_id, profile_id, amount FROM match_economy_ledger
      WHERE room_id LIKE ? ESCAPE '\\' AND entry_type = 'stake_debit';
    `).all(`${escapeSqlLikePattern(room.id)}:v%`) as Array<{ room_id: string; profile_id: ProfileId | null; amount: number }>
    const currentVersion = room.game.stateVersion
    const debits: HeldPayoutStakeDebit[] = []
    for (const participant of participants) {
      if (participant.profileId === null) continue
      let best: { scope: string; version: number; amount: number } | null = null
      for (const row of roomDebits) {
        if (row.profile_id !== participant.profileId) continue
        const version = Number(row.room_id.slice(prefix.length))
        if (!Number.isSafeInteger(version) || version > currentVersion) continue
        if (best === null || version > best.version) best = { scope: row.room_id, version, amount: row.amount }
      }
      if (best !== null) {
        debits.push({ scope: best.scope, profileId: participant.profileId, amount: best.amount })
        continue
      }
      if (participant.stakeLedgerScope !== null) {
        const amount = getLedgerAmount(participant.stakeLedgerScope, participant.profileId, 'stake_debit')
        if (amount !== null) debits.push({ scope: participant.stakeLedgerScope, profileId: participant.profileId, amount })
      }
    }
    return debits
  }

  function buildHeldPayoutRecord(
    room: ServerRoom,
    stakeAmount: number,
    winnerTeam: Team,
    winningSeatEntries: WinningSeatEntry[],
    holdReason: 'invalid' | 'stake-mismatch',
  ): HeldPayoutRecord {
    const record = buildMinimalHeldPayoutRecord(room, stakeAmount, winnerTeam, winningSeatEntries, holdReason)
    return { ...record, stakeDebits: findMatchStakeDebits(room, record.participants) }
  }

  function recordHeldPayout(record: HeldPayoutRecord): { ok: true } | { ok: false; message: string } {
    try {
      // Повторно регистриране: първоначалните доказателства остават; само
      // брояч и последно време. Статусът (вкл. вече уреден) не се пипа.
      database.prepare(`
        INSERT INTO belot_held_payouts (
          match_scope, room_id, stake_amount, rules_version, hold_reason, financial_terms_json,
          winner_team, participants_json, winners_json, stake_debits_json, context_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_scope) DO UPDATE SET
          hold_count = hold_count + 1,
          last_held_at = CURRENT_TIMESTAMP;
      `).run(
        record.matchScope,
        record.roomId,
        record.stakeAmount,
        record.rulesVersion,
        record.holdReason,
        record.financialTermsJson,
        record.winnerTeam,
        JSON.stringify(record.participants),
        JSON.stringify(record.winners),
        JSON.stringify(record.stakeDebits),
        JSON.stringify(record.context),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Задържаното изплащане не беше записано.' }
    }
  }

  function registerHeldPayoutForRestoredRoom(room: ServerRoom): { status: 'not-held' | 'recorded' } | { status: 'failed'; message: string } {
    const stakeAmount = room.config.stakeAmount ?? null
    const winnerTeam = getMatchWinnerTeam(room)
    if (winnerTeam === null || stakeAmount === null || !Number.isInteger(stakeAmount) || stakeAmount <= 0) return { status: 'not-held' }
    if (room.config.isGuestTrial === true || room.config.isTournamentMatchOrigin === true) return { status: 'not-held' }
    const resolution = resolveRoomPayoutPrizeAmount(room, stakeAmount)
    if (resolution.ok) return { status: 'not-held' }
    try {
      const record = buildHeldPayoutRecord(room, stakeAmount, winnerTeam, getWinningSeatEntries(room, winnerTeam), resolution.reason)
      const recorded = recordHeldPayout(record)
      return recorded.ok ? { status: 'recorded' } : { status: 'failed', message: recorded.message }
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
    }
  }

  type HeldPayoutDbRow = {
    match_scope: string; room_id: string; stake_amount: number; rules_version: string | null; hold_reason: HeldPayoutReason
    financial_terms_json: string; winner_team: Team; participants_json: string; winners_json: string; stake_debits_json: string
    context_json: string; status: HeldPayoutStatus; hold_count: number; held_at: string; last_held_at: string
    resolved_at: string | null; resolved_by: string | null; resolution_note: string | null
    resolution_prize_per_winner: number | null; resolution_evidence: string | null
  }

  function toHeldPayoutRow(row: HeldPayoutDbRow): HeldPayoutRow {
    return {
      matchScope: row.match_scope,
      roomId: row.room_id,
      stakeAmount: row.stake_amount,
      rulesVersion: row.rules_version,
      holdReason: row.hold_reason,
      financialTermsJson: row.financial_terms_json,
      winnerTeam: row.winner_team,
      participants: JSON.parse(row.participants_json) as HeldPayoutParticipant[],
      winners: JSON.parse(row.winners_json) as HeldPayoutRecord['winners'],
      stakeDebits: JSON.parse(row.stake_debits_json) as HeldPayoutStakeDebit[],
      context: JSON.parse(row.context_json) as Record<string, unknown>,
      status: row.status,
      holdCount: row.hold_count,
      heldAt: row.held_at,
      lastHeldAt: row.last_held_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNote: row.resolution_note,
      resolutionPrizePerWinner: row.resolution_prize_per_winner,
      resolutionEvidence: row.resolution_evidence,
    }
  }

  function registerMissingPayoutsFromCompletionLedger(): MissingPayoutDiagnosticReport {
    const report: MissingPayoutDiagnosticReport = { found: 0, registered: [], failed: [] }
    // Мачът се брои само ако има поне един победител, когото payoutMatchWinners
    // би изплатил (профил, не временен бот).
    const matches = database.prepare(`
      SELECT DISTINCT completion.match_scope AS match_scope
      FROM belot_match_completion_ledger AS completion
      WHERE completion.did_win = 1
        AND completion.is_guest_trial = 0
        AND completion.stake_amount > 0
        AND completion.profile_id IS NOT NULL
        AND completion.profile_id NOT LIKE 'temp-bot-%'
        AND NOT EXISTS (
          SELECT 1 FROM match_economy_ledger AS payout
          WHERE payout.room_id = completion.match_scope AND payout.entry_type = 'winner_payout'
        )
        AND NOT EXISTS (
          SELECT 1 FROM belot_held_payouts AS held WHERE held.match_scope = completion.match_scope
        )
      ORDER BY completion.match_scope;
    `).all() as Array<{ match_scope: string }>
    report.found = matches.length

    const selectRows = database.prepare(`
      SELECT profile_id, room_id, team, did_win, stake_amount, ended_at
      FROM belot_match_completion_ledger WHERE match_scope = ?;
    `)
    const selectBinding = database.prepare(`
      SELECT queue_scope FROM matchmaking_stake_bindings WHERE room_id = ? AND profile_id = ? LIMIT 1;
    `)

    for (const { match_scope: matchScope } of matches) {
      try {
        const rows = selectRows.all(matchScope) as Array<{
          profile_id: ProfileId | null; room_id: string; team: Team; did_win: number; stake_amount: number; ended_at: string
        }>
        const first = rows[0]!
        const winnerRow = rows.find((row) => row.did_win === 1)!
        const participants: HeldPayoutParticipant[] = rows.map((row) => ({
          seat: null,
          team: row.team,
          kind: 'unknown',
          profileId: row.profile_id,
          stakeLedgerScope: row.profile_id === null
            ? null
            : ((selectBinding.get(row.room_id, row.profile_id) as { queue_scope: string } | undefined)?.queue_scope ?? null),
          isWinner: row.did_win === 1,
        }))
        const versionText = matchScope.slice(`${first.room_id}:v`.length)
        const matchVersion = Number(versionText)
        const pseudoRoom = {
          id: first.room_id,
          game: { stateVersion: Number.isSafeInteger(matchVersion) ? matchVersion : -1 },
        } as unknown as ServerRoom
        const record: HeldPayoutRecord = {
          matchScope,
          roomId: first.room_id,
          stakeAmount: first.stake_amount,
          rulesVersion: null,
          holdReason: 'payout-missing',
          // Условията на масата не са в този източник — не се измислят.
          financialTermsJson: 'null',
          winnerTeam: winnerRow.team,
          participants,
          winners: rows
            .filter((row) => row.did_win === 1 && row.profile_id !== null && !row.profile_id.startsWith('temp-bot-'))
            .map((row) => ({ seat: null, profileId: row.profile_id! })),
          stakeDebits: Number.isSafeInteger(matchVersion) ? findMatchStakeDebits(pseudoRoom, participants) : [],
          context: { source: 'boot-completion-diagnostic', endedAt: first.ended_at, participantsFromCompletionLedger: rows.length },
        }
        const recorded = recordHeldPayout(record)
        if (recorded.ok) report.registered.push(matchScope)
        else report.failed.push({ matchScope, message: recorded.message })
      } catch (error) {
        report.failed.push({ matchScope, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return report
  }

  function getHeldPayout(matchScope: string): HeldPayoutRow | null {
    const row = database.prepare(`SELECT * FROM belot_held_payouts WHERE match_scope = ? LIMIT 1;`).get(matchScope) as HeldPayoutDbRow | undefined
    return row === undefined ? null : toHeldPayoutRow(row)
  }

  function listHeldPayouts(filter: { status?: HeldPayoutStatus } = {}): HeldPayoutRow[] {
    const rows = (filter.status === undefined
      ? database.prepare(`SELECT * FROM belot_held_payouts ORDER BY held_at ASC, match_scope ASC;`).all()
      : database.prepare(`SELECT * FROM belot_held_payouts WHERE status = ? ORDER BY held_at ASC, match_scope ASC;`).all(filter.status)) as HeldPayoutDbRow[]
    return rows.map(toHeldPayoutRow)
  }

  function settleHeldPayout(input: SettleHeldPayoutInput): SettleHeldPayoutResult {
    const fail = (code: SettleHeldPayoutErrorCode, message: string): SettleHeldPayoutResult => ({ ok: false, code, message })
    const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
    if (!nonEmpty(input.matchScope) || !nonEmpty(input.resolvedBy) || !nonEmpty(input.note)) {
      return fail('invalid-input', 'matchScope, resolvedBy и note са задължителни.')
    }
    if (input.action === 'payout') {
      if (!Number.isSafeInteger(input.prizePerWinner) || input.prizePerWinner <= 0) return fail('invalid-input', 'Наградата трябва да е цяло положително число.')
      if (!nonEmpty(input.evidence)) return fail('invalid-input', 'Изплащане изисква описание на доказателството за наградата.')
    }

    // Строг INSERT (без ON CONFLICT) — дублиран ledger ред хвърля и връща
    // цялата транзакция, вместо тихо да кредитира без запис.
    const strictInsertLedger = database.prepare(`
      INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
      VALUES (?, ?, ?, ?, ?, ?);
    `)
    const movements: Array<{ profileId: ProfileId; amount: number; entryType: 'winner_payout' | 'stake_refund'; scope: string }> = []

    try {
      // IMMEDIATE — write lock още от началото: никой друг процес/връзка не
      // може да урежда същия случай паралелно.
      database.exec('BEGIN IMMEDIATE;')
      const row = database.prepare(`SELECT * FROM belot_held_payouts WHERE match_scope = ? LIMIT 1;`).get(input.matchScope) as HeldPayoutDbRow | undefined
      const abort = (code: SettleHeldPayoutErrorCode, message: string): SettleHeldPayoutResult => {
        database.exec('ROLLBACK;')
        return fail(code, message)
      }
      if (row === undefined) return abort('not-found', 'Няма такъв задържан случай.')
      if (row.status !== 'pending_review') return abort('not-pending', `Случаят вече е уреден (status=${row.status}).`)
      const record = toHeldPayoutRow(row)

      const anyPayoutForMatch = (database.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE room_id = ? AND entry_type = 'winner_payout';`)
        .get(record.matchScope) as { n: number }).n > 0
      const anyRefundOfDebits = record.stakeDebits.some((debit) => hasLedgerEntry(debit.scope, debit.profileId, 'stake_refund'))

      if (input.action === 'payout') {
        if (record.winners.length === 0) return abort('no-recipients', 'Няма победители за изплащане — ползвай close или refund.')
        if (input.prizePerWinner * record.winners.length > record.stakeAmount * BELOT_PAID_ENTRIES) {
          return abort('prize-exceeds-pot', `Общата награда надвишава фонда от ${BELOT_PAID_ENTRIES} входа (${record.stakeAmount * BELOT_PAID_ENTRIES}).`)
        }
        if (anyPayoutForMatch) return abort('already-paid', 'За този мач вече има winner_payout в ledger-а.')
        if (anyRefundOfDebits) return abort('already-refunded', 'Вход от този мач вече е възстановен — изплащане не е допустимо.')
        for (const winner of record.winners) {
          ensureWalletStatement.run(winner.profileId)
          creditWalletStatement.run(input.prizePerWinner, winner.profileId)
          strictInsertLedger.run(randomUUID(), record.matchScope, winner.profileId, 'winner_payout', input.prizePerWinner, getWalletBalance(winner.profileId))
          movements.push({ profileId: winner.profileId, amount: input.prizePerWinner, entryType: 'winner_payout', scope: record.matchScope })
        }
      } else if (input.action === 'refund') {
        if (record.stakeDebits.length === 0) return abort('no-recipients', 'Няма записани входове за възстановяване — ползвай close.')
        if (anyPayoutForMatch) return abort('already-paid', 'За този мач вече има winner_payout — възстановяване не е допустимо.')
        if (anyRefundOfDebits) return abort('already-refunded', 'Вход от този мач вече е възстановен.')
        for (const debit of record.stakeDebits) {
          const ledgerAmount = getLedgerAmount(debit.scope, debit.profileId, 'stake_debit')
          if (ledgerAmount === null || ledgerAmount !== debit.amount) {
            return abort('debit-mismatch', `Входът ${debit.scope}/${debit.profileId} не съвпада с ledger-а.`)
          }
          if (hasLedgerEntry(debit.scope, debit.profileId, 'winner_payout')) {
            return abort('already-paid', `За входа ${debit.scope}/${debit.profileId} вече има winner_payout.`)
          }
        }
        for (const debit of record.stakeDebits) {
          ensureWalletStatement.run(debit.profileId)
          creditWalletStatement.run(debit.amount, debit.profileId)
          strictInsertLedger.run(randomUUID(), debit.scope, debit.profileId, 'stake_refund', debit.amount, getWalletBalance(debit.profileId))
          movements.push({ profileId: debit.profileId, amount: debit.amount, entryType: 'stake_refund', scope: debit.scope })
        }
      }

      const nextStatus: HeldPayoutStatus = input.action === 'payout' ? 'settled_payout' : input.action === 'refund' ? 'settled_refund' : 'closed_no_action'
      const update = database.prepare(`
        UPDATE belot_held_payouts SET
          status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ?, resolution_note = ?,
          resolution_prize_per_winner = ?, resolution_evidence = ?
        WHERE match_scope = ? AND status = 'pending_review';
      `).run(
        nextStatus,
        input.resolvedBy.trim(),
        input.note.trim(),
        input.action === 'payout' ? input.prizePerWinner : null,
        input.evidence ?? null,
        input.matchScope,
      ) as { changes?: number }
      if ((update.changes ?? 0) !== 1) return abort('not-pending', 'Статусът се промени по време на уреждането.')

      database.exec('COMMIT;')
      return { ok: true, status: nextStatus, movements }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      return fail('db-error', error instanceof Error ? error.message : 'Уреждането не беше записано.')
    }
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
    bindQueueStakesToRoom,
    reconcileOrphanedQueueStakes,
    recordHeldPayout,
    registerHeldPayoutForRestoredRoom,
    registerMissingPayoutsFromCompletionLedger,
    getHeldPayout,
    listHeldPayouts,
    settleHeldPayout,
    close,
  }
}

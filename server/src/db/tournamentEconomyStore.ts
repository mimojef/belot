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

import { randomInt, randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { dbDateToUtc } from './dbDate.js'
import { verifyPassword as verifyTournamentPassword } from './authHelpers.js'
import { normalizeProfileSearchTerm, escapeSqlLikePattern } from './normalizeProfileIdentityText.js'
import type {
  TournamentEntryJoinedAs,
  TournamentEntryRecord,
  TournamentEntryStatus,
  TournamentId,
  TournamentPartnerInviteId,
  TournamentPartnerInviteRecord,
  TournamentPartnerInviteStatus,
  TournamentRecord,
  TournamentRoundType,
  TournamentStatus,
  TournamentTeamId,
  TournamentTeamRecord,
  TournamentTeamStatus,
  TournamentVisibility,
} from '../tournament/tournamentTypes.js'
import { getTournamentRoundLadder } from '../tournament/tournamentTypes.js'
import {
  calculateTournamentPrizePreview,
  TOURNAMENT_FINANCIAL_RULES_VERSION,
} from '../tournament/tournamentPrizeRules.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

type TournamentLedgerEntryType = 'entry_fee_debit' | 'entry_fee_refund' | 'prize_payout' | 'system_fee'

export type PartnerCandidateRecord = {
  profileId: ProfileId
  displayName: string
  avatarUrl: string | null
  eligible: boolean
  unavailableReason: string | null
}

export type JoinTournamentSoloResult =
  | {
      ok: true
      alreadyJoined: boolean
      /** Реално задебитираната сума в ТОЗИ извикване — undefined при
       * alreadyJoined (idempotent retry, без нов debit). Ползва се за
       * server-authoritative "Платихте входна такса" известие на клиента. */
      debitedAmount?: number
      entry: TournamentEntryRecord
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'tournament_not_open'
        | 'tournament_fill_expired'
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
      // Auto-release (§ "КОГАТО ЕДИНИЯТ PARTNER СЕ ОТПИШЕ") — non-null ТОЧНО
      // когато напускащият е бил в двучленен partner team: partner-ът НЕ
      // остава едночленен team, а е автоматично освободен + refund-нат в
      // СЪЩАТА транзакция (виж leaveTournamentAndRefundAtomically). null за
      // нормален solo leave (никога не е бил в team) И за
      // alreadyRefunded===true (idempotent повторен call — release/refund-ът
      // на partner-а вече е бил committed от оригиналния call, не се
      // преизчислява/дублира тук).
      autoReleasedPartner: { profileId: ProfileId; refundedAmount: number; noticeId: string } | null
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
      /** Per-profile breakdown на refund-натите в ТОЗИ извикване (празно при
       * alreadyCancelled) — ползва се за персонализирани WS известия до
       * всеки реално refund-нат участник, вкл. създателя ако е бил записан. */
      refundedProfiles: Array<{ profileId: ProfileId; amount: number }>
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason: 'tournament_not_found' | 'not_creator' | 'tournament_not_open'
    }

export type StartTournamentResult =
  | {
      ok: true
      alreadyStarted: boolean
      tournament: TournamentRecord
      startedTeams: TournamentTeamRecord[]
      systemFeeAmount: number
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'tournament_not_open'
        | 'not_ready'
        | 'ledger_mismatch'
        | 'invalid_team_state'
    }

export type AutoCancelScheduledTournamentResult =
  | {
      ok: true
      alreadyCancelled: boolean
      refundedEntries: number
      totalRefunded: number
      /** Per-profile breakdown на refund-натите в ТОЗИ извикване (празно при
       * alreadyCancelled) — ползва се за персонализирани WS известия. */
      refundedProfiles: Array<{ profileId: ProfileId; amount: number }>
      tournament: TournamentRecord
    }
  | { ok: false; reason: 'tournament_not_found' | 'tournament_not_open' }

export type SettleTournamentPrizesResult =
  | {
      ok: true
      alreadySettled: boolean
      tournament: TournamentRecord
      championTeamId: TournamentTeamId
      runnerUpTeamId: TournamentTeamId
      payoutRows: number
      totalPrizePaid: number
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'not_ready'
        | 'invalid_final_state'
        | 'invalid_financial_snapshot'
        | 'invalid_recipients'
        | 'ledger_mismatch'
    }

export type PartnerInviteMutationResult =
  | {
      ok: true
      alreadyResolved?: boolean
      /** Реално задебитираната сума на ВИКАЩИЯ профил в ТОЗИ извикване —
       * undefined за decline/cancel, за idempotent resolved покани, и за
       * create-invite от вече confirmed inviter (без нов debit). Само
       * create (inviter) и accept (recipient) някога го задават. */
      debitedAmount?: number
      invite: TournamentPartnerInviteRecord
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'tournament_not_open'
        | 'tournament_fill_expired'
        | 'tournament_full'
        | 'invite_window_closed'
        | 'requires_password'
        | 'not_friend'
        | 'blocked'
        | 'invalid_invitee'
        | 'self_invite'
        | 'already_participant'
        | 'already_participating_elsewhere'
        | 'already_has_pending_invite'
        | 'already_teamed'
        | 'invite_not_found'
        | 'not_invitee'
        | 'not_inviter'
        | 'invite_not_pending'
        | 'insufficient_funds'
        | 'team_invalid'
    }

export type PartnerInviteNotificationStateResult =
  | { ok: true; invite: TournamentPartnerInviteRecord }
  | { ok: false; reason: 'invite_not_found' | 'not_invitee' | 'invite_not_pending' }

export type TournamentEconomyStore = {
  joinTournamentSoloAtomically: (
    tournamentId: TournamentId,
    profileId: ProfileId,
    options?: { password?: string | null; now?: Date },
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
  getPartnerCandidatesForTournament: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
  ) => PartnerCandidateRecord[]
  getGlobalPartnerCandidatesForTournament: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
    normalizedTerm: string,
  ) => PartnerCandidateRecord[]
  listPendingPartnerInvitesForProfile: (
    inviteeProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord[]
  listUndismissedPendingPartnerInvitesForProfile: (
    inviteeProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord[]
  getPendingPartnerLeftNotices: (
    recipientProfileId: ProfileId,
  ) => Array<{ noticeId: string; tournamentId: string; refundedAmount: number }>
  markPartnerLeftNoticeDelivered: (noticeId: string, recipientProfileId: ProfileId) => void
  dismissPartnerInvitePopup: (
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
  ) => PartnerInviteNotificationStateResult
  viewPartnerInviteNotification: (
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
  ) => PartnerInviteNotificationStateResult
  markResolvedInviteNotificationState: (
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord | null
  getOutgoingPendingInviteForProfile: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord | null
  countReservedPendingPlaces: (tournamentId: TournamentId) => number
  createPartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
    inviteeProfileId: ProfileId,
    options?: { password?: string | null; now?: Date },
  ) => PartnerInviteMutationResult
  acceptPartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
    now?: Date,
  ) => PartnerInviteMutationResult
  declinePartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
  ) => PartnerInviteMutationResult
  cancelPartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviteId: TournamentPartnerInviteId,
    inviterProfileId: ProfileId,
  ) => PartnerInviteMutationResult
  expireDuePartnerInvitesAtomically: (tournamentId?: TournamentId) => number
  startTournamentAtomically: (
    tournamentId: TournamentId,
    now: Date,
  ) => StartTournamentResult
  autoCancelScheduledTournamentAtomically: (
    tournamentId: TournamentId,
    now: Date,
    reason: string,
  ) => AutoCancelScheduledTournamentResult
  settleTournamentPrizesAtomically: (
    tournamentId: TournamentId,
    now: Date,
  ) => SettleTournamentPrizesResult
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
  fill_expires_at: string | null
  status: string
  cancel_reason: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  finished_at: string | null
  champion_team_id: string | null
  runner_up_team_id: string | null
  settlement_state: string
  settled_at: string | null
  total_entry_amount: number | null
  system_fee_percent: number | null
  system_fee_amount: number | null
  prize_pool_amount: number | null
  winner_share_percent: number | null
  runner_up_share_percent: number | null
  winner_team_prize_amount: number | null
  runner_up_team_prize_amount: number | null
  winner_player_prize_amount: number | null
  runner_up_player_prize_amount: number | null
  financial_rules_version: string | null
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

type TournamentTeamRow = {
  team_id: string
  tournament_id: string
  status: string
  seed_slot: number | null
  created_at: string
  updated_at: string
}

type TournamentPartnerInviteRow = {
  invite_id: string
  tournament_id: string
  team_id: string
  inviter_profile_id: string
  invitee_profile_id: string
  status: string
  expires_at: string
  popup_dismissed_at: string | null
  notification_read_at: string | null
  created_at: string
  responded_at: string | null
}

type WalletRow = {
  yellow_coins_balance: number
}

type ActiveAccountEntryRow = {
  entry_id: string
}

type ProfileEligibilityRow = {
  profile_id: string
  account_id: string | null
  display_name: string
  avatar_url: string | null
  profile_kind: string
  status: string
  is_temporary: number | null
}

type FinalMatchSettlementRow = {
  match_id: string
  team_a_id: string
  team_b_id: string
  winner_team_id: string | null
  status: string
  result_kind: string | null
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
    fillExpiresAt: row.fill_expires_at !== null ? dbDateToUtc(row.fill_expires_at) : null,
    status: row.status as TournamentStatus,
    cancelReason: row.cancel_reason,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
    startedAt: row.started_at !== null ? dbDateToUtc(row.started_at) : null,
    finishedAt: row.finished_at !== null ? dbDateToUtc(row.finished_at) : null,
    championTeamId: row.champion_team_id,
    runnerUpTeamId: row.runner_up_team_id,
    settlementState: row.settlement_state as TournamentRecord['settlementState'],
    settledAt: row.settled_at !== null ? dbDateToUtc(row.settled_at) : null,
    totalEntryAmount: row.total_entry_amount,
    systemFeePercent: row.system_fee_percent,
    systemFeeAmount: row.system_fee_amount,
    prizePoolAmount: row.prize_pool_amount,
    winnerSharePercent: row.winner_share_percent,
    runnerUpSharePercent: row.runner_up_share_percent,
    winnerTeamPrizeAmount: row.winner_team_prize_amount,
    runnerUpTeamPrizeAmount: row.runner_up_team_prize_amount,
    winnerPlayerPrizeAmount: row.winner_player_prize_amount,
    runnerUpPlayerPrizeAmount: row.runner_up_player_prize_amount,
    financialRulesVersion: row.financial_rules_version,
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

function toTournamentTeamRecord(row: TournamentTeamRow): TournamentTeamRecord {
  return {
    teamId: row.team_id,
    tournamentId: row.tournament_id,
    status: row.status as TournamentTeamStatus,
    seedSlot: row.seed_slot,
    createdAt: dbDateToUtc(row.created_at),
    updatedAt: dbDateToUtc(row.updated_at),
  }
}

function toTournamentPartnerInviteRecord(row: TournamentPartnerInviteRow): TournamentPartnerInviteRecord {
  return {
    inviteId: row.invite_id,
    tournamentId: row.tournament_id,
    teamId: row.team_id,
    inviterProfileId: row.inviter_profile_id,
    inviteeProfileId: row.invitee_profile_id,
    status: row.status as TournamentPartnerInviteStatus,
    expiresAt: dbDateToUtc(row.expires_at),
    popupDismissedAt: row.popup_dismissed_at !== null ? dbDateToUtc(row.popup_dismissed_at) : null,
    notificationReadAt: row.notification_read_at !== null ? dbDateToUtc(row.notification_read_at) : null,
    createdAt: dbDateToUtc(row.created_at),
    respondedAt: row.responded_at !== null ? dbDateToUtc(row.responded_at) : null,
  }
}

function entryFeeDebitKey(tournamentId: TournamentId, profileId: ProfileId): string {
  return `tournament:${tournamentId}:profile:${profileId}:entry-fee-debit`
}

function entryFeeRefundKey(tournamentId: TournamentId, profileId: ProfileId): string {
  return `tournament:${tournamentId}:profile:${profileId}:entry-fee-refund`
}

function entryFeeAttemptKey(baseKey: string, attempt: number): string {
  return attempt <= 1 ? baseKey : `${baseKey}:attempt-${attempt}`
}

function entryFeeDebitKeyForAttempt(
  tournamentId: TournamentId,
  profileId: ProfileId,
  attempt: number,
): string {
  return entryFeeAttemptKey(entryFeeDebitKey(tournamentId, profileId), attempt)
}

function entryFeeRefundKeyForAttempt(
  tournamentId: TournamentId,
  profileId: ProfileId,
  attempt: number,
): string {
  return entryFeeAttemptKey(entryFeeRefundKey(tournamentId, profileId), attempt)
}

function isRejoinableEntryStatus(status: string): boolean {
  return status === 'refunded' || status === 'withdrawn'
}

function systemFeeKey(tournamentId: TournamentId): string {
  return `tournament:${tournamentId}:system-fee:${TOURNAMENT_FINANCIAL_RULES_VERSION}`
}

function prizePayoutKey(
  tournamentId: TournamentId,
  placement: 'winner' | 'runner_up',
  profileId: ProfileId,
): string {
  return `tournament:${tournamentId}:prize:${placement}:${profileId}:${TOURNAMENT_FINANCIAL_RULES_VERSION}`
}

function shuffleInPlace<T>(items: T[]): void {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    const value = items[i]
    items[i] = items[j] as T
    items[j] = value as T
  }
}

function computePartnerInviteExpiresAt(tournament: TournamentRow, nowMs = Date.now()): string | null {
  if (tournament.start_mode === 'fill') {
    return new Date(nowMs + 60 * 60 * 1000).toISOString()
  }
  if (tournament.scheduled_start_at === null) return null
  const scheduledMs = new Date(dbDateToUtc(tournament.scheduled_start_at)).getTime()
  const expiresMs = scheduledMs - 30 * 60 * 1000
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null
  return new Date(expiresMs).toISOString()
}

// Server-authoritative guard: fill-mode турнирите имат фиксиран 1-час
// прозорец (fill_expires_at, виж migration 20260731_001). Между изтичането
// и следващия scheduler tick (до 5 сек, виж tournamentScheduler.ts) статусът
// все още е 'open' — без тази проверка join/invite операциите биха приемали
// нови участници въпреки изтеклия срок. Клиентският часовник никога не
// определя резултата — сравнението е спрямо DB-persisted timestamp и app
// `now`, подаден explicit от caller-а (по подразбиране реално време).
function isFillExpired(tournament: TournamentRow, nowMs: number): boolean {
  if (tournament.start_mode !== 'fill' || tournament.fill_expires_at === null) return false
  return new Date(dbDateToUtc(tournament.fill_expires_at)).getTime() <= nowMs
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
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      cancel_reason, created_at, updated_at, started_at, finished_at,
      champion_team_id, runner_up_team_id, settlement_state, settled_at,
      total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
      winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
      runner_up_team_prize_amount, winner_player_prize_amount,
      runner_up_player_prize_amount, financial_rules_version
    FROM tournaments
    WHERE tournament_id = ?
    LIMIT 1;
  `)

  const selectTournamentForUpdateStatement = database.prepare(`
    SELECT
      tournament_id, kind, name, creator_profile_id, visibility, password_hash,
      entry_fee, player_capacity, start_mode, scheduled_start_at, fill_expires_at, status,
      cancel_reason, created_at, updated_at, started_at, finished_at,
      champion_team_id, runner_up_team_id, settlement_state, settled_at,
      total_entry_amount, system_fee_percent, system_fee_amount, prize_pool_amount,
      winner_share_percent, runner_up_share_percent, winner_team_prize_amount,
      runner_up_team_prize_amount, winner_player_prize_amount,
      runner_up_player_prize_amount, financial_rules_version
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

  const countReservedPendingPlacesStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_partner_invites
    WHERE tournament_id = ? AND status = 'pending';
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
    JOIN tournaments t
      ON t.tournament_id = te.tournament_id
    JOIN profiles entry_profile
      ON entry_profile.profile_id = te.profile_id
    JOIN profiles joining_profile
      ON joining_profile.profile_id = ?
    WHERE te.status IN ('confirmed', 'finalist')
      AND t.status IN ('open', 'starting', 'semifinal_in_progress', 'final_in_progress')
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

  const selectConfirmedEntriesWithDebitLedgerStatement = database.prepare(`
    SELECT te.entry_id, te.profile_id, te.team_id, tel.amount
    FROM tournament_entries te
    LEFT JOIN tournament_economy_ledger tel
      ON tel.ledger_id = (
        SELECT latest_tel.ledger_id
        FROM tournament_economy_ledger latest_tel
        WHERE latest_tel.tournament_id = te.tournament_id
          AND latest_tel.profile_id = te.profile_id
          AND latest_tel.entry_type = 'entry_fee_debit'
        ORDER BY latest_tel.created_at DESC, latest_tel.ledger_id DESC
        LIMIT 1
      )
    WHERE te.tournament_id = ? AND te.status = 'confirmed'
    ORDER BY te.created_at ASC;
  `)

  const selectEntryDebitLedgerRowsStatement = database.prepare(`
    SELECT profile_id, amount
    FROM tournament_economy_ledger
    WHERE tournament_id = ? AND entry_type = 'entry_fee_debit'
    ORDER BY profile_id ASC;
  `)

  const selectSystemFeeLedgerRowsStatement = database.prepare(`
    SELECT profile_id, amount
    FROM tournament_economy_ledger
    WHERE tournament_id = ? AND entry_type = 'system_fee';
  `)

  const selectPrizePayoutLedgerRowsStatement = database.prepare(`
    SELECT profile_id, amount, idempotency_key
    FROM tournament_economy_ledger
    WHERE tournament_id = ? AND entry_type = 'prize_payout'
    ORDER BY idempotency_key ASC;
  `)

  const selectConfirmedParticipationDuplicateRowsStatement = database.prepare(`
    SELECT COALESCE(p.account_id, te.profile_id) as participant_key, COUNT(*) as count
    FROM tournament_entries te
    JOIN profiles p ON p.profile_id = te.profile_id
    WHERE te.tournament_id = ? AND te.status = 'confirmed'
    GROUP BY COALESCE(p.account_id, te.profile_id)
    HAVING COUNT(*) > 1
    LIMIT 1;
  `)

  const selectTeamByIdStatement = database.prepare(`
    SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
    FROM tournament_teams
    WHERE team_id = ?
    LIMIT 1;
  `)

  const selectTeamsForTournamentStatement = database.prepare(`
    SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
    FROM tournament_teams
    WHERE tournament_id = ?
    ORDER BY created_at ASC;
  `)

  const selectEntriesForTeamStatement = database.prepare(`
    SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
           created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE team_id = ?
    ORDER BY created_at ASC;
  `)

  const selectFinalMatchForSettlementStatement = database.prepare(`
    SELECT tm.match_id, tm.team_a_id, tm.team_b_id, tm.winner_team_id, tm.status, tm.result_kind
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
      AND tr.round_type = 'final'
      AND tr.round_index = 1
    LIMIT 1;
  `)

  const selectConfirmedEntriesForTeamStatement = database.prepare(`
    SELECT entry_id, tournament_id, profile_id, team_id, joined_as, status,
           created_at, updated_at, withdrawn_at, refunded_at
    FROM tournament_entries
    WHERE team_id = ? AND status = 'confirmed'
    ORDER BY created_at ASC;
  `)

  const selectPendingInviteByIdStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE invite_id = ? AND tournament_id = ?
    LIMIT 1;
  `)

  const selectPendingOutgoingInviteStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE tournament_id = ? AND inviter_profile_id = ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1;
  `)

  const selectPendingInvitesForProfileStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE invitee_profile_id = ? AND status = 'pending'
    ORDER BY created_at DESC;
  `)

  const selectUndismissedPendingInvitesForProfileStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE invitee_profile_id = ?
      AND status = 'pending'
      AND popup_dismissed_at IS NULL
    ORDER BY created_at ASC;
  `)

  const selectPartnerInviteByInviteIdStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE invite_id = ?
    LIMIT 1;
  `)

  const selectDuePendingInvitesStatement = database.prepare(`
    SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
           status, expires_at, popup_dismissed_at, notification_read_at, created_at,
           responded_at
    FROM tournament_partner_invites
    WHERE status = 'pending'
      AND datetime(expires_at) <= CURRENT_TIMESTAMP
      AND (? IS NULL OR tournament_id = ?)
    ORDER BY expires_at ASC;
  `)

  // Durable "партньорът ти се отписа" известие (§ "PARTNER-LEFT NOTIFICATION
  // ТРЯБВА Е DURABLE") — огледално на gift_notification_log
  // (yellowCoinGiftStore.ts): insert вътре в leave transaction-а веднага след
  // committed auto-release refund, delivered_at маркира реалната доставка
  // (online push ИЛИ login flush), не insert момента. INSERT OR IGNORE прави
  // insert-а idempotent при notice_id, детерминиран от освободения entry_id.
  const insertPartnerLeftNoticeStatement = database.prepare(`
    INSERT OR IGNORE INTO tournament_partner_left_notice_log
      (notice_id, tournament_id, recipient_profile_id, refunded_amount)
    VALUES (?, ?, ?, ?);
  `)

  const selectPendingPartnerLeftNoticesStatement = database.prepare(`
    SELECT notice_id, tournament_id, refunded_amount
    FROM tournament_partner_left_notice_log
    WHERE recipient_profile_id = ? AND delivered_at IS NULL
    ORDER BY created_at ASC;
  `)

  const markPartnerLeftNoticeDeliveredStatement = database.prepare(`
    UPDATE tournament_partner_left_notice_log
    SET delivered_at = CURRENT_TIMESTAMP
    WHERE notice_id = ? AND recipient_profile_id = ? AND delivered_at IS NULL;
  `)

  const insertTeamStatement = database.prepare(`
    INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
    VALUES (?, ?, 'forming', NULL);
  `)

  const insertLockedTeamStatement = database.prepare(`
    INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
    VALUES (?, ?, 'locked', ?);
  `)

  const updateTeamStatusStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE team_id = ? AND tournament_id = ?;
  `)

  const lockTeamWithSeedStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = 'locked', seed_slot = ?, updated_at = CURRENT_TIMESTAMP
    WHERE team_id = ? AND tournament_id = ? AND status IN ('complete', 'locked');
  `)

  const deleteTeamStatement = database.prepare(`
    DELETE FROM tournament_teams
    WHERE team_id = ? AND tournament_id = ?;
  `)

  const deleteTeamsForTournamentStatement = database.prepare(`
    DELETE FROM tournament_teams
    WHERE tournament_id = ?;
  `)

  const insertPartnerInviteStatement = database.prepare(`
    INSERT INTO tournament_partner_invites (
      invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  const resolvePartnerInviteStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET status = ?, responded_at = CURRENT_TIMESTAMP
    WHERE invite_id = ? AND tournament_id = ? AND status = 'pending';
  `)

  const dismissPartnerInvitePopupStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET popup_dismissed_at = COALESCE(popup_dismissed_at, CURRENT_TIMESTAMP)
    WHERE invite_id = ? AND invitee_profile_id = ? AND status = 'pending';
  `)

  const viewPartnerInviteNotificationStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET popup_dismissed_at = COALESCE(popup_dismissed_at, CURRENT_TIMESTAMP),
        notification_read_at = COALESCE(notification_read_at, CURRENT_TIMESTAMP)
    WHERE invite_id = ? AND invitee_profile_id = ? AND status = 'pending';
  `)

  const markInviteeResolvedNotificationStateStatement = database.prepare(`
    UPDATE tournament_partner_invites
    SET popup_dismissed_at = COALESCE(popup_dismissed_at, CURRENT_TIMESTAMP),
        notification_read_at = COALESCE(notification_read_at, CURRENT_TIMESTAMP)
    WHERE invite_id = ? AND invitee_profile_id = ?;
  `)

  const updateEntryToPartnerInviterStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = ?, joined_as = 'partner_inviter', updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
  `)

  const reactivateEntryAsPartnerInviterStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = ?, joined_as = 'partner_inviter', status = 'confirmed',
        withdrawn_at = NULL, refunded_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status IN ('refunded', 'withdrawn');
  `)

  const updateEntryToSoloStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = NULL, joined_as = 'solo', updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
  `)

  const assignEntryToTeamStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = ?, joined_as = 'solo', updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND tournament_id = ? AND status = 'confirmed';
  `)

  const reactivateEntryAsPartnerInviteeStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = ?, joined_as = 'partner_invitee', status = 'confirmed',
        withdrawn_at = NULL, refunded_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND tournament_id = ? AND status IN ('refunded', 'withdrawn');
  `)

  const insertPartnerInviteeEntryStatement = database.prepare(`
    INSERT INTO tournament_entries (
      entry_id, tournament_id, profile_id, team_id, joined_as, status
    ) VALUES (?, ?, ?, ?, 'partner_invitee', 'confirmed');
  `)

  const selectConfirmedFriendshipStatement = database.prepare(`
    SELECT 1 as found
    FROM profile_friendships
    WHERE status = 'accepted'
      AND (
        (requester_profile_id = ? AND addressee_profile_id = ?)
        OR (requester_profile_id = ? AND addressee_profile_id = ?)
      )
    LIMIT 1;
  `)

  const selectProfileEligibilityStatement = database.prepare(`
    SELECT profile_id, account_id, display_name, avatar_url, profile_kind, status, is_temporary
    FROM profiles
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const selectAcceptedFriendsStatement = database.prepare(`
    SELECT p.profile_id, p.account_id, p.display_name, p.avatar_url, p.profile_kind, p.status, p.is_temporary
    FROM profile_friendships f
    JOIN profiles p
      ON p.profile_id = CASE
        WHEN f.requester_profile_id = ? THEN f.addressee_profile_id
        ELSE f.requester_profile_id
      END
    WHERE f.status = 'accepted'
      AND (f.requester_profile_id = ? OR f.addressee_profile_id = ?)
    ORDER BY lower(p.display_name) ASC;
  `)

  // Global partner search (§ "GLOBAL SEARCH AREA") — reuse-ва точно същия
  // normalized_display_name + LIKE ESCAPE '\\' pattern и exact/prefix/substring
  // ranking като searchPublicProfilesStatement в playerProgressStore.ts (GET
  // /api/players/search), но САМО за profile_kind='human' профили (ботовете
  // не са валидни tournament partner-и — getCandidateUnavailableReason би ги
  // отхвърлил и без това с 'not_registered_human') и изключва directly
  // inviterProfileId в SQL-а (self не трябва дори да се появи в резултатите,
  // не само да бъде markнат unavailable). Разчита на СЪЩИТЕ profiles колони
  // като selectProfileEligibilityStatement/selectAcceptedFriendsStatement, за
  // да може getCandidateUnavailableReason по-долу да остане единствения
  // eligibility chokepoint за и трите candidate sources (friends/global
  // search/direct invite).
  const searchGlobalPartnerCandidatesStatement = database.prepare(`
    SELECT p.profile_id, p.account_id, p.display_name, p.avatar_url, p.profile_kind, p.status, p.is_temporary
    FROM profiles p
    WHERE p.status = 'active'
      AND p.is_temporary = 0
      AND p.profile_kind = 'human'
      AND p.account_id IS NOT NULL
      AND p.profile_id != ?
      AND p.normalized_display_name LIKE ? ESCAPE '\\'
    ORDER BY
      CASE
        WHEN p.normalized_display_name = ? THEN 0
        WHEN p.normalized_display_name LIKE ? ESCAPE '\\' THEN 1
        ELSE 2
      END,
      p.normalized_display_name ASC,
      p.profile_id ASC
    LIMIT 20;
  `)

  const selectBlockStatement = database.prepare(`
    SELECT 1 as found
    FROM player_blocks
    WHERE (blocker_profile_id = ? AND blocked_profile_id = ?)
       OR (blocker_profile_id = ? AND blocked_profile_id = ?)
    LIMIT 1;
  `)

  const insertEntryStatement = database.prepare(`
    INSERT INTO tournament_entries (
      entry_id, tournament_id, profile_id, team_id, joined_as, status
    ) VALUES (?, ?, ?, NULL, 'solo', 'confirmed');
  `)

  const reactivateEntryAsSoloStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = NULL, joined_as = 'solo', status = 'confirmed',
        withdrawn_at = NULL, refunded_at = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status IN ('refunded', 'withdrawn');
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

  const insertSystemFeeLedgerStatement = database.prepare(`
    INSERT INTO tournament_economy_ledger (
      ledger_id, idempotency_key, tournament_id, profile_id, entry_type, amount, balance_after,
      metadata_json
    ) VALUES (?, ?, ?, NULL, 'system_fee', ?, NULL, ?)
    ON CONFLICT(idempotency_key) DO NOTHING;
  `)

  const selectLedgerByKeyStatement = database.prepare(`
    SELECT ledger_id, amount
    FROM tournament_economy_ledger
    WHERE idempotency_key = ?
    LIMIT 1;
  `)

  const countEntryFeeLedgerByTypeStatement = database.prepare(`
    SELECT COUNT(*) as count
    FROM tournament_economy_ledger
    WHERE tournament_id = ?
      AND profile_id = ?
      AND entry_type = ?;
  `)

  const updateTournamentStartedStatement = database.prepare(`
    UPDATE tournaments
    SET status = 'starting',
        started_at = ?,
        updated_at = ?,
        total_entry_amount = ?,
        system_fee_percent = ?,
        system_fee_amount = ?,
        prize_pool_amount = ?,
        winner_share_percent = ?,
        runner_up_share_percent = ?,
        winner_team_prize_amount = ?,
        runner_up_team_prize_amount = ?,
        winner_player_prize_amount = ?,
        runner_up_player_prize_amount = ?,
        financial_rules_version = ?
    WHERE tournament_id = ? AND status = 'open';
  `)

  const updateTournamentAutoCancelledStatement = database.prepare(`
    UPDATE tournaments
    SET status = 'auto_cancelled',
        cancel_reason = ?,
        updated_at = ?
    WHERE tournament_id = ? AND status = 'open';
  `)

  const updateTournamentSettledStatement = database.prepare(`
    UPDATE tournaments
    SET status = 'finished',
        champion_team_id = ?,
        runner_up_team_id = ?,
        settlement_state = 'settled',
        settled_at = ?,
        finished_at = ?,
        updated_at = ?
    WHERE tournament_id = ?
      AND status = 'final_in_progress'
      AND settlement_state = 'pending';
  `)

  // round_type е bind параметър (не литерал) — за да поддържа generic
  // bracket ladder-а (round_of_16/quarterfinal/semifinal/final, виж
  // getTournamentRoundLadder в tournamentTypes.ts).
  const insertRoundStatement = database.prepare(`
    INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tournament_id, round_type, round_index) DO NOTHING;
  `)

  const selectRoundIdStatement = database.prepare(`
    SELECT round_id
    FROM tournament_rounds
    WHERE tournament_id = ? AND round_type = ? AND round_index = ?
    LIMIT 1;
  `)

  const insertMatchStatement = database.prepare(`
    INSERT INTO tournament_matches (
      match_id, tournament_id, round_id, room_id, team_a_id, team_b_id,
      status, no_show_deadline_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'awaiting_players', NULL);
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

  function countEntryFeeLedgerRows(
    tournamentId: TournamentId,
    profileId: ProfileId,
    entryType: 'entry_fee_debit' | 'entry_fee_refund',
  ): number {
    return (countEntryFeeLedgerByTypeStatement.get(tournamentId, profileId, entryType) as {
      count: number
    }).count
  }

  function nextEntryFeeDebitAttempt(tournamentId: TournamentId, profileId: ProfileId): number {
    return countEntryFeeLedgerRows(tournamentId, profileId, 'entry_fee_debit') + 1
  }

  function currentEntryFeeAttempt(tournamentId: TournamentId, profileId: ProfileId): number {
    return Math.max(1, countEntryFeeLedgerRows(tournamentId, profileId, 'entry_fee_debit'))
  }

  function getCurrentEntryFeeDebitLedger(
    tournamentId: TournamentId,
    profileId: ProfileId,
  ): { ledgerId: string; amount: number } | null {
    return getLedgerByKey(
      entryFeeDebitKeyForAttempt(tournamentId, profileId, currentEntryFeeAttempt(tournamentId, profileId)),
    )
  }

  function getCurrentEntryFeeRefundLedger(
    tournamentId: TournamentId,
    profileId: ProfileId,
  ): { ledgerId: string; amount: number } | null {
    return getLedgerByKey(
      entryFeeRefundKeyForAttempt(tournamentId, profileId, currentEntryFeeAttempt(tournamentId, profileId)),
    )
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

  function isConfirmedFriend(leftProfileId: ProfileId, rightProfileId: ProfileId): boolean {
    return selectConfirmedFriendshipStatement.get(
      leftProfileId,
      rightProfileId,
      rightProfileId,
      leftProfileId,
    ) !== undefined
  }

  function hasBlockBetween(leftProfileId: ProfileId, rightProfileId: ProfileId): boolean {
    return selectBlockStatement.get(
      leftProfileId,
      rightProfileId,
      rightProfileId,
      leftProfileId,
    ) !== undefined
  }

  function getReservedPendingPlaces(tournamentId: TournamentId): number {
    return (countReservedPendingPlacesStatement.get(tournamentId) as { count: number }).count
  }

  function getOccupiedPlaces(tournamentId: TournamentId): number {
    const confirmed = (countConfirmedEntriesStatement.get(tournamentId) as { count: number }).count
    return confirmed + getReservedPendingPlaces(tournamentId)
  }

  function resetFormingTeamToSolo(
    tournamentId: TournamentId,
    teamId: TournamentTeamId,
    inviterProfileId: ProfileId,
  ): void {
    const inviterEntry = selectEntryByTournamentAndProfileStatement.get(
      tournamentId,
      inviterProfileId,
    ) as TournamentEntryRow | undefined
    if (inviterEntry !== undefined && inviterEntry.status === 'confirmed') {
      updateEntryToSoloStatement.run(inviterEntry.entry_id)
    }
    deleteTeamStatement.run(teamId, tournamentId)
  }

  function expireDuePartnerInvitesInCurrentTransaction(tournamentId?: TournamentId): number {
    const tournamentParam = tournamentId ?? null
    const rows = selectDuePendingInvitesStatement.all(
      tournamentParam,
      tournamentParam,
    ) as TournamentPartnerInviteRow[]
    let expired = 0
    for (const invite of rows) {
      const result = resolvePartnerInviteStatement.run(
        'expired',
        invite.invite_id,
        invite.tournament_id,
      ) as { changes?: number }
      if ((result.changes ?? 0) === 0) continue
      resetFormingTeamToSolo(invite.tournament_id, invite.team_id, invite.inviter_profile_id)
      insertEvent(invite.tournament_id, 'partner_invite_expired', null, 'system', {
        inviteId: invite.invite_id,
        teamId: invite.team_id,
      })
      expired += 1
    }
    return expired
  }

  function getInviteById(
    tournamentId: TournamentId,
    inviteId: TournamentPartnerInviteId,
  ): TournamentPartnerInviteRecord | null {
    const row = selectPendingInviteByIdStatement.get(inviteId, tournamentId) as
      | TournamentPartnerInviteRow
      | undefined
    return row ? toTournamentPartnerInviteRecord(row) : null
  }

  function getCandidateUnavailableReason(
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
    candidate: ProfileEligibilityRow,
  ): string | null {
    if (candidate.profile_id === inviterProfileId) return 'self'
    if (candidate.profile_kind !== 'human' || candidate.status !== 'active' || candidate.account_id === null) {
      return 'not_registered_human'
    }
    if (candidate.is_temporary === 1) return 'temporary'
    // Friends-only prerequisite-ът е премахнат тук (беше: isConfirmedFriend
    // gate, връщащ not-friend reason) — вече ВСЕКИ eligible
    // registered human profile може да бъде поканен, не само confirmed
    // friends. Discovery продължава да предлага два независими source-а
    // (friends list чрез getPartnerCandidatesForTournament, global search
    // чрез getGlobalPartnerCandidatesForTournament), но и двата — както и
    // директно forged invite request — минават през ТОЗИ единствен
    // eligibility chokepoint, така че server-ът остава authoritative
    // независимо кой source е "предложил" кандидата на клиента.
    if (hasBlockBetween(inviterProfileId, candidate.profile_id)) return 'blocked'
    const existingEntry = selectEntryByTournamentAndProfileStatement.get(
      tournamentId,
      candidate.profile_id,
    ) as TournamentEntryRow | undefined
    if (
      existingEntry !== undefined &&
      (existingEntry.status === 'confirmed' || !isRejoinableEntryStatus(existingEntry.status))
    ) {
      return 'already_in_tournament'
    }
    const activeAccountEntry = selectActiveEntryForAccountStatement.get(
      candidate.profile_id,
    ) as ActiveAccountEntryRow | undefined
    if (activeAccountEntry !== undefined) return 'active_tournament'
    return null
  }

  function validateInvitee(
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
    inviteeProfileId: ProfileId,
  ): PartnerInviteMutationResult | null {
    if (inviterProfileId === inviteeProfileId) return { ok: false, reason: 'self_invite' }
    const invitee = selectProfileEligibilityStatement.get(inviteeProfileId) as
      | ProfileEligibilityRow
      | undefined
    if (invitee === undefined) return { ok: false, reason: 'invalid_invitee' }
    const reason = getCandidateUnavailableReason(tournamentId, inviterProfileId, invitee)
    if (reason === null) return null
    if (reason === 'blocked') return { ok: false, reason: 'blocked' }
    if (reason === 'already_in_tournament') return { ok: false, reason: 'already_participant' }
    if (reason === 'active_tournament') return { ok: false, reason: 'already_participating_elsewhere' }
    return { ok: false, reason: 'invalid_invitee' }
  }

  function expireDuePartnerInvitesAtomicallyLocal(tournamentId?: TournamentId): number {
    try {
      database.exec('BEGIN IMMEDIATE;')
      const expired = expireDuePartnerInvitesInCurrentTransaction(tournamentId)
      database.exec('COMMIT;')
      return expired
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // keep original error
      }
      throw error
    }
  }

  function getStartedTournamentResult(
    tournamentId: TournamentId,
    alreadyStarted: boolean,
  ): StartTournamentResult {
    const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
    const teams = (selectTeamsForTournamentStatement.all(tournamentId) as TournamentTeamRow[])
      .map(toTournamentTeamRecord)
    return {
      ok: true,
      alreadyStarted,
      tournament: toTournamentRecord(tournament),
      startedTeams: teams,
      systemFeeAmount: tournament.system_fee_amount ?? 0,
    }
  }

  // teamCapacity = tournament.player_capacity / 2 (4/8/16 отбора, виж §5 в
  // task spec-а). Пълният брой отбори е единственото, което се проверява
  // тук — самото bracket pairing (кой отбор играе с кого) се решава в
  // createFirstRoundBracket() след shuffle-а по-долу.
  function validateAndLockTeamsForStart(
    tournamentId: TournamentId,
    teamCapacity: number,
  ): { ok: true; teams: TournamentTeamRow[]; seedSnapshot: Record<string, string[]> } | { ok: false } {
    const entries = selectConfirmedEntriesStatement.all(tournamentId) as TournamentEntryRow[]
    const teams = selectTeamsForTournamentStatement.all(tournamentId) as TournamentTeamRow[]
    const completeTeams: TournamentTeamRow[] = []
    const assignedEntryIds = new Set<string>()

    for (const team of teams) {
      const members = (selectEntriesForTeamStatement.all(team.team_id) as TournamentEntryRow[])
        .filter((entry) => entry.status === 'confirmed')
      if (members.length === 0 && team.status === 'forming') {
        deleteTeamStatement.run(team.team_id, tournamentId)
        continue
      }
      if (members.length === 2 && (team.status === 'complete' || team.status === 'locked')) {
        completeTeams.push(team)
        for (const member of members) assignedEntryIds.add(member.entry_id)
        continue
      }
      if (members.length > 0) return { ok: false }
    }

    const soloEntries = entries.filter((entry) => entry.team_id === null || !assignedEntryIds.has(entry.entry_id))
    if (soloEntries.length % 2 !== 0) return { ok: false }
    shuffleInPlace(soloEntries)

    for (let i = 0; i < soloEntries.length; i += 2) {
      const first = soloEntries[i]
      const second = soloEntries[i + 1]
      if (first === undefined || second === undefined) return { ok: false }
      const teamId = randomUUID()
      insertLockedTeamStatement.run(teamId, tournamentId, null)
      assignEntryToTeamStatement.run(teamId, first.entry_id, tournamentId)
      assignEntryToTeamStatement.run(teamId, second.entry_id, tournamentId)
      const row = selectTeamByIdStatement.get(teamId) as TournamentTeamRow
      completeTeams.push(row)
    }

    if (completeTeams.length !== teamCapacity) return { ok: false }
    shuffleInPlace(completeTeams)

    const seedSnapshot: Record<string, string[]> = {}
    for (let i = 0; i < completeTeams.length; i += 1) {
      const seedSlot = i + 1
      const team = completeTeams[i] as TournamentTeamRow
      lockTeamWithSeedStatement.run(seedSlot, team.team_id, tournamentId)
      team.status = 'locked'
      team.seed_slot = seedSlot
      seedSnapshot[String(seedSlot)] = (selectEntriesForTeamStatement.all(team.team_id) as TournamentEntryRow[])
        .filter((entry) => entry.status === 'confirmed')
        .map((entry) => entry.profile_id)
    }

    return { ok: true, teams: completeTeams, seedSnapshot }
  }

  // Генерира първия bracket кръг (round_of_16/quarterfinal/semifinal —
  // винаги first ladder entry за дадения teamCapacity, виж
  // getTournamentRoundLadder). High-vs-low seed pairing: seed[i] срещу
  // seed[N-1-i] за i=0..N/2-1 — за 4 отбора: 1-4, 2-3 (= "A-D, B-C" в
  // task spec-а, тъй като Отбор A/B/C/D е derived от seed reда на
  // frontend-а). За 8: 1-8,2-7,3-6,4-5. За 16: 1-16,2-15,...,8-9.
  // Самите seed слотове вече идват от random shuffle (виж
  // validateAndLockTeamsForStart), затова "high vs low" тук не носи
  // competitive ranking семантика — само детерминира bracket структурата
  // от вече разбъркания seed ред.
  function createFirstRoundBracket(tournamentId: TournamentId, teams: TournamentTeamRow[]): void {
    const teamCapacity = teams.length
    const roundType = getTournamentRoundLadder(teamCapacity)[0] as TournamentRoundType
    const bySeed = new Map<number, string>()
    for (const team of teams) {
      if (team.seed_slot !== null) bySeed.set(team.seed_slot, team.team_id)
    }

    const matchCount = teamCapacity / 2
    for (let matchIndex = 0; matchIndex < matchCount; matchIndex += 1) {
      const roundIndex = matchIndex + 1
      const highSeed = bySeed.get(matchIndex + 1)
      const lowSeed = bySeed.get(teamCapacity - matchIndex)
      if (!highSeed || !lowSeed) throw new Error('Missing tournament seed slots.')
      insertRoundStatement.run(randomUUID(), tournamentId, roundType, roundIndex)
      const round = selectRoundIdStatement.get(tournamentId, roundType, roundIndex) as { round_id: string }
      insertMatchStatement.run(randomUUID(), tournamentId, round.round_id, highSeed, lowSeed)
    }
  }

  function startTournamentAtomicallyLocal(
    tournamentId: TournamentId,
    now: Date,
  ): StartTournamentResult {
    const nowIso = now.toISOString()
    try {
      database.exec('BEGIN IMMEDIATE;')
      expireDuePartnerInvitesInCurrentTransaction(tournamentId)

      const tournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow | undefined
      if (tournament === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_found' }
      }
      if (tournament.status !== 'open') {
        database.exec('ROLLBACK;')
        if (
          tournament.status === 'starting' ||
          tournament.status === 'semifinal_in_progress' ||
          tournament.status === 'final_in_progress' ||
          tournament.status === 'finished'
        ) {
          return getStartedTournamentResult(tournamentId, true)
        }
        return { ok: false, reason: 'tournament_not_open' }
      }

      const confirmedEntries = selectConfirmedEntriesWithDebitLedgerStatement.all(tournamentId) as {
        entry_id: string
        profile_id: string
        team_id: string | null
        amount: number | null
      }[]
      if (confirmedEntries.length !== tournament.player_capacity || getReservedPendingPlaces(tournamentId) !== 0) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_ready' }
      }
      if (selectConfirmedParticipationDuplicateRowsStatement.get(tournamentId) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_team_state' }
      }
      const ledgerTotal = confirmedEntries.reduce((sum, entry) => {
        if (entry.amount !== tournament.entry_fee) return Number.NaN
        return sum + entry.amount
      }, 0)
      if (!Number.isFinite(ledgerTotal) || ledgerTotal !== tournament.entry_fee * tournament.player_capacity) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'ledger_mismatch' }
      }

      const teamResult = validateAndLockTeamsForStart(tournamentId, tournament.player_capacity / 2)
      if (!teamResult.ok) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_team_state' }
      }

      const preview = calculateTournamentPrizePreview(tournament.entry_fee, tournament.player_capacity)
      if (preview.totalEntryFees !== ledgerTotal) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'ledger_mismatch' }
      }

      insertSystemFeeLedgerStatement.run(
        randomUUID(),
        systemFeeKey(tournamentId),
        tournamentId,
        preview.systemFee,
        JSON.stringify({
          totalEntryAmount: preview.totalEntryFees,
          systemFeePercent: preview.systemFeePercent,
          prizePoolAmount: preview.prizePool,
          winnerSharePercent: preview.winnerSharePercent,
          runnerUpSharePercent: preview.runnerUpSharePercent,
          financialRulesVersion: preview.financialRulesVersion,
        }),
      )

      updateTournamentStartedStatement.run(
        nowIso,
        nowIso,
        preview.totalEntryFees,
        preview.systemFeePercent,
        preview.systemFee,
        preview.prizePool,
        preview.winnerSharePercent,
        preview.runnerUpSharePercent,
        preview.firstTeamPrize,
        preview.secondTeamPrize,
        preview.firstPlayerPrize,
        preview.secondPlayerPrize,
        preview.financialRulesVersion,
        tournamentId,
      )
      createFirstRoundBracket(tournamentId, teamResult.teams)
      insertEvent(tournamentId, 'tournament_started', null, 'system', {
        financial: preview,
        teamSeeds: teamResult.seedSnapshot,
      })
      database.exec('COMMIT;')
      return getStartedTournamentResult(tournamentId, false)
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }
  }

  function validateFinancialSnapshot(tournament: TournamentRow): boolean {
    if (
      tournament.financial_rules_version !== TOURNAMENT_FINANCIAL_RULES_VERSION ||
      (tournament.player_capacity !== 8 && tournament.player_capacity !== 16 && tournament.player_capacity !== 32) ||
      tournament.total_entry_amount === null ||
      tournament.system_fee_percent === null ||
      tournament.system_fee_amount === null ||
      tournament.prize_pool_amount === null ||
      tournament.winner_share_percent === null ||
      tournament.runner_up_share_percent === null ||
      tournament.winner_team_prize_amount === null ||
      tournament.runner_up_team_prize_amount === null ||
      tournament.winner_player_prize_amount === null ||
      tournament.runner_up_player_prize_amount === null
    ) {
      return false
    }
    const preview = calculateTournamentPrizePreview(tournament.entry_fee, tournament.player_capacity)
    return (
      preview.financialRulesVersion === tournament.financial_rules_version &&
      preview.totalEntryFees === tournament.total_entry_amount &&
      preview.systemFeePercent === tournament.system_fee_percent &&
      preview.systemFee === tournament.system_fee_amount &&
      preview.prizePool === tournament.prize_pool_amount &&
      preview.winnerSharePercent === tournament.winner_share_percent &&
      preview.runnerUpSharePercent === tournament.runner_up_share_percent &&
      preview.firstTeamPrize === tournament.winner_team_prize_amount &&
      preview.secondTeamPrize === tournament.runner_up_team_prize_amount &&
      preview.firstPlayerPrize === tournament.winner_player_prize_amount &&
      preview.secondPlayerPrize === tournament.runner_up_player_prize_amount &&
      tournament.system_fee_amount + tournament.prize_pool_amount === tournament.total_entry_amount &&
      tournament.winner_team_prize_amount + tournament.runner_up_team_prize_amount === tournament.prize_pool_amount &&
      tournament.winner_player_prize_amount * 2 === tournament.winner_team_prize_amount &&
      tournament.runner_up_player_prize_amount * 2 === tournament.runner_up_team_prize_amount
    )
  }

  function getSettlementTeamMembers(teamId: TournamentTeamId): TournamentEntryRow[] {
    return (selectEntriesForTeamStatement.all(teamId) as TournamentEntryRow[])
      .filter((entry) => entry.status === 'confirmed' || entry.status === 'finalist' || entry.status === 'champion')
  }

  function settleTournamentPrizesAtomicallyLocal(
    tournamentId: TournamentId,
    now: Date,
  ): SettleTournamentPrizesResult {
    const nowIso = now.toISOString()
    try {
      database.exec('BEGIN IMMEDIATE;')
      const tournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow | undefined
      if (tournament === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_found' }
      }
      if (tournament.settlement_state === 'settled' && tournament.champion_team_id !== null && tournament.runner_up_team_id !== null) {
        database.exec('ROLLBACK;')
        return {
          ok: true,
          alreadySettled: true,
          tournament: toTournamentRecord(tournament),
          championTeamId: tournament.champion_team_id,
          runnerUpTeamId: tournament.runner_up_team_id,
          payoutRows: 0,
          totalPrizePaid: 0,
        }
      }
      if (tournament.status !== 'final_in_progress' || tournament.settlement_state !== 'pending') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_ready' }
      }
      if (!validateFinancialSnapshot(tournament)) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_financial_snapshot' }
      }

      const finalMatch = selectFinalMatchForSettlementStatement.get(tournamentId) as FinalMatchSettlementRow | undefined
      if (
        finalMatch === undefined ||
        finalMatch.status !== 'completed' ||
        !['played', 'played_with_bots', 'walkover'].includes(finalMatch.result_kind ?? '') ||
        finalMatch.winner_team_id === null ||
        finalMatch.team_a_id === finalMatch.team_b_id ||
        (finalMatch.winner_team_id !== finalMatch.team_a_id && finalMatch.winner_team_id !== finalMatch.team_b_id)
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_final_state' }
      }

      const championTeamId = finalMatch.winner_team_id
      const runnerUpTeamId = championTeamId === finalMatch.team_a_id
        ? finalMatch.team_b_id
        : finalMatch.team_a_id
      const championMembers = getSettlementTeamMembers(championTeamId)
      const runnerUpMembers = getSettlementTeamMembers(runnerUpTeamId)
      const recipientProfileIds = [
        ...championMembers.map((entry) => entry.profile_id),
        ...runnerUpMembers.map((entry) => entry.profile_id),
      ]
      if (
        championMembers.length !== 2 ||
        runnerUpMembers.length !== 2 ||
        new Set(recipientProfileIds).size !== 4
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'invalid_recipients' }
      }

      const debitRows = selectEntryDebitLedgerRowsStatement.all(tournamentId) as Array<{ profile_id: string; amount: number }>
      const debitProfiles = new Set(debitRows.map((row) => row.profile_id))
      const debitTotal = debitRows.reduce((sum, row) => sum + row.amount, 0)
      if (
        debitRows.length !== tournament.player_capacity ||
        debitProfiles.size !== tournament.player_capacity ||
        debitRows.some((row) => row.amount !== tournament.entry_fee) ||
        debitTotal !== tournament.total_entry_amount
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'ledger_mismatch' }
      }
      const systemRows = selectSystemFeeLedgerRowsStatement.all(tournamentId) as Array<{ profile_id: string | null; amount: number }>
      if (
        systemRows.length !== 1 ||
        systemRows[0]?.profile_id !== null ||
        systemRows[0]?.amount !== tournament.system_fee_amount
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'ledger_mismatch' }
      }
      const existingPrizeRows = selectPrizePayoutLedgerRowsStatement.all(tournamentId) as Array<{ profile_id: string | null; amount: number; idempotency_key: string }>
      if (existingPrizeRows.length > 0) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'ledger_mismatch' }
      }

      const payouts: Array<{ profileId: ProfileId; placement: 'winner' | 'runner_up'; amount: number }> = [
        ...championMembers.map((entry) => ({
          profileId: entry.profile_id,
          placement: 'winner' as const,
          amount: tournament.winner_player_prize_amount!,
        })),
        ...runnerUpMembers.map((entry) => ({
          profileId: entry.profile_id,
          placement: 'runner_up' as const,
          amount: tournament.runner_up_player_prize_amount!,
        })),
      ]

      for (const payout of payouts) {
        const key = prizePayoutKey(tournamentId, payout.placement, payout.profileId)
        ensureWalletStatement.run(payout.profileId)
        creditWalletStatement.run(payout.amount, payout.profileId)
        insertLedgerStatement.run(
          randomUUID(),
          key,
          tournamentId,
          payout.profileId,
          'prize_payout' satisfies TournamentLedgerEntryType,
          payout.amount,
          getWalletBalance(payout.profileId),
        )
      }

      const updateResult = updateTournamentSettledStatement.run(
        championTeamId,
        runnerUpTeamId,
        nowIso,
        nowIso,
        nowIso,
        tournamentId,
      )
      if ((updateResult.changes ?? 0) !== 1) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'not_ready' }
      }

      insertEvent(tournamentId, 'tournament_prizes_settled', null, 'system', {
        championTeamId,
        runnerUpTeamId,
        prizePoolAmount: tournament.prize_pool_amount,
        winnerPlayerPrizeAmount: tournament.winner_player_prize_amount,
        runnerUpPlayerPrizeAmount: tournament.runner_up_player_prize_amount,
        financialRulesVersion: tournament.financial_rules_version,
      })
      database.exec('COMMIT;')
      const finalTournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
      return {
        ok: true,
        alreadySettled: false,
        tournament: toTournamentRecord(finalTournament),
        championTeamId,
        runnerUpTeamId,
        payoutRows: payouts.length,
        totalPrizePaid: payouts.reduce((sum, payout) => sum + payout.amount, 0),
      }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }
  }

  function autoCancelScheduledTournamentAtomicallyLocal(
    tournamentId: TournamentId,
    now: Date,
    reason: string,
  ): AutoCancelScheduledTournamentResult {
    const nowIso = now.toISOString()
    try {
      database.exec('BEGIN IMMEDIATE;')
      expireDuePartnerInvitesInCurrentTransaction(tournamentId)
      const tournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow | undefined
      if (tournament === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_found' }
      }
      if (tournament.status === 'auto_cancelled') {
        database.exec('ROLLBACK;')
        return {
          ok: true,
          alreadyCancelled: true,
          refundedEntries: 0,
          totalRefunded: 0,
          refundedProfiles: [],
          tournament: toTournamentRecord(tournament),
        }
      }
      if (tournament.status !== 'open') {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_open' }
      }

      // 8th-player-vs-expiry race (виж tournamentScheduler.ts): турнир, който
      // е станал ready (capacity confirmed places, 0 reserved) в момента на
      // cancel опита — независимо дали заради late join в същия tick, или
      // заради изпреварване на fill-expiry cancel от паралелен start — никога
      // не трябва да бъде отменян. Fresh re-select под BEGIN IMMEDIATE прави
      // тази проверка TOCTOU-safe спрямо startTournamentAtomically-паралелна
      // транзакция (SQLite сериализира writer-ите).
      if (
        tournament.start_mode === 'fill' &&
        getOccupiedPlaces(tournamentId) >= tournament.player_capacity &&
        getReservedPendingPlaces(tournamentId) === 0
      ) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_open' }
      }

      const statusUpdate = updateTournamentAutoCancelledStatement.run(reason, nowIso, tournamentId) as {
        changes?: number
      }
      if ((statusUpdate.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return { ok: false, reason: 'tournament_not_open' }
      }

      const pendingInvites = database.prepare(`
        SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
               status, expires_at, popup_dismissed_at, notification_read_at, created_at,
               responded_at
        FROM tournament_partner_invites
        WHERE tournament_id = ? AND status = 'pending';
      `).all(tournamentId) as TournamentPartnerInviteRow[]
      for (const invite of pendingInvites) {
        resolvePartnerInviteStatement.run('cancelled', invite.invite_id, tournamentId)
      }

      const confirmedEntries = selectConfirmedEntriesStatement.all(tournamentId) as TournamentEntryRow[]
      let refundedEntries = 0
      let totalRefunded = 0
      const refundedProfiles: Array<{ profileId: ProfileId; amount: number }> = []
      for (const entry of confirmedEntries) {
        const refundKey = entryFeeRefundKeyForAttempt(
          tournamentId,
          entry.profile_id,
          currentEntryFeeAttempt(tournamentId, entry.profile_id),
        )
        if (getLedgerByKey(refundKey) !== null) continue
        const debitLedger = getCurrentEntryFeeDebitLedger(tournamentId, entry.profile_id)
        const refundAmount = debitLedger?.amount ?? tournament.entry_fee
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
        refundedProfiles.push({ profileId: entry.profile_id, amount: refundAmount })
      }
      deleteTeamsForTournamentStatement.run(tournamentId)
      insertEvent(tournamentId, 'tournament_auto_cancelled', null, 'system', {
        reason,
        refundedEntries,
        totalRefunded,
      })
      database.exec('COMMIT;')
      const finalTournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
      return {
        ok: true,
        alreadyCancelled: false,
        refundedEntries,
        totalRefunded,
        refundedProfiles,
        tournament: toTournamentRecord(finalTournament),
      }
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw error
    }
  }

  return {
    getPartnerCandidatesForTournament(
      tournamentId: TournamentId,
      inviterProfileId: ProfileId,
    ): PartnerCandidateRecord[] {
      const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournament === undefined || tournament.status !== 'open') return []
      const rows = selectAcceptedFriendsStatement.all(
        inviterProfileId,
        inviterProfileId,
        inviterProfileId,
      ) as ProfileEligibilityRow[]
      return rows.map((row) => {
        const unavailableReason = getCandidateUnavailableReason(tournamentId, inviterProfileId, row)
        return {
          profileId: row.profile_id,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          eligible: unavailableReason === null,
          unavailableReason,
        }
      })
    },

    // Global partner search (§ "GLOBAL SEARCH AREA") — независим source от
    // getPartnerCandidatesForTournament (friends list), query-based, НЕ
    // връща цялата user база (searchGlobalPartnerCandidatesStatement има
    // hardcoded LIMIT 20, normalizedTerm е задължителен non-empty, min-length
    // guard-ът е на HTTP layer-а). Reuse-ва СЪЩИЯ getCandidateUnavailableReason
    // chokepoint като friends list-а и direct invite validation-а — единствената
    // разлика е source-ът на кандидатите (global search вместо
    // profile_friendships), не eligibility правилата.
    getGlobalPartnerCandidatesForTournament(
      tournamentId: TournamentId,
      inviterProfileId: ProfileId,
      normalizedTerm: string,
    ): PartnerCandidateRecord[] {
      if (normalizedTerm.length === 0) return []
      const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournament === undefined || tournament.status !== 'open') return []
      const escapedTerm = escapeSqlLikePattern(normalizedTerm)
      const containsPattern = `%${escapedTerm}%`
      const prefixPattern = `${escapedTerm}%`
      const rows = searchGlobalPartnerCandidatesStatement.all(
        inviterProfileId,
        containsPattern,
        normalizedTerm,
        prefixPattern,
      ) as ProfileEligibilityRow[]
      return rows.map((row) => {
        const unavailableReason = getCandidateUnavailableReason(tournamentId, inviterProfileId, row)
        return {
          profileId: row.profile_id,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          eligible: unavailableReason === null,
          unavailableReason,
        }
      })
    },

    listPendingPartnerInvitesForProfile(
      inviteeProfileId: ProfileId,
    ): TournamentPartnerInviteRecord[] {
      expireDuePartnerInvitesAtomicallyLocal()
      const rows = selectPendingInvitesForProfileStatement.all(
        inviteeProfileId,
      ) as TournamentPartnerInviteRow[]
      return rows.map(toTournamentPartnerInviteRecord)
    },

    listUndismissedPendingPartnerInvitesForProfile(
      inviteeProfileId: ProfileId,
    ): TournamentPartnerInviteRecord[] {
      expireDuePartnerInvitesAtomicallyLocal()
      const rows = selectUndismissedPendingInvitesForProfileStatement.all(
        inviteeProfileId,
      ) as TournamentPartnerInviteRow[]
      return rows.map(toTournamentPartnerInviteRecord)
    },

    // Durable "партньорът ти се отписа" известия (§ "PARTNER-LEFT
    // NOTIFICATION ТРЯБВА Е DURABLE") — reused от login/reconnect flush
    // (index.ts, огледално на pending_gift_notifications) за offline
    // recipients. delivered_at се маркира едва след като известието реално
    // е изпратено (online push веднага след commit, ИЛИ login flush), не
    // при самия insert — виж markPartnerLeftNoticeDelivered.
    getPendingPartnerLeftNotices(
      recipientProfileId: ProfileId,
    ): Array<{ noticeId: string; tournamentId: string; refundedAmount: number }> {
      const rows = selectPendingPartnerLeftNoticesStatement.all(recipientProfileId) as Array<{
        notice_id: string
        tournament_id: string
        refunded_amount: number
      }>
      return rows.map((row) => ({
        noticeId: row.notice_id,
        tournamentId: row.tournament_id,
        refundedAmount: row.refunded_amount,
      }))
    },

    markPartnerLeftNoticeDelivered(noticeId: string, recipientProfileId: ProfileId): void {
      markPartnerLeftNoticeDeliveredStatement.run(noticeId, recipientProfileId)
    },

    dismissPartnerInvitePopup(
      inviteId: TournamentPartnerInviteId,
      inviteeProfileId: ProfileId,
    ): PartnerInviteNotificationStateResult {
      expireDuePartnerInvitesAtomicallyLocal()
      const before = selectPartnerInviteByInviteIdStatement.get(inviteId) as
        | TournamentPartnerInviteRow
        | undefined
      if (before === undefined) return { ok: false, reason: 'invite_not_found' }
      if (before.invitee_profile_id !== inviteeProfileId) return { ok: false, reason: 'not_invitee' }
      if (before.status !== 'pending') return { ok: false, reason: 'invite_not_pending' }
      dismissPartnerInvitePopupStatement.run(inviteId, inviteeProfileId)
      const after = selectPartnerInviteByInviteIdStatement.get(inviteId) as TournamentPartnerInviteRow
      return { ok: true, invite: toTournamentPartnerInviteRecord(after) }
    },

    viewPartnerInviteNotification(
      inviteId: TournamentPartnerInviteId,
      inviteeProfileId: ProfileId,
    ): PartnerInviteNotificationStateResult {
      expireDuePartnerInvitesAtomicallyLocal()
      const before = selectPartnerInviteByInviteIdStatement.get(inviteId) as
        | TournamentPartnerInviteRow
        | undefined
      if (before === undefined) return { ok: false, reason: 'invite_not_found' }
      if (before.invitee_profile_id !== inviteeProfileId) return { ok: false, reason: 'not_invitee' }
      if (before.status !== 'pending') return { ok: false, reason: 'invite_not_pending' }
      viewPartnerInviteNotificationStatement.run(inviteId, inviteeProfileId)
      const after = selectPartnerInviteByInviteIdStatement.get(inviteId) as TournamentPartnerInviteRow
      return { ok: true, invite: toTournamentPartnerInviteRecord(after) }
    },

    markResolvedInviteNotificationState(
      inviteId: TournamentPartnerInviteId,
      inviteeProfileId: ProfileId,
    ): TournamentPartnerInviteRecord | null {
      markInviteeResolvedNotificationStateStatement.run(inviteId, inviteeProfileId)
      const row = selectPartnerInviteByInviteIdStatement.get(inviteId) as
        | TournamentPartnerInviteRow
        | undefined
      return row ? toTournamentPartnerInviteRecord(row) : null
    },

    getOutgoingPendingInviteForProfile(
      tournamentId: TournamentId,
      inviterProfileId: ProfileId,
    ): TournamentPartnerInviteRecord | null {
      expireDuePartnerInvitesAtomicallyLocal(tournamentId)
      const row = selectPendingOutgoingInviteStatement.get(
        tournamentId,
        inviterProfileId,
      ) as TournamentPartnerInviteRow | undefined
      return row ? toTournamentPartnerInviteRecord(row) : null
    },

    countReservedPendingPlaces(tournamentId: TournamentId): number {
      expireDuePartnerInvitesAtomicallyLocal(tournamentId)
      return getReservedPendingPlaces(tournamentId)
    },

    expireDuePartnerInvitesAtomically(tournamentId?: TournamentId): number {
      return expireDuePartnerInvitesAtomicallyLocal(tournamentId)
    },

    startTournamentAtomically(
      tournamentId: TournamentId,
      now: Date,
    ): StartTournamentResult {
      return startTournamentAtomicallyLocal(tournamentId, now)
    },

    autoCancelScheduledTournamentAtomically(
      tournamentId: TournamentId,
      now: Date,
      reason: string,
    ): AutoCancelScheduledTournamentResult {
      return autoCancelScheduledTournamentAtomicallyLocal(tournamentId, now, reason)
    },

    settleTournamentPrizesAtomically(
      tournamentId: TournamentId,
      now: Date,
    ): SettleTournamentPrizesResult {
      return settleTournamentPrizesAtomicallyLocal(tournamentId, now)
    },

    createPartnerInviteAtomically(
      tournamentId: TournamentId,
      inviterProfileId: ProfileId,
      inviteeProfileId: ProfileId,
      options: { password?: string | null; now?: Date } = {},
    ): PartnerInviteMutationResult {
      const nowMs = (options.now ?? new Date()).getTime()
      const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournamentRow === undefined) return { ok: false, reason: 'tournament_not_found' }

      const existingPending = selectPendingOutgoingInviteStatement.get(
        tournamentId,
        inviterProfileId,
      ) as TournamentPartnerInviteRow | undefined
      if (existingPending !== undefined) {
        return {
          ok: true,
          invite: toTournamentPartnerInviteRecord(existingPending),
          walletBalance: getWalletBalance(inviterProfileId),
          tournament: toTournamentRecord(tournamentRow),
        }
      }

      let result: PartnerInviteMutationResult
      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)

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
        if (isFillExpired(freshTournament, nowMs)) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_fill_expired' }
        }

        const expiresAt = computePartnerInviteExpiresAt(freshTournament)
        if (expiresAt === null) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'invite_window_closed' }
        }

        const inviteeValidation = validateInvitee(tournamentId, inviterProfileId, inviteeProfileId)
        if (inviteeValidation !== null) {
          database.exec('ROLLBACK;')
          return inviteeValidation
        }

        const existingInTx = selectPendingOutgoingInviteStatement.get(
          tournamentId,
          inviterProfileId,
        ) as TournamentPartnerInviteRow | undefined
        if (existingInTx !== undefined) {
          database.exec('ROLLBACK;')
          return {
            ok: true,
            invite: toTournamentPartnerInviteRecord(existingInTx),
            walletBalance: getWalletBalance(inviterProfileId),
            tournament: toTournamentRecord(freshTournament),
          }
        }

        const inviterEntry = selectEntryByTournamentAndProfileStatement.get(
          tournamentId,
          inviterProfileId,
        ) as TournamentEntryRow | undefined
        if (
          inviterEntry !== undefined &&
          inviterEntry.status !== 'confirmed' &&
          !isRejoinableEntryStatus(inviterEntry.status)
        ) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participant' }
        }
        if (
          inviterEntry !== undefined &&
          inviterEntry.status === 'confirmed' &&
          inviterEntry.team_id !== null
        ) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_teamed' }
        }

        const hasConfirmedInviterEntry =
          inviterEntry !== undefined && inviterEntry.status === 'confirmed'
        const neededPlaces = hasConfirmedInviterEntry ? 1 : 2
        const capacity = freshTournament.player_capacity
        if (getOccupiedPlaces(tournamentId) + neededPlaces > capacity) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_full' }
        }

        const isCreator = freshTournament.creator_profile_id === inviterProfileId
        if (freshTournament.visibility === 'password' && !isCreator && !hasConfirmedInviterEntry) {
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

        const activeAccountEntry = hasConfirmedInviterEntry
          ? undefined
          : selectActiveEntryForAccountStatement.get(inviterProfileId) as ActiveAccountEntryRow | undefined
        if (activeAccountEntry !== undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participating_elsewhere' }
        }

        const teamId = randomUUID()
        insertTeamStatement.run(teamId, tournamentId)

        const entryId = inviterEntry?.entry_id ?? randomUUID()
        if (!hasConfirmedInviterEntry) {
          const debitAttempt = nextEntryFeeDebitAttempt(tournamentId, inviterProfileId)
          ensureWalletStatement.run(inviterProfileId)
          const debitResult = debitWalletStatement.run(
            freshTournament.entry_fee,
            inviterProfileId,
            freshTournament.entry_fee,
          ) as { changes?: number }
          if ((debitResult.changes ?? 0) === 0) {
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'insufficient_funds' }
          }
          if (inviterEntry === undefined) {
            database.prepare(`
              INSERT INTO tournament_entries (
                entry_id, tournament_id, profile_id, team_id, joined_as, status
              ) VALUES (?, ?, ?, ?, 'partner_inviter', 'confirmed');
            `).run(entryId, tournamentId, inviterProfileId, teamId)
          } else {
            const updateResult = reactivateEntryAsPartnerInviterStatement.run(
              teamId,
              inviterEntry.entry_id,
            ) as { changes?: number }
            if ((updateResult.changes ?? 0) === 0) {
              database.exec('ROLLBACK;')
              return { ok: false, reason: 'already_participant' }
            }
          }
          insertLedgerStatement.run(
            randomUUID(),
            entryFeeDebitKeyForAttempt(tournamentId, inviterProfileId, debitAttempt),
            tournamentId,
            inviterProfileId,
            'entry_fee_debit' satisfies TournamentLedgerEntryType,
            freshTournament.entry_fee,
            getWalletBalance(inviterProfileId),
          )
        } else {
          updateEntryToPartnerInviterStatement.run(teamId, inviterEntry.entry_id)
        }

        const inviteId = randomUUID()
        insertPartnerInviteStatement.run(
          inviteId,
          tournamentId,
          teamId,
          inviterProfileId,
          inviteeProfileId,
          expiresAt,
        )
        insertEvent(tournamentId, 'partner_invite_created', inviterProfileId, 'player', {
          inviteId,
          inviteeProfileId,
          teamId,
          entryId,
        })
        database.exec('COMMIT;')

        const inviteRow = selectPendingInviteByIdStatement.get(
          inviteId,
          tournamentId,
        ) as TournamentPartnerInviteRow
        result = {
          ok: true,
          debitedAmount: hasConfirmedInviterEntry ? undefined : freshTournament.entry_fee,
          invite: toTournamentPartnerInviteRecord(inviteRow),
          walletBalance: getWalletBalance(inviterProfileId),
          tournament: toTournamentRecord(freshTournament),
        }
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // keep original error
        }
        throw error
      }
      return result
    },

    acceptPartnerInviteAtomically(
      tournamentId: TournamentId,
      inviteId: TournamentPartnerInviteId,
      inviteeProfileId: ProfileId,
      now: Date = new Date(),
    ): PartnerInviteMutationResult {
      const nowMs = now.getTime()
      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)
        const inviteRow = selectPendingInviteByIdStatement.get(inviteId, tournamentId) as
          | TournamentPartnerInviteRow
          | undefined
        if (inviteRow === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'invite_not_found' }
        }
        if (inviteRow.invitee_profile_id !== inviteeProfileId) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'not_invitee' }
        }
        if (inviteRow.status === 'accepted') {
          database.exec('ROLLBACK;')
          const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
          return {
            ok: true,
            alreadyResolved: true,
            invite: toTournamentPartnerInviteRecord(inviteRow),
            walletBalance: getWalletBalance(inviteeProfileId),
            tournament: toTournamentRecord(tournament),
          }
        }
        if (inviteRow.status !== 'pending') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'invite_not_pending' }
        }
        const freshTournament = selectTournamentForUpdateStatement.get(tournamentId) as TournamentRow | undefined
        if (freshTournament === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_not_found' }
        }
        if (freshTournament.status !== 'open') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_not_open' }
        }
        if (isFillExpired(freshTournament, nowMs)) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_fill_expired' }
        }
        if (new Date(dbDateToUtc(inviteRow.expires_at)).getTime() <= nowMs) {
          resolvePartnerInviteStatement.run('expired', inviteId, tournamentId)
          resetFormingTeamToSolo(tournamentId, inviteRow.team_id, inviteRow.inviter_profile_id)
          database.exec('COMMIT;')
          return { ok: false, reason: 'invite_not_pending' }
        }
        const teamRow = selectTeamByIdStatement.get(inviteRow.team_id) as TournamentTeamRow | undefined
        const teamMembers = selectConfirmedEntriesForTeamStatement.all(inviteRow.team_id) as TournamentEntryRow[]
        if (teamRow === undefined || teamRow.status !== 'forming' || teamMembers.length !== 1) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'team_invalid' }
        }
        const inviteeValidation = validateInvitee(
          tournamentId,
          inviteRow.inviter_profile_id,
          inviteeProfileId,
        )
        if (inviteeValidation !== null) {
          database.exec('ROLLBACK;')
          return inviteeValidation
        }
        const inviteeEntry = selectEntryByTournamentAndProfileStatement.get(
          tournamentId,
          inviteeProfileId,
        ) as TournamentEntryRow | undefined
        const debitAttempt = nextEntryFeeDebitAttempt(tournamentId, inviteeProfileId)
        ensureWalletStatement.run(inviteeProfileId)
        const debitResult = debitWalletStatement.run(
          freshTournament.entry_fee,
          inviteeProfileId,
          freshTournament.entry_fee,
        ) as { changes?: number }
        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'insufficient_funds' }
        }
        const entryId = inviteeEntry?.entry_id ?? randomUUID()
        if (inviteeEntry === undefined) {
          insertPartnerInviteeEntryStatement.run(entryId, tournamentId, inviteeProfileId, inviteRow.team_id)
        } else if (isRejoinableEntryStatus(inviteeEntry.status)) {
          const updateResult = reactivateEntryAsPartnerInviteeStatement.run(
            inviteRow.team_id,
            inviteeEntry.entry_id,
            tournamentId,
          ) as { changes?: number }
          if ((updateResult.changes ?? 0) === 0) {
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'already_participant' }
          }
        } else {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participant' }
        }
        insertLedgerStatement.run(
          randomUUID(),
          entryFeeDebitKeyForAttempt(tournamentId, inviteeProfileId, debitAttempt),
          tournamentId,
          inviteeProfileId,
          'entry_fee_debit' satisfies TournamentLedgerEntryType,
          freshTournament.entry_fee,
          getWalletBalance(inviteeProfileId),
        )
        updateTeamStatusStatement.run('complete', inviteRow.team_id, tournamentId)
        resolvePartnerInviteStatement.run('accepted', inviteId, tournamentId)
        markInviteeResolvedNotificationStateStatement.run(inviteId, inviteeProfileId)
        insertEvent(tournamentId, 'partner_invite_accepted', inviteeProfileId, 'player', {
          inviteId,
          teamId: inviteRow.team_id,
          entryId,
        })
        database.exec('COMMIT;')
        const finalInvite = getInviteById(tournamentId, inviteId)
        return {
          ok: true,
          debitedAmount: freshTournament.entry_fee,
          invite: finalInvite ?? toTournamentPartnerInviteRecord(inviteRow),
          walletBalance: getWalletBalance(inviteeProfileId),
          tournament: toTournamentRecord(freshTournament),
        }
      } catch (error) {
        try { database.exec('ROLLBACK;') } catch {}
        throw error
      }
    },

    declinePartnerInviteAtomically(
      tournamentId: TournamentId,
      inviteId: TournamentPartnerInviteId,
      inviteeProfileId: ProfileId,
    ): PartnerInviteMutationResult {
      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)
        const inviteRow = selectPendingInviteByIdStatement.get(inviteId, tournamentId) as TournamentPartnerInviteRow | undefined
        if (inviteRow === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'invite_not_found' }
        }
        if (inviteRow.invitee_profile_id !== inviteeProfileId) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'not_invitee' }
        }
        if (inviteRow.status !== 'pending') {
          const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
          database.exec('ROLLBACK;')
          return {
            ok: true,
            alreadyResolved: true,
            invite: toTournamentPartnerInviteRecord(inviteRow),
            walletBalance: getWalletBalance(inviteeProfileId),
            tournament: toTournamentRecord(tournament),
          }
        }
        resolvePartnerInviteStatement.run('declined', inviteId, tournamentId)
        markInviteeResolvedNotificationStateStatement.run(inviteId, inviteeProfileId)
        resetFormingTeamToSolo(tournamentId, inviteRow.team_id, inviteRow.inviter_profile_id)
        insertEvent(tournamentId, 'partner_invite_declined', inviteeProfileId, 'player', {
          inviteId,
          teamId: inviteRow.team_id,
        })
        const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
        database.exec('COMMIT;')
        const finalInvite = getInviteById(tournamentId, inviteId)
        return {
          ok: true,
          invite: finalInvite ?? toTournamentPartnerInviteRecord(inviteRow),
          walletBalance: getWalletBalance(inviteeProfileId),
          tournament: toTournamentRecord(tournament),
        }
      } catch (error) {
        try { database.exec('ROLLBACK;') } catch {}
        throw error
      }
    },

    cancelPartnerInviteAtomically(
      tournamentId: TournamentId,
      inviteId: TournamentPartnerInviteId,
      inviterProfileId: ProfileId,
    ): PartnerInviteMutationResult {
      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)
        const inviteRow = selectPendingInviteByIdStatement.get(inviteId, tournamentId) as TournamentPartnerInviteRow | undefined
        if (inviteRow === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'invite_not_found' }
        }
        if (inviteRow.inviter_profile_id !== inviterProfileId) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'not_inviter' }
        }
        if (inviteRow.status !== 'pending') {
          const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
          database.exec('ROLLBACK;')
          return {
            ok: true,
            alreadyResolved: true,
            invite: toTournamentPartnerInviteRecord(inviteRow),
            walletBalance: getWalletBalance(inviterProfileId),
            tournament: toTournamentRecord(tournament),
          }
        }
        resolvePartnerInviteStatement.run('cancelled', inviteId, tournamentId)
        resetFormingTeamToSolo(tournamentId, inviteRow.team_id, inviteRow.inviter_profile_id)
        insertEvent(tournamentId, 'partner_invite_cancelled', inviterProfileId, 'player', {
          inviteId,
          teamId: inviteRow.team_id,
        })
        const tournament = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
        database.exec('COMMIT;')
        const finalInvite = getInviteById(tournamentId, inviteId)
        return {
          ok: true,
          invite: finalInvite ?? toTournamentPartnerInviteRecord(inviteRow),
          walletBalance: getWalletBalance(inviterProfileId),
          tournament: toTournamentRecord(tournament),
        }
      } catch (error) {
        try { database.exec('ROLLBACK;') } catch {}
        throw error
      }
    },

    joinTournamentSoloAtomically(
      tournamentId: TournamentId,
      profileId: ProfileId,
      options: { password?: string | null; now?: Date } = {},
    ): JoinTournamentSoloResult {
      const nowMs = (options.now ?? new Date()).getTime()
      // Pre-check извън транзакцията (не намалява коректността — всичко
      // критично се пре-проверява вътре в BEGIN IMMEDIATE по-долу; целта е
      // само бърз early-return без да отваряме транзакция за очевидни грешки).
      const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow | undefined
      if (tournamentRow === undefined) {
        return { ok: false, reason: 'tournament_not_found' }
      }

      // Идемпотентност: ако вече има confirmed entry + debit ledger, връщаме
      // success без нов debit (retry-safe за клиентски network грешки).
      const existingEntryRow = selectEntryByTournamentAndProfileStatement.get(
        tournamentId,
        profileId,
      ) as TournamentEntryRow | undefined

      if (existingEntryRow !== undefined) {
        if (existingEntryRow.status === 'confirmed') {
          const ledger = getCurrentEntryFeeDebitLedger(tournamentId, profileId)
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
        // Placement statuses stay terminal; refunded/withdrawn entries may start a new paid attempt.
        if (!isRejoinableEntryStatus(existingEntryRow.status)) {
          return { ok: false, reason: 'rejoin_not_allowed' }
        }
      }

      let result: JoinTournamentSoloResult

      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)

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
        if (isFillExpired(freshTournament, nowMs)) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_fill_expired' }
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
          if (existingInTx.status === 'confirmed') {
            // Другият паралелен join вече е commit-нал успешно — идемпотентен
            // success, не грешка (виж продуктово изискване: retry след
            // мрежов проблем не трябва да получи 409).
            const ledger = getCurrentEntryFeeDebitLedger(tournamentId, profileId)
            if (ledger !== null) {
              database.exec('ROLLBACK;')
              return {
                ok: true,
                alreadyJoined: true,
                entry: toTournamentEntryRecord(existingInTx),
                walletBalance: getWalletBalance(profileId),
                tournament: toTournamentRecord(tournamentRow),
              }
            }
          }
          if (!isRejoinableEntryStatus(existingInTx.status)) {
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'rejoin_not_allowed' }
          }
        }

        const activeAccountEntry = selectActiveEntryForAccountStatement.get(
          profileId,
        ) as ActiveAccountEntryRow | undefined
        if (activeAccountEntry !== undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participating_elsewhere' }
        }

        const playerCapacity = freshTournament.player_capacity
        if (getOccupiedPlaces(tournamentId) + 1 > playerCapacity) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_full' }
        }

        const entryFee = freshTournament.entry_fee
        const debitAttempt = nextEntryFeeDebitAttempt(tournamentId, profileId)

        ensureWalletStatement.run(profileId)
        const debitResult = debitWalletStatement.run(entryFee, profileId, entryFee) as {
          changes?: number
        }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'insufficient_funds' }
        }

        const entryId = existingInTx?.entry_id ?? randomUUID()
        if (existingInTx === undefined) {
          try {
            insertEntryStatement.run(entryId, tournamentId, profileId)
          } catch {
            // UNIQUE(tournament_id, profile_id) or active-profile partial index.
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'already_participating_elsewhere' }
          }
        } else {
          const updateResult = reactivateEntryAsSoloStatement.run(existingInTx.entry_id) as {
            changes?: number
          }
          if ((updateResult.changes ?? 0) === 0) {
            database.exec('ROLLBACK;')
            return { ok: false, reason: 'rejoin_not_allowed' }
          }
        }

        insertLedgerStatement.run(
          randomUUID(),
          entryFeeDebitKeyForAttempt(tournamentId, profileId, debitAttempt),
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
          debitedAmount: entryFee,
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

      const refundKey = entryFeeRefundKeyForAttempt(
        tournamentId,
        profileId,
        currentEntryFeeAttempt(tournamentId, profileId),
      )

      if (entryRow.status === 'refunded') {
        const ledger = getCurrentEntryFeeRefundLedger(tournamentId, profileId)
        if (ledger !== null) {
          const tournamentRow = selectTournamentByIdStatement.get(tournamentId) as TournamentRow
          return {
            ok: true,
            alreadyRefunded: true,
            refundedAmount: ledger.amount,
            walletBalance: getWalletBalance(profileId),
            tournament: toTournamentRecord(tournamentRow),
            autoReleasedPartner: null,
          }
        }
      }

      if (entryRow.status !== 'confirmed') {
        return { ok: false, reason: 'entry_not_confirmed' }
      }

      let result: LeaveTournamentResult

      try {
        database.exec('BEGIN IMMEDIATE;')
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)

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
          const ledger = getCurrentEntryFeeRefundLedger(tournamentId, profileId)
          database.exec('ROLLBACK;')
          return {
            ok: true,
            alreadyRefunded: true,
            refundedAmount: ledger?.amount ?? 0,
            walletBalance: getWalletBalance(profileId),
            tournament: toTournamentRecord(freshTournament),
            autoReleasedPartner: null,
          }
        }
        if (freshEntry.status !== 'confirmed') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'entry_not_confirmed' }
        }

        const debitLedger = getCurrentEntryFeeDebitLedger(tournamentId, profileId)
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

        // Auto-release на partner-а (§ "КОГАТО ЕДИНИЯТ PARTNER СЕ ОТПИШЕ") —
        // ако напускащият е бил в двучленен team, partner-ът вече НЕ остава
        // едночленен team (старото поведение — updateEntryToSoloStatement —
        // би оставило именно malformed "team row + one active member"
        // steady state, който task spec-ът изрично забранява). Вместо това
        // partner-ът е автоматично освободен + refund-нат в СЪЩАТА
        // транзакция, огледално на самия напускащ участник по-долу —
        // симетрично е независимо кой от двамата напусне пръв.
        let autoReleasedPartner: { profileId: ProfileId; refundedAmount: number; noticeId: string } | null = null
        if (freshEntry.team_id !== null) {
          const teamMembers = selectConfirmedEntriesForTeamStatement.all(freshEntry.team_id) as TournamentEntryRow[]
          const remainingMembers = teamMembers.filter((entry) => entry.entry_id !== freshEntry.entry_id)
          // Всеки pending outgoing invite от НАПУСКАЩИЯ (ако все още е
          // inviter на нерешена покана) се cancel-ва — непроменено спрямо
          // преди. Самата accepted покана, формирала team-а, се trie-ва
          // автоматично чрез ON DELETE CASCADE на tournament_partner_invites.team_id
          // при deleteTeamStatement по-долу (виж migration
          // 20260730_001_create_tournament_core_tables.sql:165) — не се
          // нуждае от отделен resolve тук.
          const pendingInvite = selectPendingOutgoingInviteStatement.get(
            tournamentId,
            profileId,
          ) as TournamentPartnerInviteRow | undefined
          if (pendingInvite !== undefined) {
            resolvePartnerInviteStatement.run('cancelled', pendingInvite.invite_id, tournamentId)
          }
          for (const member of remainingMembers) {
            const memberRefundKey = entryFeeRefundKeyForAttempt(
              tournamentId,
              member.profile_id,
              currentEntryFeeAttempt(tournamentId, member.profile_id),
            )
            const memberDebitLedger = getCurrentEntryFeeDebitLedger(tournamentId, member.profile_id)
            const memberRefundAmount = memberDebitLedger?.amount ?? freshTournament.entry_fee
            ensureWalletStatement.run(member.profile_id)
            creditWalletStatement.run(memberRefundAmount, member.profile_id)
            insertLedgerStatement.run(
              randomUUID(),
              memberRefundKey,
              tournamentId,
              member.profile_id,
              'entry_fee_refund' satisfies TournamentLedgerEntryType,
              memberRefundAmount,
              getWalletBalance(member.profile_id),
            )
            const memberUpdateResult = updateEntryToRefundedStatement.run(member.entry_id) as { changes?: number }
            if ((memberUpdateResult.changes ?? 0) > 0) {
              insertEvent(tournamentId, 'entry_auto_released_after_partner_left', member.profile_id, 'system', {
                leavingProfileId: profileId,
                refundedAmount: memberRefundAmount,
              })
              // Durable notice row (§ "PARTNER-LEFT NOTIFICATION ТРЯБВА Е
              // DURABLE") — notice_id детерминиран от member.entry_id-то,
              // затова е безопасно idempotent дори при теоретичен retry на
              // целия leave call (updateEntryToRefundedStatement's WHERE
              // status='confirmed' guard вече прави changes>0 клона
              // недостижим повторно за същия entry, но deterministic id
              // премахва и всякаква зависимост от този guard за самото
              // известие).
              const partnerLeftNoticeId = `partner-left:${member.entry_id}`
              insertPartnerLeftNoticeStatement.run(
                partnerLeftNoticeId,
                tournamentId,
                member.profile_id,
                memberRefundAmount,
              )
              // Само ЕДИН partner е възможен в двучленен team модел — ако
              // някога capacity/model се разшири, тук трябва да стане масив.
              autoReleasedPartner = {
                profileId: member.profile_id,
                refundedAmount: memberRefundAmount,
                noticeId: partnerLeftNoticeId,
              }
            }
          }
          deleteTeamStatement.run(freshEntry.team_id, tournamentId)
        }

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
          autoReleasedPartner,
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
          refundedProfiles: [],
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
        expireDuePartnerInvitesInCurrentTransaction(tournamentId)

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
              refundedProfiles: [],
              walletBalance: getWalletBalance(creatorProfileId),
              tournament: toTournamentRecord(freshTournament),
            }
          }
          return { ok: false, reason: 'tournament_not_open' }
        }

        const pendingInvites = database.prepare(`
          SELECT invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id,
                 status, expires_at, popup_dismissed_at, notification_read_at, created_at,
                 responded_at
          FROM tournament_partner_invites
          WHERE tournament_id = ? AND status = 'pending';
        `).all(tournamentId) as TournamentPartnerInviteRow[]
        for (const invite of pendingInvites) {
          resolvePartnerInviteStatement.run('cancelled', invite.invite_id, tournamentId)
          resetFormingTeamToSolo(tournamentId, invite.team_id, invite.inviter_profile_id)
        }

        const confirmedEntries = selectConfirmedEntriesStatement.all(
          tournamentId,
        ) as TournamentEntryRow[]

        let refundedEntries = 0
        let totalRefunded = 0
        const refundedProfiles: Array<{ profileId: ProfileId; amount: number }> = []

        for (const entry of confirmedEntries) {
          const refundKey = entryFeeRefundKeyForAttempt(
            tournamentId,
            entry.profile_id,
            currentEntryFeeAttempt(tournamentId, entry.profile_id),
          )

          if (getLedgerByKey(refundKey) !== null) {
            continue // вече refund-нат (idempotent skip)
          }

          const debitLedger = getCurrentEntryFeeDebitLedger(tournamentId, entry.profile_id)
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
          refundedProfiles.push({ profileId: entry.profile_id, amount: refundAmount })
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
          refundedProfiles,
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

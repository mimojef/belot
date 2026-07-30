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
  TournamentPartnerInviteId,
  TournamentPartnerInviteRecord,
  TournamentPartnerInviteStatus,
  TournamentRecord,
  TournamentStatus,
  TournamentTeamId,
  TournamentTeamRecord,
  TournamentTeamStatus,
  TournamentVisibility,
} from '../tournament/tournamentTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

type TournamentLedgerEntryType = 'entry_fee_debit' | 'entry_fee_refund'

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

export type PartnerInviteMutationResult =
  | {
      ok: true
      alreadyResolved?: boolean
      invite: TournamentPartnerInviteRecord
      walletBalance: number
      tournament: TournamentRecord
    }
  | {
      ok: false
      reason:
        | 'tournament_not_found'
        | 'tournament_not_open'
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
  getPartnerCandidatesForTournament: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
  ) => PartnerCandidateRecord[]
  listPendingPartnerInvitesForProfile: (
    inviteeProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord[]
  getOutgoingPendingInviteForProfile: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
  ) => TournamentPartnerInviteRecord | null
  countReservedPendingPlaces: (tournamentId: TournamentId) => number
  createPartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviterProfileId: ProfileId,
    inviteeProfileId: ProfileId,
    options?: { password?: string | null },
  ) => PartnerInviteMutationResult
  acceptPartnerInviteAtomically: (
    tournamentId: TournamentId,
    inviteId: TournamentPartnerInviteId,
    inviteeProfileId: ProfileId,
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

  const selectTeamByIdStatement = database.prepare(`
    SELECT team_id, tournament_id, status, seed_slot, created_at, updated_at
    FROM tournament_teams
    WHERE team_id = ?
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

  const insertTeamStatement = database.prepare(`
    INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot)
    VALUES (?, ?, 'forming', NULL);
  `)

  const updateTeamStatusStatement = database.prepare(`
    UPDATE tournament_teams
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE team_id = ? AND tournament_id = ?;
  `)

  const deleteTeamStatement = database.prepare(`
    DELETE FROM tournament_teams
    WHERE team_id = ? AND tournament_id = ?;
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

  const updateEntryToPartnerInviterStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = ?, joined_as = 'partner_inviter', updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
  `)

  const updateEntryToSoloStatement = database.prepare(`
    UPDATE tournament_entries
    SET team_id = NULL, joined_as = 'solo', updated_at = CURRENT_TIMESTAMP
    WHERE entry_id = ? AND status = 'confirmed';
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
    if (!isConfirmedFriend(inviterProfileId, candidate.profile_id)) return 'not_friend'
    if (hasBlockBetween(inviterProfileId, candidate.profile_id)) return 'blocked'
    const existingEntry = selectEntryByTournamentAndProfileStatement.get(
      tournamentId,
      candidate.profile_id,
    ) as TournamentEntryRow | undefined
    if (existingEntry !== undefined && existingEntry.status === 'confirmed') return 'already_in_tournament'
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
    if (reason === 'not_friend') return { ok: false, reason: 'not_friend' }
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

    listPendingPartnerInvitesForProfile(
      inviteeProfileId: ProfileId,
    ): TournamentPartnerInviteRecord[] {
      expireDuePartnerInvitesAtomicallyLocal()
      const rows = selectPendingInvitesForProfileStatement.all(
        inviteeProfileId,
      ) as TournamentPartnerInviteRow[]
      return rows.map(toTournamentPartnerInviteRecord)
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

    createPartnerInviteAtomically(
      tournamentId: TournamentId,
      inviterProfileId: ProfileId,
      inviteeProfileId: ProfileId,
      options: { password?: string | null } = {},
    ): PartnerInviteMutationResult {
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
        if (inviterEntry !== undefined && inviterEntry.status !== 'confirmed') {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participant' }
        }
        if (inviterEntry !== undefined && inviterEntry.team_id !== null) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_teamed' }
        }

        const neededPlaces = inviterEntry === undefined ? 2 : 1
        const capacity = Math.min(freshTournament.player_capacity, 8)
        if (getOccupiedPlaces(tournamentId) + neededPlaces > capacity) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'tournament_full' }
        }

        const isCreator = freshTournament.creator_profile_id === inviterProfileId
        if (freshTournament.visibility === 'password' && !isCreator && inviterEntry === undefined) {
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

        const activeAccountEntry = inviterEntry === undefined
          ? selectActiveEntryForAccountStatement.get(inviterProfileId) as ActiveAccountEntryRow | undefined
          : undefined
        if (activeAccountEntry !== undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, reason: 'already_participating_elsewhere' }
        }

        const teamId = randomUUID()
        insertTeamStatement.run(teamId, tournamentId)

        let entryId = inviterEntry?.entry_id ?? randomUUID()
        if (inviterEntry === undefined) {
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
          database.prepare(`
            INSERT INTO tournament_entries (
              entry_id, tournament_id, profile_id, team_id, joined_as, status
            ) VALUES (?, ?, ?, ?, 'partner_inviter', 'confirmed');
          `).run(entryId, tournamentId, inviterProfileId, teamId)
          insertLedgerStatement.run(
            randomUUID(),
            entryFeeDebitKey(tournamentId, inviterProfileId),
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
    ): PartnerInviteMutationResult {
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
        if (new Date(dbDateToUtc(inviteRow.expires_at)).getTime() <= Date.now()) {
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
        const entryId = randomUUID()
        insertPartnerInviteeEntryStatement.run(entryId, tournamentId, inviteeProfileId, inviteRow.team_id)
        insertLedgerStatement.run(
          randomUUID(),
          entryFeeDebitKey(tournamentId, inviteeProfileId),
          tournamentId,
          inviteeProfileId,
          'entry_fee_debit' satisfies TournamentLedgerEntryType,
          freshTournament.entry_fee,
          getWalletBalance(inviteeProfileId),
        )
        updateTeamStatusStatement.run('complete', inviteRow.team_id, tournamentId)
        resolvePartnerInviteStatement.run('accepted', inviteId, tournamentId)
        insertEvent(tournamentId, 'partner_invite_accepted', inviteeProfileId, 'player', {
          inviteId,
          teamId: inviteRow.team_id,
          entryId,
        })
        database.exec('COMMIT;')
        const finalInvite = getInviteById(tournamentId, inviteId)
        return {
          ok: true,
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

        const playerCapacity = Math.min(freshTournament.player_capacity, 8)
        if (getOccupiedPlaces(tournamentId) + 1 > playerCapacity) {
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

        if (freshEntry.team_id !== null) {
          const teamMembers = selectConfirmedEntriesForTeamStatement.all(freshEntry.team_id) as TournamentEntryRow[]
          const remainingMembers = teamMembers.filter((entry) => entry.entry_id !== freshEntry.entry_id)
          const pendingInvite = selectPendingOutgoingInviteStatement.get(
            tournamentId,
            profileId,
          ) as TournamentPartnerInviteRow | undefined
          if (pendingInvite !== undefined) {
            resolvePartnerInviteStatement.run('cancelled', pendingInvite.invite_id, tournamentId)
          }
          for (const member of remainingMembers) {
            updateEntryToSoloStatement.run(member.entry_id)
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

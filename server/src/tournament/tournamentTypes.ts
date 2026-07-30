import type { ProfileId } from '../core/serverTypes.js'

export type TournamentId = string
export type TournamentTeamId = string
export type TournamentEntryId = string
export type TournamentPartnerInviteId = string
export type TournamentRoundId = string
export type TournamentMatchId = string
export type TournamentLedgerId = string
export type TournamentEventId = string

export const TOURNAMENT_KINDS = ['community', 'official'] as const
export type TournamentKind = (typeof TOURNAMENT_KINDS)[number]

export const TOURNAMENT_VISIBILITIES = ['public', 'password'] as const
export type TournamentVisibility = (typeof TOURNAMENT_VISIBILITIES)[number]

export const TOURNAMENT_START_MODES = ['fill', 'scheduled'] as const
export type TournamentStartMode = (typeof TOURNAMENT_START_MODES)[number]

export const TOURNAMENT_STATUSES = [
  'open',
  'starting',
  'semifinal_in_progress',
  'final_in_progress',
  'finished',
  'cancelled',
  'admin_cancelled',
  'auto_cancelled',
  'failed',
] as const
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number]

export const TOURNAMENT_TEAM_STATUSES = [
  'forming',
  'complete',
  'locked',
  'eliminated',
  'finalist',
  'champion',
] as const
export type TournamentTeamStatus = (typeof TOURNAMENT_TEAM_STATUSES)[number]

export const TOURNAMENT_ENTRY_JOINED_AS = [
  'solo',
  'partner_inviter',
  'partner_invitee',
] as const
export type TournamentEntryJoinedAs = (typeof TOURNAMENT_ENTRY_JOINED_AS)[number]

export const TOURNAMENT_ENTRY_STATUSES = [
  'confirmed',
  'withdrawn',
  'refunded',
  'eliminated',
  'finalist',
  'champion',
] as const
export type TournamentEntryStatus = (typeof TOURNAMENT_ENTRY_STATUSES)[number]

export const TOURNAMENT_PARTNER_INVITE_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
] as const
export type TournamentPartnerInviteStatus = (typeof TOURNAMENT_PARTNER_INVITE_STATUSES)[number]

export const TOURNAMENT_ROUND_TYPES = ['semifinal', 'final'] as const
export type TournamentRoundType = (typeof TOURNAMENT_ROUND_TYPES)[number]

export const TOURNAMENT_MATCH_STATUSES = [
  'awaiting_players',
  'countdown',
  'in_progress',
  'completed',
  'walkover',
  'cancelled',
] as const
export type TournamentMatchStatus = (typeof TOURNAMENT_MATCH_STATUSES)[number]

export const TOURNAMENT_MATCH_RESULT_KINDS = ['played', 'played_with_bots', 'walkover'] as const
export type TournamentMatchResultKind = (typeof TOURNAMENT_MATCH_RESULT_KINDS)[number]

export const TOURNAMENT_LEDGER_ENTRY_TYPES = [
  'entry_fee_debit',
  'entry_fee_refund',
  'prize_payout',
  'system_fee',
] as const
export type TournamentLedgerEntryType = (typeof TOURNAMENT_LEDGER_ENTRY_TYPES)[number]

export const TOURNAMENT_EVENT_ACTOR_ROLES = ['player', 'admin', 'system'] as const
export type TournamentEventActorRole = (typeof TOURNAMENT_EVENT_ACTOR_ROLES)[number]

export type TournamentRecord = {
  tournamentId: TournamentId
  kind: TournamentKind
  name: string
  creatorProfileId: ProfileId
  visibility: TournamentVisibility
  passwordHash: string | null
  entryFee: number
  playerCapacity: number
  startMode: TournamentStartMode
  scheduledStartAt: string | null
  status: TournamentStatus
  cancelReason: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  totalEntryAmount: number | null
  systemFeePercent: number | null
  systemFeeAmount: number | null
  prizePoolAmount: number | null
  winnerSharePercent: number | null
  runnerUpSharePercent: number | null
  winnerTeamPrizeAmount: number | null
  runnerUpTeamPrizeAmount: number | null
  winnerPlayerPrizeAmount: number | null
  runnerUpPlayerPrizeAmount: number | null
  financialRulesVersion: string | null
}

export type TournamentTeamRecord = {
  teamId: TournamentTeamId
  tournamentId: TournamentId
  status: TournamentTeamStatus
  seedSlot: number | null
  createdAt: string
  updatedAt: string
}

export type TournamentEntryRecord = {
  entryId: TournamentEntryId
  tournamentId: TournamentId
  profileId: ProfileId
  teamId: TournamentTeamId | null
  joinedAs: TournamentEntryJoinedAs
  status: TournamentEntryStatus
  createdAt: string
  updatedAt: string
  withdrawnAt: string | null
  refundedAt: string | null
}

export type TournamentPartnerInviteRecord = {
  inviteId: TournamentPartnerInviteId
  tournamentId: TournamentId
  teamId: TournamentTeamId
  inviterProfileId: ProfileId
  inviteeProfileId: ProfileId
  status: TournamentPartnerInviteStatus
  expiresAt: string
  popupDismissedAt: string | null
  notificationReadAt: string | null
  createdAt: string
  respondedAt: string | null
}

export type TournamentRoundRecord = {
  roundId: TournamentRoundId
  tournamentId: TournamentId
  roundType: TournamentRoundType
  roundIndex: number
  createdAt: string
}

export type TournamentMatchRecord = {
  matchId: TournamentMatchId
  tournamentId: TournamentId
  roundId: TournamentRoundId
  roomId: string | null
  teamAId: TournamentTeamId
  teamBId: TournamentTeamId
  status: TournamentMatchStatus
  noShowDeadlineAt: string | null
  attendanceStartedAt: string | null
  attendanceDeadlineAt: string | null
  attendanceResolvedAt: string | null
  attendanceResolutionKind: 'all_present' | 'walkover' | 'bots_inserted' | null
  gameStartAt: string | null
  attendanceRevision: number
  winnerTeamId: TournamentTeamId | null
  resultKind: TournamentMatchResultKind | null
  walkoverReason: string | null
  missingProfileIds: string[] | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export type TournamentLedgerEntryRecord = {
  ledgerId: TournamentLedgerId
  idempotencyKey: string
  tournamentId: TournamentId
  profileId: ProfileId | null
  entryType: TournamentLedgerEntryType
  amount: number
  balanceAfter: number | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

export type TournamentEventRecord = {
  eventId: TournamentEventId
  tournamentId: TournamentId
  eventType: string
  actorProfileId: ProfileId | null
  actorRole: TournamentEventActorRole | null
  payload: Record<string, unknown> | null
  createdAt: string
}

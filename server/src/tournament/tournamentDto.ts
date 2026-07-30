import type { ProfileId } from '../core/serverTypes.js'
import type {
  TournamentEntryJoinedAs,
  TournamentEntryRecord,
  TournamentEntryStatus,
  TournamentPartnerInviteRecord,
  TournamentRecord,
  TournamentStatus,
  TournamentTeamRecord,
} from './tournamentTypes.js'
import { calculateTournamentPrizePreview } from './tournamentPrizeRules.js'

export const ACTIVE_TOURNAMENT_STATUSES: TournamentStatus[] = [
  'open',
  'starting',
  'semifinal_in_progress',
  'final_in_progress',
]

const TOURNAMENT_STATUS_LABELS_BG: Record<TournamentStatus, string> = {
  open: 'Записване',
  starting: 'Стартира',
  semifinal_in_progress: 'Полуфинали',
  final_in_progress: 'Финал',
  finished: 'Завършен',
  cancelled: 'Отменен',
  admin_cancelled: 'Отменен',
  auto_cancelled: 'Отменен',
  failed: 'Технически проблем',
}

export function getTournamentStatusLabel(status: TournamentStatus): string {
  return TOURNAMENT_STATUS_LABELS_BG[status] ?? status
}

export type TournamentCreatorDto = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
}

export type TournamentPrizePreviewDto = {
  totalEntryFees: number
  systemFee: number
  prizePool: number
  firstTeamPrize: number
  secondTeamPrize: number
  firstPlayerPrize: number
  secondPlayerPrize: number
  systemFeePercent: number
  winnerSharePercent: number
  runnerUpSharePercent: number
  financialRulesVersion: string
  persisted: boolean
}

export type TournamentViewerParticipationDto = {
  isParticipant: boolean
  entryStatus: TournamentEntryStatus | null
  joinedAs: TournamentEntryJoinedAs | null
  canJoinSolo: boolean
  canInvitePartner: boolean
  canLeave: boolean
  canCancel: boolean
}

export type TournamentTeamMemberDto = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  joinedAt: string
  joinedAs: TournamentEntryJoinedAs
}

export type TournamentTeamDto = {
  teamId: string
  status: string
  members: TournamentTeamMemberDto[]
}

export type TournamentPartnerInviteDto = {
  inviteId: string
  tournamentId: string
  teamId: string
  inviterProfileId: string
  inviteeProfileId: string
  inviter: TournamentCreatorDto
  invitee: TournamentCreatorDto
  status: string
  expiresAt: string
  popupDismissedAt: string | null
  notificationReadAt: string | null
  createdAt: string
  respondedAt: string | null
  tournamentName?: string
  entryFee?: number
  startMode?: 'fill' | 'scheduled'
  scheduledStartAt?: string | null
}

export type TournamentPartnerCandidateDto = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
  eligible: boolean
  unavailableReason: string | null
}

export type TournamentSummaryDto = {
  tournamentId: string
  name: string
  creator: TournamentCreatorDto
  visibility: 'public' | 'password'
  requiresPassword: boolean
  status: TournamentStatus
  statusLabel: string
  entryFee: number
  playerCapacity: number
  confirmedEntriesCount: number
  reservedPlacesCount: number
  occupiedPlacesCount: number
  completedTeamsCount: number
  formingTeamsCount: number
  availablePlaces: number
  isFull: boolean
  startMode: 'fill' | 'scheduled'
  scheduledStartAt: string | null
  createdAt: string
  prizePreview: TournamentPrizePreviewDto
  isMine: boolean
  viewer: TournamentViewerParticipationDto
}

export type TournamentDetailDto = TournamentSummaryDto & {
  cancelReason: string | null
  startedAt: string | null
  finishedAt: string | null
  myTeam: TournamentTeamDto | null
  teams: TournamentTeamDto[]
  incomingPartnerInvite: TournamentPartnerInviteDto | null
  outgoingPartnerInvite: TournamentPartnerInviteDto | null
}

export function computeTournamentPrizePreview(
  entryFee: number,
  playerCapacity: number,
): TournamentPrizePreviewDto {
  return { ...calculateTournamentPrizePreview(entryFee, playerCapacity), persisted: false }
}

function getTournamentPrizePreview(tournament: TournamentRecord): TournamentPrizePreviewDto {
  if (
    tournament.totalEntryAmount !== null &&
    tournament.systemFeeAmount !== null &&
    tournament.prizePoolAmount !== null &&
    tournament.winnerTeamPrizeAmount !== null &&
    tournament.runnerUpTeamPrizeAmount !== null &&
    tournament.winnerPlayerPrizeAmount !== null &&
    tournament.runnerUpPlayerPrizeAmount !== null &&
    tournament.systemFeePercent !== null &&
    tournament.winnerSharePercent !== null &&
    tournament.runnerUpSharePercent !== null &&
    tournament.financialRulesVersion !== null
  ) {
    return {
      totalEntryFees: tournament.totalEntryAmount,
      systemFee: tournament.systemFeeAmount,
      prizePool: tournament.prizePoolAmount,
      firstTeamPrize: tournament.winnerTeamPrizeAmount,
      secondTeamPrize: tournament.runnerUpTeamPrizeAmount,
      firstPlayerPrize: tournament.winnerPlayerPrizeAmount,
      secondPlayerPrize: tournament.runnerUpPlayerPrizeAmount,
      systemFeePercent: tournament.systemFeePercent,
      winnerSharePercent: tournament.winnerSharePercent,
      runnerUpSharePercent: tournament.runnerUpSharePercent,
      financialRulesVersion: tournament.financialRulesVersion,
      persisted: true,
    }
  }
  return computeTournamentPrizePreview(tournament.entryFee, tournament.playerCapacity)
}

function toTournamentCreatorDto(
  creatorProfileId: ProfileId,
  publicProfile: { profileId: string | null; displayName: string; avatarUrl: string | null } | null,
): TournamentCreatorDto {
  if (publicProfile === null) {
    return { profileId: creatorProfileId, displayName: 'Играч', avatarUrl: null }
  }
  return {
    profileId: publicProfile.profileId,
    displayName: publicProfile.displayName,
    avatarUrl: publicProfile.avatarUrl,
  }
}

const ACTIVE_VIEWER_ENTRY_STATUSES: TournamentEntryStatus[] = ['confirmed', 'finalist']

export type ToTournamentSummaryDtoInput = {
  tournament: TournamentRecord
  creatorPublicProfile: { profileId: string | null; displayName: string; avatarUrl: string | null } | null
  confirmedEntriesCount: number
  reservedPlacesCount?: number
  completedTeamsCount: number
  formingTeamsCount?: number
  viewerProfileId: ProfileId | null
  viewerEntryStatus: TournamentEntryStatus | null
  viewerEntryJoinedAs?: TournamentEntryJoinedAs | null
}

function computeViewerParticipation(input: ToTournamentSummaryDtoInput): TournamentViewerParticipationDto {
  const { tournament, viewerProfileId, viewerEntryStatus } = input
  const isParticipant =
    viewerEntryStatus !== null && ACTIVE_VIEWER_ENTRY_STATUSES.includes(viewerEntryStatus)
  const isMine = viewerProfileId !== null && viewerProfileId === tournament.creatorProfileId
  const reservedPlacesCount = input.reservedPlacesCount ?? 0
  const occupiedPlacesCount = input.confirmedEntriesCount + reservedPlacesCount
  const isFull = occupiedPlacesCount >= tournament.playerCapacity

  return {
    isParticipant,
    entryStatus: viewerEntryStatus,
    joinedAs: input.viewerEntryJoinedAs ?? null,
    canJoinSolo:
      viewerProfileId !== null &&
      tournament.status === 'open' &&
      !isParticipant &&
      !isFull &&
      viewerEntryStatus === null,
    canInvitePartner:
      viewerProfileId !== null &&
      tournament.status === 'open' &&
      occupiedPlacesCount < tournament.playerCapacity,
    canLeave: isParticipant && tournament.status === 'open',
    canCancel: isMine && tournament.status === 'open',
  }
}

export function toTournamentSummaryDto(input: ToTournamentSummaryDtoInput): TournamentSummaryDto {
  const { tournament } = input
  const reservedPlacesCount = input.reservedPlacesCount ?? 0
  const occupiedPlacesCount = input.confirmedEntriesCount + reservedPlacesCount
  const availablePlaces = Math.max(0, tournament.playerCapacity - occupiedPlacesCount)
  return {
    tournamentId: tournament.tournamentId,
    name: tournament.name,
    creator: toTournamentCreatorDto(tournament.creatorProfileId, input.creatorPublicProfile),
    visibility: tournament.visibility,
    requiresPassword: tournament.visibility === 'password',
    status: tournament.status,
    statusLabel: getTournamentStatusLabel(tournament.status),
    entryFee: tournament.entryFee,
    playerCapacity: tournament.playerCapacity,
    confirmedEntriesCount: input.confirmedEntriesCount,
    reservedPlacesCount,
    occupiedPlacesCount,
    completedTeamsCount: input.completedTeamsCount,
    formingTeamsCount: input.formingTeamsCount ?? 0,
    availablePlaces,
    isFull: availablePlaces === 0,
    startMode: tournament.startMode,
    scheduledStartAt: tournament.scheduledStartAt,
    createdAt: tournament.createdAt,
    prizePreview: getTournamentPrizePreview(tournament),
    isMine: input.viewerProfileId !== null && input.viewerProfileId === tournament.creatorProfileId,
    viewer: computeViewerParticipation(input),
  }
}

export function toTournamentDetailDto(input: ToTournamentSummaryDtoInput): TournamentDetailDto {
  const summary = toTournamentSummaryDto(input)
  return {
    ...summary,
    cancelReason: input.tournament.cancelReason,
    startedAt: input.tournament.startedAt,
    finishedAt: input.tournament.finishedAt,
    myTeam: null,
    teams: [],
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
  }
}

export function toTournamentPartnerInviteDto(input: {
  invite: TournamentPartnerInviteRecord
  inviterPublicProfile: { profileId: string | null; displayName: string; avatarUrl: string | null } | null
  inviteePublicProfile: { profileId: string | null; displayName: string; avatarUrl: string | null } | null
  tournament?: TournamentRecord | null
}): TournamentPartnerInviteDto {
  const fallback = (profileId: string): TournamentCreatorDto => ({
    profileId,
    displayName: 'Играч',
    avatarUrl: null,
  })
  return {
    inviteId: input.invite.inviteId,
    tournamentId: input.invite.tournamentId,
    teamId: input.invite.teamId,
    inviterProfileId: input.invite.inviterProfileId,
    inviteeProfileId: input.invite.inviteeProfileId,
    inviter: input.inviterPublicProfile ?? fallback(input.invite.inviterProfileId),
    invitee: input.inviteePublicProfile ?? fallback(input.invite.inviteeProfileId),
    status: input.invite.status,
    expiresAt: input.invite.expiresAt,
    popupDismissedAt: input.invite.popupDismissedAt,
    notificationReadAt: input.invite.notificationReadAt,
    createdAt: input.invite.createdAt,
    respondedAt: input.invite.respondedAt,
    tournamentName: input.tournament?.name,
    entryFee: input.tournament?.entryFee,
    startMode: input.tournament?.startMode,
    scheduledStartAt: input.tournament?.scheduledStartAt,
  }
}

export function buildTeamDtos(input: {
  teams: TournamentTeamRecord[]
  entries: TournamentEntryRecord[]
  getPublicProfile: (profileId: string) => { profileId: string | null; displayName: string; avatarUrl: string | null } | null
}): TournamentTeamDto[] {
  return input.teams.map((team) => {
    const members = input.entries
      .filter((entry) => entry.teamId === team.teamId && entry.status === 'confirmed')
      .map((entry) => {
        const profile = input.getPublicProfile(entry.profileId)
        return {
          profileId: entry.profileId,
          displayName: profile?.displayName ?? 'Играч',
          avatarUrl: profile?.avatarUrl ?? null,
          joinedAt: entry.createdAt,
          joinedAs: entry.joinedAs,
        }
      })
    return { teamId: team.teamId, status: team.status, members }
  })
}

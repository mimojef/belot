import type { ProfileId } from '../core/serverTypes.js'
import type {
  TournamentEntryJoinedAs,
  TournamentEntryRecord,
  TournamentEntryStatus,
  TournamentMatchRecord,
  TournamentMatchStatus,
  TournamentPartnerInviteRecord,
  TournamentRecord,
  TournamentRoundRecord,
  TournamentRoundType,
  TournamentStatus,
  TournamentTeamRecord,
} from './tournamentTypes.js'
import type { TournamentMatchAssignment } from './tournamentCoordinator.js'
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
  myPlacement: 'champion' | 'runner_up' | 'eliminated' | null
  myPrizeAmount: number | null
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

export type TournamentMatchDto = {
  matchId: string
  roundId: string
  roomId: string | null
  teamAId: string
  teamBId: string
  status: TournamentMatchStatus
  winnerTeamId: string | null
  resultKind: string | null
  roomReady: boolean
  attendance: {
    state: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed'
    deadlineAt: string | null
    secondsRemaining: number
    resolutionKind: 'all_present' | 'walkover' | 'bots_inserted' | null
    gameStartAt: string | null
    startSecondsRemaining: number
  }
  progressLabel: string
  startedAt: string | null
  completedAt: string | null
}

export type TournamentRoundDto = {
  roundId: string
  roundType: TournamentRoundType
  roundIndex: number
  matches: TournamentMatchDto[]
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
  championTeamId: string | null
  runnerUpTeamId: string | null
  settlementState: 'pending' | 'settled'
  settledAt: string | null
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
  rounds: TournamentRoundDto[]
  myActiveMatch: TournamentMatchAssignment | null
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
const REJOINABLE_VIEWER_ENTRY_STATUSES: TournamentEntryStatus[] = ['refunded', 'withdrawn']

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
  const canRejoin =
    viewerEntryStatus === null || REJOINABLE_VIEWER_ENTRY_STATUSES.includes(viewerEntryStatus)

  return {
    isParticipant,
    entryStatus: viewerEntryStatus,
    joinedAs: input.viewerEntryJoinedAs ?? null,
    canJoinSolo:
      viewerProfileId !== null &&
      tournament.status === 'open' &&
      !isParticipant &&
      !isFull &&
      canRejoin,
    canInvitePartner:
      viewerProfileId !== null &&
      tournament.status === 'open' &&
      occupiedPlacesCount < tournament.playerCapacity &&
      (isParticipant || canRejoin),
    canLeave: isParticipant && tournament.status === 'open',
    canCancel: isMine && tournament.status === 'open',
    myPlacement:
      input.viewerEntryStatus === 'champion'
        ? 'champion'
        : input.viewerEntryStatus === 'finalist' && tournament.settlementState === 'settled'
          ? 'runner_up'
          : input.viewerEntryStatus === 'eliminated'
            ? 'eliminated'
            : null,
    myPrizeAmount:
      input.viewerEntryStatus === 'champion' && tournament.settlementState === 'settled'
        ? tournament.winnerPlayerPrizeAmount
        : input.viewerEntryStatus === 'finalist' && tournament.settlementState === 'settled'
          ? tournament.runnerUpPlayerPrizeAmount
          : null,
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
    championTeamId: tournament.championTeamId,
    runnerUpTeamId: tournament.runnerUpTeamId,
    settlementState: tournament.settlementState,
    settledAt: tournament.settledAt,
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
    rounds: [],
    myActiveMatch: null,
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
  }
}

export function buildTournamentRoundDtos(input: {
  rounds: TournamentRoundRecord[]
  matches: TournamentMatchRecord[]
}): TournamentRoundDto[] {
  const now = Date.now()
  return input.rounds.map((round) => {
    const matches = input.matches
      .filter((match) => match.roundId === round.roundId)
      .map((match) => {
        const deadlineMs = match.attendanceDeadlineAt !== null
          ? Date.parse(match.attendanceDeadlineAt)
          : null
        const gameStartMs = match.gameStartAt !== null ? Date.parse(match.gameStartAt) : null
        const attendanceState: TournamentMatchDto['attendance']['state'] =
          match.status === 'completed'
            ? 'completed'
            : match.status === 'in_progress'
              ? 'started'
              : match.status === 'countdown'
                ? 'countdown'
                : match.attendanceResolutionKind !== null
                  ? 'resolved'
                  : 'waiting'
        const progressLabel =
          match.resultKind === 'walkover'
            ? 'Служебна победа'
            : match.status === 'completed'
              ? 'Завършен'
              : match.status === 'in_progress' && match.resultKind === 'played_with_bots'
                ? 'Играе се с бот'
                : match.status === 'in_progress'
                  ? 'Играе се'
                  : match.status === 'countdown'
                    ? 'Започва след 5 секунди'
                    : match.roomId !== null
                      ? 'Изчакват се играчите'
                      : 'Масата се подготвя'

        return {
          matchId: match.matchId,
          roundId: match.roundId,
          roomId: match.roomId,
          teamAId: match.teamAId,
          teamBId: match.teamBId,
          status: match.status,
          winnerTeamId: match.winnerTeamId,
          resultKind: match.resultKind,
          roomReady: match.roomId !== null && match.status !== 'completed',
          attendance: {
            state: attendanceState,
            deadlineAt: match.attendanceDeadlineAt,
            secondsRemaining: deadlineMs === null ? 0 : Math.max(0, Math.ceil((deadlineMs - now) / 1000)),
            resolutionKind: match.attendanceResolutionKind,
            gameStartAt: match.gameStartAt,
            startSecondsRemaining: gameStartMs === null ? 0 : Math.max(0, Math.ceil((gameStartMs - now) / 1000)),
          },
          progressLabel,
          startedAt: match.startedAt,
          completedAt: match.completedAt,
        }
      })
    return {
      roundId: round.roundId,
      roundType: round.roundType,
      roundIndex: round.roundIndex,
      matches,
    }
  })
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
      .filter((entry) => (
        entry.teamId === team.teamId &&
        (entry.status === 'confirmed' || entry.status === 'finalist' || entry.status === 'champion')
      ))
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

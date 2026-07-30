import type { ProfileId } from '../core/serverTypes.js'
import type { TournamentRecord, TournamentStatus } from './tournamentTypes.js'

// Статуси, показвани по подразбиране в публичния "активен" списък.
// finished/cancelled/admin_cancelled/auto_cancelled/failed изискват
// изричен status филтър (продуктово изискване — няма history tab в този etaп).
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
  completedTeamsCount: number
  startMode: 'fill' | 'scheduled'
  scheduledStartAt: string | null
  createdAt: string
  prizePreview: TournamentPrizePreviewDto
  isMine: boolean
}

export type TournamentDetailDto = TournamentSummaryDto & {
  cancelReason: string | null
  startedAt: string | null
  finishedAt: string | null
}

// 10% системна такса, 90% награден фонд, 70/30 разпределение между
// финалистите — точните продуктови формули (виж CLAUDE.md/продуктови
// изисквания). Само informational preview в този commit — не задейства
// никаква финансова операция.
export function computeTournamentPrizePreview(
  entryFee: number,
  playerCapacity: number,
): TournamentPrizePreviewDto {
  const totalEntryFees = entryFee * playerCapacity
  const systemFee = Math.round(totalEntryFees * 0.1)
  const prizePool = totalEntryFees - systemFee
  const firstTeamPrize = Math.round(prizePool * 0.7)
  const secondTeamPrize = prizePool - firstTeamPrize
  return { totalEntryFees, systemFee, prizePool, firstTeamPrize, secondTeamPrize }
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

export type ToTournamentSummaryDtoInput = {
  tournament: TournamentRecord
  creatorPublicProfile: { profileId: string | null; displayName: string; avatarUrl: string | null } | null
  confirmedEntriesCount: number
  completedTeamsCount: number
  viewerProfileId: ProfileId | null
}

// Безопасен DTO mapping — НИКОГА не пропуска password_hash, cancel_reason
// (в summary виждане), internal statuses без превод, или каквото и да е
// поле извън изрично изброените тук.
export function toTournamentSummaryDto(input: ToTournamentSummaryDtoInput): TournamentSummaryDto {
  const { tournament } = input
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
    completedTeamsCount: input.completedTeamsCount,
    startMode: tournament.startMode,
    scheduledStartAt: tournament.scheduledStartAt,
    createdAt: tournament.createdAt,
    prizePreview: computeTournamentPrizePreview(tournament.entryFee, tournament.playerCapacity),
    isMine: input.viewerProfileId !== null && input.viewerProfileId === tournament.creatorProfileId,
  }
}

export function toTournamentDetailDto(input: ToTournamentSummaryDtoInput): TournamentDetailDto {
  const summary = toTournamentSummaryDto(input)
  return {
    ...summary,
    cancelReason: input.tournament.cancelReason,
    startedAt: input.tournament.startedAt,
    finishedAt: input.tournament.finishedAt,
  }
}

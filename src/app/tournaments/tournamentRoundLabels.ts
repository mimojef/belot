import type { TournamentRoundType } from '../network/createGameServerClient'

export type TournamentRoundLabel = {
  lower: string
  lowerDefinite: string
  title: string
  titleDefinite: string
}

const ROUND_LABELS: Record<TournamentRoundType, TournamentRoundLabel> = {
  round_of_16: {
    lower: 'осминафинал',
    lowerDefinite: 'осминафинала',
    title: 'Осминафинал',
    titleDefinite: 'Осминафинала',
  },
  quarterfinal: {
    lower: 'четвъртфинал',
    lowerDefinite: 'четвъртфинала',
    title: 'Четвъртфинал',
    titleDefinite: 'Четвъртфинала',
  },
  semifinal: {
    lower: 'полуфинал',
    lowerDefinite: 'полуфинала',
    title: 'Полуфинал',
    titleDefinite: 'Полуфинала',
  },
  final: {
    lower: 'финал',
    lowerDefinite: 'финала',
    title: 'Финал',
    titleDefinite: 'Финала',
  },
}

export function getTournamentRoundLabel(roundType: TournamentRoundType): TournamentRoundLabel {
  return ROUND_LABELS[roundType]
}

export function getNextTournamentRoundType(roundType: TournamentRoundType): TournamentRoundType | null {
  if (roundType === 'round_of_16') return 'quarterfinal'
  if (roundType === 'quarterfinal') return 'semifinal'
  if (roundType === 'semifinal') return 'final'
  return null
}

// Inverse of getNextTournamentRoundType — used by the inter-round STATE B
// screen to find which round type the just-created next-round assignment's
// opponent match belongs to (so it can look up "Маса X"/roster/score from
// TournamentDetailSnapshot.rounds once myInterRoundWaiting has already gone
// null in favor of myActiveMatch, see renderTournamentsScreen.ts).
export function getPreviousTournamentRoundType(roundType: TournamentRoundType): TournamentRoundType | null {
  if (roundType === 'final') return 'semifinal'
  if (roundType === 'semifinal') return 'quarterfinal'
  if (roundType === 'quarterfinal') return 'round_of_16'
  return null
}

export function getNextTournamentRoundLabel(roundType: TournamentRoundType): TournamentRoundLabel | null {
  const nextRoundType = getNextTournamentRoundType(roundType)
  return nextRoundType === null ? null : getTournamentRoundLabel(nextRoundType)
}

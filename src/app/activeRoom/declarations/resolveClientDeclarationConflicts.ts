import type { ClientDeclarationCandidate } from './declarationPromptTypes'

const RANK_STRENGTH = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const
const SQUARE_STRENGTH_BY_RANK: Record<string, number> = {
  '7': 0,
  '8': 0,
  '9': 5,
  '10': 3,
  J: 6,
  Q: 1,
  K: 2,
  A: 4,
}
const TYPE_TIEBREAKER: Record<ClientDeclarationCandidate['type'], number> = {
  square: 3,
  sequence: 2,
  belote: 1,
}

function getRankStrength(rank: string | null): number {
  if (rank === null) {
    return -1
  }

  return RANK_STRENGTH.indexOf(rank as (typeof RANK_STRENGTH)[number])
}

function getCandidateTieStrength(candidate: ClientDeclarationCandidate): number {
  if (candidate.type === 'square') {
    return SQUARE_STRENGTH_BY_RANK[candidate.privateMetadata.rank ?? ''] ?? -1
  }

  if (candidate.type === 'sequence') {
    const length = candidate.privateMetadata.sequenceLength ?? 0
    const highRankStrength = getRankStrength(candidate.privateMetadata.highRank)

    return length * 100 + highRankStrength
  }

  return 0
}

function compareDefaultPriority(
  left: ClientDeclarationCandidate,
  right: ClientDeclarationCandidate,
): number {
  if (left.points !== right.points) {
    return right.points - left.points
  }

  const typeDelta = TYPE_TIEBREAKER[right.type] - TYPE_TIEBREAKER[left.type]
  if (typeDelta !== 0) {
    return typeDelta
  }

  const strengthDelta =
    getCandidateTieStrength(right) - getCandidateTieStrength(left)
  if (strengthDelta !== 0) {
    return strengthDelta
  }

  return left.key.localeCompare(right.key)
}

export function clientDeclarationCandidatesOverlap(
  left: ClientDeclarationCandidate,
  right: ClientDeclarationCandidate,
): boolean {
  const rightCardIds = new Set(right.cardIds)

  return left.cardIds.some((cardId) => rightCardIds.has(cardId))
}

function overlapsSelectedCards(
  candidate: ClientDeclarationCandidate,
  selectedCardIds: Set<string>,
): boolean {
  return candidate.cardIds.some((cardId) => selectedCardIds.has(cardId))
}

export function resolveClientDeclarationConflicts(candidates: ClientDeclarationCandidate[]): {
  selectedCandidates: ClientDeclarationCandidate[]
  rejectedCandidates: ClientDeclarationCandidate[]
} {
  const selectedCandidates: ClientDeclarationCandidate[] = []
  const rejectedCandidates: ClientDeclarationCandidate[] = []
  const selectedCardIds = new Set<string>()

  for (const candidate of [...candidates].sort(compareDefaultPriority)) {
    if (overlapsSelectedCards(candidate, selectedCardIds)) {
      rejectedCandidates.push(candidate)
      continue
    }

    selectedCandidates.push(candidate)
    for (const cardId of candidate.cardIds) {
      selectedCardIds.add(cardId)
    }
  }

  selectedCandidates.sort((left, right) => left.key.localeCompare(right.key))
  rejectedCandidates.sort((left, right) => left.key.localeCompare(right.key))

  return {
    selectedCandidates,
    rejectedCandidates,
  }
}

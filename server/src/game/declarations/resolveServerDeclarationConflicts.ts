import type {
  ServerDeclarationCandidate,
  ServerDeclarationConflictResolution,
} from './serverDeclarationTypes.js'

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
const TYPE_TIEBREAKER: Record<ServerDeclarationCandidate['type'], number> = {
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

function getCandidateTieStrength(candidate: ServerDeclarationCandidate): number {
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
  left: ServerDeclarationCandidate,
  right: ServerDeclarationCandidate,
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

type DeclarationCardsRef = Pick<ServerDeclarationCandidate, 'type' | 'cardIds'>

function declarationCandidatesOverlap(
  left: DeclarationCardsRef,
  right: DeclarationCardsRef,
): boolean {
  if (left.type === 'belote' && right.type !== 'belote') {
    return false
  }

  if (right.type === 'belote' && left.type !== 'belote') {
    return false
  }

  const rightCardIds = new Set(right.cardIds)

  return left.cardIds.some((cardId) => rightCardIds.has(cardId))
}

function overlapsSelectedCards(
  candidate: ServerDeclarationCandidate,
  selectedCandidates: ServerDeclarationCandidate[],
): boolean {
  return selectedCandidates.some((selectedCandidate) =>
    declarationCandidatesOverlap(candidate, selectedCandidate),
  )
}

/**
 * Изключва кандидатите, които използват карта от ВЕЧЕ записана обява на
 * същото място (напр. каре, обявено от бота при старта на playing фазата,
 * спрямо терца/50/100 с обща карта при първия му ход). Същото правило за
 * застъпване като resolveServerDeclarationConflicts (белот не се застъпва
 * със square/sequence).
 */
export function excludeCandidatesOverlappingDeclared<T extends DeclarationCardsRef>(
  candidates: T[],
  declared: DeclarationCardsRef[],
): T[] {
  return candidates.filter(
    (candidate) => !declared.some((existing) => declarationCandidatesOverlap(candidate, existing)),
  )
}

export function resolveServerDeclarationConflicts(
  candidates: ServerDeclarationCandidate[],
): ServerDeclarationConflictResolution {
  const selectedCandidates: ServerDeclarationCandidate[] = []
  const rejectedCandidates: ServerDeclarationCandidate[] = []

  for (const candidate of [...candidates].sort(compareDefaultPriority)) {
    if (overlapsSelectedCards(candidate, selectedCandidates)) {
      rejectedCandidates.push(candidate)
      continue
    }

    selectedCandidates.push(candidate)
  }

  selectedCandidates.sort((left, right) => left.key.localeCompare(right.key))
  rejectedCandidates.sort((left, right) => left.key.localeCompare(right.key))

  return {
    selectedCandidates,
    rejectedCandidates,
  }
}

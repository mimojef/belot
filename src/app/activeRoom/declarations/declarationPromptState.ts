import type {
  RoomCardSnapshot,
  RoomPlayCardSnapshot,
} from '../../network/createGameServerClient'
import { detectClientDeclarationCandidates } from './detectClientDeclarationCandidates'
import type {
  ClientDeclarationCandidate,
  ClientDeclarationDetectionContract,
  PendingDeclarationPrompt,
} from './declarationPromptTypes'
import {
  clientDeclarationCandidatesOverlap,
  resolveClientDeclarationConflicts,
} from './resolveClientDeclarationConflicts'

export function filterAlreadySubmittedDeclarationCandidates(
  candidates: ClientDeclarationCandidate[],
  submittedDeclarationKeys: string[],
): ClientDeclarationCandidate[] {
  const submittedKeys = new Set(submittedDeclarationKeys)

  return candidates.filter((candidate) => !submittedKeys.has(candidate.key))
}

export function normalizeSelectedDeclarationKeys(
  candidates: ClientDeclarationCandidate[],
  selectedKeys: string[],
): string[] {
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  const selectedCandidates: ClientDeclarationCandidate[] = []

  for (const key of selectedKeys) {
    const candidate = candidatesByKey.get(key)

    if (!candidate) {
      continue
    }

    const overlapsSelected = selectedCandidates.some((selectedCandidate) =>
      clientDeclarationCandidatesOverlap(candidate, selectedCandidate),
    )

    if (!overlapsSelected) {
      selectedCandidates.push(candidate)
    }
  }

  return selectedCandidates.map((candidate) => candidate.key)
}

export function createPendingDeclarationPrompt(params: {
  cardId: string
  candidates: ClientDeclarationCandidate[]
}): PendingDeclarationPrompt {
  const resolved = resolveClientDeclarationConflicts(params.candidates)

  return {
    cardId: params.cardId,
    options: [...params.candidates].sort((left, right) => left.key.localeCompare(right.key)),
    selectedKeys: resolved.selectedCandidates.map((candidate) => candidate.key),
  }
}

function getCounterpartRank(
  rank: RoomCardSnapshot['rank'],
): RoomCardSnapshot['rank'] | null {
  if (rank === 'Q') {
    return 'K'
  }

  if (rank === 'K') {
    return 'Q'
  }

  return null
}

function canDeclareBeloteForCard(params: {
  contract: ClientDeclarationDetectionContract
  card: RoomCardSnapshot
  currentTrickPlays: RoomPlayCardSnapshot[]
}): boolean {
  const { contract, card, currentTrickPlays } = params

  if (contract === null) {
    return false
  }

  if (contract.contract === 'suit') {
    return contract.trumpSuit === card.suit
  }

  if (contract.contract === 'all-trumps') {
    const leadSuit = currentTrickPlays[0]?.card.suit ?? null

    return leadSuit === null || leadSuit === card.suit
  }

  return false
}

export function resolveClientDeclarationCandidatesForPlay(params: {
  hand: RoomCardSnapshot[]
  contract: ClientDeclarationDetectionContract
  cardId: string
  completedTricksCount: number
  currentTrickPlays: RoomPlayCardSnapshot[]
  submittedDeclarationKeys: string[]
}): ClientDeclarationCandidate[] {
  const {
    hand,
    contract,
    cardId,
    completedTricksCount,
    currentTrickPlays,
    submittedDeclarationKeys,
  } = params

  const detectedCandidates = filterAlreadySubmittedDeclarationCandidates(
    detectClientDeclarationCandidates(hand, contract),
    submittedDeclarationKeys,
  )
  const openingCandidates = completedTricksCount === 0
    ? detectedCandidates.filter((candidate) => candidate.type !== 'belote')
    : []
  const selectedCard = hand.find((card) => card.id === cardId) ?? null
  const counterpartRank = selectedCard === null
    ? null
    : getCounterpartRank(selectedCard.rank)
  const beloteCandidates =
    selectedCard !== null &&
    counterpartRank !== null &&
    canDeclareBeloteForCard({ contract, card: selectedCard, currentTrickPlays })
      ? detectedCandidates.filter(
          (candidate) =>
            candidate.type === 'belote' &&
            candidate.cardIds.includes(selectedCard.id) &&
            candidate.privateMetadata.suit === selectedCard.suit,
        )
      : []
  const candidatesByKey = new Map<string, ClientDeclarationCandidate>()

  for (const candidate of [...openingCandidates, ...beloteCandidates]) {
    candidatesByKey.set(candidate.key, candidate)
  }

  return [...candidatesByKey.values()]
}

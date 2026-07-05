/**
 * humanMoveMemoryV2Shared.ts
 *
 * Споделена логика между buildHumanMoveMemoryIndexV2.ts и
 * analyzeHumanMoveMemoryV2.ts — единствено място, дефиниращо memory-aware
 * ContextVector v2, retrieval distance, и abstract strategy signature v2.
 * Build и analyze/eval ИЗПОЛЗВАТ ТОЧНО СЪЩИТЕ функции оттук (не копия) —
 * същия принцип като cardModelFeatures.ts (trainer/inference не могат да се
 * разминат), приложен тук към index-builder/evaluator чифта.
 *
 * Local-only, offline. Не пипа gameplay, recorder writer, runtime bot
 * behavior. Не заменя server/scripts/buildHumanMoveMemoryIndex.ts (v1) —
 * успоредна v2 версия, v1 остава непроменен.
 */

import { readFile } from 'node:fs/promises'

import { scanFileForForbiddenContent, type SanitizationViolation } from './trainingDataset/sanitizeOutput.js'
import { deriveTeam } from '../src/ai/cardModelFeatures.js'
import { getServerCardPoints, type ServerScoringContract } from '../src/game/serverScoring.js'
import { getServerTrickWinner } from '../src/game/getServerTrickWinner.js'
import type { ServerCard, ServerSuit, ServerTrickPlay, ServerWinningBid } from '../src/game/serverGameTypes.js'
import type { Seat } from '../src/core/serverTypes.js'

// ─── Raw card record shape (matches training-output/baseline/card-*.jsonl, ─
// след "Add Belot card memory dataset features" — включва memory enrichment) ─

export type RawCompactCard = { id: string; suit: string; rank: string }
export type RawContract = {
  bidderSeat: string
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: string | null
  doubled: boolean
  redoubled: boolean
}
export type RawPlayedCard = { sequence: number; trickIndex: number; positionInTrick: number; seat: string; card: RawCompactCard }

export type CardMemorySnapshotRaw = {
  playedCardsSoFar: RawCompactCard[]
  playedCardsBySuit: Record<string, number>
  remainingCardsBySuit: Record<string, number>
  remainingTrumpCount: number
  ownTrumpCount: number
  voidSuitsBySeat: Record<string, string[]>
  partnerVoidSuits: string[]
  opponentVoidSuits: Record<string, string[]>
  knownCannotHaveCardsBySeat: Record<string, RawCompactCard[]>
  currentTrickWinnerSeat: string | null
  currentTrickWinnerSeatIndex: number | null
  currentTrickWinningTeamIndex: number | null
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  pointsInTrick: number
  trickNumber: number
  cardsPlayedInDealCount: number
  remainingCardsCount: number
  ownCleanWinnersCount: number
  ownCleanWinnerCardIds: string[]
  suitExhaustedExceptOwnCards: Record<string, boolean>
}

export type CandidateMemoryFeaturesRaw = {
  id: string
  higherRemainingCardsCount: number
  candidateIsCleanWinner: boolean
  shouldPreserveCleanWinner: boolean
}

export type CardRecordV2 = {
  recordingId: string
  roomKey: string
  dealIndex: number
  sequence: number
  trickIndex: number
  positionInTrick: number
  seat: string
  playerKey: string | null
  ownHand: RawCompactCard[]
  legalCards: RawCompactCard[]
  chosenCard: RawCompactCard
  contract: RawContract
  playedCardCountBeforeAction: number
  currentTrick: RawPlayedCard[]
  currentWinningSeat: string | null
  currentWinningCard: RawCompactCard | null
  dealerSeat: string
  leaderSeat: string
  scoreBeforeDeal: unknown
  memory: CardMemorySnapshotRaw
  chosenCardMemoryFeatures: CandidateMemoryFeaturesRaw
  legalCardsMemoryFeatures: CandidateMemoryFeaturesRaw[]
}

// ─── JSONL parsing / validation (същия strict pattern като v1) ──────────────

export type ParsedLine<T> = { record: T; lineNumber: number }

export function parseJsonlStrict<T>(content: string, fileLabel: string): { lines: ParsedLine<T>[]; errors: string[] } {
  const rawLines = content.split('\n')
  const lines: ParsedLine<T>[] = []
  const errors: string[] = []

  rawLines.forEach((rawLine, idx) => {
    const isLastLine = idx === rawLines.length - 1
    const trimmed = rawLine.trim()
    if (!trimmed) {
      if (!isLastLine) errors.push(`${fileLabel}:${idx + 1}: неочакван празен ред (не е trailing newline)`)
      return
    }
    try {
      lines.push({ record: JSON.parse(trimmed) as T, lineNumber: idx + 1 })
    } catch (e) {
      errors.push(`${fileLabel}:${idx + 1}: invalid JSON — ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  return { lines, errors }
}

export function isValidCompactCard(card: unknown): card is RawCompactCard {
  if (typeof card !== 'object' || card === null) return false
  const c = card as Record<string, unknown>
  return (
    typeof c.id === 'string' && c.id.length > 0 &&
    typeof c.suit === 'string' && c.suit.length > 0 &&
    typeof c.rank === 'string' && c.rank.length > 0
  )
}

const VALID_CONTRACTS = new Set(['suit', 'no-trumps', 'all-trumps'])
const VALID_SUITS = new Set(['clubs', 'diamonds', 'hearts', 'spades'])
const VALID_SEATS = new Set(['bottom', 'right', 'top', 'left'])

function isValidCandidateMemoryFeatures(v: unknown): v is CandidateMemoryFeaturesRaw {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return (
    typeof c.id === 'string' &&
    typeof c.higherRemainingCardsCount === 'number' &&
    typeof c.candidateIsCleanWinner === 'boolean' &&
    typeof c.shouldPreserveCleanWinner === 'boolean'
  )
}

/** Валидира schema-та НА CardRecordV2, включително memory enrichment полетата (за разлика от v1 validateCardRecord). */
export function validateCardRecordV2(r: Partial<CardRecordV2>, label: string): string[] {
  const errors: string[] = []
  if (typeof r.recordingId !== 'string' || !r.recordingId) errors.push(`${label}: липсва recordingId`)
  if (typeof r.roomKey !== 'string' || !r.roomKey) errors.push(`${label}: липсва roomKey`)
  if (typeof r.seat !== 'string' || !VALID_SEATS.has(r.seat)) errors.push(`${label}: невалиден seat`)
  if (typeof r.positionInTrick !== 'number') errors.push(`${label}: липсва positionInTrick`)
  if (!Array.isArray(r.currentTrick)) errors.push(`${label}: currentTrick липсва/невалиден`)

  if (!r.contract || typeof r.contract.contract !== 'string' || !VALID_CONTRACTS.has(r.contract.contract)) {
    errors.push(`${label}: contract липсва/невалиден`)
  } else {
    if (typeof r.contract.bidderSeat !== 'string' || !VALID_SEATS.has(r.contract.bidderSeat)) {
      errors.push(`${label}: contract.bidderSeat липсва/невалиден`)
    }
    if (r.contract.trumpSuit !== null && (typeof r.contract.trumpSuit !== 'string' || !VALID_SUITS.has(r.contract.trumpSuit))) {
      errors.push(`${label}: contract.trumpSuit невалиден`)
    }
  }

  if (!Array.isArray(r.ownHand) || r.ownHand.length === 0) {
    errors.push(`${label}: ownHand липсва/празно`)
  } else if (!r.ownHand.every(isValidCompactCard)) {
    errors.push(`${label}: ownHand съдържа невалидна card representation`)
  }
  if (!Array.isArray(r.legalCards) || r.legalCards.length === 0) {
    errors.push(`${label}: legalCards липсва/празно`)
  } else if (!r.legalCards.every(isValidCompactCard)) {
    errors.push(`${label}: legalCards съдържа невалидна card representation`)
  }
  if (!r.chosenCard || !isValidCompactCard(r.chosenCard)) {
    errors.push(`${label}: chosenCard липсва/невалиден`)
  }
  if (Array.isArray(r.legalCards) && r.chosenCard && isValidCompactCard(r.chosenCard)) {
    const legalIds = new Set(r.legalCards.filter(isValidCompactCard).map((c) => c.id))
    if (!legalIds.has(r.chosenCard.id)) errors.push(`${label}: chosenCard "${r.chosenCard.id}" не е в legalCards`)
  }

  if (!r.memory || typeof r.memory !== 'object') {
    errors.push(`${label}: липсва memory snapshot`)
  } else {
    const m = r.memory
    if (typeof m.remainingTrumpCount !== 'number') errors.push(`${label}: memory.remainingTrumpCount липсва`)
    if (typeof m.ownCleanWinnersCount !== 'number') errors.push(`${label}: memory.ownCleanWinnersCount липсва`)
    if (typeof m.partnerCurrentlyWinning !== 'boolean') errors.push(`${label}: memory.partnerCurrentlyWinning липсва`)
    if (typeof m.opponentCurrentlyWinning !== 'boolean') errors.push(`${label}: memory.opponentCurrentlyWinning липсва`)
    if (typeof m.trickNumber !== 'number') errors.push(`${label}: memory.trickNumber липсва`)
    if (typeof m.cardsPlayedInDealCount !== 'number') errors.push(`${label}: memory.cardsPlayedInDealCount липсва`)
    if (typeof m.remainingCardsCount !== 'number') errors.push(`${label}: memory.remainingCardsCount липсва`)
    if (!m.remainingCardsBySuit || typeof m.remainingCardsBySuit !== 'object') errors.push(`${label}: memory.remainingCardsBySuit липсва`)
    if (!m.suitExhaustedExceptOwnCards || typeof m.suitExhaustedExceptOwnCards !== 'object') errors.push(`${label}: memory.suitExhaustedExceptOwnCards липсва`)
    if (!Array.isArray(m.partnerVoidSuits)) errors.push(`${label}: memory.partnerVoidSuits липсва`)
    if (!m.opponentVoidSuits || typeof m.opponentVoidSuits !== 'object') errors.push(`${label}: memory.opponentVoidSuits липсва`)
  }
  if (!r.chosenCardMemoryFeatures || !isValidCandidateMemoryFeatures(r.chosenCardMemoryFeatures)) {
    errors.push(`${label}: chosenCardMemoryFeatures липсва/невалиден`)
  }
  if (!Array.isArray(r.legalCardsMemoryFeatures) || !r.legalCardsMemoryFeatures.every(isValidCandidateMemoryFeatures)) {
    errors.push(`${label}: legalCardsMemoryFeatures липсва/невалиден`)
  }

  return errors
}

// ─── Privacy scanning (същия pattern като v1) ────────────────────────────────

const EXTRA_FORBIDDEN_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'session', pattern: /"session[a-z]*"\s*:/i },
  { label: 'cookie', pattern: /"cookie"\s*:/i },
  { label: 'authorization', pattern: /"authorization"\s*:/i },
]

async function scanExtraForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  const content = await readFile(filePath, 'utf8')
  const lines = content.split('\n')
  const violations: SanitizationViolation[] = []
  lines.forEach((line, idx) => {
    for (const { label, pattern } of EXTRA_FORBIDDEN_PATTERNS) {
      if (pattern.test(line)) violations.push({ file: filePath, line: idx + 1, pattern: label, snippet: line.slice(0, 200) })
    }
  })
  return violations
}

export async function scanAllForbiddenContent(filePath: string): Promise<SanitizationViolation[]> {
  return [...(await scanFileForForbiddenContent(filePath)), ...(await scanExtraForbiddenContent(filePath))]
}

// ─── Малки helper-и (същия pattern като v1 / analyzeAiCardModelWeaknesses.ts) ─

export function isTrumpCard(suit: string, contract: string, trumpSuit: string | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

export function cardPointsOf(suit: string, rank: string, contract: string, trumpSuit: string | null): number {
  return getServerCardPoints(suit as ServerSuit, rank, contract as ServerScoringContract, trumpSuit as ServerSuit | null)
}

export function pct(part: number, total: number): string {
  if (total === 0) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

export function legalCardsLengthBucket(len: number): 'forced(1)' | '2' | '3' | '4' | '5+' {
  if (len <= 1) return 'forced(1)'
  if (len === 2) return '2'
  if (len === 3) return '3'
  if (len === 4) return '4'
  return '5+'
}

export function trickNumberBucket(trickNumber: number): '0-1' | '2-3' | '4-5' | '6-7' {
  if (trickNumber <= 1) return '0-1'
  if (trickNumber <= 3) return '2-3'
  if (trickNumber <= 5) return '4-5'
  return '6-7'
}

export function remainingTrumpCountBucket(count: number): '0' | '1-2' | '3-4' | '5+' {
  if (count <= 0) return '0'
  if (count <= 2) return '1-2'
  if (count <= 4) return '3-4'
  return '5+'
}

export function ownCleanWinnersCountBucket(count: number): '0' | '1' | '2' | '3+' {
  if (count <= 0) return '0'
  if (count === 1) return '1'
  if (count === 2) return '2'
  return '3+'
}

export function wouldCardWinTrick(record: CardRecordV2, candidate: RawCompactCard): boolean {
  const winningBid: ServerWinningBid = {
    seat: record.contract.bidderSeat as Seat,
    contract: record.contract.contract as ServerScoringContract,
    trumpSuit: record.contract.trumpSuit as ServerSuit | null,
    doubled: record.contract.doubled,
    redoubled: record.contract.redoubled,
  }
  const priorPlays: ServerTrickPlay[] = record.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  const candidatePlay: ServerTrickPlay = { seat: record.seat as Seat, card: candidate as ServerCard }
  const winner = getServerTrickWinner([...priorPlays, candidatePlay], winningBid)
  return winner?.seat === record.seat
}

// ─── ContextVector v2 (decision-level "ситуация" за KNN similarity) ──────────
//
// Старите 10 полета (v1, непроменени) + memory-aware decision-level
// допълнения (item 3 от task brief-а). Per-candidate memory-aware сигнали
// (candidateIsCleanWinner, higherRemainingCardsCount, void-suit относно
// КОНКРЕТНАТА candidate боя и т.н.) НЕ влизат тук — те варират per card, не
// per решение, затова са мястото им в abstract signature-а (computeSignatureForCardV2
// по-долу), не в similarity distance-а между ЦЕЛИ решения. Decision-level
// агрегати като "най-добрият наличен legal избор" (bestLegalHigherRemainingCountNormalized,
// anyLegalCardIsCleanWinner) СА decision-level (зависят от целия legalCards
// набор), затова са тук.

export type ContextVectorV2 = {
  trumpSuit: string | null
  positionInTrick: number
  legalCardsCount: number
  ownTrumpCountNormalized: number
  pointsInTrickNormalized: number
  isOurTeamContractor: 0 | 1
  trickHasTrumpPlayed: 0 | 1
  ownLedSuitCountNormalized: number
  ownHandMaxSuitConcentration: number
  canWinOptionsFraction: number
  // ─── memory-aware допълнения ───────────────────────────────────────────────
  remainingTrumpCountNormalized: number
  trickNumberNormalized: number
  cardsPlayedInDealCountNormalized: number
  remainingCardsCountNormalized: number
  ownCleanWinnersCountNormalized: number
  partnerCurrentlyWinning: 0 | 1
  opponentCurrentlyWinning: 0 | 1
  bestLegalHigherRemainingCountNormalized: number
  anyLegalCardIsCleanWinner: 0 | 1
  anyLegalCardSuitExhaustedExceptOwn: 0 | 1
  partnerVoidForLedSuit: 0 | 1
  opponentVoidForLedSuitCountNormalized: number
}

export type RecordContextV2 = {
  gameMode: string
  isLead: boolean
  ledSuit: string | null
  context: ContextVectorV2
}

const MAX_POINTS_IN_TRICK_NORMALIZER = 60 // същата конвенция като cardModelFeatures.ts / v1

export function buildRecordContextV2(r: CardRecordV2): RecordContextV2 {
  const gameMode = r.contract.contract
  const trumpSuit = r.contract.trumpSuit
  const isLead = r.positionInTrick === 0
  const ledSuit = r.currentTrick.length > 0 ? r.currentTrick[0]!.card.suit : null

  const ownTrumpCount = r.ownHand.filter((c) => isTrumpCard(c.suit, gameMode, trumpSuit)).length
  const ownTrumpCountNormalized = r.ownHand.length > 0 ? ownTrumpCount / r.ownHand.length : 0

  const pointsInTrick = r.currentTrick.reduce((sum, p) => sum + cardPointsOf(p.card.suit, p.card.rank, gameMode, trumpSuit), 0)
  const pointsInTrickNormalized = pointsInTrick / MAX_POINTS_IN_TRICK_NORMALIZER

  const isOurTeamContractor: 0 | 1 = deriveTeam(r.seat) === deriveTeam(r.contract.bidderSeat) ? 1 : 0

  const trickHasTrumpPlayed: 0 | 1 = r.currentTrick.some((p) => isTrumpCard(p.card.suit, gameMode, trumpSuit)) ? 1 : 0

  const ownLedSuitCountNormalized = !isLead && ledSuit
    ? r.ownHand.filter((c) => c.suit === ledSuit).length / r.ownHand.length
    : 0

  const suitCounts: Record<string, number> = {}
  for (const c of r.ownHand) suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1
  const ownHandMaxSuitConcentration = r.ownHand.length > 0 ? Math.max(...Object.values(suitCounts)) / r.ownHand.length : 0

  const canWinOptionsCount = r.legalCards.filter((c) => wouldCardWinTrick(r, c)).length
  const canWinOptionsFraction = r.legalCards.length > 0 ? canWinOptionsCount / r.legalCards.length : 0

  const remainingTrumpCountNormalized = r.memory.remainingTrumpCount / 8
  const trickNumberNormalized = r.memory.trickNumber / 8
  const cardsPlayedInDealCountNormalized = r.memory.cardsPlayedInDealCount / 32
  const remainingCardsCountNormalized = r.memory.remainingCardsCount / 32
  const ownCleanWinnersCountNormalized = r.ownHand.length > 0 ? r.memory.ownCleanWinnersCount / r.ownHand.length : 0
  const partnerCurrentlyWinning: 0 | 1 = r.memory.partnerCurrentlyWinning ? 1 : 0
  const opponentCurrentlyWinning: 0 | 1 = r.memory.opponentCurrentlyWinning ? 1 : 0

  const legalMemory = r.legalCardsMemoryFeatures
  const bestLegalHigherRemainingCountNormalized = legalMemory.length > 0
    ? Math.min(...legalMemory.map((c) => c.higherRemainingCardsCount)) / 7
    : 0
  const anyLegalCardIsCleanWinner: 0 | 1 = legalMemory.some((c) => c.candidateIsCleanWinner) ? 1 : 0
  const anyLegalCardSuitExhaustedExceptOwn: 0 | 1 = r.legalCards.some((c) => r.memory.suitExhaustedExceptOwnCards[c.suit]) ? 1 : 0

  const partnerVoidForLedSuit: 0 | 1 = !isLead && ledSuit ? (r.memory.partnerVoidSuits.includes(ledSuit) ? 1 : 0) : 0
  const opponentVoidForLedSuitCountNormalized = !isLead && ledSuit
    ? Object.values(r.memory.opponentVoidSuits).filter((suits) => suits.includes(ledSuit)).length / 2
    : 0

  return {
    gameMode,
    isLead,
    ledSuit,
    context: {
      trumpSuit,
      positionInTrick: r.positionInTrick,
      legalCardsCount: r.legalCards.length,
      ownTrumpCountNormalized,
      pointsInTrickNormalized,
      isOurTeamContractor,
      trickHasTrumpPlayed,
      ownLedSuitCountNormalized,
      ownHandMaxSuitConcentration,
      canWinOptionsFraction,
      remainingTrumpCountNormalized,
      trickNumberNormalized,
      cardsPlayedInDealCountNormalized,
      remainingCardsCountNormalized,
      ownCleanWinnersCountNormalized,
      partnerCurrentlyWinning,
      opponentCurrentlyWinning,
      bestLegalHigherRemainingCountNormalized,
      anyLegalCardIsCleanWinner,
      anyLegalCardSuitExhaustedExceptOwn,
      partnerVoidForLedSuit,
      opponentVoidForLedSuitCountNormalized,
    },
  }
}

export function buildBucketKey(gameMode: string, isLead: boolean): string {
  return `${gameMode}|${isLead ? 'lead' : 'follow'}`
}

// Теглата са ръчно избрани (не learned/tuned) — същата конвенция както v1
// CONTEXT_WEIGHTS; новите memory-aware измерения получават тегло 1.0 по
// подразбиране (без sensitivity tuning в тази задача, извън обхвата).
const CONTEXT_WEIGHTS_V2 = {
  trumpSuitMismatch: 1.0,
  positionInTrickDiff: 1.0,
  legalCardsCountDiff: 1.0,
  ownTrumpCountDiff: 1.0,
  pointsInTrickDiff: 1.0,
  isOurTeamContractorMismatch: 1.0,
  trickHasTrumpPlayedMismatch: 0.5,
  ownLedSuitCountDiff: 1.0,
  ownHandMaxSuitConcentrationDiff: 0.75,
  canWinOptionsFractionDiff: 1.0,
  remainingTrumpCountDiff: 1.0,
  trickNumberDiff: 1.0,
  cardsPlayedInDealCountDiff: 0.5,
  remainingCardsCountDiff: 0.5,
  ownCleanWinnersCountDiff: 1.0,
  partnerCurrentlyWinningMismatch: 1.0,
  opponentCurrentlyWinningMismatch: 1.0,
  bestLegalHigherRemainingCountDiff: 1.0,
  anyLegalCardIsCleanWinnerMismatch: 1.0,
  anyLegalCardSuitExhaustedExceptOwnMismatch: 0.5,
  partnerVoidForLedSuitMismatch: 1.0,
  opponentVoidForLedSuitCountDiff: 0.5,
}

export function computeContextDistanceV2(a: ContextVectorV2, b: ContextVectorV2): number {
  let dist = 0
  dist += a.trumpSuit === b.trumpSuit ? 0 : CONTEXT_WEIGHTS_V2.trumpSuitMismatch
  dist += Math.abs(a.positionInTrick - b.positionInTrick) / 3 * CONTEXT_WEIGHTS_V2.positionInTrickDiff
  dist += Math.abs(a.legalCardsCount - b.legalCardsCount) / 8 * CONTEXT_WEIGHTS_V2.legalCardsCountDiff
  dist += Math.abs(a.ownTrumpCountNormalized - b.ownTrumpCountNormalized) * CONTEXT_WEIGHTS_V2.ownTrumpCountDiff
  dist += Math.abs(a.pointsInTrickNormalized - b.pointsInTrickNormalized) * CONTEXT_WEIGHTS_V2.pointsInTrickDiff
  dist += a.isOurTeamContractor === b.isOurTeamContractor ? 0 : CONTEXT_WEIGHTS_V2.isOurTeamContractorMismatch
  dist += a.trickHasTrumpPlayed === b.trickHasTrumpPlayed ? 0 : CONTEXT_WEIGHTS_V2.trickHasTrumpPlayedMismatch
  dist += Math.abs(a.ownLedSuitCountNormalized - b.ownLedSuitCountNormalized) * CONTEXT_WEIGHTS_V2.ownLedSuitCountDiff
  dist += Math.abs(a.ownHandMaxSuitConcentration - b.ownHandMaxSuitConcentration) * CONTEXT_WEIGHTS_V2.ownHandMaxSuitConcentrationDiff
  dist += Math.abs(a.canWinOptionsFraction - b.canWinOptionsFraction) * CONTEXT_WEIGHTS_V2.canWinOptionsFractionDiff
  dist += Math.abs(a.remainingTrumpCountNormalized - b.remainingTrumpCountNormalized) * CONTEXT_WEIGHTS_V2.remainingTrumpCountDiff
  dist += Math.abs(a.trickNumberNormalized - b.trickNumberNormalized) * CONTEXT_WEIGHTS_V2.trickNumberDiff
  dist += Math.abs(a.cardsPlayedInDealCountNormalized - b.cardsPlayedInDealCountNormalized) * CONTEXT_WEIGHTS_V2.cardsPlayedInDealCountDiff
  dist += Math.abs(a.remainingCardsCountNormalized - b.remainingCardsCountNormalized) * CONTEXT_WEIGHTS_V2.remainingCardsCountDiff
  dist += Math.abs(a.ownCleanWinnersCountNormalized - b.ownCleanWinnersCountNormalized) * CONTEXT_WEIGHTS_V2.ownCleanWinnersCountDiff
  dist += a.partnerCurrentlyWinning === b.partnerCurrentlyWinning ? 0 : CONTEXT_WEIGHTS_V2.partnerCurrentlyWinningMismatch
  dist += a.opponentCurrentlyWinning === b.opponentCurrentlyWinning ? 0 : CONTEXT_WEIGHTS_V2.opponentCurrentlyWinningMismatch
  dist += Math.abs(a.bestLegalHigherRemainingCountNormalized - b.bestLegalHigherRemainingCountNormalized) * CONTEXT_WEIGHTS_V2.bestLegalHigherRemainingCountDiff
  dist += a.anyLegalCardIsCleanWinner === b.anyLegalCardIsCleanWinner ? 0 : CONTEXT_WEIGHTS_V2.anyLegalCardIsCleanWinnerMismatch
  dist += a.anyLegalCardSuitExhaustedExceptOwn === b.anyLegalCardSuitExhaustedExceptOwn ? 0 : CONTEXT_WEIGHTS_V2.anyLegalCardSuitExhaustedExceptOwnMismatch
  dist += a.partnerVoidForLedSuit === b.partnerVoidForLedSuit ? 0 : CONTEXT_WEIGHTS_V2.partnerVoidForLedSuitMismatch
  dist += Math.abs(a.opponentVoidForLedSuitCountNormalized - b.opponentVoidForLedSuitCountNormalized) * CONTEXT_WEIGHTS_V2.opponentVoidForLedSuitCountDiff
  return dist
}

export function similarityFromDistance(distance: number): number {
  return 1 / (1 + distance)
}

export const CONTEXT_FEATURE_NAMES_V2 = [
  'trumpSuit', 'positionInTrick', 'legalCardsCount', 'ownTrumpCountNormalized', 'pointsInTrickNormalized',
  'isOurTeamContractor', 'trickHasTrumpPlayed', 'ownLedSuitCountNormalized', 'ownHandMaxSuitConcentration',
  'canWinOptionsFraction', 'remainingTrumpCountNormalized', 'trickNumberNormalized',
  'cardsPlayedInDealCountNormalized', 'remainingCardsCountNormalized', 'ownCleanWinnersCountNormalized',
  'partnerCurrentlyWinning', 'opponentCurrentlyWinning', 'bestLegalHigherRemainingCountNormalized',
  'anyLegalCardIsCleanWinner', 'anyLegalCardSuitExhaustedExceptOwn', 'partnerVoidForLedSuit',
  'opponentVoidForLedSuitCountNormalized',
]

// ─── Abstract strategy signature v2 (per-candidate; НИКОГА raw card id) ─────
//
// Базова категория (v1, непроменена): trump | lead | follow | discard.
// memoryTag: приоритетно избран (deterministic first-match) composite label
// от memory-aware стратегическите категории, изисквани от task brief-а (item
// 4) — play/preserve clean winner, spend/preserve trump, win trick, let
// partner win, beat opponent, dump points, discard low non-point, play
// exhausted-suit card, lead clean/non-clean, play where partner/opponent
// void, play с/без по-силни оставащи карти. Приоритетният ред е избран така,
// че по-специфичните/по-редки сигнали (clean winner, exhausted suit) да имат
// предимство пред generic fallback-а ('other'), пазейки label space
// достатъчно малък за смислен vote count per bucket (не комбинаторен explosion
// от независими флагове).

export type PointsTier = 'zero' | 'low' | 'mid' | 'high'
export function pointsTierOf(points: number): PointsTier {
  if (points <= 0) return 'zero'
  if (points <= 4) return 'low'
  if (points <= 9) return 'mid'
  return 'high'
}

export type MemoryStrategyTagInput = {
  isLead: boolean
  isTrump: boolean
  canWin: boolean
  points: number
  candidateIsCleanWinner: boolean
  shouldPreserveCleanWinner: boolean
  ownCleanWinnersCount: number
  ownTrumpCount: number
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  suitExhaustedExceptOwnForCandidateSuit: boolean
  candidateSuitVoidForPartner: boolean
  candidateSuitVoidForOpponentCount: number
  higherRemainingCardsCount: number
}

export function computeMemoryStrategyTag(p: MemoryStrategyTagInput): string {
  if (p.isLead && p.candidateIsCleanWinner) return 'lead_clean_winner'
  if (p.isLead) return 'lead_non_clean'
  if (p.candidateIsCleanWinner) return 'play_clean_winner'
  if (p.shouldPreserveCleanWinner) return 'preserve_clean_winner'
  if (!p.candidateIsCleanWinner && p.ownCleanWinnersCount > 0 && p.higherRemainingCardsCount > 0) return 'preserve_clean_winner_elsewhere'
  if (p.isTrump && p.canWin) return 'spend_trump_win'
  if (p.isTrump && !p.canWin) return 'spend_trump_no_win'
  if (!p.isTrump && p.ownTrumpCount > 0) return 'preserve_trump'
  if (p.canWin && p.opponentCurrentlyWinning) return 'beat_opponent'
  if (p.partnerCurrentlyWinning && !p.canWin && p.points === 0) return 'let_partner_win'
  if (p.partnerCurrentlyWinning && p.points > 0) return 'dump_points_on_partner'
  if (p.opponentCurrentlyWinning && p.points > 0) return 'dump_points_on_opponent'
  if (p.points === 0 && !p.isTrump) return 'discard_low_non_point'
  if (p.suitExhaustedExceptOwnForCandidateSuit) return 'play_exhausted_suit_card'
  if (p.candidateSuitVoidForPartner) return 'play_where_partner_void'
  if (p.candidateSuitVoidForOpponentCount > 0) return 'play_where_opponent_void'
  if (p.higherRemainingCardsCount === 0) return 'no_higher_remaining'
  return 'other'
}

export function computeCardSignatureV2(
  card: RawCompactCard,
  gameMode: string,
  trumpSuit: string | null,
  isLead: boolean,
  ledSuit: string | null,
  canWin: boolean,
  points: number,
  memoryTag: string,
): string {
  const isTrump = isTrumpCard(card.suit, gameMode, trumpSuit)
  const category = isTrump ? 'trump' : isLead ? 'lead' : card.suit === ledSuit ? 'follow' : 'discard'
  return `${category}|canWin${canWin ? 1 : 0}|${pointsTierOf(points)}|${memoryTag}`
}

export const SIGNATURE_DEFINITION_V2 =
  'category(trump|lead|follow|discard)|canWin(0|1)|pointsTier(zero|low|mid|high)|memoryTag(' +
  'lead_clean_winner|lead_non_clean|play_clean_winner|preserve_clean_winner|preserve_clean_winner_elsewhere|' +
  'spend_trump_win|spend_trump_no_win|preserve_trump|beat_opponent|let_partner_win|dump_points_on_partner|' +
  'dump_points_on_opponent|discard_low_non_point|play_exhausted_suit_card|play_where_partner_void|' +
  'play_where_opponent_void|no_higher_remaining|other)'

/**
 * Единствената функция, изчисляваща signature за карта в decision context —
 * ползвана И при build на index entries (за chosenCard), И при eval scoring
 * (за всеки legal candidate) — гарантира build/eval consistency (виж bележка
 * най-горе във файла).
 */
export function computeSignatureForCardV2(
  record: CardRecordV2,
  card: RawCompactCard,
  gameMode: string,
  trumpSuit: string | null,
  isLead: boolean,
  ledSuit: string | null,
): string {
  const candidateMemory = record.legalCardsMemoryFeatures.find((c) => c.id === card.id)
    ?? (card.id === record.chosenCard.id ? record.chosenCardMemoryFeatures : undefined)
    ?? { id: card.id, higherRemainingCardsCount: 0, candidateIsCleanWinner: false, shouldPreserveCleanWinner: false }

  const canWin = wouldCardWinTrick(record, card)
  const points = cardPointsOf(card.suit, card.rank, gameMode, trumpSuit)
  const isTrump = isTrumpCard(card.suit, gameMode, trumpSuit)

  const opponentVoidCount = Object.values(record.memory.opponentVoidSuits).filter((suits) => suits.includes(card.suit)).length

  const memoryTag = computeMemoryStrategyTag({
    isLead,
    isTrump,
    canWin,
    points,
    candidateIsCleanWinner: candidateMemory.candidateIsCleanWinner,
    shouldPreserveCleanWinner: candidateMemory.shouldPreserveCleanWinner,
    ownCleanWinnersCount: record.memory.ownCleanWinnersCount,
    ownTrumpCount: record.memory.ownTrumpCount,
    partnerCurrentlyWinning: record.memory.partnerCurrentlyWinning,
    opponentCurrentlyWinning: record.memory.opponentCurrentlyWinning,
    suitExhaustedExceptOwnForCandidateSuit: record.memory.suitExhaustedExceptOwnCards[card.suit] ?? false,
    candidateSuitVoidForPartner: record.memory.partnerVoidSuits.includes(card.suit),
    candidateSuitVoidForOpponentCount: opponentVoidCount,
    higherRemainingCardsCount: candidateMemory.higherRemainingCardsCount,
  })

  return computeCardSignatureV2(card, gameMode, trumpSuit, isLead, ledSuit, canWin, points, memoryTag)
}

// ─── Train index entry / retrieval ───────────────────────────────────────────

export type TrainIndexEntryV2 = {
  bucketKey: string
  context: ContextVectorV2
  chosenSignature: string
  roomKey: string // само за leakage exclusion — НИКОГА не участва в similarity distance
}

export function buildTrainIndexEntryV2(r: CardRecordV2): TrainIndexEntryV2 {
  const { gameMode, isLead, ledSuit, context } = buildRecordContextV2(r)
  const chosenSignature = computeSignatureForCardV2(r, r.chosenCard, gameMode, r.contract.trumpSuit, isLead, ledSuit)
  return {
    bucketKey: buildBucketKey(gameMode, isLead),
    context,
    chosenSignature,
    roomKey: r.roomKey,
  }
}

export type Neighbor = { similarity: number; signature: string }

export function findNeighborsV2(
  queryContext: ContextVectorV2,
  queryRoomKey: string,
  bucket: TrainIndexEntryV2[],
  k: number,
): Neighbor[] {
  const scored: Neighbor[] = []
  for (const entry of bucket) {
    if (entry.roomKey === queryRoomKey) continue // leakage exclusion — самата стая изключена
    const distance = computeContextDistanceV2(queryContext, entry.context)
    scored.push({ similarity: similarityFromDistance(distance), signature: entry.chosenSignature })
  }
  scored.sort((a, b) => b.similarity - a.similarity)
  return scored.slice(0, k)
}

export type CandidateScore = { card: RawCompactCard; signature: string; voteWeight: number; voteCount: number }

export function scoreCandidatesV2(
  candidates: RawCompactCard[],
  neighbors: Neighbor[],
  record: CardRecordV2,
  gameMode: string,
  trumpSuit: string | null,
  isLead: boolean,
  ledSuit: string | null,
): CandidateScore[] {
  const sigWeight = new Map<string, number>()
  const sigCount = new Map<string, number>()
  for (const n of neighbors) {
    sigWeight.set(n.signature, (sigWeight.get(n.signature) ?? 0) + n.similarity)
    sigCount.set(n.signature, (sigCount.get(n.signature) ?? 0) + 1)
  }

  return candidates
    .map((c) => {
      const signature = computeSignatureForCardV2(record, c, gameMode, trumpSuit, isLead, ledSuit)
      return { card: c, signature, voteWeight: sigWeight.get(signature) ?? 0, voteCount: sigCount.get(signature) ?? 0 }
    })
    .sort((a, b) => b.voteWeight - a.voteWeight || b.voteCount - a.voteCount)
}

// ─── Group accuracy helper (същия pattern като v1 / другите AI scripts) ─────

export type GroupStat = { total: number; correct: number; accuracy: number }
export function emptyGroupStat(): GroupStat {
  return { total: 0, correct: 0, accuracy: 0 }
}
export function bumpGroup(g: GroupStat, correct: boolean): void {
  g.total++
  if (correct) g.correct++
  g.accuracy = g.total > 0 ? g.correct / g.total : 0
}

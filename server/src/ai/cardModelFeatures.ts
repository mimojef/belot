/**
 * cardModelFeatures.ts
 *
 * Shared feature extraction за card-model-v1 И card-model-v2 — единственото
 * място, което дефинира какви feature-и вижда всяка model версия. Използва
 * се И от offline training tooling-а (server/scripts/trainCardModel.ts и
 * др.), И от runtime local AI beta wrapper-а (server/src/ai/localAiCardBeta.ts),
 * за да е гарантирано, че двете никога не могат да се разминат (същия код,
 * не копие). Самият файл няма runtime side-effect — чист feature-computation
 * helper, безопасен за import от production код.
 *
 * ВАЖНО (виж и metrics.md на trainer-а, и weakness-analysis.md): softmax-
 * over-candidates ranking loss дава ТОЧНО нулев градиент за всеки feature,
 * чиято стойност е константна за всички candidate карти в рамките на едно
 * решение (доказуемо: sum_i(probs_i − y_i) = 0 винаги, значи c·0 = 0 за
 * произволна константа c). Затова ВСЕКИ feature set по-долу съдържа само
 * per-candidate-varying стойности + interaction терми — decision-level
 * контекст (own trump count, bidder team и т.н.) винаги влиза само като
 * множител върху per-candidate-varying feature, никога като гол терм.
 */

import { getServerCardPoints, type ServerScoringContract } from '../game/serverScoring.js'
import { getServerCardRankPower, getServerTrickWinner } from '../game/getServerTrickWinner.js'
import type { ServerCard, ServerRank, ServerSuit, ServerTrickPlay, ServerWinningBid } from '../game/serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'

// ─── Shapes (минималният набор полета, нужен за feature computation) ────────

export type CompactCard = { id: string; suit: string; rank: string }
export type CompactPlayedCard = { seat: string; card: CompactCard }

export type CardDecisionState = {
  seat: string
  ownHand: CompactCard[]
  legalCards: CompactCard[]
  // bidderSeat е optional — v1 feature set никога не го чете; v2 го ползва
  // (isOurTeamContractor interaction терми). Липсва ли, v2 просто третира
  // isOurTeamContractor като 0 (виж computeCardModelFeaturesV2 по-долу).
  contract: { contract?: string; trumpSuit?: string | null; bidderSeat?: string | null }
  currentTrick: CompactPlayedCard[]
  currentWinningSeat: string | null
  // ─── v3-only, optional (v1/v2 feature extraction никога не ги четат) ──────
  // Identична форма на server/scripts/trainingDataset/cardMemoryFeatures.ts
  // изхода (memory / legalCardsMemoryFeatures в card-decisions.jsonl) —
  // ДЕКЛАРИРАНА тук независимо (не import-вана), защото src/ (runtime, rootDir
  // boundary) не може да import-ва от scripts/ (виж bележката горе за
  // rootDir="./src"). Ако липсват (напр. runtime state без memory
  // computation), v3 gracefully деградира към неутрални (0/false) стойности —
  // безопасно за accidental beta wrapper usage, виж DEFAULT_MEMORY_CONTEXT.
  memory?: CardMemoryContext
  legalCardsMemoryFeatures?: CandidateMemoryContext[]
}

export type CardMemoryContext = {
  playedCardsBySuit: Record<string, number>
  remainingCardsBySuit: Record<string, number>
  remainingTrumpCount: number
  ownTrumpCount: number
  ownCleanWinnersCount: number
  partnerCurrentlyWinning: boolean
  opponentCurrentlyWinning: boolean
  pointsInTrick: number
  trickNumber: number
  cardsPlayedInDealCount: number
  remainingCardsCount: number
  partnerVoidSuits: string[]
  opponentVoidSuits: Record<string, string[]>
  suitExhaustedExceptOwnCards: Record<string, boolean>
}

export type CandidateMemoryContext = {
  id: string
  higherRemainingCardsCount: number
  candidateIsCleanWinner: boolean
  shouldPreserveCleanWinner: boolean
}

const DEFAULT_MEMORY_CONTEXT: CardMemoryContext = {
  playedCardsBySuit: {},
  remainingCardsBySuit: {},
  remainingTrumpCount: 0,
  ownTrumpCount: 0,
  ownCleanWinnersCount: 0,
  partnerCurrentlyWinning: false,
  opponentCurrentlyWinning: false,
  pointsInTrick: 0,
  trickNumber: 0,
  cardsPlayedInDealCount: 0,
  remainingCardsCount: 0,
  partnerVoidSuits: [],
  opponentVoidSuits: {},
  suitExhaustedExceptOwnCards: {},
}

const DEFAULT_CANDIDATE_MEMORY: CandidateMemoryContext = {
  id: '',
  higherRemainingCardsCount: 0,
  candidateIsCleanWinner: false,
  shouldPreserveCleanWinner: false,
}

export type Team = 'A' | 'B'

// Канонично правило от server/src/game/createInitialAuthoritativeGameState.ts:
// bottom/top → team A, right/left → team B. Само за feature derivation —
// не пипа/дублира runtime team assignment логиката.
export function deriveTeam(seat: string): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function computeIsTrump(suit: string, contract: ServerScoringContract, trumpSuit: ServerSuit | null): 0 | 1 {
  if (contract === 'all-trumps') return 1
  if (contract === 'no-trumps') return 0
  return trumpSuit !== null && suit === trumpSuit ? 1 : 0
}

// ─── card-model-v1 feature names (ред-чувствителни! model.json.featureNames трябва да съвпада точно) ─

export const CARD_MODEL_FEATURE_NAMES = [
  'isTrump',
  'cardPointsNormalized',
  'suitVoidRisk',
  'leadershipTimesTrump',
  'leadershipTimesPoints',
] as const

export type CardModelFeatureName = (typeof CARD_MODEL_FEATURE_NAMES)[number]

/**
 * Изчислява v1 feature вектора за една candidate карта в даден decision
 * context. Редът на върнатите стойности ТРЯБВА да съвпада с
 * CARD_MODEL_FEATURE_NAMES. Непроменена спрямо card-model-v1 — card-model-v2
 * се добавя ПАРАЛЕЛНО (computeCardModelFeaturesV2 по-долу), не замества това.
 */
export function computeCardModelFeatures(state: CardDecisionState, card: CompactCard): number[] {
  const contract = (state.contract.contract ?? 'suit') as ServerScoringContract
  const trumpSuit = (state.contract.trumpSuit ?? null) as ServerSuit | null

  const isTrump = computeIsTrump(card.suit, contract, trumpSuit)

  const cardPoints = getServerCardPoints(card.suit as ServerSuit, card.rank, contract, trumpSuit)
  const cardPointsNormalized = cardPoints / 20 // 20 = максимална точкова стойност (коз Ж)

  const suitCountInHand = state.ownHand.filter((c) => c.suit === card.suit).length
  const suitVoidRisk = state.ownHand.length > 0 ? suitCountInHand / state.ownHand.length : 0

  // trickLeadershipSignal (+1 партньор печели / -1 противник печели / 0 никой
  // все още) е ЕДНАКЪВ за всеки candidate в дадено решение → сам по себе си
  // носи нулев градиент/нула информация в per-candidate scoring. Затова се
  // използва САМО като interaction term с per-candidate-varying features.
  let trickLeadershipSignal = 0
  if (state.currentWinningSeat) {
    const myTeam = deriveTeam(state.seat)
    const winningTeam = deriveTeam(state.currentWinningSeat)
    trickLeadershipSignal = myTeam === winningTeam ? 1 : -1
  }
  const leadershipTimesTrump = trickLeadershipSignal * isTrump
  const leadershipTimesPoints = trickLeadershipSignal * cardPointsNormalized

  return [isTrump, cardPointsNormalized, suitVoidRisk, leadershipTimesTrump, leadershipTimesPoints]
}

// ─── card-model-v2 feature names (ред-чувствителни!) ─────────────────────────
//
// Всичките 5 v1 features се пренасят непроменени (доказано работещи —
// leadershipTimesPoints носи основния реален сигнал в v1). Добавените са
// адресиране на находката от weakness-analysis.md: lead decisions (≈35-37%
// accuracy) са драстично по-слаби от follow (≈76%), защото leadershipTimes*
// е нула на lead (currentWinningSeat===null) и не остава друг силен сигнал.
//
// Всеки НОВ feature е или (a) genuinely per-candidate-varying (canWinTrick,
// leadCandidateStrengthWhenLeading чрез isLead-gate), или (b) interaction
// term между decision-level контекст и per-candidate-varying feature
// (winningPointsInteraction, ownTrumpCountTimesIsTrump,
// isOurTeamContractorTimesTrump/Points) — НИКОГА гол decision-level константен
// терм (виж методологичната бележка най-горе във файла).
//
// Съзнателно ИЗКЛЮЧЕНИ голи decision-level features (биха научили ≈0 тегло):
//  - isLead само по себе си (константен за всички candidates в решението) —
//    вместо това е gate върху leadCandidateStrength.
//  - pointsInTrickNormalized само по себе си (също константен) — вместо това
//    е множител в winningPointsInteraction (чрез canWinTrick, което ВАРИРА).

export const CARD_MODEL_V2_FEATURE_NAMES = [
  'isTrump',
  'cardPointsNormalized',
  'suitVoidRisk',
  'leadershipTimesTrump',
  'leadershipTimesPoints',
  'canWinTrick',
  'winningPointsInteraction',
  'leadCandidateStrengthWhenLeading',
  'ownTrumpCountTimesIsTrump',
  'isOurTeamContractorTimesTrump',
  'isOurTeamContractorTimesPoints',
] as const

export type CardModelV2FeatureName = (typeof CARD_MODEL_V2_FEATURE_NAMES)[number]

// Практичен горен предел за сумата от точки на до 3 вече изиграни карти в
// текущия trick (макс. единична карта = 20, коз Ж) — само за нормализация в
// [0,1]-порядък, не твърдение за математически точен максимум.
const MAX_POINTS_IN_TRICK_NORMALIZER = 60

/**
 * Дали candidate картата би спечелила текущия trick, ако се изиграе точно
 * сега. Reuse-ва canonical getServerTrickWinner (server/src/game/
 * getServerTrickWinner.ts) — СЪЩАТА чиста функция, използвана и от
 * localAiCardBeta.ts за currentWinningSeat, и от gameplay/scoring логиката —
 * не дублира ръчно led-suit/trump-priority сравненията. winningBid.seat е
 * ирелевантно поле за getServerTrickWinner (не участва в сравнението — виж
 * изходния код), затова тук се подава state.seat само за да съществува
 * валиден обект, не защото стойността му влияе на резултата.
 */
function computeCanWinTrick(state: CardDecisionState, card: CompactCard, contract: ServerScoringContract, trumpSuit: ServerSuit | null): 0 | 1 {
  if (state.currentTrick.length === 0) return 1 // lead — все още няма кой да е "по-силен" от нас

  const priorPlays: ServerTrickPlay[] = state.currentTrick.map((p) => ({ seat: p.seat as Seat, card: p.card as ServerCard }))
  const candidatePlay: ServerTrickPlay = { seat: state.seat as Seat, card: card as ServerCard }
  const winningBid: ServerWinningBid = { seat: state.seat as Seat, contract, trumpSuit, doubled: false, redoubled: false }

  const winner = getServerTrickWinner([...priorPlays, candidatePlay], winningBid)
  return winner?.seat === state.seat ? 1 : 0
}

/**
 * Изчислява v2 feature вектора за една candidate карта. Редът ТРЯБВА да
 * съвпада с CARD_MODEL_V2_FEATURE_NAMES.
 */
export function computeCardModelFeaturesV2(state: CardDecisionState, card: CompactCard): number[] {
  const contract = (state.contract.contract ?? 'suit') as ServerScoringContract
  const trumpSuit = (state.contract.trumpSuit ?? null) as ServerSuit | null
  const bidderSeat = state.contract.bidderSeat ?? null

  const isTrump = computeIsTrump(card.suit, contract, trumpSuit)
  const cardPoints = getServerCardPoints(card.suit as ServerSuit, card.rank, contract, trumpSuit)
  const cardPointsNormalized = cardPoints / 20

  const suitCountInHand = state.ownHand.filter((c) => c.suit === card.suit).length
  const suitVoidRisk = state.ownHand.length > 0 ? suitCountInHand / state.ownHand.length : 0

  let trickLeadershipSignal = 0
  if (state.currentWinningSeat) {
    const myTeam = deriveTeam(state.seat)
    const winningTeam = deriveTeam(state.currentWinningSeat)
    trickLeadershipSignal = myTeam === winningTeam ? 1 : -1
  }
  const leadershipTimesTrump = trickLeadershipSignal * isTrump
  const leadershipTimesPoints = trickLeadershipSignal * cardPointsNormalized

  // ── Нови v2 features ──────────────────────────────────────────────────────
  const canWinTrick = computeCanWinTrick(state, card, contract, trumpSuit)

  const pointsInTrick = state.currentTrick.reduce(
    (sum, p) => sum + getServerCardPoints(p.card.suit as ServerSuit, p.card.rank, contract, trumpSuit),
    0,
  )
  const pointsInTrickNormalized = pointsInTrick / MAX_POINTS_IN_TRICK_NORMALIZER
  // canWinTrick ВАРИРА per candidate → произведението варира per candidate,
  // въпреки че pointsInTrickNormalized сам по себе си е decision-level константа.
  const winningPointsInteraction = canWinTrick * pointsInTrickNormalized

  const isLead = state.currentTrick.length === 0 ? 1 : 0
  const rankPower = getServerCardRankPower(card.rank as ServerRank, isTrump === 1)
  const leadCandidateStrength = rankPower / 7
  // isLead е decision-level константа (0 или 1 за ВСИЧКИ candidates в
  // решението) — произведението варира per candidate само защото
  // leadCandidateStrength варира; на follow decisions (isLead=0) терминът е
  // еднакво нулев за всички candidates (носи 0 информация там By design —
  // огледален случай на leadershipTimesTrump/Points, които са 0 на lead).
  const leadCandidateStrengthWhenLeading = isLead * leadCandidateStrength

  const ownTrumpCount = state.ownHand.filter((c) => computeIsTrump(c.suit, contract, trumpSuit) === 1).length
  const ownTrumpCountNormalized = state.ownHand.length > 0 ? ownTrumpCount / state.ownHand.length : 0
  const ownTrumpCountTimesIsTrump = ownTrumpCountNormalized * isTrump

  const isOurTeamContractor = bidderSeat ? (deriveTeam(state.seat) === deriveTeam(bidderSeat) ? 1 : 0) : 0
  const isOurTeamContractorTimesTrump = isOurTeamContractor * isTrump
  const isOurTeamContractorTimesPoints = isOurTeamContractor * cardPointsNormalized

  return [
    isTrump,
    cardPointsNormalized,
    suitVoidRisk,
    leadershipTimesTrump,
    leadershipTimesPoints,
    canWinTrick,
    winningPointsInteraction,
    leadCandidateStrengthWhenLeading,
    ownTrumpCountTimesIsTrump,
    isOurTeamContractorTimesTrump,
    isOurTeamContractorTimesPoints,
  ]
}

// ─── card-model-v3 feature names (ред-чувствителни!) ─────────────────────────
//
// v3 = всичките 11 v2 features (непроменени, reuse чрез computeCardModelFeaturesV2)
// + 14 нови memory-aware features, отговор на Milen-ското "ботът трябва да
// помни цялото раздаване" искане (виж server/scripts/trainingDataset/
// cardMemoryFeatures.ts за derivation-a на самите memory данни, вече записани
// в card-decisions.jsonl от "Add Belot card memory dataset features").
//
// Всеки нов feature е ИЛИ (a) genuinely per-candidate-varying (candidateIsCleanWinner,
// higherRemainingCardsCountNormalized, shouldPreserveCleanWinner,
// suitExhaustedExceptOwnCardsForCandidate, candidateSuitRemainingCountNormalized,
// candidateSuitVoidForPartner/BothOpponents — всички варират по candidate.suit
// или candidate-specific memory lookup), ИЛИ (b) interaction term между
// decision-level memory context (remainingTrumpCount, partnerCurrentlyWinning,
// opponentCurrentlyWinning, pointsInTrick) и per-candidate-varying feature
// (isTrump, canWinTrick, cardPointsNormalized, candidateIsCleanWinner, isLead)
// — НИКОГА гол decision-level константен терм (виж методологичната бележка
// най-горе във файла, доказана емпирично при v1 и потвърдена пак при v2).
//
// Съзнателно ИЗКЛЮЧЕНИ от v3 (биха научили ≈0 тегло като голи features):
//  - ownCleanWinnersCount само по себе си (decision-level константа) — не е
//    добавен като interaction в тази версия (marginal очаквана стойност,
//    largely overlap с shouldPreserveCleanWinner, виж weakness report-а).
//  - trickNumber/cardsPlayedInDealCount/remainingCardsCount голи — decision-level
//    константи без ясен per-candidate interaction partner в тази итерация.
//  - taken-tricks-per-team/running score — все още не са explicit export-нати
//    полета (виж feature gap audit в analyzeAiCardModelWeaknesses.ts).

export const CARD_MODEL_V3_FEATURE_NAMES = [
  ...CARD_MODEL_V2_FEATURE_NAMES,
  'candidateIsCleanWinner',
  'higherRemainingCardsCountNormalized',
  'shouldPreserveCleanWinner',
  'suitExhaustedExceptOwnCardsForCandidate',
  'candidateSuitRemainingCountNormalized',
  'remainingTrumpCountTimesIsTrump',
  'canWinTrickTimesPartnerWinning',
  'canWinTrickTimesOpponentWinning',
  'pointsInTrickTimesCardPoints',
  'cleanWinnerTimesIsLead',
  'cleanWinnerTimesOpponentWinning',
  'cleanWinnerTimesPartnerWinning',
  'candidateSuitVoidForPartner',
  'candidateSuitVoidForBothOpponents',
] as const

export type CardModelV3FeatureName = (typeof CARD_MODEL_V3_FEATURE_NAMES)[number]

/**
 * Изчислява v3 feature вектора (v2's 11 + 14 нови memory-aware features).
 * Редът ТРЯБВА да съвпада с CARD_MODEL_V3_FEATURE_NAMES. Reuse-ва
 * computeCardModelFeaturesV2 непроменено (v2 репродуцируемостта не се засяга)
 * и добавя новите стойности от state.memory/state.legalCardsMemoryFeatures
 * (или safe неутрални defaults, ако липсват — виж DEFAULT_MEMORY_CONTEXT).
 */
export function computeCardModelFeaturesV3(state: CardDecisionState, card: CompactCard): number[] {
  const v2Features = computeCardModelFeaturesV2(state, card)

  const contract = (state.contract.contract ?? 'suit') as ServerScoringContract
  const trumpSuit = (state.contract.trumpSuit ?? null) as ServerSuit | null

  const isTrump = computeIsTrump(card.suit, contract, trumpSuit)
  const cardPoints = getServerCardPoints(card.suit as ServerSuit, card.rank, contract, trumpSuit)
  const cardPointsNormalized = cardPoints / 20
  const canWinTrick = computeCanWinTrick(state, card, contract, trumpSuit)
  const isLead = state.currentTrick.length === 0 ? 1 : 0

  const memory = state.memory ?? DEFAULT_MEMORY_CONTEXT
  const candidateMemory = state.legalCardsMemoryFeatures?.find((c) => c.id === card.id) ?? DEFAULT_CANDIDATE_MEMORY

  const candidateIsCleanWinner = candidateMemory.candidateIsCleanWinner ? 1 : 0
  const higherRemainingCardsCountNormalized = candidateMemory.higherRemainingCardsCount / 7
  const shouldPreserveCleanWinner = candidateMemory.shouldPreserveCleanWinner ? 1 : 0

  const suitExhaustedExceptOwnCardsForCandidate = memory.suitExhaustedExceptOwnCards[card.suit] ? 1 : 0
  const candidateSuitRemainingCountNormalized = (memory.remainingCardsBySuit[card.suit] ?? 0) / 8

  const remainingTrumpCountNormalized = memory.remainingTrumpCount / 8
  const remainingTrumpCountTimesIsTrump = remainingTrumpCountNormalized * isTrump

  const partnerCurrentlyWinning = memory.partnerCurrentlyWinning ? 1 : 0
  const opponentCurrentlyWinning = memory.opponentCurrentlyWinning ? 1 : 0
  const canWinTrickTimesPartnerWinning = canWinTrick * partnerCurrentlyWinning
  const canWinTrickTimesOpponentWinning = canWinTrick * opponentCurrentlyWinning

  const pointsInTrickNormalized = memory.pointsInTrick / MAX_POINTS_IN_TRICK_NORMALIZER
  const pointsInTrickTimesCardPoints = pointsInTrickNormalized * cardPointsNormalized

  const cleanWinnerTimesIsLead = candidateIsCleanWinner * isLead
  const cleanWinnerTimesOpponentWinning = candidateIsCleanWinner * opponentCurrentlyWinning
  const cleanWinnerTimesPartnerWinning = candidateIsCleanWinner * partnerCurrentlyWinning

  const candidateSuitVoidForPartner = memory.partnerVoidSuits.includes(card.suit) ? 1 : 0
  const opponentSeatsVoidForCandidateSuit = Object.values(memory.opponentVoidSuits).filter((suits) => suits.includes(card.suit)).length
  const candidateSuitVoidForBothOpponents = opponentSeatsVoidForCandidateSuit === 2 ? 1 : 0

  return [
    ...v2Features,
    candidateIsCleanWinner,
    higherRemainingCardsCountNormalized,
    shouldPreserveCleanWinner,
    suitExhaustedExceptOwnCardsForCandidate,
    candidateSuitRemainingCountNormalized,
    remainingTrumpCountTimesIsTrump,
    canWinTrickTimesPartnerWinning,
    canWinTrickTimesOpponentWinning,
    pointsInTrickTimesCardPoints,
    cleanWinnerTimesIsLead,
    cleanWinnerTimesOpponentWinning,
    cleanWinnerTimesPartnerWinning,
    candidateSuitVoidForPartner,
    candidateSuitVoidForBothOpponents,
  ]
}

// ─── Version dispatch (позволява trainer/inference да работят с всичките версии) ─

export const CARD_MODEL_VERSIONS = ['card-model-v1', 'card-model-v2', 'card-model-v3'] as const
export type CardModelVersion = (typeof CARD_MODEL_VERSIONS)[number]

export function isSupportedCardModelVersion(version: string): version is CardModelVersion {
  return (CARD_MODEL_VERSIONS as readonly string[]).includes(version)
}

export function getCardModelFeatureNames(version: CardModelVersion): readonly string[] {
  if (version === 'card-model-v3') return CARD_MODEL_V3_FEATURE_NAMES
  if (version === 'card-model-v2') return CARD_MODEL_V2_FEATURE_NAMES
  return CARD_MODEL_FEATURE_NAMES
}

export function computeCardModelFeaturesForVersion(version: CardModelVersion, state: CardDecisionState, card: CompactCard): number[] {
  if (version === 'card-model-v3') return computeCardModelFeaturesV3(state, card)
  if (version === 'card-model-v2') return computeCardModelFeaturesV2(state, card)
  return computeCardModelFeatures(state, card)
}

export function dot(w: readonly number[], x: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < w.length; i++) sum += w[i]! * x[i]!
  return sum
}

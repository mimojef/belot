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

// ─── Version dispatch (позволява trainer/inference да работят с двете версии) ─

export const CARD_MODEL_VERSIONS = ['card-model-v1', 'card-model-v2'] as const
export type CardModelVersion = (typeof CARD_MODEL_VERSIONS)[number]

export function isSupportedCardModelVersion(version: string): version is CardModelVersion {
  return (CARD_MODEL_VERSIONS as readonly string[]).includes(version)
}

export function getCardModelFeatureNames(version: CardModelVersion): readonly string[] {
  return version === 'card-model-v2' ? CARD_MODEL_V2_FEATURE_NAMES : CARD_MODEL_FEATURE_NAMES
}

export function computeCardModelFeaturesForVersion(version: CardModelVersion, state: CardDecisionState, card: CompactCard): number[] {
  return version === 'card-model-v2' ? computeCardModelFeaturesV2(state, card) : computeCardModelFeatures(state, card)
}

export function dot(w: readonly number[], x: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < w.length; i++) sum += w[i]! * x[i]!
  return sum
}

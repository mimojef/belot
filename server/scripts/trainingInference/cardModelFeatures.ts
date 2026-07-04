/**
 * cardModelFeatures.ts
 *
 * Shared feature extraction за card-model-v1 — единственото място, което
 * дефинира какви feature-и вижда моделът. Използва се И от trainer-а
 * (server/scripts/trainCardModel.ts), И от inference wrapper-а
 * (cardModelInference.ts), за да е гарантирано, че двете никога не могат
 * да се разминат (същия код, не копие). Няма runtime ефект върху gameplay —
 * това е чист feature-computation helper за offline training/inference.
 *
 * ВАЖНО (виж и metrics.md на trainer-а): softmax-over-candidates ranking
 * loss дава ТОЧНО нулев градиент за всеки feature, чиято стойност е
 * константна за всички candidate карти в рамките на едно решение (доказуемо:
 * sum_i(probs_i − y_i) = 0 винаги, значи c·0 = 0 за произволна константа c).
 * Затова feature set-ът съдържа само per-candidate-varying стойности +
 * interaction терми — виж CARD_MODEL_FEATURE_NAMES по-долу.
 */

import { getServerCardPoints, type ServerScoringContract } from '../../src/game/serverScoring.js'
import type { ServerSuit } from '../../src/game/serverGameTypes.js'

// ─── Shapes (минималният набор полета, нужен за feature computation) ────────

export type CompactCard = { id: string; suit: string; rank: string }
export type CompactPlayedCard = { seat: string; card: CompactCard }

export type CardDecisionState = {
  seat: string
  ownHand: CompactCard[]
  legalCards: CompactCard[]
  contract: { contract?: string; trumpSuit?: string | null }
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

// ─── Feature names (ред-чувствителни! model.json.featureNames трябва да съвпада точно) ─

export const CARD_MODEL_FEATURE_NAMES = [
  'isTrump',
  'cardPointsNormalized',
  'suitVoidRisk',
  'leadershipTimesTrump',
  'leadershipTimesPoints',
] as const

export type CardModelFeatureName = (typeof CARD_MODEL_FEATURE_NAMES)[number]

/**
 * Изчислява feature вектора за една candidate карта в даден decision context.
 * Редът на върнатите стойности ТРЯБВА да съвпада с CARD_MODEL_FEATURE_NAMES.
 */
export function computeCardModelFeatures(state: CardDecisionState, card: CompactCard): number[] {
  const contract = (state.contract.contract ?? 'suit') as ServerScoringContract
  const trumpSuit = (state.contract.trumpSuit ?? null) as ServerSuit | null

  const isTrump =
    contract === 'all-trumps' ? 1 : contract === 'no-trumps' ? 0 : trumpSuit !== null && card.suit === trumpSuit ? 1 : 0

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

export function dot(w: readonly number[], x: readonly number[]): number {
  let sum = 0
  for (let i = 0; i < w.length; i++) sum += w[i]! * x[i]!
  return sum
}

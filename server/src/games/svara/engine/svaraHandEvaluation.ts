// Свара — оценяване и сравняване на ръце (чиста сървърна логика).
//
// Потвърдени правила (решения на собственика, Етап 2Б.1):
//   • Стойности: A = 11; 10, J, Q, K = 10; 9, 8, 7 — по номинал.
//   • Обикновена ръка: най-големият сбор от карти в една боя; при три
//     различни бои това е най-високата карта.
//   • Две аса = 22 точки.
//   • Чечак (7♣) — жокер за 11 точки, добавя се към най-силната боя
//     (7♣ + A♠ + K♠ = 32; 7♣ + 9♥ + 8♦ = 20).
//   • Три седмици = 34 (вкл. 7♣ + 7 + 7). Три аса = 33 (вкл. 7♣ + A + A).
//   • Други тройки = сбор от картите (KKK = 30 … 888 = 24).
//   • Чечак + две еднакви карти = 11 + стойностите им (7♣ + K♥ + K♦ = 31).
//   • Равни точки = равенство (свара), независимо от състава.
//
// Тълкуване (за потвърждение): ръката получава НАЙ-ВИСОКАТА стойност от
// всички приложими комбинации (напр. A♠ A♥ K♠ = 22 от „две аса“, не 21).

import { assertValidSvaraCards, isSvaraChechak, SVARA_CHECHAK_POINTS, SVARA_SUITS, svaraCardCode, svaraRankPoints, SvaraInvalidInputError, type SvaraCard, type SvaraSuit } from './svaraCards.js'
import { SVARA_CARDS_PER_PLAYER, type SvaraPlayerId } from './svaraDeal.js'

export type SvaraHandKind =
  | 'three-sevens'
  | 'three-aces'
  | 'chechak-three-of-a-kind'
  | 'three-of-a-kind'
  | 'two-aces'
  | 'suit-sum'

export type SvaraHandCandidate = {
  kind: SvaraHandKind
  points: number
  usesChechak: boolean
  /** За 'suit-sum': боята на най-добрия сбор (без чечака). */
  suit?: SvaraSuit
}

export type SvaraHandEvaluation = {
  points: number
  kind: SvaraHandKind
  usesChechak: boolean
  /** Всички приложими комбинации (прозрачност и одит). */
  candidates: readonly SvaraHandCandidate[]
}

export const SVARA_THREE_SEVENS_POINTS = 34
export const SVARA_THREE_ACES_POINTS = 33
export const SVARA_TWO_ACES_POINTS = 22

// Само за етикета при равни кандидати — по-специфичната комбинация първа.
const KIND_PRIORITY: Record<SvaraHandKind, number> = {
  'three-sevens': 0,
  'three-aces': 1,
  'chechak-three-of-a-kind': 2,
  'three-of-a-kind': 3,
  'two-aces': 4,
  'suit-sum': 5,
}

function tripleCandidate(rank: SvaraCard['rank'], points: number, usesChechak: boolean): SvaraHandCandidate {
  if (rank === '7') return { kind: 'three-sevens', points: SVARA_THREE_SEVENS_POINTS, usesChechak }
  if (rank === 'A') return { kind: 'three-aces', points: SVARA_THREE_ACES_POINTS, usesChechak }
  return { kind: usesChechak ? 'chechak-three-of-a-kind' : 'three-of-a-kind', points, usesChechak }
}

export function evaluateSvaraHand(cards: readonly SvaraCard[]): SvaraHandEvaluation {
  assertValidSvaraCards(cards, SVARA_CARDS_PER_PLAYER, 'hand')
  const candidates: SvaraHandCandidate[] = []
  const chechak = cards.find(isSvaraChechak)
  const others = cards.filter((card) => !isSvaraChechak(card))

  // Тройка от три еднакви карти (без чечак като жокер; 7♣ 7♠ 7♥ също е тук).
  if (cards.every((card) => card.rank === cards[0]!.rank)) {
    const rank = cards[0]!.rank
    candidates.push(tripleCandidate(rank, svaraRankPoints(rank) * 3, false))
  }

  // Чечак + две еднакви карти.
  if (chechak && others.length === 2 && others[0]!.rank === others[1]!.rank) {
    const rank = others[0]!.rank
    candidates.push(tripleCandidate(rank, SVARA_CHECHAK_POINTS + svaraRankPoints(rank) * 2, true))
  }

  // Две аса.
  if (cards.filter((card) => card.rank === 'A').length >= 2) {
    candidates.push({ kind: 'two-aces', points: SVARA_TWO_ACES_POINTS, usesChechak: false })
  }

  // Сбор по боя; чечакът (ако има) се добавя към най-силната боя.
  let bestSuit: SvaraSuit = others[0]?.suit ?? 'clubs'
  let bestSum = -1
  for (const suit of SVARA_SUITS) {
    const sum = others.filter((card) => card.suit === suit).reduce((total, card) => total + svaraRankPoints(card.rank), 0)
    if (sum > bestSum) {
      bestSum = sum
      bestSuit = suit
    }
  }
  candidates.push({
    kind: 'suit-sum',
    points: bestSum + (chechak ? SVARA_CHECHAK_POINTS : 0),
    usesChechak: Boolean(chechak),
    suit: bestSuit,
  })

  const best = [...candidates].sort((a, b) => b.points - a.points || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind])[0]!
  return { points: best.points, kind: best.kind, usesChechak: best.usesChechak, candidates: Object.freeze(candidates) }
}

export type SvaraShowdownEntry = { playerId: SvaraPlayerId; cards: readonly SvaraCard[] }

export type SvaraShowdownResult = {
  evaluations: ReadonlyMap<SvaraPlayerId, SvaraHandEvaluation>
  topPoints: number
  /** Всички играчи с най-много точки. >1 = равенство (свара); няма случаен избор. */
  winners: readonly SvaraPlayerId[]
  isTie: boolean
}

/** Сравнява 2 до 4 ръце. Проверява уникални играчи и уникални карти между ръцете. */
export function resolveSvaraShowdown(entries: readonly SvaraShowdownEntry[]): SvaraShowdownResult {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > 4) {
    throw new SvaraInvalidInputError(`showdown: expected 2–4 hands, got ${Array.isArray(entries) ? entries.length : typeof entries}`)
  }
  const players = new Set<string>()
  const cardOwners = new Map<string, string>()
  const evaluations = new Map<SvaraPlayerId, SvaraHandEvaluation>()
  for (const entry of entries) {
    if (typeof entry?.playerId !== 'string' || entry.playerId.trim() === '') throw new SvaraInvalidInputError('showdown: invalid playerId')
    if (players.has(entry.playerId)) throw new SvaraInvalidInputError(`showdown: duplicate player ${entry.playerId}`)
    players.add(entry.playerId)
    const evaluation = evaluateSvaraHand(entry.cards)
    for (const card of entry.cards) {
      const code = svaraCardCode(card)
      const owner = cardOwners.get(code)
      if (owner !== undefined) throw new SvaraInvalidInputError(`showdown: card ${code} appears in hands of ${owner} and ${entry.playerId}`)
      cardOwners.set(code, entry.playerId)
    }
    evaluations.set(entry.playerId, evaluation)
  }
  const topPoints = Math.max(...[...evaluations.values()].map((evaluation) => evaluation.points))
  const winners = entries.map((entry) => entry.playerId).filter((id) => evaluations.get(id)!.points === topPoints)
  return { evaluations, topPoints, winners: Object.freeze(winners), isTie: winners.length > 1 }
}

/** -1 ако a губи, 0 при равенство, 1 ако a печели. */
export function compareSvaraHands(a: readonly SvaraCard[], b: readonly SvaraCard[]): -1 | 0 | 1 {
  const result = resolveSvaraShowdown([{ playerId: 'a', cards: a }, { playerId: 'b', cards: b }])
  if (result.isTie) return 0
  return result.winners[0] === 'a' ? 1 : -1
}

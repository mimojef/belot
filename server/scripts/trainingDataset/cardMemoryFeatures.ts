/**
 * cardMemoryFeatures.ts
 *
 * Belot "card memory" / belief-tracker helper — изчислява за дадено card
 * decision (в рамките на едно раздаване) какво е ИЗВЕСТНО за раздаването
 * ПРЕДИ да е изиграна текущата карта: кои карти вече са излезли, кои остават,
 * кой играч сигурно няма дадена боя (hard fact, изведено от следването на
 * боя правилата), кои карти в собствената ръка са "чисти" (guaranteed да
 * вземат взятка, доколкото е safely derivable), и текущия trick контекст.
 *
 * Използва се от server/scripts/buildTrainingDataset.ts, за да enrich-не
 * card-decisions.jsonl. Не пипа recorder writer-а, gameplay rules или bot
 * strategy — чист read-only feature computation върху вече записаните
 * TrainingDealRecord.tricks / TrainingCardAction данни.
 *
 * ─── Reconstruction на played-card history ────────────────────────────────
 * За дадено human_manual card action в рамките на deal-а:
 *   - completedTricksSoFar = deal.tricks.filter(t => t.trickIndex < action.trickIndex)
 *     (recorder-ът вече записва пълните завършени trick-ове на deal-ниво —
 *     TrainingDealRecord.tricks — join-нато тук по trickIndex, БЕЗ да се
 *     налага recorder writer промяна.)
 *   - currentTrickPlaysSoFar = action.visibleBeforeAction.currentTrick
 *     (вече наличен per-action field — картите, изиграни по-рано В СЪЩИЯ,
 *     все още незавършен trick.)
 *
 * ─── Hard facts vs soft hints ──────────────────────────────────────────────
 * Всичко в този модул е ИЗВЕДЕНО с абсолютна сигурност от правилата за
 * legal play (getServerValidPlayCards.ts) — НЕ вероятностни/heuristic
 * предположения:
 *   - ако seat не е следвал led suit → seat няма led suit (void).
 *   - ако seat е бил задължен да надцака коз (led trump, ИЛИ void в led suit
 *     + партньорът не печели + държи коз), но не го е направил (или изобщо
 *     не е играл коз) → seat няма по-силните козове (или няма коз изобщо).
 * Единственото heuristic поле е `shouldPreserveCleanWinner`, изрично
 * документирано като conservative v1 heuristic, не hard fact.
 */

import { getServerCardPoints, type ServerScoringContract } from '../../src/game/serverScoring.js'
import { getServerCardRankPower } from '../../src/game/getServerTrickWinner.js'
import { SERVER_SUITS } from '../../src/game/serverCardConstants.js'
import type { ServerRank, ServerSuit } from '../../src/game/serverGameTypes.js'

// ─── Public shapes ────────────────────────────────────────────────────────────

export type CompactCard = { id: string; suit: string; rank: string }
export type PlayedCardEntry = { seat: string; card: CompactCard }
export type CompletedTrickInput = { plays: PlayedCardEntry[] }

export type MemoryComputationInput = {
  seat: string
  ownHand: CompactCard[]
  legalCards: CompactCard[]
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: string | null
  completedTricksSoFar: CompletedTrickInput[]
  currentTrickPlaysSoFar: PlayedCardEntry[]
}

export type CardMemorySnapshot = {
  playedCardsSoFar: CompactCard[]
  playedCardsBySuit: Record<string, number>
  remainingCardsBySuit: Record<string, number>
  remainingTrumpCount: number
  ownTrumpCount: number
  voidSuitsBySeat: Record<string, string[]>
  partnerVoidSuits: string[]
  opponentVoidSuits: Record<string, string[]>
  knownCannotHaveCardsBySeat: Record<string, CompactCard[]>
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
}

export type CandidateMemoryFeatures = {
  id: string
  higherRemainingCardsCount: number
  candidateIsCleanWinner: boolean
  shouldPreserveCleanWinner: boolean
}

// ─── Seat/team helpers (същата конвенция като cardModelFeatures.ts/buildHumanMoveMemoryIndex.ts) ─

const SEAT_ORDER = ['bottom', 'right', 'top', 'left']

function seatIndexOf(seat: string): number {
  return SEAT_ORDER.indexOf(seat)
}
function teamIndexOf(seat: string): 0 | 1 {
  return seat === 'bottom' || seat === 'top' ? 0 : 1
}
function partnerSeatOf(seat: string): string {
  const idx = SEAT_ORDER.indexOf(seat)
  return SEAT_ORDER[(idx + 2) % 4]!
}
function opponentSeatsOf(seat: string): string[] {
  const idx = SEAT_ORDER.indexOf(seat)
  return [SEAT_ORDER[(idx + 1) % 4]!, SEAT_ORDER[(idx + 3) % 4]!]
}

// ─── Rank/point helpers (reuse на canonical game rule функции, не дублирани) ──

function isTrumpSuitCard(suit: string, contract: string, trumpSuit: string | null): boolean {
  if (contract === 'all-trumps') return true
  if (contract === 'no-trumps') return false
  return trumpSuit !== null && suit === trumpSuit
}

function cardPointsOf(card: CompactCard, contract: string, trumpSuit: string | null): number {
  return getServerCardPoints(card.suit as ServerSuit, card.rank, contract as ServerScoringContract, trumpSuit as ServerSuit | null)
}

// "Trump-order" rank power (J-9-A-10-K-Q-8-7) — единствената relevantна подредба
// за overtake/overtrump сравнения, независимо дали контекстът е реален коз
// (suit contract) или "everything is trump" (all-trumps) — идентично на
// TRUMP_RANK_POWER таблицата в getServerValidPlayCards.ts (потвърдено чрез
// инспекция на изходния код), reuse-нато чрез getServerCardRankPower(rank, true).
function trumpOrderPower(rank: string): number {
  return getServerCardRankPower(rank as ServerRank, true)
}

// ─── Played card aggregation ──────────────────────────────────────────────────

function flattenPlayedCards(input: MemoryComputationInput): PlayedCardEntry[] {
  return [...input.completedTricksSoFar.flatMap((t) => t.plays), ...input.currentTrickPlaysSoFar]
}

function computePlayedCardsBySuit(playedCardsSoFar: CompactCard[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const suit of SERVER_SUITS) counts[suit] = 0
  for (const c of playedCardsSoFar) counts[c.suit] = (counts[c.suit] ?? 0) + 1
  return counts
}

function computeOwnHandBySuit(ownHand: CompactCard[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const suit of SERVER_SUITS) counts[suit] = 0
  for (const c of ownHand) counts[c.suit] = (counts[c.suit] ?? 0) + 1
  return counts
}

// ─── Void-suit deduction (hard fact) ───────────────────────────────────────────
// Разширение спрямо съществуващия voidSuitsOf() в pickServerBotPlayCard.ts:
// там се проверяват само ЗАВЪРШЕНИ trick-ове; тук допълнително се проверява и
// текущия (незавършен) trick до момента на решението — СЪЩОТО правило
// ("не следва led suit → void"), приложено върху повече вече наблюдавани
// данни, не различна логика.

function computeVoidSuitsBySeat(input: MemoryComputationInput): Record<string, Set<string>> {
  const voids: Record<string, Set<string>> = {}
  for (const seat of SEAT_ORDER) voids[seat] = new Set<string>()

  const allTricks: PlayedCardEntry[][] = [
    ...input.completedTricksSoFar.map((t) => t.plays),
    input.currentTrickPlaysSoFar,
  ]

  for (const plays of allTricks) {
    const leadSuit = plays[0]?.card.suit
    if (!leadSuit) continue
    for (const play of plays) {
      if (play.card.suit !== leadSuit) {
        voids[play.seat]!.add(leadSuit)
      }
    }
  }

  return voids
}

// ─── Overtrump-failure deduction (hard fact) ──────────────────────────────────
// Директно изведено от getServerValidPlayCards.ts (getValidCardsInSuitContract /
// getValidCardsInAllTrumpsContract) — играчът е ЗАДЪЛЖЕН да играе от
// "higherTrumps", ако то е непразно; ако реално изиграната карта не е сред
// по-силните карти, това ДОКАЗВА, че higherTrumps е било празно за него в
// онзи момент → той няма никоя от still-по-силните карти (за тази боя/коз).
// Ако вместо коз е изиграл трета боя, докато е бил длъжен да играе коз (void
// в led suit + партньорът не печели) → доказва пълен void в коза (добавя се
// към voidSuitsBySeat, не тук). Прилага се само върху ЗАВЪРШЕНИ trick-ове
// (същия обхват като voidSuitsOf) — текущия trick не носи допълнителна
// информация тук, защото вече е директно видим в currentTrick.
function computeKnownCannotHaveCardsBySeat(
  input: MemoryComputationInput,
  voidSuitsBySeat: Record<string, Set<string>>,
): Record<string, CompactCard[]> {
  const result: Record<string, Map<string, Set<string>>> = {} // seat -> suit -> excluded ranks
  const addExclusion = (seat: string, suit: string, minPowerExclusive: number) => {
    if (!result[seat]) result[seat] = new Map()
    if (!result[seat]!.has(suit)) result[seat]!.set(suit, new Set())
    for (const rank of ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']) {
      if (trumpOrderPower(rank) > minPowerExclusive) result[seat]!.get(suit)!.add(rank)
    }
  }

  const { contract, trumpSuit } = input

  for (const trick of input.completedTricksSoFar) {
    const plays = trick.plays
    const leadSuit = plays[0]?.card.suit
    if (!leadSuit) continue

    if (contract === 'no-trumps') continue // няма коз концепция

    if (contract === 'all-trumps') {
      // Всеки играч, следвал led suit, е бил длъжен да надцака, ако е възможно.
      for (let i = 1; i < plays.length; i++) {
        const play = plays[i]!
        if (play.card.suit !== leadSuit) continue // void в led suit, вече обхванато
        const priorInSuit = plays.slice(0, i).filter((p) => p.card.suit === leadSuit)
        const highestBefore = priorInSuit.length > 0
          ? Math.max(...priorInSuit.map((p) => trumpOrderPower(p.card.rank)))
          : -1
        if (trumpOrderPower(play.card.rank) <= highestBefore) {
          addExclusion(play.seat, leadSuit, highestBefore)
        }
      }
      continue
    }

    // contract === 'suit'
    if (!trumpSuit) continue
    const ledTrump = leadSuit === trumpSuit

    for (let i = 1; i < plays.length; i++) {
      const play = plays[i]!
      const priorPlays = plays.slice(0, i)

      if (ledTrump) {
        if (play.card.suit !== trumpSuit) continue // void в коз, вече обхванато
        const priorTrumps = priorPlays.filter((p) => p.card.suit === trumpSuit)
        const highestBefore = priorTrumps.length > 0
          ? Math.max(...priorTrumps.map((p) => trumpOrderPower(p.card.rank)))
          : -1
        if (trumpOrderPower(play.card.rank) <= highestBefore) {
          addExclusion(play.seat, trumpSuit, highestBefore)
        }
        continue
      }

      // Not led trump: обикновено follow-suit; overtrump обвързаност само ако
      // играчът е void в led suit (доказано именно от това, че играе друга боя).
      if (play.card.suit === leadSuit) continue // следва нормално, няма нова информация

      // void в led suit доказано тук — провери дали партньорът е печелил преди хода му.
      const winnerBefore = computeLocalTrickWinner(priorPlays, contract, trumpSuit)
      const partnerWasWinning = winnerBefore !== null && teamIndexOf(winnerBefore) === teamIndexOf(play.seat)
      if (partnerWasWinning) continue // няма overtrump задължение

      if (play.card.suit !== trumpSuit) {
        // Играл е трета боя, докато е бил длъжен да коз (партньорът не печели) →
        // доказва пълен void в коза. Маркираме като "изключени всички рангове".
        addExclusion(play.seat, trumpSuit, -1)
        continue
      }

      // Играл е коз — провери дали е надцакал наличния най-силен коз в трика.
      const priorTrumps = priorPlays.filter((p) => p.card.suit === trumpSuit)
      const highestBefore = priorTrumps.length > 0
        ? Math.max(...priorTrumps.map((p) => trumpOrderPower(p.card.rank)))
        : -1
      if (trumpOrderPower(play.card.rank) <= highestBefore) {
        addExclusion(play.seat, trumpSuit, highestBefore)
      }
    }
  }

  const output: Record<string, CompactCard[]> = {}
  for (const [seat, bySuit] of Object.entries(result)) {
    const cards: CompactCard[] = []
    for (const [suit, ranks] of bySuit) {
      for (const rank of ranks) {
        // Ако вече знаем seat-ът е напълно void в тази боя (или изрично маркирано
        // "всички рангове" по-горе), не дублираме информация вече в voidSuitsBySeat.
        if (voidSuitsBySeat[seat]?.has(suit)) continue
        cards.push({ id: `${suit}-${rank}`, suit, rank })
      }
    }
    if (cards.length > 0) output[seat] = cards
  }
  return output
}

// Локален trick-winner helper върху PARTIAL plays (преди даден ход) — не
// извиква getServerTrickWinner директно, защото това изисква Seat literal
// типове и ServerWinningBid обект; тук работим с raw string seats от
// recorder-a, затова малка локална версия на СЪЩОТО правило (led suit follow +
// trump priority + trump-order rank power), напълно съгласувана с
// getServerTrickWinner.ts (използва идентичната trumpOrderPower функция).
function computeLocalTrickWinner(plays: PlayedCardEntry[], contract: string, trumpSuit: string | null): string | null {
  if (plays.length === 0) return null
  const leadSuit = plays[0]!.card.suit
  let bestSeat = plays[0]!.seat
  let bestCard = plays[0]!.card

  const isTrump = (c: CompactCard) => isTrumpSuitCard(c.suit, contract, trumpSuit)

  for (let i = 1; i < plays.length; i++) {
    const challenger = plays[i]!
    const bestIsTrump = isTrump(bestCard)
    const challengerIsTrump = isTrump(challenger.card)

    let challengerWins: boolean
    if (challengerIsTrump && !bestIsTrump) challengerWins = true
    else if (!challengerIsTrump && bestIsTrump) challengerWins = false
    else if (challengerIsTrump && bestIsTrump) challengerWins = trumpOrderPower(challenger.card.rank) > trumpOrderPower(bestCard.rank)
    else {
      const bestFollows = bestCard.suit === leadSuit
      const challengerFollows = challenger.card.suit === leadSuit
      if (challengerFollows && !bestFollows) challengerWins = true
      else if (!challengerFollows && bestFollows) challengerWins = false
      else if (challengerFollows && bestFollows) challengerWins = trumpOrderPower(challenger.card.rank) > trumpOrderPower(bestCard.rank)
      else challengerWins = false
    }

    if (challengerWins) {
      bestSeat = challenger.seat
      bestCard = challenger.card
    }
  }

  return bestSeat
}

// ─── Higher-remaining-cards / clean-winner computation ────────────────────────

function computeHigherRemainingCardsCount(
  card: CompactCard,
  isTrump: boolean,
  remainingCardsBySuit: Record<string, number>,
  playedCardsSoFar: CompactCard[],
  ownHand: CompactCard[],
): number {
  // "Remaining unseen" карти в релевантната боя = обявения count по боя минус
  // самата candidate карта (тя е в ownHand, вече изключена от remainingCardsBySuit).
  const relevantSuit = card.suit
  const remainingInSuit = remainingCardsBySuit[relevantSuit] ?? 0
  if (remainingInSuit === 0) return 0

  // Кои конкретни рангове от тази боя вече са "видени" (изиграни или в own hand)?
  const seenRanks = new Set<string>()
  for (const c of playedCardsSoFar) if (c.suit === relevantSuit) seenRanks.add(c.rank)
  for (const c of ownHand) if (c.suit === relevantSuit) seenRanks.add(c.rank)

  const candidatePower = isTrump ? trumpOrderPower(card.rank) : naturalOrderPower(card.rank)
  let count = 0
  for (const rank of ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']) {
    if (seenRanks.has(rank)) continue // вече видяна (изиграна или собствена) — не е "remaining unseen"
    const power = isTrump ? trumpOrderPower(rank) : naturalOrderPower(rank)
    if (power > candidatePower) count++
  }
  return count
}

// Natural (non-trump) rank power — идентично на NO_TRUMPS_RANK_POWER в
// getServerTrickWinner.ts, reuse-нато чрез getServerCardRankPower(rank, false).
function naturalOrderPower(rank: string): number {
  return getServerCardRankPower(rank as ServerRank, false)
}

// ─── Main snapshot computation ────────────────────────────────────────────────

export function computeCardMemorySnapshot(input: MemoryComputationInput): CardMemorySnapshot {
  const { seat, ownHand, contract, trumpSuit } = input

  const playedCardsSoFar = flattenPlayedCards(input).map((p) => p.card)
  const playedCardsBySuit = computePlayedCardsBySuit(playedCardsSoFar)
  const ownHandBySuit = computeOwnHandBySuit(ownHand)

  const remainingCardsBySuit: Record<string, number> = {}
  for (const suit of SERVER_SUITS) {
    remainingCardsBySuit[suit] = 8 - (playedCardsBySuit[suit] ?? 0) - (ownHandBySuit[suit] ?? 0)
  }

  const ownTrumpCount = ownHand.filter((c) => isTrumpSuitCard(c.suit, contract, trumpSuit)).length

  // remainingTrumpCount: за no-trumps/all-trumps няма отделна "коз" боя различна
  // от текущо водената — по конвенция 0 (документирано в item 4 на task brief-а).
  const remainingTrumpCount = contract === 'suit' && trumpSuit ? (remainingCardsBySuit[trumpSuit] ?? 0) : 0

  const voidSuitsBySeatSets = computeVoidSuitsBySeat(input)
  const voidSuitsBySeat: Record<string, string[]> = {}
  for (const [s, set] of Object.entries(voidSuitsBySeatSets)) voidSuitsBySeat[s] = [...set].sort()

  const knownCannotHaveCardsBySeat = computeKnownCannotHaveCardsBySeat(input, voidSuitsBySeatSets)

  const partner = partnerSeatOf(seat)
  const opponents = opponentSeatsOf(seat)
  const partnerVoidSuits = voidSuitsBySeat[partner] ?? []
  const opponentVoidSuits: Record<string, string[]> = {}
  for (const opp of opponents) opponentVoidSuits[opp] = voidSuitsBySeat[opp] ?? []

  const currentTrickWinnerSeat = computeLocalTrickWinner(input.currentTrickPlaysSoFar, contract, trumpSuit)
  const currentTrickWinnerSeatIndex = currentTrickWinnerSeat ? seatIndexOf(currentTrickWinnerSeat) : null
  const currentTrickWinningTeamIndex = currentTrickWinnerSeat ? teamIndexOf(currentTrickWinnerSeat) : null
  const partnerCurrentlyWinning = currentTrickWinnerSeat === partner
  const opponentCurrentlyWinning = currentTrickWinnerSeat !== null && opponents.includes(currentTrickWinnerSeat)

  const pointsInTrick = input.currentTrickPlaysSoFar.reduce((sum, p) => sum + cardPointsOf(p.card, contract, trumpSuit), 0)

  const trickNumber = input.completedTricksSoFar.length // 0-based: брой ЗАВЪРШЕНИ trick-ове преди текущия
  const cardsPlayedInDealCount = playedCardsSoFar.length
  const remainingCardsCount = 32 - ownHand.length - playedCardsSoFar.length

  // ownCleanWinners: изчислени по СЪЩОТО правило като candidateIsCleanWinner,
  // приложено върху всяка карта в own hand (не само legalCards).
  const ownCleanWinnerCardIds: string[] = []
  for (const card of ownHand) {
    const isTrump = isTrumpSuitCard(card.suit, contract, trumpSuit)
    const higherCount = computeHigherRemainingCardsCount(card, isTrump, remainingCardsBySuit, playedCardsSoFar, ownHand)
    const clean = isTrump
      ? higherCount === 0
      : higherCount === 0 && remainingTrumpCount === 0
    if (clean) ownCleanWinnerCardIds.push(card.id)
  }

  return {
    playedCardsSoFar,
    playedCardsBySuit,
    remainingCardsBySuit,
    remainingTrumpCount,
    ownTrumpCount,
    voidSuitsBySeat,
    partnerVoidSuits,
    opponentVoidSuits,
    knownCannotHaveCardsBySeat,
    currentTrickWinnerSeat,
    currentTrickWinnerSeatIndex,
    currentTrickWinningTeamIndex,
    partnerCurrentlyWinning,
    opponentCurrentlyWinning,
    pointsInTrick,
    trickNumber,
    cardsPlayedInDealCount,
    remainingCardsCount,
    ownCleanWinnersCount: ownCleanWinnerCardIds.length,
    ownCleanWinnerCardIds,
  }
}

/**
 * Per-candidate memory features (изчислени за ЕДНА candidate карта — извиква
 * се веднъж за chosenCard и по желание веднъж за всяка карта в legalCards).
 *
 * shouldPreserveCleanWinner е CONSERVATIVE v1 heuristic (не hard fact):
 *   preserve ⟺ candidateIsCleanWinner
 *            И NOT (противникът в момента печели И pointsInTrick >= 10 — т.е.
 *              трикът вече не е "евтин" да се остави на противника)
 *            И съществува друга legal карта, която е "low-risk" discard
 *              (не коз И 0 точки) — т.е. играчът има безопасна алтернатива.
 */
export function computeCandidateMemoryFeatures(
  input: MemoryComputationInput,
  snapshot: CardMemorySnapshot,
  candidate: CompactCard,
): CandidateMemoryFeatures {
  const { contract, trumpSuit } = input
  const isTrump = isTrumpSuitCard(candidate.suit, contract, trumpSuit)
  const higherRemainingCardsCount = computeHigherRemainingCardsCount(
    candidate, isTrump, snapshot.remainingCardsBySuit, snapshot.playedCardsSoFar, input.ownHand,
  )
  const candidateIsCleanWinner = isTrump
    ? higherRemainingCardsCount === 0
    : higherRemainingCardsCount === 0 && snapshot.remainingTrumpCount === 0

  const PRESERVE_POINTS_THRESHOLD = 10
  const hasLowRiskAlternative = input.legalCards.some((c) => {
    if (c.id === candidate.id) return false
    const cIsTrump = isTrumpSuitCard(c.suit, contract, trumpSuit)
    return !cIsTrump && cardPointsOf(c, contract, trumpSuit) === 0
  })
  const trickNotUrgent = !(snapshot.opponentCurrentlyWinning && snapshot.pointsInTrick >= PRESERVE_POINTS_THRESHOLD)
  const shouldPreserveCleanWinner = candidateIsCleanWinner && trickNotUrgent && hasLowRiskAlternative

  return { id: candidate.id, higherRemainingCardsCount, candidateIsCleanWinner, shouldPreserveCleanWinner }
}

/**
 * true за боя, ако всички 8 карти от нея вече са "отчетени" между изиграните
 * досега и own hand — т.е. останалите (ако има) са гарантирано в own hand
 * (пример на Milen: 6 излезли + 2 в ръката на бота = боята е "изчерпана
 * другаде", тези 2 са clean).
 */
export function computeSuitExhaustedExceptOwnCards(snapshot: CardMemorySnapshot, ownHandBySuit: Record<string, number>, suit: string): boolean {
  const played = snapshot.playedCardsBySuit[suit] ?? 0
  const own = ownHandBySuit[suit] ?? 0
  return played + own === 8 && own > 0 && played < 8
}

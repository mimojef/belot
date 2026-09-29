// Sequence guard за Anti Bad Luck: пази пълните финални 8 карти на всичките
// 4 seats от изкуствени кварти/квинти, създадени от rescue swap-овете
// (включително когато изместена карта създаде поредица при ДРУГ seat).
// Естествените кварти/квинти (от normal shuffle) НИКОГА не се пипат тук —
// това не е scoring/declarations логика, а чист structural guard преди
// bidding. Независим от declarations/detectServerDeclarationsInHand.ts,
// защото той е contract/trump-gated (връща [] при "без коз" и се нуждае от
// winning bid) — неподходящ за проверка преди bidding изобщо да е започнал.

import { SERVER_SEAT_ORDER, type Seat } from '../../core/serverTypes.js'
import { SERVER_SUITS } from '../serverCardConstants.js'
import type { ServerCard, ServerRank, ServerSuit } from '../serverGameTypes.js'

// Продуктови вероятности — теглят се ТОЧНО ВЕДНЪЖ на rescue execution (виж
// applyServerAntiBadLuckToDeck), не на всеки candidate/retry.
export const SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUART_CHANCE = 0.25
export const SERVER_ANTI_BAD_LUCK_ARTIFICIAL_QUINT_PLUS_CHANCE = 0.1

const RUN_RANK_ORDER: ServerRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export type ServerAntiBadLuckLongRunKind = 'QUART' | 'QUINT_PLUS'

export type ServerAntiBadLuckLongRun = {
  suit: ServerSuit
  kind: ServerAntiBadLuckLongRunKind
  length: number
  cardIds: string[]
}

export type ServerAntiBadLuckSequenceAllowance = {
  allowArtificialQuart: boolean
  allowArtificialQuintPlus: boolean
}

function getRunRankIndex(rank: ServerRank): number {
  return RUN_RANK_ORDER.indexOf(rank)
}

function toRunKind(length: number): ServerAntiBadLuckLongRunKind {
  return length === 4 ? 'QUART' : 'QUINT_PLUS'
}

// Maximal same-suit consecutive run (7-8-9-10-J-Q-K-A) с дължина >= 4.
// Максимум 1 такъв run на suit (8 ранга общо не позволяват 2 disjoint runs
// >= 4 в един suit: 4+1+4=9 > 8), затова връщаме suit -> run map, а не списък
// — и квинтата никога не се брои като 2 припокриващи се кварти (maximal run,
// не всички под-прозорци).
export function findServerAntiBadLuckLongRuns(
  cards: readonly ServerCard[],
): Partial<Record<ServerSuit, ServerAntiBadLuckLongRun>> {
  const result: Partial<Record<ServerSuit, ServerAntiBadLuckLongRun>> = {}

  for (const suit of SERVER_SUITS) {
    const suitCards = cards
      .filter((card) => card.suit === suit)
      .slice()
      .sort((left, right) => getRunRankIndex(left.rank) - getRunRankIndex(right.rank))

    let currentRun: ServerCard[] = []

    const flush = () => {
      if (currentRun.length >= 4) {
        result[suit] = {
          suit,
          kind: toRunKind(currentRun.length),
          length: currentRun.length,
          cardIds: currentRun.map((card) => card.id),
        }
      }
      currentRun = []
    }

    for (const card of suitCards) {
      const previous = currentRun[currentRun.length - 1]

      if (previous && getRunRankIndex(card.rank) === getRunRankIndex(previous.rank) + 1) {
        currentRun.push(card)
        continue
      }

      flush()
      currentRun = [card]
    }

    flush()
  }

  return result
}

type RunTransition = 'unchanged' | 'destroyed' | 'new-quart' | 'new-quint-plus'

// Natural run трябва да остане ЦЯЛА (всичките ѝ карти) вътре в post-run-а,
// иначе се смята за разрушена — дори ако по случайност съществува run със
// същата дължина от съвсем други карти на нейно място (т.3: не жертваме
// естествен късмет). Удължаване се брои за "ново" само когато премине bucket
// (QUART -> QUINT_PLUS, т.5); QUINT_PLUS удължен до по-дълъг QUINT_PLUS си
// остава в същия bucket и не е "ново".
function classifyTransition(
  naturalRun: ServerAntiBadLuckLongRun | undefined,
  postRun: ServerAntiBadLuckLongRun | undefined,
): RunTransition {
  if (!naturalRun) {
    if (!postRun) return 'unchanged'
    return postRun.kind === 'QUART' ? 'new-quart' : 'new-quint-plus'
  }

  const isPreserved = !!postRun && naturalRun.cardIds.every((id) => postRun.cardIds.includes(id))

  if (!isPreserved) {
    return 'destroyed'
  }

  if (postRun!.length === naturalRun.length) {
    return 'unchanged'
  }

  return naturalRun.kind === 'QUART' && postRun!.kind === 'QUINT_PLUS' ? 'new-quint-plus' : 'unchanged'
}

// Сравнява natural срещу candidate финални 8-карти ръце на всичките 4 seats:
// - разрушена natural quart/quint (на който и да е seat, rescued или не) →
//   unconditional reject;
// - 0 нови дълги поредици на масата → allowed;
// - точно 1 нова QUART → allowed само ако allowance.allowArtificialQuart;
// - точно 1 нова QUINT_PLUS → allowed само ако allowance.allowArtificialQuintPlus;
// - 2+ нови (без значение от вида/отбора) → unconditional reject.
export function isServerAntiBadLuckSequencePlanSafe(
  naturalHandsBySeat: Record<Seat, readonly ServerCard[]>,
  candidateHandsBySeat: Record<Seat, readonly ServerCard[]>,
  allowance: ServerAntiBadLuckSequenceAllowance,
): boolean {
  let newQuartCount = 0
  let newQuintPlusCount = 0

  for (const seat of SERVER_SEAT_ORDER) {
    const naturalRuns = findServerAntiBadLuckLongRuns(naturalHandsBySeat[seat])
    const postRuns = findServerAntiBadLuckLongRuns(candidateHandsBySeat[seat])

    for (const suit of SERVER_SUITS) {
      const transition = classifyTransition(naturalRuns[suit], postRuns[suit])

      if (transition === 'destroyed') {
        return false
      }

      if (transition === 'new-quart') newQuartCount += 1
      if (transition === 'new-quint-plus') newQuintPlusCount += 1
    }
  }

  const totalNew = newQuartCount + newQuintPlusCount

  if (totalNew === 0) return true
  if (totalNew >= 2) return false

  return newQuartCount === 1 ? allowance.allowArtificialQuart : allowance.allowArtificialQuintPlus
}

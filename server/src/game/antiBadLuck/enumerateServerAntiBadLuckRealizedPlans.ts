// RNG-free "concrete realized plan" engine за minimum-swap planner-а (виж
// applyServerAntiBadLuckToDeck.ts). За разлика от applyServerAntiBadLuckRescueSwaps
// (която ползва nextRandom за tie-break между еднакво слаби естествени карти —
// запазена непипната за стария picker API и legacy fixture-а), тази функция
// enumerate-ва ВСИЧКИ distinct final decks, допустими от текущата "заменяме
// най-слабите natural карти first" политика, БЕЗ никакъв random избор:
//   - tie между карти с еднаква keepStrength на cutoff границата се
//     enumerate-ва explicit (всички C(group, needed) избора), не се решава
//     с shuffle;
//   - при >1 липсваща карта, чиито "donor" позиции може да се окажат в
//     различни seats, enumerate-ваме permutations на assignment-а, доколкото
//     биха довели до различен final deck (dedupe-нато по действителния
//     resultDeck).
// Не разширява eligibility към по-силни target карти — мандаторните (строго
// по-слаби от cutoff-а) позиции винаги се заменят; само tier-ът на cutoff-а
// се enumerate-ва комбинаторно.

import type { Seat } from '../../core/serverTypes.js'
import { getServerAntiBadLuckKeepStrength } from './evaluateServerFirstFiveQuality.js'
import type { ServerCard } from '../serverGameTypes.js'
import type { ServerAntiBadLuckRescue } from './serverAntiBadLuckTypes.js'

export type ServerAntiBadLuckRealizedPlan = {
  resultDeck: ServerCard[]
  swapCount: number
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) {
    return [[]]
  }

  if (size > items.length) {
    return []
  }

  const [first, ...rest] = items
  const withFirst = combinations(rest, size - 1).map((combo) => [first as T, ...combo])
  const withoutFirst = combinations(rest, size)

  return [...withFirst, ...withoutFirst]
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [items.slice()]
  }

  const result: T[][] = []

  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)]

    for (const permutation of permutations(rest)) {
      result.push([items[index] as T, ...permutation])
    }
  }

  return result
}

// Всички distinct множества от `count` target positions, допустими от
// "replace weakest first" политиката: позиции строго по-слаби от cutoff-а са
// мандаторни (винаги включени); позициите на cutoff-а (еднаква keepStrength)
// се enumerate-ват комбинаторно — всеки избор е еднакво валиден според
// текущата semantics (tie = equally weak = equally eligible).
function enumerateTargetPositionSets(
  replaceablePositions: readonly number[],
  strengthAt: (position: number) => number,
  count: number,
): number[][] {
  if (count === 0) {
    return [[]]
  }

  const sorted = [...replaceablePositions].sort((left, right) => strengthAt(left) - strengthAt(right))
  const tiers: number[][] = []

  for (const position of sorted) {
    const strength = strengthAt(position)
    const lastTier = tiers[tiers.length - 1]

    if (lastTier && strengthAt(lastTier[0] as number) === strength) {
      lastTier.push(position)
    } else {
      tiers.push([position])
    }
  }

  const mandatory: number[] = []
  let remaining = count

  for (const tier of tiers) {
    if (remaining <= 0) {
      break
    }

    if (tier.length <= remaining) {
      mandatory.push(...tier)
      remaining -= tier.length
      continue
    }

    // Cutoff tier: избираме `remaining` от `tier.length` еднакво слаби карти.
    return combinations(tier, remaining).map((chosen) => [...mandatory, ...chosen])
  }

  return [mandatory]
}

// Enumerate-ва ВСИЧКИ distinct concrete realized plans (final decks) за даден
// abstract rescue candidate върху даден seat — изцяло RNG-free. Dedupe-ва по
// действителната последователност от card ids в resultDeck (различни
// target-set/assignment избори понякога водят до идентичен final deck, напр.
// когато всички "donor" позиции на липсващите карти принадлежат на един и
// същ друг seat — тогава редът на assignment-а не променя кой seat какво
// получава).
export function enumerateServerAntiBadLuckRealizedPlans(
  deck: readonly ServerCard[],
  seat: Seat,
  firstFiveIndices: Record<Seat, number[]>,
  rescue: ServerAntiBadLuckRescue,
): ServerAntiBadLuckRealizedPlan[] {
  const positionById = new Map(deck.map((card, index) => [card.id, index]))
  const seatPositions = firstFiveIndices[seat]
  const rescueCardIds = new Set(rescue.cardIds)

  const missingCardIds = rescue.cardIds.filter(
    (cardId) => !seatPositions.includes(positionById.get(cardId) as number),
  )
  const swapCount = missingCardIds.length

  if (swapCount === 0) {
    return [{ resultDeck: deck as ServerCard[], swapCount: 0 }]
  }

  const replaceablePositions = seatPositions.filter((position) => !rescueCardIds.has(deck[position]!.id))
  const strengthAt = (position: number) => getServerAntiBadLuckKeepStrength(deck[position]!, rescue)

  const targetPositionSets = enumerateTargetPositionSets(replaceablePositions, strengthAt, swapCount)
  const missingCardOrders = permutations(missingCardIds)

  const seenDeckKeys = new Set<string>()
  const plans: ServerAntiBadLuckRealizedPlan[] = []

  for (const targetPositions of targetPositionSets) {
    for (const missingOrder of missingCardOrders) {
      const nextDeck = [...deck]
      const swap = (left: number, right: number) => {
        const leftCard = nextDeck[left]!
        nextDeck[left] = nextDeck[right]!
        nextDeck[right] = leftCard
      }

      missingOrder.forEach((cardId, index) => {
        swap(targetPositions[index] as number, positionById.get(cardId) as number)
      })

      const key = nextDeck.map((card) => card.id).join(',')

      if (seenDeckKeys.has(key)) {
        continue
      }

      seenDeckKeys.add(key)
      plans.push({ resultDeck: nextDeck, swapCount })
    }
  }

  return plans
}

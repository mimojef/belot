// Избира 3-те контролирани rescue карти. Всички избори (тип, цвят, шаблон,
// конкретна тройка) са равновероятни и НЕ зависят от играч, отбор, bidding
// или резултат. `unavailableCardIds` пази deck invariant при два едновременни
// rescue-а — конфликтни тройки се филтрират в рамките на избрания основен тип
// (друг цвят/шаблон е позволен); никога преминаване към друг тип.

import { SERVER_RANKS, SERVER_SUITS } from '../serverCardConstants.js'
import type { ServerRank, ServerSuit } from '../serverGameTypes.js'
import {
  SERVER_ANTI_BAD_LUCK_MIN_SUIT_VALUE,
  SERVER_ANTI_BAD_LUCK_TRUMP_VALUES,
} from './evaluateServerFirstFiveQuality.js'
import type {
  ServerAntiBadLuckAnchorConstraints,
  ServerAntiBadLuckRescue,
  ServerAntiBadLuckRescueType,
} from './serverAntiBadLuckTypes.js'

const NO_ANCHOR_CONSTRAINTS: ServerAntiBadLuckAnchorConstraints = { naturalAnchorSuits: [] }

const RESCUE_TYPES: ServerAntiBadLuckRescueType[] = ['SUIT', 'ALL_TRUMPS', 'NO_TRUMPS']
const PAIR_TEMPLATES = ['TRIPLE', 'PAIR_PLUS'] as const

type PairTemplate = (typeof PAIR_TEMPLATES)[number]

function toCardId(suit: ServerSuit, rank: ServerRank): string {
  return `${suit}-${rank}`
}

function pickRandom<T>(items: readonly T[], nextRandom: () => number): T {
  const index = Math.min(items.length - 1, Math.floor(nextRandom() * items.length))
  return items[index]
}

// Всички тройки от цвета: J + две други карти, сума >= 31.
function getSuitTriples(suit: ServerSuit): string[][] {
  const others = SERVER_RANKS.filter((rank) => rank !== 'J')
  const triples: string[][] = []

  for (let first = 0; first < others.length; first += 1) {
    for (let second = first + 1; second < others.length; second += 1) {
      const total =
        SERVER_ANTI_BAD_LUCK_TRUMP_VALUES.J +
        SERVER_ANTI_BAD_LUCK_TRUMP_VALUES[others[first]] +
        SERVER_ANTI_BAD_LUCK_TRUMP_VALUES[others[second]]

      if (total >= SERVER_ANTI_BAD_LUCK_MIN_SUIT_VALUE) {
        triples.push([
          toCardId(suit, 'J'),
          toCardId(suit, others[first]),
          toCardId(suit, others[second]),
        ])
      }
    }
  }

  return triples
}

// TRIPLE: XXX (4 комбинации). PAIR_PLUS: XX + companion към едното X (6 × 2).
function getPairTemplateTriples(
  anchorRank: ServerRank,
  companionRank: ServerRank,
  template: PairTemplate,
): string[][] {
  const triples: string[][] = []

  if (template === 'TRIPLE') {
    for (const excludedSuit of SERVER_SUITS) {
      triples.push(
        SERVER_SUITS.filter((suit) => suit !== excludedSuit).map((suit) => toCardId(suit, anchorRank)),
      )
    }

    return triples
  }

  for (let first = 0; first < SERVER_SUITS.length; first += 1) {
    for (let second = first + 1; second < SERVER_SUITS.length; second += 1) {
      const anchorIds = [
        toCardId(SERVER_SUITS[first], anchorRank),
        toCardId(SERVER_SUITS[second], anchorRank),
      ]

      triples.push([...anchorIds, toCardId(SERVER_SUITS[first], companionRank)])
      triples.push([...anchorIds, toCardId(SERVER_SUITS[second], companionRank)])
    }
  }

  return triples
}

// Ограничава кандидатите до тези, дето включват вече наличните natural
// anchor (J/A) цветове — за да не rescue-нем над естествени карти вместо да
// ги преизползваме (иначе рискуваме 4 J/4 A в първите 5).
// 0 natural → без ограничение (старото поведение).
// 1 natural → само candidates, включващи точно този цвят (TRIPLE/PAIR_PLUS
//   и двата остават възможни, 50/50 preferred variant).
// 2 natural → форсиран PAIR_PLUS с anchor = точно тези 2 цвята, companion
//   само към единия от тях (TRIPLE винаги отпада — би добавил 3-то anchor).
// 3+ natural → seat вече е natural GOOD (не би трябвало да стигне дотук);
//   defensive — без candidates изобщо.
function getConstrainedPairTemplateTriples(
  anchorRank: ServerRank,
  companionRank: ServerRank,
  template: PairTemplate,
  requiredSuits: readonly ServerSuit[],
): string[][] {
  if (requiredSuits.length >= 3) {
    return []
  }

  if (requiredSuits.length === 2) {
    if (template === 'TRIPLE') {
      return []
    }

    const [first, second] = requiredSuits

    return [
      [toCardId(first, anchorRank), toCardId(second, anchorRank), toCardId(first, companionRank)],
      [toCardId(first, anchorRank), toCardId(second, anchorRank), toCardId(second, companionRank)],
    ]
  }

  const allTriples = getPairTemplateTriples(anchorRank, companionRank, template)

  if (requiredSuits.length === 0) {
    return allTriples
  }

  const requiredCardId = toCardId(requiredSuits[0], anchorRank)

  return allTriples.filter((triple) => triple.includes(requiredCardId))
}

function getTypeCandidates(
  type: ServerAntiBadLuckRescueType,
  variant: string,
  anchorConstraints: ServerAntiBadLuckAnchorConstraints = NO_ANCHOR_CONSTRAINTS,
): string[][] {
  if (type === 'SUIT') {
    return getSuitTriples(variant as ServerSuit)
  }

  return type === 'ALL_TRUMPS'
    ? getConstrainedPairTemplateTriples('J', '9', variant as PairTemplate, anchorConstraints.naturalAnchorSuits)
    : getConstrainedPairTemplateTriples('A', '10', variant as PairTemplate, anchorConstraints.naturalAnchorSuits)
}

function getTypeVariants(type: ServerAntiBadLuckRescueType): readonly string[] {
  return type === 'SUIT' ? SERVER_SUITS : PAIR_TEMPLATES
}

// Основният тип (строго 1/3) се тегли ВЕДНЪЖ на rescue и никога не се сменя
// от compatibility retry-ите.
export function pickServerAntiBadLuckRescueType(
  nextRandom: () => number = Math.random,
): ServerAntiBadLuckRescueType {
  return pickRandom(RESCUE_TYPES, nextRandom)
}

// Всички реализации на типа (всеки цвят/шаблон × всяка тройка) — за
// изчерпателното търсене, когато random опитите не намерят съвместим план.
export function getServerAntiBadLuckRescueCandidates(
  type: ServerAntiBadLuckRescueType,
  anchorConstraints: ServerAntiBadLuckAnchorConstraints = NO_ANCHOR_CONSTRAINTS,
): ServerAntiBadLuckRescue[] {
  return getTypeVariants(type).flatMap((variant) =>
    getTypeCandidates(type, variant, anchorConstraints).map((cardIds) => ({ type, variant, cardIds })),
  )
}

// Предпочитан цвят (1/4) / шаблон (1/2) в рамките на типа. Сменя се само ако
// за него няма безопасна реализация — така retry-ите не изкривяват
// честотата на цветовете/шаблоните.
// При 2 natural anchor цвята (ALL_TRUMPS/NO_TRUMPS) TRIPLE отпада изцяло —
// форсираме PAIR_PLUS, защото TRIPLE винаги би добавил 3-то anchor.
export function pickServerAntiBadLuckRescueVariant(
  type: ServerAntiBadLuckRescueType,
  nextRandom: () => number = Math.random,
  anchorConstraints: ServerAntiBadLuckAnchorConstraints = NO_ANCHOR_CONSTRAINTS,
): string {
  if (type !== 'SUIT' && anchorConstraints.naturalAnchorSuits.length >= 2) {
    return 'PAIR_PLUS'
  }

  return pickRandom(getTypeVariants(type), nextRandom)
}

// В рамките на избрания тип: random цвят/шаблон измежду тези, които още имат
// свободна тройка (или само `onlyVariant`, ако е подаден), после random тройка
// в него. null, ако няма свободна тройка — без преминаване към друг тип.
export function pickServerAntiBadLuckRescue(
  type: ServerAntiBadLuckRescueType,
  unavailableCardIds: ReadonlySet<string>,
  nextRandom: () => number = Math.random,
  onlyVariant?: string,
  anchorConstraints: ServerAntiBadLuckAnchorConstraints = NO_ANCHOR_CONSTRAINTS,
): ServerAntiBadLuckRescue | null {
  const isAvailable = (cardIds: string[]) => cardIds.every((cardId) => !unavailableCardIds.has(cardId))
  const availableVariants = getTypeVariants(type)
    .filter((variant) => onlyVariant === undefined || variant === onlyVariant)
    .map((variant) => ({
      variant,
      triples: getTypeCandidates(type, variant, anchorConstraints).filter(isAvailable),
    }))
    .filter(({ triples }) => triples.length > 0)

  if (availableVariants.length === 0) {
    return null
  }

  const { variant, triples } = pickRandom(availableVariants, nextRandom)

  return { type, variant, cardIds: pickRandom(triples, nextRandom) }
}

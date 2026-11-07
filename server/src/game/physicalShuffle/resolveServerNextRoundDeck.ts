import type { ServerAntiBadLuckConfig } from '../antiBadLuck/serverAntiBadLuckTypes.js'
import { createServerDeck } from '../createServerDeck.js'
import type { ServerAuthoritativeGameState, ServerCard } from '../serverGameTypes.js'
import { shuffleServerDeck } from '../shuffleServerDeck.js'
import { applyServerPhysicalShuffle } from './applyServerPhysicalShuffle.js'
import { collectServerRoundPile, isServerFullDeckPermutation } from './collectServerRoundPile.js'
import {
  SERVER_PHYSICAL_SHUFFLE_DEFAULT_MODE,
  isServerPhysicalShuffleMode,
  type ServerNextRoundDeckOrigin,
  type ServerPhysicalShuffleMode,
  type ServerPhysicalShuffleTransfer,
} from './serverPhysicalShuffleTypes.js'

export type ServerNextRoundDeck = {
  deck: ServerCard[]
  origin: ServerNextRoundDeckOrigin
  mode: ServerPhysicalShuffleMode | null
  transfers: ServerPhysicalShuffleTransfer[]
}

function createFreshRandomDeck(): ServerNextRoundDeck {
  return { deck: shuffleServerDeck(createServerDeck()), origin: 'fresh-random', mode: null, transfers: [] }
}

// Тестето за СЛЕДВАЩОТО раздаване (вика се от startNextServerRound, ПРЕДИ
// state-ът на приключилото раздаване да бъде нулиран).
//
//   - Anti Bad Luck активен (threshold ≠ 0) или липсващ config → съществуващото
//     поведение: пълно случайно разбъркване на ново тесте (непроменено).
//   - threshold 0 + валидна събрана камара (32 карти) → физическо размесване
//     по admin метода (RANDOM_INSERT по подразбиране).
//   - threshold 0, но камарата не може да бъде събрана/валидирана →
//     безопасен fallback към пълно случайно разбъркване.
//
// Първото раздаване на мача НЕ минава оттук (chooseServerFirstDealer →
// createServerRoundStartState без подготвено тесте → случайно разбъркване).
export function resolveServerNextRoundDeck(
  previousRoundState: ServerAuthoritativeGameState,
  config: ServerAntiBadLuckConfig | null,
  nextRandom: () => number = Math.random,
): ServerNextRoundDeck {
  if (config === null || config.threshold !== 0) {
    return createFreshRandomDeck()
  }

  const mode = isServerPhysicalShuffleMode(config.physicalShuffleMode)
    ? config.physicalShuffleMode
    : SERVER_PHYSICAL_SHUFFLE_DEFAULT_MODE

  const pile = collectServerRoundPile(previousRoundState)
  if (pile === null) {
    console.warn('[physical-shuffle] previous round pile is not a valid 32-card deck — falling back to random shuffle')
    return createFreshRandomDeck()
  }

  try {
    const shuffled = applyServerPhysicalShuffle(pile.cards, mode, nextRandom)
    // Defense-in-depth: applyServerPhysicalShuffle вече verify-ва пермутацията.
    if (!isServerFullDeckPermutation(shuffled.deck)) {
      throw new Error('result is not a full-deck permutation')
    }
    return { deck: shuffled.deck, origin: 'physical-shuffle', mode, transfers: shuffled.transfers }
  } catch (error) {
    console.error('[physical-shuffle] shuffle failed — falling back to random shuffle:', error)
    return createFreshRandomDeck()
  }
}

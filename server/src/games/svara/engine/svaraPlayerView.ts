// Свара — изглед на раздаването за конкретен играч (основа за бъдещото
// сървърно филтриране на състоянието). Клиентът получава САМО своите карти;
// за останалите — само броя им. Тестето и чуждите карти не напускат сървъра.

import { svaraCardCode, type SvaraCardCode } from './svaraCards.js'
import type { SvaraDealResult, SvaraPlayerId } from './svaraDeal.js'

export type SvaraPlayerDealView = {
  viewerId: SvaraPlayerId
  /** Собствените карти на зрителя; null ако зрителят не участва. */
  ownCards: readonly SvaraCardCode[] | null
  seats: ReadonlyArray<{ playerId: SvaraPlayerId; cardCount: number }>
}

export function createSvaraPlayerDealView(deal: SvaraDealResult, viewerId: SvaraPlayerId): SvaraPlayerDealView {
  const own = deal.hands.get(viewerId)
  return {
    viewerId,
    ownCards: own ? Object.freeze(own.map(svaraCardCode)) : null,
    seats: Object.freeze(deal.playerOrder.map((playerId) => ({ playerId, cardCount: deal.hands.get(playerId)?.length ?? 0 }))),
  }
}

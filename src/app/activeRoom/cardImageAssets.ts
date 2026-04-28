import type { RoomCardSnapshot } from '../network/createGameServerClient'

export const CARD_BACK_IMAGE_PATH = '/images/cards/card-back.png'

export function getCardFaceImagePath(card: RoomCardSnapshot): string {
  return `/images/cards/${card.suit}/${card.rank}_${card.suit}_300x420.webp`
}

import type { RoomCardSnapshot } from '../network/createGameServerClient'

export const CARD_BACK_IMAGE_PATH = '/images/cards/card-back.webp'

const SUITS: readonly RoomCardSnapshot['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANKS: readonly RoomCardSnapshot['rank'][] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

export function getCardFaceImagePath(card: RoomCardSnapshot): string {
  return `/images/cards/${card.suit}/${card.rank}_${card.suit}_300x420.webp`
}

// Браузърът не decode-ва снимка само защото е кеширана мрежово — decode-ът
// (CPU/GPU работа за да стане paint-ready) се случва отделно и мързеливо,
// обикновено при първия paint. Без този preload, decode-ът стартира чак
// когато сървърът раздаде/изиграе картата за пръв път — точно тогава, когато
// анимацията вече тръгва — и на бавни мобилни устройства lice-то на картата
// се дорисува видимо след като гърбът/анимацията вече са на екрана.
// decode() гарантира, че пикселите са готови за paint преди картата изобщо
// да участва в gameplay. Стартира веднъж, при зареждане на модула (App boot),
// доста преди cutting/dealing/bidding да имат нужда от каквато и да е карта.
let cardImagePreloadStarted = false

export function preloadAllCardFaceImages(): void {
  if (cardImagePreloadStarted || typeof Image === 'undefined') {
    return
  }
  cardImagePreloadStarted = true

  const paths = [CARD_BACK_IMAGE_PATH]
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      paths.push(getCardFaceImagePath({ id: '', suit, rank }))
    }
  }

  for (const path of paths) {
    const img = new Image()
    img.src = path
    if (typeof img.decode === 'function') {
      // decode() може да reject-не (напр. abort) — не е фатално, браузърът
      // пак ще decode-не изображението обичайно при реален paint по-късно.
      img.decode().catch(() => {})
    }
  }
}

preloadAllCardFaceImages()

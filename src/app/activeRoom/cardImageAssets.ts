import type { RoomCardSnapshot } from '../network/createGameServerClient'
import { getActiveCampaignTheme } from './activeRoomShared'

export const CARD_BACK_IMAGE_PATH = '/images/cards/card-back.webp'

/**
 * Фаза 10 — заменя литералния `url('${CARD_BACK_IMAGE_PATH}')` на всичките
 * 3 render места, където играта реално показва гръб на карта (cutting
 * deck pile, dealing packet анимация, seat panel dealt-card fan-ове —
 * последният е shared между opponent hands/bottom hand/spectator view).
 * Темизираният гръб е ДОПЪЛНИТЕЛЕН CSS background-image layer ПРЕД
 * default-а (не го замества) — ако themed файлът не зареди, браузърът
 * просто не рисува тоя layer и default-ният гръб отдолу остава изцяло
 * видим (безопасен fallback, без JS/onerror, mirror на
 * activeRoomShared.ts::getActiveRoomTableBackground-ия паттерн). Всичките
 * 3 call sites вече имат собствен единичен background-size/position/repeat
 * (напр. `cover`/`center`/`no-repeat`) — CSS спецификацията цикли тия
 * стойности за всеки допълнителен background-image layer, затова не
 * трябва да се пипат отделно.
 */
export function getActiveRoomCardBackImageValue(): string {
  const themedUrl = getActiveCampaignTheme()?.cardBackUrl ?? null
  if (!themedUrl) {
    return `url('${CARD_BACK_IMAGE_PATH}')`
  }
  return `url('${themedUrl}'), url('${CARD_BACK_IMAGE_PATH}')`
}

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

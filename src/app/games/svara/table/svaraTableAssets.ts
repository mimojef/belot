// Свара — визуални ресурси за реалната маса (Етап 2Б.3.7.3), преизползвани
// от демото (задание §3): същия гръб на картата, същите пътища на лицата и
// същите placeholder аватари. Логиката тук е ЧИСТО презентационна — нищо
// от демо сценария (раздаване/анимации) не се внася, само статичните пътища.

import { SVARA_DEMO_AVATAR_SRCS, SVARA_DEMO_CARD_BACK_SRC, svaraCardFaceSrc } from '../demo/svaraDemoScript'
import type { SvaraCardCode } from '../../../network/createGameServerClient'

export const SVARA_CARD_BACK_SRC = SVARA_DEMO_CARD_BACK_SRC

const SUIT_LETTER_TO_NAME: Record<string, string> = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' }

/** "10H" -> "/images/cards/hearts/10_hearts_300x420.webp"; невалиден код -> null (не се очаква за сървърни данни, но безопасно). */
export function svaraCardCodeToFaceSrc(code: SvaraCardCode): string | null {
  const match = /^(7|8|9|10|J|Q|K|A)([CDHS])$/.exec(code)
  if (!match) return null
  const [, rank, suitLetter] = match
  const suit = SUIT_LETTER_TO_NAME[suitLetter!]
  if (!suit) return null
  return svaraCardFaceSrc(rank!, suit)
}

/**
 * Детерминистичен placeholder аватар по playerId (стабилен за същия играч
 * между re-render-и/reconnect, но НЕ истинският профилен аватар на Pika.bg —
 * реалният Svara snapshot не включва displayName/avatarUrl, виж заданието
 * §5 "докладвай точно какво липсва" и финалния отчет).
 */
export function svaraPlaceholderAvatarSrc(playerId: string): string {
  let hash = 0
  for (let i = 0; i < playerId.length; i += 1) hash = (hash * 31 + playerId.charCodeAt(i)) >>> 0
  return SVARA_DEMO_AVATAR_SRCS[hash % SVARA_DEMO_AVATAR_SRCS.length]!
}

/** Кратко четливо "име" от playerId, докато реален displayName не е наличен в snapshot-а. */
export function svaraPlaceholderName(playerId: string): string {
  return `Играч ${playerId.slice(0, 6)}`
}

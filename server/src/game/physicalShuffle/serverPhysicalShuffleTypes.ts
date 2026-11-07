// Физическо размесване (Белот) — server-only. Прилага се САМО при Anti Bad
// Luck праг 0 и само когато има събрана камара от предишното раздаване
// (виж resolveServerNextRoundDeck). Никога не стига до клиента.

// Admin-конфигурируем метод (admin_settings.physical_shuffle_mode).
export const SERVER_PHYSICAL_SHUFFLE_MODES = ['RANDOM_INSERT', 'ALTERNATING_ENDS'] as const

export type ServerPhysicalShuffleMode = (typeof SERVER_PHYSICAL_SHUFFLE_MODES)[number]

export const SERVER_PHYSICAL_SHUFFLE_DEFAULT_MODE: ServerPhysicalShuffleMode = 'RANDOM_INSERT'

// Параметри на прехвърлянията (общи за двата режима).
export const SERVER_PHYSICAL_SHUFFLE_MIN_TRANSFERS = 3
export const SERVER_PHYSICAL_SHUFFLE_MAX_TRANSFERS = 6
export const SERVER_PHYSICAL_SHUFFLE_MIN_PACKET_SIZE = 6
export const SERVER_PHYSICAL_SHUFFLE_MAX_PACKET_SIZE = 16

export function isServerPhysicalShuffleMode(value: unknown): value is ServerPhysicalShuffleMode {
  return typeof value === 'string' && (SERVER_PHYSICAL_SHUFFLE_MODES as readonly string[]).includes(value)
}

export type ServerPhysicalShuffleEnd = 'top' | 'bottom'

// Един запис на прехвърляне (за тестове/диагностика). Индекс 0 на тестето =
// горната карта (dealServerCardsInPackets раздава от началото на масива).
export type ServerPhysicalShuffleTransfer = {
  packetSize: number
  takenFrom: ServerPhysicalShuffleEnd
  // 'top' | 'bottom' — пакетът е поставен на ръба; 'inside' — вмъкнат на
  // insertIndex (позиция в остатъка от тестето, строго между двата ръба).
  placedAt: ServerPhysicalShuffleEnd | 'inside'
  insertIndex: number | null
}

// Произход на тестето за новото раздаване (диагностика/тестове).
export type ServerNextRoundDeckOrigin =
  | 'fresh-random'
  | 'physical-shuffle'

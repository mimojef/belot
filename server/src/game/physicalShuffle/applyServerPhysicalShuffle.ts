import type { ServerCard } from '../serverGameTypes.js'
import {
  SERVER_PHYSICAL_SHUFFLE_MAX_PACKET_SIZE,
  SERVER_PHYSICAL_SHUFFLE_MAX_TRANSFERS,
  SERVER_PHYSICAL_SHUFFLE_MIN_PACKET_SIZE,
  SERVER_PHYSICAL_SHUFFLE_MIN_TRANSFERS,
  type ServerPhysicalShuffleMode,
  type ServerPhysicalShuffleTransfer,
} from './serverPhysicalShuffleTypes.js'

// Физическо размесване на събраната камара — симулира ръчно прехвърляне на
// пакети карти. НЕ е независимо пълно разбъркване: запазва голяма част от
// реда на взятките (това е умишлено — виж задачата). Индекс 0 = горна карта.
//
// И за двата режима:
//   - брой прехвърляния: случаен, 3..6 включително;
//   - размер на пакета: случаен, 6..16 включително, два поредни пакета
//     никога не са с еднакъв размер;
//   - всяко прехвърляне работи върху ЦЯЛОТО текущо тесте (общият брой
//     прехвърлени карти не е ограничен до размера на тестето);
//   - само пренареждане — карта никога не се губи, дублира или заменя
//     (verify-ва се в края; при нарушение хвърля).
//
// RANDOM_INSERT: пакет отгоре ИЛИ отдолу (случайно) се вмъква на случайна
//   вътрешна позиция в остатъка (никога на ръба → всяко прехвърляне
//   реално променя реда), вътрешният ред на пакета се запазва.
// ALTERNATING_ENDS: строго редуване — отгоре→отдолу, отдолу→отгоре, ...
//   Всяко прехвърляне е циклично завъртане, затова резултатът също е
//   циклично завъртане на входа (документирано поведение на режима).

export type ApplyServerPhysicalShuffleResult = {
  deck: ServerCard[]
  transfers: ServerPhysicalShuffleTransfer[]
}

function pickRandomInt(min: number, max: number, nextRandom: () => number): number {
  const span = max - min + 1
  const raw = Math.floor(nextRandom() * span)
  // Защита срещу RNG, връщащ 1 (или извън [0, 1)).
  const clamped = Math.min(span - 1, Math.max(0, Number.isFinite(raw) ? raw : 0))
  return min + clamped
}

// Равномерно от [min..max] БЕЗ previousSize (ако е в интервала).
export function pickServerPhysicalShufflePacketSize(
  previousSize: number | null,
  nextRandom: () => number,
  min: number = SERVER_PHYSICAL_SHUFFLE_MIN_PACKET_SIZE,
  max: number = SERVER_PHYSICAL_SHUFFLE_MAX_PACKET_SIZE,
): number {
  const excludesPrevious = previousSize !== null && previousSize >= min && previousSize <= max
  if (!excludesPrevious) {
    return pickRandomInt(min, max, nextRandom)
  }
  const picked = pickRandomInt(min, max - 1, nextRandom)
  return picked >= previousSize ? picked + 1 : picked
}

function assertSamePermutation(input: readonly ServerCard[], output: readonly ServerCard[]): void {
  if (input.length !== output.length) {
    throw new Error(`[physical-shuffle] card count changed ${input.length} -> ${output.length}`)
  }
  const remaining = new Map<string, number>()
  for (const card of input) {
    remaining.set(card.id, (remaining.get(card.id) ?? 0) + 1)
  }
  for (const card of output) {
    const count = remaining.get(card.id) ?? 0
    if (count === 0) {
      throw new Error(`[physical-shuffle] unexpected/duplicated card ${card.id}`)
    }
    remaining.set(card.id, count - 1)
  }
}

export function applyServerPhysicalShuffle(
  deck: readonly ServerCard[],
  mode: ServerPhysicalShuffleMode,
  nextRandom: () => number = Math.random,
): ApplyServerPhysicalShuffleResult {
  // Най-големият пакет трябва да остави поне 2 карти в остатъка, за да има
  // вътрешна позиция за RANDOM_INSERT (32 карти → винаги изпълнено).
  if (deck.length < SERVER_PHYSICAL_SHUFFLE_MAX_PACKET_SIZE + 2) {
    throw new Error(`[physical-shuffle] deck too small (${deck.length})`)
  }

  const transferCount = pickRandomInt(
    SERVER_PHYSICAL_SHUFFLE_MIN_TRANSFERS,
    SERVER_PHYSICAL_SHUFFLE_MAX_TRANSFERS,
    nextRandom,
  )
  let working = [...deck]
  const transfers: ServerPhysicalShuffleTransfer[] = []
  let previousSize: number | null = null

  for (let transferIndex = 0; transferIndex < transferCount; transferIndex += 1) {
    const packetSize = pickServerPhysicalShufflePacketSize(previousSize, nextRandom)
    previousSize = packetSize

    if (mode === 'ALTERNATING_ENDS') {
      if (transferIndex % 2 === 0) {
        // Отгоре → отдолу.
        working = [...working.slice(packetSize), ...working.slice(0, packetSize)]
        transfers.push({ packetSize, takenFrom: 'top', placedAt: 'bottom', insertIndex: null })
      } else {
        // Отдолу → отгоре.
        const splitAt = working.length - packetSize
        working = [...working.slice(splitAt), ...working.slice(0, splitAt)]
        transfers.push({ packetSize, takenFrom: 'bottom', placedAt: 'top', insertIndex: null })
      }
      continue
    }

    // RANDOM_INSERT
    const takeFromTop = nextRandom() < 0.5
    const packet = takeFromTop
      ? working.slice(0, packetSize)
      : working.slice(working.length - packetSize)
    const rest = takeFromTop
      ? working.slice(packetSize)
      : working.slice(0, working.length - packetSize)
    // Вътрешна позиция: 1..rest.length-1 (пакетът е между две карти на остатъка).
    const insertIndex = pickRandomInt(1, rest.length - 1, nextRandom)
    working = [...rest.slice(0, insertIndex), ...packet, ...rest.slice(insertIndex)]
    transfers.push({
      packetSize,
      takenFrom: takeFromTop ? 'top' : 'bottom',
      placedAt: 'inside',
      insertIndex,
    })
  }

  assertSamePermutation(deck, working)

  return { deck: working, transfers }
}

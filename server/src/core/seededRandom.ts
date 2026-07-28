// Инжектируем PRNG helper — production кодът извиква shuffleSeatOrder() без
// аргумент (Math.random), а тестовете подават createSeededRandom(seed) или
// собствен генератор, за да докажат детерминистично различните допустими
// разпределения на местата (виж assignPrivateRoomBotFillSeats.ts).

import { SERVER_SEAT_ORDER, type Seat } from './serverTypes.js'

function hashStringToUint32(value: string): number {
  let hash = 2166136261

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return hash >>> 0
}

export function createSeededRandom(seed: string): () => number {
  let state = hashStringToUint32(seed) || 0x9e3779b9

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state

    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)

    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffleWithRandom<T>(items: readonly T[], nextRandom: () => number = Math.random): T[] {
  const result = [...items]

  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1))
    const current = result[index]
    result[index] = result[swapIndex]
    result[swapIndex] = current
  }

  return result
}

export function shuffleSeatOrder(nextRandom: () => number = Math.random): Seat[] {
  return shuffleWithRandom(SERVER_SEAT_ORDER, nextRandom)
}

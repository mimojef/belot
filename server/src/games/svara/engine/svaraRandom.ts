// Свара — източник на случайност за разбъркването.
//
// Продукция: node:crypto randomInt — криптографски сигурен генератор (CSPRNG)
// с равномерно разпределение без modulo bias. Тестове: подаваме собствен
// SvaraRandomSource (напр. детерминистичен) или директно контролирано тесте
// (createSvaraDeckFromCards). Клиентът никога не участва в разбъркването.

import { randomInt } from 'node:crypto'
import { SvaraInvalidInputError } from './svaraCards.js'

export interface SvaraRandomSource {
  /** Цяло число в [0, maxExclusive), равномерно разпределено. */
  nextInt(maxExclusive: number): number
}

export function createCryptoSvaraRandomSource(): SvaraRandomSource {
  return {
    nextInt(maxExclusive: number): number {
      return randomInt(maxExclusive)
    },
  }
}

/**
 * Детерминистичен източник САМО за автоматизирани тестове и демо данни
 * (mulberry32). Не е криптографски сигурен — не се ползва за реални игри.
 */
export function createSeededSvaraRandomSourceForTests(seed: number): SvaraRandomSource {
  let state = seed >>> 0
  return {
    nextInt(maxExclusive: number): number {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      const unit = ((t ^ (t >>> 14)) >>> 0) / 4294967296
      return Math.floor(unit * maxExclusive)
    },
  }
}

/** Fisher–Yates; не променя входа. Проверява изхода на източника. */
export function shuffleWithSvaraRandom<T>(items: readonly T[], random: SvaraRandomSource): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = random.nextInt(i + 1)
    if (!Number.isInteger(j) || j < 0 || j > i) {
      throw new SvaraInvalidInputError(`Random source returned ${j}, expected an integer in [0, ${i}]`)
    }
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

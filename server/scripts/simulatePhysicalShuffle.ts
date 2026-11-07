/**
 * simulatePhysicalShuffle.ts — сравнение на физическото размесване
 * (RANDOM_INSERT, ALTERNATING_ENDS) със старото пълно случайно разбъркване
 * (OLD = Fisher-Yates на ново тесте всяко раздаване).
 *
 * Пълен server-authoritative flow с production ботовете (наддаване, игра,
 * „Долу картите“, всички пас), Anti Bad Luck = 0. Тестето на раздаване N+1
 * се получава от камарата на раздаване N (взятки или, при всички пас, ръце +
 * неразданите), после реално цепене (auto cut на сървъра) и раздаване 3+2+3.
 * За OLD тестето в cutting се заменя с ново Fisher-Yates разбъркване.
 * Първото раздаване на всеки мач (винаги случайно) НЕ се брои.
 *
 * Метрики (на раздаване / на ръка):
 *   - честота на всички пас (реалното наддаване на ботовете);
 *   - разпределение на боите: шаблон на 8-те карти (напр. 3-2-2-1), най-дълга
 *     боя, празни бои; шаблон на първите 5 карти;
 *   - потенциални обявявания в 8-те карти: терца, петдесет (кварта),
 *     сто (квинта+), каре (J/9/A/K/Q/10) — комбинаторно, независимо от
 *     обявената игра;
 *   - запазване на съседни карти: от 31 съседни двойки в камарата колко
 *     остават съседни в новото тесте (преди / след цепене), колко попадат в
 *     една и съща ръка; съседни карти от една боя в тестето.
 *
 * Пускане:  npx tsx scripts/simulatePhysicalShuffle.ts --rounds=3000 [--out=results.json]
 */

import { writeFileSync } from 'node:fs'
import { SERVER_SEAT_ORDER, type Seat } from '../src/core/serverTypes.js'
import type { ServerAntiBadLuckConfig } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { createServerDeck } from '../src/game/createServerDeck.js'
import { createEmptyHands } from '../src/game/createServerRoundDefaults.js'
import { cutServerDeck } from '../src/game/cutServerDeck.js'
import { dealServerCardsInPackets } from '../src/game/dealServerCardsInPackets.js'
import { collectServerRoundPile } from '../src/game/physicalShuffle/collectServerRoundPile.js'
import type { ServerPhysicalShuffleMode } from '../src/game/physicalShuffle/serverPhysicalShuffleTypes.js'
import type { ServerCard, ServerRank } from '../src/game/serverGameTypes.js'
import { shuffleServerDeck } from '../src/game/shuffleServerDeck.js'
import {
  auth,
  driveUntil,
  isNewRoundCutting,
  playRoundToEnd,
  preservedAdjacentPairs,
  startMatch,
  withState,
  type Driven,
} from './fixtures/belotRoundDriver.js'

type SimMode = 'OLD' | ServerPhysicalShuffleMode
const MODES: SimMode[] = ['OLD', 'RANDOM_INSERT', 'ALTERNATING_ENDS']

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=')
  return [key!, value ?? 'true'] as const
}))
const ROUNDS = Number(args.get('rounds') ?? 2000)
const OUT = args.get('out')

const RANK_ORDER: ServerRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const CARRE_RANKS = new Set<ServerRank>(['J', '9', 'A', 'K', 'Q', '10'])

// ─── Метрики ────────────────────────────────────────────────────────────────

type HandDeclarations = { terca: number; fifty: number; hundred: number; carre: number }

function handDeclarations(hand: readonly ServerCard[]): HandDeclarations {
  const result: HandDeclarations = { terca: 0, fifty: 0, hundred: 0, carre: 0 }
  const bySuit = new Map<string, Set<number>>()
  const rankCounts = new Map<ServerRank, number>()
  for (const card of hand) {
    if (!bySuit.has(card.suit)) bySuit.set(card.suit, new Set())
    bySuit.get(card.suit)!.add(RANK_ORDER.indexOf(card.rank))
    rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1)
  }
  for (const ranks of bySuit.values()) {
    let run = 0
    for (let index = 0; index <= RANK_ORDER.length; index += 1) {
      if (index < RANK_ORDER.length && ranks.has(index)) {
        run += 1
        continue
      }
      if (run >= 5) result.hundred += 1
      else if (run === 4) result.fifty += 1
      else if (run === 3) result.terca += 1
      run = 0
    }
  }
  for (const [rank, count] of rankCounts) {
    if (count === 4 && CARRE_RANKS.has(rank)) result.carre += 1
  }
  return result
}

function suitPattern(hand: readonly ServerCard[]): number[] {
  const counts = new Map<string, number>([['clubs', 0], ['diamonds', 0], ['hearts', 0], ['spades', 0]])
  for (const card of hand) counts.set(card.suit, (counts.get(card.suit) ?? 0) + 1)
  return [...counts.values()].sort((a, b) => b - a)
}

class Mean {
  n = 0
  sum = 0
  sumSq = 0
  add(value: number): void {
    this.n += 1
    this.sum += value
    this.sumSq += value * value
  }
  get mean(): number { return this.n === 0 ? 0 : this.sum / this.n }
  get ci95(): number {
    if (this.n < 2) return 0
    const variance = (this.sumSq - (this.sum * this.sum) / this.n) / (this.n - 1)
    return 1.96 * Math.sqrt(Math.max(0, variance) / this.n)
  }
}

class Histogram {
  counts = new Map<string, number>()
  total = 0
  add(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    this.total += 1
  }
  share(key: string): number { return this.total === 0 ? 0 : (this.counts.get(key) ?? 0) / this.total }
}

type ModeStats = {
  rounds: number
  matches: number
  allPass: Mean
  allPassBySource: { afterTricks: Mean; afterAllPass: Mean }
  pattern8: Histogram
  pattern5: Histogram
  maxSuit8: Histogram
  voids8: Mean
  handTerca: Mean
  handFifty: Mean
  handHundred: Mean
  handCarre: Mean
  roundTerca: Mean
  roundFifty: Mean
  roundHundred: Mean
  roundCarre: Mean
  roundAnySequence: Mean
  preservedPreCut: Mean
  preservedPostCut: Mean
  pileNeighboursSameHand: Mean
  sameSuitNeighbours: Mean
}

function createStats(): ModeStats {
  return {
    rounds: 0,
    matches: 0,
    allPass: new Mean(),
    allPassBySource: { afterTricks: new Mean(), afterAllPass: new Mean() },
    pattern8: new Histogram(),
    pattern5: new Histogram(),
    maxSuit8: new Histogram(),
    voids8: new Mean(),
    handTerca: new Mean(),
    handFifty: new Mean(),
    handHundred: new Mean(),
    handCarre: new Mean(),
    roundTerca: new Mean(),
    roundFifty: new Mean(),
    roundHundred: new Mean(),
    roundCarre: new Mean(),
    roundAnySequence: new Mean(),
    preservedPreCut: new Mean(),
    preservedPostCut: new Mean(),
    pileNeighboursSameHand: new Mean(),
    sameSuitNeighbours: new Mean(),
  }
}

function dealFullHands(cutDeck: ServerCard[], firstDealSeat: Seat): { five: Record<Seat, ServerCard[]>; eight: Record<Seat, ServerCard[]> } {
  const first = dealServerCardsInPackets(cutDeck, createEmptyHands(), firstDealSeat, 3, 1)
  const next = dealServerCardsInPackets(first.remainingDeck, first.hands, firstDealSeat, 2, 1)
  const last = dealServerCardsInPackets(next.remainingDeck, next.hands, firstDealSeat, 3, 1)
  return { five: next.hands, eight: last.hands }
}

function recordRound(
  stats: ModeStats,
  previousPile: { cards: ServerCard[]; source: 'tricks' | 'all-pass' },
  preCutDeck: ServerCard[],
  cutDeck: ServerCard[],
  firstDealSeat: Seat,
  allPass: boolean,
): void {
  stats.rounds += 1
  stats.allPass.add(allPass ? 1 : 0)
  ;(previousPile.source === 'tricks' ? stats.allPassBySource.afterTricks : stats.allPassBySource.afterAllPass).add(allPass ? 1 : 0)

  const { five, eight } = dealFullHands(cutDeck, firstDealSeat)
  const handOf = new Map<string, Seat>()
  const round = { terca: 0, fifty: 0, hundred: 0, carre: 0 }
  for (const seat of SERVER_SEAT_ORDER) {
    for (const card of eight[seat]) handOf.set(card.id, seat)
    const pattern = suitPattern(eight[seat])
    stats.pattern8.add(pattern.join('-'))
    stats.pattern5.add(suitPattern(five[seat]).join('-'))
    stats.maxSuit8.add(String(pattern[0]))
    stats.voids8.add(pattern.filter((count) => count === 0).length)
    const declarations = handDeclarations(eight[seat])
    stats.handTerca.add(declarations.terca > 0 ? 1 : 0)
    stats.handFifty.add(declarations.fifty > 0 ? 1 : 0)
    stats.handHundred.add(declarations.hundred > 0 ? 1 : 0)
    stats.handCarre.add(declarations.carre > 0 ? 1 : 0)
    round.terca += declarations.terca
    round.fifty += declarations.fifty
    round.hundred += declarations.hundred
    round.carre += declarations.carre
  }
  stats.roundTerca.add(round.terca)
  stats.roundFifty.add(round.fifty)
  stats.roundHundred.add(round.hundred)
  stats.roundCarre.add(round.carre)
  stats.roundAnySequence.add(round.terca + round.fifty + round.hundred > 0 ? 1 : 0)

  stats.preservedPreCut.add(preservedAdjacentPairs(previousPile.cards, preCutDeck))
  stats.preservedPostCut.add(preservedAdjacentPairs(previousPile.cards, cutDeck))
  let sameHand = 0
  for (let index = 0; index + 1 < previousPile.cards.length; index += 1) {
    if (handOf.get(previousPile.cards[index]!.id) === handOf.get(previousPile.cards[index + 1]!.id)) sameHand += 1
  }
  stats.pileNeighboursSameHand.add(sameHand / (previousPile.cards.length - 1))
  let sameSuit = 0
  for (let index = 0; index + 1 < cutDeck.length; index += 1) {
    if (cutDeck[index]!.suit === cutDeck[index + 1]!.suit) sameSuit += 1
  }
  stats.sameSuitNeighbours.add(sameSuit / (cutDeck.length - 1))
}

// ─── Симулация ──────────────────────────────────────────────────────────────

function simulate(mode: SimMode, targetRounds: number): ModeStats {
  const stats = createStats()
  const config: ServerAntiBadLuckConfig = {
    threshold: 0,
    resetGeneration: 0,
    physicalShuffleMode: mode === 'OLD' ? 'RANDOM_INSERT' : mode,
  }
  let driven: Driven | null = null
  let previousPile: ReturnType<typeof collectServerRoundPile> = null

  while (stats.rounds < targetRounds) {
    if (driven === null) {
      driven = startMatch(config, `sim-${mode}`)
      previousPile = null
      stats.matches += 1
    }

    // В cutting на ново раздаване.
    if (mode === 'OLD' && previousPile !== null) {
      const state = auth(driven.room)
      driven = { room: withState(driven.room, { ...state, deck: shuffleServerDeck(createServerDeck()) }), now: driven.now }
    }
    const preCutDeck = auth(driven.room).deck
    driven = driveUntil(driven, config, (state) => state.phase === 'deal-first-3')
    const dealt = auth(driven.room)
    const cutDeck = cutServerDeck(preCutDeck, dealt.round.selectedCutIndex!)

    driven = playRoundToEnd(driven, config)
    const end = auth(driven.room)
    const allPass = end.phase === 'next-round'
    if (previousPile !== null) {
      recordRound(stats, previousPile, preCutDeck, cutDeck, dealt.round.firstDealSeat!, allPass)
    }

    if (end.matchEnded !== null) {
      driven = null
      continue
    }
    previousPile = collectServerRoundPile(end)
    if (previousPile === null) throw new Error('invalid pile at round end')
    driven = driveUntil(driven, config, isNewRoundCutting(end.round.dealerSeat))
  }
  return stats
}

// ─── Отчет ──────────────────────────────────────────────────────────────────

const pct = (value: number) => `${(value * 100).toFixed(2)}%`
const fmtMean = (mean: Mean, asPercent = false) =>
  asPercent ? `${pct(mean.mean)} ±${(mean.ci95 * 100).toFixed(2)}` : `${mean.mean.toFixed(3)} ±${mean.ci95.toFixed(3)}`

function zVersusOld(oldMean: Mean, other: Mean): string {
  const pooledSe = Math.sqrt((oldMean.ci95 / 1.96) ** 2 + (other.ci95 / 1.96) ** 2)
  if (pooledSe === 0) return '—'
  const z = (other.mean - oldMean.mean) / pooledSe
  return `${z >= 0 ? '+' : ''}${z.toFixed(1)}`
}

const started = Date.now()
const results = new Map<SimMode, ModeStats>()
for (const mode of MODES) {
  const modeStarted = Date.now()
  results.set(mode, simulate(mode, ROUNDS))
  console.error(`[sim] ${mode}: ${ROUNDS} раздавания (${results.get(mode)!.matches} мача) за ${((Date.now() - modeStarted) / 1000).toFixed(1)}s`)
}

const old = results.get('OLD')!
const rows: Array<[string, (stats: ModeStats) => Mean, boolean]> = [
  ['Всички пас (на раздаване)', (s) => s.allPass, true],
  ['  … след раздаване с взятки', (s) => s.allPassBySource.afterTricks, true],
  ['Ръка с терца (8 карти)', (s) => s.handTerca, true],
  ['Ръка с 50 (кварта)', (s) => s.handFifty, true],
  ['Ръка със 100 (квинта+)', (s) => s.handHundred, true],
  ['Ръка с каре', (s) => s.handCarre, true],
  ['Раздаване с ≥1 поредица', (s) => s.roundAnySequence, true],
  ['Терци на раздаване', (s) => s.roundTerca, false],
  ['50-ки на раздаване', (s) => s.roundFifty, false],
  ['100-ки на раздаване', (s) => s.roundHundred, false],
  ['Карета на раздаване', (s) => s.roundCarre, false],
  ['Празни бои в ръка (8 карти)', (s) => s.voids8, false],
  ['Запазени съседни двойки /31 (преди цепене)', (s) => s.preservedPreCut, false],
  ['Запазени съседни двойки /31 (след цепене)', (s) => s.preservedPostCut, false],
  ['Съседи от камарата в една ръка', (s) => s.pileNeighboursSameHand, true],
  ['Съседни карти от една боя в тестето', (s) => s.sameSuitNeighbours, true],
]

const lines: string[] = []
const log = (line = '') => lines.push(line)
log(`Симулация: ${ROUNDS} отчетени раздавания на режим (без първото раздаване на мача), Anti Bad Luck = 0, production ботове.`)
log(`Формат: средно ±95% CI; z = отклонение спрямо OLD в стандартни грешки (|z| > 3 ≈ значима разлика).`)
log()
const header = ['Метрика', ...MODES.map((mode) => mode), 'z RI', 'z AE']
const table = rows.map(([label, pick, asPercent]) => [
  label,
  ...MODES.map((mode) => fmtMean(pick(results.get(mode)!), asPercent)),
  zVersusOld(pick(old), pick(results.get('RANDOM_INSERT')!)),
  zVersusOld(pick(old), pick(results.get('ALTERNATING_ENDS')!)),
])
const widths = header.map((_, column) => Math.max(header[column]!.length, ...table.map((row) => row[column]!.length)))
const formatRow = (row: string[]) => row.map((cell, column) => cell.padEnd(widths[column]!)).join(' | ')
log(formatRow(header))
log(widths.map((width) => '-'.repeat(width)).join('-|-'))
for (const row of table) log(formatRow(row))

function histogramTable(title: string, pick: (stats: ModeStats) => Histogram, keys?: string[]): void {
  log()
  log(title)
  const allKeys = keys ?? [...new Set(MODES.flatMap((mode) => [...pick(results.get(mode)!).counts.keys()]))]
    .sort((a, b) => pick(old).share(b) - pick(old).share(a))
  for (const key of allKeys) {
    log(`  ${key.padEnd(9)} ${MODES.map((mode) => `${mode}: ${pct(pick(results.get(mode)!).share(key)).padStart(7)}`).join('   ')}`)
  }
}
histogramTable('Разпределение на боите — 8 карти (шаблон по дължина на боите):', (s) => s.pattern8)
histogramTable('Най-дълга боя — 8 карти:', (s) => s.maxSuit8, ['2', '3', '4', '5', '6', '7', '8'])
histogramTable('Разпределение на боите — първите 5 карти:', (s) => s.pattern5)
log()
log(`Общо време: ${((Date.now() - started) / 1000).toFixed(1)}s`)

console.log(lines.join('\n'))

if (OUT) {
  const serialize = (stats: ModeStats) => Object.fromEntries(Object.entries(stats).map(([key, value]) => {
    if (value instanceof Mean) return [key, { mean: value.mean, ci95: value.ci95, n: value.n }]
    if (value instanceof Histogram) return [key, Object.fromEntries([...value.counts].map(([k, c]) => [k, c / value.total]))]
    if (value && typeof value === 'object') return [key, Object.fromEntries(Object.entries(value).map(([k, v]) => [k, { mean: (v as Mean).mean, ci95: (v as Mean).ci95, n: (v as Mean).n }]))]
    return [key, value]
  }))
  writeFileSync(OUT, JSON.stringify({ rounds: ROUNDS, modes: Object.fromEntries(MODES.map((mode) => [mode, serialize(results.get(mode)!)])) }, null, 2))
}

/**
 * checkSvaraChips2B2A.ts — Свара, Етап 2Б.2А: дневник на чиповете, основна
 * и странични банки, непокрит залог, разпределяне/заключване, идемпотентност.
 *
 *  A. Създаване: начални чипове = вход ÷ 10; невалидни маси.
 *  B. Вноски и отказ: валидни и невалидни команди (без ред/минимуми — 2Б.2Б).
 *  C. Банки: обикновени залози, класически странични банки, отказали се
 *     вносители, строго разграничение „непокрит залог“ ↔ „присъдена банка
 *     с един останал правоимащ“.
 *  D. Разпределяне: различни победители, равенство в една банка при
 *     победител в друга, тройно равенство, последователни равенства и
 *     няколко едновременни заключени банки, отпадане.
 *  E. Неуточнени правила се отказват без промяна (банка без правоимащ,
 *     участие без чипове).
 *  F. Идемпотентност: повторена команда, конфликт на commandId, отказана
 *     команда не „изразходва“ commandId.
 *  G. Инварианти: подправено състояние се открива.
 *  H. Случайни последователности (fuzz) срещу независим еталон „чип по чип“,
 *     вкл. точните върнати непокрити суми за всеки играч.
 *  I. Изолация.
 *
 * Пускане (от server/): npm run check:svara-chips-2b2a
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySvaraChipCommand,
  assertSvaraChipInvariants,
  buildSvaraPotLayers,
  createSeededSvaraRandomSourceForTests,
  createShuffledSvaraDeck,
  createSvaraChipTable,
  evaluateSvaraHand,
  isSvaraPlayerEliminated,
  parseSvaraCardCode,
  SvaraChipCommandError,
  svaraCardCode,
  SvaraInvalidInputError,
  svaraStartingChipsForEntry,
  type SvaraCardCode,
  type SvaraChipCommand,
  type SvaraChipErrorCode,
  type SvaraChipTableState,
  type SvaraSettledPot,
} from '../src/games/svara/engine/index.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

function expectChipError(fn: () => unknown, code: SvaraChipErrorCode, label: string): void {
  try {
    fn()
  } catch (error) {
    if (error instanceof SvaraChipCommandError && error.code === code) return
    throw new Error(`${label}: expected ${code}, got ${error instanceof SvaraChipCommandError ? error.code : error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
  }
  throw new Error(`${label}: expected ${code}, nothing thrown`)
}

let commandSeq = 0
const nextId = () => `cmd-${(commandSeq += 1)}`

/** Прилага команда и проверява инварианта (двигателят го прави и сам). */
function apply(state: SvaraChipTableState, command: SvaraChipCommand): SvaraChipTableState {
  const result = applySvaraChipCommand(state, command)
  assertSvaraChipInvariants(result.state)
  return result.state
}

const begin = (s: SvaraChipTableState, dealId: string, participants: string[]) =>
  apply(s, { type: 'begin-deal', commandId: nextId(), dealId, participants })
const put = (s: SvaraChipTableState, playerId: string, amount: number, reason: 'ante' | 'bet' = 'bet') =>
  apply(s, { type: 'contribute', commandId: nextId(), playerId, amount, reason })
const fold = (s: SvaraChipTableState, playerId: string) => apply(s, { type: 'fold', commandId: nextId(), playerId })
const hands = (spec: Record<string, string>) => Object.fromEntries(Object.entries(spec).map(([id, cards]) => [id, cards.split(' ') as SvaraCardCode[]]))

function settle(s: SvaraChipTableState, handSpec: Record<string, string>): { state: SvaraChipTableState; pots: SvaraSettledPot[] } {
  const result = applySvaraChipCommand(s, { type: 'settle-deal', commandId: nextId(), hands: hands(handSpec) })
  assertSvaraChipInvariants(result.state)
  return { state: result.state, pots: result.outcome.settlement!.pots }
}

/** Прехвърля amount от from към to чрез раздаване с отказ (оформяне на стекове). */
function transfer(s: SvaraChipTableState, from: string, to: string, amount: number, dealId: string): SvaraChipTableState {
  let state = begin(s, dealId, [from, to])
  state = put(state, from, amount)
  state = put(state, to, amount)
  state = fold(state, from)
  return settle(state, {}).state
}

const table = (players: string[], entryFee = 1000) => createSvaraChipTable({ tableId: 't', entryFee, playerIds: players })
const stacksOf = (s: SvaraChipTableState) => JSON.stringify(s.stacks)

// Ръце с известна сила (без общи карти помежду им в един тест).
const H34 = '7S 7H 7D' // 34
const H33 = 'AS AH AD' // 33
const H30 = 'KS QS JS' // 30 (K + Q + J в една боя)
const H27 = '10H 9H 8H' // 27
const T11a = 'AC KH QD' // 11 (три бои)
const T11b = 'KC QH JD' // 10? — не се ползва за равенства с T11a
const TIE_A = 'AS KH QD' // 11
const TIE_B = 'AH KD QC' // 11
const TIE_C = 'AD KC QS' // 11
const LOW9 = '9C 8S 8D' // 9 (три бои; двойка осмици не е специална)

console.log('\ncheckSvaraChips2B2A')

check('0. силата на тестовите ръце', () => {
  const p = (codes: string) => evaluateSvaraHand(codes.split(' ').map(parseSvaraCardCode)).points
  assert(p(H34) === 34 && p(H33) === 33 && p(H27) === 27 && p(H30) === 30 && p(T11a) === 11 && p(T11b) === 10, 'strengths')
  assert(p(TIE_A) === 11 && p(TIE_B) === 11 && p(TIE_C) === 11 && p(LOW9) === 9, 'ties')
})

// ─── A ───
console.log('\n=== A. създаване ===')

check('A1. начални чипове = вход ÷ 10; общо = брой × начални; дневник с начални записи', () => {
  assert(svaraStartingChipsForEntry(1000) === 100 && svaraStartingChipsForEntry(50) === 5, 'entry/10')
  const s = table(['a', 'b', 'c'], 2500)
  assert(s.startingChips === 250 && s.totalChips === 750 && s.ledger.length === 3 && s.ledger.every((e) => e.type === 'starting-chips' && e.amount === 250), 'table')
})

check('A2. невалидни маси се отхвърлят', () => {
  const bad = (fn: () => unknown, label: string) => {
    try { fn() } catch (error) { if (error instanceof SvaraInvalidInputError) return; throw error }
    throw new Error(`${label}: accepted`)
  }
  for (const fee of [0, -10, 15, 10.5, NaN, Infinity]) bad(() => svaraStartingChipsForEntry(fee), `fee ${fee}`)
  bad(() => table(['a']), '1 player')
  bad(() => table(['a', 'b', 'c', 'd', 'e']), '5 players')
  bad(() => table(['a', 'a']), 'duplicate')
  bad(() => table(['a', '']), 'empty id')
  bad(() => createSvaraChipTable({ tableId: '', entryFee: 100, playerIds: ['a', 'b'] }), 'empty tableId')
})

// ─── B ───
console.log('\n=== B. вноски и отказ ===')

check('B1. анте и залози се записват в дневника; ол-ин изчерпва стека', () => {
  let s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  s = put(s, 'a', 5, 'ante')
  s = put(s, 'b', 5, 'ante')
  s = put(s, 'a', 95) // ол-ин
  assert(s.stacks.a === 0 && s.deal!.contributions.a === 100 && s.deal!.contributions.b === 5, 'contributions')
  const last = s.ledger[s.ledger.length - 1]!
  assert(last.type === 'contribution' && last.from === 'stack:a' && last.to === 'deal:d1' && last.amount === 95 && last.reason === 'bet', JSON.stringify(last))
})

check('B2. невалидни вноски/откази се отхвърлят без промяна', () => {
  const base = put(begin(table(['a', 'b', 'c']), 'd1', ['a', 'b']), 'a', 10)
  const snapshot = JSON.stringify(base)
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x1', playerId: 'a', amount: 0, reason: 'bet' }), 'invalid-command', 'zero')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x2', playerId: 'a', amount: -5, reason: 'bet' }), 'invalid-command', 'negative')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x3', playerId: 'a', amount: 2.5, reason: 'bet' }), 'invalid-command', 'fraction')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x4', playerId: 'a', amount: 91, reason: 'bet' }), 'insufficient-chips', 'more than stack')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x5', playerId: 'c', amount: 5, reason: 'bet' }), 'not-a-participant', 'not in deal')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x6', playerId: 'zz', amount: 5, reason: 'bet' }), 'unknown-player', 'unknown')
  expectChipError(() => applySvaraChipCommand(base, { type: 'contribute', commandId: 'x7', playerId: 'a', amount: 5, reason: 'raise' as 'bet' }), 'invalid-command', 'bad reason')
  const folded = fold(base, 'b')
  expectChipError(() => applySvaraChipCommand(folded, { type: 'contribute', commandId: 'x8', playerId: 'b', amount: 5, reason: 'bet' }), 'player-folded', 'folded contributes')
  expectChipError(() => applySvaraChipCommand(folded, { type: 'fold', commandId: 'x9', playerId: 'b' }), 'player-folded', 'fold twice')
  expectChipError(() => applySvaraChipCommand(base, { type: 'begin-deal', commandId: 'x10', dealId: 'd2', participants: ['a', 'b'] }), 'deal-already-active', 'second deal')
  const idle = table(['a', 'b'])
  expectChipError(() => applySvaraChipCommand(idle, { type: 'contribute', commandId: 'x11', playerId: 'a', amount: 5, reason: 'bet' }), 'no-active-deal', 'no deal')
  expectChipError(() => applySvaraChipCommand(idle, { type: 'begin-deal', commandId: 'x12', dealId: 'd', participants: ['a'] }), 'invalid-command', '1 participant')
  expectChipError(() => applySvaraChipCommand(idle, { type: 'begin-deal', commandId: 'x13', dealId: 'd', participants: ['a', 'a'] }), 'invalid-command', 'dup participant')
  expectChipError(() => applySvaraChipCommand(idle, { type: 'begin-deal', commandId: 'x14', dealId: 'd', participants: ['a', 'q'] }), 'unknown-player', 'unknown participant')
  expectChipError(() => applySvaraChipCommand(idle, { type: 'begin-deal', commandId: '', dealId: 'd', participants: ['a', 'b'] }), 'invalid-command', 'empty commandId')
  expectChipError(() => applySvaraChipCommand(idle, { type: 'teleport', commandId: 'x15' } as unknown as SvaraChipCommand), 'invalid-command', 'unknown type')
  assert(JSON.stringify(base) === snapshot, 'state mutated by rejected commands')
})

// ─── C ───
console.log('\n=== C. банки ===')

check('C1. обикновени залози без ол-ин: една банка, победителят взима всичко', () => {
  let s = begin(table(['a', 'b', 'c']), 'd1', ['a', 'b', 'c'])
  for (const p of ['a', 'b', 'c']) s = put(s, p, 5, 'ante')
  for (const p of ['a', 'b', 'c']) s = put(s, p, 20)
  const r = settle(s, { a: T11a, b: H27, c: H34 })
  assert(r.pots.length === 1 && r.pots[0]!.amount === 75 && r.pots[0]!.resolution.kind === 'awarded-showdown', JSON.stringify(r.pots))
  assert(stacksOf(r.state) === JSON.stringify({ a: 75, b: 75, c: 150 }) && r.state.deal === null, stacksOf(r.state))
})

check('C2. класически странични банки (4 различни ол-ина) + непокрит остатък', () => {
  let s = table(['A', 'B', 'C', 'D'])
  s = transfer(s, 'B', 'A', 70, 'shape1') // A 170, B 30
  s = transfer(s, 'D', 'C', 40, 'shape2') // C 140, D 60
  assert(stacksOf(s) === JSON.stringify({ A: 170, B: 30, C: 140, D: 60 }), stacksOf(s))
  s = begin(s, 'main', ['A', 'B', 'C', 'D'])
  s = put(s, 'B', 30) // ол-ин
  s = put(s, 'D', 60) // ол-ин
  s = put(s, 'C', 140) // ол-ин
  s = put(s, 'A', 150)
  const r = settle(s, { A: H27, B: H34, C: T11a, D: H33 })
  const summary = r.pots.map((p) => `${p.fromLevel}-${p.toLevel}:${p.amount}:${p.eligible.join('')}:${p.resolution.kind}`)
  assert(JSON.stringify(summary) === JSON.stringify([
    '0-30:120:ABCD:awarded-showdown',
    '30-60:90:ACD:awarded-showdown',
    '60-140:160:AC:awarded-showdown',
    '140-150:10:A:uncalled-return',
  ]), JSON.stringify(summary))
  const winners = r.pots.map((p) => (p.resolution.kind === 'uncalled-return' ? p.resolution.playerId : p.resolution.kind === 'locked' ? '-' : p.resolution.winner))
  assert(winners.join() === 'B,D,A,A', winners.join())
  assert(stacksOf(r.state) === JSON.stringify({ A: 190, B: 120, C: 0, D: 90 }), stacksOf(r.state))
})

check('C3. отказал се вносител: чиповете му остават в банката, не получава нищо', () => {
  let s = begin(table(['a', 'b', 'c']), 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 40)
  s = put(s, 'b', 40)
  s = put(s, 'c', 40)
  s = fold(s, 'a')
  const r = settle(s, { b: LOW9, c: H27 })
  assert(r.pots.length === 1 && r.pots[0]!.amount === 120 && JSON.stringify(r.pots[0]!.eligible) === '["b","c"]', JSON.stringify(r.pots))
  assert(stacksOf(r.state) === JSON.stringify({ a: 60, b: 60, c: 180 }), stacksOf(r.state))
})

check('C4. строго разграничение: непокрит залог (1 вносител → връщане) ↔ банка с много вносители и 1 правоимащ (→ печалба)', () => {
  let s = begin(table(['a', 'b', 'c'], 2000), 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 50)
  s = put(s, 'b', 50)
  s = put(s, 'c', 120)
  s = fold(s, 'a')
  s = fold(s, 'b')
  const r = settle(s, {})
  assert(r.pots.length === 2, `pots ${r.pots.length}`)
  const [won, returned] = r.pots
  assert(won!.amount === 150 && won!.resolution.kind === 'awarded-uncontested', JSON.stringify(won))
  assert(JSON.stringify(won!.contributions) === JSON.stringify({ a: 50, b: 50, c: 50 }) && JSON.stringify(won!.eligible) === '["c"]', 'won pot')
  assert(returned!.amount === 70 && returned!.resolution.kind === 'uncalled-return' && JSON.stringify(returned!.contributions) === JSON.stringify({ c: 70 }), JSON.stringify(returned))
  const settleEntries = r.state.ledger.filter((e) => e.dealId === 'd1' && e.type !== 'contribution')
  assert(settleEntries.map((e) => `${e.type}:${e.amount}`).join() === 'pot-award:150,uncalled-return:70', settleEntries.map((e) => `${e.type}:${e.amount}`).join())
  assert(stacksOf(r.state) === JSON.stringify({ a: 150, b: 150, c: 300 }), stacksOf(r.state))
})

check('C5. алгоритъм на слоевете: нивата на отказалите се не създават излишни банки', () => {
  const layers = buildSvaraPotLayers({
    participants: ['a', 'b', 'c', 'd'],
    contributions: { a: 30, b: 100, c: 100, d: 80 },
    folded: ['d'],
  })
  const summary = layers.map((l) => `${l.fromLevel}-${l.toLevel}:${l.amount}:${l.eligible.join('')}:${l.kind}`)
  // (30,80] и (80,100] имат еднакви правоимащи → една банка (30,100] = 70+70+50.
  assert(JSON.stringify(summary) === JSON.stringify(['0-30:120:abc:contested', '30-100:190:bc:contested']), JSON.stringify(summary))
  assert(layers.reduce((sum, l) => sum + l.amount, 0) === 310, 'sum')
})

// ─── D ───
console.log('\n=== D. разпределяне и равенства ===')

function shaped(): SvaraChipTableState {
  // a 50, b 100, c 100 (+ d 150 за баланс; не участва)
  let s = table(['a', 'b', 'c', 'd'])
  s = transfer(s, 'a', 'd', 50, 'shape')
  return s
}

check('D1. различни победители в основната и страничната банка', () => {
  let s = begin(shaped(), 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 50)
  s = put(s, 'b', 100)
  s = put(s, 'c', 100)
  const r = settle(s, { a: H34, b: H27, c: LOW9 })
  const kinds = r.pots.map((p) => `${p.amount}:${p.resolution.kind === 'awarded-showdown' ? p.resolution.winner : p.resolution.kind}`)
  assert(kinds.join() === '150:a,100:b', kinds.join())
  assert(stacksOf(r.state) === JSON.stringify({ a: 150, b: 100, c: 0, d: 150 }), stacksOf(r.state))
})

check('D2. равенство в основната банка → заключена; страничната има победител', () => {
  let s = begin(shaped(), 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 50)
  s = put(s, 'b', 100)
  s = put(s, 'c', 100)
  const r = settle(s, { a: TIE_A, b: TIE_B, c: LOW9 })
  assert(r.pots[0]!.resolution.kind === 'locked' && r.pots[1]!.resolution.kind === 'awarded-showdown', JSON.stringify(r.pots.map((p) => p.resolution)))
  assert(r.state.lockedPots.length === 1, 'one locked')
  const locked = r.state.lockedPots[0]!
  assert(locked.amount === 150 && JSON.stringify(locked.eligible) === '["a","b"]' && locked.tiedPoints === 11 && locked.createdInDealId === 'd1', JSON.stringify(locked))
  assert(stacksOf(r.state) === JSON.stringify({ a: 0, b: 100, c: 0, d: 150 }), stacksOf(r.state))
  assert(r.state.ledger.some((e) => e.type === 'pot-lock' && e.to === `locked:${locked.potId}` && e.amount === 150), 'lock ledger')
})

check('D3. основната има победител; равенство в страничната → заключена', () => {
  let s = begin(shaped(), 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 50)
  s = put(s, 'b', 100)
  s = put(s, 'c', 100)
  const r = settle(s, { a: H34, b: TIE_A, c: TIE_B })
  assert(r.pots[0]!.resolution.kind === 'awarded-showdown' && r.pots[1]!.resolution.kind === 'locked', 'resolutions')
  assert(JSON.stringify(r.state.lockedPots[0]!.eligible) === '["b","c"]' && r.state.lockedPots[0]!.amount === 100, 'locked side')
  assert(r.state.stacks.a === 150, 'main to a')
})

check('D4. тройно равенство в основната банка', () => {
  let s = begin(table(['a', 'b', 'c']), 'd1', ['a', 'b', 'c'])
  for (const p of ['a', 'b', 'c']) s = put(s, p, 30)
  const r = settle(s, { a: TIE_A, b: TIE_B, c: TIE_C })
  assert(r.state.lockedPots.length === 1 && JSON.stringify(r.state.lockedPots[0]!.eligible) === '["a","b","c"]' && r.state.lockedPots[0]!.amount === 90, JSON.stringify(r.state.lockedPots))
})

check('D5. последователни равенства: няколко заключени банки съществуват едновременно и не се пипат', () => {
  let s = table(['a', 'b', 'c', 'd'])
  s = begin(s, 'd1', ['a', 'b'])
  s = put(s, 'a', 20)
  s = put(s, 'b', 20)
  s = settle(s, { a: TIE_A, b: TIE_B }).state
  s = begin(s, 'd2', ['b', 'c', 'd'])
  for (const p of ['b', 'c', 'd']) s = put(s, p, 30)
  s = settle(s, { b: TIE_A, c: TIE_B, d: LOW9 }).state
  s = begin(s, 'd3', ['a', 'd'])
  s = put(s, 'a', 10)
  s = put(s, 'd', 10)
  s = settle(s, { a: H34, d: LOW9 }).state
  assert(s.lockedPots.length === 2, `locked ${s.lockedPots.length}`)
  const [first, second] = s.lockedPots
  assert(first!.amount === 40 && JSON.stringify(first!.eligible) === '["a","b"]' && first!.createdInDealId === 'd1', JSON.stringify(first))
  assert(second!.amount === 90 && JSON.stringify(second!.eligible) === '["b","c"]' && second!.createdInDealId === 'd2', JSON.stringify(second))
  assert(stacksOf(s) === JSON.stringify({ a: 90, b: 50, c: 70, d: 60 }), stacksOf(s))
  assert(Object.values(s.stacks).reduce((x, y) => x + y, 0) + 130 === s.totalChips, 'accounting')
})

check('D6. отпадане: 0 чипа без заключена банка → отпаднал; 0 чипа с право върху заключена → не', () => {
  let s = table(['a', 'b', 'c'])
  s = begin(s, 'd1', ['a', 'b', 'c'])
  s = put(s, 'a', 100)
  s = put(s, 'b', 100)
  s = put(s, 'c', 100)
  s = settle(s, { a: TIE_A, b: TIE_B, c: LOW9 }).state
  assert(s.stacks.a === 0 && s.stacks.b === 0 && s.stacks.c === 0, 'all zero')
  assert(!isSvaraPlayerEliminated(s, 'a') && !isSvaraPlayerEliminated(s, 'b') && isSvaraPlayerEliminated(s, 'c'), 'elimination')
})

// ─── E ───
console.log('\n=== E. неуточнени правила → отказ без промяна ===')

check('E1. банка без нито един правоимащ: отказ, състоянието не се променя', () => {
  let s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  s = put(s, 'a', 30)
  s = put(s, 'b', 30)
  s = fold(s, 'a')
  s = fold(s, 'b')
  const snapshot = JSON.stringify(s)
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e1', hands: {} }), 'rule-not-implemented', 'no eligible')
  assert(JSON.stringify(s) === snapshot, 'mutated')
})

check('E2. участие без чипове (вкл. раздаване за Свара) не е позволено още', () => {
  let s = table(['a', 'b', 'c'])
  s = begin(s, 'd1', ['a', 'b'])
  s = put(s, 'a', 100)
  s = put(s, 'b', 100)
  s = settle(s, { a: TIE_A, b: TIE_B }).state
  expectChipError(() => applySvaraChipCommand(s, { type: 'begin-deal', commandId: 'e2', dealId: 'd2', participants: ['a', 'c'] }), 'rule-not-implemented', '0 chips')
})

check('E3. липсваща/невалидна ръка при сравняване: отказ без промяна', () => {
  let s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  s = put(s, 'a', 10)
  s = put(s, 'b', 10)
  const snapshot = JSON.stringify(s)
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e3', hands: hands({ a: H34 }) }), 'missing-hand', 'missing')
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e4', hands: hands({ a: H34, b: '7S KH QD' }) }), 'invalid-command', 'shared card')
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e5', hands: hands({ a: H34, b: 'AS KH' }) }), 'invalid-command', 'short hand')
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e6', hands: hands({ a: H34, b: 'XX KH QD' }) }), 'invalid-command', 'bad code')
  expectChipError(() => applySvaraChipCommand(s, { type: 'settle-deal', commandId: 'e7', hands: hands({ a: H34, b: H27, z: T11a }) }), 'not-a-participant', 'stranger hand')
  const f = fold(s, 'a')
  expectChipError(() => applySvaraChipCommand(f, { type: 'settle-deal', commandId: 'e8', hands: hands({ a: H34, b: H27 }) }), 'player-folded', 'folded hand')
  assert(JSON.stringify(s) === snapshot, 'mutated')
})

// ─── F ───
console.log('\n=== F. идемпотентност ===')

check('F1. повторена команда: същият резултат, без промяна, без дублиран запис', () => {
  let s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  const command: SvaraChipCommand = { type: 'contribute', commandId: 'same', playerId: 'a', amount: 7, reason: 'ante' }
  const first = applySvaraChipCommand(s, command)
  const second = applySvaraChipCommand(first.state, command)
  assert(first.status === 'applied' && second.status === 'duplicate' && second.state === first.state, 'statuses')
  assert(JSON.stringify(second.outcome) === JSON.stringify(first.outcome), 'outcome')
  assert(first.state.stacks.a === 93 && first.state.ledger.length === s.ledger.length + 1, 'applied once')
  const reordered = { reason: 'ante', amount: 7, playerId: 'a', commandId: 'same', type: 'contribute' } as SvaraChipCommand
  assert(applySvaraChipCommand(first.state, reordered).status === 'duplicate', 'key order does not matter')
  s = first.state
  let settled = applySvaraChipCommand(put(s, 'b', 7, 'ante'), { type: 'settle-deal', commandId: 'settle-x', hands: hands({ a: H34, b: LOW9 }) })
  const again = applySvaraChipCommand(settled.state, { type: 'settle-deal', commandId: 'settle-x', hands: hands({ a: H34, b: LOW9 }) })
  assert(again.status === 'duplicate' && JSON.stringify(again.outcome.settlement) === JSON.stringify(settled.outcome.settlement), 'settle duplicate')
  settled = again
  assert(settled.state.stacks.a === 107, 'paid once')
})

check('F2. същият commandId с различна команда → конфликт без промяна', () => {
  const s = applySvaraChipCommand(begin(table(['a', 'b']), 'd1', ['a', 'b']), { type: 'contribute', commandId: 'k', playerId: 'a', amount: 5, reason: 'bet' }).state
  const snapshot = JSON.stringify(s)
  expectChipError(() => applySvaraChipCommand(s, { type: 'contribute', commandId: 'k', playerId: 'a', amount: 6, reason: 'bet' }), 'command-id-conflict', 'amount differs')
  expectChipError(() => applySvaraChipCommand(s, { type: 'fold', commandId: 'k', playerId: 'a' }), 'command-id-conflict', 'type differs')
  assert(JSON.stringify(s) === snapshot, 'mutated')
})

check('F3. отказана команда не „изразходва“ commandId — след корекция може да се приложи', () => {
  const s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  expectChipError(() => applySvaraChipCommand(s, { type: 'contribute', commandId: 'retry', playerId: 'a', amount: 500, reason: 'bet' }), 'insufficient-chips', 'too much')
  const ok = applySvaraChipCommand(s, { type: 'contribute', commandId: 'retry', playerId: 'a', amount: 50, reason: 'bet' })
  assert(ok.status === 'applied' && ok.state.stacks.a === 50, 'applied after rejection')
})

// ─── G ───
console.log('\n=== G. инварианти ===')

check('G1. подправено състояние се открива (стек, банка, дневник, заключена банка)', () => {
  let s = begin(table(['a', 'b']), 'd1', ['a', 'b'])
  s = put(s, 'a', 20)
  s = put(s, 'b', 20)
  s = settle(s, { a: TIE_A, b: TIE_B }).state
  const tamper = (mutate: (x: SvaraChipTableState) => void, label: string) => {
    const copy = structuredClone(s)
    mutate(copy)
    expectChipError(() => assertSvaraChipInvariants(copy), 'invariant-violation', label)
  }
  assertSvaraChipInvariants(s)
  tamper((x) => { x.stacks.a! += 1 }, 'stack +1')
  tamper((x) => { x.stacks.a = -1 }, 'negative stack')
  tamper((x) => { x.stacks.a = 79.5 }, 'fraction')
  tamper((x) => { x.lockedPots[0]!.amount += 1 }, 'locked +1')
  tamper((x) => { x.lockedPots.push({ ...x.lockedPots[0]! }) }, 'duplicate locked pot')
  tamper((x) => { x.ledger.pop() }, 'ledger entry removed')
  tamper((x) => { x.ledger[3]!.amount += 1 }, 'ledger amount changed')
  tamper((x) => { x.ledger[2]!.seq = 99 }, 'ledger seq')
  tamper((x) => { x.stacks.a! += 40; x.lockedPots = [] }, 'locked pot moved to stack without ledger')
})

// ─── H. Fuzz срещу независим еталон ─────────────────────────────────────────
console.log('\n=== H. случайни последователности ===')

type RefResult = { stacks: Record<string, number>; lockedBySet: Record<string, number>; uncalled: Record<string, number>; unresolved: boolean }

/** Еталон „чип по чип“: всяка единица k=1..max е малка банка. */
function referenceSettlement(participants: string[], contributions: Record<string, number>, folded: Set<string>, points: Record<string, number>, stacksBefore: Record<string, number>): RefResult {
  const stacks = { ...stacksBefore }
  const lockedBySet: Record<string, number> = {}
  const uncalled: Record<string, number> = {}
  const max = Math.max(0, ...participants.map((id) => contributions[id] ?? 0))
  for (let k = 1; k <= max; k += 1) {
    const payers = participants.filter((id) => (contributions[id] ?? 0) >= k)
    const eligible = payers.filter((id) => !folded.has(id))
    if (eligible.length === 0) return { stacks, lockedBySet, uncalled, unresolved: true }
    if (payers.length === 1) {
      stacks[payers[0]!] = stacks[payers[0]!]! + 1
      uncalled[payers[0]!] = (uncalled[payers[0]!] ?? 0) + 1
      continue
    }
    const top = Math.max(...eligible.map((id) => points[id] ?? -1))
    const best = eligible.length === 1 ? eligible : eligible.filter((id) => points[id] === top)
    if (best.length === 1) stacks[best[0]!] = stacks[best[0]!]! + payers.length
    else lockedBySet[best.join(',')] = (lockedBySet[best.join(',')] ?? 0) + payers.length
  }
  return { stacks, lockedBySet, uncalled, unresolved: false }
}

const TIE_PALETTE = [TIE_A, TIE_B, TIE_C, 'AC KS QH']

check('H1. 400 маси × до 12 раздавания: инвариант след всяка команда, банките = еталона чип по чип', () => {
  const random = createSeededSvaraRandomSourceForTests(20261016)
  const pick = (n: number) => random.nextInt(n)
  let deals = 0
  let locks = 0
  let uncalledDeals = 0
  let duplicateChecks = 0
  let refusals = 0
  for (let t = 0; t < 400; t += 1) {
    const players = ['p0', 'p1', 'p2', 'p3'].slice(0, 2 + pick(3))
    let s = createSvaraChipTable({ tableId: `t${t}`, entryFee: 10 * (20 + pick(60)), playerIds: players })
    const history: SvaraChipCommand[] = []
    const run = (command: SvaraChipCommand) => {
      const result = applySvaraChipCommand(s, command)
      assertSvaraChipInvariants(result.state)
      history.push(command)
      s = result.state
      // Повторно изпращане на случайна предишна команда не променя нищо.
      if (pick(5) === 0) {
        const old = history[pick(history.length)]!
        const again = applySvaraChipCommand(s, old)
        if (again.status !== 'duplicate' || again.state !== s) throw new Error('replay changed state')
        duplicateChecks += 1
      }
      return result
    }
    for (let d = 0; d < 12; d += 1) {
      const able = players.filter((id) => s.stacks[id]! > 0)
      if (able.length < 2) break
      const participants = able.filter(() => pick(4) !== 0)
      if (participants.length < 2) continue
      const dealId = `t${t}d${d}`
      run({ type: 'begin-deal', commandId: `${dealId}:begin`, dealId, participants })
      let step = 0
      for (const id of participants) {
        const ante = Math.min(s.stacks[id]!, 1 + pick(3))
        run({ type: 'contribute', commandId: `${dealId}:${step++}`, playerId: id, amount: ante, reason: 'ante' })
      }
      for (let round = 0; round < 1 + pick(3); round += 1) {
        for (const id of participants) {
          if (s.deal!.folded.includes(id) || s.stacks[id] === 0) continue
          const roll = pick(10)
          if (roll === 0 && s.deal!.folded.length < participants.length - 1) {
            run({ type: 'fold', commandId: `${dealId}:${step++}`, playerId: id })
          } else if (roll <= 2) {
            run({ type: 'contribute', commandId: `${dealId}:${step++}`, playerId: id, amount: s.stacks[id]!, reason: 'bet' }) // ол-ин
          } else if (roll <= 6) {
            run({ type: 'contribute', commandId: `${dealId}:${step++}`, playerId: id, amount: 1 + pick(s.stacks[id]!), reason: 'bet' })
          }
        }
      }
      // Ръце: от разбъркано тесте или от палитрата с равни ръце.
      const active = participants.filter((id) => !s.deal!.folded.includes(id))
      const handMap: Record<string, SvaraCardCode[]> = {}
      if (pick(3) === 0) {
        active.forEach((id, i) => { handMap[id] = TIE_PALETTE[i]!.split(' ') as SvaraCardCode[] })
      } else {
        const deck = createShuffledSvaraDeck(random)
        active.forEach((id, i) => { handMap[id] = deck.slice(i * 3, i * 3 + 3).map(svaraCardCode) })
      }
      const points = Object.fromEntries(Object.entries(handMap).map(([id, codes]) => [id, evaluateSvaraHand(codes.map(parseSvaraCardCode)).points]))
      const contributions = { ...s.deal!.contributions }
      const stacksBefore = { ...s.stacks }
      const lockedBefore = s.lockedPots.length
      const ref = referenceSettlement(participants, contributions, new Set(s.deal!.folded), points, stacksBefore)
      let result
      try {
        result = run({ type: 'settle-deal', commandId: `${dealId}:settle`, hands: handMap })
      } catch (error) {
        if (error instanceof SvaraChipCommandError && error.code === 'rule-not-implemented' && ref.unresolved) {
          refusals += 1
          break // масата не може да продължи без още неуточнено правило
        }
        throw error
      }
      if (ref.unresolved) throw new Error(`${dealId}: engine settled a deal the reference marks unresolved`)
      deals += 1
      if (JSON.stringify(s.stacks) !== JSON.stringify(ref.stacks)) throw new Error(`${dealId}: stacks ${JSON.stringify(s.stacks)} ≠ ref ${JSON.stringify(ref.stacks)}`)
      const lockedBySet: Record<string, number> = {}
      for (const pot of s.lockedPots.slice(lockedBefore)) lockedBySet[pot.eligible.join(',')] = (lockedBySet[pot.eligible.join(',')] ?? 0) + pot.amount
      if (JSON.stringify(Object.entries(lockedBySet).sort()) !== JSON.stringify(Object.entries(ref.lockedBySet).sort())) {
        throw new Error(`${dealId}: locked ${JSON.stringify(lockedBySet)} ≠ ref ${JSON.stringify(ref.lockedBySet)}`)
      }
      locks += s.lockedPots.length - lockedBefore
      // Непокритият залог: точно връщаните суми по играч; само на единствения вносител.
      const uncalled: Record<string, number> = {}
      for (const pot of result.outcome.settlement!.pots) {
        if (pot.resolution.kind === 'uncalled-return') {
          if (Object.keys(pot.contributions).length !== 1) throw new Error('uncalled with several contributors')
          uncalled[pot.resolution.playerId] = (uncalled[pot.resolution.playerId] ?? 0) + pot.amount
        } else if (Object.keys(pot.contributions).length < 2) {
          throw new Error('contested pot with a single contributor')
        }
        if (pot.resolution.kind === 'awarded-showdown' || pot.resolution.kind === 'awarded-uncontested') {
          if (!pot.eligible.includes(pot.resolution.winner)) throw new Error('winner not eligible')
        }
        if (pot.resolution.kind === 'locked' && !pot.resolution.tiedPlayers.every((id) => pot.eligible.includes(id))) throw new Error('locked for non-eligible')
      }
      if (JSON.stringify(Object.entries(uncalled).sort()) !== JSON.stringify(Object.entries(ref.uncalled).sort())) {
        throw new Error(`${dealId}: uncalled ${JSON.stringify(uncalled)} ≠ ref ${JSON.stringify(ref.uncalled)}`)
      }
      if (Object.keys(uncalled).length > 0) uncalledDeals += 1
      const potSum = result.outcome.settlement!.pots.reduce((sum, p) => sum + p.amount, 0)
      if (potSum !== Object.values(contributions).reduce((a, b) => a + b, 0)) throw new Error('pots ≠ contributions')
    }
  }
  console.log(`      раздавания ${deals}, заключени банки ${locks}, с непокрит залог ${uncalledDeals}, повторени команди ${duplicateChecks}, отказани (без правоимащ) ${refusals}`)
  assert(deals > 1500 && locks > 100 && uncalledDeals > 100 && duplicateChecks > 1000, 'coverage too low')
})

// ─── I ───
console.log('\n=== I. изолация ===')

check('I1. модулите за чипове импортират само собствени модули на двигателя', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'engine')
  for (const file of readdirSync(dir).filter((f) => f === 'svaraPots.ts' || f === 'svaraChips.ts')) {
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/from '([^']+)'/g)) {
      assert(/^\.\/svara[A-Za-z]+\.js$/.test(match[1]!), `${file} imports ${match[1]}`)
    }
  }
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

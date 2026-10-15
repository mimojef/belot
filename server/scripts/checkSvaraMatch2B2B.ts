/**
 * checkSvaraMatch2B2B.ts — Свара, Етап 2Б.2Б: Вход, дилър, наддаване, тъмно,
 * обикновена Свара, Свара с ол-ин, изход/отсъствие, пренос, отчетност.
 *
 *  A. Маса и Вход (лоби, автоматичен/ръчен старт, % Вход).
 *  B. Наддаване (директно върху модула): ред, без „Пас“, минимуми,
 *     непълно ол-ин повишаване, тъмно и преминаване към нормално.
 *  C. Дилър, ред, печалба на дилъра, специалното 4-то раздаване при двама.
 *  D. Основна и странични банки, различни победители, отпадане,
 *     равенство само в странична банка → изричен отказ.
 *  E. Обикновена Свара: платено включване, еднаква такса, дилър,
 *     ротация, отказ, автоматично сравняване, изчакване, две Свари.
 *  F. Свара с ол-ин: обща нова ръка, отделни права, повторно равенство
 *     в основната, подялба на странична с изваден остатък.
 *  G. Изход, отсъствие, последен шанс, пренос към следващо раздаване.
 *  H. Повторени команди, конфликт, прекъсване (сериализиране) и продължаване.
 *  I. Случайни мачове: инвариант след всяка команда + независим еталон
 *     „чип по чип“ за всяко обикновено раздаване.
 *  J. Изолация.
 *
 * Пускане (от server/): npm run check:svara-match-2b2b
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySvaraBettingAction,
  applySvaraChipCommand,
  applySvaraMatchCommand,
  assertSvaraMatchInvariants,
  buildSvaraDeckForHands,
  computeSvaraEntryChips,
  createSeededSvaraRandomSourceForTests,
  createShuffledSvaraDeck,
  createSvaraBetting,
  createSvaraChipTable,
  createSvaraMatch,
  createSvaraMatchPlayerView,
  describeSvaraMatchOptions,
  evaluateSvaraHand,
  lookAtSvaraCards,
  parseSvaraCardCode,
  SvaraBettingError,
  SvaraMatchError,
  type SvaraBettingAction,
  type SvaraBettingState,
  type SvaraMatchCommand,
  type SvaraMatchEnv,
  type SvaraMatchState,
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

function expectError(fn: () => unknown, code: string, label: string): void {
  try {
    fn()
  } catch (error) {
    const actual = error instanceof SvaraMatchError || error instanceof SvaraBettingError ? error.code : null
    if (actual === code) return
    throw new Error(`${label}: expected ${code}, got ${actual ?? (error instanceof Error ? `${error.name}: ${error.message}` : String(error))}`)
  }
  throw new Error(`${label}: expected ${code}, nothing thrown`)
}

// ─── Помощни за мач ─────────────────────────────────────────────────────────

const fixedDealer = (index: number): SvaraMatchEnv['random'] => ({ nextInt: () => index })

class Table {
  state: SvaraMatchState
  private seq = 0
  constructor(state: SvaraMatchState, private readonly prefix = 'c') {
    this.state = state
  }
  run(command: Omit<SvaraMatchCommand, 'commandId'> & { commandId?: string }, env: SvaraMatchEnv = {}): SvaraMatchState {
    const full = { ...command, commandId: command.commandId ?? `${this.prefix}${(this.seq += 1)}` } as SvaraMatchCommand
    const result = applySvaraMatchCommand(this.state, full, env)
    assertSvaraMatchInvariants(result.state)
    this.state = result.state
    return this.state
  }
  /** Следващо обикновено раздаване с контролирани ръце (по реда на действие). */
  deal(hands: Record<string, string>): SvaraMatchState {
    const order = this.peekOrder()
    return this.run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(order, hands) })
  }
  peekOrder(): string[] {
    // Изчислява реда на следващото обикновено раздаване (първият след дилъра … дилърът).
    const s = this.state
    const participants = s.seats.filter((id) => (s.status[id] === 'active' || s.status[id] === 'absent') && s.stacks[id]! > 0)
    const after = (from: string) => {
      const start = s.seats.indexOf(from)
      const out: string[] = []
      for (let k = 1; k <= s.seats.length; k += 1) {
        const id = s.seats[(start + k) % s.seats.length]!
        if (participants.includes(id)) out.push(id)
      }
      return out
    }
    const dealer = s.ordinaryDealerId === null
      ? (participants.includes(s.firstDealerId!) ? s.firstDealerId! : after(s.firstDealerId!)[0]!)
      : after(s.ordinaryDealerId)[0]!
    return after(dealer)
  }
  act(playerId: string, action: SvaraBettingAction): SvaraMatchState {
    return this.run({ type: 'act', playerId, action })
  }
  look(playerId: string): SvaraMatchState {
    return this.run({ type: 'look', playerId })
  }
  /** Поглежда и действа (обичайният път с видени карти). */
  seen(playerId: string, action: SvaraBettingAction): SvaraMatchState {
    this.look(playerId)
    return this.act(playerId, action)
  }
  stacks(): string {
    return JSON.stringify(this.state.stacks)
  }
}

function newTable(players: string[], opts: { entryFee?: number; entryPercent?: 1 | 2 | 3 | 5; dealerIndex?: number } = {}): Table {
  const state = createSvaraMatch({
    tableId: 't',
    capacity: players.length as 2 | 3 | 4,
    entryFee: opts.entryFee ?? 2000,
    entryPercent: opts.entryPercent ?? 5,
    startMode: 'manual',
    creatorId: players[0]!,
  })
  const table = new Table(state)
  for (const id of players.slice(1)) table.run({ type: 'join-seat', playerId: id })
  table.run({ type: 'start-match', playerId: players[0]! }, { random: fixedDealer(opts.dealerIndex ?? players.length - 1) })
  return table
}

const total = (s: SvaraMatchState) => Object.values(s.stacks).reduce((a, b) => a + b, 0)
const ptsOf = (codes: string) => evaluateSvaraHand(codes.split(' ').map(parseSvaraCardCode)).points

// Ръце с известна сила и без общи карти помежду им.
const H34 = '7S 7H 7D'
const H33 = 'AS AH AD'
const H27 = '10H 9H 8H'
const H24 = '8S 8C 8D'
const TIE1 = 'AC KH QD'
const TIE2 = 'AH KD QC'
const TIE3 = 'AD KC QS'
const TIE4 = 'KS QS JH'.replace('QS', 'JC')
const LOW = '9C 8S JD' // 10 (три бои)

console.log('\ncheckSvaraMatch2B2B')

check('0. силата на тестовите ръце', () => {
  assert(ptsOf(H34) === 34 && ptsOf(H33) === 33 && ptsOf(H27) === 27 && ptsOf(H24) === 24, 'strong')
  assert(ptsOf(TIE1) === 11 && ptsOf(TIE2) === 11 && ptsOf(TIE3) === 11 && ptsOf(LOW) === 10 && ptsOf(TIE4) === 10 && ptsOf(H24) === 24, 'ties')
})

// ─── A. Маса и Вход ─────────────────────────────────────────────────────────
console.log('\n=== A. маса и Вход ===')

check('A1. Вход = ceil(начални × % / 100); по подразбиране 1%; само 1/2/3/5%', () => {
  assert(computeSvaraEntryChips(100, 1) === 1 && computeSvaraEntryChips(150, 3) === 5 && computeSvaraEntryChips(1000, 5) === 50 && computeSvaraEntryChips(199, 1) === 2, 'values')
  const m = createSvaraMatch({ tableId: 't', capacity: 2, entryFee: 1000, startMode: 'auto', creatorId: 'a' })
  assert(m.entryChips === 1 && m.config.entryPercent === 1 && m.startingChips === 100, 'default 1%')
  for (const bad of [0, 4, 10, 2.5]) {
    let threw = false
    try { computeSvaraEntryChips(100, bad as 1) } catch { threw = true }
    assert(threw, `percent ${bad}`)
  }
})

check('A2. автоматичен старт при запълване; ръчен — само създателят и само при пълна маса', () => {
  const auto = new Table(createSvaraMatch({ tableId: 't', capacity: 3, entryFee: 1000, startMode: 'auto', creatorId: 'a' }))
  auto.run({ type: 'join-seat', playerId: 'b' })
  assert(auto.state.phase === 'lobby', 'not yet')
  auto.run({ type: 'join-seat', playerId: 'c' }, { random: fixedDealer(0) })
  assert(auto.state.phase === 'in-progress' && auto.state.firstDealerId === 'a' && auto.state.totalChips === 300, 'auto started')
  expectError(() => auto.run({ type: 'join-seat', playerId: 'd' }), 'wrong-phase', 'no join after start')

  const manual = new Table(createSvaraMatch({ tableId: 't', capacity: 3, entryFee: 1000, startMode: 'manual', creatorId: 'a' }))
  manual.run({ type: 'join-seat', playerId: 'b' })
  expectError(() => manual.run({ type: 'start-match', playerId: 'a' }), 'not-allowed', 'not full')
  manual.run({ type: 'join-seat', playerId: 'c' })
  assert(manual.state.phase === 'lobby', 'manual waits')
  manual.run({ type: 'leave-seat', playerId: 'c' })
  expectError(() => manual.run({ type: 'start-match', playerId: 'a' }), 'not-allowed', 'blocked after leave')
  manual.run({ type: 'join-seat', playerId: 'd' })
  expectError(() => manual.run({ type: 'start-match', playerId: 'b' }), 'not-allowed', 'only creator')
  manual.run({ type: 'start-match', playerId: 'a' }, { random: fixedDealer(2) })
  assert(manual.state.phase === 'in-progress' && manual.state.firstDealerId === 'd' && JSON.stringify(manual.state.seats) === '["a","b","d"]', 'manual started')
})

check('A3. Входът е фиксиран през целия мач и се плаща от всички участници', () => {
  const t = newTable(['a', 'b', 'c'])
  assert(t.state.entryChips === 10, 'entry 10')
  for (let i = 0; i < 3; i += 1) {
    const order = t.peekOrder()
    t.deal({})
    assert(order.every((id) => (t.state.round as { contributions: Record<string, number> }).contributions[id] === 10), 'everyone paid 10')
    t.seen(order[0]!, { kind: 'fold' })
    t.seen(order[1]!, { kind: 'fold' })
  }
  assert(t.state.entryChips === 10 && t.state.history.length === 3, 'still 10')
})

// ─── B. Наддаване (модул) ───────────────────────────────────────────────────
console.log('\n=== B. наддаване ===')

function bet(stacks: Record<string, number>, entry = 10, allowNoBet = false): { s: SvaraBettingState; stacks: Record<string, number>; go: (id: string, action: SvaraBettingAction) => void } {
  const ctx = { s: createSvaraBetting({ order: Object.keys(stacks), stacks, folded: [], entryChips: entry, allowNoBet }), stacks: { ...stacks }, go: (_id: string, _a: SvaraBettingAction) => {} }
  ctx.go = (id, action) => {
    const r = applySvaraBettingAction(ctx.s, id, action, ctx.stacks[id]!)
    ctx.stacks[id] = ctx.stacks[id]! - r.added
    ctx.s = r.state
  }
  return ctx
}

check('B1. ред, без „Пас“: първият може само да залага (≥ 1 Вход) или да се откаже', () => {
  const b = bet({ p1: 100, p2: 100, dealer: 100 })
  assert(b.s.toAct === 'p1', 'first after dealer')
  b.s = lookAtSvaraCards(b.s, 'p1')
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'fold' }, 100), 'not-your-turn', 'order')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'call' }, 100), 'invalid-action', 'no check/call')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'no-bet' }, 100), 'invalid-action', 'no pass')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'bet', total: 9 }, 100), 'below-minimum', 'min 1 entry')
  b.go('p1', { kind: 'bet', total: 10 })
  assert(b.s.toAct === 'p2' && b.s.currentBet === 10, 'opened')
})

check('B2. повишаване минимум с 1 Вход над текущия залог, без ограничение в броя; приключване', () => {
  const b = bet({ p1: 200, p2: 200, d: 200 })
  b.s = lookAtSvaraCards(lookAtSvaraCards(lookAtSvaraCards(b.s, 'p1'), 'p2'), 'd')
  b.go('p1', { kind: 'bet', total: 10 })
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'bet', total: 19 }, 200), 'below-minimum', 'raise +9')
  b.go('p2', { kind: 'bet', total: 20 })
  b.go('d', { kind: 'bet', total: 30 })
  b.go('p1', { kind: 'bet', total: 40 })
  b.go('p2', { kind: 'bet', total: 50 })
  b.go('d', { kind: 'call' })
  assert(!b.s.complete && b.s.toAct === 'p1', 'p1 must respond')
  b.go('p1', { kind: 'call' })
  assert(b.s.complete && b.s.currentBet === 50 && b.s.voluntary.p1 === 50 && b.s.voluntary.d === 50, 'complete')
})

check('B3. непълно ол-ин повишаване: вече действалите само плащат/откажат; недействалите могат да повишат', () => {
  const b = bet({ p1: 200, p2: 25, d: 200, x: 200 })
  for (const id of ['p1', 'p2', 'd', 'x']) b.s = lookAtSvaraCards(b.s, id)
  b.go('p1', { kind: 'bet', total: 20 }) // пълно отваряне
  b.go('p2', { kind: 'all-in' }) // 25 < 20 + 10 → непълно
  assert(b.s.currentBet === 25 && JSON.stringify(b.s.raiseLocked) === '["p1"]', `locked ${JSON.stringify(b.s.raiseLocked)}`)
  b.go('d', { kind: 'bet', total: 35 }) // не е действал → може да повиши (25 + 10)
  assert(b.s.raiseLocked.length === 0, 'full raise clears lock')
  b.go('x', { kind: 'call' })
  b.go('p1', { kind: 'call' })
  assert(b.s.complete, 'complete')

  const c = bet({ p1: 200, p2: 25, d: 200 })
  for (const id of ['p1', 'p2', 'd']) c.s = lookAtSvaraCards(c.s, id)
  c.go('p1', { kind: 'bet', total: 20 })
  c.go('p2', { kind: 'all-in' })
  c.go('d', { kind: 'call' })
  assert(c.s.toAct === 'p1', 'p1 must respond to the extra 5')
  expectError(() => applySvaraBettingAction(c.s, 'p1', { kind: 'bet', total: 40 }, c.stacks.p1!), 'raise-not-allowed', 'locked raise')
  expectError(() => applySvaraBettingAction(c.s, 'p1', { kind: 'all-in' }, c.stacks.p1!), 'raise-not-allowed', 'locked all-in raise')
  c.go('p1', { kind: 'call' })
  assert(c.s.complete && c.s.voluntary.p1 === 25, 'called the short raise')
})

check('B4. ол-ин за по-малко при плащане не променя текущия залог', () => {
  const b = bet({ p1: 200, p2: 15, d: 200 })
  for (const id of ['p1', 'p2', 'd']) b.s = lookAtSvaraCards(b.s, id)
  b.go('p1', { kind: 'bet', total: 30 })
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'call' }, 15), 'insufficient-chips', 'call more than stack')
  b.go('p2', { kind: 'all-in' })
  assert(b.s.currentBet === 30 && b.s.allIn.includes('p2') && b.s.voluntary.p2 === 15, 'short call')
  b.go('d', { kind: 'call' })
  assert(b.s.complete, 'complete')
})

check('B5. тъмно: само първият, преди да погледне; ≥ 2 × Вход; следващите ≥ 2 × предишния; погледналият ≥ 2 × последния → край', () => {
  const b = bet({ p1: 500, p2: 500, p3: 500, d: 500 })
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'bet', total: 10 }, 500), 'look-required', 'unlooked normal bet')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'blind-bet', total: 19 }, 500), 'below-minimum', 'blind < 2E')
  b.go('p1', { kind: 'blind-bet', total: 20 })
  assert(b.s.blind.status === 'active' && b.s.blind.lastBlindTotal === 20, 'blind started')
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'blind-bet', total: 39 }, 500), 'below-minimum', 'next blind < 2×')
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'call' }, 500), 'invalid-action', 'no call in blind phase')
  b.go('p2', { kind: 'blind-bet', total: 40 })
  b.s = lookAtSvaraCards(b.s, 'p3')
  expectError(() => applySvaraBettingAction(b.s, 'p3', { kind: 'blind-bet', total: 80 }, 500), 'blind-not-allowed', 'looked cannot blind')
  expectError(() => applySvaraBettingAction(b.s, 'p3', { kind: 'bet', total: 79 }, 500), 'below-minimum', 'seen < 2× last blind')
  b.go('p3', { kind: 'bet', total: 80 })
  assert(b.s.blind.status === 'closed', 'blind phase over for everyone')
  // d не е гледал: вече важат обикновените правила (плащане или +1 Вход).
  b.go('d', { kind: 'bet', total: 90 })
  b.go('p1', { kind: 'call' })
  b.go('p2', { kind: 'call' })
  b.go('p3', { kind: 'call' })
  assert(b.s.complete && b.s.currentBet === 90, 'normal betting after blind')
})

check('B6. тъмно не може да започне друг освен първия, нито след като първият е погледнал', () => {
  const b = bet({ p1: 500, p2: 500, d: 500 })
  b.s = lookAtSvaraCards(b.s, 'p1')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'blind-bet', total: 20 }, 500), 'blind-not-allowed', 'looked first')
  b.go('p1', { kind: 'bet', total: 10 })
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'blind-bet', total: 20 }, 500), 'blind-not-allowed', 'second cannot start')
})

check('B7. случай №4: непълен ол-ин на тъмно — позволен, не е пълно повишаване, тъмната фаза продължава, минимумът остава 40', () => {
  const b = bet({ p1: 500, p2: 30, p3: 500, d: 500 })
  b.go('p1', { kind: 'blind-bet', total: 20 })
  b.go('p2', { kind: 'all-in' }) // 30 < 40
  assert(b.s.voluntary.p2 === 30 && b.s.allIn.includes('p2') && b.s.currentBet === 30, 'accepted as all-in')
  assert(b.s.blind.status === 'active' && b.s.blind.lastBlindTotal === 20, 'blind phase continues, base stays 20')
  expectError(() => applySvaraBettingAction(b.s, 'p3', { kind: 'blind-bet', total: 39 }, 500), 'below-minimum', 'next full blind is 40')
  b.go('p3', { kind: 'blind-bet', total: 40 }) // 40, не 60
  assert(b.s.blind.lastBlindTotal === 40 && b.s.raiseLocked.length === 0, 'full blind after the short all-in')
})

check('B7b. случай №4: без неправомерно повторно право — вече действалият може само да доплати или да се откаже', () => {
  const b = bet({ p1: 500, p2: 30, d: 500 })
  b.go('p1', { kind: 'blind-bet', total: 20 })
  b.go('p2', { kind: 'all-in' }) // непълно
  b.go('d', { kind: 'fold' })
  assert(b.s.toAct === 'p1' && b.s.raiseLocked.includes('p1'), 'p1 locked')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'blind-bet', total: 40 }, b.stacks.p1!), 'raise-not-allowed', 'no new raise right')
  expectError(() => applySvaraBettingAction(b.s, 'p1', { kind: 'all-in' }, b.stacks.p1!), 'raise-not-allowed', 'no all-in raise')
  b.go('p1', { kind: 'call' }) // доплаща 10
  assert(b.s.complete && b.s.voluntary.p1 === 30 && b.s.blind.status === 'active', 'called, still blind')
})

check('B7c. оставащи неуточнени подслучаи → изричен отказ (погледнал играч под минимума; непълен тъмен ол-ин на първия)', () => {
  const b = bet({ p1: 500, p2: 30, d: 500 })
  b.go('p1', { kind: 'blind-bet', total: 20 })
  b.s = lookAtSvaraCards(b.s, 'p2')
  expectError(() => applySvaraBettingAction(b.s, 'p2', { kind: 'all-in' }, 30), 'rule-not-implemented', 'looked short all-in')
  const c = bet({ p1: 15, p2: 500, d: 500 })
  expectError(() => applySvaraBettingAction(c.s, 'p1', { kind: 'all-in' }, 15), 'rule-not-implemented', 'first blind all-in < 2E')
  expectError(() => applySvaraBettingAction(c.s, 'p1', { kind: 'blind-bet', total: 15 }, 15), 'rule-not-implemented', 'first blind short')
})

// ─── C. Дилър, ред, специалното 4-то раздаване ──────────────────────────────
console.log('\n=== C. дилър и ред ===')

check('C1. първият дилър е случаен; ред: следващият след дилъра … дилърът; ротация по часовника', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 1 })
  assert(t.state.firstDealerId === 'b', 'random dealer = b')
  const dealers: string[] = []
  const firsts: string[] = []
  for (let i = 0; i < 4; i += 1) {
    t.deal({})
    const round = t.state.round as { dealerId: string; betting: SvaraBettingState }
    dealers.push(round.dealerId)
    firsts.push(round.betting.toAct!)
    assert(round.betting.order[round.betting.order.length - 1] === round.dealerId, 'dealer last')
    const [x, y] = round.betting.order
    t.seen(x!, { kind: 'fold' })
    t.seen(y!, { kind: 'fold' })
  }
  assert(dealers.join() === 'b,c,a,b' && firsts.join() === 'c,a,b,c', `${dealers} / ${firsts}`)
})

check('C2. без доброволни залози дилърът печели Входовете', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({})
  t.seen('a', { kind: 'fold' })
  t.seen('b', { kind: 'fold' })
  assert(t.state.round === null && t.stacks() === JSON.stringify({ a: 190, b: 190, c: 220 }), t.stacks())
  const pots = t.state.history[0]!.pots
  assert(pots.length === 1 && pots[0]!.outcome.kind === 'awarded' && (pots[0]!.outcome as { winner: string }).winner === 'c', JSON.stringify(pots))
})

check('C3. двама: 3 поредни раздавания без залози → 4-тото позволява „Без залог“; двамата → сравняване; броенето започва отново', () => {
  const t = newTable(['a', 'b'], { dealerIndex: 1 })
  for (let i = 0; i < 3; i += 1) {
    t.deal({})
    const first = (t.state.round as { betting: SvaraBettingState }).betting.toAct!
    expectError(() => t.run({ type: 'act', playerId: first, action: { kind: 'no-bet' } }), 'betting:invalid-action', `no-bet in deal ${i + 1}`)
    t.seen(first, { kind: 'fold' })
  }
  assert(t.state.headsUpNoBetStreak === 3, `streak ${t.state.headsUpNoBetStreak}`)
  const order = t.peekOrder()
  t.deal({ [order[0]!]: H34, [order[1]!]: LOW })
  t.seen(order[0]!, { kind: 'no-bet' })
  t.seen(order[1]!, { kind: 'no-bet' })
  const record = t.state.history[t.state.history.length - 1]!
  assert(record.pots[0]!.outcome.kind === 'awarded' && (record.pots[0]!.outcome as { winner: string; byShowdown: boolean }).winner === order[0] && (record.pots[0]!.outcome as { byShowdown: boolean }).byShowdown, 'compared')
  assert(t.state.headsUpNoBetStreak === 0, 'reset after 4th')
  t.deal({})
  const first = (t.state.round as { betting: SvaraBettingState }).betting.toAct!
  expectError(() => t.run({ type: 'act', playerId: first, action: { kind: 'no-bet' } }), 'betting:invalid-action', 'no-bet after reset')
})

check('C4. доброволен залог прекъсва поредицата; при 4-тото „Без залог“ + отказ на другия → печели оставащият (без сравняване)', () => {
  const t = newTable(['a', 'b'], { dealerIndex: 1 })
  for (let i = 0; i < 2; i += 1) {
    t.deal({})
    t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'fold' })
  }
  t.deal({})
  const first = (t.state.round as { betting: SvaraBettingState }).betting.toAct!
  t.seen(first, { kind: 'bet', total: 10 })
  t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'fold' })
  assert(t.state.headsUpNoBetStreak === 0, 'reset by voluntary bet')
  for (let i = 0; i < 3; i += 1) {
    t.deal({})
    t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'fold' })
  }
  t.deal({})
  const order = (t.state.round as { betting: SvaraBettingState }).betting.order
  t.seen(order[0]!, { kind: 'no-bet' })
  t.seen(order[1]!, { kind: 'fold' })
  const pot = t.state.history[t.state.history.length - 1]!.pots[0]!
  assert(pot.outcome.kind === 'awarded' && (pot.outcome as { winner: string; byShowdown: boolean }).winner === order[0] && !(pot.outcome as { byShowdown: boolean }).byShowdown, JSON.stringify(pot))
})

// ─── D. Банки ───────────────────────────────────────────────────────────────
console.log('\n=== D. основна и странични банки ===')

function shapedThree(): Table {
  // a 310, b 100, c 190 след първото раздаване (дилър c; ред a, b, c).
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 90 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  assert(t.stacks() === JSON.stringify({ a: 310, b: 100, c: 190 }), t.stacks())
  return t
}

check('D1. ол-ин на различни нива: основната и страничната банка с различни победители; отпадане', () => {
  const t = shapedThree() // следващ дилър a; ред b, c, a
  t.deal({ b: H34, c: LOW, a: H27 })
  t.seen('b', { kind: 'all-in' }) // 90
  t.seen('c', { kind: 'all-in' }) // 180
  t.seen('a', { kind: 'call' }) // 180
  const pots = t.state.history[t.state.history.length - 1]!.pots
  const summary = pots.map((p) => `${p.amount}:${p.eligible.join('')}:${p.outcome.kind}:${(p.outcome as { winner?: string }).winner ?? ''}`)
  assert(JSON.stringify(summary) === JSON.stringify(['300:bca:awarded:b', '180:ca:awarded:a']), JSON.stringify(summary))
  assert(t.stacks() === JSON.stringify({ a: 300, b: 300, c: 0 }) && t.state.status.c === 'eliminated', t.stacks())
})

check('D2. непокрит залог се връща (отделен запис), не е печалба', () => {
  const t = shapedThree()
  t.deal({ b: LOW, c: H27, a: H34 })
  t.seen('b', { kind: 'all-in' }) // 90
  t.seen('c', { kind: 'fold' })
  t.seen('a', { kind: 'bet', total: 150 }) // 60 над b → непокрито
  const pots = t.state.history[t.state.history.length - 1]!.pots
  assert(pots.some((p) => p.outcome.kind === 'uncalled-return' && p.amount === 60), JSON.stringify(pots))
  const entries = t.state.ledger.filter((e) => e.roundId === t.state.history[t.state.history.length - 1]!.roundId)
  assert(entries.some((e) => e.type === 'uncalled-return' && e.amount === 60 && e.playerId === 'a'), 'ledger uncalled')
})

check('D3. случай №1: основната има победител, страничната е равна → нови карти само за равните, без Вход/наддаване/външни; ново равенство → подялба', () => {
  const t = shapedThree() // ред b, c, a
  t.deal({ b: H34, c: TIE1, a: TIE2 })
  t.seen('b', { kind: 'all-in' })
  t.seen('c', { kind: 'all-in' })
  t.seen('a', { kind: 'call' })
  const record = t.state.history[t.state.history.length - 1]!
  assert(record.pots[0]!.outcome.kind === 'awarded' && (record.pots[0]!.outcome as { winner: string }).winner === 'b' && t.state.stacks.b === 300, 'main paid to b')
  const side = t.state.lockedPots[0]!
  assert(t.state.lockedPots.length === 1 && side.kind === 'allin' && !side.isMain && side.amount === 180 && JSON.stringify([...side.eligible].sort()) === '["a","c"]', JSON.stringify(t.state.lockedPots))
  assert((t.state.round as { kind: string }).kind === 'allin-svara', 'special continuation')
  expectError(() => t.run({ type: 'svara-join', playerId: 'b' }), 'not-allowed', 'no outside players')
  expectError(() => t.run({ type: 'act', playerId: 'a', action: { kind: 'bet', total: 10 } }), 'not-allowed', 'no betting')
  const entriesBefore = t.state.ledger.filter((e) => e.type === 'entry').length
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'c'], { a: TIE1, c: TIE2 }) })
  const step = t.state.history[t.state.history.length - 1]!
  assert(JSON.stringify(Object.keys(step.shownHands).sort()) === '["a","c"]', 'only the tied get new cards')
  assert(t.state.ledger.filter((e) => e.type === 'entry').length === entriesBefore, 'no new entry')
  const split = step.pots[0]!.outcome as { kind: string; share: number; removed: number }
  assert(split.kind === 'split' && split.share === 90 && split.removed === 0, JSON.stringify(step.pots))
  assert(t.stacks() === JSON.stringify({ a: 210, b: 300, c: 90 }) && t.state.round === null, t.stacks())
})

check('D3b. случай №1: странична равна, на новото раздаване има победител → получава цялата странична банка', () => {
  const t = shapedThree()
  t.deal({ b: H34, c: TIE1, a: TIE2 })
  t.seen('b', { kind: 'all-in' })
  t.seen('c', { kind: 'all-in' })
  t.seen('a', { kind: 'call' })
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'c'], { a: LOW, c: H27 }) })
  assert(t.stacks() === JSON.stringify({ a: 120, b: 300, c: 180 }) && t.state.removedChips === 0, t.stacks())
})

check('D4. случай №3: всички ол-ин от Входа → автоматично сравняване (без печалба на дилъра); отсъстващият не печели', () => {
  // Дилър c; ред a, b, c. a и b равни, c по-слаб: всички остават с по 5 чипа.
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: TIE1, b: TIE2, c: LOW })
  t.seen('a', { kind: 'bet', total: 185 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'call' })
  assert(t.stacks() === JSON.stringify({ a: 5, b: 5, c: 5 }) && t.state.lockedPots[0]!.amount === 585, t.stacks())
  t.run({ type: 'set-absent', playerId: 'b', absent: true }) // Сварата изчаква
  // Обикновено раздаване: дилър a; ред b, c, a. Всички плащат по 5 (ол-ин); b отсъства → отказва.
  t.run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(['b', 'c', 'a'], { b: H33, c: H34, a: LOW }) })
  assert(t.state.round === null, 'settled immediately (nobody can act)')
  const record = t.state.history[t.state.history.length - 1]!
  assert(record.dealerId === 'a' && !record.anyVoluntaryBet && record.folded.includes('b'), JSON.stringify(record))
  const pot = record.pots[0]!
  assert(pot.amount === 15 && (pot.outcome as { winner: string; byShowdown: boolean }).winner === 'c' && (pot.outcome as { byShowdown: boolean }).byShowdown, 'c wins by comparison, not dealer a; absent b (33) cannot win')
  assert(t.stacks() === JSON.stringify({ a: 0, b: 0, c: 15 }) && t.state.status.a === 'active' && t.state.status.b === 'absent', 'a, b keep locked rights')
})

check('D4b. случай №3: равенство при автоматичното сравняване → Свара', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: TIE1, b: TIE2, c: LOW })
  t.seen('a', { kind: 'bet', total: 185 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'call' })
  t.run({ type: 'set-absent', playerId: 'b', absent: true })
  t.run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(['b', 'c', 'a'], { b: H34, c: TIE3, a: TIE1 }) })
  assert(t.state.lockedPots.length === 2 && JSON.stringify([...t.state.lockedPots[1]!.eligible].sort()) === '["a","c"]' && t.state.lockedPots[1]!.amount === 15, JSON.stringify(t.state.lockedPots))
})

check('D5. ако само един може да действа (другите са ол-ин), той трябва да заложи или да се откаже (без „Пас“)', () => {
  const b = createSvaraBetting({ order: ['a', 'b'], stacks: { a: 0, b: 100 }, folded: [], entryChips: 10, allowNoBet: false })
  assert(!b.complete && b.toAct === 'b' && b.pending.join() === 'b', 'b must act')
  const looked = lookAtSvaraCards(b, 'b')
  expectError(() => applySvaraBettingAction(looked, 'b', { kind: 'call' }, 100), 'invalid-action', 'no check')
  const done = applySvaraBettingAction(looked, 'b', { kind: 'bet', total: 10 }, 100)
  assert(done.state.complete && done.added === 10, 'bet ends betting (uncalled later)')
})

// ─── E. Обикновена Свара ────────────────────────────────────────────────────
console.log('\n=== E. обикновена Свара ===')

function tiedThree(): Table {
  // Дилър c; a и b равни (11), c се отказва → заключена банка 30 + 40 = 70 за {a, b}.
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: TIE1, b: TIE2, c: H34 })
  t.seen('a', { kind: 'bet', total: 20 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  const pot = t.state.lockedPots[0]!
  assert(t.state.lockedPots.length === 1 && pot.kind === 'ordinary' && pot.amount === 70 && JSON.stringify(pot.eligible) === '["a","b"]', JSON.stringify(t.state.lockedPots))
  return t
}

check('E1. включване срещу пълна такса ceil(банка / равни); банката расте; без нов Вход; дилър и ред', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  const joining = t.state.round as { kind: string; fee: number }
  assert(joining.kind === 'svara-joining' && joining.fee === 35, JSON.stringify(joining))
  expectError(() => t.run({ type: 'svara-join', playerId: 'a' }), 'not-allowed', 'tied player cannot pay')
  t.run({ type: 'svara-join', playerId: 'c' })
  assert(t.state.lockedPots[0]!.amount === 105 && t.state.stacks.c === 155, 'fee paid into the locked pot')
  const order = ['b', 'c', 'a'] // дилър = следващият правоимащ след c → a
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(order, { b: TIE1, c: H34, a: LOW }) })
  const round = t.state.round as { kind: string; dealerId: string; contributions: Record<string, number>; betting: SvaraBettingState }
  assert(round.kind === 'svara' && round.dealerId === 'a' && round.betting.order.join() === 'b,c,a', `${round.dealerId} ${round.betting.order}`)
  assert(Object.keys(round.contributions).length === 0, 'no entry in a Svara deal')
  t.seen('b', { kind: 'bet', total: 10 })
  t.seen('c', { kind: 'call' })
  t.seen('a', { kind: 'call' })
  assert(t.state.round === null && t.state.lockedPots.length === 0, 'resolved')
  assert(t.stacks() === JSON.stringify({ a: 160, b: 160, c: 280 }), t.stacks())
  // Обикновената ротация не е засегната: следващото обикновено раздаване е с дилър a (след c).
  t.deal({})
  assert((t.state.round as { dealerId: string }).dealerId === 'a', 'ordinary dealer unaffected')
})

check('E2. еднаква такса за всички влизащи (изчислена веднъж); непълна такса не се приема', () => {
  const t = newTable(['a', 'b', 'c', 'd'], { dealerIndex: 3 }) // ред a, b, c, d
  t.deal({ a: TIE1, b: TIE2, c: H34, d: H27 })
  t.seen('a', { kind: 'bet', total: 10 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  t.seen('d', { kind: 'fold' })
  assert(t.state.lockedPots[0]!.amount === 60, 'locked 60')
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-join', playerId: 'c' })
  t.run({ type: 'svara-join', playerId: 'd' })
  const pot = t.state.lockedPots[0]!
  assert(pot.amount === 120 && t.state.stacks.c === 160 && t.state.stacks.d === 160, `both paid 30: ${pot.amount} ${t.stacks()}`)
})

check('E3. отказ в Свара губи правото и върху заключената банка; ол-ин/0 чипа не е отказ', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW }) })
  // Дилър = следващият правоимащ след c → a; ред b, a.
  t.seen('b', { kind: 'bet', total: 10 })
  t.seen('a', { kind: 'fold' })
  // b: 170 − 10 + 70 (заключена) + 10 (непокрит залог) = 240.
  assert(t.state.lockedPots.length === 0 && t.stacks() === JSON.stringify({ a: 170, b: 240, c: 190 }), t.stacks())
})

check('E4. всички правоимащи без свободни чипове → автоматично сравняване', () => {
  const t = newTable(['a', 'b'], { dealerIndex: 1 }) // ред a, b
  t.deal({ a: TIE1, b: TIE2 })
  t.seen('a', { kind: 'all-in' })
  t.seen('b', { kind: 'call' })
  assert(t.state.lockedPots[0]!.amount === 400 && t.state.stacks.a === 0 && t.state.stacks.b === 0, 'locked 400, both 0')
  assert(t.state.status.a === 'active' && t.state.status.b === 'active', 'not eliminated (rights)')
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { a: H33, b: H34 }) })
  assert(t.state.round === null && t.state.stacks.b === 400 && t.state.phase === 'finished' && t.state.winnerId === 'b', `${t.stacks()} ${t.state.phase}`)
})

check('E5. ново равенство: банката остава заключена; нова такса; дилърът се върти сред участниците', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { b: TIE1, a: TIE2 }) })
  t.seen('b', { kind: 'bet', total: 10 })
  t.seen('a', { kind: 'call' })
  // Нови залози 20 → равенство → нова заключена банка; старата също остава заключена.
  assert(t.state.lockedPots.length === 2, JSON.stringify(t.state.lockedPots.map((p) => [p.potId, p.amount, p.eligible])))
  const first = t.state.lockedPots[0]!
  assert(first.amount === 70 && JSON.stringify([...first.eligible].sort()) === '["a","b"]' && first.lastSvaraDealerId === 'a' && first.continuation === 1, JSON.stringify(first))
  t.run({ type: 'start-next-round' })
  assert((t.state.round as { fee: number }).fee === 35, 'new fee computed')
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b'], { a: H34, b: LOW }) })
  assert((t.state.round as { dealerId: string }).dealerId === 'b', 'dealer rotates among participants (a → b)')
})

check('E6. Свара изчаква отсъстващ правоимащ; две независими Свари се разиграват последователно, без смесване', () => {
  const t = tiedThree() // lock1 {a, b}
  t.run({ type: 'set-absent', playerId: 'b', absent: true })
  // Свара 1 не може да започне → обикновено раздаване; b плаща Вход и автоматично отказва.
  const order = t.peekOrder()
  t.deal({ a: TIE1, c: TIE3 })
  assert((t.state.round as { kind: string }).kind === 'ordinary', 'ordinary while Svara waits')
  assert((t.state.round as { betting: SvaraBettingState }).betting.folded.includes('b'), 'absent auto-folded')
  const firstActive = order.find((id) => id !== 'b')!
  const other = order.find((id) => id !== 'b' && id !== firstActive)!
  t.seen(firstActive, { kind: 'bet', total: 10 })
  t.seen(other, { kind: 'call' })
  assert(t.state.lockedPots.length === 2, 'two locked Svaras')
  const [lock1, lock2] = t.state.lockedPots
  assert(JSON.stringify([...lock1!.eligible].sort()) === '["a","b"]' && JSON.stringify([...lock2!.eligible].sort()) === '["a","c"]', 'separate rights')
  t.run({ type: 'start-next-round' })
  assert((t.state.round as { potId: string }).potId === lock2!.potId, 'lock2 starts while b is absent')
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['a', 'c'], { a: H34, c: LOW }) })
  t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'bet', total: 10 })
  t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'call' })
  assert(t.state.lockedPots.length === 1 && t.state.lockedPots[0]!.potId === lock1!.potId, 'lock1 still waiting')
  t.run({ type: 'set-absent', playerId: 'b', absent: false })
  t.run({ type: 'start-next-round' })
  assert((t.state.round as { potId: string }).potId === lock1!.potId, 'lock1 now')
})

check('E7. случай №5: отсъствие по време на Свара не е отказ — правата се пазят, ходът изчаква завръщането', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW }) })
  t.seen('b', { kind: 'bet', total: 10 })
  t.run({ type: 'set-absent', playerId: 'a', absent: true })
  const round = t.state.round as { kind: string; betting: SvaraBettingState }
  assert(round.kind === 'svara' && round.betting.toAct === 'a' && !round.betting.folded.includes('a'), 'not folded, waiting for a')
  expectError(() => t.run({ type: 'act', playerId: 'a', action: { kind: 'call' } }), 'player-absent', 'absent cannot act')
  expectError(() => t.run({ type: 'act', playerId: 'b', action: { kind: 'bet', total: 30 } }), 'betting:not-your-turn', 'others wait')
  assert(t.state.lockedPots[0]!.eligible.includes('a'), 'rights kept')
  t.run({ type: 'set-absent', playerId: 'a', absent: false })
  t.seen('a', { kind: 'call' })
  // b: 170 − 10 + 70 + 20 = 250; a: 170 − 10 = 160.
  assert(t.stacks() === JSON.stringify({ a: 160, b: 250, c: 190 }), t.stacks())
})

check('E7b. случай №5: последен шанс — само при един активен; после правата отпадат и банките се разпределят', () => {
  const t = tiedThree()
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['b', 'a'], { b: LOW, a: H34 }) })
  t.seen('b', { kind: 'bet', total: 10 })
  t.run({ type: 'set-absent', playerId: 'a', absent: true })
  expectError(() => t.run({ type: 'absence-expired', playerId: 'a' }), 'not-allowed', 'b and c are active')
  t.run({ type: 'set-absent', playerId: 'c', absent: true })
  t.run({ type: 'absence-expired', playerId: 'a' })
  // a губи правата → b единствен: заключената банка 70 + непокритият му залог 10 обратно.
  assert(t.state.round === null && t.state.lockedPots.length === 0 && t.stacks() === JSON.stringify({ a: 170, b: 240, c: 190 }), t.stacks())
  const pots = t.state.history[t.state.history.length - 1]!.pots
  assert(pots.some((p) => p.outcome.kind === 'uncalled-return' && p.amount === 10), 'uncalled returned, not won')
})

check('E8. случай №2: ол-ин в обикновена Свара — стара банка 150 отделно; нови залози 10/30/30 → основна 30 и странична 40', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 }) // ред a, b, c
  t.deal({ a: LOW, b: H34 })
  t.seen('a', { kind: 'bet', total: 130 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  assert(t.stacks() === JSON.stringify({ a: 60, b: 350, c: 190 }), t.stacks())
  t.deal({ b: TIE1, c: TIE2, a: TIE3 }) // дилър a; ред b, c, a
  t.seen('b', { kind: 'bet', total: 40 })
  t.seen('c', { kind: 'call' })
  t.seen('a', { kind: 'call' })
  assert(t.state.lockedPots[0]!.amount === 150 && t.stacks() === JSON.stringify({ a: 10, b: 300, c: 140 }), t.stacks())
  t.run({ type: 'start-next-round' })
  // Дилър на Сварата: следващият правоимащ след a → b; ред c, a, b.
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['c', 'a', 'b'], { c: H27, a: H34, b: LOW }) })
  t.seen('c', { kind: 'bet', total: 30 })
  t.seen('a', { kind: 'all-in' }) // 10
  t.seen('b', { kind: 'call' })
  const pots = t.state.history[t.state.history.length - 1]!.pots
  const summary = pots.map((p) => `${p.source}:${p.amount}:${[...p.eligible].sort().join('')}:${(p.outcome as { winner?: string }).winner ?? p.outcome.kind}`)
  assert(JSON.stringify(summary) === JSON.stringify(['locked:150:abc:a', 'round:30:abc:a', 'round:40:bc:c']), JSON.stringify(summary))
  assert(t.stacks() === JSON.stringify({ a: 180, b: 270, c: 150 }), t.stacks())
})

check('E8b. случай №2: равенство в новите залози при нов ол-ин → Свара с ол-ин само за тях; старата банка остава обикновена', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: LOW, b: H34 })
  t.seen('a', { kind: 'bet', total: 130 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  t.deal({ b: TIE1, c: TIE2, a: TIE3 })
  t.seen('b', { kind: 'bet', total: 40 })
  t.seen('c', { kind: 'call' })
  t.seen('a', { kind: 'call' })
  t.run({ type: 'start-next-round' })
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands(['c', 'a', 'b'], { c: TIE1, a: TIE2, b: TIE3 }) })
  t.seen('c', { kind: 'bet', total: 30 })
  t.seen('a', { kind: 'all-in' })
  t.seen('b', { kind: 'call' })
  const kinds = t.state.lockedPots.map((p) => `${p.kind}:${p.amount}:${p.isMain}:${[...p.eligible].sort().join('')}`)
  assert(JSON.stringify(kinds) === JSON.stringify(['ordinary:150:false:abc', 'allin:30:true:abc', 'allin:40:false:bc']), JSON.stringify(kinds))
  assert((t.state.round as { kind: string }).kind === 'allin-svara', 'all-in continuation first')
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'c'], { a: H34, b: TIE1, c: TIE2 }) })
  // Основна нова 30 → a; странична нова 40: b и c равни → 20 + 20.
  assert(t.stacks() === JSON.stringify({ a: 30, b: 290, c: 130 }) && t.state.lockedPots.length === 1 && t.state.lockedPots[0]!.kind === 'ordinary', t.stacks())
  t.run({ type: 'start-next-round' })
  assert((t.state.round as { kind: string; fee: number }).kind === 'svara-joining' && (t.state.round as { fee: number }).fee === 50, 'old pot continues as an ordinary Svara')
})

// ─── F. Свара с ол-ин ───────────────────────────────────────────────────────
console.log('\n=== F. Свара с ол-ин ===')

function allInFour(initial: Record<string, string>): Table {
  // a 320, b 100, c 190, d 190; после ол-ин b 90; c 115; d 135; a 135; c се отказва.
  const t = newTable(['a', 'b', 'c', 'd'], { dealerIndex: 3 }) // ред a, b, c, d
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 90 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  t.seen('d', { kind: 'fold' })
  assert(t.stacks() === JSON.stringify({ a: 320, b: 100, c: 190, d: 190 }), t.stacks())
  t.deal(initial) // дилър a; ред b, c, d, a
  t.seen('b', { kind: 'all-in' }) // 90
  t.seen('c', { kind: 'bet', total: 115 })
  t.seen('d', { kind: 'bet', total: 135 })
  t.seen('a', { kind: 'call' })
  t.act('c', { kind: 'fold' })
  return t
}

check('F1. обща нова ръка за правоимащите; основна и странична — отделно със същите карти; подялба 115 → 57 + 57, 1 чип изваден', () => {
  const t = allInFour({ b: TIE1, c: H34, d: TIE2, a: TIE3 })
  const record = t.state.history[t.state.history.length - 1]!
  const summary = record.pots.map((p) => `${p.amount}:${p.eligible.join('')}:${p.outcome.kind}`)
  assert(JSON.stringify(summary) === JSON.stringify(['400:bda:locked', '115:da:locked']), JSON.stringify(summary))
  assert((t.state.round as { kind: string }).kind === 'allin-svara', 'special Svara')
  const mainPot = t.state.lockedPots.find((p) => p.isMain)!
  const side = t.state.lockedPots.find((p) => !p.isMain)!
  assert(mainPot.kind === 'allin' && JSON.stringify(mainPot.eligible) === '["b","d","a"]' && JSON.stringify(side.eligible) === '["d","a"]', 'rights')
  // Без включване и без ново наддаване в специалния режим.
  expectError(() => t.run({ type: 'start-next-round' }), 'not-allowed', 'no other round')
  expectError(() => t.run({ type: 'svara-join', playerId: 'c' }), 'not-allowed', 'no joining')
  const removedBefore = t.state.removedChips
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'd'], { b: H34, d: TIE1, a: TIE2 }) })
  const step = t.state.history[t.state.history.length - 1]!
  assert(JSON.stringify(Object.keys(step.shownHands).sort()) === '["a","b","d"]', 'one common deal for b, d, a')
  const split = step.pots.find((p) => p.outcome.kind === 'split')!
  assert(split && (split.outcome as { share: number; removed: number }).share === 57 && (split.outcome as { removed: number }).removed === 1, JSON.stringify(step.pots))
  assert(t.state.removedChips === removedBefore + 1, 'burned 1')
  assert(t.state.ledger.some((e) => e.type === 'split-remainder-removed' && e.amount === 1 && e.to === 'removed'), 'burn in ledger')
  assert(t.state.round === null && t.state.lockedPots.length === 0, 'done')
  // a: 320−10−135+57 = 232; b: 400; c: 190−10−115 = 65; d: 190−10−135+57 = 102; изваден 1.
  assert(t.stacks() === JSON.stringify({ a: 232, b: 400, c: 65, d: 102 }), t.stacks())
  assert(total(t.state) + t.state.removedChips === 800, 'conservation')
})

check('F2. повторно равенство в основната: нови карти само за равните; страничната се разрешава веднъж', () => {
  const t = allInFour({ b: TIE1, c: H34, d: TIE2, a: TIE3 })
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'd'], { b: TIE1, d: LOW, a: TIE2 }) })
  // Основна: b и a равни (11) → продължава само между тях; странична: a (11) > d (10) → a.
  const step1 = t.state.history[t.state.history.length - 1]!
  assert(step1.pots.some((p) => !p.potId.includes('pot-0') && p.outcome.kind === 'awarded' && (p.outcome as { winner: string }).winner === 'a'), 'side to a')
  const mainPot = t.state.lockedPots.find((p) => p.isMain)!
  assert(JSON.stringify(mainPot.eligible) === '["b","a"]' && t.state.lockedPots.length === 1, JSON.stringify(t.state.lockedPots))
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b'], { a: H34, b: LOW }) })
  const step2 = t.state.history[t.state.history.length - 1]!
  assert(JSON.stringify(Object.keys(step2.shownHands).sort()) === '["a","b"]', 'd gets no cards in the repeat')
  assert(t.state.round === null && t.state.lockedPots.length === 0 && t.state.removedChips === 0, 'resolved without burn')
  assert(t.stacks() === JSON.stringify({ a: 175 + 115 + 400, b: 0, c: 65, d: 45 }), t.stacks())
  assert(t.state.status.b === 'eliminated', 'b eliminated')
})

check('F3. играч с по-малък ол-ин не печели над покритото ниво', () => {
  const t = allInFour({ b: TIE1, c: H34, d: TIE2, a: TIE3 })
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'd'], { b: H34, d: H27, a: LOW }) })
  assert(t.state.stacks.b === 400 && t.state.stacks.d === 45 + 115, `b only main 400; d side 115: ${t.stacks()}`)
})

// ─── G. Изход, отсъствие, пренос ────────────────────────────────────────────
console.log('\n=== G. изход, отсъствие, пренос ===')

check('G1. изход по време на раздаване: неизползваните чипове се изваждат, залозите остават, правата отпадат', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 30 })
  t.run({ type: 'exit', playerId: 'a' })
  assert(t.state.status.a === 'exited' && t.state.stacks.a === 0 && t.state.removedChips === 160, `${t.state.removedChips}`)
  assert(t.state.ledger.some((e) => e.type === 'exit-removed' && e.amount === 160 && e.playerId === 'a'), 'ledger')
  t.seen('b', { kind: 'bet', total: 40 })
  t.seen('c', { kind: 'call' })
  assert(t.state.round === null, 'settled')
  const record = t.state.history[t.state.history.length - 1]!
  assert(!record.pots.some((p) => p.eligible.includes('a')), 'exited player has no rights')
  assert(total(t.state) + t.state.removedChips === 600, 'conservation')
})

check('G2. изход на правоимащ от заключена Свара → единственият останал печели банката', () => {
  const t = tiedThree()
  t.run({ type: 'exit', playerId: 'b' })
  assert(t.state.lockedPots.length === 0 && t.state.stacks.a === 240, `${t.stacks()}`)
})

check('G3. банка без правоимащ се пренася като отделно салдо към основната банка на следващото обикновено раздаване', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: TIE1, b: TIE2, c: H34 })
  t.seen('a', { kind: 'bet', total: 20 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  t.run({ type: 'set-absent', playerId: 'b', absent: true })
  // b отсъства и Сварата изчаква; a излиза → остава само b → печели (един правоимащ).
  t.run({ type: 'exit', playerId: 'a' })
  assert(t.state.lockedPots.length === 0 && t.state.stacks.b === 240, t.stacks())
  // Пренос: заключена банка, чиито двама правоимащи излизат.
  const u = tiedThree()
  u.run({ type: 'set-absent', playerId: 'a', absent: true })
  u.run({ type: 'set-absent', playerId: 'b', absent: true })
  u.run({ type: 'exit', playerId: 'a' })
  assert(u.state.lockedPots.length === 0 && u.state.stacks.b === 240, 'b alone wins')
})

check('G4. пренос (банка без правоимащ) влиза в основната банка на следващото обикновено раздаване', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 30 }) // непокрит засега
  t.run({ type: 'exit', playerId: 'a' }) // a е единственият вносител над Входа → слоят остава без правоимащ
  t.seen('b', { kind: 'fold' })
  // Остава c: печели Входовете; слоят от 30 на a (само a, отказан) → пренос.
  assert(t.state.carried.length === 1 && t.state.carried[0]!.amount === 30, JSON.stringify(t.state.carried))
  t.deal({ b: H34, c: LOW })
  assert((t.state.round as { deadMoney: number }).deadMoney === 30 && t.state.carried.length === 0, 'carried into the next deal')
  t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'bet', total: 10 })
  t.seen((t.state.round as { betting: SvaraBettingState }).betting.toAct!, { kind: 'call' })
  const main = t.state.history[t.state.history.length - 1]!.pots[0]!
  assert(main.amount === 20 + 20 + 30 && (main.outcome as { winner: string }).winner === 'b', JSON.stringify(main))
})

check('G5. отсъстващият плаща Вход и автоматично отказва; няма доброволни действия; запазва правата си в Свара', () => {
  const t = tiedThree()
  t.run({ type: 'set-absent', playerId: 'a', absent: true })
  t.deal({})
  const round = t.state.round as { contributions: Record<string, number>; betting: SvaraBettingState }
  assert(round.contributions.a === 10 && round.betting.folded.includes('a'), 'paid and folded')
  expectError(() => t.run({ type: 'act', playerId: 'a', action: { kind: 'fold' } }), 'player-absent', 'no action')
  assert(t.state.lockedPots[0]!.eligible.includes('a'), 'keeps Svara rights')
})

check('G6. последен шанс (15 сек — модел): само при един активен играч; след това правата отпадат', () => {
  const t = tiedThree()
  t.run({ type: 'set-absent', playerId: 'a', absent: true })
  expectError(() => t.run({ type: 'absence-expired', playerId: 'a' }), 'not-allowed', 'two active players')
  t.run({ type: 'set-absent', playerId: 'c', absent: true })
  t.run({ type: 'absence-expired', playerId: 'a' })
  assert(t.state.lockedPots.length === 0 && t.state.stacks.b === 240, `b wins the locked pot: ${t.stacks()}`)
})

check('G7. случай №6: последният останал играч получава пренесените банки преди края; точен запис, без двойно изплащане', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 30 })
  t.run({ type: 'exit', playerId: 'a' })
  t.seen('b', { kind: 'fold' })
  assert(t.state.carried.length === 1 && t.state.carried[0]!.amount === 30 && t.stacks() === JSON.stringify({ a: 0, b: 190, c: 220 }), t.stacks())
  t.run({ type: 'exit', playerId: 'b' })
  assert(t.state.phase === 'finished' && t.state.winnerId === 'c' && t.state.carried.length === 0 && t.state.stacks.c === 250, `${t.state.phase} ${t.stacks()}`)
  const awards = t.state.ledger.filter((e) => e.from.startsWith('carried:'))
  const carryIn = t.state.ledger.filter((e) => e.to.startsWith('carried:'))
  assert(awards.length === 1 && awards[0]!.type === 'pot-award' && awards[0]!.amount === 30 && awards[0]!.playerId === 'c', JSON.stringify(awards))
  assert(carryIn.reduce((a, e) => a + e.amount, 0) === awards.reduce((a, e) => a + e.amount, 0), 'carried in = carried out')
  assert(total(t.state) + t.state.removedChips === t.state.totalChips && t.state.removedChips === 350, 'conservation')
  expectError(() => t.run({ type: 'start-next-round' }), 'wrong-phase', 'finished')
})

check('G8. случай №7: създателят напуска преди старта → масата се закрива, всички се освобождават, никакви чипове', () => {
  const t = new Table(createSvaraMatch({ tableId: 't', capacity: 3, entryFee: 1000, startMode: 'manual', creatorId: 'a' }))
  t.run({ type: 'join-seat', playerId: 'b' })
  t.run({ type: 'join-seat', playerId: 'c' })
  t.run({ type: 'leave-seat', playerId: 'b' }) // обикновен играч — масата остава
  assert(t.state.phase === 'lobby' && JSON.stringify(t.state.seats) === '["a","c"]', 'regular leave')
  t.run({ type: 'leave-seat', playerId: 'a' })
  assert(t.state.phase === 'closed' && t.state.seats.length === 0 && Object.keys(t.state.status).length === 0, 'closed and released')
  assert(t.state.ledger.length === 0 && t.state.totalChips === 0 && t.state.config.creatorId === 'a', 'no chips, no ownership transfer')
  for (const command of [{ type: 'join-seat', playerId: 'd' }, { type: 'start-match', playerId: 'a' }, { type: 'start-next-round' }] as const) {
    expectError(() => t.run(command), 'wrong-phase', command.type)
  }
  const auto = new Table(createSvaraMatch({ tableId: 't2', capacity: 2, entryFee: 1000, startMode: 'auto', creatorId: 'x' }))
  auto.run({ type: 'leave-seat', playerId: 'x' })
  assert(auto.state.phase === 'closed', 'auto table closes too')
})

// ─── H. Повторени команди и прекъсване ──────────────────────────────────────
console.log('\n=== H. повторени команди и прекъсване ===')

check('H1. повторена команда → същият резултат; различно съдържание → конфликт; отказана → не изразходва id', () => {
  const t = newTable(['a', 'b'], { dealerIndex: 1 })
  t.run({ type: 'start-next-round', commandId: 'r1' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b'], { a: H34, b: LOW }) })
  const snapshot = JSON.stringify(t.state)
  const again = applySvaraMatchCommand(t.state, { type: 'start-next-round', commandId: 'r1' }, { createDeck: () => buildSvaraDeckForHands(['a', 'b'], { a: LOW, b: H34 }) })
  assert(again.status === 'duplicate' && JSON.stringify(again.state) === snapshot, 'duplicate ignores env, no new deal')
  expectError(() => applySvaraMatchCommand(t.state, { type: 'look', commandId: 'r1', playerId: 'a' }), 'command-id-conflict', 'conflict')
  t.run({ type: 'look', playerId: 'a' })
  expectError(() => applySvaraMatchCommand(t.state, { type: 'act', commandId: 'x', playerId: 'a', action: { kind: 'bet', total: 5 } }), 'betting:below-minimum', 'rejected')
  const ok = applySvaraMatchCommand(t.state, { type: 'act', commandId: 'x', playerId: 'a', action: { kind: 'bet', total: 10 } })
  assert(ok.status === 'applied', 'same id accepted after a rejection')
})

check('H2. прекъсване: състоянието се сериализира и продължава; повторените команди след това са разпознати', () => {
  const t = newTable(['a', 'b', 'c'], { dealerIndex: 2 })
  t.deal({ a: H34, b: LOW, c: H27 })
  t.run({ type: 'look', playerId: 'a', commandId: 'look-a' })
  t.run({ type: 'act', playerId: 'a', action: { kind: 'bet', total: 20 }, commandId: 'bet-a' })
  const restored = JSON.parse(JSON.stringify(t.state)) as SvaraMatchState
  assertSvaraMatchInvariants(restored)
  const replay = applySvaraMatchCommand(restored, { type: 'act', commandId: 'bet-a', playerId: 'a', action: { kind: 'bet', total: 20 } })
  assert(replay.status === 'duplicate' && replay.state.stacks.a === 170, 'no double bet after restore')
  const t2 = new Table(restored, 'resumed-')
  t2.seen('b', { kind: 'call' })
  t2.seen('c', { kind: 'fold' })
  assert(t2.state.round === null && t2.state.stacks.a === 170 + 30 + 40, t2.stacks())
})

check('H2b. възстановяване по средата на Свара с ол-ин: повторената команда не дели банката втори път', () => {
  const t = allInFour({ b: TIE1, c: H34, d: TIE2, a: TIE3 })
  const advance = { type: 'advance-allin-svara', commandId: 'adv-1' } as const
  const env = { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'd'], { b: H34, d: TIE1, a: TIE2 }) }
  const first = applySvaraMatchCommand(t.state, advance, env)
  const restored = JSON.parse(JSON.stringify(first.state)) as SvaraMatchState
  assertSvaraMatchInvariants(restored)
  const again = applySvaraMatchCommand(restored, advance, { createDeck: () => buildSvaraDeckForHands(['a', 'b', 'd'], { b: LOW, d: H34, a: H27 }) })
  assert(again.status === 'duplicate' && JSON.stringify(again.state.stacks) === JSON.stringify(first.state.stacks), 'no second split')
  assert(again.state.removedChips === 1 && again.state.ledger.length === first.state.ledger.length, 'burn recorded once')
})

check('H3. изгледът на играча: собствените карти само след поглеждане; чужди карти не се виждат', () => {
  const t = newTable(['a', 'b'], { dealerIndex: 1 })
  t.deal({ a: H34, b: LOW })
  const before = createSvaraMatchPlayerView(t.state, 'a')
  assert(before.ownCards === null && !JSON.stringify(before).includes('7S'), 'hidden before look')
  t.look('a')
  const after = createSvaraMatchPlayerView(t.state, 'a')
  assert(JSON.stringify(after.ownCards) === JSON.stringify(H34.split(' ')), 'own cards after look')
  const other = createSvaraMatchPlayerView(t.state, 'b')
  for (const code of H34.split(' ')) assert(!JSON.stringify(other).includes(`"${code}"`), `b sees ${code}`)
})

// ─── I. Случайни мачове ─────────────────────────────────────────────────────
console.log('\n=== I. случайни мачове ===')

check('I1. 300 случайни мача (с отсъствия/изходи): инвариант след всяка команда; всяко обикновено раздаване = еталон „чип по чип“ и = 2Б.2А (svaraChips)', () => {
  const random = createSeededSvaraRandomSourceForTests(2026101503)
  const pick = (n: number) => random.nextInt(n)
  let rounds = 0
  let ordinaryChecked = 0
  let chipsCrossChecked = 0
  let svaras = 0
  let allins = 0
  let refusals = 0
  let finished = 0
  let absences = 0
  let exits = 0
  for (let m = 0; m < 300; m += 1) {
    const players = ['p0', 'p1', 'p2', 'p3'].slice(0, 2 + pick(3))
    const t = new Table(createSvaraMatch({ tableId: `m${m}`, capacity: players.length as 2 | 3 | 4, entryFee: 10 * (10 + pick(40)), entryPercent: ([1, 2, 3, 5] as const)[pick(4)], startMode: 'auto', creatorId: players[0]! }))
    const env: SvaraMatchEnv = { random }
    for (const id of players.slice(1)) t.run({ type: 'join-seat', playerId: id }, env)
    let guard = 0
    while (t.state.phase === 'in-progress' && guard < 500) {
      guard += 1
      const s = t.state
      const round = s.round
      const alive = s.seats.filter((id) => s.status[id] === 'active' || s.status[id] === 'absent')
      try {
        // Случайни събития: отсъствие/завръщане и (рядко) доброволен изход.
        const roll = pick(60)
        if (roll === 0 && alive.length > 0) {
          const id = alive[pick(alive.length)]!
          t.run({ type: 'set-absent', playerId: id, absent: s.status[id] === 'active' }, env)
          absences += 1
          continue
        }
        if (roll === 1 && alive.length > 2 && pick(4) === 0) {
          t.run({ type: 'exit', playerId: alive[pick(alive.length)]! }, env)
          exits += 1
          continue
        }
        // Последен шанс: когато остане един активен.
        const absentIds = s.seats.filter((id) => s.status[id] === 'absent')
        if (absentIds.length > 0 && s.seats.filter((id) => s.status[id] === 'active').length === 1 && pick(3) === 0) {
          t.run({ type: 'absence-expired', playerId: absentIds[pick(absentIds.length)]! }, env)
          continue
        }
        if (!round) {
          try {
            t.run({ type: 'start-next-round' }, env)
            rounds += 1
          } catch (error) {
            if (error instanceof SvaraMatchError && error.code === 'no-round-available' && absentIds.length > 0) {
              t.run({ type: 'set-absent', playerId: absentIds[0]!, absent: false }, env) // връщане, за да продължи
              continue
            }
            throw error
          }
        } else if (round.kind === 'svara-joining') {
          const pot = s.lockedPots.find((p) => p.potId === round.potId)!
          const absentHolder = pot.eligible.find((id) => s.status[id] === 'absent')
          if (absentHolder) {
            t.run({ type: 'set-absent', playerId: absentHolder, absent: false }, env)
            continue
          }
          const candidates = s.seats.filter((id) => s.status[id] === 'active' && !pot.eligible.includes(id) && s.stacks[id]! >= round.fee)
          if (candidates.length > 0 && pick(2) === 0) t.run({ type: 'svara-join', playerId: candidates[pick(candidates.length)]! }, env)
          else { t.run({ type: 'svara-start' }, env); svaras += 1 }
        } else if (round.kind === 'allin-svara') {
          t.run({ type: 'advance-allin-svara' }, env)
          allins += 1
        } else {
          const actor = round.betting.toAct!
          if (s.status[actor] === 'absent') {
            // Сварата изчаква отсъстващия (случай №5) — връщаме го.
            t.run({ type: 'set-absent', playerId: actor, absent: false }, env)
            continue
          }
          if (pick(3) === 0 && !round.betting.looked.includes(actor)) t.run({ type: 'look', playerId: actor }, env)
          const options = describeSvaraMatchOptions(t.state, actor)!
          if (options.lookRequired && !options.blindBet && options.call === null && options.allIn === null) {
            t.run({ type: 'look', playerId: actor }, env)
            continue
          }
          const choices: SvaraBettingAction[] = []
          if (options.fold && pick(4) === 0) choices.push({ kind: 'fold' })
          if (options.noBet) choices.push({ kind: 'no-bet' })
          if (options.call !== null) choices.push({ kind: 'call' })
          if (options.bet) choices.push({ kind: 'bet', total: options.bet.min + pick(Math.min(3, options.bet.max - options.bet.min + 1)) })
          if (options.blindBet) choices.push({ kind: 'blind-bet', total: options.blindBet.min })
          if (options.allIn !== null && pick(3) === 0) choices.push({ kind: 'all-in' })
          if (choices.length === 0) choices.push({ kind: 'fold' })
          const action = choices[pick(choices.length)]!
          const historyBefore = t.state.history.length
          t.run({ type: 'act', playerId: actor, action }, env)
          for (const record of t.state.history.slice(historyBefore)) {
            if (record.kind !== 'ordinary') continue
            verifyOrdinaryAgainstReference(t.state, record.roundId)
            ordinaryChecked += 1
            if (crossCheckWithChipTable(t.state, record.roundId)) chipsCrossChecked += 1
          }
        }
      } catch (error) {
        if (error instanceof SvaraMatchError && error.code === 'betting:rule-not-implemented') {
          refusals += 1
          break
        }
        throw error
      }
    }
    if (t.state.phase === 'finished') {
      finished += 1
      assert(t.state.carried.length === 0 && t.state.lockedPots.length === 0, 'finished with open pots')
      assert(total(t.state) + t.state.removedChips === t.state.totalChips, 'final conservation')
    }
  }
  console.log(`      рундове ${rounds}, обикновени сверени ${ordinaryChecked} (от тях с 2Б.2А ${chipsCrossChecked}), Свари ${svaras}, ол-ин Свари ${allins}, отсъствия ${absences}, изходи ${exits}, завършени ${finished}, спрени на неуточнен подслучай ${refusals}`)
  assert(ordinaryChecked > 1500 && chipsCrossChecked > 1000 && svaras > 50 && allins > 10 && finished > 150, 'coverage')
})

/**
 * Кръстосана проверка: същото раздаване, подадено на модула от 2Б.2А
 * (svaraChips), трябва да даде същите присъждания, връщания и заключени суми.
 * Пропуска раздавания с пренесени/осиротели банки (2Б.2А ги отказва по замисъл).
 */
function crossCheckWithChipTable(state: SvaraMatchState, roundId: string): boolean {
  const record = state.history.find((r) => r.roundId === roundId)!
  const entries = state.ledger.filter((e) => e.roundId === roundId)
  if (entries.some((e) => e.type === 'carry-in' || e.type === 'pot-carry')) return false
  const participants = record.participants
  const maxContribution = Math.max(...participants.map((id) => record.contributions[id] ?? 0))
  let chips = createSvaraChipTable({ tableId: 'x', entryFee: 10 * (maxContribution + 1), playerIds: participants })
  let seq = 0
  const apply = (command: Record<string, unknown>) => {
    chips = applySvaraChipCommand(chips, { ...command, commandId: `x${(seq += 1)}` } as never).state
  }
  apply({ type: 'begin-deal', dealId: 'd', participants })
  for (const id of participants) {
    if ((record.contributions[id] ?? 0) > 0) apply({ type: 'contribute', playerId: id, amount: record.contributions[id], reason: 'bet' })
  }
  for (const id of record.folded) apply({ type: 'fold', playerId: id })
  apply({ type: 'settle-deal', hands: record.shownHands })
  const sum = (list: Array<{ type: string; amount: number; playerId: string | null }>, type: string) => {
    const out: Record<string, number> = {}
    for (const e of list) if (e.type === type && e.playerId) out[e.playerId] = (out[e.playerId] ?? 0) + e.amount
    return JSON.stringify(Object.entries(out).sort())
  }
  const chipEntries = chips.ledger.filter((e) => e.dealId === 'd')
  const locked = (list: Array<{ type: string; amount: number }>) => list.filter((e) => e.type === 'pot-lock').reduce((a, e) => a + e.amount, 0)
  if (sum(entries, 'pot-award') !== sum(chipEntries, 'pot-award') || sum(entries, 'uncalled-return') !== sum(chipEntries, 'uncalled-return') || locked(entries) !== locked(chipEntries)) {
    throw new Error(`${roundId}: match ≠ 2B.2A chips: awards ${sum(entries, 'pot-award')} vs ${sum(chipEntries, 'pot-award')}; uncalled ${sum(entries, 'uncalled-return')} vs ${sum(chipEntries, 'uncalled-return')}; locked ${locked(entries)} vs ${locked(chipEntries)}`)
  }
  return true
}

/** Независим еталон: всяка единица от вноските е малка банка (вкл. мъртвите пари в първата). */
function verifyOrdinaryAgainstReference(state: SvaraMatchState, roundId: string): void {
  const record = state.history.find((r) => r.roundId === roundId)!
  const entries = state.ledger.filter((e) => e.roundId === roundId)
  const deadMoney = entries.filter((e) => e.type === 'carry-in').reduce((a, e) => a + e.amount, 0)
  const contributions = record.contributions
  const folded = new Set(record.folded)
  const participants = record.participants
  const max = Math.max(0, ...participants.map((id) => contributions[id] ?? 0))
  const expectedCredit: Record<string, number> = {}
  const expectedUncalled: Record<string, number> = {}
  let expectedLocked = 0
  let expectedCarried = 0
  for (let k = 1; k <= max; k += 1) {
    const payers = participants.filter((id) => (contributions[id] ?? 0) >= k)
    const eligible = payers.filter((id) => !folded.has(id))
    const amount = payers.length + (k === 1 ? deadMoney : 0)
    if (eligible.length === 0) { expectedCarried += amount; continue }
    if (payers.length === 1) { expectedUncalled[payers[0]!] = (expectedUncalled[payers[0]!] ?? 0) + amount; continue }
    const top = Math.max(...eligible.map((id) => record.points[id] ?? -1))
    const best = eligible.length === 1 ? eligible : eligible.filter((id) => record.points[id] === top)
    if (best.length === 1) expectedCredit[best[0]!] = (expectedCredit[best[0]!] ?? 0) + amount
    else expectedLocked += amount
  }
  const actualCredit: Record<string, number> = {}
  const actualUncalled: Record<string, number> = {}
  let actualLocked = 0
  let actualCarried = 0
  for (const e of entries) {
    if (e.type === 'pot-award') actualCredit[e.playerId!] = (actualCredit[e.playerId!] ?? 0) + e.amount
    if (e.type === 'uncalled-return') actualUncalled[e.playerId!] = (actualUncalled[e.playerId!] ?? 0) + e.amount
    if (e.type === 'pot-lock') actualLocked += e.amount
    if (e.type === 'pot-carry') actualCarried += e.amount
  }
  const norm = (o: Record<string, number>) => JSON.stringify(Object.entries(o).filter(([, v]) => v > 0).sort())
  if (norm(actualCredit) !== norm(expectedCredit) || norm(actualUncalled) !== norm(expectedUncalled) || actualLocked !== expectedLocked || actualCarried !== expectedCarried) {
    throw new Error(`${roundId}: credit ${norm(actualCredit)} vs ${norm(expectedCredit)}; uncalled ${norm(actualUncalled)} vs ${norm(expectedUncalled)}; locked ${actualLocked} vs ${expectedLocked}; carried ${actualCarried} vs ${expectedCarried}`)
  }
}

// ─── J. Изолация ────────────────────────────────────────────────────────────
console.log('\n=== J. изолация ===')

check('J1. новите модули импортират само собствени модули на двигателя', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'engine')
  for (const file of ['svaraBetting.ts', 'svaraMatch.ts']) {
    for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/from '([^']+)'/g)) {
      assert(/^\.\/svara[A-Za-z]+\.js$/.test(match[1]!), `${file} imports ${match[1]}`)
    }
  }
})

void createShuffledSvaraDeck
console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

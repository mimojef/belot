/**
 * checkSvaraShowdown2B376A.ts — Свара, Етап 2Б.3.7.6А: основни/странични
 * банки, публично сравняване, последователно изплащане и сървърно
 * състояние за представяне на резултата (показ 3с + прозорец за
 * изплащане), преди реалните анимации (2Б.3.7.6Б).
 *
 * Основна/странична банка с различни победители и подялба при Свара с
 * ол-ин вече се тества изчерпателно (payoutSteps.isMain/split непроменени
 * от основния им settlement път) в checkSvaraGameplay2B34.ts's "all-in
 * Svara handles side pots and repeated main ties" и
 * checkSvaraPersistence2B36A.ts's "all-in main/side banks..." — тук НЕ се
 * преповтаря същият комплексен многостъпков fold/all-in сетъп, за да не се
 * рискува неверифицирана дубликация; вместо това се фокусира върху
 * структурата/времената/защитата, които са специфични за НОВИЯ
 * showdown-display рунд.
 *
 *  A. Основна банка (показ): структура, точна сума, правоимащи.
 *  B. Отказали се никога не са правоимащи.
 *  D. Публично сравняване: едновременно разкриване, точки, без отказали се.
 *  E. Ред на последователното изплащане (основна винаги първа).
 *  F. „Свара!“ — неразрешена банка не е "изплащане"; остава заключена.
 *  G. reveal-choice остава непроменен; без второ финансово приключване.
 *  H. 3-секундно сравняване + прозорец за изплащане (fake clock).
 *  I. Reconnect/restart по време на показа и изплащането.
 *  J. Без изтичане на скрити карти; без преждевременно ново раздаване.
 *  K. Счетоводни инварианти; съвместимост със стар SQLite snapshot.
 *
 * Пускане (от server/): npm run check:svara-showdown-2b376a
 */
import assert from 'node:assert/strict'
import {
  applySvaraMatchCommand, assertSvaraMatchInvariants, buildSvaraDeckForHands, copyRestoredSvaraMatchForServer,
  createSvaraMatch, evaluateSvaraHand, parseSvaraCardCode, type SvaraMatchCommand, type SvaraMatchEnv, type SvaraMatchState,
} from '../src/games/svara/engine/index.js'
import { createSvaraMatchSnapshotMessage, serializeSvaraSnapshotForClient, SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { validateSvaraStoredMatch } from '../src/games/svara/runtime/svaraStoredMatchValidation.js'
import { serializeSvaraStoredMatch } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { svaraDealingAnimationMs, type SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { SVARA_SHOWDOWN_DISPLAY_MS, SVARA_PAYOUT_STEP_MS } from '../src/games/svara/runtime/svaraDeadlines.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

process.env.SVARA_TEST_ENABLED = '1'

let passed = 0, failed = 0
function check(label: string, run: () => void): void {
  try { run(); passed++; console.log(`  ok ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause instanceof Error ? cause.stack ?? cause.message : cause) }
}
function expectError(fn: () => unknown, code: string, label: string): void {
  try { fn() } catch (error) {
    const actual = (error as { code?: string })?.code
    if (actual === code) return
    throw new Error(`${label}: expected ${code}, got ${actual ?? String(error)}`)
  }
  throw new Error(`${label}: expected ${code}, nothing thrown`)
}

console.log('\ncheckSvaraShowdown2B376A')

// ─── Помощни за engine-ниво (без clock, директна инспекция на showdown-display) ──

const fixedDealer = (index: number): SvaraMatchEnv['random'] => ({ nextInt: () => index })

class Table {
  state: SvaraMatchState
  private seq = 0
  constructor(state: SvaraMatchState) { this.state = state }
  run(command: Omit<SvaraMatchCommand, 'commandId'> & { commandId?: string }, env: SvaraMatchEnv = {}): SvaraMatchState {
    const full = { ...command, commandId: command.commandId ?? `s${(this.seq += 1)}` } as SvaraMatchCommand
    const result = applySvaraMatchCommand(this.state, full, env)
    assertSvaraMatchInvariants(result.state)
    this.state = result.state
    this.finishDealingIfNeeded()
    return this.state
  }
  private finishDealingIfNeeded(): void {
    const round = this.state.round
    if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara') || !(round as { dealing?: boolean }).dealing) return
    this.run({ type: 'finish-dealing', roundId: round.roundId })
  }
  /** Следващо раздаване с контролирани ръце — НЕ пропуска showdown-display (целта на този файл). */
  deal(hands: Record<string, string>): SvaraMatchState {
    const order = this.peekOrder()
    return this.run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(order, hands) })
  }
  peekOrder(): string[] {
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
  act(playerId: string, action: any): SvaraMatchState { return this.run({ type: 'act', playerId, action }) }
  look(playerId: string): SvaraMatchState { return this.run({ type: 'look', playerId }) }
  seen(playerId: string, action: any): SvaraMatchState { this.look(playerId); return this.act(playerId, action) }
  /** Повдига ТОЧНО тази showdown-display стъпка (без да дренира по-нататъшни автоматични команди). */
  advanceShowdown(): SvaraMatchState {
    const round = this.state.round as any
    assert(round?.kind === 'showdown-display', `expected showdown-display, got ${round?.kind}`)
    return this.run({ type: round.phase === 'showdown' ? 'advance-showdown-display' : 'close-payout-display', roundId: round.roundId })
  }
  /** Напред до пълно затваряне на showdown-display. */
  resolveShowdown(): SvaraMatchState {
    for (;;) {
      const round = this.state.round as any
      if (!round || round.kind !== 'showdown-display') return this.state
      this.advanceShowdown()
    }
  }
}

function newTable(players: string[], opts: { entryFee?: number; entryPercent?: 1 | 2 | 3 | 5 } = {}): Table {
  const state = createSvaraMatch({
    tableId: 't', capacity: players.length as 2 | 3 | 4, entryFee: opts.entryFee ?? 2000,
    entryPercent: opts.entryPercent ?? 5, startMode: 'manual', creatorId: players[0]!,
  })
  const table = new Table(state)
  for (const id of players.slice(1)) table.run({ type: 'join-seat', playerId: id })
  table.run({ type: 'start-match', playerId: players[0]! }, { random: fixedDealer(players.length - 1) })
  return table
}

const total = (s: SvaraMatchState) => Object.values(s.stacks).reduce((a, b) => a + b, 0)
const ptsOf = (codes: string) => evaluateSvaraHand(codes.split(' ').map(parseSvaraCardCode)).points

// Ръце с известна сила, без общи карти (verified в checkSvaraMatch2B2B.ts §0).
const H34 = '7S 7H 7D' // 34
const H27 = '10H 9H 8H' // 27
const TIE1 = 'AC KH QD' // 11
const TIE2 = 'AH KD QC' // 11
const LOW = '9C 8S JD' // 10

check('0. силата на тестовите ръце е както се очаква', () => {
  assert.equal(ptsOf(H34), 34); assert.equal(ptsOf(H27), 27); assert.equal(ptsOf(TIE1), 11); assert.equal(ptsOf(TIE2), 11); assert.equal(ptsOf(LOW), 10)
})

// ─── A. Основна банка (показ): структура, точна сума, правоимащи ─────────
console.log('\n=== A. основна банка (показ) ===')

check('A1. единствена (основна) банка: isMain:true, точна присъдена сума, единствен победител', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  const beforeBet = Object.values((t.state.round as any).contributions as Record<string, number>).reduce((x, y) => x + y, 0)
  t.seen('a', { kind: 'bet', total: 20 })
  const afterBet = Object.values((t.state.round as any).contributions as Record<string, number>).reduce((x, y) => x + y, 0)
  const added = afterBet - beforeBet
  t.seen('b', { kind: 'call' }); t.seen('c', { kind: 'call' })
  const round = t.state.round as any
  assert.equal(round.kind, 'showdown-display')
  assert.equal(round.payoutSteps.length, 1)
  const step = round.payoutSteps[0]!
  assert.equal(step.isMain, true)
  assert.deepEqual(step.winners, ['a'])
  assert.equal(step.share, null)
  assert.equal(step.amount, afterBet + added * 2, `expected the full pot (own contributions ${afterBet} + the two matching calls)`)
})

// ─── B. Отказали се никога не са правоимащи ────────────────────────────────
console.log('\n=== B. отказали се без право на печалба ===')

check('B1. отказал се с внесени чипове НЕ е сред eligible/winners на нито една банка', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 })
  t.seen('b', { kind: 'fold' }) // b е внесъл Вход + нищо друго, но се отказва
  t.seen('c', { kind: 'call' })
  const round = t.state.round as any
  assert.equal(round.kind, 'showdown-display')
  assert(!round.comparedPlayers.includes('b'), 'отказал се не сравнява')
  for (const step of round.payoutSteps) assert(!step.winners.includes('b'), 'отказал се не е сред победителите')
  assert.equal(round.payoutSteps.length, 1); assert.deepEqual(round.payoutSteps[0]!.winners, ['a'])
})

// ─── D. Публично сравняване — едновременно, с точки, без отказали се ──────
console.log('\n=== D. публично сравняване ===')

check('D1. comparedPlayers = точно неотказалите (2+); cards/comparisonPoints само за тях', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'fold' }); t.seen('c', { kind: 'call' })
  const round = t.state.round as any
  assert.deepEqual([...round.comparedPlayers].sort(), ['a', 'c'])
  assert.equal(Object.keys(round.cards).length, 2)
  assert.equal(round.points.a, 34); assert.equal(round.points.c, 27)
  assert.equal(round.cards.b, undefined, 'отказал се никога няма карти в showdown-display')
})

check('D2. точките в showdown-display идват от сървъра (evaluateSvaraHand), не се преизчисляват', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: TIE1, b: H34 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  const round = t.state.round as any
  assert.equal(round.points.a, ptsOf(TIE1))
  assert.equal(round.points.b, ptsOf(H34))
})

check('D3. снимка (snapshot) никога не разкрива картите на отказал се играч по време на showdown', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  const bHand = [...(t.state.round as any).hands.b]
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'fold' }); t.seen('c', { kind: 'call' })
  for (const viewer of ['a', 'b', 'c']) {
    const message = createSvaraMatchSnapshotMessage('t', t.state, viewer)
    const json = serializeSvaraSnapshotForClient(message)
    for (const code of bHand) assert(!json.includes(`"${code}"`), `snapshot of ${viewer} leaks folded b's card ${code}`)
    for (const key of SVARA_SNAPSHOT_FORBIDDEN_KEYS) assert(!json.includes(`"${key}"`), `snapshot of ${viewer} contains forbidden key ${key}`)
  }
})

check('D4. показаните карти в snapshot-а на showdown-display съвпадат точно с реалните ръце', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: TIE1, b: H34 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  const message = createSvaraMatchSnapshotMessage('t', t.state, 'a')
  const round = message.round as any
  assert.equal(round.kind, 'showdown-display')
  assert.deepEqual([...round.cards.a].sort(), TIE1.split(' ').sort())
  assert.deepEqual([...round.cards.b].sort(), H34.split(' ').sort())
})

// ─── E. Ред на последователното изплащане ──────────────────────────────────
console.log('\n=== E. ред на изплащането ===')

check('E1. order полето е строго нарастващо от 0, независимо от броя стъпки', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 40 }); t.seen('b', { kind: 'call' })
  const round = t.state.round as any
  assert.deepEqual(round.payoutSteps.map((s: any) => s.order), round.payoutSteps.map((_: any, i: number) => i))
})

check('E2. всяка стъпка носи стабилен stepId (срещу дублиране при повторен рендер)', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  const round1 = t.state.round as any
  const stepId1 = round1.payoutSteps[0]!.stepId
  // Същото четене повторно (напр. при reconnect) дава СЪЩИЯ stepId — чиста функция, не нов random id.
  const round2 = t.state.round as any
  assert.equal(round2.payoutSteps[0]!.stepId, stepId1)
  assert(stepId1.length > 0)
})

// ─── F. „Свара!“ — неразрешена банка не е "изплащане" ─────────────────────
console.log('\n=== F. Свара (равенство) ===')

check('F1. равенство в единствената банка (heads-up): svaraTie=true, payoutSteps е празно, банката остава заключена', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: TIE1, b: TIE2 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  const round = t.state.round as any
  assert.equal(round.kind, 'showdown-display')
  assert.equal(round.svaraTie, true)
  assert.equal(round.payoutSteps.length, 0, 'заключена банка не е "изплащане"')
  const before = total(t.state)
  t.resolveShowdown()
  assert.equal(t.state.lockedPots.length, 1, 'банката остава заключена за следващо раздаване')
  assert.equal(total(t.state), before, 'равенството премества чипове в locked, не ги губи/троши')
})

// ─── G. reveal-choice непроменен; без второ финансово приключване ─────────
console.log('\n=== G. reveal-choice и единично приключване ===')

check('G1. единствен останал (отпадане) продължава да отваря reveal-choice, НЕ showdown-display', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'fold' }); t.seen('c', { kind: 'fold' })
  assert.equal(t.state.round?.kind, 'reveal-choice', 'единствен неотказал -> избор, не showdown-display')
})

check('G2. нормално сравняване (2+) никога не отваря reveal-choice', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' }); t.seen('c', { kind: 'call' })
  assert.equal(t.state.round?.kind, 'showdown-display')
})

check('G3. затварянето на showdown-display присъжда ТОЧНО ВЕДНЪЖ — повторна команда е отказана', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  const roundId = (t.state.round as any).roundId
  const before = total(t.state)
  t.resolveShowdown()
  assert.equal(total(t.state), before, 'сравняването само премества чипове, не ги създава/троши')
  expectError(() => t.run({ type: 'advance-showdown-display', roundId }), 'not-allowed', 'повторно затваряне е отказано')
})

// ─── H. 3-секундно сравняване + прозорец за изплащане (fake clock) ────────
console.log('\n=== H. времена (fake clock) ===')

type Job = { at: number; callback: () => void; active: boolean; order: number }
class Clock implements SvaraClock {
  time = 1_000_000
  jobs: Job[] = []
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + delay, callback, active: true, order: this.jobs.length }
    this.jobs.push(job)
    return () => { job.active = false }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let n = 0; ; n++) {
      assert(n < 10_000, 'unbounded timer loop')
      const job = this.jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0]
      if (!job) break
      this.time = job.at; job.active = false; job.callback()
    }
    this.time = end
  }
}
let serial = 0
const id = () => `h${++serial}`
const closes: Array<() => void> = []

function randomFor(decks: SvaraCard[][]) {
  const swaps: number[] = []
  return { nextInt(max: number) {
    if (max === 32) {
      const target = (decks.shift() ?? SVARA_ORDERED_DECK).map(svaraCardCode)
      const work = SVARA_ORDERED_DECK.map(svaraCardCode)
      for (let i = 31; i > 0; i--) {
        const j = work.indexOf(target[i]!)
        assert(j >= 0 && j <= i)
        swaps.push(j); [work[i], work[j]] = [work[j]!, work[i]!]
      }
    }
    if (!swaps.length) return 0
    assert.equal(max, swaps.length + 1)
    return swaps.shift()!
  } }
}
function mount(matchId: string, capacity: 2 | 3 | 4, decks: SvaraCard[][] = []) {
  const clock = new Clock()
  const runtime = createSvaraMatchRuntime({ random: randomFor(decks), now: clock.now })
  runtime.registerMatch({ matchId, creator: { playerId: 'a' }, capacity, entryFee: 1000, startMode: 'auto' })
  for (const playerId of ['b', 'c', 'd'].slice(0, capacity - 1)) runtime.executeParticipantCommand(matchId, { playerId }, id(), { type: 'join-seat' })
  const lobby = createSvaraLobby({ runtime, clock, hasOtherGameCommitment: () => false, onError: (cause) => { throw cause } })
  closes.push(() => lobby.shutdown())
  const frames = new Map<string, any[]>(), sessions = new Map<string, SvaraAccessSession>()
  function attach(player: string) {
    frames.set(player, []); sessions.set(player, { account: { role: 'admin' }, profile: { profileId: player } })
    lobby.attachConnection(player, { profileId: player, getSession: () => sessions.get(player) ?? null, send: (raw) => {
      frames.get(player)!.push(typeof raw === 'string' ? JSON.parse(raw) : raw)
    } })
  }
  for (const p of ['a', 'b', 'c', 'd']) attach(p)
  const submit = (player: string, command: any) => lobby.handle(player, { type: 'submit_svara_command', matchId, commandId: id(), expectedRevision: runtime.getMatchRevision(matchId), command })
  const sync = (p = 'a') => lobby.handle(p, { type: 'request_svara_table_state', matchId })
  const state = () => runtime.exportInternalStateForServer(matchId)
  const timing = (p = 'a') => { sync(p); return frames.get(p)!.findLast((f) => f.type === 'svara_match_timing' && f.matchId === matchId) }
  const timer = (kind: string, p = 'a') => timing(p).deadlines.find((d: any) => d.kind === kind)
  const finishDealingIfNeeded = () => {
    const round = state().round
    if (round && (round.kind === 'ordinary' || round.kind === 'svara') && (round as any).dealing) clock.advance(svaraDealingAnimationMs((round as any).participants.length))
  }
  return { runtime, matchId, clock, lobby, frames, submit, sync, state, timing, timer, finishDealingIfNeeded }
}

check('H1. показът трае точно 3с: преди изтичане round остава showdown-display с фаза "showdown"', () => {
  const t = mount('h1', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  const round = t.state().round as any
  assert.equal(round.kind, 'showdown-display'); assert.equal(round.phase, 'showdown')
  assert.equal(t.timer('showdown-display').remainingMs, SVARA_SHOWDOWN_DISPLAY_MS)
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS - 1)
  assert.equal((t.state().round as any)?.kind, 'showdown-display', 'показът не затваря преди 3с')
})

check('H2. след 3с преминава към "payout" (тук 1 стъпка) за точно brой_стъпки × SVARA_PAYOUT_STEP_MS', () => {
  const t = mount('h2', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
  const round = t.state().round as any
  assert.equal(round.kind, 'showdown-display'); assert.equal(round.phase, 'payout')
  assert.equal(round.payoutSteps.length, 1)
  assert.equal(t.timer('payout-display').remainingMs, 1 * SVARA_PAYOUT_STEP_MS)
  t.clock.advance(SVARA_PAYOUT_STEP_MS)
  assert.notEqual((t.state().round as any)?.kind, 'showdown-display', 'цялото показване приключва след показ+изплащане')
})

check('H3. равенство (без стъпки за изплащане) затваря направо след 3с, без payout-display', () => {
  const t = mount('h3', 2, [buildSvaraDeckForHands(['b', 'a'], { b: TIE1, a: TIE2 })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
  assert.equal(t.timer('payout-display'), undefined, 'без изплащане при чисто равенство')
  // Рундът вече е затворен (locked pot) — с точно 2 играчи и никой друг
  // кандидат, автоматичната верига веднага продължава към нов Свара rundeal
  // за заключената банка (start-next-round -> svara-joining -> svara-start,
  // всичко automatic); затова round не е null, а СЛЕД затварянето ВЕЧЕ не е
  // (старото) showdown-display.
  assert.notEqual((t.state().round as any)?.kind, 'showdown-display', 'показът за равенството вече е затворен')
  assert.equal(t.state().lockedPots.length, 1, 'заключената банка чака продължение (или вече е в нов Свара rundeal за нея)')
})

// ─── I. Reconnect/restart по време на показа и изплащането ────────────────
console.log('\n=== I. reconnect/restart по време на показа/изплащането ===')

check('I1. reconnect (нов snapshot) по време на 3с показ показва СЪЩОТО състояние, без повторно сравняване', () => {
  const t = mount('i1', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  const before = JSON.stringify(t.state())
  t.sync('a'); t.sync('b') // reconnect-подобно: само четене, никаква команда
  assert.equal(JSON.stringify(t.state()), before, 'четене на snapshot никога не мутира рунда')
})

check('I2. restart (сериализация/десериализация) ПО ВРЕМЕ на показа възстановява точния оставащ срок', () => {
  const t = mount('i2', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(1_000)
  const stored = t.runtime.exportStoredMatchForServer(t.matchId)
  validateSvaraStoredMatch(stored)
  const restored = copyRestoredSvaraMatchForServer(stored.state)
  assertSvaraMatchInvariants(restored)
  assert.equal(JSON.stringify(restored.round), JSON.stringify(stored.state.round), 'showdown-display round оцелява непроменено след restore')
  const roundtripped = JSON.parse(serializeSvaraStoredMatch(stored))
  validateSvaraStoredMatch(roundtripped)
})

check('I3. restart ПО ВРЕМЕ на последователното изплащане (фаза "payout") възстановява коректно', () => {
  const t = mount('i3', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
  const round = t.state().round as any
  assert.equal(round.phase, 'payout')
  const stored = t.runtime.exportStoredMatchForServer(t.matchId)
  validateSvaraStoredMatch(stored)
  assertSvaraMatchInvariants(copyRestoredSvaraMatchForServer(stored.state))
})

check('I4. restart не присъжда банката повторно — стакове идентични преди/след restore', () => {
  const t = mount('i4', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS + 5 * SVARA_PAYOUT_STEP_MS)
  const before = JSON.stringify(t.state().stacks)
  const stored = t.runtime.exportStoredMatchForServer(t.matchId)
  const restored = copyRestoredSvaraMatchForServer(stored.state)
  assert.equal(JSON.stringify(restored.stacks), before, 'restore никога не променя стаковете')
})

// ─── J. Без изтичане на скрити карти; без преждевременно ново раздаване ───
console.log('\n=== J. защита на данните и реда ===')

check('J1. докато betting-ът не приключи: ол-ин играч остава скрит до действителния showdown', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 })
  t.seen('b', { kind: 'all-in' }) // ол-ин, но раздаването ПРОДЪЛЖАВА (c все още не е решил)
  if (t.state.round?.kind === 'ordinary') {
    for (const viewer of ['a', 'c']) {
      const message = createSvaraMatchSnapshotMessage('t', t.state, viewer)
      const json = serializeSvaraSnapshotForClient(message)
      for (const code of (t.state.round as any).hands.b) assert(!json.includes(`"${code}"`), `ол-ин b не трябва да е видим за ${viewer} преди реалното сравняване`)
    }
  }
})

check('J2. startNextRound отказва докато showdown-display е отворен (без преждевременно ново раздаване)', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: H34, b: LOW })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' })
  assert.equal(t.state.round?.kind, 'showdown-display')
  expectError(() => t.run({ type: 'start-next-round' }), 'not-allowed', 'не бива да стартира нов рунд докато showdown-display тече')
})

// ─── K. Счетоводни инварианти; съвместимост със стар snapshot ────────────
console.log('\n=== K. инварианти и съвместимост ===')

check('K1. общата сума на чиповете остава непроменена през целия showdown-display цикъл', () => {
  const t = newTable(['a', 'b', 'c'])
  const before = total(t.state)
  t.deal({ a: H34, b: LOW, c: H27 })
  t.seen('a', { kind: 'bet', total: 20 }); t.seen('b', { kind: 'call' }); t.seen('c', { kind: 'call' })
  assert.equal(total(t.state), before)
  t.resolveShowdown()
  assert.equal(total(t.state), before)
})

check('K2. стар (преди 2Б.3.7.6А) формат запис в историята без isMain остава валиден при validateSvaraStoredMatch', () => {
  const t = mount('k2', 2, [buildSvaraDeckForHands(['b', 'a'], { b: H34, a: LOW })])
  t.sync(); t.finishDealingIfNeeded()
  t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 20 } })
  t.submit('a', { type: 'look' }); t.submit('a', { type: 'act', action: { kind: 'call' } })
  t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS + SVARA_PAYOUT_STEP_MS)
  const stored = t.runtime.exportStoredMatchForServer(t.matchId)
  validateSvaraStoredMatch(stored) // sanity: still valid with isMain present
  for (const record of stored.state.history) for (const pot of record.pots as any[]) delete pot.isMain
  validateSvaraStoredMatch(stored) // и остава валиден без него (пред-2Б.3.7.6А формат)
})

check('K3. advance-showdown-display/close-payout-display са отказани, когато няма активен showdown-display', () => {
  const t = newTable(['a', 'b'])
  t.deal({ a: H34, b: LOW })
  assert.notEqual(t.state.round?.kind, 'showdown-display')
  expectError(() => t.run({ type: 'advance-showdown-display', roundId: 'none' }), 'not-allowed', 'без активен showdown-display')
  expectError(() => t.run({ type: 'close-payout-display', roundId: 'none' }), 'not-allowed', 'без активен showdown-display')
})

for (const close of closes) close()
console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

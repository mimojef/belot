/**
 * checkSvaraSnapshot2B32.ts — Свара, Етап 2Б.3.2: защитени индивидуални
 * snapshot-и (protocol builder), без WebSocket.
 *
 *  A. Snapshot за всеки участник; тъмно/поглеждане; чужди карти.
 *  B. Дилър, ред, залози, банки, опции.
 *  C. Обикновена Свара, Свара с ол-ин с няколко странични банки, история.
 *  D. Завършен мач; достъп, подмяна на идентичност, независимост.
 *  E. Сериализация, детерминизъм, изолация, защита от суров state.
 *  F. Случайна игра през runtime: проверка за изтичане след всяка команда.
 *
 * Детерминистичните сценарии строят състоянието директно през двигателя с
 * контролирано тесте (само за тестове) и подават го на чистия builder.
 *
 * Пускане (от server/): npm run check:svara-snapshot-2b32
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applySvaraMatchCommand,
  assertSvaraMatchInvariants,
  buildSvaraDeckForHands,
  createSeededSvaraRandomSourceForTests,
  createSvaraMatch,
  describeSvaraMatchOptions,
  SvaraMatchError,
  type SvaraBettingAction,
  type SvaraMatchCommand,
  type SvaraMatchEnv,
  type SvaraMatchState,
  type SvaraRandomSource,
} from '../src/games/svara/engine/index.js'
import {
  createSvaraMatchSnapshotMessage,
  serializeSvaraSnapshotForClient,
  SVARA_SNAPSHOT_FORBIDDEN_KEYS,
  SVARA_SNAPSHOT_HISTORY_LIMIT,
  SVARA_SNAPSHOT_MESSAGE_TYPE,
  SVARA_SNAPSHOT_PROTOCOL_VERSION,
  SvaraSnapshotAccessError,
  type SvaraMatchSnapshotMessage,
} from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import {
  createSvaraMatchRuntime,
  createSvaraRuntimeClientFacade,
  SvaraRuntimeError,
  type SvaraMatchRuntime,
  type SvaraSystemCommand,
} from '../src/games/svara/runtime/svaraMatchRuntime.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    const actual = (error as { code?: string }).code
    if ((error instanceof SvaraSnapshotAccessError || error instanceof SvaraRuntimeError || error instanceof SvaraMatchError) && actual === code) return
    throw new Error(`expected ${code}, got ${error instanceof Error ? `${error.name}:${actual}: ${error.message}` : String(error)}`)
  }
  throw new Error(`expected ${code}, but no error was thrown`)
}

// ── Детерминистична маса през двигателя ─────────────────────────────────────

type CommandInput = SvaraMatchCommand extends unknown ? (SvaraMatchCommand extends infer C ? (C extends SvaraMatchCommand ? Omit<C, 'commandId'> : never) : never) : never

const fixedDealer = (index: number): SvaraRandomSource => ({ nextInt: () => index })

class Table {
  state: SvaraMatchState
  private seq = 0
  constructor(state: SvaraMatchState) {
    this.state = state
  }
  run(command: CommandInput, env: SvaraMatchEnv = {}): SvaraMatchState {
    const result = applySvaraMatchCommand(this.state, { ...command, commandId: `c${(this.seq += 1)}` } as SvaraMatchCommand, env)
    assertSvaraMatchInvariants(result.state)
    this.state = result.state
    return this.state
  }
  /** Следващо обикновено раздаване с контролирани ръце. */
  deal(hands: Record<string, string>): SvaraMatchState {
    this.resolveRevealChoice()
    return this.run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(this.peekOrder(), hands) })
  }
  /** 2Б.3.7.1: избор, несвързан с тестовия сценарий — по подразбиране скрива. */
  resolveRevealChoice(): SvaraMatchState {
    const round = this.state.round
    if (round && (round as { kind: string }).kind === 'reveal-choice') {
      this.run({ type: 'hide-cards', playerId: (round as { winnerId: string }).winnerId })
    }
    return this.state
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
    const dealer = s.ordinaryDealerId === null ? (participants.includes(s.firstDealerId!) ? s.firstDealerId! : after(s.firstDealerId!)[0]!) : after(s.ordinaryDealerId)[0]!
    return after(dealer)
  }
  act(playerId: string, action: SvaraBettingAction): SvaraMatchState {
    return this.run({ type: 'act', playerId, action })
  }
  look(playerId: string): SvaraMatchState {
    return this.run({ type: 'look', playerId })
  }
  seen(playerId: string, action: SvaraBettingAction): SvaraMatchState {
    this.look(playerId)
    return this.act(playerId, action)
  }
  snap(viewerId: string): SvaraMatchSnapshotMessage {
    return createSvaraMatchSnapshotMessage('t', this.state, viewerId)
  }
}

/** 200 начални чипа, Вход 10; дилърът е последният в списъка. */
function newTable(players: string[], dealerIndex = players.length - 1): Table {
  const t = new Table(createSvaraMatch({ tableId: 't', capacity: players.length as 2 | 3 | 4, entryFee: 2000, entryPercent: 5, startMode: 'manual', creatorId: players[0]! }))
  for (const id of players.slice(1)) t.run({ type: 'join-seat', playerId: id })
  t.run({ type: 'start-match', playerId: players[0]! }, { random: fixedDealer(dealerIndex) })
  return t
}

const H34 = '7S 7H 7D'
const H27 = '10H 9H 8H'
const H24 = '8S 8C 8D'
const TIE1 = 'AC KH QD'
const TIE2 = 'AH KD QC'
const LOW = '9C 8D JS'
const codes = (hand: string) => hand.split(' ')

// ── Проверка за изтичане ────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = 'carriedTotal,dealerId,history,lockedPots,matchId,phase,protocolVersion,removedChips,result,revision,round,seats,table,toActId,totalChips,type,you'

function collectKeys(value: unknown, out: Set<string>): Set<string> {
  if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) { out.add(key); collectKeys(nested, out) }
  return out
}

/**
 * Сканира пълната JSON сериализация: никакви чужди карти, никакви собствени
 * непогледнати карти, никакви карти от историята (освен текущо видимите
 * собствени), никакви вътрешни ключове и commandId пространства.
 */
function assertSnapshotSafe(snapshot: SvaraMatchSnapshotMessage, state: SvaraMatchState): void {
  const viewer = snapshot.you.playerId
  const json = serializeSvaraSnapshotForClient(snapshot)
  const parsed = JSON.parse(json) as Record<string, unknown>
  assert(Object.keys(parsed).sort().join() === TOP_LEVEL_KEYS, `top-level keys ${Object.keys(parsed).sort().join()}`)
  const keys = collectKeys(parsed, new Set())
  for (const key of SVARA_SNAPSHOT_FORBIDDEN_KEYS) assert(!keys.has(key), `snapshot of ${viewer} has internal key ${key}`)
  assert(!json.includes('[\\"p\\"') && !json.includes('[\\"s\\"'), 'namespaced commandIds leaked')
  const round = state.round
  const visible = new Set<string>()
  if (round && (round.kind === 'ordinary' || round.kind === 'svara') && round.betting.looked.includes(viewer)) for (const code of round.hands[viewer] ?? []) visible.add(code)
  // 2Б.3.7.1: докато „Покажи“/„Скрий“ чака, победителят вижда своята вече
  // погледната ръка (сега в round.cards); веднъж показана — публична за всички.
  if (round && round.kind === 'reveal-choice' && round.winnerId === viewer) for (const code of round.cards) visible.add(code)
  const hidden = new Set<string>()
  if (round && (round.kind === 'ordinary' || round.kind === 'svara')) for (const cards of Object.values(round.hands)) for (const code of cards) if (!visible.has(code)) hidden.add(code)
  if (round && round.kind === 'reveal-choice' && round.decision === 'pending') for (const code of round.cards) if (!visible.has(code)) hidden.add(code)
  for (const record of state.history) for (const cards of Object.values(record.shownHands)) for (const code of cards) if (!visible.has(code)) hidden.add(code)
  for (const code of hidden) assert(!json.includes(`"${code}"`), `snapshot of ${viewer} leaks card ${code}`)
  const cards = snapshot.you.cards
  assert(cards === null ? visible.size === 0 : cards.length === visible.size && cards.every((code) => visible.has(code)), 'you.cards must equal exactly the looked own hand')
}

// ─── A. Snapshot за всеки участник и карти ─────────────────────────────────
console.log('\n=== A. участници, тъмно, поглеждане, чужди карти ===')

check('1. snapshot за всеки участник: тип, версия, собствена позиция, всички места', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: H27, c: LOW })
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const s = t.snap(id)
    assert(s.type === SVARA_SNAPSHOT_MESSAGE_TYPE && s.protocolVersion === SVARA_SNAPSHOT_PROTOCOL_VERSION && s.matchId === 't', 'header')
    assert(s.you.playerId === id && s.you.seatIndex === index && s.you.status === 'active', 'you')
    assert(s.seats.map((seat) => `${seat.seatIndex}:${seat.playerId}`).join() === '0:a,1:b,2:c', 'seats')
    assert(s.phase === 'in-progress' && s.round?.kind === 'ordinary', 'phase/round')
    assert(s.table.capacity === 3 && s.table.startingChips === 200 && s.table.entryChips === 10 && s.table.entryPercent === 5 && s.table.entryFee === 2000 && s.table.creatorId === 'a', 'public table settings')
    assert(s.seats.every((seat) => seat.cardCount === 3 && seat.inRound), 'card counts')
    assertSnapshotSafe(s, t.state)
  }
})

check('2. собствените карти са скрити преди „поглеждане“ (тъмно)', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: H27, c: LOW })
  for (const id of ['a', 'b', 'c']) {
    const s = t.snap(id)
    assert(s.you.cards === null && s.you.looked === false, `${id} blind`)
    const json = JSON.stringify(s)
    for (const code of [...codes(H34), ...codes(H27), ...codes(LOW)]) assert(!json.includes(`"${code}"`), `${code} leaked`)
  }
  // Тъмен залог: картите остават скрити и след действието.
  t.act('a', { kind: 'blind-bet', total: 20 })
  const s = t.snap('a')
  assert(s.you.cards === null && s.round?.kind === 'ordinary' && s.round.blind.status === 'active', 'blind phase, still hidden')
  assertSnapshotSafe(s, t.state)
})

check('3. собствените карти са видими след „поглеждане“ — точно трите', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: H27, c: LOW })
  t.look('b')
  const s = t.snap('b')
  assert(s.you.looked && JSON.stringify(s.you.cards) === JSON.stringify(codes(H27)), JSON.stringify(s.you.cards))
  assertSnapshotSafe(s, t.state)
})

check('4. чуждите карти са недостъпни (и когато всички са погледнали)', () => {
  const t = newTable(['a', 'b', 'c'])
  t.deal({ a: H34, b: H27, c: LOW })
  for (const id of ['a', 'b', 'c']) t.look(id)
  const hands: Record<string, string> = { a: H34, b: H27, c: LOW }
  for (const id of ['a', 'b', 'c']) {
    const s = t.snap(id)
    const json = JSON.stringify(s)
    for (const [other, hand] of Object.entries(hands)) if (other !== id) for (const code of codes(hand)) assert(!json.includes(`"${code}"`), `${id} sees ${other}:${code}`)
    // Дали ДРУГ е погледнал не се изпраща (решение на собственика).
    assert(!json.includes('"looked":true') || s.you.looked, 'only own looked flag')
    assert(JSON.stringify(s.seats).indexOf('looked') === -1, 'no per-seat looked flag')
    assertSnapshotSafe(s, t.state)
  }
})

// ─── B. Дилър, ред, залози, банки, опции ────────────────────────────────────
console.log('\n=== B. дилър, ред, залози, банки, опции ===')

check('5. дилър и ред на ходовете', () => {
  const t = newTable(['a', 'b', 'c'], 2) // дилър c → ред a, b, c
  t.deal({ a: H34, b: H27, c: LOW })
  let s = t.snap('b')
  assert(s.dealerId === 'c' && s.toActId === 'a', `${s.dealerId} ${s.toActId}`)
  assert(s.seats.filter((x) => x.isDealer).map((x) => x.playerId).join() === 'c' && s.seats.filter((x) => x.isToAct).map((x) => x.playerId).join() === 'a', 'flags')
  t.seen('a', { kind: 'bet', total: 10 })
  s = t.snap('c')
  assert(s.toActId === 'b' && s.seats.find((x) => x.isToAct)!.playerId === 'b', 'turn moved to b')
  t.act('b', { kind: 'fold' })
  s = t.snap('a')
  assert(s.toActId === 'c' && s.seats.find((x) => x.playerId === 'b')!.folded && s.seats.find((x) => x.playerId === 'b')!.cardCount === 0, 'b folded, no cards')
})

check('6. публични залози и банки (вноски, текущ залог, общо, предварителни слоеве)', () => {
  const t = newTable(['a', 'b', 'c'], 2)
  t.deal({ a: H34, b: H27, c: LOW })
  t.seen('a', { kind: 'bet', total: 30 })
  t.seen('b', { kind: 'call' })
  const s = t.snap('c')
  const round = s.round!
  assert(round.kind === 'ordinary', 'ordinary')
  const contrib = Object.fromEntries(s.seats.map((x) => [x.playerId, x.roundContribution]))
  assert(contrib.a === 40 && contrib.b === 40 && contrib.c === 10, JSON.stringify(contrib))
  assert(round.currentBet === 30 && round.potTotal === 90 && round.carriedIn === 0, `${round.currentBet} ${round.potTotal}`)
  assert(round.provisionalPots.reduce((sum, pot) => sum + pot.amount, 0) === 90, 'layers sum')
  assert(round.actions.map((x) => `${x.playerId}:${x.kind}:${x.total}`).join() === 'a:bet:30,b:call:30', JSON.stringify(round.actions))
  const stacks = Object.fromEntries(s.seats.map((x) => [x.playerId, x.stack]))
  assert(stacks.a === 160 && stacks.b === 160 && stacks.c === 190, JSON.stringify(stacks))
  assert(s.totalChips === 600 && s.removedChips === 0, 'totals')
})

check('7. разрешените действия са само за зрителя и съвпадат с двигателя', () => {
  const t = newTable(['a', 'b', 'c'], 2)
  t.deal({ a: H34, b: H27, c: LOW })
  for (const id of ['a', 'b', 'c']) {
    const s = t.snap(id)
    const engine = describeSvaraMatchOptions(t.state, id)
    assert(JSON.stringify(s.you.betting) === JSON.stringify(engine), `${id}: ${JSON.stringify(s.you.betting)} vs ${JSON.stringify(engine)}`)
    assert((s.you.betting?.canAct ?? false) === (id === 'a'), `${id} canAct`)
  }
  const first = t.snap('a').you.betting!
  assert(first.lookRequired && first.blindBet !== null && first.bet === null, 'first player blind: look or blind bet')
  t.look('a')
  const seen = t.snap('a').you.betting!
  assert(seen.bet !== null && seen.blindBet === null, 'after look: normal bet')
  // Опциите на другите не се появяват в чуждия snapshot.
  assert(!JSON.stringify(t.snap('b')).includes(`"min":${seen.bet!.min},"max":${seen.bet!.max}`) || t.snap('b').you.betting?.bet === null, 'no foreign options')
})

// ─── C. Свари и история ─────────────────────────────────────────────────────
console.log('\n=== C. обикновена Свара, Свара с ол-ин, история ===')

check('8. обикновена Свара: заключена банка → включване → раздаване за Свара', () => {
  const t = newTable(['a', 'b', 'c', 'd'], 3)
  t.deal({ a: TIE1, b: TIE2, c: H34, d: H27 })
  t.seen('a', { kind: 'bet', total: 10 })
  t.seen('b', { kind: 'call' })
  t.seen('c', { kind: 'fold' })
  t.seen('d', { kind: 'fold' })
  let s = t.snap('c')
  assert(s.round === null && s.lockedPots.length === 1, 'locked')
  const pot = s.lockedPots[0]!
  assert(pot.kind === 'ordinary' && pot.amount === 60 && pot.eligible.slice().sort().join() === 'a,b' && pot.isMain === false, JSON.stringify(pot))
  const record = s.history.recent[s.history.recent.length - 1]!
  assert(record.pots.some((p) => p.outcome.kind === 'locked' && p.outcome.lockKind === 'ordinary'), 'history shows the lock')
  assertSnapshotSafe(s, t.state)
  t.run({ type: 'start-next-round' })
  s = t.snap('d')
  assert(s.round?.kind === 'svara-joining' && s.round.fee === 30 && s.round.joiners.length === 0 && s.round.potId === pot.potId, JSON.stringify(s.round))
  t.run({ type: 'svara-join', playerId: 'c' })
  s = t.snap('d')
  assert(s.round?.kind === 'svara-joining' && s.round.joiners.join() === 'c' && s.lockedPots[0]!.amount === 90, 'joined')
  const order = t.state.lockedPots[0]!.eligible
  t.run({ type: 'svara-start' }, { createDeck: () => buildSvaraDeckForHands([...order], { a: H34, b: H27, c: LOW }) })
  for (const id of ['a', 'b', 'c', 'd']) {
    const view = t.snap(id)
    assert(view.round?.kind === 'svara' && view.round.potId === pot.potId && view.round.participants.slice().sort().join() === 'a,b,c', 'svara deal')
    assert(view.seats.find((x) => x.playerId === 'd')!.inRound === false && view.seats.find((x) => x.playerId === 'd')!.cardCount === 0, 'd outside')
    assertSnapshotSafe(view, t.state)
  }
})

/** Примерът 40/30/20 от §12 (виж checkSvaraMatch2B2B, E8c). */
function setupThreeSidePots(): Table {
  const t = newTable(['petar', 'ivan', 'georgi', 'maria'], 3)
  t.deal({ georgi: H34 })
  t.seen('petar', { kind: 'bet', total: 170 })
  t.seen('ivan', { kind: 'bet', total: 180 })
  t.seen('georgi', { kind: 'call' })
  t.act('maria', { kind: 'fold' })
  t.act('petar', { kind: 'fold' })
  t.deal({ ivan: H34, georgi: '10S 10H 10D', maria: 'QS QH QD', petar: 'JS JH JD' })
  t.seen('georgi', { kind: 'bet', total: 20 })
  t.seen('maria', { kind: 'call' })
  t.act('petar', { kind: 'all-in' })
  return t
}

check('9. Свара с ол-ин и две странични банки: публични банки, без карти', () => {
  const t = setupThreeSidePots()
  const s = t.snap('ivan')
  assert(s.round?.kind === 'allin-svara' && s.round.potIds.length === 2 && s.round.iteration === 0, JSON.stringify(s.round))
  assert(JSON.stringify(s.lockedPots.map((p) => `${p.kind}:${p.amount}:${p.isMain}:${p.eligible.slice().sort().join('|')}`)) === JSON.stringify(['allin:30:false:georgi|maria|petar', 'allin:20:false:georgi|maria']), JSON.stringify(s.lockedPots))
  const last = s.history.recent[s.history.recent.length - 1]!
  assert(last.pots.some((p) => p.outcome.kind === 'awarded' && p.outcome.winner === 'ivan'), 'main pot awarded to ivan')
  for (const id of ['petar', 'ivan', 'georgi', 'maria']) assertSnapshotSafe(t.snap(id), t.state)
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['petar', 'georgi', 'maria'], { georgi: H34, petar: H27, maria: H24 }) })
  for (const id of ['petar', 'ivan', 'georgi', 'maria']) {
    const after = t.snap(id)
    assert(after.round === null && after.lockedPots.length === 0, 'resolved')
    const record = after.history.recent[after.history.recent.length - 1]!
    assert(record.kind === 'allin-svara' && record.pots.length === 2 && record.pots.every((p) => p.outcome.kind === 'awarded' && p.outcome.winner === 'georgi'), JSON.stringify(record.pots))
    const json = JSON.stringify(after)
    for (const code of [...codes(H34), ...codes(H27), ...codes(H24)]) assert(!json.includes(`"${code}"`), `allin-svara card ${code} leaked`)
    assertSnapshotSafe(after, t.state)
  }
})

check('10. историята не разкрива показани карти и точки; лимит на последните раздавания', () => {
  const t = newTable(['a', 'b'], 1)
  t.deal({ a: H34, b: H27 })
  t.seen('a', { kind: 'bet', total: 10 })
  t.seen('b', { kind: 'call' })
  assert(Object.keys(t.state.history[0]!.shownHands).length === 2, 'engine recorded a showdown')
  for (const id of ['a', 'b']) {
    const s = t.snap(id)
    const record = s.history.recent[0]!
    assert(s.history.showdownReveal === 'withheld' && !('shownHands' in record) && !('points' in record), 'no cards/points')
    assert(record.pots.some((p) => p.outcome.kind === 'awarded' && p.outcome.winner === 'a' && p.outcome.byShowdown), 'public outcome only')
    const json = JSON.stringify(s)
    for (const code of [...codes(H34), ...codes(H27)]) assert(!json.includes(`"${code}"`), `history leaks ${code}`)
    assertSnapshotSafe(s, t.state)
  }
  for (let i = 0; i < SVARA_SNAPSHOT_HISTORY_LIMIT + 3; i += 1) {
    t.deal({})
    t.act(t.state.round!.kind === 'ordinary' ? t.state.round!.betting.toAct! : '', { kind: 'fold' })
  }
  t.resolveRevealChoice()
  const s = t.snap('a')
  assert(s.history.totalRounds === SVARA_SNAPSHOT_HISTORY_LIMIT + 4 && s.history.recent.length === SVARA_SNAPSHOT_HISTORY_LIMIT, `${s.history.totalRounds} ${s.history.recent.length}`)
  assert(s.history.recent[s.history.recent.length - 1]!.roundId === t.state.history[t.state.history.length - 1]!.roundId, 'most recent last')
})

// ─── D. Край, достъп, идентичност, независимост ─────────────────────────────
console.log('\n=== D. завършен мач, достъп, идентичност, независимост ===')

check('11. завършен мач: резултат, победител, без раздаване', () => {
  const t = newTable(['a', 'b'], 1)
  t.deal({ a: H34, b: H27 })
  t.seen('a', { kind: 'all-in' })
  t.seen('b', { kind: 'call' })
  assert(t.state.phase === 'finished', 'finished')
  for (const id of ['a', 'b']) {
    const s = t.snap(id)
    assert(s.phase === 'finished' && s.result.finished && !s.result.closed && s.result.winnerId === 'a', JSON.stringify(s.result))
    assert(s.round === null && s.you.betting === null && s.you.cards === null, 'no round')
    assert(s.seats.find((x) => x.playerId === 'a')!.stack === 400 && s.seats.find((x) => x.playerId === 'b')!.status === 'eliminated', 'final stacks/status')
    assertSnapshotSafe(s, t.state)
  }
  // Закрита преди старта маса.
  const closed = new Table(createSvaraMatch({ tableId: 't', capacity: 3, entryFee: 2000, startMode: 'auto', creatorId: 'a' }))
  closed.run({ type: 'join-seat', playerId: 'b' })
  const lobby = closed.snap('b')
  assert(lobby.phase === 'lobby' && lobby.seats.length === 2 && lobby.round === null && lobby.you.betting === null, 'lobby snapshot')
  closed.run({ type: 'leave-seat', playerId: 'a' })
  expectError(() => closed.snap('b'), 'not-a-participant')
})

check('12. чужд участник / неучастник няма достъп', () => {
  const t = newTable(['a', 'b'], 1)
  t.deal({ a: H34, b: H27 })
  expectError(() => t.snap('eve'), 'not-a-participant')
  expectError(() => t.snap(''), 'invalid-viewer')
  expectError(() => createSvaraMatchSnapshotMessage('t', t.state, null as never), 'invalid-viewer')
  const rt = createSvaraMatchRuntime()
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity: 2, entryFee: 100, startMode: 'auto' })
  expectError(() => rt.getPlayerSnapshot('m', { playerId: 'eve' }), 'not-a-participant')
  expectError(() => rt.getPlayerSnapshot('nope', { playerId: 'a' }), 'match-not-found')
  expectError(() => createSvaraRuntimeClientFacade(rt).getPlayerSnapshot('m', { playerId: 'eve' }), 'not-a-participant')
})

check('13. подмяна на идентичността е невъзможна: зрителят е само довереният actor', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(13) })
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity: 2, entryFee: 100, startMode: 'auto' })
  rt.executeParticipantCommand('m', { playerId: 'b' }, 'j', { type: 'join-seat' })
  rt.executeSystemCommand('m', 'r1', { type: 'start-next-round' })
  rt.executeParticipantCommand('m', { playerId: 'b' }, 'l', { type: 'look' })
  // Опит „от името на“ b чрез допълнителни полета — игнорират се.
  const spoof = rt.getPlayerSnapshot('m', { playerId: 'a', viewerId: 'b', viewAs: 'b' } as never)
  assert(spoof.you.playerId === 'a' && spoof.you.cards === null, 'a gets only its own (blind) snapshot')
  const state = rt.exportInternalStateForServer('m')
  assertSnapshotSafe(spoof, state)
  expectError(() => rt.getPlayerSnapshot('m', { playerId: ['b'] } as never), 'invalid-input')
  expectError(() => rt.getPlayerSnapshot('m', null as never), 'invalid-input')
  const real = rt.getPlayerSnapshot('m', { playerId: 'b' })
  const round = state.round!
  assert(round.kind === 'ordinary' && JSON.stringify(real.you.cards) === JSON.stringify(round.hands.b), 'b sees own cards only')
})

check('14. snapshot-ите са независими, замразени и не споделят обекти със състоянието', () => {
  const t = newTable(['a', 'b', 'c'], 2)
  t.deal({ a: H34, b: H27, c: LOW })
  t.look('a')
  const before = JSON.stringify(t.state)
  const sa = t.snap('a')
  const sb = t.snap('b')
  const sbJson = JSON.stringify(sb)
  assert(sa.seats !== sb.seats && sa.round !== sb.round && sa.table !== sb.table, 'no shared objects between viewers')
  assert(Object.isFrozen(sa) && Object.isFrozen(sa.seats[0]) && Object.isFrozen(sa.you.cards) && Object.isFrozen(sa.round), 'deep frozen')
  let threw = 0
  for (const mutate of [() => { (sa.you.cards as string[]).push('AS') }, () => { (sa.seats[0] as { stack: number }).stack = 1 }, () => { (sa as { phase: string }).phase = 'x' }]) {
    try { mutate() } catch { threw += 1 }
  }
  assert(threw === 3, 'mutations rejected')
  assert(JSON.stringify(sb) === sbJson && JSON.stringify(t.state) === before, 'other snapshot and state untouched')
  const round = t.state.round!
  assert(round.kind === 'ordinary' && sa.you.cards !== round.hands.a && sa.round !== null, 'own cards are a copy')
})

// ─── E. Сериализация, детерминизъм, изолация, суров state ───────────────────
console.log('\n=== E. сериализация, детерминизъм, изолация, суров state ===')

check('15. пълната JSON сериализация няма скрити вътрешни полета (всички фази)', () => {
  const t = setupThreeSidePots()
  const states = [t.state]
  t.run({ type: 'advance-allin-svara' }, { createDeck: () => buildSvaraDeckForHands(['petar', 'georgi', 'maria'], { georgi: H34, petar: H27, maria: H24 }) })
  states.push(t.state)
  t.deal({})
  states.push(t.state)
  for (const state of states) {
    for (const id of state.seats) {
      const snapshot = createSvaraMatchSnapshotMessage('t', state, id)
      assertSnapshotSafe(snapshot, state)
      const keys = collectKeys(JSON.parse(serializeSvaraSnapshotForClient(snapshot)), new Set())
      for (const key of ['hands', 'shownHands', 'points', 'ledger', 'processedCommands', 'fingerprint', 'pending', 'acted', 'raiseLocked', 'voluntary', 'originDealerId', 'lastSvaraDealerId', 'sidesEvaluated', 'deadMoneyFrom', 'headsUpNoBetStreak', 'firstDealerId', 'roundCounter']) {
        assert(!keys.has(key), `${id}: key ${key}`)
      }
    }
  }
})

check('16. повторно изграждане от същото състояние е детерминистично и не променя състоянието', () => {
  const t = setupThreeSidePots()
  const before = JSON.stringify(t.state)
  for (const id of t.state.seats) {
    const first = serializeSvaraSnapshotForClient(createSvaraMatchSnapshotMessage('t', t.state, id))
    const second = serializeSvaraSnapshotForClient(createSvaraMatchSnapshotMessage('t', structuredClone(t.state), id))
    assert(first === second, `${id}: non-deterministic`)
  }
  assert(JSON.stringify(t.state) === before, 'builder does not mutate state')
  // „Reconnect“: същото състояние → същият snapshot, без допълнителна информация.
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(16) })
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity: 2, entryFee: 100, startMode: 'auto' })
  rt.executeParticipantCommand('m', { playerId: 'b' }, 'j', { type: 'join-seat' })
  rt.executeSystemCommand('m', 'r1', { type: 'start-next-round' })
  const live = serializeSvaraSnapshotForClient(rt.getPlayerSnapshot('m', { playerId: 'b' }))
  const again = serializeSvaraSnapshotForClient(rt.getPlayerSnapshot('m', { playerId: 'b' }))
  assert(live === again, 'reconnect yields the same snapshot')
  rt.executeSystemCommand('m', 'away', { type: 'set-absent', playerId: 'b', absent: true })
  rt.executeSystemCommand('m', 'back', { type: 'set-absent', playerId: 'b', absent: false })
  const back = rt.getPlayerSnapshot('m', { playerId: 'b' })
  assert(back.you.cards === null && back.revision === JSON.parse(live).revision + 2, 'no cards revealed by absence/return')
  assertSnapshotSafe(back, rt.exportInternalStateForServer('m'))
})

check('17. изолация между няколко мача (едни и същи играчи)', () => {
  const rt = createSvaraMatchRuntime({ random: createSeededSvaraRandomSourceForTests(17) })
  for (const id of ['x', 'y']) {
    rt.registerMatch({ matchId: id, creator: { playerId: 'a' }, capacity: 2, entryFee: id === 'x' ? 100 : 500, startMode: 'auto' })
    rt.executeParticipantCommand(id, { playerId: 'b' }, 'j', { type: 'join-seat' })
    rt.executeSystemCommand(id, 'r1', { type: 'start-next-round' })
  }
  rt.executeParticipantCommand('x', { playerId: 'a' }, 'l', { type: 'look' })
  const sx = rt.getPlayerSnapshot('x', { playerId: 'a' })
  const sy = rt.getPlayerSnapshot('y', { playerId: 'a' })
  const roundX = rt.exportInternalStateForServer('x').round!
  const roundY = rt.exportInternalStateForServer('y').round!
  assert(sx.matchId === 'x' && sy.matchId === 'y' && sx.table.entryFee === 100 && sy.table.entryFee === 500, 'own match data')
  assert(roundX.kind === 'ordinary' && roundY.kind === 'ordinary', 'ordinary')
  assert(JSON.stringify(sx.you.cards) === JSON.stringify(roundX.hands.a) && sy.you.cards === null, 'looked only in x')
  for (const code of roundY.hands.a!) if (!roundX.hands.a!.includes(code)) assert(!JSON.stringify(sx).includes(`"${code}"`), 'y cards in x snapshot')
  assertSnapshotSafe(sx, rt.exportInternalStateForServer('x'))
  assertSnapshotSafe(sy, rt.exportInternalStateForServer('y'))
})

check('18. защита срещу изпращане на суровия engine state или ръчно сглобен обект', () => {
  const t = newTable(['a', 'b'], 1)
  t.deal({ a: H34, b: H27 })
  const snapshot = t.snap('a')
  expectError(() => serializeSvaraSnapshotForClient(t.state), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient({ ...snapshot }), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient(JSON.parse(JSON.stringify(snapshot))), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient(structuredClone(snapshot)), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient({ ...snapshot, hands: t.state.round }), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient(null), 'not-a-snapshot')
  expectError(() => serializeSvaraSnapshotForClient(createSvaraMatchRuntime().getPlayerView), 'not-a-snapshot')
  assert(serializeSvaraSnapshotForClient(snapshot) === JSON.stringify(snapshot), 'built snapshot serializes')
  // Фасадата за клиентския слой дава snapshot, но не и вътрешното състояние.
  const rt = createSvaraMatchRuntime()
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity: 2, entryFee: 100, startMode: 'auto' })
  const facade = createSvaraRuntimeClientFacade(rt) as unknown as Record<string, unknown>
  assert(typeof facade.getPlayerSnapshot === 'function' && !('exportInternalStateForServer' in facade) && !('executeSystemCommand' in facade), 'facade surface')
  assert(serializeSvaraSnapshotForClient(rt.getPlayerSnapshot('m', { playerId: 'a' })).includes('"phase":"lobby"'), 'runtime snapshot serializable')
})

// ─── F. Случайна игра през runtime ──────────────────────────────────────────
console.log('\n=== F. случайна игра: изтичане след всяка команда ===')

function driveStep(rt: SvaraMatchRuntime, matchId: string, players: string[], pick: (n: number) => number, counters: { seq: number }): void {
  const s = rt.getPlayerSnapshot(matchId, { playerId: players[0]! })
  const status = Object.fromEntries(s.seats.map((x) => [x.playerId, x.status]))
  const active = players.filter((id) => status[id] === 'active')
  const absent = players.filter((id) => status[id] === 'absent')
  const sys = (command: SvaraSystemCommand) => rt.executeSystemCommand(matchId, `s${(counters.seq += 1)}`, command)
  const part = (id: string, command: unknown) => rt.executeParticipantCommand(matchId, { playerId: id }, `c${(counters.seq += 1)}`, command)
  if (pick(70) === 0 && active.length + absent.length > 0) {
    const id = [...active, ...absent][pick(active.length + absent.length)]!
    sys({ type: 'set-absent', playerId: id, absent: status[id] === 'active' })
    return
  }
  if (absent.length > 0 && active.length === 1 && pick(3) === 0) return void sys({ type: 'absence-expired', playerId: absent[pick(absent.length)]! })
  const round = s.round
  if (round === null) {
    try {
      sys({ type: 'start-next-round' })
    } catch (error) {
      if (error instanceof SvaraMatchError && error.code === 'no-round-available' && absent.length > 0) return void sys({ type: 'set-absent', playerId: absent[0]!, absent: false })
      throw error
    }
    return
  }
  if (round.kind === 'svara-joining') {
    const holder = s.lockedPots.flatMap((p) => p.eligible).find((id) => status[id] === 'absent')
    if (holder) return void sys({ type: 'set-absent', playerId: holder, absent: false })
    const candidates = active.filter((id) => s.seats.find((x) => x.playerId === id)!.stack >= round.fee)
    if (candidates.length > 0 && pick(3) === 0) {
      try {
        return void part(candidates[pick(candidates.length)]!, { type: 'svara-join' })
      } catch (error) {
        if (!(error instanceof SvaraMatchError && error.code === 'not-allowed')) throw error
      }
    }
    return void sys({ type: 'svara-start' })
  }
  if (round.kind === 'allin-svara') return void sys({ type: 'advance-allin-svara' })
  if (round.kind === 'reveal-choice') {
    if (round.decision === 'pending') {
      if (status[round.winnerId] !== 'active') return void sys({ type: 'set-absent', playerId: round.winnerId, absent: false })
      return void part(round.winnerId, { type: 'hide-cards' })
    }
    return void sys({ type: 'close-reveal-display', roundId: round.roundId })
  }
  const actor = s.toActId!
  if (status[actor] === 'absent') return void sys({ type: 'set-absent', playerId: actor, absent: false })
  const own = rt.getPlayerSnapshot(matchId, { playerId: actor })
  const o = own.you.betting!
  if (!own.you.looked && (pick(3) === 0 || (o.lookRequired && !o.blindBet && o.call === null && o.allIn === null))) return void part(actor, { type: 'look' })
  const choices: SvaraBettingAction[] = []
  if (o.fold && pick(4) === 0) choices.push({ kind: 'fold' })
  if (o.noBet) choices.push({ kind: 'no-bet' })
  if (o.call !== null) choices.push({ kind: 'call' })
  if (o.bet) choices.push({ kind: 'bet', total: o.bet.min + pick(Math.min(3, o.bet.max - o.bet.min + 1)) })
  if (o.blindBet) choices.push({ kind: 'blind-bet', total: o.blindBet.min })
  if (o.allIn !== null && pick(3) === 0) choices.push({ kind: 'all-in' })
  if (choices.length === 0) choices.push({ kind: 'fold' })
  part(actor, { type: 'act', action: choices[pick(choices.length)]! })
}

check('19. 40 случайни мача: след всяка команда snapshot-ите на всички са безопасни и сериализуеми', () => {
  const random = createSeededSvaraRandomSourceForTests(2032)
  const pick = (n: number) => random.nextInt(n)
  const rt = createSvaraMatchRuntime({ random })
  let steps = 0
  let snapshots = 0
  let svaras = 0
  let allins = 0
  let finished = 0
  for (let m = 0; m < 40; m += 1) {
    const players = ['p0', 'p1', 'p2', 'p3'].slice(0, 2 + (m % 3))
    const matchId = `r${m}`
    rt.registerMatch({ matchId, creator: { playerId: players[0]! }, capacity: players.length as 2 | 3 | 4, entryFee: 100 + 10 * pick(30), entryPercent: ([1, 2, 3, 5] as const)[pick(4)], startMode: 'auto' })
    for (const id of players.slice(1)) rt.executeParticipantCommand(matchId, { playerId: id }, 'join', { type: 'join-seat' })
    const counters = { seq: 0 }
    for (let i = 0; i < 400 && !rt.isMatchFinished(matchId); i += 1) {
      driveStep(rt, matchId, players, pick, counters)
      steps += 1
      const state = rt.exportInternalStateForServer(matchId)
      if (state.round?.kind === 'svara') svaras += 1
      if (state.round?.kind === 'allin-svara') allins += 1
      for (const id of state.seats) {
        assertSnapshotSafe(rt.getPlayerSnapshot(matchId, { playerId: id }), state)
        snapshots += 1
      }
    }
    if (rt.isMatchFinished(matchId)) finished += 1
  }
  console.log(`      стъпки ${steps}, проверени snapshot-и ${snapshots}, в Свара ${svaras}, в Свара с ол-ин ${allins}, завършени ${finished}/40`)
  assert(steps > 1000 && snapshots > 3000 && svaras > 10 && finished > 30, 'coverage')
})

// ─── G. Изолация на модула ──────────────────────────────────────────────────
console.log('\n=== G. изолация на модула ===')

check('20. протоколният модул импортира само модули на двигателя; без WS/HTTP/SQLite/таймери', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'svara', 'protocol', 'svaraSnapshotProtocol.ts')
  const source = readFileSync(file, 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  for (const match of source.matchAll(/from '([^']+)'/g)) assert(/^\.\.\/engine\/svara[A-Za-z]+\.js$/.test(match[1]!), `imports ${match[1]}`)
  for (const banned of ['WebSocket', 'sqlite', 'setTimeout', 'setInterval', 'process.env', 'exportInternalStateForServer', 'buildSvaraDeckForHands', 'Date.now', 'Math.random']) {
    assert(!code.includes(banned), `protocol code mentions ${banned}`)
  }
  // Snapshot-ът не чете суровите ръце директно — само чрез createSvaraMatchPlayerView.
  assert(!/\.hands\b/.test(code) && !/shownHands\s*[:.\[]/.test(code.replace(/'shownHands'/g, '')), 'protocol reads hands directly')
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

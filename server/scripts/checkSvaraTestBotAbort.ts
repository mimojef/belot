/**
 * ВРЕМЕННО — тестови ботове: незабавно прекратяване при изрично „Изход“ на
 * последния реален играч (docs/svara-test-bots-local.md). Премахва се заедно
 * с модула testBots/.
 *
 * Реален lobby + runtime + lifecycle + persistence порт (in-memory),
 * контролиран часовник. Част А: детерминистични състояния за всяка фаза
 * (засети през реалния runtime с контролирано тесте и възстановени от
 * lobby-то). Част Б: реални игри срещу ботове с изход в случайни моменти.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { createSvaraMatchRuntime, type SvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import type { SvaraMatchPersistence, SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import type { SvaraLobbyClientMessage, SvaraLobbyServerMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import type { SvaraMatchSnapshotMessage } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { assertSvaraMatchInvariants, buildSvaraDeckForHands, type SvaraMatchState } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { createSvaraTestBotsFactory, type SvaraTestBots } from '../src/games/svara/testBots/createSvaraTestBots.js'
import { decideSvaraTestBotCommand, svaraTestBotHasDecision } from '../src/games/svara/testBots/svaraTestBotStrategy.js'

// ── Помощни ─────────────────────────────────────────────────────────────────

type Job = { at: number; order: number; callback: () => void }
class Clock implements SvaraClock {
  time = 80_000_000
  private order = 0
  readonly jobs = new Set<Job>()
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + Math.max(0, delay), order: this.order++, callback }
    this.jobs.add(job)
    return () => { this.jobs.delete(job) }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let n = 0; ; n++) {
      assert(n < 100_000, 'unbounded timer loop')
      let next: Job | null = null
      for (const job of this.jobs) if (job.at <= end && (!next || job.at < next.at || (job.at === next.at && job.order < next.order))) next = job
      if (!next) break
      this.jobs.delete(next)
      this.time = next.at
      next.callback()
    }
    this.time = end
  }
}

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function deckRandom(decks: SvaraCard[][]) {
  const swaps: number[] = []
  return { nextInt(max: number) {
    if (max === 32) {
      const target = (decks.shift() ?? SVARA_ORDERED_DECK).map(svaraCardCode)
      const work = SVARA_ORDERED_DECK.map(svaraCardCode)
      for (let i = 31; i > 0; i--) { const j = work.indexOf(target[i]!); swaps.push(j); [work[i], work[j]] = [work[j]!, work[i]!] }
    }
    if (!swaps.length) return 0
    return swaps.shift()!
  } }
}

function memoryPersistence() {
  const store = new Map<string, SvaraStoredMatch>()
  const persistence: SvaraMatchPersistence = {
    save(snapshot, expectedRevision) {
      assert.equal(store.get(snapshot.matchId)?.revision ?? null, expectedRevision, 'persistence revision chain')
      store.set(snapshot.matchId, structuredClone(snapshot))
    },
    load: (matchId) => structuredClone(store.get(matchId) ?? null),
    loadActiveMatches: () => [...store.values()].filter((s) => s.state.phase === 'lobby' || s.state.phase === 'in-progress').map((s) => structuredClone(s)),
    findActiveMatchId: (playerId) => [...store.values()].find((s) => (s.state.phase === 'lobby' || s.state.phase === 'in-progress')
      && ['active', 'absent'].includes(s.state.status[playerId] ?? ''))?.matchId ?? null,
  }
  return { persistence, store }
}
type Memory = ReturnType<typeof memoryPersistence>

const savedEnv = { svara: process.env.SVARA_TEST_ENABLED, bots: process.env.SVARA_TEST_BOTS_ENABLED, node: process.env.NODE_ENV }
process.env.SVARA_TEST_ENABLED = '1'
process.env.SVARA_TEST_BOTS_ENABLED = '1'
delete process.env.NODE_ENV

function mount(clock: Clock, memory: Memory, seed = 1) {
  const frames = new Map<string, SvaraLobbyServerMessage[]>()
  const faults: unknown[] = []
  let bots: SvaraTestBots | null = null
  const factory = createSvaraTestBotsFactory({ random: seeded(seed), onError: (cause) => faults.push(cause) })
  const lobby = createSvaraLobby({ persistence: memory.persistence, clock, hasOtherGameCommitment: () => false, onError: (cause) => faults.push(cause),
    testBots: (host, c) => (bots = factory(host, c)) })
  assert.equal(lobby.initializeRecovery(), 'ready')
  const attach = (id: string) => {
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: 'admin' }, profile: { profileId: id } }),
      send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const send = (id: string, message: Record<string, unknown>) => lobby.handle(id, message as SvaraLobbyClientMessage)
  const reconnect = (id: string) => { lobby.disconnect(id); attach(id); lobby.reconnect(id); send(id, { type: 'request_svara_tables_list' }); return frames.get(id)! }
  const shows = (id: string, matchId: string) => reconnect(id).some((f) => (f.type === 'svara_match_snapshot' && f.matchId === matchId)
    || (f.type === 'svara_tables_list' && f.tables.some((t) => t.matchId === matchId)))
  return { lobby, frames, faults, attach, send, reconnect, shows, get bots() { return bots! } }
}
type Harness = ReturnType<typeof mount>

const bot = (slot: number) => `svara-test-bot:${slot}:${randomUUID()}`
const state = (memory: Memory, matchId: string): SvaraMatchState => memory.store.get(matchId)!.state

/** Ledger: всяка сметка се връща към стековете, банките и 'removed' без загуба. */
function assertLedger(s: SvaraMatchState) {
  assertSvaraMatchInvariants(s)
  const book: Record<string, number> = {}
  for (const e of s.ledger) { book[e.from] = (book[e.from] ?? 0) - e.amount; book[e.to] = (book[e.to] ?? 0) + e.amount }
  for (const id of s.seats) assert.equal(book[`stack:${id}`] ?? 0, s.stacks[id], `ledger stack ${id}`)
  assert.equal(Object.values(book).reduce((a, b) => a + b, 0), 0, 'double entry')
  assert.equal(-(book['buy-in'] ?? 0), s.totalChips)
  assert.equal(s.lockedPots.length, 0, 'no locked pots left open')
  assert.equal(s.carried.length, 0, 'no carried pots left open')
}

/** Изходът трябва да прекрати мача СИНХРОННО, без победител, и да освободи всичко. */
function exitAndAssertAborted(t: Harness, clock: Clock, memory: Memory, matchId: string, human: string, label: string, mode: 'leave' | 'command' = 'leave') {
  const revisionBefore = memory.store.get(matchId)!.revision
  const beforeDiag = (() => { const b = state(memory, matchId); return { status: b.status, stacks: b.stacks, round: b.round?.kind, locked: b.lockedPots.length, carried: b.carried.length } })()
  t.frames.set(human, [])
  if (mode === 'leave') t.send(human, { type: 'leave_svara_table', matchId, requestId: `exit-${randomUUID()}` })
  else t.send(human, { type: 'submit_svara_command', matchId, commandId: `exit-${randomUUID()}`, expectedRevision: revisionBefore, command: { type: 'exit' } })
  const reply = t.frames.get(human)!
  assert(reply.some((f) => f.type === 'svara_table_left' && f.matchId === matchId), `${label}: back to the Svara lobby (${JSON.stringify(reply.map((f) => f.type))})`)
  if (mode === 'command') assert(reply.some((f) => f.type === 'svara_command_result' && f.status === 'applied'), `${label}: command acknowledged`)
  const s = state(memory, matchId)
  assert.equal(s.phase, 'finished', `${label}: finished immediately`)
  assert.equal(s.winnerId, null, `${label}: no fictitious winner`)
  // Прекратяване ('all-absent') — или, ако всички ботове вече са без чипове (напр. загубили
  // на сравняването), естественият край на engine-а без жив играч. И в двата случая — без победител.
  const botsEliminated = s.seats.filter((id) => id !== human).every((id) => s.status[id] === 'eliminated' || s.status[id] === 'exited')
  assert(s.finishReason === 'all-absent' || (s.finishReason == null && botsEliminated), `${label}: abort reason ${JSON.stringify({ reason: s.finishReason, status: s.status, before: beforeDiag })}`)
  assert.equal(s.status[human], 'exited')
  assert(memory.store.get(matchId)!.revision > revisionBefore, `${label}: persisted to SQLite`)
  assertLedger(s)
  // Нова маса — веднага, още преди асинхронното освобождаване.
  t.send(human, { type: 'create_svara_table', requestId: `new-${randomUUID()}`, capacity: 2, entryFee: 5000, startMode: 'manual' })
  const created = t.frames.get(human)!.findLast((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')
  assert.equal(created?.type, 'svara_table_updated', `${label}: new table immediately (${JSON.stringify(created)})`)
  const newId = (created as Extract<SvaraLobbyServerMessage, { type: 'svara_table_updated' }>).table.matchId
  t.send(human, { type: 'leave_svara_table', matchId: newId, requestId: `close-${randomUUID()}` })
  clock.advance(0)
  assert.equal(t.bots.pendingTimerCount(), 0, `${label}: bot timers released`)
  assert.equal(clock.jobs.size, 0, `${label}: no game timers left`)
  assert(!t.shows(human, matchId), `${label}: released, not restored on reconnect`)
  const historyRevision = memory.store.get(matchId)!.revision
  clock.advance(60_000)
  assert.equal(memory.store.get(matchId)!.revision, historyRevision, `${label}: history unchanged after release`)
  assert.deepEqual(t.faults, [], `${label}: faults`)
}

const results: string[] = []
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }

// ── Част А: фази ───────────────────────────────────────────────────────────

type Phase = 'dealing' | 'human-turn' | 'bot-turn' | 'reveal-choice' | 'reveal-display' | 'showdown-display' | 'payout-display' | 'svara-joining' | 'svara-deal' | 'svara-betting'
const TIE = ['KS QS JS', 'KH QH JH'], LOW = '8C 9D 10H'

/** Засява мач h + 2 бота до точно поисканата фаза през реалния runtime (без lobby). */
function seedPhase(clock: Clock, memory: Memory, phase: Phase): { matchId: string; human: string } {
  const human = 'h', b1 = bot(0), b2 = bot(1), seats = [human, b1, b2]
  const matchId = `phase-${phase}`
  const tie = phase.startsWith('svara') || phase === 'showdown-display' || phase === 'payout-display'
  const order = [b1, b2, human] // ред на раздаване при първи дилър = seats[0]
  const hands: Record<string, string> = tie ? { [b1]: TIE[0]!, [b2]: LOW, [human]: TIE[1]! } : { [b1]: 'AS AH AD', [b2]: LOW, [human]: 'KS QS JS' }
  const rt: SvaraMatchRuntime = createSvaraMatchRuntime({ persistence: memory.persistence, now: clock.now,
    random: deckRandom([buildSvaraDeckForHands(order, hands), buildSvaraDeckForHands(order, hands), buildSvaraDeckForHands(order, hands)]) })
  rt.registerMatch({ matchId, creator: { playerId: human }, capacity: 3, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  for (const id of [b1, b2]) rt.executeParticipantCommand(matchId, { playerId: id }, `join-${id}`, { type: 'join-seat' })
  let n = 0
  const sys = (command: Parameters<SvaraMatchRuntime['executeSystemCommand']>[2]) => rt.executeSystemCommand(matchId, `seed-${++n}`, command)
  const act = (id: string, command: Record<string, unknown>) => rt.executeParticipantCommand(matchId, { playerId: id }, `seed-${++n}`, command)
  const s = () => rt.exportInternalStateForServer(matchId)
  const round = () => s().round
  const reached = (): boolean => {
    const r = round()
    if (!r) return false
    if (phase === 'dealing') return (r.kind === 'ordinary') && !!r.dealing
    if (phase === 'human-turn') return r.kind === 'ordinary' && !r.dealing && r.betting.toAct === human
    if (phase === 'bot-turn') return r.kind === 'ordinary' && !r.dealing && r.betting.toAct !== human && r.betting.toAct !== null
    if (phase === 'reveal-choice') return r.kind === 'reveal-choice' && r.decision === 'pending'
    if (phase === 'reveal-display') return r.kind === 'reveal-choice' && r.decision === 'revealed'
    if (phase === 'showdown-display') return r.kind === 'showdown-display' && r.phase === 'showdown'
    if (phase === 'payout-display') return r.kind === 'showdown-display' && r.phase === 'payout'
    if (phase === 'svara-joining') return r.kind === 'svara-joining'
    if (phase === 'svara-deal') return r.kind === 'svara' && !!r.dealing
    return r.kind === 'svara' && !r.dealing && r.betting.toAct !== null
  }
  for (let step = 0; step < 80 && !reached(); step++) {
    const r = round()
    if (!r) { sys({ type: 'start-next-round' }); continue }
    if ((r.kind === 'ordinary' || r.kind === 'svara') && r.dealing) { sys({ type: 'finish-dealing', roundId: r.roundId }); continue }
    if (r.kind === 'ordinary' || r.kind === 'svara') {
      const actor = r.betting.toAct!
      const options = rt.getPlayerView(matchId, { playerId: actor }).options!
      // Към „Покажи/Скрий“: двама бягат; иначе пасивна игра до сравняване.
      if ((phase === 'reveal-choice' || phase === 'reveal-display') && actor !== b1) { act(actor, { type: 'act', action: { kind: 'fold' } }); continue }
      if (tie && actor === b2 && r.kind === 'ordinary') { act(actor, { type: 'act', action: { kind: 'fold' } }); continue }
      if (options.lookRequired) { act(actor, { type: 'look' }); continue }
      if (options.call !== null) act(actor, { type: 'act', action: { kind: 'call' } })
      else if (options.bet) act(actor, { type: 'act', action: { kind: 'bet', total: options.bet.min } })
      else act(actor, { type: 'act', action: { kind: 'no-bet' } })
      continue
    }
    if (r.kind === 'reveal-choice' && r.decision === 'pending') { act(r.winnerId, { type: 'reveal-cards' }); continue }
    if (r.kind === 'reveal-choice') { sys({ type: 'close-reveal-display', roundId: r.roundId }); continue }
    if (r.kind === 'showdown-display') { sys({ type: r.phase === 'showdown' ? 'advance-showdown-display' : 'close-payout-display', roundId: r.roundId }); continue }
    if (r.kind === 'svara-joining') { if (!r.closed) sys({ type: 'close-svara-joining', roundId: r.roundId }); else sys({ type: 'svara-start' }); continue }
    if (r.kind === 'allin-svara') { sys({ type: 'advance-allin-svara' }); continue }
  }
  assert(reached(), `seeded phase ${phase} reached (round=${JSON.stringify(round()?.kind)})`)
  return { matchId, human }
}

try {
  console.log('Svara test bots — immediate abort on the last human exit')

  const phases: Phase[] = ['dealing', 'human-turn', 'bot-turn', 'reveal-choice', 'reveal-display', 'showdown-display', 'payout-display', 'svara-joining', 'svara-deal', 'svara-betting']
  const covered: string[] = []
  for (const phase of phases) {
    const clock = new Clock(), memory = memoryPersistence()
    const { matchId, human } = seedPhase(clock, memory, phase)
    const t = mount(clock, memory)
    t.attach(human)
    t.lobby.reconnect(human)
    const roundKind = state(memory, matchId).round?.kind ?? null
    const lockedBefore = state(memory, matchId).lockedPots.length
    const mode = covered.length % 2 === 0 ? 'leave' : 'command'
    exitAndAssertAborted(t, clock, memory, matchId, human, phase, mode)
    covered.push(`${phase}${lockedBefore ? '(заключена банка)' : ''}${mode === 'command' ? '[exit команда]' : ''}`)
    assert(roundKind !== null)
    t.lobby.shutdown()
  }
  ok(`изход във всички фази → незабавен край без победител: ${covered.join(', ')}`)

  // ── Част Б: реални игри ───────────────────────────────────────────────────

  let serial = 0
  function drive(t: Harness, matchId: string, humans: string[], random: () => number) {
    for (const h of humans) {
      const snapshot = t.frames.get(h)!.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) as SvaraMatchSnapshotMessage | undefined
      if (!snapshot || !svaraTestBotHasDecision(snapshot)) continue
      const command = decideSvaraTestBotCommand(snapshot, random)
      if (command && command.type !== 'exit') t.send(h, { type: 'submit_svara_command', matchId, commandId: `c${++serial}`, expectedRevision: snapshot.revision, command })
    }
  }
  function createWithBots(t: Harness, host: string, capacity: 2 | 3 | 4) {
    t.send(host, { type: 'create_svara_table', requestId: `c-${randomUUID()}`, capacity, entryFee: 5000, startMode: 'auto' })
    const matchId = (t.frames.get(host)!.findLast((f) => f.type === 'svara_table_updated') as Extract<SvaraLobbyServerMessage, { type: 'svara_table_updated' }>).table.matchId
    return matchId
  }

  // 1 срещу 1/2/3 бота, изход в случайни моменти от реална игра.
  for (const capacity of [2, 3, 4] as const) {
    const exitsAt: string[] = []
    for (const stop of [7, 23, 61]) {
      const clock = new Clock(), memory = memoryPersistence()
      const t = mount(clock, memory, capacity * 100 + stop)
      t.attach('h')
      const matchId = createWithBots(t, 'h', capacity)
      t.send('h', { type: 'fill_svara_table_with_bots', matchId, requestId: 'fill' })
      assert.equal(state(memory, matchId).phase, 'in-progress')
      const random = seeded(stop)
      for (let i = 0; i < stop * 3 && state(memory, matchId).phase === 'in-progress' && state(memory, matchId).status.h === 'active'; i++) { drive(t, matchId, ['h'], random); clock.advance(350) }
      if (state(memory, matchId).phase !== 'in-progress') { t.lobby.shutdown(); continue }
      const r = state(memory, matchId).round
      exitsAt.push(r ? (r.kind === 'ordinary' || r.kind === 'svara') && r.dealing ? `${r.kind}/раздаване` : r.kind : 'граница')
      exitAndAssertAborted(t, clock, memory, matchId, 'h', `1v${capacity - 1}@${stop}`)
      t.lobby.shutdown()
    }
    assert(exitsAt.length >= 2, `1v${capacity - 1}: enough live exits`)
    ok(`1 човек срещу ${capacity - 1} бот(а): реален изход (${exitsAt.join(', ')}) → незабавен край, нова маса, без таймери`)
  }

  // Смесена маса: 2 души + 2 бота. Първият изход — мачът продължава; вторият — прекратява.
  {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount(clock, memory, 77)
    t.attach('h1'); t.attach('h2')
    const matchId = createWithBots(t, 'h1', 4)
    t.send('h2', { type: 'join_svara_table', matchId, requestId: 'join' })
    t.send('h1', { type: 'fill_svara_table_with_bots', matchId, requestId: 'fill' })
    const random = seeded(78)
    for (let i = 0; i < 60; i++) { drive(t, matchId, ['h1', 'h2'], random); clock.advance(350) }
    assert.equal(state(memory, matchId).phase, 'in-progress')
    // Временно прекъсване + reconnect на h2: не е изход, нищо не се прекратява.
    t.lobby.disconnect('h2')
    clock.advance(5_000)
    assert(t.shows('h2', matchId), 'reconnect restores the running match')
    assert.equal(state(memory, matchId).phase, 'in-progress', 'disconnect/reconnect does not abort')
    t.send('h1', { type: 'leave_svara_table', matchId, requestId: 'h1-exit' })
    assert.equal(state(memory, matchId).status.h1, 'exited')
    assert.equal(state(memory, matchId).phase, 'in-progress', 'another human remains: the match continues')
    assert(state(memory, matchId).seats.filter((id) => id.startsWith('svara-test-bot:')).every((id) => state(memory, matchId).status[id] !== 'absent'), 'bots were not marked absent')
    const revisionAfterFirstExit = memory.store.get(matchId)!.revision
    for (let i = 0; i < 30 && state(memory, matchId).phase === 'in-progress'; i++) { drive(t, matchId, ['h2'], random); clock.advance(350) }
    assert(memory.store.get(matchId)!.revision > revisionAfterFirstExit, 'bots keep playing with the remaining human')
    if (state(memory, matchId).phase === 'finished') assert(state(memory, matchId).winnerId !== null && !state(memory, matchId).finishReason, 'a natural end only, never the abort')
    if (state(memory, matchId).phase === 'in-progress' && (state(memory, matchId).status.h2 === 'active' || state(memory, matchId).status.h2 === 'absent')) exitAndAssertAborted(t, clock, memory, matchId, 'h2', 'mixed last human')
    t.lobby.shutdown()
    ok('смесена маса 2 души + 2 бота: първият изход — продължава; reconnect не прекратява; последният изход — незабавен край')
  }

  // Отсъствие (изтекъл ход) не е изход: мачът не се прекратява.
  {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount(clock, memory, 9)
    t.attach('h')
    const matchId = createWithBots(t, 'h', 3)
    t.send('h', { type: 'fill_svara_table_with_bots', matchId, requestId: 'fill' })
    t.lobby.disconnect('h')
    clock.advance(60_000)
    assert.equal(state(memory, matchId).phase, 'in-progress', 'timeouts/absence never abort the match')
    assert.equal(state(memory, matchId).status.h, 'absent')
    const snapshot = t.reconnect('h').findLast((f) => f.type === 'svara_match_snapshot') as SvaraMatchSnapshotMessage
    t.send('h', { type: 'submit_svara_command', matchId, commandId: 'back', expectedRevision: snapshot.revision, command: { type: 'request-return' } })
    for (let i = 0; i < 120 && state(memory, matchId).status.h !== 'active'; i++) clock.advance(1_000)
    assert.equal(state(memory, matchId).status.h, 'active', 'the absent human returns normally at the next deal')
    exitAndAssertAborted(t, clock, memory, matchId, 'h', 'after return')
    t.lobby.shutdown()
    ok('отсъствие/изтекъл ход не прекратява; връщането работи; изходът след това прекратява')
  }

  // Маса само с хора: поведението е непроменено (изходът дава победител).
  {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount(clock, memory, 5)
    t.attach('a'); t.attach('b')
    t.send('a', { type: 'create_svara_table', requestId: 'c', capacity: 2, entryFee: 5000, startMode: 'auto' })
    const matchId = (t.frames.get('a')!.findLast((f) => f.type === 'svara_table_updated') as Extract<SvaraLobbyServerMessage, { type: 'svara_table_updated' }>).table.matchId
    t.send('b', { type: 'join_svara_table', matchId, requestId: 'j' })
    clock.advance(8_000)
    t.send('a', { type: 'leave_svara_table', matchId, requestId: 'exit' })
    clock.advance(30_000)
    const s = state(memory, matchId)
    assert.equal(s.phase, 'finished')
    assert.equal(s.winnerId, 'b', 'humans-only: the remaining player wins as before')
    assert.equal(s.finishReason ?? null, null)
    assert(!s.ledger.some((e) => e.commandId.includes('test-bot-abort')), 'abort path never used')
    t.lobby.shutdown()
    ok('маса само с хора: без промяна (изходът дава победител, без прекратяване)')
  }

  console.log(`\nSvara test bot abort: ${results.length}/${results.length} passed`)
} finally {
  for (const [key, value] of [['SVARA_TEST_ENABLED', savedEnv.svara], ['SVARA_TEST_BOTS_ENABLED', savedEnv.bots], ['NODE_ENV', savedEnv.node]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

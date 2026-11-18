/**
 * Свара — приключили/прекратени маси: изход, освобождаване от RAM, без
 * възстановяване след напускане, запазена SQLite история, връщане на временно
 * отсъстващ играч в незавършен мач. Реален lobby + runtime + lifecycle +
 * persistence порт (in-memory), контролиран часовник.
 */
import assert from 'node:assert/strict'
import { createSvaraLobby, SVARA_FINISHED_REVIEW_RETENTION_MS } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { SVARA_PRESENCE_WAIT_MS } from '../src/games/svara/runtime/svaraDeadlines.js'
import type { SvaraMatchPersistence, SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import type { SvaraLobbyClientMessage, SvaraLobbyServerMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import { createSvaraTestBotsFactory } from '../src/games/svara/testBots/createSvaraTestBots.js'

type Job = { at: number; order: number; callback: () => void }
class Clock implements SvaraClock {
  time = 50_000_000
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

function memoryPersistence() {
  const store = new Map<string, SvaraStoredMatch>()
  const persistence: SvaraMatchPersistence = {
    save(snapshot) { store.set(snapshot.matchId, structuredClone(snapshot)) },
    load: (matchId) => structuredClone(store.get(matchId) ?? null),
    loadActiveMatches: () => [...store.values()].filter((s) => s.state.phase === 'lobby' || s.state.phase === 'in-progress').map((s) => structuredClone(s)),
    findActiveMatchId: (playerId) => [...store.values()].find((s) => (s.state.phase === 'lobby' || s.state.phase === 'in-progress')
      && ['active', 'absent'].includes(s.state.status[playerId] ?? ''))?.matchId ?? null,
  }
  return { persistence, store }
}

const savedEnv = { svara: process.env.SVARA_TEST_ENABLED, bots: process.env.SVARA_TEST_BOTS_ENABLED, node: process.env.NODE_ENV }
process.env.SVARA_TEST_ENABLED = '1'
process.env.SVARA_TEST_BOTS_ENABLED = '1'
delete process.env.NODE_ENV

function mount(clock: Clock, memory: ReturnType<typeof memoryPersistence>) {
  const frames = new Map<string, SvaraLobbyServerMessage[]>()
  const faults: unknown[] = []
  const lobby = createSvaraLobby({ persistence: memory.persistence, clock, hasOtherGameCommitment: () => false, onError: (cause) => faults.push(cause),
    testBots: createSvaraTestBotsFactory({ random: () => 0.5, onError: (cause) => faults.push(cause) }) })
  assert.equal(lobby.initializeRecovery(), 'ready')
  const attach = (id: string) => {
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: 'admin' }, profile: { profileId: id } }),
      send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const send = (id: string, message: Record<string, unknown>) => lobby.handle(id, message as SvaraLobbyClientMessage)
  /** Ново свързване (refresh/reconnect): какво получава клиентът. */
  const reconnect = (id: string) => {
    lobby.disconnect(id)
    attach(id)
    lobby.reconnect(id)
    send(id, { type: 'request_svara_tables_list' })
    return frames.get(id)!
  }
  return { lobby, frames, faults, attach, send, reconnect }
}

/** Валиден мач през реалния runtime: старт, после отсъствие на `absent`, със срок за присъствие, изтекъл преди `clock`. */
function seed(memory: ReturnType<typeof memoryPersistence>, clock: Clock, matchId: string, seats: string[], absent: string[], expired = true) {
  const now = expired ? clock.time - SVARA_PRESENCE_WAIT_MS - 60_000 : clock.time
  const runtime = createSvaraMatchRuntime({ persistence: memory.persistence, now: () => now })
  runtime.registerMatch({ matchId, creator: { playerId: seats[0]! }, capacity: seats.length as 2 | 3 | 4, entryFee: 5000, entryPercent: 1, startMode: 'auto' })
  for (const playerId of seats.slice(1)) runtime.executeParticipantCommand(matchId, { playerId }, `join-${playerId}`, { type: 'join-seat' })
  for (const playerId of absent) runtime.executeSystemCommand(matchId, `absent-${playerId}`, { type: 'set-absent', playerId, absent: true })
}

const shows = (frames: SvaraLobbyServerMessage[], matchId: string) =>
  frames.some((f) => (f.type === 'svara_match_snapshot' && f.matchId === matchId)
    || (f.type === 'svara_tables_list' && f.tables.some((t) => t.matchId === matchId)))
const lastSnapshot = (frames: SvaraLobbyServerMessage[], matchId: string) =>
  frames.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) as Extract<SvaraLobbyServerMessage, { type: 'svara_match_snapshot' }> | undefined

const results: string[] = []
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }

try {
  console.log('Svara finished-table release')

  // 1. all-absent (production случаят): прекратен при възстановяване; A се връща,
  //    вижда резултата, излиза; B никога не се връща → освобождаване след срока.
  {
    const clock = new Clock(), memory = memoryPersistence()
    seed(memory, clock, 'all-absent', ['a', 'b'], ['a', 'b'])
    const t = mount(clock, memory)
    const saved = memory.store.get('all-absent')!
    assert.equal(saved.state.phase, 'finished')
    assert.equal(saved.state.finishReason, 'all-absent')
    const seen = t.reconnect('a')
    const snapshot = lastSnapshot(seen, 'all-absent')
    assert(snapshot?.result.finished && snapshot.result.aborted, 'returning participant sees the aborted result')
    t.frames.set('a', [])
    t.send('a', { type: 'leave_svara_table', matchId: 'all-absent', requestId: 'leave' })
    assert.equal(t.frames.get('a')![0]!.type, 'svara_table_left', 'exit closes the finished table')
    assert(!shows(t.reconnect('a'), 'all-absent'), 'a left match is not restored on reconnect')
    assert(!shows(t.reconnect('a'), 'all-absent'), 'nor on a second refresh')
    // B още не е затворил → прегледът му е достъпен в рамките на срока.
    assert(shows(t.reconnect('b'), 'all-absent'), 'b can still review within the retention window')
    t.lobby.disconnect('b')
    clock.advance(SVARA_FINISHED_REVIEW_RETENTION_MS)
    assert.equal(clock.jobs.size, 0, 'no timers left after release')
    assert(!shows(t.reconnect('b'), 'all-absent'), 'released from RAM: b is no longer restored')
    t.frames.set('b', [])
    t.send('b', { type: 'leave_svara_table', matchId: 'all-absent', requestId: 'late-leave' })
    assert.equal(t.frames.get('b')![0]!.type, 'svara_table_left', 'a stale client still gets a clean exit from the SQLite archive')
    assert.equal(memory.store.get('all-absent')!.state.phase, 'finished', 'SQLite history retained')
    assert.equal(memory.store.get('all-absent')!.revision, saved.revision, 'release does not rewrite history')
    t.send('a', { type: 'create_svara_table', requestId: 'again', capacity: 2, entryFee: 5000, startMode: 'auto' })
    assert.equal(t.frames.get('a')!.findLast((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')!.type, 'svara_table_updated', 'a new table can be created')
    assert.deepEqual(t.faults, [])
    t.lobby.shutdown()
    ok('all-absent: преглед → Изход → svara_table_left; без възстановяване; освобождаване от RAM след срока; SQLite история; нова маса')
  }

  // 2. Всички отсъстват и никой не се връща → освобождаване без никакво действие.
  {
    const clock = new Clock(), memory = memoryPersistence()
    seed(memory, clock, 'nobody', ['a', 'b', 'c'], ['a', 'b', 'c'])
    const t = mount(clock, memory)
    assert.equal(memory.store.get('nobody')!.state.finishReason, 'all-absent')
    clock.advance(SVARA_FINISHED_REVIEW_RETENTION_MS - 1)
    assert(shows(t.reconnect('c'), 'nobody'), 'still reviewable just before the retention limit')
    t.lobby.disconnect('c')
    clock.advance(1)
    assert.equal(clock.jobs.size, 0)
    for (const id of ['a', 'b', 'c']) assert(!shows(t.reconnect(id), 'nobody'), `${id}: released`)
    t.lobby.shutdown()
    ok('all-absent без завръщане: мачът се освобождава от RAM след срока, без нито едно действие')
  }

  // 3. prolonged-absence: победителят и отсъстващият излизат; последният освобождава веднага.
  {
    const clock = new Clock(), memory = memoryPersistence()
    seed(memory, clock, 'prolonged', ['a', 'b'], ['a'])
    const t = mount(clock, memory)
    const state = memory.store.get('prolonged')!.state
    assert.equal(state.finishReason, 'prolonged-absence')
    assert.equal(state.winnerId, 'b')
    const loser = lastSnapshot(t.reconnect('a'), 'prolonged')
    assert(loser?.result.finished && !loser.result.aborted && loser.result.winnerId === 'b')
    t.send('a', { type: 'leave_svara_table', matchId: 'prolonged', requestId: 'la' })
    t.reconnect('b')
    t.frames.set('b', [])
    t.send('b', { type: 'leave_svara_table', matchId: 'prolonged', requestId: 'lb' })
    assert.equal(t.frames.get('b')![0]!.type, 'svara_table_left')
    assert.equal(clock.jobs.size, 0, 'last dismissal releases immediately and cancels the retention timer')
    assert(!shows(t.reconnect('a'), 'prolonged') && !shows(t.reconnect('b'), 'prolonged'))
    t.lobby.shutdown()
    ok('prolonged-absence: двамата излизат, последният освобождава мача веднага')
  }

  // 4. Нормално приключване чрез напускане по време на игра: изходът на
  //    противника приключва мача; победителят излиза → освобождаване.
  {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount(clock, memory)
    t.attach('a'); t.attach('b')
    t.send('a', { type: 'create_svara_table', requestId: 'c', capacity: 2, entryFee: 5000, startMode: 'auto' })
    const matchId = (t.frames.get('a')!.findLast((f) => f.type === 'svara_table_updated') as Extract<SvaraLobbyServerMessage, { type: 'svara_table_updated' }>).table.matchId
    t.send('b', { type: 'join_svara_table', matchId, requestId: 'j' })
    clock.advance(10_000)
    t.send('a', { type: 'leave_svara_table', matchId, requestId: 'exit-in-progress' })
    clock.advance(30_000)
    assert.equal(memory.store.get(matchId)!.state.phase, 'finished')
    assert.equal(memory.store.get(matchId)!.state.status.a, 'exited')
    assert(!shows(t.reconnect('a'), matchId), 'the exited player is not restored')
    assert(lastSnapshot(t.reconnect('b'), matchId)?.result.finished, 'the winner sees the result')
    t.send('b', { type: 'leave_svara_table', matchId, requestId: 'done' })
    clock.advance(1)
    assert.equal(clock.jobs.size, 0)
    assert(!shows(t.reconnect('b'), matchId))
    t.send('b', { type: 'create_svara_table', requestId: 'again', capacity: 2, entryFee: 5000, startMode: 'auto' })
    assert.equal(t.frames.get('b')!.findLast((f) => f.type === 'svara_table_updated' || f.type === 'svara_lobby_error')!.type, 'svara_table_updated')
    t.lobby.shutdown()
    ok('нормален край (изход на противника): победителят излиза → освобождаване; нова маса')
  }

  // 5. Незавършен мач: временно отсъстващ играч все още може да се върне.
  {
    const clock = new Clock(), memory = memoryPersistence()
    seed(memory, clock, 'return', ['a', 'b'], ['a'], false)
    const t = mount(clock, memory)
    assert.equal(memory.store.get('return')!.state.phase, 'in-progress')
    const snapshot = lastSnapshot(t.reconnect('a'), 'return')
    assert(snapshot && !snapshot.result.finished && snapshot.you.status === 'absent' && !snapshot.you.returnPending)
    t.send('a', { type: 'submit_svara_command', matchId: 'return', commandId: 'back', expectedRevision: snapshot.revision, command: { type: 'request-return' } })
    clock.advance(1_000)
    const state = memory.store.get('return')!.state
    assert.equal(state.status.a, 'active', 'the absent player returned to the unfinished match')
    assert.equal(state.phase, 'in-progress')
    t.lobby.shutdown()
    ok('незавършен мач: „Върни се“ на временно отсъстващ играч работи както преди')
  }

  // 6. Тестови ботове: човекът отсъства, ботът печели; затварянето от човека освобождава
  //    веднага (ботът не може да затвори); без човешко затваряне — след срока.
  for (const humanDismisses of [true, false]) {
    const clock = new Clock(), memory = memoryPersistence()
    const bot = 'svara-test-bot:0:00000000-0000-4000-8000-000000000000'
    seed(memory, clock, 'bots', ['h', bot], ['h'])
    const t = mount(clock, memory)
    const state = memory.store.get('bots')!.state
    assert.equal(state.finishReason, 'prolonged-absence')
    assert.equal(state.winnerId, bot)
    if (humanDismisses) {
      assert(lastSnapshot(t.reconnect('h'), 'bots')?.result.finished)
      t.send('h', { type: 'leave_svara_table', matchId: 'bots', requestId: 'leave' })
      assert.equal(clock.jobs.size, 0, 'bot does not hold the match in RAM')
    } else {
      clock.advance(SVARA_FINISHED_REVIEW_RETENTION_MS)
      assert.equal(clock.jobs.size, 0)
    }
    assert(!shows(t.reconnect('h'), 'bots'))
    assert.equal(memory.store.get('bots')!.state.phase, 'finished')
    assert.deepEqual(t.faults, [])
    t.lobby.shutdown()
  }
  ok('маса с бот: човешкото затваряне освобождава веднага; иначе след срока; без бот таймери')

  console.log(`\nSvara finished-table release: ${results.length}/${results.length} passed`)
} finally {
  for (const [key, value] of [['SVARA_TEST_ENABLED', savedEnv.svara], ['SVARA_TEST_BOTS_ENABLED', savedEnv.bots], ['NODE_ENV', savedEnv.node]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

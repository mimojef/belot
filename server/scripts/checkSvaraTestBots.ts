/**
 * ВРЕМЕННО — проверки за тестовите ботове в Свара (docs/svara-test-bots-local.md).
 * Премахва се заедно с модула testBots/.
 *
 * Реален lobby + runtime + lifecycle + persistence порт (in-memory), с
 * контролиран часовник. Хората се управляват само от получените по
 * „мрежата“ snapshot кадри — както истински клиент.
 */
import assert from 'node:assert/strict'
import { createSvaraLobby, SVARA_FINISHED_REVIEW_RETENTION_MS } from '../src/games/svara/createSvaraLobby.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import type { SvaraMatchPersistence, SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import { parseSvaraLobbyMessage, type SvaraLobbyClientMessage, type SvaraLobbyServerMessage } from '../src/games/svara/protocol/svaraLobbyProtocol.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS, type SvaraMatchSnapshotMessage, type SvaraPublicTable } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { assertSvaraMatchInvariants, type SvaraMatchState } from '../src/games/svara/engine/svaraMatch.js'
import { createSvaraTestBotsFactory, SVARA_TEST_BOT_DELAY_MS, SVARA_TEST_BOT_FOLLOW_UP_DELAY_MS, type SvaraTestBots } from '../src/games/svara/testBots/createSvaraTestBots.js'
import { createSvaraTestBotIds, getSvaraTestBotProfile, isSvaraTestBotId } from '../src/games/svara/testBots/svaraTestBotIdentity.js'
import { decideSvaraTestBotCommand, svaraTestBotHasDecision, type SvaraTestBotCommand } from '../src/games/svara/testBots/svaraTestBotStrategy.js'
import { isSvaraTestBotsEnabled } from '../src/games/svara/testBots/svaraTestBotsFeatureFlag.js'

// ── Помощни ─────────────────────────────────────────────────────────────────

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Job = { at: number; order: number; callback: () => void }
class Clock implements SvaraClock {
  time = 1_000_000
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
  const saveTimes: number[] = []
  let clock: Clock | null = null
  const persistence: SvaraMatchPersistence = {
    save(snapshot, expectedRevision) {
      const current = store.get(snapshot.matchId)
      assert.equal(current?.revision ?? null, expectedRevision, 'persistence revision chain')
      store.set(snapshot.matchId, structuredClone(snapshot))
      if (clock) saveTimes.push(clock.now())
    },
    load: (matchId) => structuredClone(store.get(matchId) ?? null),
    loadActiveMatches: () => [...store.values()].filter((s) => s.state.phase === 'lobby' || s.state.phase === 'in-progress').map((s) => structuredClone(s)),
    findActiveMatchId: (playerId) => [...store.values()].find((s) => (s.state.phase === 'lobby' || s.state.phase === 'in-progress')
      && ['active', 'absent'].includes(s.state.status[playerId] ?? ''))?.matchId ?? null,
  }
  return { persistence, store, saveTimes, bindClock(next: Clock) { clock = next } }
}

type BotCall = { at: number; botId: string; command: SvaraTestBotCommand; sinceLastSave: number }
const allBotCalls: BotCall[] = []
let hiddenCardChecks = 0

function mount(options: { clock: Clock; memory: ReturnType<typeof memoryPersistence>; seed: number; isEnabled?: () => boolean }) {
  const frames = new Map<string, SvaraLobbyServerMessage[]>()
  const roles = new Map<string, string>()
  const faults: unknown[] = []
  const profileLookups: string[] = []
  let bots: SvaraTestBots | null = null
  let hostKeys: string[] = []
  options.memory.bindClock(options.clock)
  const factory = createSvaraTestBotsFactory({ random: seeded(options.seed), isEnabled: options.isEnabled, onError: (cause) => faults.push(cause) })
  const lobby = createSvaraLobby({
    persistence: options.memory.persistence,
    clock: options.clock,
    hasOtherGameCommitment: () => false,
    getPublicProfile: (id) => { profileLookups.push(id); return { displayName: `Човек ${id}`, avatarUrl: null } },
    onError: (cause) => faults.push(cause),
    testBots: (host, clock) => {
      hostKeys = Object.keys(host).sort()
      // Шпионин: само наблюдава какво ботът вижда и кога действа.
      const observed = {
        ...host,
        getBotSnapshot(matchId: string, botId: string) {
          const snapshot = host.getBotSnapshot(matchId, botId)
          assertNoHiddenCards(options.memory.store.get(matchId)!.state, snapshot, botId)
          return snapshot
        },
        submit(matchId: string, botId: string, command: SvaraTestBotCommand, expectedRevision: number) {
          const at = clock.now()
          const previous = options.memory.saveTimes.filter((time) => time < at).at(-1) ?? at
          allBotCalls.push({ at, botId, command, sinceLastSave: at - previous })
          host.submit(matchId, botId, command, expectedRevision)
        },
      }
      bots = factory(observed, clock)
      return bots
    },
  })
  assert.equal(lobby.initializeRecovery(), 'ready')
  function attach(id: string, role = 'admin') {
    roles.set(id, role)
    frames.set(id, [])
    lobby.attachConnection(id, { profileId: id, getSession: () => ({ account: { role: roles.get(id)! }, profile: { profileId: id } }),
      send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
  }
  const send = (id: string, message: Record<string, unknown>) => lobby.handle(id, message as SvaraLobbyClientMessage)
  const last = <T extends SvaraLobbyServerMessage['type']>(id: string, type: T) =>
    frames.get(id)!.findLast((frame) => frame.type === type) as Extract<SvaraLobbyServerMessage, { type: T }> | undefined
  return { lobby, frames, roles, attach, send, last, faults, profileLookups, get bots() { return bots! }, get hostKeys() { return hostKeys } }
}
type Harness = ReturnType<typeof mount>

function assertNoHiddenCards(state: SvaraMatchState, snapshot: SvaraMatchSnapshotMessage, botId: string) {
  assert.equal(snapshot.you.playerId, botId, 'a bot reads only its own snapshot')
  const json = JSON.stringify(snapshot)
  for (const key of SVARA_SNAPSHOT_FORBIDDEN_KEYS) assert(!json.includes(`"${key}":`), `bot snapshot exposes ${key}`)
  const round = state.round
  if (round && (round.kind === 'ordinary' || round.kind === 'svara')) {
    const own = new Set(round.hands[botId] ?? [])
    if (snapshot.you.cards) assert.deepEqual([...snapshot.you.cards].sort(), [...own].sort(), 'bot sees only its own hand')
    for (const [playerId, hand] of Object.entries(round.hands)) {
      if (playerId === botId) continue
      for (const card of hand) if (!own.has(card)) assert(!json.includes(`"${card}"`), `bot snapshot leaks ${playerId}'s card`)
    }
    hiddenCardChecks++
  }
}

let commandSerial = 0
/** Хората действат само по последния получен snapshot кадър (като истински клиент). */
function driveHumans(t: Harness, matchId: string, humans: string[], random: () => number) {
  for (const human of humans) {
    const snapshot = t.frames.get(human)!.findLast((frame) => frame.type === 'svara_match_snapshot' && frame.matchId === matchId) as SvaraMatchSnapshotMessage | undefined
    if (!snapshot || !svaraTestBotHasDecision(snapshot)) continue
    const pendingRevision = (t.frames.get(human)! as Array<{ type: string; revision?: number; humanSent?: number }>)
    if (pendingRevision.some((frame) => frame.type === '__sent' && frame.revision === snapshot.revision)) continue
    const command = decideSvaraTestBotCommand(snapshot, random)
    if (!command) continue
    ;(t.frames.get(human)! as unknown as Array<{ type: string; revision: number }>).push({ type: '__sent', revision: snapshot.revision })
    t.send(human, { type: 'submit_svara_command', matchId, commandId: `h${++commandSerial}`, expectedRevision: snapshot.revision, command })
  }
}

function state(memory: ReturnType<typeof memoryPersistence>, matchId: string): SvaraMatchState {
  return memory.store.get(matchId)!.state
}

function createTable(t: Harness, host: string, capacity: 2 | 3 | 4, startMode: 'auto' | 'manual'): string {
  t.send(host, { type: 'create_svara_table', requestId: `create-${host}`, capacity, entryFee: 5000, startMode })
  const created = t.last(host, 'svara_table_updated')
  assert(created, 'table created')
  return created.table.matchId
}

/** Играе до край; след maxRounds раздавания хората излизат (ботовете трябва да последват). */
function playToFinish(t: Harness, clock: Clock, memory: ReturnType<typeof memoryPersistence>, matchId: string, humans: string[], seed: number, maxRounds = 25) {
  const random = seeded(seed)
  let exited = false
  for (let step = 0; step < 40_000; step++) {
    const current = state(memory, matchId)
    assertSvaraMatchInvariants(current)
    if (current.phase === 'finished') return { exitedEarly: exited, rounds: current.history.length }
    if (!exited && current.history.length >= maxRounds) {
      exited = true
      for (const human of humans) if (['active', 'absent'].includes(current.status[human]!)) {
        t.send(human, { type: 'submit_svara_command', matchId, commandId: `exit-${human}-${++commandSerial}`, expectedRevision: memory.store.get(matchId)!.revision, command: { type: 'exit' } })
      }
    }
    if (!exited) driveHumans(t, matchId, humans, random)
    clock.advance(200)
  }
  assert.fail(`match ${matchId} did not finish`)
}

function assertResourcesReleased(t: Harness, clock: Clock, label: string) {
  assert.equal(t.bots.pendingTimerCount(), 0, `${label}: bot timers released`)
  // Остава само таймерът за освобождаване на приключилия мач от RAM.
  assert(clock.jobs.size <= 1, `${label}: only the finished-match release timer remains`)
  clock.advance(SVARA_FINISHED_REVIEW_RETENTION_MS)
  assert.equal(clock.jobs.size, 0, `${label}: no live timers after the match`)
}

function assertEqualStartAndAnte(memory: ReturnType<typeof memoryPersistence>, matchId: string) {
  const s = state(memory, matchId)
  const starting = s.ledger.filter((entry) => entry.type === 'starting-chips')
  assert.equal(starting.length, s.seats.length, 'every seat, bot or human, gets starting chips')
  assert(starting.every((entry) => entry.amount === s.startingChips), 'same virtual starting chips for bots')
  const firstRound = s.ledger.find((entry) => entry.type === 'entry')?.roundId
  const antes = s.ledger.filter((entry) => entry.type === 'entry' && entry.roundId === firstRound)
  assert.equal(antes.length, s.seats.length, 'every seat pays the ante in the first deal')
  assert(antes.every((entry) => entry.amount === s.entryChips), 'bots pay the same ante')
}

const results: string[] = []
const ok = (name: string) => { results.push(name); console.log(`  ✓ ${name}`) }

// ── Среда ───────────────────────────────────────────────────────────────────

const savedEnv = { svara: process.env.SVARA_TEST_ENABLED, bots: process.env.SVARA_TEST_BOTS_ENABLED, node: process.env.NODE_ENV }
process.env.SVARA_TEST_ENABLED = '1'
process.env.SVARA_TEST_BOTS_ENABLED = '1'
delete process.env.NODE_ENV

try {
  console.log('Svara test bots')

  // 1. Флаг
  assert.equal(isSvaraTestBotsEnabled(), true)
  process.env.NODE_ENV = 'production'
  assert.equal(isSvaraTestBotsEnabled(), false, 'never in production')
  delete process.env.NODE_ENV
  process.env.SVARA_TEST_BOTS_ENABLED = 'true'
  assert.equal(isSvaraTestBotsEnabled(), false, 'only exact "1"')
  process.env.SVARA_TEST_BOTS_ENABLED = '1'
  process.env.SVARA_TEST_ENABLED = '0'
  assert.equal(isSvaraTestBotsEnabled(), false, 'requires the Svara test flag')
  process.env.SVARA_TEST_ENABLED = '1'
  ok('флаг: само "1" + SVARA_TEST_ENABLED + не-production')

  // 2. Идентичност
  const ids = createSvaraTestBotIds([], 3, seeded(1))
  assert.equal(new Set(ids).size, 3)
  assert(ids.every((id) => isSvaraTestBotId(id) && id.length <= 64))
  assert.equal(new Set(ids.map((id) => getSvaraTestBotProfile(id)!.displayName)).size, 3, 'unique names per table')
  assert(ids.every((id) => getSvaraTestBotProfile(id)!.displayName.startsWith('Бот ')))
  assert.equal(isSvaraTestBotId('svara-test-bot:9:x'), false)
  assert.equal(isSvaraTestBotId('6f1d3c1e-0000-4000-8000-000000000000'), false)
  ok('идентичност: уникални имена „Бот …“, аватари, без профили')

  // 3. Сигурност на командата
  {
    const clock = new Clock(), memory = memoryPersistence()
    let enabled = true
    const t = mount({ clock, memory, seed: 3, isEnabled: () => enabled })
    t.attach('host'); t.attach('sub', 'subadmin'); t.attach('other')
    const matchId = createTable(t, 'host', 4, 'manual')
    const fill = (id: string, requestId = `fill-${++commandSerial}`) => t.send(id, { type: 'fill_svara_table_with_bots', matchId, requestId })
    const lastError = (id: string) => t.last(id, 'svara_lobby_error')?.code
    assert.equal(t.last('host', 'svara_table_updated')!.table.testBotFill, true, 'button only for the admin creator')
    t.send('other', { type: 'request_svara_tables_list' })
    assert.equal(t.last('other', 'svara_tables_list')!.tables.find((x: SvaraPublicTable) => x.matchId === matchId)!.testBotFill, undefined, 'no button for others')
    enabled = false
    fill('host'); assert.equal(lastError('host'), 'feature_disabled')
    t.send('host', { type: 'request_svara_tables_list' })
    assert.equal(t.last('host', 'svara_tables_list')!.tables[0]!.testBotFill, undefined, 'no button while disabled')
    enabled = true
    t.send('other', { type: 'join_svara_table', matchId, requestId: 'join-other' })
    fill('other'); assert.equal(lastError('other'), 'not_allowed', 'admin, but not the creator')
    t.roles.set('host', 'subadmin')
    fill('host'); assert.equal(lastError('host'), 'forbidden_role', 'creator, but not admin')
    t.roles.set('host', 'admin')
    assert.equal(parseSvaraLobbyMessage({ type: 'fill_svara_table_with_bots', matchId: '', requestId: 'x' }), null)
    assert.deepEqual(parseSvaraLobbyMessage({ type: 'fill_svara_table_with_bots', matchId, requestId: 'x', playerId: 'evil', count: 99 }),
      { type: 'fill_svara_table_with_bots', matchId, requestId: 'x' }, 'no forged fields')
    assert.equal(state(memory, matchId).seats.length, 2, 'rejected requests seat nobody')
    fill('host')
    const seats = state(memory, matchId).seats
    assert.equal(seats.length, 4)
    assert.equal(seats.filter(isSvaraTestBotId).length, 2, 'only the free seats')
    assert.equal(state(memory, matchId).phase, 'lobby', 'manual start waits for the creator')
    fill('host'); assert.equal(lastError('host'), 'table_full')
    const table = t.last('host', 'svara_table_updated')!.table
    assert.equal(table.testBotFill, undefined)
    assert(table.players.filter((p) => p.isBot).every((p) => p.displayName?.startsWith('Бот ') && p.avatarUrl?.startsWith('/assets/avatars/')))
    assert(!t.profileLookups.some(isSvaraTestBotId), 'bots never touch the profile store')
    t.send('host', { type: 'start_svara_table', matchId, requestId: 'start' })
    assert.equal(state(memory, matchId).phase, 'in-progress')
    fill('host'); assert.equal(lastError('host'), 'wrong_phase')
    assert.deepEqual(t.hostKeys, ['getBotSnapshot', 'getPublicTable', 'hasMatch', 'submit'], 'bots get no raw state or system commands')
    t.lobby.shutdown()
    assert.equal(t.bots.pendingTimerCount(), 0, 'shutdown releases bot timers')
    ok('сигурност: флаг, admin, създател, фаза, пълна маса, без подправени полета, shutdown')
  }

  // 4. 1 човек срещу 1/2/3 бота, автоматичен старт
  for (const capacity of [2, 3, 4] as const) {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount({ clock, memory, seed: 10 + capacity })
    t.attach('host')
    const matchId = createTable(t, 'host', capacity, 'auto')
    t.send('host', { type: 'fill_svara_table_with_bots', matchId, requestId: 'fill' })
    assert.equal(state(memory, matchId).phase, 'in-progress', 'auto start on fill')
    assert.equal(state(memory, matchId).seats.filter(isSvaraTestBotId).length, capacity - 1)
    const result = playToFinish(t, clock, memory, matchId, ['host'], 100 + capacity)
    assertEqualStartAndAnte(memory, matchId)
    assertResourcesReleased(t, clock, `1v${capacity - 1}`)
    assert.equal(t.faults.length, 0, `faults: ${t.faults.map(String).join(', ')}`)
    // Финален резултат: човекът затваря прегледа; мачът се освобождава от RAM.
    t.send('host', { type: 'leave_svara_table', matchId, requestId: 'dismiss' })
    t.send('host', { type: 'request_svara_tables_list' })
    assert(!t.last('host', 'svara_tables_list')!.tables.some((x: SvaraPublicTable) => x.matchId === matchId), 'finished bot match released')
    ok(`1 човек срещу ${capacity - 1} бот(а): авто старт, ${result.rounds} раздавания, ${result.exitedEarly ? 'изход на човека → ботовете излизат' : 'игра до победител'}`)
  }

  // 5. Смесена маса, ръчен старт, reconnect
  {
    const clock = new Clock(), memory = memoryPersistence()
    const t = mount({ clock, memory, seed: 77 })
    t.attach('host'); t.attach('p1', 'subadmin')
    const random = seeded(78)
    const stillPlaying = (id: string) => ['active', 'absent'].includes(state(memory, matchId).status[id]!)
    let matchId = ''
    // Рядко и двамата души отпадат още в 1-вото раздаване (ол-ин) — тогава нова маса.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (matchId) for (const id of ['host', 'p1']) t.send(id, { type: 'leave_svara_table', matchId, requestId: `dismiss-${id}-${attempt}` })
      matchId = createTable(t, 'host', 4, 'manual')
      t.send('p1', { type: 'join_svara_table', matchId, requestId: `join-${attempt}` })
      t.send('host', { type: 'fill_svara_table_with_bots', matchId, requestId: `fill-${attempt}` })
      assert.equal(state(memory, matchId).phase, 'lobby')
      clock.advance(10_000)
      assert.equal(t.bots.pendingTimerCount(), 0, 'no bot activity before start')
      t.send('host', { type: 'start_svara_table', matchId, requestId: `start-${attempt}` })
      assert.equal(state(memory, matchId).phase, 'in-progress')
      for (let i = 0; i < 5_000 && state(memory, matchId).history.length < 1; i++) { driveHumans(t, matchId, ['host', 'p1'], random); clock.advance(200) }
      if (stillPlaying('host') || stillPlaying('p1')) break
      for (let i = 0; i < 5_000 && state(memory, matchId).phase !== 'finished'; i++) clock.advance(200)
    }
    // Един активен човек губи връзката за 10 сек (под 15-сек ход): ботовете и
    // другият човек продължават; после той се връща и получава състоянието.
    const who = (['p1', 'host'] as const).find(stillPlaying)
    assert(who, `a human is still playing: ${JSON.stringify(state(memory, matchId).status)} errors=${['host', 'p1'].flatMap((id) => t.frames.get(id)!.filter((f) => f.type === 'svara_command_error').map((f) => JSON.stringify(f)))}`)
    const role = t.roles.get(who)!
    t.lobby.disconnect(who)
    t.frames.set(who, [])
    const revisionAtDisconnect = memory.store.get(matchId)!.revision
    for (let i = 0; i < 50; i++) { driveHumans(t, matchId, ['host', 'p1'].filter((id) => id !== who), random); clock.advance(200) }
    t.attach(who, role)
    t.lobby.reconnect(who)
    const restored = t.last(who, 'svara_match_snapshot')
    assert(restored && restored.matchId === matchId, 'reconnect restores the snapshot')
    assert.equal(restored.revision, memory.store.get(matchId)!.revision, 'reconnect gets the current revision')
    assert(restored.revision > revisionAtDisconnect, 'bots kept playing while the human was away')
    assert(t.last(who, 'svara_match_timing'), 'reconnect restores timing')
    const result = playToFinish(t, clock, memory, matchId, ['host', 'p1'], 79)
    assertEqualStartAndAnte(memory, matchId)
    assertResourcesReleased(t, clock, 'mixed')
    assert.equal(t.faults.length, 0, `faults: ${t.faults.map(String).join(', ')}`)
    ok(`смесена маса 2 души + 2 бота: ръчен старт, reconnect, ${result.rounds} раздавания`)
  }

  // 6. Рестарт на сървъра посред мач (persistence + recovery)
  {
    const memory = memoryPersistence()
    const clock = new Clock()
    let t = mount({ clock, memory, seed: 90 })
    t.attach('host')
    const random = seeded(91)
    // Рестарт след 2 раздавания, докато човекът още играе (при ранно
    // отпадане на човека — нова маса; правилата на engine не се пипат).
    let matchId = ''
    for (let attempt = 0; attempt < 10; attempt++) {
      if (matchId) t.send('host', { type: 'leave_svara_table', matchId, requestId: `dismiss-${attempt}` })
      matchId = createTable(t, 'host', 3, 'auto')
      t.send('host', { type: 'fill_svara_table_with_bots', matchId, requestId: `fill-${attempt}` })
      for (let i = 0; i < 5_000 && state(memory, matchId).phase === 'in-progress' && state(memory, matchId).history.length < 2; i++) {
        driveHumans(t, matchId, ['host'], random); clock.advance(200)
      }
      if (state(memory, matchId).phase === 'in-progress' && state(memory, matchId).status.host === 'active') break
      for (let i = 0; i < 5_000 && state(memory, matchId).phase !== 'finished'; i++) clock.advance(200)
    }
    assert.equal(state(memory, matchId).phase, 'in-progress', 'restart point reached')
    const revisionBefore = memory.store.get(matchId)!.revision
    t.lobby.shutdown()
    assert.equal(clock.jobs.size, 0, 'shutdown leaves no timers')
    t = mount({ clock, memory, seed: 92 })
    t.attach('host')
    t.lobby.reconnect('host')
    assert(t.last('host', 'svara_match_snapshot'), `host recovers the match after restart (phase=${state(memory, matchId).phase}, status=${state(memory, matchId).status.host}, frames=${t.frames.get('host')!.map((f) => f.type).join(',')}, faults=${t.faults.map(String).join(';')})`)
    clock.advance(20_000)
    driveHumans(t, matchId, ['host'], random)
    assert(memory.store.get(matchId)!.revision > revisionBefore, 'bots continue after restart')
    const result = playToFinish(t, clock, memory, matchId, ['host'], 93, state(memory, matchId).history.length + 10)
    assertResourcesReleased(t, clock, 'restart')
    assert.equal(t.faults.length, 0, `faults: ${t.faults.map(String).join(', ')}`)
    ok(`рестарт посред мач: ботовете продължават след recovery, ${result.rounds} раздавания`)
  }

  // 7. Поведение на ботовете в целия набор
  {
    const acts = allBotCalls.filter((call) => call.command.type === 'act' || call.command.type === 'look')
    assert(acts.length > 50, 'bots actually played')
    for (const call of acts) {
      const followUp = call.sinceLastSave >= SVARA_TEST_BOT_FOLLOW_UP_DELAY_MS.min && call.sinceLastSave <= SVARA_TEST_BOT_FOLLOW_UP_DELAY_MS.max
      const normal = call.sinceLastSave >= SVARA_TEST_BOT_DELAY_MS.min && call.sinceLastSave <= SVARA_TEST_BOT_DELAY_MS.max
      assert(followUp || normal, `bot acted ${call.sinceLastSave}ms after the last change`)
    }
    const kinds = new Map<string, number>()
    for (const call of acts) {
      const kind = call.command.type === 'act' ? call.command.action.kind : 'look'
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
    const betting = acts.filter((call) => call.command.type === 'act').length
    for (const kind of ['look', 'fold', 'call', 'bet']) assert((kinds.get(kind) ?? 0) > 0, `bots used ${kind}`)
    for (const [kind, count] of kinds) if (kind !== 'look') assert(count / betting < 0.7, `bots are not "always ${kind}"`)
    assert(allBotCalls.some((call) => call.command.type === 'exit'), 'bots leave when no human remains')
    assert(hiddenCardChecks > 50, 'hidden-card checks ran')
    console.log(`    действия: ${[...kinds].map(([k, v]) => `${k}=${v}`).join(', ')}; други: ${[...new Set(allBotCalls.filter((c) => c.command.type !== 'act' && c.command.type !== 'look').map((c) => c.command.type))].join(', ')}`)
    ok(`ботовете: само на ход, пауза 0.6–3 сек, разнообразни решения, без чужди карти (${hiddenCardChecks} проверки)`)
  }

  console.log(`\nSvara test bots: ${results.length}/${results.length} passed`)
} finally {
  for (const [key, value] of [['SVARA_TEST_ENABLED', savedEnv.svara], ['SVARA_TEST_BOTS_ENABLED', savedEnv.bots], ['NODE_ENV', savedEnv.node]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

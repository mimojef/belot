/** Fresh runtime/store instances + fake clocks. No Node restarts or production data (2Б.3.6В is separate). */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraMatchSnapshotStore } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createPersistentSvaraLobby } from '../src/games/svara/createPersistentSvaraLobby.js'
import { createSvaraLifecycle, type SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { validateSvaraStoredMatch } from '../src/games/svara/runtime/svaraStoredMatchValidation.js'
import { SvaraPersistenceError, type SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import { applySvaraMatchCommand, assertSvaraMatchInvariants, buildSvaraDeckForHands, copyRestoredSvaraMatchForServer } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

class Clock implements SvaraClock {
  constructor(public time = 1_800_000_000_000) {}
  jobs: Array<{ at: number; active: boolean; callback: () => void }> = []
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + delay, active: true, callback }; this.jobs.push(job)
    return () => { job.active = false }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let count = 0; ; count++) {
      assert(count < 1000, 'unbounded recovery/timer work')
      const job = this.jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!job) break
      this.time = job.at; job.active = false; job.callback()
    }
    this.time = end
  }
}
function randomFor(decks: SvaraCard[][]) {
  const swaps: number[] = []
  return { nextInt(max: number) {
    if (max === 32) {
      const target = (decks.shift() ?? SVARA_ORDERED_DECK).map(svaraCardCode), work = SVARA_ORDERED_DECK.map(svaraCardCode)
      for (let i = 31; i > 0; i--) { const j = work.indexOf(target[i]!); assert(j >= 0 && j <= i); swaps.push(j); [work[i], work[j]] = [work[j]!, work[i]!] }
    }
    if (!swaps.length) return 0
    assert.equal(max, swaps.length + 1); return swaps.shift()!
  } }
}
let serial = 0, passed = 0, failed = 0
const id = () => `recovery-${++serial}`
const directory = mkdtempSync(join(tmpdir(), 'svara-2b36b-')), base = join(directory, 'base.sqlite')
await ensureServerDatabaseReady({ databaseFilePathOverride: base })
const closes: Array<() => void> = []
const previousFlag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`  PASS ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
  finally { process.env.SVARA_TEST_ENABLED = '1' }
}
function privacy(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) { assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), key); privacy(nested) }
}
async function fixture(capacity: 2 | 3 | 4 = 3, decks: SvaraCard[][] = [], start = true, entryFee = 1000) {
  const path = join(directory, `${id()}.sqlite`); copyFileSync(base, path)
  const store = await createSvaraMatchSnapshotStore(path), clock = new Clock(), matchId = id()
  closes.push(() => store.close())
  const rt = createSvaraMatchRuntime({ persistence: store, now: clock.now, random: randomFor(decks) })
  rt.registerMatch({ matchId, creator: { playerId: 'a' }, capacity, entryFee, startMode: 'manual' })
  const p = (playerId: string, command: any, commandId = id()) => rt.executeParticipantCommand(matchId, { playerId }, commandId, command)
  const s = (command: any, commandId = id()) => rt.executeSystemCommand(matchId, commandId, command)
  // 2Б.3.7.4Б: a fresh deal starts in the server dealing-presentation phase
  // (no look/act accepted yet); skip it directly through the runtime, like
  // the real lifecycle timer would. The real 15s-after-the-real-wait
  // behavior and the gate itself have their own dedicated tests.
  const finishDealingIfNeeded = () => {
    const round = rt.exportInternalStateForServer(matchId).round
    if (round && (round.kind === 'ordinary' || round.kind === 'svara') && (round as { dealing?: boolean }).dealing) {
      s({ type: 'finish-dealing', roundId: round.roundId })
    }
  }
  for (const playerId of ['b', 'c', 'd'].slice(0, capacity - 1)) p(playerId, { type: 'join-seat' })
  if (start) { p('a', { type: 'start-match' }); s({ type: 'start-next-round' }); finishDealingIfNeeded() }
  const saved = () => store.load(matchId)!
  return { path, store, clock, matchId, rt, p, s, saved, finishDealingIfNeeded }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function boot(t: Fixture, elapsed = 0, other: (profileId: string) => boolean = () => false) {
  const store = await createSvaraMatchSnapshotStore(t.path), clock = new Clock(t.clock.time + elapsed), faults: unknown[] = []
  const lobby = createSvaraLobby({ persistence: store, clock, hasOtherGameCommitment: other, onError: (cause) => faults.push(cause) })
  closes.push(() => { lobby.shutdown(); store.close() })
  const frames = new Map<string, any[]>(), sessions = new Map<string, SvaraAccessSession>()
  function attach(playerId: string, connection = playerId) {
    sessions.set(connection, { account: { role: 'admin' }, profile: { profileId: playerId } }); frames.set(connection, [])
    lobby.attachConnection(connection, { profileId: playerId, getSession: () => sessions.get(connection) ?? null, send: (raw) => {
      const message = typeof raw === 'string' ? JSON.parse(raw) : raw; privacy(message)
      if (message.type === 'svara_match_snapshot') {
        assert.equal(message.you.playerId, playerId)
        const saved = store.load(message.matchId)!
        assert.equal(message.revision, saved.revision)
        if (saved.state.round && 'hands' in saved.state.round) for (const [owner, cards] of Object.entries(saved.state.round.hands)) {
          if (owner !== playerId) for (const card of cards) assert(!JSON.stringify(message).includes(`"${card}"`))
        }
      }
      frames.get(connection)!.push(message)
    } })
  }
  for (const p of ['a', 'b', 'c', 'd', 'outsider']) attach(p)
  const command = (playerId: string, command: any, commandId = id(), expectedRevision = store.load(t.matchId)!.revision) => {
    lobby.handle(playerId, { type: 'submit_svara_command', matchId: t.matchId, commandId, expectedRevision, command })
    return frames.get(playerId)!.findLast((f) => f.commandId === commandId)
  }
  const read = (playerId = 'a') => { lobby.handle(playerId, { type: 'request_svara_table_state', matchId: t.matchId }); return frames.get(playerId)!.findLast((f) => f.type === 'svara_match_snapshot') }
  return { store, clock, lobby, faults, frames, sessions, attach, command, read, saved: () => store.load(t.matchId)! }
}
const tie1 = 'KS QS JS', tie2 = 'KH QH JH', low = '8C 9D 10H'
async function joining(extraDecks: SvaraCard[][] = []) {
  const t = await fixture(3, [buildSvaraDeckForHands(['b', 'c', 'a'], { b: tie1, c: low, a: tie2 }), ...extraDecks])
  t.p('b', { type: 'look' }); t.p('b', { type: 'act', action: { kind: 'bet', total: 1 } })
  t.p('c', { type: 'act', action: { kind: 'fold' } }); t.p('a', { type: 'act', action: { kind: 'call' } })
  t.s({ type: 'start-next-round' }); assert.equal(t.saved().state.round?.kind, 'svara-joining'); return t
}
function sql(t: Fixture, run: (db: DatabaseSync) => void) { const db = new DatabaseSync(t.path, { enableForeignKeyConstraints: true }); try { run(db) } finally { db.close() } }

try {
  await check('batch restore preserves the complete state/revision/IDs/deadlines without a write or new deal', async () => {
    const t = await fixture(); t.p('b', { type: 'look' }); t.p('b', { type: 'act', action: { kind: 'bet', total: 3 } })
    const before = t.saved(), rt = createSvaraMatchRuntime({ persistence: t.store, now: t.clock.now }), writes = t.store.getWriteMetricsForServer().writes
    rt.restoreMatchesForServer([before]); assert.deepEqual(rt.exportStoredMatchForServer(t.matchId), before)
    assert.equal(t.store.getWriteMetricsForServer().writes, writes); before.state.stacks.a = -1
    assert.notEqual(rt.exportInternalStateForServer(t.matchId).stacks.a, -1); assertSvaraMatchInvariants(rt.exportInternalStateForServer(t.matchId))
  })
  await check('commands/read/reconnect are blocked during initialization, including reentrant load', async () => {
    const t = await fixture(), f = await boot(t), before = t.saved()
    assert.equal(f.lobby.getRecoveryState(), 'initialization'); assert.equal(f.command('b', { type: 'look' }).code, 'server_unavailable')
    f.lobby.reconnect('b'); assert(!f.frames.get('b')!.some((m) => m.type === 'svara_match_snapshot'))
    const read = f.store.loadActiveMatches.bind(f.store)
    f.store.loadActiveMatches = () => { assert.equal(f.command('b', { type: 'look' }).code, 'server_unavailable'); return read() }
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.deepEqual(t.saved(), before)
  })
  await check('unexpired dealing phase restores its real remaining time; no look/act accepted until recovery completes it', async () => {
    const t = await fixture(3, [], false)
    t.p('a', { type: 'start-match' }); t.s({ type: 'start-next-round' })
    const before = t.saved()
    assert.equal((before.state.round as any).dealing, true); assert.equal(before.deadlines[0]!.kind, 'dealing')
    const f = await boot(t, 2000) // 2000ms into the 3950ms (3-player) dealing window
    assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('a')
    const timing = f.frames.get('a')!.findLast((m) => m.type === 'svara_match_timing')
    assert.equal(timing.deadlines[0].kind, 'dealing')
    assert.equal(timing.deadlines[0].deadlineAt, before.deadlines[0]!.deadlineAt, 'the original absolute dealing deadline must survive the restart')
    assert.equal(timing.deadlines[0].remainingMs, 1950)
    assert.deepEqual(f.saved(), before, 'restoring mid-dealing must not itself change state/revision')
    assert.equal(f.saved().state.round?.dealing, true)
  })
  await check('expired dealing phase (while paused) finishes exactly once on boot; no repeated entry charge or re-deal', async () => {
    const t = await fixture(3, [], false)
    t.p('a', { type: 'start-match' }); t.s({ type: 'start-next-round' })
    const before = t.saved(), entriesBefore = before.state.ledger.filter((e) => e.type === 'entry').length
    const handsBefore = JSON.stringify((before.state.round as any).hands)
    const f = await boot(t, 10_000) // past the 3950ms dealing window while the process was down
    assert.equal(f.lobby.initializeRecovery(), 'ready')
    assert.equal(f.saved().state.round?.dealing, false, 'dealing finishes deterministically once overdue at boot')
    assert.equal(JSON.stringify((f.saved().state.round as any).hands), handsBefore, 'no re-deal across the restart')
    assert.equal(f.saved().state.ledger.filter((e) => e.type === 'entry').length, entriesBefore, 'no repeated entry charge')
    assert.equal(f.saved().revision, before.revision + 1, 'exactly one committed finish-dealing transition')
    assert.equal(f.saved().deadlines[0]!.kind, 'turn', 'the first actor now has a real turn deadline')
    const callback = f.clock.jobs[0]!.callback; callback(); callback() // stale re-fire must not repeat the transition
    assert.equal(f.saved().revision, before.revision + 1)
  })
  await check('unexpired turn restores its real remaining time, not a fresh 15 seconds', async () => {
    const t = await fixture(), before = t.saved(), f = await boot(t, 7000)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('b')
    const timing = f.frames.get('b')!.findLast((m) => m.type === 'svara_match_timing')
    assert.equal(timing.deadlines[0].deadlineAt, before.deadlines[0]!.deadlineAt); assert.equal(timing.deadlines[0].remainingMs, 8000)
    assert.deepEqual(f.saved(), before); assert.equal(f.saved().state.status.b, 'active')
  })
  await check('expired turn commits one fold/absence; stale callbacks and a second initialization cannot repeat it', async () => {
    const t = await fixture(), f = await boot(t, 20000), before = t.saved()
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.equal(f.saved().revision, before.revision + 1); assert.equal(f.saved().state.status.b, 'absent')
    const callback = f.clock.jobs[0]!.callback, applied = f.saved(); callback(); callback(); f.lobby.initializeRecovery()
    assert.deepEqual(f.saved(), applied); assert.equal(f.saved().deadlines[0]!.deadlineAt, f.clock.now() + 15000)
  })
  await check('long downtime does not simulate missing turns/deals or charge repeated entry fees', async () => {
    const t = await fixture(), before = t.saved(), f = await boot(t, 30 * 86400000)
    assert.equal(f.lobby.initializeRecovery(), 'ready')
    assert.equal(f.saved().state.history.length, before.state.history.length)
    assert.equal(f.saved().state.ledger.filter((e) => e.type === 'entry').length, before.state.ledger.filter((e) => e.type === 'entry').length)
    assert.equal(f.saved().revision, before.revision + 1); assert(f.saved().deadlines[0]!.deadlineAt > f.clock.now())
  })
  await check('unexpired Svara joining retains its deadline, cards/history and unresolved pot', async () => {
    const t = await joining(), before = t.saved(), f = await boot(t, 9000)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.deepEqual(f.saved(), before); f.lobby.reconnect('c')
    const timing = f.frames.get('c')!.findLast((m) => m.type === 'svara_match_timing')
    assert.equal(timing.deadlines.find((d: any) => d.kind === 'svara-joining').remainingMs, 6000)
  })
  await check('expired Svara joining closes once and deals only the current continuation without outsider fee', async () => {
    const t = await joining(), before = t.saved(), f = await boot(t, 20000)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.equal(f.saved().state.round?.kind, 'svara')
    assert.equal(f.saved().state.stacks.c, before.state.stacks.c); assert.equal(f.saved().state.ledger.filter((e) => e.type === 'entry').length, 3)
    // 2Б.3.7.4Б: the new Svara deal (2 tied participants) starts in its own
    // server dealing-presentation phase (800 + 2*3*350 = 2900ms), not 'turn'.
    assert.equal(f.saved().deadlines[0]!.kind, 'dealing')
    assert.equal(f.saved().deadlines[0]!.deadlineAt, f.clock.now() + 2900)
  })
  await check('single-active five-minute wait resumes at the original absolute deadline', async () => {
    const t = await joining(); for (const playerId of ['b', 'c']) t.s({ type: 'set-absent', playerId, absent: true })
    const before = t.saved(), f = await boot(t, 120000); assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('a')
    const wait = f.frames.get('a')!.findLast((m) => m.type === 'svara_match_timing').deadlines.find((d: any) => d.kind === 'presence-wait')
    assert.equal(wait.remainingMs, 180000); assert.equal(wait.deadlineAt, before.deadlines.find((d) => d.kind === 'presence-wait')!.deadlineAt)
  })
  await check('overdue joining plus presence deadlines are applied in order; sole winner gets the bank once', async () => {
    const t = await joining(); for (const playerId of ['a', 'b']) t.s({ type: 'set-absent', playerId, absent: true })
    const before = t.saved(), pot = before.state.lockedPots.reduce((n, p) => n + p.amount, 0), f = await boot(t, 400000)
    assert.equal(before.deadlines.length, 2)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); const ended = f.saved()
    assert.equal(ended.state.winnerId, 'c'); assert.equal(ended.state.finishReason, 'prolonged-absence'); assert.equal(ended.state.stacks.c, before.state.stacks.c! + pot)
    f.clock.advance(900000); assert.deepEqual(f.saved(), ended)
    const next = await boot(t, 1000000); assert.equal(next.lobby.initializeRecovery(), 'ready'); assert.equal(next.lobby.findCommitment('a'), null)
    assert.deepEqual(next.saved(), ended); assert.deepEqual(next.store.loadActiveMatches(), [])
  })
  await check('zero-active wait restores without new entries, then aborts without a winner or duplicate removal', async () => {
    const t = await joining(); for (const playerId of ['a', 'b', 'c']) t.s({ type: 'set-absent', playerId, absent: true })
    const before = t.saved(), f = await boot(t, 100000); assert.equal(f.lobby.initializeRecovery(), 'ready')
    assert.equal(f.saved().state.phase, 'in-progress'); assert.equal(f.saved().state.ledger.length, before.state.ledger.length)
    f.clock.advance(200000); const ended = f.saved(); assert.equal(ended.state.finishReason, 'all-absent'); assert.equal(ended.state.winnerId, null)
    assert.deepEqual(ended.state.stacks, before.state.stacks); assert.equal(ended.state.ledger.filter((e) => e.type === 'entry').length, 3)
    f.clock.advance(300000); assert.deepEqual(f.saved(), ended); assertSvaraMatchInvariants(ended.state)
    const overdue = await joining(); for (const playerId of ['a', 'b', 'c']) overdue.s({ type: 'set-absent', playerId, absent: true })
    const restarted = await boot(overdue, 400000); assert.equal(restarted.lobby.initializeRecovery(), 'ready')
    assert.equal(restarted.saved().state.finishReason, 'all-absent'); assert.equal(restarted.saved().state.ledger.filter((e) => e.type === 'entry').length, 3)
  })
  await check('unexpired reveal choice restores its remaining time; resolving after recovery pays nothing twice', async () => {
    const t = await fixture(); t.p('b', { type: 'act', action: { kind: 'fold' } }); t.p('c', { type: 'act', action: { kind: 'fold' } })
    const before = t.saved()
    assert.equal(before.state.round?.kind, 'reveal-choice')
    const awardsBefore = before.state.ledger.filter((e) => e.type === 'pot-award').length
    const f = await boot(t, 2000); assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('a')
    const timing = f.frames.get('a')!.findLast((m) => m.type === 'svara_match_timing')
    assert.equal(timing.deadlines.find((d: any) => d.kind === 'reveal-choice').remainingMs, 3000)
    assert.deepEqual(f.saved(), before)
    assert.equal(f.command('a', { type: 'hide-cards' }).status, 'applied')
    assert.equal(f.saved().state.ledger.filter((e) => e.type === 'pot-award').length, awardsBefore, 'no second award from resolving after recovery')
  })
  await check('overdue reveal choice auto-hides exactly once on boot; a stale callback cannot repeat it', async () => {
    const t = await fixture(); t.p('b', { type: 'act', action: { kind: 'fold' } }); t.p('c', { type: 'act', action: { kind: 'fold' } })
    const before = t.saved(), f = await boot(t, 10000)
    assert.equal(f.lobby.initializeRecovery(), 'ready')
    assert.notEqual(f.saved().state.round?.kind, 'reveal-choice', 'the 5s window elapsed during downtime, so it auto-hid on boot')
    assert.equal(f.saved().state.status.a, 'active', 'auto-hide never marks the winner absent')
    assert.equal(f.saved().state.ledger.filter((e) => e.type === 'pot-award').length, before.state.ledger.filter((e) => e.type === 'pot-award').length)
    const callback = f.clock.jobs[0]!.callback, applied = f.saved(); callback(); callback(); f.lobby.initializeRecovery()
    assert.deepEqual(f.saved(), applied)
  })
  await check('unexpired reveal display restores its remaining time; closing it after recovery never re-awards', async () => {
    const t = await fixture(); t.p('b', { type: 'act', action: { kind: 'fold' } }); t.p('c', { type: 'act', action: { kind: 'fold' } })
    t.p('a', { type: 'reveal-cards' })
    const before = t.saved()
    assert.equal(before.state.round?.kind, 'reveal-choice'); assert.equal((before.state.round as any).decision, 'revealed')
    const awardsBefore = before.state.ledger.filter((e) => e.type === 'pot-award').length
    const f = await boot(t, 1000); assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('a')
    const timing = f.frames.get('a')!.findLast((m) => m.type === 'svara_match_timing')
    assert.equal(timing.deadlines.find((d: any) => d.kind === 'reveal-display').remainingMs, 2000)
    assert.deepEqual(f.saved(), before)
    f.clock.advance(2000)
    assert.notEqual(f.saved().state.round?.kind, 'reveal-choice', 'the display closed on its own absolute deadline')
    assert.equal(f.saved().state.ledger.filter((e) => e.type === 'pot-award').length, awardsBefore)
  })
  await check('absent/pending return is restored; reconnect alone never reactivates the player', async () => {
    const t = await fixture(); t.p('b', { type: 'act', action: { kind: 'fold' } }); t.s({ type: 'set-absent', playerId: 'b', absent: true })
    t.p('b', { type: 'request-return' }, 'return-once')
    const before = t.saved(), f = await boot(t, 1000); assert.equal(f.lobby.initializeRecovery(), 'ready'); f.lobby.reconnect('b')
    const snapshot = f.frames.get('b')!.findLast((m) => m.type === 'svara_match_snapshot')
    assert.equal(snapshot.you.status, 'absent'); assert.equal(snapshot.you.returnPending, true); assert.deepEqual(f.saved(), before)
    assert.equal(f.command('b', { type: 'look' }).code, 'player_absent')
    assert.equal(f.command('b', { type: 'request-return' }, 'return-once', 0).status, 'duplicate')
    assert.equal(f.command('c', { type: 'act', action: { kind: 'fold' } }).status, 'applied')
    // 2Б.3.7.1: a е единствен останал → избор чака преди границата (activateReturns); скрива.
    assert.equal(f.saved().state.round?.kind, 'reveal-choice')
    f.command('a', { type: 'hide-cards' })
    assert.equal(f.saved().state.status.b, 'active')
  })
  await check('new return request after recovery follows the existing next-deal rule', async () => {
    const t = await fixture(2); t.s({ type: 'set-absent', playerId: 'b', absent: true })
    // 2Б.3.7.1: b отсъства → a е единствен останал → избор; скрива преди зареждането.
    assert.equal(t.saved().state.round?.kind, 'reveal-choice')
    t.p('a', { type: 'hide-cards' })
    const f = await boot(t, 1000); assert.equal(f.lobby.initializeRecovery(), 'ready')
    assert.equal(f.command('b', { type: 'request-return' }).status, 'applied'); assert.equal(f.saved().state.status.b, 'active')
  })
  await check('lost ACK retry remains duplicate; conflicting ID and stale revision never debit again', async () => {
    const t = await fixture(); t.p('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'lost-bet')
    const f = await boot(t, 1000); f.lobby.initializeRecovery(); const before = f.saved()
    assert.equal(f.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'lost-bet', 0).status, 'duplicate')
    assert.equal(f.command('b', { type: 'act', action: { kind: 'fold' } }, 'lost-bet', 0).code, 'command_id_conflict')
    assert.equal(f.command('c', { type: 'look' }, 'stale', 0).code, 'stale_action'); assert.deepEqual(f.saved(), before)
  })
  await check('restored lobby tables retain IDs/seats/settings; repeated initialization adds no duplicates', async () => {
    const t = await fixture(4, [], false), before = t.saved(), f = await boot(t)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.equal(f.lobby.initializeRecovery(), 'ready')
    f.lobby.handle('outsider', { type: 'request_svara_tables_list' })
    const list = f.frames.get('outsider')!.at(-1).tables
    assert.equal(list.length, 1); assert.equal(list[0].matchId, t.matchId); assert.equal(list[0].players.length, 4); assert.equal(list[0].capacity, 4)
    assert.deepEqual(f.saved(), before)
  })
  await check('fresh sessions reconnect privately; spoofed profile, revoked session and old transport cannot act', async () => {
    const t = await fixture(); t.p('b', { type: 'look' }); const f = await boot(t, 1000); f.lobby.initializeRecovery()
    f.lobby.reconnect('b'); assert(f.frames.get('b')!.some((m) => m.type === 'svara_match_snapshot' && m.you.cards?.length === 3))
    f.lobby.reconnect('outsider'); assert.equal(f.frames.get('outsider')!.length, 0)
    f.sessions.set('b', null); assert.equal(f.command('b', { type: 'act', action: { kind: 'fold' } }).code, 'unauthenticated')
    f.attach('b', 'new-b'); f.lobby.reconnect('new-b'); assert(f.frames.get('new-b')!.some((m) => m.type === 'svara_match_snapshot'))
    f.sessions.set('a', { account: { role: 'admin' }, profile: { profileId: 'b' } }); assert.equal(f.command('a', { type: 'look' }).code, 'unauthenticated')
    assert.equal(f.command('outsider', { type: 'look', playerId: 'b' }).code, 'not_a_participant')
    assert.equal(f.faults.length, 0)
  })
  await check('restored commitments protect disconnected profiles and reject new Svara admissions', async () => {
    const t = await fixture(), f = await boot(t); f.lobby.initializeRecovery(); f.lobby.disconnect('b')
    for (const profileId of ['a', 'b', 'c']) assert.equal(f.lobby.findCommitment(profileId)!.matchId, t.matchId)
    f.lobby.handle('a', { type: 'create_svara_table', requestId: id(), capacity: 2, entryFee: 1000, startMode: 'auto' })
    assert.equal(f.frames.get('a')!.at(-1).code, 'svara_commitment')
  })
  await check('existing Belot/Ludo/tournament conflict fails Svara recovery without altering either game', async () => {
    for (const game of ['Belot', 'Ludo', 'tournament']) {
      const t = await fixture(), before = t.saved(), f = await boot(t, 1000, (p) => p === 'b')
      assert.equal(f.lobby.initializeRecovery(), 'failed', game); assert.deepEqual(f.saved(), before); assert(f.lobby.findCommitment('b'))
      assert.equal(f.clock.jobs.filter((j) => j.active).length, 0); assert.equal(f.command('a', { type: 'look' }).code, 'server_unavailable')
    }
  })
  await check('multiple tables restore independently with no shared mutable state or participant aliases', async () => {
    const t = await fixture(), otherId = id()
    t.rt.registerMatch({ matchId: otherId, creator: { playerId: 'x' }, capacity: 2, entryFee: 1000, startMode: 'auto' })
    t.rt.executeParticipantCommand(otherId, { playerId: 'y' }, id(), { type: 'join-seat' }); t.rt.executeSystemCommand(otherId, id(), { type: 'start-next-round' })
    const before = t.store.loadActiveMatches(), rt = createSvaraMatchRuntime({ persistence: t.store, now: t.clock.now }); rt.restoreMatchesForServer(before)
    const other = rt.exportStoredMatchForServer(otherId); rt.executeParticipantCommand(t.matchId, { playerId: 'b' }, id(), { type: 'look' })
    assert.deepEqual(rt.exportStoredMatchForServer(otherId), other)
    const f = await boot(t); assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.equal(f.store.loadActiveMatches().length, 2)
  })
  await check('duplicate IDs/participants reject an entire import batch instead of partially installing it', async () => {
    const t = await fixture(), snapshot = t.saved(), rt = createSvaraMatchRuntime()
    assert.throws(() => rt.restoreMatchesForServer([snapshot, snapshot]), SvaraPersistenceError); assert.deepEqual(rt.listMatchIds(), [])
    const other = structuredClone(snapshot); other.matchId = id(); other.state.config.tableId = other.matchId
    assert.throws(() => rt.restoreMatchesForServer([snapshot, other]), SvaraPersistenceError); assert.deepEqual(rt.listMatchIds(), [])
  })
  await check('finished and closed rows are retained with their result but are never active imports', async () => {
    const t = await fixture(2); t.p('b', { type: 'exit' })
    // 2Б.3.7.1: a е единствен останал → избор преди края; скрива, за да завърши наистина.
    assert.equal(t.saved().state.round?.kind, 'reveal-choice')
    t.p('a', { type: 'hide-cards' })
    const ended = t.saved(), f = await boot(t)
    assert.equal(f.lobby.initializeRecovery(), 'ready'); assert.deepEqual(f.store.loadActiveMatches(), []); assert.deepEqual(f.saved(), ended)
    assert.equal(f.lobby.findCommitment('a'), null)
    assert.throws(() => createSvaraMatchRuntime().restoreMatchesForServer([ended]), SvaraPersistenceError)
    const waiting = await fixture(2, [], false); waiting.p('a', { type: 'leave-seat' })
    const closed = await boot(waiting); assert.equal(closed.lobby.initializeRecovery(), 'ready'); assert.deepEqual(closed.store.loadActiveMatches(), [])
    assert.equal(closed.saved().state.phase, 'closed')
  })
  await check('malformed structure/cards/revision/balances/IDs and deadline mismatch are refused safely', async () => {
    const t = await fixture(), original = t.saved()
    const corruptions: Array<(s: any) => void> = [
      (s) => { delete s.state.status }, (s) => { delete s.state.history }, (s) => { delete s.state.round.hands },
      (s) => { s.formatVersion = 999 }, (s) => { s.revision++ }, (s) => { s.state.stacks.a++ },
      (s) => { s.state.seats[1] = s.state.seats[0] }, (s) => { s.state.round.hands.a[0] = 'XX' },
      (s) => { s.state.round.hands.a[0] = s.state.round.hands.b[0] }, (s) => { s.state.round.betting.toAct = 'outsider' },
      (s) => { s.deadlines[0].playerId = 'a' }, (s) => { s.deadlines[0].roundId = 'other' },
      (s) => { s.deadlines[0].actionVersion++ }, (s) => { s.deadlines[0].key = 'bad' }, (s) => { s.deadlines = [] },
      (s) => { Object.values(s.state.processedCommands)[0].fingerprint = '{}' },
    ]
    for (const corrupt of corruptions) {
      const snapshot = structuredClone(original); corrupt(snapshot); const rt = createSvaraMatchRuntime()
      assert.throws(() => rt.restoreMatchesForServer([snapshot]), (cause: unknown) => cause instanceof SvaraPersistenceError && cause.code === 'invalid-snapshot')
      assert.deepEqual(rt.listMatchIds(), [])
    }
    assert.deepEqual(t.saved(), original)
    const j = await joining(), invalidPot = j.saved(); invalidPot.state.lockedPots[0]!.amount++
    assert.throws(() => validateSvaraStoredMatch(invalidPot), SvaraPersistenceError)
    const duplicatePot = j.saved(); duplicatePot.state.lockedPots.push(structuredClone(duplicatePot.state.lockedPots[0]!))
    assert.throws(() => validateSvaraStoredMatch(duplicatePot), SvaraPersistenceError)
  })
  await check('invalid JSON stays on disk; failed Svara is isolated, has no callbacks and leaks no raw data', async () => {
    const t = await fixture()
    sql(t, (db) => { db.exec('PRAGMA ignore_check_constraints = ON'); db.prepare('UPDATE svara_match_snapshots SET snapshot_json = ? WHERE match_id = ?').run('not-json SECRET-CARDS', t.matchId) })
    const f = await boot(t); assert.equal(f.lobby.initializeRecovery(), 'failed'); assert.equal(f.faults.length, 1)
    assert(!String(f.faults[0]).includes('SECRET')); assert.equal(f.clock.jobs.length, 0)
    f.lobby.handle('a', { type: 'request_svara_tables_list' }); assert.equal(f.frames.get('a')!.at(-1).code, 'server_unavailable')
    assert(f.lobby.findCommitment('unknown-profile')) // unreadable commitments cannot authorize a new game
    sql(t, (db) => assert.equal((db.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(t.matchId) as any).snapshot_json, 'not-json SECRET-CARDS'))
  })
  await check('one corrupt active row prevents partial readiness/publication of otherwise healthy tables', async () => {
    const t = await fixture(), second = structuredClone(t.saved()); second.matchId = 'z-corrupt'; second.state.config.tableId = second.matchId
    sql(t, (db) => db.prepare("INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json) VALUES (?, 1, ?, 'in-progress', ?)").run(second.matchId, second.revision + 1, JSON.stringify(second)))
    const f = await boot(t); assert.equal(f.lobby.initializeRecovery(), 'failed'); assert.equal(f.clock.jobs.length, 0)
    assert.equal(f.command('b', { type: 'look' }).code, 'server_unavailable'); assert.equal(f.lobby.initializeRecovery(), 'failed')
  })
  await check('quarantine preserves known commitments; missing membership data cannot silently authorize another game', async () => {
    const t = await fixture(), corrupt = t.saved(); (corrupt.state.round as any).hands.a[0] = 'XX'
    sql(t, (db) => db.prepare('UPDATE svara_match_snapshots SET snapshot_json = ? WHERE match_id = ?').run(JSON.stringify(corrupt), t.matchId))
    const f = await boot(t); assert.equal(f.lobby.initializeRecovery(), 'failed')
    assert(f.lobby.findCommitment('a')); assert.equal(f.lobby.findCommitment('unrelated'), null)
    delete (corrupt.state as any).status
    sql(t, (db) => db.prepare('UPDATE svara_match_snapshots SET snapshot_json = ? WHERE match_id = ?').run(JSON.stringify(corrupt), t.matchId))
    assert(f.lobby.findCommitment('unrelated'))
  })
  await check('SQLite failure during overdue recovery publishes nothing and preserves the old state for the next boot', async () => {
    const t = await fixture(), before = t.saved()
    sql(t, (db) => db.exec("CREATE TRIGGER fail_write BEFORE UPDATE ON svara_match_snapshots BEGIN SELECT RAISE(ABORT, 'SECRET'); END"))
    const f = await boot(t, 20000); assert.equal(f.lobby.initializeRecovery(), 'failed'); assert.deepEqual(f.saved(), before)
    assert.equal(f.frames.get('b')!.length, 0); assert.equal(f.clock.jobs.filter((j) => j.active).length, 0)
    sql(t, (db) => db.exec('DROP TRIGGER fail_write'))
    const retry = await boot(t, 20000); assert.equal(retry.lobby.initializeRecovery(), 'ready'); assert.equal(retry.saved().revision, before.revision + 1)
  })
  await check('failure after an earlier committed recovery step resumes from that revision without duplicate award', async () => {
    const t = await joining(); for (const playerId of ['a', 'b']) t.s({ type: 'set-absent', playerId, absent: true })
    const before = t.saved(), pot = before.state.lockedPots.reduce((n, p) => n + p.amount, 0)
    sql(t, (db) => db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON svara_match_snapshots WHEN NEW.match_status = 'finished' BEGIN SELECT RAISE(ABORT, 'finish failed'); END"))
    const f = await boot(t, 400000); assert.equal(f.lobby.initializeRecovery(), 'failed')
    assert.equal(f.saved().revision, before.revision + 1); assert.equal(f.saved().state.phase, 'in-progress')
    assert.equal(f.saved().deadlines.length, 1); assert.equal(f.saved().deadlines[0]!.kind, 'presence-wait')
    assert.equal(f.frames.get('a')!.length, 0)
    sql(t, (db) => db.exec('DROP TRIGGER fail_finish'))
    const retry = await boot(t, 400000); assert.equal(retry.lobby.initializeRecovery(), 'ready')
    assert.equal(retry.saved().revision, before.revision + 2); assert.equal(retry.saved().state.stacks.c, before.state.stacks.c! + pot)
    assert.equal(retry.saved().state.ledger.filter((e) => e.type === 'absence-pot-award').length, 1)
  })
  await check('immutable archive metadata is rebuilt immediately and remains safe for following commands', async () => {
    const t = await fixture(); t.p('b', { type: 'look' }); t.p('b', { type: 'act', action: { kind: 'bet', total: 1 } })
    const stored = t.saved(), copy = copyRestoredSvaraMatchForServer(stored.state), before = JSON.stringify(copy)
    assert(Object.isFrozen(copy.ledger)); assert(Object.isFrozen(copy.processedCommands)); assert(Object.isFrozen(copy.history))
    assert(copy.ledger.every(Object.isFrozen)); assert.equal(JSON.stringify(copy), JSON.stringify(stored.state))
    const next = applySvaraMatchCommand(copy, { type: 'look', playerId: 'c', commandId: JSON.stringify(['p', 'c', id()]) }).state
    assert.equal(JSON.stringify(copy), before); assert.equal(next.ledger[0], copy.ledger[0]); assertSvaraMatchInvariants(next)
  })
  await check('restored repeated-Svara history aliases behave exactly like an uninterrupted match', async () => {
    const first = await joining()
    const repeated = await joining([buildSvaraDeckForHands(['a', 'b'], { a: tie1, b: tie2 })])
    repeated.p('c', { type: 'svara-decline' }); repeated.s({ type: 'svara-start' })
    repeated.finishDealingIfNeeded()
    repeated.p('a', { type: 'look' }); repeated.p('a', { type: 'act', action: { kind: 'bet', total: 1 } }); repeated.p('b', { type: 'act', action: { kind: 'call' } })
    repeated.s({ type: 'start-next-round' })
    for (const t of [first, repeated]) {
      const uninterrupted = t.rt.exportInternalStateForServer(t.matchId), restored = copyRestoredSvaraMatchForServer(t.saved().state)
      const command = { type: 'svara-join' as const, playerId: 'c', commandId: JSON.stringify(['p', 'c', id()]) }
      const expected = applySvaraMatchCommand(uninterrupted, command).state
      const actual = applySvaraMatchCommand(restored, command).state
      assert.deepEqual(actual, expected); assert.equal(JSON.stringify(actual), JSON.stringify(expected))
    }
  })
  await check('all-in main/side banks and archived cards restore without recharging or repeating the settled side bank', async () => {
    const tied = buildSvaraDeckForHands(['a', 'b', 'c'], { a: tie1, b: tie2, c: 'KD QD JD' })
    const decided = buildSvaraDeckForHands(['a', 'b', 'c'], { a: '7C 7D 7H', b: tie2, c: low })
    const t = await fixture(3, [[...SVARA_ORDERED_DECK], [...SVARA_ORDERED_DECK], tied, tied, decided], true, 100)
    for (const pair of [['b', 'c'], ['c', 'a']]) {
      for (const p of pair) t.p(p, { type: 'act', action: { kind: 'fold' } })
      // 2Б.3.7.1: ако отказването остави единствен победител, изборът трябва да
      // се разреши (скрива), преди следващото раздаване да може да започне.
      const pending = t.rt.exportInternalStateForServer(t.matchId).round as any
      if (pending?.kind === 'reveal-choice') t.p(pending.winnerId, { type: 'hide-cards' })
      t.s({ type: 'start-next-round' })
      t.finishDealingIfNeeded()
    }
    for (const player of ['a', 'b', 'c']) { t.p(player, { type: 'look' }); t.p(player, { type: 'act', action: { kind: 'all-in' } }) }
    assert.equal(t.saved().state.round?.kind, 'allin-svara'); t.s({ type: 'advance-allin-svara' })
    const before = t.saved(), rt = createSvaraMatchRuntime({ persistence: t.store, now: t.clock.now, random: randomFor([decided]) })
    rt.restoreMatchesForServer([before]); assert.deepEqual(rt.exportStoredMatchForServer(t.matchId), before)
    rt.executeSystemCommand(t.matchId, id(), { type: 'advance-allin-svara' })
    const after = rt.exportInternalStateForServer(t.matchId)
    assert.equal(after.ledger.filter((e) => e.type === 'entry').length, before.state.ledger.filter((e) => e.type === 'entry').length)
    assert.equal(after.ledger.filter((e) => e.type === 'pot-split').length, before.state.ledger.filter((e) => e.type === 'pot-split').length)
    assertSvaraMatchInvariants(after)
  })
  await check('feature OFF with missing schema boots normally; turning ON still requires the migration', async () => {
    const path = join(directory, 'without-svara.sqlite'), db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated_platform_data (id INTEGER PRIMARY KEY)'); db.close()
    const faults: unknown[] = []; process.env.SVARA_TEST_ENABLED = '0'
    const off = await createPersistentSvaraLobby({ databaseFilePath: path, hasOtherGameCommitment: () => false, onError: (e) => faults.push(e) })
    closes.push(() => { off.lobby.shutdown(); off.close() }); assert.equal(off.lobby.initializeRecovery(), 'disabled'); assert.equal(faults.length, 0); assert.equal(off.lobby.findCommitment('a'), null)
    process.env.SVARA_TEST_ENABLED = '1'
    const messages: any[] = []
    off.lobby.attachConnection('a', { profileId: 'a', getSession: () => ({ account: { role: 'admin' }, profile: { profileId: 'a' } }), send: (message) => messages.push(message) })
    off.lobby.handle('a', { type: 'create_svara_table', requestId: id(), capacity: 2, entryFee: 1000, startMode: 'auto' })
    assert.equal(messages.at(-1).code, 'server_unavailable')
    const on = await createPersistentSvaraLobby({ databaseFilePath: path, hasOtherGameCommitment: () => false, onError: (e) => faults.push(e) })
    closes.push(() => { on.lobby.shutdown(); on.close() }); assert.equal(on.lobby.initializeRecovery(), 'failed'); assert.equal(faults.length, 1)
    const checkDb = new DatabaseSync(path); assert.equal(checkDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'svara_match_snapshots'").get(), undefined); checkDb.close()
  })
  await check('unreadable SQLite is isolated as a failed Svara service with conservative admission protection', async () => {
    const path = join(directory, 'corrupt.sqlite'); writeFileSync(path, 'not a database SECRET-CARDS')
    const faults: unknown[] = [], service = await createPersistentSvaraLobby({ databaseFilePath: path, hasOtherGameCommitment: () => false, onError: (e) => faults.push(e) })
    closes.push(() => { service.lobby.shutdown(); service.close() })
    assert.equal(service.lobby.initializeRecovery(), 'failed'); assert(service.lobby.findCommitment('unknown'))
    assert(faults.every((e) => e instanceof SvaraPersistenceError && !String(e).includes('SECRET')))
  })
  await check('recovered fixtures preserve SQLite integrity and foreign keys', async () => {
    const t = await fixture(), f = await boot(t, 20000); assert.equal(f.lobby.initializeRecovery(), 'ready')
    sql(t, (db) => { assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok'); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []) })
  })
} finally {
  for (const close of closes.reverse()) close()
  if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED; else process.env.SVARA_TEST_ENABLED = previousFlag
  assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true })
}
console.log(`\nSvara recovery 2Б.3.6Б: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1

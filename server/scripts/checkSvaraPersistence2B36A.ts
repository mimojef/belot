/** Isolated SQLite atomicity checks. No restart/recovery loop, network, production data or real timers. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createSvaraMatchSnapshotStore, serializeSvaraStoredMatch } from '../src/db/svaraMatchSnapshotStore.js'
import { createSvaraMatchRuntime, svaraParticipantCommandKey } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { SvaraPersistenceError, type SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import type { SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { applySvaraMatchCommand, assertSvaraMatchInvariants, buildSvaraDeckForHands } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { createSeededSvaraRandomSourceForTests } from '../src/games/svara/engine/svaraRandom.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'

class Clock implements SvaraClock {
  time = 1_800_000_000_000
  jobs: Array<{ at: number; callback: () => void; active: boolean }> = []
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const job = { at: this.time + delay, callback, active: true }; this.jobs.push(job)
    return () => { job.active = false }
  }
  defer = (callback: () => void) => this.schedule(callback, 0)
  advance(ms: number) {
    const end = this.time + ms
    for (let count = 0; ; count++) {
      assert(count < 1000)
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
const id = () => `persist-${++serial}`
const directory = mkdtempSync(join(tmpdir(), 'svara-2b36a-'))
const databaseFilePath = join(directory, 'isolated.sqlite')
const oldFlag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'
const bootstrap = await ensureServerDatabaseReady({ databaseFilePathOverride: databaseFilePath })
const store = await createSvaraMatchSnapshotStore(databaseFilePath)
const db = new DatabaseSync(databaseFilePath, { enableForeignKeyConstraints: true })
const shutdowns: Array<() => void> = []
let hook: ((candidate: SvaraStoredMatch, expected: number | null) => void) | undefined
const persistence = { ...store, save(candidate: SvaraStoredMatch, expected: number | null) { hook?.(candidate, expected); store.save(candidate, expected) } }
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`  PASS ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
  finally { hook = undefined; db.exec('DROP TRIGGER IF EXISTS fail_write; DROP TRIGGER IF EXISTS fail_commit;') }
}
function privacy(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) { assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), key); privacy(nested) }
}
function fixture(capacity: 2 | 3 | 4 = 3, entryFee = 1000, decks: SvaraCard[][] = [], start = true) {
  const clock = new Clock(), matchId = id(), faults: unknown[] = [], frames: any[] = []
  const rt = createSvaraMatchRuntime({ persistence, now: clock.now, random: randomFor(decks) })
  rt.registerMatch({ matchId, creator: { playerId: 'a' }, capacity, entryFee, startMode: 'manual' })
  const lobby = createSvaraLobby({ runtime: rt, clock, hasOtherGameCommitment: () => false, onError: (cause) => faults.push(cause) })
  shutdowns.push(() => lobby.shutdown())
  for (const playerId of ['a', 'b', 'c', 'd', 'outsider']) lobby.attachConnection(playerId, { profileId: playerId,
    getSession: () => ({ account: { role: 'admin' }, profile: { profileId: playerId } }), send: (raw) => {
      const message = typeof raw === 'string' ? JSON.parse(raw) : raw
      privacy(message)
      // Every emitted revision must already exist on disk, even inside send().
      if ('revision' in message) assert.equal(message.revision, store.load(matchId)!.revision)
      if (message.type === 'svara_match_snapshot' && message.round && rt.exportInternalStateForServer(matchId).round) {
        const round = rt.exportInternalStateForServer(matchId).round!
        if ('hands' in round) for (const [owner, cards] of Object.entries(round.hands)) if (owner !== playerId) {
          for (const card of cards) assert(!JSON.stringify(message).includes(`"${card}"`))
        }
      }
      frames.push({ playerId, ...message })
    } })
  const command = (playerId: string, command: any, commandId = id(), expectedRevision = rt.getMatchRevision(matchId)) => {
    lobby.handle(playerId, { type: 'submit_svara_command', matchId, commandId, expectedRevision, command })
    return frames.findLast((f) => f.playerId === playerId && f.commandId === commandId)
  }
  const p = (playerId: string, command: any, commandId = id(), revision?: number) => rt.executeParticipantCommand(matchId, { playerId }, commandId, command, revision)
  const s = (command: any, commandId = id()) => rt.executeSystemCommand(matchId, commandId, command)
  const sync = () => lobby.handle('a', { type: 'request_svara_table_state', matchId })
  const state = () => rt.exportInternalStateForServer(matchId)
  const stored = () => store.load(matchId)!
  const roundtrip = () => {
    assert.equal(serializeSvaraStoredMatch(rt.exportStoredMatchForServer(matchId)), serializeSvaraStoredMatch(stored()))
    assertSvaraMatchInvariants(stored().state)
  }
  for (const playerId of ['b', 'c', 'd'].slice(0, capacity - 1)) p(playerId, { type: 'join-seat' })
  if (start) { p('a', { type: 'start-match' }); sync() }
  return { rt, clock, matchId, lobby, frames, faults, command, p, s, sync, state, stored, roundtrip }
}
const tie1 = 'KS QS JS', tie2 = 'KH QH JH', low = '8C 9D 10H'
function joining() {
  const t = fixture(3, 1000, [buildSvaraDeckForHands(['b', 'c', 'a'], { b: tie1, c: low, a: tie2 })])
  t.command('b', { type: 'look' }); t.command('b', { type: 'act', action: { kind: 'bet', total: 1 } })
  t.command('c', { type: 'act', action: { kind: 'fold' } }); t.command('a', { type: 'act', action: { kind: 'call' } })
  assert.equal(t.state().round?.kind, 'svara-joining'); t.roundtrip(); return t
}
function failWrites(matchId: string) {
  db.exec(`CREATE TRIGGER fail_write BEFORE UPDATE ON svara_match_snapshots WHEN OLD.match_id = '${matchId}'
    BEGIN SELECT RAISE(ABORT, 'secret SQL payload must never leave store'); END`)
}

try {
  await check('migration applies through the existing runner; repeated bootstrap preserves Svara rows', async () => {
    assert(bootstrap.appliedMigrations.some((m) => m.filename === '20261023_001_create_svara_match_snapshots.sql'))
    const t = fixture(2, 1000, [], false)
    const json = serializeSvaraStoredMatch(t.stored())
    const again = await ensureServerDatabaseReady({ databaseFilePathOverride: databaseFilePath })
    assert.equal(again.appliedCount, 0); assert.equal(serializeSvaraStoredMatch(t.stored()), json)
  })
  await check('creation/join/manual start/new deal all persist; full internal JSON roundtrips', () => {
    const t = fixture(4); t.roundtrip()
    assert.equal(t.stored().state.seats.length, 4); assert.equal(t.stored().state.phase, 'in-progress')
    assert.equal(t.stored().revision, t.rt.getMatchRevision(t.matchId)); assert.equal(t.stored().formatVersion, 1)
  })
  await check('failed registration is invisible and a later creation can retry', () => {
    const rt = createSvaraMatchRuntime({ persistence }), matchId = id()
    hook = () => { throw new SvaraPersistenceError('write-failed') }
    const input = { matchId, creator: { playerId: 'a' }, capacity: 2 as const, entryFee: 1000, startMode: 'auto' as const }
    assert.throws(() => rt.registerMatch(input), SvaraPersistenceError); assert(!rt.hasMatch(matchId)); assert.equal(store.load(matchId), null)
    hook = undefined; rt.registerMatch(input); assert.equal(store.load(matchId)!.revision, 0)
  })
  await check('look preserves actual secret cards; only protected own cards cross the transport', () => {
    const t = fixture(); const before = t.stored().state.round
    assert(before && 'hands' in before); assert.equal(Object.keys(before.hands).length, 3)
    assert.equal(t.command('b', { type: 'look' }).status, 'applied'); t.roundtrip()
    const frame = t.frames.findLast((f) => f.type === 'svara_match_snapshot' && f.playerId === 'b')
    assert.deepEqual(frame.you.cards, before.hands.b); assert.equal(t.faults.length, 0)
  })
  await check('bet/blind/call/all-in/fold retain chips, contributions, pots, ledger and history', () => {
    const t = fixture()
    t.p('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }); t.roundtrip()
    t.p('c', { type: 'look' }); t.p('c', { type: 'act', action: { kind: 'bet', total: 4 } }); t.roundtrip()
    t.p('a', { type: 'act', action: { kind: 'fold' } }); t.p('b', { type: 'act', action: { kind: 'call' } }); t.roundtrip()
    assert(t.stored().state.history.length > 0); assert(t.stored().state.ledger.some((e) => e.type === 'bet'))
    const allin = fixture(2); allin.p('b', { type: 'look' }); allin.p('b', { type: 'act', action: { kind: 'all-in' } }); allin.roundtrip()
  })
  await check('no ACK, publication or authoritative RAM adoption before successful SQLite commit', () => {
    const t = fixture(), before = t.rt.exportStoredMatchForServer(t.matchId), count = t.frames.length
    let observed = false
    hook = (candidate, expected) => {
      if (candidate.matchId !== t.matchId) return
      observed = true; assert.equal(candidate.revision, before.revision + 1); assert.equal(expected, before.revision)
      assert.deepEqual(t.rt.exportStoredMatchForServer(t.matchId), before); assert.deepEqual(t.stored(), before)
      assert.equal(t.frames.length, count)
    }
    assert.equal(t.command('b', { type: 'look' }).status, 'applied'); assert(observed); t.roundtrip()
  })
  await check('SQL statement failure rolls back state/revision/IDs/deadlines; error is sanitized', () => {
    const t = fixture(), before = t.stored(), count = t.frames.length
    failWrites(t.matchId)
    const result = t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'retry')
    assert.equal(result.code, 'server_unavailable'); assert.deepEqual(t.stored(), before); t.roundtrip()
    assert.equal(t.frames.length, count + 1); assert.equal(t.faults.length, 1)
    assert(t.faults[0] instanceof SvaraPersistenceError); assert(!String(t.faults[0]).includes('secret'))
  })
  await check('COMMIT failure (deferred foreign key) rolls back the entire candidate and side write', () => {
    const t = fixture(), before = t.stored()
    db.exec(`CREATE TABLE IF NOT EXISTS test_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS test_deferred(id INTEGER REFERENCES test_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER UPDATE ON svara_match_snapshots WHEN NEW.match_id = '${t.matchId}'
      BEGIN INSERT INTO test_deferred VALUES (123456); END`)
    assert.equal(t.command('b', { type: 'look' }).code, 'server_unavailable')
    assert.deepEqual(t.stored(), before); t.roundtrip()
    assert.equal((db.prepare('SELECT count(*) AS n FROM test_deferred').get() as { n: number }).n, 0)
  })
  await check('identical retry after success performs no write, no second debit and no deadline reset', () => {
    const t = fixture(), revision = t.rt.getMatchRevision(t.matchId)
    t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'same', revision)
    const before = t.stored(), writes = store.getWriteMetricsForServer().writes
    t.clock.time += 100
    assert.equal(t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'same', revision).status, 'duplicate')
    assert.deepEqual(t.stored(), before); assert.equal(store.getWriteMetricsForServer().writes, writes)
  })
  await check('identical retry after failed write can commit once; previous ID was not consumed', () => {
    const t = fixture(), revision = t.rt.getMatchRevision(t.matchId)
    failWrites(t.matchId); assert.equal(t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'retry', revision).code, 'server_unavailable')
    db.exec('DROP TRIGGER fail_write')
    assert.equal(t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'retry', revision).status, 'applied'); t.roundtrip()
    const before = t.stored(); assert.equal(t.command('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'retry', revision).status, 'duplicate')
    assert.deepEqual(t.stored(), before)
  })
  await check('conflicting ID and stale revision cannot update the database', () => {
    const t = fixture(), revision = t.rt.getMatchRevision(t.matchId)
    t.command('b', { type: 'look' }, 'conflict', revision); const before = t.stored()
    assert.equal(t.command('b', { type: 'act', action: { kind: 'fold' } }, 'conflict', revision).code, 'command_id_conflict')
    assert.equal(t.command('c', { type: 'look' }, 'new', revision).code, 'stale_action'); assert.deepEqual(t.stored(), before)
  })
  await check('same client ID by two actors and a system ID occupy different durable namespaces', () => {
    const t = fixture(); t.p('a', { type: 'look' }, 'shared'); t.p('b', { type: 'look' }, 'shared')
    t.s({ type: 'set-absent', playerId: 'c', absent: true }, 'shared'); t.roundtrip()
    const keys = Object.keys(t.stored().state.processedCommands)
    for (const key of [svaraParticipantCommandKey('a', 'shared'), svaraParticipantCommandKey('b', 'shared'), JSON.stringify(['s', 'shared'])]) assert(keys.includes(key))
  })
  await check('lost ACK: durable processedCommands recognizes retry from a fresh JSON read', () => {
    const t = fixture(); t.p('b', { type: 'look' }, 'lost-ack')
    const loaded = store.load(t.matchId)!, key = svaraParticipantCommandKey('b', 'lost-ack')
    const retried = applySvaraMatchCommand(loaded.state, { type: 'look', playerId: 'b', commandId: key })
    assert.equal(retried.status, 'duplicate'); assert.equal(retried.state, loaded.state)
    assert.throws(() => applySvaraMatchCommand(loaded.state, { type: 'act', action: { kind: 'fold' }, playerId: 'b', commandId: key }), /commandId/)
  })
  await check('two queued same-revision commands serialize; only the first changes state', async () => {
    const t = fixture(), revision = t.rt.getMatchRevision(t.matchId)
    const result = await Promise.all([Promise.resolve().then(() => t.command('a', { type: 'look' }, 'one', revision)), Promise.resolve().then(() => t.command('b', { type: 'look' }, 'two', revision))])
    assert.equal(result[0].status, 'applied'); assert.equal(result[1].code, 'stale_action'); assert.equal(t.stored().revision, revision + 1); t.roundtrip()
  })
  await check('SQLite CAS rejects a stale writer and cannot overwrite a newer row', () => {
    const t = fixture(), old = t.stored()
    t.p('b', { type: 'look' }); const current = t.stored()
    const staleCandidate = structuredClone(current); staleCandidate.state.stacks.a! += 1
    assert.throws(() => store.save(staleCandidate, old.revision), SvaraPersistenceError)
    assert.deepEqual(t.stored(), current)
    // Valid alternate candidate with the old revision also loses the CAS.
    const alternative = applySvaraMatchCommand(old.state, { type: 'look', playerId: 'a', commandId: svaraParticipantCommandKey('a', 'other-owner') }).state
    assert.throws(() => store.save({ ...old, revision: old.revision + 1, state: alternative }, old.revision), (e: unknown) => e instanceof SvaraPersistenceError && e.code === 'revision-conflict')
    assert.deepEqual(t.stored(), current)
  })
  await check('reentrant writes cannot enter the same runtime during commit preparation', () => {
    const t = fixture(); let fenced = false
    hook = (candidate) => { if (candidate.matchId === t.matchId) { assert.throws(() => t.p('a', { type: 'look' }), SvaraPersistenceError); fenced = true } }
    t.p('b', { type: 'look' }); assert(fenced); t.roundtrip()
  })
  await check('turn absolute deadline is stored with state and stays unchanged across look/retry/read', () => {
    const t = fixture(), original = t.stored().deadlines
    assert.equal(original[0]!.deadlineAt, t.clock.now() + 15000)
    t.clock.time += 1234; t.command('a', { type: 'look' }, 'look'); t.command('a', { type: 'look' }, 'look'); t.sync()
    assert.deepEqual(t.stored().deadlines, original); t.roundtrip()
  })
  await check('timeout uses the same atomic persistence path and preserves failed expiry for retry', () => {
    const t = fixture(), before = t.stored(); failWrites(t.matchId)
    t.clock.advance(15000); assert.deepEqual(t.stored(), before); assert.equal(t.state().status.b, 'active')
    db.exec('DROP TRIGGER fail_write'); t.sync(); assert.equal(t.stored().state.status.b, 'absent')
    assert(t.stored().state.processedCommands); t.roundtrip()
  })
  await check('Svara joining window, explicit decision, fee and new Svara deal roundtrip', () => {
    const t = joining(); const joiningDeadline = t.stored().deadlines.find((d) => d.kind === 'svara-joining')!
    assert.equal(joiningDeadline.deadlineAt, t.clock.now() + 15000)
    t.clock.time += 1000; t.command('c', { type: 'svara-join' }); assert.equal(t.state().round?.kind, 'svara')
    assert(t.stored().state.ledger.some((e) => e.type === 'svara-join-fee')); t.roundtrip()
    const decline = joining(); decline.command('c', { type: 'svara-decline' }); decline.roundtrip()
    const expiry = joining(); expiry.clock.advance(15000); assert.equal(expiry.state().round?.kind, 'svara'); expiry.roundtrip()
  })
  await check('all-in Svara and resolved side pots retain the complete internal state', () => {
    // Two legal fold rounds create unequal stacks, hence a main and a side bank.
    const tied = buildSvaraDeckForHands(['a', 'b', 'c'], { a: tie1, b: tie2, c: 'KD QD JD' })
    const decided = buildSvaraDeckForHands(['a', 'b', 'c'], { a: '7C 7D 7H', b: tie2, c: low })
    const t = fixture(3, 100, [[...SVARA_ORDERED_DECK], [...SVARA_ORDERED_DECK], tied, tied, decided])
    for (const player of ['b', 'c', 'c', 'a']) t.command(player, { type: 'act', action: { kind: 'fold' } })
    assert.deepEqual(t.state().stacks, { a: 10, b: 10, c: 7 })
    for (const player of ['a', 'b', 'c']) { t.p(player, { type: 'look' }); t.p(player, { type: 'act', action: { kind: 'all-in' } }) }
    assert.equal(t.state().round?.kind, 'allin-svara'); assert(t.stored().state.lockedPots.length); t.roundtrip()
    t.s({ type: 'advance-allin-svara' }); t.roundtrip()
    assert(t.state().history.at(-1)!.pots.some((p) => p.outcome.kind === 'split'))
    t.s({ type: 'advance-allin-svara' }); t.roundtrip()
  })
  await check('pending return and absent statuses persist; reactivation is a separate next-deal commit', () => {
    const t = fixture(); t.command('b', { type: 'act', action: { kind: 'fold' } })
    t.s({ type: 'set-absent', playerId: 'b', absent: true }); t.command('b', { type: 'request-return' })
    assert.equal(t.stored().state.status.b, 'absent'); assert.deepEqual(t.stored().state.pendingReturns, ['b']); t.roundtrip()
    t.command('c', { type: 'act', action: { kind: 'fold' } }); assert.equal(t.stored().state.status.b, 'active'); t.roundtrip()
  })
  await check('failed automatic next deal does not undo a committed player action or acknowledge an undealt round', () => {
    const t = fixture(2), before = t.state().roundCounter
    hook = (candidate) => { if (candidate.matchId === t.matchId && candidate.state.roundCounter > before) throw new SvaraPersistenceError('write-failed') }
    assert.equal(t.command('b', { type: 'act', action: { kind: 'fold' } }, 'committed-fold').status, 'applied')
    assert.equal(t.stored().state.round, null); assert.equal(t.stored().state.roundCounter, before); t.roundtrip()
    assert(t.stored().state.processedCommands[svaraParticipantCommandKey('b', 'committed-fold')])
    hook = undefined; t.sync(); assert.equal(t.state().roundCounter, before + 1); t.roundtrip()
  })
  await check('five-minute single-active victory durably awards every unresolved locked bank once', () => {
    const t = joining(); t.s({ type: 'set-absent', playerId: 'b', absent: true }); t.s({ type: 'set-absent', playerId: 'c', absent: true }); t.sync()
    assert.equal(t.stored().deadlines.find((d) => d.kind === 'presence-wait')!.deadlineAt, t.clock.now() + 300000)
    const amount = t.state().lockedPots.reduce((sum, p) => sum + p.amount, 0), stack = t.state().stacks.a!
    t.clock.advance(300000); assert.equal(t.stored().state.winnerId, 'a'); assert.equal(t.stored().state.stacks.a, stack + amount)
    assert.equal(t.stored().state.finishReason, 'prolonged-absence'); assert.deepEqual(t.stored().deadlines, [])
    assert(t.stored().state.ledger.some((e) => e.type === 'absence-pot-award')); t.roundtrip()
    const ended = t.stored(); t.sync(); assert.deepEqual(t.stored(), ended)
  })
  await check('five-minute all-absent abort closes pots without a winner or changes to free stacks', () => {
    const t = joining(); for (const playerId of ['a', 'b', 'c']) t.s({ type: 'set-absent', playerId, absent: true }); t.sync()
    const before = t.state(), amount = before.lockedPots.reduce((sum, p) => sum + p.amount, 0)
    assert.equal(t.stored().deadlines.find((d) => d.kind === 'presence-wait')!.playerId, null)
    t.clock.advance(300000); const after = t.stored().state
    assert.equal(after.phase, 'finished'); assert.equal(after.winnerId, null); assert.equal(after.finishReason, 'all-absent')
    assert.deepEqual(after.stacks, before.stacks); assert.equal(after.removedChips, before.removedChips + amount); t.roundtrip()
  })
  await check('carried pot survives storage and is durably awarded only once at the presence deadline', () => {
    const t = fixture(); t.command('b', { type: 'look' }); t.command('b', { type: 'act', action: { kind: 'bet', total: 30 } })
    t.command('b', { type: 'exit' }); t.s({ type: 'set-absent', playerId: 'a', absent: true }); t.sync()
    assert.equal(t.stored().state.carried[0]!.amount, 30); t.roundtrip(); const stack = t.state().stacks.c!
    t.clock.advance(300000); assert.equal(t.stored().state.stacks.c, stack + 30); assert.deepEqual(t.stored().state.carried, []); t.roundtrip()
  })
  await check('voluntary leave/closure and normal exit/finish persist terminal metadata', () => {
    const waiting = fixture(2, 1000, [], false); waiting.p('b', { type: 'leave-seat' }); waiting.roundtrip()
    waiting.p('a', { type: 'leave-seat' }); assert.equal(waiting.stored().state.phase, 'closed'); waiting.roundtrip()
    const t = fixture(2); t.command('b', { type: 'exit' }); assert.equal(t.stored().state.phase, 'finished'); t.roundtrip()
    const row = db.prepare('SELECT finished_at FROM svara_match_snapshots WHERE match_id = ?').get(t.matchId) as { finished_at: string }
    assert(row.finished_at)
  })
  await check('independent tables are isolated; duplicate creation after a new runtime never overwrites a row', () => {
    const a = fixture(), b = fixture(), before = b.stored(); a.p('b', { type: 'look' }); assert.deepEqual(b.stored(), before)
    const freshRuntime = createSvaraMatchRuntime({ persistence })
    assert.throws(() => freshRuntime.registerMatch({ matchId: a.matchId, creator: { playerId: 'a' }, capacity: 2, entryFee: 10, startMode: 'auto' }), (e: unknown) => e instanceof SvaraPersistenceError && e.code === 'match-exists')
    assert(!freshRuntime.hasMatch(a.matchId)); a.roundtrip()
  })
  await check('before recovery, durable commitments remain protected and commands are unavailable', () => {
    const t = fixture(); assert(store.findActiveMatchId('a'))
    const fresh = createSvaraLobby({ persistence: store, hasOtherGameCommitment: () => false }); shutdowns.push(() => fresh.shutdown())
    const messages: any[] = []
    fresh.attachConnection('fresh', { profileId: 'a', getSession: () => ({ account: { role: 'admin' }, profile: { profileId: 'a' } }), send: (message) => messages.push(message) })
    assert(fresh.findCommitment('a')); fresh.reconnect('fresh'); assert.equal(messages.length, 0)
    fresh.handle('fresh', { type: 'create_svara_table', requestId: 'new-table', capacity: 2, entryFee: 1000, startMode: 'auto' })
    assert.equal(messages.at(-1).code, 'server_unavailable'); t.roundtrip()
  })
  await check('production-style lobby creation/join use the durable runtime before any success frame', async () => {
    assert.throws(() => createSvaraLobby({ hasOtherGameCommitment: () => false }), /requires durable persistence/)
    const messages: any[] = [], clock = new Clock(), creatorId = id(), otherId = id()
    const isolatedPath = join(directory, 'lobby.sqlite')
    await ensureServerDatabaseReady({ databaseFilePathOverride: isolatedPath })
    const isolated = await createSvaraMatchSnapshotStore(isolatedPath)
    const lobby = createSvaraLobby({ persistence: isolated, clock, hasOtherGameCommitment: () => false })
    shutdowns.push(() => { lobby.shutdown(); isolated.close() })
    assert.equal(lobby.initializeRecovery(), 'ready')
    for (const playerId of [creatorId, otherId]) lobby.attachConnection(playerId, { profileId: playerId,
      getSession: () => ({ account: { role: 'admin' }, profile: { profileId: playerId } }), send: (message) => {
        const frame = typeof message === 'string' ? JSON.parse(message) : message
        if (frame.type === 'svara_table_updated') assert(isolated.load(frame.table.matchId))
        if (frame.type === 'svara_match_snapshot') assert.equal(isolated.load(frame.matchId)!.revision, frame.revision)
        privacy(frame); messages.push(frame)
      } })
    lobby.handle(creatorId, { type: 'create_svara_table', requestId: id(), capacity: 2, entryFee: 1000, startMode: 'auto' })
    const matchId = messages.find((m) => m.type === 'svara_table_updated').table.matchId
    assert.equal(isolated.load(matchId)!.revision, 0)
    lobby.handle(otherId, { type: 'join_svara_table', matchId, requestId: id() })
    assert.equal(isolated.load(matchId)!.state.phase, 'in-progress'); assert.equal(isolated.load(matchId)!.deadlines[0]!.deadlineAt, clock.now() + 15000)
    const count = messages.length
    lobby.disconnect(creatorId); lobby.reconnect(otherId); assert(isolated.findActiveMatchId(creatorId)); assert(messages.length > count)
  })
  await check('lossy serialization and invalid formats fail before any partial SQL write', () => {
    const t = fixture(), before = t.stored()
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Map(), new Date()]) {
      const invalid: any = structuredClone(before); invalid.extra = value
      assert.throws(() => store.save(invalid, before.revision), SvaraPersistenceError)
      assert.deepEqual(t.stored(), before)
    }
    const cyclic: any = structuredClone(before); cyclic.self = cyclic
    assert.throws(() => serializeSvaraStoredMatch(cyclic), SvaraPersistenceError)
    const bad = structuredClone(before); (bad as any).formatVersion = 2
    assert.throws(() => serializeSvaraStoredMatch(bad), SvaraPersistenceError)
  })
  await check('JSON-deserialized archives support subsequent commands without mutating the old state', () => {
    const t = fixture(); t.p('b', { type: 'look' }); const loaded = t.stored(), saved = JSON.stringify(loaded)
    const result = applySvaraMatchCommand(loaded.state, { type: 'look', playerId: 'c', commandId: svaraParticipantCommandKey('c', 'after-read') })
    assert.equal(JSON.stringify(loaded), saved); assert.equal(result.status, 'applied'); assert(Object.isFrozen(result.state.processedCommands))
    assertSvaraMatchInvariants(result.state)
  })
  await check('immutable committed archives remain frozen and old snapshots stay unchanged', () => {
    const t = fixture(); t.p('b', { type: 'look' }); const before = t.stored(), saved = serializeSvaraStoredMatch(before)
    t.p('a', { type: 'look' }); assert.equal(serializeSvaraStoredMatch(before), saved); t.roundtrip()
  })
  await check('short measurement: full snapshot cost at short/long histories and multiple tables', () => {
    const baseline = store.getWriteMetricsForServer(), clock = new Clock(), rt = createSvaraMatchRuntime({ persistence: store, now: clock.now, random: createSeededSvaraRandomSourceForTests(892) })
    const matchId = id(); rt.registerMatch({ matchId, creator: { playerId: 'bench-a' }, capacity: 2, entryFee: 100000, startMode: 'auto' })
    rt.executeParticipantCommand(matchId, { playerId: 'bench-b' }, id(), { type: 'join-seat' })
    const sizes: Array<{ commands: number; bytes: number }> = [], samples: number[] = []
    for (let step = 0; step < 400; step++) {
      const started = performance.now(), automatic = rt.getAutomaticCommand(matchId)
      if (automatic) rt.executeSystemCommand(matchId, id(), automatic)
      else {
        const state = rt.exportInternalStateForServer(matchId), view = rt.getLifecycleView(matchId)
        if (state.phase !== 'in-progress') break
        if (state.round?.kind === 'svara-joining') rt.executeSystemCommand(matchId, id(), { type: 'close-svara-joining', roundId: state.round.roundId })
        else {
          assert(view.actorId); const actor = { playerId: view.actorId }, round = state.round
          assert(round && 'betting' in round)
          rt.executeParticipantCommand(matchId, actor, id(), !round.betting.looked.includes(actor.playerId) ? { type: 'look' } :
            { type: 'act', action: round.betting.currentBet ? { kind: 'call' } : { kind: 'bet', total: state.entryChips } })
        }
      }
      samples.push(performance.now() - started)
      if (step === 19 || step === 399) sizes.push({ commands: step + 1, bytes: Buffer.byteLength(serializeSvaraStoredMatch(store.load(matchId)!)) })
    }
    assert.equal(samples.length, 400); assert.equal(sizes.length, 2)
    const measured = store.getWriteMetricsForServer(), writes = measured.writes - baseline.writes
    console.log('  MEASURE', JSON.stringify({ writes, samples: samples.length, serializeAndValidateMeanMs: (measured.serializeMs - baseline.serializeMs) / writes,
      sqliteCommitMeanMs: (measured.sqliteMs - baseline.sqliteMs) / writes,
      persistenceMeanMs: (measured.serializeMs + measured.sqliteMs - baseline.serializeMs - baseline.sqliteMs) / writes,
      commandAndObservationMeanMs: samples.reduce((a, b) => a + b, 0) / samples.length, sizes }))
    assert.deepEqual(store.load(matchId), rt.exportStoredMatchForServer(matchId))
  })
  await check('temporary database integrity and foreign keys are clean; no other-game schema mutations', () => {
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok')
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
    assert(db.prepare("SELECT name FROM sqlite_master WHERE name = 'active_room_snapshots'").get())
    assert(db.prepare("SELECT name FROM sqlite_master WHERE name = 'active_ludo_match_snapshots'").get())
  })
} finally {
  for (const shutdown of shutdowns) shutdown()
  db.close(); store.close()
  if (oldFlag === undefined) delete process.env.SVARA_TEST_ENABLED; else process.env.SVARA_TEST_ENABLED = oldFlag
  // Only the fresh mkdtemp directory, directly under the system temp root.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
  rmSync(directory, { recursive: true, force: true })
}
console.log(`\nSvara persistence 2Б.3.6А: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1

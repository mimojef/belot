/** Deterministic 2Б.3.5 checks. All 15s/5min periods use a controlled clock. */
import assert from 'node:assert/strict'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { createSvaraLifecycle, svaraDealingAnimationMs, type SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { SVARA_SHOWDOWN_DISPLAY_MS, SVARA_PAYOUT_STEP_MS } from '../src/games/svara/runtime/svaraDeadlines.js'
import { createSvaraMatch, applySvaraMatchCommand, buildSvaraDeckForHands, assertSvaraMatchInvariants, type SvaraMatchCommand, type SvaraMatchEnv } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS, createSvaraMatchSnapshotMessage } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

type Job = { at: number; callback: () => void; active: boolean; order: number }
type WithoutCommandId<C> = C extends { commandId: string } ? Omit<C, 'commandId'> : never
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
  advance(ms: number, dispatch = true) {
    const end = this.time + ms
    if (dispatch) for (let n = 0; ; n++) {
      assert(n < 10_000, 'unbounded timer loop')
      const job = this.jobs.filter((j) => j.active && j.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0]
      if (!job) break
      this.time = job.at; job.active = false; job.callback()
    }
    this.time = end
  }
  live() { return this.jobs.filter((job) => job.active) }
}

const TIE1 = 'KS QS JS', TIE2 = 'KH QH JH', LOW = '8C 9D 10H'
let serial = 0
const id = () => `l${++serial}`
let passed = 0, failed = 0
function check(label: string, run: () => void) {
  try { run(); passed++; console.log(`  PASS ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
}
const closes: Array<() => void> = []
const faults: unknown[] = []
const previousFlag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'

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
function privateFrame(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) { assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), key); privateFrame(nested) }
}
function mount(runtime: ReturnType<typeof createSvaraMatchRuntime>, matchId = 'm', clock = new Clock()) {
  const frames = new Map<string, any[]>(), sessions = new Map<string, SvaraAccessSession>()
  const blocked = new Set<string>()
  const lobby = createSvaraLobby({ runtime, clock, hasOtherGameCommitment: (p) => blocked.has(p), onError: (cause) => faults.push(cause) })
  closes.push(() => lobby.shutdown())
  function attach(player: string, connection = player) {
    frames.set(connection, []); sessions.set(connection, { account: { role: 'admin' }, profile: { profileId: player } })
    lobby.attachConnection(connection, { profileId: player, getSession: () => sessions.get(connection) ?? null, send: (raw) => {
      const frame = typeof raw === 'string' ? JSON.parse(raw) : raw
      privateFrame(frame)
      if (frame.type === 'svara_match_snapshot') {
        assert.equal(frame.you.playerId, player)
        const state = runtime.exportInternalStateForServer(frame.matchId)
        assertSvaraMatchInvariants(state)
        if (state.round && 'hands' in state.round) for (const [owner, cards] of Object.entries(state.round.hands)) {
          if (owner !== player) for (const card of cards) assert(!JSON.stringify(frame).includes(`"${card}"`), 'foreign card')
        }
      }
      frames.get(connection)!.push(frame)
    } })
  }
  for (const p of ['a', 'b', 'c', 'd', 'outsider']) attach(p)
  function send(player: string, message: any) {
    const parsed = parseClientMessage(JSON.stringify(message)); assert(parsed, JSON.stringify(message))
    lobby.handle(player, parsed as any)
  }
  const payload = (command: any, extra = {}) => ({ type: 'submit_svara_command', matchId, commandId: id(), expectedRevision: runtime.getMatchRevision(matchId), command, ...extra })
  const submit = (player: string, command: any, extra = {}) => {
    const message = payload(command, extra); send(player, message)
    return frames.get(player)!.findLast((f) => f.commandId === message.commandId)
  }
  // 2Б.3.7.4Б: a fresh deal (ordinary or svara) starts in the server
  // dealing-presentation phase; advance the REAL fake clock through it —
  // exactly the real lifecycle timer path, not a direct engine shortcut.
  const finishDealingIfNeeded = () => {
    const round = state().round
    if (round && (round.kind === 'ordinary' || round.kind === 'svara') && (round as { dealing?: boolean }).dealing) {
      clock.advance(svaraDealingAnimationMs(round.participants.length))
      sync()
    }
  }
  // 2Б.3.7.6А: a real settled showdown (2+ remaining) now opens a public
  // display round (3с comparison, then a sequential payout window sized by
  // its own number of payout steps) before the round actually clears —
  // advance the SAME real fake clock through it, exactly the real lifecycle
  // timer path (mirrors finishDealingIfNeeded above, not a direct engine
  // shortcut). A single advance() call dispatches both chained deadlines in
  // order, since the clock processes newly-scheduled jobs within its window.
  const resolveShowdownDisplayIfNeeded = () => {
    for (;;) {
      const round = state().round as { kind: string; phase?: 'showdown' | 'payout'; payoutSteps?: unknown[] } | null
      if (!round || round.kind !== 'showdown-display') return
      clock.advance(SVARA_SHOWDOWN_DISPLAY_MS + Math.max(1, round.payoutSteps?.length ?? 1) * SVARA_PAYOUT_STEP_MS)
      sync()
    }
  }
  const ok = (player: string, command: any, extra = {}) => {
    finishDealingIfNeeded()
    resolveShowdownDisplayIfNeeded()
    const result = submit(player, command, extra)
    assert.equal(result?.type, 'svara_command_result', JSON.stringify(result)); assert.equal(result.status, 'applied')
    resolveShowdownDisplayIfNeeded()
    return result
  }
  const act = (p: string, action: any) => ok(p, { type: 'act', action })
  const sync = (p = 'a') => send(p, { type: 'request_svara_table_state', matchId })
  const state = () => runtime.exportInternalStateForServer(matchId)
  const view = (p = 'a') => runtime.getPlayerSnapshot(matchId, { playerId: p })
  const timing = (p = 'a') => { sync(p); return frames.get(p)!.findLast((f) => f.type === 'svara_match_timing' && f.matchId === matchId) }
  const timer = (kind = 'turn', p = 'a') => timing(p).deadlines.find((d: any) => d.kind === kind)
  const absent = (...players: string[]) => {
    for (const playerId of players) runtime.executeSystemCommand(matchId, id(), { type: 'set-absent', playerId, absent: true })
    sync()
  }
  return { runtime, matchId, clock, lobby, frames, sessions, blocked, attach, send, payload, submit, ok, act, sync, state, view, timing, timer, absent, finishDealingIfNeeded, resolveShowdownDisplayIfNeeded }
}
function fixture(capacity: 2 | 3 | 4 = 3, chips = 100, decks: SvaraCard[][] = []) {
  const clock = new Clock()
  const rt = createSvaraMatchRuntime({ random: randomFor(decks), now: clock.now })
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity, entryFee: chips * 10, startMode: 'auto' })
  for (const playerId of ['b', 'c', 'd'].slice(0, capacity - 1)) rt.executeParticipantCommand('m', { playerId }, id(), { type: 'join-seat' })
  const t = mount(rt, 'm', clock)
  t.sync()
  // 2Б.3.7.4Б: real fake-clock wait through the server dealing-presentation
  // phase (Вход + карти), exactly as the real lifecycle timer would fire it.
  clock.advance(svaraDealingAnimationMs(capacity))
  t.sync()
  return t
}
function joining(capacity: 3 | 4 = 3) {
  const order = capacity === 3 ? ['b', 'c', 'a'] : ['b', 'c', 'd', 'a']
  const t = fixture(capacity, 100, [buildSvaraDeckForHands(order, { b: TIE1, a: TIE2, c: LOW })])
  t.ok('b', { type: 'look' }); t.act('b', { kind: 'bet', total: 1 })
  t.act('c', { kind: 'fold' }); if (capacity === 4) t.act('d', { kind: 'fold' })
  t.act('a', { kind: 'call' })
  assert.equal(t.state().round?.kind, 'svara-joining')
  return t
}

try {
  check('valid move before 15s cancels only its turn; stale/early callbacks never fold the next player', () => {
    const t = fixture(), old = t.clock.live()[0]!
    t.clock.advance(14_999)
    t.act('b', { kind: 'fold' })
    assert.equal(t.timer().playerId, 'c'); assert.equal(t.timer().remainingMs, 15_000)
    const before = JSON.stringify(t.state()); old.callback(); old.callback()
    assert.equal(JSON.stringify(t.state()), before)
    const early = t.clock.live().find((j) => j.at === t.timer().deadlineAt)!
    early.callback(); assert.equal(t.timer().remainingMs, 15_000)
  })
  check('expiry atomically folds and marks absent; second expiry pauses with no new entry', () => {
    const t = fixture()
    const entries = () => t.state().ledger.filter((e) => e.type === 'entry').length
    t.clock.advance(15_000)
    assert.equal(t.state().status.b, 'absent'); assert((t.state().round as any).betting.folded.includes('b'))
    assert.equal(t.timer().playerId, 'c')
    t.clock.advance(15_000)
    assert.equal(t.state().status.c, 'absent')
    // 2Б.3.7.1: a е единствен останал → 5-секунден избор, после автоматично скрива (не отсъствие/отказ).
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    assert.equal(t.timer('reveal-choice').remainingMs, 5_000); assert.equal(t.timer('reveal-choice').playerId, 'a')
    t.clock.advance(5_000)
    assert.equal(t.state().round, null); assert.equal(t.state().status.a, 'active', 'expiry never marks the deciding winner absent')
    assert.equal(t.timer('presence-wait').remainingMs, 300_000)
    const count = entries(); t.clock.advance(299_999)
    assert.equal(entries(), count); assert.equal(t.state().phase, 'in-progress')
    t.clock.advance(1); assert.equal(t.state().winnerId, 'a'); assert.equal(t.state().finishReason, 'prolonged-absence')
    assert.equal(entries(), count); assert.equal(t.clock.live().length, 0)
  })
  check('reveal choice: 5s to decide, exactly 3s of public display after "show", then the next deal can start', () => {
    const t = fixture()
    t.act('b', { kind: 'fold' }); t.act('c', { kind: 'fold' })
    const pending = t.state().round as any
    assert.equal(pending.kind, 'reveal-choice'); assert.equal(pending.winnerId, 'a')
    assert.equal(t.timer('reveal-choice').remainingMs, 5_000); assert.equal(t.timer('reveal-choice').playerId, 'a')
    assert.equal(t.submit('b', { type: 'reveal-cards' }).code, 'not_allowed', 'only the winner may choose')
    t.ok('a', { type: 'reveal-cards' })
    const revealed = t.state().round as any
    assert.equal(revealed.decision, 'revealed'); assert.equal(t.timer('reveal-choice'), undefined)
    assert.equal(t.timer('reveal-display').remainingMs, 3_000); assert.equal(t.timer('reveal-display').playerId, 'a')
    assert.equal(t.view('a').you.cards?.length, 3)
    t.clock.advance(2_999)
    assert.equal((t.state().round as any)?.kind, 'reveal-choice', 'display has not closed yet at 2999ms')
    assert.equal(t.submit('a', { type: 'hide-cards' }).code, 'not_allowed', 'already decided; display is not a new choice window')
    t.clock.advance(1)
    // Затварянето на показа веднага позволява (и, тук, автоматично стартира) следващото раздаване.
    assert.notEqual((t.state().round as any)?.kind, 'reveal-choice', 'display closes exactly at 3s')
    assert.equal(t.state().status.a, 'active')
  })
  check('an off-turn exit does not restart the current actor deadline or invalidate its timeout', () => {
    const t = fixture(), end = t.timer().deadlineAt
    t.clock.advance(5_000); t.ok('a', { type: 'exit' })
    assert.equal(t.view().toActId, 'b'); assert.equal(t.timer().deadlineAt, end)
    t.clock.advance(10_000)
    assert.equal(t.state().status.b, 'absent')
    assertSvaraMatchInvariants(t.state())
  })
  check('look/retry/reconnect preserve the original deadline; exact expiry wins before a late Node callback', () => {
    const t = fixture(), end = t.timer().deadlineAt
    t.clock.advance(7_000); t.ok('b', { type: 'look' })
    assert.equal(t.timer().deadlineAt, end)
    const late = t.payload({ type: 'act', action: { kind: 'bet', total: 1 } })
    t.clock.advance(8_000, false) // incoming packet beats dispatch, but not the authoritative deadline
    t.send('b', late)
    assert.equal(t.frames.get('b')!.findLast((f) => f.commandId === late.commandId).code, 'stale_action')
    assert.equal(t.state().status.b, 'absent'); assert(!t.state().ledger.some((e) => e.type === 'bet'))
    const after = JSON.stringify(t.state())
    for (const j of t.clock.jobs.filter((j) => j.at === end)) j.callback()
    assert.equal(JSON.stringify(t.state()), after)
  })
  check('absent pays entry on actual next deal, auto-folds immediately and has no bot/new turn timer', () => {
    const t = fixture()
    t.clock.advance(15_000) // b absent; a,c still active
    t.act('c', { kind: 'fold' })
    // 2Б.3.7.1: a е единствен останал → избор; скрива, за да продължи автоматично към следващото раздаване.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    t.ok('a', { type: 'hide-cards' })
    t.finishDealingIfNeeded()
    const state = t.state(), round = state.round as any
    assert.equal(round.kind, 'ordinary'); assert.equal(round.contributions.b, 1)
    assert(round.betting.folded.includes('b')); assert.notEqual(t.timer().playerId, 'b')
    assert.equal(state.ledger.filter((e) => e.type === 'bet').length, 0, 'no replacement bets')
  })
  check('return request stays pending/current actions denied; activation only at the next deal', () => {
    const t = fixture()
    t.clock.advance(15_000)
    const before = t.state().stacks.b
    const result = t.ok('b', { type: 'request-return' })
    assert.equal(t.view('b').you.returnPending, true); assert.equal(t.state().status.b, 'absent')
    assert.equal(t.submit('b', { type: 'request-return' }, { commandId: result.commandId }).status, 'duplicate')
    assert.equal(t.submit('b', { type: 'look' }).code, 'player_absent')
    assert.equal(t.submit('b', { type: 'act', action: { kind: 'bet', total: 1 } }).code, 'player_absent')
    t.act('c', { kind: 'fold' })
    // 2Б.3.7.1: a е единствен останал → избор чака преди границата (activateReturns), не веднага.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice'); assert.equal(t.state().status.b, 'absent')
    t.ok('a', { type: 'hide-cards' })
    assert.equal(t.state().status.b, 'active'); assert.equal(t.view('b').you.returnPending, false)
    assert.equal(t.state().stacks.b, before! - 1, 'only the next normal entry is charged')
  })
  check('return at a paused boundary resumes; one returned from zero gets a fresh five minutes', () => {
    const t = fixture(2)
    t.clock.advance(15_000)
    // 2Б.3.7.1: heads-up timeout оставя единствен победител → 5-секунден избор преди границата; изтича автоматично.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    t.clock.advance(5_000)
    assert.equal(t.state().round, null); assert(t.timer('presence-wait'))
    t.clock.advance(100_000)
    t.ok('b', { type: 'request-return' })
    assert.equal(t.state().round?.kind, 'ordinary'); assert.equal(t.timer('presence-wait'), undefined)
    const z = fixture(2)
    z.absent('a', 'b')
    // 2Б.3.7.1: първото отсъствие оставя втория играч единствен → избор; изтича автоматично, въпреки отсъствието му.
    assert.equal((z.state().round as any)?.kind, 'reveal-choice')
    z.clock.advance(5_000)
    assert.equal(z.timer('presence-wait').playerId, null)
    z.clock.advance(120_000); z.ok('a', { type: 'request-return' })
    assert.equal(z.timer('presence-wait').playerId, 'a'); assert.equal(z.timer('presence-wait').remainingMs, 300_000)
    const end = z.timer('presence-wait').deadlineAt
    z.ok('a', { type: 'request-return' })
    assert.equal(z.timer('presence-wait').deadlineAt, end, 'another press cannot restart the five minutes')
    const entries = z.state().ledger.filter((e) => e.type === 'entry').length
    z.clock.advance(299_999); assert.equal(z.state().phase, 'in-progress')
    assert.equal(z.state().ledger.filter((e) => e.type === 'entry').length, entries)
    z.clock.advance(1); assert.equal(z.state().winnerId, 'a')
  })
  check('disconnect changes no presence; reconnect before/after expiry restores snapshots/time without reactivation', () => {
    const t = fixture()
    const end = t.timer().deadlineAt
    t.lobby.disconnect('b'); t.clock.advance(5_000)
    assert.equal(t.state().status.b, 'active')
    t.attach('b', 'new-b'); t.lobby.reconnect('new-b')
    assert.equal(t.frames.get('new-b')!.findLast((f) => f.type === 'svara_match_timing').deadlines[0].deadlineAt, end)
    assert.equal(t.timer().remainingMs, 10_000)
    t.lobby.disconnect('new-b'); t.clock.advance(10_001)
    t.attach('b', 'newer-b'); t.lobby.reconnect('newer-b')
    const snapshot = t.frames.get('newer-b')!.findLast((f) => f.type === 'svara_match_snapshot')
    assert.equal(snapshot.you.status, 'absent'); assert.equal(snapshot.you.returnPending, false)
    assert(t.lobby.findCommitment('b'))
  })
  check('a displaced or revoked old connection cannot act after a new authenticated connection takes over', () => {
    const t = fixture()
    t.sessions.set('b', null) // same authoritative live-session fence used by index.ts on displacement
    t.attach('b', 'replacement'); t.lobby.reconnect('replacement')
    const before = JSON.stringify(t.state())
    assert.equal(t.submit('b', { type: 'act', action: { kind: 'fold' } }).code, 'unauthenticated')
    assert.equal(JSON.stringify(t.state()), before)
    t.ok('replacement', { type: 'act', action: { kind: 'fold' } })
  })
  check('Svara join/decline decisions close early only when every eligible outsider decided', () => {
    const t = joining(4), end = t.timer('svara-joining').deadlineAt
    t.clock.advance(5_000)
    const before = t.state().stacks.c, fee = (t.state().round as any).fee
    t.ok('c', { type: 'svara-join' }); assert.equal(t.state().stacks.c, before! - fee)
    assert.equal(t.state().round?.kind, 'svara-joining'); assert.equal(t.timer('svara-joining').deadlineAt, end)
    t.ok('d', { type: 'svara-decline' })
    assert.equal(t.state().round?.kind, 'svara'); assert.equal(t.timer('svara-joining'), undefined)
    assert.equal(t.submit('d', { type: 'svara-join' }).code, 'not_allowed')
  })
  check('Svara window expires: undecided pays nothing; a late join cannot enter the dealt round', () => {
    const t = joining(), before = t.state().stacks.c
    const late = t.payload({ type: 'svara-join' })
    t.clock.advance(15_000, false); t.send('c', late)
    assert.equal(t.state().round?.kind, 'svara')
    assert.equal(t.state().stacks.c, before)
    assert.equal(t.frames.get('c')!.findLast((f) => f.commandId === late.commandId).code, 'stale_action')
    assert(!t.state().ledger.some((e) => e.type === 'svara-join-fee'))
  })
  check('explicit decline is recorded without chips; repeated decisions cannot reopen the same window', () => {
    const t = joining(4), before = t.state().stacks.c
    const result = t.ok('c', { type: 'svara-decline' })
    assert.equal(t.view('c').you.svaraDecision, 'declined')
    assert.equal(t.state().stacks.c, before)
    assert.equal(t.submit('c', { type: 'svara-join' }).code, 'not_allowed')
    assert.equal(t.submit('c', { type: 'svara-decline' }, { commandId: result.commandId }).status, 'duplicate')
    t.ok('d', { type: 'svara-decline' }); assert.equal(t.state().round?.kind, 'svara')
  })
  check('2B377: all authenticated participants see actual declined and undecided statuses, never holders', () => {
    const t = joining(4)
    const initial = [{ playerId: 'c', status: 'undecided' }, { playerId: 'd', status: 'undecided' }]
    for (const player of ['a', 'b', 'c', 'd']) {
      const round = t.view(player).round
      assert.equal(round?.kind, 'svara-joining')
      if (round?.kind === 'svara-joining') assert.deepEqual(round.decisions, initial)
    }
    const chips = JSON.stringify(t.state().stacks), end = t.timer('svara-joining').deadlineAt
    t.ok('c', { type: 'svara-decline' })
    assert.equal(JSON.stringify(t.state().stacks), chips)
    assert.equal(t.timer('svara-joining').deadlineAt, end)
    for (const player of ['a', 'b', 'c', 'd']) {
      const round = t.view(player).round
      if (round?.kind !== 'svara-joining') throw new Error('joining closed too early')
      assert.deepEqual(round.decisions, [{ playerId: 'c', status: 'declined' }, { playerId: 'd', status: 'undecided' }])
      t.sync(player)
      assert.deepEqual(t.frames.get(player)!.findLast((frame) => frame.type === 'svara_match_snapshot').round.decisions, round.decisions)
    }
  })
  check('2B377: joined means a real committed fee and rights; duplicate commandId cannot charge twice', () => {
    const t = joining(4), before = t.state().stacks.c!
    const initial = t.view('c').round
    if (initial?.kind !== 'svara-joining') throw new Error('fixture')
    const result = t.ok('c', { type: 'svara-join' })
    const round = t.view('a').round
    if (round?.kind !== 'svara-joining') throw new Error('fixture')
    assert.deepEqual(round.decisions, [{ playerId: 'c', status: 'joined' }, { playerId: 'd', status: 'undecided' }])
    assert.equal(t.state().stacks.c, before - initial.fee)
    assert(t.view('a').lockedPots.find((pot) => pot.potId === round.potId)!.eligible.includes('c'))
    assert.equal(t.submit('c', { type: 'svara-join' }, { commandId: result.commandId }).status, 'duplicate')
    assert.equal(t.state().stacks.c, before - initial.fee)
  })
  check('2B377: decisions are reconstructed after persistence roundtrip/recovery with identical deadlines and chips', () => {
    const t = joining(4)
    t.ok('c', { type: 'svara-decline' })
    const stored = JSON.parse(JSON.stringify(t.runtime.exportStoredMatchForServer(t.matchId)))
    assert(!JSON.stringify(stored.state.round).includes('decisions'), 'no new durable field or schema')
    const restored = createSvaraMatchRuntime({ now: t.clock.now })
    restored.restoreMatchesForServer([stored])
    for (const playerId of ['a', 'b', 'c', 'd']) assert.deepEqual(restored.getPlayerSnapshot(t.matchId, { playerId }), t.view(playerId))
    assert.deepEqual(restored.getDeadlinesForServer(t.matchId), t.runtime.getDeadlinesForServer(t.matchId))
    assert.deepEqual(restored.exportInternalStateForServer(t.matchId).stacks, t.state().stacks)
  })
  check('2B377: public lobby and outsiders never receive decision details; transition drops the field', () => {
    const t = joining(4)
    t.ok('c', { type: 'svara-decline' })
    assert(!JSON.stringify(t.runtime.getPublicTable(t.matchId)).includes('decisions'))
    assert(!JSON.stringify(t.runtime.getPublicTable(t.matchId)).includes('declined'))
    assert.throws(() => t.runtime.getPlayerSnapshot(t.matchId, { playerId: 'outsider' }))
    t.runtime.registerMatch({ matchId: 'another', creator: { playerId: 'another-player' }, capacity: 2, entryFee: 1000, startMode: 'manual' })
    assert.throws(() => t.runtime.getPlayerSnapshot('another', { playerId: 'a' }))
    t.clock.advance(15000)
    t.sync()
    assert.equal(t.state().round?.kind, 'svara')
    assert(!JSON.stringify(t.view('a')).includes('decisions'))
    assert.equal(t.view('a').you.svaraDecision, null)
  })
  check('2B377: an actual large tied bank excludes outsiders who cannot afford its full fee', () => {
    let state = createSvaraMatch({ tableId: 'poor-outsiders', capacity: 4, entryFee: 1000, creatorId: 'a', startMode: 'manual' })
    let sequence = 0
    const run = (command: WithoutCommandId<SvaraMatchCommand>, env: SvaraMatchEnv = {}) => {
      state = applySvaraMatchCommand(state, { ...command, commandId: `poor-${++sequence}` } as SvaraMatchCommand, env).state
      assertSvaraMatchInvariants(state)
    }
    for (const playerId of ['b', 'c', 'd']) run({ type: 'join-seat', playerId })
    run({ type: 'start-match', playerId: 'a' }, { random: { nextInt: () => 0 } })
    run({ type: 'start-next-round' }, { createDeck: () => buildSvaraDeckForHands(['b', 'c', 'd', 'a'], {
      a: TIE1, b: TIE2, c: LOW, d: '8D 9S 10C',
    }) })
    run({ type: 'finish-dealing', roundId: state.round!.roundId })
    run({ type: 'look', playerId: 'b' })
    run({ type: 'act', playerId: 'b', action: { kind: 'bet', total: 60 } })
    for (const playerId of ['c', 'd', 'a']) run({ type: 'act', playerId, action: { kind: 'call' } })
    assert.equal(state.round?.kind, 'showdown-display')
    run({ type: 'advance-showdown-display', roundId: state.round!.roundId })
    run({ type: 'start-next-round' })
    const snapshot = createSvaraMatchSnapshotMessage('poor-outsiders', state, 'c')
    assert.equal(snapshot.round?.kind, 'svara-joining')
    if (snapshot.round?.kind !== 'svara-joining') throw new Error('fixture')
    assert(snapshot.round.fee > snapshot.seats.find((seat) => seat.playerId === 'c')!.stack)
    assert.deepEqual(snapshot.round.decisions, [])
    assert.equal(snapshot.you.svaraDecision, null)
  })
  check('timeout in a Svara deal folds atomically without a bot or replacement bet', () => {
    const t = joining()
    t.ok('c', { type: 'svara-decline' })
    t.finishDealingIfNeeded()
    const actor = t.view().toActId!
    const bets = t.state().ledger.filter((e) => e.type === 'bet').length
    t.clock.advance(15_000)
    assert.equal(t.state().status[actor], 'absent')
    assert.equal(t.state().ledger.filter((e) => e.type === 'bet').length, bets, 'no automatic voluntary bet')
    assertSvaraMatchInvariants(t.state())
  })
  check('sole active wins every locked pot, including rights originally held by absent opponents', () => {
    const t = joining(), old = t.state(), amount = old.lockedPots.reduce((sum, p) => sum + p.amount, 0)
    t.absent('a', 'b') // c is the sole active player, outside the locked pot
    const before = t.state().stacks.c!
    t.clock.advance(300_000)
    const ended = t.state()
    assert.equal(ended.winnerId, 'c'); assert.equal(ended.stacks.c, before + amount)
    assert.equal(ended.lockedPots.length, 0); assert.equal(ended.carried.length, 0)
    assert.equal(t.view('c').result.message, 'Победа поради продължително отсъствие на противниците')
    assert.equal(t.lobby.findCommitment('a'), null)
  })
  check('sole active with zero free chips wins; unresolvable all-in banks are not redealt while paused', () => {
    const clock = new Clock()
    const rt = createSvaraMatchRuntime({ now: clock.now, random: randomFor([buildSvaraDeckForHands(['b', 'a'], { a: TIE1, b: TIE2 })]) })
    rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity: 2, entryFee: 20, startMode: 'auto' })
    rt.executeParticipantCommand('m', { playerId: 'b' }, id(), { type: 'join-seat' })
    rt.executeSystemCommand('m', id(), { type: 'start-next-round' })
    // 2Б.3.7.4Б: no lobby/lifecycle exists yet at this point — skip the
    // dealing phase directly through the runtime, like a timer-fired finish.
    const dealt338 = rt.exportInternalStateForServer('m').round as { roundId: string }
    rt.executeSystemCommand('m', id(), { type: 'finish-dealing', roundId: dealt338.roundId })
    for (const playerId of ['b', 'a']) {
      rt.executeParticipantCommand('m', { playerId }, id(), { type: 'look' })
      rt.executeParticipantCommand('m', { playerId }, id(), { type: 'act', action: { kind: 'all-in' } })
    }
    rt.executeSystemCommand('m', id(), { type: 'set-absent', playerId: 'b', absent: true })
    const t = mount(rt, 'm', clock); t.sync()
    assert.equal(t.state().stacks.a, 0)
    // 2Б.3.7.6А: the tied all-in showdown now opens its own 3с public
    // display first (no payout steps for a pure tie, so it closes in one
    // step) — THEN the 5-minute presence-wait is planned from that later
    // point, pushing its real deadline back by the display's duration too.
    t.clock.advance(300_000 + SVARA_SHOWDOWN_DISPLAY_MS)
    assert.equal(t.state().winnerId, 'a'); assert.equal(t.state().stacks.a, 4)
  })
  check('carried balance is awarded exactly once, without another entry', () => {
    const t = fixture()
    t.ok('b', { type: 'look' }); t.act('b', { kind: 'bet', total: 30 }); t.ok('b', { type: 'exit' })
    t.absent('a') // c alone; b\'s uncovered, now ownerless layer is carried
    assert.equal(t.state().carried[0]!.amount, 30)
    // 2Б.3.7.1: c е единствен останал → избор; скрива, за да започне изчакването на присъствие.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    t.ok('c', { type: 'hide-cards' })
    const before = t.state().stacks.c!, entries = t.state().ledger.filter((e) => e.type === 'entry').length
    const stale = t.clock.live().filter((j) => j.at === t.timer('presence-wait', 'c').deadlineAt)[0]!
    t.clock.advance(300_000)
    assert.equal(t.state().stacks.c, before + 30); assert.equal(t.state().carried.length, 0)
    const ended = JSON.stringify(t.state()); stale.callback(); stale.callback()
    assert.equal(JSON.stringify(t.state()), ended); assert.equal(t.state().ledger.filter((e) => e.type === 'entry').length, entries)
  })
  check('all absent cancels without winner: unresolved pots close into removed; no new entries or payout', () => {
    const t = joining()
    t.absent('a', 'b', 'c')
    const before = t.state(), locked = before.lockedPots.reduce((sum, p) => sum + p.amount, 0)
    assert.equal(t.timer('presence-wait').playerId, null)
    const entries = before.ledger.filter((e) => e.type === 'entry').length
    t.clock.advance(300_000)
    const state = t.state(), result = t.view().result
    assert.equal(state.winnerId, null); assert.equal(state.phase, 'finished'); assert.equal(result.aborted, true)
    assert.equal(result.reason, 'all-absent'); assert.equal(state.removedChips, before.removedChips + locked)
    assert.deepEqual(state.stacks, before.stacks); assert.equal(state.lockedPots.length, 0)
    assert.equal(state.ledger.filter((e) => e.type === 'entry').length, entries)
    assertSvaraMatchInvariants(state)
  })
  check('last surviving absent player is not automatically declared a winner when others exit', () => {
    const t = fixture(2)
    t.absent('b')
    // 2Б.3.7.1: a е единствен останал (b отсъства) → избор; изходът на a НЕ го решава вместо него.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    t.ok('a', { type: 'exit' })
    assert.equal((t.state().round as any)?.kind, 'reveal-choice', 'изходът на победителя не замества избора му')
    t.clock.advance(5_000) // автоматично скрива — изтичането не зависи от статуса на a
    assert.equal(t.state().round, null)
    assert.equal(t.state().phase, 'in-progress'); assert.equal(t.state().winnerId, null)
    assert.equal(t.timer('presence-wait', 'b').playerId, null)
    t.clock.advance(300_000)
    assert.equal(t.state().phase, 'finished'); assert.equal(t.state().winnerId, null)
    assert.equal(t.state().finishReason, 'all-absent')
  })
  check('wait owner changes/last active becomes absent fence old callbacks; two returns cancel the wait', () => {
    const t = fixture(2)
    t.clock.advance(15_000)
    // 2Б.3.7.1: heads-up timeout оставя единствен победител → избор, изтича автоматично след 5 сек.
    assert.equal((t.state().round as any)?.kind, 'reveal-choice')
    t.clock.advance(5_000)
    const old = t.clock.live().find((j) => j.at === t.timer('presence-wait').deadlineAt)!
    t.clock.advance(100_000); t.absent('a')
    assert.equal(t.timer('presence-wait').playerId, null)
    t.ok('b', { type: 'request-return' })
    assert.equal(t.timer('presence-wait').playerId, 'b')
    old.callback(); assert.equal(t.state().phase, 'in-progress')
    t.clock.advance(100_000); t.ok('a', { type: 'request-return' })
    assert.equal(t.state().round?.kind, 'ordinary'); assert.equal(t.timer('presence-wait'), undefined)
  })
  check('private return identity, expired sessions/roles/flag, system injection and cross-game commitment', () => {
    const t = fixture(2); t.clock.advance(15_000)
    assert.equal(t.submit('outsider', { type: 'request-return', playerId: 'b' }).code, 'not_a_participant')
    assert.equal(t.submit('a', { type: 'request-return', playerId: 'b' }).code, 'not_allowed')
    t.sessions.set('b', null); assert.equal(t.submit('b', { type: 'request-return' }).code, 'unauthenticated')
    t.attach('b'); t.sessions.set('b', { account: { role: 'player' }, profile: { profileId: 'b' } })
    assert.equal(t.submit('b', { type: 'request-return' }).code, 'forbidden_role')
    t.attach('b'); process.env.SVARA_TEST_ENABLED = '0'
    assert.equal(t.submit('b', { type: 'request-return' }).code, 'feature_disabled'); process.env.SVARA_TEST_ENABLED = '1'
    for (const type of ['turn-timeout', 'activate-returns', 'close-svara-joining', 'finish-presence-wait', 'set-absent']) assert.equal(parseClientMessage(JSON.stringify(t.payload({ type, playerId: 'a', winnerId: 'b' }))), null)
    assert(t.lobby.findCommitment('b')); t.lobby.disconnect('b'); assert(t.lobby.findCommitment('b'))
    t.send('a', { type: 'create_svara_table', capacity: 2, entryFee: 100, startMode: 'auto', requestId: id() })
    assert.equal(t.frames.get('a')!.at(-1).code, 'svara_commitment')
  })
  check('plain deadlines and independent matches; shutdown cancels all work without leaked handles', () => {
    const t = fixture(2), other = 'other'
    t.runtime.registerMatch({ matchId: other, creator: { playerId: 'c' }, capacity: 2, entryFee: 1000, startMode: 'auto' })
    t.runtime.executeParticipantCommand(other, { playerId: 'd' }, id(), { type: 'join-seat' })
    t.send('c', { type: 'request_svara_table_state', matchId: other })
    // 2Б.3.7.4Б: no WS-level helper for 'other' here — skip its dealing phase directly.
    const dealtOther = t.runtime.exportInternalStateForServer(other).round as { roundId: string } | null
    if (dealtOther) t.runtime.executeSystemCommand(other, id(), { type: 'finish-dealing', roundId: dealtOther.roundId })
    const before = t.runtime.getMatchRevision(other)
    t.clock.advance(1_000); t.act('b', { kind: 'fold' })
    assert.equal(t.runtime.getMatchRevision(other), before)
    const isolated = createSvaraLifecycle(t.runtime, { clock: new Clock(), onChange: () => {} })
    isolated.refresh(other)
    const data = isolated.exportDeadlines(other)
    assert.equal(data[0]!.kind, 'turn'); assert(data[0]!.baseRevision >= 0)
    assert(!JSON.stringify(data).includes('cancel')); isolated.shutdown()
    t.lobby.shutdown(); assert.equal(t.clock.live().length, 0)
  })
  check('timeout/termination preserve immutable archives and old states; duplicate termination is a no-op', () => {
    let state = createSvaraMatch({ tableId: 'pure', creatorId: 'a', capacity: 3, entryFee: 1000, startMode: 'auto' })
    const apply = (command: any) => { state = applySvaraMatchCommand(state, { ...command, commandId: command.commandId ?? id() } as SvaraMatchCommand, { random: { nextInt: () => 0 } }).state }
    apply({ type: 'join-seat', playerId: 'b' }); apply({ type: 'join-seat', playerId: 'c' }); apply({ type: 'start-next-round' })
    const retained = state, saved = JSON.stringify(state), round = state.round as any
    apply({ type: 'turn-timeout', playerId: 'b', roundId: round.roundId, actionVersion: round.betting.log.length })
    assert.equal(state.ledger[0], retained.ledger[0]); assert(Object.isFrozen(state.ledger[0]))
    apply({ type: 'set-absent', playerId: 'c', absent: true })
    // 2Б.3.7.1: a е единствен останал → избор; скрива, за да достигне границата, нужна за finish-presence-wait.
    assert.equal((state.round as any)?.kind, 'reveal-choice')
    apply({ type: 'hide-cards', playerId: 'a' })
    const before = state, history = state.history[0], old = JSON.stringify(before)
    const command = { type: 'finish-presence-wait', winnerId: 'a', commandId: 'finish-once' }
    apply(command)
    assert.equal(state.history[0], history); assert.equal(state.ledger[0], before.ledger[0])
    assert.equal(JSON.stringify(retained), saved); assert.equal(JSON.stringify(before), old)
    const ended = state; apply(command); assert.equal(state, ended)
    assert.throws(() => apply({ ...command, commandId: 'finish-twice' }))
    assert.equal(state, ended); assertSvaraMatchInvariants(state)
  })
  check('finished review dismissal preserves state/other viewers, rejects outsiders and leaves no timer jobs', () => {
    const t = fixture(2, 100, [buildSvaraDeckForHands(['b', 'a'], { a: 'AS KS QS', b: 'AH 8D 9C' })])
    t.ok('b', { type: 'look' }); t.act('b', { kind: 'all-in' }); t.act('a', { kind: 'all-in' })
    assert.equal(t.state().phase, 'finished')
    const archive = JSON.stringify(t.state()), beforeB = t.frames.get('b')!.length
    const leave = (player: string, requestId = id()) => t.send(player, { type: 'leave_svara_table', matchId: 'm', requestId })
    leave('outsider')
    assert.equal(t.frames.get('outsider')!.at(-1).code, 'not_a_participant')
    leave('a', 'same-exit'); leave('a', 'same-exit')
    assert(!t.frames.get('b')!.slice(beforeB).some((f) => f.type === 'svara_table_left'))
    t.lobby.disconnect('b'); t.attach('b'); t.lobby.reconnect('b')
    assert.equal(t.frames.get('b')!.findLast((f) => f.type === 'svara_match_snapshot').phase, 'finished')
    leave('b')
    assert.equal(JSON.stringify(t.state()), archive, 'External runtime owner retains its identical finished archive')
    assert.equal(t.clock.live().length, 0)
    for (const job of t.clock.jobs) job.callback()
    assert.equal(JSON.stringify(t.state()), archive, 'Stale callbacks modified a finished result')
  })
  check('every transport frame passed privacy checks, without swallowed send/engine failures', () => assert.deepEqual(faults, []))
} finally {
  for (const close of closes) close()
  if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
  else process.env.SVARA_TEST_ENABLED = previousFlag
}
console.log(`\nSvara lifecycle 2Б.3.5: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1

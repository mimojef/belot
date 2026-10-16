/** Deterministic protocol -> authenticated adapter -> real runtime/engine checks.
 * No DB, network, timers, benchmarks or production settings. Real-wire coverage
 * uses the existing disposable-server harness in checkSvaraLobby2B33.ts. */
import assert from 'node:assert/strict'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { buildSvaraDeckForHands, assertSvaraMatchInvariants } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

let passed = 0
let failed = 0
async function check(label: string, run: () => unknown | Promise<unknown>) {
  try { await run(); passed++; console.log(`  PASS ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
}
const TIE1 = 'KS QS JS', TIE2 = 'KH QH JH', TIE3 = 'KD QD JD'
const HIGH = '7C 7D 7H', LOW = '8C 9D 10H'
let nextId = 0
const id = () => `c${++nextId}`
const previousFlag = process.env.SVARA_TEST_ENABLED
process.env.SVARA_TEST_ENABLED = '1'
const cleanups: Array<() => void> = []
const transportFaults: unknown[] = []

function privacy(value: unknown) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), `forbidden ${key}`)
    privacy(nested)
  }
}

function fixture(capacity: 2 | 3 | 4 = 2, chips = 100, entryPercent: 1 | 2 | 3 | 5 = 1, decks: SvaraCard[][] = [], start = true) {
  // Drive the existing random dependency, including Fisher–Yates. No deck
  // injection API or restore hook is added to the production runtime.
  const swaps: number[] = []
  const runtime = createSvaraMatchRuntime({ random: { nextInt: (max) => {
    if (max === 32) {
      const wanted = (decks.shift() ?? SVARA_ORDERED_DECK).map(svaraCardCode)
      const working = SVARA_ORDERED_DECK.map(svaraCardCode)
      for (let i = 31; i > 0; i--) {
        const j = working.indexOf(wanted[i]!, 0)
        assert(j >= 0 && j <= i)
        swaps.push(j)
        ;[working[i], working[j]] = [working[j]!, working[i]!]
      }
    }
    if (swaps.length) { assert.equal(max, swaps.length + 1); return swaps.shift()! }
    return 0 // first dealer
  } } })
  const sessions = new Map<string, SvaraAccessSession>()
  const frames = new Map<string, any[]>()
  const blocked = new Set<string>()
  const faults: unknown[] = []
  const lobby = createSvaraLobby({ runtime, hasOtherGameCommitment: (player) => blocked.has(player), onError: (cause) => { faults.push(cause); transportFaults.push(cause) } })
  cleanups.push(() => lobby.shutdown())
  let matchId = ''
  function attach(player: string, connection = player) {
    sessions.set(connection, { account: { role: 'admin' }, profile: { profileId: player } })
    frames.set(connection, [])
    lobby.attachConnection(connection, { profileId: player, getSession: () => sessions.get(connection) ?? null, send: (raw) => {
      const frame = typeof raw === 'string' ? JSON.parse(raw) : raw
      privacy(frame)
      if (frame.type === 'svara_match_snapshot') {
        assert.equal(frame.you.playerId, player)
        assert.equal(frame.revision, runtime.getMatchRevision(frame.matchId))
        const state = runtime.exportInternalStateForServer(frame.matchId)
        assertSvaraMatchInvariants(state)
        const round = state.round
        if (round && 'hands' in round) {
          for (const [owner, cards] of Object.entries(round.hands)) {
            if (owner !== player) for (const card of cards) assert(!JSON.stringify(frame).includes(`"${card}"`), `foreign card ${card}`)
          }
          assert.deepEqual(frame.you.cards, frame.you.looked ? round.hands[player] ?? null : null)
        }
      }
      frames.get(connection)!.push(frame)
    } })
  }
  for (const player of ['a', 'b', 'c', 'd', 'outsider']) attach(player)
  const wire = (player: string, payload: any) => {
    const parsed = parseClientMessage(JSON.stringify(payload))
    assert(parsed, `parser rejected ${JSON.stringify(payload)}`)
    lobby.handle(player, parsed as any)
  }
  wire('a', { type: 'create_svara_table', capacity, entryFee: chips * 10, entryPercent, startMode: start ? 'auto' : 'manual', requestId: id() })
  matchId = frames.get('a')!.find((f) => f.type === 'svara_table_updated').table.matchId
  for (const player of ['b', 'c', 'd'].slice(0, capacity - 1)) wire(player, { type: 'join_svara_table', matchId, requestId: id() })
  const rawState = () => JSON.stringify(runtime.exportInternalStateForServer(matchId))
  const payload = (command: any, extra = {}) => ({ type: 'submit_svara_command', matchId, commandId: id(), expectedRevision: runtime.getMatchRevision(matchId), command, ...extra })
  const submit = (player: string, command: any, extra = {}) => {
    const message = payload(command, extra)
    wire(player, message)
    return frames.get(player)!.findLast((f) => f.commandId === message.commandId)
  }
  const ok = (player: string, command: any, extra = {}) => {
    const result = submit(player, command, extra)
    assert.equal(result?.type, 'svara_command_result', JSON.stringify(result))
    assert.equal(result.status, 'applied')
    assert.equal(faults.length, 0, String(faults[0]))
    return result
  }
  const reject = (player: string, command: any, code: string, extra = {}) => {
    const before = rawState()
    const otherCounts = [...frames].filter(([p]) => p !== player).map(([p, f]) => [p, f.length] as const)
    assert.equal(submit(player, command, extra)?.code, code)
    assert.equal(rawState(), before, 'rejection mutated state')
    for (const [p, count] of otherCounts) assert.equal(frames.get(p)!.length, count, 'false broadcast after rejection')
  }
  const state = () => runtime.exportInternalStateForServer(matchId)
  const view = (player: string) => runtime.getPlayerSnapshot(matchId, { playerId: player })
  const actor = () => view('a').toActId!
  const look = (player: string) => ok(player, { type: 'look' })
  const act = (player: string, action: any) => ok(player, { type: 'act', action })
  return { runtime, lobby, frames, sessions, blocked, faults, matchId, decks, wire, attach, payload, submit, ok, reject, rawState, state, view, actor, look, act }
}

try {
  await check('strict parser: bounded IDs/revision/amounts; identity stripped; all system commands denied', () => {
    const base = { type: 'submit_svara_command', matchId: 'm', commandId: 'x', expectedRevision: 0, command: { type: 'look' } }
    const parsed = parseClientMessage(JSON.stringify({ ...base, playerId: 'victim', actorId: 'victim', profileId: 'victim', command: { type: 'look', playerId: 'victim' } }))
    assert.deepEqual(parsed, base)
    for (const command of [{ type: 'act', action: { kind: 'bet', total: 10, playerId: 'victim' } }, { type: 'act', action: { kind: 'no-bet' } }, { type: 'svara-join' }, { type: 'exit' }]) assert(parseClientMessage(JSON.stringify({ ...base, command })))
    for (const extra of [{ commandId: '' }, { commandId: 'x'.repeat(65) }, { matchId: 'x'.repeat(65) }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { expectedRevision: undefined }, { command: [] }, { command: { type: 'act', action: [] } }]) assert.equal(parseClientMessage(JSON.stringify({ ...base, ...extra })), null)
    for (const total of [-1, 0, 1.5, '10', null, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(parseClientMessage(JSON.stringify({ ...base, command: { type: 'act', action: { kind: 'bet', total } } })), null)
    for (const type of ['start-next-round', 'svara-start', 'advance-allin-svara', 'absence-expired', 'set-absent', 'join-seat', 'start-match', 'leave-seat']) assert.equal(parseClientMessage(JSON.stringify({ ...base, command: { type } })), null)
  })

  await check('hidden before look; forged identity ignored; private snapshots after each commit', () => {
    const t = fixture()
    assert.equal(t.view('a').you.cards, null); assert.equal(t.view('b').you.cards, null)
    t.ok('b', { type: 'look', playerId: 'a', profileId: 'a' }, { playerId: 'a' })
    assert.equal(t.view('b').you.cards!.length, 3); assert.equal(t.view('a').you.cards, null)
    t.reject('outsider', { type: 'look' }, 'not_a_participant', { playerId: 'a' })
    t.reject('a', { type: 'look' }, 'match_not_found', { matchId: 'missing' })
  })

  await check('bet/call/raise/fold; no false broadcasts on turn/phase/action rejection', () => {
    const t = fixture(3)
    t.reject('a', { type: 'act', action: { kind: 'fold' } }, 'not_your_turn')
    t.look('b'); t.act('b', { kind: 'bet', total: 2 })
    t.look('c'); t.act('c', { kind: 'bet', total: 3 })
    t.act('a', { kind: 'call' }); t.act('b', { kind: 'fold' })
    assert.equal(t.state().history.length, 1)
    assert.equal(t.view('a').round?.kind, 'ordinary', 'next deal automatically starts')
    const lobby = fixture(2, 100, 1, [], false)
    lobby.reject('a', { type: 'look' }, 'wrong_phase')
    t.reject(t.actor(), { type: 'act', action: { kind: 'no-bet' } }, 'invalid_action')
  })

  await check('blind sequence, seen switch, insufficient blind chips and all-in', () => {
    const t = fixture(3)
    t.act('b', { kind: 'blind-bet', total: 2 })
    t.act('c', { kind: 'blind-bet', total: 4 })
    t.look('a'); t.act('a', { kind: 'bet', total: 8 })
    assert.equal((t.state().round as any).betting.blind.status, 'closed')
    const short = fixture(2, 1, 1)
    // Entry consumes both stacks; automatic all-in comparisons finish the match.
    assert.equal(short.state().phase, 'finished')
    const small = fixture(2, 2, 1)
    small.reject('b', { type: 'act', action: { kind: 'blind-bet', total: 2 } }, 'insufficient_chips')
    small.reject('b', { type: 'act', action: { kind: 'all-in' } }, 'invalid_action')
    small.look('b')
    const revision = small.runtime.getMatchRevision(small.matchId)
    small.act('b', { kind: 'all-in' })
    small.reject('b', { type: 'act', action: { kind: 'all-in' } }, 'stale_action', { expectedRevision: revision })
    small.act('a', { kind: 'all-in' })
    assert.equal(small.state().phase, 'finished')
  })

  await check('the existing fourth heads-up no-bet action is playable through the wire parser', () => {
    const t = fixture()
    for (let round = 0; round < 3; round++) {
      t.act(t.actor(), { kind: 'fold' })
      // 2Б.3.7.1: heads-up fold оставя единствен победител → избор преди края на рунда; скрива.
      const pending = t.state().round as any
      assert.equal(pending.kind, 'reveal-choice')
      t.ok(pending.winnerId, { type: 'hide-cards' })
    }
    assert.equal((t.state().round as any).isFourthHeadsUp, true)
    assert.equal(t.view(t.actor()).you.betting?.noBet, true)
    t.act(t.actor(), { kind: 'no-bet' }); t.act(t.actor(), { kind: 'no-bet' })
    assert.equal(t.state().history.length, 4)
    assert.equal(t.state().headsUpNoBetStreak, 0)
  })

  await check('idempotent bet after disconnect; conflicts precede stale; two players share an ID', () => {
    const t = fixture()
    t.look('b')
    const bet = t.payload({ type: 'act', action: { kind: 'bet', total: 2 } }, { commandId: 'same' })
    t.wire('b', bet)
    const committed = t.rawState(), aFrames = t.frames.get('a')!.length
    t.lobby.disconnect('b'); t.attach('b', 'b2')
    t.wire('b2', bet)
    assert.equal(t.frames.get('b2')!.find((f) => f.type === 'svara_command_result').status, 'duplicate')
    assert.equal(t.rawState(), committed); assert.equal(t.frames.get('a')!.length, aFrames)
    t.reject('b2', { type: 'act', action: { kind: 'bet', total: 3 } }, 'command_id_conflict', { commandId: 'same', expectedRevision: 0 })
    t.ok('a', { type: 'look' }, { commandId: 'same' })
    t.ok('a', { type: 'act', action: { kind: 'fold' } })
    t.reject('a', { type: 'act', action: { kind: 'fold' } }, 'stale_action', { expectedRevision: bet.expectedRevision })
  })

  await check('rapid/concurrent commands are serialized; stale second bet cannot apply to a later turn', async () => {
    const t = fixture(3)
    const rev = t.runtime.getMatchRevision(t.matchId)
    await Promise.all([
      Promise.resolve().then(() => t.wire('b', t.payload({ type: 'look' }, { commandId: 'first', expectedRevision: rev }))),
      Promise.resolve().then(() => t.reject('c', { type: 'look' }, 'stale_action', { commandId: 'second', expectedRevision: rev })),
    ])
    const betRev = t.runtime.getMatchRevision(t.matchId)
    t.ok('b', { type: 'act', action: { kind: 'bet', total: 2 } }, { expectedRevision: betRev })
    t.reject('b', { type: 'act', action: { kind: 'bet', total: 3 } }, 'stale_action', { expectedRevision: betRev })
    t.reject('b', { type: 'act', action: { kind: 'fold' } }, 'not_your_turn')
  })

  await check('ordinary Svara preserves outsider window; fee join starts only when nobody else can join', () => {
    const decks = [buildSvaraDeckForHands(['b', 'c', 'a'], { b: TIE1, c: LOW, a: TIE2 })]
    const t = fixture(3, 100, 1, decks)
    t.look('b'); t.act('b', { kind: 'bet', total: 1 }); t.act('c', { kind: 'fold' }); t.act('a', { kind: 'call' })
    assert.equal(t.state().round?.kind, 'svara-joining')
    assert.equal(t.runtime.getAutomaticCommand(t.matchId), null, 'cannot close outsider opportunity')
    const old = t.state(), fee = (old.round as any).fee
    t.ok('c', { type: 'svara-join' }, { commandId: 'fee-once' })
    assert.equal(t.state().stacks.c, old.stacks.c! - fee)
    assert.equal(t.state().round?.kind, 'svara')
    const committed = t.rawState()
    assert.equal(t.submit('c', { type: 'svara-join' }, { commandId: 'fee-once', expectedRevision: 0 }).status, 'duplicate')
    assert.equal(t.rawState(), committed, 'joining fee is never charged twice after phase change')
    t.reject('c', { type: 'svara-join' }, 'not_allowed')
  })

  await check('repeated ordinary Svara; two tied players continue without a timer or new entry', () => {
    const decks = [buildSvaraDeckForHands(['b', 'a'], { b: TIE1, a: TIE2 }), buildSvaraDeckForHands(['a', 'b'], { a: TIE1, b: TIE2 })]
    const t = fixture(2, 100, 1, decks)
    t.look('b'); t.act('b', { kind: 'bet', total: 1 }); t.act('a', { kind: 'call' })
    assert.equal(t.state().round?.kind, 'svara')
    t.look('a'); t.act('a', { kind: 'bet', total: 1 }); t.act('b', { kind: 'call' })
    assert.equal(t.state().round?.kind, 'svara')
    assert(t.state().lockedPots.length >= 2, 'independent tied pots retained')
    assert.equal(t.state().ledger.filter((e) => e.type === 'entry').length, 2, 'no extra entry in Svara')
  })

  await check('all-in Svara handles side pots and repeated main ties; one shared deal per continuation', () => {
    // Two legal fold rounds redistribute chips; the third entry leaves
    // a=10,b=10,c=7. All-ins create main=24 and side=6 (a,b only).
    const decks = [ [...SVARA_ORDERED_DECK], [...SVARA_ORDERED_DECK],
      buildSvaraDeckForHands(['a', 'b', 'c'], { a: TIE1, b: TIE2, c: TIE3 }),
      buildSvaraDeckForHands(['a', 'b', 'c'], { a: TIE1, b: TIE2, c: TIE3 }),
      buildSvaraDeckForHands(['a', 'b', 'c'], { a: HIGH, b: TIE2, c: LOW }) ]
    const u = fixture(3, 10, 1, decks)
    for (const p of ['b', 'c', 'c', 'a']) {
      u.act(p, { kind: 'fold' })
      // 2Б.3.7.1: ако това отказване остави единствен победител, изборът трябва да
      // се разреши (скрива), преди да продължи автоматичният преход към следващото раздаване.
      const pending = u.state().round as any
      if (pending?.kind === 'reveal-choice') u.ok(pending.winnerId, { type: 'hide-cards' })
    }
    assert.deepEqual(u.state().stacks, { a: 10, b: 10, c: 7 })
    while (u.state().round?.kind === 'ordinary' && u.state().history.length < 3) {
      const p = u.actor(); u.look(p); u.act(p, { kind: 'all-in' })
    }
    const special = u.state().history.filter((r) => r.kind === 'allin-svara')
    assert.equal(special.length, 2, 'repeat main tie must advance again')
    assert(special[0]!.pots.some((p) => p.outcome.kind === 'split'), 'side tie splits without another side deal')
    assert(special[0]!.pots.some((p) => p.outcome.kind === 'locked'), 'main tie retains rights')
    assert.equal(u.state().round?.kind, 'ordinary', 'surviving funded players continue after both banks settle')
    assert.equal(u.state().ledger.filter((e) => e.type === 'entry').length, 11, 'nine old entries plus two in the next ordinary deal')
  })

  await check('automatic chains yield without a turn timer, and shutdown cancels continuation', async () => {
    const decks = Array.from({ length: 40 }, (_, i) => buildSvaraDeckForHands(i === 0 ? ['b', 'a'] : ['a', 'b'], { a: TIE1, b: TIE2 }))
    const t = fixture(2, 1, 1, decks)
    assert(t.state().phase === 'in-progress')
    const revision = t.runtime.getMatchRevision(t.matchId)
    await new Promise<void>((done) => setImmediate(done))
    assert(t.runtime.getMatchRevision(t.matchId) > revision)
    t.lobby.shutdown()
    const frozen = t.rawState()
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(t.rawState(), frozen)
    t.reject('a', { type: 'look' }, 'server_unavailable')
  })

  await check('flag, roles, session revocation, shutdown and cross-game checks preserve state', () => {
    const t = fixture()
    process.env.SVARA_TEST_ENABLED = '0'; t.reject('b', { type: 'look' }, 'feature_disabled')
    process.env.SVARA_TEST_ENABLED = '1'
    t.sessions.set('b', { account: { role: 'player' }, profile: { profileId: 'b' } }); t.reject('b', { type: 'look' }, 'forbidden_role')
    t.sessions.set('b', null); t.reject('b', { type: 'look' }, 'unauthenticated')
    t.sessions.set('b', { account: { role: 'admin' }, profile: { profileId: 'a' } }); t.reject('b', { type: 'look' }, 'unauthenticated')
    t.attach('b')
    t.blocked.add('outsider')
    t.wire('outsider', { type: 'create_svara_table', capacity: 2, entryFee: 100, entryPercent: 1, startMode: 'auto', requestId: id() })
    assert.equal(t.frames.get('outsider')!.at(-1).code, 'other_game_commitment')
    assert(t.lobby.findCommitment('a')); assert(t.lobby.findCommitment('b'))
    t.lobby.disconnect('b'); assert(t.lobby.findCommitment('b'))
  })

  await check('multiple tables isolated; exit finishes/releases commitment; replay cannot re-exit or leak cards', () => {
    const t = fixture()
    t.wire('c', { type: 'create_svara_table', capacity: 2, entryFee: 1000, entryPercent: 1, startMode: 'auto', requestId: id() })
    const other = t.frames.get('c')!.find((f) => f.type === 'svara_table_updated').table.matchId
    t.wire('d', { type: 'join_svara_table', matchId: other, requestId: id() })
    const before = JSON.stringify(t.runtime.exportInternalStateForServer(other))
    const exit = t.payload({ type: 'exit' })
    t.wire('b', exit)
    // 2Б.3.7.1: b-ят изход оставя a единствен победител → избор преди края; скрива.
    const pending = t.state().round as any
    assert.equal(pending.kind, 'reveal-choice')
    t.ok('a', { type: 'hide-cards' })
    assert.equal(t.state().phase, 'finished')
    assert.equal(t.lobby.findCommitment('a'), null); assert.equal(t.lobby.findCommitment('b'), null)
    const exitedFrames = t.frames.get('b')!.filter((f) => f.type === 'svara_match_snapshot').length
    const committed = t.rawState()
    t.wire('b', exit)
    assert.equal(t.frames.get('b')!.at(-1).status, 'duplicate')
    assert.equal(t.frames.get('b')!.filter((f) => f.type === 'svara_match_snapshot').length, exitedFrames)
    assert.equal(t.rawState(), committed); assert.equal(JSON.stringify(t.runtime.exportInternalStateForServer(other)), before)
    t.ok('d', { type: 'look' }, { matchId: other, expectedRevision: t.runtime.getMatchRevision(other) })
    assert.equal(t.rawState(), committed)
    t.reject('b', { type: 'look' }, 'not_a_participant')
  })
  await check('every emitted frame passed recipient/card privacy assertions without swallowed transport errors', () => assert.deepEqual(transportFaults, []))
} finally {
  for (const cleanup of cleanups) cleanup()
  if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
  else process.env.SVARA_TEST_ENABLED = previousFlag
}
console.log(`\nSvara gameplay 2Б.3.4: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1

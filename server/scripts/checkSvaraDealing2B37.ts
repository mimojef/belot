/**
 * checkSvaraDealing2B37.ts — Свара, Етап 2Б.3.7.4Б: сървърна фаза на
 * представяне на раздаването (Вход + карти), преди първият ход да стане
 * активен. Детерминистични проверки с контролиран (fake) clock — виж
 * заданието §12 за пълния списък.
 *
 * Пускане (от server/): npm run check:svara-dealing-2b37
 */
import assert from 'node:assert/strict'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { createSvaraLifecycle, svaraDealingAnimationMs, SVARA_TURN_MS, type SvaraClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { SVARA_SHOWDOWN_DISPLAY_MS } from '../src/games/svara/runtime/svaraDeadlines.js'
import {
  applySvaraMatchCommand, assertSvaraMatchInvariants, buildSvaraDeckForHands, createSvaraMatch,
  describeSvaraLifecycle, type SvaraMatchCommand, type SvaraMatchState,
} from '../src/games/svara/engine/svaraMatch.js'
import { validateSvaraStoredMatch } from '../src/games/svara/runtime/svaraStoredMatchValidation.js'
import { SvaraPersistenceError } from '../src/games/svara/runtime/svaraPersistence.js'
import { SVARA_ORDERED_DECK, svaraCardCode, type SvaraCard } from '../src/games/svara/engine/svaraCards.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import type { SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

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
const id = () => `d${++serial}`
let passed = 0, failed = 0
function check(label: string, run: () => void) {
  try { run(); passed++; console.log(`  PASS ${label}`) }
  catch (cause) { failed++; console.error(`  FAIL ${label}`, cause) }
}
const closes: Array<() => void> = []
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
  const lobby = createSvaraLobby({ runtime, clock, hasOtherGameCommitment: () => false, onError: (cause) => { throw cause } })
  closes.push(() => lobby.shutdown())
  function attach(player: string) {
    frames.set(player, []); sessions.set(player, { account: { role: 'admin' }, profile: { profileId: player } })
    lobby.attachConnection(player, { profileId: player, getSession: () => sessions.get(player) ?? null, send: (raw) => {
      const frame = typeof raw === 'string' ? JSON.parse(raw) : raw
      privateFrame(frame)
      frames.get(player)!.push(frame)
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
  const sync = (p = 'a') => send(p, { type: 'request_svara_table_state', matchId })
  const state = () => runtime.exportInternalStateForServer(matchId)
  const timing = (p = 'a') => { sync(p); return frames.get(p)!.findLast((f) => f.type === 'svara_match_timing' && f.matchId === matchId) }
  const timer = (kind = 'dealing', p = 'a') => timing(p).deadlines.find((d: any) => d.kind === kind)
  const snapshot = (p: string) => { sync(p); return frames.get(p)!.findLast((f) => f.type === 'svara_match_snapshot' && f.matchId === matchId) }
  return { runtime, matchId, clock, lobby, frames, attach, send, payload, submit, sync, state, timing, timer, snapshot }
}
function fixture(capacity: 2 | 3 | 4 = 3, chips = 100, decks: SvaraCard[][] = []) {
  const clock = new Clock()
  const rt = createSvaraMatchRuntime({ random: randomFor(decks), now: clock.now })
  rt.registerMatch({ matchId: 'm', creator: { playerId: 'a' }, capacity, entryFee: chips * 10, startMode: 'auto' })
  for (const playerId of ['b', 'c', 'd'].slice(0, capacity - 1)) rt.executeParticipantCommand('m', { playerId }, id(), { type: 'join-seat' })
  const t = mount(rt, 'm', clock)
  t.sync()
  return t
}

try {
  // ─── 1-3: 2/3/4 участника ─────────────────────────────────────────────────
  for (const capacity of [2, 3, 4] as const) {
    check(`${capacity} участника: дилингова фаза с дедлайн dealing, правилна продължителност и 3 карти на участник`, () => {
      const t = fixture(capacity)
      const round = t.state().round as any
      assert.equal(round.kind, 'ordinary'); assert.equal(round.dealing, true)
      assert.equal(Object.keys(round.hands).length, capacity)
      for (const cards of Object.values(round.hands) as string[][]) assert.equal(cards.length, 3)
      const expectedMs = 800 + capacity * 3 * 350
      assert.equal(svaraDealingAnimationMs(capacity), expectedMs)
      const dealing = t.timer('dealing')
      assert(dealing, 'dealing deadline must exist')
      assert.equal(dealing.deadlineAt, t.clock.now() + expectedMs)
    })
  }
  // ─── 5-6: точна продължителност + записан абсолютен deadline ─────────────
  check('точна продължителност за 2/3/4 участника: 2900/3950/5000ms, записан абсолютен deadline', () => {
    for (const [capacity, expected] of [[2, 2900], [3, 3950], [4, 5000]] as const) {
      const t = fixture(capacity)
      const startedAt = t.clock.now()
      const dealing = t.timer('dealing')!
      assert.equal(dealing.deadlineAt, startedAt + expected, `capacity ${capacity}`)
      assert.equal(dealing.kind, 'dealing')
      // Повторно изчитане (без clock advance) пази същия абсолютен срок.
      assert.equal(t.timer('dealing')!.deadlineAt, startedAt + expected)
    }
  })
  // ─── 7-9: няма разрешени действия; отказ не променя състоянието ──────────
  check('няма разрешено "Погледни" по време на фазата; отказът не променя revision/състояние', () => {
    const t = fixture(3), before = JSON.stringify(t.state()), rev = t.runtime.getMatchRevision('m')
    const result = t.submit('a', { type: 'look' })
    assert.equal(result.code, 'dealing_in_progress')
    assert.equal(JSON.stringify(t.state()), before, 'rejected look changed state')
    assert.equal(t.runtime.getMatchRevision('m'), rev, 'rejected look changed revision')
  })
  check('няма разрешен залог (bet/blind-bet/call/all-in/fold/no-bet) по време на фазата; без промяна на състоянието', () => {
    const t = fixture(3), before = JSON.stringify(t.state()), rev = t.runtime.getMatchRevision('m')
    for (const action of [{ kind: 'bet', total: 1 }, { kind: 'blind-bet', total: 2 }, { kind: 'call' }, { kind: 'all-in' }, { kind: 'fold' }, { kind: 'no-bet' }]) {
      const result = t.submit('a', { type: 'act', action })
      assert.equal(result.code, 'dealing_in_progress', JSON.stringify(action))
    }
    assert.equal(JSON.stringify(t.state()), before, 'rejected actions changed state')
    assert.equal(t.runtime.getMatchRevision('m'), rev, 'rejected actions changed revision')
  })
  // ─── 10-11: фазата приключва в точния срок; пълни 15с за първия ход ──────
  check('фазата приключва в точния срок; първият ход получава пълни 15 секунди от края на дилинга', () => {
    const t = fixture(3), ms = svaraDealingAnimationMs(3)
    t.clock.advance(ms - 1)
    assert.equal((t.state().round as any).dealing, true, 'still dealing 1ms before the deadline')
    assert.equal(t.submit('b', { type: 'look' }).code, 'dealing_in_progress')
    t.clock.advance(1)
    const round = t.state().round as any
    assert.equal(round.dealing, false, 'dealing ended exactly at the deadline')
    const turn = t.timer('turn')!
    assert.equal(turn.deadlineAt, 1_000_000 + ms + SVARA_TURN_MS, 'full 15s measured from the end of dealing')
    assert.equal(turn.remainingMs, SVARA_TURN_MS)
  })
  // ─── 12: няма двойно стартиране на хода ──────────────────────────────────
  check('няма двойно стартиране на хода: само едно \'turn\' събитие, само едно \'dealing\'', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    const timing = t.timing()
    assert.equal(timing.deadlines.filter((d: any) => d.kind === 'turn').length, 1)
    assert.equal(timing.deadlines.filter((d: any) => d.kind === 'dealing').length, 0, 'dealing deadline is gone once finished')
  })
  // ─── 13-14: без повторно удържане на Вход / без повторно раздаване ───────
  check('без повторно удържане на Вход и без повторно раздаване около края на дилинга', () => {
    const t = fixture(3)
    const beforeHands = JSON.stringify((t.state().round as any).hands)
    const beforeEntries = t.state().ledger.filter((e) => e.type === 'entry').length
    t.clock.advance(svaraDealingAnimationMs(3))
    assert.equal(JSON.stringify((t.state().round as any).hands), beforeHands, 'hands changed across the dealing boundary')
    assert.equal(t.state().ledger.filter((e) => e.type === 'entry').length, beforeEntries, 'entry charged again')
  })
  // ─── 15: редът след дилъра не се нарушава ────────────────────────────────
  check('редът (първият след дилъра ... дилърът) не се променя от дилинговата фаза', () => {
    const t = fixture(3)
    const round = t.state().round as any
    const order = round.betting.order as string[]
    assert.equal(order[order.length - 1], round.dealerId, 'dealer acts last')
    t.clock.advance(svaraDealingAnimationMs(3))
    assert.deepEqual((t.state().round as any).betting.order, order)
    assert.equal((t.state().round as any).betting.toAct, order[0])
  })
  // ─── 16-18: reconnect в началото / по средата / след края ────────────────
  check('reconnect в началото на дилинга вижда фазата и пълния оставащ срок', () => {
    const t = fixture(2), ms = svaraDealingAnimationMs(2)
    const snap = t.snapshot('b')
    assert.equal(snap.round.dealing, true); assert.equal(snap.toActId, null)
    assert.equal(t.timer('dealing', 'b')!.remainingMs, ms)
  })
  check('reconnect по средата на дилинга не стартира нов цикъл и не удължава срока', () => {
    const t = fixture(3), ms = svaraDealingAnimationMs(3)
    t.clock.advance(1000)
    const remainingBefore = t.timer('dealing', 'c')!.remainingMs
    assert.equal(remainingBefore, ms - 1000)
    t.sync('c'); t.sync('c') // повторен "reconnect"-подобен sync не бива да рестартира
    assert.equal(t.timer('dealing', 'c')!.remainingMs, ms - 1000)
  })
  check('reconnect след края на дилинга вижда реалния ход и неговия дедлайн, не старото раздаване', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    const snap = t.snapshot('a')
    assert.equal(snap.round.dealing, false)
    assert(snap.toActId, 'a real actor must be exposed once dealing has finished')
    assert.equal(t.timer('turn', 'a')!.kind, 'turn')
  })
  // ─── 21: повторна lifecycle обработка е безопасна ────────────────────────
  check('повторната lifecycle обработка (sync/refresh) на дилинг-дедлайна е безопасна', () => {
    const t = fixture(3)
    const before = JSON.stringify(t.state())
    t.sync(); t.sync(); t.sync()
    assert.equal(JSON.stringify(t.state()), before, 'repeated sync mutated state before the deadline')
    t.clock.advance(svaraDealingAnimationMs(3))
    const afterFirst = JSON.stringify(t.state())
    t.sync(); t.sync(); t.sync()
    assert.equal(JSON.stringify(t.state()), afterFirst, 'repeated sync after the deadline re-applied finish-dealing')
  })
  // ─── 22: защитени индивидуални snapshots по време на дилинга ─────────────
  check('защитените snapshots по време на дилинга не показват никакви карти, никакво "на ход" и никакви betting опции', () => {
    const t = fixture(3)
    for (const p of ['a', 'b', 'c']) {
      const snap = t.snapshot(p)
      assert.equal(snap.you.cards, null); assert.equal(snap.you.betting, null)
      assert.equal(snap.toActId, null)
      for (const seat of snap.seats) assert.equal(seat.isToAct, false)
    }
  })
  // ─── 23: стар SQLite snapshot без новото поле/фаза ───────────────────────
  check('стар snapshot без round.dealing се възстановява безопасно като вече активен ход (без ново раздаване/Вход)', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    // Симулираме СТАР запис (преди 2Б.3.7.4Б): премахваме round.dealing изцяло
    // от едно вече раздадено (пост-дилинг) раздаване.
    const legacy = structuredClone(t.state())
    delete (legacy.round as any).dealing
    const view = describeSvaraLifecycle(legacy)
    assert.equal(view.dealing, false, 'missing dealing field must be treated as false (already active)')
    assert(view.actorId, 'an old snapshot without the field must expose its real actor immediately')
    assertSvaraMatchInvariants(legacy)
  })
  check('стар snapshot все още в дилингова фаза (хипотетичен, без поле) би се третирал като вече активен — документирано поведение', () => {
    // Тест на самата семантика на describeSvaraLifecycle: ако полето липсва
    // ИЗЦЯЛО (undefined), то винаги се чете като false ("не дилинг"), дори
    // ако картите тепърва са раздадени — т.е. старите snapshot-и обективно
    // НЕ могат да бъдат в дилингова фаза по конструкция (полето просто не е
    // съществувало преди тази връзка), затова няма "неразрешим" случай.
    const t = fixture(2)
    const legacy = structuredClone(t.state())
    delete (legacy.round as any).dealing
    const view = describeSvaraLifecycle(legacy)
    assert.equal(view.dealing, false)
    assert(view.actorId, 'without the field, the round is always treated as already active')
  })
  // ─── 24: следващо раздаване получава своя собствена дилингова фаза ───────
  check('всяко следващо раздаване (не само първото) получава собствена дилингова фаза', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    const order = (t.state().round as any).betting.order as string[]
    t.submit(order[0]!, { type: 'act', action: { kind: 'fold' } })
    // 2Б.3.7.1: heads-up отказ оставя единствен победител -> избор -> скрива.
    const pending = t.state().round as any
    if (pending.kind === 'reveal-choice') t.submit(pending.winnerId, { type: 'hide-cards' })
    const next = t.state().round as any
    assert.equal(next.kind, 'ordinary'); assert.equal(next.dealing, true, 'the second deal must also start dealing')
    assert(t.timer('dealing'), 'the second deal must get its own dealing deadline')
  })
  // ─── 25: съвместимост с reveal-choice ─────────────────────────────────────
  check('дилинговата фаза на следващото раздаване не пречи на reveal-choice прозореца преди него', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    const order = (t.state().round as any).betting.order as string[]
    t.submit(order[0]!, { type: 'act', action: { kind: 'fold' } })
    assert.equal((t.state().round as any).kind, 'reveal-choice')
    assert.equal(t.timer('reveal-choice')!.kind, 'reveal-choice')
    assert.equal(t.timer('dealing'), undefined, 'no dealing deadline while reveal-choice is open')
  })
  // ─── 26: обикновена Свара получава собствена дилингова фаза; Ол-ин не ────
  check('обикновена Свара (след заключена банка) получава собствена дилингова фаза', () => {
    const tie1 = 'KS QS JS', tie2 = 'KH QH JH', low = '8C 9D 10H'
    const t = fixture(3, 100, [buildSvaraDeckForHands(['b', 'c', 'a'], { b: tie1, c: low, a: tie2 })])
    t.clock.advance(svaraDealingAnimationMs(3))
    t.submit('b', { type: 'look' }); t.submit('b', { type: 'act', action: { kind: 'bet', total: 1 } })
    t.submit('c', { type: 'act', action: { kind: 'fold' } }); t.submit('a', { type: 'act', action: { kind: 'call' } })
    t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
    assert.equal(t.state().round?.kind, 'svara-joining')
    t.submit('c', { type: 'svara-decline' })
    const round = t.state().round as any
    assert.equal(round.kind, 'svara'); assert.equal(round.dealing, true, 'the Svara deal must also start dealing')
    assert.equal(round.participants.length, 2)
    assert.equal(t.timer('dealing')!.deadlineAt, t.clock.now() + svaraDealingAnimationMs(2))
  })
  check('Свара с Ол-ин (повторно раздаване за сравнение) не въвежда дилингова фаза — няма наддаване за нея', () => {
    const tie1 = 'KS QS JS', tie2 = 'KH QH JH'
    const tied = buildSvaraDeckForHands(['a', 'b'], { a: tie1, b: tie2 })
    const t = fixture(2, 1, [tied])
    t.clock.advance(svaraDealingAnimationMs(2))
    // Entry drains both stacks to zero at these chips -> automatic all-in
    // tie, which locks the pot rather than finishing outright. The
    // automatic chain then replays it (svara-joining/svara-start, no
    // outside candidates) with the fallback ordered deck, which settles
    // the lock with a clear winner and finishes the match. 2Б.3.7.6А: EACH
    // of those two real showdowns now opens its own 3с public display
    // first (no payout steps either time: a lock isn't a payout, and
    // neither is the one-shot pot award from a sole-eligible winner) —
    // advance through both before the match is actually marked finished.
    t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
    t.clock.advance(SVARA_SHOWDOWN_DISPLAY_MS)
    assert.equal(t.state().phase, 'finished')
  })
  // ─── 27: без промяна на счетоводните инварианти ──────────────────────────
  check('инвариантите на сметките остават валидни през цялата дилингова фаза и прехода', () => {
    const t = fixture(4)
    assertSvaraMatchInvariants(t.state())
    t.clock.advance(1)
    assertSvaraMatchInvariants(t.state())
    t.clock.advance(svaraDealingAnimationMs(4) - 1)
    assertSvaraMatchInvariants(t.state())
  })
  // ─── Чисто (pure engine) ниво: finish-dealing отхвърля остарели/погрешни round-ове ──
  check('finish-dealing (чист engine) отхвърля несъответстващ roundId и вече приключила фаза', () => {
    let state: SvaraMatchState = createSvaraMatch({ tableId: 'pure', creatorId: 'a', capacity: 2, entryFee: 1000, startMode: 'auto' })
    const apply = (command: Omit<SvaraMatchCommand, 'commandId'>) => { state = applySvaraMatchCommand(state, { ...command, commandId: id() } as SvaraMatchCommand, { random: { nextInt: () => 0 } }).state }
    apply({ type: 'join-seat', playerId: 'b' } as any)
    apply({ type: 'start-next-round' } as any)
    const round = state.round as any
    assert.equal(round.dealing, true)
    assert.throws(() => applySvaraMatchCommand(state, { type: 'finish-dealing', commandId: id(), roundId: 'wrong' } as any),
      (e: unknown) => e instanceof Error && (e as any).code === 'not-allowed')
    apply({ type: 'finish-dealing', roundId: round.roundId } as any)
    assert.equal((state.round as any).dealing, false)
    assert.throws(() => applySvaraMatchCommand(state, { type: 'finish-dealing', commandId: id(), roundId: round.roundId } as any),
      (e: unknown) => e instanceof Error && (e as any).code === 'not-allowed')
    assertSvaraMatchInvariants(state)
  })
  check('validateSvaraStoredMatch приема реален формат с round.dealing=true (с дедлайн kind:\'dealing\')', () => {
    const t = fixture(2)
    const stored = t.runtime.exportStoredMatchForServer('m')
    assert.equal((stored.state.round as any).dealing, true)
    assert(stored.deadlines.some((d) => d.kind === 'dealing'))
    validateSvaraStoredMatch(stored) // не трябва да хвърли
  })
  check('validateSvaraStoredMatch приема и стар формат (round.dealing липсва изцяло) за вече активен ход', () => {
    const t = fixture(2)
    t.clock.advance(svaraDealingAnimationMs(2))
    const stored = t.runtime.exportStoredMatchForServer('m')
    assert.equal((stored.state.round as any).dealing, false)
    const legacy = structuredClone(stored)
    delete (legacy.state.round as any).dealing
    validateSvaraStoredMatch(legacy) // не трябва да хвърли — липсващото поле се третира като false
  })
  check('validateSvaraStoredMatch отхвърля подправен dealing (не-булев) запис', () => {
    const t = fixture(2)
    const stored = t.runtime.exportStoredMatchForServer('m')
    const corrupt = structuredClone(stored); (corrupt.state.round as any).dealing = 'yes'
    assert.throws(() => validateSvaraStoredMatch(corrupt), SvaraPersistenceError)
  })
} finally {
  for (const close of closes) close()
  if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
  else process.env.SVARA_TEST_ENABLED = previousFlag
}
console.log(`\nSvara dealing phase 2Б.3.7.4Б: ${passed} passed, ${failed} failed`)
if (failed) process.exitCode = 1

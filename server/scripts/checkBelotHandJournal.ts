/**
 * checkBelotHandJournal.ts
 *
 * Belot hand журнал (server/src/diagnostics/belotHandJournal/):
 *  [1]  пълен мач с реалния engine (fake clock, малки стъпки) — всяко раздаване:
 *       hand_started с 32 карти, 8 взятки, hand_scored, 0 аномалии, match_ended
 *  [2]  същото с големи стъпки (catch-up) — точкуването се реконструира
 *  [3]  „Без коз“, 47 сурови точки от 3 взятки за защитата — пълна разбивка
 *  [4]  капо (всички 8 взятки) и липса на капо
 *  [5]  висяща игра (равна) и липса на висяща; консумиране на висящи точки
 *  [6]  „Долу картите“ — прието, отказано от играча, изтекло време, бот,
 *       отхвърлено решение
 *  [7]  рестарт и възстановяване (без дублирано hand_started, реконструкция)
 *  [8]  защита от дублирано начисляване + необяснена промяна на резултата
 *  [9]  цялост на 32-те карти (дублирана/липсваща карта, грешен победител)
 *  [10] поддръжка: 30 дни задържане, архивиране, лимит по размер, архиви
 *  [11] журналът не променя state-а и не съдържа токени/connectionId
 *
 * BELOT_JOURNAL_PRINT_SAMPLES=1 отпечатва примерни текстови отчети.
 */

import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../src/core/serverTypes.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import type { ServerAntiBadLuckConfig } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { advanceExpiredServerSweepOfferState } from '../src/game/advanceExpiredServerSweepOfferState.js'
import { getRoomAuthoritativeGameState } from '../src/game/getRoomAuthoritativeGameState.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { normalizeRestoredAuthoritativeState } from '../src/game/normalizeRestoredAuthoritativeState.js'
import type { ServerAuthoritativeGameState, ServerCard, ServerRank, ServerSuit } from '../src/game/serverGameTypes.js'
import { startServerScoringPhase } from '../src/game/startServerScoringPhase.js'
import { submitHumanSweepDecisionForRoom } from '../src/game/submitHumanSweepDecisionForRoom.js'
import { submitServerPlayCard } from '../src/game/submitServerPlayCard.js'
import { syncRoomWithAuthoritativeState } from '../src/game/syncRoomWithAuthoritativeState.js'
import { createBelotHandJournal, type BelotHandJournal } from '../src/diagnostics/belotHandJournal/createBelotHandJournal.js'
import {
  createBelotHandJournalStore,
  type BelotHandJournalStore,
  type BelotHandJournalStoredEvent,
} from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import { loadBelotHandJournalEvents } from '../src/diagnostics/belotHandJournal/loadBelotHandJournalEvents.js'
import { runBelotHandJournalMaintenance, type BelotHandJournalStorageConfig } from '../src/diagnostics/belotHandJournal/runBelotHandJournalMaintenance.js'
import { formatBelotHandJournalReport } from '../src/diagnostics/belotHandJournal/formatBelotHandJournalReport.js'
import { verifyBelotSweepEventsOffline } from '../src/diagnostics/belotHandJournal/verifyBelotSweepEventsOffline.js'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
}

console.log('\n═══ checkBelotHandJournal ═══')

// ─── Fake clock ──────────────────────────────────────────────────────────────
let fakeNow = Date.UTC(2026, 9, 14, 12, 0, 0)
const realDateNow = Date.now
Date.now = () => fakeNow

const ABL_CONFIG: ServerAntiBadLuckConfig = { threshold: 5, resetGeneration: 0 } as ServerAntiBadLuckConfig
const TEST_STORAGE_CONFIG: BelotHandJournalStorageConfig = {
  activeDays: 7,
  maxAgeDays: 30,
  zstdLevel: 6,
  maxTotalBytes: 1536 * 1024 * 1024,
  warnRatio: 0.8,
  startCleanupRatio: 0.95,
  targetRatio: 0.9,
  minFreeDiskBytes: 0,
}
const PRINT_SAMPLES = process.env.BELOT_JOURNAL_PRINT_SAMPLES === '1'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function auth(room: ServerRoom): ServerAuthoritativeGameState {
  const state = getRoomAuthoritativeGameState(room)
  assert(state !== null, 'missing authoritative state')
  return state
}

let roomCounter = 0
function buildRealisticRoom(): ServerRoom {
  roomCounter += 1
  const id = `journal-room-${roomCounter}`
  const { room: r1 } = createRoomWithHumanHost({
    roomId: id,
    connectionId: `conn-${id}-1`,
    identity: { displayName: 'Lidiya', profileId: `profile-${id}-lidiya` } as never,
  })
  const { room: r2 } = addHumanToRoom(r1, {
    connectionId: `conn-${id}-2`,
    identity: { displayName: 'ANI777', profileId: `profile-${id}-ani` } as never,
  })
  const { room: r3 } = addBotToRoom(r2, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'MYSTERY' } } as never)
  const { room: r4 } = addBotToRoom(r3, { difficulty: 'normal', behaviorPreset: 'balanced', identity: { displayName: 'Vladei' } } as never)
  return initializeRoomAuthoritativeGameState(r4)
}

async function createTempJournal(dir?: string): Promise<{ dir: string; store: BelotHandJournalStore; journal: BelotHandJournal }> {
  const directory = dir ?? (await mkdtemp(join(tmpdir(), 'belot-hand-journal-')))
  const store = await createBelotHandJournalStore({ directory })
  const journal = createBelotHandJournal({ store, now: () => fakeNow, scheduleFlush: (flush) => flush() })
  return { dir: directory, store, journal }
}

function allEvents(store: BelotHandJournalStore, roomId?: string): BelotHandJournalStoredEvent[] {
  return store.queryEvents(roomId ? { roomId } : { sinceMs: 0 })
}

function anomalies(events: readonly BelotHandJournalStoredEvent[]): BelotHandJournalStoredEvent[] {
  return events.filter((event) => event.eventType === 'anomaly')
}

function describeAnomalies(events: readonly BelotHandJournalStoredEvent[]): string {
  return anomalies(events)
    .map((event) => `${(event.payload as any).anomalyType}: ${(event.payload as any).check?.detail}`)
    .join(' || ')
}

function observe(journal: BelotHandJournal, prev: ServerRoom | null, next: ServerRoom, origin: 'direct_submit' | 'worker_tick'): void {
  const before = JSON.stringify(next)
  const prevBefore = prev ? JSON.stringify(prev) : null
  journal.observeRoomTransition(prev, next, origin)
  assert(JSON.stringify(next) === before, 'journal mutated next room')
  assert(prev === null || JSON.stringify(prev) === prevBefore, 'journal mutated previous room')
}

function simulateMatch(journal: BelotHandJournal, stepMs: number): { room: ServerRoom; commits: number } {
  let room = buildRealisticRoom()
  observe(journal, null, room, 'worker_tick')
  let commits = 0
  for (let step = 0; step < 400000; step += 1) {
    fakeNow += stepMs
    const next = advanceRoomAuthoritativeGame(room, fakeNow, ABL_CONFIG)
    if (next !== room) {
      observe(journal, room, next, 'worker_tick')
      commits += 1
      room = next
    }
    if (auth(room).phase === 'match-ended') break
  }
  return { room, commits }
}

// ─── Scripted hands ──────────────────────────────────────────────────────────

const NT_POWER: Record<ServerRank, number> = { '7': 0, '8': 1, '9': 2, J: 3, Q: 4, K: 5, '10': 6, A: 7 }

type TrickSpec = { suit: ServerSuit; ranks: [ServerRank, ServerRank, ServerRank, ServerRank]; winner: Seat }
type ScriptedPlay = { seat: Seat; card: ServerCard }

function seatsFrom(leader: Seat): Seat[] {
  const index = SERVER_SEAT_ORDER.indexOf(leader)
  return [0, 1, 2, 3].map((offset) => SERVER_SEAT_ORDER[(index + offset) % 4]!)
}

function buildScript(specs: TrickSpec[], firstLeader: Seat): { hands: Record<Seat, ServerCard[]>; plays: ScriptedPlay[] } {
  const hands: Record<Seat, ServerCard[]> = { bottom: [], right: [], top: [], left: [] }
  const plays: ScriptedPlay[] = []
  let leader = firstLeader
  for (const spec of specs) {
    const order = seatsFrom(leader)
    const ranks = [...spec.ranks].sort((a, b) => NT_POWER[b] - NT_POWER[a])
    const assignment = new Map<Seat, ServerRank>()
    assignment.set(spec.winner, ranks[0]!)
    const others = order.filter((seat) => seat !== spec.winner)
    others.forEach((seat, index) => assignment.set(seat, ranks[index + 1]!))
    for (const seat of order) {
      const rank = assignment.get(seat)!
      const card: ServerCard = { id: `${spec.suit}-${rank}`, suit: spec.suit, rank }
      hands[seat].push(card)
      plays.push({ seat, card })
    }
    leader = spec.winner
  }
  return { hands, plays }
}

let playingTemplate: ServerRoom | null = null

function getPlayingTemplate(): ServerRoom {
  if (playingTemplate !== null) return playingTemplate
  let room = buildRealisticRoom()
  for (let step = 0; step < 100000; step += 1) {
    fakeNow += 250
    room = advanceRoomAuthoritativeGame(room, fakeNow, ABL_CONFIG)
    const state = auth(room)
    if (state.phase === 'playing' && state.playing?.hasStarted) break
  }
  playingTemplate = room
  return room
}

function scriptedRoom(params: {
  specs: TrickSpec[]
  firstLeader: Seat
  contract?: 'no-trumps' | 'suit' | 'all-trumps'
  bidderSeat?: Seat
  carryOver?: { teamA: number; teamB: number }
  match?: { teamA: number; teamB: number }
}): { room: ServerRoom; plays: ScriptedPlay[] } {
  const template = getPlayingTemplate()
  const base = auth(template)
  const { hands, plays } = buildScript(params.specs, params.firstLeader)
  const state: ServerAuthoritativeGameState = {
    ...base,
    phase: 'playing',
    phaseEnteredAt: fakeNow,
    players: {
      bottom: { ...base.players.bottom, mode: 'human', controlledByBot: false },
      right: { ...base.players.right, mode: 'human', controlledByBot: false },
      top: { ...base.players.top, mode: 'bot', controlledByBot: false },
      left: { ...base.players.left, mode: 'bot', controlledByBot: false },
    },
    hands,
    deck: [],
    bidding: {
      ...base.bidding,
      hasEnded: true,
      winningBid: {
        seat: params.bidderSeat ?? 'bottom',
        contract: params.contract ?? 'no-trumps',
        trumpSuit: null,
        doubled: false,
        redoubled: false,
      },
    },
    declarations: [],
    playing: {
      ...base.playing!,
      hasStarted: true,
      currentTurnSeat: params.firstLeader,
      currentTrick: { leaderSeat: params.firstLeader, currentSeat: params.firstLeader, plays: [], winnerSeat: null, trickIndex: 0 },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
      wonTricksByTeam: { A: [], B: [] },
      sweepOffer: null,
      declinedSweepSeats: [],
      sweepResolution: null,
    },
    scoring: null,
    matchEnded: null,
    score: {
      ...base.score,
      match: params.match ?? { teamA: 0, teamB: 0 },
      carryOver: params.carryOver ?? { teamA: 0, teamB: 0 },
    },
  }
  return { room: syncRoomWithAuthoritativeState(template, state, fakeNow), plays }
}

type SweepPolicy = 'player_decline' | 'timeout' | 'accept' | 'reject_then_accept'

function playScript(
  journal: BelotHandJournal,
  start: ServerRoom,
  plays: ScriptedPlay[],
  sweepPolicy: SweepPolicy = 'player_decline',
): { room: ServerRoom; beforeScoring: ServerRoom; sweepHappened: boolean } {
  let room = start
  observe(journal, null, room, 'direct_submit')
  let sweepHappened = false
  for (const play of plays) {
    let state = auth(room)
    if (state.playing?.sweepResolution) break
    if (state.playing?.sweepOffer) {
      const offer = state.playing.sweepOffer
      fakeNow += 1000
      let next: ServerRoom
      if (sweepPolicy === 'timeout') {
        fakeNow = offer.expiresAt + 1
        next = syncRoomWithAuthoritativeState(room, advanceExpiredServerSweepOfferState(state, offer.expiresAt).state, fakeNow)
        observe(journal, room, next, 'worker_tick')
      } else if (sweepPolicy === 'accept' || sweepPolicy === 'reject_then_accept') {
        if (sweepPolicy === 'reject_then_accept') {
          const wrongSeat: Seat = offer.seat === 'bottom' ? 'right' : 'bottom'
          const rejected = submitHumanSweepDecisionForRoom(room, wrongSeat, 'accept')
          assert(!rejected.ok, 'wrong-seat accept must be rejected')
          journal.recordSweepDecisionRejected(room, wrongSeat, 'accept', rejected.message)
        }
        const result = submitHumanSweepDecisionForRoom(room, offer.seat, 'accept')
        assert(result.ok, `sweep accept failed: ${result.ok ? '' : result.message}`)
        next = result.room
        observe(journal, room, next, 'direct_submit')
        sweepHappened = true
      } else {
        const result = submitHumanSweepDecisionForRoom(room, offer.seat, 'decline')
        assert(result.ok, 'sweep decline failed')
        next = result.room
        observe(journal, room, next, offer.seat === 'top' || offer.seat === 'left' ? 'worker_tick' : 'direct_submit')
      }
      room = next
      state = auth(room)
      if (state.playing?.sweepResolution) break
    }
    fakeNow += 900
    const nextState = submitServerPlayCard(state, play.seat, play.card.id, [])
    assert(nextState !== state, `play rejected ${play.seat} ${play.card.id}`)
    const next = syncRoomWithAuthoritativeState(room, nextState, fakeNow)
    observe(journal, room, next, play.seat === 'top' || play.seat === 'left' ? 'worker_tick' : 'direct_submit')
    room = next
  }
  const beforeScoring = room
  fakeNow += 4000
  const scored = syncRoomWithAuthoritativeState(room, startServerScoringPhase(auth(room)), fakeNow)
  observe(journal, room, scored, 'worker_tick')
  return { room: scored, beforeScoring, sweepHappened }
}

function handEvents(events: readonly BelotHandJournalStoredEvent[], type: string): BelotHandJournalStoredEvent[] {
  return events.filter((event) => event.eventType === type)
}

// NT: защитата (right/left) взима 3 взятки = 47 т. от карти, изпълнителят
// (bottom) — 5 взятки + последната.
const NT47_SPECS: TrickSpec[] = [
  { suit: 'spades', ranks: ['J', '9', '8', '7'], winner: 'bottom' },
  { suit: 'spades', ranks: ['A', '10', 'K', 'Q'], winner: 'right' },
  { suit: 'hearts', ranks: ['A', 'K', '9', '7'], winner: 'right' },
  { suit: 'diamonds', ranks: ['K', '9', '8', '7'], winner: 'left' },
  { suit: 'hearts', ranks: ['10', 'Q', 'J', '8'], winner: 'top' },
  { suit: 'diamonds', ranks: ['A', '10', 'Q', 'J'], winner: 'top' },
  { suit: 'clubs', ranks: ['J', '9', '8', '7'], winner: 'top' },
  { suit: 'clubs', ranks: ['A', '10', 'K', 'Q'], winner: 'bottom' },
]

// NT равна: 55 + 10 срещу 65 → 130/130.
const TIE_SPECS: TrickSpec[] = [
  { suit: 'clubs', ranks: ['A', '10', 'K', 'Q'], winner: 'right' },
  { suit: 'clubs', ranks: ['J', '9', '8', '7'], winner: 'left' },
  { suit: 'diamonds', ranks: ['A', '10', 'Q', 'J'], winner: 'right' },
  { suit: 'hearts', ranks: ['K', 'Q', 'J', '9'], winner: 'left' },
  { suit: 'spades', ranks: ['A', '10', 'K', 'Q'], winner: 'bottom' },
  { suit: 'hearts', ranks: ['A', '10', '8', '7'], winner: 'top' },
  { suit: 'diamonds', ranks: ['K', '9', '8', '7'], winner: 'bottom' },
  { suit: 'spades', ranks: ['J', '9', '8', '7'], winner: 'top' },
]

// Капо: claimant печели всичко; след първата взятка държи най-високата
// карта във всяка боя → „Долу картите“ е допустимо.
function capotSpecs(winner: Seat): TrickSpec[] {
  return (['spades', 'hearts', 'diamonds', 'clubs'] as const).flatMap((suit) => [
    { suit, ranks: ['A', 'K', '9', '7'] as TrickSpec['ranks'], winner },
    { suit, ranks: ['10', 'Q', 'J', '8'] as TrickSpec['ranks'], winner },
  ])
}

// ─── [1] full match, small steps ─────────────────────────────────────────────
await check('[1] пълен мач (реален engine): всяко раздаване е напълно журналирано, 0 аномалии', async () => {
  const { store, journal } = await createTempJournal()
  const { room, commits } = simulateMatch(journal, 250)
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(auth(room).phase === 'match-ended', `match did not end (phase=${auth(room).phase}, commits=${commits})`)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const started = handEvents(events, 'hand_started')
  const scored = handEvents(events, 'hand_scored')
  const redeals = handEvents(events, 'hand_redeal')
  assert(started.length > 0 && scored.length > 0, 'no hands journaled')
  assert(started.length === scored.length + redeals.length, `started=${started.length} scored=${scored.length} redeal=${redeals.length}`)
  for (const event of started) {
    const deal = (event.payload as any).deal as Record<Seat, string[]>
    const all = SERVER_SEAT_ORDER.flatMap((seat) => deal[seat])
    assert(all.length === 32 && new Set(all).size === 32, `hand ${event.handId} deal has ${new Set(all).size} unique cards`)
    assert(event.profileIds?.includes(`profile-${room.id}-lidiya`), 'hand_started must index human profile ids')
  }
  for (const event of scored) {
    const tricks = events.filter((e) => e.handId === event.handId && e.eventType === 'trick_completed').length
    const sweep = events.find((e) => e.handId === event.handId && e.eventType === 'sweep_accepted')
    const awarded = sweep ? Number((sweep.payload as any).awardedTricksCount) : 0
    assert(tricks + awarded === 8, `hand ${event.handId}: tricks=${tricks} sweepAwarded=${awarded}`)
    assert((event.payload as any).observedVia === 'direct_transition', 'small-step simulation must observe direct scoring transitions')
    const checks = (event.payload as any).checks as { ok: boolean }[]
    assert(checks.length >= 8 && checks.every((c) => c.ok), 'all scoring checks ok')
  }
  const ended = handEvents(events, 'match_ended')
  assert(ended.length === 1, `match_ended count=${ended.length}`)
  const finalScore = (ended[0]!.payload as any).finalScore
  const lastScored = scored[scored.length - 1]!.payload as any
  assert(
    finalScore.teamA === lastScored.explanation.matchAfter.teamA && finalScore.teamB === lastScored.explanation.matchAfter.teamB,
    'final score equals last hand matchAfter',
  )
  // Сумата от точките по раздавания = крайния резултат.
  const sumA = scored.reduce((sum, e) => sum + (e.payload as any).explanation.roundBreakdown.total.teamA, 0)
  const sumB = scored.reduce((sum, e) => sum + (e.payload as any).explanation.roundBreakdown.total.teamB, 0)
  assert(sumA === finalScore.teamA && sumB === finalScore.teamB, `sum of hands ${sumA}/${sumB} != final ${finalScore.teamA}/${finalScore.teamB}`)
  const sources = new Set(
    handEvents(events, 'trick_completed').flatMap((e) => ((e.payload as any).plays as any[]).map((p) => p.source)),
  )
  assert(sources.has('bot_original'), `play sources recorded: ${[...sources].join(',')}`)
  console.log(`      hands=${started.length} scored=${scored.length} redeals=${redeals.length} events=${events.length} commits=${commits} final=${finalScore.teamA}/${finalScore.teamB}`)
  journal.close()
})

// ─── [2] catch-up ────────────────────────────────────────────────────────────
await check('[2] мач с големи стъпки (catch-up): точкуването се реконструира, 0 аномалии', async () => {
  const { store, journal } = await createTempJournal()
  const { room } = simulateMatch(journal, 40000)
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(auth(room).phase === 'match-ended', 'match ended')
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const scored = handEvents(events, 'hand_scored')
  assert(scored.length > 0, 'hands scored')
  const viaCatchUp = scored.filter((e) => (e.payload as any).observedVia === 'catch_up').length
  assert(viaCatchUp > 0, 'at least one hand scored via catch_up reconstruction')
  const finalScore = (handEvents(events, 'match_ended')[0]!.payload as any).finalScore
  const sumA = scored.reduce((sum, e) => sum + (e.payload as any).explanation.roundBreakdown.total.teamA, 0)
  const sumB = scored.reduce((sum, e) => sum + (e.payload as any).explanation.roundBreakdown.total.teamB, 0)
  assert(sumA === finalScore.teamA && sumB === finalScore.teamB, `catch-up sum ${sumA}/${sumB} != final ${finalScore.teamA}/${finalScore.teamB}`)
  console.log(`      scored=${scored.length} viaCatchUp=${viaCatchUp}`)
  journal.close()
})

// ─── [3] NT 47 ───────────────────────────────────────────────────────────────
await check('[3] „Без коз“: 47 сурови точки от 3 взятки за защитата — пълна разбивка', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom' })
  const result = playScript(journal, room, plays)
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const tricks = handEvents(events, 'trick_completed')
  assert(tricks.length === 8, `tricks=${tricks.length}`)
  const defenderTricks = tricks.filter((e) => (e.payload as any).winnerTeam === 'B')
  assert(defenderTricks.length === 3, 'defenders took 3 tricks')
  assert(defenderTricks.reduce((sum, e) => sum + (e.payload as any).cardPoints, 0) === 47, 'defender card points = 47')
  const scored = handEvents(events, 'hand_scored')[0]!.payload as any
  const x = scored.explanation
  assert(x.contract === 'no-trumps', 'contract')
  assert(x.teams.teamB.cardPoints === 47 && x.teams.teamB.lastTrickBonus === 0 && x.teams.teamB.noTrumpsMultiplier === 2, 'B breakdown')
  assert(x.teams.teamB.rawPoints === 94, `B raw ${x.teams.teamB.rawPoints}`)
  assert(x.teams.teamA.cardPoints === 73 && x.teams.teamA.lastTrickBonus === 10 && x.teams.teamA.rawPoints === 166, 'A breakdown')
  assert(x.outcome.outcome === 'made', 'made')
  assert(x.official.ruleBranch === 'made_points_split_by_rounding', x.official.ruleBranch)
  assert(x.official.rounding.threshold === 5 && x.official.rounding.teamA === 17 && x.official.rounding.teamB === 9, 'rounding 17/9')
  assert(x.roundBreakdown.total.teamA === 17 && x.roundBreakdown.total.teamB === 9, 'round total 17/9')
  assert(x.capotTeam === null && x.carryOverAfter.teamA === 0 && x.carryOverAfter.teamB === 0, 'no capot / no carry')
  assert(scored.applied.matchAfter.teamA === 17 && scored.applied.matchAfter.teamB === 9, 'applied match')
  assert(auth(result.room).score.match.teamA === 17, 'engine result unchanged by journal')
  if (PRINT_SAMPLES) {
    console.log('\n----- ПРИМЕР: пълно раздаване (Без коз, 47 т. за защитата) -----')
    console.log(formatBelotHandJournalReport(events))
    await writeFile(join(tmpdir(), 'belot-journal-sample-nt47.json'), JSON.stringify(events, null, 2))
  }
  journal.close()
})

// ─── [4] capot ───────────────────────────────────────────────────────────────
await check('[4] капо: всички 8 взятки → +180 (Без коз); липса на капо в [3]', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: capotSpecs('bottom'), firstLeader: 'bottom' })
  playScript(journal, room, plays, 'player_decline')
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const x = (handEvents(events, 'hand_scored')[0]!.payload as any).explanation
  assert(x.capotTeam === 'A' && x.teams.teamA.capotBonus === 180 && x.teams.teamB.capotBonus === 0, 'capot bonus to A')
  assert(x.isCapotRound === true && x.teams.teamA.tricksWon === 8, 'capot round')
  assert(handEvents(events, 'sweep_offered').length === 1 && handEvents(events, 'sweep_declined').length === 1, 'offer + player decline')
  assert((handEvents(events, 'sweep_declined')[0]!.payload as any).decidedBy === 'player', 'decided by player')
  journal.close()
})

// ─── [5] tie / carry over ────────────────────────────────────────────────────
await check('[5a] висяща игра: 130/130 → защитата 13, висящи 13 за изпълнителя', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: TIE_SPECS, firstLeader: 'bottom' })
  playScript(journal, room, plays)
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const x = (handEvents(events, 'hand_scored')[0]!.payload as any).explanation
  assert(x.teams.teamA.rawPoints === 130 && x.teams.teamB.rawPoints === 130, `raw ${x.teams.teamA.rawPoints}/${x.teams.teamB.rawPoints}`)
  assert(x.outcome.outcome === 'tie', 'tie')
  assert(x.official.ruleBranch === 'tie_equal_split_bidder_points_held', x.official.ruleBranch)
  assert(x.roundBreakdown.total.teamA === 0 && x.roundBreakdown.total.teamB === 13, 'defenders get 13 now')
  assert(x.carryOverAfter.teamA === 13 && x.carryOverAfter.teamB === 0, 'A carry 13')
  assert(x.official.nextCarryOverReason === 'tie_bidder_recorded_points_times_multiplier_held', 'carry reason')
  journal.close()
})

await check('[5b] висящи точки се консумират: собственикът печели → получава ги; губи → към противника', async () => {
  for (const [carry, expectedTo, reason] of [
    [{ teamA: 13, teamB: 0 }, 'A', 'owner_team_won_round'],
    [{ teamA: 0, teamB: 13 }, 'A', 'owner_team_did_not_win_round'],
  ] as const) {
    const { store, journal } = await createTempJournal()
    const { room, plays } = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom', carryOver: carry, match: { teamA: 40, teamB: 50 } })
    playScript(journal, room, plays)
    journal.flushSync()
    const events = allEvents(store, room.id)
    assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
    const x = (handEvents(events, 'hand_scored')[0]!.payload as any).explanation
    const resolution = x.official.carryOverResolutions[0]
    assert(resolution.points === 13 && resolution.awardedTo === expectedTo && resolution.reason === reason, JSON.stringify(resolution))
    assert(x.roundBreakdown.total.teamA === 30 && x.roundBreakdown.total.teamB === 9, `total ${JSON.stringify(x.roundBreakdown.total)}`)
    assert(x.matchBefore.teamA === 40 && x.matchAfter.teamA === 70 && x.matchAfter.teamB === 59, 'match before/after')
    assert(x.carryOverBefore.teamA === carry.teamA && x.carryOverAfter.teamA === 0 && x.carryOverAfter.teamB === 0, 'carry before/after')
    journal.close()
  }
})

// ─── [6] sweep ───────────────────────────────────────────────────────────────
let sweepAcceptEvents: BelotHandJournalStoredEvent[] = []
await check('[6a] „Долу картите“ прието (+ отхвърлено решение от грешно място) → капо чрез sweep', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: capotSpecs('bottom'), firstLeader: 'bottom' })
  const result = playScript(journal, room, plays, 'reject_then_accept')
  journal.flushSync()
  const events = allEvents(store, room.id)
  sweepAcceptEvents = events
  assert(result.sweepHappened, 'sweep happened')
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const offered = handEvents(events, 'sweep_offered')[0]!.payload as any
  assert(offered.claimantSeat === 'bottom' && offered.remainingTricks === 7, 'offer after trick 0')
  assert(offered.completedTricks.length === 1 && Object.values(offered.remainingHands).every((h: any) => h.length === 7), 'remaining hands at offer')
  assert(offered.whyAllowed.claimantWonLastTrick === true && offered.checks[0].ok === true, 'why allowed + structural check')
  const rejected = handEvents(events, 'sweep_accept_rejected')[0]!.payload as any
  assert(rejected.seat === 'right' && rejected.recheckEligible === null && typeof rejected.reason === 'string', 'rejected decision recorded')
  const accepted = handEvents(events, 'sweep_accepted')[0]!.payload as any
  assert(accepted.awardedTricksCount === 7 && accepted.decidedBy === 'player', 'accepted 7 tricks')
  assert(accepted.checks.every((c: any) => c.ok), 'accept rechecks ok')
  const scored = handEvents(events, 'hand_scored')[0]!.payload as any
  assert(scored.endedBySweep?.claimantSeat === 'bottom', 'scored as ended by sweep')
  assert(scored.explanation.capotTeam === 'A' && scored.explanation.teams.teamA.rawPoints === 440, `raw ${scored.explanation.teams.teamA.rawPoints}`)
  assert(handEvents(events, 'trick_completed').length === 1, 'only 1 real trick')
  const verification = verifyBelotSweepEventsOffline(events)
  assert(verification.length === 2 && verification.every((v) => v.ok), `offline sweep verify ${JSON.stringify(verification)}`)
  if (PRINT_SAMPLES) {
    console.log('\n----- ПРИМЕР: „Долу картите“ -----')
    console.log(formatBelotHandJournalReport(events))
    await writeFile(join(tmpdir(), 'belot-journal-sample-sweep.json'), JSON.stringify(events, null, 2))
  }
  journal.close()
})

await check('[6b] „Долу картите“ изтекло време → timeout_auto_decline, играта продължава', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: capotSpecs('bottom'), firstLeader: 'bottom' })
  playScript(journal, room, plays, 'timeout')
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const declined = handEvents(events, 'sweep_declined')[0]!.payload as any
  assert(declined.decidedBy === 'timeout_auto_decline' && declined.claimantSeat === 'bottom', JSON.stringify(declined))
  assert(handEvents(events, 'trick_completed').length === 8, 'all 8 tricks played after timeout')
  journal.close()
})

await check('[6c] „Долу картите“ на бот → bot_auto_decline', async () => {
  const { store, journal } = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: capotSpecs('top'), firstLeader: 'top', bidderSeat: 'top' })
  playScript(journal, room, plays, 'timeout')
  journal.flushSync()
  const events = allEvents(store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  const declined = handEvents(events, 'sweep_declined')[0]!.payload as any
  assert(declined.decidedBy === 'bot_auto_decline', declined.decidedBy)
  journal.close()
})

// ─── [7] restart ─────────────────────────────────────────────────────────────
await check('[7] рестарт по средата на раздаване: продължава без дубликати; нов журнал реконструира hand_started', async () => {
  const first = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom' })
  // Изиграваме първите 4 взятки (16 карти) с журнал 1.
  let current = room
  observe(first.journal, null, current, 'direct_submit')
  for (const play of plays.slice(0, 16)) {
    fakeNow += 900
    const next = syncRoomWithAuthoritativeState(current, submitServerPlayCard(auth(current), play.seat, play.card.id, []), fakeNow)
    observe(first.journal, current, next, 'direct_submit')
    current = next
  }
  first.journal.close() // PM2 restart: flush + close
  // Snapshot → JSON → restore (както activeRoomSnapshotStore).
  const parsed = JSON.parse(JSON.stringify(current)) as ServerRoom
  const restored: ServerRoom = {
    ...parsed,
    game: { ...parsed.game, authoritativeState: normalizeRestoredAuthoritativeState(parsed.game.authoritativeState as never) },
  }
  const second = await createTempJournal(first.dir)
  current = restored
  for (const play of plays.slice(16)) {
    fakeNow += 900
    const next = syncRoomWithAuthoritativeState(current, submitServerPlayCard(auth(current), play.seat, play.card.id, []), fakeNow)
    observe(second.journal, current, next, 'direct_submit')
    current = next
  }
  const scored = syncRoomWithAuthoritativeState(current, startServerScoringPhase(auth(current)), fakeNow)
  observe(second.journal, current, scored, 'worker_tick')
  second.journal.flushSync()
  const events = allEvents(second.store, room.id)
  assert(anomalies(events).length === 0, `anomalies: ${describeAnomalies(events)}`)
  assert(handEvents(events, 'hand_started').length === 1, `hand_started=${handEvents(events, 'hand_started').length}`)
  assert(handEvents(events, 'trick_completed').length === 8, 'all tricks across restart')
  assert(handEvents(events, 'hand_scored').length === 1, 'scored once')
  const sources = handEvents(events, 'trick_completed').map((e) => (e.payload as any).plays[0].source)
  assert(sources[0] === 'human_manual' && sources[7] === 'human_manual', `sources ${sources.join(',')}`)
  second.journal.close()

  // Празна база (напр. първо пускане на журнала) + стая по средата на раздаване.
  const third = await createTempJournal()
  const midHand = restored
  const nextPlay = plays[16]!
  const after = syncRoomWithAuthoritativeState(midHand, submitServerPlayCard(auth(midHand), nextPlay.seat, nextPlay.card.id, []), fakeNow)
  observe(third.journal, midHand, after, 'direct_submit')
  third.journal.flushSync()
  const reconstructed = handEvents(allEvents(third.store, room.id), 'hand_started')
  assert(reconstructed.length === 1 && (reconstructed[0]!.payload as any).reconstructedMidHand === true, 'reconstructed hand_started')
  assert(anomalies(allEvents(third.store, room.id)).length === 0, 'no anomalies on reconstruction')
  third.journal.close()
})

// ─── [8] duplicate scoring ───────────────────────────────────────────────────
await check('[8] повторно начисляване (след рестарт) и необяснена промяна на резултата → аномалия', async () => {
  const first = await createTempJournal()
  const { room, plays } = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom' })
  const { beforeScoring, room: scored } = playScript(first.journal, room, plays)
  first.journal.close()
  const second = await createTempJournal(first.dir)
  // Същото раздаване се точкува отново (напр. стар snapshot след рестарт).
  observe(second.journal, beforeScoring, scored, 'worker_tick')
  second.journal.flushSync()
  const duplicates = anomalies(allEvents(second.store, room.id)).filter((e) => (e.payload as any).anomalyType === 'duplicate_hand_scoring')
  assert(duplicates.length === 1, `duplicate anomalies=${duplicates.length}`)

  // Резултатът се променя без точкуване.
  const state = auth(beforeScoring)
  const bumped = syncRoomWithAuthoritativeState(beforeScoring, { ...state, score: { ...state.score, match: { teamA: state.score.match.teamA + 26, teamB: state.score.match.teamB } } }, fakeNow)
  observe(second.journal, beforeScoring, bumped, 'direct_submit')
  second.journal.flushSync()
  const unexplained = anomalies(allEvents(second.store, room.id)).filter((e) => (e.payload as any).anomalyType === 'unexplained_match_score_change')
  assert(unexplained.length === 1, `unexplained=${unexplained.length}`)
  second.journal.close()
})

await check('[8b] неуспешен запис rollback-ва и пазача → повторният опит не дава фалшив дубликат', async () => {
  const { store, journal } = await createTempJournal()
  const base = {
    schema: 'belot-hand-journal' as const,
    schemaVersion: 1,
    severity: 'info' as const,
    occurredAtMs: fakeNow,
    occurredAt: new Date(fakeNow).toISOString(),
    roomId: 'rollback-room',
    matchId: 'rollback-room@1',
    handId: 'h_rollback',
  }
  const scored = { ...base, eventType: 'hand_scored' as const, payload: { explanation: { matchBefore: { teamA: 0, teamB: 0 }, matchAfter: { teamA: 17, teamB: 9 } } } }
  const broken = { ...base, eventType: 'trick_completed' as const, payload: { unserializable: BigInt(1) } as Record<string, unknown> }
  let threw = false
  try {
    store.insertEvents([scored, broken], (event) => event)
  } catch {
    threw = true
  }
  assert(threw, 'broken batch must throw')
  assert(store.queryEvents({ roomId: 'rollback-room' }).length === 0, 'nothing persisted from failed batch')
  const retry = store.insertEvents([scored], (event) => ({ ...event, eventType: 'anomaly' }))
  assert(retry.duplicates.length === 0 && retry.inserted === 1, `retry duplicates=${retry.duplicates.length}`)
  const again = store.insertEvents([scored], (event) => ({ ...event, eventType: 'anomaly' }))
  assert(again.duplicates.length === 1, 'second scoring of same hand is a duplicate')
  journal.close()
})

// ─── [9] integrity ───────────────────────────────────────────────────────────
await check('[9] цялост: дублирана карта в раздаването, дублирана карта при точкуване, грешен победител', async () => {
  const { store, journal } = await createTempJournal()
  const { room } = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom' })
  const state = auth(room)
  const corruptHands = { ...state.hands, left: [state.hands.bottom[0]!, ...state.hands.left.slice(1)] }
  const corruptRoom = syncRoomWithAuthoritativeState(room, { ...state, hands: corruptHands }, fakeNow)
  observe(journal, null, corruptRoom, 'direct_submit')
  journal.flushSync()
  const dealAnomalies = anomalies(allEvents(store, room.id)).filter((e) => (e.payload as any).anomalyType === 'deal_integrity')
  assert(dealAnomalies.length >= 1, 'deal integrity anomaly')

  const second = await createTempJournal()
  const scripted = scriptedRoom({ specs: NT47_SPECS, firstLeader: 'bottom' })
  const played = playScript(second.journal, scripted.room, scripted.plays)
  const before = auth(played.beforeScoring)
  const tricks = before.playing!.completedTricks.map((trick) => ({ ...trick, plays: [...trick.plays] }))
  // Карта, изиграна два пъти, и подменен победител във взятка #2.
  tricks[1]!.plays[0] = { ...tricks[1]!.plays[0]!, card: tricks[0]!.plays[0]!.card }
  tricks[2] = { ...tricks[2]!, winnerSeat: 'top', winningTeam: 'A' }
  const corruptBefore = syncRoomWithAuthoritativeState(played.beforeScoring, { ...before, playing: { ...before.playing!, completedTricks: tricks } }, fakeNow)
  const corruptScored = syncRoomWithAuthoritativeState(corruptBefore, startServerScoringPhase(auth(corruptBefore)), fakeNow)
  observe(second.journal, corruptBefore, corruptScored, 'worker_tick')
  second.journal.flushSync()
  const types = new Set(anomalies(allEvents(second.store, scripted.room.id)).map((e) => (e.payload as any).anomalyType))
  assert(types.has('hand_cards_integrity'), `types ${[...types].join(',')}`)
  assert(types.has('trick_winner_mismatch'), `types ${[...types].join(',')}`)
  journal.close()
  second.journal.close()
})

// ─── [10] maintenance (подробно: checkBelotHandJournalArchive.ts) ───────────
await check('[10] поддръжка: >7 дни → .zst архив, >30 дни → изтриване; четене от архив', async () => {
  const { dir, store, journal } = await createTempJournal()
  const savedNow = fakeNow
  const DAY = 24 * 3600 * 1000
  const runAt = (offsetDays: number, specs: TrickSpec[]) => {
    fakeNow = savedNow - offsetDays * DAY
    const scripted = scriptedRoom({ specs, firstLeader: 'bottom' })
    playScript(journal, scripted.room, scripted.plays)
    journal.flushSync()
    return scripted.room.id
  }
  runAt(40, NT47_SPECS)
  const expiredCount = allEvents(store).length
  runAt(10, TIE_SPECS)
  const archivedCount = allEvents(store).length - expiredCount
  runAt(2, NT47_SPECS)
  fakeNow = savedNow
  const totalBefore = allEvents(store).length
  const report = await runBelotHandJournalMaintenance(store, TEST_STORAGE_CONFIG, fakeNow)
  assert(report.status === 'completed', report.status)
  assert(report.expiredActiveRows === expiredCount, `expired ${report.expiredActiveRows} of ${expiredCount}`)
  assert(report.archived.length === 1 && report.archived[0]!.rows === archivedCount, JSON.stringify(report.warnings))
  assert(report.archived[0]!.file.endsWith('.jsonl.zst') && report.archived[0]!.backend === 'node-zstd', report.archived[0]!.file)
  assert(allEvents(store).length === totalBefore - expiredCount - archivedCount, 'only recent rows stay active')
  const loaded = await loadBelotHandJournalEvents({ directory: dir, query: { sinceMs: 0 } })
  assert(loaded.fromArchives === archivedCount && loaded.duplicatesSkipped === 0, JSON.stringify({ ...loaded, events: loaded.events.length }))
  journal.close()
})

// ─── [11] no mutation / privacy ──────────────────────────────────────────────
await check('[11] без токени/connectionId/IP в журнала; ръцете не стигат до клиентски snapshot', async () => {
  const sample = JSON.stringify(sweepAcceptEvents)
  for (const forbidden of ['connectionId', 'reconnectToken', 'sessionId', 'remoteAddress', 'userAgent', 'accountId', 'password', 'token']) {
    assert(!sample.includes(`"${forbidden}"`), `journal contains ${forbidden}`)
  }
  assert(sample.includes('"remainingHands"'), 'journal holds full hands (server-only)')
})

Date.now = realDateNow
console.log(`\n  passed=${passed} failed=${failed}`)
if (failed > 0) process.exit(1)

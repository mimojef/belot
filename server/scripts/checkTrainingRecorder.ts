/**
 * checkTrainingRecorder.ts
 *
 * Автоматични тестове за passive AI Training Recorder.
 *
 * Сценарии:
 * [1]  Recorder disabled → noop, no errors
 * [2]  Config validation: secret too short → noop recorder
 * [3]  Config validation: path traversal rejected
 * [4]  computePlayerKey: bot (null profileId) → null
 * [5]  computePlayerKey: same profileId + same secret → same key
 * [6]  computePlayerKey: different secrets → different keys
 * [7]  Integrity: valid full record → valid=true, no violations
 * [8]  Integrity: wrong initial card count → violation
 * [9]  Integrity: duplicate initial cards → violation
 * [10] Integrity: played card not in initial hands → violation
 * [11] Integrity: 9 tricks → violation
 * [12] Integrity: non-strictly-increasing bid sequence → violation
 * [13] Integrity: non-strictly-increasing card sequence → violation
 * [14] Integrity: payload too large → violation
 * [15] Integrity: bidding_only record → valid with 20 bidding cards, 0 card actions, 0 tricks
 * [16] Integrity: bidding_only with card actions → violation
 * [17] Collector: onBiddingStart с 20 карти → state се регистрира
 * [18] Collector: onBiddingStart с грешен брой карти → игнорира
 * [19] Collector: дублиран onBiddingStart → игнорира
 * [20] Collector: onBidAction → actorKind=human_manual
 * [21] Collector: onBidAction auto, first timeout → actorKind=human_timeout
 * [22] Collector: onBidAction auto, already controlled → actorKind=bot_takeover
 * [23] Collector: onBidAction auto, bot mode → actorKind=bot_original
 * [24] Collector: onDealComplete → връща full record с recordKind='full'
 * [25] Collector: onDealComplete дублиран → duplicate
 * [26] Collector: onAllPass → bidding_only record с recordKind='bidding_only'
 * [27] Collector: collectorDropDeal → изтрива active state
 * [28] roomKey е HMAC, не raw room ID
 * [29] Noop recorder: shutdown resolves без грешка
 * [30] Queue overflow: drop без throw
 * [31] Queue shutdown: дрейнира опашката преди resolve
 * [32] Full deal integration: 20 bidding cards + 6 bids + 32 card plays → valid record
 * [33] Full deal: last bid (deal-last-3) detected via prevPhase=bidding
 * [34] Full deal: all-pass (next-round) writes bidding_only
 * [35] Human bid: actorKind=human_manual via human_manual origin
 * [36] Timeout bid: actorKind=human_timeout on first timeout
 * [37] Bot takeover bid: actorKind=bot_takeover on subsequent auto action
 * [38] bot_original: seat.mode=bot → actorKind=bot_original
 */

import { validateTrainingRecorderConfig } from '../src/trainingRecorder/trainingRecorderConfig.js'
import { computePlayerKey } from '../src/trainingRecorder/trainingRecorderHash.js'
import { validateTrainingRecord } from '../src/trainingRecorder/trainingRecorderIntegrity.js'
import {
  collectorOnBiddingStart,
  collectorOnPlayingStart,
  collectorOnBidAction,
  collectorOnCardPlayed,
  collectorOnDealComplete,
  collectorOnAllPass,
  collectorDropDeal,
  collectorGetActiveDealCount,
} from '../src/trainingRecorder/trainingRecorderCollector.js'
import { createTrainingRecorder } from '../src/trainingRecorder/trainingRecorder.js'
import { createTrainingRecorderQueue } from '../src/trainingRecorder/trainingRecorderQueue.js'
import { createMutableMetrics } from '../src/trainingRecorder/trainingRecorderMetrics.js'
import type {
  TrainingDealRecord,
  TrainingTrickResult,
  TrainingActionOrigin,
} from '../src/trainingRecorder/trainingRecorderTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerBiddingState,
  ServerPlayerState,
  ServerScoringState,
  ServerPlayingState,
  ServerWinningBid,
} from '../src/game/serverGameTypes.js'
import type { Seat, Team } from '../src/core/serverTypes.js'

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0
const asyncQueue: Array<() => Promise<void>> = []

function checkSync(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function checkAsync(label: string, fn: () => Promise<void>): void {
  asyncQueue.push(async () => {
    try {
      await fn()
      passed++
      console.log(`  PASS  ${label}`)
    } catch (err) {
      failed++
      console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected)
    throw new Error(`${label}: получено "${String(actual)}", очаквано "${String(expected)}"`)
}
function assertNull(v: unknown, label: string): void {
  if (v !== null) throw new Error(`${label}: очаквано null, получено ${String(v)}`)
}
function assertNotNull(v: unknown, label: string): void {
  if (v === null || v === undefined)
    throw new Error(`${label}: очаквано non-null, получено ${String(v)}`)
}

// ─── Builders ─────────────────────────────────────────────────────────────────

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'] as const
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

function card(suit: string, rank: string): ServerCard {
  return { id: `${suit}-${rank}`, suit: suit as ServerCard['suit'], rank: rank as ServerCard['rank'] }
}

function fullDeck(): ServerCard[] {
  return SUITS.flatMap((s) => RANKS.map((r) => card(s, r)))
}

function splitHands(deck: ServerCard[]): Record<Seat, ServerCard[]> {
  return { bottom: deck.slice(0, 8), right: deck.slice(8, 16), top: deck.slice(16, 24), left: deck.slice(24, 32) }
}

// 5 cards per seat (20 total) — bidding start snapshot
function splitHandsBidding(deck: ServerCard[]): Record<Seat, ServerCard[]> {
  return { bottom: deck.slice(0, 5), right: deck.slice(8, 13), top: deck.slice(16, 21), left: deck.slice(24, 29) }
}

function emptyScore() { return { teamA: 0, teamB: 0 } }

function makePlayers(
  modes: Partial<Record<Seat, 'bot' | 'human'>> = {},
  controlled: Partial<Record<Seat, boolean>> = {},
): Record<Seat, ServerPlayerState> {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(seats.map((s, i) => {
    const mode = modes[s] ?? 'human'
    return [s, { seat: s, team: teams[i]!, mode, controlledByBot: controlled[s] ?? mode === 'bot' }]
  })) as Record<Seat, ServerPlayerState>
}

function makeWinningBid(seat: Seat = 'right'): NonNullable<ServerWinningBid> {
  return { seat, contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }
}

function makeScoring(wb: NonNullable<ServerWinningBid>): ServerScoringState {
  return {
    winningBid: wb,
    rawHandPoints: { teamA: 81, teamB: 81 },
    rawHandTricksWon: { teamA: 4, teamB: 4 },
    declarationPoints: emptyScore(),
    belotePoints: emptyScore(),
    sumPoints: { teamA: 81, teamB: 81 },
    officialRoundPoints: { teamA: 80, teamB: 80 },
    matchTotals: { teamA: 80, teamB: 80 },
    carryOver: emptyScore(),
    isCapotRound: false,
    isNonCapotRound: true,
    outcomeLabel: 'Изкарана',
    outcomeShortLabel: 'Изкарана',
    counterMultiplier: 1,
  }
}

function makeTricks(hands: Record<Seat, ServerCard[]>): ServerCompletedTrick[] {
  return Array.from({ length: 8 }, (_, ti) => ({
    trickIndex: ti,
    leaderSeat: 'bottom' as Seat,
    winnerSeat: 'bottom' as Seat,
    winningTeam: 'A' as Team,
    plays: (['bottom', 'right', 'top', 'left'] as Seat[]).map((s) => ({
      seat: s,
      card: hands[s][ti]!,
    })),
  }))
}

function makePlaying(_unused: unknown, tricks: ServerCompletedTrick[]): ServerPlayingState {
  return {
    hasStarted: true,
    currentTurnSeat: null,
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 8 },
    completedTricks: tricks,
    lastCompletedTrickWinnerSeat: 'bottom',
    lastCompletedTrickWinnerTeam: 'A',
    wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
    wonTricksByTeam: { A: [], B: [] },
  }
}

function baseState(
  hands: Record<Seat, ServerCard[]>,
  phase: ServerAuthoritativeGameState['phase'] = 'bidding',
  overrides: Partial<ServerAuthoritativeGameState> = {},
): ServerAuthoritativeGameState {
  const es = emptyScore()
  return {
    phase,
    phaseEnteredAt: 0,
    targetScore: 151,
    players: makePlayers(),
    round: { dealerSeat: 'bottom', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands,
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: {
      announce_tersa: es, announce_50: es, announce_100: es, announce_kare: es, announce_belot: es,
    },
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 },
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: null,
    score: {
      round: { tricks: es, declarations: es, belote: es, lastTen: es, capot: es, total: es },
      match: { teamA: 0, teamB: 0 },
      carryOver: es,
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
    ...overrides,
  }
}

function makeRoom(
  id: string,
  participants: Partial<Record<Seat, { kind: 'human' | 'bot'; profileId: string | null }>> = {},
) {
  function p(seat: Seat) {
    const info = participants[seat]
    if (!info) return { kind: 'human', identity: { profileId: `profile-${seat}` } }
    return { kind: info.kind, identity: { profileId: info.profileId } }
  }
  return {
    id,
    seats: {
      bottom: { participant: p('bottom') },
      right: { participant: p('right') },
      top: { participant: p('top') },
      left: { participant: p('left') },
    },
  }
}

function completedState(
  hands: Record<Seat, ServerCard[]>,
  wb: NonNullable<ServerWinningBid>,
  matchScore = { teamA: 80, teamB: 0 },
): ServerAuthoritativeGameState {
  const tricks = makeTricks(hands)
  return baseState(hands, 'scoring', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying(null, tricks),
    scoring: makeScoring(wb),
    score: { round: baseState(hands).score.round, match: matchScore, carryOver: emptyScore() },
  })
}

// Full deal record builder for integrity tests
function makeDealRecord(overrides: Partial<TrainingDealRecord> = {}): TrainingDealRecord {
  const deck = fullDeck()
  const hands = splitHands(deck)
  const biddingHands = splitHandsBidding(deck)
  const now = new Date().toISOString()

  const cardActions = deck.map((c, i) => ({
    sequence: i + 1,
    timestamp: now,
    trickIndex: Math.floor(i / 4),
    positionInTrick: i % 4,
    seat: (['bottom', 'right', 'top', 'left'] as Seat[])[i % 4]!,
    actorKind: 'human_manual' as const,
    visibleBeforeAction: {
      ownHand: [] as ServerCard[],
      legalCards: [] as ServerCard[],
      contract: { bidderSeat: 'bottom' as Seat, contract: 'suit' as const, trumpSuit: 'hearts' as const, doubled: false, redoubled: false },
      cardsPlayedBeforeAction: [],
      currentTrick: [],
      currentWinningSeat: null as Seat | null,
      currentWinningCard: null as ServerCard | null,
      dealerSeat: 'bottom' as Seat,
      leaderSeat: 'bottom' as Seat,
      scoreBeforeDeal: { team0: 0, team1: 0 },
    },
    chosenCard: c,
  }))

  const tricks: TrainingTrickResult[] = Array.from({ length: 8 }, (_, ti) => ({
    trickIndex: ti,
    leaderSeat: 'bottom' as Seat,
    plays: (['bottom', 'right', 'top', 'left'] as Seat[]).map((s, pi) => ({
      sequence: pi,
      seat: s,
      card: deck[ti * 4 + pi]!,
    })),
    winnerSeat: 'bottom' as Seat,
    winningCard: deck[ti * 4]!,
    points: 10,
  }))

  const base: TrainingDealRecord = {
    schemaVersion: 1,
    recordingId: 'test-room::deal-0::dealer-bottom',
    recordedAt: now,
    roomKey: 'test-room',
    dealIndex: 0,
    startedAt: now,
    completedAt: now,
    completed: true,
    recordKind: 'full',
    dealerSeat: 'bottom',
    startingSeat: 'right',
    scoreBeforeDeal: { team0: 0, team1: 0 },
    scoreAfterDeal: { team0: 20, team1: 0 },
    handsAtBiddingStart: biddingHands,
    initialHands: hands,
    seats: {
      bottom: { playerKey: 'abc', isBot: false, isTakeover: false },
      right: { playerKey: 'def', isBot: false, isTakeover: false },
      top: { playerKey: 'ghi', isBot: false, isTakeover: false },
      left: { playerKey: null, isBot: true, isTakeover: false },
    },
    biddingActions: [{
      sequence: 1, timestamp: now, seat: 'right', actorKind: 'human_manual',
      visibleBeforeAction: { ownHand: biddingHands.right, dealerSeat: 'bottom', ownSeat: 'right', scoreBeforeDeal: { team0: 0, team1: 0 }, previousBids: [], legalActions: [{ type: 'pass' }] },
      chosenAction: { type: 'suit', suit: 'hearts' },
    }],
    finalContract: { bidderSeat: 'right', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false },
    cardActions,
    tricks,
    dealResult: {
      bidderSeat: 'right', bidderTeam: 'B', contractTeam: 'B',
      contract: { bidderSeat: 'right', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false },
      contractMade: true, isCapot: false, isTie: false,
      pointsTeam0Raw: 0, pointsTeam1Raw: 162, pointsTeam0Official: 0, pointsTeam1Official: 162,
      outcomeLabel: 'Изкарана', counterMultiplier: 1,
    },
    integrity: { initialCardCount: 32, playedCardCount: 32, uniqueInitialCardCount: 32, uniquePlayedCardCount: 32, valid: true, violations: [] },
  }
  return { ...base, ...overrides }
}

function makeBiddingOnlyRecord(overrides: Partial<TrainingDealRecord> = {}): TrainingDealRecord {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const now = new Date().toISOString()

  const base: TrainingDealRecord = {
    schemaVersion: 1,
    recordingId: 'test-room::bidding-only',
    recordedAt: now,
    roomKey: 'test-room',
    dealIndex: 0,
    startedAt: now,
    completedAt: now,
    completed: true,
    recordKind: 'bidding_only',
    dealerSeat: 'bottom',
    startingSeat: 'right',
    scoreBeforeDeal: { team0: 0, team1: 0 },
    scoreAfterDeal: { team0: 0, team1: 0 },
    handsAtBiddingStart: biddingHands,
    initialHands: null,
    seats: {
      bottom: { playerKey: 'abc', isBot: false, isTakeover: false },
      right: { playerKey: 'def', isBot: false, isTakeover: false },
      top: { playerKey: 'ghi', isBot: false, isTakeover: false },
      left: { playerKey: null, isBot: true, isTakeover: false },
    },
    biddingActions: [{
      sequence: 1, timestamp: now, seat: 'right', actorKind: 'human_manual',
      visibleBeforeAction: { ownHand: biddingHands.right, dealerSeat: 'bottom', ownSeat: 'right', scoreBeforeDeal: { team0: 0, team1: 0 }, previousBids: [], legalActions: [{ type: 'pass' }] },
      chosenAction: { type: 'pass' },
    }],
    finalContract: null,
    cardActions: [],
    tricks: [],
    dealResult: null,
    integrity: { initialCardCount: 0, playedCardCount: 0, uniqueInitialCardCount: 0, uniquePlayedCardCount: 0, valid: true, violations: [] },
  }
  return { ...base, ...overrides }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('\ncheckTrainingRecorder\n')

// [1] Disabled → noop
checkSync('[1] Recorder disabled → noop, getMetrics enabled=false', () => {
  delete process.env['TRAINING_RECORDER_ENABLED']
  const rec = createTrainingRecorder('0')
  const m = rec.getMetrics()
  assertEqual(m.enabled, false, 'enabled')
  assertEqual(m.healthy, true, 'healthy')
  rec.onBiddingStart({} as any, {} as any, 0)
  rec.onPlayingStart('room', 0, {} as any)
  rec.onBidAction('room', 0, {} as any, {} as any, 'bottom', 'human_manual')
  rec.onCardPlayed('room', 0, {} as any, {} as any, 'bottom', 'clubs-A', 'human_manual')
  rec.onDealComplete('room', 0, {} as any)
  rec.onAllPass('room', 0, {} as any)
  rec.onDealAbandoned('room', 0)
})

// [2] Secret too short
checkSync('[2] TRAINING_RECORDER_HASH_SECRET too short → noop', () => {
  process.env['TRAINING_RECORDER_ENABLED'] = 'true'
  process.env['TRAINING_RECORDER_HASH_SECRET'] = 'short'
  process.env['TRAINING_RECORDER_PATH'] = '/tmp/tr-test'
  const rec = createTrainingRecorder('0')
  assertEqual(rec.getMetrics().enabled, false, 'enabled must be false')
  delete process.env['TRAINING_RECORDER_ENABLED']
  delete process.env['TRAINING_RECORDER_HASH_SECRET']
  delete process.env['TRAINING_RECORDER_PATH']
})

// [3] Path traversal
checkSync('[3] Path traversal in storagePath → validation fails', () => {
  const result = validateTrainingRecorderConfig({
    enabled: true,
    storagePath: '/safe/../bad',
    hashSecret: 'this-is-sixteen-c',
    maxFileMb: 100, maxTotalGb: 10, maxQueue: 1000, retentionDays: 90,
    processId: '1', workerId: '0',
  })
  assertEqual(result.ok, false, 'ok must be false')
})

// [4-6] computePlayerKey
checkSync('[4] computePlayerKey(secret, null) → null', () => {
  assertNull(computePlayerKey('secret-key-16chars', null), 'key')
})
checkSync('[5] computePlayerKey deterministic (same input → same 64-char hex)', () => {
  const s = 'my-secret-key-1234'
  const k1 = computePlayerKey(s, 'user-123')
  const k2 = computePlayerKey(s, 'user-123')
  assertEqual(k1, k2, 'keys must match')
  assert(k1 !== null && k1.length === 64, `expected 64 chars, got ${k1?.length}`)
})
checkSync('[6] computePlayerKey: different secrets → different keys', () => {
  assert(
    computePlayerKey('secret-key-111111', 'u1') !== computePlayerKey('secret-key-222222', 'u1'),
    'different secrets must produce different keys',
  )
})

// [7-16] Integrity
checkSync('[7] validateTrainingRecord: valid full record → valid=true', () => {
  const rec = makeDealRecord()
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(i.valid, `expected valid, got: ${i.violations.join('; ')}`)
  assertEqual(i.initialCardCount, 32, 'initialCardCount')
  assertEqual(i.playedCardCount, 32, 'playedCardCount')
})
checkSync('[8] validateTrainingRecord: 31 initial cards → violation', () => {
  const deck = fullDeck()
  const rec = makeDealRecord({
    initialHands: { bottom: deck.slice(0, 7), right: deck.slice(8, 16), top: deck.slice(16, 24), left: deck.slice(24, 32) },
  })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('initial cards')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[9] validateTrainingRecord: duplicate initial cards → violation', () => {
  const deck = fullDeck()
  const h = splitHands(deck)
  const rec = makeDealRecord({ initialHands: { ...h, bottom: [...h.bottom.slice(0, 7), h.bottom[0]!] } })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.toLowerCase().includes('duplicate')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[10] validateTrainingRecord: played card not in initial hands → violation', () => {
  const base = makeDealRecord()
  const cardActions = base.cardActions.map((a, idx) =>
    idx === 0 ? { ...a, chosenCard: { id: 'FAKE-XYZ', suit: 'hearts' as const, rank: '7' as const } } : a,
  )
  const rec = makeDealRecord({ cardActions })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(
    i.violations.some((v) => v.includes('not found in initial hands') || v.toLowerCase().includes('duplicate')),
    `violations: ${i.violations.join('; ')}`,
  )
})
checkSync('[11] validateTrainingRecord: 9 tricks → violation', () => {
  const deck = fullDeck()
  const base = makeDealRecord()
  const extra: TrainingTrickResult = {
    trickIndex: 8, leaderSeat: 'bottom',
    plays: (['bottom', 'right', 'top', 'left'] as Seat[]).map((s, i) => ({ sequence: i, seat: s, card: deck[i]! })),
    winnerSeat: 'bottom', winningCard: deck[0]!, points: 0,
  }
  const rec = makeDealRecord({ tricks: [...base.tricks, extra] })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('Too many tricks')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[12] validateTrainingRecord: bid sequence not strictly increasing → violation', () => {
  const now = new Date().toISOString()
  const bh = splitHandsBidding(fullDeck())
  const base = makeDealRecord()
  const rec = makeDealRecord({
    biddingActions: [
      base.biddingActions[0]!,
      { sequence: 1, timestamp: now, seat: 'top', actorKind: 'human_manual',
        visibleBeforeAction: { ownHand: bh.top, dealerSeat: 'bottom', ownSeat: 'top', scoreBeforeDeal: { team0: 0, team1: 0 }, previousBids: [], legalActions: [{ type: 'pass' }] },
        chosenAction: { type: 'pass' } },
    ],
  })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('Bidding sequence not strictly increasing')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[13] validateTrainingRecord: card sequence not strictly increasing → violation', () => {
  const base = makeDealRecord()
  const cardActions = base.cardActions.map((a, idx) => idx === 31 ? { ...a, sequence: 30 } : a)
  const rec = makeDealRecord({ cardActions })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('Card action sequence not strictly increasing')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[14] validateTrainingRecord: payload > 500KB → violation', () => {
  const rec = makeDealRecord()
  const i = validateTrainingRecord(rec, 'x'.repeat(500_001))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('too large')), `violations: ${i.violations.join('; ')}`)
})
checkSync('[15] Integrity: bidding_only record → valid with 20 bidding cards', () => {
  const rec = makeBiddingOnlyRecord()
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(i.valid, `expected valid bidding_only, got: ${i.violations.join('; ')}`)
  assertEqual(i.playedCardCount, 0, 'playedCardCount must be 0')
})
checkSync('[16] Integrity: bidding_only with card actions → violation', () => {
  const deck = fullDeck()
  const now = new Date().toISOString()
  const rec = makeBiddingOnlyRecord({
    cardActions: [{
      sequence: 1, timestamp: now, trickIndex: 0, positionInTrick: 0,
      seat: 'bottom', actorKind: 'human_manual',
      visibleBeforeAction: { ownHand: [], legalCards: [], contract: { bidderSeat: 'bottom', contract: 'suit', trumpSuit: null, doubled: false, redoubled: false }, cardsPlayedBeforeAction: [], currentTrick: [], currentWinningSeat: null, currentWinningCard: null, dealerSeat: 'bottom', leaderSeat: 'bottom', scoreBeforeDeal: { team0: 0, team1: 0 } },
      chosenCard: deck[0]!,
    }],
  })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('bidding_only')), `violations: ${i.violations.join('; ')}`)
})

// [17-28] Collector
checkSync('[17] collectorOnBiddingStart: 20 карти → active deal registered', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-17`
  const before = collectorGetActiveDealCount()
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 990017, 'secret-key-1234567')
  assertEqual(collectorGetActiveDealCount(), before + 1, 'count +1')
  collectorDropDeal(roomId, 990017)
})
checkSync('[18] collectorOnBiddingStart: грешен брой карти → игнорира', () => {
  const deck = fullDeck()
  const hands: Record<Seat, ServerCard[]> = { bottom: deck.slice(0, 3), right: deck.slice(8, 13), top: deck.slice(16, 21), left: deck.slice(24, 29) }
  const roomId = `tr-${Date.now()}-18`
  const before = collectorGetActiveDealCount()
  collectorOnBiddingStart(makeRoom(roomId), baseState(hands, 'bidding'), 990018, 'secret-key-1234567')
  assertEqual(collectorGetActiveDealCount(), before, 'count must not change')
})
checkSync('[19] collectorOnBiddingStart: дублиран → игнорира', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-19`; const dealIndex = 990019
  const room = makeRoom(roomId)
  const state = baseState(biddingHands, 'bidding')
  collectorOnBiddingStart(room, state, dealIndex, 'secret-key-1234567')
  const before = collectorGetActiveDealCount()
  collectorOnBiddingStart(room, state, dealIndex, 'secret-key-1234567')
  assertEqual(collectorGetActiveDealCount(), before, 'duplicate start must be ignored')
  collectorDropDeal(roomId, dealIndex)
})

// [20-23] actorKind
checkSync('[20] actorKind: human_manual', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-20`; const dealIndex = 990020
  const playersBefore = makePlayers({ right: 'human' }, { right: false })
  const playersAfter = makePlayers({ right: 'human' }, { right: false })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), dealIndex, 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersAfter,
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBidAction(roomId, dealIndex, stateBefore, stateAfter, 'right', 'human_manual')
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record')
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'human_manual', 'actorKind')
})

checkSync('[21] actorKind: human_timeout (first auto action)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-21`; const dealIndex = 990021
  const playersBefore = makePlayers({ bottom: 'human' }, { bottom: false })
  // After timeout: controlledByBot becomes true
  const playersAfter = makePlayers({ bottom: 'human' }, { bottom: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), dealIndex, 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersAfter,
    bidding: { entries: [{ seat: 'bottom', action: { type: 'pass' } }], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBidAction(roomId, dealIndex, stateBefore, stateAfter, 'bottom', 'auto')
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'human_timeout', 'actorKind must be human_timeout')
})

checkSync('[22] actorKind: bot_takeover (subsequent auto, already controlled)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-22`; const dealIndex = 990022
  // Already controlled before this action
  const playersBefore = makePlayers({ bottom: 'human' }, { bottom: true })
  const playersAfter = makePlayers({ bottom: 'human' }, { bottom: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), dealIndex, 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersAfter,
    bidding: { entries: [{ seat: 'bottom', action: { type: 'pass' } }], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBidAction(roomId, dealIndex, stateBefore, stateAfter, 'bottom', 'auto')
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'bot_takeover', 'actorKind must be bot_takeover')
})

checkSync('[23] actorKind: bot_original (mode=bot)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-23`; const dealIndex = 990023
  const playersBefore = makePlayers({ right: 'bot' }, { right: true })
  const playersAfter = makePlayers({ right: 'bot' }, { right: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), dealIndex, 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersAfter,
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBidAction(roomId, dealIndex, stateBefore, stateAfter, 'right', 'auto')
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'bot_original', 'actorKind must be bot_original')
})

checkSync('[24] collectorOnDealComplete: full record, recordKind=full', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const hands = splitHands(deck)
  const roomId = `tr-${Date.now()}-24`; const dealIndex = 990024
  const wb = makeWinningBid()
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, 'secret-key-1234567')
  collectorOnPlayingStart(roomId, dealIndex, baseState(hands, 'playing'))
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(hands, wb))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record')
  assertEqual(rec!.recordKind, 'full', 'recordKind')
  assertEqual(rec!.schemaVersion, 1, 'schemaVersion')
  assertNotNull(rec!.initialHands, 'initialHands must be non-null for full record')
  assertNotNull(rec!.handsAtBiddingStart, 'handsAtBiddingStart')
})

checkSync('[25] collectorOnDealComplete: дублиран → duplicate', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-25`; const dealIndex = 990025
  const wb = makeWinningBid()
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, 'secret-key-1234567')
  const r1 = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), wb))
  assert(r1.kind === 'enqueued', 'first call must enqueue')
  const r2 = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), wb))
  assert(r2.kind === 'no_active_deal', `second call must be no_active_deal, got ${r2.kind}`)
})

checkSync('[26] collectorOnAllPass: bidding_only record', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-26`; const dealIndex = 990026
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, 'secret-key-1234567')
  const nextRoundState = baseState(biddingHands, 'next-round')
  const result = collectorOnAllPass(roomId, dealIndex, nextRoundState)
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record')
  assertEqual(rec!.recordKind, 'bidding_only', 'recordKind')
  assertNull(rec!.initialHands, 'initialHands must be null for bidding_only')
  assertEqual(rec!.cardActions.length, 0, 'cardActions must be empty')
  assertEqual(rec!.tricks.length, 0, 'tricks must be empty')
  assert(rec!.integrity.valid, `integrity must be valid: ${rec!.integrity.violations.join('; ')}`)
})

checkSync('[27] collectorDropDeal: removes active state', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-27`; const dealIndex = 990027
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, 'secret-key-1234567')
  const before = collectorGetActiveDealCount()
  assert(before > 0, 'must have active deal before drop')
  collectorDropDeal(roomId, dealIndex)
  assertEqual(collectorGetActiveDealCount(), before - 1, 'count -1')
})

checkSync('[28] roomKey е HMAC pseudonym, не raw room ID', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `raw-room-id-${Date.now()}`
  const dealIndex = 990028
  const secret = 'my-hash-secret-32c'
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, secret)
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', 'must enqueue')
  const rec = result.kind === 'enqueued' ? result.record : null
  assert(rec!.roomKey !== roomId, `roomKey must NOT equal raw room ID, got: ${rec!.roomKey}`)
  assertEqual(rec!.roomKey.length, 64, 'roomKey must be 64-char HMAC hex')
})

// [29] Noop shutdown
checkAsync('[29] noop recorder: shutdown resolves без грешка', async () => {
  delete process.env['TRAINING_RECORDER_ENABLED']
  const rec = createTrainingRecorder('0')
  await rec.shutdown(100)
})

// [30] Queue overflow
checkAsync('[30] queue overflow: drops records without throw', async () => {
  const metrics = createMutableMetrics()
  const slowWriter = {
    write: async (_p: string) => { await new Promise<void>((r) => setTimeout(r, 60_000)) },
    getCurrentFilePath: () => null,
    shutdown: async () => {},
  }
  const queue = createTrainingRecorderQueue(3, slowWriter as any, metrics)
  for (let i = 0; i < 10; i++) queue.enqueue(`{"seq":${i}}`)
  assert(metrics.droppedRecords > 0, `expected droppedRecords > 0, got ${metrics.droppedRecords}`)
  await queue.shutdown(20)
})

// [31] Queue shutdown flushes
checkAsync('[31] queue shutdown: дрейнира опашката преди resolve', async () => {
  const metrics = createMutableMetrics()
  const written: string[] = []
  const testWriter = {
    write: async (p: string) => { written.push(p) },
    getCurrentFilePath: () => null,
    shutdown: async () => {},
  }
  const queue = createTrainingRecorderQueue(100, testWriter as any, metrics)
  for (let i = 0; i < 5; i++) queue.enqueue(`{"seq":${i}}`)
  await queue.shutdown(500)
  assertEqual(written.length, 5, `expected 5 written records, got ${written.length}`)
})

// [32] Full deal integration
checkSync('[32] full deal integration: 20 bidding cards + 6 bids + 32 card plays → valid record', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)
  const roomId = `tr-${Date.now()}-32`; const dealIndex = 990032
  const secret = 'secret-key-1234567'
  const wb: NonNullable<ServerWinningBid> = { seat: 'left', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }

  // 1. Bidding start (deal-next-2 → bidding)
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), dealIndex, secret)

  // 2. Playing start (deal-last-3 → playing)
  collectorOnPlayingStart(roomId, dealIndex, baseState(fullHands, 'playing'))

  // 3. Bidding actions
  const bids: Array<{ seat: Seat; action: ServerBidEntry['action'] }> = [
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
    { seat: 'left', action: { type: 'suit', suit: 'hearts' } },
    { seat: 'bottom', action: { type: 'pass' } },
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
  ]
  let entries: typeof bids = []
  for (const bid of bids) {
    const prevEntries = entries
    entries = [...entries, bid]
    const hasEnded = entries.length === bids.length
    const stateBefore = baseState(biddingHands, 'bidding', {
      bidding: { entries: prevEntries as any, currentSeat: bid.seat, winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
    })
    const stateAfter = baseState(biddingHands, 'bidding', {
      bidding: { entries: entries as any, currentSeat: bid.seat, winningBid: hasEnded ? wb : null, hasStarted: true, hasEnded, consecutivePasses: 0 },
    })
    collectorOnBidAction(roomId, dealIndex, stateBefore, stateAfter, bid.seat, 'human_manual')
  }

  // 4. Card playing — simulate 8 tricks × 4 plays
  const tricks = makeTricks(fullHands)
  let prevState: ServerAuthoritativeGameState = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying(null, []),
    hands: { ...fullHands },
  })

  for (const trick of tricks) {
    for (let pi = 0; pi < trick.plays.length; pi++) {
      const play = trick.plays[pi]!
      const isLast = pi === trick.plays.length - 1
      const prevCompleted = prevState.playing!.completedTricks
      const newHands = { ...prevState.hands, [play.seat]: prevState.hands[play.seat].filter((c) => c.id !== play.card.id) }

      const newCurrentPlays = prevState.playing!.currentTrick.plays
      const nextState = baseState(newHands, 'playing', {
        bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
        playing: {
          hasStarted: true,
          currentTurnSeat: play.seat,
          currentTrick: {
            leaderSeat: isLast ? trick.winnerSeat : prevState.playing!.currentTrick.leaderSeat,
            currentSeat: play.seat,
            plays: isLast ? [] : [...newCurrentPlays, { seat: play.seat, card: play.card }],
            winnerSeat: null,
            trickIndex: isLast ? trick.trickIndex + 1 : trick.trickIndex,
          },
          completedTricks: isLast ? [...prevCompleted, trick] : prevCompleted,
          lastCompletedTrickWinnerSeat: isLast ? trick.winnerSeat : prevState.playing!.lastCompletedTrickWinnerSeat,
          lastCompletedTrickWinnerTeam: isLast ? 'A' : prevState.playing!.lastCompletedTrickWinnerTeam,
          wonTricksBySeat: { bottom: [], right: [], top: [], left: [] },
          wonTricksByTeam: { A: [], B: [] },
        },
      })

      collectorOnCardPlayed(roomId, dealIndex, prevState, nextState, play.seat, play.card.id, 'human_manual')
      prevState = nextState
    }
  }

  // 5. Deal complete
  const result = collectorOnDealComplete(roomId, dealIndex, completedState(fullHands, wb, { teamA: 0, teamB: 80 }))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record must not be null')
  assert(rec!.integrity.valid, `integrity violations: ${rec!.integrity.violations.join('; ')}`)
  assertEqual(rec!.biddingActions.length, bids.length, 'biddingActions count')
  assertEqual(rec!.cardActions.length, 32, 'cardActions count')
  assertEqual(rec!.tricks.length, 8, 'tricks count')
  assertEqual(rec!.finalContract?.trumpSuit ?? null, 'hearts', 'trumpSuit')
  assertEqual(rec!.recordKind, 'full', 'recordKind')
  assertNotNull(rec!.handsAtBiddingStart, 'handsAtBiddingStart')
  assertNotNull(rec!.initialHands, 'initialHands')
})

// Import type needed for tests
import type { ServerBidEntry } from '../src/game/serverGameTypes.js'

// ─── Run async tests and print summary ───────────────────────────────────────

async function main() {
  for (const fn of asyncQueue) await fn()
  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(1)
})

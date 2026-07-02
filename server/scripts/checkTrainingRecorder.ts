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
 * [17] Collector: onBiddingStart с 20 карти → state се регистрира (roomId-only key)
 * [18] Collector: onBiddingStart с грешен брой карти → игнорира
 * [19] Collector: дублиран onBiddingStart (unfinalized) → replaced_stale
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
 * [32] Full deal integration (collector-level): 20 bidding cards + 7 bids + 32 card plays → valid record
 * [33] scoreBeforeDeal=0:0 → scoreAfterDeal=16:0 finalizes successfully (no score-based key)
 * [34] findAddedBidEntry: middle bid detected as 'added'
 * [35] findAddedBidEntry: last pass after a won bid detected as 'added'
 * [36] findAddedBidEntry: 4th pass at all-pass detected as 'added'
 * [37] findAddedBidEntry: mismatch when entries diverge
 * [38] findAddedBidEntry: unchanged when nothing changed
 * [39] flattenPlayedCards + findAddedPlayedCard: playing→playing new card
 * [40] findAddedPlayedCard: playing→scoring new (32nd) card
 * [41] findAddedPlayedCard: playing→scoring finalize-only (no new card, already 32)
 * [42] Action-level dedup: same bid observed via human hook then auto hook → one action, human_manual kept
 * [43] Action-level dedup: same card observed twice → one action recorded
 * [44] Canonical trick points: suit contract matches expected raw points
 * [45] Canonical trick points: all-trumps contract matches expected raw points
 * [46] Canonical trick points: no-trumps contract doubles raw points
 * [47] Canonical trick points: double/redouble do not change raw trick points
 * [48] Semantic outcome: scoring.outcome matches legacy outcomeShortLabel mapping
 * [49] Multi-process writer safety: writer A's active file survives writer B's cleanup; old closed file is deleted
 * [50] Full deal end-to-end via real hooks + real writer → physical JSONL row is correct
 * [51] All-pass end-to-end via real hooks + real writer → physical JSONL row is correct
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

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
  collectorGetRecentlyFinalizedDealCount,
} from '../src/trainingRecorder/trainingRecorderCollector.js'
import { createTrainingRecorder } from '../src/trainingRecorder/trainingRecorder.js'
import { createTrainingRecorderQueue } from '../src/trainingRecorder/trainingRecorderQueue.js'
import { createTrainingRecorderWriter } from '../src/trainingRecorder/trainingRecorderWriter.js'
import { createMutableMetrics } from '../src/trainingRecorder/trainingRecorderMetrics.js'
import {
  handleTrainingRecorderOnApplied,
  handleTrainingRecorderHumanBid,
  handleTrainingRecorderHumanCard,
} from '../src/trainingRecorder/trainingRecorderHooks.js'
import {
  findAddedBidEntry,
  findAddedPlayedCard,
  flattenPlayedCards,
} from '../src/trainingRecorder/trainingRecorderStateDiff.js'
import { getServerTrickCardPoints, getServerOutcomeShortLabel } from '../src/game/serverScoring.js'
import { normalizeServerScoringState } from '../src/game/normalizeRestoredAuthoritativeState.js'
import { submitHumanBidActionForRoom } from '../src/game/submitHumanBidActionForRoom.js'
import { submitHumanPlayCardForRoom } from '../src/game/submitHumanPlayCardForRoom.js'
import type {
  TrainingDealRecord,
  TrainingTrickResult,
} from '../src/trainingRecorder/trainingRecorderTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerBidEntry,
  ServerBidAction,
  ServerPlayerState,
  ServerScoringState,
  ServerPlayingState,
  ServerWinningBid,
  ServerTrickPlay,
} from '../src/game/serverGameTypes.js'
import type { AuthoritativePhaseType } from '../src/game/serverPhaseTypes.js'
import type { Seat, Team, ServerRoom, RoomParticipant } from '../src/core/serverTypes.js'

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

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
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
function emptyWon(): Record<Seat, ServerCard[][]> {
  return { bottom: [], right: [], top: [], left: [] }
}

function makePlayers(
  modes: Partial<Record<Seat, 'bot' | 'human'>> = {},
  controlled: Partial<Record<Seat, boolean>> = {},
): Record<Seat, ServerPlayerState> {
  const teams: Team[] = ['A', 'B', 'A', 'B']
  return Object.fromEntries(SEATS.map((s, i) => {
    const mode = modes[s] ?? 'human'
    return [s, { seat: s, team: teams[i]!, mode, controlledByBot: controlled[s] ?? mode === 'bot' }]
  })) as Record<Seat, ServerPlayerState>
}

function makeWinningBid(seat: Seat = 'right'): NonNullable<ServerWinningBid> {
  return { seat, contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }
}

function makeScoring(
  wb: NonNullable<ServerWinningBid>,
  overrides: Partial<ServerScoringState> = {},
): ServerScoringState {
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
    outcomeLabel: 'Обявилият е изкарал',
    outcomeShortLabel: 'Изкарана',
    outcome: 'made',
    counterMultiplier: 1,
    ...overrides,
  }
}

function makeTricks(hands: Record<Seat, ServerCard[]>): ServerCompletedTrick[] {
  return Array.from({ length: 8 }, (_, ti) => ({
    trickIndex: ti,
    leaderSeat: 'bottom' as Seat,
    winnerSeat: 'bottom' as Seat,
    winningTeam: 'A' as Team,
    plays: SEATS.map((s) => ({
      seat: s,
      card: hands[s][ti]!,
    })),
  }))
}

function makePlaying(tricks: ServerCompletedTrick[]): ServerPlayingState {
  return {
    hasStarted: true,
    currentTurnSeat: null,
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 8 },
    completedTricks: tricks,
    lastCompletedTrickWinnerSeat: 'bottom',
    lastCompletedTrickWinnerTeam: 'A',
    wonTricksBySeat: emptyWon(),
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
  scoringOverrides: Partial<ServerScoringState> = {},
): ServerAuthoritativeGameState {
  const tricks = makeTricks(hands)
  return baseState(hands, 'scoring', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying(tricks),
    scoring: makeScoring(wb, scoringOverrides),
    score: { round: baseState(hands).score.round, match: matchScore, carryOver: emptyScore() },
  })
}

// ─── Full-fidelity ServerRoom builders (for real-hooks end-to-end tests) ──────

function makeIdentity(profileId: string | null): RoomParticipant['identity'] {
  return {
    accountId: null,
    profileId,
    username: null,
    displayName: profileId ?? 'Bot',
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
    gender: null,
  }
}

function makeParticipant(kind: 'human' | 'bot', profileId: string | null): RoomParticipant {
  if (kind === 'bot') {
    return {
      kind: 'bot',
      playerId: `bot-${profileId ?? 'x'}`,
      joinedAt: 0,
      botCode: 'core-v1',
      difficulty: 'normal',
      identity: makeIdentity(profileId),
    }
  }
  return {
    kind: 'human',
    playerId: `human-${profileId ?? 'x'}`,
    connectionId: null,
    isConnected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    reconnectToken: null,
    identity: makeIdentity(profileId),
  }
}

function makeE2eRoom(
  id: string,
  state: ServerAuthoritativeGameState,
  seatKinds: Record<Seat, 'human' | 'bot'>,
): ServerRoom {
  const teams: Record<Seat, Team> = { bottom: 'A', top: 'A', right: 'B', left: 'B' }
  const seats = Object.fromEntries(
    SEATS.map((seat) => [
      seat,
      {
        seat,
        team: teams[seat],
        participant: makeParticipant(seatKinds[seat], seatKinds[seat] === 'bot' ? null : `profile-${seat}`),
      },
    ]),
  ) as ServerRoom['seats']

  return {
    id,
    status: 'playing',
    createdAt: 0,
    updatedAt: 0,
    hostPlayerId: null,
    config: {
      maxPlayers: 4,
      allowBots: true,
      isPrivate: false,
      joinCode: null,
      targetScore: 151,
      turnTimeMs: 15_000,
      reconnectGraceMs: 30_000,
    },
    seats,
    game: {
      phase: 'playing',
      stateVersion: 1,
      startedAt: 0,
      updatedAt: 0,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState: state,
    },
    replayVotes: [],
    leaveVotes: [],
  }
}

function withState(room: ServerRoom, state: ServerAuthoritativeGameState): ServerRoom {
  return { ...room, game: { ...room.game, authoritativeState: state } }
}

// Standard 4-seat cast used by the e2e tests: bottom/top human, right bot,
// left human-that-times-out — this exercises all four actorKinds across a
// single deal (human_manual, bot_original, human_timeout, bot_takeover).
const E2E_SEAT_KINDS: Record<Seat, 'human' | 'bot'> = {
  bottom: 'human', top: 'human', right: 'bot', left: 'human',
}

type BidPlanStep = { seat: Seat; action: ServerBidAction; via: 'human' | 'auto'; timeout?: boolean }

// Drives a full deal (bidding → 8 tricks of playing → scoring) through the
// REAL hooks (handleTrainingRecorderHumanBid/Card, handleTrainingRecorderOnApplied)
// against a REAL recorder instance, mirroring exactly how index.ts calls them.
async function runFullDealThroughHooks(
  recorder: import('../src/trainingRecorder/trainingRecorder.js').TrainingRecorder,
  roomId: string,
  scoreAfter: { teamA: number; teamB: number },
): Promise<void> {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)

  let players = makePlayers({ right: 'bot' })

  const prevBiddingState = baseState({ bottom: [], right: [], top: [], left: [] }, 'deal-next-2', { players })
  const biddingStartState = baseState(biddingHands, 'bidding', {
    players,
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
    score: { round: baseState(biddingHands).score.round, match: { teamA: 0, teamB: 0 }, carryOver: emptyScore() },
  })

  let room = makeE2eRoom(roomId, prevBiddingState, E2E_SEAT_KINDS)
  let nextRoom = withState(room, biddingStartState)
  handleTrainingRecorderOnApplied(recorder, room, nextRoom)
  room = nextRoom

  const bidPlan: BidPlanStep[] = [
    { seat: 'right', action: { type: 'pass' }, via: 'auto' },
    { seat: 'top', action: { type: 'pass' }, via: 'human' },
    { seat: 'left', action: { type: 'pass' }, via: 'auto', timeout: true },
    { seat: 'bottom', action: { type: 'suit', suit: 'hearts' }, via: 'human' },
    { seat: 'right', action: { type: 'pass' }, via: 'auto' },
    { seat: 'top', action: { type: 'pass' }, via: 'human' },
    { seat: 'left', action: { type: 'pass' }, via: 'auto' },
  ]

  let entries: ServerBidEntry[] = []
  let winningBid: NonNullable<ServerWinningBid> | null = null

  for (let i = 0; i < bidPlan.length; i++) {
    const step = bidPlan[i]!
    entries = [...entries, { seat: step.seat, action: step.action }]
    if (step.action.type === 'suit') {
      winningBid = { seat: step.seat, contract: 'suit', trumpSuit: step.action.suit, doubled: false, redoubled: false }
    }

    if (step.timeout) {
      players = { ...players, left: { ...players.left, controlledByBot: true } }
    }

    const isLast = i === bidPlan.length - 1
    const nextPhase: AuthoritativePhaseType = isLast ? 'deal-last-3' : 'bidding'
    const nextState = baseState(biddingHands, nextPhase, {
      players,
      bidding: {
        entries,
        currentSeat: isLast ? null : bidPlan[i + 1]!.seat,
        winningBid,
        hasStarted: true,
        hasEnded: isLast,
        consecutivePasses: 0,
      },
    })

    const nextRoomStep = withState(room, nextState)
    if (step.via === 'human') {
      handleTrainingRecorderHumanBid(recorder, room, nextRoomStep)
    } else {
      handleTrainingRecorderOnApplied(recorder, room, nextRoomStep)
    }
    room = nextRoomStep
  }

  if (!winningBid) throw new Error('test setup error: no winning bid produced')
  const finalWinningBid = winningBid

  const startPlayingState = baseState(fullHands, 'playing', {
    players,
    bidding: { entries, currentSeat: null, winningBid: finalWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: {
      hasStarted: true,
      currentTurnSeat: 'bottom',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'bottom', plays: [], winnerSeat: null, trickIndex: 0 },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(),
      wonTricksByTeam: { A: [], B: [] },
    },
  })
  const playingStartRoom = withState(room, startPlayingState)
  handleTrainingRecorderOnApplied(recorder, room, playingStartRoom)
  room = playingStartRoom

  const playOrder: Seat[] = ['bottom', 'right', 'top', 'left']
  const seatVia: Record<Seat, 'human' | 'auto'> = { bottom: 'human', top: 'human', right: 'auto', left: 'auto' }

  let hands = { ...fullHands }
  let completedTricks: ServerCompletedTrick[] = []
  let currentTrickPlays: ServerTrickPlay[] = []
  let prevState = startPlayingState

  for (let ti = 0; ti < 8; ti++) {
    for (let pi = 0; pi < 4; pi++) {
      const seat = playOrder[pi]!
      const playedCard = fullHands[seat][ti]!
      const isLastOfTrick = pi === 3
      const isVeryLastCard = ti === 7 && pi === 3

      const nextHands = { ...hands, [seat]: hands[seat].filter((c) => c.id !== playedCard.id) }
      const newTrickPlays = [...currentTrickPlays, { seat, card: playedCard }]

      let nextCompletedTricks = completedTricks
      let nextCurrentTrick: ServerAuthoritativeGameState['currentTrick']
      if (isLastOfTrick) {
        nextCompletedTricks = [
          ...completedTricks,
          { trickIndex: ti, leaderSeat: 'bottom', plays: newTrickPlays, winnerSeat: 'bottom', winningTeam: 'A' },
        ]
        nextCurrentTrick = { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: ti + 1 }
      } else {
        nextCurrentTrick = { leaderSeat: 'bottom', currentSeat: seat, plays: newTrickPlays, winnerSeat: null, trickIndex: ti }
      }

      const playingPatch: ServerPlayingState = {
        hasStarted: true,
        currentTurnSeat: isVeryLastCard ? null : playOrder[(pi + 1) % 4]!,
        currentTrick: nextCurrentTrick,
        completedTricks: nextCompletedTricks,
        lastCompletedTrickWinnerSeat: isLastOfTrick ? 'bottom' : prevState.playing!.lastCompletedTrickWinnerSeat,
        lastCompletedTrickWinnerTeam: isLastOfTrick ? 'A' : prevState.playing!.lastCompletedTrickWinnerTeam,
        wonTricksBySeat: emptyWon(),
        wonTricksByTeam: { A: [], B: [] },
      }

      const nextState: ServerAuthoritativeGameState = isVeryLastCard
        ? {
            ...prevState,
            phase: 'scoring',
            hands: nextHands,
            playing: playingPatch,
            scoring: makeScoring(finalWinningBid, {
              isCapotRound: false,
              outcome: 'made',
              outcomeLabel: 'Обявилият е изкарал',
              outcomeShortLabel: 'Изкарана',
            }),
            score: { round: prevState.score.round, match: scoreAfter, carryOver: emptyScore() },
          }
        : baseState(nextHands, 'playing', {
            players,
            bidding: { entries, currentSeat: null, winningBid: finalWinningBid, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
            playing: playingPatch,
          })

      const nextRoomStep = withState(room, nextState)
      if (seatVia[seat] === 'human') {
        handleTrainingRecorderHumanCard(recorder, room, nextRoomStep)
      } else {
        handleTrainingRecorderOnApplied(recorder, room, nextRoomStep)
      }

      room = nextRoomStep
      prevState = nextState
      hands = nextHands
      completedTricks = nextCompletedTricks
      currentTrickPlays = isLastOfTrick ? [] : newTrickPlays
    }
  }
}

async function runAllPassThroughHooks(
  recorder: import('../src/trainingRecorder/trainingRecorder.js').TrainingRecorder,
  roomId: string,
): Promise<void> {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const players = makePlayers({ right: 'bot' })

  const prevState = baseState({ bottom: [], right: [], top: [], left: [] }, 'deal-next-2', { players })
  const biddingStartState = baseState(biddingHands, 'bidding', {
    players,
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })

  let room = makeE2eRoom(roomId, prevState, E2E_SEAT_KINDS)
  let nextRoom = withState(room, biddingStartState)
  handleTrainingRecorderOnApplied(recorder, room, nextRoom)
  room = nextRoom

  const passOrder: Seat[] = ['right', 'top', 'left', 'bottom']
  const via: Record<Seat, 'human' | 'auto'> = { right: 'auto', top: 'human', left: 'auto', bottom: 'human' }

  let entries: ServerBidEntry[] = []
  for (let i = 0; i < passOrder.length; i++) {
    const seat = passOrder[i]!
    entries = [...entries, { seat, action: { type: 'pass' } }]
    const isLast = i === passOrder.length - 1
    const nextPhase: AuthoritativePhaseType = isLast ? 'next-round' : 'bidding'
    const nextState = baseState(biddingHands, nextPhase, {
      players,
      bidding: {
        entries,
        currentSeat: isLast ? null : passOrder[i + 1]!,
        winningBid: null,
        hasStarted: true,
        hasEnded: isLast,
        consecutivePasses: i + 1,
      },
    })
    const nextRoomStep = withState(room, nextState)
    if (via[seat] === 'human') {
      handleTrainingRecorderHumanBid(recorder, room, nextRoomStep)
    } else {
      handleTrainingRecorderOnApplied(recorder, room, nextRoomStep)
    }
    room = nextRoomStep
  }
}

// Full deal record builder for integrity tests
function makeDealRecord(overrides: Partial<TrainingDealRecord> = {}): TrainingDealRecord {
  const deck = fullDeck()
  const hands = splitHands(deck)
  const biddingHands = splitHandsBidding(deck)
  const now = new Date().toISOString()

  const cardActions = deck.map((c, i) => {
    const trickIndex = Math.floor(i / 4)
    const positionInTrick = i % 4
    const trickStartIndex = trickIndex * 4
    const currentTrick = deck.slice(trickStartIndex, i).map((playedCard, offset) => ({
      sequence: trickStartIndex + offset + 1,
      trickIndex,
      positionInTrick: offset,
      seat: (['bottom', 'right', 'top', 'left'] as Seat[])[offset]!,
      card: playedCard,
    }))

    return {
      sequence: i + 1,
      timestamp: now,
      trickIndex,
      positionInTrick,
      seat: (['bottom', 'right', 'top', 'left'] as Seat[])[positionInTrick]!,
      actorKind: 'human_manual' as const,
      visibleBeforeAction: {
        ownHand: [] as ServerCard[],
        legalCards: [] as ServerCard[],
        contract: { bidderSeat: 'bottom' as Seat, contract: 'suit' as const, trumpSuit: 'hearts' as const, doubled: false, redoubled: false },
        playedCardCountBeforeAction: i,
        currentTrick,
        currentWinningSeat: null as Seat | null,
        currentWinningCard: null as ServerCard | null,
        dealerSeat: 'bottom' as Seat,
        leaderSeat: 'bottom' as Seat,
        scoreBeforeDeal: { team0: 0, team1: 0 },
      },
      chosenCard: c,
    }
  })

  const tricks: TrainingTrickResult[] = Array.from({ length: 8 }, (_, ti) => ({
    trickIndex: ti,
    leaderSeat: 'bottom' as Seat,
    plays: (['bottom', 'right', 'top', 'left'] as Seat[]).map((s, pi) => ({
      sequence: ti * 4 + pi + 1,
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
  rec.onBiddingStart({} as any, {} as any)
  rec.onPlayingStart('room', {} as any)
  rec.onBidAction('room', {} as any, {} as any, { seat: 'bottom', action: { type: 'pass' } }, 'human_manual')
  rec.onCardPlayed('room', {} as any, {} as any, { sequence: 1, trickIndex: 0, positionInTrick: 0, seat: 'bottom', card: card('clubs', 'A') }, 'human_manual')
  rec.onDealComplete('room', {} as any)
  rec.onAllPass('room', {} as any)
  rec.onDealAbandoned('room')
  rec.onInvalidTransition('test')
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
    plays: (['bottom', 'right', 'top', 'left'] as Seat[]).map((s, i) => ({ sequence: i + 1, seat: s, card: deck[i]! })),
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
  assert(i.violations.some((v) => v.includes('Card action sequence must be contiguous 1-based')), `violations: ${i.violations.join('; ')}`)
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
      visibleBeforeAction: { ownHand: [], legalCards: [], contract: { bidderSeat: 'bottom', contract: 'suit', trumpSuit: null, doubled: false, redoubled: false }, playedCardCountBeforeAction: 0, currentTrick: [], currentWinningSeat: null, currentWinningCard: null, dealerSeat: 'bottom', leaderSeat: 'bottom', scoreBeforeDeal: { team0: 0, team1: 0 } },
      chosenCard: deck[0]!,
    }],
  })
  const i = validateTrainingRecord(rec, JSON.stringify(rec))
  assert(!i.valid, 'expected invalid')
  assert(i.violations.some((v) => v.includes('bidding_only')), `violations: ${i.violations.join('; ')}`)
})

// [17-19] Collector: onBiddingStart (roomId-only key)
checkSync('[17] collectorOnBiddingStart: 20 карти → active deal registered (roomId key)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-17`
  const before = collectorGetActiveDealCount()
  const result = collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  assertEqual(result, 'started', 'result')
  assertEqual(collectorGetActiveDealCount(), before + 1, 'count +1')
  collectorDropDeal(roomId)
})
checkSync('[18] collectorOnBiddingStart: грешен брой карти → игнорира', () => {
  const deck = fullDeck()
  const hands: Record<Seat, ServerCard[]> = { bottom: deck.slice(0, 3), right: deck.slice(8, 13), top: deck.slice(16, 21), left: deck.slice(24, 29) }
  const roomId = `tr-${Date.now()}-18`
  const before = collectorGetActiveDealCount()
  const result = collectorOnBiddingStart(makeRoom(roomId), baseState(hands, 'bidding'), 'secret-key-1234567')
  assertEqual(result, 'ignored_card_count', 'result')
  assertEqual(collectorGetActiveDealCount(), before, 'count must not change')
})
checkSync('[19] collectorOnBiddingStart: дублиран (unfinalized) → replaced_stale, still one active state', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-19`
  const room = makeRoom(roomId)
  const state = baseState(biddingHands, 'bidding')
  const r1 = collectorOnBiddingStart(room, state, 'secret-key-1234567')
  assertEqual(r1, 'started', 'first result')
  const before = collectorGetActiveDealCount()
  const r2 = collectorOnBiddingStart(room, state, 'secret-key-1234567')
  assertEqual(r2, 'replaced_stale', 'second result')
  assertEqual(collectorGetActiveDealCount(), before, 'stale replace must not grow active count')
  collectorDropDeal(roomId)
})

// [20-23] actorKind
checkSync('[20] actorKind: human_manual', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-20`
  const playersBefore = makePlayers({ right: 'human' }, { right: false })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersBefore,
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const diff = findAddedBidEntry(stateBefore, stateAfter)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  collectorOnBidAction(roomId, stateBefore, stateAfter, (diff as any).entry, 'human_manual')
  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record')
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'human_manual', 'actorKind')
})

checkSync('[21] actorKind: human_timeout (first auto action)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-21`
  const playersBefore = makePlayers({ bottom: 'human' }, { bottom: false })
  const playersAfter = makePlayers({ bottom: 'human' }, { bottom: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersAfter,
    bidding: { entries: [{ seat: 'bottom', action: { type: 'pass' } }], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const diff = findAddedBidEntry(stateBefore, stateAfter)
  assert(diff.kind === 'added', 'expected added')
  collectorOnBidAction(roomId, stateBefore, stateAfter, (diff as any).entry, 'auto')
  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'human_timeout', 'actorKind must be human_timeout')
})

checkSync('[22] actorKind: bot_takeover (subsequent auto, already controlled)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-22`
  const playersBefore = makePlayers({ bottom: 'human' }, { bottom: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersBefore,
    bidding: { entries: [{ seat: 'bottom', action: { type: 'pass' } }], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const diff = findAddedBidEntry(stateBefore, stateAfter)
  assert(diff.kind === 'added', 'expected added')
  collectorOnBidAction(roomId, stateBefore, stateAfter, (diff as any).entry, 'auto')
  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'bot_takeover', 'actorKind must be bot_takeover')
})

checkSync('[23] actorKind: bot_original (mode=bot)', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-23`
  const playersBefore = makePlayers({ right: 'bot' }, { right: true })
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding', { players: playersBefore }), 'secret-key-1234567')
  const stateBefore = baseState(biddingHands, 'bidding', { players: playersBefore })
  const stateAfter = baseState(biddingHands, 'bidding', {
    players: playersBefore,
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const diff = findAddedBidEntry(stateBefore, stateAfter)
  assert(diff.kind === 'added', 'expected added')
  collectorOnBidAction(roomId, stateBefore, stateAfter, (diff as any).entry, 'auto')
  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', `expected enqueued`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions[0]?.actorKind ?? null, 'bot_original', 'actorKind must be bot_original')
})

checkSync('[24] collectorOnDealComplete: full record, recordKind=full', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const hands = splitHands(deck)
  const roomId = `tr-${Date.now()}-24`
  const wb = makeWinningBid()
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  collectorOnPlayingStart(roomId, baseState(hands, 'playing'))
  const result = collectorOnDealComplete(roomId, completedState(hands, wb))
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
  const roomId = `tr-${Date.now()}-25`
  const wb = makeWinningBid()
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  const r1 = collectorOnDealComplete(roomId, completedState(splitHands(deck), wb))
  assert(r1.kind === 'enqueued', 'first call must enqueue')
  const r2 = collectorOnDealComplete(roomId, completedState(splitHands(deck), wb))
  assert(r2.kind === 'duplicate', `second call must be duplicate, got ${r2.kind}`)
  assert(collectorGetRecentlyFinalizedDealCount() > 0, 'recently finalized registry must track the finalized room')
  const r3 = collectorOnDealComplete(`${roomId}-unknown`, completedState(splitHands(deck), wb))
  assert(r3.kind === 'no_active_deal', `unknown room must be no_active_deal, got ${r3.kind}`)
})

checkSync('[26] collectorOnAllPass: bidding_only record', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-26`
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  const nextRoundState = baseState(biddingHands, 'next-round')
  const result = collectorOnAllPass(roomId, nextRoundState)
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
  const roomId = `tr-${Date.now()}-27`
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  const before = collectorGetActiveDealCount()
  assert(before > 0, 'must have active deal before drop')
  collectorDropDeal(roomId)
  assertEqual(collectorGetActiveDealCount(), before - 1, 'count -1')
})

checkSync('[27b] collector state: many room ids do not leave active or per-room sequence state behind', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const beforeActive = collectorGetActiveDealCount()
  for (let i = 0; i < 250; i++) {
    const roomId = `tr-${Date.now()}-27b-${i}`
    const result = collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
    assertEqual(result, 'started', `start result ${i}`)
    collectorDropDeal(roomId)
  }
  assertEqual(collectorGetActiveDealCount(), beforeActive, 'active state count returns to baseline')
})

checkSync('[28] roomKey е HMAC pseudonym, не raw room ID', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `raw-room-id-${Date.now()}`
  const secret = 'my-hash-secret-32c'
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), secret)
  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(result.kind === 'enqueued', 'must enqueue')
  const rec = result.kind === 'enqueued' ? result.record : null
  assert(rec!.roomKey !== roomId, `roomKey must NOT equal raw room ID, got: ${rec!.roomKey}`)
  assertEqual(rec!.roomKey.length, 64, 'roomKey must be 64-char HMAC hex')
})

checkAsync('[28b] metrics: duplicateDeals and noActiveDeal are separate counters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tr-metrics-'))
  try {
    process.env['TRAINING_RECORDER_ENABLED'] = 'true'
    process.env['TRAINING_RECORDER_HASH_SECRET'] = 'metrics-secret-32chars!!!!'
    process.env['TRAINING_RECORDER_PATH'] = dir
    const recorder = createTrainingRecorder('metrics')
    const deck = fullDeck()
    const roomId = `tr-${Date.now()}-28b`
    const wb = makeWinningBid()
    recorder.onBiddingStart(makeRoom(roomId), baseState(splitHandsBidding(deck), 'bidding'))
    recorder.onDealComplete(roomId, completedState(splitHands(deck), wb))
    recorder.onDealComplete(roomId, completedState(splitHands(deck), wb))
    recorder.onDealComplete(`${roomId}-never-started`, completedState(splitHands(deck), wb))
    const metrics = recorder.getMetrics()
    assertEqual(metrics.duplicateDeals, 1, 'duplicateDeals increments only for duplicate finalize')
    assertEqual(metrics.noActiveDeal, 1, 'noActiveDeal increments only for unknown finalize')
    await recorder.shutdown(500)
  } finally {
    delete process.env['TRAINING_RECORDER_ENABLED']
    delete process.env['TRAINING_RECORDER_HASH_SECRET']
    delete process.env['TRAINING_RECORDER_PATH']
    await rm(dir, { recursive: true, force: true })
  }
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
    write: async (_p: string) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000)
        timer.unref()
      })
    },
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

// [32] Full deal integration (collector-level, via findAddedBidEntry/findAddedPlayedCard)
checkSync('[32] full deal integration: 20 bidding cards + 7 bids + 32 card plays → valid record', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)
  const roomId = `tr-${Date.now()}-32`
  const secret = 'secret-key-1234567'
  const wb: NonNullable<ServerWinningBid> = { seat: 'left', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }

  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), secret)
  collectorOnPlayingStart(roomId, baseState(fullHands, 'playing'))

  const bids: Array<{ seat: Seat; action: ServerBidAction }> = [
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
    { seat: 'left', action: { type: 'suit', suit: 'hearts' } },
    { seat: 'bottom', action: { type: 'pass' } },
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
  ]
  let entries: ServerBidEntry[] = []
  for (const bid of bids) {
    const stateBefore = baseState(biddingHands, 'bidding', {
      bidding: { entries, currentSeat: bid.seat, winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
    })
    entries = [...entries, bid]
    const hasEnded = entries.length === bids.length
    const stateAfter = baseState(biddingHands, 'bidding', {
      bidding: { entries, currentSeat: bid.seat, winningBid: hasEnded ? wb : null, hasStarted: true, hasEnded, consecutivePasses: 0 },
    })
    const diff = findAddedBidEntry(stateBefore, stateAfter)
    assert(diff.kind === 'added', `expected added for ${bid.seat}, got ${diff.kind}`)
    collectorOnBidAction(roomId, stateBefore, stateAfter, (diff as any).entry, 'human_manual')
  }

  const tricks = makeTricks(fullHands)
  let prevState: ServerAuthoritativeGameState = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([]),
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
          wonTricksBySeat: emptyWon(),
          wonTricksByTeam: { A: [], B: [] },
        },
      })

      const cardDiff = findAddedPlayedCard(prevState, nextState)
      assert(cardDiff.kind === 'added', `expected added at trick ${trick.trickIndex} pos ${pi}, got ${cardDiff.kind}`)
      collectorOnCardPlayed(roomId, prevState, nextState, (cardDiff as any).play, 'human_manual')
      prevState = nextState
    }
  }

  const result = collectorOnDealComplete(roomId, completedState(fullHands, wb, { teamA: 0, teamB: 80 }))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertNotNull(rec, 'record must not be null')
  assert(rec!.integrity.valid, `integrity violations: ${rec!.integrity.violations.join('; ')}`)
  assertEqual(rec!.biddingActions.length, bids.length, 'biddingActions count')
  assertEqual(rec!.cardActions.length, 32, 'cardActions count')
  const cardSequences = rec!.cardActions.map((a) => a.sequence)
  assertEqual(Math.min(...cardSequences), 1, 'minimum card sequence')
  assertEqual(Math.max(...cardSequences), 32, 'maximum card sequence')
  assertEqual(new Set(cardSequences).size, 32, 'card sequences unique')
  for (let i = 0; i < 32; i++) {
    assertEqual(cardSequences[i], i + 1, `card sequence at index ${i}`)
    assertEqual(
      rec!.cardActions[i]!.visibleBeforeAction.playedCardCountBeforeAction,
      i,
      `playedCardCountBeforeAction at sequence ${i + 1}`,
    )
  }
  assertEqual(rec!.cardActions[1]!.visibleBeforeAction.currentTrick[0]!.sequence, 1, 'before second card currentTrick sequence')
  assertEqual(
    rec!.cardActions[3]!.visibleBeforeAction.currentTrick.map((p) => p.sequence).join(','),
    '1,2,3',
    'before fourth card currentTrick sequences',
  )
  assertEqual(rec!.cardActions[4]!.sequence, 5, 'first card of second trick continues at sequence 5')
  assertEqual(rec!.cardActions[31]!.sequence, 32, 'last card sequence')
  assertEqual(rec!.tricks.length, 8, 'tricks count')
  assertEqual(rec!.tricks[7]!.plays[3]!.sequence, 32, 'last trick play global sequence')
  assertEqual(rec!.finalContract?.trumpSuit ?? null, 'hearts', 'trumpSuit')
  assertEqual(rec!.recordKind, 'full', 'recordKind')
})

// [33] score-independent correlation: 0:0 → 16:0 finalizes successfully
checkSync('[33] scoreBeforeDeal=0:0 → scoreAfterDeal=16:0 finalizes successfully', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const hands = splitHands(deck)
  const roomId = `tr-${Date.now()}-33`
  const wb = makeWinningBid('bottom')

  collectorOnBiddingStart(
    makeRoom(roomId),
    baseState(biddingHands, 'bidding', { score: { round: baseState(biddingHands).score.round, match: { teamA: 0, teamB: 0 }, carryOver: emptyScore() } }),
    'secret-key-1234567',
  )
  const result = collectorOnDealComplete(roomId, completedState(hands, wb, { teamA: 16, teamB: 0 }))
  assert(result.kind === 'enqueued', `expected enqueued, got ${result.kind}`)
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.scoreBeforeDeal.team0, 0, 'scoreBeforeDeal.team0')
  assertEqual(rec!.scoreBeforeDeal.team1, 0, 'scoreBeforeDeal.team1')
  assertEqual(rec!.scoreAfterDeal.team0, 16, 'scoreAfterDeal.team0')
  assertEqual(rec!.scoreAfterDeal.team1, 0, 'scoreAfterDeal.team1')
})

// [34-38] findAddedBidEntry
checkSync('[34] findAddedBidEntry: middle bid detected as added', () => {
  const prev = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const next = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }, { seat: 'top', action: { type: 'suit', suit: 'clubs' } }], currentSeat: 'left', winningBid: { seat: 'top', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false }, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const diff = findAddedBidEntry(prev, next)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  assertEqual((diff as any).entry.seat, 'top', 'seat')
  assertEqual((diff as any).entry.action.type, 'suit', 'action type')
})
checkSync('[35] findAddedBidEntry: last pass after a won bid (bidding→deal-last-3)', () => {
  const wb: NonNullable<ServerWinningBid> = { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false }
  const prevEntries: ServerBidEntry[] = [
    { seat: 'bottom', action: { type: 'suit', suit: 'clubs' } },
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
  ]
  const prev = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: prevEntries, currentSeat: 'left', winningBid: wb, hasStarted: true, hasEnded: false, consecutivePasses: 2 },
  })
  const next = baseState(splitHandsBidding(fullDeck()), 'deal-last-3', {
    bidding: { entries: [...prevEntries, { seat: 'left', action: { type: 'pass' } }], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 3 },
  })
  const diff = findAddedBidEntry(prev, next)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  assertEqual((diff as any).entry.seat, 'left', 'seat must be the final passer')
})
checkSync('[36] findAddedBidEntry: 4th pass at all-pass (bidding→next-round)', () => {
  const prevEntries: ServerBidEntry[] = [
    { seat: 'right', action: { type: 'pass' } },
    { seat: 'top', action: { type: 'pass' } },
    { seat: 'left', action: { type: 'pass' } },
  ]
  const prev = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: prevEntries, currentSeat: 'bottom', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 3 },
  })
  const next = baseState(splitHandsBidding(fullDeck()), 'next-round', {
    bidding: { entries: [...prevEntries, { seat: 'bottom', action: { type: 'pass' } }], currentSeat: null, winningBid: null, hasStarted: true, hasEnded: true, consecutivePasses: 4 },
  })
  const diff = findAddedBidEntry(prev, next)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  assertEqual((diff as any).entry.seat, 'bottom', 'seat must be the 4th passer')
})
checkSync('[37] findAddedBidEntry: mismatch when entries diverge', () => {
  const prev = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const next = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries: [{ seat: 'top', action: { type: 'pass' } }], currentSeat: 'left', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const diff = findAddedBidEntry(prev, next)
  assertEqual(diff.kind, 'mismatch', 'kind')
})
checkSync('[38] findAddedBidEntry: unchanged when entries identical', () => {
  const entries: ServerBidEntry[] = [{ seat: 'right', action: { type: 'pass' } }]
  const prev = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries, currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const next = baseState(splitHandsBidding(fullDeck()), 'bidding', {
    bidding: { entries, currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const diff = findAddedBidEntry(prev, next)
  assertEqual(diff.kind, 'unchanged', 'kind')
})

// [39-41] findAddedPlayedCard / flattenPlayedCards
checkSync('[39] flattenPlayedCards + findAddedPlayedCard: playing→playing new card', () => {
  const hands = splitHands(fullDeck())
  const prev = baseState(hands, 'playing', {
    playing: {
      hasStarted: true, currentTurnSeat: 'right',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'right', plays: [{ seat: 'bottom', card: hands.bottom[0]! }], winnerSeat: null, trickIndex: 0 },
      completedTricks: [], lastCompletedTrickWinnerSeat: null, lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
    },
  })
  const next = baseState(hands, 'playing', {
    playing: {
      hasStarted: true, currentTurnSeat: 'top',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'top', plays: [{ seat: 'bottom', card: hands.bottom[0]! }, { seat: 'right', card: hands.right[0]! }], winnerSeat: null, trickIndex: 0 },
      completedTricks: [], lastCompletedTrickWinnerSeat: null, lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
    },
  })
  assertEqual(flattenPlayedCards(prev).length, 1, 'prev history length')
  assertEqual(flattenPlayedCards(next).length, 2, 'next history length')
  const diff = findAddedPlayedCard(prev, next)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  assertEqual((diff as any).play.seat, 'right', 'seat')
  assertEqual((diff as any).play.card.id, hands.right[0]!.id, 'card id')
})
checkSync('[40] findAddedPlayedCard: playing→scoring new 32nd card', () => {
  const hands = splitHands(fullDeck())
  const sevenTricks = makeTricks(hands).slice(0, 7)
  const lastTrick = makeTricks(hands)[7]!
  const prev = baseState(hands, 'playing', {
    playing: {
      hasStarted: true, currentTurnSeat: 'left',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'left', plays: lastTrick.plays.slice(0, 3), winnerSeat: null, trickIndex: 7 },
      completedTricks: sevenTricks, lastCompletedTrickWinnerSeat: 'bottom', lastCompletedTrickWinnerTeam: 'A',
      wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
    },
  })
  const next = baseState(hands, 'scoring', {
    playing: {
      hasStarted: true, currentTurnSeat: null,
      currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 8 },
      completedTricks: [...sevenTricks, lastTrick], lastCompletedTrickWinnerSeat: 'bottom', lastCompletedTrickWinnerTeam: 'A',
      wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
    },
  })
  assertEqual(flattenPlayedCards(prev).length, 31, 'prev history length')
  assertEqual(flattenPlayedCards(next).length, 32, 'next history length')
  const diff = findAddedPlayedCard(prev, next)
  assert(diff.kind === 'added', `expected added, got ${diff.kind}`)
  assertEqual((diff as any).play.seat, lastTrick.plays[3]!.seat, 'seat')
  assertEqual((diff as any).play.card.id, lastTrick.plays[3]!.card.id, 'card id')
})
checkSync('[41] findAddedPlayedCard: playing→scoring finalize-only (already 32, no new card)', () => {
  const hands = splitHands(fullDeck())
  const allTricks = makeTricks(hands)
  const playingState: ServerPlayingState = {
    hasStarted: true, currentTurnSeat: null,
    currentTrick: { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 8 },
    completedTricks: allTricks, lastCompletedTrickWinnerSeat: 'bottom', lastCompletedTrickWinnerTeam: 'A',
    wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
  }
  const prev = baseState(hands, 'playing', { playing: playingState })
  const next = baseState(hands, 'scoring', { playing: playingState })
  assertEqual(flattenPlayedCards(prev).length, 32, 'prev history length')
  assertEqual(flattenPlayedCards(next).length, 32, 'next history length')
  const diff = findAddedPlayedCard(prev, next)
  assertEqual(diff.kind, 'unchanged', 'kind must be unchanged — finalize only, no new card')
})

// [42-43] Action-level dedup
checkSync('[42] Action-level dedup: bid observed via human hook then auto hook → one action, human_manual kept', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-42`
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')

  const stateBefore = baseState(biddingHands, 'bidding', {
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  const stateAfter = baseState(biddingHands, 'bidding', {
    bidding: { entries: [{ seat: 'right', action: { type: 'pass' } }], currentSeat: 'top', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 1 },
  })
  const diff = findAddedBidEntry(stateBefore, stateAfter)
  assert(diff.kind === 'added', 'expected added')
  const entry = (diff as any).entry

  const r1 = collectorOnBidAction(roomId, stateBefore, stateAfter, entry, 'human_manual')
  assertEqual(r1, 'recorded', 'first observation must record')
  const r2 = collectorOnBidAction(roomId, stateBefore, stateAfter, entry, 'auto')
  assertEqual(r2, 'duplicate', 'second observation (same transition) must be a duplicate')

  const result = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid('right')))
  assert(result.kind === 'enqueued', 'must enqueue')
  const rec = result.kind === 'enqueued' ? result.record : null
  assertEqual(rec!.biddingActions.length, 1, 'exactly one bid action recorded')
  assertEqual(rec!.biddingActions[0]!.actorKind, 'human_manual', 'first-seen actorKind must be preserved')
})

checkSync('[43] Action-level dedup: same card observed twice → one card action recorded', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)
  const roomId = `tr-${Date.now()}-43`
  const wb: NonNullable<ServerWinningBid> = { seat: 'bottom', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  collectorOnPlayingStart(roomId, baseState(fullHands, 'playing'))

  const stateBefore = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: makePlaying([]),
  })
  const stateAfter = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: {
      hasStarted: true, currentTurnSeat: 'right',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'right', plays: [{ seat: 'bottom', card: fullHands.bottom[0]! }], winnerSeat: null, trickIndex: 0 },
      completedTricks: [], lastCompletedTrickWinnerSeat: null, lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(), wonTricksByTeam: { A: [], B: [] },
    },
  })
  const diff = findAddedPlayedCard(stateBefore, stateAfter)
  assert(diff.kind === 'added', 'expected added')
  const play = (diff as any).play

  const r1 = collectorOnCardPlayed(roomId, stateBefore, stateAfter, play, 'human_manual')
  assertEqual(r1, 'recorded', 'first observation must record')
  const r2 = collectorOnCardPlayed(roomId, stateBefore, stateAfter, play, 'auto')
  assertEqual(r2, 'duplicate', 'second observation must be a duplicate')

  collectorDropDeal(roomId)
})

checkSync('[43b] Canonical submitHumanBidActionForRoom success records exactly one human_manual bid', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-43b`
  const stateBefore = baseState(biddingHands, 'bidding', {
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBiddingStart(makeRoom(roomId), stateBefore, 'secret-key-1234567')
  const room = makeE2eRoom(roomId, stateBefore, E2E_SEAT_KINDS)
  const result = submitHumanBidActionForRoom(room, 'right', { type: 'pass' })
  assert(result.ok, result.ok ? 'ok' : result.message)
  handleTrainingRecorderHumanBid({
    onBidAction: (id, before, after, entry, origin) => {
      const r = collectorOnBidAction(id, before, after, entry, origin)
      assertEqual(r, 'recorded', 'collectorOnBidAction result')
    },
    onBiddingStart: () => undefined,
    onPlayingStart: () => undefined,
    onCardPlayed: () => undefined,
    onDealComplete: () => undefined,
    onAllPass: () => undefined,
    onDealAbandoned: () => undefined,
    onInvalidTransition: () => undefined,
    getMetrics: () => createTrainingRecorder().getMetrics(),
    shutdown: async () => undefined,
  }, room, result.room)
  const recResult = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(recResult.kind === 'enqueued', `expected enqueued, got ${recResult.kind}`)
  assertEqual(recResult.record.biddingActions.length, 1, 'exactly one bid action')
  assertEqual(recResult.record.biddingActions[0]!.actorKind, 'human_manual', 'actorKind')
})

checkSync('[43c] Canonical submitHumanBidActionForRoom rejected bid is not recorded', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const roomId = `tr-${Date.now()}-43c`
  const stateBefore = baseState(biddingHands, 'bidding', {
    bidding: { entries: [], currentSeat: 'right', winningBid: null, hasStarted: true, hasEnded: false, consecutivePasses: 0 },
  })
  collectorOnBiddingStart(makeRoom(roomId), stateBefore, 'secret-key-1234567')
  const room = makeE2eRoom(roomId, stateBefore, E2E_SEAT_KINDS)
  const result = submitHumanBidActionForRoom(room, 'top', { type: 'pass' })
  assert(!result.ok, 'bid from wrong seat must be rejected')
  const recResult = collectorOnDealComplete(roomId, completedState(splitHands(deck), makeWinningBid()))
  assert(recResult.kind === 'enqueued', `expected enqueued, got ${recResult.kind}`)
  assertEqual(recResult.record.biddingActions.length, 0, 'rejected bid must not be recorded')
})

checkSync('[43d] Canonical submitHumanPlayCardForRoom success records exactly one human_manual card', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)
  const roomId = `tr-${Date.now()}-43d`
  const wb = makeWinningBid('bottom')
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  collectorOnPlayingStart(roomId, baseState(fullHands, 'playing'))
  const stateBefore = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: {
      hasStarted: true,
      currentTurnSeat: 'bottom',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'bottom', plays: [], winnerSeat: null, trickIndex: 0 },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(),
      wonTricksByTeam: { A: [], B: [] },
    },
  })
  const room = makeE2eRoom(roomId, stateBefore, E2E_SEAT_KINDS)
  const cardId = fullHands.bottom[0]!.id
  const result = submitHumanPlayCardForRoom(room, 'bottom', cardId)
  assert(result.ok, result.ok ? 'ok' : result.message)
  handleTrainingRecorderHumanCard({
    onCardPlayed: (id, before, after, play, origin) => {
      const r = collectorOnCardPlayed(id, before, after, play, origin)
      assertEqual(r, 'recorded', 'collectorOnCardPlayed result')
    },
    onBiddingStart: () => undefined,
    onPlayingStart: () => undefined,
    onBidAction: () => undefined,
    onDealComplete: () => undefined,
    onAllPass: () => undefined,
    onDealAbandoned: () => undefined,
    onInvalidTransition: () => undefined,
    getMetrics: () => createTrainingRecorder().getMetrics(),
    shutdown: async () => undefined,
  }, room, result.room)
  const recResult = collectorOnDealComplete(roomId, completedState(fullHands, wb))
  assert(recResult.kind === 'enqueued', `expected enqueued, got ${recResult.kind}`)
  assertEqual(recResult.record.cardActions.length, 1, 'exactly one card action')
  assertEqual(recResult.record.cardActions[0]!.actorKind, 'human_manual', 'actorKind')
})

checkSync('[43e] Canonical submitHumanPlayCardForRoom rejected card is not recorded', () => {
  const deck = fullDeck()
  const biddingHands = splitHandsBidding(deck)
  const fullHands = splitHands(deck)
  const roomId = `tr-${Date.now()}-43e`
  const wb = makeWinningBid('bottom')
  collectorOnBiddingStart(makeRoom(roomId), baseState(biddingHands, 'bidding'), 'secret-key-1234567')
  collectorOnPlayingStart(roomId, baseState(fullHands, 'playing'))
  const stateBefore = baseState(fullHands, 'playing', {
    bidding: { entries: [], currentSeat: null, winningBid: wb, hasStarted: true, hasEnded: true, consecutivePasses: 0 },
    playing: {
      hasStarted: true,
      currentTurnSeat: 'bottom',
      currentTrick: { leaderSeat: 'bottom', currentSeat: 'bottom', plays: [], winnerSeat: null, trickIndex: 0 },
      completedTricks: [],
      lastCompletedTrickWinnerSeat: null,
      lastCompletedTrickWinnerTeam: null,
      wonTricksBySeat: emptyWon(),
      wonTricksByTeam: { A: [], B: [] },
    },
  })
  const room = makeE2eRoom(roomId, stateBefore, E2E_SEAT_KINDS)
  const result = submitHumanPlayCardForRoom(room, 'top', fullHands.top[0]!.id)
  assert(!result.ok, 'card from wrong seat must be rejected')
  const recResult = collectorOnDealComplete(roomId, completedState(fullHands, wb))
  assert(recResult.kind === 'enqueued', `expected enqueued, got ${recResult.kind}`)
  assertEqual(recResult.record.cardActions.length, 0, 'rejected card must not be recorded')
})

// [44-47] Canonical trick points
checkSync('[44] Canonical trick points: suit contract (hearts trump)', () => {
  const trick = { plays: [
    { card: card('hearts', 'J') },  // trump J = 20
    { card: card('clubs', 'A') },   // non-trump A = 11
    { card: card('hearts', '9') },  // trump 9 = 14
    { card: card('spades', '10') }, // non-trump 10 = 10
  ] }
  const pts = getServerTrickCardPoints(trick, 'suit', 'hearts')
  assertEqual(pts, 20 + 11 + 14 + 10, 'raw trick points')
})
checkSync('[45] Canonical trick points: all-trumps contract', () => {
  const trick = { plays: [
    { card: card('hearts', 'J') },  // 20
    { card: card('clubs', 'J') },   // 20
    { card: card('hearts', 'A') },  // 11
    { card: card('spades', 'Q') },  // 3
  ] }
  const pts = getServerTrickCardPoints(trick, 'all-trumps', null)
  assertEqual(pts, 20 + 20 + 11 + 3, 'raw trick points')
})
checkSync('[46] Canonical trick points: no-trumps contract doubles raw points', () => {
  const trick = { plays: [
    { card: card('hearts', 'A') },  // 11
    { card: card('clubs', '10') },  // 10
    { card: card('spades', 'K') },  // 4
    { card: card('diamonds', 'Q') }, // 3
  ] }
  const pts = getServerTrickCardPoints(trick, 'no-trumps', null)
  assertEqual(pts, (11 + 10 + 4 + 3) * 2, 'no-trumps raw points must be doubled')
})
checkSync('[47] Canonical trick points: double/redouble do not change raw trick points', () => {
  const trick = { plays: [
    { card: card('hearts', 'J') },
    { card: card('clubs', 'A') },
    { card: card('hearts', '9') },
    { card: card('spades', '10') },
  ] }
  // getServerTrickCardPoints has no doubled/redoubled parameter — contract multipliers
  // are applied only at the official-score level, never to raw trick card points.
  const pts1 = getServerTrickCardPoints(trick, 'suit', 'hearts')
  const pts2 = getServerTrickCardPoints(trick, 'suit', 'hearts')
  assertEqual(pts1, pts2, 'raw trick points must be stable regardless of double/redouble')
  assertEqual(pts1, 20 + 11 + 14 + 10, 'raw trick points value')
})

// [48] Semantic outcome matches legacy label mapping
checkSync('[48] Semantic outcome: scoring.outcome matches legacy outcomeShortLabel mapping', () => {
  const wb = makeWinningBid()
  const legacyMade = makeScoring(wb, { outcomeShortLabel: getServerOutcomeShortLabel('made') }) as Omit<ServerScoringState, 'outcome'>
  delete (legacyMade as Partial<ServerScoringState>).outcome
  assertEqual(normalizeServerScoringState(legacyMade as ServerScoringState)?.outcome, 'made', 'legacy made label')

  const legacyInside = makeScoring(wb, { outcomeShortLabel: getServerOutcomeShortLabel('inside') }) as Omit<ServerScoringState, 'outcome'>
  delete (legacyInside as Partial<ServerScoringState>).outcome
  assertEqual(normalizeServerScoringState(legacyInside as ServerScoringState)?.outcome, 'inside', 'legacy inside label')

  const legacyTie = makeScoring(wb, { outcomeShortLabel: getServerOutcomeShortLabel('tie') }) as Omit<ServerScoringState, 'outcome'>
  delete (legacyTie as Partial<ServerScoringState>).outcome
  assertEqual(normalizeServerScoringState(legacyTie as ServerScoringState)?.outcome, 'tie', 'legacy tie label')

  const modern = makeScoring(wb, { outcome: 'inside', outcomeShortLabel: getServerOutcomeShortLabel('made') })
  assertEqual(normalizeServerScoringState(modern)?.outcome, 'inside', 'modern outcome is preserved')

  const unknownLegacy = makeScoring(wb, { outcomeShortLabel: 'unknown legacy label' }) as Omit<ServerScoringState, 'outcome'>
  delete (unknownLegacy as Partial<ServerScoringState>).outcome
  assertEqual(normalizeServerScoringState(unknownLegacy as ServerScoringState)?.outcome, 'made', 'unknown legacy label fails safe')
})

// [49] Retention safety
checkAsync('[49a] Retention cleanup deletes only strict closed recorder JSONL files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tr-retention-'))
  try {
    const oldDir = join(dir, '2000-01-01')
    await mkdir(oldDir, { recursive: true })
    const closedPath = join(oldDir, 'process-old-worker-0-part-0001.jsonl')
    const keepTxt = join(oldDir, 'keep-me.txt')
    const crashedActive = join(oldDir, 'crashed.active.jsonl')
    const archiveGz = join(oldDir, 'archive.gz')
    await writeFile(closedPath, '{"old":true}\n')
    await writeFile(keepTxt, 'keep')
    await writeFile(crashedActive, '{"active":true}\n')
    await writeFile(archiveGz, 'gz')

    const metrics = createMutableMetrics()
    const writer = createTrainingRecorderWriter(
      { enabled: true, storagePath: dir, hashSecret: 'x'.repeat(20), maxFileMb: 100, maxTotalGb: 10, maxQueue: 1000, retentionDays: 1, processId: 'R', workerId: '0' },
      metrics,
    )
    await writer.write('{"trigger":true}')

    const closedGone = await stat(closedPath).then(() => false).catch(() => true)
    const txtExists = await stat(keepTxt).then(() => true).catch(() => false)
    const activeExists = await stat(crashedActive).then(() => true).catch(() => false)
    const gzExists = await stat(archiveGz).then(() => true).catch(() => false)
    const oldDirExists = await stat(oldDir).then(() => true).catch(() => false)
    assert(closedGone, 'strict closed recorder .jsonl must be deleted')
    assert(txtExists, 'keep-me.txt must remain')
    assert(activeExists, 'crashed.active.jsonl must remain')
    assert(gzExists, 'archive.gz must remain')
    assert(oldDirExists, 'non-empty old directory must remain')
    await writer.shutdown(200)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [49] Multi-process writer safety
checkAsync('[49b] Total-size cleanup: active and unknown files survive; old strict closed file is eligible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tr-multiproc-'))
  try {
    const metricsA = createMutableMetrics()
    const writerA = createTrainingRecorderWriter(
      { enabled: true, storagePath: dir, hashSecret: 'x'.repeat(20), maxFileMb: 100, maxTotalGb: 10, maxQueue: 1000, retentionDays: 90, processId: 'A', workerId: '0' },
      metricsA,
    )
    await writerA.write('{"a":1}')
    const activePathA = writerA.getCurrentFilePath()
    assertNotNull(activePathA, 'writer A must have an active file path')
    assert(activePathA!.endsWith('.active.jsonl'), `writer A file must be *.active.jsonl, got ${activePathA}`)

    // Manufacture an old, large, CLOSED file belonging to a different process
    // so writer B's maxTotalGb enforcement has something eligible to delete.
    const oldDir = join(dir, '2000-01-01')
    const { utimes } = await import('node:fs/promises')
    await mkdir(oldDir, { recursive: true })
    const oldClosedPath = join(oldDir, 'process-OLD-worker-0-part-0001.jsonl')
    const unknownPath = join(oldDir, 'not-a-recorder.jsonl')
    await writeFile(oldClosedPath, 'x'.repeat(2_000_000))
    await writeFile(unknownPath, 'x'.repeat(2_000_000))
    const oldDate = new Date('2000-01-01T00:00:00Z')
    await utimes(oldClosedPath, oldDate, oldDate)
    await utimes(unknownPath, oldDate, oldDate)

    const metricsB = createMutableMetrics()
    // Tiny maxTotalGb so enforceMaxTotalSize is forced to run and delete something.
    const writerB = createTrainingRecorderWriter(
      { enabled: true, storagePath: dir, hashSecret: 'x'.repeat(20), maxFileMb: 100, maxTotalGb: 0.000001, maxQueue: 1000, retentionDays: 100_000, processId: 'B', workerId: '0' },
      metricsB,
    )
    await writerB.write('{"b":1}')

    const aStillActive = await stat(activePathA!).then(() => true).catch(() => false)
    assert(aStillActive, "writer A's active file must survive writer B's cleanup")

    const oldFileGone = await stat(oldClosedPath).then(() => false).catch(() => true)
    assert(oldFileGone, 'old closed file from another process must be deleted by size enforcement')
    const unknownStillExists = await stat(unknownPath).then(() => true).catch(() => false)
    assert(unknownStillExists, 'unknown .jsonl file must not be deleted by size enforcement')

    await writerA.shutdown(200)
    await writerB.shutdown(200)

    const aClosedPath = activePathA!.replace('.active.jsonl', '.jsonl')
    const aClosedExists = await stat(aClosedPath).then(() => true).catch(() => false)
    assert(aClosedExists, 'writer A file must be finalized to *.jsonl on shutdown')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// [50] Full deal end-to-end via real hooks + real writer
let e2eFullDealBytes = 0
let e2eFullDealGzipBytes = 0
let e2eFullJsonlPath: string | null = null
checkAsync('[50] Full deal end-to-end via real hooks + real writer → physical JSONL row is correct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tr-e2e-full-'))
  try {
    process.env['TRAINING_RECORDER_ENABLED'] = 'true'
    process.env['TRAINING_RECORDER_HASH_SECRET'] = 'e2e-full-deal-secret-32chars!!'
    process.env['TRAINING_RECORDER_PATH'] = dir
    const recorder = createTrainingRecorder('e2e-full')
    assert(recorder.getMetrics().enabled, 'recorder must be enabled for this test')

    const roomId = `e2e-full-room-${Date.now()}`
    await runFullDealThroughHooks(recorder, roomId, { teamA: 16, teamB: 0 })
    await recorder.shutdown(3_000)

    delete process.env['TRAINING_RECORDER_ENABLED']
    delete process.env['TRAINING_RECORDER_HASH_SECRET']
    delete process.env['TRAINING_RECORDER_PATH']

    const { readdir } = await import('node:fs/promises')
    const dateDirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())
    assertEqual(dateDirs.length, 1, 'exactly one date dir')
    const files = (await readdir(join(dir, dateDirs[0]!.name), { withFileTypes: true })).filter((e) => e.isFile())
    const jsonlFiles = files.filter((f) => f.name.endsWith('.jsonl') && !f.name.endsWith('.active.jsonl'))
    assertEqual(jsonlFiles.length, 1, `expected exactly one closed .jsonl file, got: ${files.map((f) => f.name).join(', ')}`)

    const filePath = join(dir, dateDirs[0]!.name, jsonlFiles[0]!.name)
    e2eFullJsonlPath = filePath
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    assertEqual(lines.length, 1, 'JSONL rows = 1')

    e2eFullDealBytes = Buffer.byteLength(lines[0]!, 'utf8')
    e2eFullDealGzipBytes = gzipSync(Buffer.from(lines[0]!, 'utf8')).length

    const rec = JSON.parse(lines[0]!) as TrainingDealRecord
    assertEqual(rec.recordKind, 'full', 'recordKind')
    assertEqual(Object.values(rec.handsAtBiddingStart).reduce((n, h) => n + h.length, 0), 20, 'handsAtBiddingStart = 4×5')
    assertNotNull(rec.initialHands, 'initialHands must be present')
    assertEqual(Object.values(rec.initialHands!).reduce((n, h) => n + h.length, 0), 32, 'initialHands = 4×8')
    assertEqual(rec.finalContract?.trumpSuit ?? null, 'hearts', 'final bid trumpSuit')
    assertEqual(rec.finalContract?.contract ?? null, 'suit', 'final bid contract')
    assertEqual(rec.cardActions.length, 32, 'cardActions = 32')
    const uniqueChosen = new Set(rec.cardActions.map((a) => a.chosenCard.id))
    assertEqual(uniqueChosen.size, 32, 'chosen cards unique = 32')
    assertEqual(rec.tricks.length, 8, 'tricks = 8')
    assert(rec.integrity.valid, `integrity.valid must be true: ${rec.integrity.violations.join('; ')}`)
    assert(rec.roomKey !== roomId, 'roomKey must not equal raw roomId')
    assertEqual(rec.roomKey.length, 64, 'roomKey is 64-char HMAC hex')
    assertEqual(rec.scoreBeforeDeal.team0, 0, 'scoreBeforeDeal.team0')
    assertEqual(rec.scoreAfterDeal.team0, 16, 'scoreAfterDeal.team0')
    assert(
      rec.scoreBeforeDeal.team0 !== rec.scoreAfterDeal.team0 || rec.scoreBeforeDeal.team1 !== rec.scoreAfterDeal.team1,
      'score must have changed across the deal',
    )

    const humanBidActions = rec.biddingActions.filter((a) => a.actorKind === 'human_manual')
    const botOriginalBidActions = rec.biddingActions.filter((a) => a.actorKind === 'bot_original')
    const timeoutBidActions = rec.biddingActions.filter((a) => a.actorKind === 'human_timeout')
    assert(humanBidActions.length > 0, 'expected at least one human_manual bid action')
    assert(botOriginalBidActions.length > 0, 'expected at least one bot_original bid action')
    assert(timeoutBidActions.length > 0, 'expected at least one human_timeout bid action')

    const humanCardActions = rec.cardActions.filter((a) => a.actorKind === 'human_manual')
    const botOriginalCardActions = rec.cardActions.filter((a) => a.actorKind === 'bot_original')
    const botTakeoverCardActions = rec.cardActions.filter((a) => a.actorKind === 'bot_takeover')
    assert(humanCardActions.length > 0, 'expected at least one human_manual card action')
    assert(botOriginalCardActions.length > 0, 'expected at least one bot_original card action')
    assert(botTakeoverCardActions.length > 0, 'expected at least one bot_takeover card action (left seat, post-timeout)')
  } finally {
    // Keep the generated physical JSONL long enough for the validator test.
  }
})

// [51] All-pass end-to-end via real hooks + real writer
let e2eBiddingOnlyBytes = 0
let e2eBiddingOnlyGzipBytes = 0
let e2eBiddingOnlyJsonlPath: string | null = null
checkAsync('[51] All-pass end-to-end via real hooks + real writer → physical JSONL row is correct', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tr-e2e-pass-'))
  try {
    process.env['TRAINING_RECORDER_ENABLED'] = 'true'
    process.env['TRAINING_RECORDER_HASH_SECRET'] = 'e2e-all-pass-secret-32chars!!!'
    process.env['TRAINING_RECORDER_PATH'] = dir
    const recorder = createTrainingRecorder('e2e-pass')
    assert(recorder.getMetrics().enabled, 'recorder must be enabled for this test')

    const roomId = `e2e-pass-room-${Date.now()}`
    await runAllPassThroughHooks(recorder, roomId)
    await recorder.shutdown(3_000)

    delete process.env['TRAINING_RECORDER_ENABLED']
    delete process.env['TRAINING_RECORDER_HASH_SECRET']
    delete process.env['TRAINING_RECORDER_PATH']

    const { readdir } = await import('node:fs/promises')
    const dateDirs = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())
    assertEqual(dateDirs.length, 1, 'exactly one date dir')
    const files = (await readdir(join(dir, dateDirs[0]!.name), { withFileTypes: true })).filter((e) => e.isFile())
    const jsonlFiles = files.filter((f) => f.name.endsWith('.jsonl') && !f.name.endsWith('.active.jsonl'))
    assertEqual(jsonlFiles.length, 1, `expected exactly one closed .jsonl file, got: ${files.map((f) => f.name).join(', ')}`)

    const filePath = join(dir, dateDirs[0]!.name, jsonlFiles[0]!.name)
    e2eBiddingOnlyJsonlPath = filePath
    const raw = await readFile(filePath, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    assertEqual(lines.length, 1, 'JSONL rows = 1')

    e2eBiddingOnlyBytes = Buffer.byteLength(lines[0]!, 'utf8')
    e2eBiddingOnlyGzipBytes = gzipSync(Buffer.from(lines[0]!, 'utf8')).length

    const rec = JSON.parse(lines[0]!) as TrainingDealRecord
    assertEqual(rec.recordKind, 'bidding_only', 'recordKind')
    assertEqual(rec.biddingActions.length, 4, 'biddingActions = 4')
    assertEqual(rec.biddingActions[3]!.chosenAction.type, 'pass', 'fourth pass is the final action')
    assertNull(rec.initialHands, 'initialHands = null')
    assertEqual(rec.cardActions.length, 0, 'cardActions = 0')
    assertEqual(rec.tricks.length, 0, 'tricks = 0')
    assert(rec.integrity.valid, `integrity.valid must be true: ${rec.integrity.violations.join('; ')}`)
  } finally {
    // Keep the generated physical JSONL long enough for the validator test.
  }
})

function runValidator(targetPath: string): { status: number | null; stdout: string; stderr: string } {
  const tsxCli = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const result = spawnSync(
    process.execPath,
    [tsxCli, 'scripts/validateTrainingRecordings.ts', targetPath],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error instanceof Error ? result.error.message : ''),
  }
}

checkAsync('[52] Physical JSONL validator: full, all-pass, and combined directory exit 0', async () => {
  assertNotNull(e2eFullJsonlPath, 'full e2e JSONL path')
  assertNotNull(e2eBiddingOnlyJsonlPath, 'bidding-only e2e JSONL path')

  const fullResult = runValidator(e2eFullJsonlPath!)
  assertEqual(fullResult.status, 0, `full validator exit code; stdout=${fullResult.stdout}; stderr=${fullResult.stderr}`)

  const passResult = runValidator(e2eBiddingOnlyJsonlPath!)
  assertEqual(passResult.status, 0, `all-pass validator exit code; stdout=${passResult.stdout}; stderr=${passResult.stderr}`)

  const combinedDir = await mkdtemp(join(tmpdir(), 'tr-e2e-combined-'))
  await writeFile(join(combinedDir, 'full.jsonl'), await readFile(e2eFullJsonlPath!, 'utf8'))
  await writeFile(join(combinedDir, 'all-pass.jsonl'), await readFile(e2eBiddingOnlyJsonlPath!, 'utf8'))
  const combinedResult = runValidator(combinedDir)
  assertEqual(combinedResult.status, 0, `combined validator exit code; stdout=${combinedResult.stdout}; stderr=${combinedResult.stderr}`)
})

// ─── Run async tests and print summary ───────────────────────────────────────

async function main() {
  for (const fn of asyncQueue) await fn()

  if (e2eFullDealBytes > 0) {
    console.log('\n─── Measured real file sizes (from e2e tests) ───')
    console.log(`  Full deal row:      ${e2eFullDealBytes} bytes  (gzip: ${e2eFullDealGzipBytes} bytes)`)
    console.log(`  Bidding-only row:   ${e2eBiddingOnlyBytes} bytes  (gzip: ${e2eBiddingOnlyGzipBytes} bytes)`)
    for (const n of [1_000, 10_000, 100_000, 1_000_000]) {
      const fullProjected = e2eFullDealBytes * n
      const fullGzipProjected = e2eFullDealGzipBytes * n
      console.log(
        `  ${String(n).padStart(9)} full rows:  ~${(fullProjected / 1024 / 1024).toFixed(2)} MB raw, ~${(fullGzipProjected / 1024 / 1024).toFixed(2)} MB gzip (linear extrapolation)`,
      )
    }
  }

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error('Unexpected error:', e)
  process.exit(1)
})

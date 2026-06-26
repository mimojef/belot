/**
 * checkReconnectContractDisplay.ts — Server-side snapshot checks за winningBid при playing.
 *
 * Тества createRoomSnapshotMessage с реален ServerAuthoritativeGameState.
 * Само server код — без клиентски импорти.
 *
 * [0]  playing snapshot: suit contract → winningBid.contract === 'suit', trumpSuit коректен
 * [1]  playing snapshot: all-trumps → winningBid.contract === 'all-trumps', trumpSuit === null
 * [2]  playing snapshot: no-trumps → winningBid.contract === 'no-trumps', trumpSuit === null
 * [3]  playing snapshot: doubled → winningBid.doubled === true
 * [4]  playing snapshot: redoubled → winningBid.redoubled === true
 * [5]  playing snapshot: declarer seat се прехвърля коректно
 * [6]  scoring snapshot: winningBid се запазва в scoring фаза, playing === null
 * [7]  playing snapshot с null winningBid → winningBid === null (passed round guard)
 * [8]  bidding фаза → playing snapshot е null
 */

import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import type { ServerAuthoritativeGameState, ServerWinningBid } from '../src/game/serverGameTypes.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import {
  createEmptyBiddingState,
  createEmptyCarryOverPoints,
  createEmptyHands,
  createEmptyMatchDeclarationMissionCounts,
  createEmptyPlayingState,
  createEmptyScoreBreakdown,
  createEmptyTimerState,
  createEmptyTrickState,
  createEmptyWonTricks,
} from '../src/game/createServerRoundDefaults.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function makeIdentity() {
  return {
    accountId: null,
    profileId: null,
    username: null,
    displayName: 'Bot',
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
    gender: null,
  }
}

function makeSeatSlot(seat: 'bottom' | 'right' | 'top' | 'left') {
  return {
    seat,
    team: (seat === 'bottom' || seat === 'top' ? 'A' : 'B') as 'A' | 'B',
    participant: {
      kind: 'bot' as const,
      playerId: `bot-${seat}`,
      joinedAt: 0,
      botCode: 'easy',
      difficulty: 'easy' as const,
      identity: makeIdentity(),
    },
  }
}

function makeState(
  phase: ServerAuthoritativeGameState['phase'],
  winningBid: ServerWinningBid,
  overrides?: Partial<ServerAuthoritativeGameState>,
): ServerAuthoritativeGameState {
  return {
    phase,
    phaseEnteredAt: null,
    targetScore: 151,
    players: {
      bottom: { seat: 'bottom', team: 'A', mode: 'bot', controlledByBot: false },
      right: { seat: 'right', team: 'B', mode: 'bot', controlledByBot: false },
      top: { seat: 'top', team: 'A', mode: 'bot', controlledByBot: false },
      left: { seat: 'left', team: 'B', mode: 'bot', controlledByBot: false },
    },
    round: {
      dealerSeat: 'right',
      cutterSeat: null,
      firstBidderSeat: null,
      firstDealSeat: null,
      selectedCutIndex: null,
    },
    deck: [],
    hands: createEmptyHands(),
    bidding: {
      ...createEmptyBiddingState(),
      hasEnded: true,
      winningBid,
    },
    declarations: [],
    matchDeclarationMissionCounts: createEmptyMatchDeclarationMissionCounts(),
    currentTrick: createEmptyTrickState(),
    wonTricks: createEmptyWonTricks(),
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      currentTurnSeat: 'bottom',
    },
    scoring: null,
    matchEnded: null,
    score: {
      round: createEmptyScoreBreakdown(),
      match: { teamA: 0, teamB: 0 },
      carryOver: createEmptyCarryOverPoints(),
    },
    timer: createEmptyTimerState(),
    ...overrides,
  }
}

function makeRoom(authoritativeState: ServerAuthoritativeGameState): ServerRoom {
  return {
    id: 'room-test',
    status: 'playing',
    createdAt: 0,
    updatedAt: 0,
    hostPlayerId: null,
    config: {
      maxPlayers: 4,
      allowBots: true,
      isPrivate: false,
      joinCode: null,
      stakeAmount: null,
      targetScore: 151,
      turnTimeMs: 15000,
      reconnectGraceMs: 30000,
    },
    seats: {
      bottom: makeSeatSlot('bottom'),
      right: makeSeatSlot('right'),
      top: makeSeatSlot('top'),
      left: makeSeatSlot('left'),
    },
    game: {
      phase: 'playing',
      stateVersion: 1,
      startedAt: 0,
      updatedAt: 0,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState,
    },
    replayVotes: [],
    leaveVotes: [],
  }
}

// ── [0] suit contract ─────────────────────────────────────────────────────────

console.log('\n[0] playing snapshot: suit contract')
{
  const wb: ServerWinningBid = { seat: 'bottom', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  const p = msg.game?.playing
  check('playing snapshot не е null', p != null)
  check('winningBid.contract === suit', p?.winningBid?.contract === 'suit')
  check('winningBid.trumpSuit === hearts', p?.winningBid?.trumpSuit === 'hearts')
  check('winningBid.doubled === false', p?.winningBid?.doubled === false)
}

// ── [1] all-trumps ─────────────────────────────────────────────────────────────

console.log('\n[1] playing snapshot: all-trumps')
{
  const wb: ServerWinningBid = { seat: 'top', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  const p = msg.game?.playing
  check('winningBid.contract === all-trumps', p?.winningBid?.contract === 'all-trumps')
  check('winningBid.trumpSuit === null', p?.winningBid?.trumpSuit === null)
}

// ── [2] no-trumps ──────────────────────────────────────────────────────────────

console.log('\n[2] playing snapshot: no-trumps')
{
  const wb: ServerWinningBid = { seat: 'left', contract: 'no-trumps', trumpSuit: null, doubled: false, redoubled: false }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  const p = msg.game?.playing
  check('winningBid.contract === no-trumps', p?.winningBid?.contract === 'no-trumps')
  check('winningBid.trumpSuit === null', p?.winningBid?.trumpSuit === null)
}

// ── [3] doubled ────────────────────────────────────────────────────────────────

console.log('\n[3] playing snapshot: doubled')
{
  const wb: ServerWinningBid = { seat: 'right', contract: 'suit', trumpSuit: 'spades', doubled: true, redoubled: false }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  const p = msg.game?.playing
  check('winningBid.doubled === true', p?.winningBid?.doubled === true)
  check('winningBid.redoubled === false', p?.winningBid?.redoubled === false)
}

// ── [4] redoubled ──────────────────────────────────────────────────────────────

console.log('\n[4] playing snapshot: redoubled')
{
  const wb: ServerWinningBid = { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: true, redoubled: true }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  const p = msg.game?.playing
  check('winningBid.redoubled === true', p?.winningBid?.redoubled === true)
  check('winningBid.doubled === true', p?.winningBid?.doubled === true)
}

// ── [5] declarer seat ──────────────────────────────────────────────────────────

console.log('\n[5] playing snapshot: declarer seat')
{
  const wb: ServerWinningBid = { seat: 'left', contract: 'suit', trumpSuit: 'diamonds', doubled: false, redoubled: false }
  const msg = createRoomSnapshotMessage(makeRoom(makeState('playing', wb)), null)
  check('winningBid.seat === left', msg.game?.playing?.winningBid?.seat === 'left')
}

// ── [6] scoring фаза запазва winningBid ────────────────────────────────────────

console.log('\n[6] scoring snapshot: winningBid се запазва')
{
  const wb: NonNullable<ServerWinningBid> = { seat: 'top', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false }
  const state = makeState('scoring', wb, {
    playing: null,
    scoring: {
      winningBid: wb,
      rawHandPoints: { teamA: 0, teamB: 0 },
      rawHandTricksWon: { teamA: 0, teamB: 0 },
      declarationPoints: { teamA: 0, teamB: 0 },
      belotePoints: { teamA: 0, teamB: 0 },
      sumPoints: { teamA: 0, teamB: 0 },
      officialRoundPoints: { teamA: 0, teamB: 0 },
      matchTotals: { teamA: 0, teamB: 0 },
      carryOver: { teamA: 0, teamB: 0 },
      isCapotRound: false,
      isNonCapotRound: false,
      outcomeLabel: '',
      outcomeShortLabel: '',
      counterMultiplier: 1,
    },
  })
  const msg = createRoomSnapshotMessage(makeRoom(state), null)
  check('scoring.winningBid.contract === suit', msg.game?.scoring?.winningBid?.contract === 'suit')
  check('scoring.winningBid.seat === top', msg.game?.scoring?.winningBid?.seat === 'top')
  check('playing snapshot е null за scoring фаза', msg.game?.playing === null)
}

// ── [7] null winningBid при passed round guard ─────────────────────────────────

console.log('\n[7] playing snapshot с null winningBid')
{
  const state = makeState('playing', null)
  const msg = createRoomSnapshotMessage(makeRoom(state), null)
  check('winningBid === null при null winningBid', msg.game?.playing?.winningBid === null)
}

// ── [8] bidding фаза → playing е null ─────────────────────────────────────────

console.log('\n[8] bidding фаза → playing snapshot е null')
{
  const state = makeState('bidding', null, {
    playing: null,
    bidding: {
      ...createEmptyBiddingState(),
      hasStarted: true,
      currentSeat: 'bottom',
    },
  })
  const room = makeRoom(state)
  room.game.phase = 'bidding'
  const msg = createRoomSnapshotMessage(room, null)
  check('playing е null при bidding фаза', msg.game?.playing == null)
}

// ── Summary ────────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}

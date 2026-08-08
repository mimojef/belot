/**
 * checkShouldKeepRoomAlive.ts — Unit check за shouldKeepRoomAlive TTL логиката.
 *
 * Верифицира поведението след добавяне на MATCH_ENDED_ROOM_TTL_MS:
 *
 * [1]  finished room + connected player + age < TTL → keep alive
 * [2]  finished room + connected player + age > TTL → cleanup (bug fix)
 * [3]  finished room + disconnected player + age < TTL + within reconnect grace → keep alive
 * [4]  finished room + disconnected player + age > TTL → cleanup
 * [5]  active phase (playing) + connected player → keep alive
 * [6]  active phase (playing) + disconnected player → grace period applies, not TTL
 * [7]  bootstrap phase + no players → cleanup
 * [8]  null matchEnded + age > TTL (fallback to phaseEnteredAt) → cleanup
 *
 * Верифицира поведението след изнасяне на TTL проверката ПРЕДИ isGuestTrial
 * early return-а (production bug: finished guest trial room с все още
 * isConnected=true/zombie socket оставаше жива безкрайно, заобикаляйки TTL):
 *
 * [9]  guest trial + finished + connected + age < TTL → keep alive
 * [10] guest trial + finished + connected + age >= TTL → cleanup (production bug fix)
 */

import { shouldKeepRoomAlive } from '../src/core/serverGameRuntimeHelpers.js'
import type { ServerRoom, ServerRoomGameSnapshot, ServerSeatMap, RoomSeatSlot } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

const MATCH_ENDED_ROOM_TTL_MS = 180_000
const RECONNECT_GRACE_MS = 30_000

function makeSeats(connectedHuman: boolean): ServerSeatMap<RoomSeatSlot> {
  const now = Date.now()
  return {
    bottom: {
      seat: 'bottom',
      team: 'A',
      participant: {
        kind: 'human',
        playerId: 'p1',
        connectionId: connectedHuman ? 'conn-1' : null,
        isConnected: connectedHuman,
        joinedAt: now - 60_000,
        lastSeenAt: now - 5_000,
        reconnectToken: 'tok',
        identity: {
          accountId: null, profileId: 'prof1', username: 'cooksasha', displayName: 'cooksasha',
          avatarUrl: null, level: 1, rankTitle: null, skillRating: null, gender: null,
        },
      },
    },
    right: { seat: 'right', team: 'B', participant: null },
    top: { seat: 'top', team: 'A', participant: null },
    left: { seat: 'left', team: 'B', participant: null },
  }
}

function makeEmptySeats(): ServerSeatMap<RoomSeatSlot> {
  return {
    bottom: { seat: 'bottom', team: 'A', participant: null },
    right: { seat: 'right', team: 'B', participant: null },
    top: { seat: 'top', team: 'A', participant: null },
    left: { seat: 'left', team: 'B', participant: null },
  }
}

function makeFinishedAuthState(matchEndedAtOffset: number): ServerAuthoritativeGameState {
  const now = Date.now()
  const endedAt = now - matchEndedAtOffset
  return {
    phase: 'match-ended',
    phaseEnteredAt: endedAt,
    targetScore: 151,
    players: {} as ServerAuthoritativeGameState['players'],
    round: {} as ServerAuthoritativeGameState['round'],
    deck: [],
    hands: { bottom: [], right: [], top: [], left: [] },
    bidding: {} as ServerAuthoritativeGameState['bidding'],
    declarations: [],
    matchDeclarationMissionCounts: {} as ServerAuthoritativeGameState['matchDeclarationMissionCounts'],
    matchDeclarationMissionCountsBySeat: {},
    currentTrick: {} as ServerAuthoritativeGameState['currentTrick'],
    wonTricks: { A: [], B: [] },
    playing: null,
    scoring: null,
    matchEnded: {
      winnerTeam: 'A',
      targetScore: 151,
      finalScore: { teamA: 151, teamB: 80 },
      endedAt,
    },
    score: {
      round: {} as ServerAuthoritativeGameState['score']['round'],
      match: { teamA: 151, teamB: 80 },
      carryOver: { teamA: 0, teamB: 0 },
    },
    timer: { expiresAt: null },
  }
}

function makeFinishedAuthStateNullMatchEnded(phaseEnteredAtOffset: number): ServerAuthoritativeGameState {
  const now = Date.now()
  const enteredAt = now - phaseEnteredAtOffset
  return {
    ...makeFinishedAuthState(phaseEnteredAtOffset),
    phaseEnteredAt: enteredAt,
    matchEnded: null,
  }
}

function makeActiveAuthState(): ServerAuthoritativeGameState {
  return {
    ...makeFinishedAuthState(0),
    phase: 'playing',
    phaseEnteredAt: Date.now() - 30_000,
    matchEnded: null,
  }
}

function makeRoom(overrides: {
  phase: ServerRoom['game']['phase']
  status: ServerRoom['status']
  authoritativeState: ServerRoom['game']['authoritativeState']
  seats: ServerSeatMap<RoomSeatSlot>
}): ServerRoom {
  const now = Date.now()
  const game: ServerRoomGameSnapshot = {
    phase: overrides.phase,
    stateVersion: 1,
    startedAt: now - 600_000,
    updatedAt: now,
    activeTimerId: null,
    timerDeadlineAt: null,
    authoritativeState: overrides.authoritativeState,
  }
  return {
    id: 'test-room',
    status: overrides.status,
    createdAt: now - 600_000,
    updatedAt: now,
    hostPlayerId: 'p1',
    config: {
      maxPlayers: 4,
      allowBots: true,
      isPrivate: false,
      joinCode: null,
      targetScore: 151,
      turnTimeMs: 20_000,
      reconnectGraceMs: RECONNECT_GRACE_MS,
    },
    seats: overrides.seats,
    game,
    replayVotes: [],
    leaveVotes: [],
  }
}

// [1] finished + connected + age < TTL → keep alive
const now1 = Date.now()
const room1 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(60_000), // 60s old, TTL=180s
  seats: makeSeats(true),
})
check('[1] finished + connected + age < TTL → keep alive', shouldKeepRoomAlive(room1, now1) === true)

// [2] finished + connected + age > TTL → cleanup
const now2 = Date.now()
const room2 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(MATCH_ENDED_ROOM_TTL_MS + 1_000), // 181s old
  seats: makeSeats(true),
})
check('[2] finished + connected + age > TTL → cleanup', shouldKeepRoomAlive(room2, now2) === false)

// [3] finished + disconnected + age < TTL + within reconnect grace → keep alive
const now3 = Date.now()
const room3 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(10_000), // 10s old, well within TTL
  seats: makeSeats(false), // disconnected, lastSeenAt = now - 5s, grace = 30s → deadline = now+25s
})
check('[3] finished + disconnected + age < TTL + within grace → keep alive', shouldKeepRoomAlive(room3, now3) === true)

// [4] finished + disconnected + age > TTL → cleanup (TTL wins)
const now4 = Date.now()
const room4 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(MATCH_ENDED_ROOM_TTL_MS + 5_000), // 185s old
  seats: makeSeats(false),
})
check('[4] finished + disconnected + age > TTL → cleanup', shouldKeepRoomAlive(room4, now4) === false)

// [5] active phase (playing) + connected → keep alive
const now5 = Date.now()
const room5 = makeRoom({
  phase: 'playing',
  status: 'playing',
  authoritativeState: makeActiveAuthState(),
  seats: makeSeats(true),
})
check('[5] active phase (playing) + connected → keep alive', shouldKeepRoomAlive(room5, now5) === true)

// [6] active phase (playing) + disconnected → grace period, not TTL
const now6 = Date.now()
const room6 = makeRoom({
  phase: 'playing',
  status: 'playing',
  authoritativeState: makeActiveAuthState(),
  seats: makeSeats(false), // lastSeenAt = now-5s, grace=30s → deadline = now+25s
})
check('[6] active phase (playing) + disconnected + within grace → keep alive', shouldKeepRoomAlive(room6, now6) === true)

// [7] bootstrap/null phase + no players → cleanup
const now7 = Date.now()
const room7 = makeRoom({
  phase: null,
  status: 'waiting',
  authoritativeState: null,
  seats: makeEmptySeats(),
})
check('[7] null phase + no players → cleanup', shouldKeepRoomAlive(room7, now7) === false)

// [8] null matchEnded (fallback to phaseEnteredAt) + age > TTL → cleanup
const now8 = Date.now()
const room8 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthStateNullMatchEnded(MATCH_ENDED_ROOM_TTL_MS + 2_000), // 182s, phaseEnteredAt used
  seats: makeSeats(true),
})
check('[8] null matchEnded fallback to phaseEnteredAt + age > TTL → cleanup', shouldKeepRoomAlive(room8, now8) === false)

// [9] guest trial + finished + connected + age < TTL → keep alive
const now9 = Date.now()
const baseRoom9 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(60_000), // 60s old, TTL=180s
  seats: makeSeats(true),
})
const room9: ServerRoom = { ...baseRoom9, config: { ...baseRoom9.config, isGuestTrial: true } }
check('[9] guest trial + finished + connected + age < TTL → keep alive', shouldKeepRoomAlive(room9, now9) === true)

// [10] guest trial + finished + connected + age >= TTL → cleanup (production bug fix:
// isGuestTrial early return used to bypass this TTL check entirely for a still-"connected"
// zombie socket, leaving the room alive indefinitely)
const now10 = Date.now()
const baseRoom10 = makeRoom({
  phase: 'finished',
  status: 'finished',
  authoritativeState: makeFinishedAuthState(MATCH_ENDED_ROOM_TTL_MS + 1_000), // 181s old
  seats: makeSeats(true),
})
const room10: ServerRoom = { ...baseRoom10, config: { ...baseRoom10.config, isGuestTrial: true } }
check(
  '[10] guest trial + finished + connected + age >= TTL → cleanup (production bug fix)',
  shouldKeepRoomAlive(room10, now10) === false,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

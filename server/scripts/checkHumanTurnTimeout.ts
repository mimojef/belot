/**
 * checkHumanTurnTimeout.ts
 *
 * Regression за "Време за реакция" (human turn timeout преди поемане от бот):
 *  [1] стандарт = 15000ms за cutting/bidding/playing; bot delay 800ms,
 *      sweepOffer 15000ms, summary 5000ms, trick collection delay непроменени.
 *  [2] create_private_room parser: липсващо поле -> 15000, whitelist
 *      5000/10000/15000 се приема, всичко друго отхвърля съобщението.
 *  [3] privateRoomsStore.createRoom: невалидна стойност не минава.
 *  [4] Реален game loop (createServerRoom -> initialize -> advance) за
 *      случайна маса (без override) и частна маса с 5/10/15s: всяка фаза
 *      (cutting, bidding, playing) използва избраната продължителност,
 *      ботът поема точно при deadline-а (не 1ms по-рано), след поемане ходът
 *      на бота е 800ms, "Върни се" дава пълен нов период.
 *  [5] Tamper/legacy: невалиден или липсващ state.humanTurnTimeoutMs ->
 *      стандартът; persistence JSON roundtrip + normalizeRestored... пазят
 *      override-а и не пипат вече записания expiresAt.
 *  [6] Snapshot: humanTurnTimeoutMs/serverNow в participant и spectator
 *      snapshot-а; timerDeadlineAt = authoritative expiresAt.
 *  [7] Replay (authoritativeState=null -> initialize) запазва override-а.
 */

import { createServerRoom } from '../src/core/createServerRoom.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { getRoomAuthoritativeGameState } from '../src/game/getRoomAuthoritativeGameState.js'
import { resumeHumanControlForRoom } from '../src/game/resumeHumanControlForRoom.js'
import { normalizeRestoredAuthoritativeState } from '../src/game/normalizeRestoredAuthoritativeState.js'
import { rebaseServerStateToEventAt } from '../src/game/rebaseServerStateToEventAt.js'
import { syncRoomWithAuthoritativeState } from '../src/game/syncRoomWithAuthoritativeState.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { SERVER_TIMING_CONFIG } from '../src/game/serverTimingConfig.js'
import {
  createServerBiddingTimerState,
  createServerCuttingTimerState,
  createServerPlayingTimerState,
  resolveServerHumanTurnTimeoutMs,
} from '../src/game/serverTimerStateHelpers.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createPrivateRoomsStore } from '../src/game/privateRoomsStore.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import {
  createRoomSnapshotMessage,
  createSpectatorRoomSnapshotMessage,
} from '../src/protocol/createRoomSnapshotMessage.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
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

console.log('\n═══ checkHumanTurnTimeout ═══')

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const BOT_DELAY_MS = 800

function humanParticipant(seat: Seat): any {
  return {
    kind: 'human',
    playerId: `player-${seat}`,
    connectionId: `conn-${seat}`,
    isConnected: true,
    joinedAt: 1,
    lastSeenAt: 1,
    reconnectToken: `token-${seat}`,
    permanentlyLeftAt: null,
    identity: {
      accountId: null,
      profileId: `profile-${seat}`,
      username: null,
      displayName: `Player ${seat}`,
      avatarUrl: null,
      level: 3,
      rankTitle: null,
      skillRating: null,
      gender: 'male',
    },
  }
}

function createStartedRoom(humanTurnTimeoutMs?: number, isPrivate = humanTurnTimeoutMs !== undefined): ServerRoom {
  const room = createServerRoom({
    config: {
      isPrivate,
      isPrivateTableOrigin: isPrivate,
      ...(humanTurnTimeoutMs !== undefined ? { humanTurnTimeoutMs } : {}),
    },
  })
  const seats = { ...room.seats }
  for (const seat of SEATS) {
    seats[seat] = { ...seats[seat], participant: humanParticipant(seat) }
  }
  return initializeRoomAuthoritativeGameState({ ...room, seats })
}

function stateOf(room: ServerRoom): ServerAuthoritativeGameState {
  const state = getRoomAuthoritativeGameState(room)
  assert(state !== null, 'authoritative state missing')
  return state!
}

function activeHumanTimer(state: ServerAuthoritativeGameState): { seat: Seat; durationMs: number } | null {
  const seat = state.timer.activeSeat
  if (seat === null || state.timer.durationMs === null) return null
  const player = state.players[seat]
  if (player.mode === 'bot' || player.controlledByBot) return null
  return { seat, durationMs: state.timer.durationMs }
}

// Стъпва game loop-а напред на 50ms, докато predicate не стане true.
function advanceUntil(
  room: ServerRoom,
  startNow: number,
  predicate: (state: ServerAuthoritativeGameState) => boolean,
  label: string,
): { room: ServerRoom; now: number } {
  let now = startNow
  let current = room
  for (let i = 0; i < 20_000; i += 1) {
    if (predicate(stateOf(current))) return { room: current, now }
    now += 50
    current = advanceRoomAuthoritativeGame(current, now, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  }
  throw new Error(`advanceUntil timed out: ${label} (phase=${stateOf(current).phase})`)
}

// Стига до човешки ход в bidding без поемания (цепенето се изпълнява от
// реалния bot picker за cutter-а чрез изтичане само ако е нужно).
function advanceUntilHumanBiddingTurn(room: ServerRoom): ServerRoom {
  let current = room
  let now = Date.now()
  for (let i = 0; i < 20_000; i += 1) {
    const s = stateOf(current)
    if (s.phase === 'bidding' && activeHumanTimer(s) !== null) {
      // Върни всички под човешки контрол (цепещият е поет при изтичането).
      for (const seat of SEATS) {
        if (stateOf(current).players[seat].controlledByBot) {
          const resumed = resumeHumanControlForRoom(current, seat)
          if (resumed.ok) current = resumed.room
        }
      }
      return current
    }
    now += 50
    current = advanceRoomAuthoritativeGame(current, now, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  }
  throw new Error('could not reach a human bidding turn')
}

// Проверява: human timer = expectedMs, ботът НЕ поема 1ms преди deadline-а,
// поема точно при него и следващият таймер на същия seat (ако е негов) е 800ms.
function expectHumanTimeoutAndTakeover(
  room: ServerRoom,
  expectedMs: number,
  phaseLabel: string,
): ServerRoom {
  const state = stateOf(room)
  const human = activeHumanTimer(state)
  assert(human !== null, `${phaseLabel}: expected an active human timer`)
  assert(human!.durationMs === expectedMs, `${phaseLabel}: expected ${expectedMs}ms, got ${human!.durationMs}`)
  assert(
    state.timer.expiresAt === (state.timer.startedAt ?? NaN) + expectedMs,
    `${phaseLabel}: expiresAt must equal startedAt + ${expectedMs}`,
  )
  assert(room.game.timerDeadlineAt === state.timer.expiresAt, `${phaseLabel}: room deadline != authoritative expiresAt`)

  const deadline = state.timer.expiresAt!
  const beforeDeadline = advanceRoomAuthoritativeGame(room, deadline - 1, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  assert(
    stateOf(beforeDeadline).players[human!.seat].controlledByBot === false,
    `${phaseLabel}: bot took over before the deadline`,
  )
  const atDeadline = advanceRoomAuthoritativeGame(room, deadline, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  assert(
    stateOf(atDeadline).players[human!.seat].controlledByBot === true,
    `${phaseLabel}: bot did not take over at the deadline`,
  )
  return atDeadline
}

await check('[1] standard timeouts are 15s; bot/sweep/summary/trick delays unchanged', () => {
  assert(SERVER_TIMING_CONFIG.cutHumanTimeoutMs === 15000, 'cut')
  assert(SERVER_TIMING_CONFIG.bidHumanTimeoutMs === 15000, 'bid')
  assert(SERVER_TIMING_CONFIG.playHumanTimeoutMs === 15000, 'play')
  assert(SERVER_TIMING_CONFIG.cutBotDelayMs === 800, 'cut bot')
  assert(SERVER_TIMING_CONFIG.bidBotDelayMs === 800, 'bid bot')
  assert(SERVER_TIMING_CONFIG.playBotDelayMs === 800, 'play bot')
  assert(SERVER_TIMING_CONFIG.sweepOfferHumanTimeoutMs === 15000, 'sweep offer')
  assert(SERVER_TIMING_CONFIG.summaryVisibleMs === 5000, 'summary')
  assert(SERVER_TIMING_CONFIG.playAfterTrickCollectionDelayMs === 1325, 'trick collection delay')
})

await check('[2] create_private_room parser whitelist', () => {
  const base = { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 15 }
  const parse = (extra: Record<string, unknown>) => parseClientMessage(JSON.stringify({ ...base, ...extra })) as any
  assert(parse({})?.humanTurnTimeoutMs === 15000, 'missing field must default to 15000')
  for (const value of [5000, 10000, 15000]) {
    assert(parse({ humanTurnTimeoutMs: value })?.humanTurnTimeoutMs === value, `whitelisted ${value} rejected`)
  }
  for (const value of [20000, 7000, 0, -5000, 1e9, '5000', null, true, 5000.5]) {
    assert(parse({ humanTurnTimeoutMs: value }) === null, `invalid ${JSON.stringify(value)} must reject the message`)
  }
})

await check('[3] privateRoomsStore stores only whitelisted values', () => {
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => {},
    onRoomReady: () => {},
    onRoomExpired: () => {},
    onRoomClosed: () => {},
    onMemberLeft: () => {},
    onMemberKicked: () => {},
  })
  const create = (connectionId: string, humanTurnTimeoutMs: any) =>
    store.createRoom({
      connectionId,
      profileId: `profile-${connectionId}`,
      displayName: connectionId,
      avatarUrl: null,
      level: 1,
      rankTitle: null,
      stake: 5000,
      isLocked: false,
      waitMinutes: 5,
      manualStart: false,
      humanTurnTimeoutMs,
    })
  const results = [
    create('c1', 5000),
    create('c2', 10000),
    create('c3', undefined),
    create('c4', 20000),
  ]
  const values = results.map((r) => (r.ok ? r.room.humanTurnTimeoutMs : null))
  assert(JSON.stringify(values) === JSON.stringify([5000, 10000, 15000, 15000]), `got ${JSON.stringify(values)}`)
  for (const r of results) if (r.ok) store.leaveRoom?.(`c${results.indexOf(r) + 1}`)
})

const SCENARIOS: Array<{ label: string; override: number | undefined; expectedMs: number }> = [
  { label: 'random table (no override)', override: undefined, expectedMs: 15000 },
  { label: 'private 5s', override: 5000, expectedMs: 5000 },
  { label: 'private 10s', override: 10000, expectedMs: 10000 },
  { label: 'private 15s', override: 15000, expectedMs: 15000 },
]

for (const scenario of SCENARIOS) {
  await check(`[4] ${scenario.label}: cutting/bidding/playing = ${scenario.expectedMs}ms, takeover at deadline, bot 800ms, resume full`, () => {
    let room = createStartedRoom(scenario.override)
    let now = Date.now()

    // Cutting.
    ;({ room, now } = advanceUntil(room, now, (s) => s.phase === 'cutting' && activeHumanTimer(s) !== null, 'cutting'))
    const cutterSeat = stateOf(room).timer.activeSeat!
    room = expectHumanTimeoutAndTakeover(room, scenario.expectedMs, 'cutting')
    now = stateOf(room).timer.startedAt ?? now

    // Bidding — първият human bidder.
    ;({ room, now } = advanceUntil(room, now, (s) => s.phase === 'bidding' && activeHumanTimer(s) !== null, 'bidding'))
    const bidderSeat = stateOf(room).timer.activeSeat!
    room = expectHumanTimeoutAndTakeover(room, scenario.expectedMs, 'bidding')

    // След поемане ботът играе с 800ms, когато пак е на ход (задължителна
    // проверка — поетите seat-ове неизбежно идват на ход до края на ръката).
    const takenOverSeats = new Set<Seat>([cutterSeat, bidderSeat])
    const bidderRoom = room
    const botTurn = advanceUntil(
      room,
      stateOf(room).timer.startedAt ?? now,
      (s) => s.timer.activeSeat !== null && takenOverSeats.has(s.timer.activeSeat) && s.timer.durationMs !== null,
      'bot seat turn',
    )
    const botTimer = stateOf(botTurn.room).timer
    assert(
      stateOf(botTurn.room).players[botTimer.activeSeat!].controlledByBot === true,
      'taken-over seat lost bot control',
    )
    assert(botTimer.durationMs === BOT_DELAY_MS, `bot-controlled seat timer should be ${BOT_DELAY_MS}ms, got ${botTimer.durationMs}`)
    room = bidderRoom

    // Playing — ако всички вече са поети, "Върни се" за текущия seat.
    ;({ room, now } = advanceUntil(
      room,
      now,
      (s) => s.phase === 'playing' && s.playing?.hasStarted === true && s.playing.currentTurnSeat !== null,
      'playing',
    ))
    let playState = stateOf(room)
    const playSeat = playState.playing!.currentTurnSeat!
    if (playState.players[playSeat].controlledByBot) {
      const resumed = resumeHumanControlForRoom(room, playSeat)
      assert(resumed.ok, 'resumeHumanControl failed')
      room = (resumed as { ok: true; room: ServerRoom }).room
      playState = stateOf(room)
    }
    // Resume / нормален ход: пълен период според конфигурацията на масата.
    expectHumanTimeoutAndTakeover(room, scenario.expectedMs, 'playing')

    // Snapshot носи същата продължителност.
    const snapshot = createRoomSnapshotMessage(room, 'bottom')
    assert(snapshot.game?.humanTurnTimeoutMs === scenario.expectedMs, `snapshot humanTurnTimeoutMs=${snapshot.game?.humanTurnTimeoutMs}`)
    assert(snapshot.game?.timerDeadlineAt === playState.timer.expiresAt, 'snapshot deadline != expiresAt')
  })
}

await check('[5] tamper/legacy state falls back to the standard; JSON roundtrip keeps override and expiresAt', () => {
  const room = createStartedRoom(5000)
  const state = stateOf(room)
  for (const bogus of [20000, 1, -1, 7000, '5000', undefined, null]) {
    const tampered = { ...state, humanTurnTimeoutMs: bogus as any }
    assert(
      resolveServerHumanTurnTimeoutMs(tampered, 15000) === 15000,
      `bogus ${JSON.stringify(bogus)} must fall back to 15000`,
    )
    const seat: Seat = 'bottom'
    assert(createServerCuttingTimerState(tampered, seat).durationMs === 15000, 'cut tamper')
    assert(createServerBiddingTimerState(tampered, seat).durationMs === 15000, 'bid tamper')
    assert(createServerPlayingTimerState(tampered, seat).durationMs === 15000, 'play tamper')
  }

  // Legacy persisted state без полето.
  const legacy = { ...state } as any
  delete legacy.humanTurnTimeoutMs
  assert(createServerPlayingTimerState(legacy, 'bottom').durationMs === 15000, 'legacy state must use 15000')

  // Persistence roundtrip (activeRoomSnapshotStore записва целия room JSON).
  const restored = JSON.parse(JSON.stringify(room)) as ServerRoom
  const restoredState = normalizeRestoredAuthoritativeState(stateOf(restored))
  assert(restoredState.humanTurnTimeoutMs === 5000, 'override lost after persistence roundtrip')
  assert(restored.config.humanTurnTimeoutMs === 5000, 'config override lost after roundtrip')
  assert(restoredState.timer.expiresAt === state.timer.expiresAt, 'restore must not rewrite expiresAt')

  // Вече записан legacy 20s deadline не се пренаписва със задна дата.
  const legacyTimerRoom = {
    ...room,
    game: {
      ...room.game,
      timerDeadlineAt: (state.timer.startedAt ?? 0) + 20000,
      authoritativeState: {
        ...legacy,
        timer: { ...state.timer, durationMs: 20000, expiresAt: (state.timer.startedAt ?? 0) + 20000 },
      },
    },
  } as ServerRoom
  const legacySnapshot = createRoomSnapshotMessage(legacyTimerRoom, 'bottom')
  assert(legacySnapshot.game?.timerDeadlineAt === (state.timer.startedAt ?? 0) + 20000, 'legacy deadline must stay')
  assert(legacySnapshot.game?.humanTurnTimeoutMs === 15000, 'legacy room should report the new standard')
})

await check('[6] participant + spectator snapshots carry humanTurnTimeoutMs and serverNow', () => {
  const room = createStartedRoom(10000)
  const before = Date.now()
  const participant = createRoomSnapshotMessage(room, 'bottom')
  const spectator = createSpectatorRoomSnapshotMessage(room)
  const after = Date.now()
  assert(participant.game?.humanTurnTimeoutMs === 10000, 'participant humanTurnTimeoutMs')
  assert(spectator.game?.humanTurnTimeoutMs === 10000, 'spectator humanTurnTimeoutMs')
  for (const serverNow of [participant.game?.serverNow, spectator.game?.serverNow]) {
    assert(typeof serverNow === 'number' && serverNow >= before && serverNow <= after, `serverNow out of range: ${serverNow}`)
  }
  const publicRoom = createStartedRoom(undefined)
  assert(createRoomSnapshotMessage(publicRoom, 'bottom').game?.humanTurnTimeoutMs === 15000, 'public snapshot must be 15000')
})

await check('[7] replay re-initialization keeps the private override', () => {
  const room = createStartedRoom(5000)
  const reset = { ...room, game: { ...room.game, authoritativeState: null } } as ServerRoom
  const restarted = initializeRoomAuthoritativeGameState(reset)
  assert(stateOf(restarted).humanTurnTimeoutMs === 5000, 'override lost on replay')
  const publicRoom = createStartedRoom(undefined)
  assert(stateOf(publicRoom).humanTurnTimeoutMs === null, 'public room must not store an override')
})

await check('[8] deploy transition: legacy persisted 20s turn survives restart, next turns are 15s', () => {
  // Pre-deploy snapshot: без humanTurnTimeoutMs (state + config), turnTimeMs 20000,
  // текущ човешки ход с 20s таймер, стартиран преди 5s.
  const now = Date.now()
  const live = createStartedRoom(undefined)
  const advanced = advanceUntilHumanBiddingTurn(live)
  const state = stateOf(advanced) as any
  delete state.humanTurnTimeoutMs
  const startedAt = now - 5000
  const legacyRoom = {
    ...advanced,
    config: { ...advanced.config, turnTimeMs: 20000 } as any,
    game: {
      ...advanced.game,
      timerDeadlineAt: startedAt + 20000,
      authoritativeState: { ...state, timer: { ...state.timer, startedAt, durationMs: 20000, expiresAt: startedAt + 20000 } },
    },
  } as ServerRoom
  delete (legacyRoom.config as any).humanTurnTimeoutMs

  // Рестарт: JSON от SQLite -> normalize -> rebase към "сега" (същото като
  // prepareRestoredRoomForServerStart в index.ts).
  const restored = JSON.parse(JSON.stringify(legacyRoom)) as ServerRoom
  const restoredState = rebaseServerStateToEventAt(normalizeRestoredAuthoritativeState(stateOf(restored)), now)
  assert(restoredState.timer.durationMs === 20000, 'in-flight legacy turn keeps its persisted 20s duration')
  assert(restoredState.timer.expiresAt === now + 20000, 'restart rebases the in-flight turn from "now" (pre-existing behaviour)')
  const restoredRoom = syncRoomWithAuthoritativeState(restored, restoredState, now)
  const snapshot = createRoomSnapshotMessage(restoredRoom, 'bottom')
  assert(snapshot.game?.humanTurnTimeoutMs === 15000, `legacy room reports ${snapshot.game?.humanTurnTimeoutMs}`)
  assert(snapshot.game?.timerDeadlineAt === now + 20000, 'deadline not rewritten to 15s')

  // Изтичане -> поемане от бот; следващият ЧОВЕШКИ ход вече е 15s.
  const seat = restoredState.timer.activeSeat as Seat
  const afterExpiry = advanceRoomAuthoritativeGame(restoredRoom, now + 20000, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  assert(stateOf(afterExpiry).players[seat].controlledByBot === true, 'bot did not take over at the legacy deadline')
  const nextHuman = stateOf(afterExpiry)
  const nextHumanTimer = activeHumanTimer(nextHuman)
  assert(nextHumanTimer !== null, 'expected the next seat to be a human turn')
  assert(nextHumanTimer!.durationMs === 15000, `next human turn after deploy is ${nextHumanTimer!.durationMs}ms`)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)

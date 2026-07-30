import assert from 'node:assert/strict'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { abandonHumanControlForRoom } from '../src/game/abandonHumanControlForRoom.js'
import { countServerRoomsByPhase } from '../src/core/countServerRoomsByPhase.js'
import {
  computeActiveRoomSnapshot,
  computeActiveRoomsSnapshot,
  isStaleActiveRoom,
  STALE_ACTIVE_ROOM_THRESHOLD_MS,
} from '../src/core/computeActiveRoomsSnapshot.js'

let passCount = 0
let failCount = 0

function pass(label: string): void {
  passCount += 1
  console.log(`  PASS ${label}`)
}

function fail(label: string, error: unknown): void {
  failCount += 1
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`  FAIL ${label}: ${msg}`)
}

function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (error: unknown) {
    fail(label, error)
  }
}

// ─── Room builders ──────────────────────────────────────────────────────────

function buildRoomWithHumansAndBots(
  id: string,
  humanCount: number,
  botCount: number,
): ServerRoom {
  assert.ok(humanCount + botCount <= 4 && humanCount + botCount >= 1)

  assert.ok(humanCount >= 1, 'builder always seats one human host first; use takeover helpers for 0-human rooms')

  const created = createRoomWithHumanHost({
    roomId: id,
    connectionId: `conn-${id}-host`,
    identity: { displayName: 'Host' },
  })
  let room: ServerRoom = created.room
  const remainingHumans = humanCount - 1
  const remainingBots = botCount

  for (let i = 0; i < remainingHumans; i += 1) {
    const result = addHumanToRoom(room, {
      connectionId: `conn-${id}-${i + 2}`,
      identity: { displayName: `Player ${i + 2}` },
    })
    room = result.room
  }

  for (let i = 0; i < remainingBots; i += 1) {
    const result = addBotToRoom(room, {
      difficulty: 'normal',
      behaviorPreset: 'balanced',
      identity: { displayName: `Bot ${i + 1}` },
    })
    room = result.room
  }

  room = initializeRoomAuthoritativeGameState(room)
  return room
}

function withDisconnectedFirstHumanSeat(room: ServerRoom): ServerRoom {
  const seatEntry = Object.values(room.seats).find(
    (slot) => slot.participant?.kind === 'human',
  )
  if (!seatEntry || seatEntry.participant?.kind !== 'human') {
    throw new Error('No human seat found to disconnect.')
  }
  return {
    ...room,
    seats: {
      ...room.seats,
      [seatEntry.seat]: {
        ...seatEntry,
        participant: {
          ...seatEntry.participant,
          isConnected: false,
          connectionId: null,
        },
      },
    },
  }
}

function withBotTakeoverFirstHumanSeat(room: ServerRoom): ServerRoom {
  const seatEntry = Object.values(room.seats).find(
    (slot) => slot.participant?.kind === 'human',
  )
  if (!seatEntry) throw new Error('No human seat found for takeover.')
  const disconnected = withDisconnectedFirstHumanSeat(room)
  const result = abandonHumanControlForRoom(disconnected, seatEntry.seat)
  if (!result.ok) throw new Error(`abandonHumanControlForRoom failed: ${result.message}`)
  return result.room
}

const noWorker = () => null

// ─── [1] Броене: 4 човека, 0 бота ───────────────────────────────────────────

check('[1] 4 свързани човека, 0 бота', () => {
  const room = buildRoomWithHumansAndBots('room-4h0b', 4, 0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 4)
  assert.equal(snap.bots, 0)
  assert.equal(snap.disconnectedHumans, 0)
  assert.equal(snap.occupiedSeats, 4)
})

// ─── [2] 2 човека, 2 бота ────────────────────────────────────────────────────

check('[2] 2 свързани човека, 2 бота', () => {
  const room = buildRoomWithHumansAndBots('room-2h2b', 2, 2)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 2)
  assert.equal(snap.bots, 2)
  assert.equal(snap.disconnectedHumans, 0)
  assert.equal(snap.occupiedSeats, 4)
})

// ─── [3] 1 човек, 3 бота ─────────────────────────────────────────────────────

check('[3] 1 свързан човек, 3 бота', () => {
  const room = buildRoomWithHumansAndBots('room-1h3b', 1, 3)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 1)
  assert.equal(snap.bots, 3)
  assert.equal(snap.disconnectedHumans, 0)
})

// ─── [4] 0 човека, 4 бота ────────────────────────────────────────────────────

check('[4] 0 човека, 4 бота (host мястото поето от бот чрез takeover)', () => {
  const room0 = buildRoomWithHumansAndBots('room-0h4b', 1, 3)
  const room = withBotTakeoverFirstHumanSeat(room0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 0)
  assert.equal(snap.bots, 4)
  assert.equal(snap.disconnectedHumans, 0)
})

// ─── [5] Прекъснал играч преди takeover ─────────────────────────────────────

check('[5] прекъснал играч (grace период, още не е takeover)', () => {
  const room0 = buildRoomWithHumansAndBots('room-disc', 2, 2)
  const room = withDisconnectedFirstHumanSeat(room0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 1)
  assert.equal(snap.disconnectedHumans, 1)
  assert.equal(snap.bots, 2)
  assert.equal(snap.occupiedSeats, 4)
})

// ─── [6] Играч след окончателен bot takeover ────────────────────────────────

check('[6] играч след окончателен bot takeover (controlledByBot=true)', () => {
  const room0 = buildRoomWithHumansAndBots('room-takeover', 2, 2)
  const room = withBotTakeoverFirstHumanSeat(room0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.connectedHumans, 1)
  assert.equal(snap.disconnectedHumans, 0)
  assert.equal(snap.bots, 3)
})

// ─── [7] Преобразуване на фазите ────────────────────────────────────────────

check('[7] фазата идва от authoritativeState.phase (fine-grained)', () => {
  const room = buildRoomWithHumansAndBots('room-phase', 4, 0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const authoritativeState = room.game.authoritativeState
  assert.ok(authoritativeState !== null && !('kind' in authoritativeState))
  assert.equal(snap.phase, (authoritativeState as { phase: string }).phase)
})

// ─── [8] Worker ID ───────────────────────────────────────────────────────────

check('[8] worker ID идва от getWorkerIdForRoom callback', () => {
  const room = buildRoomWithHumansAndBots('room-worker', 4, 0)
  const snap = computeActiveRoomSnapshot(room, (roomId) =>
    roomId === 'room-worker' ? 'game-worker-3' : null,
  )
  assert.equal(snap.workerId, 'game-worker-3')
})

check('[8b] worker ID е null, ако стаята не е assigned', () => {
  const room = buildRoomWithHumansAndBots('room-no-worker', 4, 0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.workerId, null)
})

// ─── [9] Подреждане ──────────────────────────────────────────────────────────

check('[9] подреждане: стаи с хора преди стаи само с ботове, после по активност, после по roomId', () => {
  const roomA = withBotTakeoverFirstHumanSeat(buildRoomWithHumansAndBots('room-aaa', 1, 3))
  const roomB = buildRoomWithHumansAndBots('room-bbb', 2, 2)
  const roomC = buildRoomWithHumansAndBots('room-ccc', 1, 3)
  const roomD = withBotTakeoverFirstHumanSeat(buildRoomWithHumansAndBots('room-ddd', 1, 3))

  const now = Date.now()
  const withUpdatedAt = (room: ServerRoom, updatedAt: number): ServerRoom => ({
    ...room,
    updatedAt,
  })

  const rooms: Record<string, ServerRoom> = {
    'room-aaa': withUpdatedAt(roomA, now - 1000),
    'room-bbb': withUpdatedAt(roomB, now - 5000),
    'room-ccc': withUpdatedAt(roomC, now - 2000),
    'room-ddd': withUpdatedAt(roomD, now - 500),
  }

  const snapshots = computeActiveRoomsSnapshot(rooms, noWorker)
  const order = snapshots.map((s) => s.roomId)

  // Стаи с хора (bbb, ccc) преди стаи само с ботове (aaa, ddd).
  // Сред тези с хора: по-скорошна активност първо → ccc (-2000) преди bbb (-5000).
  // Сред тези само с ботове: ddd (-500) преди aaa (-1000).
  assert.deepEqual(order, ['room-ccc', 'room-bbb', 'room-ddd', 'room-aaa'])
})

check('[9b] подреждане: равенство по активност → по roomId', () => {
  const roomA = buildRoomWithHumansAndBots('room-zzz', 1, 3)
  const roomB = buildRoomWithHumansAndBots('room-yyy', 1, 3)
  const now = Date.now()
  const rooms: Record<string, ServerRoom> = {
    'room-zzz': { ...roomA, updatedAt: now },
    'room-yyy': { ...roomB, updatedAt: now },
  }
  const snapshots = computeActiveRoomsSnapshot(rooms, noWorker)
  assert.deepEqual(snapshots.map((s) => s.roomId), ['room-yyy', 'room-zzz'])
})

// ─── [10] Празно състояние ───────────────────────────────────────────────────

check('[10] празен rooms обект → празен списък', () => {
  const snapshots = computeActiveRoomsSnapshot({}, noWorker)
  assert.deepEqual(snapshots, [])
})

// ─── [11] Брой редове съвпада с activeRooms, сумата на фазите съвпада ──────

check('[11] брой редове == Object.keys(rooms).length; сумата по фаза == общо', () => {
  const rooms: Record<string, ServerRoom> = {
    'room-1': buildRoomWithHumansAndBots('room-1', 4, 0),
    'room-2': buildRoomWithHumansAndBots('room-2', 2, 2),
    'room-3': withBotTakeoverFirstHumanSeat(buildRoomWithHumansAndBots('room-3', 1, 3)),
  }
  const activeRoomsCount = Object.keys(rooms).length
  const snapshots = computeActiveRoomsSnapshot(rooms, noWorker)
  const phaseCounts = countServerRoomsByPhase(rooms)
  const phaseSum = Object.values(phaseCounts).reduce((s, n) => s + n, 0)

  assert.equal(snapshots.length, activeRoomsCount)
  assert.equal(phaseSum, activeRoomsCount)
})

// ─── [12] Room ID — snapshot съдържа ПЪЛНИЯ room.id, не съкратен ──────────────

check('[12] snapshot.roomId е пълният room.id (не съкратен)', () => {
  const room = buildRoomWithHumansAndBots('room-full-id-check-1234567890', 4, 0)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  assert.equal(snap.roomId, room.id)
  assert.equal(snap.roomId, 'room-full-id-check-1234567890')
  assert.ok(snap.roomId.length > 8, 'roomId в snapshot-а не трябва да е предварително съкратен')
})

check('[12b] roomId в snapshot-а е реален randomUUID, когато не е зададен явно', () => {
  const created = createRoomWithHumanHost({ connectionId: 'conn-uuid-check' })
  const room = initializeRoomAuthoritativeGameState(created.room)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  assert.ok(uuidPattern.test(snap.roomId), `roomId "${snap.roomId}" не изглежда като пълен UUID`)
})

// ─── [13] Подозрително стари стаи ────────────────────────────────────────────

check('[13] стая само с ботове ПОД прага → не е маркирана като стара', () => {
  const room = withBotTakeoverFirstHumanSeat(buildRoomWithHumansAndBots('room-fresh-bots', 1, 3))
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const now = snap.lastActivityAt + (STALE_ACTIVE_ROOM_THRESHOLD_MS - 1000)
  assert.equal(snap.connectedHumans, 0)
  assert.equal(isStaleActiveRoom(snap, now), false)
})

check('[13b] стая само с ботове НАД прага → маркирана е като стара', () => {
  const room = withBotTakeoverFirstHumanSeat(buildRoomWithHumansAndBots('room-stale-bots', 1, 3))
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const now = snap.lastActivityAt + STALE_ACTIVE_ROOM_THRESHOLD_MS + 1000
  assert.equal(snap.connectedHumans, 0)
  assert.equal(isStaleActiveRoom(snap, now), true)
})

check('[13c] стая със свързан човек НАД прага по активност → НЕ е маркирана като стара', () => {
  const room = buildRoomWithHumansAndBots('room-human-old-activity', 1, 3)
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const now = snap.lastActivityAt + STALE_ACTIVE_ROOM_THRESHOLD_MS + 1000
  assert.equal(snap.connectedHumans, 1)
  assert.equal(isStaleActiveRoom(snap, now), false)
})

check('[13d] стая с прекъснал (не окончателно takeover) човек НАД прага → НЕ е маркирана като стара', () => {
  const room = withDisconnectedFirstHumanSeat(buildRoomWithHumansAndBots('room-disc-old-activity', 1, 3))
  const snap = computeActiveRoomSnapshot(room, noWorker)
  const now = snap.lastActivityAt + STALE_ACTIVE_ROOM_THRESHOLD_MS + 1000
  assert.equal(snap.connectedHumans, 0)
  assert.equal(snap.disconnectedHumans, 1)
  // botsOnlyRoom изисква connectedHumans===0 И disconnectedHumans===0 — прекъснал човек не е "само ботове".
  assert.equal(isStaleActiveRoom(snap, now), false)
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exit(1)

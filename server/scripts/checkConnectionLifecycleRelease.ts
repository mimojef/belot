/**
 * checkConnectionLifecycleRelease.ts
 *
 * Синтетичен (без сървър, без мрежа, без база) тест на
 * core/releaseClosedConnection.ts — финалната стъпка на WebSocket 'close'
 * handler-а в index.ts.
 *
 * Production дефект: serverState.connections пазеше по един запис за ВСЯКА
 * WS връзка от старта на процеса (disconnect само сменяше status на
 * 'disconnected'; removeServerConnection не се викаше никъде). На 04.11
 * това бяха >22 000 записа, а GET /api/friends обхождаше всички за всеки
 * приятел (O(F × C)) и всяко обновяване на връзка копираше целия обект.
 *
 * Проверява:
 *  [1] 10 000 последователни connect/close -> 0 записа накрая, максимум 1
 *      по всяко време (старото поведение: 10 000 записа).
 *  [2] Много едновременни връзки + затваряне в разбъркан ред -> само
 *      затворените изчезват, отворените остават непроменени.
 *  [3] Close по време на игра: участникът става disconnected
 *      (connectionId: null, isConnected: false), стаята се връща за
 *      snapshot/commit, записът изчезва — както handleDisconnect досега.
 *  [4] Reconnect по reconnectToken след close: новата връзка се закача
 *      за същото място, без нужда от стария запис.
 *  [5] Закъснял close на СТАРА връзка след displacement + reconnect с НОВА:
 *      новата връзка, участникът и стаята остават непокътнати.
 *  [6] Повторен close (вече освободен запис) -> released:false, същият
 *      state обект, без exception.
 *  [7] Displaced, но още незатворен socket остава в state като
 *      'disconnected' (stale-connection guard-ът разчита на това) до
 *      реалния close.
 *  [8] Benchmark: размер, heap и цена на едно обновяване след 10 000
 *      цикъла — старо (само handleDisconnect) срещу ново поведение.
 */

import { attachConnectionToRoomSeat } from '../src/core/attachConnectionToRoomSeat.js'
import { createInitialServerState } from '../src/core/createInitialServerState.js'
import { createServerConnection } from '../src/core/createServerConnection.js'
import { getConnectionById } from '../src/core/getConnectionById.js'
import { handleCreateRoom } from '../src/core/handleCreateRoom.js'
import { handleDisconnect } from '../src/core/handleDisconnect.js'
import { handleJoinRoom } from '../src/core/handleJoinRoom.js'
import { markHumanParticipantReconnected } from '../src/core/markHumanParticipantReconnected.js'
import { releaseClosedConnection } from '../src/core/releaseClosedConnection.js'
import type { ConnectionId, ServerState } from '../src/core/serverTypes.js'
import { updateHumanParticipantInRoom } from '../src/core/updateHumanParticipantInRoom.js'
import { updateServerConnectionInState } from '../src/core/updateServerConnectionInState.js'
import { updateServerRoomInState } from '../src/core/updateServerRoomInState.js'
import { upsertServerConnection } from '../src/core/upsertServerConnection.js'

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function connectionCount(state: ServerState): number {
  return Object.keys(state.connections).length
}

function connect(state: ServerState, profileId: string | null = null): { state: ServerState; id: ConnectionId } {
  const connection = createServerConnection({ profileId, playerId: profileId, userAgent: 'synthetic-test' })
  return { state: upsertServerConnection(state, connection), id: connection.id }
}

// Index.ts пътят при reconnect по reconnectToken (tryResumeRoomForConnection):
// участникът се маркира reconnected с НОВИЯ connectionId, а новата връзка
// се закача за мястото. Старият connectionId не участва.
function reconnectToSeat(state: ServerState, roomId: string, seat: 'bottom' | 'right' | 'top' | 'left', newConnectionId: ConnectionId): ServerState {
  const room = state.rooms[roomId]!
  const participant = room.seats[seat].participant
  if (participant === null || participant.kind !== 'human') throw new Error('expected human participant')
  const nextRoom = updateHumanParticipantInRoom(room, seat, markHumanParticipantReconnected(participant, newConnectionId))
  let next = updateServerRoomInState(state, roomId, nextRoom)
  const attached = attachConnectionToRoomSeat(getConnectionById(next, newConnectionId)!, newConnectionId, nextRoom, seat)
  next = updateServerConnectionInState(next, newConnectionId, attached)
  return next
}

console.log('\ncheckConnectionLifecycleRelease')

check('[1] 10 000 последователни connect/close -> 0 записа, никога повече от 1', () => {
  let state = createInitialServerState()
  let maxSeen = 0
  for (let i = 0; i < 10_000; i += 1) {
    const opened = connect(state, i % 3 === 0 ? null : `profile-${i % 500}`)
    state = opened.state
    maxSeen = Math.max(maxSeen, connectionCount(state))
    const released = releaseClosedConnection(state, opened.id)
    assert(released.released, `cycle ${i}: очаквах released:true`)
    state = released.serverState
  }
  assert(connectionCount(state) === 0, `очаквах 0 записа, има ${connectionCount(state)}`)
  assert(maxSeen === 1, `очаквах максимум 1 едновременен запис, видях ${maxSeen}`)
})

check('[2] Едновременни връзки, затваряне в разбъркан ред -> само затворените изчезват', () => {
  let state = createInitialServerState()
  const ids: ConnectionId[] = []
  for (let i = 0; i < 200; i += 1) {
    const opened = connect(state, `profile-${i}`)
    state = opened.state
    ids.push(opened.id)
  }
  const toClose = ids.filter((_, index) => index % 2 === 1).reverse()
  const keep = ids.filter((_, index) => index % 2 === 0)
  const keptBefore = new Map(keep.map((id) => [id, state.connections[id]]))
  for (const id of toClose) state = releaseClosedConnection(state, id).serverState
  assert(connectionCount(state) === keep.length, `очаквах ${keep.length} записа, има ${connectionCount(state)}`)
  for (const id of keep) {
    assert(state.connections[id] === keptBefore.get(id), `отворената връзка ${id} е променена`)
    assert(state.connections[id]!.status === 'connected', `отворената връзка ${id} не е connected`)
  }
  for (const id of toClose) assert(!(id in state.connections), `затворената ${id} още е в state`)
})

// Обща подготовка: стая с двама човешки играчи.
function setupRoom() {
  let state = createInitialServerState()
  const host = connect(state, 'profile-host')
  state = host.state
  const created = handleCreateRoom(state, host.id, 'Host')
  state = created.serverState
  const guest = connect(state, 'profile-guest')
  state = guest.state
  const joined = handleJoinRoom(state, guest.id, created.room.id, 'Guest')
  state = joined.serverState
  return { state, roomId: created.room.id, hostId: host.id, hostSeat: created.seat, guestId: guest.id, guestSeat: joined.seat }
}

check('[3] Close по време на игра: участникът disconnected, стаята върната, записът изчезва', () => {
  const setup = setupRoom()
  const oldBehavior = handleDisconnect(setup.state, setup.guestId)
  const released = releaseClosedConnection(setup.state, setup.guestId)
  assert(released.released, 'очаквах released:true')
  assert(released.room !== null, 'очаквах стаята да бъде върната')
  const participant = released.serverState.rooms[setup.roomId]!.seats[setup.guestSeat].participant
  assert(participant !== null && participant.kind === 'human', 'участникът изчезна')
  assert(participant.connectionId === null && participant.isConnected === false, 'участникът не е маркиран disconnected')
  assert(!(setup.guestId in released.serverState.connections), 'записът на затворената връзка остана')
  assert(released.serverState.connections[setup.hostId] === setup.state.connections[setup.hostId], 'host връзката е променена')
  // Същото състояние на стаята като старото поведение (само handleDisconnect);
  // lastSeenAt/updatedAt са Date.now() и се нормализират.
  const normalizeRoom = (room: unknown) => JSON.stringify(room, (key, value) => (key === 'lastSeenAt' || key === 'updatedAt' ? 0 : value))
  assert(
    normalizeRoom(released.serverState.rooms[setup.roomId]) === normalizeRoom(oldBehavior.serverState.rooms[setup.roomId]),
    'стаята се различава от старото поведение',
  )
})

check('[4] Reconnect по reconnectToken след close: нова връзка на същото място', () => {
  const setup = setupRoom()
  let state = releaseClosedConnection(setup.state, setup.guestId).serverState
  const fresh = connect(state, 'profile-guest')
  state = reconnectToSeat(fresh.state, setup.roomId, setup.guestSeat, fresh.id)
  const participant = state.rooms[setup.roomId]!.seats[setup.guestSeat].participant!
  assert(participant.kind === 'human' && participant.connectionId === fresh.id && participant.isConnected, 'участникът не е закачен за новата връзка')
  const conn = state.connections[fresh.id]!
  assert(conn.status === 'connected' && conn.currentRoomId === setup.roomId && conn.currentSeat === setup.guestSeat, 'новата връзка не е закачена за мястото')
  assert(!(setup.guestId in state.connections), 'старият запис се върна')
})

check('[5] Закъснял close на стара връзка след displacement + reconnect не засяга новата', () => {
  const setup = setupRoom()
  // displaceProfileConnections: handleDisconnect веднага, socket-ът още затваря.
  let state = handleDisconnect(setup.state, setup.guestId).serverState
  assert(state.connections[setup.guestId]!.status === 'disconnected', 'displaced записът трябва да остане disconnected до close')
  const fresh = connect(state, 'profile-guest')
  state = reconnectToSeat(fresh.state, setup.roomId, setup.guestSeat, fresh.id)
  const roomBefore = state.rooms[setup.roomId]
  const freshBefore = state.connections[fresh.id]
  // Закъснелият 'close' на стария socket пристига СЕГА.
  const released = releaseClosedConnection(state, setup.guestId)
  assert(released.released, 'очаквах released:true за стария запис')
  assert(released.room === null, 'старата връзка не трябва да намира стая (участникът сочи новата)')
  assert(released.serverState.rooms[setup.roomId] === roomBefore, 'стаята е променена от закъснелия close')
  assert(released.serverState.connections[fresh.id] === freshBefore, 'новата връзка е променена от закъснелия close')
  assert(!(setup.guestId in released.serverState.connections), 'старият запис остана')
})

check('[6] Повторен close -> released:false, същият state, без exception', () => {
  const setup = setupRoom()
  const first = releaseClosedConnection(setup.state, setup.guestId)
  const second = releaseClosedConnection(first.serverState, setup.guestId)
  assert(second.released === false && second.room === null && second.connection === null, 'очаквах released:false')
  assert(second.serverState === first.serverState, 'state обектът трябва да е непроменен')
})

check('[7] Displaced, но незатворен socket остава "disconnected" в state до close', () => {
  const setup = setupRoom()
  const displaced = handleDisconnect(setup.state, setup.hostId).serverState
  const conn = displaced.connections[setup.hostId]
  assert(conn !== undefined && conn.status === 'disconnected', 'displaced записът трябва да съществува със status disconnected')
  const closed = releaseClosedConnection(displaced, setup.hostId).serverState
  assert(!(setup.hostId in closed.connections), 'след close записът трябва да изчезне')
})

// ─── [8] Benchmark: старо срещу ново поведение ─────────────────────────────
function heapMb(): number {
  globalThis.gc?.()
  return process.memoryUsage().heapUsed / 1048576
}

function runCycles(release: (state: ServerState, id: ConnectionId) => ServerState, cycles: number) {
  const heapBeforeMb = heapMb()
  let state = createInitialServerState()
  const startedAt = performance.now()
  for (let i = 0; i < cycles; i += 1) {
    const opened = connect(state, `profile-${i % 500}`)
    state = release(opened.state, opened.id)
  }
  const cyclesMs = performance.now() - startedAt
  // Цена на ЕДНО обновяване (heartbeat при всяко WS съобщение) за жива връзка.
  const live = connect(state, 'profile-live')
  state = live.state
  const updateStartedAt = performance.now()
  for (let i = 0; i < 20; i += 1) {
    state = updateServerConnectionInState(state, live.id, { ...state.connections[live.id]!, lastSeenAt: Date.now() })
  }
  const updateMs = (performance.now() - updateStartedAt) / 20
  // Памет, задържана от state-а: heap след GC с жив state минус heap след GC
  // преди циклите.
  const entries = connectionCount(state)
  const retainedMb = heapMb() - heapBeforeMb
  return { entries, cyclesMs, updateMs, retainedMb, keepAlive: state }
}

check('[8] Benchmark 10 000 цикъла: старо (само handleDisconnect) срещу ново (releaseClosedConnection)', () => {
  const oldRun = runCycles((state, id) => handleDisconnect(state, id).serverState, 10_000)
  oldRun.keepAlive = createInitialServerState() // освобождава стария state преди новото мерене
  const newRun = runCycles((state, id) => releaseClosedConnection(state, id).serverState, 10_000)
  const gcNote = globalThis.gc ? '' : ' (без --expose-gc паметта е приблизителна)'
  console.log(`        старо: записи=${oldRun.entries} цикли=${oldRun.cyclesMs.toFixed(0)}ms 1 обновяване=${oldRun.updateMs.toFixed(2)}ms задържана памет≈${oldRun.retainedMb.toFixed(2)}MB${gcNote}`)
  console.log(`        ново : записи=${newRun.entries} цикли=${newRun.cyclesMs.toFixed(0)}ms 1 обновяване=${newRun.updateMs.toFixed(3)}ms задържана памет≈${newRun.retainedMb.toFixed(2)}MB${gcNote}`)
  const oldEntries = oldRun.entries
  assert(oldEntries === 10_001, `старото поведение трябваше да натрупа 10 001 записа, има ${oldEntries}`)
  assert(newRun.entries === 1, `новото поведение трябва да остави само живата връзка, има ${newRun.entries}`)
  assert(newRun.updateMs < oldRun.updateMs, 'обновяването не стана по-евтино')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

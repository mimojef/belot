import assert from 'node:assert/strict'
import { createInitialServerState } from '../src/core/createInitialServerState.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import type { ServerGamePhase, ServerRoom } from '../src/core/serverTypes.js'
import { upsertServerRoom } from '../src/core/upsertServerRoom.js'
import { countServerRoomsByPhase } from '../src/core/countServerRoomsByPhase.js'
import { broadcastRoomSnapshots } from '../src/core/broadcastRoomSnapshots.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { applyAcceptedGameWorkerCandidate } from '../src/game/applyAcceptedGameWorkerCandidate.js'
import { createRoomRevisionRegistry } from '../src/game/createRoomRevisionRegistry.js'
import type { WebSocket } from 'ws'

const phases: ServerGamePhase[] = [
  'cutting',
  'cut-resolve',
  'deal-first-3',
  'deal-next-2',
  'bidding',
  'deal-last-3',
  'playing',
  'scoring',
]

const roomId = 'candidate-apply-regression'
const revisionRegistry = createRoomRevisionRegistry()
revisionRegistry.ensure(roomId)

let canonicalState = upsertServerRoom(
  createInitialServerState(),
  createServerRoom({ roomId }),
)
let persistedRoom: ServerRoom | null = null
let broadcastRoom: ServerRoom | null = null

for (const phase of phases) {
  const currentRoom = canonicalState.rooms[roomId]!
  const candidate: ServerRoom = {
    ...currentRoom,
    status: 'playing',
    game: {
      ...currentRoom.game,
      phase,
      stateVersion: currentRoom.game.stateVersion + 1,
    },
  }
  const baseRevision = revisionRegistry.get(roomId)!
  const order: string[] = []

  const result = applyAcceptedGameWorkerCandidate({
    serverState: canonicalState,
    roomId,
    baseRevision,
    candidate,
    revisionRegistry,
    commitCanonicalRoom: (room) => {
      canonicalState = upsertServerRoom(canonicalState, room)
      order.push('commit')
    },
    persist: (room) => {
      assert.equal(canonicalState.rooms[roomId]?.game.phase, phase)
      persistedRoom = structuredClone(room)
      order.push('persist')
    },
    broadcast: (room) => {
      assert.equal(canonicalState.rooms[roomId]?.game.phase, phase)
      assert.equal(persistedRoom?.game.phase, phase)
      assert.equal(revisionRegistry.get(roomId), baseRevision + 1)
      broadcastRoom = structuredClone(room)
      order.push('broadcast')
    },
    onApplied: () => {
      order.push('completion')
    },
  })

  assert.equal(result.kind, 'applied')
  assert.equal(canonicalState.rooms[roomId]?.game.phase, phase)
  assert.equal(persistedRoom?.game.phase, phase)
  assert.equal(broadcastRoom?.game.phase, phase)
  assert.equal(revisionRegistry.get(roomId), baseRevision + 1)
  assert.deepEqual(order, ['commit', 'persist', 'broadcast', 'completion'])
  assert.deepEqual(countServerRoomsByPhase(canonicalState.rooms), { [phase]: 1 })
}

const acceptedState = canonicalState
const acceptedRevision = revisionRegistry.get(roomId)!
const staleCandidate = {
  ...acceptedState.rooms[roomId]!,
  game: { ...acceptedState.rooms[roomId]!.game, phase: 'playing' as const },
}
let staleEffectCount = 0
const staleResult = applyAcceptedGameWorkerCandidate({
  serverState: acceptedState,
  roomId,
  baseRevision: acceptedRevision - 1,
  candidate: staleCandidate,
  revisionRegistry,
  commitCanonicalRoom: () => { staleEffectCount += 1 },
  persist: () => { staleEffectCount += 1 },
  broadcast: () => { staleEffectCount += 1 },
  onApplied: () => { staleEffectCount += 1 },
})
assert.equal(staleResult.kind, 'stale')
assert.equal(staleEffectCount, 0)
assert.equal(canonicalState, acceptedState)
assert.equal(revisionRegistry.get(roomId), acceptedRevision)

let invalidEffectCount = 0
const invalidResult = applyAcceptedGameWorkerCandidate({
  serverState: acceptedState,
  roomId,
  baseRevision: acceptedRevision,
  candidate: { ...staleCandidate, id: 'different-room' },
  revisionRegistry,
  commitCanonicalRoom: () => { invalidEffectCount += 1 },
  persist: () => { invalidEffectCount += 1 },
  broadcast: () => { invalidEffectCount += 1 },
  onApplied: () => { invalidEffectCount += 1 },
})
assert.equal(invalidResult.kind, 'invalid')
assert.equal(invalidEffectCount, 0)

const failedCandidate = {
  ...acceptedState.rooms[roomId]!,
  game: { ...acceptedState.rooms[roomId]!.game, phase: 'playing' as const },
}
let failureBroadcasts = 0
let failureCompletions = 0
canonicalState = {
  ...canonicalState,
  connections: {
    ...canonicalState.connections,
    preserved: {
      id: 'preserved',
    } as never,
  },
}
const stateBeforeFailure = canonicalState
const failureResult = applyAcceptedGameWorkerCandidate({
  serverState: acceptedState,
  roomId,
  baseRevision: acceptedRevision,
  candidate: failedCandidate,
  revisionRegistry,
  commitCanonicalRoom: (room) => {
    canonicalState = upsertServerRoom(canonicalState, room)
  },
  persist: () => {
    canonicalState = {
      ...canonicalState,
      connections: {
        ...canonicalState.connections,
        reentrant: { id: 'reentrant' } as never,
      },
    }
    throw new Error('injected persistence failure')
  },
  broadcast: () => { failureBroadcasts += 1 },
  onApplied: () => { failureCompletions += 1 },
})
assert.equal(failureResult.kind, 'persist_failed')
assert.equal(canonicalState.rooms[roomId], stateBeforeFailure.rooms[roomId])
assert.ok(canonicalState.connections.preserved)
assert.ok(canonicalState.connections.reentrant)
assert.equal(revisionRegistry.get(roomId), acceptedRevision)
assert.equal(failureBroadcasts, 0)
assert.equal(failureCompletions, 0)

const roomsWithoutCandidate = { ...canonicalState.rooms }
delete roomsWithoutCandidate[roomId]
assert.deepEqual(countServerRoomsByPhase(roomsWithoutCandidate), {})

const { room: hostRoom } = createRoomWithHumanHost({
  roomId: 'broadcast-regression',
  connectionId: 'throwing-connection',
  identity: { displayName: 'Throwing' },
})
const { room: twoHumanRoom } = addHumanToRoom(hostRoom, {
  connectionId: 'closed-connection',
  identity: { displayName: 'Closed' },
})
const { room: broadcastCandidate } = addHumanToRoom(twoHumanRoom, {
  connectionId: 'open-connection',
  identity: { displayName: 'Open' },
})
const broadcastRevisionRegistry = createRoomRevisionRegistry()
broadcastRevisionRegistry.ensure(broadcastCandidate.id)
let broadcastCanonical = upsertServerRoom(createInitialServerState(), hostRoom)
let broadcastPersisted: ServerRoom | null = null
let completionCount = 0
let closedSendCount = 0
const openMessages: string[] = []
const socketRegistry = new Map<string, WebSocket>([
  ['throwing-connection', {
    readyState: 1,
    send: () => { throw new Error('injected socket failure') },
  } as unknown as WebSocket],
  ['closed-connection', {
    readyState: 3,
    send: () => { closedSendCount += 1 },
  } as unknown as WebSocket],
  ['open-connection', {
    readyState: 1,
    send: (message: string) => { openMessages.push(message) },
  } as unknown as WebSocket],
])
const originalConsoleError = console.error
console.error = () => {}
let broadcastApplyResult
try {
  broadcastApplyResult = applyAcceptedGameWorkerCandidate({
    serverState: broadcastCanonical,
    roomId: broadcastCandidate.id,
    baseRevision: 0,
    candidate: broadcastCandidate,
    revisionRegistry: broadcastRevisionRegistry,
    commitCanonicalRoom: (room) => {
      broadcastCanonical = upsertServerRoom(broadcastCanonical, room)
    },
    persist: (room) => { broadcastPersisted = structuredClone(room) },
    broadcast: (room) => { broadcastRoomSnapshots(room, socketRegistry) },
    onApplied: () => { completionCount += 1 },
  })
} finally {
  console.error = originalConsoleError
}
assert.equal(broadcastApplyResult?.kind, 'applied')
assert.equal(broadcastCanonical.rooms[broadcastCandidate.id], broadcastCandidate)
assert.equal(broadcastPersisted?.id, broadcastCandidate.id)
assert.equal(broadcastRevisionRegistry.get(broadcastCandidate.id), 1)
assert.equal(completionCount, 1)
assert.equal(closedSendCount, 0)
assert.equal(openMessages.length, 1)
assert.equal(JSON.parse(openMessages[0]!).roomId, broadcastCandidate.id)

console.log('Game worker candidate apply regression checks passed.')

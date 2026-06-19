import type { ServerRoom, ServerState } from '../core/serverTypes.js'
import type { RoomRevisionRegistry } from './createRoomRevisionRegistry.js'

export type ApplyAcceptedGameWorkerCandidateResult =
  | { kind: 'applied'; revision: number }
  | { kind: 'stale' }
  | { kind: 'missing' }
  | { kind: 'invalid'; message: string }
  | { kind: 'persist_failed'; error: unknown }

type ApplyAcceptedGameWorkerCandidateInput = {
  serverState: ServerState
  roomId: string
  baseRevision: number
  candidate: ServerRoom
  revisionRegistry: RoomRevisionRegistry
  commitCanonicalRoom: (room: ServerRoom) => void
  persist: (room: ServerRoom) => void
  broadcast: (room: ServerRoom) => void
  onApplied: (currentRoom: ServerRoom, candidate: ServerRoom) => void
}

export function applyAcceptedGameWorkerCandidate(
  input: ApplyAcceptedGameWorkerCandidateInput,
): ApplyAcceptedGameWorkerCandidateResult {
  const {
    serverState,
    roomId,
    baseRevision,
    candidate,
    revisionRegistry,
    commitCanonicalRoom,
    persist,
    broadcast,
    onApplied,
  } = input

  if (candidate.id !== roomId) {
    return {
      kind: 'invalid',
      message: `Candidate room id mismatch room=${roomId} candidate=${candidate.id}`,
    }
  }

  const currentRoom = serverState.rooms[roomId]
  if (currentRoom === undefined) {
    return { kind: 'missing' }
  }

  if (revisionRegistry.get(roomId) !== baseRevision) {
    return { kind: 'stale' }
  }

  if (baseRevision >= Number.MAX_SAFE_INTEGER) {
    return {
      kind: 'invalid',
      message: `Room revision overflow room=${roomId} revision=${baseRevision}`,
    }
  }

  commitCanonicalRoom(candidate)

  try {
    persist(candidate)
  } catch (error) {
    commitCanonicalRoom(currentRoom)
    return { kind: 'persist_failed', error }
  }

  const revision = revisionRegistry.bump(roomId)
  broadcast(candidate)
  onApplied(currentRoom, candidate)

  return { kind: 'applied', revision }
}

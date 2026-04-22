import type { ServerRoom } from '../core/serverTypes.js'
import {
  createServerGameRuntime,
  type ServerGameRuntime,
} from '../core/serverGameRuntimeHelpers.js'

export function ensureRoomGameRuntime(
  roomGameRuntimeRegistry: Map<string, ServerGameRuntime>,
  room: ServerRoom,
): void {
  const existingRuntime = roomGameRuntimeRegistry.get(room.id) ?? null

  if (existingRuntime !== null) {
    return
  }

  const runtime = createServerGameRuntime(room)

  roomGameRuntimeRegistry.set(room.id, runtime)

  console.log(
    `[game-runtime] created room=${room.id} phase=${room.game.phase ?? 'bootstrap'}`,
  )
}

export function removeRoomGameRuntime(
  roomGameRuntimeRegistry: Map<string, ServerGameRuntime>,
  roomId: string,
): void {
  const hadRuntime = roomGameRuntimeRegistry.delete(roomId)

  if (hadRuntime) {
    console.log(`[game-runtime] removed room=${roomId}`)
  }
}

export function getGameRuntimeCountsByPhase(
  roomGameRuntimeRegistry: Map<string, ServerGameRuntime>,
): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const runtime of roomGameRuntimeRegistry.values()) {
    counts[runtime.phase] = (counts[runtime.phase] ?? 0) + 1
  }

  return counts
}
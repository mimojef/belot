import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerGameRuntime } from '../core/serverGameRuntimeHelpers.js'
import type {
  ActiveRoomRuntime,
  ActiveRoomRuntimeHealth,
} from './activeRoomRuntime.js'
import {
  ensureRoomGameRuntime,
  getGameRuntimeCountsByPhase,
  removeRoomGameRuntime,
} from './roomGameRuntimeRegistry.js'

export function createInProcessActiveRoomRuntime(
  roomGameRuntimeRegistry: Map<string, ServerGameRuntime>,
): ActiveRoomRuntime {
  return {
    ensureRoom(room: ServerRoom): void {
      ensureRoomGameRuntime(roomGameRuntimeRegistry, room)
    },

    removeRoom(roomId: string): void {
      removeRoomGameRuntime(roomGameRuntimeRegistry, roomId)
    },

    hasRoom(roomId: string): boolean {
      return roomGameRuntimeRegistry.has(roomId)
    },

    getHealth(): ActiveRoomRuntimeHealth {
      return {
        activeRooms: roomGameRuntimeRegistry.size,
        roomsByPhase: getGameRuntimeCountsByPhase(roomGameRuntimeRegistry),
      }
    },
  }
}

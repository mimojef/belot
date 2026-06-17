import type { ServerRoom } from '../core/serverTypes.js'
import type { ServerGameRuntime } from '../core/serverGameRuntimeHelpers.js'
import type {
  ActiveRoomRuntime,
  ActiveRoomRuntimeHealth,
  EnsureRoomResult,
  RuntimeRoomTickResult,
  TickRoomsResult,
} from './activeRoomRuntime.js'
import { abandonHumanControlForRoom } from './abandonHumanControlForRoom.js'
import { advanceRoomAuthoritativeGame } from './advanceRoomAuthoritativeGame.js'
import { resumeHumanControlForRoom } from './resumeHumanControlForRoom.js'
import { submitHumanBidActionForRoom } from './submitHumanBidActionForRoom.js'
import { submitHumanCutIndexForRoom } from './submitHumanCutIndexForRoom.js'
import { submitHumanPlayCardForRoom } from './submitHumanPlayCardForRoom.js'
import {
  ensureRoomGameRuntime,
  getGameRuntimeCountsByPhase,
  removeRoomGameRuntime,
} from './roomGameRuntimeRegistry.js'

export function createInProcessActiveRoomRuntime(
  roomGameRuntimeRegistry: Map<string, ServerGameRuntime>,
): ActiveRoomRuntime {
  return {
    ensureRoom(room: ServerRoom): EnsureRoomResult {
      ensureRoomGameRuntime(
        roomGameRuntimeRegistry,
        room,
      )

      return {
        ok: true,
      }
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

    listTrackedRoomIds(): string[] {
      return Array.from(roomGameRuntimeRegistry.keys())
    },

    tickRooms(input): TickRoomsResult {
      const results: RuntimeRoomTickResult[] = []

      for (const room of input.rooms) {
        const nextRoom = advanceRoomAuthoritativeGame(room, input.now)

        const runtime = roomGameRuntimeRegistry.get(room.id) ?? null

        if (runtime !== null) {
          roomGameRuntimeRegistry.set(room.id, {
            ...runtime,
            phase: nextRoom.game.phase ?? runtime.phase,
            updatedAt: input.now,
            tickCount: runtime.tickCount + 1,
          })
        }

        if (nextRoom === room) {
          results.push({ kind: 'unchanged', roomId: room.id })
        } else {
          results.push({ kind: 'advanced', roomId: room.id, room: nextRoom })
        }
      }

      return { results }
    },

    submitBid(input) {
      return submitHumanBidActionForRoom(
        input.room,
        input.seat,
        input.action,
      )
    },

    submitCut(input) {
      return submitHumanCutIndexForRoom(
        input.room,
        input.seat,
        input.cutIndex,
      )
    },

    submitPlay(input) {
      return submitHumanPlayCardForRoom(
        input.room,
        input.seat,
        input.cardId,
        input.declarationKeys,
      )
    },

    resumeHumanControl(input) {
      return resumeHumanControlForRoom(input.room, input.seat)
    },

    abandonHumanControl(input) {
      return abandonHumanControlForRoom(input.room, input.seat)
    },
  }
}

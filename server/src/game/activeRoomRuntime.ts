import type { ServerRoom } from '../core/serverTypes.js'

export type ActiveRoomRuntimeHealth = {
  activeRooms: number
  roomsByPhase: Record<string, number>
}

export interface ActiveRoomRuntime {
  ensureRoom(room: ServerRoom): void
  removeRoom(roomId: string): void
  hasRoom(roomId: string): boolean
  getHealth(): ActiveRoomRuntimeHealth
}

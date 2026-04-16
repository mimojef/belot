import type { ServerRoom } from './serverTypes.js'
import { getRoomParticipantCount } from './getRoomParticipantCount.js'

export function isRoomFull(room: ServerRoom): boolean {
  return getRoomParticipantCount(room) >= room.config.maxPlayers
}
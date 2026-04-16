import type {
  ConnectionId,
  HumanRoomParticipant,
} from './serverTypes.js'

export function markHumanParticipantReconnected(
  participant: HumanRoomParticipant,
  connectionId: ConnectionId,
): HumanRoomParticipant {
  return {
    ...participant,
    connectionId,
    isConnected: true,
    lastSeenAt: Date.now(),
  }
}
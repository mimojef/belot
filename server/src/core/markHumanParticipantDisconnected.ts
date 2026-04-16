import type {
  ConnectionId,
  HumanRoomParticipant,
} from './serverTypes.js'

export function markHumanParticipantDisconnected(
  participant: HumanRoomParticipant,
  connectionId: ConnectionId,
): HumanRoomParticipant {
  if (participant.connectionId !== connectionId) {
    throw new Error(
      `Participant connection mismatch. Expected "${participant.connectionId}", got "${connectionId}".`,
    )
  }

  return {
    ...participant,
    connectionId: null,
    isConnected: false,
    lastSeenAt: Date.now(),
  }
}
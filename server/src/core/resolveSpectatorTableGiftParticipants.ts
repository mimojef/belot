import {
  SERVER_SEAT_ORDER,
  type ConnectionId,
  type ProfileId,
  type RoomId,
  type Seat,
  type ServerConnection,
  type ServerRoom,
} from './serverTypes.js'
import { isProfileParticipantInRoom } from './evaluateBelotSpectatorWatchEligibility.js'

export type SpectatorTableGiftParticipantsResolution =
  | {
      ok: true
      room: ServerRoom
      senderProfileId: ProfileId
      senderDisplayName: string
      recipientProfileId: ProfileId
      recipientSeat: Seat
      recipientIsBot: boolean
    }
  | { ok: false; message: string }

/**
 * Server-authoritative валидация за table gift от Belot SPECTATOR (тясно
 * изключение от spectator забраната — само send_table_gift, само към
 * участник в стаята, която connection-ът реално гледа).
 *
 * PURE функция (без I/O) — watchedRoomId и публичното име се подават от
 * caller-а. Стаята идва ИЗКЛЮЧИТЕЛНО от registry-то (watchedRoomId), а
 * claimedRoomId от request body е само consistency check — spectator-ът не
 * може да насочи подарък към стая, която не гледа, нито към произволен
 * profileId (получателят трябва да седи на маса в СЪЩАТА стая — същите
 * правила като participant table gift: human или bot с реален profileId).
 */
export function resolveSpectatorTableGiftParticipants(input: {
  connection: ServerConnection | null
  connectionId: ConnectionId
  watchedRoomId: RoomId | null
  rooms: Record<string, ServerRoom>
  claimedRoomId: string
  recipientProfileId: string
  getPublicDisplayName: (profileId: ProfileId) => string | null
}): SpectatorTableGiftParticipantsResolution {
  const { connection, watchedRoomId, rooms, claimedRoomId, recipientProfileId } = input

  if (connection === null || connection.status !== 'connected' || connection.id !== input.connectionId) {
    return { ok: false, message: 'Няма активна връзка.' }
  }

  const senderProfileId = connection.profileId
  if (senderProfileId === null || senderProfileId.length === 0) {
    return { ok: false, message: 'Трябва да влезеш в профила си.' }
  }

  // Spectator никога не е закачен за игра; закачена connection минава през
  // participant resolver-а, не тук.
  if (connection.currentRoomId !== null) {
    return { ok: false, message: 'Невалидна маса.' }
  }

  if (watchedRoomId === null || watchedRoomId !== claimedRoomId) {
    return { ok: false, message: 'Невалидна маса.' }
  }

  const room = rooms[watchedRoomId] ?? null
  if (room === null) {
    return { ok: false, message: 'Масата не съществува.' }
  }

  if (room.config.isPrivateTableOrigin !== true) {
    return { ok: false, message: 'Невалидна маса.' }
  }

  if (room.status === 'finished') {
    return { ok: false, message: 'Играта вече е приключила.' }
  }

  // Инвариант: spectator и participant роли никога едновременно.
  if (isProfileParticipantInRoom(room, senderProfileId)) {
    return { ok: false, message: 'Невалидна маса.' }
  }

  const normalizedRecipientId = recipientProfileId.trim()
  if (normalizedRecipientId.length === 0) {
    return { ok: false, message: 'Липсва получател.' }
  }

  if (normalizedRecipientId === senderProfileId) {
    return { ok: false, message: 'Не можеш да си изпратиш подарък сам на себе си.' }
  }

  let recipientSeat: Seat | null = null
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat]?.participant ?? null
    if (participant !== null && participant.identity.profileId === normalizedRecipientId) {
      recipientSeat = seat
      break
    }
  }

  if (recipientSeat === null) {
    return { ok: false, message: 'Играчът не е на тази маса.' }
  }

  const recipientParticipant = room.seats[recipientSeat].participant
  if (recipientParticipant === null) {
    return { ok: false, message: 'Играчът не е на тази маса.' }
  }

  const displayName = input.getPublicDisplayName(senderProfileId)?.trim() ?? ''

  return {
    ok: true,
    room,
    senderProfileId,
    senderDisplayName: displayName.length > 0 ? displayName : 'Зрител',
    recipientProfileId: normalizedRecipientId,
    recipientSeat,
    recipientIsBot: recipientParticipant.kind === 'bot',
  }
}

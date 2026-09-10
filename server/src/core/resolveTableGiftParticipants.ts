import {
  SERVER_SEAT_ORDER,
  type ProfileId,
  type Seat,
  type ServerConnection,
  type ServerRoom,
} from './serverTypes.js'

export type TableGiftParticipantsResolution =
  | {
      ok: true
      room: ServerRoom
      senderProfileId: ProfileId
      senderSeat: Seat
      senderDisplayName: string
      recipientProfileId: ProfileId
      recipientSeat: Seat
      /** true ако получателят е bot participant (Stage 2.1) — само за
       * логване/UI детайли, не влияе на payment/validation логиката. */
      recipientIsBot: boolean
      recipientDisplayName: string
    }
  | { ok: false; message: string }

/**
 * Server-authoritative валидация кой на кого може да прати table gift.
 *
 * Извлечена като PURE функция (никакъв I/O, никакъв DB достъп, никакъв
 * WebSocket) — точно за да е unit-testable без реален сървър, виж
 * server/scripts/checkGiftItemSystem.ts.
 *
 * КЛЮЧОВО: стаята и седалката на ИЗПРАЩАЧА идват ИЗКЛЮЧИТЕЛНО от canonical
 * server connection state, никога от request body — клиентският roomId се
 * ползва само като consistency check срещу connection.currentRoomId
 * (mirror на submit_bid_action pattern-а).
 */
export function resolveTableGiftParticipants(input: {
  connection: ServerConnection | null
  rooms: Record<string, ServerRoom>
  claimedRoomId: string
  recipientProfileId: string
}): TableGiftParticipantsResolution {
  const { connection, rooms, claimedRoomId, recipientProfileId } = input

  if (connection === null || connection.status !== 'connected') {
    return { ok: false, message: 'Няма активна връзка.' }
  }

  const senderProfileId = connection.profileId

  if (senderProfileId === null || senderProfileId.length === 0) {
    return { ok: false, message: 'Трябва да влезеш в профила си.' }
  }

  if (connection.currentRoomId === null) {
    return { ok: false, message: 'Не си на маса.' }
  }

  // Client claim-ът трябва да съвпада с authoritative state — иначе е stale
  // или подправен roomId.
  if (connection.currentRoomId !== claimedRoomId) {
    return { ok: false, message: 'Невалидна маса.' }
  }

  const room = rooms[connection.currentRoomId] ?? null

  if (room === null) {
    return { ok: false, message: 'Масата не съществува.' }
  }

  if (room.status === 'finished') {
    return { ok: false, message: 'Играта вече е приключила.' }
  }

  const senderSeat = connection.currentSeat

  if (senderSeat === null) {
    return { ok: false, message: 'Не си на маса.' }
  }

  const senderParticipant = room.seats[senderSeat]?.participant ?? null

  if (
    senderParticipant === null ||
    senderParticipant.kind !== 'human' ||
    senderParticipant.identity.profileId !== senderProfileId
  ) {
    return { ok: false, message: 'Мястото ти на масата не е разпознато.' }
  }

  const normalizedRecipientId = recipientProfileId.trim()

  if (normalizedRecipientId.length === 0) {
    return { ok: false, message: 'Липсва получател.' }
  }

  if (normalizedRecipientId === senderProfileId) {
    return { ok: false, message: 'Не можеш да си изпратиш подарък сам на себе си.' }
  }

  let recipientSeat: Seat | null = null

  // И human, И bot participants се проверяват тук — bots вече са допустими
  // gift recipients (Stage 2.1), стига да имат реален profileId (виж
  // коментара по-долу). Matchmaking bots се резолват от DB-backed bot
  // roster (selectMatchmakingBotProfiles.ts → pickEligibleBotProfileFromDb.ts)
  // и получават стабилен identity.profileId, сочещ към действителен ред в
  // profiles таблицата (profile_kind='bot') — затова recipient_profile_id
  // FK-то в gift_item_transactions продължава да важи непроменено, без fake
  // profile creation и без nullable schema промяна.
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat]?.participant ?? null

    if (
      participant !== null &&
      participant.identity.profileId === normalizedRecipientId
    ) {
      recipientSeat = seat
      break
    }
  }

  if (recipientSeat === null) {
    // Покрива и: получателят не е на тази маса, ИЛИ получателят е bot БЕЗ
    // реален profileId (rare fallback — bot pool изчерпан, viж
    // createMatchedRoomFromEntries.ts createBotParticipantFromFallbackSelection).
    // Такъв bot никога не може да бъде gift target — client-side icon-ът
    // също не се показва за него (seat.profileId === null), но проверката
    // тук е authoritative defense-in-depth.
    return { ok: false, message: 'Играчът не е на тази маса.' }
  }

  const recipientParticipant = room.seats[recipientSeat].participant

  if (recipientParticipant === null) {
    return { ok: false, message: 'Играчът не е на тази маса.' }
  }

  return {
    ok: true,
    room,
    senderProfileId,
    senderSeat,
    senderDisplayName: senderParticipant.identity.displayName,
    recipientProfileId: normalizedRecipientId,
    recipientSeat,
    recipientIsBot: recipientParticipant.kind === 'bot',
    recipientDisplayName: recipientParticipant.identity.displayName,
  }
}

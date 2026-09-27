import type { LudoColor } from '../game/ludoEngine/ludoEngineTypes.js'
import type { ProfileId, ServerConnection } from './serverTypes.js'

/**
 * Минималният "match shape", нужен за gift валидацията — умишлено НЕ е
 * директен import на ludoMatchRuntime.ts-овия вътрешен `Match` тип (той е
 * file-private там), а структурно съвместим subset (matchId/status/
 * leftColors/players), точно колкото index.ts вече чете от
 * `ludoMatchRuntime.getMatch(matchId)` в roll/move handler-ите. Никакъв
 * import на реализацията на engine-а тук — тази функция никога не пипа
 * gameplay state machine-а, само validation.
 */
export type LudoGiftMatchParticipant = {
  profileId: string
  displayName: string
  color: LudoColor
}

export type LudoGiftMatchLike = {
  matchId: string
  status: 'in_progress' | 'finished'
  leftColors: readonly LudoColor[]
  players: readonly LudoGiftMatchParticipant[]
}

export type LudoGiftParticipantsResolution =
  | {
      ok: true
      senderProfileId: ProfileId
      senderColor: LudoColor
      senderDisplayName: string
      recipientProfileId: ProfileId
      recipientColor: LudoColor
      recipientDisplayName: string
    }
  | { ok: false; message: string }

/**
 * Server-authoritative валидация кой на кого може да прати Ludo in-game
 * gift — 1:1 mirror на server/src/core/resolveTableGiftParticipants.ts
 * (Belot table gift), адаптирано за Ludo match/color модела вместо
 * room/seat. Извлечена като PURE функция (никакъв I/O, никакъв WebSocket) —
 * unit-testable без реален сървър, виж server/scripts/checkLudoGiftSystem.ts.
 *
 * КЛЮЧОВО: match-ът (players/leftColors/status) идва ИЗЦЯЛО от caller-а
 * (index.ts вече чете ludoMatchRuntime.getMatch(matchId) точно така за
 * roll/move/reclaim handler-ите, виж validate() там) — тази функция никога
 * не докосва ludoMatchRuntime.ts директно, само валидира вече прочетеното
 * canonical state.
 */
export function resolveLudoGiftParticipants(input: {
  connection: ServerConnection | null
  match: LudoGiftMatchLike | null
  recipientProfileId: string
}): LudoGiftParticipantsResolution {
  const { connection, match, recipientProfileId } = input

  if (connection === null || connection.status !== 'connected') {
    return { ok: false, message: 'Няма активна връзка.' }
  }

  const senderProfileId = connection.profileId

  if (senderProfileId === null || senderProfileId.length === 0) {
    return { ok: false, message: 'Трябва да влезеш в профила си.' }
  }

  if (match === null) {
    return { ok: false, message: 'Играта не беше намерена.' }
  }

  if (match.status === 'finished') {
    return { ok: false, message: 'Играта вече е приключила.' }
  }

  const senderParticipant = match.players.find((player) => player.profileId === senderProfileId) ?? null

  if (senderParticipant === null) {
    return { ok: false, message: 'Не участваш в тази игра.' }
  }

  if (match.leftColors.includes(senderParticipant.color)) {
    return { ok: false, message: 'Вече не участваш активно в тази игра.' }
  }

  const normalizedRecipientId = recipientProfileId.trim()

  if (normalizedRecipientId.length === 0) {
    return { ok: false, message: 'Липсва получател.' }
  }

  if (normalizedRecipientId === senderProfileId) {
    return { ok: false, message: 'Не можеш да си изпратиш подарък сам на себе си.' }
  }

  const recipientParticipant = match.players.find((player) => player.profileId === normalizedRecipientId) ?? null

  if (recipientParticipant === null) {
    // Покрива и: получателят не е в тоя match, ИЛИ client-ът е подал
    // изфабрикуван/остарял profileId — client-side иконата и без друго не
    // се показва за никого извън текущия match roster, проверката тук е
    // authoritative defense-in-depth.
    return { ok: false, message: 'Играчът не е в тази игра.' }
  }

  if (match.leftColors.includes(recipientParticipant.color)) {
    return { ok: false, message: 'Играчът вече не участва в играта.' }
  }

  return {
    ok: true,
    senderProfileId,
    senderColor: senderParticipant.color,
    senderDisplayName: senderParticipant.displayName,
    recipientProfileId: normalizedRecipientId,
    recipientColor: recipientParticipant.color,
    recipientDisplayName: recipientParticipant.displayName,
  }
}

import type { BelotSpectateDenialCode } from '../protocol/messageTypes.js'
import { evaluateVipSpectatorGateEligibility } from './evaluateVipSpectatorGateEligibility.js'
import { SERVER_SEAT_ORDER, type ProfileId, type RoomId, type ServerConnection, type ServerRoom } from './serverTypes.js'

/**
 * Pure server-side authorization за watch_belot_room (Belot Spectator Mode,
 * Phase 2A). Без I/O — всички cross-cutting факти (active game commitment,
 * Ludo spectator, други watched стаи на профила) се подават от caller-а в
 * index.ts, затова функцията е unit-testable без реален сървър.
 *
 * Невалиден watch НИКОГА не мутира нищо — caller-ът пипа registry-то само
 * при { ok: true }.
 */
export type BelotSpectatorWatchEligibilityInput = {
  featureEnabled: boolean
  connection: ServerConnection | null
  room: ServerRoom | null
  /**
   * Phase 2C: VIP-only gate. Caller-ът (index.ts) резолвва
   * vipStore.getStatus(profileId) и подава само { isActive } — САМО
   * canonical vipStore е source of truth, никаква duplicate expiration
   * логика тук. Няма role bypass.
   */
  vipStatus: { isActive: boolean }
  /** isProfileInActiveGame / waiting private room / matchmaking / Ludo room/match. */
  profileHasActiveGameCommitment: boolean
  profileIsLudoSpectating: boolean
  /** Стаите, които профилът ВЕЧЕ гледа през която и да е своя connection. */
  profileWatchedRoomIds: RoomId[]
  /**
   * "Турнирни срещи" — факти за турнирна стая, resolve-нати от caller-а от
   * persisted tournament данните. null/undefined за нетурнирни стаи; за
   * турнирна стая липсата им се третира като deny (fail-closed).
   *  - matchInProgress: DB срещата, свързана с ТАЗИ стая (room_id), е
   *    'in_progress' — гарантира точна асоциация среща <-> маса.
   *  - profileAssignedToMatch: профилът е член на някой от двата отбора в
   *    срещата (вкл. временно заменен от бот) — той трябва да се върне в
   *    играта, не да я гледа.
   *  - profileHasActiveTournamentParticipation: профилът е активен участник
   *    в течащ турнир — assignment/resume flow-ът му не бива да се смесва
   *    със spectator view.
   */
  tournamentMatch?: {
    matchInProgress: boolean
    profileAssignedToMatch: boolean
    profileHasActiveTournamentParticipation: boolean
  } | null
}

export type BelotSpectatorWatchEligibility =
  | { ok: true; profileId: ProfileId }
  | { ok: false; code: BelotSpectateDenialCode; message: string }

function deny(code: BelotSpectateDenialCode, message: string): BelotSpectatorWatchEligibility {
  return { ok: false, code, message }
}

export function isTournamentMatchSpectatorRoom(room: ServerRoom): boolean {
  return (
    room.config.isTournamentMatchOrigin === true &&
    typeof room.config.tournamentId === 'string' && room.config.tournamentId.length > 0 &&
    typeof room.config.tournamentMatchId === 'string' && room.config.tournamentMatchId.length > 0
  )
}

// Гледаеми са играещи частни маси и (от "Турнирни срещи") играещи турнирни
// маси. Matchmaking и guest trial маси остават негледаеми.
export function isBelotRoomWatchable(room: ServerRoom): boolean {
  const authoritativeState = room.game.authoritativeState
  const isPrivateTable = room.config.isPrivateTableOrigin === true && room.config.isTournamentMatchOrigin !== true
  return (
    (isPrivateTable || isTournamentMatchSpectatorRoom(room)) &&
    room.config.isGuestTrial !== true &&
    room.status === 'playing' &&
    authoritativeState !== null &&
    !('kind' in authoritativeState) &&
    authoritativeState.matchEnded === null
  )
}

export function isProfileParticipantInRoom(room: ServerRoom, profileId: ProfileId): boolean {
  return SERVER_SEAT_ORDER.some((seat) => {
    const participant = room.seats[seat].participant
    if (participant === null || participant.kind !== 'human') return false
    const participantProfileId =
      participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
    return participantProfileId === profileId
  })
}

export function evaluateBelotSpectatorWatchEligibility(
  input: BelotSpectatorWatchEligibilityInput,
): BelotSpectatorWatchEligibility {
  const { connection, room } = input

  if (!input.featureEnabled) {
    return deny('feature_disabled', 'Гледането на игри не е налично.')
  }

  if (connection === null || connection.status !== 'connected') {
    return deny('connection_inactive', 'Връзката не е активна.')
  }

  const profileId = connection.profileId
  if (profileId === null || profileId.length === 0) {
    return deny('not_authenticated', 'Трябва да влезеш в профила си.')
  }

  const vipGate = evaluateVipSpectatorGateEligibility({ vipStatus: input.vipStatus })
  if (!vipGate.ok) {
    return deny(vipGate.code, 'Гледането на тази маса изисква активен VIP.')
  }

  if (room === null) {
    return deny('room_not_found', 'Играта не беше намерена.')
  }

  if (!isBelotRoomWatchable(room)) {
    return deny('room_not_watchable', 'Тази игра не може да бъде гледана.')
  }

  if (isProfileParticipantInRoom(room, profileId)) {
    return deny('participant', 'Ти си участник в тази игра.')
  }

  if (isTournamentMatchSpectatorRoom(room)) {
    const tournamentMatch = input.tournamentMatch ?? null
    if (tournamentMatch === null || !tournamentMatch.matchInProgress) {
      return deny('room_not_watchable', 'Тази игра не може да бъде гледана.')
    }
    if (tournamentMatch.profileAssignedToMatch) {
      return deny('participant', 'Ти си участник в тази игра.')
    }
    if (tournamentMatch.profileHasActiveTournamentParticipation) {
      return deny('active_game_commitment', 'Не можеш да гледаш турнирни маси, докато участваш в активен турнир.')
    }
  }

  // connection.currentRoomId !== null => тази connection вече е закачена за
  // игрова стая (seat) — spectator connection НИКОГА не носи currentRoomId.
  if (connection.currentRoomId !== null || input.profileHasActiveGameCommitment) {
    return deny('active_game_commitment', 'Вече участваш в друга игра.')
  }

  if (input.profileIsLudoSpectating) {
    return deny('ludo_spectating', 'Вече гледаш друга игра.')
  }

  if (input.profileWatchedRoomIds.some((watchedRoomId) => watchedRoomId !== room.id)) {
    return deny('already_watching_other_room', 'Вече гледаш друга маса.')
  }

  return { ok: true, profileId }
}

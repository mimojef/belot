// Гласов чат — клиентско огледало на backend договора (Етап 3).
//
// Точно копие на server/src/voice/voiceChatProtocol.ts (WS съобщения) и на
// отговорите на voiceChatHttpApi.ts / voiceChatService.ts (HTTPS). НЕ е втори
// протокол: при промяна на backend договора този файл се обновява заедно с
// него. Тук НЯМА livekit-client и няма DOM — модулът е в основния bundle.

export type VoiceSpeakBlockedReason = 'vip_required' | 'muted'

/** Само към самия играч (никога към останалите участници). */
export type VoiceSpeakState = {
  canSpeak: boolean
  blockedReason: VoiceSpeakBlockedReason | null
  hasSpeakingEntitlement: boolean
  /** ISO; само при blockedReason 'muted' и ако е известен. */
  mutedUntil: string | null
}

export type VoicePresenceErrorCode =
  | 'voice_off'
  | 'not_authenticated'
  | 'table_not_found'
  | 'table_released'
  | 'not_a_player'
  | 'not_seat_connection'
  | 'client_instance_conflict'
  | 'banned'

export type VoicePresenceResultMessage =
  | {
      type: 'voice_presence_result'
      voiceTableId: string
      ok: true
      onTableScreen: boolean
      leaseTtlMs: number
      renewAfterMs: number
      ready: boolean
      speak: VoiceSpeakState
    }
  | { type: 'voice_presence_result'; voiceTableId: string; ok: false; code: VoicePresenceErrorCode }

export type VoiceTableUpdatedMessage = {
  type: 'voice_table_updated'
  voiceTableId: string
  generation: number | null
  ready: boolean
}

export type VoiceAccessEndReason =
  | 'left_table'
  | 'kicked'
  | 'banned'
  | 'session_replaced'
  | 'session_displaced'
  | 'lease_expired'
  | 'game_connection_lost'
  | 'table_released'
  | 'voice_off'

export type VoiceAccessEndedMessage = {
  type: 'voice_access_ended'
  voiceTableId: string
  reason: VoiceAccessEndReason
}

export type VoiceSpeakAccessUpdatedMessage = {
  type: 'voice_speak_access_updated'
  voiceTableId: string
  speak: VoiceSpeakState
}

export type VoiceServerMessage =
  | VoicePresenceResultMessage
  | VoiceTableUpdatedMessage
  | VoiceAccessEndedMessage
  | VoiceSpeakAccessUpdatedMessage

export type VoicePresenceClientMessage = {
  type: 'voice_presence'
  voiceTableId: string
  clientInstanceId: string
  onTableScreen: boolean
}

const VOICE_SERVER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'voice_presence_result',
  'voice_table_updated',
  'voice_access_ended',
  'voice_speak_access_updated',
])

export function isVoiceServerMessage(message: { type: string }): message is VoiceServerMessage {
  return VOICE_SERVER_MESSAGE_TYPES.has(message.type)
}

// ─── HTTPS ────────────────────────────────────────────────────────────────

export const VOICE_TOKEN_PATH = '/api/voice/token'
export const VOICE_SPEAK_ACCESS_PATH = '/api/voice/speak-access'

/** POST /api/voice/token -> 200. Токенът живее само в паметта до connect. */
export type VoiceTokenSuccess = {
  ok: true
  url: string
  token: string
  identity: string
  voiceTableId: string
  generation: number | null
  canSpeak: boolean
  speak: VoiceSpeakState
  expiresInSeconds: number
}

/**
 * Кодове за отказ (status): voice_off 403, voice_unavailable 503,
 * voice_starting 503, voice_rotation_pending 503, voice_busy 503,
 * voice_state_changed 409/503, table_not_found 404, table_released 410,
 * banned 403, spectator 403, bot 403, not_a_player 403, wrong_table 403,
 * permanently_left 403, not_authenticated 401, invalid_session 409,
 * presence_required 409, token_sign_failed 500, invalid_body 400,
 * forbidden_origin 403, internal_error 500.
 */
export type VoiceHttpFailure = { ok: false; code: string; retryAfterMs?: number }

/** POST /api/voice/speak-access -> 200. */
export type VoiceSpeakAccessResult =
  | { ok: true; canSpeak: true; upgrade: 'updated' | 'already_allowed' | 'request_new_token' }
  | { ok: true; canSpeak: false; code: VoiceSpeakBlockedReason; speak?: VoiceSpeakState }

/** Само формат: clientInstanceId [A-Za-z0-9_-]{16,64} (виж VOICE_CLIENT_INSTANCE_ID_PATTERN). */
export const VOICE_CLIENT_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

/** LiveKit identity на Pika: p_<profileId>_<bindingEpoch> (voiceTokenIssuer.ts). */
export function profileIdFromVoiceIdentity(identity: string): string | null {
  const match = /^p_(.+)_(\d+)$/.exec(identity)
  return match === null ? null : match[1]!
}

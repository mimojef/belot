// Гласов чат — backend протокол (Етап 2б). Само типове и парсване.
//
// ИГРОВ WebSocket (никога не носи LiveKit токен — клиентът логва всяко
// входящо WS съобщение):
//
//   клиент -> сървър
//     voice_presence { voiceTableId, clientInstanceId, onTableScreen }
//       onTableScreen:true  — "на екрана на масата съм и ползвам гласа":
//                             регистрира/премества session binding-а и
//                             подновява lease-а (на всеки VOICE_LEASE_RENEW_MS);
//       onTableScreen:false — напускам екрана на масата (лоби, магазин,
//                             "Изчакай в лоби", "Към лобито"): гласовият достъп
//                             се прекратява сървърно; мястото на масата и
//                             правото за говорене се пазят.
//
//   сървър -> клиент
//     voice_presence_result — отговор на voice_presence (без токен);
//     voice_table_updated   — нова генерация на стаята (ротация) или
//                             готовност след потвърдено изтриване на старата;
//                             клиентът иска нов токен по HTTPS;
//     voice_access_ended    — гласовият достъп на тази страница е прекратен
//                             от сървъра; без автоматично повторно включване;
//     voice_speak_access_updated — правото за говорене на ТОЗИ играч се е
//                             променило (наложено/изтекло/премахнато mute
//                             наказание). Микрофонът никога не се включва
//                             автоматично.
//
// HTTPS (сесия от cookie, origin guard, Cache-Control: no-store):
//   POST /api/voice/token         { voiceTableId, clientInstanceId }
//   POST /api/voice/speak-access  { voiceTableId, clientInstanceId }

export const VOICE_CLIENT_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
const VOICE_TABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type VoicePresenceClientMessage = {
  type: 'voice_presence'
  voiceTableId: string
  clientInstanceId: string
  onTableScreen: boolean
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

/**
 * Защо играчът в момента НЕ може да говори:
 *   'vip_required' — няма VIP и няма придобито право в участието;
 *   'muted'        — активно административно mute наказание (единният mute
 *                    за Лафче/Общи/чата в чакалнята). Придобитото право се
 *                    пази и важи отново след края на наказанието.
 * Доброволно изключен микрофон е само клиентско състояние (сървърът не го
 * знае и не го пази). Временно недостъпна услуга: HTTP 503 кодове
 * (voice_unavailable / voice_rotation_pending / voice_starting) и ready:false.
 */
export type VoiceSpeakBlockedReason = 'vip_required' | 'muted'

/** Само към самия играч (никога към останалите участници). */
export type VoiceSpeakState = {
  canSpeak: boolean
  blockedReason: VoiceSpeakBlockedReason | null
  /** Придобито право в текущото участие (пази се и по време на mute). */
  hasSpeakingEntitlement: boolean
  /** Краен срок на mute наказанието (ISO), само при blockedReason 'muted' и ако е известен. */
  mutedUntil: string | null
}

export type VoiceSpeakAccessUpdatedMessage = {
  type: 'voice_speak_access_updated'
  voiceTableId: string
  speak: VoiceSpeakState
}

export type VoicePresenceResultMessage =
  | {
      type: 'voice_presence_result'
      voiceTableId: string
      ok: true
      onTableScreen: boolean
      /** Lease-ът изтича след толкова ms без подновяване. */
      leaseTtlMs: number
      /** Препоръчителен интервал за подновяване. */
      renewAfterMs: number
      /** false -> има чакаща ротация/изтриване; токен ще бъде отказан временно. */
      ready: boolean
      speak: VoiceSpeakState
    }
  | { type: 'voice_presence_result'; voiceTableId: string; ok: false; code: VoicePresenceErrorCode }

export type VoiceTableUpdatedMessage = {
  type: 'voice_table_updated'
  voiceTableId: string
  /** Номер на текущата жива генерация (null = ще бъде създадена при следващия токен). */
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

export type VoiceServerMessage =
  | VoicePresenceResultMessage
  | VoiceTableUpdatedMessage
  | VoiceAccessEndedMessage
  | VoiceSpeakAccessUpdatedMessage

export function isVoiceClientInstanceId(value: unknown): value is string {
  return typeof value === 'string' && VOICE_CLIENT_INSTANCE_ID_PATTERN.test(value)
}

export function isVoiceTableIdFormat(value: unknown): value is string {
  return typeof value === 'string' && VOICE_TABLE_ID_PATTERN.test(value)
}

/** null -> невалидно съобщение (отхвърля се цялото, както останалите в parseClientMessage). */
export function parseVoicePresenceMessage(parsed: Record<string, unknown>): VoicePresenceClientMessage | null {
  if (!isVoiceTableIdFormat(parsed.voiceTableId)) return null
  if (!isVoiceClientInstanceId(parsed.clientInstanceId)) return null
  if (typeof parsed.onTableScreen !== 'boolean') return null
  return {
    type: 'voice_presence',
    voiceTableId: parsed.voiceTableId,
    clientInstanceId: parsed.clientInstanceId,
    onTableScreen: parsed.onTableScreen,
  }
}

/** Тяло на двете HTTPS заявки. */
export function parseVoiceSessionClaimBody(body: unknown): { voiceTableId: string; clientInstanceId: string } | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const record = body as Record<string, unknown>
  if (!isVoiceTableIdFormat(record.voiceTableId) || !isVoiceClientInstanceId(record.clientInstanceId)) return null
  return { voiceTableId: record.voiceTableId, clientInstanceId: record.clientInstanceId }
}

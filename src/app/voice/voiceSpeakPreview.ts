// Гласов чат — последното сървърно решение за говорене ПРЕДИ включване.
//
// Основен bundle, без мрежови заявки: само чете вече пристигналите WS
// съобщения. Сървърът праща решението на самия играч като поле `voiceSpeak`
// в private_room_updated (чакалня: при сядане, промяна, refresh/reconnect) и
// room_snapshot (игра), а при промяна на мюта — voice_speak_access_updated.
// voice_presence_result също носи решението. Така прозорецът знае за
// придобитото право (пази се след изтичане на VIP) и за административния мют
// още преди включването — и след refresh, reconnect и връщане на същата маса.

export type VoiceSpeakPreview = {
  canSpeak: boolean
  blockedReason: 'vip_required' | 'muted' | null
  /** Само при 'muted' и ако е известен. */
  mutedUntil: string | null
}

/** Само валидна форма; всичко друго -> null (без догадки). */
export function parseVoiceSpeakPreview(value: unknown): VoiceSpeakPreview | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.canSpeak !== 'boolean') return null
  const blockedReason = v.blockedReason === 'vip_required' || v.blockedReason === 'muted' ? v.blockedReason : v.blockedReason === null || v.blockedReason === undefined ? null : undefined
  if (blockedReason === undefined) return null
  if (v.canSpeak === (blockedReason !== null)) return null
  const mutedUntil = blockedReason === 'muted' && typeof v.mutedUntil === 'string' ? v.mutedUntil : null
  return { canSpeak: v.canSpeak, blockedReason, mutedUntil }
}

export type VoiceSpeakPreviewTracker = {
  /** Решението за тази маса (null = неизвестно). */
  get: (voiceTableId: string) => VoiceSpeakPreview | null
  /** Прилага входящо WS съобщение; true = решението се е променило. */
  applyServerMessage: (message: { type: string }) => boolean
}

export function createVoiceSpeakPreviewTracker(): VoiceSpeakPreviewTracker {
  let current: { voiceTableId: string; speak: VoiceSpeakPreview } | null = null

  function set(voiceTableId: unknown, raw: unknown): boolean {
    if (typeof voiceTableId !== 'string' || voiceTableId === '') return false
    const speak = parseVoiceSpeakPreview(raw)
    if (speak === null) {
      if (current?.voiceTableId !== voiceTableId) return false
      current = null
      return true
    }
    if (current !== null && current.voiceTableId === voiceTableId && current.speak.canSpeak === speak.canSpeak
      && current.speak.blockedReason === speak.blockedReason && current.speak.mutedUntil === speak.mutedUntil) {
      return false
    }
    current = { voiceTableId, speak }
    return true
  }

  return {
    get: (voiceTableId) => (current !== null && current.voiceTableId === voiceTableId ? current.speak : null),
    applyServerMessage(message) {
      const m = message as Record<string, unknown>
      switch (message.type) {
        case 'private_room_updated': {
          // Стар сървър (без полето) -> нищо не се променя.
          if (!('voiceSpeak' in m)) return false
          const room = m.room as Record<string, unknown> | null | undefined
          return set(room?.voiceTableId, m.voiceSpeak)
        }
        case 'room_snapshot':
          return 'voiceSpeak' in m ? set(m.voiceTableId, m.voiceSpeak) : false
        case 'voice_speak_access_updated':
          return set(m.voiceTableId, m.speak)
        case 'voice_presence_result':
          return m.ok === true ? set(m.voiceTableId, m.speak) : false
        default:
          return false
      }
    },
  }
}

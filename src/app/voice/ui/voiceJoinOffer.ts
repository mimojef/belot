// Гласов чат — кой вариант на включване да види играчът (прозорецът в
// чакалнята и панелът преди включване). Чиста функция, без I/O.
//
// Ред на източниците (повтаря сървърното правило canSpeak = !мют && (VIP ||
// придобито право), без да го заменя — сървърът решава при включване):
//   1) известно сървърно решение — преди включване от WS snapshot-ите
//      (voiceSpeakPreview: private_room_updated / room_snapshot /
//      voice_speak_access_updated), иначе snapshot.speak на контролера;
//      включва придобитото в участието право (пази се и след изтичане на
//      VIP) и административния мют; има приоритет;
//   2) иначе собственият VIP статус от /api/vip/status;
//   3) неизвестен статус НЕ означава „без VIP“: изчакване ('pending'), а при
//      грешка — неутрален вариант без „Вземи VIP“.

import type { VoiceOwnVipStatus } from '../voiceOwnVipStatus'
import type { VoiceSpeakState } from '../voiceProtocol'

/**
 * 'speak'      — „Включи микрофона“ + „Само слушай“;
 * 'listen_vip' — „Само слушай“ + „Вземи VIP“ (няма право за говорене);
 * 'muted'      — само „Само слушай“ (административен мют — VIP не помага);
 * 'neutral'    — правото е неизвестно: „Само слушай“ + „Включи микрофона“, без
 *                „Вземи VIP“; при отказ от сървъра микрофонът не се иска;
 * 'pending'    — VIP статусът още се зарежда: прозорецът изчаква.
 */
export type VoiceJoinOffer = 'speak' | 'listen_vip' | 'muted' | 'neutral' | 'pending'

export function resolveVoiceJoinOffer(speak: Pick<VoiceSpeakState, 'canSpeak' | 'blockedReason'> | null, vip: VoiceOwnVipStatus): VoiceJoinOffer {
  if (speak !== null) {
    if (speak.blockedReason === 'muted') return 'muted'
    if (speak.canSpeak) return 'speak'
    // Сървърният отказ е 'vip_required'. По-нов активен VIP (напр. подарък след
    // последното сървърно решение) по самото сървърно правило дава право.
    return vip === 'active' ? 'speak' : 'listen_vip'
  }
  if (vip === 'active') return 'speak'
  if (vip === 'inactive') return 'listen_vip'
  if (vip === 'error') return 'neutral'
  return 'pending'
}

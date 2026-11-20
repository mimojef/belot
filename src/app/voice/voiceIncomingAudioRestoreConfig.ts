// Гласов чат — Етап H4 (ЕКСПЕРИМЕНТАЛНО): кой вижда бутона „Възстанови звука“.
//
// Само ръчно (жест), само за изброените профили — проверката е по profile_id
// (никога по nickname/displayName). Не дава права на сървъра: бутонът само
// пресъздава локалните входящи audio елементи (виж restoreIncomingAudio в
// liveKitVoiceAdapter.ts) и не засяга другите участници.
//
// Разширяване: добави profile_id в списъка (по един ред с коментар кой е).
// Влиза в lazy chunk-а на гласа (импортира се от createVoiceController).

export const VOICE_INCOMING_AUDIO_RESTORE_PROFILE_IDS: readonly string[] = [
  '29925128-167c-408b-9a33-620d2d8f9a95', // Divaka655 (Samsung) — 2026-11-20
  '90e3e375-1d21-4ce2-9ff5-e341bd91eea4', // DILEIDI (Samsung PWA) — 2026-11-20
]

const allowed = new Set(VOICE_INCOMING_AUDIO_RESTORE_PROFILE_IDS.map((id) => id.toLowerCase()))

/** Точно съвпадение на profile_id (без значение за главни/малки букви на UUID-а). */
export function isVoiceIncomingAudioRestoreAllowed(profileId: string | null | undefined): boolean {
  return typeof profileId === 'string' && profileId !== '' && allowed.has(profileId.toLowerCase())
}

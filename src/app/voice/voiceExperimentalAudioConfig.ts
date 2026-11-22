// Гласов чат — ограничено production изпитване на експерименталния аудио режим
// (W1: входящото аудио през Web Audio / LiveKit webAudioMix, виж
// voiceWebAudioOutput.ts).
//
// Кой получава режима (за всяка НОВА гласова стая), по приоритет:
//   1. Сървърният kill switch (Админ -> Настройки, `voice_webaudio_mix_enabled`,
//      идва с отговора на гласовия токен). Изключен / липсващ / невалиден ->
//      СТАРИЯТ механизъм за всички — абсолютен приоритет над т. 2 и 3.
//   2. Само Android PWA (`classifyVoicePlatform` = 'android_pwa').
//   3. а) Изброените профили (по точен profile_id, никога по nickname) —
//         включено по подразбиране; профилът може да го изключи от панела
//         („Експериментален аудио режим“, пази се локално);
//      б) локалният тестов ключ — САМО на localhost/127.0.0.1 (локални
//         тестове); в production се игнорира.
// Всичко друго -> 'element' (сегашният механизъм, без промяна).
//
// Влиза в lazy chunk-а на гласа (импортира се от voiceRuntime/контролера).

import type { VoicePlatform } from './voiceMediaHealth'
import type { VoiceIncomingAudioMode } from './voiceWebAudioOutput'

export const VOICE_EXPERIMENTAL_AUDIO_PROFILE_IDS: readonly string[] = [
  '29925128-167c-408b-9a33-620d2d8f9a95', // Divaka655 (Samsung, Android PWA) — 2026-11-22
]

/** Изборът на профила в панела: '0' = изключен; липсващ/друго = включен (по подразбиране). */
export const VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY = 'pika-voice-experimental-audio'

/** Локален тестов ключ (W1) — важи САМО на localhost/127.0.0.1. */
export const VOICE_WEBAUDIO_MIX_STORAGE_KEY = 'pika-voice-webaudio-mix'

const allowedProfiles = new Set(VOICE_EXPERIMENTAL_AUDIO_PROFILE_IDS.map((id) => id.toLowerCase()))

type ReadStorage = Pick<Storage, 'getItem'> | null
type WriteStorage = Pick<Storage, 'setItem'> | null

/** localStorage на браузъра; може да хвърли (частен режим/блокирани данни) -> null. */
export function voiceExperimentalAudioStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** Точно съвпадение на profile_id (без значение за главни/малки букви на UUID-а). */
export function isVoiceExperimentalAudioProfile(profileId: string | null | undefined): boolean {
  return typeof profileId === 'string' && profileId !== '' && allowedProfiles.has(profileId.toLowerCase())
}

/** Локална среда за тестове (никога production адрес). */
export function isVoiceLocalTestHost(hostname: string | null | undefined): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** Настройката се показва само на изброения профил в Android PWA. */
export function isVoiceExperimentalAudioAvailable(platform: VoicePlatform, profileId: string | null | undefined): boolean {
  return platform === 'android_pwa' && isVoiceExperimentalAudioProfile(profileId)
}

export function readVoiceExperimentalAudioPreference(storage: ReadStorage): boolean {
  if (storage === null) return true
  try {
    return storage.getItem(VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeVoiceExperimentalAudioPreference(storage: WriteStorage, enabled: boolean): void {
  if (storage === null) return
  try {
    storage.setItem(VOICE_EXPERIMENTAL_AUDIO_PREFERENCE_KEY, enabled ? '1' : '0')
  } catch {
    /* частен режим / блокирани данни — изборът важи до затваряне на страницата */
  }
}

export type VoiceIncomingAudioModeInput = {
  /** Сървърният kill switch (от отговора на токена); само изричното true разрешава. */
  serverAllowed: boolean
  platform: VoicePlatform
  profileId: string | null | undefined
  storage: ReadStorage
  hostname: string | null | undefined
}

/** Режимът на входящото аудио за следващата стая (виж приоритета по-горе). */
export function resolveVoiceIncomingAudioMode(input: VoiceIncomingAudioModeInput): VoiceIncomingAudioMode {
  if (input.serverAllowed !== true) return 'element'
  if (input.platform !== 'android_pwa') return 'element'
  if (isVoiceExperimentalAudioProfile(input.profileId)) {
    return readVoiceExperimentalAudioPreference(input.storage) ? 'webaudio' : 'element'
  }
  if (!isVoiceLocalTestHost(input.hostname) || input.storage === null) return 'element'
  try {
    return input.storage.getItem(VOICE_WEBAUDIO_MIX_STORAGE_KEY) === '1' ? 'webaudio' : 'element'
  } catch {
    return 'element'
  }
}

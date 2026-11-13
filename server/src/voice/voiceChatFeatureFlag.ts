// Гласов чат — env авариен стоп и наличие на LiveKit конфигурация.
// ЕДИНСТВЕНОТО място, което чете тези env променливи.
//
// Режимът (Изключен / Само админ / Активен) НЕ е env: управлява се от админ
// панела и се пази в SQLite (voice_chat_admin_changes; без записи -> 'off').
// Env-ът е само авариен стоп:
//
//   * VOICE_CHAT_ENABLED=0 -> авариен стоп: ефективният режим е 'off'
//     независимо от записания (никакви нови гласови маси/токени).
//   * всяка друга стойност / липсваща -> нормална работа според режима.
//
// Чете се при всяко извикване (без кеш), за да се приложи с рестарт на
// процеса без нов deploy.

import type { VoiceChatMode } from './voiceChatTypes.js'

const EMERGENCY_STOP_ENV_NAME = 'VOICE_CHAT_ENABLED'
const EMERGENCY_STOP_VALUE = '0'

/**
 * Имената (никога стойностите) на server-side LiveKit конфигурацията.
 * Етап 2а само проверява дали са подадени — нищо не се свързва с LiveKit.
 */
export const VOICE_CHAT_LIVEKIT_ENV_NAMES = [
  'LIVEKIT_API_URL',
  'LIVEKIT_WS_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
] as const

type EnvSource = Readonly<Record<string, string | undefined>>

export function isVoiceChatEmergencyStopActive(env: EnvSource = process.env): boolean {
  return env[EMERGENCY_STOP_ENV_NAME]?.trim() === EMERGENCY_STOP_VALUE
}

/** Аварийният стоп винаги печели над записания режим. */
export function resolveEffectiveVoiceChatMode(storedMode: VoiceChatMode, emergencyStop: boolean): VoiceChatMode {
  return emergencyStop ? 'off' : storedMode
}

export type VoiceChatLiveKitConfigStatus = {
  configured: boolean
  /** Само имена на липсващи променливи — за админ панела, без стойности. */
  missing: string[]
}

export function getVoiceChatLiveKitConfigStatus(env: EnvSource = process.env): VoiceChatLiveKitConfigStatus {
  const missing = VOICE_CHAT_LIVEKIT_ENV_NAMES.filter((name) => (env[name]?.trim() ?? '') === '')
  return { configured: missing.length === 0, missing: [...missing] }
}

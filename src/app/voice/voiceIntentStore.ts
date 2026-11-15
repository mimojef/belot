// Гласов чат — намерение за участие след презареждане (етап В).
//
// Само в sessionStorage на ТОЗИ таб (не се споделя с други табове/устройства)
// и само за същия профил и същата гласова маса. Използва се единствено при
// истинско презареждане на страницата (navigation type 'reload') или връщане
// от bfcache — „Duplicate tab“/нов таб не наследяват гласа. Срок: 15 минути.
// Никакви токени, identity-та или имена — само id на масата и профила.

const STORAGE_KEY = 'pika.voice.intent.v1'
const MAX_AGE_MS = 15 * 60_000

export type StoredVoiceIntent = { voiceTableId: string; profileId: string; mic: boolean; savedAt: number }

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function saveVoiceIntent(intent: { voiceTableId: string; profileId: string; mic: boolean }, now: number = Date.now()): void {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify({ ...intent, savedAt: now })) } catch { /* без памет — без възстановяване */ }
}

export function clearVoiceIntent(): void {
  try { storage()?.removeItem(STORAGE_KEY) } catch { /* нищо */ }
}

export function readVoiceIntent(now: number = Date.now()): StoredVoiceIntent | null {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return null
    const value = JSON.parse(raw) as Partial<StoredVoiceIntent>
    if (typeof value.voiceTableId !== 'string' || typeof value.profileId !== 'string' || typeof value.mic !== 'boolean' || typeof value.savedAt !== 'number') return null
    if (now - value.savedAt > MAX_AGE_MS || value.savedAt > now + 60_000) return null
    return { voiceTableId: value.voiceTableId, profileId: value.profileId, mic: value.mic, savedAt: value.savedAt }
  } catch {
    return null
  }
}

/** Страницата е заредена чрез презареждане (не нов таб, не „Duplicate tab“, не навигация). */
export function isReloadNavigation(): boolean {
  try {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return entry?.type === 'reload'
  } catch {
    return false
  }
}

/** Микрофонът може да се вземе без прозорец за разрешение (вече е разрешен). */
export async function isMicrophonePermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
    return status.state === 'granted'
  } catch {
    return false
  }
}

// Обща server-authoritative проверка за достъп до тестовата игра "Свара".
//
// ЕДИНСТВЕНИЯТ източник на истина за "може ли този профил да ползва Свара".
// Етап 1 я ползва за GET /api/games/svara/access и за UI сигнала в сесията;
// следващите етапи ТРЯБВА да я викат и при създаване на маса, присъединяване,
// игрови действия, повторно свързване и възстановяване — никога inline role
// сравнения из handler-ите.
//
// Ролята се чете от authoritative сесията (authStore.getSession — валидна,
// неотменена сесия на активен акаунт), никога от клиентски payload.
//
// Два режима на достъп (след флага SVARA_TEST_ENABLED):
//   • затворен (по подразбиране) — само SVARA_ALLOWED_ROLES;
//   • публичен — всички регистрирани профили (всяка сесия с профил).
// Публичният режим е админ настройката „Свара — Достъпна за всички“
// (admin_settings.svara_public_access_enabled); index.ts я подава през
// setSvaraPublicAccessProvider (кеш в паметта, обновява се при запис) —
// важи веднага за HTTP, WebSocket и сесийния сигнал, без deploy/рестарт.

import { isSvaraTestFeatureEnabled } from './svaraFeatureFlag.js'

export const SVARA_ALLOWED_ROLES = ['admin', 'subadmin', 'pika_team', 'marketing', 'top_chat_admin'] as const

export type SvaraAllowedRole = (typeof SVARA_ALLOWED_ROLES)[number]

export type SvaraAccessDenialReason = 'feature_disabled' | 'unauthenticated' | 'forbidden_role'

export type SvaraAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: SvaraAccessDenialReason }

/** Минималната форма на authoritative сесия, нужна за решението. */
export type SvaraAccessSession = {
  account: { role: string }
  profile: { profileId: string | null }
} | null

export function isSvaraAllowedRole(role: string): role is SvaraAllowedRole {
  return (SVARA_ALLOWED_ROLES as readonly string[]).includes(role)
}

let publicAccessProvider: () => boolean = () => false

/** Подава текущата стойност на „Свара — Достъпна за всички“ (по подразбиране — изключено). */
export function setSvaraPublicAccessProvider(provider: () => boolean): void {
  publicAccessProvider = provider
}

/** Грешка при четене → затворен режим (fail-closed). */
export function isSvaraPublicAccessEnabled(): boolean {
  try { return publicAccessProvider() === true } catch { return false }
}

export function evaluateSvaraAccess(
  session: SvaraAccessSession,
  isFeatureEnabled: () => boolean = isSvaraTestFeatureEnabled,
  isPublicAccess: () => boolean = isSvaraPublicAccessEnabled,
): SvaraAccessDecision {
  // Флагът е първи: при OFF отказът е еднакъв за всички, без значение от
  // ролята или дали има сесия.
  if (!isFeatureEnabled()) return { allowed: false, reason: 'feature_disabled' }
  if (session === null || session.profile.profileId === null) return { allowed: false, reason: 'unauthenticated' }
  if (isSvaraAllowedRole(session.account.role) || isPublicAccess()) return { allowed: true }
  return { allowed: false, reason: 'forbidden_role' }
}

export function canSessionAccessSvara(session: SvaraAccessSession): boolean {
  return evaluateSvaraAccess(session).allowed
}

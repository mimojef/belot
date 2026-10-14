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
// Бъдещото публично пускане е отделна, контролирана промяна САМО тук
// (напр. разширяване на правилото след флага), без да се пипат call site-ите.

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

export function evaluateSvaraAccess(
  session: SvaraAccessSession,
  isFeatureEnabled: () => boolean = isSvaraTestFeatureEnabled,
): SvaraAccessDecision {
  // Флагът е първи: при OFF отказът е еднакъв за всички, без значение от
  // ролята или дали има сесия.
  if (!isFeatureEnabled()) return { allowed: false, reason: 'feature_disabled' }
  if (session === null || session.profile.profileId === null) return { allowed: false, reason: 'unauthenticated' }
  if (!isSvaraAllowedRole(session.account.role)) return { allowed: false, reason: 'forbidden_role' }
  return { allowed: true }
}

export function canSessionAccessSvara(session: SvaraAccessSession): boolean {
  return evaluateSvaraAccess(session).allowed
}

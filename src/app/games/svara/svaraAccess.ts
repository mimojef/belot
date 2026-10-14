// Клиентска страна на достъпа до тестовата игра "Свара" — САМО UX.
//
// Видимостта на бутона в "Игри" следва server-derived сигнала
// session.svaraTestAccess (флаг SVARA_TEST_ENABLED + роля, изчислени от
// server/src/games/svara/svaraAccess.ts). Ролевият списък тук е mirror —
// допълнителна защита срещу показване, не източник на истина. Самата
// страница /games/svara рендира съдържание едва след 200 от
// GET /api/games/svara/access (виж fetchSvaraAccess).

export const SVARA_ALLOWED_ROLES = ['admin', 'subadmin', 'pika_team', 'marketing', 'top_chat_admin'] as const

export type SvaraEntrySession = {
  account: { role: string }
  svaraTestAccess?: boolean
} | null

export function isSvaraAllowedRole(role: string): boolean {
  return (SVARA_ALLOWED_ROLES as readonly string[]).includes(role)
}

export function canShowSvaraEntry(session: SvaraEntrySession): boolean {
  return session !== null && session.svaraTestAccess === true && isSvaraAllowedRole(session.account.role)
}

export type SvaraAccessCheckResult = 'granted' | 'denied'

export async function fetchSvaraAccess(apiBaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SvaraAccessCheckResult> {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/games/svara/access`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
    if (response.status !== 200) return 'denied'
    const body = (await response.json()) as { ok?: unknown; access?: unknown }
    return body.ok === true && body.access === 'granted' ? 'granted' : 'denied'
  } catch {
    // Мрежова грешка → fail closed.
    return 'denied'
  }
}

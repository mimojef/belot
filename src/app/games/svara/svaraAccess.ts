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

export type SvaraAccessCheckResult = 'granted' | 'denied' | 'unauthenticated' | 'forbidden' | 'unavailable'

export type SvaraTableCreationOptions = {
  entryPercent: 1
  entries: Array<{ entryFee: number; startingChips: number; entryChips: number }>
}

/** Read-only server configuration; never guess an ante or use stale defaults. */
export async function fetchSvaraTableCreationOptions(apiBaseUrl: string): Promise<SvaraTableCreationOptions | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/games/svara/access`, { credentials: 'include', cache: 'no-store' })
    if (response.status !== 200) return null
    const body = await response.json()
    const options = body.creationOptions as SvaraTableCreationOptions | undefined
    if (body.ok !== true || body.access !== 'granted' || options?.entryPercent !== 1 || !Array.isArray(options.entries) || options.entries.length === 0) return null
    const seen = new Set<number>()
    for (const entry of options.entries) {
      if (!entry || !Number.isSafeInteger(entry.entryFee) || entry.entryFee <= 0 || seen.has(entry.entryFee)
        || !Number.isSafeInteger(entry.startingChips) || entry.startingChips * 10 !== entry.entryFee
        || !Number.isSafeInteger(entry.entryChips) || entry.entryChips * 100 !== entry.startingChips) return null
      seen.add(entry.entryFee)
    }
    return options
  } catch { return null }
}

export async function fetchSvaraAccess(apiBaseUrl: string, fetchImpl: typeof fetch = fetch): Promise<SvaraAccessCheckResult> {
  try {
    const response = await fetchImpl(`${apiBaseUrl}/api/games/svara/access`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    })
    if (response.status === 401) return 'unauthenticated'
    if (response.status === 403) return 'forbidden'
    if (response.status === 404) return 'unavailable'
    if (response.status !== 200) return 'denied'
    const body = (await response.json()) as { ok?: unknown; access?: unknown }
    return body.ok === true && body.access === 'granted' ? 'granted' : 'denied'
  } catch {
    // Мрежова грешка → fail closed.
    return 'denied'
  }
}

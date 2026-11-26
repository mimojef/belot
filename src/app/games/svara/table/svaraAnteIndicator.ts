// Свара — индикатор на текущия вход (анте) и броене до следващото увеличение.
//
// Сървърът е единственият източник: snapshot.table.entryChips (текущото анте)
// и snapshot.table.ante.nextIncreaseAt (срокът, сървърно време). Клиентът само
// смята оставащото време по sharedServerClock — без заявки и без отрицателно
// време (изтекъл срок по време на раздаване показва 00:00 до следващата граница,
// където сървърът прилага новото анте и изпраща нов срок).

import type { SvaraMatchSnapshotMessage } from '../../../network/createGameServerClient'

const amountFormatter = new Intl.NumberFormat('bg-BG', { useGrouping: 'always' })

/** Продължителност на „Вход X“ в центъра на масата. */
export const SVARA_ANTE_FLASH_MS = 2000
/** Промяна, по-стара от това (reconnect, презареждане, възстановяване), не се анимира. */
export const SVARA_ANTE_FLASH_FRESH_MS = 3000

export function formatSvaraAnteCountdown(nextIncreaseAt: number, serverNow: number): string {
  const seconds = Math.max(0, Math.ceil((nextIncreaseAt - serverNow) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/** Горният ляв ъгъл на сукното: „Вход 10 — 05:37“; празно извън игра. */
export function renderSvaraAnteIndicatorHtml(snapshot: SvaraMatchSnapshotMessage | null, serverNow: number): string {
  if (!snapshot || snapshot.phase !== 'in-progress') return ''
  const next = snapshot.table.ante?.nextIncreaseAt ?? null
  const countdown = next === null ? ''
    : ` <span aria-hidden="true" style="color:rgba(248,231,176,.55);">—</span> <span data-svara-ante-countdown="${next}" style="font-variant-numeric:tabular-nums;">${formatSvaraAnteCountdown(next, serverNow)}</span>`
  return `<div data-svara-ante-indicator="1" title="Текущ вход (анте) и време до следващото увеличение" style="position:absolute;left:8px;top:8px;z-index:6;pointer-events:none;box-sizing:border-box;max-width:calc(50% - 16px);overflow:hidden;white-space:nowrap;padding:4px 9px;border-radius:8px;background:rgba(0,0,0,.72);border:1px solid rgba(212,165,32,.6);box-shadow:0 2px 8px rgba(0,0,0,.45);color:#f8e7b0;font-size:clamp(11px,2.8vw,13px);font-weight:800;line-height:1.2;letter-spacing:.01em;">Вход <span data-svara-ante-chips="1" style="color:#f4c95b;">${amountFormatter.format(snapshot.table.entryChips)}</span>${countdown}</div>`
}

export type SvaraAnteSeen = { matchId: string; chips: number; changedAt: number | null }

/**
 * Дали новият snapshot носи ДЕЙСТВИТЕЛНА, току-що приложена промяна на входа.
 * Първото виждане на мача (зареждане, remount) е само база; промяна, приложена
 * по-рано от SVARA_ANTE_FLASH_FRESH_MS (reconnect, възстановяване), не се показва.
 */
export function detectSvaraAnteChange(seen: SvaraAnteSeen | null, snapshot: SvaraMatchSnapshotMessage, serverNow: number): number | null {
  if (!seen || seen.matchId !== snapshot.matchId || snapshot.phase !== 'in-progress') return null
  const changedAt = snapshot.table.ante?.changedAt ?? null
  if (changedAt === null || changedAt === seen.changedAt || snapshot.table.entryChips === seen.chips) return null
  return serverNow - changedAt <= SVARA_ANTE_FLASH_FRESH_MS ? snapshot.table.entryChips : null
}

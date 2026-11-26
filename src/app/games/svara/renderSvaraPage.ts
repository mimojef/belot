// "Свара" — начална страница: заглавие, истинската игра
// (реалният WS мултиплейър) и връзка обратно към "Игри".
//
// status==='checking' рендира само неутрален loader — съдържанието се
// показва едва при 'granted' (потвърдено от сървъра). При отказ
// показва обяснение, без да монтира игровия интерфейс.

import type { SvaraAccessCheckResult } from './svaraAccess'

/**
 * Телефон: отстъпът от ръба на екрана до съдържанието на масата —
 * <main style="padding:12px"> на мобилното лоби (renderLobbyScreen.ts) +
 * страничният padding на тази страница (12px).
 */
const MOBILE_EDGE_INSET_PX = 24

export type SvaraPageStatus = 'checking' | SvaraAccessCheckResult

/** Иконката пред заглавието „Частни маси – Свара“ (светлата мобилна рамка, 36×36 като Ludo). */
const LIGHT_TITLE_ICON_URL = '/assets/lobby-mobile/icons/icon-private-tables-svara.webp'

export function renderSvaraPage(status: SvaraPageStatus, useMobileLayout = false, light = false): string {
  if (light) return renderLightSvaraPage(status)
  const padding = useMobileLayout ? '14px 12px 40px' : '28px 40px 60px'

  if (status === 'checking') {
    return `
      <article data-svara-page="checking" style="padding:${padding};max-width:720px;box-sizing:border-box;">
        <div style="color:rgba(248,250,252,0.72);font-size:14px;font-weight:700;">Зареждане…</div>
      </article>
    `
  }

  if (status !== 'granted') {
    const messages = {
      unauthenticated: 'Влез в профила си, за да проверим тестовия ти достъп.',
      forbidden: 'Този профил няма разрешение за тестов достъп до Свара.',
      unavailable: 'Тестовата игра не е достъпна на този сървър.',
      denied: 'Проверката за достъп не завърши успешно. Опитай отново.',
    }
    return `
      <article data-svara-page="${status}" style="padding:${padding};max-width:720px;box-sizing:border-box;">
        <p role="alert" style="color:#f8fafc;font-size:14px;">${messages[status]}</p>
        <button type="button" data-svara-play-button="1">Опитай отново</button>
        <a href="/games" data-svara-back-to-games="1" style="display:inline-block;margin:12px;color:#f5d06f;">← Обратно към Игри</a>
      </article>
    `
  }

  // Активна маса: сукното заема цялата ширина на
  // игровия екран — без горната граница на страницата, а на телефон и без
  // страничните отстъпи. Изходът е иконата в горния бар на масата; извън
  // активна маса „Назад“ е в реда с действията на контролера.
  const realSection = `
    <style data-svara-page-style="1">
      [data-svara-page="granted"]:has([data-svara-table]) { max-width:none !important; }
      /* Предигровите екрани: структурата на „Не се сърди човече“ — банерът,
         „Назад“ и отстъпите идват от контролера (createSvaraLobbyController). */
      [data-svara-page="granted"]:not(:has([data-svara-table])) { padding:0 !important; max-width:none !important; }
      [data-svara-page="granted"]:not(:has([data-svara-table])) > [data-svara-page-title] { display:none !important; }
      ${useMobileLayout ? `[data-svara-page="granted"] > [data-svara-lobby-mount]:has([data-svara-table]) { margin-left:-${MOBILE_EDGE_INSET_PX}px; margin-right:-${MOBILE_EDGE_INSET_PX}px; }` : ''}
    </style>
    <div data-svara-lobby-mount="1"></div>
  `
  // Компактен заглавен ред (мобилният приоритет и „без вертикално превъртане
  // на активната маса“) — максимум пространство за самата маса.
  return `
      <article data-svara-page="granted" style="padding:${padding};width:100%;max-width:1180px;box-sizing:border-box;">
        <div data-svara-page-title="1" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <h1 style="margin:0;color:#fff;font-size:${useMobileLayout ? '18px' : '22px'};font-weight:900;letter-spacing:0.3px;">Свара</h1>
        </div>
        ${realSection}
      </article>
    `
}

// Светлата мобилна рамка (само предигровите екрани на телефон — виж
// isMobileSvaraLobbyView в renderLobbyScreen.ts): заглавие с иконка като
// „Частни маси – Не се сърди човече“. Бутонът „Назад“ е в реда с действията
// на контролера (createSvaraLobbyController, светлият вариант).
function renderLightSvaraPage(status: SvaraPageStatus): string {
  const title = `<div style="display:flex;align-items:center;gap:10px;min-width:0;margin-bottom:12px;">
          <img src="${LIGHT_TITLE_ICON_URL}" alt="" width="36" height="36" decoding="async" style="width:36px;height:36px;flex:0 0 auto;display:block;object-fit:contain;">
          <h1 style="margin:0;min-width:0;color:#17233C;font-size:20px;font-weight:800;line-height:1.2;overflow-wrap:anywhere;">Частни маси – Свара</h1>
        </div>`
  const article = (body: string) => `
      <article data-svara-page="${status}" data-svara-light="1" style="padding:4px 0 20px;max-width:920px;margin:0 auto;box-sizing:border-box;color:#111827;">
        ${title}
        ${body}
      </article>
    `
  if (status === 'checking') {
    return article('<div style="font-size:14px;font-weight:700;color:#667085;">Зареждане…</div>')
  }
  if (status !== 'granted') {
    const messages = {
      unauthenticated: 'Влез в профила си, за да проверим тестовия ти достъп.',
      forbidden: 'Този профил няма разрешение за тестов достъп до Свара.',
      unavailable: 'Тестовата игра не е достъпна на този сървър.',
      denied: 'Проверката за достъп не завърши успешно. Опитай отново.',
    }
    const secondary = 'box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:42px;padding:0 14px;border:1px solid #D0D5DD;border-radius:10px;background:#FFFFFF;color:#344054;font-family:inherit;font-size:14px;font-weight:800;text-decoration:none;cursor:pointer;white-space:nowrap;'
    return article(`<div style="box-sizing:border-box;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:12px;padding:12px;box-shadow:0 1px 2px rgba(16,24,40,0.05);">
          <p role="alert" style="margin:0 0 12px;font-size:14px;font-weight:700;line-height:1.45;color:#B42318;">${messages[status]}</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button type="button" data-svara-play-button="1" style="${secondary}color:#6941C6;">Опитай отново</button>
            <a href="/games" data-svara-back-to-games="1" style="${secondary}">← Обратно към Игри</a>
          </div>
        </div>`)
  }
  return article('<div data-svara-lobby-mount="1"></div>')
}

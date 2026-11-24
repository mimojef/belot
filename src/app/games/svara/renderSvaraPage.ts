// "Свара" — начална страница: заглавие („Тестов режим“), истинската игра
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

export function renderSvaraPage(status: SvaraPageStatus, useMobileLayout = false): string {
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
  // страничните отстъпи (заглавието и връзката „Обратно“ остават подравнени).
  // При активна маса „← Обратно към Игри“ се скрива (на всяка резолюция) —
  // изходът е иконата в горния бар на масата.
  const realSection = `
    <style data-svara-page-style="1">
      [data-svara-page="granted"]:has([data-svara-table]) { max-width:none !important; }
      [data-svara-page="granted"]:has([data-svara-table]) > [data-svara-back-to-games] { display:none !important; }
      ${useMobileLayout ? `[data-svara-page="granted"] > [data-svara-lobby-mount]:has([data-svara-table]) { margin-left:-${MOBILE_EDGE_INSET_PX}px; margin-right:-${MOBILE_EDGE_INSET_PX}px; }` : ''}
    </style>
    <div data-svara-lobby-mount="1"></div>
  `
  // Компактен заглавен ред (мобилният приоритет и „без вертикално превъртане
  // на активната маса“) — максимум пространство за самата маса.
  return `
      <article data-svara-page="granted" style="padding:${padding};width:100%;max-width:1180px;box-sizing:border-box;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <h1 style="margin:0;color:#fff;font-size:${useMobileLayout ? '18px' : '22px'};font-weight:900;letter-spacing:0.3px;">Свара</h1>
          <div style="padding:2px 9px;border:1px solid rgba(212,165,32,0.55);border-radius:999px;background:rgba(212,165,32,0.10);color:#f5d06f;font-size:10px;font-weight:800;">Тестов режим</div>
        </div>
        ${realSection}
        <a
          href="/games"
          data-svara-back-to-games="1"
          style="display:inline-block;text-decoration:none;margin-top:10px;background:transparent;border:1px solid rgba(212,165,32,0.55);border-radius:10px;padding:7px 14px;color:#f8fafc;font-size:12px;font-weight:800;cursor:pointer;"
        >← Обратно към Игри</a>
      </article>
    `
}

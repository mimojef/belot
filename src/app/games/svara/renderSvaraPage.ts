// "Свара" — начална страница: заглавие, връзка обратно към "Игри", toggle
// между реалния WS мултиплейър (Етап 2Б.3.7.2) и запазеното анимационно
// демо (Етап 2А) — ясно разделени (задание §10), демото остава непипнато.
//
// status==='checking' рендира само неутрален loader — съдържанието се
// показва едва при 'granted' (потвърдено от сървъра). При отказ
// показва обяснение, без да монтира игровия интерфейс.

import type { SvaraAccessCheckResult } from './svaraAccess'

export type SvaraPageStatus = 'checking' | SvaraAccessCheckResult
export type SvaraViewMode = 'real' | 'demo'

export function renderSvaraPage(status: SvaraPageStatus, useMobileLayout = false, viewMode: SvaraViewMode = 'real'): string {
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

  const tabButtonStyle = (active: boolean, compact: boolean) => `
    flex:1 1 auto;min-height:${compact ? 30 : 38}px;padding:0 14px;border-radius:8px;cursor:pointer;font-size:${compact ? 12 : 13}px;font-weight:800;
    border:1px solid ${active ? 'rgba(212,165,32,0.7)' : 'rgba(255,255,255,0.14)'};
    background:${active ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.04)'};
    color:${active ? '#f5d06f' : 'rgba(255,255,255,0.65)'};
  `

  const realSection = `
    <div data-svara-lobby-mount="1"></div>
  `
  const demoSection = `
    <h2 style="margin:${useMobileLayout ? '18px' : '22px'} 0 0;color:#fff;font-size:${useMobileLayout ? '16px' : '18px'};font-weight:900;">Анимационен прототип (демо)</h2>
    <div style="margin-top:6px;color:rgba(248,250,252,0.55);font-size:12px;">Локални тестови данни — без реални играчи, жълтици или сървърни заявки.</div>
    <div data-svara-demo-mount="1"></div>
  `

  // "Реален" изглед пести вертикално място (задание §11 — мобилният приоритет
  // и "без вертикално превъртане на активната маса") — компактен заглавен
  // ред вместо голямата brand-витрина, за да остане максимум пространство
  // за самата маса/местата. "Демо" режимът пази оригиналната голяма
  // витрина — демонстрационната страница не е засегната от този бюджет.
  if (viewMode === 'real') {
    return `
      <article data-svara-page="granted" style="padding:${padding};width:100%;max-width:1180px;box-sizing:border-box;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
          <h1 style="margin:0;color:#fff;font-size:${useMobileLayout ? '18px' : '22px'};font-weight:900;letter-spacing:0.3px;">Свара</h1>
          <div style="padding:2px 9px;border:1px solid rgba(212,165,32,0.55);border-radius:999px;background:rgba(212,165,32,0.10);color:#f5d06f;font-size:10px;font-weight:800;">Тестов режим</div>
          <div style="display:flex;gap:6px;margin-left:auto;" role="tablist">
            <button type="button" data-svara-view-tab="real" data-active="true" style="${tabButtonStyle(true, true)}">Истинска игра</button>
            <button type="button" data-svara-view-tab="demo" data-active="false" style="${tabButtonStyle(false, true)}">Демо</button>
          </div>
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

  return `
    <article data-svara-page="granted" style="padding:${padding};width:100%;max-width:${useMobileLayout ? 720 : 1180}px;box-sizing:border-box;">
      <div style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:14px;
        padding:${useMobileLayout ? '22px 18px' : '32px 32px'};
        box-sizing:border-box;
        text-align:center;
      ">
        <h1 style="margin:0;color:#fff;font-size:${useMobileLayout ? '28px' : '36px'};font-weight:900;letter-spacing:0.5px;">Свара</h1>
        <div style="
          display:inline-block;
          margin-top:14px;
          padding:6px 14px;
          border:1px solid rgba(212,165,32,0.55);
          border-radius:999px;
          background:rgba(212,165,32,0.10);
          color:#f5d06f;
          font-size:${useMobileLayout ? '13px' : '14px'};
          font-weight:800;
        ">Тестов режим</div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;" role="tablist">
        <button type="button" data-svara-view-tab="real" data-active="false" style="${tabButtonStyle(false, false)}">Истинска игра</button>
        <button type="button" data-svara-view-tab="demo" data-active="true" style="${tabButtonStyle(true, false)}">Демо</button>
      </div>
      ${demoSection}
      <a
        href="/games"
        data-svara-back-to-games="1"
        style="
          display:inline-block;
          text-decoration:none;
          margin-top:${useMobileLayout ? '16px' : '20px'};
          background:transparent;
          border:1px solid rgba(212,165,32,0.55);
          border-radius:10px;
          padding:10px 16px;
          color:#f8fafc;
          font-size:14px;
          font-weight:800;
          cursor:pointer;
        "
      >← Обратно към Игри</a>
    </article>
  `
}

// "Свара" — начална страница (Етап 1): заглавие, "В разработка" и връзка
// обратно към "Игри". Без маса/карти/мултиплейър.
//
// status==='checking' рендира само неутрален loader — съдържанието се
// показва едва при 'granted' (потвърдено от сървъра). При отказ
// контролерът пренасочва към /games и тази страница не се рендира.

export type SvaraPageStatus = 'checking' | 'granted'

export function renderSvaraPage(status: SvaraPageStatus, useMobileLayout = false): string {
  const padding = useMobileLayout ? '14px 12px 40px' : '28px 40px 60px'

  if (status !== 'granted') {
    return `
      <article data-svara-page="checking" style="padding:${padding};max-width:720px;box-sizing:border-box;">
        <div style="color:rgba(248,250,252,0.72);font-size:14px;font-weight:700;">Зареждане…</div>
      </article>
    `
  }

  return `
    <article data-svara-page="granted" style="padding:${padding};max-width:720px;box-sizing:border-box;">
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
        ">В разработка</div>
      </div>
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

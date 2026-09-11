// "Още игри" — lobby sub-screen зад VITE_FEATURE_LUDO. Засега една карта:
// "Не се сърди човече" с бутон "ИГРАЙ". Визуалният стил следва
// съществуващия action-card език от лобито (renderStakeSection и
// съседните rules/strategy карти), не отделна design система.

export function renderMoreGamesScreen(useMobileLayout = false): string {
  const padding = useMobileLayout ? '14px 12px 40px' : '28px 40px 60px'
  const titleSize = useMobileLayout ? '24px' : '32px'

  return `
    <article style="padding:${padding};max-width:720px;box-sizing:border-box;">
      <header style="margin-bottom:${useMobileLayout ? '18px' : '26px'};">
        <h1 style="margin:0 0 8px;color:#ffffff;font-size:${titleSize};font-weight:900;letter-spacing:-0.01em;">Още игри</h1>
        <p style="margin:0;color:rgba(255,255,255,0.55);font-size:${useMobileLayout ? '13px' : '14px'};line-height:1.6;">Нови игри в Pika.bg, освен белот.</p>
      </header>

      <div
        data-ludo-play-card="1"
        style="
          background:#000000;
          border:2px solid rgba(212,165,32,0.78);
          border-radius:14px;
          padding:${useMobileLayout ? '16px' : '20px'};
          display:flex;
          align-items:center;
          gap:16px;
          flex-wrap:wrap;
        "
      >
        <div style="
          width:64px; height:64px; border-radius:14px; flex-shrink:0;
          background:conic-gradient(#e0473e 0deg 90deg, #3b82f6 90deg 180deg, #f2c230 180deg 270deg, #22a559 270deg 360deg);
          box-shadow:inset 0 0 0 2px rgba(255,255,255,0.2);
        "></div>

        <div style="flex:1; min-width:180px;">
          <div style="font-size:${useMobileLayout ? '16px' : '18px'}; font-weight:800; color:#fff;">Не се сърди човече</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px;">Класическа игра за 4 играчи. Визуален прототип.</div>
        </div>

        <button
          type="button"
          data-ludo-play-button="1"
          style="
            padding:12px 28px;
            border:none;
            border-radius:10px;
            background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
            color:#000000;
            font-size:14px;
            font-weight:900;
            letter-spacing:0.04em;
            text-transform:uppercase;
            cursor:pointer;
            flex-shrink:0;
          "
        >Играй</button>
      </div>
    </article>
  `
}

// "Игри" — lobby sub-screen. Засега съдържа една feature-flagged карта:
// "Не се сърди човече" — кликуем банер (бутонът "ИГРАЙ" е нарисуван вътре
// в самото изображение), обвит в златната рамка на action-card езика от
// лобито (renderStakeSection и съседните rules/strategy карти).
//
// "Свара" — тестова карта, видима САМО при showSvara (server-derived
// session.svaraTestAccess, виж app/games/svara/svaraAccess.ts). При false
// HTML-ът изобщо не съдържа картата.

//
// light — светлият мобилен дизайн (renderLobbyScreen.ts,
// GUEST_MOBILE_LIGHT_INFO_VIEWS), общ за гост и регистриран. Ludo лобито
// изисква профил, затова за гост картата е data-lobby-guest-auth-gate
// (подканата за вход), както "Създай игра" в гост лобито; за регистриран
// (isMember) — data-ludo-play-button.
export function renderMoreGamesScreen(useMobileLayout = false, showLudo = true, showSvara = false, light = false, isMember = false): string {
  if (light) return renderLightMoreGamesScreen(showLudo, showSvara, isMember)
  const padding = useMobileLayout ? '14px 12px 40px' : '28px 40px 60px'

  return `
    <article style="padding:${padding};max-width:720px;box-sizing:border-box;">
      <img
        src="/images/games/games-banner.webp"
        alt="Игри в Pika.bg"
        style="display:block;width:100%;height:auto;margin-bottom:${useMobileLayout ? '18px' : '26px'};border-radius:14px;"
      />

      ${showLudo ? `<div
        data-ludo-play-card="1"
        data-ludo-play-button="1"
        role="button"
        tabindex="0"
        aria-label="Играй Не се сърди човече"
        style="
          background:#000000;
          border:2px solid rgba(212,165,32,0.78);
          border-radius:14px;
          padding:0;
          overflow:hidden;
          cursor:pointer;
          line-height:0;
        "
      ><img
          src="/images/games/ludo-banner.webp"
          alt="Не се сърди човече — играй"
          style="display:block;width:100%;height:auto;border-radius:12px;"
        /></div>` : ''}${showSvara ? `

      <div
        data-svara-play-card="1"
        data-svara-play-button="1"
        role="button"
        tabindex="0"
        aria-label="Свара"
        style="
          margin-top:${useMobileLayout ? '14px' : '18px'};
          background:#000000;
          border:2px solid rgba(212,165,32,0.78);
          border-radius:14px;
          padding:${useMobileLayout ? '16px 16px' : '20px 24px'};
          box-sizing:border-box;
          cursor:pointer;
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
        "
      >
        <div>
          <div style="color:#fff;font-size:${useMobileLayout ? '20px' : '24px'};font-weight:900;">Свара</div>
          <div style="margin-top:4px;color:#f5d06f;font-size:12px;font-weight:800;">Тестов достъп · В разработка</div>
        </div>
        <span style="
          flex:0 0 auto;
          padding:8px 16px;
          border-radius:10px;
          background:linear-gradient(180deg,#f5d06f,#d4a520);
          color:#1a1203;
          font-size:14px;
          font-weight:900;
        ">ОТВОРИ</span>
      </div>` : ''}
    </article>
  `
}

function renderLightMoreGamesScreen(showLudo: boolean, showSvara: boolean, isMember: boolean): string {
  const card = 'background:#FFFFFF;border:1px solid rgba(20,20,43,0.05);border-radius:12px;box-shadow:0 6px 18px rgba(34,30,80,0.07);box-sizing:border-box;'
  return `
    <article data-more-games-light="1" style="padding:2px 0 8px;box-sizing:border-box;">
      <div style="${card}padding:8px;">
        <img
          src="/images/games/games-banner.webp"
          alt="Игри в Pika.bg"
          style="display:block;width:100%;height:auto;border-radius:8px;"
        />
      </div>

      ${showLudo ? `<button
        type="button"
        data-ludo-play-card="1"
        ${isMember ? 'data-ludo-play-button="1"' : 'data-lobby-guest-auth-gate="1"'}
        aria-label="Играй Не се сърди човече"
        style="${card}display:block;width:100%;margin-top:14px;padding:8px;cursor:pointer;line-height:0;font:inherit;text-align:left;"
      ><img
          src="/images/games/ludo-banner.webp"
          alt="Не се сърди човече — играй"
          style="display:block;width:100%;height:auto;border-radius:8px;"
        /></button>` : ''}${showSvara ? `

      <div
        data-svara-play-card="1"
        data-svara-play-button="1"
        role="button"
        tabindex="0"
        aria-label="Свара"
        style="${card}margin-top:14px;padding:14px 16px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:12px;"
      >
        <div style="min-width:0;">
          <div style="color:#17233C;font-size:18px;font-weight:800;">Свара</div>
          <div style="margin-top:4px;color:#667085;font-size:12px;font-weight:700;">Тестов достъп · В разработка</div>
        </div>
        <span class="lobby-violet-btn" style="
          flex:0 0 auto;
          padding:9px 16px;
          border-radius:8px;
          color:#FFFFFF;
          font-size:14px;
          font-weight:800;
        ">ОТВОРИ</span>
      </div>` : ''}
    </article>
  `
}

// "Игри" — lobby sub-screen. Засега съдържа една feature-flagged карта:
// "Не се сърди човече" — кликуем банер (бутонът "ИГРАЙ" е нарисуван вътре
// в самото изображение), обвит в златната рамка на action-card езика от
// лобито (renderStakeSection и съседните rules/strategy карти).
//
// "Свара" — кликуем банер по същия модел ("ИГРАЙ" е в изображението), видим
// САМО при showSvara (server-derived session.svaraTestAccess, виж
// app/games/svara/svaraAccess.ts). При false HTML-ът изобщо не съдържа
// картата; самата страница /games/svara пак проверява достъпа в сървъра.

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
        aria-label="Играй Свара"
        style="
          margin-top:${useMobileLayout ? '14px' : '18px'};
          background:#000000;
          border:2px solid rgba(212,165,32,0.78);
          border-radius:14px;
          padding:0;
          overflow:hidden;
          cursor:pointer;
          line-height:0;
        "
      ><img
          src="/images/games/svara-banner.webp"
          alt="Свара — играй"
          style="display:block;width:100%;height:auto;border-radius:12px;"
        /></div>` : ''}
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
        aria-label="Играй Свара"
        style="${card}display:block;width:100%;margin-top:14px;padding:8px;cursor:pointer;line-height:0;"
      ><img
          src="/images/games/svara-banner.webp"
          alt="Свара — играй"
          style="display:block;width:100%;height:auto;border-radius:8px;"
        /></div>` : ''}
    </article>
  `
}

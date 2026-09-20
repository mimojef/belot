// "Игри" — lobby sub-screen. Засега съдържа една feature-flagged карта:
// "Не се сърди човече" — кликуем банер (бутонът "ИГРАЙ" е нарисуван вътре
// в самото изображение), обвит в златната рамка на action-card езика от
// лобито (renderStakeSection и съседните rules/strategy карти).

export function renderMoreGamesScreen(useMobileLayout = false, showLudo = true): string {
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
        /></div>` : ''}
    </article>
  `
}

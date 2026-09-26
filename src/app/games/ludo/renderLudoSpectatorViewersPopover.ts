// Viewer-indicator popover ("наднича във вашата игра") — лек floating panel
// (mirror на renderLudoBottomBar.ts's emoji picker стил, НЕ full-screen
// blocking modal като exit-confirm/game-end popup-ите — виж
// createLudoFlowController.ts::mountSpectatorViewersPopover doc коментара
// защо explicit НЕ минава през syncModalLayerInteractivity()). Позицията е
// fixed (не измерена от иконата runtime rect) — mobile/desktop offset-ите
// са изчислени спрямо известните header/badge размери (виж
// renderLudoGameScreen.ts renderLudoHeader/renderLudoSpectatorViewerIcon).

const esc = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

export function renderLudoSpectatorViewersPopoverHtml(
  viewers: Array<{ profileId: string; displayName: string }>,
  useMobileLayout: boolean,
): string {
  // Display name-ът е bold + златист (#d4a520 — established Pika.bg/Ludo
  // gold, виж renderLudoHeader-овия title label цвят и popover border-а
  // по-долу, СЪЩИЯТ RGB 212,165,32), останалият текст ("наднича във вашата
  // игра.") е нормален светъл текст (#f0e6cf, наследен от родителския div).
  // esc(viewer.displayName) остава единствената escaped ЧАСТ — самият
  // static суфикс никога не идва от viewer данни, затова е safe literal, не
  // unsafe innerHTML на непроверен низ.
  const rows = viewers
    .map(
      (viewer) =>
        `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#f0e6cf;font-size:13px;line-height:1.4;"><span style="font-weight:700;color:#d4a520;">${esc(viewer.displayName)}</span> наднича във вашата игра.</div>`,
    )
    .join('')
  // Offset-и, преизчислени СЛЕД иконата да порасне от 44px на 52px (виж
  // task-а "увеличи иконката" — стойностите тук останаха stale от старата
  // 44px итерация и щяха да causeват popover/icon overlap, хванато при
  // финалния audit):
  //   Desktop: header-ът е flex row с align-items:center, padding:14px 28px
  //   (28 общо вертикално) — content height-ът вече е самата икона (52px, по-
  //   висока от chess emoji-то/title text stack-а, ~37px преди), затова
  //   header-ът реално е ~14+52+14=80px висок (не старите документирани 69px,
  //   виж LUDO_DESKTOP_HEADER_HEIGHT_PX doc коментара в renderLudoGameScreen.ts
  //   за инвариант с board sizing formula-та — отделен въпрос, не пипан тук).
  //   84px offset разчиства новата header височина с малък gap.
  //   Mobile: badge-ът е absolute top:8px, 52px висок (виж
  //   LUDO_SPECTATOR_VIEWER_ICON_SIZE_PX в renderLudoGameScreen.ts) — bottom
  //   edge-ът му е на 8+52=60px, 68px offset разчиства с малък gap (старата
  //   стойност 36px беше stale от предишната 22-28px badge итерация и
  //   реално се застъпваше с новата, по-голяма икона).
  const topOffsetPx = useMobileLayout ? 68 : 84
  return `
    <div data-ludo-spectator-viewers-popover="1" style="
      position:fixed;
      top:${topOffsetPx}px;
      left:max(8px, env(safe-area-inset-left));
      z-index:1;
      max-width:min(280px, calc(100vw - 16px));
      max-height:min(320px, calc(100vh - ${topOffsetPx}px - 16px));
      overflow-y:auto;
      background:rgba(15,23,42,0.98);
      border:1px solid rgba(212,165,32,0.4);
      border-radius:12px;
      padding:10px 14px;
      box-shadow:0 12px 32px rgba(0,0,0,0.5);
      -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
      box-sizing:border-box;
    ">
      ${rows || '<div style="padding:8px 0;color:rgba(255,255,255,0.5);font-size:13px;">Няма зрители в момента.</div>'}
    </div>
  `
}

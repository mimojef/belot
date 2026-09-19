import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'

// prizeAmount: authoritative payout сума (от ludoEconomyStore.payoutLudoMatchWinner
// през LudoGameStateMessage.prizeAmount), НЕ клиентско изчисление — виж task
// spec §"END GAME UI / PRIZE": "UI числото трябва да идва от authoritative
// settlement/result, а НЕ клиентът сам да пресмята prize." Показва се само
// когато играчът реално е спечелил И award-ът вече е известен (може за кратко
// да е null между "status:finished" презентацията и пристигането на снимката
// със settlement резултата — следващият snapshot ще презареди popup текста).
export function renderLudoGameEndPopup(didLocalPlayerWin: boolean, prizeAmount: number | null): string {
  const prizeLine = didLocalPlayerWin && prizeAmount !== null
    ? `<div style="color:#f4c95b;font-size:16px;font-weight:900;line-height:1.4;margin-top:-10px;margin-bottom:22px;">Печелите ${prizeAmount.toLocaleString('bg-BG')} жълтици</div>`
    : ''
  return `
    <div data-ludo-game-end-backdrop="1" style="
      position:fixed; inset:0; z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
      background:rgba(2,6,23,0.68);
      display:flex; align-items:center; justify-content:center;
      padding:16px; box-sizing:border-box;
    ">
      <div role="dialog" aria-modal="true" aria-labelledby="ludo-game-end-title" style="
        width:min(360px, 100%);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:20px;
        padding:28px 24px 22px;
        text-align:center;
        box-shadow:0 20px 60px rgba(0,0,0,0.55);
      ">
        <div id="ludo-game-end-title" style="color:#f4f8ff;font-size:18px;font-weight:800;line-height:1.45;${prizeLine ? 'margin-bottom:10px;' : 'margin-bottom:22px;'}">
          ${didLocalPlayerWin ? 'Вие сте победител в играта!' : 'Вие загубихте играта.'}
        </div>
        ${prizeLine}
        <button type="button" data-ludo-game-end-dismiss="1" style="
          min-width:112px; padding:11px 28px;
          border:none; border-radius:10px;
          background:linear-gradient(135deg,#f4c95b 0%,#c98f13 100%);
          color:#000000; font-size:14px; font-weight:900;
          cursor:pointer;
        ">OK</button>
      </div>
    </div>
  `
}

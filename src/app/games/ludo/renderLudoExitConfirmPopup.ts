import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'

function formatStake(stake: number): string {
  return new Intl.NumberFormat('bg-BG', { useGrouping: 'always' }).format(stake)
}

export function renderLudoExitConfirmPopup(stake: number | null, isLeaving: boolean): string {
  const warning = stake === null
    ? 'Ако напуснете, ще загубите жълтиците, с които сте влезли в играта.'
    : `Ако напуснете, ще загубите ${formatStake(stake)} жълтици.`

  return `
    <div data-ludo-exit-confirm-backdrop="1" style="
      position:fixed; inset:0; z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
      background:rgba(2,6,23,0.68);
      display:flex; align-items:center; justify-content:center;
      padding:16px; box-sizing:border-box;
    ">
      <div role="dialog" aria-modal="true" aria-labelledby="ludo-exit-confirm-title" aria-describedby="ludo-exit-confirm-warning" style="
        width:min(390px, 100%);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:20px;
        padding:26px 22px 22px;
        text-align:center;
        box-shadow:0 20px 60px rgba(0,0,0,0.55);
      ">
        <div id="ludo-exit-confirm-title" style="color:#f4f8ff;font-size:18px;font-weight:800;line-height:1.45;">
          Сигурни ли сте, че искате да напуснете играта?
        </div>
        <div id="ludo-exit-confirm-warning" style="margin-top:12px;color:#fbbf24;font-size:14px;font-weight:600;line-height:1.5;">
          ${warning}
        </div>
        <div style="display:flex;justify-content:center;gap:10px;margin-top:24px;flex-wrap:wrap;">
          <button type="button" data-ludo-exit-confirm-cancel="1" ${isLeaving ? 'disabled' : ''} style="
            min-width:112px; min-height:42px; padding:10px 20px;
            border:1px solid rgba(255,255,255,0.18); border-radius:8px;
            background:#080808; color:#f8fafc; font-size:14px; font-weight:800;
            cursor:${isLeaving ? 'default' : 'pointer'}; opacity:${isLeaving ? '0.55' : '1'};
          ">Отказ</button>
          <button type="button" data-ludo-exit-confirm-submit="1" ${isLeaving ? 'disabled' : ''} style="
            min-width:112px; min-height:42px; padding:10px 20px;
            border:1px solid rgba(248,113,113,0.7); border-radius:8px;
            background:rgba(127,29,29,0.88); color:#fee2e2; font-size:14px; font-weight:900;
            cursor:${isLeaving ? 'wait' : 'pointer'}; opacity:${isLeaving ? '0.7' : '1'};
          ">${isLeaving ? 'Напускане...' : 'Напусни'}</button>
        </div>
      </div>
    </div>
  `
}

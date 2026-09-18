import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'

// Bot-takeover popup — reuse-ва Belot-овия УХ pattern (fixed scrim + centered
// card + robot съобщение + бутон), но е НОВ, Ludo-local компонент —
// НЕ import от src/app/activeRoom/ (виж Phase 3A audit-а: Belot popup-ите са
// private closures, тясно обвързани със Seat/RoomBiddingSnapshot типове,
// не safe за directen import в изолиран Ludo модул). Визуален стил е
// умишлено аналогичен (същия "Поради изтичане на времето..." message тон),
// но напълно независим markup/CSS, за да остане Ludo модулът изцяло
// self-contained (виж task-а т.15).
//
// Бутонът "Върни се" (виж task-а — reclaim flow) НЕ е чисто dismiss —
// createLudoFlowController.ts's click handler-ът маркира local player-а за
// safe "resume human control" (виж pendingHumanReclaimColor doc коментара
// там). Markup/размер/позиция/икона/цветове са НЕДОКОСНАТИ — само текстът и
// поведението зад click-а са различни.

export function renderLudoBotTakeoverPopup(): string {
  return `
    <div data-ludo-bot-takeover-backdrop="1" style="
      position:fixed; inset:0; z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
      background:rgba(2,6,23,0.62);
      display:flex; align-items:center; justify-content:center;
      padding:16px; box-sizing:border-box;
    ">
      <div style="
        width:min(360px, 100%);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:20px;
        padding:28px 24px 22px;
        text-align:center;
        box-shadow:0 20px 60px rgba(0,0,0,0.55);
      ">
        <div style="font-size:48px; line-height:1; margin-bottom:14px;">&#129302;</div>
        <div style="color:#f4f8ff; font-size:15px; font-weight:600; line-height:1.5; margin-bottom:20px;">
          Поради изтичане на времето за реакция,<br>играта беше поета от робот.
        </div>
        <button
          type="button"
          data-ludo-bot-takeover-dismiss="1"
          style="
            padding:11px 28px;
            border:none; border-radius:10px;
            background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
            color:#000000; font-size:14px; font-weight:900;
            letter-spacing:0.02em; text-transform:uppercase;
            cursor:pointer;
          "
        >Върни се</button>
      </div>
    </div>
  `
}

// "Долу картите" — OK/X popup, shown ONLY to the offered seat (the snapshot
// is already seat-gated server-side — see RoomSweepOfferSnapshot). Modeled
// directly on declarations/renderDeclarationPrompt.ts's fixed-overlay modal
// structure for visual/structural consistency with the rest of this screen.

const PROMPT_SELECTOR = '[data-sweep-offer-prompt-root="1"]'

// Responsive sizing: every value reaches its desktop size (the clamp max) at
// ~515px viewport width and above, and shrinks on phones (320–393px) so the
// popup stays compact over the table while OK/X stay ≥44px touch targets.
export const SWEEP_OFFER_POPUP_SIZING = {
  backdropPadding: 'clamp(12px, 4vw, 18px)',
  dialogWidth: 'clamp(220px, 70vw, 360px)',
  dialogPadding: 'clamp(14px, 4.4vw, 22px) clamp(12px, 3.6vw, 18px) clamp(12px, 3.6vw, 18px)',
  titleFontSize: 'clamp(22px, 6.6vw, 30px)',
  titleMarginBottom: 'clamp(12px, 4vw, 20px)',
  buttonGap: 'clamp(8px, 2.6vw, 12px)',
  buttonMinHeight: 'clamp(44px, 12.4vw, 56px)',
  declineFontSize: 'clamp(19px, 5.6vw, 24px)',
  acceptFontSize: 'clamp(18px, 5.2vw, 22px)',
} as const

export function removeSweepOfferPopup(root: ParentNode = document): void {
  root.querySelector(PROMPT_SELECTOR)?.remove()
}

export function renderSweepOfferPopup(params: {
  root: ParentNode
  onAccept: () => void
  onDecline: () => void
}): void {
  const { root, onAccept, onDecline } = params
  removeSweepOfferPopup(root)
  const sizing = SWEEP_OFFER_POPUP_SIZING

  const overlay = document.createElement('div')
  overlay.setAttribute('data-sweep-offer-prompt-root', '1')
  overlay.innerHTML = `
    <div
      style="
        position:fixed;
        inset:0;
        z-index:9999;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:${sizing.backdropPadding};
        background:rgba(0,0,0,0.58);
        box-sizing:border-box;
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Долу картите?"
        style="
          width:${sizing.dialogWidth};
          max-width:100%;
          box-sizing:border-box;
          border:3px solid rgba(245,166,35,0.9);
          border-radius:12px;
          background:linear-gradient(180deg, rgba(24,24,24,0.98) 0%, rgba(8,8,8,0.99) 100%);
          box-shadow:0 24px 60px rgba(0,0,0,0.36), 0 0 0 1px rgba(245,166,35,0.18);
          color:#f8fafc;
          padding:${sizing.dialogPadding};
          text-align:center;
        "
      >
        <div
          style="
            margin:0 0 ${sizing.titleMarginBottom};
            color:#f5a623;
            font-size:${sizing.titleFontSize};
            line-height:1.1;
            font-weight:900;
          "
        >Долу картите?</div>
        <div style="display:flex;gap:${sizing.buttonGap};">
          <button
            type="button"
            data-sweep-offer-decline="1"
            style="
              flex:1 1 0;
              min-height:${sizing.buttonMinHeight};
              border:2px solid rgba(248,250,252,0.35);
              border-radius:8px;
              background:rgba(30,30,30,0.9);
              color:#f8fafc;
              font-size:${sizing.declineFontSize};
              line-height:1;
              font-weight:900;
              cursor:pointer;
            "
            aria-label="Отказ"
          >X</button>
          <button
            type="button"
            data-sweep-offer-accept="1"
            style="
              flex:1 1 0;
              min-height:${sizing.buttonMinHeight};
              border:0;
              border-radius:8px;
              background:#f5a623;
              color:#101010;
              font-size:${sizing.acceptFontSize};
              line-height:1;
              font-weight:900;
              cursor:pointer;
              box-shadow:inset 0 -3px 0 rgba(0,0,0,0.14);
            "
          >OK</button>
        </div>
      </div>
    </div>
  `

  root.appendChild(overlay)

  overlay.querySelector<HTMLButtonElement>('[data-sweep-offer-accept="1"]')
    ?.addEventListener('click', () => {
      onAccept()
    })
  overlay.querySelector<HTMLButtonElement>('[data-sweep-offer-decline="1"]')
    ?.addEventListener('click', () => {
      onDecline()
    })
}

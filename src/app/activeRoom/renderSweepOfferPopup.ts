// "Долу картите" — OK/X popup, shown ONLY to the offered seat (the snapshot
// is already seat-gated server-side — see RoomSweepOfferSnapshot). Modeled
// directly on declarations/renderDeclarationPrompt.ts's fixed-overlay modal
// structure for visual/structural consistency with the rest of this screen.

const PROMPT_SELECTOR = '[data-sweep-offer-prompt-root="1"]'

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
        padding:18px;
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
          width:min(86vw,360px);
          box-sizing:border-box;
          border:3px solid rgba(245,166,35,0.9);
          border-radius:12px;
          background:linear-gradient(180deg, rgba(24,24,24,0.98) 0%, rgba(8,8,8,0.99) 100%);
          box-shadow:0 24px 60px rgba(0,0,0,0.36), 0 0 0 1px rgba(245,166,35,0.18);
          color:#f8fafc;
          padding:22px 18px 18px;
          text-align:center;
        "
      >
        <div
          style="
            margin:0 0 20px;
            color:#f5a623;
            font-size:30px;
            line-height:1.1;
            font-weight:900;
          "
        >Долу картите?</div>
        <div style="display:flex;gap:12px;">
          <button
            type="button"
            data-sweep-offer-decline="1"
            style="
              flex:1 1 0;
              min-height:56px;
              border:2px solid rgba(248,250,252,0.35);
              border-radius:8px;
              background:rgba(30,30,30,0.9);
              color:#f8fafc;
              font-size:24px;
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
              min-height:56px;
              border:0;
              border-radius:8px;
              background:#f5a623;
              color:#101010;
              font-size:22px;
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

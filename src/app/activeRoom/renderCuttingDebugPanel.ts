import {
  type RoomAuthoritativePhaseSnapshot,
  type RoomCuttingSnapshot,
  type Seat,
} from '../network/createGameServerClient'

type RenderCuttingDebugPanelOptions = {
  cuttingSnapshot: RoomCuttingSnapshot
  authoritativePhase: RoomAuthoritativePhaseSnapshot | null
  seatLabels: Record<Seat, string>
  escapeHtml: (value: string) => string
}

export function renderCuttingDebugPanel(
  options: RenderCuttingDebugPanelOptions,
): string {
  const { cuttingSnapshot, authoritativePhase, seatLabels, escapeHtml } = options

  return `
    <div
      style="
        border:1px solid rgba(148,163,184,0.18);
        border-radius:24px;
        padding:24px;
        background:rgba(15,23,42,0.72);
      "
    >
      <div
        style="
          font-size:12px;
          font-weight:900;
          letter-spacing:0.08em;
          text-transform:uppercase;
          color:#93c5fd;
          margin-bottom:16px;
        "
      >
        Cutting debug placeholder
      </div>

      <div
        style="
          display:grid;
          grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
          gap:12px;
          font-size:14px;
          color:#cbd5e1;
        "
      >
        <div><strong style="color:#f8fafc;">Authoritative phase:</strong> ${escapeHtml(authoritativePhase ?? '—')}</div>
        <div><strong style="color:#f8fafc;">Cutter seat:</strong> ${
          cuttingSnapshot.cutterSeat
            ? seatLabels[cuttingSnapshot.cutterSeat]
            : '—'
        }</div>
        <div><strong style="color:#f8fafc;">Selected cut index:</strong> ${
          cuttingSnapshot.selectedCutIndex ?? '—'
        }</div>
        <div><strong style="color:#f8fafc;">Deck count:</strong> ${cuttingSnapshot.deckCount}</div>
        <div><strong style="color:#f8fafc;">Can submit cut:</strong> ${
          cuttingSnapshot.canSubmitCut ? 'yes' : 'no'
        }</div>
      </div>

      ${
        cuttingSnapshot.canSubmitCut
          ? `
            <div
              style="
                margin-top:18px;
                font-size:13px;
                color:#cbd5e1;
              "
            >
              Избери временен cut index:
            </div>

            <div
              style="
                margin-top:14px;
                display:grid;
                grid-template-columns:repeat(auto-fit, minmax(72px, 1fr));
                gap:10px;
              "
            >
              ${Array.from(
                { length: Math.max(0, cuttingSnapshot.deckCount - 1) },
                (_, index) => index + 1,
              )
                .map(
                  (cutIndex) => `
                    <button
                      type="button"
                      data-active-room-cut-index="${cutIndex}"
                      style="
                        border:1px solid rgba(96,165,250,0.24);
                        border-radius:14px;
                        padding:12px 10px;
                        background:rgba(30,41,59,0.88);
                        color:#f8fafc;
                        font-size:14px;
                        font-weight:800;
                        cursor:pointer;
                      "
                    >
                      ${cutIndex}
                    </button>
                  `,
                )
                .join('')}
            </div>
          `
          : `
            <div
              style="
                margin-top:18px;
                font-size:13px;
                color:#cbd5e1;
              "
            >
              В момента този играч не може да подаде cut index.
            </div>
          `
      }
    </div>
  `
}

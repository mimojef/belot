export function renderTableBiddingPanel(phase, biddingControlsHtml = '') {
  if (phase !== 'bidding') {
    return ''
  }

  return `
    <div
      style="
        position: absolute;
        left: 50%;
        bottom: clamp(250px, 31vh, 380px);
        transform: translateX(-50%);
        width: min(92vw, 440px);
        padding: 10px;
        border-radius: 16px;
        background: rgba(17, 34, 56, 0.88);
        border: 2px solid #d79a1e;
        box-shadow: 0 14px 28px rgba(0,0,0,0.24);
        z-index: 8;
      "
    >
      ${biddingControlsHtml}
    </div>
  `
}
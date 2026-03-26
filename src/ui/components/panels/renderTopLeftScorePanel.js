import { formatAnnouncement, formatPlayerName } from '../../helpers/formatters.js'
import { getSuitSymbol } from '../../helpers/cards.js'

export function renderTopLeftScorePanel({ contract, trumpSuit, winningBidder, scores }) {
  const announcement = formatAnnouncement(contract, trumpSuit)
  const bidder = winningBidder ? formatPlayerName(winningBidder) : 'Няма'
  const symbol =
    contract === 'color'
      ? getSuitSymbol(trumpSuit)
      : contract === 'all-trumps'
        ? '★'
        : contract === 'no-trumps'
          ? '⦸'
          : ''

  return `
    <div
      style="
        position: absolute;
        top: clamp(10px, 1.4vw, 18px);
        left: clamp(10px, 1.4vw, 18px);
        width: clamp(140px, 12vw, 200px);
        border-radius: clamp(10px, 1vw, 16px);
        overflow: hidden;
        background: rgba(20, 36, 59, 0.88);
        box-shadow: 0 12px 28px rgba(0,0,0,0.22);
        z-index: 8;
      "
    >
      <div
        style="
          display:grid;
          grid-template-columns:1fr 1fr;
          padding: clamp(12px, 1vw, 16px);
          gap: 8px;
          text-align:center;
        "
      >
        <div>
          <div style="font-size: clamp(14px, 1.4vw, 24px); font-weight: 800; color: #f8fafc;">НИЕ</div>
          <div style="margin-top: 6px; font-size: clamp(20px, 2vw, 42px); color:#ffffff;">${scores.teamA ?? 0}</div>
        </div>

        <div>
          <div style="font-size: clamp(14px, 1.4vw, 24px); font-weight: 800; color: #f8fafc;">ВИЕ</div>
          <div style="margin-top: 6px; font-size: clamp(20px, 2vw, 42px); color:#ffffff;">${scores.teamB ?? 0}</div>
        </div>
      </div>

      <div
        style="
          min-height: clamp(28px, 2.6vw, 42px);
          background: #f2a81d;
          display:flex;
          align-items:center;
          gap: 8px;
          padding: 0 clamp(10px, 0.9vw, 14px);
          color:#ffffff;
          font-weight:700;
          font-size: clamp(12px, 1vw, 18px);
        "
      >
        <span style="font-size: clamp(15px, 1.3vw, 22px); line-height:1;">
          ${symbol}
        </span>
        <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
          ${announcement} ${winningBidder ? `• ${bidder}` : ''}
        </span>
      </div>
    </div>
  `
}

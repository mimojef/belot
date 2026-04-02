import type { PlayingViewState } from '../../core/state/getPlayingViewState'
import type { Card, Suit } from '../../core/state/gameTypes'

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function getSuitSymbol(suit: Suit): string {
  if (suit === 'clubs') return '♣'
  if (suit === 'diamonds') return '♦'
  if (suit === 'hearts') return '♥'
  return '♠'
}

function isRedSuit(suit: Suit): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function getPlayedCardOffset(index: number, count: number): {
  leftOffset: number
  topOffset: number
  rotate: number
} {
  const distance = index - (count - 1) / 2

  return {
    leftOffset: distance * 28,
    topOffset: Math.abs(distance) * 5,
    rotate: distance * 6,
  }
}

function renderPlayedCard(
  play: { card: Card },
  index: number,
  count: number
): string {
  const suitSymbol = getSuitSymbol(play.card.suit)
  const cardColor = isRedSuit(play.card.suit) ? '#b3261e' : '#13253d'
  const offset = getPlayedCardOffset(index, count)

  return `
    <div
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:112px;
        height:162px;
        margin-left:${-56 + offset.leftOffset}px;
        margin-top:${-81 + offset.topOffset}px;
        transform:rotate(${offset.rotate}deg);
        transform-origin:center center;
        z-index:${10 + index};
        pointer-events:none;
      "
    >
      <div
        style="
          position:absolute;
          inset:0;
          border-radius:14px;
          background:linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(241,245,250,0.99) 100%);
          box-shadow:
            0 16px 34px rgba(0,0,0,0.24),
            inset 0 1px 0 rgba(255,255,255,0.95),
            inset 0 -1px 0 rgba(0,0,0,0.05);
          border:1px solid rgba(21,48,82,0.10);
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:4px;
          border-radius:10px;
          border:1px solid rgba(20,49,84,0.12);
          background:linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,250,253,0.94) 100%);
        "
      ></div>

      <div
        style="
          position:absolute;
          left:9px;
          top:10px;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:1px;
          color:${cardColor};
          line-height:1;
        "
      >
        <span
          style="
            font-size:18px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${escapeHtml(String(play.card.rank))}
        </span>
        <span
          style="
            font-size:16px;
            font-weight:900;
          "
        >
          ${escapeHtml(suitSymbol)}
        </span>
      </div>

      <div
        style="
          position:absolute;
          right:9px;
          bottom:8px;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:1px;
          color:${cardColor};
          line-height:1;
          transform:rotate(180deg);
        "
      >
        <span
          style="
            font-size:18px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${escapeHtml(String(play.card.rank))}
        </span>
        <span
          style="
            font-size:16px;
            font-weight:900;
          "
        >
          ${escapeHtml(suitSymbol)}
        </span>
      </div>

      <div
        style="
          position:absolute;
          left:50%;
          top:54%;
          transform:translate(-50%, -50%);
          color:${cardColor};
          font-size:42px;
          line-height:1;
          font-weight:900;
          text-shadow:0 2px 6px rgba(0,0,0,0.08);
        "
      >
        ${escapeHtml(suitSymbol)}
      </div>
    </div>
  `
}

function renderCenterTrick(viewState: PlayingViewState): string {
  return `
    <div
      style="
        position:relative;
        width:420px;
        height:260px;
        margin:0 auto;
        background:transparent;
        pointer-events:none;
      "
    >
      ${viewState.plays
        .map((play, index) => renderPlayedCard(play, index, viewState.plays.length))
        .join('')}
    </div>
  `
}

export function renderPlayingPanel(viewState: PlayingViewState): string {
  return renderCenterTrick(viewState)
}
import type { PlayingViewState } from '../../core/state/getPlayingViewState'
import type { Seat } from '../../data/constants/seatOrder'
import type { Card, Suit } from '../../core/state/gameTypes'
import { createGameAudioController } from '../../app/audio/createGameAudioController'

let lastRenderedTrickStateKey: string | null = null

const gameAudio = createGameAudioController()

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeHtmlAttribute(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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

function getSeatCardOffset(seat: Seat): {
  leftOffset: number
  topOffset: number
  rotate: number
} {
  if (seat === 'top') {
    return { leftOffset: 0, topOffset: -54, rotate: 0 }
  }

  if (seat === 'left') {
    return { leftOffset: -78, topOffset: 0, rotate: -8 }
  }

  if (seat === 'right') {
    return { leftOffset: 78, topOffset: 0, rotate: 8 }
  }

  return { leftOffset: 0, topOffset: 54, rotate: 0 }
}

function getPlayOrderSpread(index: number, count: number): {
  leftOffset: number
  topOffset: number
  rotate: number
} {
  const distance = index - (count - 1) / 2

  return {
    leftOffset: distance * 8,
    topOffset: Math.abs(distance) * 3,
    rotate: distance * 2,
  }
}

function getEntryOffsetBySeat(seat: Seat): { x: number; y: number } {
  if (seat === 'top') {
    return { x: 0, y: -170 }
  }

  if (seat === 'left') {
    return { x: -190, y: 0 }
  }

  if (seat === 'right') {
    return { x: 190, y: 0 }
  }

  return { x: 0, y: 190 }
}

function getCurrentTrickStateKey(viewState: PlayingViewState): string {
  return viewState.plays
    .map((play) => `${play.seat}:${play.card.id}`)
    .join('|')
}

function renderPlayTarget(seat: Seat): string {
  const seatOffset = getSeatCardOffset(seat)

  return `
    <div
      data-play-target-seat="${seat}"
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:148px;
        height:215px;
        margin-left:${-56 + seatOffset.leftOffset}px;
        margin-top:${-81 + seatOffset.topOffset}px;
        transform:rotate(${seatOffset.rotate}deg);
        transform-origin:center center;
        opacity:0;
        pointer-events:none;
        z-index:0;
      "
    ></div>
  `
}

function getEntryAnimationStyle(
  play: { seat: Seat },
  index: number,
  count: number,
  finalRotate: number,
  shouldAnimateNewestCard: boolean
): string {
  const isNewestCard = index === count - 1

  if (!isNewestCard || !shouldAnimateNewestCard) {
    return 'opacity:1;'
  }

  const entryOffset = getEntryOffsetBySeat(play.seat)

  return `
    --belot-entry-x:${entryOffset.x}px;
    --belot-entry-y:${entryOffset.y}px;
    --belot-final-rotate:${finalRotate}deg;
    animation: belot-play-card-entry 400ms cubic-bezier(0.22, 1, 0.36, 1) forwards;
    opacity:1;
  `
}

function renderPlayedCard(
  play: { seat: Seat; card: Card },
  index: number,
  count: number,
  shouldAnimateNewestCard: boolean
): string {
  const suitSymbol = getSuitSymbol(play.card.suit)
  const cardColor = isRedSuit(play.card.suit) ? '#b3261e' : '#13253d'
  const seatOffset = getSeatCardOffset(play.seat)
  const orderSpread = getPlayOrderSpread(index, count)

  const finalLeft = seatOffset.leftOffset + orderSpread.leftOffset
  const finalTop = seatOffset.topOffset + orderSpread.topOffset
  const finalRotate = seatOffset.rotate + orderSpread.rotate
  const animationStyle = getEntryAnimationStyle(
    play,
    index,
    count,
    finalRotate,
    shouldAnimateNewestCard
  )

  return `
    <div
      data-current-trick-card="1"
      data-trick-card="1"
      data-played-card="1"
      data-trick-seat="${play.seat}"
      data-card-id="${escapeHtmlAttribute(play.card.id)}"
      style="
  position:absolute;
  left:50%;
  top:50%;
  width:148px;
  height:215px;
  margin-left:${-56 + finalLeft}px;
  margin-top:${-81 + finalTop}px;
  transform:translate(0px, 0px) rotate(${finalRotate}deg) scale(1);
  transform-origin:center center;
  backface-visibility:hidden;
  will-change:transform;
  z-index:${10 + index};
  pointer-events:none;
  ${animationStyle}
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
            font-size:30px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${escapeHtml(String(play.card.rank))}
        </span>
        <span
          style="
            font-size:45px;
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
            font-size:30px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${escapeHtml(String(play.card.rank))}
        </span>
        <span
          style="
            font-size:45px;
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
          font-size:54px;
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
  const trickStateKey = getCurrentTrickStateKey(viewState)
  const shouldAnimateNewestCard =
    viewState.plays.length > 0 &&
    viewState.plays.length < 4 &&
    trickStateKey !== lastRenderedTrickStateKey

  if (shouldAnimateNewestCard) {
    gameAudio.playCardMove()
  }

  const html = `
    <style>
      @keyframes belot-play-card-entry {
        0% {
          opacity: 1;
          transform:
            translate(var(--belot-entry-x), var(--belot-entry-y))
            rotate(var(--belot-final-rotate))
            scale(1.42);
        }
        100% {
          opacity: 1;
          transform:
            translate(0px, 0px)
            rotate(var(--belot-final-rotate))
            scale(1);
        }
      }
    </style>

    <div
      data-current-trick="1"
      data-trick-area="1"
      style="
        position:relative;
        width:420px;
        height:260px;
        margin:0 auto;
        background:transparent;
        pointer-events:none;
      "
    >
      ${renderPlayTarget('bottom')}
      ${renderPlayTarget('left')}
      ${renderPlayTarget('top')}
      ${renderPlayTarget('right')}
      ${viewState.plays
        .map((play, index) =>
          renderPlayedCard(
            play,
            index,
            viewState.plays.length,
            shouldAnimateNewestCard
          )
        )
        .join('')}
    </div>
  `

  lastRenderedTrickStateKey = trickStateKey || null
  return html
}

export function renderPlayingPanel(viewState: PlayingViewState): string {
  return renderCenterTrick(viewState)
}

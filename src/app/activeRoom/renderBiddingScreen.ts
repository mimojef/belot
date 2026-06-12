import type {
  RoomBiddingSnapshot,
  RoomBidActionSnapshot,
  RoomValidBidActionsSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { ACTIVE_ROOM_TABLE_STAGE_BACKGROUND } from './activeRoomShared'
import { renderPile, getPileVisibleCards } from './renderDealingScreen'

export const BID_HUMAN_TIMEOUT_MS = 20_000
export const BID_BOT_DELAY_MS = 800

export type RenderBiddingScreenOptions = {
  biddingSnapshot: RoomBiddingSnapshot
  isPendingSubmission: boolean
  showBidPopup: boolean
  animateBidPopup: boolean
  showBotTakeover: boolean
  stageScale: number
}

export function getBidActionLabel(action: RoomBidActionSnapshot): string {
  if (action.type === 'pass') return 'Пас'
  if (action.type === 'no-trumps') return 'Без коз'
  if (action.type === 'all-trumps') return 'Всичко коз'
  if (action.type === 'double') return 'Контра'
  if (action.type === 'redouble') return 'Реконтра'
  if (action.type === 'suit') {
    if (action.suit === 'clubs') return '♣ Спатия'
    if (action.suit === 'diamonds') return '♦ Каро'
    if (action.suit === 'hearts') return '♥ Купа'
    return '♠ Пика'
  }
  return ''
}

function getWinningBidLabel(winningBid: RoomWinningBidSnapshot): string {
  if (!winningBid) return ''
  const contractLabel =
    winningBid.contract === 'suit'
      ? getBidActionLabel({ type: 'suit', suit: winningBid.trumpSuit! })
      : winningBid.contract === 'no-trumps'
        ? 'Без коз'
        : 'Всичко коз'
  const doubleLabel = winningBid.redoubled ? ' (реконтра)' : winningBid.doubled ? ' (контра)' : ''
  return contractLabel + doubleLabel
}

export function renderBiddingStageHtml(
  winningBid: RoomWinningBidSnapshot,
  currentBidderSeat: Seat | null,
  handCounts: Record<Seat, number>,
): string {
  const phaseStatus =
    currentBidderSeat !== null ? 'Чака се следващата обява' : 'Обявяването приключи'
  const winningBidLabel = winningBid
    ? `Водеща обява: ${getWinningBidLabel(winningBid)}`
    : 'Все още няма водеща обява'

  return `
    <section
      style="
        position:relative;
        width:100%;
        height:100%;
        background:${ACTIVE_ROOM_TABLE_STAGE_BACKGROUND};
        overflow:visible;
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:58px;
          transform:translateX(-50%);
          min-width:320px;
          max-width:min(88vw, 520px);
          padding:14px 18px;
          border-radius:18px;
          background:rgba(10,10,10,0.84);
          border:1px solid rgba(220,163,58,0.46);
          box-shadow:0 16px 34px rgba(0,0,0,0.24);
          text-align:center;
          color:#eff6ff;
          z-index:2;
          pointer-events:none;
          font-family:Inter, system-ui, sans-serif;
        "
      >
        <div
          style="
            font-size:11px;
            font-weight:800;
            letter-spacing:0.10em;
            text-transform:uppercase;
            color:rgba(244,182,58,0.92);
          "
        >
          Обявяване
        </div>
        <div
          style="
            margin-top:6px;
            font-size:21px;
            font-weight:800;
            line-height:1.2;
            color:#ffffff;
          "
        >
          ${phaseStatus}
        </div>
        <div
          style="
            margin-top:6px;
            font-size:14px;
            line-height:1.35;
            color:rgba(226,232,240,0.96);
          "
        >
          ${winningBidLabel}
        </div>
      </div>
      ${renderPile(getPileVisibleCards(handCounts))}
    </section>
  `
}

function renderBidTile(options: {
  symbol: string
  label: string
  dataAction: string
  enabled: boolean
  symbolColor?: string
}): string {
  const { symbol, label, dataAction, enabled, symbolColor = '#111827' } = options
  return `
    <button
      type="button"
      ${dataAction}
      ${enabled ? '' : 'disabled'}
      style="
        min-height:72px;
        border:0;
        border-radius:10px;
        padding:6px 8px;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:4px;
        cursor:${enabled ? 'pointer' : 'not-allowed'};
        background:${enabled ? 'rgba(255,255,255,0.92)' : 'rgba(56,56,56,0.58)'};
        box-shadow:inset 0 0 0 1px ${enabled ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.04)'};
        transition:filter 120ms ease;
        font-family:inherit;
      "
      onmouseover="${enabled ? "this.style.filter='brightness(0.97)'" : ''}"
      onmouseout="${enabled ? "this.style.filter=''" : ''}"
    >
      <span style="
        font-size:38px;
        line-height:1;
        font-weight:800;
        color:${enabled ? symbolColor : 'rgba(31,41,55,0.18)'};
      ">${symbol}</span>
      <span style="
        font-size:13px;
        line-height:1.05;
        font-weight:600;
        text-transform:uppercase;
        color:${enabled ? '#2f3745' : 'rgba(31,41,55,0.22)'};
      ">${label}</span>
    </button>
  `
}

function renderPassButton(enabled: boolean): string {
  return `
    <button
      type="button"
      data-bid-action="pass"
      ${enabled ? '' : 'disabled'}
      style="
        width:100%;
        min-height:56px;
        border:0;
        border-radius:10px;
        cursor:${enabled ? 'pointer' : 'not-allowed'};
        background:${enabled ? '#f5ad1c' : 'rgba(245,173,28,0.40)'};
        color:${enabled ? '#fff' : 'rgba(255,255,255,0.50)'};
        font-size:30px;
        line-height:1;
        font-weight:600;
        text-transform:uppercase;
        font-family:inherit;
        box-shadow:inset 0 0 0 1px ${enabled ? 'rgba(120,53,15,0.14)' : 'rgba(120,53,15,0.08)'};
        transition:filter 120ms ease;
      "
      onmouseover="${enabled ? "this.style.filter='brightness(1.04)'" : ''}"
      onmouseout="${enabled ? "this.style.filter=''" : ''}"
    >
      Пас
    </button>
  `
}

function renderBidPopup(
  validActions: RoomValidBidActionsSnapshot,
  isPendingSubmission: boolean,
  shouldAnimateEnter: boolean,
  stageScale: number,
): string {
  const disabled = isPendingSubmission
  const opacity = disabled ? '0.7' : '1'
  const filter = disabled ? 'saturate(0.92)' : 'none'
  const enterScale = stageScale * (shouldAnimateEnter ? 0.96 : 1)

  const suits = validActions.suits

  return `
    <div
      data-bidding-popup="1"
      data-bidding-popup-enter="${shouldAnimateEnter ? '1' : '0'}"
      data-bidding-popup-final-opacity="${opacity}"
      data-bidding-popup-final-filter="${filter}"
      data-bidding-popup-stage-scale="${stageScale}"
      style="
        position:fixed;
        bottom:${260 * stageScale}px;
        left:50%;
        transform:translateX(-50%) scale(${enterScale});
        transform-origin:bottom center;
        width:400px;
        padding:5px;
        border-radius:14px;
        background:rgba(10,10,10,0.92);
        border:2px solid #f5ad1c;
        box-shadow:
          0 20px 48px rgba(0,0,0,0.36),
          inset 0 0 0 1px rgba(244,182,58,0.18);
        z-index:10;
        pointer-events:${disabled ? 'none' : 'auto'};
        opacity:${shouldAnimateEnter ? '0' : opacity};
        transition:opacity 280ms ease, transform 280ms ease, filter 280ms ease;
        will-change:opacity, transform, filter;
        filter:${shouldAnimateEnter ? 'saturate(0.9)' : filter};
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div style="
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:5px;
        margin-bottom:5px;
      ">
        ${renderBidTile({ symbol: '♣', label: 'Спатия', dataAction: 'data-bid-suit="clubs"', enabled: suits.clubs && !disabled, symbolColor: '#1f1720' })}
        ${renderBidTile({ symbol: 'A', label: 'Без коз', dataAction: 'data-bid-action="no-trumps"', enabled: validActions.noTrumps && !disabled, symbolColor: '#111111' })}
        ${renderBidTile({ symbol: '♦', label: 'Каро', dataAction: 'data-bid-suit="diamonds"', enabled: suits.diamonds && !disabled, symbolColor: '#dc2626' })}
        ${renderBidTile({ symbol: 'J', label: 'Всичко коз', dataAction: 'data-bid-action="all-trumps"', enabled: validActions.allTrumps && !disabled, symbolColor: '#dc2626' })}
        ${renderBidTile({ symbol: '♥', label: 'Купа', dataAction: 'data-bid-suit="hearts"', enabled: suits.hearts && !disabled, symbolColor: '#dc2626' })}
        ${renderBidTile({ symbol: 'x2', label: 'Контра', dataAction: 'data-bid-action="double"', enabled: validActions.double && !disabled, symbolColor: '#dc2626' })}
        ${renderBidTile({ symbol: '♠', label: 'Пика', dataAction: 'data-bid-suit="spades"', enabled: suits.spades && !disabled, symbolColor: '#1f1720' })}
        ${renderBidTile({ symbol: 'x4', label: 'Реконтра', dataAction: 'data-bid-action="redouble"', enabled: validActions.redouble && !disabled, symbolColor: '#dc2626' })}
      </div>
      ${renderPassButton(validActions.pass && !disabled)}
    </div>
  `
}

function renderBotTakeoverPopup(): string {
  return `
    <div
      data-bot-takeover-overlay="1"
      style="
        position:fixed;
        inset:0;
        z-index:20;
        display:flex;
        align-items:center;
        justify-content:center;
        background:rgba(0,0,0,0.66);
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div style="
        width:min(88vw, 480px);
        background:rgba(12,12,12,0.98);
        border:1px solid rgba(220,163,58,0.52);
        border-radius:24px;
        padding:32px 28px;
        box-shadow:0 32px 72px rgba(0,0,0,0.42);
        text-align:center;
      ">
        <img
          src="/images/ui/robot_100x100.png"
          alt="Robot"
          style="
            width:64px;
            height:64px;
            object-fit:contain;
            margin-bottom:18px;
            filter:drop-shadow(0 10px 18px rgba(0,0,0,0.28));
          "
        >
        <div style="
          color:#f8fafc;
          font-size:18px;
          font-weight:700;
          line-height:1.5;
          margin-bottom:28px;
        ">
          Поради изтичане на времето за реакция,<br>играта беше поета от робот.
        </div>
        <button
          type="button"
          data-bot-takeover-dismiss="1"
          style="
            border:0;
            border-radius:14px;
            padding:14px 32px;
            background:linear-gradient(180deg,#f5ad1c 0%,#d49412 100%);
            color:#101010;
            font-size:16px;
            font-weight:800;
            cursor:pointer;
            font-family:inherit;
            box-shadow:0 8px 20px rgba(245,173,28,0.28);
          "
        >
          Върни се
        </button>
      </div>
    </div>
  `
}

export function createBiddingInteractionHtml(options: RenderBiddingScreenOptions): string {
  const { biddingSnapshot, isPendingSubmission, showBidPopup, animateBidPopup, showBotTakeover, stageScale } = options

  const popupHtml =
    showBidPopup && biddingSnapshot.canSubmitBid && biddingSnapshot.validActions
      ? renderBidPopup(biddingSnapshot.validActions, isPendingSubmission, animateBidPopup, stageScale)
      : ''

  const botTakeoverHtml = showBotTakeover ? renderBotTakeoverPopup() : ''

  if (!popupHtml && !botTakeoverHtml) return ''

  return `${popupHtml}${botTakeoverHtml}`
}

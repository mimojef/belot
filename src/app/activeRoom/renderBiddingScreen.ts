import type {
  RoomBiddingSnapshot,
  RoomBidActionSnapshot,
  RoomValidBidActionsSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'

export const BID_HUMAN_TIMEOUT_MS = 15_000

export type RenderBiddingScreenOptions = {
  biddingSnapshot: RoomBiddingSnapshot
  timerDeadlineAt: number | null
  isPendingSubmission: boolean
  showBotTakeover: boolean
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
): string {
  const seatLabels: Record<Seat, string> = {
    bottom: 'ТИ',
    right: 'ДЯСНО',
    top: 'ГОРЕ',
    left: 'ЛЯВО',
  }

  const bidderLabel = currentBidderSeat ? seatLabels[currentBidderSeat] : null
  const winLabel = getWinningBidLabel(winningBid)

  return `
    <section
      style="
        position:relative;
        width:100%;
        height:100%;
        background:
          radial-gradient(circle at center, rgba(74,222,128,0.22) 0%, rgba(34,197,94,0.12) 32%, rgba(21,128,61,0.00) 58%),
          linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
        overflow:visible;
        display:flex;
        align-items:center;
        justify-content:center;
      "
    >
      <div style="text-align:center;pointer-events:none;user-select:none;">
        ${
          winLabel
            ? `
              <div style="
                color:rgba(255,255,255,0.55);
                font-size:13px;
                font-weight:800;
                letter-spacing:0.1em;
                text-transform:uppercase;
                margin-bottom:8px;
              ">Текуща обява</div>
              <div style="
                color:#fbbf24;
                font-size:42px;
                font-weight:900;
                letter-spacing:0.02em;
                text-shadow:0 2px 12px rgba(0,0,0,0.4);
              ">${winLabel}</div>
            `
            : `
              <div style="
                color:rgba(255,255,255,0.30);
                font-size:15px;
                font-weight:800;
                letter-spacing:0.1em;
                text-transform:uppercase;
              ">Обявяване</div>
            `
        }
        ${
          bidderLabel
            ? `
              <div style="
                margin-top:14px;
                color:rgba(255,255,255,0.46);
                font-size:13px;
                font-weight:700;
                letter-spacing:0.06em;
              ">Обявява: ${bidderLabel}</div>
            `
            : ''
        }
      </div>
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
        min-height:88px;
        border:0;
        border-radius:10px;
        padding:8px 10px;
        display:flex;
        flex-direction:column;
        align-items:center;
        justify-content:center;
        gap:4px;
        cursor:${enabled ? 'pointer' : 'not-allowed'};
        background:${enabled ? 'rgba(255,255,255,0.92)' : 'rgba(100,116,139,0.52)'};
        box-shadow:inset 0 0 0 1px ${enabled ? 'rgba(15,23,42,0.10)' : 'rgba(15,23,42,0.06)'};
        transition:filter 120ms ease;
        font-family:inherit;
      "
      onmouseover="${enabled ? "this.style.filter='brightness(0.97)'" : ''}"
      onmouseout="${enabled ? "this.style.filter=''" : ''}"
    >
      <span style="
        font-size:48px;
        line-height:1;
        font-weight:800;
        color:${enabled ? symbolColor : 'rgba(31,41,55,0.18)'};
      ">${symbol}</span>
      <span style="
        font-size:16px;
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
        min-height:72px;
        border:0;
        border-radius:10px;
        cursor:${enabled ? 'pointer' : 'not-allowed'};
        background:${enabled ? '#f5ad1c' : 'rgba(245,173,28,0.40)'};
        color:${enabled ? '#fff' : 'rgba(255,255,255,0.50)'};
        font-size:40px;
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

function renderCountdownBar(timerDeadlineAt: number | null): string {
  if (timerDeadlineAt === null) return ''
  const remainingMs = Math.max(0, timerDeadlineAt - Date.now())
  const elapsedMs = BID_HUMAN_TIMEOUT_MS - remainingMs

  return `
    <div style="
      width:100%;
      height:5px;
      border-radius:3px 3px 0 0;
      background:rgba(255,255,255,0.12);
      overflow:hidden;
      margin-bottom:6px;
    ">
      <style>
        @keyframes bid-countdown-bar {
          0% { transform:scaleX(1); }
          100% { transform:scaleX(0); }
        }
      </style>
      <div style="
        height:100%;
        background:linear-gradient(90deg, #fbbf24 0%, #f59e0b 100%);
        transform-origin:left center;
        animation:bid-countdown-bar ${BID_HUMAN_TIMEOUT_MS}ms linear forwards;
        animation-delay:-${Math.round(elapsedMs)}ms;
        animation-fill-mode:both;
      "></div>
    </div>
  `
}

function renderBidPopup(
  validActions: RoomValidBidActionsSnapshot,
  timerDeadlineAt: number | null,
  isPendingSubmission: boolean,
): string {
  const disabled = isPendingSubmission

  const suits = validActions.suits

  return `
    <div
      data-bidding-popup="1"
      style="
        position:fixed;
        bottom:168px;
        left:50%;
        transform:translateX(-50%);
        width:min(92vw, 440px);
        padding:6px;
        border-radius:14px;
        background:rgba(13,34,64,0.88);
        border:2px solid #f5ad1c;
        box-shadow:
          0 20px 48px rgba(0,0,0,0.36),
          inset 0 0 0 1px rgba(255,255,255,0.05);
        z-index:10;
        pointer-events:${disabled ? 'none' : 'auto'};
        opacity:${disabled ? '0.7' : '1'};
        font-family:Inter, system-ui, sans-serif;
      "
    >
      ${renderCountdownBar(timerDeadlineAt)}
      <div style="
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:6px;
        margin-bottom:6px;
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
        background:rgba(2,6,23,0.62);
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div style="
        width:min(88vw, 480px);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(148,163,184,0.22);
        border-radius:24px;
        padding:32px 28px;
        box-shadow:0 32px 72px rgba(0,0,0,0.42);
        text-align:center;
      ">
        <div style="
          font-size:40px;
          margin-bottom:18px;
          line-height:1;
        ">🤖</div>
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
            background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 100%);
            color:#fff;
            font-size:16px;
            font-weight:800;
            cursor:pointer;
            font-family:inherit;
            box-shadow:0 8px 20px rgba(29,78,216,0.32);
          "
        >
          Върни се
        </button>
      </div>
    </div>
  `
}

export function createBiddingInteractionHtml(options: RenderBiddingScreenOptions): string {
  const { biddingSnapshot, timerDeadlineAt, isPendingSubmission, showBotTakeover } = options

  const popupHtml =
    biddingSnapshot.canSubmitBid && biddingSnapshot.validActions
      ? renderBidPopup(biddingSnapshot.validActions, timerDeadlineAt, isPendingSubmission)
      : ''

  const botTakeoverHtml = showBotTakeover ? renderBotTakeoverPopup() : ''

  if (!popupHtml && !botTakeoverHtml) return ''

  return `${popupHtml}${botTakeoverHtml}`
}

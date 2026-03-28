import type { BiddingViewState } from '../../core/state/getBiddingViewState'
import type { Seat } from '../../data/constants/seatOrder'
import type { Suit, WinningBid } from '../../core/state/gameTypes'

function formatSeat(seat: Seat | null): string {
  if (seat === 'bottom') return 'Долу'
  if (seat === 'right') return 'Дясно'
  if (seat === 'top') return 'Горе'
  if (seat === 'left') return 'Ляво'
  return '—'
}

function formatSuit(suit: Suit): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  return 'Пика'
}

function formatWinningBid(winningBid: WinningBid): string {
  if (!winningBid) {
    return 'Все още няма обява'
  }

  let label = ''

  if (winningBid.contract === 'suit' && winningBid.trumpSuit) {
    label = formatSuit(winningBid.trumpSuit)
  }

  if (winningBid.contract === 'no-trumps') {
    label = 'Без коз'
  }

  if (winningBid.contract === 'all-trumps') {
    label = 'Всичко коз'
  }

  if (winningBid.doubled) {
    label += ' / Контра'
  }

  if (winningBid.redoubled) {
    label += ' / Ре контра'
  }

  return `${label} — ${formatSeat(winningBid.seat)}`
}

function renderBidButton(
  label: string,
  action: string,
  value: string,
  enabled: boolean
): string {
  const extraAttributes =
    action === 'bid-suit' ? `data-suit="${value}" data-bid-suit="${value}"` : ''

  return `
    <button
      type="button"
      data-action="${action}"
      data-value="${value}"
      ${extraAttributes}
      ${enabled ? '' : 'disabled'}
      style="
        border: 0;
        border-radius: 10px;
        padding: 12px 16px;
        font-weight: 700;
        cursor: ${enabled ? 'pointer' : 'not-allowed'};
        opacity: ${enabled ? '1' : '0.45'};
        background: ${enabled ? '#e5e7eb' : '#94a3b8'};
        color: #0f172a;
      "
    >
      ${label}
    </button>
  `
}

export function renderBiddingPanel(biddingViewState: BiddingViewState): string {
  if (!biddingViewState) {
    return ''
  }

  const { currentSeat, validActions, winningBid } = biddingViewState

  return `
    <div style="max-width: 920px; margin-bottom: 16px;">
      <div style="padding: 16px; border-radius: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); margin-bottom: 12px;">
        <div style="margin-bottom: 8px;"><strong>На ход:</strong> ${formatSeat(currentSeat)}</div>
        <div><strong>Текуща най-силна обява:</strong> ${formatWinningBid(winningBid)}</div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 10px;">
        ${renderBidButton('Спатия', 'bid-suit', 'clubs', validActions.suits.clubs)}
        ${renderBidButton('Каро', 'bid-suit', 'diamonds', validActions.suits.diamonds)}
        ${renderBidButton('Купа', 'bid-suit', 'hearts', validActions.suits.hearts)}
        ${renderBidButton('Пика', 'bid-suit', 'spades', validActions.suits.spades)}
        ${renderBidButton('Без коз', 'bid-no-trumps', 'no-trumps', validActions.noTrumps)}
        ${renderBidButton('Всичко коз', 'bid-all-trumps', 'all-trumps', validActions.allTrumps)}
        ${renderBidButton('Контра', 'bid-double', 'double', validActions.double)}
        ${renderBidButton('Ре контра', 'bid-redouble', 'redouble', validActions.redouble)}
        ${renderBidButton('Пас', 'bid-pass', 'pass', validActions.pass)}
      </div>
    </div>
  `
}
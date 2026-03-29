import type { PlayingViewState } from '../../core/state/getPlayingViewState'
import type { Seat } from '../../data/constants/seatOrder'
import type { Card, Suit, WinningBid } from '../../core/state/gameTypes'

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

function formatCard(card: Card): string {
  return `${card.rank} ${formatSuit(card.suit)}`
}

function formatWinningBid(winningBid: WinningBid): string {
  if (!winningBid) {
    return 'Няма активна обява'
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

function renderPlayedCards(viewState: PlayingViewState): string {
  if (viewState.plays.length === 0) {
    return `
      <div style="opacity: 0.7;">
        Все още няма изиграни карти в тази взятка.
      </div>
    `
  }

  return `
    <div style="display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px;">
      ${viewState.plays
        .map(
          (play) => `
            <div
              style="
                padding: 12px 14px;
                border-radius: 10px;
                background: rgba(255,255,255,0.05);
                border: 1px solid rgba(255,255,255,0.12);
              "
            >
              <div style="margin-bottom: 6px; font-weight: 700;">${formatSeat(play.seat)}</div>
              <div>${formatCard(play.card)}</div>
            </div>
          `
        )
        .join('')}
    </div>
  `
}

function renderBottomHand(viewState: PlayingViewState): string {
  if (viewState.bottomHand.length === 0) {
    return `
      <div style="opacity: 0.7;">
        Няма карти в ръката.
      </div>
    `
  }

  return `
    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
      ${viewState.bottomHand
        .map((card) => {
          const isPlayable =
            viewState.isBottomTurn &&
            viewState.validBottomCardIds.includes(card.id)

          return `
            <button
              type="button"
              data-action="play-card"
              data-card-id="${card.id}"
              ${isPlayable ? '' : 'disabled'}
              style="
                border: 0;
                border-radius: 10px;
                padding: 12px 14px;
                font-weight: 700;
                cursor: ${isPlayable ? 'pointer' : 'not-allowed'};
                opacity: ${isPlayable ? '1' : '0.5'};
                background: ${isPlayable ? '#e5e7eb' : '#94a3b8'};
                color: #0f172a;
                min-width: 110px;
              "
            >
              ${formatCard(card)}
            </button>
          `
        })
        .join('')}
    </div>
  `
}

export function renderPlayingPanel(viewState: PlayingViewState): string {
  return `
    <div style="max-width: 920px; margin-bottom: 16px;">
      <div
        style="
          padding: 16px;
          border-radius: 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          margin-bottom: 12px;
        "
      >
        <div style="margin-bottom: 8px;"><strong>Фаза:</strong> Игра</div>
        <div style="margin-bottom: 8px;"><strong>На ход:</strong> ${formatSeat(viewState.currentTurnSeat)}</div>
        <div style="margin-bottom: 8px;"><strong>Води:</strong> ${formatSeat(viewState.leaderSeat)}</div>
        <div style="margin-bottom: 8px;"><strong>Взятка:</strong> ${viewState.trickIndex + 1}</div>
        <div><strong>Договор:</strong> ${formatWinningBid(viewState.winningBid)}</div>
      </div>

      <div
        style="
          padding: 16px;
          border-radius: 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
          margin-bottom: 12px;
        "
      >
        <div style="margin-bottom: 10px; font-weight: 700;">Текуща взятка</div>
        ${renderPlayedCards(viewState)}
      </div>

      <div
        style="
          padding: 16px;
          border-radius: 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
        "
      >
        <div style="margin-bottom: 10px; font-weight: 700;">Твоите карти</div>
        ${renderBottomHand(viewState)}
      </div>
    </div>
  `
}
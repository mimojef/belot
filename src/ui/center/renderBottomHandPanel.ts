import type { BottomHandViewState } from '../../core/state/getBottomHandViewState'
import type { Card, Suit } from '../../core/state/gameTypes'

function formatSuit(suit: Suit): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  return 'Пика'
}

function formatCard(card: Card): string {
  return `${card.rank} ${formatSuit(card.suit)}`
}

function renderCards(cards: Card[]): string {
  if (cards.length === 0) {
    return `
      <div style="opacity: 0.7;">
        Все още няма карти.
      </div>
    `
  }

  return `
    <div style="display: flex; flex-wrap: wrap; gap: 10px;">
      ${cards
        .map(
          (card) => `
            <div
              style="
                border-radius: 10px;
                padding: 12px 14px;
                font-weight: 700;
                background: #e5e7eb;
                color: #0f172a;
                min-width: 110px;
                text-align: center;
              "
            >
              ${formatCard(card)}
            </div>
          `
        )
        .join('')}
    </div>
  `
}

export function renderBottomHandPanel(viewState: BottomHandViewState): string {
  if (!viewState.shouldShow) {
    return ''
  }

  return `
    <div style="max-width: 920px; margin-bottom: 16px;">
      <div
        style="
          padding: 16px;
          border-radius: 12px;
          background: rgba(255,255,255,0.06);
          border: 1px solid rgba(255,255,255,0.12);
        "
      >
        <div style="margin-bottom: 10px; font-weight: 700;">Твоите карти</div>
        ${renderCards(viewState.cards)}
      </div>
    </div>
  `
}
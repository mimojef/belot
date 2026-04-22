import type { BiddingViewState } from '../../core/state/getBiddingViewState'

function renderBidTile(options: {
  symbol: string
  label: string
  action: string
  value: string
  enabled: boolean
  symbolColor?: string
}): string {
  const { symbol, label, action, value, enabled, symbolColor = '#111827' } = options

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
        min-height: 92px;
        border: 0;
        border-radius: 10px;
        padding: 8px 10px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: ${enabled ? 'pointer' : 'not-allowed'};
        background: ${enabled ? 'rgba(255,255,255,0.92)' : 'rgba(100,116,139,0.58)'};
        color: ${enabled ? '#1f2937' : 'rgba(31,41,55,0.34)'};
        box-shadow: inset 0 0 0 1px ${enabled ? 'rgba(15,23,42,0.10)' : 'rgba(15,23,42,0.06)'};
        transition: filter 140ms ease;
      "
      onmouseover="${enabled ? "this.style.filter='brightness(0.98)'" : ''}"
      onmouseout="${enabled ? "this.style.filter='brightness(1)'" : ''}"
    >
      <span
        style="
          font-size: 52px;
          line-height: 1;
          font-weight: 800;
          color: ${enabled ? symbolColor : 'rgba(31,41,55,0.18)'};
        "
      >
        ${symbol}
      </span>

      <span
        style="
          font-size: 18px;
          line-height: 1.05;
          font-weight: 500;
          text-transform: uppercase;
          color: ${enabled ? '#2f3745' : 'rgba(31,41,55,0.24)'};
        "
      >
        ${label}
      </span>
    </button>
  `
}

function renderPassButton(enabled: boolean): string {
  return `
    <button
      type="button"
      data-action="bid-pass"
      data-value="pass"
      ${enabled ? '' : 'disabled'}
      style="
        width: 100%;
        min-height: 78px;
        border: 0;
        border-radius: 10px;
        cursor: ${enabled ? 'pointer' : 'not-allowed'};
        background: ${enabled ? '#f5ad1c' : 'rgba(245,173,28,0.45)'};
        color: ${enabled ? '#ffffff' : 'rgba(255,255,255,0.58)'};
        font-size: 44px;
        line-height: 1;
        font-weight: 500;
        text-transform: uppercase;
        box-shadow: inset 0 0 0 1px ${enabled ? 'rgba(120,53,15,0.14)' : 'rgba(120,53,15,0.08)'};
        transition: filter 140ms ease;
      "
      onmouseover="${enabled ? "this.style.filter='brightness(1.03)'" : ''}"
      onmouseout="${enabled ? "this.style.filter='brightness(1)'" : ''}"
    >
      Пас
    </button>
  `
}

export function renderBiddingPanel(biddingViewState: BiddingViewState): string {
  if (!biddingViewState) {
    return ''
  }

  const { validActions } = biddingViewState

  return `
    <div
      style="
        width: min(92vw, 440px);
        margin: 0 auto 16px;
        padding: 6px;
        border-radius: 14px;
        background: rgba(13, 34, 64, 0.42);
        border: 2px solid #f5ad1c;
        box-shadow:
          0 14px 34px rgba(0,0,0,0.20),
          inset 0 0 0 1px rgba(255,255,255,0.05);
      "
    >
      <div
        style="
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
          margin-bottom: 6px;
        "
      >
        ${renderBidTile({
          symbol: '♣',
          label: 'Спатия',
          action: 'bid-suit',
          value: 'clubs',
          enabled: validActions.suits.clubs,
          symbolColor: '#1f1720',
        })}

        ${renderBidTile({
          symbol: 'A',
          label: 'Без коз',
          action: 'bid-no-trumps',
          value: 'no-trumps',
          enabled: validActions.noTrumps,
          symbolColor: '#111111',
        })}

        ${renderBidTile({
          symbol: '♦',
          label: 'Каро',
          action: 'bid-suit',
          value: 'diamonds',
          enabled: validActions.suits.diamonds,
          symbolColor: '#ef4444',
        })}

        ${renderBidTile({
          symbol: 'J',
          label: 'Всичко коз',
          action: 'bid-all-trumps',
          value: 'all-trumps',
          enabled: validActions.allTrumps,
          symbolColor: '#ef4444',
        })}

        ${renderBidTile({
          symbol: '♥',
          label: 'Купа',
          action: 'bid-suit',
          value: 'hearts',
          enabled: validActions.suits.hearts,
          symbolColor: '#ef4444',
        })}

        ${renderBidTile({
          symbol: 'x2',
          label: 'Контра',
          action: 'bid-double',
          value: 'double',
          enabled: validActions.double,
          symbolColor: '#dc2626',
        })}

        ${renderBidTile({
          symbol: '♠',
          label: 'Пика',
          action: 'bid-suit',
          value: 'spades',
          enabled: validActions.suits.spades,
          symbolColor: '#1f1720',
        })}

        ${renderBidTile({
          symbol: 'x4',
          label: 'Ре контра',
          action: 'bid-redouble',
          value: 'redouble',
          enabled: validActions.redouble,
          symbolColor: '#dc2626',
        })}
      </div>

      ${renderPassButton(validActions.pass)}
    </div>
  `
}
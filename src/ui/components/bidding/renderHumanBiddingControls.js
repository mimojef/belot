import { renderBiddingButton } from './renderBiddingButton.js'

export function renderHumanBiddingControls({ phase, currentTurn, bidding }) {
  if (phase !== 'bidding' || currentTurn !== 'bottom') {
    return ''
  }

  const allowedSuits = bidding.allowedSuits ?? []
  const allowedContracts = bidding.allowedContracts ?? []
  const canDouble = bidding.canDouble ?? false
  const canRedouble = bidding.canRedouble ?? false

  return `
    <div class="bidding-actions" style="margin-top:0; padding-top:0; border-top:none;">
      <div
        style="
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        "
      >
        ${renderBiddingButton({
          label: 'Спатия',
          icon: '♣',
          iconColor: '#111827',
          onclick: "bidSuitAndRender('clubs')",
          enabled: allowedSuits.includes('clubs'),
        })}

        ${renderBiddingButton({
          label: 'Без коз',
          icon: 'A',
          iconColor: '#111827',
          onclick: 'bidNoTrumpsAndRender()',
          enabled: allowedContracts.includes('no-trumps'),
        })}

        ${renderBiddingButton({
          label: 'Каро',
          icon: '♦',
          iconColor: '#dc2626',
          onclick: "bidSuitAndRender('diamonds')",
          enabled: allowedSuits.includes('diamonds'),
        })}

        ${renderBiddingButton({
          label: 'Всичко коз',
          icon: 'J',
          iconColor: '#dc2626',
          onclick: 'bidAllTrumpsAndRender()',
          enabled: allowedContracts.includes('all-trumps'),
          isAccent: true,
        })}

        ${renderBiddingButton({
          label: 'Купа',
          icon: '♥',
          iconColor: '#ef4444',
          onclick: "bidSuitAndRender('hearts')",
          enabled: allowedSuits.includes('hearts'),
        })}

        ${renderBiddingButton({
          label: 'Контра',
          icon: 'x2',
          iconColor: '#b91c1c',
          onclick: 'doubleBidAndRender()',
          enabled: canDouble,
          isAccent: true,
        })}

        ${renderBiddingButton({
          label: 'Пика',
          icon: '♠',
          iconColor: '#111827',
          onclick: "bidSuitAndRender('spades')",
          enabled: allowedSuits.includes('spades'),
        })}

        ${renderBiddingButton({
          label: 'Ре контра',
          icon: 'x4',
          iconColor: '#991b1b',
          onclick: 'redoubleBidAndRender()',
          enabled: canRedouble,
          isDanger: true,
        })}
      </div>

      <div style="margin-top: 10px;">
        ${renderBiddingButton({
          label: 'Пас',
          onclick: 'passBidAndRender()',
          enabled: true,
          isPass: true,
        })}
      </div>
    </div>
  `
}

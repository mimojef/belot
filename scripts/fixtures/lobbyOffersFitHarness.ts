// Visual harness за checkLobbyOffersFit.ts — РЕАЛНИТЕ renderMobileOffersSection /
// renderBottomSection от renderLobbyScreen.ts, с различни дължини на сумите и
// (по избор) активен кампаниен бонус през setActiveCampaignTheme.
import '/src/style.css'
import { renderMobileOffersSection, renderBottomSection } from '/src/app/lobby/renderLobbyScreen.ts'
import { setActiveCampaignTheme } from '/src/app/activeRoom/activeRoomShared.ts'

const AMOUNTS = [50_000, 400_000, 1_500_000, 3_200_000, 10_000_000]

function pkg(amount: number, i: number) {
  return { packageId: `p${i}`, packageKey: `key_${amount}`, title: '', description: '', yellowCoinsAmount: amount, priceCents: 1999, currency: 'EUR', status: 'active', sortOrder: i + 1, showInLobby: true, isTopOffer: i === 2 } as any
}

document.body.style.margin = '0'
document.body.style.background = '#000'
const root = document.createElement('div')
document.body.appendChild(root)

;(window as any).__lobbyOffersFitHarness = {
  AMOUNTS,
  mount: (mode: 'mobile' | 'desktop', withBonus: boolean): void => {
    setActiveCampaignTheme(withBonus
      ? { unitIconUrl: '/assets/lobby/icon-coin.png', tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null, packageUnits: Object.fromEntries(AMOUNTS.map((a) => [`key_${a}`, a >= 1_000_000 ? 120 : 20])) }
      : null)
    const packages = AMOUNTS.map(pkg)
    root.innerHTML = mode === 'mobile'
      ? renderMobileOffersSection(packages, true)
      : `<div style="width:min(1160px, calc(100vw - 40px));margin:20px auto;">${renderBottomSection(packages.slice(0, 3), true, 0)}${renderBottomSection(packages.slice(2, 5), true, 0)}</div>`
  },
}

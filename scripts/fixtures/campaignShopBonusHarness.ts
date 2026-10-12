// Real createLobbyFlowController() + real renderLobbyScreen (Vite) — see
// checkCampaignShopBonus.ts. Темата идва по СЪЩИЯ път като в main.ts:
// setActiveCampaignTheme() (activeRoom контролера) + lobby.handleServerMessage.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { setActiveCampaignTheme } from '/src/app/activeRoom/activeRoomShared.ts'

const ICON = '/assets/lobby/icon-coin.png'

function coin(packageId: string, packageKey: string, amount: number, sortOrder: number) {
  return { packageId, packageKey, title: `Пакет ${amount}`, description: '', yellowCoinsAmount: amount, priceCents: 999, currency: 'EUR', status: 'active', sortOrder, showInLobby: true, isTopOffer: false } as any
}

const root = document.createElement('div')
document.body.appendChild(root)

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({ account: { role: 'player' }, profile: { profileId: 'me', displayName: 'Tester', avatarUrl: null, level: 3, yellowCoinsBalance: 0 } }) as any,
  onShopPackagesLoad: async () => ({ ok: true, packages: [coin('p-big', 'coins_big', 2_200_000, 1), coin('p-small', 'coins_small', 50_000, 2), coin('p-huge', 'coins_huge', 4_500_000, 3)] }),
  onShopPurchasesLoad: async () => ({ ok: true, purchases: [] }),
  onVipPackagesLoad: async () => ({ ok: true, packages: [{ packageId: 'vip_30', title: 'VIP 30', days: 30, priceCents: 499, currency: 'EUR' }, { packageId: 'vip_180', title: 'VIP 180', days: 180, priceCents: 1999, currency: 'EUR' }] }),
  onBundlePackagesLoad: async () => ({ ok: true, packages: [{ packageId: 'b-1', packageKey: 'bundle_gold', title: 'Комплект', description: '', yellowCoinsAmount: 3_000_000, vipDays: 30, priceCents: 2999, currency: 'EUR', status: 'active', sortOrder: 1, visualKey: null }] }),
  onBundlePurchasesLoad: async () => ({ ok: true, purchases: [] }),
} as any)

controller.setConnected(true)
controller.render()

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0))
}

;(window as any).__campaignShopBonusHarness = {
  ICON,
  openShopTab: async (tab: 'coins' | 'vip' | 'bundle'): Promise<void> => {
    if (document.querySelector('[data-shop-tab]') === null) {
      root.querySelector<HTMLElement>('[data-lobby-nav-shop="1"]')?.click()
      await flush()
    }
    root.querySelector<HTMLElement>(`[data-shop-tab="${tab}"]`)?.click()
    await flush()
  },
  // Същата последователност като main.ts onMessage: activeRoom записва темата, лобито пререндерира.
  pushTheme: async (theme: unknown): Promise<void> => {
    setActiveCampaignTheme(theme as any)
    controller.handleServerMessage({ type: 'active_campaign_theme', theme } as any)
    await flush()
  },
  badges: (): Array<{ key: string; text: string; iconSrc: string | null }> =>
    [...document.querySelectorAll<HTMLElement>('[data-shop-campaign-units]')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ key: el.dataset.shopCampaignUnits ?? '', text: (el.textContent ?? '').trim(), iconSrc: el.querySelector('img')?.getAttribute('src') ?? null })),
}

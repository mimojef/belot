// Фаза 9.1 — browser harness за createLobbyFlowController.ts's REAL
// campaign-reward-congratulations queue/gating logic
// (enqueueCampaignRewardNotifications/isSafeToShowCampaignRewardCongratulations/
// maybeShowNextCampaignRewardCongratulations), mirror на established
// initialNavUrlSyncHarness.ts pattern (реалния controller, не mock;
// main.ts's wiring се СИМУЛИРА explicit тук, не се импортира — main.ts е
// app entry point с тежки side effects при import, established "simulate
// its specific callback, не import-вай main.ts самия" паттерн).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let isCoinRewardOverlayActive = false
let isInGame = false
const ackedNotificationIds: string[] = []

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  getIsInGame: () => isInGame,
  getIsCoinRewardOverlayActive: () => isCoinRewardOverlayActive,
  onCampaignRewardNotificationAck: async (notificationId: string) => {
    ackedNotificationIds.push(notificationId)
  },
})

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function pushNotifications(notifications: Array<{ notificationId: string; campaignId: string; payload: any }>): void {
  controller.handleServerMessage({ type: 'pending_campaign_reward_notifications', notifications } as any)
}

function isPopupOpen(): boolean {
  return root.querySelector('[data-campaign-reward-congratulations-backdrop="1"]') !== null
}

function getPopupText(): string {
  return root.querySelector('[data-campaign-reward-congratulations-backdrop="1"]')?.textContent ?? ''
}

function clickClose(): void {
  root.querySelector<HTMLButtonElement>('[data-campaign-reward-congratulations-close="1"]')?.click()
}

;(window as unknown as { __campaignRewardCongratulationsQueueHarness: unknown }).__campaignRewardCongratulationsQueueHarness = {
  // Mirrors main.ts's coin-purchase-overlay lifecycle: set the flag, then
  // (optionally) flip it back and call the SAME public method main.ts's
  // onComplete callback calls.
  setCoinRewardOverlayActive: async (active: boolean): Promise<void> => {
    isCoinRewardOverlayActive = active
    await flush()
  },
  setInGame: async (active: boolean): Promise<void> => {
    isInGame = active
    await flush()
  },
  simulateCoinOverlayComplete: async (): Promise<void> => {
    isCoinRewardOverlayActive = false
    controller.maybeShowCampaignRewardCongratulations()
    await flush()
  },
  // Генеричен alias — mirrors ANY "safe moment" trigger call site (Белот
  // showLobby, Ludo onGameEndAcknowledged, VIP/bundle close), не само
  // coin overlay-я. Семантично по-коректно име за тестове, несвързани с
  // coin анимацията специфично (напр. "връщане от игра").
  retryShowCongratulations: async (): Promise<void> => {
    controller.maybeShowCampaignRewardCongratulations()
    await flush()
  },
  pushNotification: async (notificationId: string, campaignId: string, payload: any): Promise<void> => {
    pushNotifications([{ notificationId, campaignId, payload }])
    await flush()
  },
  openVipPurchaseSuccessPopup: async (): Promise<void> => {
    controller.showVipPurchaseSuccessPopup(30, '2027-01-01')
    await flush()
  },
  closeVipPurchaseSuccessPopupViaRealButton: async (): Promise<void> => {
    root.querySelector<HTMLButtonElement>('[data-vip-purchase-success-popup-ok="1"]')?.click()
    await flush()
  },
  isPopupOpen,
  getPopupText,
  clickClose: async (): Promise<void> => {
    clickClose()
    await flush()
  },
  getAckedNotificationIds: (): string[] => [...ackedNotificationIds],
}

// Фаза 9 (поздравителен popup за действително предоставени кампанийни
// награди) — browser harness за visual regression
// (checkCampaignRewardCongratulationsUi.ts). Ползва ДИРЕКТНО реалните
// production render + attach-listener функции
// (renderCampaignRewardCongratulationsPopup/attachCampaignRewardCongratulationsPopupEventListeners)
// — не re-implementация. Тия две функции са самостоятелни, чисти (вход:
// group | null -> HTML string; DOM root -> wire click listener), затова не
// се нуждаят от целия LobbyScreenState за да бъдат реално тестувани.
import {
  renderCampaignRewardCongratulationsPopup,
  attachCampaignRewardCongratulationsPopupEventListeners,
  type CampaignRewardCongratulationsGroup,
} from '/src/ui/overlays/renderCampaignRewardCongratulationsPopup.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let currentGroup: CampaignRewardCongratulationsGroup | null = null
let closeCallCount = 0
let lastClosedNotificationIds: string[] = []

function render(): void {
  root.innerHTML = renderCampaignRewardCongratulationsPopup(currentGroup, true)
  attachCampaignRewardCongratulationsPopupEventListeners(root, {
    onClose: () => {
      closeCallCount += 1
      lastClosedNotificationIds = currentGroup?.notificationIds ?? []
      currentGroup = null
      render()
    },
  })
}

function mount(group: CampaignRewardCongratulationsGroup): void {
  currentGroup = group
  closeCallCount = 0
  lastClosedNotificationIds = []
  render()
}

function clickClose(): void {
  root.querySelector<HTMLButtonElement>('[data-campaign-reward-congratulations-close="1"]')?.click()
}

function clickBackdrop(): void {
  root.querySelector<HTMLElement>('[data-campaign-reward-congratulations-backdrop="1"]')?.dispatchEvent(
    new MouseEvent('click', { bubbles: true }),
  )
}

;(window as unknown as { __campaignRewardCongratulationsHarness: unknown }).__campaignRewardCongratulationsHarness = {
  mount,
  clickClose,
  clickBackdrop,
  getCloseCallCount: () => closeCallCount,
  getLastClosedNotificationIds: () => lastClosedNotificationIds,
  isOpen: () => root.querySelector('[data-campaign-reward-congratulations-backdrop="1"]') !== null,
}

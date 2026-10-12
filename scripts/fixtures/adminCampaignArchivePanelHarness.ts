// Фаза 11 — изолиран browser fixture за renderAdminCampaignArchivePanel.ts /
// attachAdminCampaignArchivePanelHandlers, mirror на established
// biddingBoardLifecycleHarness.ts pattern (реален production render код,
// synthetic state, без реален server/auth — UI wiring под тест, не HTTP/
// auth слоя, вече покрит от checkCampaignArchiveHttp.ts).
import {
  renderAdminCampaignArchivePanel,
  attachAdminCampaignArchivePanelHandlers,
  type AdminCampaignArchivePanelState,
} from '/src/app/adminCampaigns/renderAdminCampaignArchivePanel.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const calls: Array<{ name: string; args: unknown[] }> = []
function record(name: string) {
  return (...args: unknown[]) => { calls.push({ name, args }) }
}

function baseState(overrides: Partial<AdminCampaignArchivePanelState> = {}): AdminCampaignArchivePanelState {
  return {
    adminCampaignArchiveList: [],
    adminCampaignArchiveLoading: false,
    adminCampaignArchiveErrorText: null,
    adminCampaignArchiveSuccessText: null,
    adminCampaignArchiveSelectedId: null,
    adminCampaignArchiveDetail: null,
    ...overrides,
  }
}

function render(state: AdminCampaignArchivePanelState, isMobile = false): void {
  root.innerHTML = renderAdminCampaignArchivePanel(state, isMobile)
  attachAdminCampaignArchivePanelHandlers(root, {
    onBack: record('onBack'),
    onSelect: record('onSelect'),
    onCloseDetail: record('onCloseDetail'),
    onArchiveNow: record('onArchiveNow'),
  })
}

function clickSelector(selector: string): boolean {
  const el = root.querySelector<HTMLElement>(selector)
  if (!el) return false
  el.click()
  return true
}

;(window as any).__adminCampaignArchivePanelHarness = {
  render,
  baseState,
  getCalls: () => calls,
  clickSelector,
  rowCount: () => root.querySelectorAll('[data-admin-campaign-archive-row]').length,
  hasDetail: () => root.querySelector('[data-admin-campaign-archive-panel="1"] table') !== null,
  bodyText: () => root.textContent ?? '',
}

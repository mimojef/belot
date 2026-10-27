// Browser fixture за checkBelotVisualClient.ts — реалният production
// renderAdminBelotVisualSection + attachAdminBelotVisualHandlers, с
// записващи handler-и (мрежата е покрита от checkBelotVisualAdminHttp.ts).
import {
  attachAdminBelotVisualHandlers,
  renderAdminBelotVisualSection,
  type AdminBelotVisualSectionState,
} from '/src/app/adminBelotVisual/renderAdminBelotVisualSection.ts'
import { renderThemeAssetWidget } from '/src/app/adminCampaigns/renderThemeAssetWidget.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const calls: Array<{ name: string; args: unknown[] }> = []
let state: AdminBelotVisualSectionState = {
  adminBelotVisual: { enabled: false, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null },
  adminBelotVisualLoading: false,
  adminBelotVisualBusy: false,
  adminBelotVisualErrorText: null,
  adminBelotVisualSuccessText: null,
}
let isMobile = false

function render(): void {
  root.innerHTML = renderAdminBelotVisualSection(state, isMobile)
  attachAdminBelotVisualHandlers(root, {
    onToggle: (enabled) => calls.push({ name: 'toggle', args: [enabled] }),
    onUpload: (kind, dataUrl) => calls.push({ name: 'upload', args: [kind, dataUrl.slice(0, 22)] }),
    onRemove: (kind) => calls.push({ name: 'remove', args: [kind] }),
  })
}

;(window as any).__belotVisualAdminHarness = {
  setState: (patch: Partial<AdminBelotVisualSectionState>, mobile = false) => {
    state = { ...state, ...patch }
    isMobile = mobile
    render()
  },
  getCalls: () => calls,
  clearCalls: () => { calls.length = 0 },
  renderCampaignWidget: (kind: string, label: string, url: string | null, accept: string) =>
    renderThemeAssetWidget({ dataPrefix: 'admin-campaign-theme', kind, label, url, accept }),
}
render()

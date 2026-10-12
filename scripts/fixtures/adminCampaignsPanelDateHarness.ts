// Изолиран browser fixture за renderAdminCampaignsPanel.ts/
// attachAdminCampaignsHandlers — mirror на established
// adminCampaignArchivePanelHarness.ts подход (реален production render код,
// synthetic state, без реален server/auth). Фокус: Europe/Sofia start/end
// date round-trip през datetime-local полетата (production incident
// регресия), не earn rules/reward tiers/theme assets.
import {
  renderAdminCampaignsPanel,
  attachAdminCampaignsHandlers,
  type AdminCampaignsPanelState,
} from '/src/app/adminCampaigns/renderAdminCampaignsPanel.ts'
import type { AdminCampaignEditorDraft, AdminCampaignReferenceData } from '/src/app/adminCampaigns/adminCampaignTypes.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const calls: Array<{ name: string; args: unknown[] }> = []
function record(name: string) {
  return (...args: unknown[]) => { calls.push({ name, args }) }
}

function emptyReferenceData(): AdminCampaignReferenceData {
  return {
    allowedStakes: { belot: [], ludo: [] },
    purchasePackages: [],
    giftItems: [],
    marketingProfiles: [],
  }
}

function baseDraft(overrides: Partial<AdminCampaignEditorDraft> = {}): AdminCampaignEditorDraft {
  return {
    campaignId: null,
    name: 'Test Campaign',
    // Sofia local: starts 2026-10-14T00:00 (EEST, UTC+3 — точно полунощ,
    // упражнява hour=24 Intl edge-а), ends 2026-11-07T06:00 (EET, UTC+2 —
    // след края на DST на 25.10.2026).
    startsAt: '2026-10-13T21:00:00.000Z',
    endsAt: '2026-11-07T04:00:00.000Z',
    unitNameSingular: 'жетон',
    unitNamePlural: 'жетони',
    giftSenderProfileId: null,
    earnRules: [],
    packageEarnRules: [],
    rewardTiers: [],
    ...overrides,
  }
}

let currentState: AdminCampaignsPanelState | null = null

function render(draft: AdminCampaignEditorDraft | null): void {
  currentState = {
    adminCampaigns: [],
    adminCampaignsReferenceData: emptyReferenceData(),
    adminCampaignsLoading: false,
    adminCampaignsErrorText: null,
    adminCampaignsSuccessText: null,
    adminCampaignsFilter: 'all',
    adminCampaignEditorDraft: draft,
  }
  root.innerHTML = renderAdminCampaignsPanel(currentState, false)
  attachAdminCampaignsHandlers(root, currentState, {
    onBack: record('onBack'),
    onCreate: record('onCreate'),
    onEdit: record('onEdit'),
    onFilter: record('onFilter'),
    onDraftChange: record('onDraftChange'),
    onSave: record('onSave'),
    onAction: record('onAction'),
    onMarketingSenderSave: record('onMarketingSenderSave'),
    onThemeAssetUpload: record('onThemeAssetUpload'),
    onThemeAssetRemove: record('onThemeAssetRemove'),
    onViewArchive: record('onViewArchive'),
  })
}

function getStartsInputValue(): string {
  return (root.querySelector('[data-admin-campaign-starts="1"]') as HTMLInputElement | null)?.value ?? ''
}
function getEndsInputValue(): string {
  return (root.querySelector('[data-admin-campaign-ends="1"]') as HTMLInputElement | null)?.value ?? ''
}
function setStartsInputValue(value: string): void {
  const el = root.querySelector('[data-admin-campaign-starts="1"]') as HTMLInputElement | null
  if (!el) return
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
function setEndsInputValue(value: string): void {
  const el = root.querySelector('[data-admin-campaign-ends="1"]') as HTMLInputElement | null
  if (!el) return
  el.value = value
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
function submitForm(): void {
  const form = root.querySelector('[data-admin-campaign-form="1"]') as HTMLFormElement | null
  form?.requestSubmit ? form.requestSubmit() : form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
}

;(window as any).__adminCampaignsPanelDateHarness = {
  render,
  baseDraft,
  getCalls: () => calls,
  getStartsInputValue,
  getEndsInputValue,
  setStartsInputValue,
  setEndsInputValue,
  submitForm,
}

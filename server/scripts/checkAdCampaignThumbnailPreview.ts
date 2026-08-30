/**
 * checkAdCampaignThumbnailPreview.ts
 *
 * Тества management-only image preview lightbox-а за /admin/ad-campaigns
 * (renderAdCampaignThumbnailPreview.ts + wiring-а в
 * renderAdCampaignManagementPanel.ts) — доказва, че thumbnail-ите са
 * clickable, отварят preview на СЪЩОТО изображение, независимо от target,
 * и НЕ носят никаква delivery/receipt семантика (отделен от
 * renderAdCampaignPopup.ts production popup-а).
 *
 * Реалният click/DOM interaction не се симулира лесно в Node test script
 * (established convention — виж checkImageViewerHistoryState.ts), затова:
 * (а) чист pure-function output inspection за renderAdCampaignThumbnailPreview
 *     и renderAdCampaignManagementPanel (реалната production markup, не мок);
 * (б) static source-grep за wiring-а (addEventListener извиквания), който не
 *     може да се провери през самия HTML output.
 *
 * [1]  campaign thumbnail е обвит в clickable бутон (data-ad-campaign-thumbnail-preview-open="<imageUrl>", cursor:pointer)
 * [2]  wiring: click на thumbnail бутона извиква handlers.onThumbnailPreviewOpen с imageUrl-а
 * [3]  preview overlay се рендва със СЪЩИЯ imageUrl, когато previewImageUrl е зададен
 * [4]  wiring: backdrop click (target===currentTarget) затваря
 * [5]  wiring: X close бутон затваря
 * [6]  wiring: click вътре в frame-а (stopPropagation) НЕ затваря
 * [7]  preview markup НЕ съдържа "Изпрати"/"Изтрий кампания"/"Виж" (никаква action семантика)
 * [8]  работи еднакво за campaign С target и БЕЗ target (thumbnail wrapping идентичен)
 * [9]  responsive: max-width/max-height/object-fit:contain, без hardcoded overflow
 * [10] preview е null -> нищо не се рендва; null -> non-null -> overlay се появява
 */

import { readFile } from 'node:fs/promises'
import { renderAdCampaignThumbnailPreview } from '../../src/app/adCampaigns/renderAdCampaignThumbnailPreview.js'
import { renderAdCampaignManagementPanel } from '../../src/app/adCampaigns/renderAdCampaignManagementPanel.js'
import type { AdCampaignManagementDto } from '../../src/app/network/createGameServerClient.js'
import type { AdCampaignManagementState } from '../../src/app/adCampaigns/renderAdCampaignManagementPanel.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.error(`  FAIL  ${label}`)
  }
}

function campaignRow(overrides: Partial<AdCampaignManagementDto> = {}): AdCampaignManagementDto {
  return {
    campaignId: 'c1',
    imageUrl: '/uploads/ad-campaigns/preview-fixture.webp',
    targetUrl: '/tournaments',
    createdAt: '2026-01-01T00:00:00Z',
    createdByProfileId: 'p1',
    createdByDisplayName: 'AdminUser',
    createdByRole: 'admin',
    dispatchCount: 0,
    lastDispatchAt: null,
    ...overrides,
  }
}

function panelState(overrides: Partial<AdCampaignManagementState> = {}): AdCampaignManagementState {
  return {
    isAdCampaignManager: true,
    loading: false,
    errorText: null,
    rows: [campaignRow()],
    createBusy: false,
    createErrorText: null,
    actionBusy: false,
    deleteConfirmCampaignId: null,
    previewImageUrl: null,
    ...overrides,
  }
}

console.log('\n=== renderAdCampaignThumbnailPreview (pure) ===\n')

check('[10a] null imageUrl -> празен string (нищо не се рендва)', renderAdCampaignThumbnailPreview(null) === '')

const previewMarkup = renderAdCampaignThumbnailPreview('/uploads/ad-campaigns/preview-fixture.webp')
check('[3] preview overlay съдържа backdrop/frame/close/image', [
  'data-ad-campaign-thumbnail-preview-backdrop',
  'data-ad-campaign-thumbnail-preview-frame',
  'data-ad-campaign-thumbnail-preview-close',
  '<img',
].every((needle) => previewMarkup.includes(needle)))
check('[3] preview показва ТОЧНО подадения imageUrl', previewMarkup.includes('src="/uploads/ad-campaigns/preview-fixture.webp"'))
check('[7] preview markup НЕ съдържа "Изпрати"', !previewMarkup.includes('Изпрати'))
check('[7] preview markup НЕ съдържа "Изтрий кампания"', !previewMarkup.includes('Изтрий кампания'))
check('[7] preview markup НЕ съдържа бутона "Виж" (data-ad-campaign-popup-view)', !previewMarkup.includes('data-ad-campaign-popup-view') && !previewMarkup.includes('>Виж<'))
check('[9] responsive: object-fit:contain', previewMarkup.includes('object-fit:contain'))
check('[9] responsive: max-width спрямо viewport (94vw)', previewMarkup.includes('94vw'))
check('[9] responsive: max-height спрямо viewport (dvh)', previewMarkup.includes('dvh'))

console.log('\n=== renderAdCampaignManagementPanel — thumbnail clickability + preview wiring (реална production markup) ===\n')

const panelWithoutPreview = renderAdCampaignManagementPanel(panelState({ previewImageUrl: null }))
check('[10b] previewImageUrl:null -> панелът НЕ съдържа preview overlay', !panelWithoutPreview.includes('data-ad-campaign-thumbnail-preview-backdrop'))

check('[1] campaign thumbnail е clickable бутон с data-ad-campaign-thumbnail-preview-open="<imageUrl>" и cursor:pointer', (() => {
  const match = /<button[^>]*data-ad-campaign-thumbnail-preview-open="([^"]*)"[^>]*>/.exec(panelWithoutPreview)
  if (!match) return false
  const [buttonTag, attrValue] = match
  return attrValue === '/uploads/ad-campaigns/preview-fixture.webp' && buttonTag.includes('cursor:pointer')
})())

const panelWithPreview = renderAdCampaignManagementPanel(panelState({ previewImageUrl: '/uploads/ad-campaigns/preview-fixture.webp' }))
check('[3] previewImageUrl зададен -> панелът съдържа preview overlay СЪС същия image', panelWithPreview.includes('data-ad-campaign-thumbnail-preview-backdrop') && panelWithPreview.includes('src="/uploads/ad-campaigns/preview-fixture.webp"'))

check('[8] campaign БЕЗ target също има clickable thumbnail (идентичен wrapping)', (() => {
  const stateNoTarget = panelState({ rows: [campaignRow({ campaignId: 'c2', targetUrl: null, imageUrl: '/uploads/ad-campaigns/no-target.webp' })] })
  const html = renderAdCampaignManagementPanel(stateNoTarget)
  return html.includes('data-ad-campaign-thumbnail-preview-open="/uploads/ad-campaigns/no-target.webp"') && !html.includes('>Виж<')
})())

console.log('\n=== Wiring (static source-grep — DOM addEventListener не се симулира лесно в Node) ===\n')

const managementPanelSource = await readFile(
  new URL('../../src/app/adCampaigns/renderAdCampaignManagementPanel.ts', import.meta.url),
  'utf8',
)
const thumbnailPreviewSource = await readFile(
  new URL('../../src/app/adCampaigns/renderAdCampaignThumbnailPreview.ts', import.meta.url),
  'utf8',
)

check('[2] thumbnail click wiring чете dataset.adCampaignThumbnailPreviewOpen и вика onThumbnailPreviewOpen', (() => {
  const wiringIdx = managementPanelSource.indexOf("querySelectorAll<HTMLButtonElement>('[data-ad-campaign-thumbnail-preview-open]')")
  if (wiringIdx === -1) return false
  const region = managementPanelSource.slice(wiringIdx, wiringIdx + 300)
  return region.includes('button.dataset.adCampaignThumbnailPreviewOpen') && region.includes('handlers.onThumbnailPreviewOpen(imageUrl)')
})())

check('[4] backdrop close wiring ползва target===currentTarget pattern (click извън рамката dismiss-ва, вътре — не)', thumbnailPreviewSource.includes('event.target === event.currentTarget'))
check('[5] X close бутонът е wired към handlers.onClose', thumbnailPreviewSource.includes('[data-ad-campaign-thumbnail-preview-close="1"]') && thumbnailPreviewSource.includes("addEventListener('click', handlers.onClose)"))
check('[6] frame-ът има stopPropagation (click вътре в preview-а не затваря)', thumbnailPreviewSource.includes('stopPropagation()'))
check('Escape затваря (established close pattern, mirror на production popup-а)', thumbnailPreviewSource.includes("event.key === 'Escape'"))

check('preview компонентът НЕ праща/маркира никакво receipt съобщение (ad_campaign_mark_shown/dismiss/click) — грепнато в целия файл', [
  'ad_campaign_mark_shown',
  'ad_campaign_dismiss',
  'ad_campaign_click',
  'onAdCampaignMarkShown',
  'onAdCampaignDismissDispatch',
  'onAdCampaignClickDispatch',
].every((needle) => !thumbnailPreviewSource.includes(needle)))

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}

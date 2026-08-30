/**
 * checkAdCampaignPopupOptionalTarget.ts
 *
 * Чист unit тест (без DOM) за renderAdCampaignPopup — доказва item 6/7 от
 * "campaign без target" изискването: popup без target НЕ съдържа бутон
 * "Виж" (и не оставя празно disabled/скрито място за него), а popup С target
 * продължава да го съдържа (regression).
 */

import { renderAdCampaignPopup } from '../../src/app/adCampaigns/renderAdCampaignPopup.js'
import type { AdCampaignDispatchClientDto } from '../../src/app/network/createGameServerClient.js'

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

function dispatch(targetUrl: string | null): AdCampaignDispatchClientDto {
  return {
    dispatchId: 'd1',
    campaignId: 'c1',
    imageUrl: '/uploads/ad-campaigns/x.webp',
    targetUrl,
    sentAt: '2026-01-01T00:00:00Z',
  }
}

console.log('\n=== renderAdCampaignPopup (target е optional) ===\n')

check('null dispatch -> празен string (нищо не се рендва)', renderAdCampaignPopup(null) === '')

const withoutTarget = renderAdCampaignPopup(dispatch(null))
check('popup без target съдържа backdrop/frame/X/image', [
  'data-ad-campaign-popup-backdrop',
  'data-ad-campaign-popup-frame',
  'data-ad-campaign-popup-close',
  '<img',
].every((needle) => withoutTarget.includes(needle)))
check('popup без target НЕ съдържа бутона "Виж" (data-ad-campaign-popup-view)', !withoutTarget.includes('data-ad-campaign-popup-view'))
check('popup без target НЕ съдържа текста "Виж" никъде (нито disabled, нито скрит бутон)', !withoutTarget.includes('>Виж<'))

const withTarget = renderAdCampaignPopup(dispatch('/tournaments'))
check('popup С target продължава да съдържа бутона "Виж" (regression)', withTarget.includes('data-ad-campaign-popup-view') && withTarget.includes('>Виж<'))
check('popup С target пази backdrop/frame/X/image също', [
  'data-ad-campaign-popup-backdrop',
  'data-ad-campaign-popup-frame',
  'data-ad-campaign-popup-close',
  '<img',
].every((needle) => withTarget.includes(needle)))

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}

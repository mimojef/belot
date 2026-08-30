/**
 * checkAdCampaignPopupOptionalTarget.ts
 *
 * Чист unit тест (без DOM) за renderAdCampaignPopup — доказва item 6/7 от
 * "campaign без target" изискването: popup без target НЕ съдържа бутон
 * "Виж" (и не оставя празно disabled/скрито място за него), а popup С target
 * продължава да го съдържа (regression).
 *
 * Плюс: X close бутонът — кръгла форма (border-radius:50%, равни width/
 * height, tap-friendly размер), червен X + червена рамка, НЕ плътен голям
 * червен бутон (background остава неутрален/полупрозрачен), и СЪЩИЯТ markup
 * се използва независимо дали targetUrl е null или има стойност (един-
 * единствен shared component, не две отделни реализации).
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

console.log('\n=== X close бутон — червен, кръгъл, tap-friendly, споделен между двата варианта ===\n')

function extractCloseButtonMarkup(html: string): string {
  const match = /<button[^>]*data-ad-campaign-popup-close="1"[^>]*>×<\/button>/.exec(html)
  if (!match) throw new Error('close бутонът не беше намерен в markup-а')
  return match[0]
}

const closeButtonWithoutTarget = extractCloseButtonMarkup(withoutTarget)
const closeButtonWithTarget = extractCloseButtonMarkup(withTarget)

check('close бутонът е ИДЕНТИЧЕН независимо дали targetUrl е null или има стойност (един shared component)', closeButtonWithoutTarget === closeButtonWithTarget)

check('close бутонът е истински кръгъл: border-radius:50% + равни width/height (38px/38px)', (() => {
  const hasRadius50 = /border-radius:\s*50%/.test(closeButtonWithoutTarget)
  const widthMatch = /width:\s*(\d+)px/.exec(closeButtonWithoutTarget)
  const heightMatch = /height:\s*(\d+)px/.exec(closeButtonWithoutTarget)
  return hasRadius50 && widthMatch !== null && heightMatch !== null && widthMatch[1] === heightMatch[1]
})())

check('close бутонът е в tap-friendly диапазон (34-40px)', (() => {
  const widthMatch = /width:\s*(\d+)px/.exec(closeButtonWithoutTarget)
  if (!widthMatch) return false
  const px = Number(widthMatch[1])
  return px >= 34 && px <= 40
})())

check('close бутонът има червена рамка (border: ...#ef4444)', /border:\s*2px solid #ef4444/.test(closeButtonWithoutTarget))
check('X-ът вътре е червен (color:#ef4444)', /color:#ef4444/.test(closeButtonWithoutTarget))
check('close бутонът НЕ е плътен голям червен бутон — background остава неутрален/полупрозрачен, не #ef4444', !/background:\s*#ef4444/.test(closeButtonWithoutTarget) && /background:\s*rgba\(/.test(closeButtonWithoutTarget))
check('close бутонът остава горе вдясно (position:absolute; top/right)', /position:absolute/.test(closeButtonWithoutTarget) && /top:10px/.test(closeButtonWithoutTarget) && /right:10px/.test(closeButtonWithoutTarget))
check('cursor:pointer за desktop', /cursor:pointer/.test(closeButtonWithoutTarget))

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}

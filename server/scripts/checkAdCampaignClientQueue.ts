/**
 * checkAdCampaignClientQueue.ts
 *
 * Чист unit тест (без DOM) за mergeIncomingAdCampaignDispatches — извлечена
 * от createLobbyFlowController.ts's `ad_campaign_pending_ads` handler pure
 * merge логика. Доказва item 5 от hardening pass-а: client queue/dedupe не
 * създава duplicate копие на един и същ dispatch в рамките на runtime session.
 */

import { mergeIncomingAdCampaignDispatches, dequeueNextAdCampaignPopup } from '../../src/app/adCampaigns/adCampaignPendingQueue.js'
import type { AdCampaignDispatchClientDto } from '../../src/app/network/createGameServerClient.js'

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function dto(dispatchId: string, campaignId = 'c1'): AdCampaignDispatchClientDto {
  return { dispatchId, campaignId, imageUrl: '/uploads/ad-campaigns/x.webp', targetUrl: '/tournaments', sentAt: '2026-01-01T00:00:00Z' }
}

console.log('\n=== mergeIncomingAdCampaignDispatches ===\n')

check('празна опашка + 1 нов dispatch -> опашката съдържа точно него', () => {
  const result = mergeIncomingAdCampaignDispatches([], null, [dto('d1')])
  assertEqual(result, [dto('d1')], 'result')
})

check('вече опашкуван dispatch НЕ се дублира при повторен push', () => {
  const existing = [dto('d1')]
  const result = mergeIncomingAdCampaignDispatches(existing, null, [dto('d1')])
  assertEqual(result.length, 1, 'дължина на опашката след duplicate push')
  assertEqual(result, existing, 'опашката остава непроменена (same reference-equal content)')
})

check('dispatch, който вече е активният показан popup, НЕ се добавя пак в опашката', () => {
  const active = dto('d1')
  const result = mergeIncomingAdCampaignDispatches([], active, [dto('d1')])
  assertEqual(result, [], 'опашката трябва да остане празна')
})

check('генуинно нов dispatch се добавя, докато вече опашкуваните не се дублират', () => {
  const existing = [dto('d1')]
  const result = mergeIncomingAdCampaignDispatches(existing, null, [dto('d1'), dto('d2')])
  assertEqual(result, [dto('d1'), dto('d2')], 'резултат')
})

check('multiple genuinely нови dispatch-и се добавят в реда, в който пристигат', () => {
  const result = mergeIncomingAdCampaignDispatches([], null, [dto('d1'), dto('d2'), dto('d3')])
  assertEqual(result, [dto('d1'), dto('d2'), dto('d3')], 'ред на опашката')
})

check('празен incoming масив -> опашката остава непроменена', () => {
  const existing = [dto('d1'), dto('d2')]
  const result = mergeIncomingAdCampaignDispatches(existing, null, [])
  assertEqual(result, existing, 'опашката без промяна')
})

check('duplicate вътре в самия incoming масив се добавя само веднъж', () => {
  const result = mergeIncomingAdCampaignDispatches([], null, [dto('d1'), dto('d1')])
  assertEqual(result, [dto('d1')], 'defensive dedupe и в рамките на самия incoming push, не само срещу existing/active')
})

console.log('\n=== dequeueNextAdCampaignPopup (queue "показва по едно" семантика) ===\n')

check('няма активен popup, опашка с 3 -> показва #1, опашката пази #2/#3 (multiple offline dispatches)', () => {
  const queue = [dto('d1'), dto('d2'), dto('d3')]
  const result = dequeueNextAdCampaignPopup(null, queue)
  assertEqual(result.activePopup, dto('d1'), 'activePopup')
  assertEqual(result.queue, [dto('d2'), dto('d3')], 'останала опашка')
})

check('вече има активен popup -> НЕ изважда нов (никога 2 modal-а едновременно)', () => {
  const active = dto('d1')
  const queue = [dto('d2'), dto('d3')]
  const result = dequeueNextAdCampaignPopup(active, queue)
  assertEqual(result.activePopup, active, 'activePopup остава непроменен')
  assertEqual(result.queue, queue, 'опашката остава непроменена, докато текущият popup не се dismiss-не/click-не')
})

check('след dismiss на #1 (activePopup=null) се показва #2, после #3 — последователно, едно по едно', () => {
  const afterDismiss1 = dequeueNextAdCampaignPopup(null, [dto('d2'), dto('d3')])
  assertEqual(afterDismiss1.activePopup, dto('d2'), '#2 след dismiss на #1')
  assertEqual(afterDismiss1.queue, [dto('d3')], 'остава само #3')

  const afterDismiss2 = dequeueNextAdCampaignPopup(null, afterDismiss1.queue)
  assertEqual(afterDismiss2.activePopup, dto('d3'), '#3 след dismiss на #2')
  assertEqual(afterDismiss2.queue, [], 'опашката е празна накрая')
})

check('няма активен popup, празна опашка -> нищо за показване', () => {
  const result = dequeueNextAdCampaignPopup(null, [])
  assertEqual(result.activePopup, null, 'activePopup')
  assertEqual(result.queue, [], 'queue')
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}

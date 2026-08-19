/**
 * checkVipWebhookEnrichmentNonBlocking.ts
 *
 * Focused source-level static-assertion test за VIP webhook payment-method
 * enrichment безопасност (server/src/index.ts, checkout.session.completed
 * VIP branch). Не моква реален Stripe HTTP webhook (тежка инфраструктура за
 * малка проверка) — вместо това потвърждава ТОЧНАТА структура/подредба на
 * кода, която гарантира изискваните safety свойства:
 *
 * [1] Enrichment блокът е guard-нат зад `if (vipResult.ok)` — enrichment
 *       никога не се опитва, ако settlement е неуспешен
 * [2] Enrichment е guard-нат зад needsPaymentMethodSnapshot(...) — duplicate
 *       webhook за вече enriched ред пропуска Stripe retrieve изцяло
 * [3] Stripe retrieve + updatePaymentMethodSnapshot са в try/catch с
 *       console.warn в catch клона (enrichment failure не хвърля нагоре)
 * [4] sendJsonResponse(res, 200, ...) + return true идват СЛЕД целия
 *       enrichment блок, извън try/catch-а — webhook винаги връща 200,
 *       независимо от enrichment изхода (важно: спира Stripe retry storms)
 * [5] updatePaymentMethodSnapshot() извикването е ВЪТРЕ в try блока (не
 *       извън/след catch) — грешка при retrieve никога не оставя частичен/
 *       невалиден snapshot запис
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed += 1
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed += 1
  const message = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${message}`)
}
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const serverRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const indexTsPath = resolve(serverRoot, 'src', 'index.ts')

console.log('\ncheckVipWebhookEnrichmentNonBlocking')
console.log(`Source: ${indexTsPath}`)

const source = await readFile(indexTsPath, 'utf8')

// Изолира VIP branch-а: от "purchaseType === 'vip'" до следващия
// "sendJsonResponse(res, 200, { ok: true })\n      return true" (краят на
// VIP branch-а в checkout.session.completed handler-а).
const vipBranchStart = source.indexOf(`stripeSession.metadata?.purchaseType === 'vip'`)
assert(vipBranchStart !== -1, `VIP branch marker not found in ${indexTsPath}`)

const vipBranchEndRegex = /sendJsonResponse\(res,\s*200,\s*\{\s*ok:\s*true\s*\}\)\s*\n\s*return true/
const vipBranchEndMatch = vipBranchEndRegex.exec(source.slice(vipBranchStart))
assert(vipBranchEndMatch !== null, 'VIP branch end marker (sendJsonResponse + return true) not found after VIP branch start')

const vipBranchEndIdx = vipBranchStart + (vipBranchEndMatch?.index ?? 0)
const vipBranch = source.slice(vipBranchStart, vipBranchEndIdx + (vipBranchEndMatch?.[0].length ?? 0))

check('[1] Enrichment блокът е guard-нат зад "if (vipResult.ok)"', () => {
  const guardIdx = vipBranch.indexOf('if (vipResult.ok)')
  assert(guardIdx !== -1, 'if (vipResult.ok) guard not found')
  const enrichCallIdx = vipBranch.indexOf('updatePaymentMethodSnapshot(')
  assert(enrichCallIdx !== -1, 'updatePaymentMethodSnapshot(...) call not found in VIP branch')
  assert(enrichCallIdx > guardIdx, 'updatePaymentMethodSnapshot call must appear AFTER the vipResult.ok guard')
})

check('[2] Enrichment е guard-нат зад needsPaymentMethodSnapshot(...) преди Stripe retrieve', () => {
  const needsIdx = vipBranch.indexOf('needsPaymentMethodSnapshot(')
  assert(needsIdx !== -1, 'needsPaymentMethodSnapshot(...) guard not found')
  const retrieveIdx = vipBranch.indexOf('stripe.paymentIntents.retrieve(')
  assert(retrieveIdx !== -1, 'stripe.paymentIntents.retrieve(...) call not found')
  assert(retrieveIdx > needsIdx, 'paymentIntents.retrieve must appear AFTER the needsPaymentMethodSnapshot guard (skip Stripe call when already enriched)')
})

check('[3] Stripe retrieve + updatePaymentMethodSnapshot са в try/catch с warn (не throw) в catch клона', () => {
  const tryIdx = vipBranch.indexOf('try {')
  const retrieveIdx = vipBranch.indexOf('stripe.paymentIntents.retrieve(')
  const updateIdx = vipBranch.indexOf('updatePaymentMethodSnapshot(')
  const catchIdx = vipBranch.indexOf('} catch (vipEnrichErr)', tryIdx)
  assert(tryIdx !== -1, 'try { not found')
  assert(catchIdx !== -1, 'catch (vipEnrichErr) not found')
  assert(tryIdx < retrieveIdx && retrieveIdx < catchIdx, 'paymentIntents.retrieve must be inside the try block')
  assert(tryIdx < updateIdx && updateIdx < catchIdx, 'updatePaymentMethodSnapshot must be inside the try block (never partially applied outside it)')

  const catchBlockEnd = vipBranch.indexOf('\n          }', catchIdx)
  const catchBody = vipBranch.slice(catchIdx, catchBlockEnd === -1 ? undefined : catchBlockEnd)
  assert(/console\.warn/.test(catchBody), 'catch block must console.warn (log), not rethrow')
  assert(!/throw\s+vipEnrichErr/.test(catchBody), 'catch block must NOT rethrow vipEnrichErr')
})

check('[4] sendJsonResponse(200) + return true идват СЛЕД целия enrichment блок, извън try/catch-а', () => {
  const catchIdx = vipBranch.indexOf('} catch (vipEnrichErr)')
  const sendIdx = vipBranch.indexOf('sendJsonResponse(res, 200, { ok: true })', catchIdx)
  assert(catchIdx !== -1 && sendIdx !== -1, 'expected markers not found')
  assert(sendIdx > catchIdx, 'sendJsonResponse(200) must appear after the enrichment try/catch — webhook always ACKs 200 regardless of enrichment outcome')
})

check('[5] fulfillPaidPurchase (settlement) е ПРЕДИ enrichment блока — settlement е source-of-truth, enrichment е чисто follow-up', () => {
  const fulfillIdx = vipBranch.indexOf('vipPurchaseStore.fulfillPaidPurchase(')
  const enrichGuardIdx = vipBranch.indexOf('if (vipResult.ok)')
  assert(fulfillIdx !== -1, 'fulfillPaidPurchase call not found')
  assert(fulfillIdx < enrichGuardIdx, 'fulfillPaidPurchase (settlement) must happen before the enrichment guard/block')
})

console.log(`\n${'═'.repeat(64)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

/**
 * checkStripeOldSessionAndPaymentReview.ts
 *
 * (1) Стари Stripe сесии. Преди: всяко „Купи“ върху reuse-нат pending ред
 *     създаваше НОВА сесия и презаписваше provider_checkout_session_id;
 *     старата оставаше платима, а VIP/bundle webhook-ът (строг lookup по
 *     session id) не намираше поръчката → платено, некредитирано.
 * (2) Проблемни плащания: потвърдено плащане, което не е кредитирано
 *     автоматично, оставя устойчив запис в payment_review_issues.
 *
 * obtainPendingPurchaseCheckoutSession (fake Stripe с idempotency емулация):
 * [1]  без сесия → нова, key checkout-<id>-none
 * [2]  отворена сесия → връща СЪЩАТА, без create
 * [3]  complete → 409, без create
 * [4]  expired → нова, key checkout-<id>-<стара>
 * [5]  retrieve грешка → 503, без create (старата не се изоставя „на сляпо“)
 * [6]  две конкурентни заявки без сесия → една и съща Stripe сесия
 * [7]  coin „Купи“ и „Плати“ подават еднакъв key И идентични параметри
 * Стари сесии (реални миграции, store + helper като в route-а):
 * [8]  VIP: второ „Купи“ при отворена сесия → същата сесия; плащането кредитира веднъж
 * [9]  VIP legacy осиротяла сесия → не се кредитира, запис purchase_not_found с metadata purchaseId;
 *      повторна доставка → occurrences=2, пак без кредит
 * [10] bundle legacy осиротяла сесия → същото
 * Две платени сесии за една поръчка (coins):
 * [11] плащане по стара сесия (metadata fallback) кредитира веднъж и става „платилата“ сесия
 * [12] второ плащане по другата сесия → duplicate_payment, без кредит, запис; повторно → occurrences=2
 * [13] повторна доставка на платилата сесия → alreadyCredited, без запис, без кредит
 * [14] паралелно (worker threads) две различни сесии за един ред → точно един кредит,
 *      другото → duplicate_payment
 * Проблемни плащания:
 * [15] coin грешна сума → amount_mismatch с очаквано/реално; без кредит; повторно → occurrences=2
 * [16] VIP грешна валута → currency_mismatch; без VIP grant
 * [17] VIP payment_status 'unpaid' → НЕ се записва (не е потвърдено плащане)
 * [18] coin canceled ред, но платен → not_creditable
 * [19] неуспешен запис → recordUncreditedPaidCheckout хвърля (webhook → 500, Stripe retry)
 * [20] Meri86-подобен платен ред: повторна доставка → alreadyCredited, без запис, wallet непроменен
 * [21] resolved проблем остава resolved при повторна доставка
 * „Купи“ при вече complete сесия (иначе клиентът е блокиран завинаги):
 * [22] coin → старият ред се скрива, нов ред + нова сесия; старата сесия кредитира веднъж
 * [23] VIP → същото
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import type Stripe from 'stripe'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { createPaymentReviewIssueStore } from '../src/db/paymentReviewIssueStore.js'
import type { PurchaseFulfillmentFailure } from '../src/db/purchaseFulfillmentFailure.js'
import {
  obtainPendingPurchaseCheckoutSession,
  obtainBuyCheckoutSession,
  getPendingPurchaseCheckoutIdempotencyKey,
} from '../src/shop/obtainPendingPurchaseCheckoutSession.js'
import { buildCoinCheckoutSessionParams } from '../src/shop/checkoutSessionParams.js'
import { resumeCoinPurchaseCheckout } from '../src/shop/resumeCoinPurchaseCheckout.js'
import { recordUncreditedPaidCheckout } from '../src/shop/recordUncreditedPaidCheckout.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(__dirname, '..', 'database', 'migrations')

let passed = 0
let failed = 0

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

async function applyMigrations(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.close()
}

// ── Fake Stripe с емулация на idempotency (същият key → същата сесия) ─────
type FakeSession = { id: string; status: 'open' | 'expired' | 'complete'; url: string | null }

let fakeStripeInstances = 0

function makeFakeStripe(opts: { retrieveThrows?: boolean } = {}) {
  const instance = ++fakeStripeInstances
  const sessions = new Map<string, FakeSession>()
  const byKey = new Map<string, FakeSession>()
  const createCalls: Array<{ params: Record<string, unknown>; key: string | undefined }> = []
  let counter = 0
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id: string): Promise<FakeSession> => {
          if (opts.retrieveThrows) throw new Error('network')
          const found = sessions.get(id)
          if (!found) throw new Error('No such checkout.session')
          return found
        },
        create: async (params: unknown, options?: { idempotencyKey?: string }): Promise<FakeSession> => {
          const key = options?.idempotencyKey
          createCalls.push({ params: params as Record<string, unknown>, key })
          if (key && byKey.has(key)) {
            const previous = createCalls.find((c) => c.key === key)
            if (previous && JSON.stringify(previous.params) !== JSON.stringify(params)) {
              throw new Error('idempotency_error: Keys for idempotent requests can only be used with the same parameters')
            }
            return byKey.get(key) as FakeSession
          }
          counter++
          const created: FakeSession = { id: `cs_fake_${instance}_${counter}`, status: 'open', url: `https://stripe.test/${instance}/${counter}` }
          sessions.set(created.id, created)
          if (key) byKey.set(key, created)
          return created
        },
      },
    },
  }
  return { stripe: stripe as unknown as Pick<Stripe, 'checkout'>, sessions, createCalls }
}

const createParams = (purchaseId: string): Stripe.Checkout.SessionCreateParams => ({
  mode: 'payment',
  success_url: 'https://pika.bg/ok',
  cancel_url: 'https://pika.bg/cancel',
  line_items: [{ price_data: { currency: 'eur', unit_amount: 499, product_data: { name: 'VIP' } }, quantity: 1 }],
  metadata: { purchaseType: 'vip', purchaseId },
})

// Минимален Stripe.Checkout.Session за recordUncreditedPaidCheckout.
function paidSession(id: string, purchaseId: string, amount: number | null, currency: string | null, paymentStatus = 'paid') {
  return {
    id,
    payment_status: paymentStatus,
    amount_total: amount,
    currency,
    metadata: { purchaseId, profileId: '' },
    payment_intent: `pi_${id}`,
  } as unknown as Stripe.Checkout.Session
}

async function runHelperScenarios(): Promise<void> {
  await check('[1] без сесия → нова сесия, key checkout-<id>-none', async () => {
    const { stripe, createCalls } = makeFakeStripe()
    const r = await obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p1', existingCheckoutSessionId: null, createParams: createParams('p1'), logLabel: 't' })
    assert(r.ok && !r.reused, `ok/new: ${JSON.stringify(r)}`)
    assert(createCalls.length === 1 && createCalls[0].key === 'checkout-p1-none', `key: ${createCalls[0]?.key}`)
  })

  await check('[2] отворена сесия → връща същата, без create', async () => {
    const { stripe, sessions, createCalls } = makeFakeStripe()
    sessions.set('cs_open', { id: 'cs_open', status: 'open', url: 'https://stripe.test/open' })
    const r = await obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p2', existingCheckoutSessionId: 'cs_open', createParams: createParams('p2'), logLabel: 't' })
    assert(r.ok && r.reused && r.session.id === 'cs_open', `очаквана същата: ${JSON.stringify(r)}`)
    assert(createCalls.length === 0, 'без create')
  })

  await check('[3] complete → 409, без create', async () => {
    const { stripe, sessions, createCalls } = makeFakeStripe()
    sessions.set('cs_done', { id: 'cs_done', status: 'complete', url: null })
    const r = await obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p3', existingCheckoutSessionId: 'cs_done', createParams: createParams('p3'), logLabel: 't' })
    assert(!r.ok && r.status === 409 && createCalls.length === 0, JSON.stringify(r))
  })

  await check('[4] expired → нова сесия, key checkout-<id>-<стара>', async () => {
    const { stripe, sessions, createCalls } = makeFakeStripe()
    sessions.set('cs_exp', { id: 'cs_exp', status: 'expired', url: null })
    const r = await obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p4', existingCheckoutSessionId: 'cs_exp', createParams: createParams('p4'), logLabel: 't' })
    assert(r.ok && !r.reused, JSON.stringify(r))
    assert(createCalls[0]?.key === 'checkout-p4-cs_exp', `key: ${createCalls[0]?.key}`)
  })

  await check('[5] retrieve грешка → 503, без create', async () => {
    const { stripe, createCalls } = makeFakeStripe({ retrieveThrows: true })
    const r = await obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p5', existingCheckoutSessionId: 'cs_x', createParams: createParams('p5'), logLabel: 't' })
    assert(!r.ok && r.status === 503 && createCalls.length === 0, JSON.stringify(r))
  })

  await check('[6] две конкурентни заявки без сесия → една и съща Stripe сесия', async () => {
    const { stripe } = makeFakeStripe()
    const [a, b] = await Promise.all([
      obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p6', existingCheckoutSessionId: null, createParams: createParams('p6'), logLabel: 't' }),
      obtainPendingPurchaseCheckoutSession({ stripe, purchaseId: 'p6', existingCheckoutSessionId: null, createParams: createParams('p6'), logLabel: 't' }),
    ])
    assert(a.ok && b.ok && a.session.id === b.session.id, `сесии: ${JSON.stringify([a, b])}`)
  })
}

async function runStoreScenarios(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-old-session-review-'))
  const dbPath = join(tempDir, 'db.sqlite')
  await applyMigrations(dbPath)

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  for (const p of ['vip-a', 'vip-b', 'bun-a', 'coin-a', 'coin-b', 'coin-c', 'coin-race', 'meri']) {
    db.prepare('INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(p, p, p)
  }
  db.exec(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
      VALUES ('pkg-c', 'pkg-c', 'Елит', 2250000, 1699, 'EUR', 'active');
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status)
      VALUES ('bun', 'bun', 'Комбо', 500000, 30, 999, 'EUR', 'active');
  `)

  const coin = await createCoinPurchaseStore(dbPath)
  const vip = await createVipPurchaseStore(dbPath)
  const bundle = await createBundlePurchaseStore(dbPath)
  const issues = await createPaymentReviewIssueStore(dbPath)

  const walletOf = (p: string): number =>
    ((db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(p) as { b: number } | undefined)?.b) ?? 0
  const vipGrants = (purchaseId: string): number =>
    (db.prepare('SELECT COUNT(*) AS c FROM vip_grants WHERE purchase_id = ?').get(purchaseId) as { c: number }).c
  const issueCount = (): number => (db.prepare('SELECT COUNT(*) AS c FROM payment_review_issues').get() as { c: number }).c
  const record = (type: 'coin' | 'vip' | 'bundle', session: Stripe.Checkout.Session, failure: PurchaseFulfillmentFailure, eventId = 'evt_1') =>
    recordUncreditedPaidCheckout({ store: issues, purchaseType: type, stripeSession: session, stripeEventId: eventId, failure })

  try {
    await check('[7] coin „Купи“ и „Плати“: еднакъв idempotency key и идентични параметри', async () => {
      const pending = coin.createPendingPurchase('coin-c', 'pkg-c')
      assert(pending.ok, 'pending ok')
      if (!pending.ok) return
      const { stripe, createCalls } = makeFakeStripe()
      const buy = await obtainPendingPurchaseCheckoutSession({
        stripe,
        purchaseId: pending.purchase.purchaseId,
        existingCheckoutSessionId: null,
        createParams: buildCoinCheckoutSessionParams(pending.purchase, 'coin-c', 'https://pika.bg/ok', 'https://pika.bg/cancel'),
        logLabel: 't',
      })
      const resumed = await resumeCoinPurchaseCheckout({
        store: coin, stripe, purchaseId: pending.purchase.purchaseId, profileId: 'coin-c',
        successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel',
      })
      assert(buy.ok && resumed.ok, `и двете ok: ${JSON.stringify([buy, resumed])}`)
      assert(createCalls.length === 2 && createCalls[0].key === createCalls[1].key, `keys: ${createCalls.map((c) => c.key).join(',')}`)
      assert(createCalls[0].key === getPendingPurchaseCheckoutIdempotencyKey(pending.purchase.purchaseId, null), 'key формат')
      assert(buy.ok && resumed.ok && resumed.purchase.providerCheckoutSessionId === buy.session.id, 'една и съща Stripe сесия')
      db.prepare(`UPDATE coin_purchase_ledger SET hidden_at = CURRENT_TIMESTAMP WHERE purchase_id = ?`).run(pending.purchase.purchaseId)
    })

    // ── [8] VIP: второ „Купи“ при отворена сесия ──
    await check('[8] VIP: второ „Купи“ при отворена сесия → същата сесия, кредит веднъж', async () => {
      const { stripe, createCalls } = makeFakeStripe()
      const buyOnce = async () => {
        const pending = vip.createPendingPurchase('vip-a', 'vip_30', 499)
        assert(pending.ok, 'pending ok')
        if (!pending.ok) throw new Error('pending')
        const obtained = await obtainPendingPurchaseCheckoutSession({
          stripe, purchaseId: pending.purchase.purchaseId,
          existingCheckoutSessionId: pending.purchase.providerCheckoutSessionId,
          createParams: createParams(pending.purchase.purchaseId), logLabel: 't',
        })
        assert(obtained.ok, JSON.stringify(obtained))
        if (!obtained.ok) throw new Error('obtain')
        vip.attachCheckoutSession(pending.purchase.purchaseId, obtained.session.id)
        return { purchaseId: pending.purchase.purchaseId, sessionId: obtained.session.id }
      }
      const first = await buyOnce()
      const second = await buyOnce()
      assert(first.purchaseId === second.purchaseId && first.sessionId === second.sessionId, `една поръчка/сесия: ${JSON.stringify([first, second])}`)
      assert(createCalls.length === 1, `точно 1 Stripe create, има ${createCalls.length}`)
      const pay = () => vip.fulfillPaidPurchase({ checkoutSessionId: first.sessionId, purchaseId: first.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 499 })
      const r1 = pay()
      const r2 = pay()
      assert(r1.ok && !r1.alreadyCredited && r2.ok && r2.alreadyCredited, JSON.stringify([r1, r2]))
      assert(vipGrants(first.purchaseId) === 1, 'точно 1 VIP grant')
    })

    // ── [9] VIP legacy осиротяла сесия ──
    await check('[9] VIP осиротяла сесия → без кредит, purchase_not_found; повторно → occurrences=2', () => {
      const pending = vip.createPendingPurchase('vip-b', 'vip_30', 499)
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      const purchaseId = pending.purchase.purchaseId
      vip.attachCheckoutSession(purchaseId, 'cs_vip_orphan')
      vip.attachCheckoutSession(purchaseId, 'cs_vip_current') // legacy презапис
      const session = paidSession('cs_vip_orphan', purchaseId, 499, 'eur')
      for (const eventId of ['evt_a', 'evt_b']) {
        const r = vip.fulfillPaidPurchase({ checkoutSessionId: session.id, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 499 })
        assert(!r.ok && r.reason === 'purchase_not_found', JSON.stringify(r))
        if (!r.ok) record('vip', session, r, eventId)
      }
      assert(vipGrants(purchaseId) === 0, 'без VIP grant')
      const issue = issues.listOpenIssues().find((i) => i.checkoutSessionId === 'cs_vip_orphan')
      assert(issue?.issueKind === 'purchase_not_found' && issue.metadataPurchaseId === purchaseId, JSON.stringify(issue))
      assert(issue?.occurrences === 2 && issue.stripeAmountTotal === 499 && issue.stripeCurrency === 'EUR', JSON.stringify(issue))
    })

    // ── [10] bundle legacy осиротяла сесия ──
    await check('[10] bundle осиротяла сесия → без кредит, purchase_not_found', () => {
      const pending = bundle.createPendingPurchase('bun-a', 'bun')
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      const purchaseId = pending.purchase.purchaseId
      bundle.attachCheckoutSession(purchaseId, 'cs_bun_orphan')
      bundle.attachCheckoutSession(purchaseId, 'cs_bun_current')
      const before = walletOf('bun-a')
      const r = bundle.fulfillPaidPurchase({ checkoutSessionId: 'cs_bun_orphan', purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 999 })
      assert(!r.ok && r.reason === 'purchase_not_found', JSON.stringify(r))
      if (!r.ok) record('bundle', paidSession('cs_bun_orphan', purchaseId, 999, 'eur'), r)
      assert(walletOf('bun-a') === before, 'без кредит')
      assert(issues.listOpenIssues().some((i) => i.checkoutSessionId === 'cs_bun_orphan' && i.purchaseType === 'bundle'), 'запис')
    })

    // ── [11]-[13] две платени сесии за една coin поръчка ──
    const twoPay = coin.createPendingPurchase('coin-a', 'pkg-c')
    const twoPayId = twoPay.ok ? twoPay.purchase.purchaseId : ''
    coin.attachCheckoutSession(twoPayId, 'cs_coin_old')
    coin.attachCheckoutSession(twoPayId, 'cs_coin_new') // legacy презапис
    const payCoin = (sessionId: string, amount = 1699, currency = 'eur') =>
      coin.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId: twoPayId, amountPaidCents: amount, currency })

    await check('[11] плащане по стара сесия → кредит веднъж, става „платилата“ сесия', () => {
      const before = walletOf('coin-a')
      const r = payCoin('cs_coin_old')
      assert(r.ok && !r.alreadyCredited, JSON.stringify(r))
      assert(walletOf('coin-a') - before === 2250000, 'кредит 2 250 000')
      const col = (db.prepare('SELECT provider_checkout_session_id AS s FROM coin_purchase_ledger WHERE purchase_id = ?').get(twoPayId) as { s: string }).s
      assert(col === 'cs_coin_old', `платилата сесия трябва да е cs_coin_old, а е ${col}`)
    })

    await check('[12] второ реално плащане (друга сесия) → duplicate_payment, без кредит; повторно → occurrences=2', () => {
      const before = walletOf('coin-a')
      for (const eventId of ['evt_d1', 'evt_d2']) {
        const r = payCoin('cs_coin_new')
        assert(!r.ok && r.reason === 'duplicate_payment', JSON.stringify(r))
        if (!r.ok) record('coin', paidSession('cs_coin_new', twoPayId, 1699, 'eur'), r, eventId)
      }
      assert(walletOf('coin-a') === before, 'без втори кредит')
      const issue = issues.listOpenIssues().find((i) => i.checkoutSessionId === 'cs_coin_new')
      assert(issue?.issueKind === 'duplicate_payment' && issue.purchaseId === twoPayId && issue.occurrences === 2, JSON.stringify(issue))
      assert(issue?.stripePaymentIntentId === 'pi_cs_coin_new', 'payment intent за refund/преглед')
    })

    await check('[13] повторна доставка на платилата сесия → alreadyCredited, без запис', () => {
      const before = walletOf('coin-a')
      const issuesBefore = issueCount()
      const r = payCoin('cs_coin_old')
      assert(r.ok && r.alreadyCredited, JSON.stringify(r))
      assert(walletOf('coin-a') === before && issueCount() === issuesBefore, 'без промяна')
    })

    // ── [15] coin грешна сума ──
    await check('[15] coin грешна сума → amount_mismatch, без кредит; повторно → occurrences=2', () => {
      const pending = coin.createPendingPurchase('coin-b', 'pkg-c')
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      coin.attachCheckoutSession(pending.purchase.purchaseId, 'cs_coin_amount')
      const before = walletOf('coin-b')
      for (const eventId of ['evt_m1', 'evt_m2']) {
        const r = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_coin_amount', purchaseId: pending.purchase.purchaseId, amountPaidCents: 999, currency: 'eur' })
        assert(!r.ok && r.reason === 'amount_mismatch', JSON.stringify(r))
        if (!r.ok) record('coin', paidSession('cs_coin_amount', pending.purchase.purchaseId, 999, 'eur'), r, eventId)
      }
      assert(walletOf('coin-b') === before, 'без кредит')
      const issue = issues.listOpenIssues().find((i) => i.checkoutSessionId === 'cs_coin_amount')
      assert(issue?.issueKind === 'amount_mismatch' && issue.expectedAmount === 1699 && issue.stripeAmountTotal === 999 && issue.occurrences === 2, JSON.stringify(issue))
      assert(issue?.payerProfileId === 'coin-b', 'платец')
    })

    // ── [16] VIP грешна валута ──
    await check('[16] VIP грешна валута → currency_mismatch, без VIP grant', () => {
      const pending = vip.createPendingPurchase('vip-b', 'vip_180', 2269)
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      vip.attachCheckoutSession(pending.purchase.purchaseId, 'cs_vip_cur')
      const r = vip.fulfillPaidPurchase({ checkoutSessionId: 'cs_vip_cur', purchaseId: pending.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'BGN', stripeAmountTotalCents: 2269 })
      assert(!r.ok && r.reason === 'currency_mismatch', JSON.stringify(r))
      if (!r.ok) record('vip', paidSession('cs_vip_cur', pending.purchase.purchaseId, 2269, 'bgn'), r)
      assert(vipGrants(pending.purchase.purchaseId) === 0, 'без grant')
      const issue = issues.listOpenIssues().find((i) => i.checkoutSessionId === 'cs_vip_cur')
      assert(issue?.issueKind === 'currency_mismatch' && issue.expectedCurrency === 'EUR' && issue.stripeCurrency === 'BGN', JSON.stringify(issue))
    })

    // ── [17] не е потвърдено плащане ──
    await check('[17] VIP payment_status unpaid → без запис', () => {
      const before = issueCount()
      const r = vip.fulfillPaidPurchase({ checkoutSessionId: 'cs_vip_cur', purchaseId: '', stripePaymentStatus: 'unpaid', stripeCurrency: 'EUR', stripeAmountTotalCents: 2269 })
      assert(!r.ok && r.reason === 'not_paid', JSON.stringify(r))
      if (!r.ok) {
        const issue = record('vip', paidSession('cs_vip_cur', '', 2269, 'eur', 'unpaid'), r)
        assert(issue === null, 'не трябва да се записва')
      }
      assert(issueCount() === before, 'брой записи непроменен')
    })

    // ── [18] canceled, но платен ──
    await check('[18] coin canceled ред, но платен → not_creditable', () => {
      const pending = coin.createPendingPurchase('coin-race', 'pkg-c')
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      coin.attachCheckoutSession(pending.purchase.purchaseId, 'cs_coin_canceled')
      coin.markPurchaseCanceledByCheckoutSessionId('cs_coin_canceled')
      const r = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_coin_canceled', purchaseId: pending.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' })
      assert(!r.ok && r.reason === 'not_creditable', JSON.stringify(r))
      if (!r.ok) record('coin', paidSession('cs_coin_canceled', pending.purchase.purchaseId, 1699, 'eur'), r)
      assert(issues.listOpenIssues().some((i) => i.checkoutSessionId === 'cs_coin_canceled' && i.issueKind === 'not_creditable'), 'запис')
    })

    // ── [20] Meri86-подобен платен ред ──
    await check('[20] платен ред + ръчна компенсация: повторна доставка → alreadyCredited, без запис', () => {
      db.exec(`
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
        VALUES ('meri-paid', 'meri', 'pkg-c', 'pkg-c', 'Елит', 1500000, 1699, 'EUR', 'cs_meri', 'paid', CURRENT_TIMESTAMP);
        INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('meri', 2250000);
      `)
      const rowBefore = JSON.stringify(db.prepare(`SELECT * FROM coin_purchase_ledger WHERE purchase_id = 'meri-paid'`).get())
      const before = issueCount()
      const r = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_meri', purchaseId: 'meri-paid', amountPaidCents: 1699, currency: 'eur' })
      assert(r.ok && r.alreadyCredited, JSON.stringify(r))
      assert(walletOf('meri') === 2250000 && issueCount() === before, 'wallet/записи непроменени')
      assert(JSON.stringify(db.prepare(`SELECT * FROM coin_purchase_ledger WHERE purchase_id = 'meri-paid'`).get()) === rowBefore, 'редът непроменен')
    })

    await check('[21] resolved проблем остава resolved при повторна доставка', () => {
      db.prepare(`UPDATE payment_review_issues SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE checkout_session_id = 'cs_coin_amount'`).run()
      const r = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_coin_amount', purchaseId: '', amountPaidCents: 999, currency: 'eur' })
      assert(!r.ok, 'пак отказ')
      if (!r.ok) {
        const issue = record('coin', paidSession('cs_coin_amount', '', 999, 'eur'), r, 'evt_m3')
        assert(issue?.status === 'resolved' && issue.occurrences === 3, JSON.stringify(issue))
      }
    })

    await check('[22] coin „Купи“ при complete сесия → старият ред се скрива, нов ред + нова сесия; старата сесия кредитира веднъж', async () => {
      const first = coin.createPendingPurchase('coin-b', 'pkg-c')
      assert(first.ok, 'pending')
      if (!first.ok) return
      // coin-b вече има amount_mismatch ред от [15] (pending, видим) → reuse.
      const { stripe, sessions, createCalls } = makeFakeStripe()
      sessions.set('cs_coin_amount', { id: 'cs_coin_amount', status: 'complete', url: null })
      const obtained = await obtainBuyCheckoutSession({
        stripe,
        purchase: first.purchase,
        buildCreateParams: (p) => buildCoinCheckoutSessionParams(p, 'coin-b', 'https://pika.bg/ok', 'https://pika.bg/cancel'),
        retirePendingPurchase: (id) => coin.retirePendingPurchase(id),
        createReplacementPurchase: () => coin.createPendingPurchase('coin-b', 'pkg-c'),
        logLabel: 't',
      })
      assert(obtained.ok, JSON.stringify(obtained))
      if (!obtained.ok) return
      assert(obtained.purchase.purchaseId !== first.purchase.purchaseId && !obtained.reused && createCalls.length === 1, 'нов ред и нова сесия')
      coin.attachCheckoutSession(obtained.purchase.purchaseId, obtained.session.id)
      const old = db.prepare('SELECT status, hidden_at, provider_checkout_session_id AS s FROM coin_purchase_ledger WHERE purchase_id = ?').get(first.purchase.purchaseId) as { status: string; hidden_at: string | null; s: string }
      assert(old.status === 'pending' && old.hidden_at !== null && old.s === 'cs_coin_amount', `стар ред: ${JSON.stringify(old)}`)
      const before = walletOf('coin-b')
      const r1 = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_coin_amount', purchaseId: first.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' })
      const r2 = coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_coin_amount', purchaseId: first.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' })
      assert(r1.ok && !r1.alreadyCredited && r2.ok && r2.alreadyCredited, JSON.stringify([r1, r2]))
      assert(walletOf('coin-b') - before === 2250000, 'кредит веднъж по старата сесия')
    })

    await check('[23] VIP „Купи“ при complete сесия → нов ред; старата сесия намира стария ред', async () => {
      const first = vip.createPendingPurchase('vip-a', 'vip_365', 6989)
      assert(first.ok, 'pending')
      if (!first.ok) return
      vip.attachCheckoutSession(first.purchase.purchaseId, 'cs_vip_complete')
      const reread = vip.createPendingPurchase('vip-a', 'vip_365', 6989)
      assert(reread.ok && reread.purchase.providerCheckoutSessionId === 'cs_vip_complete', 'reuse с complete сесия')
      if (!reread.ok) return
      const { stripe, sessions } = makeFakeStripe()
      sessions.set('cs_vip_complete', { id: 'cs_vip_complete', status: 'complete', url: null })
      const obtained = await obtainBuyCheckoutSession({
        stripe,
        purchase: reread.purchase,
        buildCreateParams: (p) => createParams(p.purchaseId),
        retirePendingPurchase: (id) => vip.retirePendingPurchase(id),
        createReplacementPurchase: () => vip.createPendingPurchase('vip-a', 'vip_365', 6989),
        logLabel: 't',
      })
      assert(obtained.ok && obtained.purchase.purchaseId !== first.purchase.purchaseId, JSON.stringify(obtained))
      const r = vip.fulfillPaidPurchase({ checkoutSessionId: 'cs_vip_complete', purchaseId: first.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 6989 })
      assert(r.ok && !r.alreadyCredited && vipGrants(first.purchase.purchaseId) === 1, JSON.stringify(r))
    })

    await check('[19] неуспешен запис → recordUncreditedPaidCheckout хвърля (webhook → 500)', () => {
      const brokenStore = { ...issues, recordIssue: () => { throw new Error('disk I/O error') } }
      let threw = false
      try {
        recordUncreditedPaidCheckout({
          store: brokenStore,
          purchaseType: 'coin',
          stripeSession: paidSession('cs_x', 'p', 1, 'eur'),
          stripeEventId: 'evt',
          failure: { ok: false, reason: 'amount_mismatch', message: 'x' },
        })
      } catch {
        threw = true
      }
      assert(threw, 'трябва да хвърли')
    })
  } finally {
    coin.close()
    vip.close()
    bundle.close()
    issues.close()
    db.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ── [14] паралелни плащания по две различни сесии (worker threads) ───────
type RaceData = { dbPath: string; sessionId: string; purchaseId: string; barrier: SharedArrayBuffer }

async function raceWorkerMain(): Promise<void> {
  const data = workerData as RaceData
  const barrier = new Int32Array(data.barrier)
  const store = await createCoinPurchaseStore(data.dbPath)
  Atomics.add(barrier, 1, 1)
  Atomics.wait(barrier, 0, 0)
  const r = store.fulfillPaidPurchase({ checkoutSessionId: data.sessionId, purchaseId: data.purchaseId, amountPaidCents: 1699, currency: 'eur' })
  parentPort?.postMessage(r.ok ? { ok: true, alreadyCredited: r.alreadyCredited } : { ok: false, reason: r.reason ?? null })
  store.close()
}

async function runRaceScenario(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-two-session-race-'))
  const dbPath = join(tempDir, 'race.sqlite')
  try {
    await applyMigrations(dbPath)
    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    try {
      // Продукционната база вече е в WAL (режимът е постоянен); превключването
      // DELETE→WAL изисква изключителен lock и не бива да се състезава в worker-ите.
      db.exec('PRAGMA journal_mode = WAL;')
      db.exec(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('race', 'race', 'race');
        INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
          VALUES ('pkg-r', 'pkg-r', 'Елит', 2250000, 1699, 'EUR', 'active');
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status)
        VALUES ('race-p', 'race', 'pkg-r', 'pkg-r', 'Елит', 2250000, 1699, 'EUR', 'cs_race_b', 'pending');
      `)

      await check('[14] паралелно две различни сесии за един ред → един кредит + duplicate_payment', async () => {
        const barrier = new SharedArrayBuffer(8)
        const view = new Int32Array(barrier)
        const results = ['cs_race_a', 'cs_race_b'].map((sessionId) => new Promise<{ ok: boolean; alreadyCredited?: boolean; reason?: string | null }>((resolveResult, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { dbPath, sessionId, purchaseId: 'race-p', barrier } })
          worker.once('message', (m) => { resolveResult(m); void worker.terminate() })
          worker.once('error', reject)
        }))
        while (Atomics.load(view, 1) < 2) await new Promise((r) => setTimeout(r, 10))
        Atomics.store(view, 0, 1)
        Atomics.notify(view, 0)
        const out = await Promise.all(results)
        const credited = out.filter((r) => r.ok && !r.alreadyCredited).length
        const duplicates = out.filter((r) => !r.ok && r.reason === 'duplicate_payment').length
        assert(credited === 1 && duplicates === 1, `резултати: ${JSON.stringify(out)}`)
        const wallet = (db.prepare(`SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = 'race'`).get() as { b: number }).b
        assert(wallet === 2250000, `wallet ${wallet}`)
      })
    } finally {
      db.close()
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  await runHelperScenarios()
  await runStoreScenarios()
  await runRaceScenario()
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (isMainThread) {
  void main()
} else {
  void raceWorkerMain()
}

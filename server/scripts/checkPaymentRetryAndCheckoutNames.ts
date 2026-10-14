/**
 * checkPaymentRetryAndCheckoutNames.ts
 *
 * (1) Повторни опити при техническа грешка при кредитиране (webhook 500 →
 *     Stripe retry) срещу окончателни проблеми (запис + 200, без retry).
 * (2) Имена на продуктите в Stripe Checkout от snapshot-а на поръчката.
 *
 * Класификация:
 * [1]  SQLITE_BUSY/LOCKED/IOERR/FULL (вкл. extended кодове) → временни
 * [2]  CONSTRAINT/ERROR/CORRUPT и не-SQLite грешки (бъг) → детерминистични
 * [3]  runFulfillment: хвърлена SQLITE_BUSY → credit_failed transient; TypeError → не-transient
 * Реален lock (отделна връзка държи write lock > busy_timeout):
 * [4]  coin: заключена база → credit_failed transient, без кредит, редът pending
 * [5]  след освобождаване: повторението кредитира точно веднъж
 * [6]  VIP: заключена база → transient; след това → кредит веднъж, 1 VIP grant
 * Settlement (решение за HTTP статуса):
 * [7]  временна грешка → 500 + отворен is_transient запис
 * [8]  успешна повторна доставка → 200, временният запис е resolved с бележка, няма активни
 * [9]  временна грешка, после окончателна (amount_mismatch) → временният resolved, окончателният open, 200
 * [10] детерминистична техническа грешка → 200 (без безкраен retry), open, is_transient=0
 * [11] временна → детерминистична със същия вид → един ред, is_transient=0, open
 * [12] окончателен проблем, но записът не успява → 500
 * [13] временна грешка и записът не успява → 500
 * [14] неуспешно затваряне след успешен кредит → 500; повторението → alreadyCredited, без кредит
 * [15] непотвърдено плащане (unpaid) → 200, без запис
 * [16] балансът е committed, отговорът „изгубен“ → повторна доставка: alreadyCredited, без втори кредит
 * Имена в Checkout:
 * [17] coin: „Елит — 2 250 000 жълтици“, цена/валута от snapshot-а
 * [18] coin: подновяване на стара неплатена поръчка показва НЕЙНИТЕ условия; нова поръчка — новите
 * [19] VIP: „VIP — 365 дни“ от snapshot-а (не от каталога)
 * [20] bundle: „Ултра — 4 500 000 жълтици + 365 дни VIP“
 * [21] единствено число: 1 жълтица / 1 ден; хиляди с bg-BG разделител
 * [22] дълго име → ≤ 250 символа, условията остават цели, emoji не се реже
 * [23] metadata стойности ≤ 500 символа, ключове ≤ 40, ≤ 50 ключа (Stripe лимити)
 * [24] „Купи“ и resume за една поръчка → идентични параметри (общ idempotency key)
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type Stripe from 'stripe'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { createVipPurchaseStore } from '../src/db/vipPurchaseStore.js'
import { createBundlePurchaseStore } from '../src/db/bundlePurchaseStore.js'
import { createPaymentReviewIssueStore } from '../src/db/paymentReviewIssueStore.js'
import type { PaymentReviewIssueStore } from '../src/db/paymentReviewIssueStore.js'
import { isTransientDatabaseError } from '../src/db/classifyFulfillmentError.js'
import type { PurchaseFulfillmentFailure } from '../src/db/purchaseFulfillmentFailure.js'
import {
  runFulfillment,
  settleUncreditedPaidCheckout,
  settleCreditedPaidCheckout,
  AUTO_RESOLVED_AFTER_CREDIT_NOTE,
} from '../src/shop/recordUncreditedPaidCheckout.js'
import {
  buildCoinCheckoutSessionParams,
  buildVipCheckoutSessionParams,
  buildBundleCheckoutSessionParams,
} from '../src/shop/checkoutSessionParams.js'
import { CHECKOUT_PRODUCT_NAME_MAX_LENGTH, buildBundleCheckoutProductName, buildCoinCheckoutProductName } from '../src/shop/checkoutProductNames.js'
import { resumeCoinPurchaseCheckout } from '../src/shop/resumeCoinPurchaseCheckout.js'

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

// bg-BG разделителят на хилядите е U+00A0 (неразделим интервал); очакванията
// се пишат с обикновен интервал и тук се превръщат само между цифри.
const nb = (text: string) => text.replace(/(\d) (?=\d)/g, '$1\u00a0')

async function applyMigrations(dbPath: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.exec('PRAGMA journal_mode = WAL;')
  db.close()
}

function sqliteError(errcode: number): Error {
  return Object.assign(new Error(`sqlite ${errcode}`), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'x' })
}

function paidSession(id: string, amount = 1699, paymentStatus = 'paid') {
  return {
    id,
    payment_status: paymentStatus,
    amount_total: amount,
    currency: 'eur',
    metadata: { purchaseId: '', profileId: '' },
    payment_intent: `pi_${id}`,
  } as unknown as Stripe.Checkout.Session
}

const transientFailure: PurchaseFulfillmentFailure = { ok: false, reason: 'credit_failed', transient: true, message: 'database is locked' }
const deterministicFailure: PurchaseFulfillmentFailure = { ok: false, reason: 'credit_failed', transient: false, message: 'CHECK constraint failed' }

async function main(): Promise<void> {
  // ── Класификация ─────────────────────────────────────────────────────
  await check('[1] BUSY/LOCKED/IOERR/FULL (вкл. extended) → временни', () => {
    for (const code of [5, 6, 10, 13, 517 /* BUSY_SNAPSHOT */, 261 /* BUSY_RECOVERY */, 266 /* IOERR_READ */]) {
      assert(isTransientDatabaseError(sqliteError(code)), `код ${code}`)
    }
  })

  await check('[2] CONSTRAINT/ERROR/CORRUPT и не-SQLite → детерминистични', () => {
    for (const code of [19, 787 /* CONSTRAINT_FOREIGNKEY */, 2067 /* CONSTRAINT_UNIQUE */, 1, 11]) {
      assert(!isTransientDatabaseError(sqliteError(code)), `код ${code}`)
    }
    assert(!isTransientDatabaseError(new TypeError('x is undefined')), 'TypeError')
    assert(!isTransientDatabaseError('string'), 'string')
  })

  await check('[3] runFulfillment: хвърлена BUSY → transient; TypeError → детерминистична', () => {
    const busy = runFulfillment(() => { throw sqliteError(5) })
    assert(!busy.ok && busy.reason === 'credit_failed' && busy.transient === true, JSON.stringify(busy))
    const bug = runFulfillment(() => { throw new TypeError('boom') })
    assert(!bug.ok && bug.reason === 'credit_failed' && bug.transient === false, JSON.stringify(bug))
  })

  const tempDir = await mkdtemp(join(tmpdir(), 'belot-payment-retry-'))
  const dbPath = join(tempDir, 'db.sqlite')
  await applyMigrations(dbPath)

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  for (const p of ['lock-coin', 'lock-vip', 'names', 'mark']) {
    db.prepare('INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(p, p, p)
  }
  db.exec(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
      VALUES ('t-elite', 't-elite', 'Елит', 2250000, 1699, 'EUR', 'active');
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status)
      VALUES ('t-ultra', 't-ultra', 'Ултра', 4500000, 365, 4999, 'EUR', 'active');
  `)

  const coin = await createCoinPurchaseStore(dbPath)
  const vip = await createVipPurchaseStore(dbPath)
  const bundle = await createBundlePurchaseStore(dbPath)
  const issues = await createPaymentReviewIssueStore(dbPath)
  const walletOf = (p: string): number =>
    ((db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(p) as { b: number } | undefined)?.b) ?? 0
  const issueRow = (session: string, kind: string) =>
    db.prepare('SELECT * FROM payment_review_issues WHERE checkout_session_id = ? AND issue_kind = ?').get(session, kind) as Record<string, unknown> | undefined

  // Отделна връзка, която държи write lock (симулира друг процес/дълга транзакция).
  const locker = new DatabaseSync(dbPath, { open: true })
  const withWriteLock = <T>(fn: () => T): T => {
    locker.exec('BEGIN IMMEDIATE;')
    try {
      return fn()
    } finally {
      locker.exec('ROLLBACK;')
    }
  }

  try {
    // ── Реален lock ──────────────────────────────────────────────────────
    const coinPending = coin.createPendingPurchase('lock-coin', 't-elite')
    const coinId = coinPending.ok ? coinPending.purchase.purchaseId : ''
    coin.attachCheckoutSession(coinId, 'cs_lock_coin')
    const payCoin = () => runFulfillment(() => coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_lock_coin', purchaseId: coinId, amountPaidCents: 1699, currency: 'eur' }))

    await check('[4] coin при заключена база → credit_failed transient, без кредит', () => {
      const r = withWriteLock(payCoin)
      assert(!r.ok && r.reason === 'credit_failed' && r.transient === true, JSON.stringify(r))
      assert(walletOf('lock-coin') === 0, 'без кредит')
      const status = (db.prepare('SELECT status FROM coin_purchase_ledger WHERE purchase_id = ?').get(coinId) as { status: string }).status
      assert(status === 'pending', `статус ${status}`)
    })

    await check('[5] след освобождаване: повторението кредитира точно веднъж', () => {
      const r1 = payCoin()
      const r2 = payCoin()
      assert(r1.ok && !r1.alreadyCredited && r2.ok && r2.alreadyCredited, JSON.stringify([r1, r2]))
      assert(walletOf('lock-coin') === 2250000, `wallet ${walletOf('lock-coin')}`)
    })

    await check('[6] VIP при заключена база → transient; после кредит веднъж', () => {
      const pending = vip.createPendingPurchase('lock-vip', 'vip_30', 499)
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      vip.attachCheckoutSession(pending.purchase.purchaseId, 'cs_lock_vip')
      const pay = () => runFulfillment(() => vip.fulfillPaidPurchase({ checkoutSessionId: 'cs_lock_vip', purchaseId: pending.purchase.purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 499 }))
      const locked = withWriteLock(pay)
      assert(!locked.ok && locked.transient === true, JSON.stringify(locked))
      const ok = pay()
      assert(ok.ok && !ok.alreadyCredited, JSON.stringify(ok))
      const grants = (db.prepare('SELECT COUNT(*) AS c FROM vip_grants WHERE purchase_id = ?').get(pending.purchase.purchaseId) as { c: number }).c
      assert(grants === 1, `grants ${grants}`)
    })

    // ── Settlement ───────────────────────────────────────────────────────
    const settleFail = (session: string, failure: PurchaseFulfillmentFailure, store: PaymentReviewIssueStore = issues, amount = 1699, status = 'paid') =>
      settleUncreditedPaidCheckout({ store, purchaseType: 'coin', stripeSession: paidSession(session, amount, status), stripeEventId: 'evt', failure })

    await check('[7] временна грешка → 500 + отворен is_transient запис', () => {
      const r = settleFail('cs_t1', transientFailure)
      assert(r.httpStatus === 500 && r.issue?.isTransient === true && r.issue.status === 'open', JSON.stringify(r))
    })

    await check('[8] успешна повторна доставка → 200, временният запис resolved, няма активни', () => {
      const r = settleCreditedPaidCheckout({ store: issues, checkoutSessionId: 'cs_t1' })
      assert(r.httpStatus === 200, JSON.stringify(r))
      const row = issueRow('cs_t1', 'credit_failed')
      assert(row?.status === 'resolved' && row.resolution_note === AUTO_RESOLVED_AFTER_CREDIT_NOTE && row.resolved_at !== null, JSON.stringify(row))
      assert(!issues.listOpenIssues().some((i) => i.checkoutSessionId === 'cs_t1'), 'няма активни за сесията')
    })

    await check('[9] временна, после окончателна (amount_mismatch) → временният resolved, окончателният open, 200', () => {
      settleFail('cs_t2', transientFailure)
      const r = settleFail('cs_t2', { ok: false, reason: 'amount_mismatch', message: 'сума', expectedAmountCents: 1699 }, issues, 999)
      assert(r.httpStatus === 200 && r.issue?.issueKind === 'amount_mismatch' && r.issue.isTransient === false, JSON.stringify(r))
      assert(issueRow('cs_t2', 'credit_failed')?.status === 'resolved', 'временният трябва да е resolved')
      assert(issueRow('cs_t2', 'amount_mismatch')?.status === 'open', 'окончателният open')
    })

    await check('[10] детерминистична техническа грешка → 200, open, is_transient=0', () => {
      const r = settleFail('cs_t3', deterministicFailure)
      assert(r.httpStatus === 200 && r.issue?.isTransient === false && r.issue.status === 'open', JSON.stringify(r))
    })

    await check('[11] временна → детерминистична (същия вид) → един ред, is_transient=0, open', () => {
      settleFail('cs_t4', transientFailure)
      const r = settleFail('cs_t4', deterministicFailure)
      assert(r.httpStatus === 200, JSON.stringify(r))
      const row = issueRow('cs_t4', 'credit_failed')
      assert(row?.is_transient === 0 && row.status === 'open' && row.occurrences === 2, JSON.stringify(row))
    })

    const brokenStore: PaymentReviewIssueStore = {
      ...issues,
      recordIssue: () => { throw sqliteError(10) },
      resolveTransientIssuesForSession: () => { throw sqliteError(10) },
    }

    await check('[12] окончателен проблем, записът не успява → 500', () => {
      const r = settleFail('cs_t5', { ok: false, reason: 'currency_mismatch', message: 'валута' }, brokenStore)
      assert(r.httpStatus === 500 && r.error !== null, JSON.stringify(r))
    })

    await check('[13] временна грешка, записът не успява → 500', () => {
      const r = settleFail('cs_t6', transientFailure, brokenStore)
      assert(r.httpStatus === 500 && r.error !== null, JSON.stringify(r))
    })

    await check('[14] неуспешно затваряне след успешен кредит → 500; повторението → alreadyCredited', () => {
      const r = settleCreditedPaidCheckout({ store: brokenStore, checkoutSessionId: 'cs_lock_coin' })
      assert(r.httpStatus === 500, JSON.stringify(r))
      const again = payCoin()
      assert(again.ok && again.alreadyCredited, JSON.stringify(again))
      assert(walletOf('lock-coin') === 2250000, 'без втори кредит')
    })

    await check('[15] непотвърдено плащане → 200, без запис', () => {
      const before = issues.listOpenIssues().length
      const r = settleFail('cs_t7', { ok: false, reason: 'not_paid', message: 'unpaid' }, issues, 1699, 'unpaid')
      assert(r.httpStatus === 200 && r.issue === null && issues.listOpenIssues().length === before, JSON.stringify(r))
    })

    await check('[16] балансът е committed, отговорът „изгубен“ → повторна доставка без втори кредит', () => {
      const pending = coin.createPendingPurchase('mark', 't-elite')
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      coin.attachCheckoutSession(pending.purchase.purchaseId, 'cs_lost_response')
      const pay = () => runFulfillment(() => coin.fulfillPaidPurchase({ checkoutSessionId: 'cs_lost_response', purchaseId: pending.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' }))
      const first = pay() // commit-нато, но приемаме, че 200-ката не е стигнала до Stripe
      assert(first.ok && !first.alreadyCredited, JSON.stringify(first))
      for (let i = 0; i < 3; i++) {
        const again = pay()
        assert(again.ok && again.alreadyCredited, JSON.stringify(again))
      }
      assert(walletOf('mark') === 2250000, `wallet ${walletOf('mark')}`)
    })

    // ── Имена в Checkout ─────────────────────────────────────────────────
    const urls = { successUrl: 'https://pika.bg/ok', cancelUrl: 'https://pika.bg/cancel' }
    const nameOf = (params: Stripe.Checkout.SessionCreateParams) => params.line_items?.[0]?.price_data?.product_data?.name ?? ''
    const priceOf = (params: Stripe.Checkout.SessionCreateParams) => params.line_items?.[0]?.price_data

    const oldOrder = coin.createPendingPurchase('names', 't-elite')
    const oldOrderSnapshot = oldOrder.ok ? oldOrder.purchase : null

    await check('[17] coin: „Елит — 2 250 000 жълтици“, цена/валута от snapshot-а', () => {
      assert(oldOrderSnapshot !== null, 'pending')
      if (!oldOrderSnapshot) return
      const params = buildCoinCheckoutSessionParams(oldOrderSnapshot, 'names', urls.successUrl, urls.cancelUrl)
      assert(nameOf(params) === nb('Елит — 2 250 000 жълтици'), `име: ${JSON.stringify(nameOf(params))}`)
      assert(priceOf(params)?.unit_amount === 1699 && priceOf(params)?.currency === 'eur', JSON.stringify(priceOf(params)))
      assert(params.line_items?.length === 1 && params.line_items[0].quantity === 1, 'един продукт, количество 1')
    })

    await check('[18] подновяване показва условията на поръчката; нова поръчка — новите', async () => {
      assert(oldOrderSnapshot !== null, 'pending')
      if (!oldOrderSnapshot) return
      // Магазинът се променя след създаването на поръчката (само количество).
      db.exec(`UPDATE coin_packages SET yellow_coins_amount = 3000000 WHERE package_id = 't-elite'`)
      // Подновяване на старата поръчка: условията ѝ вече не са актуални →
      // resume отказва (Meri86 fix); името за НЕЙНАТА сесия остава по snapshot-а.
      const staleParams = buildCoinCheckoutSessionParams(oldOrderSnapshot, 'names', urls.successUrl, urls.cancelUrl)
      assert(nameOf(staleParams) === nb('Елит — 2 250 000 жълтици'), `стара поръчка: ${nameOf(staleParams)}`)
      const fresh = coin.createPendingPurchase('names', 't-elite')
      assert(fresh.ok && fresh.purchase.purchaseId !== oldOrderSnapshot.purchaseId, 'нова поръчка')
      if (!fresh.ok) return
      const freshParams = buildCoinCheckoutSessionParams(fresh.purchase, 'names', urls.successUrl, urls.cancelUrl)
      assert(nameOf(freshParams) === nb('Елит — 3 000 000 жълтици'), `нова поръчка: ${nameOf(freshParams)}`)
      assert(priceOf(freshParams)?.unit_amount === 1699, 'цената непроменена')
      // Допустимо подновяване (актуални условия, изтекла сесия) → името на нейния snapshot.
      coin.attachCheckoutSession(fresh.purchase.purchaseId, 'cs_names_expired')
      const created: Array<Record<string, unknown>> = []
      const stripe = {
        checkout: {
          sessions: {
            retrieve: async () => ({ id: 'cs_names_expired', status: 'expired', url: null }),
            create: async (params: Record<string, unknown>) => {
              created.push(params)
              return { id: 'cs_names_new', status: 'open', url: 'https://stripe.test/names' }
            },
          },
        },
      } as unknown as Pick<Stripe, 'checkout'>
      const resumed = await resumeCoinPurchaseCheckout({ store: coin, stripe, purchaseId: fresh.purchase.purchaseId, profileId: 'names', ...urls })
      assert(resumed.ok, JSON.stringify(resumed))
      assert(nameOf(created[0] as Stripe.Checkout.SessionCreateParams) === nb('Елит — 3 000 000 жълтици'), `resume: ${JSON.stringify(created[0])}`)
    })

    await check('[19] VIP: „VIP — 365 дни“ от snapshot-а (не от каталога)', () => {
      const pending = vip.createPendingPurchase('names', 'vip_365', 6989)
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      const params = buildVipCheckoutSessionParams(pending.purchase, 'names', urls)
      assert(nameOf(params) === 'VIP — 365 дни' && priceOf(params)?.unit_amount === 6989, `${nameOf(params)} ${JSON.stringify(priceOf(params))}`)
      // Snapshot с различни дни от каталога (напр. стара поръчка) → показва snapshot-а.
      const fromSnapshot = buildVipCheckoutSessionParams({ ...pending.purchase, days: 90 }, 'names', urls)
      assert(nameOf(fromSnapshot) === 'VIP — 90 дни', nameOf(fromSnapshot))
    })

    await check('[20] bundle: „Ултра — 4 500 000 жълтици + 365 дни VIP“', () => {
      const pending = bundle.createPendingPurchase('names', 't-ultra')
      assert(pending.ok, 'pending')
      if (!pending.ok) return
      const params = buildBundleCheckoutSessionParams(pending.purchase, 'names', urls)
      assert(nameOf(params) === nb('Ултра — 4 500 000 жълтици + 365 дни VIP'), `име: ${JSON.stringify(nameOf(params))}`)
      assert(priceOf(params)?.unit_amount === 4999 && priceOf(params)?.currency === 'eur', JSON.stringify(priceOf(params)))
      assert(params.metadata?.purchaseType === 'bundle' && params.metadata?.purchaseId === pending.purchase.purchaseId, 'metadata')
    })

    await check('[21] единствено число и разделители', () => {
      assert(buildCoinCheckoutProductName({ title: 'Мини', yellowCoinsAmount: 1 }) === 'Мини — 1 жълтица', 'жълтица')
      assert(buildBundleCheckoutProductName({ titleSnapshot: 'Проба', yellowCoinsAmount: 12000, vipDays: 1 }) === nb('Проба — 12 000 жълтици + 1 ден VIP'), 'ден')
    })

    await check('[22] дълго име → ≤ 250 символа, условията остават, emoji не се реже', () => {
      const longTitle = '🎁'.repeat(300)
      const name = buildBundleCheckoutProductName({ titleSnapshot: longTitle, yellowCoinsAmount: 4500000, vipDays: 365 })
      assert(Array.from(name).length <= CHECKOUT_PRODUCT_NAME_MAX_LENGTH, `дължина ${Array.from(name).length}`)
      assert(name.endsWith(nb(' — 4 500 000 жълтици + 365 дни VIP')), name.slice(-40))
      assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(name), 'срязана surrogate двойка')
    })

    await check('[23] metadata в Stripe лимитите (ключ ≤ 40, стойност ≤ 500, ≤ 50 ключа)', () => {
      const all = [
        oldOrderSnapshot ? buildCoinCheckoutSessionParams(oldOrderSnapshot, 'names', urls.successUrl, urls.cancelUrl) : null,
      ].filter((p): p is Stripe.Checkout.SessionCreateParams => p !== null)
      for (const params of all) {
        const entries = Object.entries(params.metadata ?? {})
        assert(entries.length <= 50, 'брой ключове')
        for (const [k, v] of entries) assert(k.length <= 40 && String(v).length <= 500, `${k}`)
      }
    })

    await check('[24] „Купи“ и resume за една поръчка → идентични параметри', () => {
      assert(oldOrderSnapshot !== null, 'pending')
      if (!oldOrderSnapshot) return
      const a = buildCoinCheckoutSessionParams(oldOrderSnapshot, 'names', urls.successUrl, urls.cancelUrl)
      const b = buildCoinCheckoutSessionParams(oldOrderSnapshot, 'names', urls.successUrl, urls.cancelUrl)
      assert(JSON.stringify(a) === JSON.stringify(b), 'детерминистични параметри')
    })
  } finally {
    locker.close()
    coin.close()
    vip.close()
    bundle.close()
    issues.close()
    db.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()

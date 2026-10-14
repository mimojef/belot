/**
 * checkStalePendingPurchaseOffer.ts — регресия за инцидент Meri86 (14.10.2026).
 *
 * Bug: createPendingPurchase() reuse-ваше видим pending ред за същия
 * profile+package, без да сравнява snapshot-а с актуалните условия на пакета.
 * Админ увеличи „Елит“ от 1 500 000 на 2 250 000 жълтици; клиентка с pending
 * ред от 24.09 натисна „Купи“ на 14.10, магазинът показа 2 250 000, но
 * /api/shop/checkout върза нова Stripe сесия към СТАРИЯ ред → webhook
 * кредитира 1 500 000. Resume от историята („Плати“) имаше същия ефект, а
 * confirm модалът му показваше ТЕКУЩИЯ пакет (2 250 000).
 *
 * Пуска се върху РЕАЛНИТЕ миграции (unique индексите са част от теста).
 *
 * Coins:
 * [1]  pending при непроменени условия → reuse на същия ред
 * [2]  смяна на количеството → нов pending ред с новите условия
 * [3]  старият ред: скрит, още pending, session id и snapshot непроменени
 * [4]  историята показва само новия ред; polling по стара сесия намира скрития
 * [5]  webhook за новата сесия → точно 2 250 000; повторен webhook → без двойно начисляване
 * [6]  плащане по старата (още отворена) сесия → старите условия, точно веднъж
 * [7]  смяна само на цената → също нов ред
 * [8]  isPurchaseOfferCurrent: true за актуален, false за остарял/неактивен пакет
 * Resume (coins):
 * [9]  остарял ред без сесия → 409, без Stripe create
 * [10] остарял ред с отворена сесия → 409, URL не се връща
 * [11] остарял ред с complete сесия → съобщение „обработва се“, не stale
 * [12] актуален ред с expired сесия → нова сесия с актуалните условия
 * [13] неактивен пакет → 409, без Stripe create
 * Сверка на платеното (coins):
 * [14] различна сума → не се кредитира, редът остава pending, wallet непроменен
 * [15] различна валута → не се кредитира
 * [16] липсващ amount_total (-1) → не се кредитира
 * [17] валутата се сравнява case-insensitive (Stripe връща 'eur'); коректното плащане минава
 * [18] повторен webhook за вече кредитиран ред с различна сума → idempotent alreadyCredited
 * Конкурентност:
 * [19] две заявки за нова покупка от различни DB връзки → един нов ред, reuse от втората
 * [20] два конкурентни webhook-а от различни връзки → кредит точно веднъж
 * Компенсация (Meri86):
 * [21] платен ред + ръчна компенсация → нищо не се начислява повторно
 * VIP:
 * [22] стара VIP поръчка при променена цена → нов ред с новата цена, старият скрит/pending
 * [23] VIP при непроменена цена → reuse
 * [24] стара отворена VIP сесия → завършва по старата цена, точно веднъж
 * [25] нова VIP сесия → по новата цена; грешна сума → отказ
 * [26] VIP listProfilePurchases връща и скрития ред (polling след redirect)
 * Bundle:
 * [27] bundle reuse при непроменени условия; смяна на жълтици → нов ред, стар скрит
 * [28] стара bundle поръчка при променени VIP дни → нов ред
 * [29] bundle webhook за новия ред → новите жълтици точно веднъж; polling по стара сесия
 * Клиент:
 * [30] computeShopResumeConfirmOpen → 'offer-changed' при остарели условия, ok при актуални
 * Миграция 20261019_001:
 * [31] прилага се върху DB със съществуващи VIP pending/paid редове — данните остават,
 *      hidden_at = NULL, индексът е с новия predicate
 * Паралелност (worker threads = реални отделни връзки, синхронизиран старт):
 * [32] 4 паралелни „Купи“ за coins/bundle/VIP след смяна на условията →
 *      всички ok, един и същ нов ред, точно един видим pending
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
import { resumeCoinPurchaseCheckout } from '../src/shop/resumeCoinPurchaseCheckout.js'
import { computeShopResumeConfirmOpen } from '../../src/app/lobby/shopResumeConfirmState.js'
import type { CoinPackageSnapshot, CoinPurchaseSnapshot } from '../../src/app/network/createGameServerClient.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const migrationsDir = resolve(__dirname, '..', 'database', 'migrations')
const VIP_MIGRATION = '20261019_001_add_hidden_at_to_vip_purchase_ledger.sql'

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

async function applyMigrations(dbPath: string, stopBefore?: string): Promise<void> {
  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    if (stopBefore !== undefined && file >= stopBefore) break
    db.exec(await readFile(join(migrationsDir, file), 'utf8'))
  }
  db.close()
}

type FakeSession = { id: string; status: 'open' | 'expired' | 'complete'; url: string | null }

function makeFakeStripe(retrieveResult: FakeSession, createResult: FakeSession) {
  const createCalls: Array<Record<string, unknown>> = []
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (): Promise<FakeSession> => retrieveResult,
        create: async (params: unknown): Promise<FakeSession> => {
          createCalls.push(params as Record<string, unknown>)
          return createResult
        },
      },
    },
  }
  return { stripe: stripe as unknown as Pick<Stripe, 'checkout'>, createCalls }
}

async function runMainScenarios(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-stale-pending-offer-'))
  const dbPath = join(tempDir, 'stale.sqlite')

  await applyMigrations(dbPath)

  const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')

  for (const profileId of ['prof-meri', 'prof-other', 'prof-bundle', 'prof-race', 'prof-vip', 'prof-comp']) {
    db.prepare('INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(profileId, profileId, profileId)
  }

  db.prepare(`
    INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
    VALUES ('pkg-elite-test', 'elite-test', 'Елит', 1500000, 1699, 'EUR', 'active')
  `).run()

  db.prepare(`
    INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status)
    VALUES ('bundle-test', 'bundle-test', 'Комбо', 500000, 30, 999, 'EUR', 'active')
  `).run()

  const setElite = (coins: number, priceCents: number, status = 'active'): void => {
    db.prepare(`
      UPDATE coin_packages SET yellow_coins_amount = ?, price_cents = ?, status = ? WHERE package_id = 'pkg-elite-test'
    `).run(coins, priceCents, status)
  }
  const walletOf = (profileId: string): number =>
    ((db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(profileId) as { b: number } | undefined)?.b) ?? 0
  const rawRow = (purchaseId: string) =>
    db.prepare('SELECT * FROM coin_purchase_ledger WHERE purchase_id = ?').get(purchaseId) as Record<string, unknown>
  const visiblePendingCount = (table: string, profileId: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL`).get(profileId) as { c: number }).c

  const store = await createCoinPurchaseStore(dbPath)
  const store2 = await createCoinPurchaseStore(dbPath)
  const bundleStore = await createBundlePurchaseStore(dbPath)
  const vipStore = await createVipPurchaseStore(dbPath)

  // Webhook-еквивалент на coin клона в index.ts (amount_total ?? -1, currency).
  const payCoin = (s: typeof store, sessionId: string, purchaseId: string, amount = 1699, currency = 'eur') =>
    s.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, amountPaidCents: amount, currency })

  try {
    // ── Coins ────────────────────────────────────────────────────────────
    const first = store.createPendingPurchase('prof-meri', 'pkg-elite-test')
    assert(first.ok, 'първото createPendingPurchase трябва да е ok')
    const oldId = first.ok ? first.purchase.purchaseId : ''
    store.attachCheckoutSession(oldId, 'cs_old')

    await check('[1] непроменени условия → reuse на същия pending ред', () => {
      const again = store.createPendingPurchase('prof-meri', 'pkg-elite-test')
      assert(again.ok && again.purchase.purchaseId === oldId, 'очакван reuse')
      assert(again.ok && again.purchase.yellowCoinsAmount === 1500000, 'очаквани 1 500 000')
    })

    setElite(2250000, 1699)

    let newId = ''
    await check('[2] смяна на количеството → нов pending ред с 2 250 000', () => {
      const fresh = store.createPendingPurchase('prof-meri', 'pkg-elite-test')
      assert(fresh.ok, `очакван ok: ${JSON.stringify(fresh)}`)
      if (!fresh.ok) return
      newId = fresh.purchase.purchaseId
      assert(newId !== oldId, 'очакван НОВ purchase_id, получен стария')
      assert(fresh.purchase.yellowCoinsAmount === 2250000, `очаквани 2 250 000, получени ${fresh.purchase.yellowCoinsAmount}`)
      assert(fresh.purchase.priceCents === 1699, 'цената трябва да е 1699')
    })
    store.attachCheckoutSession(newId, 'cs_new')

    await check('[3] старият ред: скрит, pending, session id и snapshot непроменени', () => {
      const old = rawRow(oldId)
      assert(old.hidden_at !== null, 'старият ред трябва да е скрит')
      assert(old.status === 'pending', `статусът трябва да остане pending, а е ${String(old.status)}`)
      assert(old.provider_checkout_session_id === 'cs_old', 'session id на стария ред не трябва да се променя')
      assert(old.yellow_coins_amount === 1500000, 'snapshot-ът на стария ред не се пипа')
    })

    await check('[4] история: само новият ред; polling по стара сесия намира скрития', () => {
      const ids = store.listProfilePurchases('prof-meri').map((p) => p.purchaseId)
      assert(ids.includes(newId) && !ids.includes(oldId), `история: ${JSON.stringify(ids)}`)
      const polled = store.findProfilePurchaseByCheckoutSessionId('prof-meri', 'cs_old')
      assert(polled?.purchaseId === oldId, 'polling трябва да намери скрития ред по собствена сесия')
      assert(store.findProfilePurchaseByCheckoutSessionId('prof-other', 'cs_old') === null, 'чужд профил не трябва да го вижда')
    })

    await check('[5] webhook за новата сесия → +2 250 000 точно веднъж', () => {
      const before = walletOf('prof-meri')
      const r1 = payCoin(store, 'cs_new', newId)
      assert(r1.ok && !r1.alreadyCredited, `първи webhook: ${JSON.stringify(r1)}`)
      const r2 = payCoin(store, 'cs_new', newId)
      assert(r2.ok && r2.alreadyCredited, 'повторен webhook трябва да е alreadyCredited')
      assert(walletOf('prof-meri') - before === 2250000, `делта ${walletOf('prof-meri') - before}`)
    })

    await check('[6] плащане по старата отворена сесия → 1 500 000 точно веднъж', () => {
      const before = walletOf('prof-meri')
      const r1 = payCoin(store, 'cs_old', oldId)
      assert(r1.ok && !r1.alreadyCredited, `webhook по стара сесия: ${JSON.stringify(r1)}`)
      const r2 = payCoin(store, 'cs_old', oldId)
      assert(r2.ok && r2.alreadyCredited, 'повторен webhook трябва да е alreadyCredited')
      assert(walletOf('prof-meri') - before === 1500000, `делта ${walletOf('prof-meri') - before}`)
      assert(store.findProfilePurchaseByCheckoutSessionId('prof-meri', 'cs_old')?.status === 'paid', 'polling вижда paid')
    })

    await check('[7] смяна само на цената → нов pending ред', () => {
      const a = store.createPendingPurchase('prof-other', 'pkg-elite-test')
      assert(a.ok, 'a ok')
      setElite(2250000, 1899)
      const b = store.createPendingPurchase('prof-other', 'pkg-elite-test')
      assert(a.ok && b.ok && a.purchase.purchaseId !== b.purchase.purchaseId, 'очакван нов ред при нова цена')
      assert(b.ok && b.purchase.priceCents === 1899, 'новият ред трябва да е с 1899')
      setElite(2250000, 1699)
    })

    // Подготовка за resume: актуален и остарял pending ред за prof-other.
    const current = store.createPendingPurchase('prof-other', 'pkg-elite-test')
    const currentId = current.ok ? current.purchase.purchaseId : ''
    // Ред с по-стари условия, симулиран директно (както реалния ред от 24.09).
    db.prepare(`
      INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
        yellow_coins_amount, price_cents, currency, status, hidden_at)
      VALUES ('stale-1', 'prof-other', 'pkg-elite-test', 'elite-test', 'Елит', 1500000, 1699, 'EUR', 'pending', CURRENT_TIMESTAMP)
    `).run()
    // Unique индексът позволява само един видим pending ред за profile+package,
    // затова за [9]-[11] currentId се скрива, а stale-1 се показва.
    db.prepare(`UPDATE coin_purchase_ledger SET hidden_at = CURRENT_TIMESTAMP WHERE purchase_id = ?`).run(currentId)
    db.prepare(`UPDATE coin_purchase_ledger SET hidden_at = NULL WHERE purchase_id = 'stale-1'`).run()

    await check('[8] isPurchaseOfferCurrent: актуален / остарял / неактивен', () => {
      assert(store.isPurchaseOfferCurrent(newId), 'новият ред трябва да е актуален')
      assert(!store.isPurchaseOfferCurrent(oldId), 'старият ред трябва да е остарял')
      setElite(2250000, 1699, 'inactive')
      assert(!store.isPurchaseOfferCurrent(newId), 'неактивен пакет → не е актуален')
      setElite(2250000, 1699)
    })

    const resume = (purchaseId: string, stripe: Pick<Stripe, 'checkout'>) =>
      resumeCoinPurchaseCheckout({
        store,
        stripe,
        purchaseId,
        profileId: 'prof-other',
        successUrl: 'https://pika.bg/ok',
        cancelUrl: 'https://pika.bg/cancel',
      })

    await check('[9] resume на остарял ред без сесия → 409, без Stripe create', async () => {
      const { stripe, createCalls } = makeFakeStripe(
        { id: 'x', status: 'expired', url: null },
        { id: 'cs_should_not', status: 'open', url: 'https://stripe/should-not' },
      )
      const r = await resume('stale-1', stripe)
      assert(!r.ok && r.status === 409 && r.message.includes('Купи пакета отново'), `очакван 409: ${JSON.stringify(r)}`)
      assert(createCalls.length === 0, 'не трябва да има Stripe create')
      assert(rawRow('stale-1').provider_checkout_session_id === null, 'няма закачена сесия')
    })

    db.prepare(`UPDATE coin_purchase_ledger SET provider_checkout_session_id = 'cs_stale_open' WHERE purchase_id = 'stale-1'`).run()

    await check('[10] resume на остарял ред с отворена сесия → 409, без URL', async () => {
      const { stripe, createCalls } = makeFakeStripe(
        { id: 'cs_stale_open', status: 'open', url: 'https://stripe/old-open' },
        { id: 'cs_should_not', status: 'open', url: 'https://stripe/should-not' },
      )
      const r = await resume('stale-1', stripe)
      assert(!r.ok && r.status === 409, `очакван 409: ${JSON.stringify(r)}`)
      assert(createCalls.length === 0, 'не трябва да има Stripe create')
    })

    await check('[11] resume на остарял ред с complete сесия → „обработва се“', async () => {
      const { stripe } = makeFakeStripe(
        { id: 'cs_stale_open', status: 'complete', url: null },
        { id: 'cs_should_not', status: 'open', url: 'https://stripe/should-not' },
      )
      const r = await resume('stale-1', stripe)
      assert(!r.ok && r.status === 409 && r.message.includes('обработва'), `съобщение: ${JSON.stringify(r)}`)
    })

    // Обратно: currentId става единственият видим pending.
    db.prepare(`UPDATE coin_purchase_ledger SET hidden_at = CURRENT_TIMESTAMP WHERE purchase_id = 'stale-1'`).run()
    db.prepare(`UPDATE coin_purchase_ledger SET hidden_at = NULL WHERE purchase_id = ?`).run(currentId)
    db.prepare(`UPDATE coin_purchase_ledger SET provider_checkout_session_id = 'cs_cur_expired' WHERE purchase_id = ?`).run(currentId)

    await check('[12] resume на актуален ред с expired сесия → нова сесия с 2 250 000', async () => {
      const { stripe, createCalls } = makeFakeStripe(
        { id: 'cs_cur_expired', status: 'expired', url: null },
        { id: 'cs_cur_new', status: 'open', url: 'https://stripe/cur-new' },
      )
      const r = await resume(currentId, stripe)
      assert(r.ok, `очакван ok: ${JSON.stringify(r)}`)
      const meta = createCalls[0]?.metadata as Record<string, string> | undefined
      assert(createCalls.length === 1 && meta?.coins === '2250000', `metadata: ${JSON.stringify(meta)}`)
    })

    await check('[13] resume при неактивен пакет → 409, без Stripe create', async () => {
      db.prepare(`UPDATE coin_purchase_ledger SET provider_checkout_session_id = 'cs_cur_expired2' WHERE purchase_id = ?`).run(currentId)
      setElite(2250000, 1699, 'inactive')
      const { stripe, createCalls } = makeFakeStripe(
        { id: 'cs_cur_expired2', status: 'expired', url: null },
        { id: 'cs_should_not', status: 'open', url: 'https://stripe/should-not' },
      )
      const r = await resume(currentId, stripe)
      setElite(2250000, 1699)
      assert(!r.ok && r.status === 409, `очакван 409: ${JSON.stringify(r)}`)
      assert(createCalls.length === 0, 'не трябва да има Stripe create')
    })

    // ── Сверка на платеното (coins) — currentId, сесия cs_cur_expired2 ──
    const assertNotCredited = (label: string, result: ReturnType<typeof payCoin>, before: number): void => {
      assert(!result.ok, `${label}: очакван отказ, получен ${JSON.stringify(result)}`)
      assert(rawRow(currentId).status === 'pending', `${label}: редът трябва да остане pending`)
      assert(walletOf('prof-other') === before, `${label}: wallet се промени`)
    }

    await check('[14] различна сума → не се кредитира', () => {
      assertNotCredited('сума', payCoin(store, 'cs_cur_expired2', currentId, 1599), walletOf('prof-other'))
    })

    await check('[15] различна валута → не се кредитира', () => {
      assertNotCredited('валута', payCoin(store, 'cs_cur_expired2', currentId, 1699, 'bgn'), walletOf('prof-other'))
    })

    await check('[16] липсващ amount_total (-1) → не се кредитира', () => {
      assertNotCredited('amount_total', payCoin(store, 'cs_cur_expired2', currentId, -1), walletOf('prof-other'))
    })

    await check('[17] коректно плащане (валута в lowercase като от Stripe) → кредитира точно 2 250 000', () => {
      const before = walletOf('prof-other')
      const r = payCoin(store, 'cs_cur_expired2', currentId, 1699, 'eur')
      assert(r.ok && !r.alreadyCredited, `очакван кредит: ${JSON.stringify(r)}`)
      assert(walletOf('prof-other') - before === 2250000, `делта ${walletOf('prof-other') - before}`)
    })

    await check('[18] повторен webhook за кредитиран ред с различна сума → alreadyCredited, без промяна', () => {
      const before = walletOf('prof-other')
      const r = payCoin(store, 'cs_cur_expired2', currentId, 1)
      assert(r.ok && r.alreadyCredited, `очакван alreadyCredited: ${JSON.stringify(r)}`)
      assert(walletOf('prof-other') === before, 'wallet се промени')
    })

    // ── Конкурентност ────────────────────────────────────────────────────
    await check('[19] две заявки за нова покупка (различни връзки) → един нов ред', async () => {
      const seed = store.createPendingPurchase('prof-race', 'pkg-elite-test')
      assert(seed.ok, 'seed ok')
      setElite(3000000, 1699)
      const [a, b] = await Promise.all([
        Promise.resolve().then(() => store.createPendingPurchase('prof-race', 'pkg-elite-test')),
        Promise.resolve().then(() => store2.createPendingPurchase('prof-race', 'pkg-elite-test')),
      ])
      setElite(2250000, 1699)
      assert(a.ok && b.ok, `и двете трябва да са ok: ${JSON.stringify([a, b])}`)
      assert(a.ok && b.ok && a.purchase.purchaseId === b.purchase.purchaseId, 'втората заявка трябва да reuse-не реда на първата')
      assert(a.ok && a.purchase.yellowCoinsAmount === 3000000, 'новият ред е с новите условия')
      assert(visiblePendingCount('coin_purchase_ledger', 'prof-race') === 1, 'точно един видим pending')
      const total = (db.prepare(`SELECT COUNT(*) AS c FROM coin_purchase_ledger WHERE profile_id = 'prof-race'`).get() as { c: number }).c
      assert(total === 2, `очаквани 2 реда общо (стар скрит + нов), има ${total}`)
    })

    await check('[20] два конкурентни webhook-а (различни връзки) → кредит точно веднъж', async () => {
      const pending = store.createPendingPurchase('prof-race', 'pkg-elite-test')
      assert(pending.ok, 'pending ok')
      if (!pending.ok) return
      // Скриване на стария race ред не е нужно — същите условия → reuse.
      store.attachCheckoutSession(pending.purchase.purchaseId, 'cs_race')
      const before = walletOf('prof-race')
      const [r1, r2] = await Promise.all([
        Promise.resolve().then(() => store.fulfillPaidPurchase({ checkoutSessionId: 'cs_race', purchaseId: pending.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' })),
        Promise.resolve().then(() => store2.fulfillPaidPurchase({ checkoutSessionId: 'cs_race', purchaseId: pending.purchase.purchaseId, amountPaidCents: 1699, currency: 'eur' })),
      ])
      assert(r1.ok && r2.ok, `и двата ok: ${JSON.stringify([r1, r2])}`)
      const fresh = [r1, r2].filter((r) => r.ok && !r.alreadyCredited).length
      assert(fresh === 1, `точно един реален кредит, получени ${fresh}`)
      assert(walletOf('prof-race') - before === pending.purchase.yellowCoinsAmount, `делта ${walletOf('prof-race') - before}`)
    })

    // ── Компенсация (Meri86) ─────────────────────────────────────────────
    await check('[21] платен ред + ръчна компенсация → нищо не се начислява повторно', () => {
      // Възпроизвежда продукционното състояние: paid ред с 1 500 000 + ръчно
      // +750 000 директно в profile_wallets, без ledger запис.
      db.prepare(`
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
        VALUES ('401c6f6b-test', 'prof-comp', 'pkg-elite-test', 'elite-test', 'Елит', 1500000, 1699, 'EUR',
          'cs_meri_paid', 'paid', CURRENT_TIMESTAMP)
      `).run()
      db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('prof-comp', 2250000)`).run()
      const before = walletOf('prof-comp')
      const rowBefore = JSON.stringify(rawRow('401c6f6b-test'))

      const redelivered = payCoin(store, 'cs_meri_paid', '401c6f6b-test')
      assert(redelivered.ok && redelivered.alreadyCredited, `повторен webhook: ${JSON.stringify(redelivered)}`)
      const fresh = store.createPendingPurchase('prof-comp', 'pkg-elite-test')
      assert(fresh.ok && fresh.purchase.purchaseId !== '401c6f6b-test', 'нова покупка не засяга платения ред')

      assert(JSON.stringify(rawRow('401c6f6b-test')) === rowBefore, 'платеният ред не трябва да се променя')
      assert(walletOf('prof-comp') === before, `wallet се промени: ${before} → ${walletOf('prof-comp')}`)
    })

    // ── VIP ──────────────────────────────────────────────────────────────
    const vipRow = (purchaseId: string) =>
      db.prepare('SELECT * FROM vip_purchase_ledger WHERE purchase_id = ?').get(purchaseId) as Record<string, unknown>
    const vipOld = vipStore.createPendingPurchase('prof-vip', 'vip_30', 499)
    const vipOldId = vipOld.ok ? vipOld.purchase.purchaseId : ''
    const vipDays = vipOld.ok ? vipOld.purchase.days : 0
    vipStore.attachCheckoutSession(vipOldId, 'cs_vip_old')

    let vipNewId = ''
    await check('[22] стара VIP поръчка при променена цена → нов ред, старият скрит/pending', () => {
      const fresh = vipStore.createPendingPurchase('prof-vip', 'vip_30', 599)
      assert(fresh.ok, `ok: ${JSON.stringify(fresh)}`)
      if (!fresh.ok) return
      vipNewId = fresh.purchase.purchaseId
      assert(vipNewId !== vipOldId && fresh.purchase.priceCents === 599, 'очакван нов ред с 599')
      const old = vipRow(vipOldId)
      assert(old.hidden_at !== null && old.status === 'pending', 'старият VIP ред: скрит и pending')
      assert(old.price_cents_snapshot === 499 && old.provider_checkout_session_id === 'cs_vip_old', 'старият snapshot/сесия непроменени')
      assert(visiblePendingCount('vip_purchase_ledger', 'prof-vip') === 1, 'точно един видим pending')
    })
    vipStore.attachCheckoutSession(vipNewId, 'cs_vip_new')

    await check('[23] VIP при непроменена цена → reuse', () => {
      const again = vipStore.createPendingPurchase('prof-vip', 'vip_30', 599)
      assert(again.ok && again.purchase.purchaseId === vipNewId, 'очакван reuse')
    })

    const payVip = (sessionId: string, purchaseId: string, amount: number) =>
      vipStore.fulfillPaidPurchase({ checkoutSessionId: sessionId, purchaseId, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: amount })

    await check('[24] стара отворена VIP сесия → по старата цена, точно веднъж', () => {
      const r1 = payVip('cs_vip_old', vipOldId, 499)
      assert(r1.ok && !r1.alreadyCredited, `първи: ${JSON.stringify(r1)}`)
      const r2 = payVip('cs_vip_old', vipOldId, 499)
      assert(r2.ok && r2.alreadyCredited, 'повторен webhook → alreadyCredited')
      const grants = (db.prepare(`SELECT COUNT(*) AS c FROM vip_grants WHERE purchase_id = ?`).get(vipOldId) as { c: number }).c
      assert(grants === 1, `очакван 1 VIP grant, има ${grants}`)
      assert(vipRow(vipOldId).days_snapshot === vipDays, 'дните по стария snapshot')
    })

    await check('[25] нова VIP сесия: грешна сума → отказ; коректна → по новата цена', () => {
      const bad = payVip('cs_vip_new', vipNewId, 499)
      assert(!bad.ok && vipRow(vipNewId).status === 'pending', `грешна сума трябва да е отказ: ${JSON.stringify(bad)}`)
      const good = payVip('cs_vip_new', vipNewId, 599)
      assert(good.ok && !good.alreadyCredited && good.purchase.priceCents === 599, `коректно: ${JSON.stringify(good)}`)
    })

    await check('[26] VIP listProfilePurchases връща и скрития ред (polling)', () => {
      const ids = vipStore.listProfilePurchases('prof-vip').map((p) => p.purchaseId)
      assert(ids.includes(vipOldId) && ids.includes(vipNewId), `списък: ${JSON.stringify(ids)}`)
    })

    // ── Bundle ───────────────────────────────────────────────────────────
    const b1 = bundleStore.createPendingPurchase('prof-bundle', 'bundle-test')
    const b1Id = b1.ok ? b1.purchase.purchaseId : ''
    bundleStore.attachCheckoutSession(b1Id, 'cs_b_old')

    await check('[27] bundle: reuse при същите условия; нови жълтици → нов ред, стар скрит', () => {
      const same = bundleStore.createPendingPurchase('prof-bundle', 'bundle-test')
      assert(same.ok && same.purchase.purchaseId === b1Id, 'очакван reuse')
      db.prepare(`UPDATE shop_bundle_packages SET yellow_coins_amount = 750000 WHERE package_id = 'bundle-test'`).run()
      const fresh = bundleStore.createPendingPurchase('prof-bundle', 'bundle-test')
      assert(fresh.ok && fresh.purchase.purchaseId !== b1Id, 'очакван нов ред')
      assert(fresh.ok && fresh.purchase.yellowCoinsAmount === 750000, 'очаквани 750 000')
      const old = db.prepare('SELECT hidden_at, status FROM bundle_purchase_ledger WHERE purchase_id = ?').get(b1Id) as { hidden_at: string | null; status: string }
      assert(old.hidden_at !== null && old.status === 'pending', 'старият bundle ред: скрит и pending')
    })

    let b3Id = ''
    await check('[28] стара bundle поръчка при променени VIP дни → нов ред', () => {
      const before = bundleStore.createPendingPurchase('prof-bundle', 'bundle-test')
      db.prepare(`UPDATE shop_bundle_packages SET vip_days = 60 WHERE package_id = 'bundle-test'`).run()
      const after = bundleStore.createPendingPurchase('prof-bundle', 'bundle-test')
      assert(before.ok && after.ok && before.purchase.purchaseId !== after.purchase.purchaseId, 'очакван нов ред')
      assert(after.ok && after.purchase.vipDays === 60, 'очаквани 60 дни')
      b3Id = after.ok ? after.purchase.purchaseId : ''
      assert(visiblePendingCount('bundle_purchase_ledger', 'prof-bundle') === 1, 'точно един видим pending')
    })
    bundleStore.attachCheckoutSession(b3Id, 'cs_b_new')

    await check('[29] bundle webhook за новия ред → +750 000 точно веднъж; polling по стара сесия', () => {
      const before = walletOf('prof-bundle')
      const pay = () => bundleStore.fulfillPaidPurchase({ checkoutSessionId: 'cs_b_new', purchaseId: b3Id, stripePaymentStatus: 'paid', stripeCurrency: 'EUR', stripeAmountTotalCents: 999 })
      const r1 = pay()
      assert(r1.ok && !r1.alreadyCredited, `първи webhook: ${JSON.stringify(r1)}`)
      const r2 = pay()
      assert(r2.ok && r2.alreadyCredited, 'повторен webhook трябва да е alreadyCredited')
      assert(walletOf('prof-bundle') - before === 750000, `делта ${walletOf('prof-bundle') - before}`)
      assert(bundleStore.findProfilePurchaseByCheckoutSessionId('prof-bundle', 'cs_b_old')?.purchaseId === b1Id, 'polling намира скрития bundle ред')
      assert(!bundleStore.listProfilePurchases('prof-bundle').some((p) => p.purchaseId === b1Id), 'историята не показва скрития bundle ред')
    })
  } finally {
    store.close()
    store2.close()
    bundleStore.close()
    vipStore.close()
    db.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function runClientScenarios(): Promise<void> {
  return check('[30] computeShopResumeConfirmOpen → offer-changed при остарели условия', () => {
    const pkg = { packageId: 'pkg-elite', yellowCoinsAmount: 2250000, priceCents: 1699, currency: 'EUR' } as CoinPackageSnapshot
    const purchase = {
      purchaseId: 'p1', packageId: 'pkg-elite', status: 'pending', yellowCoinsAmount: 1500000, priceCents: 1699, currency: 'EUR',
    } as CoinPurchaseSnapshot
    const stale = computeShopResumeConfirmOpen('p1', { purchases: [purchase], shopPackages: [pkg], lobbyPackages: [] })
    assert(!stale.ok && stale.reason === 'offer-changed', `очакван offer-changed: ${JSON.stringify(stale)}`)
    const currentPurchase = { ...purchase, yellowCoinsAmount: 2250000 } as CoinPurchaseSnapshot
    const ok = computeShopResumeConfirmOpen('p1', { purchases: [currentPurchase], shopPackages: [pkg], lobbyPackages: [] })
    assert(ok.ok, `очакван ok: ${JSON.stringify(ok)}`)
  })
}

async function runMigrationScenario(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-vip-hidden-migration-'))
  const dbPath = join(tempDir, 'pre.sqlite')

  try {
    await applyMigrations(dbPath, VIP_MIGRATION)

    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    db.exec('PRAGMA foreign_keys = ON;')
    try {
      db.exec(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('m1', 'm1', 'm1'), ('m2', 'm2', 'm2');
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status)
          VALUES ('v-pending', 'm1', 'vip_30', 30, 499, 'EUR', 'pending');
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, recipient_profile_id, recipient_display_name_snapshot)
          VALUES ('v-gift-pending', 'm1', 'vip_30', 30, 499, 'EUR', 'pending', 'm2', 'm2');
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status, credited_at)
          VALUES ('v-paid', 'm1', 'vip_30', 30, 499, 'EUR', 'paid', CURRENT_TIMESTAMP);
      `)
      const before = JSON.stringify(db.prepare('SELECT * FROM vip_purchase_ledger ORDER BY purchase_id').all())

      db.exec(await readFile(join(migrationsDir, VIP_MIGRATION), 'utf8'))

      await check('[31] миграция 20261019_001 върху съществуващи VIP редове', () => {
        const rows = db.prepare('SELECT * FROM vip_purchase_ledger ORDER BY purchase_id').all() as Array<Record<string, unknown>>
        assert(rows.length === 3 && rows.every((r) => r.hidden_at === null), 'редовете остават, hidden_at = NULL')
        const withoutHidden = JSON.stringify(rows.map(({ hidden_at: _h, ...rest }) => rest))
        assert(withoutHidden === before, 'данните не трябва да се променят')
        const indexSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_vip_purchase_ledger_pending_package'`).get() as { sql: string }).sql
        assert(indexSql.includes('hidden_at IS NULL') && indexSql.includes('COALESCE(recipient_profile_id, profile_id)'), `индекс: ${indexSql}`)
        let duplicateRejected = false
        try {
          db.exec(`INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status)
            VALUES ('v-dup', 'm1', 'vip_30', 30, 599, 'EUR', 'pending')`)
        } catch {
          duplicateRejected = true
        }
        assert(duplicateRejected, 'втори видим pending за същия ключ трябва да е отхвърлен')
        db.exec(`UPDATE vip_purchase_ledger SET hidden_at = CURRENT_TIMESTAMP WHERE purchase_id = 'v-pending'`)
        db.exec(`INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, status)
          VALUES ('v-new', 'm1', 'vip_30', 30, 599, 'EUR', 'pending')`)
      })
    } finally {
      db.close()
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

type ParallelWorkerData = {
  dbPath: string
  kind: 'coin' | 'vip' | 'bundle'
  profileId: string
  packageId: string
  priceCents: number
  barrier: SharedArrayBuffer
}

type ParallelResult = { ok: boolean; purchaseId?: string; error?: string }

// Worker: собствена DB връзка, изчаква общия старт, после createPendingPurchase.
async function parallelWorkerMain(): Promise<void> {
  const data = workerData as ParallelWorkerData
  const barrier = new Int32Array(data.barrier)
  let create: () => { ok: true; purchase: { purchaseId: string } } | { ok: false; message: string }
  if (data.kind === 'coin') {
    const s = await createCoinPurchaseStore(data.dbPath)
    create = () => s.createPendingPurchase(data.profileId, data.packageId)
  } else if (data.kind === 'bundle') {
    const s = await createBundlePurchaseStore(data.dbPath)
    create = () => s.createPendingPurchase(data.profileId, data.packageId)
  } else {
    const s = await createVipPurchaseStore(data.dbPath)
    create = () => s.createPendingPurchase(data.profileId, 'vip_30', data.priceCents)
  }
  Atomics.add(barrier, 1, 1)
  Atomics.wait(barrier, 0, 0)
  try {
    const result = create()
    parentPort?.postMessage(result.ok ? { ok: true, purchaseId: result.purchase.purchaseId } : { ok: false, error: result.message })
  } catch (error) {
    parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

async function runParallel(data: Omit<ParallelWorkerData, 'barrier'>, workers: number): Promise<ParallelResult[]> {
  const barrier = new SharedArrayBuffer(8)
  const view = new Int32Array(barrier)
  const results = Array.from({ length: workers }, () => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { ...data, barrier } })
    return new Promise<ParallelResult>((resolveResult, reject) => {
      worker.once('message', (message: ParallelResult) => {
        resolveResult(message)
        void worker.terminate()
      })
      worker.once('error', reject)
    })
  })
  while (Atomics.load(view, 1) < workers) {
    await new Promise((r) => setTimeout(r, 10))
  }
  Atomics.store(view, 0, 1)
  Atomics.notify(view, 0)
  return Promise.all(results)
}

async function runParallelScenario(): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), 'belot-stale-pending-parallel-'))
  const dbPath = join(tempDir, 'parallel.sqlite')

  try {
    await applyMigrations(dbPath)
    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
    try {
      db.exec(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('par', 'par', 'par');
        INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
          VALUES ('pkg-par', 'pkg-par', 'Елит', 1500000, 1699, 'EUR', 'active');
        INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status)
          VALUES ('bundle-par', 'bundle-par', 'Комбо', 500000, 30, 999, 'EUR', 'active');
      `)
      // Стари pending редове по старите условия.
      const seedCoin = await createCoinPurchaseStore(dbPath)
      const seedBundle = await createBundlePurchaseStore(dbPath)
      const seedVip = await createVipPurchaseStore(dbPath)
      seedCoin.createPendingPurchase('par', 'pkg-par')
      seedBundle.createPendingPurchase('par', 'bundle-par')
      seedVip.createPendingPurchase('par', 'vip_30', 499)
      seedCoin.close()
      seedBundle.close()
      seedVip.close()
      db.exec(`
        UPDATE coin_packages SET yellow_coins_amount = 2250000 WHERE package_id = 'pkg-par';
        UPDATE shop_bundle_packages SET vip_days = 60 WHERE package_id = 'bundle-par';
      `)

      await check('[32] 4 паралелни „Купи“ (coins/bundle/VIP) след смяна на условията → един нов ред', async () => {
        const cases: Array<[ParallelWorkerData['kind'], string, string]> = [
          ['coin', 'pkg-par', 'coin_purchase_ledger'],
          ['bundle', 'bundle-par', 'bundle_purchase_ledger'],
          ['vip', 'vip_30', 'vip_purchase_ledger'],
        ]
        for (const [kind, packageId, table] of cases) {
          const results = await runParallel({ dbPath, kind, profileId: 'par', packageId, priceCents: 599 }, 4)
          assert(results.every((r) => r.ok), `${kind}: всички трябва да са ok: ${JSON.stringify(results)}`)
          const ids = new Set(results.map((r) => r.purchaseId))
          assert(ids.size === 1, `${kind}: очакван един purchaseId, получени ${JSON.stringify([...ids])}`)
          const counts = db.prepare(`
            SELECT SUM(CASE WHEN status = 'pending' AND hidden_at IS NULL THEN 1 ELSE 0 END) AS visible, COUNT(*) AS total
            FROM ${table} WHERE profile_id = 'par'
          `).get() as { visible: number; total: number }
          assert(counts.visible === 1 && counts.total === 2, `${kind}: видими=${counts.visible}, общо=${counts.total} (очаквани 1 и 2)`)
        }
      })
    } finally {
      db.close()
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function main(): Promise<void> {
  await runMainScenarios()
  await runClientScenarios()
  await runMigrationScenario()
  await runParallelScenario()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

if (isMainThread) {
  void main()
} else {
  void parallelWorkerMain()
}

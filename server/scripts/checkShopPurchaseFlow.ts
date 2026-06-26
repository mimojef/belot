/**
 * checkShopPurchaseFlow.ts — Focused checks за resume-checkout и hide логиката.
 *
 * Checks [0]-[15] извикват PRODUCTION модула resumeCoinPurchaseCheckout.
 * Няма дублирана бизнес логика в теста.
 *
 * [0]  pending + open session → reuse URL, без нова сесия
 * [1]  pending + expired session → точно 1 нова сесия
 * [2]  Stripe retrieve error → 503, без нова сесия, стар ID непроменен
 * [3]  две едновременни resume → еднакъв idempotency key, 1 логическа сесия
 * [4]  complete session → 409, без нова сесия
 * [5]  paid purchase → resume отказано
 * [6]  hidden purchase → resume отказано (404)
 * [7]  чужда покупка → resume отказано (404)
 * [8]  чужда покупка → hide отказано
 * [9]  pending покупка → soft-hidden
 * [10] paid покупка → soft-hidden
 * [11] скрит ред остава физически в DB (hidden_at != null)
 * [12] скрита покупка не е в listProfilePurchases
 * [13] webhook за скрита покупка кредитира точно веднъж (idempotent)
 * [14] resume не създава нов ledger ред
 * [15] Stripe create получава само server-side данни (purchaseId, profileId,
 *      packageId, packageKey, title/coins/price/currency от snapshot)
 * [16] popup flow: computeShopResumeConfirmOpen + computeShopPurchaseConfirmDispatch
 *      + renderShopPurchaseConfirmModal — без DOM, само pure helpers
 * [17] Stripe create → url: null → ok: false (не ok: true с празен string)
 * [18] Stripe create error → message не съдържа вътрешния error текст
 * [19] server build (tsc --noEmit)
 * [20] client build (tsc --noEmit)
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCoinPurchaseStore } from '../src/db/coinPurchaseStore.js'
import { resumeCoinPurchaseCheckout } from '../src/shop/resumeCoinPurchaseCheckout.js'
import {
  computeShopResumeConfirmOpen,
  computeShopPurchaseConfirmDispatch,
} from '../../src/app/lobby/shopResumeConfirmState.js'
import { renderShopPurchaseConfirmModal } from '../../src/app/lobby/renderLobbyScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const projectRoot = resolve(serverRoot, '..')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

// Отваря DB, изпълнява SQL и веднага затваря
function seedDb(dbPath: string, sql: string): void {
  const db = new DatabaseSync(dbPath, { open: true })
  try {
    db.exec(sql)
  } finally {
    db.close()
  }
}

// ── SQLite база с пълна schema ────────────────────────────────────────────────

function buildTestDb(dbPath: string): void {
  seedDb(dbPath, `
    PRAGMA foreign_keys = ON;

    CREATE TABLE accounts (
      account_id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL DEFAULT 'x', role TEXT NOT NULL DEFAULT 'player',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profiles (
      profile_id TEXT PRIMARY KEY, account_id TEXT, display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0 CHECK (yellow_coins_balance >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );
    CREATE TABLE coin_packages (
      package_id TEXT PRIMARY KEY, package_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
      sort_order INTEGER NOT NULL DEFAULT 0, show_in_lobby INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE coin_purchase_ledger (
      purchase_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL,
      package_id TEXT, package_key_snapshot TEXT NOT NULL,
      title_snapshot TEXT NOT NULL,
      yellow_coins_amount INTEGER NOT NULL CHECK (yellow_coins_amount > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      currency TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'stripe',
      provider_checkout_session_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','canceled','failed')),
      credited_at TEXT, hidden_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE,
      FOREIGN KEY (package_id) REFERENCES coin_packages(package_id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX idx_coin_purchase_ledger_pending_package
      ON coin_purchase_ledger(profile_id, package_id, status)
      WHERE status = 'pending' AND package_id IS NOT NULL;

    INSERT INTO accounts VALUES ('acc-1','u1@t.bg','x','player','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO accounts VALUES ('acc-2','u2@t.bg','x','player','active',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO profiles VALUES ('prof-1','acc-1','Тест 1',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO profiles VALUES ('prof-2','acc-2','Тест 2',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

    -- Отделни пакети за всеки тест → не удряме unique partial index
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-a','a','Пакет A',40000,199,'EUR','active',1);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-b','b','Пакет B',100000,499,'EUR','active',2);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-c','c','Пакет C',250000,999,'EUR','active',3);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-d','d','Пакет D',600000,1999,'EUR','active',4);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-e','e','Пакет E',10000,99,'EUR','active',5);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-f','f','Пакет F',20000,149,'EUR','active',6);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-g','g','Пакет G',30000,179,'EUR','active',7);
    INSERT INTO coin_packages (package_id,package_key,title,yellow_coins_amount,price_cents,currency,status,sort_order)
      VALUES ('pkg-h','h','Пакет H',50000,249,'EUR','active',8);
  `)
}

// ── Фейкнат Stripe client ─────────────────────────────────────────────────────

type FakeStripeSession = {
  id: string
  status: 'open' | 'expired' | 'complete'
  url: string | null
}

type FakeStripeCreateCall = {
  params: Record<string, unknown>
  options: Record<string, unknown>
}

type FakeStripeOpts = {
  retrieveResult: FakeStripeSession | 'throw'
  createResult: FakeStripeSession | 'throw'
  createCalls: FakeStripeCreateCall[]
}

function makeFakeStripe(opts: FakeStripeOpts) {
  return {
    checkout: {
      sessions: {
        retrieve: async (_id: string): Promise<FakeStripeSession> => {
          if (opts.retrieveResult === 'throw') throw new Error('Stripe network error')
          return opts.retrieveResult
        },
        create: async (params: unknown, options?: unknown): Promise<FakeStripeSession> => {
          opts.createCalls.push({
            params: params as Record<string, unknown>,
            options: (options ?? {}) as Record<string, unknown>,
          })
          if (opts.createResult === 'throw') throw new Error('Stripe create error')
          return opts.createResult
        },
      },
    },
  }
}

type FakeStripe = ReturnType<typeof makeFakeStripe>
type StoreType = Awaited<ReturnType<typeof createCoinPurchaseStore>>

const SUCCESS_URL = 'https://pika.bg/lobby?payment=success'
const CANCEL_URL  = 'https://pika.bg/lobby?payment=cancel'

async function callResume(store: StoreType, purchaseId: string, profileId: string, stripe: FakeStripe) {
  return resumeCoinPurchaseCheckout({
    store,
    stripe: stripe as unknown as import('stripe').default,
    purchaseId,
    profileId,
    successUrl: SUCCESS_URL,
    cancelUrl: CANCEL_URL,
  })
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedPending(dbPath: string, id: string, profile: string, pkg: string, pkgKey: string, title: string, coins: number, price: number, sessionId: string): void {
  seedDb(dbPath, `
    INSERT INTO coin_purchase_ledger
      (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,
       yellow_coins_amount,price_cents,currency,provider,provider_checkout_session_id,status)
    VALUES ('${id}','${profile}','${pkg}','${pkgKey}','${title}',${coins},${price},'EUR','stripe','${sessionId}','pending')
  `)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\ncheckShopPurchaseFlow.ts\n')

  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-shop-check-'))
  const dbPath = join(tmpDir, 'test.db')

  try {
    buildTestDb(dbPath)
    const store = await createCoinPurchaseStore(dbPath)

    // Seed: всяка покупка ползва отделен пакет → никой unique partial index не се удря
    // prof-1/pkg-a pending + open session
    seedPending(dbPath, 'p-open', 'prof-1', 'pkg-a', 'a', 'Пакет A', 40000, 199, 'cs_open')
    // prof-1/pkg-b pending + expired session
    seedPending(dbPath, 'p-expired', 'prof-1', 'pkg-b', 'b', 'Пакет B', 100000, 499, 'cs_expired')
    // prof-2/pkg-a pending + unreachable session
    seedPending(dbPath, 'p-retrieverr', 'prof-2', 'pkg-a', 'a', 'Пакет A', 40000, 199, 'cs_unreachable')
    // prof-2/pkg-b pending + expired session за concurrent test
    seedPending(dbPath, 'p-conc', 'prof-2', 'pkg-b', 'b', 'Пакет B', 100000, 499, 'cs_exp_conc')
    // prof-1/pkg-c pending + complete session
    seedPending(dbPath, 'p-complete', 'prof-1', 'pkg-c', 'c', 'Пакет C', 250000, 999, 'cs_complete')
    // prof-2/pkg-c paid
    seedDb(dbPath, `
      INSERT INTO coin_purchase_ledger
        (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,
         yellow_coins_amount,price_cents,currency,provider,status,credited_at)
      VALUES ('p-paid','prof-2','pkg-c','c','Пакет C',250000,999,'EUR','stripe','paid',CURRENT_TIMESTAMP)
    `)
    // prof-1/pkg-d pending + hidden
    seedDb(dbPath, `
      INSERT INTO coin_purchase_ledger
        (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,
         yellow_coins_amount,price_cents,currency,provider,provider_checkout_session_id,status,hidden_at)
      VALUES ('p-hidden-resume','prof-1','pkg-d','d','Пакет D',600000,1999,'EUR','stripe',
              'cs_hidden','pending',CURRENT_TIMESTAMP)
    `)

    // ── [0] ──────────────────────────────────────────────────────────────────
    await check('[0] pending + open session → reuse URL, без нова сесия', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_open', status: 'open', url: 'https://stripe.com/open' },
        createResult: { id: 'cs_never', status: 'open', url: 'https://stripe.com/never' },
        createCalls,
      })
      const result = await callResume(store, 'p-open', 'prof-1', stripe)
      assert(result.ok, `трябва ok: ${!result.ok ? result.message : ''}`)
      assert(result.ok && result.checkoutUrl === 'https://stripe.com/open', 'URL трябва да е старата')
      assert(createCalls.length === 0, 'Stripe create не трябва да е извикан')
    })

    // ── [1] ──────────────────────────────────────────────────────────────────
    await check('[1] pending + expired session → точно 1 нова сесия', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_expired', status: 'expired', url: null },
        createResult: { id: 'cs_new_b', status: 'open', url: 'https://stripe.com/new-b' },
        createCalls,
      })
      const result = await callResume(store, 'p-expired', 'prof-1', stripe)
      assert(result.ok, `трябва ok: ${!result.ok ? result.message : ''}`)
      assert(result.ok && result.checkoutUrl === 'https://stripe.com/new-b', 'URL трябва да е новата')
      assert(createCalls.length === 1, `точно 1 create, намерени: ${createCalls.length}`)
      const refreshed = store.getPurchaseWithOwnerCheck('p-expired', 'prof-1')
      assert(refreshed?.providerCheckoutSessionId === 'cs_new_b', 'новият session ID трябва да е в ledger-а')
    })

    // ── [2] ──────────────────────────────────────────────────────────────────
    await check('[2] Stripe retrieve error → 503, без нова сесия, стар ID непроменен', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: 'throw',
        createResult: { id: 'cs_bad', status: 'open', url: 'https://stripe.com/bad' },
        createCalls,
      })
      const result = await callResume(store, 'p-retrieverr', 'prof-2', stripe)
      assert(!result.ok, 'трябва грешка')
      assert(!result.ok && result.status === 503, `503 очакван, получен: ${!result.ok ? result.status : 'ok'}`)
      assert(createCalls.length === 0, 'Stripe create не трябва да е извикан')
      const unchanged = store.getPurchaseWithOwnerCheck('p-retrieverr', 'prof-2')
      assert(unchanged?.providerCheckoutSessionId === 'cs_unreachable', 'session ID трябва да е непроменен')
    })

    // ── [3] ──────────────────────────────────────────────────────────────────
    await check('[3] две едновременни resume → еднакъв idempotency key, 1 логическа сесия', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_exp_conc', status: 'expired', url: null },
        createResult: { id: 'cs_idem', status: 'open', url: 'https://stripe.com/idem' },
        createCalls,
      })

      const [res1, res2] = await Promise.all([
        callResume(store, 'p-conc', 'prof-2', stripe),
        callResume(store, 'p-conc', 'prof-2', stripe),
      ])

      assert(res1.ok || res2.ok, 'поне едната заявка трябва да успее')

      // Всяко create повикване трябва да носи ТОЧНО ЕДИН idempotency key: resume-{id}-{oldSessionId}
      const expectedKey = 'resume-p-conc-cs_exp_conc'
      for (const call of createCalls) {
        const key = (call.options as { idempotencyKey?: string }).idempotencyKey
        assert(key === expectedKey, `idempotency key трябва да е "${expectedKey}", получен: "${key}"`)
      }

      // Всички успешни резултати трябва да дадат идентичен URL (идемпотентна Stripe сесия)
      const successUrls = [res1, res2].filter((r) => r.ok).map((r) => r.ok && r.checkoutUrl)
      assert(
        new Set(successUrls).size === 1,
        `всички успешни resume трябва да дадат 1 уникален URL, намерени: ${JSON.stringify(successUrls)}`,
      )

      const final = store.getPurchaseWithOwnerCheck('p-conc', 'prof-2')
      assert(final?.providerCheckoutSessionId === 'cs_idem', `session ID трябва да е cs_idem, намерен: ${final?.providerCheckoutSessionId}`)
    })

    // ── [4] ──────────────────────────────────────────────────────────────────
    await check('[4] complete session → 409, без нова сесия', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_complete', status: 'complete', url: null },
        createResult: { id: 'cs_bad', status: 'open', url: 'https://stripe.com/bad' },
        createCalls,
      })
      const result = await callResume(store, 'p-complete', 'prof-1', stripe)
      assert(!result.ok, 'трябва грешка')
      assert(!result.ok && result.status === 409, `409 очакван, получен: ${!result.ok ? result.status : 'ok'}`)
      assert(createCalls.length === 0, 'Stripe create не трябва да е извикан')
    })

    // ── [5] ──────────────────────────────────────────────────────────────────
    await check('[5] paid purchase → resume отказано (409)', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: 'throw',
        createResult: { id: 'cs_x', status: 'open', url: 'https://stripe.com/x' },
        createCalls,
      })
      const result = await callResume(store, 'p-paid', 'prof-2', stripe)
      assert(!result.ok, 'трябва грешка')
      assert(!result.ok && result.status === 409, `409 очакван, получен: ${!result.ok ? result.status : 'ok'}`)
      assert(createCalls.length === 0, 'Stripe не трябва да е повикан')
    })

    // ── [6] ──────────────────────────────────────────────────────────────────
    await check('[6] hidden purchase → resume отказано (404)', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_hidden', status: 'open', url: 'https://stripe.com/hidden' },
        createResult: { id: 'cs_x', status: 'open', url: 'https://stripe.com/x' },
        createCalls,
      })
      const result = await callResume(store, 'p-hidden-resume', 'prof-1', stripe)
      assert(!result.ok, 'трябва грешка')
      assert(!result.ok && result.status === 404, `404 очакван, получен: ${!result.ok ? result.status : 'ok'}`)
      assert(createCalls.length === 0, 'Stripe не трябва да е повикан')
    })

    // ── [7] ──────────────────────────────────────────────────────────────────
    await check('[7] чужда покупка → resume отказано (404)', async () => {
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_open', status: 'open', url: 'https://stripe.com/open' },
        createResult: { id: 'cs_x', status: 'open', url: 'https://stripe.com/x' },
        createCalls,
      })
      // p-open е на prof-1, опитваме с prof-2
      const result = await callResume(store, 'p-open', 'prof-2', stripe)
      assert(!result.ok, 'трябва грешка')
      assert(!result.ok && result.status === 404, `404 очакван, получен: ${!result.ok ? result.status : 'ok'}`)
      assert(createCalls.length === 0, 'Stripe не трябва да е повикан')
    })

    // ── [8] ──────────────────────────────────────────────────────────────────
    await check('[8] чужда покупка → hide отказано', () => {
      const result = store.hidePurchaseForUser('p-open', 'prof-2')
      assert(!result.ok, 'трябва грешка')
    })

    // ── [9] ──────────────────────────────────────────────────────────────────
    await check('[9] pending покупка → soft-hidden', () => {
      seedPending(dbPath, 'p-hide-pend', 'prof-2', 'pkg-e', 'e', 'Пакет E', 10000, 99, 'cs_hide_e')
      const result = store.hidePurchaseForUser('p-hide-pend', 'prof-2')
      assert(result.ok, `трябваше да успее: ${!result.ok ? result.message : ''}`)
      assert(result.ok && result.purchase.hiddenAt !== null, 'hiddenAt трябва да е set')
    })

    // ── [10] ─────────────────────────────────────────────────────────────────
    await check('[10] paid покупка → soft-hidden', () => {
      seedDb(dbPath, `
        INSERT INTO coin_purchase_ledger
          (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,
           yellow_coins_amount,price_cents,currency,provider,status,credited_at)
        VALUES ('p-hide-paid','prof-1','pkg-e','e','Пакет E',10000,99,'EUR','stripe','paid',CURRENT_TIMESTAMP)
      `)
      const result = store.hidePurchaseForUser('p-hide-paid', 'prof-1')
      assert(result.ok, `трябваше да успее: ${!result.ok ? result.message : ''}`)
      assert(result.ok && result.purchase.hiddenAt !== null, 'hiddenAt трябва да е set')
    })

    // ── [11] ─────────────────────────────────────────────────────────────────
    await check('[11] скрит ред остава физически в DB (hidden_at != null)', () => {
      // getPurchaseWithOwnerCheck не филтрира по hidden_at — ако върне ред, той е в DB
      const row = store.getPurchaseWithOwnerCheck('p-hide-pend', 'prof-2')
      assert(row !== null, 'редът трябва да съществува в DB')
      assert(row !== null && row.hiddenAt !== null, 'hidden_at трябва да е записан')
    })

    // ── [12] ─────────────────────────────────────────────────────────────────
    await check('[12] скрита покупка не е в listProfilePurchases', () => {
      const purchases = store.listProfilePurchases('prof-2')
      assert(
        purchases.find((p) => p.purchaseId === 'p-hide-pend') === undefined,
        'скритата покупка не трябва да е в историята',
      )
    })

    // ── [13] ─────────────────────────────────────────────────────────────────
    await check('[13] webhook за скрита покупка кредитира точно веднъж (idempotent)', () => {
      seedPending(dbPath, 'p-wh', 'prof-1', 'pkg-f', 'f', 'Пакет F', 20000, 149, 'cs_wh')
      // Скриваме ли преди fulfill
      seedDb(dbPath, `UPDATE coin_purchase_ledger SET hidden_at=CURRENT_TIMESTAMP WHERE purchase_id='p-wh'`)

      const r1 = store.fulfillPaidPurchase({ checkoutSessionId: 'cs_wh', purchaseId: 'p-wh', amountPaidCents: 149, currency: 'EUR' })
      assert(r1.ok, `1-во fulfill трябва да успее: ${!r1.ok ? r1.message : ''}`)
      assert(r1.ok && !r1.alreadyCredited, 'трябва да е кредитирано за пръв път')

      const r2 = store.fulfillPaidPurchase({ checkoutSessionId: 'cs_wh', purchaseId: 'p-wh', amountPaidCents: 149, currency: 'EUR' })
      assert(r2.ok, '2-ро fulfill трябва да успее (idempotent)')
      assert(r2.ok && r2.alreadyCredited, 'трябва да е alreadyCredited при повторно викане')
    })

    // ── [14] ─────────────────────────────────────────────────────────────────
    await check('[14] resume не създава нов ledger ред', async () => {
      seedPending(dbPath, 'p-norow', 'prof-1', 'pkg-g', 'g', 'Пакет G', 30000, 179, 'cs_exp_g')
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_exp_g', status: 'expired', url: null },
        createResult: { id: 'cs_new_g', status: 'open', url: 'https://stripe.com/new-g' },
        createCalls,
      })
      const result = await callResume(store, 'p-norow', 'prof-1', stripe)
      assert(result.ok, `трябва ok: ${!result.ok ? result.message : ''}`)

      // Оригиналният ред трябва да съдържа новата сесия
      const row = store.getPurchaseWithOwnerCheck('p-norow', 'prof-1')
      assert(row !== null, 'p-norow трябва да съществува')
      assert(row?.providerCheckoutSessionId === 'cs_new_g', 'session ID трябва да е обновен в оригиналния ред')

      // Нов ред с purchase_id = session ID не трябва да съществува
      const wrongRow = store.getPurchaseWithOwnerCheck('cs_new_g', 'prof-1')
      assert(wrongRow === null, 'не трябва да съществува ред с purchase_id = session ID')
    })

    // ── [15] ─────────────────────────────────────────────────────────────────
    await check('[15] Stripe create получава само server-side данни', async () => {
      // pkg-h: coins=50000, price=249, currency=EUR
      seedPending(dbPath, 'p-data', 'prof-2', 'pkg-h', 'h', 'Пакет H', 50000, 249, 'cs_exp_h')
      const createCalls: FakeStripeCreateCall[] = []
      const stripe = makeFakeStripe({
        retrieveResult: { id: 'cs_exp_h', status: 'expired', url: null },
        createResult: { id: 'cs_cap_h', status: 'open', url: 'https://stripe.com/cap-h' },
        createCalls,
      })

      await callResume(store, 'p-data', 'prof-2', stripe)

      assert(createCalls.length === 1, `create трябва да е извикан точно веднъж, намерени: ${createCalls.length}`)

      type CreateParams = {
        line_items: Array<{ price_data: { unit_amount: number; currency: string }; quantity: number }>
        metadata: { purchaseId: string; profileId: string; packageId: string; packageKey: string; coins: string }
        success_url: string
        cancel_url: string
      }
      const p = createCalls[0].params as CreateParams

      // Цена и валута от server snapshot (pkg-h: 249 EUR)
      assert(p.line_items[0].price_data.unit_amount === 249, `цена 249 очаквана, получена: ${p.line_items[0].price_data.unit_amount}`)
      assert(p.line_items[0].price_data.currency === 'eur', `валута 'eur' очаквана`)

      // Metadata — всички полета от server snapshot
      assert(p.metadata.purchaseId === 'p-data', `purchaseId: ${p.metadata.purchaseId}`)
      assert(p.metadata.profileId === 'prof-2', `profileId: ${p.metadata.profileId}`)
      assert(p.metadata.packageId === 'pkg-h', `packageId: ${p.metadata.packageId}`)
      assert(p.metadata.packageKey === 'h', `packageKey: ${p.metadata.packageKey}`)
      assert(p.metadata.coins === '50000', `coins: ${p.metadata.coins}`)

      // URL-овете идват от server config, не от клиента
      assert(p.success_url === SUCCESS_URL, `success_url: ${p.success_url}`)
      assert(p.cancel_url === CANCEL_URL, `cancel_url: ${p.cancel_url}`)
    })

    // ── [16] ─────────────────────────────────────────────────────────────────
    // Pure helpers — без DOM, без browser globals mock
    await check('[16] popup flow: computeShopResumeConfirmOpen + dispatch + renderShopPurchaseConfirmModal', () => {
      const fakePkg = {
        packageId: 'pkg-a',
        packageKey: 'a',
        title: 'Пакет А',
        yellowCoinsAmount: 40000,
        priceCents: 199,
        currency: 'EUR',
        status: 'active' as const,
        sortOrder: 1,
        showInLobby: true,
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const fakePending = {
        purchaseId: 'p-ctrl',
        packageId: 'pkg-a',
        packageKey: 'a',
        title: 'Пакет А',
        yellowCoinsAmount: 40000,
        priceCents: 199,
        currency: 'EUR',
        provider: 'stripe',
        providerCheckoutSessionId: 'cs_ctrl',
        status: 'pending' as const,
        creditedAt: null,
        hiddenAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }
      const fakePaid = {
        ...fakePending,
        purchaseId: 'p-ctrl-paid',
        status: 'paid' as const,
        creditedAt: '2026-01-02T00:00:00.000Z',
      }
      const input = { purchases: [fakePending, fakePaid], shopPackages: [fakePkg], lobbyPackages: [] }

      // computeShopResumeConfirmOpen ─────────────────────────────────────────

      // pending → ok
      const r1 = computeShopResumeConfirmOpen('p-ctrl', input)
      assert(r1.ok === true, `pending → очакван ok:true, получен: ${JSON.stringify(r1)}`)
      if (r1.ok) {
        assert(r1.resumeId === 'p-ctrl', `resumeId: очакван 'p-ctrl', получен: ${r1.resumeId}`)
        assert(r1.packageId === 'pkg-a', `packageId: очакван 'pkg-a', получен: ${r1.packageId}`)
      }

      // paid → not-pending
      const r2 = computeShopResumeConfirmOpen('p-ctrl-paid', input)
      assert(!r2.ok && r2.reason === 'not-pending', `paid → очакван not-pending, получен: ${JSON.stringify(r2)}`)

      // не съществуваща покупка → not-found
      const r3 = computeShopResumeConfirmOpen('p-missing', input)
      assert(!r3.ok && r3.reason === 'not-found', `missing → очакван not-found, получен: ${JSON.stringify(r3)}`)

      // без package_id → no-package-id
      const noPkgPurchase = { ...fakePending, purchaseId: 'p-nopkg', packageId: null }
      const r4 = computeShopResumeConfirmOpen('p-nopkg', {
        ...input,
        purchases: [noPkgPurchase as typeof fakePending],
      })
      assert(!r4.ok && r4.reason === 'no-package-id', `no-package-id → получен: ${JSON.stringify(r4)}`)

      // пакетът не е наличен → package-unavailable
      const r5 = computeShopResumeConfirmOpen('p-ctrl', { ...input, shopPackages: [], lobbyPackages: [] })
      assert(!r5.ok && r5.reason === 'package-unavailable', `unavailable → получен: ${JSON.stringify(r5)}`)

      // computeShopPurchaseConfirmDispatch ──────────────────────────────────

      // resumeId зададен → resume action
      const d1 = computeShopPurchaseConfirmDispatch('p-ctrl', 'pkg-a')
      assert(d1.action === 'resume', `dispatch с resumeId → очакван 'resume', получен: ${d1.action}`)
      if (d1.action === 'resume') {
        assert(d1.purchaseId === 'p-ctrl', `purchaseId: очакван 'p-ctrl', получен: ${d1.purchaseId}`)
      }

      // resumeId null, packageId зададен → new-purchase
      const d2 = computeShopPurchaseConfirmDispatch(null, 'pkg-a')
      assert(d2.action === 'new-purchase', `dispatch без resumeId → очакван 'new-purchase', получен: ${d2.action}`)
      if (d2.action === 'new-purchase') {
        assert(d2.packageId === 'pkg-a', `packageId: очакван 'pkg-a', получен: ${d2.packageId}`)
      }

      // и двете null → noop
      const d3 = computeShopPurchaseConfirmDispatch(null, null)
      assert(d3.action === 'noop', `dispatch без нищо → очакван 'noop', получен: ${d3.action}`)

      // renderShopPurchaseConfirmModal ──────────────────────────────────────
      // Минимален LobbyScreenState с само задължителните полета за popup-а

      const minState = {
        shopPurchaseConfirmPackageId: 'pkg-a',
        shopPurchaseActionPackageId: null,
        shopPackages: [fakePkg],
        lobbyPackages: [],
      } as unknown as LobbyScreenState

      const html = renderShopPurchaseConfirmModal(minState)

      // Popup root присъства
      assert(html.includes('data-shop-purchase-confirm-root="1"'), 'popup root липсва')

      // Правилното заглавие
      assert(html.includes('Потвърждение на покупка'), 'заглавието липсва')

      // Правилното наименование на пакета
      assert(html.includes('Пакет А'), `името на пакета липсва в popup-а`)

      // Checkbox незабелязан (без checked атрибут)
      const checkboxRx = /data-shop-purchase-confirm-check="1"[^>]*/
      const checkboxMatch = html.match(checkboxRx)
      assert(checkboxMatch !== null, 'checkbox липсва')
      assert(!checkboxMatch![0].includes('checked'), 'checkbox трябва да е неизбран по подразбиране')

      // Submit бутон е disabled
      const submitRx = /data-shop-purchase-confirm-submit="1"[^>]*/
      const submitMatch = html.match(submitRx)
      assert(submitMatch !== null, 'submit бутон липсва')
      assert(submitMatch![0].includes('disabled'), 'submit бутон трябва да е disabled при незабелязан checkbox')

      // Линкове към Общи условия и Политика за поверителност
      assert(html.includes('data-shop-confirm-legal-link="terms"'), 'linк към Общи условия липсва')
      assert(html.includes('data-shop-confirm-legal-link="privacy"'), 'линк към Политика за поверителност липсва')

      // При shopPurchaseConfirmPackageId = null → празен string (popup затворен)
      const emptyState = { ...minState, shopPurchaseConfirmPackageId: null } as unknown as LobbyScreenState
      const emptyHtml = renderShopPurchaseConfirmModal(emptyState)
      assert(emptyHtml === '', 'popup трябва да е скрит когато shopPurchaseConfirmPackageId е null')
    })

    // ── [17] ─────────────────────────────────────────────────────────────────
    await check('[17] Stripe create → url:null → ok:false (не ok:true с празен string)', async () => {
      const db2Path = join(tmpDir, 'db17.sqlite')
      buildTestDb(db2Path)
      seedDb(db2Path, `
        INSERT INTO profiles VALUES ('prof-17','acc-1','Тест 17',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO profile_wallets VALUES ('prof-17',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO coin_packages VALUES ('pkg-17','key-17','Пакет 17','',50000,299,'EUR','active',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO coin_purchase_ledger
          (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,yellow_coins_amount,price_cents,currency,provider,provider_checkout_session_id,status,credited_at,hidden_at)
        VALUES ('p-17','prof-17','pkg-17','key-17','Пакет 17',50000,299,'EUR','stripe','cs_exp_17','pending',NULL,NULL);
      `)
      const store17 = await createCoinPurchaseStore(db2Path)
      try {
        // Stripe mock: retrieve → expired, create → { id: 'cs_new_17', url: null }
        const fakeStripe17 = {
          checkout: {
            sessions: {
              retrieve: async () => ({ status: 'expired', url: null }),
              create: async () => ({ id: 'cs_new_17', url: null }),
            },
          },
        } as unknown as import('stripe').default

        const result = await resumeCoinPurchaseCheckout({
          store: store17,
          stripe: fakeStripe17,
          purchaseId: 'p-17',
          profileId: 'prof-17',
          successUrl: 'https://pika.bg/success',
          cancelUrl: 'https://pika.bg/cancel',
        })

        assert(result.ok === false, `url:null → очакван ok:false, получен: ${JSON.stringify(result)}`)
        assert(
          result.ok === false && result.status === 500,
          `url:null → очакван status:500, получен: ${result.ok === false ? result.status : 'N/A'}`,
        )
        // Да не съдържа checkoutUrl с празен string
        assert(
          !('checkoutUrl' in result) || (result as { checkoutUrl?: string }).checkoutUrl !== '',
          'не трябва да се връща checkoutUrl:""',
        )
      } finally {
        store17.close()
      }
    })

    // ── [18] ─────────────────────────────────────────────────────────────────
    await check('[18] Stripe create error → тайният текст не попада нито в API отговора, нито в server log', async () => {
      const db3Path = join(tmpDir, 'db18.sqlite')
      buildTestDb(db3Path)
      seedDb(db3Path, `
        INSERT INTO profiles VALUES ('prof-18','acc-1','Тест 18',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO profile_wallets VALUES ('prof-18',0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO coin_packages VALUES ('pkg-18','key-18','Пакет 18','',50000,299,'EUR','active',1,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
        INSERT INTO coin_purchase_ledger
          (purchase_id,profile_id,package_id,package_key_snapshot,title_snapshot,yellow_coins_amount,price_cents,currency,provider,provider_checkout_session_id,status,credited_at,hidden_at)
        VALUES ('p-18','prof-18','pkg-18','key-18','Пакет 18',50000,299,'EUR','stripe','cs_exp_18','pending',NULL,NULL);
      `)
      const store18 = await createCoinPurchaseStore(db3Path)
      try {
        const internalStripeMessage = 'sk_live_secret_key_leaked_INTERNAL_DETAILS'

        // Прихващаме console.error за да проверим какво попада в server log
        const loggedArgs: unknown[][] = []
        const originalConsoleError = console.error
        console.error = (...args: unknown[]) => { loggedArgs.push(args) }

        let result: Awaited<ReturnType<typeof resumeCoinPurchaseCheckout>>
        try {
          const fakeStripe18 = {
            checkout: {
              sessions: {
                retrieve: async () => ({ status: 'expired', url: null }),
                create: async () => {
                  throw new Error(internalStripeMessage)
                },
              },
            },
          } as unknown as import('stripe').default

          result = await resumeCoinPurchaseCheckout({
            store: store18,
            stripe: fakeStripe18,
            purchaseId: 'p-18',
            profileId: 'prof-18',
            successUrl: 'https://pika.bg/success',
            cancelUrl: 'https://pika.bg/cancel',
          })
        } finally {
          console.error = originalConsoleError
        }

        // API отговорът не трябва да съдържа тайния текст
        assert(result.ok === false, `Stripe error → очакван ok:false, получен: ${JSON.stringify(result)}`)
        assert(
          result.ok === false && result.status === 500,
          `Stripe error → очакван status:500, получен: ${result.ok === false ? result.status : 'N/A'}`,
        )
        assert(
          result.ok === false && !result.message.includes(internalStripeMessage),
          `Тайният текст НЕ трябва да е в API response.message. Получено: ${result.ok === false ? result.message : ''}`,
        )

        // Server log аргументите не трябва да съдържат тайния текст
        const allLoggedText = loggedArgs.map((args) => args.map((a) => JSON.stringify(a)).join(' ')).join('\n')
        assert(
          !allLoggedText.includes(internalStripeMessage),
          `Тайният текст НЕ трябва да се логва в console.error. Логнато: ${allLoggedText}`,
        )

        // Трябва да е логнато поне нещо (безопасното съобщение)
        assert(loggedArgs.length > 0, 'console.error трябва да е извикан при Stripe грешка')

        // Логнатото трябва да съдържа purchaseId (безопасен идентификатор)
        assert(
          allLoggedText.includes('p-18'),
          `Логнатото трябва да съдържа purchaseId 'p-18'. Логнато: ${allLoggedText}`,
        )
      } finally {
        store18.close()
      }
    })

    store.close()

    // ── [19] ─────────────────────────────────────────────────────────────────
    await check('[19] server build (tsc --noEmit)', () => {
      execSync('npx tsc --noEmit --project tsconfig.json', { cwd: serverRoot, stdio: 'inherit' })
    })

    // ── [20] ─────────────────────────────────────────────────────────────────
    await check('[20] client build (tsc --noEmit)', () => {
      execSync('npx tsc --noEmit', { cwd: projectRoot, stdio: 'inherit' })
    })

  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }

  console.log(`\n${passed + failed} checks: ${passed} PASS, ${failed} FAIL\n`)

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Неочаквана грешка:', err)
  process.exit(1)
})

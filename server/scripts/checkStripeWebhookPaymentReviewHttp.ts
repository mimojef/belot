/**
 * checkStripeWebhookPaymentReviewHttp.ts
 *
 * HTTP ниво: реален сървър (изолиран temp root), реален POST
 * /api/stripe/webhook с ПОДПИСАНИ събития (stripe.webhooks.generateTestHeaderString
 * — локален HMAC, без мрежа). Покрива свързването в index.ts, което
 * store-level тестовете не виждат.
 *
 * [H1] coin, грешна сума → 200, payment_review_issues amount_mismatch, без кредит, редът pending
 * [H2] повторна доставка на [H1] → 200, occurrences=2, пак без кредит
 * [H3] coin, коректно плащане → кредит веднъж; повторна доставка → без втори кредит, без запис
 * [H4] coin, второ реално плащане (друга сесия) за вече платената поръчка → duplicate_payment, без кредит
 * [H5] VIP, осиротяла сесия → purchase_not_found с metadata purchaseId, без VIP grant
 * [H6] VIP, payment_status 'unpaid' → 200, без запис
 * [H7] bundle, грешна валута → currency_mismatch, без кредит
 * [H8] Meri86-подобен платен ред + ръчна компенсация: повторна доставка → без промяна, без запис
 * [H9] невалиден подпис → 400, без запис
 * [H10] заключена база (временна грешка) → 500; повторението кредитира веднъж, без активни проблеми
 * Adaptive Pricing (EUR цена, плащане в GBP; currency/amount_total в EUR, GBP в presentment_details):
 * [H11] coin → кредит веднъж; [H12] VIP → 1 grant; [H13] bundle → жълтици + VIP веднъж
 * [H14] GBP на top-level (несъответстващо) → без кредит, currency_mismatch
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, cp, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import Stripe from 'stripe'

const WEBHOOK_SECRET = 'whsec_test_payment_review_http_0123456789'
const SERVER_READY_TIMEOUT_MS = 90_000

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePromise(port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

const sourceRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function makeIsolated(root: string): Promise<{ serverDir: string; cleanup: () => Promise<void> }> {
  const serverSrc = existsSync(join(root, 'src', 'index.ts')) ? root : join(root, 'server')
  const tmp = await mkdtemp(join(tmpdir(), 'belot-webhook-review-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(serverSrc, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  if (existsSync(join(serverSrc, 'dist'))) {
    await cp(join(serverSrc, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  }
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverSrc, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverSrc, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverSrc, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(serverSrc, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return { serverDir, cleanup: () => retryRm(tmp) }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      // Фиктивен ключ: webhook-ът само проверява подписа локално; успешните
      // coin събития тук са без payment_intent, за да няма enrichment заявка.
      STRIPE_SECRET_KEY: 'sk_test_dummy_no_network',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PASSWORD_RESET_RATE_LIMIT_SECRET: 'x'.repeat(40),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

const stripeSigner = new Stripe('sk_test_dummy_no_network')

async function postEvent(port: number, session: Record<string, unknown>, opts: { badSignature?: boolean; eventId?: string } = {}): Promise<number> {
  const payload = JSON.stringify({
    id: opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { object: 'checkout.session', ...session } },
  })
  const header = stripeSigner.webhooks.generateTestHeaderString({
    payload,
    secret: opts.badSignature ? 'whsec_wrong_secret_value_000000000000' : WEBHOOK_SECRET,
  })
  const response = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  })
  await response.text()
  return response.status
}

async function main(): Promise<void> {
  const iso = await makeIsolated(sourceRoot)
  const port = await getFreePort()
  const srv = startSrv(iso.serverDir, port)

  try {
    const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
    let ready = false
    while (Date.now() < deadline && !ready) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`)
        const h = (await r.json()) as { ok?: boolean; gameWorkerLifecycle?: { state?: string } | null }
        ready = r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { /* not yet */ }
      if (!ready) await sleep(200)
    }
    if (!ready) throw new Error(`Сървърът не стана готов.\n${srv.output().slice(-3000)}`)

    const db = new DatabaseSync(join(iso.serverDir, 'database', 'data', 'belot-v2.sqlite'))
    db.exec('PRAGMA busy_timeout = 5000;')
    try {
      db.exec(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES
          ('h-coin', 'h-coin', 'h-coin'), ('h-vip', 'h-vip', 'h-vip'), ('h-bun', 'h-bun', 'h-bun'), ('h-meri', 'h-meri', 'h-meri');
        INSERT INTO coin_packages (package_id, package_key, title, yellow_coins_amount, price_cents, currency, status)
          VALUES ('h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'active');
        INSERT INTO shop_bundle_packages (package_id, package_key, title, yellow_coins_amount, vip_days, price_cents, currency, status)
          VALUES ('h-bun-pkg', 'h-bun-pkg', 'Комбо', 500000, 30, 999, 'EUR', 'active');
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status)
        VALUES ('h-coin-mismatch', 'h-coin', 'h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'cs_h_mismatch', 'pending');
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider_checkout_session_id, status)
          VALUES ('h-vip-p', 'h-vip', 'vip_30', 30, 499, 'EUR', 'cs_h_vip_current', 'pending');
        INSERT INTO bundle_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider_checkout_session_id, status)
        VALUES ('h-bun-p', 'h-bun', 'h-bun-pkg', 'h-bun-pkg', 'Комбо', 500000, 30, 999, 'EUR', 'cs_h_bun', 'pending');
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
        VALUES ('h-meri-paid', 'h-meri', 'h-pkg', 'h-pkg', 'Елит', 1500000, 1699, 'EUR', 'cs_h_meri', 'paid', CURRENT_TIMESTAMP);
        INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES ('h-meri', 2250000);
      `)

      const walletOf = (p: string): number =>
        ((db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(p) as { b: number } | undefined)?.b) ?? 0
      const issue = (sessionId: string) =>
        db.prepare('SELECT * FROM payment_review_issues WHERE checkout_session_id = ?').get(sessionId) as Record<string, unknown> | undefined
      const issueCount = () => (db.prepare('SELECT COUNT(*) AS c FROM payment_review_issues').get() as { c: number }).c
      const coinStatus = (id: string) => (db.prepare('SELECT status FROM coin_purchase_ledger WHERE purchase_id = ?').get(id) as { status: string }).status

      const coinSession = (id: string, purchaseId: string, amount: number, currency = 'eur') => ({
        id, payment_status: 'paid', amount_total: amount, currency, payment_intent: null,
        metadata: { purchaseId, profileId: 'h-coin' },
      })

      await check('[H1] coin грешна сума → 200, amount_mismatch, без кредит', async () => {
        const status = await postEvent(port, coinSession('cs_h_mismatch', 'h-coin-mismatch', 999), { eventId: 'evt_h1' })
        assert(status === 200, `status ${status}`)
        const row = issue('cs_h_mismatch')
        assert(row?.issue_kind === 'amount_mismatch' && row.expected_amount === 1699 && row.stripe_amount_total === 999, JSON.stringify(row))
        assert(row?.purchase_id === 'h-coin-mismatch' && row.stripe_event_id === 'evt_h1', JSON.stringify(row))
        assert(walletOf('h-coin') === 0 && coinStatus('h-coin-mismatch') === 'pending', 'без кредит, pending')
      })

      await check('[H2] повторна доставка → occurrences=2, без кредит', async () => {
        const status = await postEvent(port, coinSession('cs_h_mismatch', 'h-coin-mismatch', 999), { eventId: 'evt_h1' })
        assert(status === 200, `status ${status}`)
        assert(issue('cs_h_mismatch')?.occurrences === 2, JSON.stringify(issue('cs_h_mismatch')))
        assert(walletOf('h-coin') === 0, 'без кредит')
      })

      await check('[H3] coin коректно плащане → кредит веднъж; повторно → без втори кредит/запис', async () => {
        db.exec(`
          INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, hidden_at)
          VALUES ('h-coin-ok', 'h-coin', 'h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'cs_h_ok', 'pending', CURRENT_TIMESTAMP);
        `)
        const before = issueCount()
        assert(await postEvent(port, coinSession('cs_h_ok', 'h-coin-ok', 1699)) === 200, 'status 1')
        assert(await postEvent(port, coinSession('cs_h_ok', 'h-coin-ok', 1699)) === 200, 'status 2')
        assert(walletOf('h-coin') === 2250000, `wallet ${walletOf('h-coin')}`)
        assert(coinStatus('h-coin-ok') === 'paid' && issueCount() === before, 'paid, без запис')
      })

      await check('[H4] coin второ реално плащане за платена поръчка → duplicate_payment, без кредит', async () => {
        assert(await postEvent(port, coinSession('cs_h_second', 'h-coin-ok', 1699)) === 200, 'status')
        const row = issue('cs_h_second')
        assert(row?.issue_kind === 'duplicate_payment' && row.purchase_id === 'h-coin-ok', JSON.stringify(row))
        assert(walletOf('h-coin') === 2250000, `wallet ${walletOf('h-coin')}`)
      })

      await check('[H5] VIP осиротяла сесия → purchase_not_found, без VIP grant', async () => {
        const status = await postEvent(port, {
          id: 'cs_h_vip_orphan', payment_status: 'paid', amount_total: 499, currency: 'eur', payment_intent: 'pi_h_vip',
          metadata: { purchaseType: 'vip', purchaseId: 'h-vip-p', profileId: 'h-vip' },
        })
        assert(status === 200, `status ${status}`)
        const row = issue('cs_h_vip_orphan')
        assert(row?.issue_kind === 'purchase_not_found' && row.metadata_purchase_id === 'h-vip-p' && row.purchase_type === 'vip', JSON.stringify(row))
        assert(row?.stripe_payment_intent_id === 'pi_h_vip', 'payment intent')
        const grants = (db.prepare(`SELECT COUNT(*) AS c FROM vip_grants WHERE profile_id = 'h-vip'`).get() as { c: number }).c
        assert(grants === 0, 'без VIP grant')
      })

      await check('[H6] VIP unpaid → 200, без запис', async () => {
        const before = issueCount()
        const status = await postEvent(port, {
          id: 'cs_h_vip_current', payment_status: 'unpaid', amount_total: 499, currency: 'eur', payment_intent: null,
          metadata: { purchaseType: 'vip', purchaseId: 'h-vip-p', profileId: 'h-vip' },
        })
        assert(status === 200 && issueCount() === before, `status ${status}, записи ${issueCount()}`)
      })

      await check('[H7] bundle грешна валута → currency_mismatch, без кредит', async () => {
        const status = await postEvent(port, {
          id: 'cs_h_bun', payment_status: 'paid', amount_total: 999, currency: 'bgn', payment_intent: 'pi_h_bun',
          metadata: { purchaseType: 'bundle', purchaseId: 'h-bun-p', profileId: 'h-bun' },
        })
        assert(status === 200, `status ${status}`)
        assert(issue('cs_h_bun')?.issue_kind === 'currency_mismatch', JSON.stringify(issue('cs_h_bun')))
        assert(walletOf('h-bun') === 0, 'без кредит')
      })

      await check('[H8] Meri86-подобен платен ред: повторна доставка → без промяна, без запис', async () => {
        const rowBefore = JSON.stringify(db.prepare(`SELECT * FROM coin_purchase_ledger WHERE purchase_id = 'h-meri-paid'`).get())
        const before = issueCount()
        const status = await postEvent(port, {
          id: 'cs_h_meri', payment_status: 'paid', amount_total: 1699, currency: 'eur', payment_intent: null,
          metadata: { purchaseId: 'h-meri-paid', profileId: 'h-meri' },
        })
        assert(status === 200, `status ${status}`)
        assert(walletOf('h-meri') === 2250000 && issueCount() === before, 'wallet/записи непроменени')
        assert(JSON.stringify(db.prepare(`SELECT * FROM coin_purchase_ledger WHERE purchase_id = 'h-meri-paid'`).get()) === rowBefore, 'редът непроменен')
      })

      await check('[H10] заключена база (временна грешка) → 500; след освобождаване повторението кредитира веднъж, без активни проблеми', async () => {
        db.exec(`
          INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES ('h-lock', 'h-lock', 'h-lock');
          INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
            yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status)
          VALUES ('h-lock-p', 'h-lock', 'h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'cs_h_lock', 'pending');
        `)
        const session = { ...coinSession('cs_h_lock', 'h-lock-p', 1699), metadata: { purchaseId: 'h-lock-p', profileId: 'h-lock' } }
        // Write lock > busy_timeout (5 s) на сървъра → SQLITE_BUSY при кредитиране.
        db.exec('BEGIN IMMEDIATE;')
        let lockedStatus = 0
        try {
          lockedStatus = await postEvent(port, session, { eventId: 'evt_h10' })
        } finally {
          db.exec('ROLLBACK;')
        }
        assert(lockedStatus === 500, `при заключена база очакван 500, получен ${lockedStatus}`)
        assert(walletOf('h-lock') === 0 && coinStatus('h-lock-p') === 'pending', 'без кредит, pending')

        assert(await postEvent(port, session, { eventId: 'evt_h10' }) === 200, 'повторение → 200')
        assert(await postEvent(port, session, { eventId: 'evt_h10' }) === 200, 'второ повторение → 200')
        assert(walletOf('h-lock') === 2250000, `wallet ${walletOf('h-lock')}`)
        const open = db.prepare(`SELECT COUNT(*) AS c FROM payment_review_issues WHERE checkout_session_id = 'cs_h_lock' AND status = 'open'`).get() as { c: number }
        assert(open.c === 0, `активни проблеми: ${open.c}`)
      })

      // Adaptive Pricing (Stripe changelog 2025-03-31.basil / 2025-09-30.clover):
      // за сесии след 2025-03-30 currency/amount_total са във валутата на
      // интеграцията (EUR), а платеното в местна валута е в presentment_details.
      db.exec(`
        INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES
          ('h-gbp-coin', 'h-gbp-coin', 'h-gbp-coin'), ('h-gbp-vip', 'h-gbp-vip', 'h-gbp-vip'),
          ('h-gbp-bun', 'h-gbp-bun', 'h-gbp-bun'), ('h-gbp-legacy', 'h-gbp-legacy', 'h-gbp-legacy');
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status)
        VALUES ('h-gbp-coin-p', 'h-gbp-coin', 'h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'cs_h_gbp_coin', 'pending'),
               ('h-gbp-legacy-p', 'h-gbp-legacy', 'h-pkg', 'h-pkg', 'Елит', 2250000, 1699, 'EUR', 'cs_h_gbp_legacy', 'pending');
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider_checkout_session_id, status)
          VALUES ('h-gbp-vip-p', 'h-gbp-vip', 'vip_30', 30, 499, 'EUR', 'cs_h_gbp_vip', 'pending');
        INSERT INTO bundle_purchase_ledger (purchase_id, profile_id, package_id, package_key_snapshot, title_snapshot,
          yellow_coins_amount, vip_days_snapshot, price_cents, currency, provider_checkout_session_id, status)
        VALUES ('h-gbp-bun-p', 'h-gbp-bun', 'h-bun-pkg', 'h-bun-pkg', 'Комбо', 500000, 30, 999, 'EUR', 'cs_h_gbp_bun', 'pending');
      `)
      const gbpSession = (id: string, purchaseId: string, eurAmount: number, gbpAmount: number, extraMeta: Record<string, string> = {}) => ({
        id, payment_status: 'paid', amount_total: eurAmount, currency: 'eur', payment_intent: null,
        presentment_details: { presentment_amount: gbpAmount, presentment_currency: 'gbp' },
        metadata: { purchaseId, ...extraMeta },
      })
      const vipGrantsOf = (profileId: string) =>
        (db.prepare('SELECT COUNT(*) AS c FROM vip_grants WHERE profile_id = ?').get(profileId) as { c: number }).c

      await check('[H11] coin 16,99 EUR, платени в GBP (presentment_details) → кредит веднъж; повторно → без втори', async () => {
        const session = gbpSession('cs_h_gbp_coin', 'h-gbp-coin-p', 1699, 1450)
        assert(await postEvent(port, session) === 200, 'status 1')
        assert(await postEvent(port, session) === 200, 'status 2')
        assert(walletOf('h-gbp-coin') === 2250000 && coinStatus('h-gbp-coin-p') === 'paid', `wallet ${walletOf('h-gbp-coin')}`)
        assert(issue('cs_h_gbp_coin') === undefined, 'без запис за преглед')
      })

      await check('[H12] VIP в GBP → един VIP grant; повторно → без втори', async () => {
        const session = gbpSession('cs_h_gbp_vip', 'h-gbp-vip-p', 499, 430, { purchaseType: 'vip' })
        assert(await postEvent(port, session) === 200, 'status 1')
        assert(await postEvent(port, session) === 200, 'status 2')
        assert(vipGrantsOf('h-gbp-vip') === 1 && issue('cs_h_gbp_vip') === undefined, `grants ${vipGrantsOf('h-gbp-vip')}`)
      })

      await check('[H13] комбиниран пакет в GBP → жълтици + VIP веднъж; повторно → без втори', async () => {
        const session = gbpSession('cs_h_gbp_bun', 'h-gbp-bun-p', 999, 860, { purchaseType: 'bundle' })
        assert(await postEvent(port, session) === 200, 'status 1')
        assert(await postEvent(port, session) === 200, 'status 2')
        assert(walletOf('h-gbp-bun') === 500000 && vipGrantsOf('h-gbp-bun') === 1, `wallet ${walletOf('h-gbp-bun')} grants ${vipGrantsOf('h-gbp-bun')}`)
        assert(issue('cs_h_gbp_bun') === undefined, 'без запис за преглед')
      })

      await check('[H14] GBP сума/валута на top-level (не по документацията) → без кредит, currency_mismatch', async () => {
        const session = { id: 'cs_h_gbp_legacy', payment_status: 'paid', amount_total: 1450, currency: 'gbp', payment_intent: null, metadata: { purchaseId: 'h-gbp-legacy-p' } }
        assert(await postEvent(port, session) === 200, 'status')
        assert(walletOf('h-gbp-legacy') === 0 && coinStatus('h-gbp-legacy-p') === 'pending', 'без кредит')
        assert(issue('cs_h_gbp_legacy')?.issue_kind === 'currency_mismatch', JSON.stringify(issue('cs_h_gbp_legacy')))
      })

      await check('[H9] невалиден подпис → 400, без запис', async () => {
        const before = issueCount()
        const status = await postEvent(port, coinSession('cs_h_forged', 'h-coin-mismatch', 1), { badSignature: true })
        assert(status === 400 && issueCount() === before, `status ${status}`)
      })
    } finally {
      db.close()
    }
  } finally {
    await stopSrv(srv)
    await iso.cleanup()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

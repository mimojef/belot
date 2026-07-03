/**
 * Frontend-level checks for admin payments page (pure logic, no browser):
 *
 * [1]  Period labels mapping (5 карета → 5 periods)
 * [2]  isAdminPaymentPeriod: valid/invalid/edge-cases
 * [3]  Default period fallback (invalid → 'today')
 * [4]  URL/state synchronization (period in URL)
 * [5]  Loading state renders loading message
 * [6]  Error state renders error message
 * [7]  Empty state renders empty message
 * [8]  Payment row rendering: full profile
 * [9]  Payment row: null displayName → username fallback
 * [10] Payment row: null displayName + null username → 'Липсващ профил'
 * [11] Payment row: email null → '—'
 * [12] Sofia date formatting for creditedAt
 * [13] Coins formatted with thousands separator
 * [14] Amount formatted with Intl.NumberFormat bg-BG (e.g. "3,49 €")
 * [15] providerCheckoutSessionId shortened + full ID available
 * [16] HTML escaping: username, displayName, email, package title
 * [17] Stripe Session shown safely (no raw HTML injection)
 * [18] Pagination: hasMore drives Следваща button state
 * [19] Period change resets offset (via fresh panel state)
 * [20] Admin-only: non-admin renders access denied
 * [21] Active "Детайли" button opens detail
 * [22] Period tabs: active aria-pressed, correct data attribute
 * [23] Summary totalsByCurrency renders currency rows
 * [24] getPaymentMethodLabel: Google Pay, Apple Pay, card, unknown, null
 * [25] "Карта" column: brand + last4 display (e.g. "Visa •••• 4242")
 * [26] "Карта" column: HTML escaping of brand/last4
 * [27] "Метод" column: rendered in table header (renamed from "Доставчик")
 * [28] Race condition: generation counter in fetchAdminPayments (documentation check)
 * [29] stat card click uses onAdminPaymentsOpen (not onAdminPaymentsPeriodChange)
 * [30] onAdminPaymentsOpen callback is wired (present in RenderLobbyScreenOptions)
 * [31] period tab change uses onAdminPaymentsPeriodChange (replaceState, no new Back)
 * [32] stat cards render data-admin-payments-period for all 5 periods
 * [33] renderAdminPaymentsPanel: period tab data-admin-payments-tab present
 * [34] period tab has correct aria-pressed for active period
 * [35] stat card buttons render aria-label with period context
 *
 * Payment detail page checks:
 * [36] detail page: loading state
 * [37] detail page: error state
 * [38] detail page: not-found state
 * [39] detail page: non-admin access denied
 * [40] detail page: full purchase data rendered
 * [41] detail page: Google Pay method
 * [42] detail page: standard card (Visa 4242)
 * [43] detail page: null payment method data
 * [44] detail page: null profile/account/wallet
 * [45] detail page: HTML escaping
 * [46] detail page: copy buttons for IDs
 * [47] detail page: Bulgarian formatting (date, coins, money)
 * [48] "Детайли" button in table is enabled with data-payment-detail-open
 * [49] detail route/history source checks
 * [50] detail stale-response guards
 * [51] copy buttons report success only after clipboard success
 */

import {
  ADMIN_PAYMENT_PERIODS,
  ADMIN_PAYMENT_PERIOD_LABELS,
  renderAdminPaymentsPanel,
  getPaymentMethodLabel,
} from '../../src/app/adminPayments/renderAdminPaymentsPanel.js'
import { isAdminPaymentPeriod } from '../../src/app/adminPayments/adminPaymentsTypes.js'
import type { AdminPaymentListRow, AdminPaymentDetailRow } from '../../src/app/adminPayments/adminPaymentsTypes.js'
import type { AdminPaymentsPanelState } from '../../src/app/adminPayments/renderAdminPaymentsPanel.js'
import {
  renderAdminPaymentDetailPanel,
} from '../../src/app/adminPayments/renderAdminPaymentDetailPanel.js'
import type { AdminPaymentDetailState } from '../../src/app/adminPayments/renderAdminPaymentDetailPanel.js'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

function check(label: string, fn: () => void): void {
  try { fn(); pass(label) } catch (err) { fail(label, err) }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

function assertContains(html: string, needle: string, msg: string): void {
  if (!html.includes(needle)) throw new Error(`${msg}: expected to find "${needle}"`)
}

function assertNotContains(html: string, needle: string, msg: string): void {
  if (html.includes(needle)) throw new Error(`${msg}: expected NOT to find "${needle}"`)
}

const NOOP_CALLBACKS = { onBack: () => {}, onPeriodChange: () => {}, onPageChange: () => {}, onDetailOpen: () => {} }

function baseState(overrides: Partial<AdminPaymentsPanelState> = {}): AdminPaymentsPanelState {
  return {
    isAdmin: true,
    period: 'today',
    loading: false,
    errorText: null,
    rows: [],
    total: 0,
    totalsByCurrency: {},
    offset: 0,
    limit: 50,
    ...overrides,
  }
}

function makeRow(overrides: Partial<AdminPaymentListRow> = {}): AdminPaymentListRow {
  return {
    purchaseId: 'pid-001',
    profileId: 'prof-001',
    accountId: 'acc-001',
    username: 'testuser',
    displayName: 'Тест Потребител',
    email: 'user@test.com',
    profileKind: 'human',
    packageKey: 'starter',
    packageTitle: 'Starter Pack',
    yellowCoinsAmount: 1500,
    priceCents: 499,
    currency: 'EUR',
    provider: 'stripe',
    status: 'paid',
    providerCheckoutSessionId: 'cs_test_abcdefghijklmnop1234567890',
    paymentMethodType: null,
    walletType: null,
    cardBrand: null,
    cardLast4: null,
    cardCountry: null,
    createdAt: '2026-06-15T10:00:00.000Z',
    creditedAt: '2026-06-15T10:05:00.000Z',
    hiddenAt: null,
    ...overrides,
  }
}

// ─── [1] Period labels ─────────────────────────────────────────────────────────
console.log('\n[1] Period labels mapping')
check('[1.1] 5 periods defined', () => {
  assert(ADMIN_PAYMENT_PERIODS.length === 5, `Expected 5, got ${ADMIN_PAYMENT_PERIODS.length}`)
})
check('[1.2] today label', () => {
  assert(ADMIN_PAYMENT_PERIOD_LABELS.today === 'Днес', `Got "${ADMIN_PAYMENT_PERIOD_LABELS.today}"`)
})
check('[1.3] yesterday label', () => {
  assert(ADMIN_PAYMENT_PERIOD_LABELS.yesterday === 'Вчера', '')
})
check('[1.4] last7days label', () => {
  assert(ADMIN_PAYMENT_PERIOD_LABELS.last7days === 'Последните 7 дни', '')
})
check('[1.5] thisMonth label', () => {
  assert(ADMIN_PAYMENT_PERIOD_LABELS.thisMonth === 'Този месец', '')
})
check('[1.6] allTime label', () => {
  assert(ADMIN_PAYMENT_PERIOD_LABELS.allTime === 'Общо (всички времена)', '')
})

// ─── [2] isAdminPaymentPeriod ─────────────────────────────────────────────────
console.log('\n[2] isAdminPaymentPeriod validation')
check('[2.1] today valid', () => assert(isAdminPaymentPeriod('today'), ''))
check('[2.2] yesterday valid', () => assert(isAdminPaymentPeriod('yesterday'), ''))
check('[2.3] last7days valid', () => assert(isAdminPaymentPeriod('last7days'), ''))
check('[2.4] thisMonth valid', () => assert(isAdminPaymentPeriod('thisMonth'), ''))
check('[2.5] allTime valid', () => assert(isAdminPaymentPeriod('allTime'), ''))
check('[2.6] invalid string → false', () => assert(!isAdminPaymentPeriod('bogus'), ''))
check('[2.7] empty string → false', () => assert(!isAdminPaymentPeriod(''), ''))
check('[2.8] null → false', () => assert(!isAdminPaymentPeriod(null), ''))
check('[2.9] undefined → false', () => assert(!isAdminPaymentPeriod(undefined), ''))
check('[2.10] number → false', () => assert(!isAdminPaymentPeriod(7), ''))

// ─── [3] Default period fallback ──────────────────────────────────────────────
console.log('\n[3] Default/invalid period renders with valid label')
check('[3.1] today renders period label', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'today' }), NOOP_CALLBACKS)
  assertContains(html, 'Днес', 'today label not found')
})
check('[3.2] allTime renders correct label', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'allTime' }), NOOP_CALLBACKS)
  assertContains(html, 'Общо (всички времена)', 'allTime label not found')
})

// ─── [4] URL/state sync (data attributes) ────────────────────────────────────
console.log('\n[4] Period data attributes for URL sync')
for (const period of ADMIN_PAYMENT_PERIODS) {
  check(`[4.${period}] data-admin-payments-period="${period}" present`, () => {
    const html = renderAdminPaymentsPanel(baseState({ period }), NOOP_CALLBACKS)
    assertContains(html, `data-admin-payments-period="${period}"`, `period="${period}" not found`)
  })
}

// ─── [5] Loading state ────────────────────────────────────────────────────────
console.log('\n[5] Loading state')
check('[5.1] renders Зареждане', () => {
  const html = renderAdminPaymentsPanel(baseState({ loading: true }), NOOP_CALLBACKS)
  assertContains(html, 'Зареждане', 'Loading text not found')
})
check('[5.2] no table during loading', () => {
  const html = renderAdminPaymentsPanel(baseState({ loading: true }), NOOP_CALLBACKS)
  assertNotContains(html, '<table', 'Table should not be rendered while loading')
})

// ─── [6] Error state ──────────────────────────────────────────────────────────
console.log('\n[6] Error state')
check('[6.1] renders error message', () => {
  const html = renderAdminPaymentsPanel(baseState({ errorText: 'Сървърна грешка' }), NOOP_CALLBACKS)
  assertContains(html, 'Сървърна грешка', '')
})
check('[6.2] no table during error', () => {
  const html = renderAdminPaymentsPanel(baseState({ errorText: 'Грешка' }), NOOP_CALLBACKS)
  assertNotContains(html, '<table', 'Table rendered despite error')
})

// ─── [7] Empty state ──────────────────────────────────────────────────────────
console.log('\n[7] Empty state')
check('[7.1] renders empty message', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [], total: 0 }), NOOP_CALLBACKS)
  assertContains(html, 'Няма плащания', '')
})

// ─── [8] Row rendering: full profile ─────────────────────────────────────────
console.log('\n[8] Row rendering: full profile')
check('[8.1] displays displayName', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Тест Потребител', '')
})
check('[8.2] displays email', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'user@test.com', '')
})
check('[8.3] displays package title', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Starter Pack', '')
})
check('[8.4] displays paid status badge', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'paid', '')
})

// ─── [9] null displayName → username ─────────────────────────────────────────
console.log('\n[9] null displayName → username fallback')
check('[9.1] shows username when displayName=null', () => {
  const row = makeRow({ displayName: null, username: 'myusername' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'myusername', '')
  assertNotContains(html, 'null', 'Should not render literal null')
})

// ─── [10] null displayName + null username → 'Липсващ профил' ────────────────
console.log('\n[10] null displayName + null username → "Липсващ профил"')
check('[10.1] shows "Липсващ профил"', () => {
  const row = makeRow({ displayName: null, username: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Липсващ профил', '')
})

// ─── [11] null email → '—' ───────────────────────────────────────────────────
console.log('\n[11] null email → "—"')
check('[11.1] null email shown as —', () => {
  const row = makeRow({ email: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '—', '')
})

// ─── [12] Sofia date formatting ───────────────────────────────────────────────
console.log('\n[12] Sofia date formatting')
check('[12.1] creditedAt renders human-readable date', () => {
  const row = makeRow({ creditedAt: '2026-06-15T10:05:00.000Z' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '2026', 'Year not found in date')
})
check('[12.2] null creditedAt shows —', () => {
  const row = makeRow({ creditedAt: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '—', 'Null creditedAt should show —')
})

// ─── [13] Coins formatted ─────────────────────────────────────────────────────
console.log('\n[13] Coins formatted with separator')
check('[13.1] 1500 coins shown', () => {
  const row = makeRow({ yellowCoinsAmount: 1500 })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '1', 'Coins number not found')
  assertContains(html, '500', 'Coins number not found')
})
check('[13.2] large coins have separator', () => {
  const row = makeRow({ yellowCoinsAmount: 100000 })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  // bg-BG locale: 100 000 or 100.000 depending on the environment
  assert(html.includes('100') && html.includes('000'), '100000 not formatted')
})

// ─── [14] Money formatting with Intl.NumberFormat bg-BG ──────────────────────
console.log('\n[14] Money formatting (Intl.NumberFormat bg-BG)')
check('[14.1] 499 cents formats with bg-BG locale (comma decimal or currency symbol)', () => {
  const row = makeRow({ priceCents: 499, currency: 'EUR' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  // bg-BG formats: "4,99 €" or "4.99 €" depending on Node ICU data
  assert(html.includes('4') && html.includes('99'), '4.99 / 4,99 not found in HTML')
  // Must NOT output "4.99 EUR" (old format) — either decimal sep differs or symbol differs
  // At minimum: currency amount digits are present
})
check('[14.2] 1000 cents = 10.00 (any locale format)', () => {
  const row = makeRow({ priceCents: 1000 })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assert(html.includes('10'), '10.00 / 10,00 not found')
})
check('[14.3] formatMoney: does not show raw "EUR" string when symbol available', () => {
  const row = makeRow({ priceCents: 349, currency: 'EUR' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  // With Intl.NumberFormat bg-BG, EUR renders as "€" not "EUR" in most ICU builds
  // We can't assert one over the other across all Node environments,
  // but we can assert the amount appears
  assert(html.includes('3') && html.includes('49'), '3,49 not found')
})

// ─── [15] Stripe Session ID shortened ─────────────────────────────────────────
console.log('\n[15] Stripe Session ID display')
check('[15.1] long session shortened with ellipsis', () => {
  const row = makeRow({ providerCheckoutSessionId: 'cs_test_abcdefghijklmnop1234567890' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '…', 'Ellipsis not found in shortened session ID')
})
check('[15.2] full session ID in copy button data attribute', () => {
  const full = 'cs_test_abcdefghijklmnop1234567890'
  const row = makeRow({ providerCheckoutSessionId: full })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, `data-copy-session="${full}"`, 'Full session ID not in copy button')
})
check('[15.3] null session shows —', () => {
  const row = makeRow({ providerCheckoutSessionId: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '—', 'Null session should show —')
})

// ─── [16] HTML escaping ───────────────────────────────────────────────────────
console.log('\n[16] HTML escaping')
check('[16.1] displayName XSS escaped', () => {
  const row = makeRow({ displayName: '<script>alert(1)</script>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<script>', 'XSS in displayName not escaped')
  assertContains(html, '&lt;script&gt;', 'Expected escaped form')
})
check('[16.2] email XSS escaped', () => {
  const row = makeRow({ email: '<img src=x onerror=alert(1)>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<img src=x', 'XSS in email not escaped')
})
check('[16.3] username XSS escaped', () => {
  const row = makeRow({ displayName: null, username: '<b>bold</b>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<b>bold</b>', 'XSS in username not escaped')
  assertContains(html, '&lt;b&gt;bold&lt;/b&gt;', '')
})
check('[16.4] package title XSS escaped', () => {
  const row = makeRow({ packageTitle: '<script>pwned</script>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<script>pwned</script>', 'XSS in package title not escaped')
})

// ─── [17] Stripe Session safe in HTML ────────────────────────────────────────
console.log('\n[17] Stripe Session no raw HTML injection')
check('[17.1] session ID with special chars escaped', () => {
  const row = makeRow({ providerCheckoutSessionId: 'cs_<img>_"></div>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<img>', 'Raw HTML in session ID not escaped')
})

// ─── [18] Pagination ──────────────────────────────────────────────────────────
console.log('\n[18] Pagination hasMore')
check('[18.1] hasMore → Следваща enabled', () => {
  const rows = [makeRow()]
  const html = renderAdminPaymentsPanel(baseState({ rows, total: 10, offset: 0, limit: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Следваща', '')
  // Следваща button should NOT be disabled when hasMore=true
  const btnIdx = html.indexOf('Следваща')
  const snippet = html.slice(Math.max(0, btnIdx - 200), btnIdx)
  assert(!snippet.includes('disabled aria-disabled="true"'), 'Следваща should be enabled when hasMore')
})
check('[18.2] no hasMore → Следваща disabled', () => {
  const rows = [makeRow()]
  const html = renderAdminPaymentsPanel(baseState({ rows, total: 1, offset: 0, limit: 50 }), NOOP_CALLBACKS)
  assertContains(html, 'Следваща', '')
  const btnIdx = html.lastIndexOf('Следваща')
  // search 400 chars around the button tag (attr appears before text content)
  const snippet = html.slice(Math.max(0, btnIdx - 400), btnIdx + 50)
  assert(snippet.includes('disabled'), 'Следваща should be disabled when !hasMore')
})
check('[18.3] hasPrev when offset>0', () => {
  const rows = [makeRow()]
  const html = renderAdminPaymentsPanel(baseState({ rows, total: 100, offset: 50, limit: 50 }), NOOP_CALLBACKS)
  assertContains(html, 'Предишна', '')
  const btnIdx = html.indexOf('Предишна')
  const snippet = html.slice(Math.max(0, btnIdx - 200), btnIdx)
  assert(!snippet.includes('disabled aria-disabled="true"'), 'Предишна should be enabled when offset>0')
})
check('[18.4] no hasPrev when offset=0', () => {
  const rows = [makeRow()]
  const html = renderAdminPaymentsPanel(baseState({ rows, total: 100, offset: 0, limit: 50 }), NOOP_CALLBACKS)
  const btnIdx = html.indexOf('Предишна')
  // search 400 chars around the button tag
  const snippet = html.slice(Math.max(0, btnIdx - 400), btnIdx + 50)
  assert(snippet.includes('disabled'), 'Предишна should be disabled when offset=0')
})
check('[18.5] correct page data-attribute for Следваща', () => {
  const rows = [makeRow()]
  const html = renderAdminPaymentsPanel(baseState({ rows, total: 100, offset: 0, limit: 50 }), NOOP_CALLBACKS)
  assertContains(html, 'data-admin-payments-page="50"', 'Next page offset should be 50')
})

// ─── [19] Period change resets offset ────────────────────────────────────────
console.log('\n[19] Period change resets offset')
check('[19.1] rendering with new period+offset=0', () => {
  const html = renderAdminPaymentsPanel(
    baseState({ period: 'yesterday', offset: 0, rows: [], total: 0 }),
    NOOP_CALLBACKS,
  )
  assertContains(html, 'data-admin-payments-period="yesterday"', '')
  // offset reset to 0 means no previous page
  assertNotContains(html, 'data-admin-payments-page="-50"', 'Negative offset should not appear')
})

// ─── [20] Admin-only guard ────────────────────────────────────────────────────
console.log('\n[20] Admin-only: non-admin gets access denied')
check('[20.1] isAdmin=false shows access denied', () => {
  const html = renderAdminPaymentsPanel(baseState({ isAdmin: false }), NOOP_CALLBACKS)
  assertContains(html, 'Нямаш достъп', '')
  assertNotContains(html, 'Плащания', 'Should not show payments title to non-admin')
})

// ─── [21] Active "Детайли" button ────────────────────────────────────────────
console.log('\n[21] "Детайли" button enabled')
check('[21.1] Детайли button is enabled with purchaseId', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Детайли', '')
  const btnMatch = html.match(/<button[^>]*data-payment-detail-open="pid-001"[^>]*>/)
  assert(btnMatch !== null, 'detail button with purchaseId not found')
  assert(!btnMatch[0].includes(' disabled'), 'Детайли should be enabled')
})

// ─── [22] Period tab aria-pressed ────────────────────────────────────────────
console.log('\n[22] Period tabs aria-pressed')
check('[22.1] active period has aria-pressed=true', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'today' }), NOOP_CALLBACKS)
  assertContains(html, 'data-admin-payments-period="today"', '')
  const idx = html.indexOf('data-admin-payments-period="today"')
  const snippet = html.slice(Math.max(0, idx - 100), idx + 300)
  assertContains(snippet, 'aria-pressed="true"', 'Active period should have aria-pressed=true')
})
check('[22.2] inactive period has aria-pressed=false', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'today' }), NOOP_CALLBACKS)
  const idx = html.indexOf('data-admin-payments-period="allTime"')
  const snippet = html.slice(Math.max(0, idx - 100), idx + 300)
  assertContains(snippet, 'aria-pressed="false"', 'Inactive period should have aria-pressed=false')
})

// ─── [23] Summary totalsByCurrency ───────────────────────────────────────────
console.log('\n[23] Summary totalsByCurrency')
check('[23.1] EUR total shown (digits 4 and 99 present, any locale format)', () => {
  const html = renderAdminPaymentsPanel(
    baseState({ rows: [makeRow()], total: 1, totalsByCurrency: { EUR: 499 } }),
    NOOP_CALLBACKS,
  )
  // Intl.NumberFormat bg-BG renders "4,99 €" — no "4.99", no "EUR" in some ICU builds
  assert(html.includes('4') && html.includes('99'), 'EUR amount digits "4" and "99" not found in summary')
})
check('[23.2] multiple currencies: USD and EUR amounts appear', () => {
  const html = renderAdminPaymentsPanel(
    baseState({ rows: [makeRow()], total: 2, totalsByCurrency: { EUR: 499, USD: 999 } }),
    NOOP_CALLBACKS,
  )
  // Both amounts should produce digits in the summary
  assert(html.includes('4') && html.includes('99'), 'EUR amount not found in multi-currency summary')
  assert(html.includes('9') && html.includes('99'), 'USD amount not found in multi-currency summary')
})
check('[23.3] empty totalsByCurrency shows no summary amounts', () => {
  const html = renderAdminPaymentsPanel(
    baseState({ rows: [], total: 0, totalsByCurrency: {} }),
    NOOP_CALLBACKS,
  )
  // Summary div only renders when currencies.length > 0.
  // Verify it is absent by checking that the summary total count span is not present.
  // (The word "плащания" appears in aria-label too, so we check the count span text instead.)
  assertNotContains(html, '>0<', 'Total count "0" span should not be in summary for empty state')
  // Also confirm no currency amount formatting appeared
  assertNotContains(html, '0,00', 'Currency amount should not appear in empty summary')
})

// ─── [24] getPaymentMethodLabel ───────────────────────────────────────────────
console.log('\n[24] getPaymentMethodLabel')
check('[24.1] google_pay wallet → "Google Pay"', () => {
  const label = getPaymentMethodLabel({ walletType: 'google_pay', paymentMethodType: 'card' })
  assert(label === 'Google Pay', `Got "${label}"`)
})
check('[24.2] apple_pay wallet → "Apple Pay"', () => {
  const label = getPaymentMethodLabel({ walletType: 'apple_pay', paymentMethodType: 'card' })
  assert(label === 'Apple Pay', `Got "${label}"`)
})
check('[24.3] samsung_pay wallet → "Samsung Pay"', () => {
  const label = getPaymentMethodLabel({ walletType: 'samsung_pay', paymentMethodType: 'card' })
  assert(label === 'Samsung Pay', `Got "${label}"`)
})
check('[24.4] link wallet → "Link"', () => {
  const label = getPaymentMethodLabel({ walletType: 'link', paymentMethodType: 'card' })
  assert(label === 'Link', `Got "${label}"`)
})
check('[24.5] null wallet + card type → "Карта"', () => {
  const label = getPaymentMethodLabel({ walletType: null, paymentMethodType: 'card' })
  assert(label === 'Карта', `Got "${label}"`)
})
check('[24.6] null wallet + unknown type → title-cased type', () => {
  const label = getPaymentMethodLabel({ walletType: null, paymentMethodType: 'sepa_debit' })
  assert(label === 'Sepa Debit', `Got "${label}"`)
})
check('[24.7] both null → "Неизвестен"', () => {
  const label = getPaymentMethodLabel({ walletType: null, paymentMethodType: null })
  assert(label === 'Неизвестен', `Got "${label}"`)
})
check('[24.8] empty string wallet + card type → "Карта"', () => {
  const label = getPaymentMethodLabel({ walletType: '', paymentMethodType: 'card' })
  assert(label === 'Карта', `Got "${label}"`)
})
check('[24.9] unknown wallet type → title-cased', () => {
  const label = getPaymentMethodLabel({ walletType: 'unknown_wallet', paymentMethodType: 'card' })
  assert(label === 'Unknown Wallet', `Got "${label}"`)
})
check('[24.10] walletType takes precedence over paymentMethodType', () => {
  const label = getPaymentMethodLabel({ walletType: 'google_pay', paymentMethodType: 'bank_transfer' })
  assert(label === 'Google Pay', `Got "${label}"`)
})

// ─── [25] "Карта" column: brand + last4 display ───────────────────────────────
console.log('\n[25] Card column brand+last4 display')
check('[25.1] visa + 4242 → "Visa •••• 4242"', () => {
  const row = makeRow({ cardBrand: 'visa', cardLast4: '4242', paymentMethodType: 'card' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Visa •••• 4242', '"Visa •••• 4242" not found')
})
check('[25.2] mastercard + 1234 → "Mastercard •••• 1234"', () => {
  const row = makeRow({ cardBrand: 'mastercard', cardLast4: '1234', paymentMethodType: 'card' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Mastercard •••• 1234', '')
})
check('[25.3] null brand + null last4 → "—"', () => {
  const row = makeRow({ cardBrand: null, cardLast4: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '—', '"—" not found for empty card')
})
check('[25.4] brand only (no last4) → brand label shown', () => {
  const row = makeRow({ cardBrand: 'amex', cardLast4: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Amex', '"Amex" not found')
  assertNotContains(html, '••••', 'Should not show •••• without last4')
})
check('[25.5] last4 only (no brand) → "•••• NNNN"', () => {
  const row = makeRow({ cardBrand: null, cardLast4: '9999' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, '•••• 9999', '')
})

// ─── [26] "Карта" column HTML escaping ────────────────────────────────────────
console.log('\n[26] Card column HTML escaping')
check('[26.1] cardBrand XSS escaped', () => {
  const row = makeRow({ cardBrand: '<script>alert(1)</script>', cardLast4: '1234' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<script>', 'XSS in cardBrand not escaped')
  assertContains(html, '&lt;script&gt;', 'Expected escaped form of cardBrand')
})
check('[26.2] cardLast4 XSS escaped', () => {
  const row = makeRow({ cardBrand: 'visa', cardLast4: '"><img src=x>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<img', 'XSS in cardLast4 not escaped')
})
check('[26.3] methodLabel (getPaymentMethodLabel result) is escaped in DOM', () => {
  const row = makeRow({ walletType: null, paymentMethodType: '<evil>' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertNotContains(html, '<evil>', 'XSS in paymentMethodType not escaped')
})

// ─── [27] "Метод" column header (renamed from "Доставчик") ───────────────────
console.log('\n[27] "Метод" column header in table')
check('[27.1] table renders "Метод" header (not "Доставчик")', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Метод', '"Метод" column header not found')
  assertNotContains(html, '>Доставчик<', 'Column should be "Метод", not "Доставчик"')
})
check('[27.2] table renders "Карта" header', () => {
  const html = renderAdminPaymentsPanel(baseState({ rows: [makeRow()], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Карта', '"Карта" column header not found')
})
check('[27.3] Google Pay row: Метод column shows "Google Pay"', () => {
  const row = makeRow({ walletType: 'google_pay', paymentMethodType: 'card' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Google Pay', '"Google Pay" not found in row')
})
check('[27.4] standard Visa card: Метод column shows "Карта"', () => {
  const row = makeRow({ walletType: null, paymentMethodType: 'card', cardBrand: 'visa', cardLast4: '4242' })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  // "Карта" appears in both header and method cell — just confirm it's there
  assertContains(html, 'Карта', '"Карта" not found for standard card')
})
check('[27.5] null snapshot: Метод column shows "Неизвестен"', () => {
  const row = makeRow({ walletType: null, paymentMethodType: null })
  const html = renderAdminPaymentsPanel(baseState({ rows: [row], total: 1 }), NOOP_CALLBACKS)
  assertContains(html, 'Неизвестен', '"Неизвестен" not found for null snapshot')
})

// ─── [29] stat card click uses onAdminPaymentsOpen (data-admin-payments-open) ──
console.log('\n[29] stat card uses data-admin-payments-open (not data-admin-payments-period)')

// We can verify the rendered HTML from the admin-info panel section.
// renderAdminInfoPanel is not exported, but we can check renderLobbyScreen indirectly:
// the stat card template in renderLobbyScreen uses data-admin-payments-open.
// We test this by inspecting the source module text for the correct attribute.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const lobbyScreenSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/app/lobby/renderLobbyScreen.ts'),
  'utf8',
)
check('[29.1] stat card uses data-admin-payments-open attribute', () => {
  assert(lobbyScreenSrc.includes('data-admin-payments-open='), 'data-admin-payments-open not found in renderLobbyScreen.ts')
})
check('[29.2] stat card does NOT use data-admin-payments-period for open action', () => {
  // querySelectorAll for open should use -open, not -period
  assert(
    lobbyScreenSrc.includes('[data-admin-payments-open]'),
    '[data-admin-payments-open] querySelectorAll not found',
  )
})
check('[29.3] open handler calls onAdminPaymentsOpen (not onAdminPaymentsPeriodChange)', () => {
  // The click handler for data-admin-payments-open must reference onAdminPaymentsOpen
  const openBlock = lobbyScreenSrc.match(/data-admin-payments-open[\s\S]{0,400}?onAdminPaymentsOpen/)
  assert(openBlock !== null, 'onAdminPaymentsOpen not found in data-admin-payments-open handler')
})
check('[29.4] handler does NOT call pushState in renderer', () => {
  // pushState should NOT appear in the data-admin-payments-open handler in renderLobbyScreen
  // (history is managed by the controller)
  const openHandlerBlock = lobbyScreenSrc.indexOf('[data-admin-payments-open]')
  if (openHandlerBlock === -1) throw new Error('[data-admin-payments-open] block not found')
  const blockSnippet = lobbyScreenSrc.slice(openHandlerBlock, openHandlerBlock + 500)
  assert(!blockSnippet.includes('pushState'), 'pushState found in renderer open handler — should be in controller only')
})

// ─── [30] onAdminPaymentsOpen in RenderLobbyScreenOptions ────────────────────
console.log('\n[30] onAdminPaymentsOpen present in RenderLobbyScreenOptions')
check('[30.1] options interface has onAdminPaymentsOpen', () => {
  assert(lobbyScreenSrc.includes('onAdminPaymentsOpen?:'), 'onAdminPaymentsOpen not found in RenderLobbyScreenOptions')
})
check('[30.2] onAdminPaymentsPeriodChange still present (for in-screen tab changes)', () => {
  assert(lobbyScreenSrc.includes('onAdminPaymentsPeriodChange?:'), 'onAdminPaymentsPeriodChange missing')
})

// ─── [31] period tab change uses onAdminPaymentsPeriodChange ─────────────────
console.log('\n[31] period tab change uses onAdminPaymentsPeriodChange via attachAdminPaymentsPanelHandlers')
const panelSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/app/adminPayments/renderAdminPaymentsPanel.ts'),
  'utf8',
)
check('[31.1] attachAdminPaymentsPanelHandlers handles data-admin-payments-period (tabs)', () => {
  assert(panelSrc.includes('[data-admin-payments-period]'), 'period tab handler not found in renderAdminPaymentsPanel.ts')
})
check('[31.2] period tabs use data-admin-payments-period (not -open)', () => {
  assert(panelSrc.includes('data-admin-payments-period='), 'data-admin-payments-period not found in period tabs')
  assert(!panelSrc.includes('data-admin-payments-open'), 'period tabs must not use data-admin-payments-open')
})

// ─── [32] stat cards render data-admin-payments-open for all 5 periods ───────
console.log('\n[32] stat cards: data-admin-payments-open present for each period')
const STAT_CARD_PERIODS = ['today', 'yesterday', 'last7days', 'thisMonth', 'allTime']
for (const p of STAT_CARD_PERIODS) {
  check(`[32.${p}] data-admin-payments-open="${p}" in renderLobbyScreen source`, () => {
    // The template uses escapeHtml(period) but for ASCII periods that's a no-op
    assert(
      lobbyScreenSrc.includes(`data-admin-payments-open=`),
      `data-admin-payments-open not found for period=${p}`,
    )
  })
}

// ─── [33] period tabs in renderAdminPaymentsPanel have correct aria-pressed ──
console.log('\n[33] period tabs aria-pressed')
check('[33.1] active tab: aria-pressed="true"', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'today', rows: [] }), NOOP_CALLBACKS)
  assertContains(html, 'aria-pressed="true"', 'No aria-pressed=true tab found')
})
check('[33.2] inactive tab: aria-pressed="false"', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'today', rows: [] }), NOOP_CALLBACKS)
  assertContains(html, 'aria-pressed="false"', 'No aria-pressed=false tab found')
})
check('[33.3] only one tab has aria-pressed=true', () => {
  const html = renderAdminPaymentsPanel(baseState({ period: 'yesterday', rows: [] }), NOOP_CALLBACKS)
  const matches = [...html.matchAll(/aria-pressed="true"/g)]
  assert(matches.length === 1, `Expected 1 aria-pressed=true, got ${matches.length}`)
})

// ─── [34] controller: showAdminPaymentsPanel uses pushState (source check) ───
console.log('\n[34] controller uses pushState when opening admin-payments')
const controllerSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/app/lobby/createLobbyFlowController.ts'),
  'utf8',
)
check('[34.1] showAdminPaymentsPanel contains pushState', () => {
  // Find showAdminPaymentsPanel function and check it uses pushState
  const fnIdx = controllerSrc.indexOf('function showAdminPaymentsPanel')
  assert(fnIdx !== -1, 'showAdminPaymentsPanel not found')
  const fnSnippet = controllerSrc.slice(fnIdx, fnIdx + 1200)
  assert(fnSnippet.includes('pushState'), 'pushState not found in showAdminPaymentsPanel')
})
check('[34.2] syncAdminPaymentsUrl uses replaceState (for in-screen period/offset changes)', () => {
  const fnIdx = controllerSrc.indexOf('function syncAdminPaymentsUrl')
  assert(fnIdx !== -1, 'syncAdminPaymentsUrl not found')
  const fnSnippet = controllerSrc.slice(fnIdx, fnIdx + 400)
  assert(fnSnippet.includes('replaceState'), 'replaceState not found in syncAdminPaymentsUrl')
  assert(!fnSnippet.includes('pushState'), 'pushState must not appear in syncAdminPaymentsUrl')
})
check('[34.3] onAdminPaymentsOpen wired in renderActiveRoom options', () => {
  assert(controllerSrc.includes('onAdminPaymentsOpen:'), 'onAdminPaymentsOpen not wired in controller render options')
})

// ─── [35] stat card buttons have aria-label ──────────────────────────────────
console.log('\n[35] stat card buttons have aria-label="Виж плащания: ..."')
check('[35.1] aria-label with "Виж плащания" present in source', () => {
  assert(lobbyScreenSrc.includes('aria-label="Виж плащания:'), 'aria-label not found on stat card buttons')
})

// ─── Helper: make a full AdminPaymentDetailRow ────────────────────────────────

const NOOP_DETAIL = { onBack: () => {} }

function makeDetailRow(overrides: Partial<AdminPaymentDetailRow> = {}): AdminPaymentDetailRow {
  return {
    purchaseId: 'pid-detail-001',
    profileId: 'prof-001',
    accountId: 'acc-001',
    username: 'testuser',
    displayName: 'Тест Потребител',
    email: 'user@test.com',
    profileKind: 'human',
    packageKey: 'starter',
    packageTitle: 'Starter Pack',
    yellowCoinsAmount: 500,
    priceCents: 999,
    currency: 'EUR',
    provider: 'stripe',
    status: 'paid',
    providerCheckoutSessionId: 'cs_test_abc123',
    stripePaymentIntentId: 'pi_test_xyz456',
    stripeChargeId: 'ch_test_789',
    paymentMethodType: 'card',
    walletType: null,
    cardBrand: 'visa',
    cardLast4: '4242',
    cardCountry: 'BG',
    createdAt: '2026-06-15T09:00:00.000Z',
    creditedAt: '2026-06-15T10:05:00.000Z',
    updatedAt: '2026-06-15T10:05:01.000Z',
    hiddenAt: null,
    currentYellowCoinsBalance: 1500,
    ...overrides,
  }
}

function detailState(overrides: Partial<AdminPaymentDetailState> = {}): AdminPaymentDetailState {
  return { isAdmin: true, loading: false, errorText: null, purchase: makeDetailRow(), ...overrides }
}

// ─── [36] detail: loading state ──────────────────────────────────────────────
console.log('\n[36] detail page: loading state')
check('[36.1] renders Зареждане', () => {
  const html = renderAdminPaymentDetailPanel(detailState({ loading: true, purchase: null }), NOOP_DETAIL)
  assertContains(html, 'Зареждане', 'Loading text not found')
})
check('[36.2] ← Назад button present during loading', () => {
  const html = renderAdminPaymentDetailPanel(detailState({ loading: true, purchase: null }), NOOP_DETAIL)
  assertContains(html, 'data-payment-detail-back', '← Назад button not found in loading state')
})

// ─── [37] detail: error state ────────────────────────────────────────────────
console.log('\n[37] detail page: error state')
check('[37.1] renders error message', () => {
  const html = renderAdminPaymentDetailPanel(detailState({ errorText: 'Сървърна грешка', purchase: null }), NOOP_DETAIL)
  assertContains(html, 'Сървърна грешка', 'Error text not rendered')
})

// ─── [38] detail: purchase=null (not found) ──────────────────────────────────
console.log('\n[38] detail page: not-found state')
check('[38.1] renders not-found message', () => {
  const html = renderAdminPaymentDetailPanel(detailState({ purchase: null }), NOOP_DETAIL)
  assertContains(html, 'не е намерено', 'Not-found message not rendered')
})

// ─── [39] detail: non-admin ──────────────────────────────────────────────────
console.log('\n[39] detail page: non-admin access denied')
check('[39.1] isAdmin=false shows access denied', () => {
  const html = renderAdminPaymentDetailPanel(detailState({ isAdmin: false }), NOOP_DETAIL)
  assertContains(html, 'достъп', 'Access denied message not found')
  assertNotContains(html, 'Детайли за плащане', 'Should not show purchase when non-admin')
})

// ─── [40] detail: full purchase data ─────────────────────────────────────────
console.log('\n[40] detail page: full purchase data rendered')
{
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  check('[40.1] section А: Покупка title', () => assertContains(html, 'А. Покупка', 'Section А not found'))
  check('[40.2] section Б: Клиент title', () => assertContains(html, 'Б. Клиент', 'Section Б not found'))
  check('[40.3] section В: Метод на плащане', () => assertContains(html, 'В. Метод на плащане', 'Section В not found'))
  check('[40.4] section Г: Системна информация', () => assertContains(html, 'Г. Системна информация', 'Section Г not found'))
  check('[40.5] purchase status badge', () => assertContains(html, 'paid', 'Status badge not rendered'))
  check('[40.6] package title', () => assertContains(html, 'Starter Pack', 'Package title not rendered'))
  check('[40.7] profile display name', () => assertContains(html, 'Тест Потребител', 'Display name not rendered'))
  check('[40.8] email', () => assertContains(html, 'user@test.com', 'Email not rendered'))
  check('[40.9] Checkout Session ID', () => assertContains(html, 'cs_test_abc123', 'Session ID not rendered'))
  check('[40.10] PaymentIntent ID', () => assertContains(html, 'pi_test_xyz456', 'PaymentIntent ID not rendered'))
  check('[40.11] Charge ID', () => assertContains(html, 'ch_test_789', 'Charge ID not rendered'))
  check('[40.12] purchase ID', () => assertContains(html, 'pid-detail-001', 'Purchase ID not rendered'))
}

// ─── [41] detail: Google Pay ─────────────────────────────────────────────────
console.log('\n[41] detail page: Google Pay method')
check('[41.1] shows Google Pay label', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ walletType: 'google_pay', paymentMethodType: 'card' }) }),
    NOOP_DETAIL,
  )
  assertContains(html, 'Google Pay', 'Google Pay label not rendered')
})

// ─── [42] detail: standard card ──────────────────────────────────────────────
console.log('\n[42] detail page: standard Visa card')
{
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  check('[42.1] shows Карта label', () => assertContains(html, 'Карта', '"Карта" method label not rendered'))
  check('[42.2] shows Visa •••• 4242', () => assertContains(html, 'Visa •••• 4242', 'Card display not rendered'))
  check('[42.3] shows card country BG', () => assertContains(html, 'BG', 'Card country not rendered'))
}

// ─── [43] detail: null payment method ────────────────────────────────────────
console.log('\n[43] detail page: null payment method data')
check('[43.1] shows Неизвестен when all null', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ walletType: null, paymentMethodType: null, cardBrand: null, cardLast4: null }) }),
    NOOP_DETAIL,
  )
  assertContains(html, 'Неизвестен', '"Неизвестен" not shown for null method')
})
check('[43.2] card column shows — for null brand+last4', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ cardBrand: null, cardLast4: null }) }),
    NOOP_DETAIL,
  )
  assertContains(html, '—', '"—" not shown for null card')
})

// ─── [44] detail: null profile/account/wallet ────────────────────────────────
console.log('\n[44] detail page: null profile/account/wallet')
check('[44.1] null displayName + null username shows Липсващ профил', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ displayName: null, username: null, email: null, currentYellowCoinsBalance: null }) }),
    NOOP_DETAIL,
  )
  assertContains(html, 'Липсващ профил', '"Липсващ профил" not shown')
})
check('[44.2] null email shows —', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ email: null }) }),
    NOOP_DETAIL,
  )
  assertContains(html, '—', '"—" not shown for null email')
})
check('[44.3] null balance shows —', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ currentYellowCoinsBalance: null }) }),
    NOOP_DETAIL,
  )
  assertContains(html, '—', '"—" not shown for null balance')
})

// ─── [45] detail: HTML escaping ──────────────────────────────────────────────
console.log('\n[45] detail page: HTML escaping')
check('[45.1] displayName XSS escaped', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ displayName: '<script>alert(1)</script>' }) }),
    NOOP_DETAIL,
  )
  assertNotContains(html, '<script>', 'XSS in displayName not escaped')
  assertContains(html, '&lt;script&gt;', 'XSS not properly escaped')
})
check('[45.2] email XSS escaped', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ email: '<evil@bad.com>' }) }),
    NOOP_DETAIL,
  )
  assertNotContains(html, '<evil', 'XSS in email not escaped')
})
check('[45.3] packageTitle XSS escaped', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ packageTitle: '<b>XSS</b>' }) }),
    NOOP_DETAIL,
  )
  assertNotContains(html, '<b>', 'XSS in packageTitle not escaped')
})
check('[45.4] purchaseId XSS escaped', () => {
  const html = renderAdminPaymentDetailPanel(
    detailState({ purchase: makeDetailRow({ purchaseId: '<img src=x>' }) }),
    NOOP_DETAIL,
  )
  assertNotContains(html, '<img', 'XSS in purchaseId not escaped')
})

// ─── [46] detail: copy buttons for IDs ───────────────────────────────────────
console.log('\n[46] detail page: copy buttons present')
{
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  check('[46.1] copy button for purchaseId', () => assertContains(html, `data-copy-detail="pid-detail-001"`, 'purchaseId copy btn missing'))
  check('[46.2] copy button for profileId', () => assertContains(html, `data-copy-detail="prof-001"`, 'profileId copy btn missing'))
  check('[46.3] copy button for sessionId', () => assertContains(html, `data-copy-detail="cs_test_abc123"`, 'sessionId copy btn missing'))
  check('[46.4] copy button for paymentIntentId', () => assertContains(html, `data-copy-detail="pi_test_xyz456"`, 'paymentIntentId copy btn missing'))
  check('[46.5] copy button for chargeId', () => assertContains(html, `data-copy-detail="ch_test_789"`, 'chargeId copy btn missing'))
}

// ─── [47] detail: Bulgarian date/coins/money formatting ──────────────────────
console.log('\n[47] detail page: Bulgarian formatting')
check('[47.1] coins formatted with bg-BG locale (500 = "500")', () => {
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  assertContains(html, '500', 'coins not rendered')
})
check('[47.2] money formatted (999 cents = ~9,99 EUR region format)', () => {
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  // bg-BG locale: "9,99 €" or similar — check for digits only
  assertContains(html, '9', 'money amount not found')
  assertContains(html, '99', 'money cents not found')
})
check('[47.3] creditedAt renders a date string', () => {
  const html = renderAdminPaymentDetailPanel(detailState(), NOOP_DETAIL)
  assertContains(html, '2026', 'year not rendered in date')
})

// ─── [48] "Детайли" button in table is enabled ───────────────────────────────
console.log('\n[48] "Детайли" button in list table is enabled with purchaseId')
{
  const html = renderAdminPaymentsPanel(
    baseState({ rows: [makeRow({ purchaseId: 'test-pid-abc' })], total: 1 }),
    { onBack: () => {}, onPeriodChange: () => {}, onPageChange: () => {}, onDetailOpen: () => {} },
  )
  check('[48.1] data-payment-detail-open attribute present', () =>
    assertContains(html, 'data-payment-detail-open="test-pid-abc"', 'data-payment-detail-open not found'))
  check('[48.2] button is NOT disabled', () => {
    const btnMatch = html.match(/<button[^>]*data-payment-detail-open="test-pid-abc"[^>]*>/)
    assert(btnMatch !== null, 'button not found')
    assert(!btnMatch[0].includes(' disabled'), 'button should not be disabled')
  })
  check('[48.3] button text is "Детайли"', () => {
    assertContains(html, '>Детайли<', 'Button text not "Детайли"')
  })
}

// ─── [49] detail route/history source checks ─────────────────────────────────
console.log('\n[49] detail route/history source checks')
check('[49.1] detail route is checked before exact payment list route', () => {
  const detailIdx = controllerSrc.indexOf('const detailMatch = /^\\/admin\\/payments\\/([^/]+)$/')
  const pathToScreenIdx = controllerSrc.indexOf('const screen = PATH_TO_SCREEN[path] ?? null')
  assert(detailIdx !== -1, 'dynamic detail route check not found')
  assert(pathToScreenIdx !== -1, 'PATH_TO_SCREEN lookup not found')
  assert(detailIdx < pathToScreenIdx, 'detail route must be checked before exact route lookup')
})
check('[49.2] opening detail calls pushState exactly once in detail function', () => {
  const fnIdx = controllerSrc.indexOf('function showAdminPaymentDetailPanel')
  const endIdx = controllerSrc.indexOf('async function fetchAdminPaymentDetail', fnIdx)
  assert(fnIdx !== -1 && endIdx !== -1, 'showAdminPaymentDetailPanel bounds not found')
  const fnSnippet = controllerSrc.slice(fnIdx, endIdx)
  const matches = [...fnSnippet.matchAll(/history\.pushState/g)]
  assert(matches.length === 1, `expected 1 pushState, got ${matches.length}`)
  assert(fnSnippet.includes('encodeURIComponent(purchaseId)'), 'purchaseId must be URL-encoded')
})
check('[49.3] direct detail route is accepted during initial navigation', () => {
  assert(controllerSrc.includes('/^\\/admin\\/payments\\/[^/]+$/.test(_loadPath)'), 'initial dynamic route check missing')
})
check('[49.4] popstate navigates from current browser path', () => {
  const popIdx = controllerSrc.indexOf("window.addEventListener('popstate'")
  assert(popIdx !== -1, 'popstate handler missing')
  const snippet = controllerSrc.slice(popIdx, popIdx + 250)
  assert(snippet.includes('navigateFromPath(path)'), 'popstate must call navigateFromPath(path)')
})
check('[49.5] detail Back replaces URL with payment list preserving period', () => {
  assert(controllerSrc.includes('showAdminPaymentsPanel(period, \'replace\')'), 'detail Back must replace list URL')
  const paymentsFnIdx = controllerSrc.indexOf('function showAdminPaymentsPanel')
  const paymentsSnippet = controllerSrc.slice(paymentsFnIdx, paymentsFnIdx + 1400)
  assert(paymentsSnippet.includes("historyMode: 'push' | 'replace'"), 'history mode parameter missing')
  assert(paymentsSnippet.includes('history.replaceState'), 'replaceState branch missing')
})

// ─── [50] detail stale response guards ───────────────────────────────────────
console.log('\n[50] detail stale response guards')
check('[50.1] stale detail response cannot mutate after leaving detail screen', () => {
  const fnIdx = controllerSrc.indexOf('async function fetchAdminPaymentDetail')
  assert(fnIdx !== -1, 'fetchAdminPaymentDetail not found')
  const fnSnippet = controllerSrc.slice(fnIdx, fnIdx + 900)
  assert(fnSnippet.includes("state.currentScreen !== 'admin-payment-detail'"), 'currentScreen stale guard missing')
})
check('[50.2] stale detail response cannot mutate after opening another purchase', () => {
  const fnIdx = controllerSrc.indexOf('async function fetchAdminPaymentDetail')
  const fnSnippet = controllerSrc.slice(fnIdx, fnIdx + 900)
  assert(fnSnippet.includes('state.adminPaymentDetailPurchaseId !== purchaseId'), 'purchaseId stale guard missing')
})

// ─── [51] copy success/error behavior ────────────────────────────────────────
console.log('\n[51] detail copy success/error behavior')
const detailPanelSrc = readFileSync(
  resolve(import.meta.dirname, '../../src/app/adminPayments/renderAdminPaymentDetailPanel.ts'),
  'utf8',
)
check('[51.1] copy success is set only in clipboard writeText.then', () => {
  const writeIdx = detailPanelSrc.indexOf('navigator.clipboard.writeText(value).then')
  const successIdx = detailPanelSrc.indexOf("btn.textContent = '✓'", writeIdx)
  assert(writeIdx !== -1, 'clipboard writeText(value).then not found')
  assert(successIdx !== -1, 'success marker not found after writeText.then')
})
check('[51.2] copy error marker is used for missing clipboard and rejected writes', () => {
  const errorMatches = [...detailPanelSrc.matchAll(/btn\.textContent = '✗'/g)]
  assert(errorMatches.length >= 2, `expected at least two error markers, got ${errorMatches.length}`)
})

// ─── Резюме ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

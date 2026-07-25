/**
 * checkConsentAnalytics.ts
 *
 * Проверки за GDPR consent механизма (banner + настройки modal, 3 категории:
 * necessary/analytics/marketing), Google AdSense + Meta Pixel gating
 * ИЗКЛЮЧИТЕЛНО от marketing consent (PageView + CompleteRegistration).
 *
 *  A) РЕАЛНИ поведенчески тестове върху src/app/consent/consentState.ts,
 *     src/app/analytics/loadAdSense.ts, src/app/analytics/metaPixel.ts и
 *     src/app/analytics/initializeAnalytics.ts — mock-нат localStorage/
 *     document/window (без jsdom зависимост), реални import-нати модули, не
 *     regex. Тества consent validation (липсващ/невалиден/стар/валиден),
 *     v1→v2 миграция (re-prompt, не auto-accept), независимост на
 *     analytics/marketing запис+възстановяване, idempotency guard-ове
 *     (script/init/PageView/CompleteRegistration) и marketing-only gating
 *     (analytics:true сам по себе си НЕ зарежда AdSense/Pixel).
 *
 *  B) Source-text проверки за wiring-а, който изисква пълен app контекст
 *     (main.ts register-only CompleteRegistration извикване, липса на
 *     статичен AdSense/Meta script в index.html, липса на директни fbq
 *     извиквания извън wrapper-а, footer връзка, privacy policy съдържание
 *     за трите отделни категории).
 *
 *  C) Реален браузър (Playwright) срещу build-нат dist, статично сервиран
 *     (без backend — main.ts вече обработва липсващ /api/* чрез try/catch).
 *     Доказва действителното UI поведение: banner copy, забранени думи,
 *     мрежови заявки към AdSense/Meta преди/след consent, analytics-only vs
 *     marketing gating в реален браузър, Escape/X focus restore, reopen на
 *     постоянната връзка, устойчивост след reload/revoke.
 *
 * Изпълнява се в Node.js чрез tsx (Part A/B) + Playwright chromium (Part C).
 */

import { readFile, stat } from 'node:fs/promises'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:http'
import { chromium, type Browser } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

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

// ═══════════════════════════════════════════════════════════════════════
// Part A — real module behavior, mocked browser globals (no jsdom needed)
// ═══════════════════════════════════════════════════════════════════════

class FakeStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

class FakeElement {
  tagName: string
  async = false
  src = ''
  crossOrigin = ''
  onerror: (() => void) | null = null
  private attrs = new Map<string, string>()
  constructor(tag: string) {
    this.tagName = tag.toUpperCase()
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  matchesAttr(name: string, value: string): boolean {
    return this.attrs.get(name) === value
  }
}

class FakeDocument {
  headAppended: FakeElement[] = []
  head = { appendChild: (el: FakeElement) => { this.headAppended.push(el) } }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag)
  }
  querySelector(selector: string): FakeElement | null {
    const match = selector.match(/^(\w+)\[([\w-]+)="([^"]*)"\]$/)
    if (!match) return null
    const [, tag, attrName, attrValue] = match
    return (
      this.headAppended.find(
        (el) => el.tagName === tag.toUpperCase() && el.matchesAttr(attrName, attrValue),
      ) ?? null
    )
  }
  reset(): void {
    this.headAppended = []
  }
}

const fakeStorage = new FakeStorage()
const fakeDocument = new FakeDocument()
;(globalThis as unknown as { localStorage: FakeStorage }).localStorage = fakeStorage
;(globalThis as unknown as { document: FakeDocument }).document = fakeDocument
;(globalThis as unknown as { window: typeof globalThis }).window = globalThis

function clearFbq(): void {
  delete (globalThis as Record<string, unknown>).fbq
  delete (globalThis as Record<string, unknown>)._fbq
}
function getFbqQueue(): unknown[][] {
  const fbq = (globalThis as Record<string, unknown>).fbq as { queue?: unknown[][] } | undefined
  return fbq?.queue ?? []
}

console.log('\n=== Part A: consent (3 categories) + analytics module behavior ===\n')

const consentState = await import('../src/app/consent/consentState.ts')
const {
  getConsent,
  hasAnalyticsConsent,
  hasMarketingConsent,
  hasRecordedChoice,
  acceptAllConsent,
  saveConsentChoice,
  subscribeToConsentChanges,
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  __resetConsentStateForTests,
} = consentState

const { enableAdSenseIfConsented, __resetAdSenseLoaderForTests } =
  await import('../src/app/analytics/loadAdSense.ts')
const {
  initMetaPixelIfConsented,
  trackCompleteRegistration,
  __resetMetaPixelForTests,
  __setMetaPixelIdOverrideForTests,
} = await import('../src/app/analytics/metaPixel.ts')
const { initializeAnalytics } = await import('../src/app/analytics/initializeAnalytics.ts')

function fullReset(): void {
  fakeStorage.clear()
  __resetConsentStateForTests()
  __resetAdSenseLoaderForTests()
  __resetMetaPixelForTests()
  clearFbq()
  fakeDocument.reset()
}

// ─── consent state validation ───────────────────────────────────────────

await check('[A1] storage key/version are v2 (three-category model)', () => {
  assert(CONSENT_STORAGE_KEY === 'pika-consent-v2', `expected pika-consent-v2, got ${CONSENT_STORAGE_KEY}`)
  assert(CONSENT_VERSION === 2, `expected version 2, got ${CONSENT_VERSION}`)
})

await check('[A2] missing consent → not recorded, neither analytics nor marketing allowed', () => {
  fullReset()
  assert(getConsent() === null, 'expected null consent')
  assert(!hasRecordedChoice(), 'expected no recorded choice')
  assert(!hasAnalyticsConsent(), 'expected analytics consent false')
  assert(!hasMarketingConsent(), 'expected marketing consent false')
})

await check('[A3] corrupted JSON in storage → treated as no consent', () => {
  fullReset()
  fakeStorage.setItem(CONSENT_STORAGE_KEY, '{not valid json')
  __resetConsentStateForTests()
  assert(getConsent() === null, 'corrupted JSON must be rejected')
})

await check('[A4] valid JSON but old (v1, two-field) structure → treated as no consent', () => {
  fullReset()
  // Old v1 shape: no "marketing" field at all.
  fakeStorage.setItem(
    CONSENT_STORAGE_KEY,
    JSON.stringify({ version: 2, necessary: true, analytics: true, updatedAt: new Date().toISOString() }),
  )
  __resetConsentStateForTests()
  assert(getConsent() === null, 'missing marketing field must be rejected')
})

await check('[A5] old consent version number → treated as invalid, must re-prompt', () => {
  fullReset()
  fakeStorage.setItem(
    CONSENT_STORAGE_KEY,
    JSON.stringify({ version: 1, necessary: true, analytics: true, marketing: true, updatedAt: new Date().toISOString() }),
  )
  __resetConsentStateForTests()
  assert(getConsent() === null, 'old version must be rejected')
})

await check('[A6] migration from pika-consent-v1: old key data is never read under the new v2 key, banner re-prompts', () => {
  fullReset()
  // Simulates a real returning user who previously accepted under the OLD
  // key/shape. The old analytics:true must NOT be auto-applied to the new
  // analytics AND marketing categories — the app must ask again.
  fakeStorage.setItem(
    'pika-consent-v1',
    JSON.stringify({ version: 1, necessary: true, analytics: true, updatedAt: new Date().toISOString() }),
  )
  __resetConsentStateForTests()
  assert(getConsent() === null, 'old v1 key must not be picked up under the v2 key')
  assert(!hasRecordedChoice(), 'a stale v1 entry must not count as a recorded v2 choice')
  assert(!hasMarketingConsent(), 'old analytics:true must never be auto-applied as marketing consent')
})

await check('[A7] "Приеми всички" records necessary:true + analytics:true + marketing:true and persists', () => {
  fullReset()
  acceptAllConsent()
  const consent = getConsent()
  assert(consent !== null, 'consent must be recorded')
  assert(consent!.necessary === true, 'necessary must always be true')
  assert(consent!.analytics === true, 'accept-all must set analytics true')
  assert(consent!.marketing === true, 'accept-all must set marketing true')
  const persisted = JSON.parse(fakeStorage.getItem(CONSENT_STORAGE_KEY)!)
  assert(persisted.analytics === true && persisted.marketing === true, 'persisted value must match')
})

await check('[A8] analytics and marketing are recorded and restored independently (true/false)', () => {
  fullReset()
  saveConsentChoice(true, false)
  assert(getConsent()!.analytics === true && getConsent()!.marketing === false, 'analytics:true, marketing:false must persist independently')
  assert(hasAnalyticsConsent() && !hasMarketingConsent(), 'guards must reflect the independent state')

  saveConsentChoice(false, true)
  assert(getConsent()!.analytics === false && getConsent()!.marketing === true, 'analytics:false, marketing:true must persist independently')
  assert(!hasAnalyticsConsent() && hasMarketingConsent(), 'guards must flip independently')
})

await check('[A9] reopening (simulated reload) reflects the real recorded choice for both categories', () => {
  fullReset()
  saveConsentChoice(true, false)
  __resetConsentStateForTests()
  assert(getConsent()!.analytics === true && getConsent()!.marketing === false, 'reload must reflect the last saved combination')

  saveConsentChoice(false, false)
  __resetConsentStateForTests()
  assert(getConsent()!.analytics === false && getConsent()!.marketing === false, 'reload must reflect the updated combination')
})

await check('[A10] subscribers are notified on every consent change, not after unsubscribe', () => {
  fullReset()
  let calls = 0
  const unsubscribe = subscribeToConsentChanges(() => { calls++ })
  acceptAllConsent()
  assert(calls === 1, `expected 1 notification, got ${calls}`)
  saveConsentChoice(false, false)
  assert(calls === 2, `expected 2 notifications, got ${calls}`)
  unsubscribe()
  acceptAllConsent()
  assert(calls === 2, 'unsubscribed listener must not be notified')
})

// ─── AdSense loader — gated ONLY by marketing ───────────────────────────

await check('[A11] no consent → AdSense script is not injected', () => {
  fullReset()
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 0, 'no script should be injected without consent')
})

await check('[A12] analytics:true + marketing:false → AdSense script is NOT injected', () => {
  fullReset()
  saveConsentChoice(true, false)
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 0, 'analytics-only consent must not load AdSense')
})

await check('[A13] marketing:true → AdSense script injected exactly once, correct publisher ID', () => {
  fullReset()
  saveConsentChoice(false, true)
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 1, 'expected exactly one injected script')
  assert(fakeDocument.headAppended[0].src.includes('ca-pub-4005564019331779'), 'publisher ID must be preserved')
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 1, 'repeated call must not duplicate the script')
})

await check('[A14] simulated reload after revoking marketing → AdSense never loads again', () => {
  fullReset()
  acceptAllConsent()
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 1, 'precondition: script loaded once')
  saveConsentChoice(true, false) // keep analytics, revoke marketing only
  __resetAdSenseLoaderForTests()
  fakeDocument.reset()
  enableAdSenseIfConsented()
  assert(fakeDocument.headAppended.length === 0, 'revoked marketing + reloaded state must not load AdSense')
})

// ─── Meta Pixel wrapper — gated ONLY by marketing ────────────────────────

await check('[A15] no consent, no pixel ID → nothing happens, no fbq created', () => {
  fullReset()
  initMetaPixelIfConsented()
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'fbq must not be created')
  assert(fakeDocument.headAppended.length === 0, 'no script should be injected')
})

await check('[A16] marketing:true but VITE_META_PIXEL_ID missing → no crash, no script, no init', () => {
  fullReset()
  saveConsentChoice(false, true)
  __setMetaPixelIdOverrideForTests(null)
  initMetaPixelIfConsented()
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'fbq must not be created without a pixel ID')
  assert(fakeDocument.headAppended.length === 0, 'no script should be injected without a pixel ID')
})

await check('[A17] analytics:true + marketing:false + valid pixel ID → Meta Pixel does NOT load', () => {
  fullReset()
  saveConsentChoice(true, false)
  __setMetaPixelIdOverrideForTests('123456789012345')
  initMetaPixelIfConsented()
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'analytics-only consent must not init the pixel')
  assert(fakeDocument.headAppended.length === 0, 'analytics-only consent must not inject fbevents.js')
})

await check('[A18] marketing:true + valid pixel ID → script injected once, init once, PageView once', () => {
  fullReset()
  saveConsentChoice(false, true)
  __setMetaPixelIdOverrideForTests('123456789012345')
  initMetaPixelIfConsented()
  assert(
    fakeDocument.headAppended.some((el) => el.src.includes('connect.facebook.net/en_US/fbevents.js')),
    'fbevents.js must be injected',
  )
  const queue = getFbqQueue()
  assert(queue.some((call) => call[0] === 'init' && call[1] === '123456789012345'), 'fbq init must be queued')
  assert(queue.filter((call) => call[0] === 'track' && call[1] === 'PageView').length === 1, 'exactly one PageView')

  // repeated call → no duplication
  initMetaPixelIfConsented()
  const fbEventsScripts = fakeDocument.headAppended.filter((el) => el.src.includes('fbevents.js'))
  assert(fbEventsScripts.length === 1, 'repeated init must not duplicate the script')
  assert(getFbqQueue().length === queue.length, 'repeated init must not duplicate init/PageView calls')
})

await check('[A19] decline marketing first, then accept later in the same load → pixel loads and sends PageView once', () => {
  fullReset()
  __setMetaPixelIdOverrideForTests('999999999999999')
  saveConsentChoice(true, false) // analytics on, marketing still off
  initMetaPixelIfConsented()
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'declined marketing must not init the pixel, even with analytics on')

  saveConsentChoice(true, true)
  initMetaPixelIfConsented()
  const queue = getFbqQueue()
  assert(queue.filter((call) => call[0] === 'track' && call[1] === 'PageView').length === 1, 'PageView must fire exactly once after late marketing acceptance')
})

await check('[A20] trackCompleteRegistration idempotency — max one event regardless of repeated/rerender calls', () => {
  fullReset()
  acceptAllConsent()
  __setMetaPixelIdOverrideForTests('123456789012345')
  initMetaPixelIfConsented()

  trackCompleteRegistration('evt-account-1')
  trackCompleteRegistration('evt-account-1')
  trackCompleteRegistration('evt-different-id')
  const completeRegEvents = getFbqQueue().filter((call) => call[0] === 'track' && call[1] === 'CompleteRegistration')
  assert(completeRegEvents.length === 1, `expected exactly 1 CompleteRegistration, got ${completeRegEvents.length}`)
})

await check('[A21] CompleteRegistration depends ONLY on marketing consent — analytics:true alone blocks it, and it is never sent retroactively', () => {
  fullReset()
  __setMetaPixelIdOverrideForTests('123456789012345')
  saveConsentChoice(true, false) // analytics on, marketing off

  trackCompleteRegistration('evt-blocked')
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'nothing should happen while marketing is declined, even with analytics on')

  // User later accepts marketing — this must NOT retroactively fire the missed event.
  saveConsentChoice(true, true)
  initMetaPixelIfConsented()
  const completeRegEvents = getFbqQueue().filter((call) => call[0] === 'track' && call[1] === 'CompleteRegistration')
  assert(completeRegEvents.length === 0, 'CompleteRegistration must never be sent retroactively')
})

await check('[A22] CompleteRegistration blocked when the pixel was never initialized (no pixel ID)', () => {
  fullReset()
  acceptAllConsent()
  __setMetaPixelIdOverrideForTests(null)
  trackCompleteRegistration('evt-no-pixel')
  assert((globalThis as Record<string, unknown>).fbq === undefined, 'no fbq should exist without a configured pixel')
})

// ─── initializeAnalytics orchestration — marketing-only ─────────────────

await check('[A23] initializeAnalytics reacts only to marketing consent, never to analytics alone', () => {
  fullReset()
  __setMetaPixelIdOverrideForTests('123456789012345')

  initializeAnalytics()
  assert(fakeDocument.headAppended.length === 0, 'nothing should load before any consent is recorded')

  saveConsentChoice(true, false)
  assert(fakeDocument.headAppended.length === 0, 'analytics:true alone must not trigger AdSense/Pixel')

  saveConsentChoice(true, true)
  assert(
    fakeDocument.headAppended.some((el) => el.src.includes('ca-pub-4005564019331779')),
    'AdSense must load once marketing consent is granted',
  )
  assert(
    fakeDocument.headAppended.some((el) => el.src.includes('fbevents.js')),
    'Meta Pixel must load once marketing consent is granted',
  )
})

console.log('')

// ═══════════════════════════════════════════════════════════════════════
// Part B — source-text checks for wiring that needs full app context
// ═══════════════════════════════════════════════════════════════════════

console.log('=== Part B: source wiring checks ===\n')

const INDEX_HTML_PATH = join(REPO_ROOT, 'index.html')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')
const RENDER_LOBBY_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const LEGAL_PAGES_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'publicLegalPages.ts')
const META_PIXEL_PATH = join(REPO_ROOT, 'src', 'app', 'analytics', 'metaPixel.ts')
const LOAD_ADSENSE_PATH = join(REPO_ROOT, 'src', 'app', 'analytics', 'loadAdSense.ts')
const INITIALIZE_ANALYTICS_PATH = join(REPO_ROOT, 'src', 'app', 'analytics', 'initializeAnalytics.ts')
const ENV_EXAMPLE_PATH = join(REPO_ROOT, '.env.example')

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

const indexHtmlSrc = normalizeLineEndings(await readFile(INDEX_HTML_PATH, 'utf8'))
const mainSrc = normalizeLineEndings(await readFile(MAIN_PATH, 'utf8'))
const renderLobbySrc = normalizeLineEndings(await readFile(RENDER_LOBBY_PATH, 'utf8'))
const legalPagesSrc = normalizeLineEndings(await readFile(LEGAL_PAGES_PATH, 'utf8'))
const metaPixelSrc = normalizeLineEndings(await readFile(META_PIXEL_PATH, 'utf8'))
const loadAdSenseSrc = normalizeLineEndings(await readFile(LOAD_ADSENSE_PATH, 'utf8'))
const initializeAnalyticsSrc = normalizeLineEndings(await readFile(INITIALIZE_ANALYTICS_PATH, 'utf8'))
const envExampleSrc = normalizeLineEndings(await readFile(ENV_EXAMPLE_PATH, 'utf8'))

await check('[B1] index.html no longer statically loads adsbygoogle.js or fbevents.js', () => {
  assert(!indexHtmlSrc.includes('pagead2.googlesyndication.com'), 'AdSense script must not be static in index.html')
  assert(!indexHtmlSrc.includes('connect.facebook.net'), 'Meta Pixel script must not be static in index.html')
})

await check('[B2] main.ts mounts the consent UI and initializes analytics at bootstrap', () => {
  assert(mainSrc.includes('mountConsentUi()'), 'main.ts must call mountConsentUi()')
  assert(mainSrc.includes('initializeAnalytics()'), 'main.ts must call initializeAnalytics()')
})

await check('[B3] trackCompleteRegistration is called only inside the register-success branch, never for login', () => {
  const fnStart = mainSrc.indexOf('async function submitAuthRequest')
  const fnEnd = mainSrc.indexOf('\nasync function submitLogout')
  assert(fnStart !== -1 && fnEnd !== -1 && fnEnd > fnStart, 'could not locate submitAuthRequest body')
  const fnBody = mainSrc.slice(fnStart, fnEnd)

  const callIndex = fnBody.indexOf('trackCompleteRegistration(')
  assert(callIndex !== -1, 'submitAuthRequest must call trackCompleteRegistration')

  const guardIndex = fnBody.lastIndexOf("endpoint === 'register'", callIndex)
  assert(guardIndex !== -1 && guardIndex < callIndex, 'the call must be guarded by endpoint === \'register\'')

  const successMarkerIndex = fnBody.indexOf('currentAuthSession = data.session')
  assert(successMarkerIndex !== -1 && successMarkerIndex < callIndex, 'the call must happen after the success branch is reached')

  const failureReturnIndex = fnBody.indexOf('return data.message')
  assert(failureReturnIndex !== -1 && failureReturnIndex < callIndex, 'the failure branch must return before reaching the call')
})

await check('[B4] trackCompleteRegistration is never called from the /api/auth/me bootstrap or logout paths', () => {
  const meFnStart = mainSrc.indexOf('async function loadAuthSession')
  const meFnEnd = mainSrc.indexOf('\nasync function submitAuthRequest')
  const meBody = mainSrc.slice(meFnStart, meFnEnd)
  assert(!meBody.includes('trackCompleteRegistration'), 'loadAuthSession (/api/auth/me) must never call trackCompleteRegistration')

  const logoutFnStart = mainSrc.indexOf('async function submitLogout')
  const logoutFnEnd = mainSrc.indexOf('\nasync function loadPlayersDirectory')
  const logoutBody = mainSrc.slice(logoutFnStart, logoutFnEnd)
  assert(!logoutBody.includes('trackCompleteRegistration'), 'submitLogout must never call trackCompleteRegistration')
})

await check('[B5] no direct fbq(...) calls anywhere outside the metaPixel.ts wrapper', () => {
  const srcDir = join(REPO_ROOT, 'src')
  const offenders: string[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stats = statSync(fullPath)
      if (stats.isDirectory()) {
        walk(fullPath)
        continue
      }
      if (!entry.endsWith('.ts')) continue
      if (fullPath === META_PIXEL_PATH) continue
      const content = readFileSync(fullPath, 'utf8')
      if (/\bfbq\s*\(/.test(content)) offenders.push(fullPath)
    }
  }

  walk(srcDir)
  assert(offenders.length === 0, `direct fbq() calls found outside metaPixel.ts: ${offenders.join(', ')}`)
})

await check('[B6] metaPixel.ts reads the pixel ID from VITE_META_PIXEL_ID, no hardcoded production ID', () => {
  assert(metaPixelSrc.includes('VITE_META_PIXEL_ID'), 'must read VITE_META_PIXEL_ID')
  assert(!/\b\d{15,16}\b/.test(metaPixelSrc), 'no hardcoded 15-16 digit pixel ID literal')
})

await check('[B7] renderLobbyScreen.ts exposes a permanent "Настройки на бисквитките" link in both footers', () => {
  const occurrences = renderLobbySrc.split('Настройки на бисквитките').length - 1
  assert(occurrences === 2, `expected the link text in both desktop and mobile footers, found ${occurrences}`)
  assert(renderLobbySrc.includes('data-consent-open-settings="1"'), 'footer link must carry data-consent-open-settings')
})

await check('[B8] publicLegalPages.ts documents all three categories and Meta/AdSense specifics accurately', () => {
  assert(legalPagesSrc.includes('Аналитични'), 'privacy policy must describe the analytics category')
  assert(legalPagesSrc.includes('Маркетинг'), 'privacy policy must describe the marketing category')
  assert(legalPagesSrc.includes('Meta Pixel'), 'privacy policy must mention Meta Pixel')
  assert(legalPagesSrc.includes('PageView'), 'privacy policy must mention PageView')
  assert(legalPagesSrc.includes('CompleteRegistration'), 'privacy policy must mention CompleteRegistration')
  assert(legalPagesSrc.includes('AdSense'), 'privacy policy must mention Google AdSense')
  assert(!legalPagesSrc.includes('Conversions API') || legalPagesSrc.includes('не изпраща данни към Meta чрез сървърно интегриране'), 'must not falsely claim Conversions API usage')
  assert(!legalPagesSrc.includes('access token'), 'must not mention a Meta access token')
})

await check('[B9] .env.example documents VITE_META_PIXEL_ID with no real value committed', () => {
  assert(/^VITE_META_PIXEL_ID=\s*$/m.test(envExampleSrc), '.env.example must declare an empty VITE_META_PIXEL_ID')
})

await check('[B10] loadAdSense.ts and metaPixel.ts gate strictly on marketing consent, not analytics', () => {
  assert(loadAdSenseSrc.includes('hasMarketingConsent'), 'loadAdSense.ts must check hasMarketingConsent')
  assert(!loadAdSenseSrc.includes('hasAnalyticsConsent'), 'loadAdSense.ts must not gate on hasAnalyticsConsent')
  assert(metaPixelSrc.includes('hasMarketingConsent'), 'metaPixel.ts must check hasMarketingConsent')
  assert(!metaPixelSrc.includes('hasAnalyticsConsent'), 'metaPixel.ts must not gate on hasAnalyticsConsent')
  assert(initializeAnalyticsSrc.includes('marketing'), 'initializeAnalytics.ts must key off consent.marketing')
})

console.log('')

// ═══════════════════════════════════════════════════════════════════════
// Part C — real browser (Playwright) against a built, statically served dist
// ═══════════════════════════════════════════════════════════════════════

console.log('=== Part C: real browser consent/UI flow (Playwright) ===\n')

const DIST_DIR = join(REPO_ROOT, 'dist')
const PORT = 4933
const CONSENT_KEY = 'pika-consent-v2'

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
}

function startStaticServer() {
  return createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      let filePath = join(DIST_DIR, urlPath === '/' ? '/index.html' : urlPath)
      try {
        const st = await stat(filePath)
        if (st.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        if (!extname(urlPath)) filePath = join(DIST_DIR, 'index.html')
      }
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404')
    }
  }).listen(PORT, '127.0.0.1')
}

function runBuild(): Promise<void> {
  return new Promise((resolveBuild, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(
      'npx', ['vite', 'build'],
      { cwd: REPO_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('exit', (code) => (code === 0 ? resolveBuild() : reject(new Error(out.slice(-2000)))))
  })
}

console.log('Build-вам dist (нужен е реален index.html/bundle, без backend)...')
await runBuild()

const server = startStaticServer()
await new Promise((r) => setTimeout(r, 300))

let browser: Browser | null = null

try {
  browser = await chromium.launch({ headless: true })
  const BASE = `http://127.0.0.1:${PORT}`

  await check('[C1] fresh visit with no consent shows the banner with the exact required copy', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    const banner = page.locator('[data-consent-banner="1"]')
    await banner.waitFor({ state: 'visible', timeout: 5000 })
    const text = (await banner.textContent()) ?? ''
    assert(text.includes('Този сайт използва бисквитки'), 'banner title missing')
    assert(text.includes('Използваме бисквитки, за да улесним работата на сайта'), 'banner description missing')
    assert(text.includes('Настройки'), '"Настройки" button missing')
    assert(text.includes('Приеми всички'), '"Приеми всички" button missing')
    await context.close()
  })

  await check('[C2] banner never mentions ads/tracking/profiling/Facebook/Meta/AdSense', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    const banner = page.locator('[data-consent-banner="1"]')
    await banner.waitFor({ state: 'visible' })
    const text = ((await banner.textContent()) ?? '').toLowerCase()
    for (const forbidden of ['реклам', 'проследяван', 'профилиран', 'facebook', 'meta', 'adsense']) {
      assert(!text.includes(forbidden), `banner text must not mention "${forbidden}"`)
    }
    await context.close()
  })

  await check('[C3] no AdSense/Meta network request fires before any consent decision', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    let seen = false
    page.on('request', (req) => { if (/googlesyndication\.com|connect\.facebook\.net/.test(req.url())) seen = true })
    await page.goto(`${BASE}/lobby`)
    await page.waitForTimeout(1500)
    assert(!seen, 'no AdSense/Meta request should fire before consent')
    await context.close()
  })

  await check('[C4] "Приеми всички" persists necessary+analytics+marketing true, closes the banner, triggers AdSense', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    let adRequestSeen = false
    page.on('request', (req) => { if (/googlesyndication\.com/.test(req.url())) adRequestSeen = true })
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-accept-all="1"]').click()
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'detached', timeout: 5000 })
    const stored = await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY)
    assert(stored !== null, 'consent must be persisted')
    const parsed = JSON.parse(stored!)
    assert(parsed.necessary === true && parsed.analytics === true && parsed.marketing === true, 'accept-all must record necessary+analytics+marketing true')
    await page.waitForTimeout(1000)
    assert(adRequestSeen, 'AdSense script request should be attempted after accept-all')
    await context.close()
  })

  await check('[C5] settings modal via banner: Escape closes without saving and restores focus to opener', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    const settingsButton = page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]')
    await settingsButton.click()
    const dialog = page.locator('[data-consent-modal-dialog="1"]')
    await dialog.waitFor({ state: 'visible' })
    assert((await dialog.getAttribute('aria-modal')) === 'true', 'dialog must have aria-modal=true')
    assert((await dialog.getAttribute('role')) === 'dialog', 'dialog must have role=dialog')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached', timeout: 5000 })
    const stored = await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY)
    assert(stored === null, 'Escape must not record any consent choice')
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'visible' })
    await context.close()
  })

  await check('[C6] settings modal via banner: X closes without saving, banner stays visible', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]').click()
    const dialog = page.locator('[data-consent-modal-dialog="1"]')
    await dialog.waitFor({ state: 'visible' })
    await page.locator('[data-consent-modal-close="1"]').click()
    await dialog.waitFor({ state: 'detached' })
    const stored = await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY)
    assert(stored === null, 'X must not record any consent choice')
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'visible' })
    await context.close()
  })

  await check('[C7] necessary always checked+disabled; analytics AND marketing both start unchecked on first visit', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    assert(!(await page.isChecked('[data-consent-analytics-checkbox="1"]')), 'analytics must start unchecked')
    assert(!(await page.isChecked('[data-consent-marketing-checkbox="1"]')), 'marketing must start unchecked')
    assert(await page.isChecked('[data-consent-necessary-checkbox="1"]'), 'necessary must always be checked')
    assert(await page.isDisabled('[data-consent-necessary-checkbox="1"]'), 'necessary checkbox must be disabled')
    await context.close()
  })

  await check('[C8] "Запази избора" with analytics ON but marketing OFF persists both independently and loads nothing', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    let seen = false
    page.on('request', (req) => { if (/googlesyndication\.com|connect\.facebook\.net/.test(req.url())) seen = true })
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-consent-analytics-checkbox="1"]').check()
    // marketing stays unchecked
    await page.locator('[data-consent-save-choice="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })
    const parsed = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY))!)
    assert(parsed.analytics === true, 'analytics must persist true')
    assert(parsed.marketing === false, 'marketing must persist false')
    await page.waitForTimeout(1000)
    assert(!seen, 'analytics-only consent must not load AdSense/Meta')
    await context.close()
  })

  await check('[C9] "Запази избора" with marketing ON (analytics off) loads AdSense/Meta', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    let seen = false
    page.on('request', (req) => { if (/googlesyndication\.com/.test(req.url())) seen = true })
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    // analytics stays unchecked
    await page.locator('[data-consent-marketing-checkbox="1"]').check()
    await page.locator('[data-consent-save-choice="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })
    const parsed = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY))!)
    assert(parsed.analytics === false, 'analytics must persist false')
    assert(parsed.marketing === true, 'marketing must persist true')
    await page.waitForTimeout(1000)
    assert(seen, 'marketing consent must load AdSense')
    await context.close()
  })

  await check('[C10] reopening reflects the previously saved analytics/marketing combination independently', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-consent-analytics-checkbox="1"]').check()
    // marketing left unchecked
    await page.locator('[data-consent-save-choice="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })

    // Banner is gone now — data-consent-open-settings only matches the footer link.
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    assert(await page.isChecked('[data-consent-analytics-checkbox="1"]'), 'modal must reflect the previously saved analytics:true')
    assert(!(await page.isChecked('[data-consent-marketing-checkbox="1"]')), 'modal must reflect the previously saved marketing:false')
    await context.close()
  })

  await check('[C11] persistent footer link reopens settings after reload, banner stays gone', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-accept-all="1"]').click()
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'detached' })
    await page.reload()
    await page.waitForTimeout(800)
    assert((await page.locator('[data-consent-banner="1"]').count()) === 0, 'banner must not reappear once a valid choice is recorded')
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible', timeout: 5000 })
    await context.close()
  })

  await check('[C12] revoking marketing only (keeping analytics on), then reloading, never loads AdSense/Meta again', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-accept-all="1"]').click()
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'detached' })
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    // analytics stays checked (was true from accept-all), only uncheck marketing
    await page.locator('[data-consent-marketing-checkbox="1"]').uncheck()
    await page.locator('[data-consent-save-choice="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })

    const parsed = JSON.parse((await page.evaluate((key) => localStorage.getItem(key), CONSENT_KEY))!)
    assert(parsed.analytics === true && parsed.marketing === false, 'analytics must stay true while marketing is revoked')

    let seen = false
    page.on('request', (req) => { if (/googlesyndication\.com|connect\.facebook\.net/.test(req.url())) seen = true })
    await page.reload()
    await page.waitForTimeout(1200)
    assert(!seen, 'revoked marketing must stay off after reload, regardless of analytics')
    await context.close()
  })

  await check('[C13] full accept → revoke marketing → reopen flow never throws an uncaught page error', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(err.message))

    await page.goto(`${BASE}/lobby`)
    await page.locator('[data-consent-banner="1"] [data-consent-accept-all="1"]').click()
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'detached' })
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-consent-marketing-checkbox="1"]').uncheck()
    await page.locator('[data-consent-save-choice="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'detached' })

    assert(pageErrors.length === 0, `unexpected page errors: ${pageErrors.join(' | ')}`)
    await context.close()
  })

  await check('[C14] clearing consent storage → "Приеми всички" → reopening settings shows both analytics and marketing checked', async () => {
    const context = await browser!.newContext()
    const page = await context.newPage()
    await page.goto(`${BASE}/lobby`)
    await page.evaluate((key) => localStorage.removeItem(key), CONSENT_KEY)
    await page.reload()
    await page.locator('[data-consent-banner="1"] [data-consent-accept-all="1"]').click()
    await page.locator('[data-consent-banner="1"]').waitFor({ state: 'detached', timeout: 5000 })
    await page.locator('[data-consent-open-settings="1"]').click()
    await page.locator('[data-consent-modal-dialog="1"]').waitFor({ state: 'visible' })
    assert(await page.isChecked('[data-consent-analytics-checkbox="1"]'), 'analytics checkbox must be checked after accept-all')
    assert(await page.isChecked('[data-consent-marketing-checkbox="1"]'), 'marketing checkbox must be checked after accept-all')
    await context.close()
  })
} finally {
  if (browser) await browser.close()
  server.close()
}

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) {
  process.exit(1)
}

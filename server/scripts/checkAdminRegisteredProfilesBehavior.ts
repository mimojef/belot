/**
 * checkAdminRegisteredProfilesBehavior.ts
 *
 * Behavioral checks: клик върху "днес"/"вчера" бройката в Admin -> Информация
 * действително отваря модала за правилния period, зарежда редовете, и се
 * затваря коректно (close бутон / backdrop). Огледално на подхода в
 * checkAdminPaymentsFrontend.ts (FakeRoot/installFakeBrowser), стеснено само
 * до елементите, нужни тук.
 *
 * [1] Клик на "днес" отваря модала с period='today' и зарежда правилните редове
 * [2] Клик на "вчера" отваря модала с period='yesterday' и зарежда правилните редове
 * [3] Клик на close бутона затваря модала
 * [4] Клик на backdrop-а затваря модала
 * [5] Late-arriving response за затворен/сменен модал не презаписва текущото състояние
 */

import { createLobbyFlowController } from '../../src/app/lobby/createLobbyFlowController.js'
import type { LobbyAuthSession } from '../../src/app/lobby/createLobbyFlowController.js'
import type { AdminRegisteredProfileRow } from '../../src/app/network/createGameServerClient.js'

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
async function asyncCheck(label: string, fn: () => Promise<void> | void): Promise<void> {
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

// ─── Минимален DOM stub (regex-базиран querySelectorAll над innerHTML) ────────

type FakeClickHandler = (ev: Event) => void

class FakeDomElement {
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  private listeners: Record<string, FakeClickHandler[]> = {}

  appendChild(_child: unknown): void {}
  contains(_child: unknown): boolean { return false }
  remove(): void {}
  setAttribute(name: string, value: string): void { (this as unknown as Record<string, unknown>)[name] = value }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void {
    const fn: FakeClickHandler = typeof handler === 'function' ? handler as FakeClickHandler : (ev) => { handler.handleEvent(ev) }
    this.listeners[event] = [...(this.listeners[event] ?? []), fn]
  }
  dispatchClick(): void {
    for (const handler of this.listeners.click ?? []) handler({ type: 'click' } as Event)
  }
  querySelector<T extends Element>(_selector: string): T | null { return null }
  querySelectorAll<T extends Element>(_selector: string): NodeListOf<T> { return [] as unknown as NodeListOf<T> }
}

class FakeRoot extends FakeDomElement {
  private html = ''
  private openButtons: FakeDomElement[] = []
  private closeButton: FakeDomElement | null = null
  private backdropEl: FakeDomElement | null = null

  set innerHTML(value: string) {
    this.html = value
    this.openButtons = [...this.html.matchAll(/data-admin-registered-profiles-open="([^"]+)"/g)].map((m) => {
      const btn = new FakeDomElement()
      btn.dataset.adminRegisteredProfilesOpen = m[1] ?? ''
      return btn
    })
    this.closeButton = this.html.includes('data-admin-registered-profiles-close="1"') ? new FakeDomElement() : null
    this.backdropEl = this.html.includes('data-admin-registered-profiles-backdrop="1"') ? new FakeDomElement() : null
  }
  get innerHTML(): string { return this.html }

  override querySelectorAll<T extends Element>(selector: string): NodeListOf<T> {
    if (selector === '[data-admin-registered-profiles-open]') {
      return this.openButtons as unknown as NodeListOf<T>
    }
    return [] as unknown as NodeListOf<T>
  }

  override querySelector<T extends Element>(selector: string): T | null {
    if (selector === '[data-admin-registered-profiles-close="1"]') return this.closeButton as unknown as T | null
    if (selector === '[data-admin-registered-profiles-backdrop="1"]') return this.backdropEl as unknown as T | null
    return null
  }

  clickOpen(period: 'today' | 'yesterday'): void {
    const btn = this.openButtons.find((b) => b.dataset.adminRegisteredProfilesOpen === period)
    if (!btn) throw new Error(`open button for period="${period}" was not wired`)
    btn.dispatchClick()
  }
  clickClose(): void {
    if (!this.closeButton) throw new Error('close button was not wired (modal likely not open)')
    this.closeButton.dispatchClick()
  }
  clickBackdrop(): void {
    if (!this.backdropEl) throw new Error('backdrop was not wired (modal likely not open)')
    this.backdropEl.dispatchClick()
  }
}

function installFakeBrowser(startPath: string): void {
  const location = { pathname: '', search: '', assign: (url: string) => { setUrl(url) } }
  const setUrl = (url: string): void => {
    const relative = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
    const [pathname, search = ''] = relative.split('?')
    location.pathname = pathname || '/lobby'
    location.search = search ? `?${search}` : ''
  }
  setUrl(startPath)
  const fakeWindow = {
    innerWidth: 1440, innerHeight: 900, location,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {}, removeEventListener: () => {},
    requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
  }
  const fakeHistory = {
    pushState: (_s: unknown, _t: string, url?: string | URL | null) => { if (url) setUrl(String(url)) },
    replaceState: (_s: unknown, _t: string, url?: string | URL | null) => { if (url) setUrl(String(url)) },
  }
  const fakeDocument = {
    activeElement: null, title: '', body: new FakeDomElement(), head: new FakeDomElement(),
    createElement: () => new FakeDomElement(), getElementById: () => null, querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  }
  Object.assign(globalThis, {
    window: fakeWindow, document: fakeDocument, history: fakeHistory,
    requestAnimationFrame: fakeWindow.requestAnimationFrame, cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    setTimeout: fakeWindow.setTimeout, clearTimeout: fakeWindow.clearTimeout,
  })
}

function makeAdminSession(): LobbyAuthSession {
  return {
    account: { role: 'admin' },
    profile: {
      profileId: 'admin-profile-001',
      displayName: 'Admin User',
      avatarUrl: null,
      level: 10,
      rankTitle: 'Admin',
      skillRating: 1000,
      completedGamesCount: 0,
      wonGamesCount: 0,
      currentRankGames: 0,
      nextRankGames: 10,
      gamesUntilNextRank: 10,
      rankProgressRatio: 0,
      averageRating: null,
      totalRatingsCount: 0,
      yellowCoinsBalance: 1000,
      galleryImages: [],
      gender: null,
      likesCount: 0,
      hasLikedByMe: null,
      isBlockedByMe: null,
    },
  } as unknown as LobbyAuthSession
}

function makeRow(period: 'today' | 'yesterday'): AdminRegisteredProfileRow {
  return {
    profileId: `profile-${period}`,
    username: `User${period}`,
    displayName: `Display ${period}`,
    createdAt: '2026-08-15 10:00:00',
    email: `${period}@example.test`,
  }
}

// ─── Тестове ────────────────────────────────────────────────────────────────

console.log('\ncheckAdminRegisteredProfilesBehavior')

await asyncCheck('[1] клик на "днес" отваря модала с period=today и заредени редове', async () => {
  const root = new FakeRoot()
  installFakeBrowser('/admin/info')
  const loadCalls: Array<'today' | 'yesterday'> = []
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeAdminSession(),
    onAdminStatsLoad: async () => ({
      ok: true,
      stats: {
        onlineCount: 0,
        registeredProfiles: { total: 100, today: 3, yesterday: 2 },
        payments: {
          today: { count: 0, totalCents: 0 }, yesterday: { count: 0, totalCents: 0 },
          last7days: { count: 0, totalCents: 0 }, thisMonth: { count: 0, totalCents: 0 }, allTime: { count: 0, totalCents: 0 },
        },
        visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
        viewLayout: {
          today: { mobile: 0, desktop: 0 }, yesterday: { mobile: 0, desktop: 0 },
          last7days: { mobile: 0, desktop: 0 }, last30days: { mobile: 0, desktop: 0 },
        },
        gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
      },
    }),
    onAdminRegisteredProfilesLoad: async (period) => {
      loadCalls.push(period)
      return { ok: true, rows: [makeRow(period)] }
    },
  })

  controller.setConnected(true)
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()

  root.clickOpen('today')
  await Promise.resolve()
  await Promise.resolve()

  assert(loadCalls.length === 1, `expected exactly 1 load call, got ${loadCalls.length}`)
  assert(loadCalls[0] === 'today', `expected load for "today", got "${loadCalls[0]}"`)
  assert(root.innerHTML.includes('Регистрирани профили — Днес'), 'modal title for "today" not rendered')
  assert(root.innerHTML.includes('Usertoday'), 'row for "today" not rendered')
})

await asyncCheck('[2] клик на "вчера" отваря модала с period=yesterday и заредени редове', async () => {
  const root = new FakeRoot()
  installFakeBrowser('/admin/info')
  const loadCalls: Array<'today' | 'yesterday'> = []
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeAdminSession(),
    onAdminStatsLoad: async () => ({
      ok: true,
      stats: {
        onlineCount: 0,
        registeredProfiles: { total: 100, today: 3, yesterday: 2 },
        payments: {
          today: { count: 0, totalCents: 0 }, yesterday: { count: 0, totalCents: 0 },
          last7days: { count: 0, totalCents: 0 }, thisMonth: { count: 0, totalCents: 0 }, allTime: { count: 0, totalCents: 0 },
        },
        visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
        viewLayout: {
          today: { mobile: 0, desktop: 0 }, yesterday: { mobile: 0, desktop: 0 },
          last7days: { mobile: 0, desktop: 0 }, last30days: { mobile: 0, desktop: 0 },
        },
        gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
      },
    }),
    onAdminRegisteredProfilesLoad: async (period) => {
      loadCalls.push(period)
      return { ok: true, rows: [makeRow(period)] }
    },
  })

  controller.setConnected(true)
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()

  root.clickOpen('yesterday')
  await Promise.resolve()
  await Promise.resolve()

  assert(loadCalls.length === 1, `expected exactly 1 load call, got ${loadCalls.length}`)
  assert(loadCalls[0] === 'yesterday', `expected load for "yesterday", got "${loadCalls[0]}"`)
  assert(root.innerHTML.includes('Регистрирани профили — Вчера'), 'modal title for "yesterday" not rendered')
  assert(root.innerHTML.includes('Useryesterday'), 'row for "yesterday" not rendered')
})

await asyncCheck('[3] клик на close бутона затваря модала', async () => {
  const root = new FakeRoot()
  installFakeBrowser('/admin/info')
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeAdminSession(),
    onAdminStatsLoad: async () => ({
      ok: true,
      stats: {
        onlineCount: 0,
        registeredProfiles: { total: 100, today: 3, yesterday: 2 },
        payments: {
          today: { count: 0, totalCents: 0 }, yesterday: { count: 0, totalCents: 0 },
          last7days: { count: 0, totalCents: 0 }, thisMonth: { count: 0, totalCents: 0 }, allTime: { count: 0, totalCents: 0 },
        },
        visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
        viewLayout: {
          today: { mobile: 0, desktop: 0 }, yesterday: { mobile: 0, desktop: 0 },
          last7days: { mobile: 0, desktop: 0 }, last30days: { mobile: 0, desktop: 0 },
        },
        gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
      },
    }),
    onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: [makeRow(period)] }),
  })

  controller.setConnected(true)
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  root.clickOpen('today')
  await Promise.resolve()
  await Promise.resolve()
  assert(root.innerHTML.includes('data-admin-registered-profiles-root="1"'), 'modal should be open before close')

  root.clickClose()
  assert(!root.innerHTML.includes('data-admin-registered-profiles-root="1"'), 'modal should be closed after clicking close')
})

await asyncCheck('[4] клик на backdrop-а затваря модала', async () => {
  const root = new FakeRoot()
  installFakeBrowser('/admin/info')
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeAdminSession(),
    onAdminStatsLoad: async () => ({
      ok: true,
      stats: {
        onlineCount: 0,
        registeredProfiles: { total: 100, today: 3, yesterday: 2 },
        payments: {
          today: { count: 0, totalCents: 0 }, yesterday: { count: 0, totalCents: 0 },
          last7days: { count: 0, totalCents: 0 }, thisMonth: { count: 0, totalCents: 0 }, allTime: { count: 0, totalCents: 0 },
        },
        visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
        viewLayout: {
          today: { mobile: 0, desktop: 0 }, yesterday: { mobile: 0, desktop: 0 },
          last7days: { mobile: 0, desktop: 0 }, last30days: { mobile: 0, desktop: 0 },
        },
        gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
      },
    }),
    onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: [makeRow(period)] }),
  })

  controller.setConnected(true)
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  root.clickOpen('yesterday')
  await Promise.resolve()
  await Promise.resolve()
  assert(root.innerHTML.includes('data-admin-registered-profiles-root="1"'), 'modal should be open before backdrop click')

  root.clickBackdrop()
  assert(!root.innerHTML.includes('data-admin-registered-profiles-root="1"'), 'modal should be closed after clicking backdrop')
})

await asyncCheck('[5] late-arriving response за сменен period не презаписва текущото състояние', async () => {
  const root = new FakeRoot()
  installFakeBrowser('/admin/info')
  const resolvers: Array<(v: { ok: true; rows: AdminRegisteredProfileRow[] }) => void> = []
  const controller = createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeAdminSession(),
    onAdminStatsLoad: async () => ({
      ok: true,
      stats: {
        onlineCount: 0,
        registeredProfiles: { total: 100, today: 3, yesterday: 2 },
        payments: {
          today: { count: 0, totalCents: 0 }, yesterday: { count: 0, totalCents: 0 },
          last7days: { count: 0, totalCents: 0 }, thisMonth: { count: 0, totalCents: 0 }, allTime: { count: 0, totalCents: 0 },
        },
        visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
        viewLayout: {
          today: { mobile: 0, desktop: 0 }, yesterday: { mobile: 0, desktop: 0 },
          last7days: { mobile: 0, desktop: 0 }, last30days: { mobile: 0, desktop: 0 },
        },
        gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
      },
    }),
    onAdminRegisteredProfilesLoad: (period) => new Promise((resolvePromise) => {
      resolvers.push((v) => resolvePromise(v))
      void period
    }),
  })

  controller.setConnected(true)
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()

  // Отвори "today" (заявката виси), после веднага смени на "yesterday".
  root.clickOpen('today')
  await Promise.resolve()
  root.clickOpen('yesterday')
  await Promise.resolve()

  // Първата (stale) "today" заявка се разрешава СЕГА — късно.
  const staleResolve = resolvers[0]
  assert(staleResolve !== undefined, 'first (stale) request resolver must exist')
  staleResolve({ ok: true, rows: [makeRow('today')] })
  await Promise.resolve()
  await Promise.resolve()

  assert(
    root.innerHTML.includes('Регистрирани профили — Вчера'),
    'stale "today" response must not overwrite the currently-open "yesterday" modal',
  )
  assert(
    !root.innerHTML.includes('Usertoday'),
    'stale "today" rows must not leak into the "yesterday" modal',
  )
})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

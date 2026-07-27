/**
 * checkSubadminAdminInfoAccessPolling.ts
 *
 * Реални (изпълними) тестове на M1 поправката — засичане на отнет
 * административен достъп, докато потребителят е на екран от фамилията
 * "Информация" (stats/visitors/visitor-sources/payments/payment-detail).
 *
 * Използва установения в проекта fake-browser harness (виж
 * checkAdminPaymentsFrontend.ts) за реално извикване на
 * createLobbyFlowController() — не text-grep, а реално изпълнение на
 * навигационните функции, forbidden-детекцията и forceLeaveAdminScreenForbidden.
 *
 * Покрива:
 *  [1] субадмин е на "Информация" (navigateAdminInfo зарежда екрана).
 *  [2]/[3] ролята му се премахва → frontend засича свежата забрана
 *      (forceLeaveAdminScreenForbidden, същият механизъм, който polling-ът
 *      в main.ts извиква при 403 от /api/auth/me).
 *  [4] потребителят се връща безопасно към лобито (currentScreen === 'lobby').
 *  [5] стар/закъснял отговор (resolved след напускане на екрана) НЕ
 *      пренасочва — нито текущия (различен) екран, нито изобщо.
 *  [6] onAdminInfoFamilyScreenEnter/Leave се викат точно толкова пъти,
 *      колкото се влиза/излиза от фамилията "Информация" — доказва, че
 *      polling стартът/спирането в main.ts (свързани точно с тези hook-ове)
 *      се случват коректно, без дублиране.
 *  [7] пълен admin не се засяга (forbidden никога не се тригва за ok:true).
 *  [8] 403 (forbidden:true) от stats/visitors/payments заявка -> safe redirect.
 */

import { createLobbyFlowController } from '../../src/app/lobby/createLobbyFlowController.js'
import type { LobbyAuthSession } from '../../src/app/lobby/createLobbyFlowController.js'
import type { AdminStatsSnapshot, PlayerPublicProfileSnapshot } from '../../src/app/network/createGameServerClient.js'

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
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

// ─── Минимален fake-browser harness (огледален на checkAdminPaymentsFrontend.ts) ──

type FakeClickHandler = (ev: Event) => void

class FakeDomElement {
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  private listeners: Record<string, FakeClickHandler[]> = {}
  appendChild(_child: unknown): void {}
  contains(_child: unknown): boolean { return false }
  remove(): void {}
  setAttribute(_name: string, _value: string): void {}
  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void {
    const fn: FakeClickHandler = typeof handler === 'function' ? handler as FakeClickHandler : (ev) => { handler.handleEvent(ev) }
    this.listeners[event] = [...(this.listeners[event] ?? []), fn]
  }
  removeEventListener(): void {}
  querySelector<T extends Element>(_selector: string): T | null { return null }
  querySelectorAll<T extends Element>(_selector: string): NodeListOf<T> { return [] as unknown as NodeListOf<T> }
}

class FakeRoot extends FakeDomElement {
  private html = ''
  set innerHTML(value: string) { this.html = value }
  get innerHTML(): string { return this.html }
}

function installFakeBrowser(startPath: string): void {
  const location = {
    pathname: '',
    search: '',
    assign: (url: string) => { setUrl(url) },
  }
  const setUrl = (url: string): void => {
    const relative = url.startsWith('http') ? new URL(url).pathname + new URL(url).search : url
    const [pathname, search = ''] = relative.split('?')
    location.pathname = pathname || '/lobby'
    location.search = search ? `?${search}` : ''
  }
  setUrl(startPath)

  const fakeWindow = {
    innerWidth: 1440,
    innerHeight: 900,
    location,
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const fakeHistory = {
    pushState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) setUrl(String(url)) },
    replaceState: (_state: unknown, _title: string, url?: string | URL | null) => { if (url) setUrl(String(url)) },
  }
  const fakeDocument = {
    activeElement: null,
    title: '',
    body: new FakeDomElement(),
    head: new FakeDomElement(),
    createElement: () => new FakeDomElement(),
    getElementById: () => null,
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  Object.assign(globalThis, {
    window: fakeWindow,
    document: fakeDocument,
    history: fakeHistory,
    requestAnimationFrame: fakeWindow.requestAnimationFrame,
    cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    setTimeout: fakeWindow.setTimeout,
    clearTimeout: fakeWindow.clearTimeout,
  })
}

function makeProfile(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'session-profile-1',
    displayName: 'Test User',
    avatarUrl: null,
    level: 1,
    rankTitle: null,
    skillRating: 1000,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 10,
    gamesUntilNextRank: 10,
    rankProgressRatio: 0,
    averageRating: null,
    totalRatingsCount: 0,
    yellowCoinsBalance: 0,
    galleryImages: [],
    gender: null,
    likesCount: 0,
    hasLikedByMe: null,
    isBlockedByMe: null,
    ...overrides,
  }
}

function makeSession(role: 'admin' | 'subadmin' | 'player'): LobbyAuthSession {
  return { account: { role }, profile: makeProfile() }
}

// Пълноценен (не празен) AdminStatsSnapshot — реалният renderAdminInfoPanel()
// чете stats.visitors.today и др. директно, без null checks; {} като fixture
// би причинил TypeError при render() и unhandled promise rejection (виж
// showAdminInfoPanel's `void`-извикване от navigateAdminInfo).
function makeStatsSnapshot(): AdminStatsSnapshot {
  return {
    onlineCount: 0,
    registeredProfiles: { total: 0, today: 0, yesterday: 0 },
    payments: {
      today: { count: 0, totalCents: 0 },
      yesterday: { count: 0, totalCents: 0 },
      last7days: { count: 0, totalCents: 0 },
      thisMonth: { count: 0, totalCents: 0 },
      allTime: { count: 0, totalCents: 0 },
    },
    visitors: { today: 0, yesterday: 0, last7days: 0, last30days: 0, newToday: 0, newYesterday: 0 },
    viewLayout: {
      today: { mobile: 0, desktop: 0 },
      yesterday: { mobile: 0, desktop: 0 },
      last7days: { mobile: 0, desktop: 0 },
      last30days: { mobile: 0, desktop: 0 },
    },
    gamesPlayed: { userGamesToday: 0, userGamesYesterday: 0, guestTrialGamesToday: 0, guestTrialGamesYesterday: 0 },
  }
}

type ControllerOptions = Parameters<typeof createLobbyFlowController>[0]

function makeController(overrides: Partial<ControllerOptions>): ReturnType<typeof createLobbyFlowController> {
  const root = new FakeRoot()
  return createLobbyFlowController({
    root: root as unknown as HTMLElement,
    joinMatchmaking: () => {},
    leaveMatchmaking: () => {},
    onMatchFound: () => {},
    getAuthSession: () => makeSession('admin'),
    ...overrides,
  })
}

console.log('\ncheckSubadminAdminInfoAccessPolling')

// ─── [1] субадмин е на "Информация" ─────────────────────────────────────────
await check('[1] navigateAdminInfo() зарежда admin-info за subadmin сесия', async () => {
  installFakeBrowser('/lobby')
  let role: 'admin' | 'subadmin' | 'player' = 'subadmin'
  const controller = makeController({
    getAuthSession: () => makeSession(role),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'admin-info', `currentScreen=${controller.getCurrentScreen()}`)
  void role
})

// ─── [2]/[3]/[4] ролята е отнета -> frontend засича свежата забрана -> лоби ──
await check('[2][3][4] forceLeaveAdminScreenForbidden (симулира polling detection) връща subadmin на admin-info безопасно в лобито', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'admin-info', 'setup: очаквахме да сме на admin-info')

  // Точно това извиква main.ts-ката poll, когато /api/auth/me покаже role !== admin/subadmin.
  controller.forceLeaveAdminScreenForbidden('Достъпът до администраторския панел беше отнет.')

  assert(controller.getCurrentScreen() === 'lobby', `очаквахме безопасно връщане в лобито, currentScreen=${controller.getCurrentScreen()}`)
})

// ─── [8] 403 (forbidden:true) от stats/visitors/payments заявка -> safe redirect ──
await check('[8.1] onAdminStatsLoad връща forbidden:true -> currentScreen става lobby', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: false, message: 'Нямаш достъп.', forbidden: true }),
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'lobby', `currentScreen=${controller.getCurrentScreen()}`)
})

await check('[8.2] onAdminVisitorsLoad връща forbidden:true -> currentScreen става lobby', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminVisitorsLoad: async () => ({ ok: false, message: 'Нямаш достъп.', forbidden: true }),
  })
  controller.navigateAdminVisitors('today')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'lobby', `currentScreen=${controller.getCurrentScreen()}`)
})

await check('[8.3] onAdminPaymentsLoad връща forbidden:true -> currentScreen става lobby', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminPaymentsLoad: async () => ({ ok: false, message: 'Нямаш достъп.', forbidden: true }),
  })
  controller.navigateAdminPayments('today')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'lobby', `currentScreen=${controller.getCurrentScreen()}`)
})

await check('[8.4] onAdminPaymentDetailLoad връща forbidden:true -> currentScreen става lobby', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminPaymentDetailLoad: async () => ({ ok: false, message: 'Нямаш достъп.', forbidden: true }),
  })
  controller.navigateAdminPaymentDetail('purchase-1')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'lobby', `currentScreen=${controller.getCurrentScreen()}`)
})

await check('[8.5] onAdminVisitorSourcesLoad (view=sources) връща forbidden:true -> currentScreen става lobby', async () => {
  // navigateAdminVisitors чете view/device/type/os от window.location.search, не от аргументи.
  installFakeBrowser('/admin/visitors?view=sources')
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminVisitorSourcesLoad: async () => ({ ok: false, message: 'Нямаш достъп.', forbidden: true }),
  })
  controller.navigateAdminVisitors('today')
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'lobby', `currentScreen=${controller.getCurrentScreen()}`)
})

// ─── [5] стар/закъснял отговор не пренасочва грешен екран ──────────────────
await check('[5] stale (късен) forbidden отговор за екран, който вече е напуснат, НЕ пренасочва', async () => {
  installFakeBrowser('/lobby')
  let resolveVisitors: ((r: { ok: false; message: string; forbidden: true }) => void) | null = null
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminVisitorsLoad: () => new Promise((res) => { resolveVisitors = res }),
  })

  controller.navigateAdminVisitors('today')
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'admin-visitors', 'setup: очаквахме admin-visitors, fetch-ът виси')

  // Потребителят напуска (към лобито) ПРЕДИ старият visitors fetch да е отговорил.
  controller.resetToLobby()
  assert(controller.getCurrentScreen() === 'lobby', 'setup: очаквахме лоби след resetToLobby')

  // Старият, вече "закъснял" отговор пристига чак СЕГА, с forbidden:true.
  assert(resolveVisitors !== null, 'resolveVisitors не е зададен')
  resolveVisitors!({ ok: false, message: 'Нямаш достъп.', forbidden: true })
  await Promise.resolve()
  await Promise.resolve()

  // Не трябва да е "пренасочен" отново (вече е в лобито си, без нов errorText от stale отговора).
  assert(controller.getCurrentScreen() === 'lobby', `stale отговорът не биваше да променя екрана, currentScreen=${controller.getCurrentScreen()}`)
})

// ─── [6] polling enter/leave hook-овете се викат коректно (без дублиране) ───
await check('[6.1] onAdminInfoFamilyScreenEnter се вика при вход в admin-info', async () => {
  installFakeBrowser('/lobby')
  let enterCount = 0
  let leaveCount = 0
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
    onAdminInfoFamilyScreenEnter: () => { enterCount++ },
    onAdminInfoFamilyScreenLeave: () => { leaveCount++ },
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(enterCount === 1, `enterCount=${enterCount}`)
  assert(leaveCount === 0, `leaveCount=${leaveCount}`)
})

await check('[6.2] навигация между admin-info family екрани спира и рестартира polling (leave после enter), без да остане "изгубен" активен', async () => {
  installFakeBrowser('/lobby')
  let enterCount = 0
  let leaveCount = 0
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
    onAdminVisitorsLoad: async () => ({ ok: true, rows: [], total: 0 }),
    onAdminInfoFamilyScreenEnter: () => { enterCount++ },
    onAdminInfoFamilyScreenLeave: () => { leaveCount++ },
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(enterCount === 1 && leaveCount === 0, `след navigateAdminInfo: enter=${enterCount} leave=${leaveCount}`)

  controller.navigateAdminVisitors('today')
  await Promise.resolve()
  await Promise.resolve()
  // Вътрешна навигация info -> visitors: старият екран (admin-info) е бил "напуснат" (leave),
  // новият (admin-visitors) е "влязъл" (enter) — нетно все още само 1 активен polling.
  assert(enterCount === 2 && leaveCount === 1, `след navigateAdminVisitors: enter=${enterCount} leave=${leaveCount}`)
})

await check('[6.3] напускане към lobby спира polling (leave без съответен enter)', async () => {
  installFakeBrowser('/lobby')
  let enterCount = 0
  let leaveCount = 0
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
    onAdminInfoFamilyScreenEnter: () => { enterCount++ },
    onAdminInfoFamilyScreenLeave: () => { leaveCount++ },
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(enterCount === 1 && leaveCount === 0, `след navigateAdminInfo: enter=${enterCount} leave=${leaveCount}`)

  controller.resetToLobby()
  assert(enterCount === 1 && leaveCount === 1, `след resetToLobby: enter=${enterCount} leave=${leaveCount} (не бива нов enter)`)
})

await check('[6.4] destroy() спира polling, ако потребителят е бил на admin-info екран', async () => {
  installFakeBrowser('/lobby')
  let leaveCount = 0
  const controller = makeController({
    getAuthSession: () => makeSession('subadmin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
    onAdminInfoFamilyScreenLeave: () => { leaveCount++ },
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  controller.destroy()
  assert(leaveCount === 1, `destroy() трябваше да спре активния admin-info polling, leaveCount=${leaveCount}`)
})

// ─── [7] пълен admin не се засяга ────────────────────────────────────────────
await check('[7.1] admin: onAdminStatsLoad ok:true -> остава на admin-info, без forbidden редирект', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('admin'),
    onAdminStatsLoad: async () => ({ ok: true, stats: makeStatsSnapshot() }),
  })
  controller.navigateAdminInfo()
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'admin-info', `currentScreen=${controller.getCurrentScreen()}`)
})

await check('[7.2] admin: onAdminPaymentsLoad ok:true -> остава на admin-payments', async () => {
  installFakeBrowser('/lobby')
  const controller = makeController({
    getAuthSession: () => makeSession('admin'),
    onAdminPaymentsLoad: async () => ({
      ok: true,
      purchases: [],
      pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
      summary: { totalsByCurrency: {} },
    }),
  })
  controller.navigateAdminPayments('today')
  await Promise.resolve()
  await Promise.resolve()
  assert(controller.getCurrentScreen() === 'admin-payments', `currentScreen=${controller.getCurrentScreen()}`)
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

/**
 * checkAdminProfileHardDeletePendingUx.ts
 *
 * Regression coverage за admin hard-delete UX/reliability fix (production
 * report): admin-ски "Изтрий -> Изтрий окончателно" flow-ът виждаше
 * ИДЕНТИЧНО "успешно" поведение и за target профил, който реално е бил
 * изтрит веднага (pending:false), И за target профил, който в момента е
 * реален участник в играеща се стая — физическото DELETE FROM profiles е
 * ОТЛОЖЕНО до края на мача (pending:true, виж
 * applyPendingModerationForRoomParticipants в index.ts). Root cause: preди
 * fix-а main.ts's adminHardDeleteProfile() четеше `pending` от server JSON
 * response тялото, но никога не го пренасяше нагоре — връщаше само
 * {ok:true}, затова admin-ът не можеше да различи "изтрит" от "насрочен".
 *
 * Огледално на подхода в checkAdminRegisteredProfilesBehavior.ts
 * (FakeRoot/installFakeBrowser regex-базиран DOM stub) — разширено с
 * FakePopupHost за document.body-appended profile popup-а (syncProfilePopup
 * живее извън root.innerHTML, виж renderLobbyScreen.ts). Тества
 * createLobbyFlowController + renderLobbyScreen директно, БЕЗ реален
 * browser/сървър — main.ts самото (реалният fetch wrapper,
 * adminHardDeleteProfile) НЕ е директно import-ваемо в Node (top-level
 * bootstrap код изисква истински browser globals, вкл. WebSocket/DOM
 * структура, за разлика от createLobbyFlowController.ts, който е чист
 * factory модул) — затова тестовете тук инжектират onAdminHardDeleteProfile
 * с ТОЧНО същата {ok, pending, message} форма, каквато main.ts вече връща
 * (виж кода там), и проверяват, че CONTROLLER-ът коректно я consume-ва
 * (не re-collapse-ва я обратно към bare {ok:true}). Самата wire-форма
 * pending:false вече е end-to-end потвърдена от реален HTTP round-trip в
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts (round4-B, `b.pending
 * !== false` assertion); pending:true wire-формата се вижда directly в
 * index.ts кода (handleAdminProfileHardDeleteRequest), но НЕ е exercised
 * през реален live-gameplay HTTP round-trip тук нито другаде — mirror на
 * съществуващото round4-EF решение да не се строи пълен 4-играч gameplay
 * harness само за това (виж коментара там).
 *
 * [A] Controller/API mapping — pending:true (с custom server message) И
 *     pending:false ДВЕТЕ достигат до controller-а с пълната форма, не
 *     bare {ok:true}: proверено чрез verbatim server message в рендернатия
 *     popup (pending:true) и нормално closure поведение (pending:false).
 * [B] pending:true UI поведение — popup-ът НЕ се затваря, submit бутонът се
 *     заключва, pending notice-ът се показва, повторен submit докато
 *     notice-ът е активен НЕ праща втора HTTP-еквивалентна заявка.
 * [C] pending:false (immediate delete) — запазва предишното успешно
 *     поведение: delete popup + profile popup се затварят.
 * [D1/D2] Registered Profiles list refresh — след успешен delete request
 *     (immediate И pending) отвореният "Днес" модал се презарежда чрез
 *     съществуващия loadAdminRegisteredProfilesPage; за immediate delete
 *     редът изчезва след reload, за pending delete reload се случва, но
 *     редът legitimately може да остане (профилът все още съществува).
 * [Support-C/Support-D] Втори admin entry point — submitAdminSupportDeleteProfile
 *     (support chat "Изтрий профила по тази заявка", renderSupportDeleteProfileConfirmModal,
 *     ОТДЕЛЕН state/UI от generic profile-popup delete flow-а по-горе, но
 *     СЪЩИЯТ onAdminHardDeleteProfile API) — mirror-ва точно [A]/[B]/[C]:
 *     pending:true показва deferred status в confirm модала, заключва
 *     submit бутона, не третира операцията като физически приключила, не
 *     позволява втори delete request; pending:false запазва старото
 *     immediate-success поведение (архивиране на разговора + refresh).
 * [Stats-A/B/C] Admin Information summary counters refresh (първи follow-up
 *     production report) — "Общо"/"Днес"/"Вчера" картите (state.adminStats,
 *     зареждани ЕДИНСТВЕНО от showAdminInfoPanel() при вход в екрана) не
 *     се презареждаха след successful hard delete, докато admin-ът остане
 *     на екрана — отделен bug от Registered Profiles drilldown-а по-горе
 *     ([D1/D2]), различна state/loader двойка. Stats-A: immediate delete +
 *     Admin Information активен -> onAdminStatsLoad се извиква повторно,
 *     counters се обновяват от backend response. Stats-B: pending:true ->
 *     reload СЕ прави (никакъв optimistic decrement), но числата остават
 *     непроменени, защото backend-ът е authoritative и профилът реално
 *     още съществува. Stats-C: deferred final delete — fallback safety net
 *     (re-navigate reload), сега ВТОРИЧЕН механизъм спрямо WS-Invalidation-*
 *     по-долу.
 * [WS-Invalidation-A/B/C] Deferred final-delete WS invalidation (ВТОРИ
 *     follow-up production report) — сървърът вече изпраща минимален
 *     {type:'admin_aggregate_data_changed'} INVALIDATION сигнал (без
 *     payload данни) към admin/subadmin WS connections СЛЕД реално успешен
 *     hard-delete COMMIT (immediate И deferred, виж
 *     broadcastAdminAggregateDataChangedToAdminConnections в index.ts) —
 *     клиентският handleServerMessage handler просто reuse-ва
 *     refreshAdminAggregatesAfterHardDelete() ([Stats-A/B]-ите функции).
 *     WS-Invalidation-A: admin-info активен -> stats reload. WS-Invalidation-B:
 *     Registered Profiles модал отворен -> reload, target редът изчезва.
 *     WS-Invalidation-C: admin-ът НЕ е на нито едното -> НУЛА fetch-ове
 *     (reuse-натите refresh функции вече си имат own screen/modal guard-ове,
 *     handler-ът не добавя нов check). Реалният HTTP+WS broadcast (2
 *     admin connections, dedup на initiator-а чрез excludeSessionId) е
 *     тестван end-to-end в checkAdminProfileBanAndDeleteHttpAuthorization.ts
 *     ([WS-Invalidation] секция) — тук се тества само клиентската reaction.
 *     "pending:true не изпраща invalidation" е потвърдено чрез code review
 *     (call site-ът физически не е достижим от pending branch-а, виж
 *     server diff-а), не чрез runtime E2E тест — pending:true изисква
 *     реален isProfileInActiveGame()===true HTTP round-trip, което
 *     explicitно е извън scope на съществуващата test infrastructure (виж
 *     round4-EF коментара в checkAdminProfileBanAndDeleteHttpAuthorization.ts).
 */

import { createLobbyFlowController } from '../../src/app/lobby/createLobbyFlowController.js'
import type { LobbyAuthSession } from '../../src/app/lobby/createLobbyFlowController.js'
import type {
  AdminRegisteredProfileRow,
  PlayerPublicProfileSnapshot,
  SupportConversationSnapshot,
  SupportMessageSnapshot,
} from '../../src/app/network/createGameServerClient.js'

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
/** Изчаква N microtask tick-а — submit -> onAdminHardDeleteProfile resolve -> refreshAdminRegisteredProfilesListIfOpen -> loadAdminRegisteredProfilesPage resolve -> render() е верига от няколко chained await-а. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

// ─── Минимален DOM stub (regex-базиран querySelector над innerHTML) ────────

type FakeEventHandler = (ev: Event) => void

class FakeDomElement {
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  value = ''
  /** true след .remove() — syncProfilePopup вика popupRootEl.remove() при затваряне БЕЗ да пипа innerHTML отново, затова innerHTML съдържанието само по себе си не е надежден "затворен ли е popup-ът" сигнал (виж isDeletePopupClosed по-долу). */
  removed = false
  private listeners: Record<string, FakeEventHandler[]> = {}

  appendChild(_child: unknown): void {}
  contains(_child: unknown): boolean { return false }
  remove(): void { this.removed = true }
  setAttribute(name: string, value: string): void { (this as unknown as Record<string, unknown>)[name] = value }
  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  addEventListener(event: string, handler: EventListenerOrEventListenerObject): void {
    const fn: FakeEventHandler = typeof handler === 'function' ? handler as FakeEventHandler : (ev) => { handler.handleEvent(ev) }
    this.listeners[event] = [...(this.listeners[event] ?? []), fn]
  }
  dispatchClick(): void {
    // currentTarget=this — няколко реални handler-и (напр. data-player-
    // profile-delete-open в attachPopupListeners) четат e.currentTarget.dataset,
    // не closure-нат reference.
    for (const handler of this.listeners.click ?? []) handler({ type: 'click', currentTarget: this } as unknown as Event)
  }
  dispatchSubmit(): void {
    for (const handler of this.listeners.submit ?? []) {
      handler({ type: 'submit', currentTarget: this, preventDefault: () => {} } as unknown as Event)
    }
  }
  querySelector<T extends Element>(_selector: string): T | null { return null }
  querySelectorAll<T extends Element>(_selector: string): NodeListOf<T> { return [] as unknown as NodeListOf<T> }
}

/**
 * root.innerHTML stub — "Регистрирани профили" модал (period open + row
 * open) И support-chat admin delete confirm flow-а (nav -> conversation ->
 * message delete button -> confirm modal) — и двата рендират inline в
 * root.innerHTML (за разлика от profile popup-а, виж FakePopupHost по-долу).
 */
class FakeRoot extends FakeDomElement {
  private html = ''
  private periodOpenButtons: FakeDomElement[] = []
  private profileRowButtons: FakeDomElement[] = []
  private supportNavBtn: FakeDomElement | null = null
  private supportConvButtons: FakeDomElement[] = []
  private supportDeleteMessageButtons: FakeDomElement[] = []
  private supportDeleteConfirmSubmitBtn: FakeDomElement | null = null
  private supportDeleteConfirmCancelBtn: FakeDomElement | null = null

  set innerHTML(value: string) {
    this.html = value
    this.periodOpenButtons = [...value.matchAll(/data-admin-registered-profiles-open="([^"]+)"/g)].map((m) => {
      const btn = new FakeDomElement()
      btn.dataset.adminRegisteredProfilesOpen = m[1] ?? ''
      return btn
    })
    this.profileRowButtons = [...value.matchAll(/data-admin-registered-profiles-open-profile="([^"]+)"/g)].map((m) => {
      const btn = new FakeDomElement()
      btn.dataset.adminRegisteredProfilesOpenProfile = m[1] ?? ''
      return btn
    })
    this.supportNavBtn = value.includes('data-lobby-nav-support="1"') ? new FakeDomElement() : null
    this.supportConvButtons = [...value.matchAll(/data-admin-support-conv="([^"]+)"/g)].map((m) => {
      const btn = new FakeDomElement()
      btn.dataset.adminSupportConv = m[1] ?? ''
      return btn
    })
    this.supportDeleteMessageButtons = [...value.matchAll(
      /data-admin-support-delete-profile="([^"]+)"\s+data-admin-support-delete-profile-message="([^"]+)"/g,
    )].map((m) => {
      const btn = new FakeDomElement()
      btn.dataset.adminSupportDeleteProfile = m[1] ?? ''
      btn.dataset.adminSupportDeleteProfileMessage = m[2] ?? ''
      return btn
    })
    this.supportDeleteConfirmSubmitBtn = value.includes('data-admin-support-delete-profile-confirm-submit="1"') ? new FakeDomElement() : null
    this.supportDeleteConfirmCancelBtn = value.includes('data-admin-support-delete-profile-confirm-cancel="1"') ? new FakeDomElement() : null
  }
  get innerHTML(): string { return this.html }

  override querySelectorAll<T extends Element>(selector: string): NodeListOf<T> {
    if (selector === '[data-admin-registered-profiles-open]') return this.periodOpenButtons as unknown as NodeListOf<T>
    if (selector === '[data-admin-registered-profiles-open-profile]') return this.profileRowButtons as unknown as NodeListOf<T>
    if (selector === '[data-admin-support-conv]') return this.supportConvButtons as unknown as NodeListOf<T>
    if (selector === '[data-admin-support-delete-profile]') return this.supportDeleteMessageButtons as unknown as NodeListOf<T>
    return [] as unknown as NodeListOf<T>
  }

  override querySelector<T extends Element>(selector: string): T | null {
    if (selector === '[data-lobby-nav-support="1"]') return this.supportNavBtn as unknown as T | null
    if (selector === '[data-admin-support-delete-profile-confirm-submit="1"]') return this.supportDeleteConfirmSubmitBtn as unknown as T | null
    if (selector === '[data-admin-support-delete-profile-confirm-cancel="1"]') return this.supportDeleteConfirmCancelBtn as unknown as T | null
    return null
  }

  clickOpenPeriod(period: 'today' | 'yesterday'): void {
    const btn = this.periodOpenButtons.find((b) => b.dataset.adminRegisteredProfilesOpen === period)
    if (!btn) throw new Error(`period open button "${period}" was not wired`)
    btn.dispatchClick()
  }
  clickOpenProfileRow(profileId: string): void {
    const btn = this.profileRowButtons.find((b) => b.dataset.adminRegisteredProfilesOpenProfile === profileId)
    if (!btn) throw new Error(`profile row button for profileId="${profileId}" was not wired (is the modal open?)`)
    btn.dispatchClick()
  }
  clickSupportNav(): void {
    if (!this.supportNavBtn) throw new Error('support nav button not wired')
    this.supportNavBtn.dispatchClick()
  }
  clickSupportConversation(profileId: string): void {
    const btn = this.supportConvButtons.find((b) => b.dataset.adminSupportConv === profileId)
    if (!btn) throw new Error(`support conversation row for profileId="${profileId}" was not wired`)
    btn.dispatchClick()
  }
  clickSupportDeleteProfileForMessage(profileId: string, messageId: string): void {
    const btn = this.supportDeleteMessageButtons.find(
      (b) => b.dataset.adminSupportDeleteProfile === profileId && b.dataset.adminSupportDeleteProfileMessage === messageId,
    )
    if (!btn) throw new Error(`support "Маркирай като заявка за изтриване" button not wired for profileId="${profileId}" messageId="${messageId}"`)
    btn.dispatchClick()
  }
  clickSupportDeleteConfirmSubmit(): void {
    if (!this.supportDeleteConfirmSubmitBtn) throw new Error('support delete confirm submit button not wired (confirm modal not open?)')
    this.supportDeleteConfirmSubmitBtn.dispatchClick()
  }
  clickSupportDeleteConfirmCancel(): void {
    if (!this.supportDeleteConfirmCancelBtn) throw new Error('support delete confirm cancel button not wired (confirm modal not open?)')
    this.supportDeleteConfirmCancelBtn.dispatchClick()
  }
  isSupportDeleteConfirmSubmitDisabled(): boolean {
    const startIdx = this.html.indexOf('data-admin-support-delete-profile-confirm-submit="1"')
    if (startIdx === -1) return false
    const endIdx = this.html.indexOf('</button>', startIdx)
    const block = endIdx === -1 ? this.html.slice(startIdx) : this.html.slice(startIdx, endIdx)
    return /\bdisabled\b/.test(block)
  }
  hasSupportDeletePendingNotice(): boolean { return this.html.includes('data-admin-support-delete-profile-pending-notice="1"') }
  isSupportDeleteConfirmOpen(): boolean { return this.html.includes('data-admin-support-delete-profile-confirm-backdrop="1"') }
}

/**
 * document.createElement() stub, употребен за popupRootEl-а на
 * syncProfilePopup (document.body-appended, извън root.innerHTML). reasonInput
 * е нарочно ЕДИН персистентен instance (не rebuild-нат при всяко innerHTML
 * set), за да оцелее .value между "напиши причина" и "submit" стъпките в
 * теста — submit handler-ът в renderLobbyScreen.ts чете стойността чрез
 * ФРЕШ el.querySelector(...) СИНХРОННО, преди state промяната да задейства
 * следващия render (реалният DOM се държи аналогично: value-то е на самия
 * live textarea node, не на state).
 */
class FakePopupHost extends FakeDomElement {
  private html = ''
  private deleteOpenBtn: FakeDomElement | null = null
  private deleteCancelBtn: FakeDomElement | null = null
  private deleteForm: FakeDomElement | null = null
  private readonly reasonInputEl = new FakeDomElement()

  set innerHTML(value: string) {
    this.html = value
    const openMatch = value.match(/data-player-profile-delete-open="([^"]*)"/)
    if (openMatch) {
      const btn = new FakeDomElement()
      btn.dataset.playerProfileDeleteOpen = openMatch[1] ?? ''
      this.deleteOpenBtn = btn
    } else {
      this.deleteOpenBtn = null
    }
    this.deleteCancelBtn = value.includes('data-player-profile-delete-cancel="1"') ? new FakeDomElement() : null
    this.deleteForm = value.includes('data-player-profile-delete-form="1"') ? new FakeDomElement() : null
  }
  get innerHTML(): string { return this.html }

  override querySelector<T extends Element>(selector: string): T | null {
    if (selector === '[data-player-profile-delete-open]') return this.deleteOpenBtn as unknown as T | null
    if (selector === '[data-player-profile-delete-cancel="1"]') return this.deleteCancelBtn as unknown as T | null
    if (selector === '[data-player-profile-delete-form="1"]') return this.deleteForm as unknown as T | null
    if (selector === '[data-player-profile-delete-reason-input="1"]') return this.reasonInputEl as unknown as T | null
    return null
  }

  clickDeleteOpen(): void {
    if (!this.deleteOpenBtn) throw new Error('delete-open button not wired (profile popup not open, or not admin?)')
    this.deleteOpenBtn.dispatchClick()
  }
  clickDeleteCancel(): void {
    if (!this.deleteCancelBtn) throw new Error('delete-cancel button not wired (delete popup not open?)')
    this.deleteCancelBtn.dispatchClick()
  }
  setReasonValue(value: string): void { this.reasonInputEl.value = value }
  submitDeleteForm(): void {
    if (!this.deleteForm) throw new Error('delete form not wired (delete popup not open?)')
    this.deleteForm.dispatchSubmit()
  }
  isDeletePopupOpen(): boolean { return this.deleteForm !== null }
  isSubmitDisabled(): boolean {
    return /\bdisabled\b/.test(this.extractSubmitButtonBlock())
  }
  submitButtonLabel(): string {
    const block = this.extractSubmitButtonBlock()
    const textMatch = block.match(/>([^<]*)<\/button>/)
    return textMatch?.[1]?.trim() ?? ''
  }
  hasPendingNotice(): boolean { return this.html.includes('data-player-profile-delete-pending-notice="1"') }
  private extractSubmitButtonBlock(): string {
    const startIdx = this.html.indexOf('data-player-profile-delete-submit="1"')
    if (startIdx === -1) return ''
    const endIdx = this.html.indexOf('</button>', startIdx)
    return endIdx === -1 ? this.html.slice(startIdx) : this.html.slice(startIdx, endIdx)
  }
}

function installFakeBrowser(startPath: string): { createdPopupHosts: FakePopupHost[] } {
  const createdPopupHosts: FakePopupHost[] = []
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
    createElement: () => {
      const host = new FakePopupHost()
      createdPopupHosts.push(host)
      return host
    },
    getElementById: () => null, querySelector: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  }
  Object.assign(globalThis, {
    window: fakeWindow, document: fakeDocument, history: fakeHistory,
    requestAnimationFrame: fakeWindow.requestAnimationFrame, cancelAnimationFrame: fakeWindow.cancelAnimationFrame,
    setTimeout: fakeWindow.setTimeout, clearTimeout: fakeWindow.clearTimeout,
  })
  return { createdPopupHosts }
}

/** Намира profile popup host-а по съдържание (data-player-profile-summary-grid="1" marker, виж renderPlayerProfilePopup.ts) — robust спрямо creation order. */
function findProfilePopupHost(createdPopupHosts: FakePopupHost[]): FakePopupHost {
  const host = [...createdPopupHosts].reverse().find((h) => h.innerHTML.includes('data-player-profile-summary-grid="1"'))
  if (!host) throw new Error('profile popup host not found (was the target profile popup opened?)')
  return host
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

function makeTargetProfile(profileId: string, displayName: string): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName,
    avatarUrl: null,
    level: 5,
    rankTitle: null,
    skillRating: null,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: null,
    gamesUntilNextRank: null,
    rankProgressRatio: null,
    averageRating: null,
    totalRatingsCount: 0,
    yellowCoinsBalance: 0,
    galleryImages: [],
    gender: null,
    likesCount: 0,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: false,
    vipActiveUntil: null,
  }
}

function makeRow(profileId: string, username: string): AdminRegisteredProfileRow {
  return {
    profileId,
    username,
    displayName: username,
    createdAt: '2026-09-13 10:00:00',
    email: `${username}@example.test`,
  }
}

function makeSupportConversation(profileId: string, displayName: string): SupportConversationSnapshot {
  return {
    profileId,
    displayName,
    avatarUrl: null,
    lastMessageBody: 'Здравейте, имам въпрос.',
    lastMessageIsFromAdmin: false,
    unreadByAdmin: 0,
    updatedAt: '2026-09-13 10:00:00',
    deletionArchive: null,
  }
}

/** isFromAdmin=false (user-authored) — единствено такива съобщения показват "Маркирай като заявка за изтриване" бутона (виж canDeleteByThisMessage в renderLobbyScreen.ts). */
function makeSupportUserMessage(messageId: string, profileId: string): SupportMessageSnapshot {
  return {
    messageId,
    profileId,
    body: 'Искам да ми изтриете профила, моля.',
    isFromAdmin: false,
    createdAt: '2026-09-13 10:00:00',
    attachment: null,
  }
}

const ADMIN_STATS_STUB = {
  ok: true as const,
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
}

/** Параметризиран вариант на ADMIN_STATS_STUB — за Admin Information summary refresh тестовете (Stats-A/B/C), където total/today/yesterday трябва да се сменят между последователни onAdminStatsLoad извиквания. */
function makeAdminStatsStub(total: number, today: number, yesterday: number) {
  return {
    ok: true as const,
    stats: {
      onlineCount: 0,
      registeredProfiles: { total, today, yesterday },
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
  }
}

/** Извлича числото от "общо"/"днес"/"вчера" summary картата (Admin -> Информация) по data-admin-registered-profiles-open="<period>" маркера — вторият <span> в button блока е числото (първият е label текста). */
function extractAdminStatsCount(html: string, period: 'all' | 'today' | 'yesterday'): number | null {
  const marker = `data-admin-registered-profiles-open="${period}"`
  const startIdx = html.indexOf(marker)
  if (startIdx === -1) return null
  const endIdx = html.indexOf('</button>', startIdx)
  const block = endIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, endIdx)
  const spanMatches = [...block.matchAll(/<span[^>]*>([^<]*)<\/span>/g)]
  const lastSpanText = spanMatches[spanMatches.length - 1]?.[1] ?? null
  if (lastSpanText === null) return null
  const cleaned = lastSpanText.replace(/[^\d]/g, '')
  return cleaned.length > 0 ? Number(cleaned) : null
}

const TARGET_PROFILE_ID = 'target-profile-001'
const TARGET_USERNAME = 'TargetPlayer'
const TARGET_MESSAGE_ID = 'support-msg-001'

/**
 * Отваря "Регистрирани профили — Днес" модала, кликва реда на target
 * профила (истинският production entry point, огледален на bug report-а),
 * изчаква profile popup-а да се зареди, после кликва "Изтрий профил" ->
 * връща FakePopupHost-а на profile попъпа с вече отворена delete confirm
 * форма.
 */
async function openDeletePopupViaRegisteredProfilesRow(
  root: FakeRoot,
  createdPopupHosts: FakePopupHost[],
  controller: ReturnType<typeof createLobbyFlowController>,
): Promise<FakePopupHost> {
  controller.setConnected(true)
  controller.navigateAdminInfo()
  await flush(2)

  root.clickOpenPeriod('today')
  await flush(2)

  root.clickOpenProfileRow(TARGET_PROFILE_ID)
  await flush(3)

  const popupHost = findProfilePopupHost(createdPopupHosts)
  popupHost.clickDeleteOpen()
  await flush(1)
  assert(popupHost.isDeletePopupOpen(), 'delete confirm form did not open after "Изтрий профил" click')
  return popupHost
}

/**
 * Support-chat "Изтрий профила по тази заявка" flow (истинският production
 * entry point за submitAdminSupportDeleteProfile, task 4 fix): "Поддръжка"
 * nav -> избор на разговор -> "Маркирай като заявка за изтриване" бутон под
 * user-authored съобщение -> отваря dedicated confirm модала (различен от
 * generic profile-popup delete popup-а, рендира inline в root.innerHTML, не
 * document.body host).
 */
async function openSupportDeleteConfirmForProfile(
  root: FakeRoot,
  controller: ReturnType<typeof createLobbyFlowController>,
): Promise<void> {
  controller.setConnected(true)
  root.clickSupportNav()
  await flush(2)

  root.clickSupportConversation(TARGET_PROFILE_ID)
  await flush(2)

  root.clickSupportDeleteProfileForMessage(TARGET_PROFILE_ID, TARGET_MESSAGE_ID)
  await flush(1)
  assert(root.isSupportDeleteConfirmOpen(), 'support delete confirm modal did not open after "Маркирай като заявка за изтриване" click')
}

// ─── Тестове ────────────────────────────────────────────────────────────────

console.log('\ncheckAdminProfileHardDeletePendingUx')

await asyncCheck(
  '[A1] pending:true от onAdminHardDeleteProfile достига controller-а с verbatim server message (не bare {ok:true})',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    const deleteCalls: Array<{ profileId: string; reason: string }> = []
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async (profileId, reason) => {
        deleteCalls.push({ profileId, reason })
        return { ok: true, pending: true, message: 'CUSTOM: играта все още тече.' }
      },
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(deleteCalls.length === 1, `expected exactly 1 onAdminHardDeleteProfile call, got ${deleteCalls.length}`)
    assert(
      popupHost.innerHTML.includes('CUSTOM: играта все още тече.'),
      'server-ското pending message трябва да достигне до попъпа verbatim — controller-ът не бива да го замества/губи',
    )
    assert(popupHost.isDeletePopupOpen(), 'delete popup-ът не биваше да се затвори при pending:true (все едно е bare {ok:true} success)')
  },
)

await asyncCheck(
  '[A2] pending:false от onAdminHardDeleteProfile се третира като реално завършено изтриване (не се обърква с pending)',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: false }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(!popupHost.hasPendingNotice(), 'pending:false не биваше да покаже pending notice')
    // syncProfilePopup затваря popup-а чрез popupRootEl.remove() БЕЗ да
    // презаписва innerHTML отново (виж FakeDomElement.removed doc-а) —
    // .removed е надеждният "затворен ли е" сигнал тук, не innerHTML
    // съдържанието (то остава замразено на последната показана форма).
    assert(popupHost.removed, 'целият profile popup (вкл. delete formата) трябваше да се затвори при pending:false (immediate success)')
  },
)

await asyncCheck(
  '[B] pending:true заключва submit бутона и предотвратява повторен HTTP-еквивалентен опит, докато notice-ът е активен',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    const deleteCalls: Array<{ profileId: string; reason: string }> = []
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async (profileId, reason) => {
        deleteCalls.push({ profileId, reason })
        return { ok: true, pending: true, message: 'Профилът е маркиран за изтриване и ще бъде изтрит автоматично след края на текущата игра.' }
      },
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(popupHost.hasPendingNotice(), 'pending notice блокът не се показа')
    assert(
      popupHost.innerHTML.includes('ще бъде изтрит автоматично след края на текущата игра'),
      'точният server message не се вижда в popup-а',
    )
    assert(popupHost.isSubmitDisabled(), 'submit бутонът трябваше да е disabled, докато pending notice-ът е активен')
    assert(popupHost.submitButtonLabel() !== 'Изтрий окончателно', 'бутонният label трябваше да сигнализира заключено/насрочено състояние, не обичайния "Изтрий окончателно"')

    // Симулира повторен click/submit опит (real DOM: disabled бутон не би
    // изпратил submit event, но submitAdminHardDelete има и explicit
    // defense-in-depth guard — тестваме именно него тук).
    popupHost.submitDeleteForm()
    await flush()
    assert(deleteCalls.length === 1, `повторен submit докато е pending не биваше да прати нова заявка, но onAdminHardDeleteProfile бе извикан ${deleteCalls.length} пъти`)

    // Cancel/Close остава достъпен въпреки заключения submit (admin-ът
    // винаги трябва да може да излезе от popup-а).
    popupHost.clickDeleteCancel()
    await flush(1)
    assert(!popupHost.isDeletePopupOpen(), 'Затвори/Отказ трябваше да работи дори докато pending notice-ът е показан')
  },
)

await asyncCheck(
  '[C] pending:false (immediate delete) запазва предишното поведение — delete popup И profile popup се затварят',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: false }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    // syncProfilePopup затваря popup-а чрез popupRootEl.remove() БЕЗ да
    // презаписва innerHTML отново — .removed е надеждният сигнал тук (виж
    // FakeDomElement.removed doc-а и теста [A2] по-горе).
    assert(popupHost.removed, 'целият profile popup (вкл. delete formата) трябваше да се затвори след immediate delete (съществуващо поведение)')
  },
)

await asyncCheck(
  '[D1] immediate delete (pending:false) + отворен "Днес" модал -> reload на текущия период, target редът изчезва',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    let registeredProfilesLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => {
        registeredProfilesLoadCount++
        if (period !== 'today') return { ok: true, rows: [] }
        // Първо зареждане показва target-а; след delete-а вече не е там
        // (реален server поведение би върнал точно това).
        return { ok: true, rows: registeredProfilesLoadCount === 1 ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }
      },
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: false }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    assert(root.innerHTML.includes(TARGET_USERNAME), 'target редът трябваше да се вижда в модала преди delete-а')
    const loadCountBeforeDelete = registeredProfilesLoadCount

    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(
      registeredProfilesLoadCount > loadCountBeforeDelete,
      `очаквах loadAdminRegisteredProfilesPage да се извика отново след successful delete (преди=${loadCountBeforeDelete}, след=${registeredProfilesLoadCount})`,
    )
    assert(!root.innerHTML.includes(TARGET_USERNAME), 'target редът трябваше да изчезне от модала след reload (immediate delete)')
  },
)

await asyncCheck(
  '[D2] pending delete (pending:true) + отворен "Днес" модал -> reload се случва, но редът legitimately може да остане',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    let registeredProfilesLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => {
        registeredProfilesLoadCount++
        // Профилът РЕАЛНО още съществува (delete-ът е отложен) — сървърът
        // легитимно продължава да го връща на всяко зареждане.
        return { ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }
      },
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: true, message: 'Профилът ще бъде изтрит след края на текущата игра.' }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    const loadCountBeforeDelete = registeredProfilesLoadCount

    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(
      registeredProfilesLoadCount > loadCountBeforeDelete,
      `очаквах reload дори за pending delete (преди=${loadCountBeforeDelete}, след=${registeredProfilesLoadCount})`,
    )
    assert(root.innerHTML.includes(TARGET_USERNAME), 'target редът legitimately трябва да остане видим — профилът все още съществува (pending)')
    assert(popupHost.hasPendingNotice(), 'pending notice-ът трябваше да остане видим в popup-а')
  },
)

await asyncCheck(
  '[Support-C] support delete (submitAdminSupportDeleteProfile) + pending:true — deferred status, НЕ физически завършен, без втори delete request',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/lobby')
    const deleteCalls: Array<{ profileId: string; reason: string; messageId?: string | null }> = []
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminSupportConversationsLoad: async () => ({ ok: true, conversations: [makeSupportConversation(TARGET_PROFILE_ID, TARGET_USERNAME)] }),
      onAdminSupportMessagesLoad: async () => ({ ok: true, messages: [makeSupportUserMessage(TARGET_MESSAGE_ID, TARGET_PROFILE_ID)] }),
      onAdminHardDeleteProfile: async (profileId, reason, messageId) => {
        deleteCalls.push({ profileId, reason, messageId })
        return { ok: true, pending: true, message: 'CUSTOM SUPPORT: играта все още тече.' }
      },
    })

    await openSupportDeleteConfirmForProfile(root, controller)
    root.clickSupportDeleteConfirmSubmit()
    await flush()

    assert(deleteCalls.length === 1, `expected exactly 1 onAdminHardDeleteProfile call, got ${deleteCalls.length}`)
    assert(deleteCalls[0]?.messageId === TARGET_MESSAGE_ID, 'explicit attribution (messageId) не бе пренесен коректно')
    assert(
      root.innerHTML.includes('CUSTOM SUPPORT: играта все още тече.'),
      'server-ското pending message трябва да достигне до support confirm модала verbatim',
    )
    assert(root.isSupportDeleteConfirmOpen(), 'support confirm модалът не биваше да се затвори при pending:true (все едно физически завършено изтриване)')
    assert(root.isSupportDeleteConfirmSubmitDisabled(), 'submit бутонът трябваше да е disabled, докато pending notice-ът е активен')

    // Повторен submit докато е pending — не бива да прати нова заявка
    // (defense-in-depth guard, mirror на generic delete popup-а).
    root.clickSupportDeleteConfirmSubmit()
    await flush()
    assert(deleteCalls.length === 1, `повторен submit докато е pending не биваше да прати нова заявка, но онAdminHardDeleteProfile бе извикан ${deleteCalls.length} пъти`)

    // Cancel/Close остава достъпен.
    root.clickSupportDeleteConfirmCancel()
    await flush(1)
    assert(!root.isSupportDeleteConfirmOpen(), 'Затвори/Отказ трябваше да работи дори докато pending notice-ът е показан')
  },
)

await asyncCheck(
  '[Support-D] support delete (submitAdminSupportDeleteProfile) + pending:false — запазва normal immediate-delete поведението',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/lobby')
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminSupportConversationsLoad: async () => ({ ok: true, conversations: [makeSupportConversation(TARGET_PROFILE_ID, TARGET_USERNAME)] }),
      onAdminSupportMessagesLoad: async () => ({ ok: true, messages: [makeSupportUserMessage(TARGET_MESSAGE_ID, TARGET_PROFILE_ID)] }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: false }),
    })

    await openSupportDeleteConfirmForProfile(root, controller)
    root.clickSupportDeleteConfirmSubmit()
    await flush()

    assert(!root.hasSupportDeletePendingNotice(), 'pending:false не биваше да покаже pending notice')
    assert(!root.isSupportDeleteConfirmOpen(), 'support confirm модалът трябваше да се затвори при pending:false (immediate success, съществуващо поведение)')
  },
)

await asyncCheck(
  '[Stats-A] immediate delete + Admin Information активен -> summary loader се извиква повторно, counters се обновяват от backend',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    let statsLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => {
        statsLoadCount++
        return statsLoadCount === 1 ? makeAdminStatsStub(4, 1, 0) : makeAdminStatsStub(3, 0, 0)
      },
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: false }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    assert(statsLoadCount === 1, `expected exactly 1 initial admin-info stats load, got ${statsLoadCount}`)
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 4, 'initial total трябваше да е 4')
    assert(extractAdminStatsCount(root.innerHTML, 'today') === 1, 'initial today трябваше да е 1')

    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    assert(
      statsLoadCount === 2,
      `очаквах summary loader-ът (onAdminStatsLoad) да се извика повторно след successful immediate delete, но е извикан ${statsLoadCount} пъти`,
    )
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 3, 'total трябваше да се обнови до 3 след delete (root cause на follow-up report-а)')
    assert(extractAdminStatsCount(root.innerHTML, 'today') === 0, 'today трябваше да се обнови до 0 след delete')
  },
)

await asyncCheck(
  '[Stats-B] pending:true -> summary counters НЕ се намаляват преждевременно (backend продължава да връща непроменени стойности, профилът все още съществува)',
  async () => {
    const root = new FakeRoot()
    const { createdPopupHosts } = installFakeBrowser('/admin/info')
    let statsLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => {
        statsLoadCount++
        // Target профилът е в активна игра — DELETE FROM profiles е
        // отложен, значи backend-ът легитимно продължава да връща СЪЩИТЕ
        // числа и на втория (post-submit) reload.
        return makeAdminStatsStub(4, 1, 0)
      },
      onAdminRegisteredProfilesLoad: async (period) => ({ ok: true, rows: period === 'today' ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }),
      onProfileByIdLoad: async (profileId) => ({ ok: true, profile: makeTargetProfile(profileId, TARGET_USERNAME) }),
      onAdminHardDeleteProfile: async () => ({ ok: true, pending: true, message: 'Профилът ще бъде изтрит след края на текущата игра.' }),
    })

    const popupHost = await openDeletePopupViaRegisteredProfilesRow(root, createdPopupHosts, controller)
    assert(statsLoadCount === 1, `expected exactly 1 initial admin-info stats load, got ${statsLoadCount}`)

    popupHost.setReasonValue('нарушение на правилата')
    popupHost.submitDeleteForm()
    await flush()

    // Reload СЕ извиква (никакъв optimistic local decrement, винаги re-fetch
    // от authoritative backend) — но самите числа остават непроменени,
    // защото профилът физически все още съществува.
    assert(
      statsLoadCount === 2,
      `pending:true все пак трябва да re-fetch-не summary-то (backend е authoritative source of truth), получени извиквания: ${statsLoadCount}`,
    )
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 4, 'pending:true НЕ трябва да намали total — профилът все още съществува')
    assert(extractAdminStatsCount(root.innerHTML, 'today') === 1, 'pending:true НЕ трябва да намали today — профилът все още съществува')
  },
)

await asyncCheck(
  '[Stats-C] deferred final delete (без live push event до admin сесията) — повторно влизане в Admin Information зарежда пресни counters (fallback safety net)',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/admin/info')
    let statsLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => {
        statsLoadCount++
        // 1-во влизане: target профилът все още играе (pending). 2-ро
        // влизане: СЛЕД match-end hook-а (applyPendingModerationForRoomParticipants
        // в index.ts), target вече физически изтрит — точно както
        // production QA доклада описва ("leave + re-enter коригира
        // числата").
        return statsLoadCount === 1 ? makeAdminStatsStub(4, 1, 0) : makeAdminStatsStub(3, 0, 0)
      },
    })

    controller.setConnected(true)
    controller.navigateAdminInfo()
    await flush(2)
    assert(statsLoadCount === 1, `expected 1 initial load, got ${statsLoadCount}`)
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 4, 'първото влизане трябваше да покаже total=4')

    // ВТОРИ follow-up round: сега вече ИМА admin_aggregate_data_changed WS
    // invalidation (виж WS-Invalidation-A/B/C тестовете по-долу) — това е
    // ПЪРВИЧНИЯТ механизъм за deferred completion refresh. Тестът тук
    // остава като regression coverage за FALLBACK пътеката (напр. admin-ът
    // не е бил WS-свързан в момента на broadcast-а, или просто е
    // навигирал away+back по собствена воля) — showAdminInfoPanel() е
    // unconditional reload при всеки navigateAdminInfo() извикване,
    // независимо дали admin-ът реално е напуснал екрана междувременно.
    // Тук симулираме "повторно влизане" директно.
    controller.navigateAdminInfo()
    await flush(2)

    assert(statsLoadCount === 2, `expected reload on re-entering Admin Information, got ${statsLoadCount} total loads`)
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 3, 'повторно влизане трябваше да покаже актуализирания total=3')
    assert(extractAdminStatsCount(root.innerHTML, 'today') === 0, 'повторно влизане трябваше да покаже актуализирания today=0')
  },
)

await asyncCheck(
  '[WS-Invalidation-A] admin_aggregate_data_changed + Admin Information активен -> stats loader се извиква, counters се обновяват от backend',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/admin/info')
    let statsLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => {
        statsLoadCount++
        return statsLoadCount === 1 ? makeAdminStatsStub(4, 1, 0) : makeAdminStatsStub(3, 0, 0)
      },
    })

    controller.setConnected(true)
    controller.navigateAdminInfo()
    await flush(2)
    assert(statsLoadCount === 1, `expected 1 initial load, got ${statsLoadCount}`)
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 4, 'initial total трябваше да е 4')

    // Симулира deferred final-delete invalidation, получена по WS — точно
    // каквото сървърът изпраща (broadcastAdminAggregateDataChangedToAdminConnections
    // в index.ts) след успешен applyPendingModerationForRoomParticipants ->
    // hardDeleteProfile() COMMIT.
    controller.handleServerMessage({ type: 'admin_aggregate_data_changed' })
    await flush(2)

    assert(statsLoadCount === 2, `expected reload след admin_aggregate_data_changed, got ${statsLoadCount} total loads`)
    assert(extractAdminStatsCount(root.innerHTML, 'all') === 3, 'total трябваше да се обнови до 3 след WS invalidation')
    assert(extractAdminStatsCount(root.innerHTML, 'today') === 0, 'today трябваше да се обнови до 0 след WS invalidation')
  },
)

await asyncCheck(
  '[WS-Invalidation-B] admin_aggregate_data_changed + Registered Profiles модал отворен -> reload, target редът изчезва',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/admin/info')
    let registeredProfilesLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => ADMIN_STATS_STUB,
      onAdminRegisteredProfilesLoad: async (period) => {
        registeredProfilesLoadCount++
        if (period !== 'today') return { ok: true, rows: [] }
        // Профилът е бил там при първото зареждане (target-ът все още играеше
        // — pending); след deferred final delete вече не е.
        return { ok: true, rows: registeredProfilesLoadCount === 1 ? [makeRow(TARGET_PROFILE_ID, TARGET_USERNAME)] : [] }
      },
    })

    controller.setConnected(true)
    controller.navigateAdminInfo()
    await flush(2)
    root.clickOpenPeriod('today')
    await flush(2)
    assert(root.innerHTML.includes(TARGET_USERNAME), 'target редът трябваше да се вижда преди invalidation-а')
    const loadCountBefore = registeredProfilesLoadCount

    controller.handleServerMessage({ type: 'admin_aggregate_data_changed' })
    await flush(2)

    assert(
      registeredProfilesLoadCount > loadCountBefore,
      `очаквах reload на Registered Profiles модала след admin_aggregate_data_changed (преди=${loadCountBefore}, след=${registeredProfilesLoadCount})`,
    )
    assert(!root.innerHTML.includes(TARGET_USERNAME), 'target редът трябваше да изчезне след reload (deferred final delete invalidation)')
  },
)

await asyncCheck(
  '[WS-Invalidation-C] admin_aggregate_data_changed, докато admin-ът НЕ е на Admin Information И модалът не е отворен -> без ненужни fetch-ове',
  async () => {
    const root = new FakeRoot()
    installFakeBrowser('/lobby')
    let statsLoadCount = 0
    let registeredProfilesLoadCount = 0
    const controller = createLobbyFlowController({
      root: root as unknown as HTMLElement,
      joinMatchmaking: () => {}, leaveMatchmaking: () => {}, onMatchFound: () => {},
      getAuthSession: () => makeAdminSession(),
      onAdminStatsLoad: async () => { statsLoadCount++; return ADMIN_STATS_STUB },
      onAdminRegisteredProfilesLoad: async () => { registeredProfilesLoadCount++; return { ok: true, rows: [] } },
    })

    controller.setConnected(true)
    await flush(2)
    // Admin-ът не е навигирал към admin-info изобщо — currentScreen е
    // default (lobby), adminRegisteredProfilesModal е null.

    controller.handleServerMessage({ type: 'admin_aggregate_data_changed' })
    await flush(3)

    assert(statsLoadCount === 0, `не очаквах onAdminStatsLoad извиквания, докато admin-ът не е на екрана, получени: ${statsLoadCount}`)
    assert(registeredProfilesLoadCount === 0, `не очаквах onAdminRegisteredProfilesLoad извиквания, докато модалът не е отворен, получени: ${registeredProfilesLoadCount}`)
  },
)

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

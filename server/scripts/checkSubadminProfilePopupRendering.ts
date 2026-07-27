/**
 * checkSubadminProfilePopupRendering.ts
 *
 * Реални (не текстови/grep) тестове на UI логиката за субадмин бадж/бутони —
 * извиква директно чистите render функции (без DOM) и проверява върнатия
 * HTML низ, огледално на подхода в checkCoinPackagesTopOfferBadge.ts.
 *
 * Покрива:
 *  [11] Само пълен admin вижда статуса "Субадмин" в чужд профил.
 *  [12] Обикновен потребител/субадмин viewer никога не вижда бадж/бутони —
 *       тества се дори на ниво САМАТА render функция (defense-in-depth:
 *       дори ако извикващият код погрешно подаде targetAccountRole,
 *       viewerIsFullAdmin:false трябва да скрие всичко).
 *  [13] Точния текст на confirm попъпа при "Направи субадмин".
 *  [14] Точния текст на confirm попъпа при "Премахни субадмин" + success toast-ове.
 */

import {
  renderPlayerProfilePopup,
  type RenderPlayerProfilePopupOptions,
} from '../../src/ui/overlays/renderPlayerProfilePopup.js'
import {
  renderSubadminActionConfirmPopup,
  renderSubadminActionToast,
  renderAdminPanel,
  renderAdminInfoPanel,
  renderAdminServerPanel,
  type LobbyScreenState,
} from '../../src/app/lobby/renderLobbyScreen.js'
import type { PlayerPublicProfileSnapshot } from '../../src/app/network/createGameServerClient.js'

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
function check(label: string, fn: () => void): void {
  try {
    fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function makeProfile(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'target-profile-1',
    displayName: 'Тестов Играч',
    avatarUrl: null,
    level: 5,
    rankTitle: 'Ранг 5',
    skillRating: 1200,
    completedGamesCount: 10,
    wonGamesCount: 5,
    currentRankGames: 0,
    nextRankGames: 20,
    gamesUntilNextRank: 10,
    rankProgressRatio: 0.5,
    averageRating: 4.2,
    totalRatingsCount: 3,
    yellowCoinsBalance: 1000,
    galleryImages: [],
    gender: null,
    likesCount: 0,
    hasLikedByMe: false,
    isBlockedByMe: false,
    ...overrides,
  }
}

function renderPopup(overrides: Partial<RenderPlayerProfilePopupOptions> = {}): string {
  return renderPlayerProfilePopup({
    isOpen: true,
    seat: 'bottom',
    profile: makeProfile(),
    isOwnProfile: false,
    ...overrides,
  })
}

console.log('\ncheckSubadminProfilePopupRendering')

// ─── [11] Пълен admin вижда бадж "Субадмин" при target role = subadmin ─────
check('[11.1] viewerIsFullAdmin=true, targetAccountRole=subadmin => показва бадж "Субадмин"', () => {
  const html = renderPopup({ viewerIsFullAdmin: true, targetAccountRole: 'subadmin' })
  assert(html.includes('data-player-profile-subadmin-badge="1"'), 'липсва subadmin badge markup')
  assert(html.includes('Субадмин'), 'липсва текст "Субадмин"')
  assert(html.includes('data-player-profile-revoke-subadmin="1"'), 'липсва бутон "Премахни субадмин"')
  assert(html.includes('Премахни субадмин'), 'липсва текст "Премахни субадмин"')
})

check('[11.2] viewerIsFullAdmin=true, targetAccountRole=player => показва бутон "Направи субадмин", БЕЗ бадж', () => {
  const html = renderPopup({ viewerIsFullAdmin: true, targetAccountRole: 'player' })
  assert(html.includes('data-player-profile-grant-subadmin="1"'), 'липсва бутон "Направи субадмин"')
  assert(html.includes('Направи субадмин'), 'липсва текст "Направи субадмин"')
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'НЕ трябва да има subadmin badge за player роля')
  assert(!html.includes('data-player-profile-revoke-subadmin="1"'), 'НЕ трябва да има revoke бутон за player роля')
})

check('[11.3] viewerIsFullAdmin=true, targetAccountRole=admin (друг пълен admin) => НИЩО не се показва', () => {
  const html = renderPopup({ viewerIsFullAdmin: true, targetAccountRole: 'admin' })
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'не трябва бадж за друг admin')
  assert(!html.includes('data-player-profile-grant-subadmin="1"'), 'не трябва grant бутон за друг admin')
  assert(!html.includes('data-player-profile-revoke-subadmin="1"'), 'не трябва revoke бутон за друг admin')
})

check('[11.4] viewerIsFullAdmin=true, targetAccountRole=null (все още не е заредена/няма акаунт) => НИЩО не се показва', () => {
  const html = renderPopup({ viewerIsFullAdmin: true, targetAccountRole: null })
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'не трябва бадж докато role е null')
  assert(!html.includes('data-player-profile-grant-subadmin="1"'), 'не трябва grant бутон докато role е null')
  assert(!html.includes('data-player-profile-revoke-subadmin="1"'), 'не трябва revoke бутон докато role е null')
})

check('[11.5] собствен профил (isOwnProfile=true) — никога бадж/бутони, дори за пълен admin viewer', () => {
  const html = renderPopup({ isOwnProfile: true, viewerIsFullAdmin: true, targetAccountRole: 'subadmin' })
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'не трябва бадж за собствен профил')
  assert(!html.includes('data-player-profile-grant-subadmin="1"'), 'не трябва grant бутон за собствен профил')
  assert(!html.includes('data-player-profile-revoke-subadmin="1"'), 'не трябва revoke бутон за собствен профил')
})

// ─── [12] Обикновен потребител / субадмин viewer никога не вижда статуса ───
check('[12.1] viewerIsFullAdmin=false (обикновен потребител), дори ако targetAccountRole=subadmin => НИЩО', () => {
  const html = renderPopup({ viewerIsFullAdmin: false, targetAccountRole: 'subadmin' })
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'обикновен потребител не бива да вижда subadmin badge')
  assert(!html.includes('Субадмин'), 'обикновен потребител не бива да вижда текст "Субадмин"')
  assert(!html.includes('data-player-profile-revoke-subadmin="1"'), 'обикновен потребител не бива да вижда revoke бутон')
})

check('[12.2] viewerIsFullAdmin=false (subadmin viewer), targetAccountRole=subadmin => НИЩО (defense-in-depth)', () => {
  // Backend никога не би пратил targetAccountRole на subadmin viewer (403 на GET role
  // endpoint), но проверяваме, че дори renderPlayerProfilePopup самостоятелно защитава,
  // ако някой някога погрешно го извика с грешни данни.
  const html = renderPopup({ viewerIsFullAdmin: false, targetAccountRole: 'subadmin' })
  assert(!html.includes('Субадмин'), 'render функцията сама трябва да скрие статуса, ако viewerIsFullAdmin=false')
})

check('[12.3] опции без viewerIsFullAdmin/targetAccountRole изобщо (undefined, стар caller) => НИЩО, без грешка', () => {
  const html = renderPopup({})
  assert(!html.includes('data-player-profile-subadmin-badge="1"'), 'по подразбиране не трябва бадж')
  assert(!html.includes('data-player-profile-grant-subadmin="1"'), 'по подразбиране не трябва grant бутон')
})

// ─── [13]/[14] Confirm попъп — точен текст по спецификация ─────────────────
function makeConfirmState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    subadminActionConfirm: null,
    subadminActionBusy: false,
    subadminActionToast: null,
    ...overrides,
  } as unknown as LobbyScreenState
}

check('[13.1] Grant confirm popup — заглавие "Направи субадмин?"', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'grant' },
  }))
  assert(html.includes('Направи субадмин?'), 'липсва заглавие "Направи субадмин?"')
})

check('[13.2] Grant confirm popup — точен текст на съобщението', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'grant' },
  }))
  assert(
    html.includes('Потребителят ще получи достъп само за преглед до секциите „Информация“ и „Сървър“. Няма да може да редактира профили, да чете чата с поддръжката или да променя настройки.'),
    'текстът на grant confirm попъпа не съвпада точно със спецификацията',
  )
})

check('[13.3] Grant confirm popup — бутони "Отказ" и "Направи субадмин"', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'grant' },
  }))
  assert(html.includes('data-subadmin-action-cancel="1"') && html.includes('>Отказ<'), 'липсва бутон "Отказ"')
  assert(html.includes('data-subadmin-action-confirm="1"') && html.includes('Направи субадмин'), 'липсва бутон "Направи субадмин"')
})

check('[14.1] Revoke confirm popup — заглавие "Премахни субадмин?"', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'revoke' },
  }))
  assert(html.includes('Премахни субадмин?'), 'липсва заглавие "Премахни субадмин?"')
})

check('[14.2] Revoke confirm popup — точен текст на съобщението', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'revoke' },
  }))
  assert(
    html.includes('Потребителят ще загуби достъпа до административните секции „Информация“ и „Сървър“.'),
    'текстът на revoke confirm попъпа не съвпада точно със спецификацията',
  )
})

check('[14.3] Revoke confirm popup — бутони "Отказ" и "Премахни"', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'revoke' },
  }))
  assert(html.includes('data-subadmin-action-cancel="1"') && html.includes('>Отказ<'), 'липсва бутон "Отказ"')
  assert(html.includes('data-subadmin-action-confirm="1"') && html.includes('>Премахни<'), 'липсва бутон "Премахни"')
})

check('[14.4] busy=true — бутоните са disabled (не се задейства повторно при клик по време на заявка)', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({
    subadminActionConfirm: { profileId: 'p1', displayName: 'Иван', action: 'grant' },
    subadminActionBusy: true,
  }))
  const confirmBtnMatch = /data-subadmin-action-confirm="1"[^>]*disabled/.exec(html)
  const cancelBtnMatch = /data-subadmin-action-cancel="1"[^>]*disabled/.exec(html)
  assert(confirmBtnMatch !== null, 'confirm бутонът трябва да е disabled докато е busy')
  assert(cancelBtnMatch !== null, 'cancel бутонът трябва да е disabled докато е busy')
})

check('[confirm] няма отворен confirm (subadminActionConfirm=null) => празен низ', () => {
  const html = renderSubadminActionConfirmPopup(makeConfirmState({ subadminActionConfirm: null }))
  assert(html === '', 'трябва да върне празен низ, когато няма pending action')
})

check('[toast.grant] съобщение за успех при назначаване: "Потребителят вече е субадмин."', () => {
  const html = renderSubadminActionToast(makeConfirmState({
    subadminActionToast: { text: 'Потребителят вече е субадмин.', ok: true },
  }))
  assert(html.includes('Потребителят вече е субадмин.'), 'липсва точния success текст при grant')
})

check('[toast.revoke] съобщение за успех при премахване: "Ролята субадмин е премахната."', () => {
  const html = renderSubadminActionToast(makeConfirmState({
    subadminActionToast: { text: 'Ролята субадмин е премахната.', ok: true },
  }))
  assert(html.includes('Ролята субадмин е премахната.'), 'липсва точния success текст при revoke')
})

check('[toast] няма toast (null) => празен низ', () => {
  const html = renderSubadminActionToast(makeConfirmState({ subadminActionToast: null }))
  assert(html === '', 'трябва да върне празен низ, когато няма toast')
})

// ─── [4] Content-level defense-in-depth: "Настройки" директен URL/screen bypass ──
// state.currentScreen може да се зададе директно от URL routing (LOBBY_PATH_TO_SCREEN)
// БЕЗ да мине през showAdminPanel()'s guard. renderAdminPanel() е последната линия
// на защита — проверява state.isAdmin (пълен admin) независимо как view е станал 'admin'.
function makeScreenState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    isAdmin: false,
    isAdminOrSubadmin: false,
    adminSettingsLoading: false,
    adminSettings: null,
    signupBonusYellowCoins: 0,
    adminCoinPackages: [],
    adminStatsLoading: false,
    adminStatsErrorText: null,
    adminStats: null,
    adminMonitoringSnapshot: null,
    adminMonitoringErrorText: null,
    adminHistoryWindow: '1h',
    adminHistoryResult: null,
    adminHistoryLoading: false,
    adminHistoryErrorText: null,
    adminWsConnections: null,
    ...overrides,
  } as unknown as LobbyScreenState
}

check('[4.1] renderAdminPanel(isAdmin:false) — subadmin директен URL bypass към "Настройки" => "Нямаш достъп"', () => {
  const html = renderAdminPanel(makeScreenState({ isAdmin: false, isAdminOrSubadmin: true }))
  assert(html.includes('Нямаш достъп'), 'subadmin (isAdmin:false) не трябва да вижда съдържанието на "Настройки"')
  assert(!html.includes('adminSettings'), 'не трябва изобщо да прониква реално съдържание')
})

// renderAdminPanel() изисква пълен набор state полета отвъд самия access gate
// (coin packages editor state, mission editor state, daily rewards, match
// rooms и т.н.). Пълна fixture, за да могат [4.2]/[4.3] РЕАЛНО да достигнат
// success path-а, вместо да минат през exception, който преди се поглъщаше
// мълчаливо (виж M2 finding от code review-то).
function makeFullAdminSettingsState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return makeScreenState({
    adminActiveDailyRewardTiers: [],
    adminStagedDailyRewardTiers: [],
    adminDailyRewardsLoading: false,
    adminDailyRewardsErrorText: null,
    adminDailyRewardAddLoading: false,
    adminDailyRewardAddErrorText: null,
    adminCoinPackages: [],
    adminCoinPackagesLoading: false,
    adminCoinPackagesErrorText: null,
    adminCoinPackageEditId: null,
    adminActiveMissions: [],
    adminStagedMissions: [],
    adminMissionsLoading: false,
    adminMissionsErrorText: null,
    adminMissionEditId: null,
    adminMissionEditIsStaged: false,
    matchRooms: [],
    matchRoomsLoading: false,
    matchRoomsErrorText: null,
    adminMatchRoomEdit: null,
    signupBonusYellowCoins: 0,
    adminSettings: null,
    adminSettingsLoading: false,
    adminSettingsErrorText: null,
    ...overrides,
  } as Partial<LobbyScreenState>)
}

check('[4.2] renderAdminPanel(isAdmin:false) — не хвърля exception, дори с пълна fixture (доказва, че [4.3] по-долу тества истинския gate, не случаен throw)', () => {
  // Контролна проверка: пълната fixture е валидна и за isAdmin:false — с други
  // думи, ако [4.3] premine gate-а, ТОВА е защото isAdmin:true действително го
  // отваря, а не защото fixture-ът случайно кара функцията да хвърли за false.
  const html = renderAdminPanel(makeFullAdminSettingsState({ isAdmin: false, isAdminOrSubadmin: true }))
  assert(html.includes('Нямаш достъп'), 'isAdmin:false трябва да продължи да блокира дори с пълна fixture')
})

check('[4.3] renderAdminPanel(isAdmin:true) — РЕАЛНО минава gate-а и рендерира истинско съдържание на "Настройки" (не поглъща exception)', () => {
  // Без try/catch — ако fixture-ът е непълен и функцията хвърли, тестът ще се
  // провали истински (fail), вместо да отчете фалшив PASS (виж M2 находката).
  const html = renderAdminPanel(makeFullAdminSettingsState({ isAdmin: true, isAdminOrSubadmin: true }))
  assert(!html.includes('Нямаш достъп'), 'admin=true не трябва да получи блокиращото съобщение')
  assert(html.includes('data-lobby-admin-settings-form="1"'), 'липсва формата за настройки — доказателство за реален success рендер')
  assert(html.includes('Настройки за икономика и профили.'), 'липсва реалният текст на "Настройки" екрана')
})

// ─── [3] Content-level: "Информация"/"Сървър" позволени за subadmin ────────────
check('[3.1] renderAdminInfoPanel(isAdminOrSubadmin:true, isAdmin:false) — subadmin вижда съдържание', () => {
  const html = renderAdminInfoPanel(makeScreenState({ isAdmin: false, isAdminOrSubadmin: true, adminStats: null, adminStatsLoading: false, adminStatsErrorText: null }))
  assert(!html.includes('Нямаш достъп'), 'subadmin трябва да има достъп до "Информация" съдържанието')
})

check('[3.2] renderAdminInfoPanel(isAdminOrSubadmin:false) — обикновен player блокиран', () => {
  const html = renderAdminInfoPanel(makeScreenState({ isAdmin: false, isAdminOrSubadmin: false }))
  assert(html.includes('Нямаш достъп'), 'обикновен player не трябва да вижда "Информация" съдържанието')
})

check('[3.3] renderAdminServerPanel(isAdminOrSubadmin:true, isAdmin:false) — subadmin вижда съдържание', () => {
  const html = renderAdminServerPanel(makeScreenState({ isAdmin: false, isAdminOrSubadmin: true }))
  assert(!html.includes('Нямаш достъп'), 'subadmin трябва да има достъп до "Сървър" съдържанието')
})

check('[3.4] renderAdminServerPanel(isAdminOrSubadmin:false) — обикновен player блокиран', () => {
  const html = renderAdminServerPanel(makeScreenState({ isAdmin: false, isAdminOrSubadmin: false }))
  assert(html.includes('Нямаш достъп'), 'обикновен player не трябва да вижда "Сървър" съдържанието')
})

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

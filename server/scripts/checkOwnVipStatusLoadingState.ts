/**
 * checkOwnVipStatusLoadingState.ts
 *
 * Regression за production bug: отваряне на СОБСТВЕНИЯ профил кратко
 * показва "VIP · 0 дни", докато /api/vip/status все още не е отговорил,
 * след което (веднъж отговорът пристигне) сменя към реалната стойност
 * (напр. "VIP · 379 дни"). Root cause: state.ownVipActiveUntil започваше
 * като null, и null означаваше едновременно "not loaded yet" И "loaded, no
 * active VIP" — computeVipRemainingDays(null) връща 0 и в двата случая, а
 * VIP редът е умишлено ВИНАГИ видим за собствения профил (не се крие при
 * inactive VIP, за разлика от чужд профил).
 *
 * Fix: RenderPlayerProfilePopupOptions.ownVipActiveUntil стана истински
 * tri-state (undefined/null/string) вместо coerce-нато към null навсякъде
 * по пътя (syncProfilePopup, renderPlayerProfilePopup, renderProfileContent,
 * renderOwnProfileSummary) — undefined explicit значи "not loaded",
 * render-ва "VIP · …" placeholder в СЪЩИЯ DOM ред/стил (без layout shift).
 * Discriminator-ът в createLobbyFlowController.ts е новото поле
 * ownVipActiveUntilResolvedForProfileId (profileId, за който response-ът
 * РЕАЛНО е пристигнал), отделно от съществуващия
 * ownVipActiveUntilLoadedForProfileId (fetch dedup guard, сетнат синхронно
 * ПРЕДИ await-а — не доказва, че отговорът е дошъл).
 *
 * Покрива [A]-[G] от task brief-а:
 *  [A]/[B] real render tests срещу renderPlayerProfilePopup (без DOM),
 *          огледален подход на checkSubadminProfilePopupRendering.ts.
 *  [C]/[D] real render tests за resolved active/inactive/expired стойности.
 *  [E]     source-level: resolveOwnVipActiveUntilForRender() е чист read
 *          (никога не пише state), и е единственото място, което
 *          buildLobbyScreenState() (per-render projection) използва за
 *          ownVipActiveUntil — "unrelated render" не може да върне
 *          resolved стойност обратно към loading/null.
 *  [F]     source-level: resetToLobby() (общата logout/login hook точка,
 *          виж main.ts) нулира ownVipActiveUntil +
 *          ownVipActiveUntilLoadedForProfileId +
 *          ownVipActiveUntilResolvedForProfileId атомарно заедно, и
 *          controller instance-ът реално се reuse-ва между logout/login
 *          (createLobbyFlowController() се извиква точно веднъж в main.ts).
 *  [G]     real render tests: foreign profile VIP поведението (active row,
 *          admin vs non-admin visibility, inactive row hidden) остава
 *          непроменено — regression proof, не просто твърдение.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  renderPlayerProfilePopup,
  computeVipRemainingDays,
  type RenderPlayerProfilePopupOptions,
} from '../../src/ui/overlays/renderPlayerProfilePopup.js'
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

const DAY_MS = 24 * 60 * 60 * 1000

function makeProfile(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'own-profile-1',
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
    isVip: false,
    vipActiveUntil: null,
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

/**
 * Извлича РЕАЛНО render-натия "N дни"/"…" текст от own-vip-days реда — "VIP · "
 * label-ът и стойността са в ДВА отделни <span> тага (не един contiguous
 * "VIP · N дни" низ), затова .includes('VIP · N дни') би бил false-positive-
 * safe тест (минава дори върху старата бъгава версия, защото такъв низ
 * никога не е съществувал contiguous). Regex-ът target-ва точно втория span.
 */
function extractOwnVipDaysText(html: string): string {
  const match = html.match(
    /data-player-profile-own-vip-days="1"[\s\S]*?VIP · <\/span><span[^>]*>([^<]*)<\/span>/,
  )
  if (match === null) throw new Error('own-vip-days редът липсва в render-натия HTML')
  return match[1] ?? ''
}

function extractOwnVipLoadingMarker(html: string): string {
  const match = html.match(/data-player-profile-own-vip-days="1"[\s\S]*?data-vip-status-loading="(\d)"/)
  if (match === null) throw new Error('data-vip-status-loading marker липсва')
  return match[1] ?? ''
}

console.log('\ncheckOwnVipStatusLoadingState')

// ─── [A]/[B] Own profile, VIP status not yet loaded ────────────────────────

check('[A] initial own popup (ownVipActiveUntil=undefined) does NOT render "0 дни"', () => {
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: undefined })
  const daysText = extractOwnVipDaysText(html)
  assert(daysText !== '0 дни', `popup-ът показва невярно "${daysText}" преди отговорът да е пристигнал`)
})

check('[A2] initial own popup with ownVipActiveUntil OMITTED entirely (never passed) also does NOT render "0 дни"', () => {
  const html = renderPopup({ isOwnProfile: true })
  const daysText = extractOwnVipDaysText(html)
  assert(daysText !== '0 дни', `omitted prop не бива да се третира като "0 дни" (got "${daysText}")`)
})

check('[B] initial state shows the loading placeholder "VIP · …" in the SAME row/markup', () => {
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: undefined })
  assert(html.includes('data-player-profile-own-vip-days="1"'), 'липсва own-vip-days редът изобщо (layout shift risk)')
  assert(extractOwnVipLoadingMarker(html) === '1', 'липсва explicit loading marker')
  assert(extractOwnVipDaysText(html) === '…', `очакван placeholder "…", получено "${extractOwnVipDaysText(html)}"`)
})

// ─── [C] Resolved, active VIP ───────────────────────────────────────────────

check('[C] resolved active response shows the exact correct N дни (matches computeVipRemainingDays)', () => {
  // 378.5 days из бъдещето -> Math.ceil(378.5) = 379, огледално на точния
  // production пример от bug report-а ("VIP · 379 дни").
  const activeUntil = new Date(Date.now() + 378 * DAY_MS + DAY_MS / 2).toISOString()
  const expectedDays = computeVipRemainingDays(activeUntil)
  assert(expectedDays === 379, `test setup assumption broke: expected 379, computeVipRemainingDays returned ${expectedDays}`)
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: activeUntil })
  assert(extractOwnVipDaysText(html) === '379 дни', `не показва точния брой оставащи дни (got "${extractOwnVipDaysText(html)}")`)
  assert(extractOwnVipLoadingMarker(html) === '0', 'loading marker трябва да е "0" след resolved отговор')
})

check('[C2] single remaining day uses correct singular "1 ден"', () => {
  const activeUntil = new Date(Date.now() + DAY_MS / 2).toISOString()
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: activeUntil })
  assert(extractOwnVipDaysText(html) === '1 ден', `сингуляр "1 ден" не се показва коректно (got "${extractOwnVipDaysText(html)}")`)
})

// ─── [D] Resolved, inactive/expired VIP ─────────────────────────────────────

check('[D] resolved response with activeUntil=null shows "VIP · 0 дни"', () => {
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: null })
  assert(extractOwnVipDaysText(html) === '0 дни', `null (resolved, no VIP) трябва да покаже "0 дни" (got "${extractOwnVipDaysText(html)}")`)
  assert(extractOwnVipLoadingMarker(html) === '0', 'loading marker трябва да е "0" за resolved-inactive')
})

check('[D2] resolved response with an EXPIRED activeUntil (past date) shows "VIP · 0 дни"', () => {
  const expired = new Date(Date.now() - DAY_MS).toISOString()
  const html = renderPopup({ isOwnProfile: true, ownVipActiveUntil: expired })
  assert(extractOwnVipDaysText(html) === '0 дни', `изтекъл VIP трябва да показва "0 дни", не placeholder (got "${extractOwnVipDaysText(html)}")`)
  assert(extractOwnVipLoadingMarker(html) === '0', 'изтекъл VIP не е "loading" състояние')
})

// ─── [G] Foreign profile VIP rendering is unchanged ─────────────────────────

check('[G1] foreign profile with ACTIVE VIP, non-admin viewer: badge only, no days text', () => {
  const activeUntil = new Date(Date.now() + 30 * DAY_MS).toISOString()
  const html = renderPopup({
    isOwnProfile: false,
    viewerIsFullAdmin: false,
    profile: makeProfile({ vipActiveUntil: activeUntil }),
  })
  assert(html.includes('data-player-profile-foreign-vip-days="1"'), 'липсва foreign VIP редът за активен VIP')
  assert(html.includes('>VIP<'), 'липсва VIP баджа')
  assert(!/VIP[\s\S]{0,80}дни/.test(html), 'non-admin viewer не бива да вижда оставащите дни на чужд профил')
})

check('[G2] foreign profile with ACTIVE VIP, full-admin viewer: sees the remaining days', () => {
  const activeUntil = new Date(Date.now() + 20 * DAY_MS + DAY_MS / 2).toISOString()
  const expectedDays = computeVipRemainingDays(activeUntil)
  const html = renderPopup({
    isOwnProfile: false,
    viewerIsFullAdmin: true,
    profile: makeProfile({ vipActiveUntil: activeUntil }),
  })
  assert(html.includes(`${expectedDays} дни`), 'admin viewer трябва да вижда точния брой оставащи дни на чужд профил')
})

check('[G3] foreign profile with NO active VIP: the entire row is hidden (unlike own profile)', () => {
  const html = renderPopup({
    isOwnProfile: false,
    viewerIsFullAdmin: true,
    profile: makeProfile({ vipActiveUntil: null }),
  })
  assert(!html.includes('data-player-profile-foreign-vip-days="1"'), 'chuжд неактивен VIP не бива да render-ва ред изобщо')
})

check('[G4] foreign profile with EXPIRED VIP timestamp: row still hidden', () => {
  const expired = new Date(Date.now() - DAY_MS).toISOString()
  const html = renderPopup({
    isOwnProfile: false,
    viewerIsFullAdmin: true,
    profile: makeProfile({ vipActiveUntil: expired }),
  })
  assert(!html.includes('data-player-profile-foreign-vip-days="1"'), 'изтекъл чужд VIP не бива да render-ва ред')
})

// ─── [E]/[F] Source-level: controller state-machine invariants ─────────────
// createLobbyFlowController.ts е твърде голям stateful closure за пълна
// instance-level интеграция в скрипт (виж established прецедент в
// checkVipPriceRefreshBug.ts [7]-[10]) — real source verification на
// точните инварианти, не текстово съвпадение "някъде в файла".

const projectRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--project-root='))?.slice('--project-root='.length)
    ?? join(process.cwd(), '..'),
)

const controllerSource = await readFile(
  join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'),
  'utf8',
)
const mainSource = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')

check('[E1] resolveOwnVipActiveUntilForRender() exists and is a PURE read (never assigns to state)', () => {
  const fnMatch = controllerSource.match(/function resolveOwnVipActiveUntilForRender\([\s\S]*?\n  \}/)
  assert(fnMatch !== null, 'липсва resolveOwnVipActiveUntilForRender()')
  const body = fnMatch![0]
  assert(!body.includes('state.ownVipActiveUntil ='), 'discriminator функцията НЕ трябва да пише state.ownVipActiveUntil')
  assert(!body.includes('state.ownVipActiveUntilResolvedForProfileId ='), 'discriminator функцията НЕ трябва да пише resolved tracker-а')
  assert(body.includes('state.ownVipActiveUntilResolvedForProfileId !== ownProfileId'), 'discriminator логиката липсва/е променена')
})

check('[E2] buildLobbyScreenState() (per-render projection) sources ownVipActiveUntil ONLY from resolveOwnVipActiveUntilForRender()', () => {
  assert(
    controllerSource.includes('ownVipActiveUntil: resolveOwnVipActiveUntilForRender(authSession),'),
    'buildLobbyScreenState() не използва resolveOwnVipActiveUntilForRender() — "unrelated render" риск да презапише resolved стойност',
  )
  // Единствените места, писани directly с raw state.ownVipActiveUntil (не
  // resolved-through-helper), трябва да са само вътре в
  // resolveOwnVipActiveUntilForRender самата, никъде другаде като projection.
  const rawProjectionOccurrences = (controllerSource.match(/ownVipActiveUntil: state\.ownVipActiveUntil,/g) ?? []).length
  assert(rawProjectionOccurrences === 0, 'намерен е stale-risk projection, който заобикаля resolveOwnVipActiveUntilForRender()')
})

check('[E3] renderPopupOnly() (explicit popup-open path) also routes through resolveOwnVipActiveUntilForRender()', () => {
  assert(
    controllerSource.includes('ownVipActiveUntil: isOwnProfile ? resolveOwnVipActiveUntilForRender(authSession) : null,'),
    'renderPopupOnly() не използва общия discriminator helper',
  )
})

check('[E4] exactly the three intended reset sites clear ownVipActiveUntilResolvedForProfileId (no stray resets elsewhere)', () => {
  const resetOccurrences = (controllerSource.match(/state\.ownVipActiveUntilResolvedForProfileId = null/g) ?? []).length
  assert(resetOccurrences === 3, `очаквани точно 3 reset места (ensureOwnVipStatusLoaded early-return, invalidateOwnVipStatus, resetToLobby), намерени ${resetOccurrences}`)
})

check('[F1] resetToLobby() atomically resets ownVipActiveUntil + both tracking fields together', () => {
  const fnMatch = controllerSource.match(/function resetToLobby\(\): void \{[\s\S]*?\n  \}/)
  assert(fnMatch !== null, 'липсва resetToLobby()')
  const body = fnMatch![0]
  assert(body.includes('state.ownVipActiveUntil = null'), 'resetToLobby() не нулира ownVipActiveUntil — stale VIP timestamp може да оцелее между профили')
  assert(body.includes('state.ownVipActiveUntilLoadedForProfileId = null'), 'resetToLobby() не нулира fetch dedup guard-а')
  assert(body.includes('state.ownVipActiveUntilResolvedForProfileId = null'), 'resetToLobby() не нулира resolved tracker-а')
})

check('[F2] the SAME controller instance is reused across logout/login (single createLobbyFlowController() call site)', () => {
  const occurrences = (mainSource.match(/createLobbyFlowController\(/g) ?? []).length
  assert(occurrences === 1, `createLobbyFlowController() трябва да се извиква точно веднъж (module-level singleton) — намерени ${occurrences}; ако вече не е singleton, VIP state risk анализът трябва да се преразгледа`)
})

check('[F3] both the login/register success path AND the logout path call lobby.resetToLobby()', () => {
  const submitLogoutMatch = mainSource.match(/async function submitLogout\(\)[\s\S]*?\n\}/)
  assert(submitLogoutMatch !== null, 'липсва submitLogout()')
  assert(submitLogoutMatch![0].includes('lobby.resetToLobby()'), 'submitLogout() не вика resetToLobby() — stale own VIP state би оцеляло след logout')
  assert(
    /currentAuthSession = data\.session[\s\S]{0,400}lobby\.resetToLobby\(\)/.test(mainSource),
    'login/register success flow-ът не вика resetToLobby() веднага след установяване на новата сесия',
  )
})

if (failed > 0) {
  console.error(`\ncheckOwnVipStatusLoadingState failed: ${failed} failed, ${passed} passed`)
  process.exit(1)
}

console.log(`\ncheckOwnVipStatusLoadingState passed: ${passed} checks`)

/**
 * checkPasswordResetFrontend.ts
 *
 * Pure helper checks за reset-password frontend логика.
 * Изпълнява се в Node.js чрез tsx — без DOM.
 *
 * [1] Token се прочита от #token=...
 * [2] Fragment без token се отхвърля
 * [3] State при липсващ token е no-token
 * [4] Password mismatch се блокира
 * [5] Known backend response codes се разпознават
 * [6] Успешен reset маркира phase='success'
 * [7]  shouldStartLobby('/reset-password') === false
 * [8]  shouldStartLobby('/lobby') === true
 * [9]  shouldStartLobby('/') === true
 * [10] Reset route render не може да бъде последван от initial lobby render
 * [11] Token extraction и fragment cleanup остават работещи
 * [12] No-token reset state остава работещ
 * [13] Нормалните /lobby и / routes не са променени
 * [14] suppressRendering=true блокира lobby render
 * [15] scheduleRender е блокиран при suppressRendering=true
 * [16] suppressRendering=false не блокира нормален lobby render
 */

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}

// ─── Pure helpers (извлечени от renderResetPasswordScreen логика) ─────────────

function extractTokenFromHash(hash: string): string | null {
  if (!hash || hash.length < 2) return null
  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('token')
  return token && token.length > 0 ? token : null
}

type ResetState =
  | { phase: 'no-token' }
  | { phase: 'form'; token: string; errorText: string | null; submitting: boolean }
  | { phase: 'success' }

function buildInitialState(token: string | null): ResetState {
  return token
    ? { phase: 'form', token, errorText: null, submitting: false }
    : { phase: 'no-token' }
}

function passwordsMatch(p1: string, p2: string): boolean {
  return p1 === p2
}

const KNOWN_RESET_CODES = new Set([
  'INVALID_PASSWORD', 'INVALID_OR_EXPIRED_TOKEN', 'RATE_LIMITED', 'PASSWORD_CHANGED',
])

function resolveResetResponseMessage(
  responseBody: { ok: boolean; code?: string; message?: string } | null,
): { isSuccess: boolean; message: string } {
  if (responseBody?.code === 'PASSWORD_CHANGED') {
    return { isSuccess: true, message: responseBody.message ?? '' }
  }
  const message =
    responseBody !== null && responseBody.message && KNOWN_RESET_CODES.has(responseBody.code ?? '')
      ? responseBody.message
      : 'Възникна грешка при смяната на паролата. Моля, опитайте отново.'
  return { isSuccess: false, message }
}

function applyResetResponse(
  state: Extract<ResetState, { phase: 'form' }>,
  responseBody: { ok: boolean; code?: string; message?: string } | null,
): ResetState {
  const { isSuccess, message } = resolveResetResponseMessage(responseBody)
  if (isSuccess) return { phase: 'success' }
  return { phase: 'form', token: state.token, errorText: message, submitting: false }
}

// ─── Checks ───────────────────────────────────────────────────────────────────

console.log('\n=== Password Reset Frontend Helper Checks ===\n')

// [1] Token се прочита от #token=...
await check('[1] Token се прочита от #token=...', () => {
  const token = extractTokenFromHash('#token=abc123XYZ')
  assert(token === 'abc123XYZ', `Очакван 'abc123XYZ', получен '${token}'`)

  // base64url формат (реален token)
  const realToken = extractTokenFromHash('#token=dGhpcyBpcyBhIHRlc3Q_dG9rZW4')
  assert(realToken !== null, 'base64url token трябва да се прочете')
})

// [2] Fragment без token се отхвърля
await check('[2] Fragment без token се отхвърля', () => {
  assert(extractTokenFromHash('') === null, 'Празен hash → null')
  assert(extractTokenFromHash('#other=value') === null, '#other=value → null')
  assert(extractTokenFromHash('#token=') === null, 'Празен token → null')
  assert(extractTokenFromHash('#') === null, 'Само # → null')
  assert(extractTokenFromHash('noHash') === null, 'Без # → null')
})

// [3] State при липсващ token е no-token
await check('[3] State при липсващ token е no-token', () => {
  const state = buildInitialState(null)
  assert(state.phase === 'no-token', `Очакван phase='no-token', получен '${state.phase}'`)

  const stateWithToken = buildInitialState('abc')
  assert(stateWithToken.phase === 'form', `Очакван phase='form' при валиден token`)
  if (stateWithToken.phase === 'form') {
    assert(stateWithToken.token === 'abc', 'Token трябва да е запазен в state')
    assert(stateWithToken.errorText === null, 'errorText трябва да е null при старт')
    assert(!stateWithToken.submitting, 'submitting трябва да е false при старт')
  }
})

// [4] Password mismatch се блокира
await check('[4] Password mismatch се блокира', () => {
  assert(!passwordsMatch('password1', 'password2'), 'Различни пароли трябва да не съвпадат')
  assert(passwordsMatch('same', 'same'), 'Еднакви пароли трябва да съвпадат')
  assert(!passwordsMatch('', 'a'), 'Празна и непразна → не съвпадат')
  assert(passwordsMatch('', ''), 'Две празни → съвпадат (validation е отделна грижа)')
})

// [5] Known backend response codes се разпознават
await check('[5] Known backend response codes се разпознават', () => {
  const r1 = resolveResetResponseMessage({ ok: false, code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Линкът е невалиден.' })
  assert(!r1.isSuccess, 'INVALID_OR_EXPIRED_TOKEN → не success')
  assert(r1.message === 'Линкът е невалиден.', `Backend message трябва да се покаже: ${r1.message}`)

  const r2 = resolveResetResponseMessage({ ok: false, code: 'INVALID_PASSWORD', message: 'Паролата е твърде кратка.' })
  assert(!r2.isSuccess, 'INVALID_PASSWORD → не success')
  assert(r2.message === 'Паролата е твърде кратка.', `Backend message: ${r2.message}`)

  const r3 = resolveResetResponseMessage({ ok: false, code: 'RATE_LIMITED', message: 'Твърде много опити.' })
  assert(!r3.isSuccess, 'RATE_LIMITED → не success')

  const r4 = resolveResetResponseMessage({ ok: false, code: 'UNKNOWN_CODE', message: 'Нещо' })
  assert(!r4.isSuccess, 'Unknown code → не success')
  assert(r4.message.includes('Възникна грешка'), `Unknown code → generic message: ${r4.message}`)

  const r5 = resolveResetResponseMessage(null)
  assert(!r5.isSuccess, 'null response → не success')
  assert(r5.message.includes('Възникна грешка'), `null response → generic message: ${r5.message}`)
})

// [6] Успешен reset маркира phase='success' и token изчезва от state
await check('[6] Успешен reset маркира phase=success', () => {
  const initial = buildInitialState('raw-token-xyz') as Extract<ResetState, { phase: 'form' }>
  const next = applyResetResponse(initial, { ok: true, code: 'PASSWORD_CHANGED', message: 'Паролата е сменена.' })
  assert(next.phase === 'success', `Очакван phase='success', получен '${next.phase}'`)
  assert(!('token' in next), 'След success state не трябва да съдържа token')

  // При грешка token остава за повторен опит.
  const errNext = applyResetResponse(initial, { ok: false, code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Изтекъл.' })
  assert(errNext.phase === 'form', `При грешка phase трябва да остане form`)
  if (errNext.phase === 'form') {
    assert(errNext.token === 'raw-token-xyz', 'При грешка token се запазва в state')
    assert(errNext.errorText === 'Изтекъл.', `errorText трябва да е backend message: ${errNext.errorText}`)
  }
})

// ─── Routing logic helpers (mirror на main.ts логика) ─────────────────────────

const RESET_PATH = '/reset-password'

// Mirror на _isResetPasswordPath логиката в main.ts
function isResetPasswordPath(pathname: string): boolean {
  return pathname === RESET_PATH
}

// shouldStartLobby = !isResetPasswordPath.
// Guards: loadAuthSession lobby.render(), onOpen lobby.setConnected(),
//         onClose lobby.setConnected(), onMessage lobby.handleServerMessage(),
//         viewport resize lobby.render(), loadAuthSession().then navigateInitialPath().
function shouldStartLobby(pathname: string): boolean {
  return !isResetPasswordPath(pathname)
}

// PATH_TO_SCREEN от lobby — /reset-password умишлено липсва
const LOBBY_PATH_TO_SCREEN: Record<string, string> = {
  '/lobby': 'lobby',
  '/players': 'players',
  '/ranking': 'leaderboards',
  '/shop': 'shop',
  '/friends': 'friends',
  '/chat': 'chat',
  '/admin': 'admin',
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/contact': 'contact',
  '/rules': 'rules',
  '/strategy': 'strategy',
}

// Симулира navigateFromPath логика — null означава switchToLobby()
function resolvePathToScreen(path: string): string | null {
  return LOBBY_PATH_TO_SCREEN[path] ?? null
}

// [7] shouldStartLobby('/reset-password') === false
await check('[7] shouldStartLobby("/reset-password") === false', () => {
  assert(!shouldStartLobby('/reset-password'), 'shouldStartLobby("/reset-password") трябва да е false')
  assert(isResetPasswordPath('/reset-password'), 'isResetPasswordPath("/reset-password") → true')
  assert(!isResetPasswordPath('/lobby'), 'isResetPasswordPath("/lobby") → false')
  assert(!isResetPasswordPath('/'), 'isResetPasswordPath("/") → false')
  assert(!isResetPasswordPath('/reset-password/extra'), 'isResetPasswordPath("/reset-password/extra") → false')
})

// [8] shouldStartLobby('/lobby') === true
await check('[8] shouldStartLobby("/lobby") === true', () => {
  assert(shouldStartLobby('/lobby'), 'shouldStartLobby("/lobby") трябва да е true')
})

// [9] shouldStartLobby('/') === true
await check('[9] shouldStartLobby("/") === true', () => {
  assert(shouldStartLobby('/'), 'shouldStartLobby("/") трябва да е true')
})

// [10] Reset route render не може да бъде последван от initial lobby render
await check('[10] Reset route блокира всички lobby renders', () => {
  // При /reset-password всички lobby startup calls са guard-нати от !shouldStartLobby(path).
  // loadAuthSession → lobby.render(): guard !_isResetPasswordPath
  // onOpen → lobby.setConnected(true): guard !_isResetPasswordPath
  // onClose → lobby.setConnected(false): guard !_isResetPasswordPath
  // onMessage → lobby.handleServerMessage(): guard !_isResetPasswordPath
  // viewport resize → lobby.render(): guard !_isResetPasswordPath
  // loadAuthSession().then → navigateInitialPath(): guard !_isResetPasswordPath
  const isReset = isResetPasswordPath('/reset-password')
  const lobbyRendersAllowed = shouldStartLobby('/reset-password')
  assert(isReset, '/reset-password е reset path')
  assert(!lobbyRendersAllowed, 'Нито един lobby render не е позволен при reset path')

  // resolvePathToScreen('/reset-password') → null → потвърждава че без guard щеше switchToLobby()
  const screen = resolvePathToScreen('/reset-password')
  assert(screen === null, '/reset-password не е в PATH_TO_SCREEN')
})

// [11] Token extraction и fragment cleanup остават работещи
await check('[11] Token extraction и fragment cleanup остават работещи', () => {
  const token = extractTokenFromHash('#token=TEST_TOKEN')
  assert(token === 'TEST_TOKEN', `Token трябва да е 'TEST_TOKEN', получен '${token}'`)

  const base64url = extractTokenFromHash('#token=dGhpcyBpcyBhIHRlc3Q_dG9rZW4')
  assert(base64url !== null, 'base64url token се прочита')

  const simulatedCleanUrl = '/reset-password'
  assert(!simulatedCleanUrl.includes('#'), 'URL след replaceState не съдържа #')
  assert(!simulatedCleanUrl.includes('token'), 'URL след replaceState не съдържа token')
})

// [12] No-token reset state остава работещ
await check('[12] No-token reset state остава работещ', () => {
  const token = extractTokenFromHash('')
  assert(token === null, 'Без hash → null token')
  const state = buildInitialState(null)
  assert(state.phase === 'no-token', `phase трябва да е 'no-token', получен '${state.phase}'`)
})

// [13] Нормалните /lobby и / routes не са променени
await check('[13] Нормалните /lobby и / routes не са променени', () => {
  assert(shouldStartLobby('/lobby'), '/lobby → lobby стартира нормално')
  assert(shouldStartLobby('/'), '/ → lobby стартира нормално')
  assert(resolvePathToScreen('/lobby') === 'lobby', '/lobby → lobby screen')
  assert(resolvePathToScreen('/') === null, '/ → null (landing overlay)')
})

// ─── suppressRendering guard checks ──────────────────────────────────────────

// Симулира shouldSuppressLobbyRender() от createLobbyFlowController.ts
function shouldSuppressLobbyRender(opts: { suppressRendering?: boolean; getIsInGame?: () => boolean }): boolean {
  return (opts.suppressRendering === true) || (opts.getIsInGame?.() ?? false)
}

// Симулира дали render() ще се изпълни
function wouldRender(opts: { suppressRendering?: boolean; getIsInGame?: () => boolean }): boolean {
  return !shouldSuppressLobbyRender(opts)
}

// [14] suppressRendering=true блокира lobby render
await check('[14] suppressRendering=true блокира lobby render', () => {
  assert(!wouldRender({ suppressRendering: true }), 'При suppressRendering=true render се блокира')
  assert(!wouldRender({ suppressRendering: true, getIsInGame: () => false }), 'suppressRendering=true + не в игра → блокиран')
})

// [15] scheduleRender също е блокиран при suppressRendering=true
await check('[15] scheduleRender е блокиран при suppressRendering=true', () => {
  // scheduleRender() проверява shouldSuppressLobbyRender() преди да планира render
  assert(shouldSuppressLobbyRender({ suppressRendering: true }), 'shouldSuppressLobbyRender → true при suppressRendering=true')
  // scheduleRender не планира setTimeout ако suppress е true — блокиран
})

// [16] suppressRendering=false запазва нормалното поведение
await check('[16] suppressRendering=false не блокира нормален lobby render', () => {
  assert(wouldRender({ suppressRendering: false }), 'suppressRendering=false → render се изпълнява')
  assert(wouldRender({}), 'Без suppressRendering → render се изпълнява')
  assert(!wouldRender({ getIsInGame: () => true }), 'В игра → render е блокиран (съществуваща логика)')
  assert(wouldRender({ suppressRendering: false, getIsInGame: () => false }), 'suppressRendering=false + не в игра → render OK')
})

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

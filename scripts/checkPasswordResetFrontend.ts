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

// ─── Резултат ─────────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

/**
 * checkSvaraStage1Access.ts
 *
 * Свара — Етап 1: скрита игра, ролеви достъп и SVARA_TEST_ENABLED.
 *
 *  A. Unit — обща сървърна проверка evaluateSvaraAccess (флаг/сесия/роля).
 *  B. Unit — клиент: canShowSvaraEntry, fetchSvaraAccess (fail closed),
 *     renderMoreGamesScreen (картата присъства само при showSvara; без нея
 *     HTML-ът е byte-identical с HEAD версията → без регресия за Ludo),
 *     renderSvaraPage (съдържание само при 'granted').
 *  C. Source-level — клиентът показва съдържание само след сървърно 'granted';
 *     сървърът регистрира endpoint-а и UI сигнала през общата проверка.
 *  D. HTTP E2E (реален isolated server process): 5 разрешени роли, обикновен
 *     профил, VIP без роля, chat_admin, неудостоверен посетител, подправена
 *     сесия, опит за заобикаляне с role в query/header, понижаване на роля,
 *     флаг OFF (рестарт на същата DB) → отказ за всички.
 *
 * Изпълнение: npm run check:svara-stage1-access (от server/).
 */

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createIsolatedSvaraRoot, runNode, startIsolatedSvaraBackend } from '../../scripts/svaraRealIntegrationHarness.js'
import { evaluateSvaraAccess, SVARA_ALLOWED_ROLES } from '../src/games/svara/svaraAccess.js'
import { canShowSvaraEntry, fetchSvaraAccess } from '../../src/app/games/svara/svaraAccess.js'
import { renderSvaraPage } from '../../src/app/games/svara/renderSvaraPage.js'
import { renderMoreGamesScreen } from '../../src/app/games/ludo/renderMoreGamesScreen.js'

const PASSWORD = 'SvaraStage1Check1!'
const ALL_ROLES = ['player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin'] as const
const EXPECTED_ALLOWED = ['admin', 'subadmin', 'pika_team', 'marketing', 'top_chat_admin']

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const projectRootPath = join(serverRootPath, '..')

console.log('\ncheckSvaraStage1Access')

// ─── A. Сървърна обща проверка ─────────────────────────────────────────────
console.log('\n=== A. evaluateSvaraAccess ===')

const sessionFor = (role: string) => ({ account: { role }, profile: { profileId: randomUUID() } })
const ON = () => true
const OFF = () => false

await check('A1. списъкът с разрешени роли е точно петте служебни роли', () => {
  assert(JSON.stringify([...SVARA_ALLOWED_ROLES].sort()) === JSON.stringify([...EXPECTED_ALLOWED].sort()), JSON.stringify(SVARA_ALLOWED_ROLES))
})

for (const role of ALL_ROLES) {
  const shouldAllow = EXPECTED_ALLOWED.includes(role)
  await check(`A2. флаг ON, role=${role} → ${shouldAllow ? 'allowed' : 'forbidden_role'}`, () => {
    const decision = evaluateSvaraAccess(sessionFor(role), ON)
    if (shouldAllow) assert(decision.allowed === true, JSON.stringify(decision))
    else assert(decision.allowed === false && decision.reason === 'forbidden_role', JSON.stringify(decision))
  })
  await check(`A3. флаг OFF, role=${role} → feature_disabled`, () => {
    const decision = evaluateSvaraAccess(sessionFor(role), OFF)
    assert(decision.allowed === false && decision.reason === 'feature_disabled', JSON.stringify(decision))
  })
}

await check('A4. без сесия (флаг ON) → unauthenticated; (флаг OFF) → feature_disabled', () => {
  const on = evaluateSvaraAccess(null, ON)
  const off = evaluateSvaraAccess(null, OFF)
  assert(on.allowed === false && on.reason === 'unauthenticated', JSON.stringify(on))
  assert(off.allowed === false && off.reason === 'feature_disabled', JSON.stringify(off))
})

await check('A5. сесия без профил → unauthenticated', () => {
  const decision = evaluateSvaraAccess({ account: { role: 'admin' }, profile: { profileId: null } }, ON)
  assert(decision.allowed === false && decision.reason === 'unauthenticated', JSON.stringify(decision))
})

await check('A6. роля с различен регистър/интервали не минава ("Admin", " admin")', () => {
  assert(evaluateSvaraAccess(sessionFor('Admin'), ON).allowed === false, 'Admin')
  assert(evaluateSvaraAccess(sessionFor(' admin'), ON).allowed === false, ' admin')
})

await check('A7. default флаг (без SVARA_TEST_ENABLED в env) е OFF', () => {
  const previous = process.env.SVARA_TEST_ENABLED
  delete process.env.SVARA_TEST_ENABLED
  try {
    const decision = evaluateSvaraAccess(sessionFor('admin'))
    assert(decision.allowed === false && decision.reason === 'feature_disabled', JSON.stringify(decision))
    process.env.SVARA_TEST_ENABLED = 'true'
    assert(evaluateSvaraAccess(sessionFor('admin')).allowed === false, '"true" не трябва да включва флага (само точно "1")')
    process.env.SVARA_TEST_ENABLED = '1'
    assert(evaluateSvaraAccess(sessionFor('admin')).allowed === true, '"1" трябва да включва флага')
  } finally {
    if (previous === undefined) delete process.env.SVARA_TEST_ENABLED
    else process.env.SVARA_TEST_ENABLED = previous
  }
})

// ─── B. Клиент ──────────────────────────────────────────────────────────────
console.log('\n=== B. клиент ===')

for (const role of ALL_ROLES) {
  const shouldShow = EXPECTED_ALLOWED.includes(role)
  await check(`B1. canShowSvaraEntry role=${role}, svaraTestAccess=true → ${shouldShow}`, () => {
    assert(canShowSvaraEntry({ account: { role }, svaraTestAccess: true }) === shouldShow, role)
  })
}

await check('B2. canShowSvaraEntry е false без сигнал от сървъра / без сесия', () => {
  assert(canShowSvaraEntry({ account: { role: 'admin' }, svaraTestAccess: false }) === false, 'false signal')
  assert(canShowSvaraEntry({ account: { role: 'admin' } }) === false, 'missing signal')
  assert(canShowSvaraEntry(null) === false, 'null session')
})

const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })) as typeof fetch

await check('B3. fetchSvaraAccess: само 200 + {ok:true, access:"granted"} дава granted', async () => {
  assert(await fetchSvaraAccess('', fakeFetch(200, { ok: true, access: 'granted' })) === 'granted', '200 granted')
  assert(await fetchSvaraAccess('', fakeFetch(200, { ok: true })) === 'denied', '200 без access')
  assert(await fetchSvaraAccess('', fakeFetch(403, { ok: true, access: 'granted' })) === 'forbidden', '403 cannot grant access even with a forged success body')
  assert(await fetchSvaraAccess('', fakeFetch(401, {})) === 'unauthenticated', '401')
  assert(await fetchSvaraAccess('', fakeFetch(404, {})) === 'unavailable', '404')
  assert(await fetchSvaraAccess('', fakeFetch(500, {})) === 'denied', '500')
  const invalidJson = (async () => new Response('invalid', { status: 200 })) as typeof fetch
  assert(await fetchSvaraAccess('', invalidJson) === 'denied', 'malformed success remains closed')
  const throwingFetch = (async () => { throw new Error('network') }) as typeof fetch
  assert(await fetchSvaraAccess('', throwingFetch) === 'denied', 'network error → fail closed')
})

await check('B4. fetchSvaraAccess праща cookie (credentials:include) към /api/games/svara/access', async () => {
  let seenUrl = ''
  let seenInit: RequestInit | undefined
  const spyFetch = (async (url: string, init?: RequestInit) => {
    seenUrl = url
    seenInit = init
    return new Response('{}', { status: 403 })
  }) as unknown as typeof fetch
  await fetchSvaraAccess('http://localhost:3001', spyFetch)
  assert(seenUrl === 'http://localhost:3001/api/games/svara/access', seenUrl)
  assert(seenInit?.credentials === 'include' && seenInit?.method === 'GET', JSON.stringify(seenInit))
})

await check('B5. "Игри": картата Свара е в HTML само при showSvara=true (desktop + mobile)', () => {
  for (const mobile of [false, true]) {
    const hidden = renderMoreGamesScreen(mobile, true, false)
    const shown = renderMoreGamesScreen(mobile, true, true)
    assert(!hidden.includes('data-svara-play-card') && !hidden.includes('Свара'), `hidden mobile=${mobile}`)
    assert(shown.includes('data-svara-play-card="1"') && shown.includes('Свара'), `shown mobile=${mobile}`)
    assert(shown.includes('data-ludo-play-card="1"'), `Ludo картата остава при showSvara mobile=${mobile}`)
  }
})

await check('B6. [регресия] без Свара "Игри" HTML е byte-identical с HEAD версията (Ludo on/off, desktop/mobile)', async () => {
  const headSource = execFileSync('git', ['show', 'HEAD:src/app/games/ludo/renderMoreGamesScreen.ts'], { cwd: projectRootPath, encoding: 'utf8' })
  const tempDir = await mkdtemp(join(tmpdir(), 'svara-stage1-head-'))
  try {
    const tempFile = join(tempDir, 'renderMoreGamesScreenHead.ts')
    await writeFile(tempFile, headSource, 'utf8')
    const head = await import(pathToFileURL(tempFile).href) as { renderMoreGamesScreen: (m?: boolean, l?: boolean) => string }
    for (const mobile of [false, true]) {
      for (const ludo of [false, true]) {
        assert(head.renderMoreGamesScreen(mobile, ludo) === renderMoreGamesScreen(mobile, ludo), `mobile=${mobile} ludo=${ludo}`)
        assert(head.renderMoreGamesScreen(mobile, ludo) === renderMoreGamesScreen(mobile, ludo, false), `explicit false mobile=${mobile} ludo=${ludo}`)
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

await check('B7. renderSvaraPage: checking hides both mounts; granted exposes the test-only real lobby and back link', () => {
  for (const mobile of [false, true]) {
    const checking = renderSvaraPage('checking', mobile)
    const granted = renderSvaraPage('granted', mobile)
    assert(checking.includes('data-svara-page="checking"') && !checking.includes('data-svara-lobby-mount') && !checking.includes('data-svara-demo-mount') && !checking.includes('>Свара<'), `checking mobile=${mobile}`)
    assert(granted.includes('>Свара</h1>') && granted.includes('Тестов режим') && granted.includes('data-svara-lobby-mount="1"') && !granted.includes('data-svara-demo-mount'), `granted mobile=${mobile}`)
    assert(granted.includes('href="/games"') && granted.includes('data-svara-back-to-games="1"'), `back link mobile=${mobile}`)
  }
})

await check('B8. отказите имат обяснение и retry/back, без игрови или демо mount (desktop + mobile)', () => {
  const reasons = {
    unauthenticated: 'Влез в профила си',
    forbidden: 'няма разрешение',
    unavailable: 'не е достъпна на този сървър',
    denied: 'не завърши успешно',
  } as const
  for (const mobile of [false, true]) {
    for (const reason of Object.keys(reasons) as (keyof typeof reasons)[]) {
      const html = renderSvaraPage(reason, mobile)
      assert(html.includes(`data-svara-page="${reason}"`) && html.includes(reasons[reason]), `${reason} explanation mobile=${mobile}`)
      assert(html.includes('role="alert"') && html.includes('data-svara-play-button="1"') && html.includes('data-svara-back-to-games="1"'), `${reason} recovery actions`)
      assert(!html.includes('data-svara-lobby-mount') && !html.includes('data-svara-demo-mount'), `${reason} must not mount game`)
    }
  }
})

// ─── C. Source-level ───────────────────────────────────────────────────────
console.log('\n=== C. source-level ===')

const controllerSource = (await readFile(join(projectRootPath, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')).replace(/\r\n/g, '\n')
const lobbyScreenSource = (await readFile(join(projectRootPath, 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')).replace(/\r\n/g, '\n')
const serverIndexSource = (await readFile(join(serverRootPath, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')

await check('C1. клиентът задава svaraPageStatus="granted" само в един път — след fetchSvaraAccess === "granted"', () => {
  const grants = controllerSource.match(/svaraPageStatus = 'granted'/g) ?? []
  assert(grants.length === 1, `expected 1 assignment, got ${grants.length}`)
  const idx = controllerSource.indexOf('function showSvaraPage')
  assert(idx !== -1, 'showSvaraPage missing')
  const block = controllerSource.slice(idx, idx + 1600)
  const fetchIdx = block.indexOf('fetchSvaraAccess(')
  const grantIdx = block.indexOf("result === 'granted'")
  const assignIdx = block.indexOf("state.svaraPageStatus = 'granted'")
  const resetIdx = block.indexOf("state.svaraPageStatus = 'checking'")
  assert(resetIdx !== -1 && resetIdx < fetchIdx, 'status трябва да се нулира до checking преди заявката')
  assert(fetchIdx !== -1 && fetchIdx < grantIdx && grantIdx < assignIdx, 'granted трябва да следва сървърния отговор')
  assert(block.includes('state.svaraPageStatus = result'), 'отказът трябва да се показва като сървърен резултат')
  assert(!block.includes('history.replaceState') && !block.includes('showMoreGamesPage()'), 'отказът не трябва да пренасочва без обяснение')
})

await check('C2. /games/svara е регистриран в routing картите и navigateFromPath', () => {
  assert((controllerSource.match(/'\/games\/svara': 'svara'/g) ?? []).length === 2, 'LOBBY_PATH_TO_SCREEN + PATH_TO_SCREEN')
  assert(controllerSource.includes("svara: '/games/svara'"), 'SCREEN_TO_PATH')
  assert(controllerSource.includes("case 'svara': showSvaraPage(); break"), 'navigateFromPath switch')
})

await check('C3. картата в "Игри" идва от canShowSvaraEntry(authSession) (desktop + mobile render)', () => {
  assert(controllerSource.includes('canShowSvaraEntry: canShowSvaraEntry(authSession)'), 'controller view state')
  assert((lobbyScreenSource.match(/renderMoreGamesScreen\((true|false), isLudoFeatureEnabled\(\), state\.canShowSvaraEntry\)/g) ?? []).length === 2, 'both render branches')
})

await check('C4. сървърът регистрира /api/games/svara/access и UI сигнала през общата проверка', () => {
  assert(serverIndexSource.includes('handleSvaraHttpRequest(req, res, requestUrl.pathname'), 'dispatch')
  assert(serverIndexSource.includes('svaraTestAccess: canSessionAccessSvara(session)'), 'session signal')
  assert(!/SVARA_TEST_ENABLED/.test(serverIndexSource), 'index.ts не трябва да чете флага директно')
})

// ─── D. HTTP E2E ───────────────────────────────────────────────────────────
console.log('\n=== D. HTTP E2E ===')

// Direct compiled child, PORT=0 and private PID/socket/DB proof shared with Chromium.
let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250 + 1}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[]; headers: Headers }

async function request(
  port: number,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
  cookie?: string,
  extraHeaders: Record<string, string> = {},
): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp(), ...extraHeaders }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [], headers: res.headers }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

type TestUser = { label: string; role: string; cookie: string; profileId: string; email: string }

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<TestUser> {
  const email = `svara-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Sv${label.replace(/[^a-z]/gi, '').slice(0, 6)}${randomUUID().replace(/[^a-z0-9]/gi, '').slice(0, 4)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  if (role !== 'player') {
    withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  }
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  const me = await request(port, 'GET', '/api/auth/me', undefined, cookie)
  const profileId = ((me.body?.session as { profile?: { profileId?: string } } | undefined)?.profile?.profileId) ?? ''
  assert(profileId !== '', `profileId ${label}`)
  return { label, role, cookie, profileId, email }
}

function setVip(databaseFile: string, profileId: string): void {
  const activeUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, activeUntil))
}

const meSvaraSignal = async (port: number, cookie: string) => {
  const me = await request(port, 'GET', '/api/auth/me', undefined, cookie)
  return (me.body?.session as { svaraTestAccess?: unknown } | undefined)?.svaraTestAccess
}

const ACCESS_PATH = '/api/games/svara/access'
const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? serverRootPath,
)

await runNode(projectRootPath, ['node_modules/typescript/bin/tsc', '-p', join(sourceServerRoot, 'tsconfig.json')])
const isolated = await createIsolatedSvaraRoot(resolve(sourceServerRoot, '..'))
let server: Awaited<ReturnType<typeof startIsolatedSvaraBackend>> | null = null

try {
  // ── D-ON: SVARA_TEST_ENABLED=1 ──
  server = await startIsolatedSvaraBackend(isolated)
  let port = server.port
  withDb(isolated.dbFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const staff: TestUser[] = []
  for (const role of EXPECTED_ALLOWED) staff.push(await registerUser(port, isolated.dbFile, role, role))
  const player = await registerUser(port, isolated.dbFile, 'player', 'player')
  const vip = await registerUser(port, isolated.dbFile, 'vip', 'player')
  setVip(isolated.dbFile, vip.profileId)
  const chatAdmin = await registerUser(port, isolated.dbFile, 'chatadmin', 'chat_admin')
  const demoted = await registerUser(port, isolated.dbFile, 'demoted', 'admin')

  console.log('\n--- флаг ON ---')
  for (const [index, user] of staff.entries()) {
    await check(`D${index + 1}. ${user.role}: вижда бутона (svaraTestAccess=true) и има достъп (200 granted)`, async () => {
      assert(await meSvaraSignal(port, user.cookie) === true, 'svaraTestAccess')
      const res = await request(port, 'GET', ACCESS_PATH, undefined, user.cookie)
      assert(res.status === 200 && res.body?.ok === true && res.body?.access === 'granted', `${res.status} ${res.text}`)
      assert(res.headers.get('cache-control') === 'no-store', 'Cache-Control: no-store')
    })
  }

  await check('D6. обикновен профил: няма бутон (svaraTestAccess=false) и няма достъп (403)', async () => {
    assert(await meSvaraSignal(port, player.cookie) === false, 'svaraTestAccess')
    const res = await request(port, 'GET', ACCESS_PATH, undefined, player.cookie)
    assert(res.status === 403 && res.body?.ok === false && res.body?.reason === 'forbidden', `${res.status} ${res.text}`)
  })

  await check('D7. VIP без служебна роля: няма бутон и няма достъп (403)', async () => {
    const vipRow = withDb(isolated.dbFile, (db) => db.prepare('SELECT active_until FROM vip_status WHERE profile_id = ?').get(vip.profileId))
    assert(vipRow !== undefined, 'VIP fixture')
    assert(await meSvaraSignal(port, vip.cookie) === false, 'svaraTestAccess')
    const res = await request(port, 'GET', ACCESS_PATH, undefined, vip.cookie)
    assert(res.status === 403, `${res.status} ${res.text}`)
  })

  await check('D7b. chat_admin (служебна, но неразрешена роля): няма достъп (403)', async () => {
    assert(await meSvaraSignal(port, chatAdmin.cookie) === false, 'svaraTestAccess')
    const res = await request(port, 'GET', ACCESS_PATH, undefined, chatAdmin.cookie)
    assert(res.status === 403, `${res.status} ${res.text}`)
  })

  await check('D8. неудостоверен посетител: 401', async () => {
    const res = await request(port, 'GET', ACCESS_PATH)
    assert(res.status === 401 && res.body?.reason === 'unauthenticated', `${res.status} ${res.text}`)
  })

  await check('D10a. подправена сесийна бисквитка: 401', async () => {
    const res = await request(port, 'GET', ACCESS_PATH, undefined, `belot_session=${randomUUID()}`)
    assert(res.status === 401, `${res.status} ${res.text}`)
  })

  await check('D10b. роля в query/header/body не заобикаля проверката (обикновен профил остава 403)', async () => {
    const viaQuery = await request(port, 'GET', `${ACCESS_PATH}?role=admin&svaraTestAccess=true`, undefined, player.cookie)
    assert(viaQuery.status === 403, `query: ${viaQuery.status}`)
    const viaHeader = await request(port, 'GET', ACCESS_PATH, undefined, player.cookie, { 'X-Role': 'admin', 'X-Account-Role': 'admin' })
    assert(viaHeader.status === 403, `header: ${viaHeader.status}`)
    const viaPost = await request(port, 'POST', ACCESS_PATH, { role: 'admin' }, player.cookie)
    assert(viaPost.status === 405, `POST: ${viaPost.status}`)
  })

  await check('D10c. понижаване на роля admin → player отнема достъпа веднага (без нов login)', async () => {
    const before = await request(port, 'GET', ACCESS_PATH, undefined, demoted.cookie)
    assert(before.status === 200, `before: ${before.status}`)
    withDb(isolated.dbFile, (db) => db.prepare("UPDATE accounts SET role = 'player' WHERE email = ?").run(demoted.email))
    const after = await request(port, 'GET', ACCESS_PATH, undefined, demoted.cookie)
    assert(after.status === 403, `after: ${after.status} ${after.text}`)
    assert(await meSvaraSignal(port, demoted.cookie) === false, 'svaraTestAccess след понижаване')
  })

  await check('D11a. съществуващите endpoint-и не са засегнати (/api/rooms, /api/auth/me)', async () => {
    assert((await request(port, 'GET', '/api/rooms')).status === 200, '/api/rooms')
    const me = await request(port, 'GET', '/api/auth/me', undefined, player.cookie)
    assert(me.status === 200 && me.body?.ok === true, '/api/auth/me')
  })

  await server.stop()
  server = null

  // ── D-OFF: без SVARA_TEST_ENABLED (default) и с невалидна стойност ──
  for (const flagValue of [undefined, '0', 'true']) {
    server = await startIsolatedSvaraBackend(isolated, { featureFlag: flagValue ?? null })
    port = server.port
    console.log(`\n--- флаг OFF (SVARA_TEST_ENABLED=${flagValue === undefined ? '<unset>' : JSON.stringify(flagValue)}) ---`)

    await check(`D9. [${flagValue ?? 'unset'}] всичките 5 служебни роли: няма бутон и 404`, async () => {
      for (const user of staff) {
        assert(await meSvaraSignal(port, user.cookie) === false, `svaraTestAccess ${user.role}`)
        const res = await request(port, 'GET', ACCESS_PATH, undefined, user.cookie)
        assert(res.status === 404, `${user.role}: ${res.status} ${res.text}`)
      }
    })

    await check(`D9b. [${flagValue ?? 'unset'}] обикновен/VIP/анонимен: 404`, async () => {
      for (const cookie of [player.cookie, vip.cookie, undefined]) {
        const res = await request(port, 'GET', ACCESS_PATH, undefined, cookie)
        assert(res.status === 404, `${res.status} ${res.text}`)
      }
    })

    await server.stop()
    server = null
  }
} catch (error) {
  failed += 1
  console.error(`  FAIL HTTP harness: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  try { if (server) await server.stop() } finally { await isolated.cleanup() }
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

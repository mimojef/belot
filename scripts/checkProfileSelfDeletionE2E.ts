/**
 * checkProfileSelfDeletionE2E.ts
 *
 * Самоизтриване, Етап 4I — основният сценарий в РЕАЛЕН браузър срещу РЕАЛЕН
 * backend (изолирано копие на server/ с temp база) и реалното приложение
 * (vite, src/main.ts). Флагът PROFILE_SELF_DELETION_ENABLED е включен САМО в
 * това изолирано копие.
 *
 *   [E1] Собственият профил показва "Изтрий"; грешна парола -> съобщение,
 *        профилът е непроменен (без заявка, сесията работи).
 *   [E2] Валидна парола -> заявката е приета от сървъра; показаната дата =
 *        scheduled_for в базата; сесията е отнета на сървъра, WS е затворен,
 *        клиентът е без потребител.
 *   [E3] "Разбрах" -> чисто презареждане; "Назад" не връща достъп.
 *   [E4] Нов вход -> екранът от 4H с крайната дата; "Запази профила ми" ->
 *        заявката е отменена; следващ вход е нормален.
 *   [E6] Етап 4J — admin: собственият профил без "Изтрий"; менюто "Заявки
 *        за изтриване" (настолно и мобилно) отваря панела с реалните данни;
 *        отмяна с причина през UI (статус + одит в базата); subadmin няма
 *        пункта.
 *   [E5] Изключен флаг (друго изолирано копие): бутонът не се показва, а
 *        директна заявка към API се отказва (клиентът не заобикаля сървъра).
 *
 * Употреба (от корена): npx tsx scripts/checkProfileSelfDeletionE2E.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { ensureServerDatabaseReady } from '../server/src/db/ensureServerDatabaseReady.js'
import { writeTestLedgerAck } from '../server/scripts/fixtures/profileDeletionCancellationKit.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const freePort = () => new Promise<number>((done, fail) => {
  const server = createNetServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return fail(new Error('No free port'))
    server.close(() => done(address.port))
  })
})
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 30_000): Promise<void> {
  const expires = Date.now() + timeout
  while (Date.now() < expires) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

const projectRoot = process.cwd()
const SECRET = 'profile-self-deletion-e2e-secret-0123456789abcdef'
const PASSWORD = 'SelfDelete1!'

type Backend = { child: ChildProcessWithoutNullStreams; port: number; db: DatabaseSync; tempRoot: string; output: string[]; ledgerPath: string }

async function startBackend(flagEnabled: boolean): Promise<Backend> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'belot-self-deletion-e2e-'))
  const serverDir = join(tempRoot, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(resolve(projectRoot, 'server/src'), join(serverDir, 'src'), { recursive: true })
  await cp(resolve(projectRoot, 'server/dist'), join(serverDir, 'dist'), { recursive: true })
  await cp(resolve(projectRoot, 'server/database/migrations'), join(serverDir, 'database/migrations'), { recursive: true })
  await cp(resolve(projectRoot, 'server/package.json'), join(serverDir, 'package.json'))
  await mkdir(join(serverDir, 'database/data'), { recursive: true })
  await symlink(resolve(projectRoot, 'server/node_modules'), join(serverDir, 'node_modules'), 'junction')
  await symlink(resolve(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction')
  const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
  const db = new DatabaseSync(bootstrap.databaseFilePath)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
  db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()
  const port = await freePort()
  // Етап 4J1 — изолиран регистър; отмяната е окончателна след offsite ack (пише го тестът).
  const ledgerPath = join(tempRoot, 'deletion-ledger', 'profile-deletions.jsonl')
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET, BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1',
    PROFILE_DELETION_LEDGER_PATH: ledgerPath, PROFILE_DELETION_CANCELLATION_FINALIZER_INTERVAL_MS: '300',
  }
  delete env.PROFILE_SELF_DELETION_ENABLED
  delete env.PROFILE_SELF_DELETION_WORKER_ENABLED
  if (flagEnabled) env.PROFILE_SELF_DELETION_ENABLED = '1'
  const output: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => output.push(String(chunk)))
  child.stderr.on('data', (chunk) => output.push(String(chunk)))
  await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false), 'backend health', 90_000)
  return { child, port, db, tempRoot, output, ledgerPath }
}

async function stopBackend(backend: Backend | null): Promise<void> {
  if (backend === null) return
  try { backend.db.close() } catch { /* ignore */ }
  if (backend.child.exitCode === null) {
    backend.child.kill('SIGTERM')
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { backend.child.kill('SIGKILL'); done() }, 10_000)
      backend.child.once('exit', () => { clearTimeout(timer); done() })
    })
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { await rm(backend.tempRoot, { recursive: true, force: true }); break } catch { await sleep(500) }
  }
}

async function register(port: number, label: string): Promise<{ profileId: string; accountId: string; email: string; cookie: string }> {
  const unique = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const email = `self-del-${label}-${unique}@example.test`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `SD${label}${unique.slice(-6)}`, gender: 'female', visitorId: randomUUID() }),
  })
  const body: any = await response.json()
  assert(response.ok && body.ok, `Регистрация: ${response.status} ${JSON.stringify(body)}`)
  const cookie = (response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
  assert(cookie, 'Липсва бисквитка')
  return { profileId: body.session.profile.profileId, accountId: body.session.account.accountId, email, cookie: cookie.split('=')[1]! }
}

console.log('\ncheckProfileSelfDeletionE2E')

let browser: Browser | null = null
let vite: ViteDevServer | null = null
let backend: Backend | null = null
let backendOff: Backend | null = null

try {
  backend = await startBackend(true)
  const backendPort = backend.port
  // Приложението сочи към :3001 при localhost/127.0.0.1 — пренасочваме към
  // изолирания backend (established подход: checkLudoEndGameNavigationReal.ts).
  // Отделен vite сървър за всеки backend: vite кешира трансформираните модули.
  async function startVite(targetBackendPort: number): Promise<{ server: ViteDevServer; origin: string }> {
    const vitePort = await freePort()
    const server = await createViteServer({
      root: projectRoot,
      server: { host: '127.0.0.1', port: vitePort, strictPort: true },
      logLevel: 'error',
      plugins: [{
        name: 'self-deletion-e2e-isolated-backend',
        enforce: 'pre',
        transform(code, id) {
          if (!id.includes('/src/') && !id.includes('\\src\\')) return null
          return code.includes(':3001') ? code.replaceAll(':3001', `:${targetBackendPort}`) : null
        },
      }],
    })
    await server.listen()
    return { server, origin: `http://127.0.0.1:${vitePort}` }
  }
  let currentBackendPort = backendPort
  const mainVite = await startVite(backendPort)
  vite = mainVite.server
  let appOrigin = mainVite.origin
  browser = await chromium.launch({ headless: true })

  async function openApp(cookie: string | null, path = '/lobby', viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page; sockets: Array<{ closed: boolean }> }> {
    const context = await browser!.newContext({ viewport, locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    if (cookie !== null) await context.addCookies([{ name: 'belot_session', value: cookie, url: `http://127.0.0.1:${currentBackendPort}` }])
    const page = await context.newPage()
    const sockets: Array<{ closed: boolean }> = []
    const socketPort = currentBackendPort
    page.on('websocket', (socket) => {
      if (!socket.url().includes(`:${socketPort}/ws`)) return
      const entry = { closed: false }
      sockets.push(entry)
      socket.on('close', () => { entry.closed = true })
    })
    await page.goto(`${appOrigin}${path}`)
    const consent = page.locator('[data-consent-accept-all="1"]')
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).then(() => consent.click()).catch(() => {})
    return { context, page, sockets }
  }
  const meFromPage = (page: Page) => page.evaluate(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/me`, { credentials: 'include' })
    const json = await response.json()
    return json?.session?.profile?.profileId ?? null
  }, currentBackendPort)

  const user = await register(backendPort, 'main')
  const { page, sockets } = await openApp(user.cookie)

  async function openOwnProfileAndDialog(): Promise<void> {
    const profileButton = page.locator('[data-lobby-profile-button="1"]:visible').first()
    await profileButton.waitFor({ state: 'visible', timeout: 30_000 })
    await profileButton.click()
    const selfDelete = page.locator('[data-player-profile-self-delete="1"]')
    await selfDelete.waitFor({ state: 'visible', timeout: 15_000 })
    await selfDelete.click()
    await page.locator('#self-deletion-dialog [role="dialog"]').waitFor({ state: 'visible' })
  }

  await check('[E1] "Изтрий" в собствения профил; грешна парола -> съобщение, без заявка, сесията и профилът са непроменени', async () => {
    await openOwnProfileAndDialog()
    await page.locator('[data-self-deletion-password="1"]').fill('wrong-password')
    await page.locator('[data-self-deletion-confirm="1"]').check()
    await page.locator('[data-self-deletion-submit="1"]').click()
    await page.waitForFunction(() => (document.querySelector('[data-self-deletion-error="1"]')?.textContent ?? '').length > 0, undefined, { timeout: 15_000 })
    const error = await page.locator('[data-self-deletion-error="1"]').textContent()
    assert(error?.includes('Паролата не е вярна') === true, `грешка: ${error}`)
    assert(Number((backend!.db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(user.profileId) as { c: number }).c) === 0, 'създадена заявка')
    assert((await meFromPage(page)) === user.profileId, 'сесията е засегната')
    await page.keyboard.press('Escape')
    assert((await page.locator('#self-deletion-dialog').count()) === 0, 'Escape')
  })

  let shownDeadline = ''
  await check('[E2] Валидна парола -> приета от сървъра; датата = scheduled_for в базата; сесията е отнета, WS е затворен, клиентът е без потребител', async () => {
    await page.locator('[data-player-profile-self-delete="1"]').click().catch(async () => { await openOwnProfileAndDialog() })
    if ((await page.locator('#self-deletion-dialog').count()) === 0) await openOwnProfileAndDialog()
    await page.locator('[data-self-deletion-password="1"]').fill(PASSWORD)
    await page.locator('[data-self-deletion-confirm="1"]').check()
    await page.locator('[data-self-deletion-submit="1"]').click()
    await page.locator('[data-self-deletion-deadline="1"]').waitFor({ state: 'visible', timeout: 20_000 })
    shownDeadline = (await page.locator('[data-self-deletion-deadline="1"]').textContent()) ?? ''
    const row = backend!.db.prepare(`SELECT status, scheduled_for, grace_period_days FROM profile_deletion_requests WHERE profile_id = ?;`).get(user.profileId) as { status: string; scheduled_for: string; grace_period_days: number }
    assert(row?.status === 'pending' && Number(row.grace_period_days) === 30, JSON.stringify(row))
    const expected = await page.evaluate((iso) => new Date(iso).toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }), row.scheduled_for)
    assert(shownDeadline === expected, `показано "${shownDeadline}", в базата ${row.scheduled_for} -> "${expected}"`)
    const activeSessions = Number((backend!.db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL;').get(user.accountId) as { c: number }).c)
    assert(activeSessions === 0, `неотнети сесии: ${activeSessions}`)
    assert((await meFromPage(page)) === null, 'бисквитката още удостоверява')
    assert(sockets.length > 0, 'няма проследен WS към backend-а')
    await waitFor(async () => sockets.every((s) => s.closed), `WS е затворен (${sockets.filter((s) => !s.closed).length} отворени)`, 10_000)
    assert(((await page.locator('#self-deletion-dialog').textContent()) ?? '').includes('Запази профила ми'), 'обяснение за връщане')
  })

  await check('[E3] "Разбрах" -> чисто презареждане към /lobby без потребител; "Назад" не връща достъп', async () => {
    await page.locator('[data-self-deletion-done="1"]').click()
    await page.waitForURL(/\/lobby/, { timeout: 15_000 })
    await page.waitForLoadState('load')
    assert((await page.locator('#self-deletion-dialog').count()) === 0, 'потвърждението остана след презареждането')
    assert((await meFromPage(page)) === null, 'има сесия след презареждане')
    await page.goBack().catch(() => {})
    await sleep(1500)
    assert((await meFromPage(page)) === null, '"Назад" върна сесия')
    assert((await page.locator('[data-player-profile-self-delete="1"]').count()) === 0, '"Назад" показва стария профил с действия')
  })

  await check('[E4] Нов вход -> екранът от 4H с крайната дата; "Запази профила ми" -> заявката е отменена; следващият вход е нормален', async () => {
    const { page: loginPage } = await openApp(null)
    const form = loginPage.locator('form[data-lobby-auth-form="login"]')
    // Гостът отваря входа от бутона "Влез"/"Вход" в lobby-то.
    await loginPage.locator('[data-lobby-auth-login="1"]:visible, [data-lobby-auth-login-button="1"]:visible').first().click({ timeout: 30_000 })
    if (!(await form.isVisible().catch(() => false))) {
      await loginPage.locator('[data-lobby-auth-login-button="1"]:visible, [data-lobby-auth-mode="login"]:visible').first().click({ timeout: 15_000 })
    }
    await form.waitFor({ state: 'visible', timeout: 20_000 })
    await form.locator('input[type="email"]').fill(user.email)
    await form.locator('input[type="password"]').fill(PASSWORD)
    await form.locator('input[type="password"]').press('Enter')
    await loginPage.locator('#pending-deletion-prompt').waitFor({ state: 'visible', timeout: 20_000 })
    const promptText = (await loginPage.locator('#pending-deletion-prompt').textContent()) ?? ''
    assert(promptText.includes(shownDeadline), `крайната дата в 4H екрана: ${promptText}`)
    assert((await loginPage.locator('form[data-lobby-auth-form="login"]').count()) === 0 || !(await form.isVisible()), 'login модалът остана отворен')
    await loginPage.locator('[data-pending-deletion-cancel="1"]').click()
    // Етап 4J1 — без offsite потвърждение: приета, но не окончателна.
    await loginPage.locator('[data-pending-deletion-cancellation-pending="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    assert(!((await loginPage.locator('#pending-deletion-prompt').textContent()) ?? '').includes('отменена и профилът е запазен'), 'окончателен успех преди потвърждението')
    writeTestLedgerAck(backend!.ledgerPath)
    await waitFor(async () => (backend!.db.prepare(`SELECT status FROM profile_deletion_requests WHERE profile_id = ?;`).get(user.profileId) as { status: string }).status === 'cancelled', 'финализиране след offsite ack', 15_000)
    const row = backend!.db.prepare(`SELECT status FROM profile_deletion_requests WHERE profile_id = ?;`).get(user.profileId) as { status: string }
    assert(row.status === 'cancelled', `статус: ${row.status}`)
    const relogin = await fetch(`http://127.0.0.1:${backendPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: PASSWORD }) })
    const reloginBody: any = await relogin.json()
    assert(relogin.status === 200 && reloginBody.ok === true, `вход след запазване: ${relogin.status} ${JSON.stringify(reloginBody)}`)
  })

  await check('[E6] Етап 4J — admin: в собствения профил няма "Изтрий"; менюто "Заявки за изтриване" отваря панела с реалните данни; отмяна с причина през UI; subadmin няма пункта', async () => {
    // Rate limit-ът за регистрации (10/час от IP) е извън обхвата на теста.
    backend!.db.prepare('DELETE FROM registration_rate_limit_events;').run()
    const target = await register(backendPort, 'admtarget')
    const submitted = await fetch(`http://127.0.0.1:${backendPort}/api/account/deletion-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${target.cookie}` },
      body: JSON.stringify({ password: PASSWORD, confirm: true }),
    })
    assert(submitted.status === 200, `подаване: ${submitted.status}`)
    const admin = await register(backendPort, 'adm')
    backend!.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
    const { page: adminPage } = await openApp(admin.cookie)
    const profileButton = adminPage.locator('[data-lobby-profile-button="1"]:visible').first()
    await profileButton.waitFor({ state: 'visible', timeout: 30_000 })
    await profileButton.click()
    await adminPage.locator('[data-player-profile-edit="1"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    assert((await adminPage.locator('[data-player-profile-self-delete="1"]').count()) === 0, '"Изтрий" в собствения профил на admin')
    await adminPage.keyboard.press('Escape')
    await adminPage.reload()
    await adminPage.locator('[data-lobby-nav-admin-toggle="1"]:visible').first().click({ timeout: 30_000 })
    await adminPage.locator('[data-lobby-nav-admin-profile-deletions="1"]:visible').first().click({ timeout: 10_000 })
    await adminPage.locator('#admin-profile-deletions-panel').waitFor({ state: 'visible', timeout: 15_000 })
    const requestId = (backend!.db.prepare('SELECT request_id FROM profile_deletion_requests WHERE profile_id = ?;').get(target.profileId) as { request_id: string }).request_id
    const row = adminPage.locator(`[data-admin-deletion-row="${requestId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15_000 })
    assert(await row.getAttribute('data-admin-deletion-category') === 'pending_cancellable', 'категория')
    await row.locator('[data-admin-deletion-cancel-open]').click()
    await adminPage.locator('[data-admin-deletion-cancel-reason="1"]').fill('Потребителят се обади в поддръжката')
    await adminPage.locator('[data-admin-deletion-cancel-confirm="1"]').click()
    await adminPage.waitForFunction((id) => document.querySelector(`[data-admin-deletion-row="${id}"]`)?.getAttribute('data-admin-deletion-category') === 'cancellation_pending', requestId, { timeout: 15_000 })
    writeTestLedgerAck(backend!.ledgerPath)
    await waitFor(async () => (backend!.db.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status === 'cancelled', 'финализиране', 15_000)
    const dbRow = backend!.db.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }
    const audit = backend!.db.prepare('SELECT reason, actor_profile_id FROM profile_deletion_admin_cancellations WHERE request_id = ?;').get(requestId) as { reason: string; actor_profile_id: string } | undefined
    assert(dbRow.status === 'cancelled' && audit?.reason === 'Потребителят се обади в поддръжката' && audit.actor_profile_id === admin.profileId, `${JSON.stringify(dbRow)} ${JSON.stringify(audit)}`)

    // Мобилно меню на admin.
    const { page: mobileAdmin } = await openApp(admin.cookie, '/lobby', { width: 390, height: 844 })
    await mobileAdmin.locator('[data-lobby-mobile-menu="1"] > summary').first().click({ timeout: 30_000 })
    const mobileItem = mobileAdmin.locator('[data-lobby-mobile-menu="1"] [data-lobby-nav-admin-profile-deletions="1"]')
    await mobileItem.waitFor({ state: 'visible', timeout: 10_000 })
    await mobileItem.click()
    await mobileAdmin.locator('#admin-profile-deletions-panel').waitFor({ state: 'visible', timeout: 15_000 })
    const overflow = await mobileAdmin.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert(overflow <= 1, `хоризонтален скрол: ${overflow}`)

    // Subadmin: админ менюто е налично, но без "Заявки за изтриване".
    const sub = await register(backendPort, 'sub')
    backend!.db.prepare(`UPDATE accounts SET role = 'subadmin' WHERE account_id = ?;`).run(sub.accountId)
    const { page: subPage } = await openApp(sub.cookie)
    await subPage.locator('[data-lobby-nav-admin-toggle="1"]:visible').first().click({ timeout: 30_000 })
    await subPage.locator('[data-lobby-nav-admin-info="1"]:visible').first().waitFor({ state: 'visible', timeout: 10_000 })
    assert((await subPage.locator('[data-lobby-nav-admin-profile-deletions="1"]').count()) === 0, 'пунктът е видим за subadmin')
  })

  await check('[E5] Изключен флаг: бутонът не се показва; директна заявка към API се отказва', async () => {
    backendOff = await startBackend(false)
    currentBackendPort = backendOff.port
    const offVite = await startVite(backendOff.port)
    await vite?.close().catch(() => {})
    vite = offVite.server
    appOrigin = offVite.origin
    const offUser = await register(backendOff.port, 'off')
    const { page: offPage } = await openApp(offUser.cookie)
    const profileButton = offPage.locator('[data-lobby-profile-button="1"]:visible').first()
    await profileButton.waitFor({ state: 'visible', timeout: 30_000 })
    await profileButton.click()
    await offPage.locator('[data-player-profile-edit="1"]').first().waitFor({ state: 'visible', timeout: 15_000 })
    assert((await offPage.locator('[data-player-profile-self-delete="1"]').count()) === 0, 'бутонът при изключен флаг')
    const direct = await offPage.evaluate(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/account/deletion-request`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'SelfDelete1!', confirm: true }) })
      return { status: response.status, body: await response.json() }
    }, backendOff.port)
    assert(direct.status === 404 && direct.body.code === 'PROFILE_SELF_DELETION_DISABLED', JSON.stringify(direct))
    assert(Number((backendOff.db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests;').get() as { c: number }).c) === 0, 'създадена заявка')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
  if (backend !== null) console.error(backend.output.join('').slice(-1500))
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
  await stopBackend(backend)
  await stopBackend(backendOff)
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0

// Общ harness за "Подари и ти" e2e проверките
// (checkGiftBackFromReceivedPopup.ts, checkGiftBackInGame.ts): изолирано
// копие на server/src + празна SQLite база (никога реалната), Vite dev server
// към него, Playwright, верифицирани тестови акаунти и seed на подаръци/баланси.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

let passed = 0
let failed = 0
export async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
export function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg)
}
export function finishAndExit(): never {
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

// Регистрацията изисква email верификация. Изолираният сървър получава
// throwaway EMAIL_VERIFICATION_CODE_SECRET (само в env-а на spawn-натия
// процес) и тестът възстановява 6-цифрения код от СОБСТВЕНАТА си временна
// SQLite база — същия pattern като checkLudoEmojiDiceInteraction.ts.
const EMAIL_VERIFICATION_SECRET = 'gift-back-harness-throwaway-secret-32-chars!'
function recoverVerificationCode(storedHash: string): string {
  for (let n = 0; n < 1_000_000; n += 1) {
    const code = n.toString().padStart(6, '0')
    if (createHmac('sha256', EMAIL_VERIFICATION_SECRET).update(`email-verification-code-v1:${code}`).digest('hex') === storedHash) return code
  }
  throw new Error('could not recover verification code')
}

const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

const projectRoot = process.cwd()

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-gift-back-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(projectRoot, 'server', 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(projectRoot, 'server', 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(projectRoot, 'server', 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env: { ...process.env, PORT: String(port), EMAIL_VERIFICATION_CODE_SECRET: EMAIL_VERIFICATION_SECRET }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function waitForHealth(port: number, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h: any = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}

export type TestProfile = { cookie: string; profileId: string; displayName: string }

export type OpenedPage = {
  page: Page
  context: BrowserContext
  giftSendUrls: string[]
  profileLoadUrls: string[]
  /** WS frames (parsed JSON type + payload), с timestamp. */
  wsSent: Array<{ at: number; type: string; data: any }>
  wsReceived: Array<{ at: number; type: string; data: any }>
}

export type GiftBackHarness = {
  browser: Browser
  db: DatabaseSync
  backendOrigin: string
  appOrigin: string
  runId: string
  CHEAP_ID: string
  PRICEY_ID: string
  CHEAP_PRICE: number
  register: (tag: string) => Promise<TestProfile>
  setBalance: (profileId: string, balance: number) => void
  getBalance: (profileId: string) => number
  txCount: (sender: string, recipient: string) => number
  /** gift_item_transactions редовете sender → recipient (най-новият последен). */
  txRows: (sender: string, recipient: string) => Array<{ transaction_id: string; gift_item_id: string; charged_price: number }>
  sendGiftViaApi: (from: TestProfile, to: TestProfile) => Promise<string>
  openPage: (profile: TestProfile, viewport: { width: number; height: number }, path: string, readySelector: string) => Promise<OpenedPage>
  serverOutput: () => string
  close: () => Promise<void>
}

export async function startGiftBackHarness(): Promise<GiftBackHarness> {
  const isolated = await createIsolatedServerRoot()
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const browser = await chromium.launch({ headless: true })
  const backendPort = await freePort()
  const server = startServer(isolated.serverDir, backendPort)
  let vite: Awaited<ReturnType<typeof createViteServer>> | null = null
  let db: DatabaseSync | null = null

  async function close(): Promise<void> {
    try { db?.close() } catch { /* ignore */ }
    await browser.close().catch(() => undefined)
    await vite?.close().catch(() => undefined)
    server.child.kill()
    await sleep(500)
    await isolated.cleanup()
  }

  try {
    console.log(`Waiting for server on port ${backendPort}...`)
    if (!(await waitForHealth(backendPort))) { console.error(server.output()); throw new Error('server did not become ready') }
    console.log('Server ready.\n')

    const vitePort = await freePort()
    vite = await createViteServer({
      root: projectRoot,
      server: { host: '127.0.0.1', port: vitePort, strictPort: true },
      logLevel: 'error',
      plugins: [{
        name: 'gift-back-isolated-backend',
        enforce: 'pre',
        transform(code, id) {
          if (!id.includes('/src/') && !id.includes('\\src\\')) return null
          return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
        },
      }],
    })
    await vite.listen()
  } catch (error) {
    await close()
    throw error
  }

  const appOrigin = `http://127.0.0.1:${(vite.httpServer?.address() as { port: number }).port}`
  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const dbPath = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 5000;')
  const database = db

  const CHEAP_ID = `gb-cheap-${runId}`
  const PRICEY_ID = `gb-pricey-${runId}`
  const CHEAP_PRICE = 50
  const insertGift = database.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, ?)`)
  insertGift.run(CHEAP_ID, 'Роза GB', '/favicon.ico', CHEAP_PRICE, 1)
  insertGift.run(PRICEY_ID, 'Диамант GB', '/favicon.ico', 9_000_000, 2)

  async function register(tag: string): Promise<TestProfile> {
    const email = `gift-back-${tag}-${runId}@example.test`
    const displayName = `GB${tag.toUpperCase()}${runId.slice(-5)}`
    const registerRes = await fetch(`${backendOrigin}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'GiftBack1!', displayName, gender: 'male', visitorId: randomUUID() }),
    })
    const registerBody: any = await registerRes.json()
    // EMAIL_DELIVERY_FAILED (503) е очаквано (няма BREVO_API_KEY) — pending
    // редът се създава въпреки това.
    if (registerRes.status !== 503 || registerBody.code !== 'EMAIL_DELIVERY_FAILED') {
      throw new Error(`register ${tag}: unexpected ${registerRes.status} ${JSON.stringify(registerBody)}`)
    }
    const pendingRegistrationId = registerBody.pendingRegistrationId as string
    const row = database.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined
    if (!row) throw new Error(`register ${tag}: pending row not found`)
    const verifyRes = await fetch(`${backendOrigin}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code: recoverVerificationCode(row.code_hash) }),
    })
    const verifyBody: any = await verifyRes.json()
    if (verifyRes.status !== 200) throw new Error(`verify ${tag} failed: ${JSON.stringify(verifyBody)}`)
    const setCookie = (verifyRes.headers.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie'))?.split(';')[0] ?? null
    if (!setCookie) throw new Error('no cookie returned')
    return { cookie: setCookie.split('=')[1]!, profileId: verifyBody.session.profile.profileId as string, displayName }
  }

  function setBalance(profileId: string, balance: number): void {
    database.prepare(`
      INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance
    `).run(profileId, balance)
  }
  function getBalance(profileId: string): number {
    return (database.prepare(`SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?`).get(profileId) as { b: number } | undefined)?.b ?? 0
  }
  function txCount(sender: string, recipient: string): number {
    return (database.prepare(`SELECT COUNT(*) AS n FROM gift_item_transactions WHERE sender_profile_id = ? AND recipient_profile_id = ?`).get(sender, recipient) as { n: number }).n
  }

  function txRows(sender: string, recipient: string): Array<{ transaction_id: string; gift_item_id: string; charged_price: number }> {
    return database.prepare(`SELECT transaction_id, gift_item_id, charged_price FROM gift_item_transactions WHERE sender_profile_id = ? AND recipient_profile_id = ? ORDER BY created_at ASC, rowid ASC`).all(sender, recipient) as Array<{ transaction_id: string; gift_item_id: string; charged_price: number }>
  }

  async function sendGiftViaApi(from: TestProfile, to: TestProfile): Promise<string> {
    const res = await fetch(`${backendOrigin}/api/profile/${encodeURIComponent(to.profileId)}/send-gift-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${from.cookie}` },
      body: JSON.stringify({ giftItemId: CHEAP_ID, requestId: `api-${Math.random().toString(36).slice(2)}` }),
    })
    const body: any = await res.json()
    if (!body.ok) throw new Error(`api send failed: ${JSON.stringify(body)}`)
    return body.transaction.transactionId as string
  }

  async function openPage(
    profile: TestProfile,
    viewport: { width: number; height: number },
    path: string,
    readySelector: string,
  ): Promise<OpenedPage> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    // Consent банерът не е предмет на теста — задаваме валиден consent
    // предварително (същата форма като src/app/consent/consentState.ts).
    await context.addInitScript(() => {
      try {
        localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() }))
      } catch { /* ignore */ }
    })
    const page = await context.newPage()
    const opened: OpenedPage = { page, context, giftSendUrls: [], profileLoadUrls: [], wsSent: [], wsReceived: [] }
    page.on('request', (req) => {
      const url = req.url()
      if (url.includes('/send-gift-item')) opened.giftSendUrls.push(url)
      if (/\/api\/profiles\/[^/?]+$/.test(url.split('?')[0]!)) opened.profileLoadUrls.push(url)
    })
    page.on('websocket', (ws) => {
      const parse = (payload: string | Buffer) => {
        try {
          const data = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf8'))
          return { at: Date.now(), type: String(data?.type ?? ''), data }
        } catch {
          return null
        }
      }
      ws.on('framesent', (frame) => { const p = parse(frame.payload); if (p) opened.wsSent.push(p) })
      ws.on('framereceived', (frame) => { const p = parse(frame.payload); if (p) opened.wsReceived.push(p) })
    })
    await page.goto(`${appOrigin}${path}`)
    await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: 25_000 })
    await page.waitForTimeout(800)
    return opened
  }

  return {
    browser,
    db: database,
    backendOrigin,
    appOrigin,
    runId,
    CHEAP_ID,
    PRICEY_ID,
    CHEAP_PRICE,
    register,
    setBalance,
    getBalance,
    txCount,
    txRows,
    sendGiftViaApi,
    openPage,
    serverOutput: () => server.output(),
    close,
  }
}

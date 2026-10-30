/**
 * „Теми“ — прочетено по ръчно преминаване, РЕАЛЕН сървър + РЕАЛЕН клиент.
 *
 * Изолиран сървър (temp SQLite, истински topic_thread_read_state) на :3001 и
 * истинският main.ts през Vite на :5173 (getApiBaseUrl/WS сочат към :3001
 * за localhost) — истинска сесия, истински POST .../seen, истински броячи.
 * Проверките четат сървъра (API + базата), не mock.
 *
 * Production бъг: при 45 непрочетени и скрол до края значката оставаше ~45 —
 * старото правило (60% видимост за 0,6 s) не броеше бързо преминатите
 * отговори, а последователната граница спираше на първия от тях.
 *
 *  [R1] 45 непрочетени → бавно до края → 0 (сървър, база, значка)
 *  [R2] 45 непрочетени → бързо (колелце) до края → 0
 *  [R3] 45 непрочетени → бързи свайп-подобни жестове (fling; headless не скролва touch) → 0
 *  [R4] 45 непрочетени → до 10-ия → 35; излизане веднага
 *  [R5] излизане веднага след последния → 0; повторно отваряне в края без разделител; refresh
 *  [R6] 200 непрочетени (няколко страници, sliding window освобождава) → бързо до края → 0
 *  [R7] много дълги отговори → бързо до края → 0
 *  [R8] програмен прескок до края (собствен отговор → „покажи“) → прескочените остават
 *  [R9] без лавина от заявки
 */
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const PASSWORD = 'TopicReadRealE2E1!'
const API = 'http://127.0.0.1:3001'
const APP = 'http://127.0.0.1:5173'
const GENERAL = 'topic-general'
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  const only = process.env.TOPIC_THREAD_ONLY?.split(',').filter(Boolean) ?? []
  if (only.length > 0 && !only.some((part) => label.includes(part))) return
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const srv = createNetServer()
    srv.once('error', () => done(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => done(true)))
  })
}

const projectRoot = process.cwd()
const serverRoot = resolve(projectRoot, 'server')
let tempRoot: string | null = null
let child: ChildProcessWithoutNullStreams | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null
const serverOutput: string[] = []

let ipCounter = 0
async function api(method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; json: any; cookie: string }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'X-Forwarded-For': `198.51.100.${(ipCounter += 1) % 250}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  const setCookie = ((res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith('belot_session='))
  return { status: res.status, json, cookie: setCookie?.split(';')[0] ?? '' }
}

console.log('\ncheckTopicThreadReadRealServerE2E\n')

try {
  assert(await isPortFree(3001) && await isPortFree(5173), 'ports 3001/5173 must be free (the client targets :3001 on localhost)')

  // ── изолиран сървър ──
  tempRoot = await mkdtemp(join(tmpdir(), 'belot-topic-read-e2e-'))
  const serverDir = join(tempRoot, 'server')
  await mkdir(serverDir, { recursive: true })
  for (const part of ['src', 'dist']) await cp(join(serverRoot, part), join(serverDir, part), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverRoot, 'package.json'), join(serverDir, 'package.json'))
  await symlink(join(serverRoot, 'node_modules'), join(serverDir, 'node_modules'), 'junction')
  await symlink(join(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction')
  const dbFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')
  child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: '3001', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1', PASSWORD_RESET_RATE_LIMIT_SECRET: 'topic-read-real-e2e-secret-0123456789-0123456789' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => serverOutput.push(String(chunk)))
  child.stderr.on('data', (chunk) => serverOutput.push(String(chunk)))
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`${API}/api/rooms`)).ok) break } catch { /* not yet */ }
    await sleep(100)
  }
  const withDb = <T>(fn: (db: DatabaseSync) => T): T => { const db = new DatabaseSync(dbFile); try { return fn(db) } finally { db.close() } }
  withDb((db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  async function registerUser(label: string): Promise<{ cookie: string; profileId: string }> {
    const email = `tre-${label}-${randomUUID().slice(0, 6)}@example.test`
    const reg = await api('POST', '/api/auth/register', { email, password: PASSWORD, displayName: `Tre${label}${randomUUID().slice(0, 4)}`, gender: 'male', visitorId: randomUUID() })
    assert(reg.status === 200, `register ${label}: ${reg.status} ${JSON.stringify(reg.json)}`)
    const login = await api('POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
    return { cookie: login.cookie, profileId: login.json.session.profile.profileId }
  }
  const viewer = await registerUser('viewer')
  const author = await registerUser('author')
  await api('GET', '/api/topics', undefined, viewer.cookie)

  const { createTopicMessageStore } = await import('../server/src/db/topicMessageStore.ts')
  const store = await createTopicMessageStore(dbFile)

  /** Нишка: readCount прочетени + unreadCount непрочетени; връща seq-овете на непрочетените. */
  function seedThread(readCount: number, unreadCount: number, bodyFor: (i: number) => string): { rootId: string; unreadSeqs: number[] } {
    const root = store.insertMessage({ topicId: GENERAL, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: `Тема ${randomUUID().slice(0, 6)}` })
    let lastRead = root.seq
    for (let i = 1; i <= readCount; i++) {
      const r = store.insertReply({ topicId: GENERAL, parentMessageId: root.messageId, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: `Прочетен ${i} ${'текст '.repeat(8 + (i % 4) * 6)}` })
      if (r.ok) lastRead = r.message.seq
    }
    withDb((db) => db.prepare('INSERT INTO topic_thread_read_state (profile_id, root_message_id, last_seen_seq) VALUES (?, ?, ?)').run(viewer.profileId, root.messageId, lastRead))
    const unreadSeqs: number[] = []
    for (let i = 1; i <= unreadCount; i++) {
      const r = store.insertReply({ topicId: GENERAL, parentMessageId: root.messageId, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: bodyFor(i) })
      if (r.ok) unreadSeqs.push(r.message.seq)
    }
    return { rootId: root.messageId, unreadSeqs }
  }
  const normalBody = (i: number) => `Нов ${i} ${'текст на нов отговор '.repeat(4 + (i % 5) * 5)}`

  const serverThreadUnread = async (rootId: string): Promise<number> => {
    const res = await api('GET', `/api/topics/${GENERAL}/messages?limit=50`, undefined, viewer.cookie)
    return (res.json.messages as Array<{ messageId: string; unreadCount: number }>).find((m) => m.messageId === rootId)?.unreadCount ?? -1
  }
  const dbLastSeen = (rootId: string): number => withDb((db) =>
    (db.prepare('SELECT last_seen_seq AS s FROM topic_thread_read_state WHERE profile_id = ? AND root_message_id = ?').get(viewer.profileId, rootId) as { s: number }).s)
  async function waitForServerUnread(rootId: string, expected: number, timeoutMs = 4000): Promise<number> {
    const deadline = Date.now() + timeoutMs
    let value = await serverThreadUnread(rootId)
    while (value !== expected && Date.now() < deadline) {
      await sleep(150)
      value = await serverThreadUnread(rootId)
    }
    return value
  }

  await sleep(900)
  vite = await createViteServer({ root: projectRoot, server: { port: 5173, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  type Session = { context: BrowserContext; page: Page; requests: string[]; errors: string[] }
  async function openSession(mobile: boolean): Promise<Session> {
    const context = await browser!.newContext(mobile ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 900 } })
    await context.addCookies([{ name: 'belot_session', value: viewer.cookie.split('=')[1]!, domain: '127.0.0.1', path: '/' }])
    const page = await context.newPage()
    const requests: string[] = []
    const errors: string[] = []
    page.on('request', (r) => { if (/\/replies|\/seen/.test(r.url())) requests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`) })
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${APP}/topics`)
    // Банерът за бисквитки (нов браузър) покрива долната част — приема се като от потребител.
    const accept = page.locator('[data-consent-accept-all="1"]')
    if (await accept.isVisible({ timeout: 5000 }).catch(() => false)) await accept.click()
    return { context, page, requests, errors }
  }
  async function openGeneralList(page: Page): Promise<void> {
    await page.waitForSelector('[data-topics-back-to-general="1"]', { timeout: 30_000 })
    await page.click('[data-topics-back-to-general="1"]')
  }
  async function openThread(page: Page, rootId: string): Promise<void> {
    await page.waitForSelector(`[data-topic-card-open="${rootId}"]`, { timeout: 15_000 })
    await page.click(`[data-topic-card-open="${rootId}"]`)
    await page.waitForSelector('[data-topic-replies-section] [data-topic-reply]', { timeout: 15_000 })
    await sleep(300)
  }
  const bottomDistance = (page: Page) => page.evaluate(() => {
    const s = document.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')!
    return s.scrollHeight - s.scrollTop - s.clientHeight
  })
  const lastLoadedSeq = (page: Page) => page.evaluate(() => {
    const all = document.querySelectorAll<HTMLElement>('[data-topic-replies-section] [data-topic-reply]')
    return Number(all[all.length - 1]?.dataset.topicThreadSeq ?? 0)
  })
  async function scrollToEnd(page: Page, lastSeq: number, step: () => Promise<void>): Promise<void> {
    for (let i = 0; i < 600; i++) {
      if ((await lastLoadedSeq(page)) === lastSeq && (await bottomDistance(page)) <= 2) return
      await step()
    }
    throw new Error('did not reach the end of the thread')
  }
  async function pointerOnThread(page: Page): Promise<{ x: number; y: number; height: number }> {
    const box = (await page.locator('[data-topic-thread-scroll="1"]').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height }
  }
  async function backToList(page: Page): Promise<void> {
    await page.click('[data-topic-thread-back="1"]')
    await page.waitForSelector('[data-topic-card-open]', { timeout: 10_000 })
  }
  const cardBadge = (page: Page, rootId: string) => page.locator(`[data-topic-thread-unread-badge="${rootId}"]`).textContent({ timeout: 300 }).catch(() => null)

  for (const mobile of [true, false]) {
    const vp = mobile ? 'mobile-390' : 'desktop'

    await check(`[${vp}] [R1] 45 непрочетени → бавно скролване до края → 0`, async () => {
      const { rootId, unreadSeqs } = seedThread(5, 45, normalBody)
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        assert((await cardBadge(s.page, rootId)) === '45', 'badge 45 before')
        await openThread(s.page, rootId)
        const p = await pointerOnThread(s.page)
        await scrollToEnd(s.page, unreadSeqs[44]!, async () => { await s.page.mouse.wheel(0, Math.round(p.height * 0.35)); await sleep(350) })
        await backToList(s.page)
        assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
        assert(dbLastSeen(rootId) === unreadSeqs[44], `db read cursor ${dbLastSeen(rootId)}`)
        await sleep(300)
        assert((await cardBadge(s.page, rootId)) === null, 'badge cleared')
        assert(s.errors.length === 0, s.errors.join(' | '))
      } finally { await s.context.close() }
    })

    await check(`[${vp}] [R2] 45 непрочетени → бързо скролване до края → 0`, async () => {
      const { rootId, unreadSeqs } = seedThread(5, 45, normalBody)
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        await openThread(s.page, rootId)
        await pointerOnThread(s.page)
        await scrollToEnd(s.page, unreadSeqs[44]!, async () => { await s.page.mouse.wheel(0, 2500); await sleep(40) })
        await backToList(s.page)
        assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
        await sleep(300)
        assert((await cardBadge(s.page, rootId)) === null, 'badge cleared')
      } finally { await s.context.close() }
    })

    if (mobile) {
      // Headless Chromium не скролва синтезирани TOUCH жестове изобщо (проверено
      // и на празна страница: 0 → 0). Свайп с инерция се симулира с бърз
      // синтезиран scroll жест — големи скокове между кадрите и асинхронни
      // скрол събития, както при fling на телефон. Логиката не зависи от вида
      // на входа (работи по скрол позицията).
      await check(`[${vp}] [R3] 45 непрочетени → бързи свайп-подобни жестове (fling) → 0`, async () => {
        const { rootId, unreadSeqs } = seedThread(5, 45, normalBody)
        const s = await openSession(true)
        try {
          await openGeneralList(s.page)
          await openThread(s.page, rootId)
          const p = await pointerOnThread(s.page)
          const cdp = await s.context.newCDPSession(s.page)
          await scrollToEnd(s.page, unreadSeqs[44]!, async () => {
            await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(p.x), y: Math.round(p.y), yDistance: -Math.round(p.height * 2.5), speed: 25_000, gestureSourceType: 'mouse' })
          })
          await backToList(s.page)
          assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
        } finally { await s.context.close() }
      })
    }

    await check(`[${vp}] [R4] 45 непрочетени → скрол до 10-ия → 35; излизане веднага`, async () => {
      // №11 е дълъг (няколко екрана) — краят му не може да влезе в изгледа заедно с №10.
      const { rootId, unreadSeqs } = seedThread(5, 45, (i) => i === 11 ? `Дълъг ${i} ${'много дълъг текст '.repeat(400)}` : normalBody(i))
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        await openThread(s.page, rootId)
        await pointerOnThread(s.page)
        for (let i = 0; i < 400; i++) {
          const reached = await s.page.evaluate((seq) => {
            const scroll = document.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')!
            const el = document.querySelector<HTMLElement>(`[data-topic-thread-seq="${seq}"]`)
            return el !== null && el.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom
          }, unreadSeqs[9])
          if (reached) break
          await s.page.mouse.wheel(0, 60)
          await sleep(30)
        }
        await backToList(s.page)
        assert((await waitForServerUnread(rootId, 35)) === 35, `server unread ${await serverThreadUnread(rootId)} (expected 35)`)
        assert(dbLastSeen(rootId) === unreadSeqs[9], `db read cursor ${dbLastSeen(rootId)} vs №10 ${unreadSeqs[9]}`)
        await sleep(300)
        assert((await cardBadge(s.page, rootId)) === '35', `badge ${await cardBadge(s.page, rootId)}`)
        await openThread(s.page, rootId)
        const dividerNext = await s.page.evaluate(() => Number((document.querySelector('[data-topic-thread-unread-divider="1"]')?.nextElementSibling as HTMLElement | null)?.dataset.topicThreadSeq ?? 0))
        assert(dividerNext === unreadSeqs[10], `divider before №11 (got ${dividerNext})`)
      } finally { await s.context.close() }
    })

    await check(`[${vp}] [R5] излизане веднага след последния; повторно отваряне в края без разделител; refresh`, async () => {
      const { rootId, unreadSeqs } = seedThread(5, 45, normalBody)
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        await openThread(s.page, rootId)
        await pointerOnThread(s.page)
        await scrollToEnd(s.page, unreadSeqs[44]!, async () => { await s.page.mouse.wheel(0, 1800); await sleep(40) })
        await s.page.click('[data-topic-thread-back="1"]') // без изчакване
        assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
        await s.page.waitForSelector('[data-topic-card-open]', { timeout: 10_000 })
        await openThread(s.page, rootId)
        assert((await s.page.locator('[data-topic-thread-unread-divider="1"]').count()) === 0, 'no divider after reading')
        assert((await bottomDistance(s.page)) <= 8, 'reopens at the last reply')
        await s.page.reload()
        await openGeneralList(s.page)
        await s.page.waitForSelector(`[data-topic-card-open="${rootId}"]`, { timeout: 15_000 })
        await sleep(300)
        assert((await cardBadge(s.page, rootId)) === null, 'no badge after refresh')
      } finally { await s.context.close() }
    })

    await check(`[${vp}] [R6] 200 непрочетени (sliding window освобождава) → бързо до края → 0, ≤120 в DOM, без лавина`, async () => {
      const { rootId, unreadSeqs } = seedThread(5, 200, normalBody)
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        await openThread(s.page, rootId)
        await pointerOnThread(s.page)
        await scrollToEnd(s.page, unreadSeqs[199]!, async () => { await s.page.mouse.wheel(0, 2500); await sleep(60) })
        const domCount = await s.page.locator('[data-topic-replies-section] [data-topic-reply]').count()
        assert(domCount <= 120, `DOM ${domCount}`)
        const pageRequests = s.requests.filter((r) => r.startsWith('GET') && /after=|before=/.test(r)).length
        assert(pageRequests <= Math.ceil(205 / 30) + 2, `[R9] ${pageRequests} page requests for 205 replies`)
        await backToList(s.page)
        assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
      } finally { await s.context.close() }
    })

    await check(`[${vp}] [R7] много дълги отговори → бързо до края → 0`, async () => {
      const { rootId, unreadSeqs } = seedThread(5, 45, (i) => `Дълъг ${i} ${'дълъг текст на отговора '.repeat(120)}`)
      const s = await openSession(mobile)
      try {
        await openGeneralList(s.page)
        await openThread(s.page, rootId)
        await pointerOnThread(s.page)
        await scrollToEnd(s.page, unreadSeqs[44]!, async () => { await s.page.mouse.wheel(0, 3000); await sleep(40) })
        await backToList(s.page)
        assert((await waitForServerUnread(rootId, 0)) === 0, `server unread ${await serverThreadUnread(rootId)}`)
      } finally { await s.context.close() }
    })
  }

  await check('[desktop] [R8] програмен прескок до края (собствен отговор → „покажи“) → прескочените остават непрочетени', async () => {
    const claim = await api('POST', '/api/vip/claim-launch-gift', {}, viewer.cookie)
    assert(claim.status === 200 || claim.json?.alreadyClaimed === true, `VIP claim: ${claim.status} ${JSON.stringify(claim.json)}`)
    const { rootId, unreadSeqs } = seedThread(5, 250, normalBody)
    const s = await openSession(false)
    try {
      await openGeneralList(s.page)
      await openThread(s.page, rootId)
      await sleep(500)
      const atOpen = dbLastSeen(rootId)
      await s.page.fill('[data-topics-reply-composer-text="1"]', 'Собствен отговор от средата')
      await s.page.evaluate(() => document.querySelector<HTMLFormElement>('[data-topics-reply-composer-form="1"]')!.requestSubmit())
      await s.page.waitForSelector('[data-topic-thread-own-reply-reveal="1"]', { timeout: 10_000 })
      await s.page.click('[data-topic-thread-own-reply-reveal="1"]')
      await s.page.waitForFunction(() => {
        const s2 = document.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')!
        return s2.scrollHeight - s2.scrollTop - s2.clientHeight <= 8
      }, undefined, { timeout: 15_000 })
      await sleep(800)
      await backToList(s.page)
      await sleep(800)
      const cursor = dbLastSeen(rootId)
      assert(cursor < unreadSeqs[60]!, `programmatic jump marked skipped replies (cursor ${cursor}, at open ${atOpen})`)
      assert((await serverThreadUnread(rootId)) > 180, `server unread ${await serverThreadUnread(rootId)}`)
    } finally { await s.context.close() }
  })

  store.close()
} catch (error) {
  failed++
  console.error(`  FAIL  harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(serverOutput.join('').slice(-3000))
} finally {
  await browser?.close()
  await vite?.close()
  if (child && child.exitCode === null) {
    child.kill()
    await sleep(1500)
  }
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
}

if (failed > 0) {
  console.error(`\ncheckTopicThreadReadRealServerE2E: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncheckTopicThreadReadRealServerE2E: ${passed} passed, 0 failed`)

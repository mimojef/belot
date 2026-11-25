// checkLudoErrorIsolationE2E.ts — Етап 1, обратната посока: чужди грешки не
// влияят на „Не се сърди човече“, а нормалното откриване/възстановяване на
// активен Ludo мач е запазено.
//
// Реален сървър (изолирано копие) + реален Vite + реалното приложение
// (src/main.ts) в Chromium. WebSocket-ът минава през context.routeWebSocket:
// кадрите се наблюдават, могат да се задържат и да се инжектират съобщения
// към страницата (все едно от сървъра).
//
//   [L1] Ludo лоби: грешка от Белот маса (requestType submit_play_card) не се
//        показва; обща грешка и Ludo грешка се показват както досега
//   [L2] Ludo мач: хвърлянето е в полет (задържано) + чужди грешки (Белот и
//        обща) -> зарът НЕ се връща; после хвърлянето минава нормално
//   [L3] прекъсване на WS по време на Ludo мач -> при connected се праща
//        ludo_game_state_request и мачът остава/се възстановява
//   [L4] refresh по време на Ludo мач -> проба + мачът се показва отново
//   [L5] без грешки в конзолата
//
//   node server/node_modules/tsx/dist/cli.mjs scripts/checkLudoErrorIsolationE2E.ts
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): asserts condition {
  if (!condition) throw new Error(msg)
}
async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(100)
  }
  throw new Error(`timeout: ${label}`)
}

type Frame = { type: string; data: any }
type Client = {
  page: Page
  context: BrowserContext
  sent: Frame[]
  received: Frame[]
  errors: string[]
  inject: (payload: Record<string, unknown>) => void
  holdNext: (type: string) => void
  releaseHeld: () => void
  dropSocket: () => void
}
const parse = (m: string | Buffer): Frame | null => {
  try { const d = JSON.parse(typeof m === 'string' ? m : m.toString('utf8')); return typeof d?.type === 'string' ? { type: d.type, data: d } : null } catch { return null }
}

const FOREIGN_BELOT_TEXT = 'ЧУЖДА-БЕЛОТ-ГРЕШКА-e2e'
const GENERAL_TEXT = 'ОБЩА-ГРЕШКА-e2e'
const LUDO_OWN_TEXT = 'LUDO-СОБСТВЕНА-ГРЕШКА-e2e'

console.log('\ncheckLudoErrorIsolationE2E\n')
// Изолиран сървър + Vite + регистрация (email код от изолираната база) —
// същата инфраструктура като checkActiveRoomSoftReconnectE2E.
const h = await startGiftBackHarness()
const browser = h.browser

try {
  const appOrigin = h.appOrigin
  const backendOrigin = h.backendOrigin
  const registerFunded = async (tag: string): Promise<TestProfile> => {
    const profile = await h.register(tag)
    h.setBalance(profile.profileId, 50_000_000)
    return profile
  }

  async function open(profile: { cookie: string }): Promise<Client> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const sent: Frame[] = []
    const received: Frame[] = []
    let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null
    let holdType: string | null = null
    let held: string | Buffer | null = null
    await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
      const upstream = ws.connectToServer()
      ws.onMessage((m) => {
        const f = parse(m)
        if (f) sent.push(f)
        if (f && holdType !== null && f.type === holdType && held === null) { held = m; holdType = null; return }
        upstream.send(m)
      })
      upstream.onMessage((m) => { const f = parse(m); if (f) received.push(f); ws.send(m) })
      ws.onClose(() => upstream.close())
      upstream.onClose(() => ws.close())
      current = { page: ws, server: upstream }
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(400)
    return {
      page, context, sent, received, errors,
      inject: (payload) => current?.page.send(JSON.stringify(payload)),
      holdNext: (type) => { holdType = type; held = null },
      releaseHeld: () => { if (held !== null && current) current.server.send(held); held = null },
      dropSocket: () => { const c = current; current = null; c?.server.close(); c?.page.close({ code: 4001, reason: 'e2e drop' }) },
    }
  }
  const textVisible = (page: Page, text: string) => page.locator(`text=${text}`).first().isVisible().catch(() => false)
  async function assertNeverVisible(page: Page, text: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await textVisible(page, text)) throw new Error(`"${text}" се показа`)
      await sleep(120)
    }
  }

  const a = await open(await registerFunded('a'))
  const b = await open(await registerFunded('b'))

  await check('[L1] Ludo лоби: грешка от Белот маса не се показва; обща и Ludo грешка — както досега', async () => {
    a.inject({ type: 'error', message: FOREIGN_BELOT_TEXT, requestType: 'submit_play_card' })
    await assertNeverVisible(a.page, FOREIGN_BELOT_TEXT, 1_500)
    a.inject({ type: 'error', message: GENERAL_TEXT, requestType: 'send_lobby_chat_message' })
    await waitUntil('общата грешка се показва', () => textVisible(a.page, GENERAL_TEXT), 5_000)
    a.inject({ type: 'error', message: LUDO_OWN_TEXT, requestType: 'join_ludo_room' })
    await waitUntil('Ludo грешката се показва', () => textVisible(a.page, LUDO_OWN_TEXT), 5_000)
  })

  // Мач с двама играчи.
  await a.page.locator('[data-ludo-create-open="1"]').click()
  await a.page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
  await a.page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
  const stakeSelect = a.page.locator('[data-ludo-create-form="1"] select[name="stake"]')
  await stakeSelect.selectOption((await stakeSelect.locator('option').first().getAttribute('value'))!)
  await a.page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  await a.page.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  await b.page.reload()
  await b.page.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 15_000 })
  await b.page.locator('[data-ludo-room-join]').first().click()
  await a.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
  await b.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })

  const rollButtonVisible = (c: Client) => c.page.locator('[data-ludo-dice-roll-button="1"]').first().isVisible().catch(() => false)
  const roller = await waitUntil('чий ред е', async () => ((await rollButtonVisible(a)) ? a : (await rollButtonVisible(b)) ? b : null), 15_000)
  const other = roller === a ? b : a

  await check('[L2] хвърлянето е в полет + чужди грешки (Белот и обща) -> зарът не се връща; после хвърлянето минава', async () => {
    const stateFramesBefore = roller.received.filter((f) => f.type === 'ludo_game_state').length
    roller.holdNext('ludo_roll_request')
    await roller.page.locator('[data-ludo-dice-roll-button="1"]').first().click()
    await waitUntil('ludo_roll_request задържан', () => roller.sent.some((f) => f.type === 'ludo_roll_request'), 5_000)
    await waitUntil('зарът е скрит (хвърлянето започна)', async () => !(await rollButtonVisible(roller)), 3_000)
    roller.inject({ type: 'error', message: FOREIGN_BELOT_TEXT, requestType: 'submit_play_card' })
    roller.inject({ type: 'error', message: GENERAL_TEXT, requestType: 'send_lobby_chat_message' })
    await sleep(900)
    assert(!(await rollButtonVisible(roller)), 'чужда грешка върна зара, докато хвърлянето е в полет')
    roller.releaseHeld()
    await waitUntil('отговорът на хвърлянето', () => roller.received.filter((f) => f.type === 'ludo_game_state').length > stateFramesBefore, 8_000)
    assert(!(await textVisible(roller.page, FOREIGN_BELOT_TEXT)), 'чуждата Белот грешка се показа в Ludo')
  })

  await check('[L3] прекъсване на WS по време на мача -> при connected се праща ludo_game_state_request; мачът остава', async () => {
    const sentFrom = other.sent.length
    const receivedFrom = other.received.length
    other.dropSocket()
    await waitUntil('нова връзка + connected', () => other.received.slice(receivedFrom).some((f) => f.type === 'connected'), 20_000)
    await waitUntil('проба за Ludo мач', () => other.sent.slice(sentFrom).some((f) => f.type === 'ludo_game_state_request'), 10_000)
    await waitUntil('ludo_game_state', () => other.received.slice(receivedFrom).some((f) => f.type === 'ludo_game_state'), 10_000)
    await other.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 10_000 })
  })

  await check('[L4] refresh по време на мача -> проба + мачът се показва отново', async () => {
    const sentFrom = other.sent.length
    await other.page.reload()
    await waitUntil('проба след refresh', () => other.sent.slice(sentFrom).some((f) => f.type === 'ludo_game_state_request'), 20_000)
    await other.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
  })

  await check('[L5] без грешки в конзолата', () => {
    assert(a.errors.length === 0 && b.errors.length === 0, JSON.stringify([...a.errors, ...b.errors].slice(0, 3)))
  })

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await h.close()
}

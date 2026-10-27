/**
 * checkBelotVisualClient.ts
 *
 * "Визия на Белот" — реален Chromium (Playwright) + реален production код.
 *
 * Маса (createActiveRoomFlowController през activeRoomSpectatorHarness):
 *  [R1] ръчната визия (belotVisual) има предимство пред кампанията — маса и гръб.
 *  [R2] телефон (390×844) → mobile URL, не desktop URL; desktop → обратното.
 *  [R3] липсващо ръчно изображение → сървърът подава кампанийното → показва се то.
 *  [R4] belotVisual с null-ове (изключена, без кампанийни изображения) →
 *       стандартната визия, дори ако theme е налична (клиентът НЕ пада сам
 *       към theme, щом сървърът е разрешил визията).
 *  [R5] стар сървър без belotVisual → кампанийната тема, както преди.
 *  [R6] превключване на живо по време на игра (ръчна → кампания → ръчна),
 *       без reload/re-enter; стандартният гръб остава като резервен слой.
 *  [R7] стабилна bidding снимка + само belotVisual промяна → прерисува се.
 *  [F1-F7] ръчно изображение, което липсва (404) или е повредено, или не се
 *       зарежда → само този слот минава към кампанията, а без кампания — към
 *       стандартната визия; независимо за Desktop/Mobile/гръб; всеки URL се
 *       проверява най-много веднъж (без повторни опити); нов URL работи отново;
 *       пътят само с кампания е непроменен.
 *
 * Админ секция (adminBelotVisualSectionHarness):
 *  [A1] превключвател изключен по подразбиране, статус "Изключена", трите слота.
 *  [A2] превключването вика onToggle с новата стойност.
 *  [A3] качване (PNG/JPEG/WebP) → onUpload(kind, data URL); преглед + "Замени"/"Премахни".
 *  [A4] "Премахни" с потвърждение → onRemove(kind); отказ → нищо.
 *  [A5] busy → контролите са неактивни; грешка/успех се показват.
 *  [A6] телефон → без хоризонтален overflow.
 *  [A7] кампанийният виджет (споделен) дава същия HTML като преди.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import sharp from 'sharp'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = {
  enterAsParticipant: (roomId: string, seat?: string) => Promise<void>
  applyParticipantSnapshot: (roomId: string, game: unknown, seats?: unknown, yourSeat?: string) => Promise<void>
  render: () => Promise<void>
  biddingGame: (overrides?: unknown) => unknown
  playingGame: (overrides?: unknown) => unknown
  makeSeats: () => unknown
  getCurrentRoomIdFn: () => string | null
  injectServerMessage: (message: unknown) => Promise<boolean>
}

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

const has = (page: Page, needle: string) => page.evaluate((n) => document.body.innerHTML.includes(n), needle)
const push = (page: Page, message: unknown) => call(page, (h: H, m: unknown) => h.injectServerMessage(m), message)

const CAMPAIGN = {
  unitIconUrl: null,
  tableBgDesktopUrl: '/uploads/campaign-themes/camp-1/tables/c-desk.webp',
  tableBgMobileUrl: '/uploads/campaign-themes/camp-1/tables/c-mob.webp',
  cardBackUrl: '/uploads/campaign-themes/camp-1/card-backs/c-back.webp',
  packageUnits: {},
}
const MANUAL = {
  tableBgDesktopUrl: '/uploads/campaign-themes/belot-visual/tables/m-desk.webp',
  tableBgMobileUrl: '/uploads/campaign-themes/belot-visual/tables/m-mob.webp',
  cardBackUrl: '/uploads/campaign-themes/belot-visual/card-backs/m-back.webp',
}
const DEFAULT_CARD_BACK = '/images/cards/card-back.webp'

// Кампанийният виджет преди извеждането в renderThemeAssetWidget.ts (git HEAD).
function legacyCampaignWidget(kind: string, label: string, url: string | null, accept: string): string {
  const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  const previewHtml = url
    ? `<img src="${esc(url)}" alt="${esc(label)}" style="max-width:170px;max-height:96px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);object-fit:cover;background:#000;">`
    : `<div style="width:170px;height:96px;border-radius:6px;border:1px dashed rgba(255,255,255,0.22);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.35);font-size:11px;font-weight:800;">По подразбиране</div>`
  return `
    <div data-admin-campaign-theme-widget="${kind}" style="display:flex;flex-direction:column;gap:8px;min-width:170px;">
      <div style="font-size:11px;font-weight:900;color:rgba(255,255,255,0.6);">${esc(label)}</div>
      ${previewHtml}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <label style="height:30px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid rgba(147,197,253,0.35);border-radius:6px;background:rgba(30,64,175,0.22);color:#bfdbfe;font-size:11px;font-weight:900;cursor:pointer;">
          ${url ? 'Замени' : 'Качи'}
          <input data-admin-campaign-theme-upload="${kind}" type="file" accept="${accept}" style="display:none;">
        </label>
        ${url ? `<button type="button" data-admin-campaign-theme-remove="${kind}" style="height:30px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.30);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;">Премахни</button>` : ''}
      </div>
    </div>
  `
}

console.log('\ncheckBelotVisualClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  // /uploads/** се обслужва от теста: валиден WebP, освен "missing" (404),
  // "corrupt" (повредени байтове) и "offline" (мрежова грешка).
  const validWebp = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#335533' } }).webp().toBuffer()
  const uploadRequests = new Map<string, number>()
  async function newPage(url: string, readyGlobal: string, viewport = { width: 1280, height: 900 }): Promise<{ page: Page; errors: string[] }> {
    const context = await browser!.newContext({ viewport })
    const page = await context.newPage()
    await page.route('**/uploads/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      uploadRequests.set(path, (uploadRequests.get(path) ?? 0) + 1)
      if (path.includes('missing')) return route.fulfill({ status: 404, body: 'not found' })
      if (path.includes('corrupt')) return route.fulfill({ status: 200, contentType: 'image/webp', body: Buffer.from('RIFF....WEBPVP8 broken-bytes') })
      if (path.includes('offline')) return route.abort('failed')
      return route.fulfill({ status: 200, contentType: 'image/webp', body: validWebp })
    })
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${port}${url}`)
    await page.waitForFunction((g) => (window as any)[g] !== undefined, readyGlobal, { timeout: 15_000 })
    return { page, errors }
  }

  // ─── Маса ─────────────────────────────────────────────────────────────────
  console.log('--- Белот маса ---')
  const { page, errors } = await newPage('/scripts/fixtures/activeRoomSpectatorHarness.html', '__activeRoomSpectatorHarness')
  const roomId = 'belot-visual-room-1'
  await call(page, (h: H, rid: string) => h.enterAsParticipant(rid, 'bottom'), roomId)
  const bidding = await call(page, (h: H) => h.biddingGame({
    handCounts: { bottom: 2, right: 5, top: 5, left: 5 },
    ownHand: [{ id: 'c7', suit: 'clubs', rank: '7' }, { id: 'd8', suit: 'diamonds', rank: '8' }],
  }))
  await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game: bidding })

  await check('[R1] ръчната визия има предимство пред кампанията (маса Desktop + гръб)', async () => {
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: MANUAL })
    await page.waitForFunction((n) => document.body.innerHTML.includes(n), MANUAL.cardBackUrl, { timeout: 3_000 })
    assert(await has(page, MANUAL.tableBgDesktopUrl), 'manual desktop table missing')
    assert(!(await has(page, CAMPAIGN.tableBgDesktopUrl)), 'campaign desktop table still shown')
    assert(!(await has(page, CAMPAIGN.cardBackUrl)), 'campaign card back still shown')
    assert(await has(page, DEFAULT_CARD_BACK), 'default card back fallback layer missing')
  })

  await check('[R2] телефон → mobile URL (не desktop); обратно на desktop → desktop URL', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await call(page, (h: H) => h.render())
    assert(await has(page, MANUAL.tableBgMobileUrl), 'mobile url missing on phone')
    assert(!(await has(page, MANUAL.tableBgDesktopUrl)), 'desktop url shown on phone')
    await page.setViewportSize({ width: 1280, height: 900 })
    await call(page, (h: H) => h.render())
    assert(await has(page, MANUAL.tableBgDesktopUrl) && !(await has(page, MANUAL.tableBgMobileUrl)), 'desktop/mobile mismatch on desktop')
  })

  await check('[R3] липсващ ръчен гръб → кампанийният (както го е разрешил сървърът)', async () => {
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: { ...MANUAL, cardBackUrl: CAMPAIGN.cardBackUrl } })
    await page.waitForFunction((n) => document.body.innerHTML.includes(n), CAMPAIGN.cardBackUrl, { timeout: 3_000 })
    assert(await has(page, MANUAL.tableBgDesktopUrl), 'manual table lost')
    assert(!(await has(page, MANUAL.cardBackUrl)), 'manual card back still shown')
  })

  await check('[R4] belotVisual с null-ове → стандартна визия, без празни изображения', async () => {
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: { tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null } })
    await page.waitForFunction((n) => !document.body.innerHTML.includes(n), MANUAL.tableBgDesktopUrl, { timeout: 3_000 })
    for (const url of [CAMPAIGN.tableBgDesktopUrl, CAMPAIGN.cardBackUrl, MANUAL.cardBackUrl]) assert(!(await has(page, url)), `unexpected ${url}`)
    assert(await has(page, DEFAULT_CARD_BACK), 'standard card back missing')
    assert(!(await has(page, "url('')")) && !(await has(page, 'url(null)')), 'empty image url rendered')
  })

  await check('[R5] стар сървър без belotVisual → кампанийната тема (както преди)', async () => {
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN })
    await page.waitForFunction((n) => document.body.innerHTML.includes(n), CAMPAIGN.cardBackUrl, { timeout: 3_000 })
    assert(await has(page, CAMPAIGN.tableBgDesktopUrl), 'campaign table missing')
  })

  await check('[R6] превключване на живо в playing (ръчна → кампания → ръчна), същата стая', async () => {
    const game = await call(page, (h: H) => h.playingGame())
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game })
    for (const [visual, expected, absent] of [
      [MANUAL, MANUAL.tableBgDesktopUrl, CAMPAIGN.tableBgDesktopUrl],
      [{ tableBgDesktopUrl: CAMPAIGN.tableBgDesktopUrl, tableBgMobileUrl: CAMPAIGN.tableBgMobileUrl, cardBackUrl: CAMPAIGN.cardBackUrl }, CAMPAIGN.tableBgDesktopUrl, MANUAL.tableBgDesktopUrl],
      [MANUAL, MANUAL.tableBgDesktopUrl, CAMPAIGN.tableBgDesktopUrl],
    ] as const) {
      await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: visual })
      await page.waitForFunction((n) => document.body.innerHTML.includes(n), expected, { timeout: 3_000 })
      assert(!(await has(page, absent)), `stale ${absent}`)
    }
    assert(await call(page, (h: H) => h.getCurrentRoomIdFn()) === roomId, 'room changed')
  })

  await check('[R7] стабилна bidding снимка + само belotVisual промяна → прерисува се', async () => {
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game: bidding })
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: { ...MANUAL, cardBackUrl: CAMPAIGN.cardBackUrl } })
    await page.waitForFunction((n) => document.body.innerHTML.includes(n), CAMPAIGN.cardBackUrl, { timeout: 3_000 })
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game: bidding })
    await push(page, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: MANUAL })
    await page.waitForFunction((n) => document.body.innerHTML.includes(n), MANUAL.cardBackUrl, { timeout: 3_000 })
  })

  await check('[R8] без грешки в страницата', () => {
    assert(errors.length === 0, errors.join(' | '))
  })

  // ─── Неработещо ръчно изображение ─────────────────────────────────────────
  console.log('--- Неработещо ръчно изображение ---')
  const fb = await newPage('/scripts/fixtures/activeRoomSpectatorHarness.html', '__activeRoomSpectatorHarness')
  const fp = fb.page
  const fbRoom = 'belot-visual-fallback-room'
  await call(fp, (h: H, rid: string) => h.enterAsParticipant(rid, 'bottom'), fbRoom)
  await call(fp, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: fbRoom, game: bidding })
  const BROKEN = {
    tableBgDesktopUrl: '/uploads/campaign-themes/belot-visual/tables/missing-desk.webp',
    tableBgMobileUrl: '/uploads/campaign-themes/belot-visual/tables/corrupt-mob.webp',
    cardBackUrl: '/uploads/campaign-themes/belot-visual/card-backs/ok-back.webp',
  }
  const waitFor = (p: Page, needle: string, present = true) =>
    p.waitForFunction(({ n, want }) => document.body.innerHTML.includes(n) === want, { n: needle, want: present }, { timeout: 5_000 })

  await check('[F1] липсваща (404) ръчна маса Desktop → кампанийната; работещият ръчен гръб остава', async () => {
    await push(fp, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: BROKEN })
    await waitFor(fp, BROKEN.tableBgDesktopUrl, false)
    await waitFor(fp, CAMPAIGN.tableBgDesktopUrl)
    assert(await has(fp, BROKEN.cardBackUrl), 'working manual card back replaced')
    assert(!(await has(fp, CAMPAIGN.cardBackUrl)), 'campaign card back shown although manual works')
  })

  await check('[F2] повредена ръчна маса Mobile → кампанийната на телефон; desktop не е засегнат', async () => {
    await fp.setViewportSize({ width: 390, height: 844 })
    await call(fp, (h: H) => h.render())
    await waitFor(fp, BROKEN.tableBgMobileUrl, false)
    await waitFor(fp, CAMPAIGN.tableBgMobileUrl)
    await fp.setViewportSize({ width: 1280, height: 900 })
    await call(fp, (h: H) => h.render())
    assert(await has(fp, CAMPAIGN.tableBgDesktopUrl) && !(await has(fp, CAMPAIGN.tableBgMobileUrl)), 'desktop/mobile mixed up')
  })

  await check('[F3] незареждащ се ръчен гръб (мрежова грешка) → кампанийният; стандартният остава резервен слой', async () => {
    const visual = { ...BROKEN, cardBackUrl: '/uploads/campaign-themes/belot-visual/card-backs/offline-back.webp' }
    await push(fp, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: visual })
    await waitFor(fp, visual.cardBackUrl, false)
    await waitFor(fp, CAMPAIGN.cardBackUrl)
    assert(await has(fp, DEFAULT_CARD_BACK), 'default card back layer missing')
  })

  await check('[F4] неработещо ръчно изображение без кампания → стандартната визия', async () => {
    const visual = {
      tableBgDesktopUrl: '/uploads/campaign-themes/belot-visual/tables/missing-desk-2.webp',
      tableBgMobileUrl: null,
      cardBackUrl: '/uploads/campaign-themes/belot-visual/card-backs/corrupt-back-2.webp',
    }
    await push(fp, { type: 'active_campaign_theme', theme: null, belotVisual: visual })
    await waitFor(fp, visual.tableBgDesktopUrl, false)
    await waitFor(fp, visual.cardBackUrl, false)
    for (const url of [CAMPAIGN.tableBgDesktopUrl, CAMPAIGN.cardBackUrl]) assert(!(await has(fp, url)), `unexpected ${url}`)
    assert(await has(fp, DEFAULT_CARD_BACK), 'standard card back missing')
    assert(!(await has(fp, "url('')")) && !(await has(fp, 'url(null)')), 'empty image url rendered')
  })

  await check('[F5] без повторни опити: неработещите URL-и не се заявяват отново при нови render-и/push-ове', async () => {
    const broken = [BROKEN.tableBgDesktopUrl, BROKEN.tableBgMobileUrl, '/uploads/campaign-themes/belot-visual/card-backs/offline-back.webp']
    const before = broken.map((u) => uploadRequests.get(u) ?? 0)
    assert(before.every((n) => n >= 1 && n <= 3), `initial requests ${before}`)
    for (let i = 0; i < 4; i++) {
      await push(fp, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: { ...BROKEN, cardBackUrl: broken[2] } })
      await fp.setViewportSize({ width: i % 2 === 0 ? 390 : 1280, height: 844 })
      await call(fp, (h: H) => h.render())
    }
    await new Promise((r) => setTimeout(r, 500))
    const after = broken.map((u) => uploadRequests.get(u) ?? 0)
    assert(JSON.stringify(after) === JSON.stringify(before), `requests ${before} -> ${after}`)
    await fp.setViewportSize({ width: 1280, height: 900 })
  })

  await check('[F6] ново качване (нов работещ URL) → ръчната визия се показва отново', async () => {
    const fixed = { ...BROKEN, tableBgDesktopUrl: '/uploads/campaign-themes/belot-visual/tables/ok-desk-v2.webp' }
    await push(fp, { type: 'active_campaign_theme', theme: CAMPAIGN, belotVisual: fixed })
    await waitFor(fp, fixed.tableBgDesktopUrl)
    await new Promise((r) => setTimeout(r, 500))
    assert(await has(fp, fixed.tableBgDesktopUrl), 'working re-upload replaced by fallback')
    assert(!(await has(fp, CAMPAIGN.tableBgDesktopUrl)), 'campaign still shown')
  })

  await check('[F7] само кампания (сървърът подава кампанийния URL) → без JS проверка, както преди', async () => {
    const brokenCampaign = { ...CAMPAIGN, tableBgDesktopUrl: '/uploads/campaign-themes/camp-1/tables/missing-camp-desk.webp' }
    const visual = { tableBgDesktopUrl: brokenCampaign.tableBgDesktopUrl, tableBgMobileUrl: CAMPAIGN.tableBgMobileUrl, cardBackUrl: CAMPAIGN.cardBackUrl }
    await push(fp, { type: 'active_campaign_theme', theme: brokenCampaign, belotVisual: visual })
    await waitFor(fp, brokenCampaign.tableBgDesktopUrl)
    await new Promise((r) => setTimeout(r, 500))
    assert(await has(fp, brokenCampaign.tableBgDesktopUrl), 'campaign URL removed (old behaviour changed)')
  })

  await check('[F8] без грешки в страницата', () => {
    assert(fb.errors.length === 0, fb.errors.join(' | '))
  })

  // ─── Админ секция ─────────────────────────────────────────────────────────
  console.log('--- Админ секция ---')
  const admin = await newPage('/scripts/fixtures/adminBelotVisualSectionHarness.html', '__belotVisualAdminHarness')
  const ap = admin.page
  const setState = (patch: unknown, mobile = false) => ap.evaluate(({ p, m }) => (window as any).__belotVisualAdminHarness.setState(p, m), { p: patch, m: mobile })
  const calls = () => ap.evaluate(() => (window as any).__belotVisualAdminHarness.getCalls() as Array<{ name: string; args: unknown[] }>)
  const clearCalls = () => ap.evaluate(() => (window as any).__belotVisualAdminHarness.clearCalls())

  await check('[A1] превключвател изключен по подразбиране, статус "Изключена", трите слота', async () => {
    const toggle = ap.locator('[data-admin-belot-visual-toggle="1"]')
    assert(!(await toggle.isChecked()), 'toggle checked by default')
    assert((await ap.locator('[data-admin-belot-visual-status="1"]').textContent())?.trim() === 'Изключена', 'status')
    const text = await ap.locator('[data-admin-belot-visual-section="1"]').textContent() ?? ''
    for (const label of ['Визия на Белот', 'Включи/Изключи приоритетната визия', 'Маса — Desktop', 'Маса — Mobile', 'Гръб на картите']) assert(text.includes(label), `missing ${label}`)
    for (const kind of ['table_bg_desktop', 'table_bg_mobile', 'card_back']) {
      assert(await ap.locator(`[data-admin-belot-visual-upload="${kind}"]`).count() === 1, `no upload for ${kind}`)
      assert(await ap.locator(`[data-admin-belot-visual-remove="${kind}"]`).count() === 0, `remove shown without image for ${kind}`)
    }
  })

  await check('[A2] превключване → onToggle(true); изключване → onToggle(false)', async () => {
    await clearCalls()
    await ap.locator('[data-admin-belot-visual-toggle="1"]').check()
    await setState({ adminBelotVisual: { enabled: true, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null } })
    assert((await ap.locator('[data-admin-belot-visual-status="1"]').textContent())?.trim() === 'Включена', 'status after enable')
    await ap.locator('[data-admin-belot-visual-toggle="1"]').uncheck()
    const c = await calls()
    assert(JSON.stringify(c.map((x) => [x.name, x.args[0]])) === JSON.stringify([['toggle', true], ['toggle', false]]), JSON.stringify(c))
  })

  await check('[A3] качване → onUpload(kind, data URL); после преглед + "Замени" + "Премахни"', async () => {
    await clearCalls()
    const png = await sharp({ create: { width: 40, height: 20, channels: 4, background: '#a00' } }).png().toBuffer()
    await ap.setInputFiles('[data-admin-belot-visual-upload="table_bg_mobile"]', { name: 'table.png', mimeType: 'image/png', buffer: png })
    await ap.waitForFunction(() => (window as any).__belotVisualAdminHarness.getCalls().length > 0, null, { timeout: 3_000 })
    const c = await calls()
    assert(c[0]?.name === 'upload' && c[0].args[0] === 'table_bg_mobile' && String(c[0].args[1]).startsWith('data:image/png;base64'), JSON.stringify(c))
    await setState({ adminBelotVisual: { enabled: true, tableBgDesktopUrl: null, tableBgMobileUrl: '/uploads/campaign-themes/belot-visual/tables/x.webp', cardBackUrl: null } })
    const widget = ap.locator('[data-admin-belot-visual-widget="table_bg_mobile"]')
    assert(await widget.locator('img').getAttribute('src') === '/uploads/campaign-themes/belot-visual/tables/x.webp', 'preview src')
    assert((await widget.textContent() ?? '').includes('Замени'), 'no "Замени"')
    assert(await ap.locator('[data-admin-belot-visual-remove="table_bg_mobile"]').count() === 1, 'no remove')
    const accept = await ap.locator('[data-admin-belot-visual-upload="card_back"]').getAttribute('accept')
    assert(accept === 'image/png,image/jpeg,image/webp', `accept ${accept}`)
  })

  await check('[A4] "Премахни" с потвърждение → onRemove; отказ → нищо', async () => {
    await clearCalls()
    ap.once('dialog', (d) => void d.dismiss())
    await ap.click('[data-admin-belot-visual-remove="table_bg_mobile"]')
    assert((await calls()).length === 0, 'removed despite cancel')
    ap.once('dialog', (d) => void d.accept())
    await ap.click('[data-admin-belot-visual-remove="table_bg_mobile"]')
    const c = await calls()
    assert(c.length === 1 && c[0]!.name === 'remove' && c[0]!.args[0] === 'table_bg_mobile', JSON.stringify(c))
  })

  await check('[A5] busy → неактивни контроли; грешка и успех се показват', async () => {
    await setState({ adminBelotVisualBusy: true })
    assert(await ap.locator('[data-admin-belot-visual-toggle="1"]').isDisabled(), 'toggle enabled while busy')
    assert(await ap.locator('[data-admin-belot-visual-remove="table_bg_mobile"]').isDisabled(), 'remove enabled while busy')
    assert(await ap.locator('[data-admin-belot-visual-upload="card_back"]').isDisabled(), 'upload enabled while busy')
    await setState({ adminBelotVisualBusy: false, adminBelotVisualErrorText: 'Поддържат се само JPEG, PNG и WebP снимки до 10 MB.' })
    assert((await ap.locator('[data-admin-belot-visual-error="1"]').textContent())?.includes('JPEG') === true, 'error text')
    await setState({ adminBelotVisualErrorText: null, adminBelotVisualSuccessText: 'Изображението е качено.' })
    assert(await ap.locator('[data-admin-belot-visual-success="1"]').isVisible(), 'success text')
  })

  await check('[A6] телефон (390px) → без хоризонтален overflow', async () => {
    await ap.setViewportSize({ width: 390, height: 844 })
    await setState({ adminBelotVisual: { enabled: true, tableBgDesktopUrl: '/a.webp', tableBgMobileUrl: '/b.webp', cardBackUrl: '/c.webp' } }, true)
    const ok = await ap.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
    assert(ok, 'horizontal overflow')
  })

  await check('[A7] кампанийният виджет (споделен) дава същия HTML като преди извеждането', async () => {
    for (const [kind, label, url, accept] of [
      ['unit_icon', 'Иконка (поддържа GIF)', null, 'image/png,image/jpeg,image/webp,image/gif'],
      ['card_back', 'Гръб на картите', '/uploads/campaign-themes/x/card-backs/y.webp', 'image/png,image/jpeg,image/webp'],
    ] as const) {
      const html = await ap.evaluate(({ k, l, u, a }) => (window as any).__belotVisualAdminHarness.renderCampaignWidget(k, l, u, a), { k: kind, l: label, u: url, a: accept })
      assert(html === legacyCampaignWidget(kind, label, url, accept), `campaign widget changed for ${kind}`)
    }
  })

  await check('[A8] без грешки в админ страницата', () => {
    assert(admin.errors.length === 0, admin.errors.join(' | '))
  })
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

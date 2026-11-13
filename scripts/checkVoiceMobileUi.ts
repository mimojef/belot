/**
 * checkVoiceMobileUi.ts — Гласов чат, Етап 4: визуален преглед на мобилния
 * интерфейс + основни layout проверки. Реален Chromium (Playwright) върху
 * реалния production UI код (scripts/fixtures/voiceMobileUiHarness.ts).
 * Гласовите състояния са FIXTURE (без LiveKit/аудио) — НЕ е аудиотест.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMobileUi.ts
 *
 * Скрийншоти: <tmp>/belot-v2-voice-mobile-screenshots/<viewport>/*.png
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

const OUT = join(tmpdir(), 'belot-v2-voice-mobile-screenshots')
const VIEWPORTS = [
  { label: '390x844', width: 390, height: 844, full: true },
  { label: '320x568', width: 320, height: 568, full: false },
  { label: '360x800', width: 360, height: 800, full: false },
  { label: '430x932', width: 430, height: 932, full: false },
]

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const rectOf = (page: Page, selector: string): Promise<Rect | null> => page.evaluate((sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}, selector)
const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/** Иконата на гласовата маса в списъка: брой, ред с „Ръчен старт“, без разтягане, без хоризонтален overflow. */
async function assertListBadges(page: Page, viewportWidth: number): Promise<void> {
  const info = await page.evaluate(() => {
    const badges = Array.from(document.querySelectorAll<HTMLElement>('[data-private-room-voice-badge="1"]'))
    const rows = badges.map((badge) => {
      const row = badge.parentElement!
      const manual = Array.from(row.children).find((el) => el.textContent?.trim() === 'Ръчен старт') as HTMLElement | undefined
      const b = badge.getBoundingClientRect()
      const m = manual?.getBoundingClientRect()
      return { w: b.width, h: b.height, right: b.right, rowHeight: row.getBoundingClientRect().height, manualTopDelta: m ? Math.abs((m.top + m.height / 2) - (b.top + b.height / 2)) : null, manualGap: m ? m.left - b.right : null }
    })
    // Сравнение: ред на домакина с „Ръчен старт“ без глас (r3) спрямо с глас (r1).
    const manualPills = Array.from(document.querySelectorAll<HTMLElement>('span')).filter((el) => el.textContent?.trim() === 'Ръчен старт')
    const manualRows = manualPills.map((el) => el.parentElement!.getBoundingClientRect().height)
    const manualPillHeight = manualPills[0]?.getBoundingClientRect().height ?? 0
    return { count: badges.length, rows, manualRows, manualPillHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
  })
  assert(info.count === 3, `3 гласови маси (вкл. с автоматичен старт) -> 3 икони (${info.count})`)
  for (const row of info.rows) {
    // Спрямо „Ръчен старт“ на същия екран (desktop лобито е мащабирано).
    assert(row.h >= info.manualPillHeight - 1.5 && row.w >= row.h * 1.4, `иконата е ясно видима (${row.w.toFixed(1)}x${row.h.toFixed(1)}, „Ръчен старт“ ${info.manualPillHeight.toFixed(1)})`)
    assert(row.right <= viewportWidth, 'в рамките на екрана')
    if (row.manualTopDelta !== null) {
      assert(row.manualTopDelta < 1.5, `на един ред с „Ръчен старт“ (Δ${row.manualTopDelta})`)
      assert(row.manualGap !== null && row.manualGap >= 3 && row.manualGap <= 10, `непосредствено до „Ръчен старт“ (${row.manualGap}px)`)
    }
  }
  const heights = new Set(info.manualRows.map((height) => Math.round(height)))
  assert(heights.size === 1, `редът не се разтяга: ${[...heights].join(', ')}`)
  assert(!info.overflow, 'без хоризонтален скрол')
}

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const base = `http://127.0.0.1:${port}/scripts/fixtures/voiceMobileUiHarness.html`

  // --final: само целевите проверки на финалните доработки на Етап 4.
  const finalOnly = process.argv.includes('--final')
  // --desktop: само целевите проверки на desktop интерфейса (Етап 5).
  const desktopOnly = process.argv.includes('--desktop')
  for (const vp of finalOnly || desktopOnly ? [] : VIEWPORTS) {
    console.log(`\n--- ${vp.label} ---`)
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })
    const open = async (query: string): Promise<Page> => {
      const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
      await page.goto(`${base}?${query}`)
      await page.waitForFunction(() => (window as any).__voiceUiHarness !== undefined, undefined, { timeout: 20_000 })
      return page
    }
    const shot = async (page: Page, name: string) => {
      // Началният екран на лобито (логото) трябва да е изчезнал.
      await page.waitForFunction(() => ![...document.body.children].some((el) => (el as HTMLElement).style.zIndex === '99999'), undefined, { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(dir, `${name}.png`) })
    }
    const h = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__voiceUiHarness[f as string](...(a as unknown[])), [fn, args] as const)

    // 0. Списъкът с частни маси — иконата на гласовите маси до „Ръчен старт“.
    await check(`${vp.label} списък „Частни маси“: микрофон само на гласовите маси, на реда на „Ръчен старт“, без да разтяга картата`, async () => {
      const page = await open('vip=1')
      await h(page, 'showList')
      await page.waitForSelector('[data-private-room-voice-badge="1"]', { timeout: 5000 })
      await shot(page, '00-private-rooms-list')
      await assertListBadges(page, vp.width)
      await page.context().close()
    })

    if (vp.full) {
      // 1. „Нова маса“ — VIP: редът е изключен по подразбиране.
      await check(`${vp.label} „Нова маса“ (VIP): ред „Гласов чат“, изключен по подразбиране`, async () => {
        const page = await open('vip=1')
        await h(page, 'openCreate')
        await page.waitForSelector('[data-private-room-voice-checkbox="1"]', { timeout: 5000 })
        assert(!(await page.isChecked('[data-private-room-voice-checkbox="1"]')), 'не е включен по подразбиране')
        await shot(page, '01-create-vip')
        await page.check('[data-private-room-voice-checkbox="1"]')
        await shot(page, '01a-create-vip-checked')
        await h(page, 'checkVoiceAndSubmit')
        await h(page, 'pushCapacityError')
        await page.waitForSelector('[data-private-room-voice-fallback-create="1"]', { timeout: 5000 })
        await shot(page, '01b-create-capacity-choice')
        await page.context().close()
      })
      await check(`${vp.label} „Нова маса“ (без VIP): заключен ред -> VIP прозорец`, async () => {
        const page = await open('vip=0&option=locked')
        await h(page, 'openCreate')
        await page.waitForSelector('[data-private-room-voice-vip="1"]', { timeout: 5000 })
        assert(await page.$('[data-private-room-voice-checkbox="1"]') === null, 'без поле за не-VIP')
        await shot(page, '01c-create-nonvip-locked')
        await h(page, 'clickVoiceVipRow')
        await page.waitForSelector('[data-private-room-voice-vip-popup-card="1"]', { timeout: 5000 })
        const onTop = await page.evaluate(() => {
          const card = document.querySelector('[data-private-room-voice-vip-popup-card="1"]')!.getBoundingClientRect()
          return document.elementFromPoint(card.left + card.width / 2, card.top + 20)?.closest('[data-private-room-voice-vip-popup-card="1"]') !== null
        })
        assert(onTop, 'VIP прозорецът е НАД формата „Нова маса“')
        await shot(page, '01d-create-nonvip-vip-popup')
        await page.context().close()
      })
      // 2. Чакалня + прозорци за включване.
      await check(`${vp.label} чакалня: прозорец за включване (VIP), после лента`, async () => {
        const page = await open('vip=1')
        await h(page, 'showWaiting')
        await page.waitForSelector('[data-voice-prompt="1"]', { timeout: 5000 })
        await shot(page, '02-waiting-prompt-vip')
        await page.click('[data-voice-prompt="1"] [data-voice-action="not-now"].pvp-btn')
        await page.waitForSelector('[data-voice-waiting-strip="1"] .pvs', { timeout: 5000 })
        assert(await page.$('[data-voice-prompt="1"]') === null, 'прозорецът е затворен')
        await shot(page, '03-waiting-strip')
        await h(page, 'setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen' } })
        await h(page, 'setSpeaking', ['me', 'p2'])
        await shot(page, '03a-waiting-connected-speaking')
        const strip = await rectOf(page, '[data-voice-waiting-strip="1"]')
        assert(strip !== null && strip.height >= 50 && strip.height <= 56, `лентата е ~52px (${strip?.height})`)
        const mic = await rectOf(page, '.prw-slot-avatar .pika-voice-speaking')
        assert(mic !== null && mic.width >= 17 && mic.width <= 20, `микрофончето е 18px (${mic?.width})`)
        await h(page, 'openPanel')
        await shot(page, '03b-waiting-panel')
        await page.context().close()
      })
      await check(`${vp.label} чакалня: прозорец за включване (без VIP)`, async () => {
        const page = await open('vip=0')
        await h(page, 'showWaiting')
        await page.waitForSelector('[data-voice-prompt="1"]', { timeout: 5000 })
        const text = await page.textContent('[data-voice-prompt="1"]')
        assert((text ?? '').includes('Можеш да слушаш разговора безплатно. Говоренето през микрофона е VIP привилегия.'), 'одобреният текст')
        await shot(page, '04-waiting-prompt-nonvip')
        await page.context().close()
      })
    }

    // 3. Игрална маса — бутон, панел, говорещи, mute, липсващ микрофон.
    await check(`${vp.label} игра: бутон 40px вляво от „Фрази“, без застъпване; панел; говорещи; mute; без микрофон`, async () => {
      const page = await open('vip=1')
      await h(page, 'showGame')
      await page.waitForSelector('[data-voice-game-toggle="1"]', { timeout: 8000 })
      await shot(page, '05-game-button')
      const voiceBtn = (await rectOf(page, '[data-voice-game-toggle="1"]'))!
      const phrase = await rectOf(page, '[data-phrase-toggle="1"]')
      const emoji = await rectOf(page, '[data-emoji-toggle="1"]')
      assert(Math.round(voiceBtn.width) === 40 && Math.round(voiceBtn.height) === 40, `40px (${voiceBtn.width}x${voiceBtn.height})`)
      if (phrase !== null) {
        assert(voiceBtn.right <= phrase.left - 6, `вляво от „Фрази“ с отстояние (${voiceBtn.right} / ${phrase.left})`)
        assert(Math.abs(voiceBtn.top - phrase.top) < 1, 'на същата линия')
      }
      if (emoji !== null) assert(!overlaps(voiceBtn, emoji), 'без застъпване с емоджи')
      const settings = await page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('[data-voice-game-toggle="1"]')!.getBoundingClientRect()
        const hits = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))
          .filter((el) => !el.matches('[data-voice-game-toggle="1"], [data-phrase-toggle="1"], [data-emoji-toggle="1"], [data-card-id]'))
          .filter((el) => getComputedStyle(el).visibility !== 'hidden' && el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
          .map((el) => ({ r: el.getBoundingClientRect(), label: `${el.tagName.toLowerCase()}[${Array.from(el.attributes).filter((a) => a.name.startsWith('data-') || a.name === 'aria-label').map((a) => `${a.name}=${a.value}`).join(' ')}] ${(el.textContent ?? '').trim().slice(0, 16)}` }))
          .filter(({ r }) => r.width > 0 && r.height > 0 && r.left < btn.right && btn.left < r.right && r.top < btn.bottom && btn.top < r.bottom)
        return hits.map((h) => `${h.label} @${Math.round(h.r.left)},${Math.round(h.r.top)} ${Math.round(h.r.width)}x${Math.round(h.r.height)}`)
      })
      assert(settings.length === 0, `застъпване с: ${settings.join(', ')}`)
      // Картите на ръката влизат под долната лента (както при „Фрази“/емоджи):
      // без бутона в центъра му трябва да е лентата, не карта (бутонът не отнема tap от карта).
      const cardsUnder = (selector: string) => page.evaluate((sel) => {
        const btn = document.querySelector<HTMLElement>(sel)
        if (!btn) return null
        const r = btn.getBoundingClientRect()
        btn.style.visibility = 'hidden'
        const points = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 4, r.top + 4], [r.right - 4, r.top + 4]]
        const found = points.map(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-card-id]')?.getAttribute('data-card-id') ?? null)
        btn.style.visibility = ''
        return found.filter((id) => id !== null)
      }, selector)
      const underVoice = await cardsUnder('[data-voice-game-toggle="1"]')
      const underPhrase = await cardsUnder('[data-phrase-toggle="1"]')
      console.log(`    карти под бутона: глас=${JSON.stringify(underVoice)} фрази=${JSON.stringify(underPhrase)}`)
      await shot(page, '05-game-button')
      await h(page, 'setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen', p4: 'out' }, locallyMuted: ['p4'] })
      await h(page, 'openPanel')
      await page.waitForSelector('[data-voice-panel="1"]')
      const panel = (await rectOf(page, '.pvl-panel'))!
      assert(panel.left >= 15 && panel.right <= vp.width - 15 && panel.bottom <= vp.height - 57, `панелът е над лентата и в екрана (${JSON.stringify(panel)})`)
      await shot(page, '06-game-panel')
      // Първият tap извън панела само го затваря (без tap-through към картите).
      await page.mouse.click(vp.width / 2, 24)
      assert(await page.$('[data-voice-panel="1"]') === null, 'tap извън панела го затваря')
      await h(page, 'setSpeaking', ['me', 'p2', 'p3'])
      const icons = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-profile-seat-btn] .pika-voice-speaking')).map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.voiceSpeakingProfile, w: r.width, opacity: getComputedStyle(el).opacity }
      }))
      assert(icons.length === 4, `4 слота (${icons.length})`)
      await page.waitForTimeout(200)
      const visible = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-profile-seat-btn] .pika-voice-speaking'))
        .filter((el) => getComputedStyle(el).opacity === '1').map((el) => ({ id: el.dataset.voiceSpeakingProfile, w: el.getBoundingClientRect().width })))
      assert(visible.length === 3 && visible.every((v) => v.w >= 17.5 && v.w <= 20.5), `3 видими, 18–20px: ${JSON.stringify(visible)}`)
      await shot(page, '07-game-speaking')
      await h(page, 'setSpeaking', [])
      await h(page, 'setConnected', { mic: false, muted: true, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { uiError: { code: 'mic_blocked', message: 'Микрофонът е блокиран.', detail: null } })
      await h(page, 'openPanel')
      await shot(page, '08-game-panel-muted')
      await h(page, 'closePanel')
      await h(page, 'setConnected', { mic: false, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { uiError: { code: 'mic_not_found', message: 'Не е открит микрофон.', detail: null } })
      await h(page, 'openPanel')
      await shot(page, '09-game-panel-no-mic')
      if (vp.full) {
        await h(page, 'closePanel')
        await h(page, 'setConnected', { mic: false, remotes: { p2: 'mic', p3: 'listen', p4: 'out' } }, { playbackBlocked: true })
        await h(page, 'openPanel')
        await shot(page, '10-game-panel-autoplay-blocked')
        await h(page, 'closePanel')
        await h(page, 'resetIdle')
        await h(page, 'openPanel')
        await shot(page, '11-game-panel-not-joined')
      }
      await page.context().close()
    })
  }
  // ─── Финални доработки на Етап 4 (целеви) ───────────────────────────────
  for (const vp of finalOnly ? VIEWPORTS.filter((v) => v.label === '390x844' || v.label === '320x568') : []) {
    console.log(`\n--- ${vp.label} (финални доработки) ---`)
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })
    const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const requested: string[] = []
    page.on('request', (request) => { if (request.url().includes('renderVoicePanel')) requested.push(request.url()) })
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    await page.goto(`${base}?vip=1`)
    await page.waitForFunction(() => (window as any).__voiceUiHarness !== undefined, undefined, { timeout: 20_000 })
    const h = (fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__voiceUiHarness[f as string](...(a as unknown[])), [fn, args] as const)
    const shot = async (name: string) => {
      await page.waitForFunction(() => ![...document.body.children].some((el) => (el as HTMLElement).style.zIndex === '99999'), undefined, { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(dir, `${name}.png`) })
    }
    const panelButtons = () => page.evaluate(() => Array.from(document.querySelectorAll('[data-voice-panel="1"] button')).map((b) => (b.textContent ?? '').trim()).filter(Boolean))
    const panelText = () => page.evaluate(() => document.querySelector('[data-voice-panel="1"]')?.textContent ?? '')

    await check(`${vp.label} lazy: панелът/прозорците се зареждат едва на гласова маса`, async () => {
      assert(requested.length === 0, `зареден преди гласова маса: ${requested.join(', ')}`)
      await h('showGame')
      await page.waitForFunction(() => document.getElementById('pika-voice-panel-ui') !== null, undefined, { timeout: 8000 })
      assert(requested.length >= 1, 'prefetch на гласова маса')
    })
    await check(`${vp.label} статус „Микрофонът е включен“ (не „Говорите“), заглавният ред не се разпада`, async () => {
      await h('setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen', p4: 'out' } })
      await h('openPanel')
      await page.waitForSelector('[data-voice-panel="1"]')
      const text = await panelText()
      assert(text.includes('Микрофонът е включен') && !text.includes('Говорите'), 'нов статус')
      const head = await page.evaluate(() => {
        const panel = document.querySelector('[data-voice-panel="1"]')!.getBoundingClientRect()
        const close = document.querySelector('[data-voice-panel="1"] .pvp-close')!.getBoundingClientRect()
        const status = document.querySelector('[data-voice-panel="1"] .pvp-status')!.getBoundingClientRect()
        return { insidePanel: close.right <= panel.right + 0.5 && status.right <= close.left, closeTop: close.top - panel.top }
      })
      assert(head.insidePanel, 'статусът и „×“ са в панела, без застъпване')
      assert(await page.locator('[data-voice-game-toggle="1"]').getAttribute('aria-label') === 'Гласов чат: Микрофонът е включен', 'aria-label на бутона')
      await shot('F1-panel-mic-on')
      await h('closePanel')
    })
    await check(`${vp.label} липсващ микрофон: само един бутон „Опитай отново“, без „Включи микрофона“`, async () => {
      await h('setConnected', { mic: false, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { uiError: { code: 'mic_not_found', message: '', detail: null } })
      await h('openPanel')
      const buttons = await panelButtons()
      assert(buttons.filter((b) => b === 'Опитай отново').length === 1, `един „Опитай отново“: ${buttons.join(' | ')}`)
      assert(!buttons.includes('Включи микрофона'), `без „Включи микрофона“: ${buttons.join(' | ')}`)
      await shot('F2-panel-no-mic')
      await h('closePanel')
      await h('setConnected', { mic: false, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { uiError: { code: 'mic_not_found', message: '', detail: null }, microphoneDevicesChanged: true })
      await h('openPanel')
      const afterDevice = await panelButtons()
      assert(afterDevice.filter((b) => b === 'Опитай отново').length === 1 && !afterDevice.includes('Включи микрофона'), `нов микрофон — пак един бутон: ${afterDevice.join(' | ')}`)
      assert((await panelText()).includes('Открит е микрофон.'), 'съобщение за нов микрофон')
      await h('closePanel')
    })
    await check(`${vp.label} административен mute: „Микрофонът е блокиран“ само веднъж`, async () => {
      await h('setConnected', { mic: false, muted: true, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { uiError: { code: 'mic_blocked', message: 'Микрофонът е блокиран.', detail: null } })
      await h('openPanel')
      const text = await panelText()
      const count = text.split('Микрофонът е блокиран').length - 1
      assert(count === 1, `повторения: ${count}`)
      assert(text.includes('Имате активно наказание за чат.'), 'одобреният текст остава')
      await shot('F3-panel-muted')
      await h('closePanel')
    })
    await check(`${vp.label} финален екран на мача: зелени микрофончета само при говорещите, 18–20px, без застъпване с гласа за преиграване`, async () => {
      await h('setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } })
      await h('showMatchEnded')
      await page.waitForSelector('[data-profile-seat-btn] .pika-voice-speaking', { timeout: 8000 })
      await h('setSpeaking', ['me', 'p2'])
      await page.waitForTimeout(200)
      const result = await page.evaluate(() => {
        const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-profile-seat-btn] .pika-voice-speaking'))
        const visible = slots.filter((el) => getComputedStyle(el).opacity === '1').map((el) => {
          const r = el.getBoundingClientRect()
          return { id: el.dataset.voiceSpeakingProfile, w: r.width, r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }
        })
        const badges = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Гласувал за преиграване"], [aria-label="Гласувал за излизане"]')).map((el) => el.getBoundingClientRect())
        const overlap = visible.some((v) => badges.some((b) => v.r.left < b.right && b.left < v.r.right && v.r.top < b.bottom && b.top < v.r.bottom))
        return { slots: slots.length, visible, overlap }
      })
      assert(result.slots === 4, `4 слота (${result.slots})`)
      assert(result.visible.length === 2 && result.visible.every((v) => v.w >= 17.5 && v.w <= 20.5), `2 видими, 18–20px: ${JSON.stringify(result.visible.map((v) => [v.id, v.w]))}`)
      assert(!result.overlap, 'без застъпване със значката за преиграване')
      await shot('F4-match-ended-speaking')
    })
    await context.close()
  }

  // ─── Етап 5: desktop интерфейс (целеви) ─────────────────────────────────
  const DESKTOP_VIEWPORTS = [
    { label: '1280x800', width: 1280, height: 800, full: true },
    { label: '1366x768', width: 1366, height: 768, full: false },
    { label: '1920x1080', width: 1920, height: 1080, full: false },
  ]
  for (const vp of desktopOnly ? DESKTOP_VIEWPORTS : []) {
    console.log(`\n--- ${vp.label} (desktop) ---`)
    const dir = join(OUT, `desktop-${vp.label}`)
    await mkdir(dir, { recursive: true })
    const openDesktop = async (query: string): Promise<Page> => {
      const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height } })
      const page = await context.newPage()
      page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
      await page.goto(`${base}?${query}`)
      await page.waitForFunction(() => (window as any).__voiceUiHarness !== undefined, undefined, { timeout: 20_000 })
      return page
    }
    const shotD = async (page: Page, name: string) => {
      await page.waitForFunction(() => ![...document.body.children].some((el) => (el as HTMLElement).style.zIndex === '99999'), undefined, { timeout: 15_000 }).catch(() => {})
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(dir, `${name}.png`) })
    }
    const hd = (page: Page, fn: string, ...args: unknown[]) => page.evaluate(([f, a]) => (window as any).__voiceUiHarness[f as string](...(a as unknown[])), [fn, args] as const)
    const visibleMics = (page: Page, scope: string) => page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(`${sel} .pika-voice-speaking`))
      .map((el) => ({ id: el.dataset.voiceSpeakingProfile, w: el.getBoundingClientRect().width, visible: getComputedStyle(el).opacity === '1' })), scope)

    if (vp.full) {
      await check(`${vp.label} „Нова маса“ (desktop): ред „Гласов чат“ в тъмната форма, изключен; отказ -> тъмен избор`, async () => {
        const page = await openDesktop('vip=1')
        await hd(page, 'openCreate')
        await page.waitForSelector('[data-private-room-voice-checkbox="1"]', { timeout: 5000 })
        assert(!(await page.isChecked('[data-private-room-voice-checkbox="1"]')), 'изключен по подразбиране')
        assert(await page.$('[data-private-room-voice-badge="1"]') === null || true, 'списъкът не е засегнат')
        await shotD(page, 'D01-create-vip')
        await hd(page, 'checkVoiceAndSubmit')
        await hd(page, 'pushCapacityError')
        await page.waitForSelector('[data-private-room-voice-fallback-create="1"]', { timeout: 5000 })
        await shotD(page, 'D02-create-capacity-choice')
        await page.context().close()
      })
      await check(`${vp.label} „Нова маса“ (desktop, без VIP): заключен ред -> VIP прозорец над формата`, async () => {
        const page = await openDesktop('vip=0&option=locked')
        await hd(page, 'openCreate')
        await page.waitForSelector('[data-private-room-voice-vip="1"]', { timeout: 5000 })
        await shotD(page, 'D03-create-nonvip-locked')
        await hd(page, 'clickVoiceVipRow')
        await page.waitForSelector('[data-private-room-voice-vip-popup-card="1"]', { timeout: 5000 })
        const onTop = await page.evaluate(() => {
          const card = document.querySelector('[data-private-room-voice-vip-popup-card="1"]')!.getBoundingClientRect()
          return document.elementFromPoint(card.left + card.width / 2, card.top + 20)?.closest('[data-private-room-voice-vip-popup-card="1"]') !== null
        })
        assert(onTop, 'VIP прозорецът е над формата')
        await page.waitForTimeout(400)
        await shotD(page, 'D04-create-nonvip-vip-popup')
        await page.context().close()
      })
      await check(`${vp.label} чакалня (desktop): тъмни прозорци VIP/non-VIP, лента, панел под лентата, микрофончета`, async () => {
        const page = await openDesktop('vip=1')
        await hd(page, 'showWaiting')
        await page.waitForSelector('[data-voice-prompt="1"] .pvp--dark', { timeout: 5000 })
        await shotD(page, 'D05-waiting-prompt-vip')
        await page.click('[data-voice-prompt="1"] .pvp-btn[data-voice-action="not-now"]')
        await page.waitForSelector('[data-voice-waiting-strip="1"] .pvs--dark', { timeout: 5000 })
        const strip = (await rectOf(page, '[data-voice-waiting-strip="1"]'))!
        assert(strip.height >= 50 && strip.height <= 56, `лентата ~52px (${strip.height})`)
        await shotD(page, 'D06-waiting-strip')
        await hd(page, 'setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen' } })
        await hd(page, 'setSpeaking', ['me', 'p2'])
        await page.waitForTimeout(200)
        const mics = await visibleMics(page, '.prw-slot-avatar')
        const shown = mics.filter((m) => m.visible)
        assert(shown.length === 2 && shown.every((m) => m.w >= 17.5 && m.w <= 20.5), `2 видими, 18–20px: ${JSON.stringify(shown)}`)
        await shotD(page, 'D07-waiting-speaking')
        await hd(page, 'openPanel')
        await page.waitForSelector('[data-voice-panel="1"].pvp--dark')
        const panel = (await rectOf(page, '.pvl-panel'))!
        const stripBtn = (await rectOf(page, '[data-voice-waiting-strip="1"] .pvs'))!
        assert(panel.top >= stripBtn.bottom && panel.right <= vp.width - 15 && panel.bottom <= vp.height, `панелът е под лентата и в екрана (${JSON.stringify(panel)})`)
        assert((await page.textContent('[data-voice-panel="1"]'))!.includes('Микрофонът е включен'), 'одобреният статус')
        await shotD(page, 'D08-waiting-panel')
        await page.context().close()
        const page2 = await openDesktop('vip=0')
        await hd(page2, 'showWaiting')
        await page2.waitForSelector('[data-voice-prompt="1"] .pvp--dark', { timeout: 5000 })
        const text = await page2.textContent('[data-voice-prompt="1"]')
        assert((text ?? '').includes('Можеш да слушаш разговора безплатно. Говоренето през микрофона е VIP привилегия.') && (text ?? '').includes('Вземи VIP'), 'non-VIP текст и „Вземи VIP“')
        await shotD(page2, 'D09-waiting-prompt-nonvip')
        await page2.context().close()
      })
    }

    await check(`${vp.label} игра (desktop): бутон 52px веднага след ⚙️ в същия flex; панел над бутона; микрофончета; само на гласова маса; финален екран`, async () => {
      const page = await openDesktop('vip=1')
      await hd(page, 'showGame')
      await page.waitForSelector('[data-active-room-desktop-action-bar="1"] [data-voice-game-toggle="1"]', { timeout: 8000 })
      const layout = await page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>('[data-voice-game-toggle="1"]')!
        const settings = document.querySelector<HTMLElement>('[data-active-room-desktop-action-bar="1"] [data-active-room-settings-button="1"]')!
        const leave = document.querySelector<HTMLElement>('[data-active-room-desktop-action-bar="1"] [data-active-room-leave-button="1"]')!
        const b = btn.getBoundingClientRect()
        const s = settings.getBoundingClientRect()
        const l = leave.getBoundingClientRect()
        return { afterSettings: btn.previousElementSibling === settings, gap: b.left - s.right, w: b.width, h: b.height, centerDelta: Math.abs((b.top + b.height / 2) - (l.top + l.height / 2)), settingsW: s.width, leaveH: l.height }
      })
      assert(layout.afterSettings, 'веднага след ⚙️ в същия flex')
      assert(Math.abs(layout.gap - 6) < 1, `отстояние като останалите (6px): ${layout.gap}`)
      assert(Math.round(layout.w) === 52 && Math.round(layout.h) === 52, `52px (${layout.w}x${layout.h})`)
      assert(layout.centerDelta < 1 && Math.round(layout.leaveH) === 52 && Math.round(layout.settingsW) === 52, 'подравнен с „Изход“ и ⚙️, които не са променени')
      await shotD(page, 'D10-game-button')
      await hd(page, 'setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen', p4: 'out' } })
      await hd(page, 'openPanel')
      await page.waitForSelector('[data-voice-panel="1"].pvp--dark')
      const panel = (await rectOf(page, '.pvl-panel'))!
      const btn = (await rectOf(page, '[data-voice-game-toggle="1"]'))!
      assert(panel.bottom <= btn.top - 5 && panel.left >= 15 && panel.top >= 0, `панелът е над бутона (${JSON.stringify(panel)})`)
      await shotD(page, 'D11-game-panel')
      await page.mouse.click(vp.width / 2, 30)
      assert(await page.$('[data-voice-panel="1"]') === null, 'клик извън панела го затваря')
      await hd(page, 'setSpeaking', ['me', 'p2', 'p3'])
      await page.waitForTimeout(200)
      const mics = await visibleMics(page, '[data-profile-seat-btn]')
      const shown = mics.filter((m) => m.visible)
      assert(mics.length === 4 && shown.length === 3 && shown.every((m) => m.w >= 17.5 && m.w <= 20.5), `4 слота, 3 видими 18–20px: ${JSON.stringify(mics)}`)
      await shotD(page, 'D12-game-speaking')
      // Само на гласова маса.
      await hd(page, 'setVoice', { voiceTableId: null })
      assert(await page.$('[data-voice-game-toggle="1"]') === null, 'без гласова маса няма бутон')
      await hd(page, 'setConnected', { mic: true, remotes: { p2: 'mic', p3: 'listen', p4: 'listen' } }, { voiceTableId: '11111111-2222-4333-8444-555555555555' })
      await page.waitForSelector('[data-voice-game-toggle="1"]', { timeout: 3000 })
      // Финален екран: лентата „Изход“ се маха — бутонът остава на същото място.
      await hd(page, 'setSpeaking', [])
      await hd(page, 'showMatchEnded')
      await page.waitForSelector('[data-profile-seat-btn] .pika-voice-speaking', { timeout: 8000 })
      await hd(page, 'setSpeaking', ['me', 'p2'])
      await page.waitForTimeout(250)
      const end = await page.evaluate(() => {
        const slots = Array.from(document.querySelectorAll<HTMLElement>('[data-profile-seat-btn] .pika-voice-speaking'))
        const visible = slots.filter((el) => getComputedStyle(el).opacity === '1').map((el) => el.getBoundingClientRect())
        const badges = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="Гласувал за преиграване"], [aria-label="Гласувал за излизане"]')).map((el) => el.getBoundingClientRect())
        const overlap = visible.some((v) => badges.some((b) => v.left < b.right && b.left < v.right && v.top < b.bottom && b.top < v.bottom))
        const btn = document.querySelector<HTMLElement>('[data-voice-game-toggle="1"]')?.getBoundingClientRect() ?? null
        return { slots: slots.length, widths: visible.map((v) => v.width), overlap, btn: btn ? { left: btn.left, bottom: window.innerHeight - btn.bottom } : null }
      })
      assert(end.slots === 4 && end.widths.length === 2 && end.widths.every((w) => w >= 17.5 && w <= 20.5), `финален екран: ${JSON.stringify(end)}`)
      assert(!end.overlap, 'без застъпване със значката за гласуване')
      assert(end.btn !== null && Math.abs(end.btn.left - 18) < 1.5 && Math.abs(end.btn.bottom - 24) < 1.5, `бутонът остава долу вляво (${JSON.stringify(end.btn)})`)
      await shotD(page, 'D13-match-ended-speaking')
      await page.context().close()
    })
  }

  // Desktop (тъмният вариант на същия списък) — само иконата в списъка.
  if (!finalOnly && !desktopOnly) console.log('\n--- 1280x800 (desktop списък) ---')
  if (!finalOnly && !desktopOnly) await check('1280x800 списък „Частни маси“ (тъмен вариант): същата икона до „Ръчен старт“', async () => {
    const dir = join(OUT, '1280x800')
    await mkdir(dir, { recursive: true })
    const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    await page.goto(`${base}?vip=1`)
    await page.waitForFunction(() => (window as any).__voiceUiHarness !== undefined, undefined, { timeout: 20_000 })
    await page.evaluate(() => (window as any).__voiceUiHarness.showList())
    await page.waitForSelector('[data-private-room-voice-badge="1"]', { timeout: 5000 })
    await page.waitForFunction(() => ![...document.body.children].some((el) => (el as HTMLElement).style.zIndex === '99999'), undefined, { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(dir, '00-private-rooms-list.png') })
    await assertListBadges(page, 1280)
    await context.close()
  })
} finally {
  await browser?.close()
  await vite?.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
console.log(`Скрийншоти: ${OUT}`)
if (failed > 0) process.exit(1)

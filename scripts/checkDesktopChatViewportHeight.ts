// Desktop Чат (/chat) — вертикално разпъване до долния край на viewport-а.
//
// Реалният createLobbyFlowController + renderLobbyScreen (през Vite, в истински
// Chromium) чрез scripts/fixtures/chatDraftHarness. Измерва реалното layout-ване
// при няколко desktop височини и проверява, че:
//   - чатът и footer-ът стигат до долния край на viewport-а (без празна зона);
//   - няма page-level vertical scroll;
//   - трите колони (списък / разговор / emoji) завършват на една линия;
//   - САМО историята на съобщенията скролва вътрешно, header/composer остават;
//   - по-висок viewport -> по-висока зона със съобщения;
//   - scroll-to-latest продължава да работи;
//   - mobile (phone layout) не е засегнат.
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed++
    console.error(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('no port')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

type Metrics = {
  viewportHeight: number
  hasScaleStage: boolean
  rootScrollOverflow: number
  contentBottom: number
  footerBottom: number
  footerVisible: boolean
  columnBottoms: number[]
  headerTop: number
  headerBottom: number
  formTop: number
  formBottom: number
  messagesTop: number
  messagesBottom: number
  messagesClientHeight: number
  messagesScrollHeight: number
  messagesDistanceFromBottom: number
  listScrollable: boolean
  emojiBottom: number
}

async function openChatWithManyMessages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const harness = (window as any).__chatDraftHarness
    for (let i = 0; i < 60; i++) harness.deliverIncomingMessage('friendship-a', `Съобщение номер ${i + 1}`)
    harness.openConversation('friendship-a')
    for (let i = 0; i < 120; i++) {
      if (document.querySelectorAll('[data-chat-messages-scroll="1"] [data-chat-message]').length >= 60) return
      await new Promise((resolve) => setTimeout(resolve, 16))
    }
  })
  await page.waitForTimeout(150)
}

async function measure(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')!
    const messages = document.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')!
    const form = document.querySelector('[data-lobby-chat-form]')
    const section = messages.closest('section')!
    const columns = Array.from(section.children) as HTMLElement[]
    const center = messages.parentElement!
    const header = center.firstElementChild!
    const footer = root.querySelector('footer')
    const content = footer?.parentElement ?? null
    const list = columns[0]?.querySelector<HTMLElement>('[style*="overflow-y:auto"]') ?? null
    const footerRect = footer?.getBoundingClientRect()
    return {
      viewportHeight: window.innerHeight,
      hasScaleStage: document.querySelector('[data-lobby-scale-stage="1"]') !== null,
      rootScrollOverflow: root.scrollHeight - root.clientHeight,
      contentBottom: content?.getBoundingClientRect()?.bottom ?? -1,
      footerBottom: footerRect?.bottom ?? -1,
      footerVisible: footerRect !== null && footerRect.top >= 0 && footerRect.bottom <= window.innerHeight + 1,
      columnBottoms: columns.map((col) => col.getBoundingClientRect().bottom),
      headerTop: header?.getBoundingClientRect()!.top,
      headerBottom: header?.getBoundingClientRect()!.bottom,
      formTop: form?.getBoundingClientRect()?.top ?? -1,
      formBottom: form?.getBoundingClientRect()?.bottom ?? -1,
      messagesTop: messages?.getBoundingClientRect()!.top,
      messagesBottom: messages?.getBoundingClientRect()!.bottom,
      messagesClientHeight: messages.clientHeight,
      messagesScrollHeight: messages.scrollHeight,
      messagesDistanceFromBottom: messages.scrollHeight - messages.scrollTop - messages.clientHeight,
      listScrollable: list !== null && getComputedStyle(list).overflowY === 'auto',
      emojiBottom: columns[2]?.getBoundingClientRect().bottom ?? -1,
    }
  })
}

console.log('\ncheckDesktopChatViewportHeight\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/chatDraftHarness.html`
  browser = await chromium.launch()

  const desktopViewports = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1200 },
  ]
  const results: Array<{ label: string; metrics: Metrics }> = []

  for (const viewport of desktopViewports) {
    const label = `[${viewport.width}×${viewport.height}]`
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
    await openChatWithManyMessages(page)
    const m = await measure(page)
    results.push({ label, metrics: m })
    console.log(`  ${label} messages=${m.messagesClientHeight}px scrollHeight=${m.messagesScrollHeight}px footerBottom=${m.footerBottom.toFixed(1)} contentBottom=${m.contentBottom.toFixed(1)} rootOverflow=${m.rootScrollOverflow}`)

    await check(`${label} desktop layout (scale stage) is used`, () => assert(m.hasScaleStage, 'missing data-lobby-scale-stage'))
    await check(`${label} no page-level vertical scroll`, () => assert(m.rootScrollOverflow <= 1, `root overflows by ${m.rootScrollOverflow}px`))
    await check(`${label} chat content reaches the bottom of the viewport (no empty zone)`, () =>
      assert(Math.abs(m.contentBottom - m.viewportHeight) <= 1.5, `content bottom ${m.contentBottom} vs viewport ${m.viewportHeight}`))
    await check(`${label} footer is visible right under the chat`, () => {
      assert(m.footerVisible, `footer not fully visible (bottom ${m.footerBottom})`)
      assert(m.footerBottom > m.columnBottoms[1]!, 'footer is not below the chat')
      assert(m.footerBottom - m.columnBottoms[1]! < 120, `gap between chat and footer bottom too large: ${m.footerBottom - m.columnBottoms[1]!}`)
    })
    await check(`${label} the three columns end on the same line`, () => {
      assert(m.columnBottoms.length === 3, `expected 3 columns, got ${m.columnBottoms.length}`)
      const spread = Math.max(...m.columnBottoms) - Math.min(...m.columnBottoms)
      assert(spread <= 1, `column bottoms differ by ${spread}px: ${m.columnBottoms.join(', ')}`)
    })
    await check(`${label} header on top, composer at the bottom, messages fill the space between`, () => {
      assert(Math.abs(m.messagesTop - m.headerBottom) <= 1.5, `messages not directly under header (${m.messagesTop} vs ${m.headerBottom})`)
      assert(Math.abs(m.formTop - m.messagesBottom) <= 1.5, `composer not directly under messages (${m.formTop} vs ${m.messagesBottom})`)
      assert(m.formBottom <= m.columnBottoms[1]! + 1, 'composer overflows the center column')
      assert(m.formBottom <= m.viewportHeight, 'composer is outside the viewport')
    })
    await check(`${label} only the message history scrolls internally and starts at the latest message`, () => {
      assert(m.messagesScrollHeight > m.messagesClientHeight, 'messages should overflow internally with 60 messages')
      assert(m.messagesDistanceFromBottom <= 2, `not scrolled to latest (distance ${m.messagesDistanceFromBottom}px)`)
    })
    await check(`${label} conversation list keeps its own vertical scroll`, () => assert(m.listScrollable, 'conversation list is not a scroll container'))
    await check(`${label} emoji panel stays inside the viewport`, () => assert(m.emojiBottom <= m.viewportHeight, `emoji panel bottom ${m.emojiBottom}`))

    // Ново входящо съобщение при отворен разговор -> остава на последното.
    await page.evaluate(() => (window as any).__chatDraftHarness.deliverIncomingMessage('friendship-a', 'Последно съобщение'))
    await page.waitForTimeout(250)
    const after = await measure(page)
    await check(`${label} scroll-to-latest still works after a new incoming message`, () =>
      assert(after.messagesDistanceFromBottom <= 2, `distance from bottom ${after.messagesDistanceFromBottom}px`))
    await check(`${label} no JS errors`, () => assert(errors.length === 0, errors.join(' | ')))
    await context.close()
  }

  const byLabel = Object.fromEntries(results.map((r) => [r.label, r.metrics]))
  await check('taller viewport (1920×1200) shows a taller message area than 1920×1080', () =>
    assert(byLabel['[1920×1200]']!.messagesClientHeight > byLabel['[1920×1080]']!.messagesClientHeight + 50,
      `${byLabel['[1920×1200]']!.messagesClientHeight} vs ${byLabel['[1920×1080]']!.messagesClientHeight}`))

  // Нисък desktop viewport под минималната височина на чата -> чатът спира да
  // се свива (min-height), страницата скролва, composer-ът остава достъпен.
  {
    const context = await browser.newContext({ viewport: { width: 1366, height: 420 } })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
    await openChatWithManyMessages(page)
    const m = await measure(page)
    await check('[1366×420] very short viewport: messages keep a usable height and the page scrolls instead of crushing the chat', () => {
      assert(m.messagesClientHeight >= 150, `messages too small: ${m.messagesClientHeight}`)
      assert(m.rootScrollOverflow > 0, 'expected page scroll on a very short viewport')
      assert(m.formTop > m.messagesTop, 'composer must stay under the messages')
    })
    await context.close()
  }

  // ─── Mobile (phone layout) — не трябва да е засегнат ───────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }) // без isMobile: harness HTML-ът няма viewport meta (иначе layout width = 980px)
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__chatDraftHarness !== undefined, undefined, { timeout: 10_000 })
    await openChatWithManyMessages(page)
    const mobile = await page.evaluate(() => {
      const messages = document.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')
      const root = document.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')
      return {
        hasScaleStage: document.querySelector('[data-lobby-scale-stage="1"]') !== null,
        mobileLayout: root?.getAttribute('data-mobile-layout') === '1',
        messagesStyleHeight: messages?.style.height ?? null,
        rootDisplay: root ? getComputedStyle(root).display : null,
      }
    })
    await check('[mobile 390×844] phone layout keeps its own chat panel unchanged (fixed 360px history, block root)', () => {
      assert(mobile.mobileLayout && !mobile.hasScaleStage, `not in phone layout: ${JSON.stringify(mobile)}`)
      assert(mobile.messagesStyleHeight === '360px', `mobile history height changed: ${mobile.messagesStyleHeight}`)
      assert(mobile.rootDisplay === 'block', `mobile root display changed: ${mobile.rootDisplay}`)
    })
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

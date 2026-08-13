/**
 * Current Topics navigation regression.
 *
 * The visible Topics UI was simplified to "Общ | Лични"; legacy directory
 * chips, create-topic "+", and horizontal arrows are intentionally absent.
 * The old A/B chip race no longer has a user entry point, so this guard keeps:
 * - source-level generation-token protection in the controller;
 * - browser-level simplified navigation and scroll isolation checks.
 */
import { readFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page, type ViewportSize } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: got ${String(actual)}, expected ${String(expected)}`)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type Harness = {
  openTopicsScreen: () => void
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => void
  setNextMessagesResult: (messages: unknown[], hasMore?: boolean) => void
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  clickTopicsPersonalOpen: () => void
  clickTopicsBackToGeneral: () => void
  isTopicsStreamVisible: () => boolean
  getTopicsPersonalPanelView: () => string | null
  getMessagesScrollTop: () => number | null
}

async function call<T>(page: Page, fn: (h: Harness, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__topicsComposerVipGateHarness as Harness
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: Harness, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

async function makeMessages(page: Page, count: number): Promise<any[]> {
  return call(page, (h: Harness, total: number) => {
    return Array.from({ length: total }, (_value, index) => {
      const seq = index + 1
      const msg = h.makeMessage('topic-general', seq, `message ${seq} ${'body '.repeat(8)}`)
      msg.messageId = `topic-general-current-${seq}`
      msg.unreadCount = 0
      msg.attachment = null
      return msg
    })
  }, count)
}

async function openTopicsWithMessages(page: Page, messages: unknown[], hasMore = false): Promise<void> {
  await call(page, (h: Harness) => h.setVipGate(true, true))
  await call(page, (h: Harness, arg: { messages: unknown[]; hasMore: boolean }) => h.setNextMessagesResult(arg.messages, arg.hasMore), { messages, hasMore })
  await call(page, (h: Harness) => h.openTopicsScreen())
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-topic-message]').length === count,
    messages.length,
    { timeout: 5000 },
  )
}

const controllerSource = await readFile('src/app/lobby/createLobbyFlowController.ts', 'utf8')

await check('[1] controller still uses generation token for topic message loads', () => {
  assert(controllerSource.includes('++state.topicMessagesRequestGeneration'), 'missing topicMessagesRequestGeneration increment')
  assert(controllerSource.includes('state.topicMessagesRequestGeneration !== requestGeneration'), 'missing stale response generation guard')
  assert(controllerSource.includes('loadTopicMessagesForActiveTopic'), 'missing topic message load path')
})

await check('[2] legacy topic strip entry points remain absent from render source', async () => {
  const renderSource = await readFile('src/app/lobby/renderTopicsScreen.ts', 'utf8')
  assert(!renderSource.includes('data-topics-bar-scroll="1"'), 'legacy horizontal topic strip should not render')
  assert(!renderSource.includes('data-topics-create="1"'), 'legacy create-topic plus button should not render')
  assert(!renderSource.includes('data-topics-arrow='), 'legacy arrow controls should not render')
  assert(renderSource.includes('data-topics-back-to-general="1"'), 'General action should remain visible')
  assert(renderSource.includes('data-topics-personal-open="1"'), 'Personal action should remain visible')
})

const port = await findFreePort()
const vite: ViteDevServer = await createViteServer({
  root: process.cwd(),
  server: { host: '127.0.0.1', port, strictPort: true },
  logLevel: 'silent',
})
await vite.listen()

let browser: Browser | null = null
try {
  browser = await chromium.launch({ headless: true })
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`

  async function withPage(viewport: ViewportSize, fn: (page: Page) => Promise<void>): Promise<void> {
    const page = await browser!.newPage({ viewport })
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })
    try {
      await fn(page)
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
    } finally {
      await page.close()
    }
  }

  for (const [label, viewport] of [
    ['mobile-390', { width: 390, height: 844 }],
    ['mobile-360', { width: 360, height: 800 }],
    ['desktop', { width: 1280, height: 900 }],
  ] as const) {
    await check(`[3.${label}] simplified Topics nav is stable without legacy strip`, async () => {
      await withPage(viewport, async (page) => {
        const messages = await makeMessages(page, 32)
        await openTopicsWithMessages(page, messages, true)
        const nav = await page.evaluate(() => {
          const general = document.querySelector<HTMLElement>('[data-topics-back-to-general="1"]')
          const personal = document.querySelector<HTMLElement>('[data-topics-personal-open="1"]')
          const stream = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
          return {
            hasLegacyChip: document.querySelector('[data-topic-chip]') !== null,
            hasLegacyStrip: document.querySelector('[data-topics-bar-scroll="1"]') !== null,
            hasLegacyCreate: document.querySelector('[data-topics-create="1"]') !== null,
            hasLegacyArrow: document.querySelector('[data-topics-arrow]') !== null,
            generalText: general?.textContent ?? '',
            generalPressed: general?.getAttribute('aria-pressed') ?? null,
            personalText: personal?.textContent ?? '',
            bodyScrollWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth,
            streamTop: stream?.getBoundingClientRect().top ?? null,
          }
        })
        assertEqual(nav.hasLegacyChip, false, `${label}: legacy topic chips should be absent`)
        assertEqual(nav.hasLegacyStrip, false, `${label}: legacy horizontal strip should be absent`)
        assertEqual(nav.hasLegacyCreate, false, `${label}: legacy create-topic control should be absent`)
        assertEqual(nav.hasLegacyArrow, false, `${label}: legacy arrows should be absent`)
        assert(nav.generalText.includes('Общ'), `${label}: General action missing`)
        assertEqual(nav.generalPressed, 'true', `${label}: General should be active`)
        assert(nav.personalText.includes('Лични'), `${label}: Personal action missing`)
        assert(nav.bodyScrollWidth <= nav.viewportWidth + 1, `${label}: horizontal overflow`)
        assert(nav.streamTop !== null && nav.streamTop > 0, `${label}: stream should be measurable`)
      })
    })

    await check(`[4.${label}] Personal and General navigation do not create stale topic context`, async () => {
      await withPage(viewport, async (page) => {
        const messages = await makeMessages(page, 8)
        await openTopicsWithMessages(page, messages)
        await call(page, (h: Harness) => h.clickTopicsPersonalOpen())
        await page.waitForTimeout(80)
        assertEqual(await call(page, (h: Harness) => h.isTopicsStreamVisible()), false, `${label}: Personal should hide topic stream`)
        assertEqual(await call(page, (h: Harness) => h.getTopicsPersonalPanelView()), 'list', `${label}: Personal should open list view`)
        await call(page, (h: Harness) => h.clickTopicsBackToGeneral())
        await page.waitForTimeout(80)
        assertEqual(await call(page, (h: Harness) => h.isTopicsStreamVisible()), true, `${label}: General should restore topic stream`)
      })
    })

    await check(`[5.${label}] topic stream contains vertical scroll and opens at top`, async () => {
      await withPage(viewport, async (page) => {
        const messages = await makeMessages(page, 48)
        await openTopicsWithMessages(page, messages, true)
        const metrics = await page.evaluate(() => {
          const stream = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
          return stream
            ? { scrollTop: stream.scrollTop, canScroll: stream.scrollHeight > stream.clientHeight + 120, windowScrollY: window.scrollY }
            : null
        })
        assert(metrics !== null, `${label}: missing topic stream`)
        assertEqual(metrics!.scrollTop, 0, `${label}: activity feed should open at top`)
        assertEqual(metrics!.canScroll, true, `${label}: stream should be vertical scroll container`)
        assertEqual(metrics!.windowScrollY, 0, `${label}: window should not scroll`)
      })
    })
  }
} finally {
  if (browser) await browser.close()
  await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

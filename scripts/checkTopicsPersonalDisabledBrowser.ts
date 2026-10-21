/**
 * checkTopicsPersonalDisabledBrowser.ts
 *
 * Real browser (Playwright) + real production controller/render code (през
 * scripts/fixtures/topicsComposerVipGateHarness.ts) за TOPICS_PERSONAL_ENABLED
 * (server/src/shared/topicsPersonalFeatureFlag.ts) и "Лафче" по подразбиране.
 *
 * OFF (?topicsPersonal=0), desktop + mobile:
 *  [1] "Теми" се отваря на "Лафче"; няма "Лични" бутон (без празно място —
 *      header-ът съдържа само "Лафче" + "Общи");
 *  [2] "Общи" се отваря с клик и рендира публикациите; няма "Лично" бутони
 *      под публикации/отговори; thread header-ът също е без "Лични";
 *  [3] Back от thread връща в "Общи" (history не е нарушена);
 *  [4] опит за отваряне на стар vip_dm ("Виж" от chat известие) води в
 *      "Лафче", без личния панел и без page error;
 *  [5] friend разговор ("Виж") отваря основния Чат както досега.
 * ON (по подразбиране в harness-а):
 *  [6] "Лични" и "Лично" са видими, vip_dm "Виж" отваря "Лични" (както досега).
 * Стандартно влизане в "Теми" (флагът OFF и ON) през РЕАЛНИТЕ nav елементи:
 *  [7] клик "Теми" в десктоп навбара / мобилното меню → "Лафче";
 *  [8] "Общи" + отворена публикация → друг екран → пак "Теми" → "Лафче"
 *      (предишната секция не се помни); клик "Теми" от "Общи" → "Лафче";
 *  [9] Back/Forward до /topics (popstate → navigateFromPath) → "Лафче".
 */

import { createServer as createNetServer } from 'node:net'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
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

type Harness = any

async function call<T>(page: Page, fn: (h: Harness, arg: any) => T, arg?: unknown): Promise<T> {
  return page.evaluate(
    ({ fn: source, arg: value }) => {
      const h = (window as any).__topicsComposerVipGateHarness
      // eslint-disable-next-line no-new-func
      return new Function('h', 'arg', `return (${source})(h, arg)`)(h, value)
    },
    { fn: fn.toString(), arg },
  ) as Promise<T>
}

const LAFCHE = 'topic-lafche'
const GENERAL = 'topic-general'

async function prepareTopics(page: Page): Promise<void> {
  await call(page, (h: Harness) => h.setVipGate(true, true))
  await call(page, (h: Harness, ids: { lafche: string; general: string }) => h.setTopicDirectoryResponse([
    { topicId: ids.general, slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 0 },
    { topicId: ids.lafche, slug: 'lafche', title: 'Лафче', isGeneral: false, unreadCount: 0 },
  ]), { lafche: LAFCHE, general: GENERAL })
  // Чужди публикации в "Общи" — само при тях production кодът би показал "Лично".
  await call(page, (h: Harness, general: string) => {
    const messages = [1, 2, 3].map((seq) => {
      const msg = h.makeMessage(general, seq, `публикация ${seq}`, `author-${seq}`, `Автор ${seq}`)
      msg.messageId = `general-root-${seq}`
      msg.attachment = null
      return msg
    })
    h.setNextMessagesResult(messages)
  }, GENERAL)
}

const activeSection = (page: Page) => page.evaluate(() => ({
  lafche: document.querySelector('[data-topics-lafche-open="1"]')?.getAttribute('aria-pressed') ?? null,
  general: document.querySelector('[data-topics-back-to-general="1"]')?.getAttribute('aria-pressed') ?? null,
}))

const personalOpenCount = (page: Page) => page.evaluate(() => document.querySelectorAll('[data-topics-personal-open="1"]').length)
const personalMessageButtonCount = (page: Page) => page.evaluate(() => document.querySelectorAll('[data-topic-message-personal]').length)
const headerText = (page: Page) => page.evaluate(() => document.querySelector('[data-topics-fixed-top="1"]')?.textContent ?? '')
const personalPanelVisible = (page: Page) => page.evaluate(() => document.querySelector('[data-topics-personal-panel="1"]') !== null)

async function openGeneral(page: Page): Promise<void> {
  await page.locator('[data-topics-back-to-general="1"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-topic-card-open]').length === 3, undefined, { timeout: 5000 })
}

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

  async function withPage(viewport: { width: number; height: number }, query: string, fn: (page: Page) => Promise<void>): Promise<void> {
    const page = await browser!.newPage({ viewport })
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`${baseUrl}${query}`)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })
    try {
      await fn(page)
      assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
    } finally {
      await page.close()
    }
  }

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile-390', { width: 390, height: 844 }],
    ['mobile-360', { width: 360, height: 800 }],
  ] as const) {
    console.log(`\n--- OFF / ${label} ---`)

    await check(`[1.${label}] OFF: "Теми" се отваря на "Лафче", без "Лични" и без празно място`, async () => {
      await withPage(viewport, '?topicsPersonal=0', async (page) => {
        await prepareTopics(page)
        await call(page, (h: Harness) => h.openTopicsScreen())
        await page.waitForSelector('[data-topics-lafche-open="1"]', { timeout: 5000 })
        const section = await activeSection(page)
        assertEqual(section.lafche, 'true', 'Лафче active')
        assertEqual(section.general, 'false', 'Общи inactive')
        assertEqual(await personalOpenCount(page), 0, '"Лични" button count')
        assert(!(await headerText(page)).includes('Лични'), 'header must not contain "Лични"')
        const actions = await page.evaluate(() => Array.from(document.querySelector('[data-topics-header-actions="1"]')?.children ?? []).map((el) => el.getAttribute('data-topics-lafche-open') ? 'lafche' : el.getAttribute('data-topics-back-to-general') ? 'general' : el.tagName))
        assertEqual(actions.join(','), 'lafche,general', 'header actions are exactly Лафче + Общи')
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
        assert(!overflow, 'horizontal overflow')
      })
    })

    await check(`[2.${label}] OFF: "Общи" работи, без "Лично" под публикации, отговори и в thread`, async () => {
      await withPage(viewport, '?topicsPersonal=0', async (page) => {
        await prepareTopics(page)
        await call(page, (h: Harness) => h.openTopicsScreen())
        await page.waitForSelector('[data-topics-back-to-general="1"]', { timeout: 5000 })
        await openGeneral(page)
        const section = await activeSection(page)
        assertEqual(section.general, 'true', 'Общи active after click')
        assertEqual(await personalMessageButtonCount(page), 0, '"Лично" buttons in Общи')
        await call(page, (h: Harness, general: string) => {
          h.setNextRepliesResult([h.makeReply(general, 10, 'general-root-1', 'отговор', 'replier', 'Отговарящ')])
        }, GENERAL)
        await call(page, (h: Harness) => h.clickRootCard('general-root-1'))
        await page.waitForSelector('[data-topic-thread-scroll="1"]', { timeout: 5000 })
        await page.waitForTimeout(150)
        assertEqual(await personalMessageButtonCount(page), 0, '"Лично" buttons in thread (root + replies)')
        assertEqual(await personalOpenCount(page), 0, '"Лични" in thread header')
        assert(await page.evaluate(() => document.querySelector('[data-topic-thread-back="1"]') !== null), 'thread back to Общи visible')
      })
    })

    await check(`[3.${label}] OFF: Back от thread връща в "Общи" (history)`, async () => {
      await withPage(viewport, '?topicsPersonal=0', async (page) => {
        await prepareTopics(page)
        await call(page, (h: Harness) => h.openTopicsScreen())
        await page.waitForSelector('[data-topics-back-to-general="1"]', { timeout: 5000 })
        await openGeneral(page)
        await call(page, (h: Harness) => h.clickRootCard('general-root-2'))
        await page.waitForSelector('[data-topic-thread-scroll="1"]', { timeout: 5000 })
        await page.goBack()
        await page.waitForFunction(() => document.querySelector('[data-topic-thread-scroll="1"]') === null, undefined, { timeout: 5000 })
        assertEqual((await activeSection(page)).general, 'true', 'Общи active after Back')
        assertEqual(await page.evaluate(() => document.querySelectorAll('[data-topic-card-open]').length), 3, 'Общи posts visible after Back')
      })
    })

    await check(`[4.${label}] OFF: стар vip_dm ("Виж") води в "Лафче", без личния панел`, async () => {
      await withPage(viewport, '?topicsPersonal=0', async (page) => {
        await prepareTopics(page)
        await call(page, (h: Harness) => h.setChatConversations([
          h.makeConversation('OLD_VIPDM', 'vip_dm', 'stranger', 'Непознат'),
        ]))
        await call(page, (h: Harness) => h.openChatConversation('OLD_VIPDM'))
        await page.waitForSelector('[data-topics-lafche-open="1"]', { timeout: 5000 })
        await page.waitForTimeout(150)
        assertEqual(await personalPanelVisible(page), false, 'personal panel visible')
        assertEqual(await call(page, (h: Harness) => h.isTopicsPersonalDetailVisible()), false, 'personal detail visible')
        assertEqual((await activeSection(page)).lafche, 'true', 'Лафче active')
        assertEqual(await call(page, (h: Harness) => h.isLegacyChatScreenVisible()), false, 'vip_dm must not open main Chat')
      })
    })

    await check(`[5.${label}] OFF: friend разговор ("Виж") отваря основния Чат както досега`, async () => {
      await withPage(viewport, '?topicsPersonal=0', async (page) => {
        await call(page, (h: Harness) => h.setChatConversations([
          h.makeConversation('FRIEND_CONV', 'friend', 'friend-1', 'Приятел'),
          h.makeConversation('OLD_VIPDM', 'vip_dm', 'friend-1', 'Приятел'),
        ]))
        await call(page, (h: Harness) => h.openChatConversation('FRIEND_CONV'))
        await page.waitForFunction(() => document.querySelector('[data-lobby-chat-form]') !== null, undefined, { timeout: 5000 })
        await page.waitForTimeout(100)
        assertEqual(await call(page, (h: Harness) => h.getChatFormFriendshipId()), 'FRIEND_CONV', 'chat form friendshipId')
        assertEqual(await call(page, (h: Harness) => h.isTopicsScreenVisible()), false, 'Topics screen visible')
      })
    })
  }

  // ─── Стандартно влизане в "Теми" през РЕАЛНИТЕ nav елементи ──────────────
  // Desktop: <a href="/topics" data-lobby-nav-topics> в горния навбар.
  // Mobile: <button data-lobby-nav-topics> в мобилното меню (<details>).
  // И двата минават през onTopicsClick → showTopicsDirectory().
  async function clickNav(page: Page, name: 'topics' | 'chat', isMobile: boolean): Promise<void> {
    // Harness-ът не рендира лобито, докато нищо не е извикало render()
    // (в production main.ts го прави при старт).
    if (await page.locator(`[data-lobby-nav-${name}="1"]`).count() === 0) {
      await call(page, (h: Harness) => h.render())
    }
    if (isMobile) {
      await call(page, (h: Harness) => h.openMobileMenu())
    }
    const target = page.locator(`[data-lobby-nav-${name}="1"]:visible`).first()
    await target.waitFor({ state: 'visible', timeout: 5000 })
    if (isMobile) {
      const inMenu = await target.evaluate((el) => el.closest('[data-lobby-mobile-menu="1"]') !== null)
      assert(inMenu, `mobile "${name}" click must come from the mobile menu`)
    } else {
      const inMenu = await target.evaluate((el) => el.closest('[data-lobby-mobile-menu="1"]') !== null)
      assert(!inMenu, `desktop "${name}" click must come from the top navbar`)
    }
    await target.click()
  }

  async function waitLafcheActive(page: Page): Promise<void> {
    await page.waitForFunction(
      () => document.querySelector('[data-topics-lafche-open="1"]')?.getAttribute('aria-pressed') === 'true',
      undefined,
      { timeout: 5000 },
    )
  }

  async function waitTopicsGone(page: Page): Promise<void> {
    await page.waitForFunction(() => document.querySelector('[data-topics-screen="1"]') === null, undefined, { timeout: 5000 })
  }

  for (const [label, viewport, isMobile, query] of [
    ['desktop', { width: 1280, height: 900 }, false, '?topicsPersonal=0'],
    ['mobile-390', { width: 390, height: 844 }, true, '?topicsPersonal=0'],
    ['mobile-360', { width: 360, height: 800 }, true, '?topicsPersonal=0'],
    ['desktop-flag-on', { width: 1280, height: 900 }, false, ''],
  ] as const) {
    console.log(`\n--- навигация "Теми" / ${label} ---`)

    await check(`[7.${label}] клик "Теми" (${isMobile ? 'мобилно меню' : 'десктоп навбар'}) → "Лафче", не "Общи"`, async () => {
      await withPage(viewport, query, async (page) => {
        await prepareTopics(page)
        await clickNav(page, 'topics', isMobile)
        await waitLafcheActive(page)
        const section = await activeSection(page)
        assertEqual(section.lafche, 'true', 'Лафче active')
        assertEqual(section.general, 'false', 'Общи inactive')
      })
    })

    await check(`[8.${label}] "Общи" (+ отворена публикация) → излизане → пак "Теми" → "Лафче"`, async () => {
      await withPage(viewport, query, async (page) => {
        await prepareTopics(page)
        await clickNav(page, 'topics', isMobile)
        await waitLafcheActive(page)
        await openGeneral(page)
        assertEqual((await activeSection(page)).general, 'true', 'Общи active before leaving')
        await call(page, (h: Harness) => h.clickRootCard('general-root-1'))
        await page.waitForSelector('[data-topic-thread-scroll="1"]', { timeout: 5000 })

        await clickNav(page, 'chat', isMobile)
        await waitTopicsGone(page)

        await clickNav(page, 'topics', isMobile)
        await waitLafcheActive(page)
        const section = await activeSection(page)
        assertEqual(section.lafche, 'true', 'Лафче active after re-entry')
        assertEqual(section.general, 'false', 'Общи must not be remembered')
        assertEqual(await page.evaluate(() => document.querySelector('[data-topic-thread-scroll="1"]') !== null), false, 'thread must not be restored')

        // Повторно влизане от "Общи" без междинен екран.
        await openGeneral(page)
        await clickNav(page, 'topics', isMobile)
        await waitLafcheActive(page)
        assertEqual((await activeSection(page)).general, 'false', 'Общи inactive after clicking "Теми" from Общи')
      })
    })
  }

  await check('[9] Back/Forward до /topics (navigateFromPath) също започва от "Лафче"', async () => {
    await withPage({ width: 1280, height: 900 }, '?topicsPersonal=0', async (page) => {
      await prepareTopics(page)
      // Production main.ts вика navigateInitialPath() при старт — то активира
      // URL синхронизацията (pushState при смяна на екран + popstate routing).
      await call(page, (h: Harness) => h.controller.navigateInitialPath())
      await clickNav(page, 'topics', false)
      await waitLafcheActive(page)
      assertEqual(await page.evaluate(() => location.pathname), '/topics', 'URL after Теми')
      await openGeneral(page)
      await clickNav(page, 'chat', false)
      await waitTopicsGone(page)
      assertEqual(await page.evaluate(() => location.pathname), '/chat', 'URL after Чат')
      await page.goBack()
      await waitLafcheActive(page)
      assertEqual((await activeSection(page)).general, 'false', 'Общи inactive after Back to /topics')
      await page.goForward()
      await waitTopicsGone(page)
    })
  })

  console.log('\n--- ON (restore) ---')
  await check('[6] ON: "Лични" + "Лично" видими и vip_dm "Виж" отваря "Лични" (както досега)', async () => {
    await withPage({ width: 1280, height: 900 }, '', async (page) => {
      await prepareTopics(page)
      await call(page, (h: Harness) => h.openTopicsScreen())
      await page.waitForSelector('[data-topics-lafche-open="1"]', { timeout: 5000 })
      assertEqual((await activeSection(page)).lafche, 'true', 'Лафче default also when ON')
      assertEqual(await personalOpenCount(page), 1, '"Лични" button count')
      await openGeneral(page)
      assertEqual(await personalMessageButtonCount(page), 3, '"Лично" under each foreign post')
      await call(page, (h: Harness) => h.setChatConversations([
        h.makeConversation('OLD_VIPDM', 'vip_dm', 'stranger', 'Непознат'),
      ]))
      await call(page, (h: Harness) => h.openChatConversation('OLD_VIPDM'))
      await page.waitForSelector('[data-topics-personal-panel="1"]', { timeout: 5000 })
      assertEqual(await call(page, (h: Harness) => h.getChatFormFriendshipId()), 'OLD_VIPDM', 'old vip_dm opens again')
    })
  })
} finally {
  await browser?.close()
  await vite.close()
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)
process.exit(failed > 0 ? 1 : 0)

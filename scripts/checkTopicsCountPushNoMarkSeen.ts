/**
 * checkTopicsCountPushNoMarkSeen.ts
 *
 * Push за брояч (topic_unread_count_changed / topic_thread_unread_count_changed)
 * НИКОГА сам не маркира като прочетено — нито за „Лафче“, докато е отворено
 * (вкл. прозореца при повторно свързване преди повторния абонамент), нито за
 * отворена нишка в „Общи“. Маркирането остава при пристигнало съдържание
 * (topic_message / topic_reply) и при отваряне. Реалният контролер в
 * Playwright, със stub-нат backend (scripts/fixtures/topicsCountPushNoMarkSeenHarness.ts).
 */
import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
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

async function h<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(({ method: m, args: a }) => {
    const harness = (window as any).__topicsCountPushNoMarkSeenHarness
    return harness[m](...a)
  }, { method, args }) as Promise<T>
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((r) => setTimeout(r, 150)))
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/topicsCountPushNoMarkSeenHarness.html`)
  await page.waitForFunction(() => (window as any).__topicsCountPushNoMarkSeenHarness !== undefined, undefined, { timeout: 15_000 })

  console.log('\n[L] „Лафче“ е отворено')
  await h(page, 'openTopicsScreen')
  await settle(page)
  await h(page, 'openLafche')
  await settle(page)

  await check('[L0] Отварянето на „Лафче“ маркира темата (очаквано — съдържанието е показано)', async () => {
    assertEqual((await h<string[]>(page, 'getMarkSeenLog')).includes('topic-lafche'), true, 'onTopicMarkSeen при отваряне')
  })

  await check('[L1] Push за брояч на „Лафче“, докато е отворено (напр. reconnect преди повторния абонамент / отмяна на заявка) -> НЕ маркира', async () => {
    await h(page, 'clearLogs')
    await h(page, 'send', { type: 'topic_unread_count_changed', topicId: 'topic-lafche', unreadCount: 3 })
    await settle(page)
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
  })

  await check('[L2] Контрола: пристигнало съобщение в отвореното „Лафче“ -> маркира (поведението при съдържание е запазено)', async () => {
    await h(page, 'clearLogs')
    const message = await h<unknown>(page, 'makeMessage', 'topic-lafche', 'lafche-live-1')
    await h(page, 'send', { type: 'topic_message', ...(message as object) })
    await settle(page)
    assertEqual((await h<string[]>(page, 'getMarkSeenLog')).includes('topic-lafche'), true, 'onTopicMarkSeen след topic_message')
  })

  console.log('\n[G] „Общи“ — списък и отворена нишка')
  await h(page, 'openGeneral')
  await settle(page)

  await check('[G1] Push за брояч на неотворена нишка -> бадж-ът на картата се обновява (3) без маркиране; „Общи“ = 3', async () => {
    await h(page, 'clearLogs')
    assertEqual(await h<boolean>(page, 'hasCard', 'general-root-a'), true, 'картата е в списъка')
    await h(page, 'send', { type: 'topic_thread_unread_count_changed', topicId: 'topic-general', rootMessageId: 'general-root-a', unreadCount: 3, topicUnreadCount: 3 })
    await settle(page)
    assertEqual(await h<string | null>(page, 'getThreadBadgeText', 'general-root-a'), '3', 'бадж на картата')
    assertEqual(await h<string | null>(page, 'getGeneralBadgeText'), '3', 'бадж на „Общи“')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
  })

  await check('[G2] Push за по-малък брояч (скриване на профил) -> бадж-ът на картата пада 3 -> 1, без маркиране', async () => {
    await h(page, 'clearLogs')
    await h(page, 'send', { type: 'topic_thread_unread_count_changed', topicId: 'topic-general', rootMessageId: 'general-root-a', unreadCount: 1, topicUnreadCount: 1 })
    await settle(page)
    assertEqual(await h<string | null>(page, 'getThreadBadgeText', 'general-root-a'), '1', 'бадж на картата')
    assertEqual(await h<string | null>(page, 'getGeneralBadgeText'), '1', 'бадж на „Общи“')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
  })

  await h(page, 'openThread', 'general-root-b')
  await settle(page)

  await check('[G3] Отварянето на нишка я маркира (очаквано)', async () => {
    assertEqual(await h<boolean>(page, 'isThreadOpen'), true, 'нишката е отворена')
    assertEqual((await h<string[]>(page, 'getThreadMarkSeenLog')).includes('general-root-b'), true, 'onTopicThreadMarkSeen при отваряне')
  })

  await check('[G4] Push за брояч на ОТВОРЕНАТА нишка (отмяна на заявка — отново показани отговори) -> НЕ маркира; след връщане картата показва реалния брой', async () => {
    await h(page, 'clearLogs')
    await h(page, 'send', { type: 'topic_thread_unread_count_changed', topicId: 'topic-general', rootMessageId: 'general-root-b', unreadCount: 2, topicUnreadCount: 3 })
    await settle(page)
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
    await h(page, 'backFromThread')
    await settle(page)
    assertEqual(await h<string | null>(page, 'getThreadBadgeText', 'general-root-b'), '2', 'бадж на картата след връщане')
    assertEqual(await h<string | null>(page, 'getGeneralBadgeText'), '3', 'бадж на „Общи“')
  })

  await check('[G5] Контрола: пристигнал отговор в отворената нишка -> маркира нишката', async () => {
    await h(page, 'openThread', 'general-root-b')
    await settle(page)
    await h(page, 'clearLogs')
    const reply = await h<unknown>(page, 'makeReply', 'general-root-b', 'reply-live-1')
    await h(page, 'send', { type: 'topic_reply', ...(reply as object) })
    await settle(page)
    assertEqual((await h<string[]>(page, 'getThreadMarkSeenLog')).includes('general-root-b'), true, 'onTopicThreadMarkSeen след topic_reply')
  })

  console.log('\n[V] Самоизтриване — картата изчезва / се връща на отворения екран')
  await h(page, 'backFromThread')
  await settle(page)

  await check('[V1] Скриване (topic_message_deleted, root над видимата зона): картата изчезва без пълен render и без скок на видимото съдържание; без маркиране', async () => {
    assertEqual(await h<boolean>(page, 'scrollCardToTop', 'general-root-15'), true, 'скрол до root-15')
    await settle(page)
    const offsetBefore = await h<number>(page, 'getCardOffset', 'general-root-15')
    const rendersBefore = await h<number>(page, 'getRenderCount')
    await h(page, 'clearLogs')
    await h(page, 'send', { type: 'topic_message_deleted', topicId: 'topic-general', messageId: 'general-root-05', parentMessageId: null, deletedAt: new Date().toISOString() })
    await settle(page)
    assertEqual((await h<string[]>(page, 'getCardOrder')).includes('general-root-05'), false, 'картата е махната')
    assertEqual(await h<number>(page, 'getRenderCount'), rendersBefore, 'без пълен render')
    const offsetAfter = await h<number>(page, 'getCardOffset', 'general-root-15')
    assertEqual(Math.abs(offsetAfter - offsetBefore) <= 2, true, `видимата карта не подскача (${offsetBefore} -> ${offsetAfter})`)
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
  })

  await check('[V2] Отмяна (topic_message_catchup): картата се връща на мястото си по активност, с бройката си; видимото съдържание не подскача; без маркиране', async () => {
    const offsetBefore = await h<number>(page, 'getCardOffset', 'general-root-15')
    await h(page, 'clearLogs')
    const restored = await h<unknown>(page, 'makeMessage', 'topic-general', 'general-root-05', 2, 5)
    await h(page, 'send', { type: 'topic_message_catchup', topicId: 'topic-general', messages: [restored], truncated: false })
    await settle(page)
    const order = await h<string[]>(page, 'getCardOrder')
    const index = order.indexOf('general-root-05')
    assertEqual(order[index - 1], 'general-root-04', 'преди нея')
    assertEqual(order[index + 1], 'general-root-06', 'след нея')
    assertEqual(await h<string | null>(page, 'getThreadBadgeText', 'general-root-05'), '2', 'бройка на картата')
    const offsetAfter = await h<number>(page, 'getCardOffset', 'general-root-15')
    assertEqual(Math.abs(offsetAfter - offsetBefore) <= 2, true, `видимата карта не подскача (${offsetBefore} -> ${offsetAfter})`)
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
  })

  await check('[V3] Скриване на нишката, която е отворена: връщане към списъка, картата я няма; без маркиране', async () => {
    await h(page, 'openThread', 'general-root-10')
    await settle(page)
    await h(page, 'clearLogs')
    await h(page, 'send', { type: 'topic_message_deleted', topicId: 'topic-general', messageId: 'general-root-10', parentMessageId: null, deletedAt: new Date().toISOString() })
    await settle(page)
    assertEqual(await h<boolean>(page, 'isThreadOpen'), false, 'нишката е затворена')
    assertEqual((await h<string[]>(page, 'getCardOrder')).includes('general-root-10'), false, 'картата е махната')
    assertEqual(await h<string[]>(page, 'getMarkSeenLog'), [], 'onTopicMarkSeen')
    assertEqual(await h<string[]>(page, 'getThreadMarkSeenLog'), [], 'onTopicThreadMarkSeen')
  })

  await check('[P] Без page errors', async () => {
    assertEqual(pageErrors, [], 'page errors')
  })
} finally {
  await browser?.close()
  await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

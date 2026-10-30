/**
 * Браузърен тест (Vite + Playwright, реалният контролер/рендер) за „Теми“:
 * нишка без „Покажи още“, разделител „Нови отговори“, прочетено по реална
 * видимост и пълна изолация на „Лафче“. Фалшивият сървър
 * (fixtures/topicThreadUnreadHarness.ts) повтаря сървърните прагове.
 *
 *  [1]  190 отговора, прочетени 170 → разделител пред №171, в горния край
 *  [2]  0 непрочетени → края, без разделител, без seen заявка
 *  [3]  1 непрочетен → разделител; след видимост → 0; повторно отваряне в края
 *  [4]  25 непрочетени, частично прочитане → повторно отваряне при първия останал
 *  [5]  бързо скролване/прескачане → невидените остават непрочетени
 *  [6]  нов отговор при четене на по-стари → без преместване, без маркиране
 *  [7]  нов отговор, когато потребителят е най-долу → остава най-долу, маркира се
 *  [8]  автоматично зареждане нагоре — котвата не мърда, без дубликати, до №1
 *  [9]  refresh (pagehide flush), reconnect (пропуснати + tombstone), второ устройство
 *  [10] изтрит непрочетен отговор и изтрит root по време на четене
 *  [11] „Лафче“ — без разделител/прозорец/thread заявки, непроменено поведение
 *  [12] собствен отговор при 60 и 250 непрочетени → без прескок, без маркиране
 *  [13] собствен отговор при четене на по-стари / най-долу
 *  [14] отговор по-висок от екрана: постепенно четене → прочетен; прескачане → не
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page, type ViewportSize } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  // TOPIC_THREAD_ONLY="[12],[14a]" — само избрани проверки (локална диагностика).
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      srv.close(() => resolve(address.port))
    })
  })
}

async function h<T = any>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ({ method: name, args: a }) => (window as any).__topicThreadUnreadHarness[name](...a),
    { method, args },
  ) as Promise<T>
}

// Над dwell прага (600 ms) + flush паузата (400 ms) + малък резерв.
const READ_SETTLE_MS = 1500

async function openGeneral(page: Page): Promise<void> {
  await h(page, 'openTopicsScreen')
  await page.waitForFunction(() => document.querySelector('[data-topics-back-to-general="1"]') !== null, undefined, { timeout: 5000 })
  await h(page, 'openGeneral')
  await page.waitForFunction(() => document.querySelector('[data-topic-card-open]') !== null, undefined, { timeout: 5000 })
}

async function openThread(page: Page, rootMessageId: string): Promise<void> {
  await h(page, 'openThread', rootMessageId)
  await page.waitForFunction(() => document.querySelector('[data-topic-replies-section] [data-topic-reply]') !== null, undefined, { timeout: 5000 })
  await page.waitForTimeout(50)
}

async function backToList(page: Page): Promise<void> {
  await h(page, 'clickThreadBack')
  await page.waitForFunction(() => document.querySelector('[data-topic-thread-scroll="1"]') === null, undefined, { timeout: 5000 })
}

const viewports: Array<{ label: string; viewport: ViewportSize }> = [
  { label: 'mobile-390', viewport: { width: 390, height: 844 } },
  { label: 'desktop', viewport: { width: 1366, height: 900 } },
]

console.log('\ncheckTopicThreadUnreadClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicThreadUnreadHarness.html`
  browser = await chromium.launch()

  for (const { label: vp, viewport } of viewports) {
    async function newPage(context: BrowserContext, errors: string[]): Promise<Page> {
      const page = await context.newPage()
      page.on('pageerror', (err) => errors.push(err.message))
      await page.goto(baseUrl)
      await page.waitForFunction(() => (window as any).__topicThreadUnreadHarness !== undefined, undefined, { timeout: 15_000 })
      return page
    }

    async function withHarness(fn: (page: Page, context: BrowserContext, errors: string[]) => Promise<void>): Promise<void> {
      const context = await browser!.newContext({ viewport })
      const errors: string[] = []
      try {
        const page = await newPage(context, errors)
        await h(page, 'reset')
        await fn(page, context, errors)
        assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
      } finally {
        await context.close()
      }
    }

    await check(`[${vp}] [1] 190 отговора, прочетени 170 → разделител пред №171 в горния край, без „Покажи още“`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-big', 190, 170)
        await openGeneral(page)
        assert((await h(page, 'getRootCardBadge', 'root-big')) === '20', `root card badge before open: ${await h(page, 'getRootCardBadge', 'root-big')}`)
        await openThread(page, 'root-big')
        const loads = await h<any[]>(page, 'getThreadLoadLog')
        assert(JSON.stringify(loads[0]?.cursor) === JSON.stringify({ window: 'unread' }), `first load: ${JSON.stringify(loads[0])}`)
        assert((await h<string[]>(page, 'getLegacyRepliesLoadLog')).length === 0, 'legacy replies load must not run')
        assert(await h(page, 'hasDivider'), 'divider missing')
        assert((await h(page, 'getDividerNextSeq')) === seqs[170], `divider must precede №171 (got ${await h(page, 'getDividerNextSeq')})`)
        const offset = await h<number>(page, 'getDividerOffset')
        assert(offset !== null && Math.abs(offset) <= 16, `divider must sit at the top of the viewport (offset ${offset})`)
        assert(!(await h<boolean>(page, 'hasLoadMoreButton')), '„Покажи още“ must be gone')
        const loaded: number[] = await h(page, 'getLoadedReplySeqs')
        assert(loaded.length === 30 && loaded[0] === seqs[160] && loaded[29] === seqs[189], `bounded initial window: ${loaded.length}`)
        await page.waitForTimeout(300)
        assert((await h<any[]>(page, 'getSeenLog')).length === 0, 'opening alone must not mark anything read')
        await page.waitForTimeout(READ_SETTLE_MS)
        const watermark: number = await h(page, 'getWatermark', 'root-big')
        const visible: number[] = await h(page, 'getVisibleSeqs')
        assert(watermark >= seqs[170]!, `visible unread must be marked (watermark ${watermark})`)
        if (vp.startsWith('mobile')) {
          assert(watermark < seqs[189]!, 'unseen replies below the fold must stay unread')
          assert(watermark <= Math.max(...visible), `watermark ${watermark} beyond what was on screen`)
        }
      })
    })

    await check(`[${vp}] [2] 0 непрочетени → отваря се най-долу, без разделител, без seen заявка`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedThread', 'root-read', 60, 60)
        await openGeneral(page)
        await openThread(page, 'root-read')
        assert(!(await h(page, 'hasDivider')), 'divider must not render')
        const distance = await h<number>(page, 'getThreadBottomDistance')
        assert(distance <= 8, `must open at the last reply (bottom distance ${distance})`)
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<any[]>(page, 'getSeenLog')).length === 0, 'nothing to mark')
      })
    })

    await check(`[${vp}] [3] 1 непрочетен → разделител; видян → 0; повторно отваряне в края без разделител`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-one', 12, 11)
        await openGeneral(page)
        await openThread(page, 'root-one')
        assert((await h(page, 'getDividerNextSeq')) === seqs[11], 'divider before the single unread reply')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h(page, 'getWatermark', 'root-one')) === seqs[11], 'single unread marked after being visible')
        await backToList(page)
        assert((await h(page, 'getRootCardBadge', 'root-one')) === null, 'badge cleared after reading')
        await openThread(page, 'root-one')
        assert(!(await h(page, 'hasDivider')), 'divider must not stay after reading')
        assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'reopens at the bottom')
      })
    })

    await check(`[${vp}] [4] 25 непрочетени, частично прочитане → повторно отваряне при първия останал`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-part', 40, 15)
        await openGeneral(page)
        await openThread(page, 'root-part')
        assert((await h(page, 'getDividerNextSeq')) === seqs[15], 'divider before №16')
        await page.waitForTimeout(READ_SETTLE_MS)
        await backToList(page)
        await page.waitForTimeout(200)
        const watermark: number = await h(page, 'getWatermark', 'root-part')
        const remaining: number = await h(page, 'getThreadUnread', 'root-part')
        assert(watermark >= seqs[15]!, 'some unread were read')
        if (vp.startsWith('mobile')) assert(remaining > 0, 'mobile viewport cannot show all 25 at once')
        if (remaining > 0) {
          assert((await h(page, 'getRootCardBadge', 'root-part')) === String(remaining), 'badge shows the real remainder')
          await openThread(page, 'root-part')
          const firstRemaining = seqs.find((seq) => seq > watermark)
          assert((await h(page, 'getDividerNextSeq')) === firstRemaining, `divider before the first remaining unread (${firstRemaining})`)
        }
      })
    })

    await check(`[${vp}] [5] бързо скролване до края → прескочените остават непрочетени`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-skip', 90, 10)
        await openGeneral(page)
        await openThread(page, 'root-skip')
        // Рязко до края, страница по страница, по-бързо от dwell прага.
        for (let i = 0; i < 12; i++) {
          await h(page, 'scrollThreadToBottom')
          await page.waitForTimeout(40)
        }
        const loaded: number[] = await h(page, 'getLoadedReplySeqs')
        assert(loaded[loaded.length - 1] === seqs[89], `fast scroll must reach the end (last ${loaded[loaded.length - 1]})`)
        assert(new Set(loaded).size === loaded.length, 'no duplicate replies after auto-loading')
        await page.waitForTimeout(READ_SETTLE_MS)
        const watermark: number = await h(page, 'getWatermark', 'root-skip')
        assert(watermark < seqs[10]!, `skipped replies must stay unread (watermark ${watermark}, first unread ${seqs[10]})`)
        await backToList(page)
        await openThread(page, 'root-skip')
        assert((await h(page, 'getDividerNextSeq')) === seqs[10], 'divider still before the first skipped reply')
      })
    })

    await check(`[${vp}] [6] нов отговор при четене на по-стари → екранът не се мести, не се маркира`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedThread', 'root-live', 30, 30)
        await openGeneral(page)
        await openThread(page, 'root-live')
        await h(page, 'scrollThreadBy', -900)
        await page.waitForTimeout(300)
        const anchorSeq = (await h<number[]>(page, 'getVisibleSeqs'))[1]!
        const topBefore = await h<number>(page, 'getItemTop', anchorSeq)
        const scrollBefore = await h<number>(page, 'getThreadScrollTop')
        const push = await h(page, 'addServerReply', 'root-live')
        await h(page, 'simulateServerMessage', push)
        await page.waitForTimeout(100)
        assert(Math.abs((await h<number>(page, 'getThreadScrollTop')) - scrollBefore) <= 1, 'scroll position must not move')
        assert(Math.abs((await h<number>(page, 'getItemTop', anchorSeq)) - topBefore) <= 1, 'visible reply must not move')
        const loaded: number[] = await h(page, 'getLoadedReplySeqs')
        assert(loaded[loaded.length - 1] === push.seq, 'new reply appended at the end')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', 'root-live')) < push.seq, 'unseen new reply must stay unread')
        await h(page, 'scrollThreadToBottom')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', 'root-live')) === push.seq, 'marked once it was actually seen')
      })
    })

    await check(`[${vp}] [7] нов отговор, когато потребителят е най-долу → остава най-долу и се маркира`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedThread', 'root-bottom', 20, 20)
        await openGeneral(page)
        await openThread(page, 'root-bottom')
        const push = await h(page, 'addServerReply', 'root-bottom')
        await h(page, 'simulateServerMessage', push)
        await page.waitForTimeout(100)
        assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'stays at the bottom')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', 'root-bottom')) === push.seq, 'visible new reply marked')
      })
    })

    await check(`[${vp}] [8] автоматично зареждане нагоре — котвата не мърда, без дубликати, до №1`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-up', 190, 190)
        await openGeneral(page)
        await openThread(page, 'root-up')
        assert((await h<number[]>(page, 'getLoadedReplySeqs')).length === 30, 'tail window')
        for (let round = 0; round < 12; round++) {
          const loadedBefore: number[] = await h(page, 'getLoadedReplySeqs')
          if (loadedBefore[0] === seqs[0]) break
          await h(page, 'setThreadScrollTop', 0)
          await page.waitForTimeout(30)
          const anchorSeq = loadedBefore[0]!
          const topBefore = await h<number>(page, 'getItemTop', anchorSeq)
          await page.waitForFunction((count) => document.querySelectorAll('[data-topic-replies-section] [data-topic-reply]').length > count, loadedBefore.length, { timeout: 5000 })
          await page.waitForTimeout(30)
          const topAfter = await h<number>(page, 'getItemTop', anchorSeq)
          assert(Math.abs(topAfter - topBefore) <= 2, `round ${round}: anchor moved ${topAfter - topBefore}px`)
        }
        const loaded: number[] = await h(page, 'getLoadedReplySeqs')
        assert(loaded.length === 190 && new Set(loaded).size === 190, `all 190 loaded once (got ${loaded.length})`)
        assert(loaded.every((seq, i) => seq === seqs[i]), 'chronological order')
        const sentinels = await h<{ older: string; newer: string }>(page, 'getSentinelVisibility')
        assert(sentinels.older === 'none' && sentinels.newer === 'none', `sentinels hidden at both ends: ${JSON.stringify(sentinels)}`)
      })
    })

    await check(`[${vp}] [9a] refresh: видяното се изпраща при pagehide и оцелява`, async () => {
      await withHarness(async (page, context, errors) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-refresh', 40, 20)
        await openGeneral(page)
        await openThread(page, 'root-refresh')
        await page.waitForTimeout(800) // dwell изтекъл, flush паузата — още не
        await page.reload()
        await page.waitForFunction(() => (window as any).__topicThreadUnreadHarness !== undefined, undefined, { timeout: 15_000 })
        const watermark: number = await h(page, 'getWatermark', 'root-refresh')
        assert(watermark >= seqs[20]!, `seen replies flushed on pagehide (watermark ${watermark})`)
        await openGeneral(page)
        await openThread(page, 'root-refresh')
        const firstRemaining = seqs.find((seq) => seq > watermark)
        if (firstRemaining !== undefined) {
          assert((await h(page, 'getDividerNextSeq')) === firstRemaining, 'divider after refresh at the first remaining unread')
        } else {
          assert(!(await h(page, 'hasDivider')), 'no divider when nothing remains')
        }
        void context
        void errors
      })
    })

    await check(`[${vp}] [9b] reconnect: пропуснатите отговори се добавят, изтритите изчезват, без скок`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedThread', 'root-reconnect', 30, 30)
        await openGeneral(page)
        await openThread(page, 'root-reconnect')
        await h(page, 'scrollThreadBy', -700)
        await page.waitForTimeout(100)
        const anchorSeq = (await h<number[]>(page, 'getVisibleSeqs'))[1]!
        const topBefore = await h<number>(page, 'getItemTop', anchorSeq)
        const ids: string[] = await h(page, 'getLoadedReplyIds')
        const missedA = await h(page, 'addServerReply', 'root-reconnect')
        const missedB = await h(page, 'addServerReply', 'root-reconnect')
        await h(page, 'deleteServerReply', 'root-reconnect', ids[ids.length - 1])
        await h(page, 'reconnect')
        await page.waitForFunction((seq) => document.querySelector(`[data-topic-thread-seq="${seq}"]`) !== null, missedB.seq, { timeout: 5000 })
        const loadedIds: string[] = await h(page, 'getLoadedReplyIds')
        assert(!loadedIds.includes(ids[ids.length - 1]!), 'tombstoned reply removed')
        assert(loadedIds.includes(missedA.messageId) && loadedIds.includes(missedB.messageId), 'missed replies appended')
        assert(new Set(loadedIds).size === loadedIds.length, 'no duplicates')
        assert(Math.abs((await h<number>(page, 'getItemTop', anchorSeq)) - topBefore) <= 2, 'reading position kept')
      })
    })

    await check(`[${vp}] [9c] второ устройство: отваря се там, докъдето е стигнало първото; push обновява бадж`, async () => {
      await withHarness(async (pageA, context, errors) => {
        const seqs: number[] = await h(pageA, 'seedThread', 'root-device', 40, 10)
        const pageB = await newPage(context, errors)
        await openGeneral(pageB)
        assert((await h(pageB, 'getRootCardBadge', 'root-device')) === '30', 'device B badge before')
        await openGeneral(pageA)
        await openThread(pageA, 'root-device')
        await pageA.waitForTimeout(READ_SETTLE_MS)
        const watermark: number = await h(pageA, 'getWatermark', 'root-device')
        assert(watermark >= seqs[10]!, 'device A read some replies')
        const push = await h(pageA, 'threadSeenPush', 'root-device')
        await h(pageB, 'simulateServerMessage', push)
        await pageB.waitForTimeout(150)
        assert((await h(pageB, 'getRootCardBadge', 'root-device')) === (push.unreadCount > 0 ? String(push.unreadCount) : null), 'device B badge follows the push')
        await openThread(pageB, 'root-device')
        const firstRemaining = seqs.find((seq) => seq > watermark)
        if (firstRemaining !== undefined) {
          assert((await h(pageB, 'getDividerNextSeq')) === firstRemaining, 'device B opens at device A position')
        }
      })
    })

    await check(`[${vp}] [10] изтрит непрочетен отговор и изтрит root по време на четене`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-del', 14, 10)
        await openGeneral(page)
        await openThread(page, 'root-del')
        const deletion = await h(page, 'deleteServerReply', 'root-del', 'root-del-r11')
        await h(page, 'simulateServerMessage', deletion)
        await page.waitForTimeout(50)
        assert(!(await h<string[]>(page, 'getLoadedReplyIds')).includes('root-del-r11'), 'deleted reply removed')
        await page.waitForTimeout(READ_SETTLE_MS)
        await h(page, 'scrollThreadToBottom')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', 'root-del')) === seqs[13], 'deleted reply does not block reading')
        assert((await h<number>(page, 'getThreadUnread', 'root-del')) === 0, 'nothing left unread')
        await h(page, 'simulateServerMessage', { type: 'topic_message_deleted', topicId: 'topic-general', messageId: 'root-del', parentMessageId: null })
        await page.waitForFunction(() => document.querySelector('[data-topic-thread-scroll="1"]') === null, undefined, { timeout: 5000 })
      })
    })

    for (const unread of [60, 250]) {
      await check(`[${vp}] [12] собствен отговор при ${unread} непрочетени (прозорецът не стига до края) → без прескок`, async () => {
        await withHarness(async (page) => {
          const rootId = `root-own-${unread}`
          const seqs: number[] = await h(page, 'seedThread', rootId, unread + 10, 10)
          await openGeneral(page)
          await openThread(page, rootId)
          await page.waitForTimeout(READ_SETTLE_MS)
          const watermarkBefore: number = await h(page, 'getWatermark', rootId)
          const loadedBefore: number[] = await h(page, 'getLoadedReplySeqs')
          const anchorSeq = (await h<number[]>(page, 'getVisibleSeqs')).find((seq) => seq !== seqs[0]) ?? loadedBefore[0]!
          const topBefore = await h<number>(page, 'getItemTop', anchorSeq)
          const scrollBefore = await h<number>(page, 'getThreadScrollTop')

          const requestId: string | null = await h(page, 'sendOwnReply', rootId, 'Моят отговор')
          assert(requestId !== null, 'composer must send the reply')
          const push = await h(page, 'addServerReply', rootId, 'me', requestId)
          await h(page, 'simulateServerMessage', push)
          await page.waitForTimeout(150)

          assert(Math.abs((await h<number>(page, 'getThreadScrollTop')) - scrollBefore) <= 1, 'scroll position must not move')
          assert(Math.abs((await h<number>(page, 'getItemTop', anchorSeq)) - topBefore) <= 1, 'reading position must not move')
          assert(JSON.stringify(await h(page, 'getLoadedReplySeqs')) === JSON.stringify(loadedBefore), 'loaded range stays contiguous (no out-of-order own reply)')
          assert(await h<boolean>(page, 'isOwnReplyNoticeOnScreen'), '„Отговорът ти е публикуван ↓“ must be visible')
          assert((await h(page, 'getReplyComposerValue', rootId)) === '', 'composer cleared after ack')

          await page.waitForTimeout(READ_SETTLE_MS)
          const watermarkAfterAck: number = await h(page, 'getWatermark', rootId)
          assert(watermarkAfterAck === watermarkBefore, `publishing must not mark anything (before ${watermarkBefore}, after ${watermarkAfterAck})`)

          if (unread === 60) {
            // Естествено четене надолу: отговорът се появява на мястото си.
            for (let i = 0; i < 20; i++) {
              await h(page, 'scrollThreadToBottom')
              await page.waitForTimeout(60)
            }
            const loaded: number[] = await h(page, 'getLoadedReplySeqs')
            assert(loaded[loaded.length - 1] === push.seq, 'own reply appears last, in chronological order')
            assert(loaded.every((seq, i) => i === 0 || seq > loaded[i - 1]!), 'strict chronological order')
            await page.waitForTimeout(READ_SETTLE_MS)
            assert(!(await h<boolean>(page, 'hasOwnReplyNotice')), 'notice disappears once the own reply was seen')
          } else {
            // Изричен избор „покажи“ — прескача до края, но прескочените остават непрочетени.
            await h(page, 'clickOwnReplyNotice')
            await page.waitForFunction((seq) => document.querySelector(`[data-topic-thread-seq="${seq}"]`) !== null, push.seq, { timeout: 5000 })
            await page.waitForTimeout(100)
            assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'reveal shows the own reply at the bottom')
            assert(!(await h<boolean>(page, 'hasOwnReplyNotice')), 'notice removed after reveal')
            const loaded: number[] = await h(page, 'getLoadedReplySeqs')
            assert(loaded[loaded.length - 1] === push.seq && loaded.every((seq, i) => i === 0 || seq > loaded[i - 1]!), 'chronological order after reveal')
          }
          await page.waitForTimeout(READ_SETTLE_MS)
          const watermarkEnd: number = await h(page, 'getWatermark', rootId)
          if (unread === 250) {
            assert(watermarkEnd === watermarkBefore, `skipped replies must stay unread after reveal (before ${watermarkBefore}, after ${watermarkEnd})`)
            assert(watermarkEnd < seqs[seqs.length - 1]!, 'thread is not marked as fully read')
          }
        })
      })
    }

    await check(`[${vp}] [13] собствен отговор при четене на по-стари (прозорецът е в края) → без прескок; най-долу → остава най-долу`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedThread', 'root-own-tail', 40, 40)
        await openGeneral(page)
        await openThread(page, 'root-own-tail')
        await h(page, 'scrollThreadBy', -900)
        await page.waitForTimeout(200)
        const scrollBefore = await h<number>(page, 'getThreadScrollTop')
        const requestId: string | null = await h(page, 'sendOwnReply', 'root-own-tail', 'Отговор отгоре')
        const push = await h(page, 'addServerReply', 'root-own-tail', 'me', requestId)
        await h(page, 'simulateServerMessage', push)
        await page.waitForTimeout(150)
        assert(Math.abs((await h<number>(page, 'getThreadScrollTop')) - scrollBefore) <= 1, 'no jump while reading older replies')
        const loaded: number[] = await h(page, 'getLoadedReplySeqs')
        assert(loaded[loaded.length - 1] === push.seq, 'own reply appended at the end')
        assert(await h<boolean>(page, 'isOwnReplyNoticeOnScreen'), 'notice visible')
        await h(page, 'scrollThreadToBottom')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert(!(await h<boolean>(page, 'hasOwnReplyNotice')), 'notice gone once the reply was seen')

        const requestId2: string | null = await h(page, 'sendOwnReply', 'root-own-tail', 'Отговор отдолу')
        const push2 = await h(page, 'addServerReply', 'root-own-tail', 'me', requestId2)
        await h(page, 'simulateServerMessage', push2)
        await page.waitForTimeout(150)
        assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'at the bottom → stays at the bottom with the new reply')
        assert(!(await h<boolean>(page, 'hasOwnReplyNotice')), 'no notice when the reply is already on screen')
      })
    })

    await check(`[${vp}] [14a] отговор по-висок от екрана → прочетен само след постепенно преглеждане`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-long', 12, 5, 0, [6])
        await openGeneral(page)
        await openThread(page, 'root-long')
        const longSeq = seqs[5]!
        const height = await h<number>(page, 'getItemHeight', longSeq)
        const viewport = await h<number>(page, 'getThreadClientHeight')
        assert(height > viewport * 1.8, `precondition: long reply ${height}px vs viewport ${viewport}px`)
        assert((await h(page, 'getDividerNextSeq')) === longSeq, 'divider before the long reply')
        // Само първият екран от отговора — не е прочетен.
        await page.waitForTimeout(2500)
        assert((await h<number>(page, 'getWatermark', 'root-long') ?? 0) < longSeq, 'first screen only must not mark the long reply')
        // Постепенно четене надолу: по около треть екран, с пауза за четене.
        for (let i = 0; i < 60; i++) {
          const bottom = (await h<number>(page, 'getItemTop', longSeq)) + height
          if (bottom <= viewport) break
          await h(page, 'scrollThreadBy', Math.round(viewport * 0.35))
          await page.waitForTimeout(1000)
        }
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', 'root-long')) >= longSeq, 'long reply marked after it was read through')
      })
    })

    await check(`[${vp}] [14b] бързо прескачане на дълъг отговор → остава непрочетен`, async () => {
      await withHarness(async (page) => {
        const seqs: number[] = await h(page, 'seedThread', 'root-long-skip', 12, 5, 0, [6])
        await openGeneral(page)
        await openThread(page, 'root-long-skip')
        const longSeq = seqs[5]!
        const viewport = await h<number>(page, 'getThreadClientHeight')
        for (let i = 0; i < 40; i++) {
          const top = await h<number>(page, 'getItemTop', seqs[6]!)
          if (top <= viewport * 0.3) break
          await h(page, 'scrollThreadBy', Math.round(viewport * 0.9))
          await page.waitForTimeout(60)
        }
        await h(page, 'scrollItemToTop', seqs[6]!, 0)
        await page.waitForTimeout(READ_SETTLE_MS + 500)
        const watermark = (await h<number>(page, 'getWatermark', 'root-long-skip')) ?? 0
        assert(watermark < longSeq, `skimmed long reply must stay unread (watermark ${watermark}, long ${longSeq})`)
        await backToList(page)
        await openThread(page, 'root-long-skip')
        assert((await h(page, 'getDividerNextSeq')) === longSeq, 'divider still before the skimmed long reply')
      })
    })

    await check(`[${vp}] [11] „Лафче“ — без разделител/прозорец/thread заявки, непроменено`, async () => {
      await withHarness(async (page) => {
        await h(page, 'seedLafche', 25)
        await h(page, 'seedThread', 'root-x', 5, 0)
        await h(page, 'openTopicsScreen')
        await page.waitForFunction(() => document.querySelectorAll('.lafche-post').length > 0, undefined, { timeout: 5000 })
        assert((await h<number>(page, 'countLafchePosts')) === 25, 'all lafche posts rendered')
        assert(!(await h(page, 'hasDivider')), 'no divider in Лафче')
        assert(!(await h<boolean>(page, 'hasLoadMoreButton')), 'no load-more in Лафче')
        const sentinels = await h<{ older: string | null; newer: string | null }>(page, 'getSentinelVisibility')
        assert(sentinels.older === null && sentinels.newer === null, 'no thread sentinels in Лафче')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<any[]>(page, 'getThreadLoadLog')).length === 0, 'no thread window requests')
        assert((await h<any[]>(page, 'getSeenLog')).length === 0, 'no thread seen requests')
        assert((await h<string[]>(page, 'getTopicSeenLog')).includes('topic-lafche'), 'Лафче keeps its topic-level mark-seen')
        // Установено поведение (измерено идентично на чист HEAD): Лафче се отваря при най-новите, най-долу.
        assert((await h<number>(page, 'getTopicsBottomDistance')) <= 8, 'Лафче opens at the newest posts (bottom) as before')
      })
    })
  }
} catch (error) {
  failed++
  console.error(`  FAIL  harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
} finally {
  await browser?.close()
  await vite?.close()
}

if (failed > 0) {
  console.error(`\ncheckTopicThreadUnreadClient: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncheckTopicThreadUnreadClient: ${passed} passed, 0 failed`)

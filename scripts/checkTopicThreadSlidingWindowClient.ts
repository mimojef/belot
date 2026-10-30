/**
 * Браузърен регресионен тест (Vite + Playwright, реалният контролер/рендер)
 * за плъзгащия се прозорец на нишките в „Теми“ — production бъг след 1f65d8b:
 * при скрол нагоре се зареждаха ВСИЧКИ отговори и екранът прескачаше до №1.
 *
 * Причина: котвата за позицията падаше върху root картата (над вмъкнатите
 * отговори) → без корекция → scrollTop оставаше ≈0 → таймерът на watcher-а
 * зареждаше следваща страница на всеки 150 ms до началото на нишката.
 *
 * За нишки със 190, 500 и 2000 отговора (различни височини, снимки, дълъг
 * текст), на mobile и desktop:
 *  [S1] отваряне най-долу
 *  [S2] бавно скролване нагоре — точният видим отговор не мърда при зареждане/освобождаване
 *  [S3] бързо скролване нагоре — без лавина, без прескок до №1
 *  [S4] връщане надолу — освободените се зареждат отново, до края
 *  [S5] многократно нагоре/надолу — непрекъснат, подреден, ограничен прозорец
 *  [S6] DOM ≤ 120 отговора навсякъде; [S7] без заявки, когато потребителят спре
 *  [S8] разделител, частично прочитане и освобождаване на непрочетени
 *  [S9] нов отговор по WebSocket, докато се четат стари (прозорецът не е в края)
 *  [S10] собствен отговор далеч от края — без преместване
 *  [P1-P2] prefetch нагоре/надолу — без граница, root картата не е тригер
 *  [P3] бавна мрежа + бързо скролване — една заявка наведнъж, без лавина
 *  [P4] prefetch не маркира като прочетено и не мести разделителя
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page, type ViewportSize } from 'playwright'
import { createServer as createNetServer } from 'node:net'

const WINDOW_MAX = 120

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

const READ_SETTLE_MS = 1500

async function openThreadOf(page: Page, rootId: string): Promise<void> {
  await h(page, 'openTopicsScreen')
  await page.waitForFunction(() => document.querySelector('[data-topics-back-to-general="1"]') !== null, undefined, { timeout: 5000 })
  await h(page, 'openGeneral')
  await page.waitForFunction(() => document.querySelector('[data-topic-card-open]') !== null, undefined, { timeout: 5000 })
  await h(page, 'openThread', rootId)
  await page.waitForFunction(() => document.querySelector('[data-topic-replies-section] [data-topic-reply]') !== null, undefined, { timeout: 5000 })
  await page.waitForTimeout(100)
}

/** Зареденото в DOM е непрекъснат, подреден отрязък от нишката, без дубликати и ≤ 120. */
async function assertWindowShape(page: Page, seqs: readonly number[], label: string): Promise<number[]> {
  const loaded: number[] = await h(page, 'getLoadedReplySeqs')
  assert(loaded.length > 0, `${label}: empty window`)
  assert(loaded.length <= WINDOW_MAX, `${label}: ${loaded.length} replies in DOM (max ${WINDOW_MAX})`)
  assert(new Set(loaded).size === loaded.length, `${label}: duplicate replies in DOM`)
  const start = seqs.indexOf(loaded[0]!)
  assert(start >= 0, `${label}: unknown first seq ${loaded[0]}`)
  for (let i = 0; i < loaded.length; i++) {
    if (loaded[i] !== seqs[start + i]) throw new Error(`${label}: window not contiguous at index ${i} (${loaded[i]} vs ${seqs[start + i]})`)
  }
  return loaded
}

/**
 * Една стъпка скрол с проверка, че видимият отговор се е преместил ТОЧНО
 * колкото е скролнато — вкл. когато междувременно е заредена/освободена
 * страница (тогава позицията се пази от котвата).
 */
async function scrollStepPreservingAnchor(page: Page, delta: number, waitMs: number, label: string): Promise<void> {
  // Долният ръб: при вмъкване над отговора той получава разделителна линия
  // (::before) — горният му ръб се вдига, съдържанието не.
  const before = await h<{ seq: number; top: number; bottom: number } | null>(page, 'getTopVisibleReply')
  const scrollTop = await h<number>(page, 'getThreadScrollTop')
  const bottomDistance = await h<number>(page, 'getThreadBottomDistance')
  const applied = delta < 0 ? -Math.min(-delta, scrollTop) : Math.min(delta, bottomDistance)
  await h(page, 'scrollThreadBy', delta)
  await page.waitForTimeout(waitMs)
  if (before === null || applied === 0) return
  const after = await h<number | null>(page, 'getItemBottom', before.seq)
  if (after === null) return // освободен далеч от изгледа — не е бил видимият при зареждане
  const expected = before.bottom - applied
  assert(Math.abs(after - expected) <= 2, `${label}: visible reply ${before.seq} moved ${(after - expected).toFixed(1)}px (expected ${expected.toFixed(1)}, got ${after.toFixed(1)})`)
}

const sizes = [190, 500, 2000]
const viewports: Array<{ label: string; viewport: ViewportSize }> = [
  { label: 'mobile-390', viewport: { width: 390, height: 844 } },
  { label: 'desktop', viewport: { width: 1366, height: 900 } },
]

console.log('\ncheckTopicThreadSlidingWindowClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicThreadUnreadHarness.html`
  browser = await chromium.launch()

  for (const { label: vp, viewport } of viewports) {
    async function withHarness(fn: (page: Page, context: BrowserContext) => Promise<void>): Promise<void> {
      const context = await browser!.newContext({ viewport })
      const errors: string[] = []
      try {
        const page = await context.newPage()
        page.on('pageerror', (err) => errors.push(err.message))
        await page.goto(baseUrl)
        await page.waitForFunction(() => (window as any).__topicThreadUnreadHarness !== undefined, undefined, { timeout: 15_000 })
        await h(page, 'reset')
        await h(page, 'setResponseDelay', 60)
        await fn(page, context)
        assert(errors.length === 0, `page errors: ${errors.join(' | ')}`)
      } finally {
        await context.close()
      }
    }

    for (const size of sizes) {
      await check(`[${vp}] [${size}] [S1-S7] отваряне най-долу, бавно/бързо нагоре, обратно надолу, нагоре/надолу`, async () => {
        await withHarness(async (page) => {
          const rootId = `root-sw-${size}`
          const seqs: number[] = await h(page, 'seedThread', rootId, size, size, 0, [], true)
          await openThreadOf(page, rootId)

          // [S1]
          assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'S1: opens at the last reply')
          let loaded = await assertWindowShape(page, seqs, 'S1')
          assert(loaded[loaded.length - 1] === seqs[size - 1], 'S1: window ends with the last reply')
          assert((await h<number>(page, 'countThreadRequests', 'window')) === 1, 'S1: one initial request')

          // [S2] бавно нагоре — позицията на видимия отговор е точна при всяко зареждане/освобождаване
          for (let i = 0; i < 70; i++) {
            await scrollStepPreservingAnchor(page, -300, 140, `S2 step ${i}`)
            await assertWindowShape(page, seqs, `S2 step ${i}`)
          }
          const beforeRequests = await h<number>(page, 'countThreadRequests', 'before')
          assert(beforeRequests >= 1, 'S2: older pages were loaded')
          loaded = await assertWindowShape(page, seqs, 'S2 end')
          // Всяка заявка носи точно една страница — броят им следва изминатото.
          const pagesCovered = Math.ceil((size - seqs.indexOf(loaded[0]!)) / 30)
          assert(beforeRequests <= pagesCovered, `S2: ${beforeRequests} older requests for ${pagesCovered} pages of distance`)

          // [S3] бързо нагоре — без лавина и без прескок до №1
          const requestsBeforeFast = await h<number>(page, 'countThreadRequests', 'before')
          const firstBeforeFast = loaded[0]!
          const flings = 8
          for (let i = 0; i < flings; i++) {
            await h(page, 'scrollThreadBy', -2500)
            await page.waitForTimeout(40)
          }
          await page.waitForTimeout(400)
          const fastRequests = (await h<number>(page, 'countThreadRequests', 'before')) - requestsBeforeFast
          assert(fastRequests <= flings, `S3: ${fastRequests} requests for ${flings} flings (avalanche)`)
          loaded = await assertWindowShape(page, seqs, 'S3')
          if (size >= 500) {
            assert(loaded[0] !== seqs[0], 'S3: must not jump to the very first reply')
            assert(seqs.indexOf(firstBeforeFast) - seqs.indexOf(loaded[0]!) <= (fastRequests + 1) * 30, 'S3: progress matches the requests')
          }

          // [S7] когато потребителят спре — никакви заявки
          const idleBefore = await h<any[]>(page, 'getThreadLoadLog')
          await page.waitForTimeout(1500)
          assert((await h<any[]>(page, 'getThreadLoadLog')).length === idleBefore.length, 'S7: requests while idle')

          // Гарантирано освобождаване на най-новите (по-високите отговори на mobile
          // изискват повече път), за да има какво да се зарежда отново при [S4].
          for (let i = 0; i < 80 && size > WINDOW_MAX; i++) {
            const current: number[] = await h(page, 'getLoadedReplySeqs')
            if (current[current.length - 1] !== seqs[size - 1]) break
            await scrollStepPreservingAnchor(page, -2500, 110, `S3b step ${i}`)
          }
          loaded = await assertWindowShape(page, seqs, 'S3b')
          const releasedAtBottom = loaded[loaded.length - 1] !== seqs[size - 1]
          assert(releasedAtBottom || size <= WINDOW_MAX, 'S3b: newest replies released after moving far up')
          const afterRequestsBefore = await h<number>(page, 'countThreadRequests', 'after')

          // [S4] обратно надолу до края — освободените се зареждат отново
          for (let i = 0; i < 400; i++) {
            const current: number[] = await h(page, 'getLoadedReplySeqs')
            if (current[current.length - 1] === seqs[size - 1] && (await h<number>(page, 'getThreadBottomDistance')) <= 8) break
            await scrollStepPreservingAnchor(page, 2200, 110, `S4 step ${i}`)
          }
          loaded = await assertWindowShape(page, seqs, 'S4')
          assert(loaded[loaded.length - 1] === seqs[size - 1], 'S4: reached the last reply again')
          if (releasedAtBottom) {
            assert((await h<number>(page, 'countThreadRequests', 'after')) > afterRequestsBefore, 'S4: released replies reloaded')
          }

          // [S5] нагоре/надолу многократно
          const requestsBeforeOsc = (await h<any[]>(page, 'getThreadLoadLog')).length
          for (let i = 0; i < 16; i++) {
            await scrollStepPreservingAnchor(page, i % 2 === 0 ? -1800 : 1500, 160, `S5 step ${i}`)
            await assertWindowShape(page, seqs, `S5 step ${i}`)
          }
          const oscRequests = (await h<any[]>(page, 'getThreadLoadLog')).length - requestsBeforeOsc
          assert(oscRequests <= 16, `S5: ${oscRequests} requests for 16 movements`)
        })
      })
    }

    for (const variant of ['mixed', 'long'] as const) {
      await check(`[${vp}] [P1-P2] prefetch (${variant === 'long' ? 'само дълги отговори' : 'различни височини + снимки'}) — зарежда предварително, без граница, нагоре и надолу`, async () => {
        await withHarness(async (page) => {
          const rootId = `root-pf-${variant}`
          const seqs: number[] = await h(page, 'seedThread', rootId, 500, 500, 0, [], variant === 'long' ? 'long' : true)
          await openThreadOf(page, rootId)
          let requests = (await h<any[]>(page, 'getThreadLoadLog')).length
          let prefetches = 0
          // Бавно нагоре (като четене): всяка заявка тръгва, докато има заредено над
          // изгледа; root картата не е тригер; маркерът „Зареждане…“ не стига до изгледа.
          const step = variant === 'long' ? 600 : 250
          for (let i = 0; i < 90; i++) {
            await scrollStepPreservingAnchor(page, -step, 140, `P1 step ${i}`)
            const beyond = await h<any>(page, 'getLoadedBeyond')
            const now = (await h<any[]>(page, 'getThreadLoadLog')).length
            if (now > requests) {
              prefetches += now - requests
              assert(!beyond.rootVisible, `P1 step ${i}: request fired only when the creator post was reached`)
            }
            requests = now
            assert(!beyond.olderSentinelVisible, `P1 step ${i}: reader hit the loading boundary (no prefetch)`)
            await assertWindowShape(page, seqs, `P1 step ${i}`)
          }
          // Дългите отговори покриват по-малко страници за същия брой стъпки.
          assert(prefetches >= (variant === 'long' ? 1 : 2), `P1: expected prefetches, got ${prefetches}`)

          // Надолу обратно — същото за следващите страници.
          requests = (await h<any[]>(page, 'getThreadLoadLog')).length
          let downPrefetches = 0
          for (let i = 0; i < 160; i++) {
            const current: number[] = await h(page, 'getLoadedReplySeqs')
            if (current[current.length - 1] === seqs[499] && (await h<number>(page, 'getThreadBottomDistance')) <= 8) break
            await scrollStepPreservingAnchor(page, step, 140, `P2 step ${i}`)
            const beyond = await h<any>(page, 'getLoadedBeyond')
            const now = (await h<any[]>(page, 'getThreadLoadLog')).length
            downPrefetches += now - requests
            requests = now
            assert(!beyond.newerSentinelVisible, `P2 step ${i}: reader hit the loading boundary going down`)
            await assertWindowShape(page, seqs, `P2 step ${i}`)
          }
          const loaded: number[] = await h(page, 'getLoadedReplySeqs')
          if (loaded[loaded.length - 1] !== seqs[499]) {
            assert(downPrefetches >= 1, 'P2: newer pages prefetched')
          }
          assert((await h<number>(page, 'getMaxConcurrentThreadLoads')) <= 1, 'P1-P2: at most one request at a time')
        })
      })
    }

    await check(`[${vp}] [P3] бавна мрежа (1,5 s) + бързо скролване — една заявка наведнъж, стабилна позиция, без лавина`, async () => {
      await withHarness(async (page) => {
        const rootId = 'root-pf-slow'
        const seqs: number[] = await h(page, 'seedThread', rootId, 2000, 2000, 0, [], true)
        await openThreadOf(page, rootId)
        await h(page, 'setResponseDelay', 1500)
        const requestsBefore = (await h<any[]>(page, 'getThreadLoadLog')).length
        const flings = 16
        for (let i = 0; i < flings; i++) {
          await h(page, 'scrollThreadBy', -2500)
          await page.waitForTimeout(120)
          // Докато заявката виси и пристига — видимият отговор не мърда.
          const before = await h<{ seq: number; top: number; bottom: number } | null>(page, 'getTopVisibleReply')
          await page.waitForTimeout(250)
          if (before !== null) {
            const after = await h<number | null>(page, 'getItemBottom', before.seq)
            if (after !== null) assert(Math.abs(after - before.bottom) <= 2, `P3 fling ${i}: visible reply moved ${(after - before.bottom).toFixed(1)}px without user scroll`)
          }
        }
        await page.waitForTimeout(1800)
        const requests = (await h<any[]>(page, 'getThreadLoadLog')).length - requestsBefore
        assert(requests <= flings, `P3: ${requests} requests for ${flings} flings`)
        assert((await h<number>(page, 'getMaxConcurrentThreadLoads')) <= 1, 'P3: concurrent requests')
        const loaded = await assertWindowShape(page, seqs, 'P3')
        assert(loaded[0] !== seqs[0], 'P3: no jump to the first reply')
        const cursors = (await h<any[]>(page, 'getThreadLoadLog')).filter((entry) => 'beforeSeq' in entry.cursor).map((entry) => entry.cursor.beforeSeq)
        assert(new Set(cursors).size === cursors.length, 'P3: the same page was requested twice')
        // Без движение от потребителя — нищо повече не се зарежда.
        const idle = (await h<any[]>(page, 'getThreadLoadLog')).length
        await page.waitForTimeout(2500)
        assert((await h<any[]>(page, 'getThreadLoadLog')).length === idle, 'P3: requests while idle')
      })
    })

    await check(`[${vp}] [P4] prefetch не маркира като прочетено и не мести разделителя`, async () => {
      await withHarness(async (page) => {
        const rootId = 'root-pf-read'
        const seqs: number[] = await h(page, 'seedThread', rootId, 500, 300, 0, [], true)
        await openThreadOf(page, rootId)
        const dividerOffset = await h<number>(page, 'getDividerOffset')
        await page.waitForTimeout(READ_SETTLE_MS)
        // Предварително зареденото над разделителя не мести изгледа.
        assert(Math.abs((await h<number>(page, 'getDividerOffset')) - dividerOffset) <= 2, 'divider stays in place after prefetch')
        assert((await h<number>(page, 'countThreadRequests', 'before')) >= 1, 'older context prefetched at open')
        const visible: number[] = await h(page, 'getVisibleSeqs')
        const watermark: number = await h(page, 'getWatermark', rootId)
        assert(watermark <= Math.max(...visible), `prefetched (not visible) replies marked as read: watermark ${watermark}`)
        assert(watermark < seqs[499]!, 'thread not marked fully read')
      })
    })

    await check(`[${vp}] [500] [S8] разделител, частично прочитане и освобождаване на непрочетени`, async () => {
      await withHarness(async (page) => {
        const rootId = 'root-sw-divider'
        const seqs: number[] = await h(page, 'seedThread', rootId, 500, 300, 0, [], true)
        await openThreadOf(page, rootId)
        assert((await h(page, 'getDividerNextSeq')) === seqs[300], 'divider before №301')
        await page.waitForTimeout(READ_SETTLE_MS)
        const watermarkRead: number = await h(page, 'getWatermark', rootId)
        assert(watermarkRead >= seqs[300]!, 'visible unread marked')
        // Бързо надолу далеч (непрочетените над изгледа се освобождават) и обратно нагоре.
        for (let i = 0; i < 25; i++) {
          await h(page, 'scrollThreadBy', 2500)
          await page.waitForTimeout(90)
        }
        await assertWindowShape(page, seqs, 'S8 down')
        assert(!(await h<number[]>(page, 'getLoadedReplySeqs')).includes(seqs[300]!), 'divider region released')
        await page.waitForTimeout(READ_SETTLE_MS)
        // Ръчно преминатото се брои дори след като е освободено от прозореца.
        const watermarkFar: number = await h(page, 'getWatermark', rootId)
        const firstPassed = seqs.find((seq) => seq > watermarkRead)!
        assert(watermarkFar > firstPassed, `passed (and released) replies must be read (watermark ${watermarkFar}, first passed ${firstPassed})`)
        const farthest = Math.max(...(await h<number[]>(page, 'getVisibleSeqs')))
        assert(watermarkFar <= farthest, `nothing below the reached position is marked (watermark ${watermarkFar}, reached ${farthest})`)
        for (let i = 0; i < 60; i++) {
          if ((await h<number[]>(page, 'getLoadedReplySeqs')).includes(seqs[300]!)) break
          await h(page, 'scrollThreadBy', -2500)
          await page.waitForTimeout(110)
        }
        await page.waitForTimeout(200)
        assert((await h(page, 'getDividerNextSeq')) === seqs[300], 'divider (fixed for the session) restored before №301 after reloading the region')
        await assertWindowShape(page, seqs, 'S8 back')
        // Повторно отваряне — при първия останал непрочетен.
        await h(page, 'clickThreadBack')
        await page.waitForFunction(() => document.querySelector('[data-topic-thread-scroll="1"]') === null, undefined, { timeout: 5000 })
        await page.waitForTimeout(500)
        const watermark: number = await h(page, 'getWatermark', rootId)
        const firstRemaining = seqs.find((seq) => seq > watermark)
        await h(page, 'openThread', rootId)
        await page.waitForFunction(() => document.querySelector('[data-topic-replies-section] [data-topic-reply]') !== null, undefined, { timeout: 5000 })
        await page.waitForTimeout(200)
        if (firstRemaining === undefined) {
          assert(!(await h(page, 'hasDivider')), 'everything read → no divider')
          assert((await h<number>(page, 'getThreadBottomDistance')) <= 8, 'everything read → opens at the bottom')
        } else {
          assert((await h(page, 'getDividerNextSeq')) === firstRemaining, 'reopen at the first remaining unread')
        }
      })
    })

    await check(`[${vp}] [2000] [S9] нов отговор по WebSocket при четене на стари → без преместване, после на мястото си`, async () => {
      await withHarness(async (page) => {
        const rootId = 'root-sw-live'
        const seqs: number[] = await h(page, 'seedThread', rootId, 2000, 2000, 0, [], true)
        await openThreadOf(page, rootId)
        // Нагоре, докато най-новите се освободят (прозорецът вече не стига до края).
        for (let i = 0; i < 80; i++) {
          const current: number[] = await h(page, 'getLoadedReplySeqs')
          if (current.length >= 100 && current[current.length - 1] !== seqs[1999]) break
          await h(page, 'scrollThreadBy', -2500)
          await page.waitForTimeout(110)
        }
        await page.waitForTimeout(300)
        const loaded = await assertWindowShape(page, seqs, 'S9 before')
        assert(loaded[loaded.length - 1] !== seqs[1999], 'precondition: newest replies released')
        const anchor = await h<{ seq: number; top: number }>(page, 'getTopVisibleReply')
        const push = await h(page, 'addServerReply', rootId)
        await h(page, 'simulateServerMessage', push)
        await page.waitForTimeout(150)
        assert(Math.abs((await h<number>(page, 'getItemTop', anchor.seq)) - anchor.top) <= 1, 'reading position kept')
        assert(JSON.stringify(await h(page, 'getLoadedReplySeqs')) === JSON.stringify(loaded), 'window untouched (no gap, no out-of-order reply)')
        await page.waitForTimeout(READ_SETTLE_MS)
        assert((await h<number>(page, 'getWatermark', rootId)) < push.seq, 'unseen live reply not marked')
        for (let i = 0; i < 200; i++) {
          const current: number[] = await h(page, 'getLoadedReplySeqs')
          if (current[current.length - 1] === push.seq && (await h<number>(page, 'getThreadBottomDistance')) <= 8) break
          await h(page, 'scrollThreadBy', 2500)
          await page.waitForTimeout(90)
        }
        const final = await assertWindowShape(page, [...seqs, push.seq], 'S9 after')
        assert(final[final.length - 1] === push.seq, 'live reply appears last, in order')
      })
    })

    await check(`[${vp}] [2000] [S10] собствен отговор далеч от края → без преместване`, async () => {
      await withHarness(async (page) => {
        const rootId = 'root-sw-own'
        const seqs: number[] = await h(page, 'seedThread', rootId, 2000, 2000, 0, [], true)
        await openThreadOf(page, rootId)
        // Нагоре, докато най-новите се освободят (прозорецът вече не стига до края).
        for (let i = 0; i < 80; i++) {
          const current: number[] = await h(page, 'getLoadedReplySeqs')
          if (current.length >= 100 && current[current.length - 1] !== seqs[1999]) break
          await h(page, 'scrollThreadBy', -2500)
          await page.waitForTimeout(110)
        }
        await page.waitForTimeout(300)
        const loaded = await assertWindowShape(page, seqs, 'S10 before')
        assert(loaded[loaded.length - 1] !== seqs[1999], 'precondition: newest replies released')
        const anchor = await h<{ seq: number; top: number }>(page, 'getTopVisibleReply')
        const requestId: string | null = await h(page, 'sendOwnReply', rootId, 'Мой отговор от средата')
        const push = await h(page, 'addServerReply', rootId, 'me', requestId)
        await h(page, 'simulateServerMessage', push)
        await page.waitForTimeout(200)
        assert(Math.abs((await h<number>(page, 'getItemTop', anchor.seq)) - anchor.top) <= 1, 'no movement on own reply')
        assert(JSON.stringify(await h(page, 'getLoadedReplySeqs')) === JSON.stringify(loaded), 'window untouched')
        assert(await h<boolean>(page, 'isOwnReplyNoticeOnScreen'), 'notice shown')
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
  console.error(`\ncheckTopicThreadSlidingWindowClient: ${failed} failed, ${passed} passed`)
  process.exit(1)
}
console.log(`\ncheckTopicThreadSlidingWindowClient: ${passed} passed, 0 failed`)

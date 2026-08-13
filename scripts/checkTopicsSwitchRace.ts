/**
 * checkTopicsSwitchRace.ts
 *
 * Regression check за rapid topic switching race condition в "Теми" (т.3C от
 * Етап 1 корекциите): ако потребителят отвори Тема A → Тема B, и заявката за
 * A resolve-не СЛЕД заявката за B, отговорът за A НЕ трябва да overwrite-не
 * вече показваната Тема B.
 *
 * Root cause guard: createLobbyFlowController.ts loadTopicMessagesForActiveTopic()
 * инкрементира state.topicMessagesRequestGeneration синхронно (преди await),
 * и сравнява стойността след resolve — ако е сменена (нова заявка е тръгнала
 * междувременно), резултатът се изхвърля.
 *
 * Реален браузър (Playwright) + реален production код (createLobbyFlowController
 * + renderLobbyScreen), зареден през Vite dev server (без build, без jsdom).
 * Мрежовите onTopicMessagesLoad заявки са deferred-promise stub-нати (виж
 * scripts/fixtures/topicsSwitchRaceHarness.ts) — тестът контролира ръчно
 * КОГА всяка заявка resolve-ва, за да симулира точния race прозорец.
 *
 * Покрива:
 *  [1]  A→B rapid switch, A resolve-ва ПЪРВИ (нормален ред) → B се показва коректно
 *  [2]  A→B rapid switch, A resolve-ва ВТОРИ (обърнат ред, реалният race) →
 *         отговорът за A се изхвърля, B остава на екрана непроменена
 *  [3]  Само 1 заявка за message history е направена за B (не се дублира)
 *  [4a-c] A→B→A rapid switch с ЯВНО различими A-old/A-new/B маркери —
 *         доказва изрично, че A-old никога не се появява на екрана, нито
 *         дори временно между resolve на A-old и resolve на A-new
 *  [5]  Няма JS грешки в конзолата по време на сценария (desktop scenario)
 *
 * Profile popup stale-fetch race (profilePopupRequestToken guard,
 * createLobbyFlowController.ts onTopicMessageAuthorClick):
 *  [6]  Click author A → canonical fetch за A pending → click author B →
 *         canonical fetch за B pending → resolve B първи → popup показва B
 *  [7]  Resolve A след това → popup продължава да показва B, A response игнориран
 *  [8]  Popup затворен преди response → закъснелият response не го отваря отново
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Не успях да намеря свободен порт.'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

async function openTopicsScreen(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__topicsSwitchRaceHarness.openTopicsScreen()
  })
  await page.waitForSelector('[data-topics-screen="1"]', { state: 'attached' })
}

async function clickTopicChip(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__topicsSwitchRaceHarness.clickTopicChip(id)
  }, topicId)
}

async function deliverNextResponse(page: Page, topicId: string): Promise<void> {
  await page.evaluate((id) => {
    ;(window as any).__topicsSwitchRaceHarness.deliverNextResponse(id)
  }, topicId)
}

async function deliverNextResponseWithBody(page: Page, topicId: string, body: string): Promise<void> {
  await page.evaluate(
    ({ id, b }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextResponseWithBody(id, b)
    },
    { id: topicId, b: body },
  )
}

async function getLoadCallLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getLoadCallLog())
}

async function getVisibleMessageBodies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies())
}

async function deliverNextResponseWithAuthor(
  page: Page,
  topicId: string,
  body: string,
  senderProfileId: string,
  senderDisplayName: string,
): Promise<void> {
  await page.evaluate(
    ({ id, b, pid, name }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextResponseWithAuthor(id, b, pid, name)
    },
    { id: topicId, b: body, pid: senderProfileId, name: senderDisplayName },
  )
}

async function deliverNextResponseWithAuthors(
  page: Page,
  topicId: string,
  authors: Array<{ body: string; senderProfileId: string; senderDisplayName: string }>,
): Promise<void> {
  await page.evaluate(
    ({ id, list }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextResponseWithAuthors(id, list)
    },
    { id: topicId, list: authors },
  )
}

async function deliverNextResponseWithAuthorsAndHasMore(
  page: Page,
  topicId: string,
  authors: Array<{ body: string; senderProfileId: string; senderDisplayName: string }>,
  hasMore: boolean,
): Promise<void> {
  await page.evaluate(
    ({ id, list, more }) => {
      ;(window as any).__topicsSwitchRaceHarness.deliverNextResponseWithAuthorsAndHasMore(id, list, more)
    },
    { id: topicId, list: authors, more: hasMore },
  )
}

async function clickMessageAuthor(page: Page, profileId: string): Promise<void> {
  await page.evaluate((pid) => {
    ;(window as any).__topicsSwitchRaceHarness.clickMessageAuthor(pid)
  }, profileId)
}

async function deliverNextProfileResponse(page: Page, profileId: string): Promise<void> {
  await page.evaluate((pid) => {
    ;(window as any).__topicsSwitchRaceHarness.deliverNextProfileResponse(pid)
  }, profileId)
}

async function isProfilePopupOpen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.isProfilePopupOpen())
}

async function getProfilePopupText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsSwitchRaceHarness.getProfilePopupText())
}

async function closeProfilePopup(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__topicsSwitchRaceHarness.closeProfilePopup()
  })
}

console.log('\ncheckTopicsSwitchRace\n')

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
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsSwitchRaceHarness.html`

  browser = await chromium.launch()
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  await page.goto(baseUrl)
  await page.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })

  // ─── [1] Нормален ред: A resolve-ва първи (без реален race) ────────────────
  await check('[1] A→B switch, A resolve-ва първи → B се показва коректно', async () => {
    await openTopicsScreen(page)
    // showTopics() отваря general по подразбиране — изчистваме лога за яснота.
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)

    await clickTopicChip(page, 'topic-a')
    await deliverNextResponse(page, 'topic-a')
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      'Отговор за topic-a',
      { timeout: 3000 },
    )

    await clickTopicChip(page, 'topic-b')
    await deliverNextResponse(page, 'topic-b')
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      'Отговор за topic-b',
      { timeout: 3000 },
    )

    const bodies = await getVisibleMessageBodies(page)
    assert(bodies.some((t) => t.includes('topic-b')), 'Трябва да вижда отговора за topic-b')
  })

  // ─── [2] Реалният race: A resolve-ва ВТОРИ, СЛЕД B ──────────────────────────
  await check('[2] A→B switch, A resolve-ва ВТОРИ (реален race) → B остава на екрана', async () => {
    await clickTopicChip(page, 'topic-a')
    // НЕ delivery-ваме отговора за A все още — той виси pending.
    await page.waitForTimeout(20)

    await clickTopicChip(page, 'topic-b')
    // Доставяме B ПЪРВИ...
    await deliverNextResponse(page, 'topic-b')
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      'topic-b',
      { timeout: 3000 },
    )
    // ...после доставяме ЗАКЪСНЕЛИЯ отговор за A.
    await deliverNextResponse(page, 'topic-a')
    // Даваме време на event loop-а да обработи (ако guard-ът е счупен, тук
    // би презаписал екрана с topic-a данни).
    await page.waitForTimeout(100)

    const bodies = await getVisibleMessageBodies(page)
    assert(
      bodies.some((t) => t.includes('topic-b')),
      `Екранът трябваше да остане на topic-b, получих: ${JSON.stringify(bodies)}`,
    )
    assert(
      !bodies.some((t) => t.includes('Отговор за topic-a')),
      `Закъснелият отговор за topic-a НЕ трябваше да презапише topic-b, получих: ${JSON.stringify(bodies)}`,
    )
  })

  // ─── [3] Само 1 заявка е направена за всяка тема (не се дублира) ──────────
  // Сценарии [1] и [2] кликват topic-b по веднъж всеки → очаквано 2 общо
  // (не повече — липсата на race-induced дублиране е самата проверка).
  await check('[3] Точно 2 load заявки за topic-b общо (по 1 от сценарии [1] и [2], без дублиране)', async () => {
    const log = await getLoadCallLog(page)
    const topicBCalls = log.filter((id) => id === 'topic-b')
    assertEqual(topicBCalls.length, 2, `Очаквах точно 2 заявки за topic-b общо, получих ${topicBCalls.length}`)
  })

  // ─── [4] A→B→A rapid triple switch — с ЯВНО различими A-old/A-new/B ────────
  // Точния протокол от корекциите: доказваме НЕ само че крайният екран
  // показва нещо разумно, а че СТАРИЯТ отговор за A никога не се появява
  // на екрана дори за момент, включително МЕЖДУ стъпка 4 (resolve A-old) и
  // стъпка 6 (resolve A-new) — не само в крайното състояние.
  const MARKER_A_OLD = 'MARKER-A-OLD-UNIQUE-TEXT'
  const MARKER_A_NEW = 'MARKER-A-NEW-UNIQUE-TEXT'
  const MARKER_B = 'MARKER-B-UNIQUE-TEXT'

  await check('[4a] Стъпки 1-3: A-old остава pending, switch B, switch обратно A → A-new остава pending', async () => {
    // 1) request A-old остава pending
    await clickTopicChip(page, 'topic-a')
    await page.waitForTimeout(10)

    // 2) switch B
    await clickTopicChip(page, 'topic-b')
    await deliverNextResponseWithBody(page, 'topic-b', MARKER_B)
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      MARKER_B,
      { timeout: 3000 },
    )
    const bodiesAfterB = await getVisibleMessageBodies(page)
    assert(bodiesAfterB.some((t) => t.includes(MARKER_B)), 'B трябва да се вижда веднага след resolve')

    // 3) switch обратно A → request A-new остава pending
    await clickTopicChip(page, 'topic-a')
    await page.waitForTimeout(10)
  })

  await check('[4b] Стъпка 4-5: resolve A-old → A-old НЕ се появява, B/pending state непроменени', async () => {
    // 4) resolve A-old
    await deliverNextResponseWithBody(page, 'topic-a', MARKER_A_OLD)
    // Даваме реален прозорец на event loop-а — ако guard-ът е счупен, тук
    // A-old би се появило на екрана.
    await page.waitForTimeout(150)

    // 5) изрично провери, че A-old НЕ се е появило в message stream
    const bodiesAfterAOld = await getVisibleMessageBodies(page)
    assert(
      !bodiesAfterAOld.some((t) => t.includes(MARKER_A_OLD)),
      `A-old НИКОГА не трябва да се покаже (stale response guard), получих: ${JSON.stringify(bodiesAfterAOld)}`,
    )
  })

  await check('[4c] Стъпка 6-7: resolve A-new → A-new се показва, A-old никога не се е появило', async () => {
    // 6) resolve A-new
    await deliverNextResponseWithBody(page, 'topic-a', MARKER_A_NEW)
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      MARKER_A_NEW,
      { timeout: 3000 },
    )

    // 7) A-new се показва, A-old никога не се показва
    const finalBodies = await getVisibleMessageBodies(page)
    assert(
      finalBodies.some((t) => t.includes(MARKER_A_NEW)),
      `A-new трябва да се показва в крайното състояние, получих: ${JSON.stringify(finalBodies)}`,
    )
    assert(
      !finalBodies.some((t) => t.includes(MARKER_A_OLD)),
      `A-old не трябва да се показва дори в крайното състояние, получих: ${JSON.stringify(finalBodies)}`,
    )
  })

  // ─── [6]-[8] Profile popup stale-fetch race (profilePopupRequestToken) ────
  // Сценарии [4a]-[4c] оставят активната тема = topic-a (третото
  // превключване) — превключваме изрично към topic-b тук, за да имаме
  // предвидим контекст за кликаемите author бутони.
  await check('[6] Click author A → pending, click author B → pending, resolve B първи → popup показва B', async () => {
    await clickTopicChip(page, 'topic-b')
    // Доставяме ДВАМАТА автора в ЕДНО съобщение-response (една
    // onTopicMessagesLoad заявка за темата), за да имаме едновременно два
    // реални data-topic-message-author бутона в DOM-а.
    await deliverNextResponseWithAuthors(page, 'topic-b', [
      { body: 'msg-from-author-x', senderProfileId: 'author-x', senderDisplayName: 'Author X' },
      { body: 'msg-from-author-y', senderProfileId: 'author-y', senderDisplayName: 'Author Y' },
    ])
    await page.waitForFunction(
      () => document.querySelectorAll('[data-topic-message-author]').length >= 2,
      undefined,
      { timeout: 3000 },
    )

    await clickMessageAuthor(page, 'author-x')
    // canonical fetch за author-x остава pending (не сме доставили отговор).
    await page.waitForTimeout(20)
    assert(!(await isProfilePopupOpen(page)), 'Popup must stay closed while canonical profile authorization is pending')

    await clickMessageAuthor(page, 'author-y')
    // canonical fetch за author-y също остава pending.
    await page.waitForTimeout(20)

    // Resolve B (author-y) ПЪРВИ.
    await deliverNextProfileResponse(page, 'author-y')
    await page.waitForFunction(
      (needle) => ((window as any).__topicsSwitchRaceHarness.getProfilePopupText() ?? '').includes(needle),
      'Canonical author-y',
      { timeout: 3000 },
    )

    const text = await getProfilePopupText(page)
    assert(text !== null && text.includes('Canonical author-y'), `Popup трябва да показва author-y, получих: ${text}`)
  })

  await check('[7] Resolve A след това → popup продължава да показва B, A response игнориран', async () => {
    // Закъснелият canonical fetch за author-x resolve-ва СЕГА.
    await deliverNextProfileResponse(page, 'author-x')
    await page.waitForTimeout(100)

    const text = await getProfilePopupText(page)
    assert(
      text !== null && text.includes('Canonical author-y'),
      `Popup трябваше да ОСТАНЕ на author-y (stale response guard), получих: ${text}`,
    )
    assert(
      text === null || !text.includes('Canonical author-x'),
      `Закъснелият отговор за author-x НЕ трябваше да презапише popup-а, получих: ${text}`,
    )
  })

  await check('[8] Pending author profile auth не показва placeholder и отваря popup чак след canonical response', async () => {
    // Нужна е НОВА onTopicMessagesLoad заявка за topic-b (queue-то от [6] е
    // вече консумирано) — превключваме away и обратно, за да я тригнем.
    await clickTopicChip(page, 'topic-general')
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)
    await clickTopicChip(page, 'topic-b')
    await deliverNextResponseWithAuthor(page, 'topic-b', 'msg-from-author-z', 'author-z', 'Author Z')
    await page.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      'msg-from-author-z',
      { timeout: 3000 },
    )

    await clickMessageAuthor(page, 'author-z')
    await page.waitForTimeout(20)
    assert(!(await isProfilePopupOpen(page)), 'Popup must stay closed until the canonical profile authorization response arrives')

    // Response за author-z пристига след pending състоянието.
    await deliverNextProfileResponse(page, 'author-z')
    await page.waitForFunction(
      (needle) => ((window as any).__topicsSwitchRaceHarness.getProfilePopupText() ?? '').includes(needle),
      'Canonical author-z',
      { timeout: 3000 },
    )

    const text = await getProfilePopupText(page)
    assert(text !== null && text.includes('Canonical author-z'), `Popup must show author-z after canonical response, got: ${text}`)
  })

  // ─── [10] Layout regression: header/topics bar остават фиксирани при vertical scroll ──
  // Regression guard за корекцията "topics header/bar трябва да е
  // стационарен" — само [data-topic-messages-scroll] трябва да поема
  // vertical overflow, [data-topics-fixed-top] (заглавие + topics bar)
  // остава на същата viewport позиция.
  await check('[10] Topics header/bar остават фиксирани при vertical scroll на message stream', async () => {
    // Нужна е НОВА onTopicMessagesLoad заявка (queue-то от [8] е консумирано) —
    // превключваме away и обратно, за да я тригнем.
    await clickTopicChip(page, 'topic-general')
    await deliverNextResponse(page, 'topic-general')
    await page.waitForTimeout(20)
    await clickTopicChip(page, 'topic-b')

    // Доставяме достатъчно съобщения, за да предизвикаме реален overflow.
    await deliverNextResponseWithAuthors(page, 'topic-b', [
      { body: 'Съобщение 1 за layout теста', senderProfileId: 'author-x', senderDisplayName: 'Author X' },
      { body: 'Съобщение 2 за layout теста', senderProfileId: 'author-y', senderDisplayName: 'Author Y' },
    ])
    await page.waitForFunction(
      () => document.querySelectorAll('[data-topic-message]').length >= 2,
      undefined,
      { timeout: 3000 },
    )
    await page.waitForTimeout(100)

    const headerBefore = await page.evaluate(() => {
      const header = document.querySelector('[data-topics-fixed-top="1"]')
      const rect = header?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom } : null
    })
    assert(headerBefore !== null, 'data-topics-fixed-top трябва да съществува в DOM-а')

    await page.evaluate(() => {
      const scrollEl = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement | null
      if (scrollEl) scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop - 500)
    })
    await page.waitForTimeout(100)

    const headerAfter = await page.evaluate(() => {
      const header = document.querySelector('[data-topics-fixed-top="1"]')
      const rect = header?.getBoundingClientRect()
      return rect ? { top: rect.top, bottom: rect.bottom } : null
    })
    assert(headerAfter !== null, 'data-topics-fixed-top трябва да остане в DOM-а след scroll')

    assert(
      Math.abs(headerBefore!.top - headerAfter!.top) < 1,
      `Header top позицията НЕ трябва да се промени при scroll на message stream-а: преди=${headerBefore!.top}, след=${headerAfter!.top}`,
    )

    const bodyScrollY = await page.evaluate(() => window.scrollY)
    assertEqual(bodyScrollY, 0, 'page/body самият не трябва да scroll-ва вертикално за topics content-а')
  })

  // ─── [11] Layout regression: "+" остава фиксиран при horizontal swipe на topics bar ──
  // Regression guard за "+" бутонa — преди беше В ЕДИН И СЪЩ overflow-x:auto
  // контейнер с topic chips-овете, затова при swipe/scroll-snap временно
  // излизаше извън видимата зона. Сега е извън [data-topics-bar-scroll]
  // (отделен flex:0 0 auto елемент в outer row-а) — не трябва да мръдне
  // изобщо, независимо какво прави потребителят с chips-овете вдясно.
  await check('[11] "+" бутонът остава фиксиран при horizontal swipe на topics bar', async () => {
    const plusBefore = await page.evaluate(() => {
      const btn = document.querySelector('[data-topics-create="1"]')
      const rect = btn?.getBoundingClientRect()
      return rect ? { left: rect.left, top: rect.top } : null
    })
    assert(plusBefore !== null, '"+" бутонът трябва да съществува в DOM-а')

    await page.evaluate(() => {
      const scrollEl = document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement | null
      if (scrollEl) scrollEl.scrollLeft = scrollEl.scrollWidth
    })
    await page.waitForTimeout(100)

    const plusAfterSwipe = await page.evaluate(() => {
      const btn = document.querySelector('[data-topics-create="1"]')
      const rect = btn?.getBoundingClientRect()
      return rect ? { left: rect.left, top: rect.top } : null
    })
    assert(
      plusAfterSwipe !== null &&
        Math.abs(plusBefore!.left - plusAfterSwipe.left) < 1 &&
        Math.abs(plusBefore!.top - plusAfterSwipe.top) < 1,
      `"+" НЕ трябва да мръдне при swipe на topics bar-а: преди=${JSON.stringify(plusBefore)}, след=${JSON.stringify(plusAfterSwipe)}`,
    )

    const horizontalOverflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth)
    assert(!horizontalOverflow, 'Не трябва да има horizontal page overflow')

    // Връщаме scroll-а обратно, за да не влияе на следващи сценарии.
    await page.evaluate(() => {
      const scrollEl = document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement | null
      if (scrollEl) scrollEl.scrollLeft = 0
    })
  })

  await check('[9] Няма JS грешки в конзолата по време на сценария', () => {
    assert(consoleErrors.length === 0, `Конзолни грешки: ${consoleErrors.join(' | ')}`)
  })

  await context.close()

  // ─── [12]-[15] Wheel routing / arrow controls / scrollbar hiding ──────────
  // Отделен, МНОГО ТЕСЕН desktop viewport (260px) — topicsSwitchRaceHarness
  // има само 3 mock теми (general/a/b, за разлика от 5-те в
  // visualTopicsHarness), затова се нуждае от по-тесен viewport от обичайния
  // mobile breakpoint, за да принуди реален horizontal overflow.
  const narrowContext: BrowserContext = await browser!.newContext({ viewport: { width: 260, height: 900 } })
  const narrowPage = await narrowContext.newPage()
  const narrowErrors: string[] = []
  narrowPage.on('pageerror', (err) => narrowErrors.push(err.message))
  await narrowPage.goto(baseUrl)
  await narrowPage.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
  await openTopicsScreen(narrowPage)
  // Множество съобщения — нужен е реален vertical overflow за [13] теста
  // (единично съобщение от deliverNextResponse не прелива 900px viewport).
  await deliverNextResponseWithAuthors(
    narrowPage,
    'topic-general',
    Array.from({ length: 20 }, (_, i) => ({
      body: `Съобщение номер ${i + 1} за wheel/scroll теста — достатъчно дълъг текст, за да имаме реален vertical overflow в message stream контейнера.`,
      senderProfileId: 'author-x',
      senderDisplayName: 'Author X',
    })),
  )
  await narrowPage.waitForTimeout(50)

  await check('[12] Native horizontal scrollbar е скрит (scrollbar-width:none) без да чупи scroll функционалността', async () => {
    const scrollbarWidth = await narrowPage.evaluate(
      () => getComputedStyle(document.querySelector('[data-topics-bar-scroll="1"]')!).scrollbarWidth,
    )
    assertEqual(scrollbarWidth, 'none', 'scrollbar-width трябва да е none')
  })

  await check('[13] Vertical wheel върху topics bar скролва message stream, НЕ topics scrollLeft; "+" не мърда', async () => {
    const hasVerticalOverflow = await narrowPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      return el.scrollHeight > el.clientHeight
    })
    assert(hasVerticalOverflow, 'Нужен е реален vertical overflow в message stream-а за теста')

    // Initial load отива директно до дъното (viewport към последните
    // съобщения, по дизайн) — скролваме изрично нагоре първо, за да имаме
    // накъде да мърднем в двете посоки за самия wheel тест.
    await narrowPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      el.scrollTop = el.scrollHeight / 2
    })
    await narrowPage.waitForTimeout(50)

    const plusBefore = await narrowPage.evaluate(() => {
      const r = document.querySelector('[data-topics-create="1"]')?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top } : null
    })
    const topicsScrollLeftBefore = await narrowPage.evaluate(() => (document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement).scrollLeft)
    const messagesScrollTopBefore = await narrowPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollTop)

    // Синтетичен WheelEvent dispatch, отрицателна deltaY (скрол нагоре) —
    // детерминиран, не зависи от OS-level курсорна позиция (page.mouse.wheel
    // координатите се оказаха ненадеждни в headless Chromium при малки
    // target елементи по време на разработката).
    await narrowPage.evaluate(() => {
      document.querySelector('[data-topics-bar-scroll="1"]')!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -150, deltaX: 0, bubbles: true, cancelable: true }),
      )
    })
    await narrowPage.waitForTimeout(100)

    const plusAfter = await narrowPage.evaluate(() => {
      const r = document.querySelector('[data-topics-create="1"]')?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top } : null
    })
    const topicsScrollLeftAfter = await narrowPage.evaluate(() => (document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement).scrollLeft)
    const messagesScrollTopAfter = await narrowPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollTop)

    assertEqual(topicsScrollLeftBefore, topicsScrollLeftAfter, 'topics scrollLeft НЕ трябва да се промени от vertical wheel')
    assert(messagesScrollTopAfter < messagesScrollTopBefore, `message stream трябва да се скролне нагоре: преди=${messagesScrollTopBefore}, след=${messagesScrollTopAfter}`)
    assert(
      plusBefore !== null && plusAfter !== null &&
        Math.abs(plusBefore.left - plusAfter.left) < 1 && Math.abs(plusBefore.top - plusAfter.top) < 1,
      '"+" не трябва да мръдне при wheel върху topics bar-а',
    )
  })

  await check('[14] Arrow controls: → достига последната тема, ← се връща в началото', async () => {
    const maxScrollLeft = await narrowPage.evaluate(() => {
      const el = document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement
      return el.scrollWidth - el.clientWidth
    })
    assert(maxScrollLeft > 0, `Нужен е реален overflow за теста, получих maxScrollLeft=${maxScrollLeft}`)

    for (let i = 0; i < 10; i++) {
      const disabled = await narrowPage.evaluate(() => (document.querySelector('[data-topics-arrow="right"]') as HTMLButtonElement)?.disabled)
      if (disabled) break
      await narrowPage.click('[data-topics-arrow="right"]')
      await narrowPage.waitForTimeout(300)
    }

    const lastChipInView = await narrowPage.evaluate(() => {
      const chips = Array.from(document.querySelectorAll('[data-topic-chip]'))
      const last = chips[chips.length - 1]
      if (!last) return false
      const rect = last.getBoundingClientRect()
      const containerRect = document.querySelector('[data-topics-bar-scroll="1"]')?.getBoundingClientRect()
      return containerRect ? rect.left >= containerRect.left - 2 && rect.right <= containerRect.right + 2 : false
    })
    assert(lastChipInView, 'Последната тема трябва да е достижима чрез повторни кликове на →')

    for (let i = 0; i < 10; i++) {
      const disabled = await narrowPage.evaluate(() => (document.querySelector('[data-topics-arrow="left"]') as HTMLButtonElement)?.disabled)
      if (disabled) break
      await narrowPage.click('[data-topics-arrow="left"]')
      await narrowPage.waitForTimeout(300)
    }
    const scrollLeftAtStart = await narrowPage.evaluate(() => (document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement).scrollLeft)
    assert(scrollLeftAtStart < 2, `← трябва да върне в началото, получих scrollLeft=${scrollLeftAtStart}`)
  })

  await check('[15] Mobile viewport: arrow controls скрити, "+" и vertical swipe работят нормално', async () => {
    const mobileContext: BrowserContext = await browser!.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    })
    const mobilePage = await mobileContext.newPage()
    await mobilePage.goto(baseUrl)
    await mobilePage.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })
    await openTopicsScreen(mobilePage)
    await deliverNextResponse(mobilePage, 'topic-general')
    await mobilePage.waitForTimeout(50)

    const arrowsHidden = await mobilePage.evaluate(() => {
      const l = document.querySelector('[data-topics-arrow="left"]')
      const r = document.querySelector('[data-topics-arrow="right"]')
      return { left: l ? getComputedStyle(l).display : null, right: r ? getComputedStyle(r).display : null }
    })
    assertEqual(arrowsHidden.left, 'none', 'ляв arrow control трябва да е скрит на touch viewport')
    assertEqual(arrowsHidden.right, 'none', 'десен arrow control трябва да е скрит на touch viewport')

    const plusBefore = await mobilePage.evaluate(() => {
      const r = document.querySelector('[data-topics-create="1"]')?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top } : null
    })
    await mobilePage.evaluate(() => {
      const el = document.querySelector('[data-topics-bar-scroll="1"]') as HTMLElement
      el.scrollLeft = el.scrollWidth
    })
    await mobilePage.waitForTimeout(100)
    const plusAfter = await mobilePage.evaluate(() => {
      const r = document.querySelector('[data-topics-create="1"]')?.getBoundingClientRect()
      return r ? { left: r.left, top: r.top } : null
    })
    assert(
      plusBefore !== null && plusAfter !== null && Math.abs(plusBefore.left - plusAfter.left) < 1,
      '"+" не трябва да мръдне при touch swipe на mobile',
    )

    const likeMobileInfo = await mobilePage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-like]') as HTMLElement | null
      if (!btn) return null
      const icon = btn.querySelector('.topic-message-action-icon') as HTMLElement | null
      const iconRect = icon?.getBoundingClientRect() ?? null
      const cs = getComputedStyle(btn)
      const r = btn.getBoundingClientRect()
      return {
        visibleText: btn.textContent?.trim() ?? '',
        iconWidth: iconRect?.width ?? null,
        iconHeight: iconRect?.height ?? null,
        paddingTop: parseFloat(cs.paddingTop),
        paddingBottom: parseFloat(cs.paddingBottom),
        width: r.width,
        height: r.height,
      }
    })
    assert(likeMobileInfo !== null, 'Like копчето трябва да съществува на mobile')
    assert((likeMobileInfo!.visibleText?.length ?? 0) <= 2, `mobile Like НЕ трябва да показва постоянен текст, получено: "${likeMobileInfo!.visibleText}"`)
    assert(likeMobileInfo!.iconWidth !== null && likeMobileInfo!.iconWidth >= 18 && likeMobileInfo!.iconHeight !== null && likeMobileInfo!.iconHeight >= 18, 'иконата трябва да остане голяма на mobile')
    assert(likeMobileInfo!.paddingTop + likeMobileInfo!.paddingBottom >= 18, 'mobile tap зоната трябва да е удобна за пръст (media query padding)')

    const bodyScrollWidth = await mobilePage.evaluate(() => document.body.scrollWidth)
    assert(bodyScrollWidth <= 390, `не трябва да има horizontal overflow на mobile, получено bodyScrollWidth=${bodyScrollWidth}`)

    await mobileContext.close()
  })

  await check('[16] Няма JS грешки в конзолата по време на wheel/arrow сценариите', () => {
    assert(narrowErrors.length === 0, `Конзолни грешки: ${narrowErrors.join(' | ')}`)
  })

  await narrowContext.close()

  // ─── [17]-[24] Viewport isolation architecture regression ─────────────────
  // Пълна viewport isolation спецификация: Topics screen никога не причинява
  // page-level (window/body) vertical scroll, footer не се рендира в Topics
  // view, fixed top/composer не мърдат, message stream е единственият
  // vertical scroll container, scroll chaining е contained на top/bottom,
  // initial open landing на bottom, load-older запазва позицията.
  const isoContext: BrowserContext = await browser!.newContext({ viewport: { width: 1400, height: 900 } })
  const isoPage = await isoContext.newPage()
  const isoErrors: string[] = []
  isoPage.on('pageerror', (err) => isoErrors.push(err.message))
  await isoPage.goto(baseUrl)
  await isoPage.waitForFunction(() => (window as any).__topicsSwitchRaceHarness !== undefined, undefined, { timeout: 10_000 })

  async function getScrollMetrics(page: Page) {
    return page.evaluate(() => ({
      windowScrollY: window.scrollY,
      bodyScrollHeight: document.body.scrollHeight,
      docScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    }))
  }

  await check('[17] Initial Topics open → window.scrollY=0, body height не превишава viewport', async () => {
    await openTopicsScreen(isoPage)
    await deliverNextResponse(isoPage, 'topic-general')
    await isoPage.waitForTimeout(50)

    const metrics = await getScrollMetrics(isoPage)
    assertEqual(metrics.windowScrollY, 0, 'window.scrollY трябва да е 0 при отваряне на Теми')
    assert(
      metrics.bodyScrollHeight <= metrics.innerHeight + 2,
      `document.body.scrollHeight (${metrics.bodyScrollHeight}) не трябва да превишава viewport height (${metrics.innerHeight})`,
    )
  })

  await check('[18] Footer НЕ съществува в Topics view', async () => {
    const footerCount = await isoPage.evaluate(
      () => document.querySelectorAll('[data-lobby-footer-legal-link="1"], [data-lobby-mobile-footer-legal-link="1"], footer').length,
    )
    assertEqual(footerCount, 0, 'Не трябва да има footer елементи в Topics view')
  })

  await check('[19] Composer форма присъства и е позиционирана (Етап 2 — real composer, тук без VIP callback -> vip-locked readonly)', async () => {
    const composer = await isoPage.evaluate(() => {
      const form = document.querySelector('[data-topics-composer-form="1"]')
      const textarea = document.querySelector('[data-topics-composer-text="1"]')
      const button = document.querySelector('[data-topics-composer-send="1"]')
      return {
        exists: form !== null,
        // Този harness не подава onGetTopicsVipGateStatus/onClaimTopicsLaunchGift
        // -> topicsVipGate остава null -> composer се рендира non-VIP-locked
        // (readonly, НЕ disabled — виж Етап 2 корекция т.4 UX модел).
        vipLocked: form ? (form as HTMLFormElement).dataset.topicsComposerVipLocked === '1' : null,
        textareaReadonly: textarea ? (textarea as HTMLTextAreaElement).readOnly : null,
        buttonExists: button !== null,
      }
    })
    assert(composer.exists, 'Composer формата трябва да съществува в DOM-а')
    assertEqual(composer.vipLocked, true, 'Без VIP gate callback composer-ът трябва да е vip-locked')
    assertEqual(composer.textareaReadonly, true, 'Textarea трябва да е readonly (не disabled) в non-VIP състояние')
    assert(composer.buttonExists, 'Send бутонът трябва да съществува')
  })

  await check('[20] Message stream е единственият vertical scroll container (fixed top/composer не мърдат при scroll)', async () => {
    // Достатъчно съобщения за реален overflow.
    await deliverNextResponseWithAuthors(
      isoPage,
      'topic-general',
      Array.from({ length: 25 }, (_, i) => ({
        body: `Viewport isolation съобщение ${i + 1} — достатъчно текст за overflow.`,
        senderProfileId: 'author-x',
        senderDisplayName: 'Author X',
      })),
    )
    await isoPage.waitForTimeout(80)

    const before = await isoPage.evaluate(() => ({
      header: document.querySelector('[data-topics-fixed-top="1"]')?.getBoundingClientRect().top,
      composer: document.querySelector('[data-topics-composer-form="1"]')?.getBoundingClientRect().top,
    }))

    await isoPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      el.scrollTop = el.scrollHeight / 3
    })
    await isoPage.waitForTimeout(80)

    const after = await isoPage.evaluate(() => ({
      header: document.querySelector('[data-topics-fixed-top="1"]')?.getBoundingClientRect().top,
      composer: document.querySelector('[data-topics-composer-form="1"]')?.getBoundingClientRect().top,
      windowScrollY: window.scrollY,
    }))

    assertEqual(before.header, after.header, 'Fixed top не трябва да мърда при scroll на message stream-а')
    assertEqual(before.composer, after.composer, 'Composer не трябва да мърда при scroll на message stream-а')
    assertEqual(after.windowScrollY, 0, 'window.scrollY трябва да остане 0 при scroll на message stream-а')
  })

  await check('[21] Scroll до absolute bottom + допълнителен wheel надолу → stream остава на bottom, window.scrollY=0', async () => {
    await isoPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      el.scrollTop = el.scrollHeight
    })
    await isoPage.waitForTimeout(50)
    const before = await isoPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollTop)

    await isoPage.evaluate(() => {
      document.querySelector('[data-topic-messages-scroll="1"]')!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 400, deltaX: 0, bubbles: true, cancelable: true }),
      )
    })
    await isoPage.waitForTimeout(80)

    const after = await isoPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollTop)
    const windowScrollY = await isoPage.evaluate(() => window.scrollY)

    assertEqual(after, before, 'Message stream не трябва да скролва отвъд bottom-а (overscroll containment)')
    assertEqual(windowScrollY, 0, 'window.scrollY трябва да остане 0 дори при wheel отвъд bottom-а')
  })

  await check('[22] Scroll до absolute top + допълнителен wheel нагоре → window.scrollY=0', async () => {
    await isoPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      el.scrollTop = 0
    })
    await isoPage.waitForTimeout(50)

    await isoPage.evaluate(() => {
      document.querySelector('[data-topic-messages-scroll="1"]')!.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -400, deltaX: 0, bubbles: true, cancelable: true }),
      )
    })
    await isoPage.waitForTimeout(80)

    const windowScrollY = await isoPage.evaluate(() => window.scrollY)
    assertEqual(windowScrollY, 0, 'window.scrollY трябва да остане 0 дори при wheel отвъд top-а')
  })

  await check('[23] Topic switch → новата тема отваря viewport-а на bottom (newest message)', async () => {
    await clickTopicChip(isoPage, 'topic-a')
    await deliverNextResponseWithAuthors(isoPage, 'topic-a', [
      { body: 'Първо съобщение в topic-a', senderProfileId: 'author-x', senderDisplayName: 'Author X' },
      { body: 'Последно съобщение в topic-a (най-ново)', senderProfileId: 'author-x', senderDisplayName: 'Author X' },
    ])
    await isoPage.waitForFunction(
      (needle) => (window as any).__topicsSwitchRaceHarness.getVisibleMessageBodies().some((t: string) => t.includes(needle)),
      'Последно съобщение в topic-a',
      { timeout: 3000 },
    )
    await isoPage.waitForTimeout(80)

    const atBottom = await isoPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      return el.scrollHeight - el.clientHeight - el.scrollTop <= 4
    })
    assert(atBottom, 'При отваряне на нова тема viewport-ът трябва да е позициониран на bottom (най-новото съобщение)')
  })

  await check('[24] Load older (scroll до top) prepend-ва съобщения и запазва visual позицията (без jump)', async () => {
    await clickTopicChip(isoPage, 'topic-b')
    // Първоначален отговор с hasMore:true — активира loadOlderTopicMessages()
    // scroll-triggered пътя (early-return-ва при hasMore:false).
    await deliverNextResponseWithAuthorsAndHasMore(
      isoPage,
      'topic-b',
      Array.from({ length: 15 }, (_, i) => ({
        body: `Load-older база съобщение ${i + 1}`,
        senderProfileId: 'author-x',
        senderDisplayName: 'Author X',
      })),
      true,
    )
    await isoPage.waitForFunction(
      () => document.querySelectorAll('[data-topic-message]').length >= 15,
      undefined,
      { timeout: 3000 },
    )
    await isoPage.waitForTimeout(80)

    const messageCountBefore = await isoPage.evaluate(() => document.querySelectorAll('[data-topic-message]').length)

    // Scroll до top → тригва onTopicMessagesLoadOlder (scrollTop <= 40).
    await isoPage.evaluate(() => {
      const el = document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement
      el.scrollTop = 0
    })
    await isoPage.evaluate(() => {
      document.querySelector('[data-topic-messages-scroll="1"]')!.dispatchEvent(new Event('scroll'))
    })
    await isoPage.waitForTimeout(50)

    // Anchor елемент — първото видимо съобщение СЛЕД скрола до top (преди
    // prepend-ът пристигне) — трябва да остане на същата viewport позиция
    // след prepend (без visual jump).
    const scrollHeightBefore = await isoPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollHeight)
    const anchorTextBefore = await isoPage.evaluate(() => document.querySelector('[data-topic-message]')?.textContent ?? null)
    const anchorTopBefore = await isoPage.evaluate(() => document.querySelector('[data-topic-message]')?.getBoundingClientRect().top ?? null)

    // Доставяме по-старите съобщения (prepend).
    await deliverNextResponseWithAuthorsAndHasMore(
      isoPage,
      'topic-b',
      Array.from({ length: 5 }, (_, i) => ({
        body: `По-старо съобщение ${i + 1}`,
        senderProfileId: 'author-x',
        senderDisplayName: 'Author X',
      })),
      false,
    )
    await isoPage.waitForFunction(
      (needle) => document.querySelectorAll('[data-topic-message]').length >= needle,
      messageCountBefore + 5,
      { timeout: 3000 },
    )
    await isoPage.waitForTimeout(80)

    const scrollHeightAfter = await isoPage.evaluate(() => (document.querySelector('[data-topic-messages-scroll="1"]') as HTMLElement).scrollHeight)
    const anchorTextAfterPrepend = await isoPage.evaluate(
      (needle) => Array.from(document.querySelectorAll('[data-topic-message]')).find((el) => el.textContent === needle)?.getBoundingClientRect().top ?? null,
      anchorTextBefore,
    )

    assert(scrollHeightAfter > scrollHeightBefore, 'scrollHeight трябва да расте след prepend на по-стари съобщения')
    assert(
      anchorTopBefore !== null && anchorTextAfterPrepend !== null && Math.abs(anchorTopBefore - anchorTextAfterPrepend) < 2,
      `Anchor съобщението не трябва да "скача" визуално след prepend: преди=${anchorTopBefore}, след=${anchorTextAfterPrepend}`,
    )

    const windowScrollY = await isoPage.evaluate(() => window.scrollY)
    assertEqual(windowScrollY, 0, 'window.scrollY трябва да остане 0 по време на load-older')
  })

  // ─── [26]-[30] UI polish pass: "+" (зелен, скоро), Like/Reply (скоро), width ──

  await check('[26] "+" бутонът е зелен (не сив/disabled) и pinned най-вляво пред chips', async () => {
    const info = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topics-create="1"]') as HTMLButtonElement | null
      const row = document.querySelector('[data-topics-bar-row="1"]')
      if (!btn || !row) return null
      const cs = getComputedStyle(btn)
      const firstChild = row.children[0]
      return {
        isFirstChild: firstChild === btn,
        hasAriaDisabled: btn.hasAttribute('aria-disabled'),
        backgroundImage: cs.backgroundImage,
      }
    })
    assert(info !== null, '"+" бутонът и topics-bar-row трябва да съществуват')
    assert(info!.isFirstChild, '"+" трябва да е първият елемент в topics-bar-row (най-вляво, pinned)')
    assert(!info!.hasAriaDisabled, '"+" вече НЕ трябва да носи aria-disabled (реагира на клик с toast, не е истински disabled)')
    // Браузърът нормализира hex цветовете от inline style-а до rgb() при computed style четене.
    assert(
      /rgb\(34,\s*197,\s*94\)/.test(info!.backgroundImage) || /rgb\(22,\s*163,\s*74\)/.test(info!.backgroundImage),
      `"+" трябва да ползва зеления gradient (#22c55e/#16a34a), получен background-image: ${info!.backgroundImage}`,
    )
  })

  await check('[27] Клик върху "+" (non-VIP fixture) отваря VIP-required popup, БЕЗ create-topic форма/навигация — mirror на Like/Reply non-VIP gate (Custom Topic Creation, canonical HEAD)', async () => {
    // Production поведение (canonical HEAD a4e54f1): "+" вече НЕ показва
    // placeholder toast — handleTopicCreateClick() reuse-ва establishedата
    // composer non-VIP tap логика (виж createLobbyFlowController.ts). Harness-ът
    // няма topicsVipGate wired (isActive:false по подразбиране), значи клик
    // трябва да отвори СЪЩИЯ VIP-required popup като Like/Reply (тестове
    // [28]/[29] по-долу), НЕ create-topic формата директно.
    const urlBefore = isoPage.url()
    const activeTopicBefore = await isoPage.evaluate(() =>
      document.querySelector('[data-topic-chip][data-active="1"]')?.getAttribute('data-topic-chip') ?? null,
    )
    await isoPage.click('[data-topics-create="1"]')
    await isoPage.waitForSelector('[data-topics-vip-popup-card="1"]', { state: 'attached', timeout: 1000 })

    const toastVisible = await isoPage.evaluate(() => document.body.textContent?.includes('Създаването на теми ще бъде налично скоро.') ?? false)
    assert(!toastVisible, '"+" вече НЕ трябва да показва стария placeholder toast (Custom Topic Creation — реална функционалност)')

    const hasCreateForm = await isoPage.evaluate(() => document.querySelector('[data-topic-create-form="1"]') !== null)
    assert(!hasCreateForm, 'non-VIP клик НЕ трябва да отвори create-topic формата directno — VIP gate-ът е пред нея')
    assertEqual(isoPage.url(), urlBefore, 'URL не трябва да се промени (без навигация)')
    const activeTopicAfter = await isoPage.evaluate(() =>
      document.querySelector('[data-topic-chip][data-active="1"]')?.getAttribute('data-topic-chip') ?? null,
    )
    assertEqual(activeTopicAfter, activeTopicBefore, 'активната тема не трябва да се променя')

    // Затваряме popup-а, за да не пречи на следващите тестове в СЪЩИЯ isoPage
    // (mirror на teardown-а в [29] по-долу — established convention).
    await isoPage.evaluate(() => {
      const closeBtn = document.querySelector<HTMLButtonElement>('[data-topics-vip-popup-close="1"]')
      closeBtn?.click()
    })
    await isoPage.waitForSelector('[data-topics-vip-popup-backdrop="1"]', { state: 'detached', timeout: 1000 })
  })

  await check('[28] Like: само икона (без постоянен текст), по-голяма от преди, aria-label + tooltip, реална tap зона, реален optimistic toggle (Етап 3)', async () => {
    const likeInfo = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-like]') as HTMLButtonElement | null
      if (!btn) return null
      const icon = btn.querySelector('.topic-message-action-icon') as HTMLElement | null
      const cs = getComputedStyle(btn)
      const iconRect = icon?.getBoundingClientRect() ?? null
      return {
        tagName: btn.tagName,
        visibleText: btn.textContent?.trim() ?? '',
        ariaLabel: btn.getAttribute('aria-label'),
        dataTooltip: btn.getAttribute('data-tooltip'),
        hasTitleAttr: btn.hasAttribute('title'),
        paddingTop: parseFloat(cs.paddingTop),
        paddingBottom: parseFloat(cs.paddingBottom),
        iconWidth: iconRect?.width ?? null,
        iconHeight: iconRect?.height ?? null,
      }
    })
    assert(likeInfo !== null, 'поне едно Like копче трябва да съществува в текущия message stream')
    assertEqual(likeInfo!.tagName, 'BUTTON', 'Like трябва да е истински <button>, не <span>')
    assertEqual(likeInfo!.ariaLabel, 'Харесай', 'Like трябва да има aria-label="Харесай"')
    assertEqual(likeInfo!.dataTooltip, 'Харесай', 'Like трябва да носи data-tooltip="Харесай" (custom tooltip pattern)')
    assert(!likeInfo!.hasTitleAttr, 'Like НЕ трябва да ползва browser-native title tooltip (имаме собствен tooltip pattern)')
    assert(likeInfo!.paddingTop + likeInfo!.paddingBottom >= 14, 'Like трябва да има реален vertical padding за tap зона, по-голяма от самата икона')
    assert(likeInfo!.iconWidth !== null && likeInfo!.iconWidth >= 18 && likeInfo!.iconHeight !== null && likeInfo!.iconHeight >= 18, `иконата трябва да е осезаемо по-голяма (>=18px), получено: ${likeInfo!.iconWidth}x${likeInfo!.iconHeight}`)

    // Много message rows са се натрупали от предишни тестове в СЪЩИЯ isoPage
    // — data-topic-message-like е keyed по messageId (Етап 3), не е уникален
    // selector сам по себе си при множество rows, затова навсякъде тук
    // explicit-но взимаме ПЪРВОТО съвпадение (.first()),
    // огледално на document.querySelector семантиката, ползвана другаде в
    // този файл. scrollIntoViewIfNeeded() ПРЕДИ да мерим rectBefore, за да не
    // объркаме auto-scroll-а (по-долу от hover()-а) с реален layout shift.
    const likeLocator = isoPage.locator('[data-topic-message-like]').first()
    await likeLocator.scrollIntoViewIfNeeded()

    const rectBefore = await isoPage.evaluate(() => document.querySelector('[data-topic-message-like]')!.getBoundingClientRect().toJSON())
    const opacityBefore = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-like]') as HTMLElement
      return parseFloat(getComputedStyle(btn, '::after').opacity)
    })
    assertEqual(opacityBefore, 0, 'tooltip-ът НЕ трябва да е видим без hover/focus')

    await likeLocator.hover()
    // CSS transition:opacity 0.15s ease — изчакваме до 400ms, poll-вайки за
    // финалната стойност, вместо fixed sleep по-къс от transition-а.
    await isoPage.waitForFunction(() => {
      const btn = document.querySelector('[data-topic-message-like]') as HTMLElement
      return parseFloat(getComputedStyle(btn, '::after').opacity) === 1
    }, undefined, { timeout: 400 })
    const opacityOnHover = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-like]') as HTMLElement
      return parseFloat(getComputedStyle(btn, '::after').opacity)
    })
    assertEqual(opacityOnHover, 1, 'desktop hover трябва да покаже "Харесай" tooltip-а (opacity:1)')
    const rectAfterHover = await isoPage.evaluate(() => document.querySelector('[data-topic-message-like]')!.getBoundingClientRect().toJSON())
    assertEqual(JSON.stringify(rectBefore), JSON.stringify(rectAfterHover), 'hover tooltip-ът НЕ трябва да мести layout-а (position:absolute)')

    // Етап 3 — Like вече е реален toggle (optimistic UI flip), не "скоро"
    // toast. Click трябва веднага (синхронно, преди какъвто и да е WS
    // roundtrip) да смени иконата ♡ → ♥ и aria-pressed=false → true.
    const fillBefore = await isoPage.evaluate(() => document.querySelector('[data-topic-message-like] .topic-message-action-icon svg')?.getAttribute('fill') ?? '')
    const pressedBefore = await isoPage.evaluate(() => document.querySelector('[data-topic-message-like]')?.getAttribute('aria-pressed'))
    assertEqual(pressedBefore, 'false', 'преди click aria-pressed трябва да е false (не е харесано)')

    await likeLocator.click()
    await isoPage.waitForFunction(() => document.querySelector('[data-topic-message-like]')?.getAttribute('aria-pressed') === 'true', undefined, { timeout: 1000 })
    const fillAfter = await isoPage.evaluate(() => document.querySelector('[data-topic-message-like] .topic-message-action-icon svg')?.getAttribute('fill') ?? '')
    assert(fillBefore !== fillAfter && fillAfter === 'currentColor', `like SVG fill трябва да се смени при click (optimistic flip), преди="${fillBefore}", след="${fillAfter}"`)

    const toastVisible = await isoPage.evaluate(() => document.body.textContent?.includes('Функцията ще бъде налична скоро.') ?? false)
    assert(!toastVisible, 'Like вече НЕ трябва да показва "ще бъде налично скоро" toast (Етап 3 — реална функционалност)')

    await isoPage.mouse.move(0, 0)
  })

  await check('[29] Reply: само икона, aria-label + tooltip, keyboard focus показва tooltip, non-VIP click отваря VIP popup (Етап 3)', async () => {
    const replyInfo = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-reply]') as HTMLButtonElement | null
      if (!btn) return null
      const icon = btn.querySelector('.topic-message-action-icon') as HTMLElement | null
      const iconRect = icon?.getBoundingClientRect() ?? null
      return {
        tagName: btn.tagName,
        visibleText: btn.textContent?.trim() ?? '',
        ariaLabel: btn.getAttribute('aria-label'),
        dataTooltip: btn.getAttribute('data-tooltip'),
        iconWidth: iconRect?.width ?? null,
        iconHeight: iconRect?.height ?? null,
      }
    })
    assert(replyInfo !== null, 'поне едно Reply копче трябва да съществува')
    assertEqual(replyInfo!.tagName, 'BUTTON', 'Reply трябва да е истински <button>, не <span>')
    assertEqual(replyInfo!.ariaLabel, 'Отговори', 'Reply трябва да има aria-label="Отговори"')
    assertEqual(replyInfo!.dataTooltip, 'Отговори', 'Reply трябва да носи data-tooltip="Отговори"')
    assert(replyInfo!.iconWidth !== null && replyInfo!.iconWidth >= 18 && replyInfo!.iconHeight !== null && replyInfo!.iconHeight >= 18, `иконата трябва да е осезаемо по-голяма (>=18px), получено: ${replyInfo!.iconWidth}x${replyInfo!.iconHeight}`)

    // Keyboard focus (:focus-visible) трябва да покаже същия tooltip —
    // accessibility еквивалент на hover. `:focus-visible` в Chromium следва
    // input modality-то — програмен .focus() (без предхождащ Tab) не винаги
    // го тригерва надеждно, затова focus-ваме Like (реда преди Reply в DOM-а)
    // и после реално натискаме Tab клавиша, за да стигнем до Reply — това е
    // истинска keyboard навигация, каквато :focus-visible очаква.
    const replyLocator = isoPage.locator('[data-topic-message-reply]').first()
    await isoPage.locator('[data-topic-message-like]').first().focus()
    await isoPage.keyboard.press('Tab')
    await isoPage.waitForFunction(() => {
      const btn = document.querySelector('[data-topic-message-reply]') as HTMLElement | null
      return btn === document.activeElement && parseFloat(getComputedStyle(btn, '::after').opacity) === 1
    }, undefined, { timeout: 400 })
    const opacityOnFocus = await isoPage.evaluate(() => {
      const btn = document.querySelector('[data-topic-message-reply]') as HTMLElement
      return parseFloat(getComputedStyle(btn, '::after').opacity)
    })
    assertEqual(opacityOnFocus, 1, 'keyboard focus трябва да покаже "Отговори" tooltip-а (:focus-visible)')

    // Етап 3 — Reply вече е реална функционалност (не "скоро" toast). Non-VIP
    // (harness-ът няма topicsVipGate wired → isActive:false) click трябва да
    // отвори СЪЩИЯ VIP-required popup, ползван от root composer-a, БЕЗ да
    // focus-не inline reply composer textarea.
    await replyLocator.click()
    await isoPage.waitForSelector('[data-topics-vip-popup-card="1"]', { state: 'attached', timeout: 1000 })

    const toastVisible = await isoPage.evaluate(() => document.body.textContent?.includes('Функцията ще бъде налична скоро.') ?? false)
    assert(!toastVisible, 'Reply вече НЕ трябва да показва "ще бъде налично скоро" toast (Етап 3 — реална функционалност)')

    const replyComposerFocused = await isoPage.evaluate(() => document.activeElement?.matches('[data-topics-reply-composer-text="1"]') ?? false)
    assert(!replyComposerFocused, 'Non-VIP click НЕ трябва да focus-не inline reply composer-а — VIP popup-ът е правилният flow')

    // Затваряме popup-а, за да не пречи на следващите тестове в СЪЩИЯ isoPage.
    await isoPage.evaluate(() => {
      const closeBtn = document.querySelector<HTMLButtonElement>('[data-topics-vip-popup-close="1"]')
      closeBtn?.click()
    })
  })

  await check('[30] Desktop Topics width: header/topics-bar/message-stream/composer споделят СЪЩАТА content ширина (canonical navbar width)', async () => {
    const rectOf = async (sel: string): Promise<{ left: number; right: number } | null> => isoPage.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right) }
    }, sel)
    const widths = {
      fixedTop: await rectOf('[data-topics-fixed-top="1"]'),
      streamContainer: await rectOf('[data-topics-stream-container="1"]'),
      composerForm: await rectOf('[data-topics-composer-form="1"]'),
    }
    assert(widths.fixedTop !== null && widths.streamContainer !== null, 'header и message stream трябва да съществуват')
    assert(
      Math.abs(widths.fixedTop!.left - widths.streamContainer!.left) <= 8 &&
      Math.abs(widths.fixedTop!.right - widths.streamContainer!.right) <= 8,
      `header и message stream трябва да имат почти същите леви/десни граници: header=${JSON.stringify(widths.fixedTop)}, stream=${JSON.stringify(widths.streamContainer)}`,
    )
    if (widths.composerForm) {
      assert(
        Math.abs(widths.fixedTop!.left - widths.composerForm.left) <= 8 &&
        Math.abs(widths.fixedTop!.right - widths.composerForm.right) <= 8,
        `composer трябва да следва СЪЩАТА ширина като header/stream: header=${JSON.stringify(widths.fixedTop)}, composer=${JSON.stringify(widths.composerForm)}`,
      )
    }
  })

  // [32] е ДИРЕКТНАТА регресия за проблема от втория UI polish кръг: споделен
  // max-width constant (тествано в [30] по-горе) НЕ гарантира еднаква
  // ФАКТИЧЕСКИ рендирана ширина — nav е content-driven (margin:auto
  // self-centering изключва stretch), затова тук сравняваме РЕАЛНИТЕ
  // getBoundingClientRect() ръбове на <nav> срещу [data-topics-desktop-shell],
  // не абстрактен CSS-constant равенство.
  await check('[32] Desktop: Topics outer shell edges (getBoundingClientRect) съвпадат с РЕАЛНО рендираните navbar edges, не само max-width константата', async () => {
    const rectOf = async (sel: string): Promise<{ left: number; right: number; width: number } | null> => isoPage.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }
    }, sel)
    const navRect = await rectOf('nav')
    const shellRect = await rectOf('[data-topics-desktop-shell="1"]')
    assert(navRect !== null, 'nav трябва да съществува на desktop')
    assert(shellRect !== null, '[data-topics-desktop-shell="1"] трябва да съществува на desktop')
    // Допустима толерантност само за border/padding субпиксел разлики
    // (виж коментара в renderLobbyScreen.ts над JS width-measurement блока),
    // НЕ за структурно разминаване като преди фикса (~1600 vs ~1270, delta 330px).
    const TOLERANCE_PX = 4
    assert(
      Math.abs(navRect!.left - shellRect!.left) <= TOLERANCE_PX &&
      Math.abs(navRect!.right - shellRect!.right) <= TOLERANCE_PX &&
      Math.abs(navRect!.width - shellRect!.width) <= TOLERANCE_PX,
      `Topics shell трябва визуално да се подравнява с РЕАЛНО рендираната navbar ширина (±${TOLERANCE_PX}px): nav=${JSON.stringify(navRect)}, shell=${JSON.stringify(shellRect)}`,
    )
  })

  await check('[33] Няма JS грешки в конзолата по време на viewport isolation сценариите (вкл. UI polish pass взаимодействията)', () => {
    assert(isoErrors.length === 0, `Конзолни грешки: ${isoErrors.join(' | ')}`)
  })

  await isoContext.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${String(actual)}, expected ${String(expected)}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

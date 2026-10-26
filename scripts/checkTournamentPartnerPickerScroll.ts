/**
 * checkTournamentPartnerPickerScroll.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * "списъкът с приятели в 'Избери партньор' се връща в началото през кратки
 * интервали, докато потребителят скролва".
 *
 * ROOT CAUSE (доказано, не предположено): picker-ът живее вътре в
 * root.innerHTML (renderTournamentDetailScreen -> renderLobbyScreen). Пълният
 * render() има skip-if-unchanged guard (nextRootHtml === lastRenderedRootHtml),
 * но детайлният екран на отворен турнир вгражда в HTML-а секунден брояч
 * ("Изтича след MM:SS" / "Остават ... сек."), изчислен от Date.now(). Затова
 * ВСЕКИ render() >1 сек след предишния дава различен HTML -> guard-ът никога
 * не сработва -> root.innerHTML се подменя изцяло -> friends list node-ът се
 * пресъздава със scrollTop = 0. Честият тригер е "Лафче": всеки нов пост
 * праща topic_unread_count_changed до всеки directory subscriber, а на
 * desktop layout refreshTopicsUnreadDom() не намира mobile badge node-овете
 * и пада към scheduleRender() -> пълен render().
 *
 * Тестът кара РЕАЛНИЯ createLobbyFlowController през fixture harness
 * (scripts/fixtures/tournamentPartnerPickerScrollHarness.ts) и проверява DOM
 * node identity (stamped marker) + scrollTop след фонови събития, с реални
 * паузи >1 сек, за да може броячът реално да смени текста си.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
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
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
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

type Metrics = { scrollTop: number; scrollHeight: number; clientHeight: number }

type H = {
  init: () => Promise<void>
  flush: () => Promise<void>
  flushPastScheduledRender: () => Promise<void>
  openPicker: () => Promise<void>
  closePicker: () => Promise<void>
  isPickerOpen: () => Promise<boolean>
  friendRowCount: () => Promise<number>
  getFriendsListNodeId: () => Promise<string | null>
  getFriendsListMetrics: () => Promise<Metrics | null>
  scrollFriendsListTo: (px: number) => Promise<number>
  scrollFriendsListToBottom: () => Promise<number>
  backgroundRender: () => Promise<void>
  lafchePost: () => Promise<void>
  tournamentTeamUpdated: (confirmedEntriesCount: number) => Promise<void>
  isFriendRowVisibleInList: (profileId: string) => Promise<boolean>
  clickFriend: (profileId: string) => Promise<void>
  getCountdownText: () => Promise<string | null>
  getRootRebuildCount: () => Promise<number>
  getDetailLoadCount: () => Promise<number>
  getCandidatesLoadCount: () => Promise<number>
  getLastInviteSubmittedProfileId: () => Promise<string | null>
  lastFriendProfileId: () => Promise<string>
  rootText: () => Promise<string>
}

function harness(page: Page): H {
  const w = '__tournamentPartnerPickerScrollHarness'
  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(([k, n, a]: any) => (window as any)[k][n](...a), [w, name, args] as any)
  return {
    init: () => call('init') as Promise<void>,
    flush: () => call('flush') as Promise<void>,
    flushPastScheduledRender: () => call('flushPastScheduledRender') as Promise<void>,
    openPicker: () => call('openPicker') as Promise<void>,
    closePicker: () => call('closePicker') as Promise<void>,
    isPickerOpen: () => call('isPickerOpen') as Promise<boolean>,
    friendRowCount: () => call('friendRowCount') as Promise<number>,
    getFriendsListNodeId: () => call('getFriendsListNodeId') as Promise<string | null>,
    getFriendsListMetrics: () => call('getFriendsListMetrics') as Promise<Metrics | null>,
    scrollFriendsListTo: (px) => call('scrollFriendsListTo', px) as Promise<number>,
    scrollFriendsListToBottom: () => call('scrollFriendsListToBottom') as Promise<number>,
    backgroundRender: () => call('backgroundRender') as Promise<void>,
    lafchePost: () => call('lafchePost') as Promise<void>,
    tournamentTeamUpdated: (n) => call('tournamentTeamUpdated', n) as Promise<void>,
    isFriendRowVisibleInList: (p) => call('isFriendRowVisibleInList', p) as Promise<boolean>,
    clickFriend: (p) => call('clickFriend', p) as Promise<void>,
    getCountdownText: () => call('getCountdownText') as Promise<string | null>,
    getRootRebuildCount: () => call('getRootRebuildCount') as Promise<number>,
    getDetailLoadCount: () => call('getDetailLoadCount') as Promise<number>,
    getCandidatesLoadCount: () => call('getCandidatesLoadCount') as Promise<number>,
    getLastInviteSubmittedProfileId: () => call('getLastInviteSubmittedProfileId') as Promise<string | null>,
    lastFriendProfileId: () => call('lastFriendProfileId') as Promise<string>,
    rootText: () => page.evaluate(() => document.body.textContent ?? ''),
  }
}

// Countdown текстът е секунден — пауза >1 сек гарантира, че следващият
// render би произвел различен HTML, ако броячът участва в сравнението.
const COUNTDOWN_TICK_WAIT_MS = 1_100

async function runScenario(browser: Browser, baseUrl: string, label: string, viewport: { width: number; height: number }): Promise<void> {
  console.log(`\n── ${label} (${viewport.width}x${viewport.height}) ──`)
  const context = await browser.newContext({ baseURL: baseUrl, viewport })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentPartnerPickerScrollHarness.html')
  await page.waitForFunction(() => (window as any).__tournamentPartnerPickerScrollHarness !== undefined)
  const h = harness(page)
  await h.init()
  await h.openPicker()
  await h.flush()

  let nodeId: string | null = null
  const SCROLL_TARGET = 400

  await check(`[${label}][1] picker се отваря с дълъг, скролируем списък приятели`, async () => {
    assert(await h.isPickerOpen(), 'picker не е отворен')
    assert((await h.friendRowCount()) === 40, `очаквани 40 реда, има ${await h.friendRowCount()}`)
    const m = await h.getFriendsListMetrics()
    assert(m !== null && m.scrollHeight > m.clientHeight + SCROLL_TARGET, `списъкът не е достатъчно скролируем: ${JSON.stringify(m)}`)
    nodeId = await h.getFriendsListNodeId()
    const top = await h.scrollFriendsListTo(SCROLL_TARGET)
    assert(top === SCROLL_TARGET, `scrollTop след превъртане е ${top}`)
  })

  await check(`[${label}][2] без активност (броячът тиктака 2.5 сек) — списъкът и скролът остават`, async () => {
    await wait(2_500)
    await h.flush()
    assert((await h.getFriendsListNodeId()) === nodeId, 'friends list node-ът е пресъздаден')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
  })

  await check(`[${label}][3] несвързан фонов render() след тик на брояча не пресъздава списъка`, async () => {
    const rebuildsBefore = await h.getRootRebuildCount()
    for (let i = 0; i < 3; i++) {
      await wait(COUNTDOWN_TICK_WAIT_MS)
      await h.backgroundRender()
      await h.flush()
    }
    assert((await h.getFriendsListNodeId()) === nodeId, 'friends list node-ът е пресъздаден от фонов render()')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
    assert((await h.getRootRebuildCount()) === rebuildsBefore, `root е rebuild-нат ${(await h.getRootRebuildCount()) - rebuildsBefore} пъти`)
  })

  await check(`[${label}][3b] броячът продължава да се обновява на живо, въпреки пропуснатите rebuild-и`, async () => {
    const before = await h.getCountdownText()
    assert(before !== null && /^Изтича след \d{2}:\d{2}$/.test(before), `неочакван текст на брояча: ${before}`)
    await wait(COUNTDOWN_TICK_WAIT_MS + 200)
    await h.backgroundRender()
    await h.flush()
    const after = await h.getCountdownText()
    assert(after !== null && /^Изтича след \d{2}:\d{2}$/.test(after), `неочакван текст на брояча: ${after}`)
    assert(after !== before, `броячът е замръзнал на "${before}"`)
  })

  await check(`[${label}][4] нови постове в "Лафче" (topic_unread_count_changed) не пресъздават ненужно списъка и не нулират скрола`, async () => {
    // Първият пост (0 -> 1 unread) легитимно сменя видимия "Теми" badge в
    // navbar-а/менюто — допустим е най-много ЕДИН rebuild, а скролът трябва
    // да оцелее и през него.
    const rebuildsBefore = await h.getRootRebuildCount()
    await wait(COUNTDOWN_TICK_WAIT_MS)
    await h.lafchePost()
    await h.flushPastScheduledRender()
    const firstPostRebuilds = (await h.getRootRebuildCount()) - rebuildsBefore
    assert(firstPostRebuilds <= 1, `root е rebuild-нат ${firstPostRebuilds} пъти за първия Лафче пост`)
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop след първия пост = ${(await h.getFriendsListMetrics())?.scrollTop}`)

    // Всеки следващ пост само увеличава брояча (badge-ът остава същият) —
    // никакъв rebuild, същият DOM node.
    nodeId = await h.getFriendsListNodeId()
    const rebuildsAfterFirst = await h.getRootRebuildCount()
    for (let i = 0; i < 3; i++) {
      await wait(COUNTDOWN_TICK_WAIT_MS)
      await h.lafchePost()
      await h.flushPastScheduledRender()
    }
    assert((await h.getFriendsListNodeId()) === nodeId, 'friends list node-ът е пресъздаден от Лафче събитие')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
    const laterRebuilds = (await h.getRootRebuildCount()) - rebuildsAfterFirst
    assert(laterRebuilds === 0, `root е rebuild-нат ${laterRebuilds} пъти за 3 последващи Лафче поста`)
  })

  await check(`[${label}][5] реално турнирно обновяване запазва отворения picker и позицията`, async () => {
    const loadsBefore = await h.getDetailLoadCount()
    await wait(COUNTDOWN_TICK_WAIT_MS)
    await h.tournamentTeamUpdated(2)
    await h.flush()
    assert((await h.getDetailLoadCount()) === loadsBefore + 1, 'турнирният детайл не е refetch-нат')
    assert((await h.rootText()).includes('2 / 8'), 'обновеният брой участници не е показан')
    assert(await h.isPickerOpen(), 'picker-ът се е затворил при турнирното обновяване')
    assert((await h.friendRowCount()) === 40, 'редовете с приятели липсват след обновяването')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
    nodeId = await h.getFriendsListNodeId()
  })

  await check(`[${label}][6] няколко поредни цикъла (Лафче + render + турнир) — скролът оцелява`, async () => {
    for (let i = 0; i < 3; i++) {
      await wait(COUNTDOWN_TICK_WAIT_MS)
      await h.lafchePost()
      await h.flushPastScheduledRender()
      await h.backgroundRender()
      await h.tournamentTeamUpdated(3 + i)
      await h.flush()
    }
    assert(await h.isPickerOpen(), 'picker-ът се е затворил')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
  })

  await check(`[${label}][7] затваряне и повторно отваряне — свеж списък от началото, после пак стабилен`, async () => {
    await h.closePicker()
    await h.flush()
    assert(!(await h.isPickerOpen()), 'picker-ът не се затвори')
    const candidateLoadsBefore = await h.getCandidatesLoadCount()
    await h.openPicker()
    await h.flush()
    assert(await h.isPickerOpen(), 'picker-ът не се отвори повторно')
    assert((await h.getCandidatesLoadCount()) === candidateLoadsBefore + 1, 'приятелите не са заредени наново при повторно отваряне')
    assert((await h.friendRowCount()) === 40, 'редовете с приятели липсват след повторно отваряне')
    assert((await h.getFriendsListMetrics())?.scrollTop === 0, `повторно отвореният списък не започва от началото: ${(await h.getFriendsListMetrics())?.scrollTop}`)
    nodeId = await h.getFriendsListNodeId()
    await h.scrollFriendsListTo(SCROLL_TARGET)
    await wait(COUNTDOWN_TICK_WAIT_MS)
    await h.lafchePost()
    await h.flushPastScheduledRender()
    await h.backgroundRender()
    await h.flush()
    assert((await h.getFriendsListNodeId()) === nodeId, 'friends list node-ът е пресъздаден след повторно отваряне')
    assert((await h.getFriendsListMetrics())?.scrollTop === SCROLL_TARGET, `scrollTop = ${(await h.getFriendsListMetrics())?.scrollTop}`)
  })

  await check(`[${label}][8] продължително скролване до последния приятел + фонови събития -> успешен избор`, async () => {
    await h.scrollFriendsListToBottom()
    const bottom = (await h.getFriendsListMetrics())?.scrollTop ?? 0
    assert(bottom > SCROLL_TARGET, `списъкът не стигна дъното: ${bottom}`)
    for (let i = 0; i < 2; i++) {
      await wait(COUNTDOWN_TICK_WAIT_MS)
      await h.lafchePost()
      await h.flushPastScheduledRender()
      await h.backgroundRender()
      await h.flush()
    }
    assert((await h.getFriendsListMetrics())?.scrollTop === bottom, `скролът при дъното се изгуби: ${(await h.getFriendsListMetrics())?.scrollTop}`)
    const last = await h.lastFriendProfileId()
    assert(await h.isFriendRowVisibleInList(last), 'последният приятел не е видим в списъка')
    await h.clickFriend(last)
    await h.flush()
    assert((await h.getLastInviteSubmittedProfileId()) === last, `поканата е за ${await h.getLastInviteSubmittedProfileId()}, очакван ${last}`)
    assert(!(await h.isPickerOpen()), 'picker-ът не се затвори след успешна покана')
  })

  await check(`[${label}] няма JS грешки в конзолата`, () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()
}

console.log('\n═══ checkTournamentPartnerPickerScroll ═══')

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

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  await runScenario(browser, baseUrl, 'desktop', { width: 1280, height: 900 })
  await runScenario(browser, baseUrl, 'phone', { width: 400, height: 860 })

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

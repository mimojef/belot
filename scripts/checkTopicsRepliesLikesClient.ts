/**
 * checkTopicsRepliesLikesClient.ts
 *
 * Client-side behavior checks за Етап 3 (реални Likes + едно-ниво Replies):
 * expand/collapse на replies, reply draft isolation между множество отворени
 * threads, VIP gate reuse за non-VIP Reply click, optimistic like toggle +
 * server reconciliation, realtime merge (topic_reply/topic_message_like_changed*),
 * Enter/Shift+Enter, success/failure draft handling, topic-switch isolation.
 *
 * Reuse-ва topicsComposerVipGateHarness.ts (permanent Етап 2 fixture,
 * разширен за Етап 3 с onTopicReplySend/onTopicMessageLikeToggle/
 * onTopicRepliesLoad + helper методи) — вместо да дублира VIP gate
 * инфраструктурата в нов harness.
 *
 * [1]  Reply бутон под root съобщение показва replyCount (0 -> без видим брой)
 * [2]  Like бутон показва начален state (♡, aria-pressed=false) от snapshot-а
 * [3]  Non-VIP click Reply -> отваря VIP popup, БЕЗ да отвори inline composer
 * [4]  VIP click Reply -> expand-ва thread + отваря inline composer (fetch replies)
 * [5]  Collapse (повторен click Reply) -> replies section изчезва, composer се затваря
 * [6]  Reply draft isolation: draft за root A остава непокътнат след отваряне на composer за root B
 * [7]  Reply composer Enter изпраща (onTopicReplySend извикан), Shift+Enter НЕ изпраща
 * [8]  Успешен topic_reply (matching requestId) изчиства draft-а и pending state-а
 * [9]  topic_reply_error пази draft-а, показва error текст
 * [10] Like click -> optimistic UI flip веднага (преди server round-trip), бутонът се disable-ва (pending)
 * [11] topic_message_like_changed_self reconciliation презаписва count/viewerHasLiked с authoritative стойност
 * [12] topic_message_like_changed (public broadcast) обновява count, НЕ пипа viewerHasLiked
 * [13] topic_reply realtime push към EXPANDED thread append-ва reply в DOM-а
 * [14] topic_reply push към COLLAPSED thread НЕ append-ва в DOM, само root replyCount расте
 * [15] Topic switch не пренася activeTopicId-specific reply composer state (isolation)
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type H = {
  controller: { handleServerMessage: (message: Record<string, unknown>) => boolean }
  openTopicsScreen: () => void
  clickTopicChip: (topicId: string) => void
  clickTopicsPersonalOpen: () => void
  clickTopicsBackToGeneral: () => void
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => void
  setNextMessagesResult: (messages: unknown[], hasMore?: boolean) => void
  setNextRepliesResult: (replies: unknown[], hasMore?: boolean, deletedMessageIds?: string[]) => void
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  makeReply: (topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  getReplySendLog: () => Array<{ topicId: string; parentMessageId: string; body: string; requestId: string }>
  getLikeToggleLog: () => Array<{ messageId: string; requestId: string }>
  getRepliesLoadLog: () => Array<{ topicId: string; rootMessageId: string; afterSeq: number | null }>
  simulateServerMessage: (message: Record<string, unknown>) => boolean
  clickRootCard: (rootMessageId: string) => void
  clickThreadBack: () => void
  isThreadVisible: () => boolean
  getThreadRootMessageId: () => string | null
  isReplyComposerReadonly: (rootMessageId: string) => boolean | null
  clickReplyButton: (rootMessageId: string) => void
  clickLikeButton: (messageId: string) => void
  isRepliesSectionExpanded: (rootMessageId: string) => boolean
  getReplyComposerValue: (rootMessageId: string) => string | null
  setReplyComposerValue: (rootMessageId: string, value: string) => void
  submitReplyComposer: (rootMessageId: string) => void
  pressEnterInReplyComposer: (rootMessageId: string, shiftKey: boolean) => void
  isReplyComposerOpen: (rootMessageId: string) => boolean
  getLikeButtonState: (messageId: string) => { pressed: string | null; liked: boolean; count: number; disabled: boolean } | null
  getReplyButtonCount: (rootMessageId: string) => number
  getVisibleReplyIds: (rootMessageId: string) => Array<string | null>
  isVipPopupOpen: () => boolean
  clickVipPopupClose: () => void
  getComposerErrorText: () => string | null
  isTopicsStreamVisible: () => boolean
  getTopicsPersonalPanelView: () => string | null
}

// Playwright page.evaluate(fn, arg) сериализира fn директно (Function.prototype.toString
// + browser-side re-eval под капака) — fn НЕ може да reference-не outer-scope
// променливи (closures не преминават през CDP boundary), само подадения `arg`.
// Затова тук подаваме harness-а КАТО ПЪРВИ елемент на tuple-а (window lookup
// се случва browser-side, вътре в fn), вместо да разчитаме на closure capture.
async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__topicsComposerVipGateHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

console.log('\ncheckTopicsRepliesLikesClient\n')

const renderTopicsSource = readFileSync(resolve(process.cwd(), 'src/app/lobby/renderTopicsScreen.ts'), 'utf8')
const topicActionSource = renderTopicsSource.slice(
  renderTopicsSource.indexOf('function renderTopicLikeButton'),
  renderTopicsSource.indexOf('function renderTopicMessageEditForm'),
)

await check('[0.1] Topics action icons use deterministic inline SVG helpers', () => {
  assert(renderTopicsSource.includes('function renderTopicActionIcon'), 'shared action icon helper missing')
  assert(renderTopicsSource.includes('width="20" height="20" viewBox="0 0 24 24"'), 'SVGs must use deterministic 20x20 viewBox')
  assert(renderTopicsSource.includes('stroke="currentColor"'), 'SVGs must inherit currentColor')
  assert(renderTopicsSource.includes("renderTopicActionIcon('like', { filled: viewerHasLiked })"), 'like action must use SVG helper')
  assert(renderTopicsSource.includes("renderTopicActionIcon('reply')"), 'reply action must use SVG helper')
})

await check('[0.2] Topics action rows no longer render Unicode glyph entities', () => {
  ;['&#128172;', '&#9825;', '&#9829;', '&#128465;', '&#9998;'].forEach((glyph) => {
    assert(!topicActionSource.includes(glyph), `${glyph} must not be used in message action row`)
  })
})

await check('[0.3] Topics action icon wrapper is a fixed 20x20 box and counts remain separate', () => {
  assert(renderTopicsSource.includes('width:20px;'), 'icon wrapper width must be fixed')
  assert(renderTopicsSource.includes('height:20px;'), 'icon wrapper height must be fixed')
  assert(renderTopicsSource.includes('flex:0 0 20px;'), 'icon wrapper flex basis must be fixed')
  assert(renderTopicsSource.includes('line-height:0;'), 'icon wrapper must not depend on font metrics')
  assert(renderTopicsSource.includes('topic-message-action-count'), 'action count element must remain present')
})

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`

  browser = await chromium.launch()
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))
  await page.goto(baseUrl)
  await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })

  // Уникален seed per извикване — makeMessage() генерира messageId от
  // `${topicId}-${seq}-${body}`, затова еднакви (seq, body) двойки между
  // отделни тестове биха произвели ИДЕНТИЧНИ messageId-та. Тъй като
  // controller instance-ът е СЪЩИЯТ (same page) през целия test suite,
  // state.topicExpandedReplyRootIds от предишен тест би "изтекъл" в следващ
  // тест с идентичен messageId, ако не рандомизираме тук.
  let openGeneralWithRootsCallCount = 0
  async function openGeneralWithRoots(vipActive: boolean): Promise<{ rootA: string; rootB: string }> {
    const callId = ++openGeneralWithRootsCallCount
    await call(page, (h: H, active: boolean) => h.setVipGate(active, true), vipActive)
    const rootA = await call(page, (h: H, seed: number) => h.makeMessage('topic-general', seed * 2 + 1, `root A body ${seed}`, 'author-x', 'Author X'), callId)
    const rootB = await call(page, (h: H, seed: number) => h.makeMessage('topic-general', seed * 2 + 2, `root B body ${seed}`, 'author-y', 'Author Y'), callId)
    await call(page, (h: H, msgs: unknown) => h.setNextMessagesResult(msgs as any[], false), [rootA, rootB])
    await call(page, (h: H) => h.openTopicsScreen())
    await page.waitForFunction(() => document.querySelectorAll('[data-topic-message]').length >= 2, undefined, { timeout: 3000 })
    return { rootA: rootA.messageId, rootB: rootB.messageId }
  }

  await check('[1] Reply бутон под root съобщение показва replyCount (0 -> без видим брой)', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    const count = await call(page, (h: H, id: string) => h.getReplyButtonCount(id), rootA)
    assertEqual(count, 0, 'replyCount=0 не трябва да показва видим брой (0 == no counter shown)')
  })

  await check('[2] Like бутон показва начален state (♡, aria-pressed=false) от snapshot-а', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    const state = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assert(state !== null, 'like бутонът трябва да съществува')
    assertEqual(state!.liked, false, 'начален state НЕ трябва да е liked')
    assertEqual(state!.pressed, 'false', 'aria-pressed трябва да е false')
  })

  await check('[3] Non-VIP click Reply -> opens thread; VIP popup appears only when trying to write', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const vipOpen = await call(page, (h: H) => h.isVipPopupOpen())
    assert(!vipOpen, 'Non-VIP read/open на thread НЕ трябва да отваря VIP popup')
    assert(await call(page, (h: H) => h.isThreadVisible()), 'Reply click трябва да отвори отделен thread view')
    assertEqual(await call(page, (h: H) => h.getThreadRootMessageId()), rootA, 'thread view трябва да е за точния rootMessageId')
    const composerOpen = await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA)
    assert(composerOpen, 'thread reply composer трябва да е видим за non-VIP')
    assertEqual(await call(page, (h: H, id: string) => h.isReplyComposerReadonly(id), rootA), true, 'non-VIP thread composer трябва да е readonly')
    await call(page, (h: H, id: string) => h.pressEnterInReplyComposer(id, false), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isVipPopupOpen()), 'Опит за писане като non-VIP трябва да отвори VIP popup')
    await call(page, (h: H) => h.clickVipPopupClose())
  })

  await check('[4] VIP click Reply -> opens exact thread + reply composer (fetch replies)', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'thread view трябва да се отвори')
    assertEqual(await call(page, (h: H) => h.getThreadRootMessageId()), rootA, 'thread view трябва да е за rootA')
    const expanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(expanded, 'replies section трябва да се render-ва вътре в thread view')
    const composerOpen = await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA)
    assert(composerOpen, 'thread reply composer трябва да се отвори за VIP click')
    const loadLog = await call(page, (h: H) => h.getRepliesLoadLog())
    assert(loadLog.some((l) => l.rootMessageId === rootA), 'onTopicRepliesLoad трябва да е извикан за rootA')
  })

  await check('[5] Thread Back -> closes thread; General stays without inline replies', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'thread трябва да е отворен преди Back')

    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)
    assert(!await call(page, (h: H) => h.isThreadVisible()), 'thread трябва да се затвори след Back')
    const generalExpanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(!generalExpanded, 'General stream НЕ трябва да показва inline replies след Back')
  })

  await check('[6] Reply draft isolation: draft за root A остава непокътнат след thread за root B', async () => {
    const { rootA, rootB } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootA, 'draft за A'])
    await page.waitForTimeout(50)

    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootB)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootB, 'draft за B'])
    await page.waitForTimeout(50)

    const bDraft = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootB)
    assertEqual(bDraft, 'draft за B', 'B composer-ът трябва да пази собствения си draft')

    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const aDraftAfterReturn = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootA)
    assertEqual(aDraftAfterReturn, 'draft за A', 'A draft-ът трябва да е запазен в state-a, независимо от B composer отварянето междувременно')
  })

  await check('[6.1] Root card surface opens exact thread; General has no inline replies', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickRootCard(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'root card surface трябва да отвори thread view')
    assertEqual(await call(page, (h: H) => h.getThreadRootMessageId()), rootA, 'card click трябва да отвори точния rootMessageId')
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)
    assert(!await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA), 'General НЕ трябва да render-ва inline replies')
  })

  await check('[6.2] Nested Like click does not open thread', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H, id: string) => h.clickLikeButton(id), rootA)
    await page.waitForTimeout(50)
    assert(!await call(page, (h: H) => h.isThreadVisible()), 'nested like button click НЕ трябва да отвори thread')
  })

  await check('[6.3] Browser Back closes open thread to General', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickRootCard(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'thread трябва да е отворен преди browser Back')
    await page.goBack({ timeout: 3000 }).catch(() => null)
    await page.waitForTimeout(100)
    assert(!await call(page, (h: H) => h.isThreadVisible()), 'browser Back трябва да затвори thread-а, не да остави thread view')
  })

  await check('[6.4] Root delete while thread open closes thread safely', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'thread трябва да е отворен преди delete push')
    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_message_deleted', topicId: 'topic-general', messageId: rootA, parentMessageId: null },
    )
    await page.waitForTimeout(100)
    assert(!await call(page, (h: H) => h.isThreadVisible()), 'root delete трябва да затвори thread view безопасно')
  })

  await check('[6.5] Thread renders replies in ascending order from canonical replies load', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 10, id, 'first reply'), rootA)
    const reply2 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 11, id, 'second reply'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1, reply2])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const ids = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(ids.join('|'), `${reply1.messageId}|${reply2.messageId}`, 'thread replies трябва да са във възходящ ред')
  })

  await check('[7] Reply composer Enter изпраща, Shift+Enter НЕ изпраща', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootA, 'reply текст'])

    await call(page, (h: H, id: string) => h.pressEnterInReplyComposer(id, true), rootA) // Shift+Enter
    await page.waitForTimeout(50)
    let log = await call(page, (h: H) => h.getReplySendLog())
    assertEqual(log.length, 0, 'Shift+Enter НЕ трябва да изпрати')

    await call(page, (h: H, id: string) => h.pressEnterInReplyComposer(id, false), rootA) // Enter
    await page.waitForTimeout(50)
    log = await call(page, (h: H) => h.getReplySendLog())
    assertEqual(log.length, 1, 'Enter трябва да изпрати точно веднъж')
    assertEqual(log[0]!.parentMessageId, rootA, 'requestId-ът трябва да е за правилния root')
  })

  await check('[8] Успешен topic_reply (matching requestId) изчиства draft-а и pending state-а', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootA, 'success draft'])
    await call(page, (h: H, id: string) => h.submitReplyComposer(id), rootA)
    await page.waitForTimeout(50)

    const log = await call(page, (h: H) => h.getReplySendLog())
    const requestId = log[log.length - 1]!.requestId

    await call(
      page,
      (h: H, reply: unknown) => h.simulateServerMessage(reply as Record<string, unknown>),
      { type: 'topic_reply', requestId, seq: 999, messageId: 'reply-success-1', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'me', senderDisplayName: 'Me', senderAvatarUrl: null, senderRole: 'player', body: 'success draft', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, viewerHasLiked: false, attachment: null },
    )
    await page.waitForTimeout(100)

    const draftAfter = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootA)
    assertEqual(draftAfter, '', 'draft трябва да е изчистен след успешен ack')
  })

  await check('[9] topic_reply_error пази draft-а, показва error текст', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootA, 'error draft'])
    await call(page, (h: H, id: string) => h.submitReplyComposer(id), rootA)
    await page.waitForTimeout(50)

    const log = await call(page, (h: H) => h.getReplySendLog())
    const requestId = log[log.length - 1]!.requestId

    await call(
      page,
      (h: H, err: unknown) => h.simulateServerMessage(err as Record<string, unknown>),
      { type: 'topic_reply_error', code: 'rate_limited', message: 'Твърде много съобщения.', requestId },
    )
    await page.waitForTimeout(100)

    const draftAfter = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootA)
    assertEqual(draftAfter, 'error draft', 'draft НЕ трябва да се изчисти при грешка')
  })

  await check('[10] Like click -> optimistic UI flip веднага (преди server round-trip), бутонът се disable-ва', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    const before = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assertEqual(before!.liked, false, 'преди click трябва да е not-liked')

    await call(page, (h: H, id: string) => h.clickLikeButton(id), rootA)
    await page.waitForTimeout(20) // синхронен optimistic flip, малко изчакване за DOM re-render

    const after = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assertEqual(after!.liked, true, 'optimistic flip трябва да смени иконата веднага')
    assertEqual(after!.count, 1, 'optimistic count трябва да е 1')
    assert(after!.disabled, 'бутонът трябва да е disabled докато pending ack')
  })

  await check('[11] topic_message_like_changed_self reconciliation презаписва с authoritative стойност', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    await call(page, (h: H, id: string) => h.clickLikeButton(id), rootA)
    await page.waitForTimeout(20)

    const log = await call(page, (h: H) => h.getLikeToggleLog())
    const requestId = log[log.length - 1]!.requestId

    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_message_like_changed_self', messageId: rootA, likeCount: 5, viewerHasLiked: true, requestId },
    )
    await page.waitForTimeout(50)

    const after = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assertEqual(after!.count, 5, 'authoritative count (5) трябва да презапише optimistic guess-а (1)')
    assertEqual(after!.disabled, false, 'бутонът трябва да е enabled отново след ack')
  })

  await check('[12] topic_message_like_changed (public broadcast) обновява count, НЕ пипа viewerHasLiked', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    const before = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assertEqual(before!.liked, false, 'преди broadcast трябва да е not-liked (никога не сме click-нали сами)')

    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_message_like_changed', messageId: rootA, likeCount: 7 },
    )
    await page.waitForTimeout(50)

    const after = await call(page, (h: H, id: string) => h.getLikeButtonState(id), rootA)
    assertEqual(after!.count, 7, 'public broadcast трябва да обнови count')
    assertEqual(after!.liked, false, 'public broadcast НЕ трябва да пипа own viewerHasLiked')
  })

  await check('[13] topic_reply push към EXPANDED thread append-ва reply в DOM-а', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_reply', seq: 500, messageId: 'reply-push-expanded', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'author-z', senderDisplayName: 'Author Z', senderAvatarUrl: null, senderRole: 'player', body: 'live reply', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, viewerHasLiked: false, attachment: null },
    )
    await page.waitForTimeout(100)

    const replyIds = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assert(replyIds.includes('reply-push-expanded'), 'live reply push трябва да append-не в expanded thread-а')
  })

  await check('[14] topic_reply push към COLLAPSED thread НЕ append-ва в DOM, само root replyCount расте', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    // Thread НЕ е expanded (не сме click-нали Reply).
    const countBefore = await call(page, (h: H, id: string) => h.getReplyButtonCount(id), rootA)
    assertEqual(countBefore, 0, 'начален replyCount трябва да е 0')

    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_reply', seq: 501, messageId: 'reply-push-collapsed', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'author-z', senderDisplayName: 'Author Z', senderAvatarUrl: null, senderRole: 'player', body: 'collapsed live reply', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, viewerHasLiked: false, attachment: null },
    )
    await page.waitForTimeout(100)

    const expanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(!expanded, 'thread трябва да остане collapsed')
    const countAfter = await call(page, (h: H, id: string) => h.getReplyButtonCount(id), rootA)
    assertEqual(countAfter, 1, 'root replyCount трябва да се увеличи дори при collapsed thread')
  })

  await check('[15] Personal open from thread clears thread id and does not restore wrong composer', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H) => h.isThreadVisible()), 'thread трябва да е отворен преди Personal switch')

    await call(page, (h: H) => h.clickTopicsPersonalOpen())
    await page.waitForTimeout(100)

    assertEqual(await call(page, (h: H) => h.isTopicsStreamVisible()), false, 'Personal mode трябва да скрива topic stream-а')
    assertEqual(await call(page, (h: H) => h.getTopicsPersonalPanelView()), 'list', 'Personal mode трябва да отвори inbox list context')
    await call(page, (h: H) => h.clickTopicsBackToGeneral())
    await page.waitForTimeout(100)
    assertEqual(await call(page, (h: H) => h.isThreadVisible()), false, 'връщане към Общ от Personal НЕ трябва да възстановява стар thread id')
    assertEqual(await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA), false, 'General stream НЕ трябва да възстановява thread composer')
  })

  await check('[16] Reopen на thread БЕЗ нови replies -> втори onTopicRepliesLoad е gap-closing (afterSeq = last known seq), няма duplicates', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 900, id, 'reopen no-op reply 1'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const idsAfterFirstOpen = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(idsAfterFirstOpen.join('|'), reply1.messageId, 'cold open трябва да покаже reply1')

    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    // Reopen: сървърът "няма" нищо ново след последния познат seq.
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    const loadLog = await call(page, (h: H) => h.getRepliesLoadLog())
    const loadsForRootA = loadLog.filter((l) => l.rootMessageId === rootA)
    assertEqual(loadsForRootA.length, 2, 'reopen трябва да задейства втора REST заявка (не early-return от кеша)')
    assertEqual(loadsForRootA[0]!.afterSeq, null, 'първото зареждане трябва да е cold load (afterSeq=null)')
    assertEqual(loadsForRootA[1]!.afterSeq, 900, 'reopen заявката трябва да е gap-closing от последния познат seq')

    const idsAfterReopen = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(idsAfterReopen.join('|'), reply1.messageId, 'reopen без нови replies не трябва да произведе duplicates')
  })

  await check('[17] Reopen на thread С 2 нови replies (badge-only path, без live WS push) -> detail view ги показва без refresh', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 910, id, 'seen before leaving'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    // Потребителят напуска thread-а (Back) — точно като report сценария,
    // новите replies идват само като badge/unread push (тук: НЕ симулираме
    // topic_reply push изобщо, тъй като real bug е "user not subscribed to
    // topic message channel" -> replies никога не идват по WS).
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    const reply2 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 911, id, 'new reply while away 1'), rootA)
    const reply3 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 912, id, 'new reply while away 2'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply2, reply3])

    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    const ids = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(
      ids.join('|'),
      `${reply1.messageId}|${reply2.messageId}|${reply3.messageId}`,
      'reopen трябва да покаже cached reply1 + двата нови reply-я, без нужда от browser refresh',
    )
  })

  await check('[18] Reopen с 1 нов reply merge-ва по messageId (dedup) при overlap със сървърния отговор', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 920, id, 'first'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    const reply2 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 921, id, 'second'), rootA)
    // Server response overlaps: връща reply1 отново (напр. race с afterSeq
    // граница) + новия reply2 — merge-ът по messageId не трябва да дублира reply1.
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1, reply2])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    const ids = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(ids.join('|'), `${reply1.messageId}|${reply2.messageId}`, 'overlap в server response не трябва да произведе duplicate reply1')
  })

  await check('[19] Reopen все още работи коректно заедно с live topic_reply push докато thread е отворен (не чупи [13])', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    await call(
      page,
      (h: H, msg: unknown) => h.simulateServerMessage(msg as Record<string, unknown>),
      { type: 'topic_reply', seq: 930, messageId: 'reply-push-after-reopen', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'author-z', senderDisplayName: 'Author Z', senderAvatarUrl: null, senderRole: 'player', body: 'live after reopen', createdAt: new Date().toISOString(), editedAt: null, likeCount: 0, viewerHasLiked: false, attachment: null },
    )
    await page.waitForTimeout(100)

    const ids = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assert(ids.includes('reply-push-after-reopen'), 'live push след reopen трябва да продължи да append-ва нормално')
  })

  await check('[20] Reopen след moderator delete на кеширан reply (без live push) -> изтритият reply изчезва без browser refresh', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 940, id, 'will be deleted'), rootA)
    const reply2 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 941, id, 'stays'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1, reply2])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const idsBeforeLeaving = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(idsBeforeLeaving.join('|'), `${reply1.messageId}|${reply2.messageId}`, 'начален кеш трябва да съдържа и двата replies')

    // Потребителят напуска thread-а — точно като [17], моделираме "unsubscribed
    // while away" сценария: НЕ симулираме topic_message_deleted push (real bug
    // е, че delete push никога не стига, ако не си message-channel subscriber
    // за темата в момента на delete-а).
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    // Reopen reconciliation: сървърът вече не връща нови replies, но докладва
    // reply1 като deleted (seq <= gap-closing afterSeq).
    await call(
      page,
      (h: H, [replies, deletedIds]: [unknown[], string[]]) => h.setNextRepliesResult(replies as any[], false, deletedIds),
      [[], [reply1.messageId]],
    )
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    const idsAfterReopen = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(idsAfterReopen.join('|'), reply2.messageId, 'reopen трябва да махне изтрития reply1 от кеша и да запази reply2, без browser refresh')
  })

  await check('[21] Reopen едновременно с нови И изтрити replies (combined reconciliation)', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    const reply1 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 950, id, 'old, will be deleted'), rootA)
    await call(page, (h: H, replies: unknown) => h.setNextRepliesResult(replies as any[], false), [reply1])
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H) => h.clickThreadBack())
    await page.waitForTimeout(100)

    const reply2 = await call(page, (h: H, id: string) => h.makeReply('topic-general', 951, id, 'new while away'), rootA)
    await call(
      page,
      (h: H, [replies, deletedIds]: [unknown[], string[]]) => h.setNextRepliesResult(replies as any[], false, deletedIds),
      [[reply2], [reply1.messageId]],
    )
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)

    const ids = await call(page, (h: H, id: string) => h.getVisibleReplyIds(id), rootA)
    assertEqual(ids.join('|'), reply2.messageId, 'combined reconciliation трябва едновременно да добави reply2 и да махне изтрития reply1')
  })

  await check('Няма JS грешки в конзолата по време на сценариите', () => {
    assert(consoleErrors.length === 0, `Конзолни грешки: ${consoleErrors.join(' | ')}`)
  })

  await context.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

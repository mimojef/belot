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
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => void
  setNextMessagesResult: (messages: unknown[], hasMore?: boolean) => void
  setNextRepliesResult: (replies: unknown[], hasMore?: boolean) => void
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  makeReply: (topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  getReplySendLog: () => Array<{ topicId: string; parentMessageId: string; body: string; requestId: string }>
  getLikeToggleLog: () => Array<{ messageId: string; requestId: string }>
  getRepliesLoadLog: () => Array<{ topicId: string; rootMessageId: string; afterSeq: number | null }>
  simulateServerMessage: (message: Record<string, unknown>) => boolean
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
  getComposerErrorText: () => string | null
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

  await check('[3] Non-VIP click Reply -> отваря VIP popup, БЕЗ да отвори inline composer', async () => {
    const { rootA } = await openGeneralWithRoots(false)
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const vipOpen = await call(page, (h: H) => h.isVipPopupOpen())
    assert(vipOpen, 'VIP popup трябва да се отвори при non-VIP click на Reply')
    const composerOpen = await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA)
    assert(!composerOpen, 'inline reply composer НЕ трябва да се отвори за non-VIP')
  })

  await check('[4] VIP click Reply -> expand-ва thread + отваря inline composer (fetch replies)', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const expanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(expanded, 'replies section трябва да е expanded след VIP click')
    const composerOpen = await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA)
    assert(composerOpen, 'inline reply composer трябва да се отвори за VIP click')
    const loadLog = await call(page, (h: H) => h.getRepliesLoadLog())
    assert(loadLog.some((l) => l.rootMessageId === rootA), 'onTopicRepliesLoad трябва да е извикан за rootA')
  })

  await check('[5] Collapse (повторен click Reply) -> replies section изчезва, composer се затваря', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA), 'трябва да е expanded преди collapse')

    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const stillExpanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(!stillExpanded, 'replies section трябва да изчезне след collapse click')
  })

  await check('[6] Reply draft isolation: draft за root A остава непокътнат след отваряне на composer за root B', async () => {
    const { rootA, rootB } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootA, 'draft за A'])
    await page.waitForTimeout(50)

    // Само ЕДИН composer отворен наведнъж (продуктово решение) — click на B затваря A composer-а visually.
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootB)
    await page.waitForTimeout(100)
    await call(page, (h: H, [id, v]: [string, string]) => h.setReplyComposerValue(id, v), [rootB, 'draft за B'])
    await page.waitForTimeout(50)

    const bDraft = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootB)
    assertEqual(bDraft, 'draft за B', 'B composer-ът трябва да пази собствения си draft')

    // Отваряме А отново — draft-ът за A трябва да е запазен в state-a (дори composer-ът да е бил затворен визуално).
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    const aDraftAfterReturn = await call(page, (h: H, id: string) => h.getReplyComposerValue(id), rootA)
    assertEqual(aDraftAfterReturn, 'draft за A', 'A draft-ът трябва да е запазен в state-a, независимо от B composer отварянето междувременно')
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
      { type: 'topic_reply', requestId, seq: 999, messageId: 'reply-success-1', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'me', senderDisplayName: 'Me', senderAvatarUrl: null, senderRole: 'player', body: 'success draft', createdAt: new Date().toISOString(), likeCount: 0, viewerHasLiked: false },
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
      { type: 'topic_reply', seq: 500, messageId: 'reply-push-expanded', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'author-z', senderDisplayName: 'Author Z', senderAvatarUrl: null, senderRole: 'player', body: 'live reply', createdAt: new Date().toISOString(), likeCount: 0, viewerHasLiked: false },
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
      { type: 'topic_reply', seq: 501, messageId: 'reply-push-collapsed', topicId: 'topic-general', parentMessageId: rootA, senderProfileId: 'author-z', senderDisplayName: 'Author Z', senderAvatarUrl: null, senderRole: 'player', body: 'collapsed live reply', createdAt: new Date().toISOString(), likeCount: 0, viewerHasLiked: false },
    )
    await page.waitForTimeout(100)

    const expanded = await call(page, (h: H, id: string) => h.isRepliesSectionExpanded(id), rootA)
    assert(!expanded, 'thread трябва да остане collapsed')
    const countAfter = await call(page, (h: H, id: string) => h.getReplyButtonCount(id), rootA)
    assertEqual(countAfter, 1, 'root replyCount трябва да се увеличи дори при collapsed thread')
  })

  await check('[15] Topic switch не пренася reply composer state от старата тема', async () => {
    const { rootA } = await openGeneralWithRoots(true)
    await call(page, (h: H) => h.setNextRepliesResult([], false))
    await call(page, (h: H, id: string) => h.clickReplyButton(id), rootA)
    await page.waitForTimeout(100)
    assert(await call(page, (h: H, id: string) => h.isReplyComposerOpen(id), rootA), 'composer трябва да е отворен преди switch')

    await call(page, (h: H) => h.setNextMessagesResult([], false))
    await call(page, (h: H, id: string) => h.clickTopicChip(id), 'topic-b')
    await page.waitForTimeout(100)

    const bodies = await page.evaluate(() => document.querySelectorAll('[data-topic-message]').length)
    assertEqual(bodies, 0, 'topic-b трябва да е празна (различен topic context)')
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

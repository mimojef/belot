/**
 * Browser regression for Topics message stream scroll retention.
 *
 * Exercises the real render/re-render path through Vite + Playwright. The
 * assertions use the actual scroll container metrics and message
 * getBoundingClientRect() anchors; no source-string shortcut can catch this
 * class of bug.
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page, type ViewportSize } from 'playwright'
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertClose(actual: number | null, expected: number | null, label: string, tolerancePx = 4): void {
  assert(actual !== null && expected !== null, `${label}: missing anchor metric`)
  const delta = Math.abs(actual - expected)
  assert(delta <= tolerancePx, `${label}: anchor moved by ${delta.toFixed(2)}px (expected <= ${tolerancePx}px)`)
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
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type H = {
  openTopicsScreen: () => void
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => void
  setNextMessagesResult: (messages: unknown[], hasMore?: boolean) => void
  setNextRepliesResult: (replies: unknown[], hasMore?: boolean) => void
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  makeReply: (topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  simulateServerMessage: (message: Record<string, unknown>) => boolean
  clickReplyButton: (rootMessageId: string) => void
  clickThreadBack: () => void
  getThreadScrollTop: () => number | null
  getThreadScrollHeight: () => number | null
  getThreadClientHeight: () => number | null
  getThreadBottomDistance: () => number | null
  setThreadScrollTop: (value: number) => void
  setReplyComposerValue: (rootMessageId: string, value: string) => void
  submitReplyComposer: (rootMessageId: string) => void
  getReplySendLog: () => Array<{ topicId: string; parentMessageId: string; body: string; requestId: string }>
  setComposerValue: (value: string) => void
  submitComposerForm: () => void
  getSendLog: () => Array<{ topicId: string; body: string; requestId: string }>
  getMessagesScrollTop: () => number | null
  getMessagesScrollHeight: () => number | null
  getMessagesClientHeight: () => number | null
  getMessagesBottomDistance: () => number | null
  getMessageTop: (messageId: string) => number | null
  getMessageBottom: (messageId: string) => number | null
  getMessageCount: () => number
  setMessagesScrollTop: (value: number) => void
  dispatchMessagesScroll: () => void
}

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

function makeTopicMessage(topicId: string, seq: number, prefix: string): Record<string, unknown> {
  const createdAt = new Date().toISOString()
  return {
    type: 'topic_message',
    seq,
    messageId: `${topicId}-${prefix}-${seq}`,
    topicId,
    parentMessageId: null,
    senderProfileId: `${prefix}-author`,
    senderDisplayName: `${prefix} Author`,
    senderAvatarUrl: null,
    senderRole: 'player',
    body: `${prefix} message ${seq}`,
    createdAt,
    lastActivityAt: createdAt,
    editedAt: null,
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    attachment: null,
  }
}

async function makeMessages(page: Page, topicId: string, startSeq: number, count: number, prefix: string, withAttachment = false): Promise<any[]> {
  return call(
    page,
    (h: H, arg: { topicId: string; startSeq: number; count: number; prefix: string; withAttachment: boolean }) => {
      return Array.from({ length: arg.count }, (_, i) => {
        const seq = arg.startSeq + i
        const msg = h.makeMessage(
          arg.topicId,
          seq,
          `${arg.prefix} ${seq} ${'long body text '.repeat(8)}`,
          `author-${arg.prefix}`,
          `Author ${arg.prefix}`,
        )
        msg.messageId = `${arg.topicId}-${arg.prefix}-${seq}`
        msg.unreadCount = 0
        msg.attachment = arg.withAttachment && i === 8
          ? {
              attachmentId: `att-${arg.prefix}-${seq}`,
              width: 320,
              height: 180,
              byteSize: 128,
              viewUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
              downloadUrl: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
            }
          : null
        return msg
      })
    },
    { topicId, startSeq, count, prefix, withAttachment },
  )
}

async function makeReplies(page: Page, topicId: string, parentMessageId: string, startSeq: number, count: number, prefix: string): Promise<any[]> {
  return call(
    page,
    (h: H, arg: { topicId: string; parentMessageId: string; startSeq: number; count: number; prefix: string }) => {
      return Array.from({ length: arg.count }, (_, i) => {
        const seq = arg.startSeq + i
        const reply = h.makeReply(
          arg.topicId,
          seq,
          arg.parentMessageId,
          `${arg.prefix} reply ${seq} ${'reply body text '.repeat(6)}`,
          `reply-author-${arg.prefix}`,
          `Reply Author ${arg.prefix}`,
        )
        reply.messageId = `${arg.topicId}-${arg.prefix}-reply-${seq}`
        reply.attachment = null
        return reply
      })
    },
    { topicId, parentMessageId, startSeq, count, prefix },
  )
}

async function openTopic(page: Page, messages: any[], hasMore = false): Promise<void> {
  await call(page, (h: H) => h.setVipGate(true, true))
  await call(page, (h: H, arg: { messages: unknown[]; hasMore: boolean }) => h.setNextMessagesResult(arg.messages, arg.hasMore), { messages, hasMore })
  await call(page, (h: H) => h.openTopicsScreen())
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-topic-message]').length >= count,
    messages.length,
    { timeout: 5000 },
  )
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    return el !== null && el.scrollHeight > el.clientHeight + 200
  }, undefined, { timeout: 5000 })
}

async function scrollMessageNearTop(page: Page, messageId: string, offsetPx = 24): Promise<void> {
  await page.evaluate(
    ({ messageId: id, offset }) => {
      const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
      const message = document.querySelector<HTMLElement>(`[data-topic-message="${CSS.escape(id)}"]`)
      if (!scroll || !message) throw new Error(`cannot scroll to ${id}`)
      const delta = message.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset
      scroll.scrollTop += delta
      scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
    },
    { messageId, offset: offsetPx },
  )
  await page.waitForTimeout(50)
}

async function setBottomDistance(page: Page, distancePx: number): Promise<void> {
  await page.evaluate((distance) => {
    const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (!scroll) throw new Error('missing topic scroll')
    scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - distance
    scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, distancePx)
  await page.waitForTimeout(30)
}

async function assertAtBottom(page: Page, label: string, tolerancePx = 8): Promise<void> {
  const distance = await call(page, (h: H) => h.getMessagesBottomDistance())
  assert(distance !== null && distance <= tolerancePx, `${label}: bottom distance ${distance}, expected <= ${tolerancePx}`)
}

async function assertThreadAtBottom(page: Page, label: string, tolerancePx = 8): Promise<void> {
  const distance = await call(page, (h: H) => h.getThreadBottomDistance())
  assert(distance !== null && distance <= tolerancePx, `${label}: thread bottom distance ${distance}, expected <= ${tolerancePx}`)
}

async function assertAtTop(page: Page, label: string, tolerancePx = 8): Promise<void> {
  const scrollTop = await call(page, (h: H) => h.getMessagesScrollTop())
  assert(scrollTop !== null && scrollTop <= tolerancePx, `${label}: scrollTop ${scrollTop}, expected <= ${tolerancePx}`)
}

async function assertNotAtBottom(page: Page, label: string): Promise<void> {
  const distance = await call(page, (h: H) => h.getMessagesBottomDistance())
  assert(distance !== null && distance > 120, `${label}: unexpectedly near bottom (${distance}px)`)
}

async function assertAnchorPreserved(page: Page, anchorId: string, label: string, action: () => Promise<void>, tolerancePx = 4): Promise<void> {
  const before = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
  await action()
  await page.waitForTimeout(100)
  const after = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
  assertClose(after, before, label, tolerancePx)
  await assertNotAtBottom(page, label)
}

const viewports: Array<{ label: string; viewport: ViewportSize }> = [
  { label: 'mobile-390', viewport: { width: 390, height: 844 } },
  { label: 'mobile-360', viewport: { width: 360, height: 800 } },
  { label: 'desktop', viewport: { width: 1366, height: 900 } },
]

console.log('\ncheckTopicsScrollRetentionClient\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`

  browser = await chromium.launch()

  for (const { label: viewportLabel, viewport } of viewports) {
    async function withHarness(fn: (page: Page) => Promise<void>): Promise<void> {
      const context = await browser!.newContext({ viewport })
      const page = await context.newPage()
      const pageErrors: string[] = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await page.goto(baseUrl)
      await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })
      try {
        await fn(page)
        assert(pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`)
      } finally {
        await context.close()
      }
    }

    await check(`[${viewportLabel}] initial topic load scrolls to top`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-initial`)
        await openTopic(page, messages)
        await assertAtTop(page, 'initial topic load')
      })
    })

    await check(`[${viewportLabel}] simplified top navigation omits horizontal topic strip`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 36, `${viewportLabel}-top-nav`)
        await openTopic(page, messages)
        const nav = await page.evaluate(() => {
          const row = document.querySelector<HTMLElement>('[data-topics-header-row="1"]')
          const general = document.querySelector<HTMLButtonElement>('[data-topics-back-to-general="1"]')
          const personal = document.querySelector<HTMLButtonElement>('[data-topics-personal-open="1"]')
          const stream = document.querySelector<HTMLElement>('[data-topics-stream-container="1"]')
          const body = document.scrollingElement ?? document.documentElement
          const rowRect = row?.getBoundingClientRect() ?? null
          const streamRect = stream?.getBoundingClientRect() ?? null
          return {
            hasBarRow: document.querySelector('[data-topics-bar-row="1"]') !== null,
            hasBarScroll: document.querySelector('[data-topics-bar-scroll="1"]') !== null,
            hasTopicChip: document.querySelector('[data-topic-chip]') !== null,
            hasCreate: document.querySelector('[data-topics-create="1"]') !== null,
            hasArrow: document.querySelector('[data-topics-arrow]') !== null,
            generalText: general?.textContent?.trim() ?? null,
            generalPressed: general?.getAttribute('aria-pressed') ?? null,
            personalText: personal?.textContent?.trim() ?? null,
            bodyScrollWidth: body.scrollWidth,
            viewportWidth: window.innerWidth,
            rowBottom: rowRect?.bottom ?? null,
            streamTop: streamRect?.top ?? null,
          }
        })
        assert(!nav.hasBarRow, `${viewportLabel}: legacy topics bar row should not render`)
        assert(!nav.hasBarScroll, `${viewportLabel}: legacy horizontal scroll container should not render`)
        assert(!nav.hasTopicChip, `${viewportLabel}: legacy topic chips should not render`)
        assert(!nav.hasCreate, `${viewportLabel}: legacy create topic control should not render`)
        assert(!nav.hasArrow, `${viewportLabel}: legacy desktop arrow controls should not render`)
        assert(nav.generalText !== null && nav.generalText.includes('Общ'), `${viewportLabel}: missing visible Общ action`)
        assert(nav.generalPressed === 'true', `${viewportLabel}: Общ action should be active in general stream`)
        assert(nav.personalText !== null && nav.personalText.includes('Лични'), `${viewportLabel}: missing visible Лични action`)
        assert(nav.bodyScrollWidth <= nav.viewportWidth + 1, `${viewportLabel}: body has horizontal overflow (${nav.bodyScrollWidth} > ${nav.viewportWidth})`)
        assert(nav.rowBottom !== null && nav.streamTop !== null && nav.streamTop >= nav.rowBottom, `${viewportLabel}: stream overlaps top navigation`)
      })
    })

    await check(`[${viewportLabel}] near-top realtime root stays pinned`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-near-bottom`)
        await openTopic(page, messages)
        await call(page, (h: H) => h.setMessagesScrollTop(24))
        await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), makeTopicMessage('topic-general', 1000, `${viewportLabel}-near-bottom-live`))
        await page.waitForTimeout(100)
        await assertAtTop(page, 'near-top realtime root', 96)
      })
    })

    await check(`[${viewportLabel}] middle realtime root preserves viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 50, `${viewportLabel}-root`)
        await openTopic(page, messages)
        const anchorId = messages[24]!.messageId
        await scrollMessageNearTop(page, anchorId)
        await assertAnchorPreserved(page, anchorId, 'middle realtime root', async () => {
          await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), makeTopicMessage('topic-general', 2000, `${viewportLabel}-foreign-root`))
        })
      })
    })

    await check(`[${viewportLabel}] middle incoming reply in another thread preserves General viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 52, `${viewportLabel}-reply`)
        await openTopic(page, messages)
        const rootId = messages[8]!.messageId
        const anchorId = messages[28]!.messageId
        await scrollMessageNearTop(page, anchorId)
        await assertAnchorPreserved(page, anchorId, 'middle incoming reply in General', async () => {
          await call(
            page,
            (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg),
            {
              type: 'topic_reply',
              seq: 999,
              messageId: `${viewportLabel}-incoming-reply`,
              topicId: 'topic-general',
              parentMessageId: rootId,
              senderProfileId: 'reply-live-author',
              senderDisplayName: 'Reply Live',
              senderAvatarUrl: null,
              senderRole: 'player',
              body: `live reply ${'body '.repeat(8)}`,
              createdAt: new Date().toISOString(),
              editedAt: null,
              likeCount: 0,
              viewerHasLiked: false,
              attachment: null,
            },
          )
        })
      })
    })

    await check(`[${viewportLabel}] like/edit/delete rerenders preserve viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 54, `${viewportLabel}-updates`, true)
        await openTopic(page, messages)
        const anchorId = messages[30]!.messageId
        await scrollMessageNearTop(page, anchorId)
        await assertAnchorPreserved(page, anchorId, 'like update', async () => {
          await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), {
            type: 'topic_message_like_changed',
            messageId: messages[7]!.messageId,
            likeCount: 11,
          })
        })
        await assertAnchorPreserved(page, anchorId, 'edit update', async () => {
          await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), {
            type: 'topic_message_edited',
            topicId: 'topic-general',
            messageId: messages[8]!.messageId,
            parentMessageId: null,
            body: `edited above anchor ${'body '.repeat(20)}`,
            editedAt: new Date().toISOString(),
          })
        })
        await assertAnchorPreserved(page, anchorId, 'delete update', async () => {
          await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), {
            type: 'topic_message_deleted',
            topicId: 'topic-general',
            messageId: messages[9]!.messageId,
            parentMessageId: null,
          })
        }, 6)
      })
    })

    await check(`[${viewportLabel}] thread open/back restores clicked root anchor`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 52, `${viewportLabel}-toggle`)
        await openTopic(page, messages)
        const rootId = messages[28]!.messageId
        const replies = await makeReplies(page, 'topic-general', rootId, 1, 4, `${viewportLabel}-toggle`)
        await call(page, (h: H, arg: unknown[]) => h.setNextRepliesResult(arg, false), replies)
        await scrollMessageNearTop(page, rootId)
        const before = await call(page, (h: H, id: string) => h.getMessageTop(id), rootId)
        await call(page, (h: H, id: string) => h.clickReplyButton(id), rootId)
        await page.waitForFunction((id) => document.querySelector(`[data-topic-replies-section="${CSS.escape(id as string)}"]`) !== null, rootId)
        await page.click('[data-topic-thread-back="1"]')
        await page.waitForFunction(() => document.querySelector('[data-topic-messages-scroll="1"]') !== null)
        const after = await call(page, (h: H, id: string) => h.getMessageTop(id), rootId)
        assertClose(after, before, 'thread open/back root anchor', 8)
      })
    })

    await check(`[${viewportLabel}] thread initial open and realtime reply scroll lifecycle`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 52, `${viewportLabel}-thread-scroll`)
        await openTopic(page, messages)
        const rootId = messages[18]!.messageId
        const replies = await makeReplies(page, 'topic-general', rootId, 1, 36, `${viewportLabel}-thread-scroll`)
        await call(page, (h: H, arg: unknown[]) => h.setNextRepliesResult(arg, false), replies)
        await call(page, (h: H, id: string) => h.clickReplyButton(id), rootId)
        await page.waitForFunction((id) => document.querySelector(`[data-topic-replies-section="${CSS.escape(id as string)}"]`) !== null, rootId)
        await page.waitForFunction(() => {
          const el = document.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
          return el !== null && el.scrollHeight > el.clientHeight + 120 && el.scrollHeight - el.scrollTop - el.clientHeight <= 8
        }, undefined, { timeout: 5000 })
        await assertThreadAtBottom(page, 'initial thread open with many replies')

        await call(page, (h: H) => h.setThreadScrollTop(40))
        await page.waitForTimeout(30)
        const scrolledUpBefore = await call(page, (h: H) => h.getThreadScrollTop())
        await call(
          page,
          (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg),
          {
            type: 'topic_reply',
            seq: 2000,
            messageId: `${viewportLabel}-thread-live-scrolled-up`,
            topicId: 'topic-general',
            parentMessageId: rootId,
            senderProfileId: 'thread-live-author',
            senderDisplayName: 'Thread Live',
            senderAvatarUrl: null,
            senderRole: 'player',
            body: `scrolled up live reply ${'body '.repeat(8)}`,
            createdAt: new Date().toISOString(),
            editedAt: null,
            likeCount: 0,
            viewerHasLiked: false,
            attachment: null,
          },
        )
        await page.waitForTimeout(100)
        const scrolledUpAfter = await call(page, (h: H) => h.getThreadScrollTop())
        assertClose(scrolledUpAfter, scrolledUpBefore, 'scrolled-up current-thread realtime reply', 4)

        await page.evaluate(() => {
          const el = document.querySelector<HTMLElement>('[data-topic-thread-scroll="1"]')
          if (!el) throw new Error('missing thread scroll')
          el.scrollTop = el.scrollHeight - el.clientHeight - 24
          el.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        await page.waitForTimeout(30)
        await call(
          page,
          (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg),
          {
            type: 'topic_reply',
            seq: 2001,
            messageId: `${viewportLabel}-thread-live-near-bottom`,
            topicId: 'topic-general',
            parentMessageId: rootId,
            senderProfileId: 'thread-live-author',
            senderDisplayName: 'Thread Live',
            senderAvatarUrl: null,
            senderRole: 'player',
            body: `near bottom live reply ${'body '.repeat(8)}`,
            createdAt: new Date().toISOString(),
            editedAt: null,
            likeCount: 0,
            viewerHasLiked: false,
            attachment: null,
          },
        )
        await page.waitForTimeout(100)
        await assertThreadAtBottom(page, 'near-bottom current-thread realtime reply')

        await call(page, (h: H) => h.setThreadScrollTop(40))
        await page.waitForTimeout(30)
        await call(page, (h: H, arg: [string, string]) => h.setReplyComposerValue(arg[0], arg[1]), [rootId, 'own reply from thread'])
        await call(page, (h: H, id: string) => h.submitReplyComposer(id), rootId)
        await page.waitForTimeout(50)
        const replySendLog = await call(page, (h: H) => h.getReplySendLog())
        const requestId = replySendLog[replySendLog.length - 1]!.requestId
        await call(
          page,
          (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg),
          {
            type: 'topic_reply',
            requestId,
            seq: 2002,
            messageId: `${viewportLabel}-thread-own-reply`,
            topicId: 'topic-general',
            parentMessageId: rootId,
            senderProfileId: 'me',
            senderDisplayName: 'Me',
            senderAvatarUrl: null,
            senderRole: 'player',
            body: 'own reply from thread',
            createdAt: new Date().toISOString(),
            editedAt: null,
            likeCount: 0,
            viewerHasLiked: false,
            attachment: null,
          },
        )
        await page.waitForTimeout(100)
        await assertThreadAtBottom(page, 'own successful thread reply')

        await call(page, (h: H) => h.clickThreadBack())
        await page.waitForFunction(() => document.querySelector('[data-topic-messages-scroll="1"]') !== null)
        const rootVisibleAfterBack = await page.evaluate((id) => {
          const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
          const root = document.querySelector<HTMLElement>(`[data-topic-message="${CSS.escape(id as string)}"]`)
          if (!scroll || !root) return false
          const scrollRect = scroll.getBoundingClientRect()
          const rootRect = root.getBoundingClientRect()
          return rootRect.bottom > scrollRect.top && rootRect.top < scrollRect.bottom
        }, rootId)
        assert(rootVisibleAfterBack, 'thread lifecycle Back -> General трябва да остави правилния root видим след activity bump')
      })
    })

    await check(`[${viewportLabel}] load older from bottom preserves viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 31, 30, `${viewportLabel}-recent`)
        await openTopic(page, messages, true)
        const anchorId = messages[messages.length - 1]!.messageId
        const older = await makeMessages(page, 'topic-general', 1, 30, `${viewportLabel}-older`)
        await call(page, (h: H, arg: unknown[]) => h.setNextMessagesResult(arg, false), older)
        const before = await page.evaluate((id) => {
          const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
          const anchor = document.querySelector<HTMLElement>(`[data-topic-message="${CSS.escape(id as string)}"]`)
          if (!scroll || !anchor) throw new Error('missing load older scroll precondition elements')
          scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight - 20
          const scrollTop = scroll.scrollTop
          const bottomDistance = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
          if (bottomDistance > 40) throw new Error(`load older precondition failed: bottomDistance=${bottomDistance}, scrollTop=${scrollTop}`)
          const anchorTop = anchor.getBoundingClientRect().top
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
          return anchorTop
        }, anchorId)
        await page.waitForFunction(() => document.querySelectorAll('[data-topic-message]').length >= 60, undefined, { timeout: 5000 })
        const after = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
        assertClose(after, before, 'load older from bottom', 6)
      })
    })

    await check(`[${viewportLabel}] own successful root message scrolls to top`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-own`)
        await openTopic(page, messages)
        await scrollMessageNearTop(page, messages[24]!.messageId)
        await call(page, (h: H, value: string) => h.setComposerValue(value), `${viewportLabel} own send`)
        await call(page, (h: H) => h.submitComposerForm())
        await page.waitForTimeout(50)
        const log = await call(page, (h: H) => h.getSendLog())
        const requestId = log[log.length - 1]!.requestId
        await call(
          page,
          (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg),
          { ...makeTopicMessage('topic-general', 3000, `${viewportLabel}-own-ack`), requestId, senderProfileId: 'me', senderDisplayName: 'Me' },
        )
        await page.waitForTimeout(100)
        await assertAtTop(page, 'own successful root message')
      })
    })

    await check(`[${viewportLabel}] active General top action preserves current stream viewport`, async () => {
      await withHarness(async (page) => {
        const general = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-switch-a`)
        await openTopic(page, general)
        const anchorId = general[20]!.messageId
        await scrollMessageNearTop(page, anchorId)
        await assertAnchorPreserved(page, anchorId, 'active General top action', async () => {
          await page.click('[data-topics-back-to-general="1"]')
        })
      })
    })
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

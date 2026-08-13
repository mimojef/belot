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
  clickTopicChip: (topicId: string) => void
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => void
  setNextMessagesResult: (messages: unknown[], hasMore?: boolean) => void
  setNextRepliesResult: (replies: unknown[], hasMore?: boolean) => void
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  makeReply: (topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  simulateServerMessage: (message: Record<string, unknown>) => boolean
  clickReplyButton: (rootMessageId: string) => void
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
    createdAt: new Date().toISOString(),
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

    await check(`[${viewportLabel}] initial topic load scrolls to bottom`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-initial`)
        await openTopic(page, messages)
        await assertAtBottom(page, 'initial topic load')
      })
    })

    await check(`[${viewportLabel}] near-bottom realtime root stays pinned`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-near-bottom`)
        await openTopic(page, messages)
        await setBottomDistance(page, 24)
        await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), makeTopicMessage('topic-general', 1000, `${viewportLabel}-near-bottom-live`))
        await page.waitForTimeout(100)
        await assertAtBottom(page, 'near-bottom realtime root', 96)
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

    await check(`[${viewportLabel}] middle incoming reply preserves viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 52, `${viewportLabel}-reply`)
        await openTopic(page, messages)
        const rootId = messages[8]!.messageId
        const anchorId = messages[28]!.messageId
        const replies = await makeReplies(page, 'topic-general', rootId, 1, 2, `${viewportLabel}-reply-initial`)
        await call(page, (h: H, arg: unknown[]) => h.setNextRepliesResult(arg, false), replies)
        await call(page, (h: H, id: string) => h.clickReplyButton(id), rootId)
        await page.waitForFunction((id) => document.querySelector(`[data-topic-replies-section="${CSS.escape(id as string)}"]`) !== null, rootId)
        await scrollMessageNearTop(page, anchorId)
        await assertAnchorPreserved(page, anchorId, 'middle incoming reply', async () => {
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

    await check(`[${viewportLabel}] reply expand/collapse keeps clicked root anchored`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 1, 52, `${viewportLabel}-toggle`)
        await openTopic(page, messages)
        const rootId = messages[28]!.messageId
        const replies = await makeReplies(page, 'topic-general', rootId, 1, 4, `${viewportLabel}-toggle`)
        await call(page, (h: H, arg: unknown[]) => h.setNextRepliesResult(arg, false), replies)
        await scrollMessageNearTop(page, rootId)

        await assertAnchorPreserved(page, rootId, 'reply expand', async () => {
          await call(page, (h: H, id: string) => h.clickReplyButton(id), rootId)
          await page.waitForFunction((id) => document.querySelector(`[data-topic-replies-section="${CSS.escape(id as string)}"]`) !== null, rootId)
        })

        await assertAnchorPreserved(page, rootId, 'reply collapse', async () => {
          await call(page, (h: H, id: string) => h.clickReplyButton(id), rootId)
          await page.waitForFunction((id) => document.querySelector(`[data-topic-replies-section="${CSS.escape(id as string)}"]`) === null, rootId)
        })
      })
    })

    await check(`[${viewportLabel}] load older prepend preserves viewport`, async () => {
      await withHarness(async (page) => {
        const messages = await makeMessages(page, 'topic-general', 31, 30, `${viewportLabel}-recent`)
        await openTopic(page, messages, true)
        const anchorId = messages[0]!.messageId
        const older = await makeMessages(page, 'topic-general', 1, 30, `${viewportLabel}-older`)
        await call(page, (h: H, arg: unknown[]) => h.setNextMessagesResult(arg, false), older)
        const before = await page.evaluate((id) => {
          const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
          const anchor = document.querySelector<HTMLElement>(`[data-topic-message="${CSS.escape(id as string)}"]`)
          if (!scroll || !anchor) throw new Error('missing load older scroll precondition elements')
          scroll.scrollTop = 20
          const scrollTop = scroll.scrollTop
          if (scrollTop > 40) throw new Error(`load older precondition failed: scrollTop=${scrollTop}`)
          const anchorTop = anchor.getBoundingClientRect().top
          scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
          return anchorTop
        }, anchorId)
        await page.waitForFunction(() => document.querySelectorAll('[data-topic-message]').length >= 60, undefined, { timeout: 5000 })
        const after = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
        assertClose(after, before, 'load older prepend', 6)
      })
    })

    await check(`[${viewportLabel}] own successful root message scrolls to bottom`, async () => {
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
        await assertAtBottom(page, 'own successful root message')
      })
    })

    await check(`[${viewportLabel}] topic switch initial load scrolls selected topic to bottom`, async () => {
      await withHarness(async (page) => {
        const general = await makeMessages(page, 'topic-general', 1, 46, `${viewportLabel}-switch-a`)
        await openTopic(page, general)
        await scrollMessageNearTop(page, general[20]!.messageId)
        const topicB = await makeMessages(page, 'topic-b', 1, 46, `${viewportLabel}-switch-b`)
        await call(page, (h: H, arg: unknown[]) => h.setNextMessagesResult(arg, false), topicB)
        await call(page, (h: H, topicId: string) => h.clickTopicChip(topicId), 'topic-b')
        await page.waitForFunction((id) => document.querySelector(`[data-topic-message="${CSS.escape(id as string)}"]`) !== null, topicB[topicB.length - 1]!.messageId)
        await assertAtBottom(page, 'topic switch initial load')
      })
    })
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

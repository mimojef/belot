/**
 * Browser regression for the new Topics activity feed ordering:
 * root cards are threads ordered by max(root.createdAt, newest live reply).
 */
import { createServer as createNetServer } from 'node:net'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}. actual=${String(actual)} expected=${String(expected)}`)
}

function assertArrayPrefix(actual: readonly string[], expected: readonly string[], message: string): void {
  const actualPrefix = actual.slice(0, expected.length)
  assert(
    actualPrefix.join('|') === expected.join('|'),
    `${message}. actual=${actual.join(',')} expectedPrefix=${expected.join(',')}`,
  )
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
  makeMessage: (topicId: string, seq: number, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  makeReply: (topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId?: string, senderDisplayName?: string) => any
  simulateServerMessage: (message: Record<string, unknown>) => boolean
  getMessageTop: (messageId: string) => number | null
  getMessagesScrollTop: () => number | null
  setMessagesScrollTop: (value: number) => void
  setComposerValue: (value: string) => void
  submitComposerForm: () => void
  getSendLog: () => Array<{ topicId: string; body: string; requestId: string }>
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

async function makeRoot(page: Page, input: {
  seq: number
  id: string
  body: string
  createdAt: string
  lastActivityAt?: string
}): Promise<any> {
  return call(page, (h: H, arg: any) => {
    const msg = h.makeMessage('topic-general', arg.seq, arg.body, `author-${arg.id}`, `Author ${arg.id}`)
    msg.messageId = arg.id
    msg.createdAt = arg.createdAt
    msg.lastActivityAt = arg.lastActivityAt ?? arg.createdAt
    msg.unreadCount = 0
    msg.attachment = null
    return msg
  }, input)
}

async function makeReplyMessage(page: Page, input: {
  seq: number
  id: string
  parentMessageId: string
  body: string
  createdAt: string
}): Promise<any> {
  return call(page, (h: H, arg: any) => {
    const reply = h.makeReply('topic-general', arg.seq, arg.parentMessageId, arg.body, `reply-author-${arg.id}`, `Reply ${arg.id}`)
    reply.messageId = arg.id
    reply.createdAt = arg.createdAt
    reply.attachment = null
    return reply
  }, input)
}

async function openWithMessages(page: Page, messages: any[], hasMore = false): Promise<void> {
  await call(page, (h: H) => h.setVipGate(true, true))
  await call(page, (h: H, arg: { messages: unknown[]; hasMore: boolean }) => h.setNextMessagesResult(arg.messages, arg.hasMore), { messages, hasMore })
  await call(page, (h: H) => h.openTopicsScreen())
  await page.waitForFunction(
    (count) => document.querySelectorAll('[data-topic-message]').length === count,
    messages.length,
    { timeout: 5000 },
  )
}

async function getOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-topic-message]')).map((el) => el.dataset.topicMessage ?? ''))
}

async function getActivityText(page: Page, messageId: string): Promise<string> {
  return page.evaluate((id) => {
    return document.querySelector<HTMLElement>(`[data-topic-message-last-activity="${CSS.escape(id as string)}"]`)?.textContent?.trim() ?? ''
  }, messageId)
}

async function assertAnchorPreserved(page: Page, anchorId: string, label: string, action: () => Promise<void>): Promise<void> {
  const before = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
  await action()
  await page.waitForTimeout(120)
  const after = await call(page, (h: H, id: string) => h.getMessageTop(id), anchorId)
  assert(before !== null && after !== null, `${label}: missing anchor`)
  const delta = Math.abs(after - before)
  assert(delta <= 6, `${label}: anchor moved by ${delta.toFixed(2)}px`)
}

function iso(value: string): string {
  return new Date(value).toISOString()
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

  async function withPage(fn: (page: Page) => Promise<void>): Promise<void> {
    const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined)
    try {
      await fn(page)
    } finally {
      await page.close()
    }
  }

  await check('[1] roots order by lastActivityAt DESC', async () => {
    await withPage(async (page) => {
      const a = await makeRoot(page, { seq: 10, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z') })
      const b = await makeRoot(page, { seq: 11, id: 'root-b', body: 'B', createdAt: iso('2026-08-13T10:02:00Z') })
      await openWithMessages(page, [a, b])
      assertArrayPrefix(await getOrder(page), ['root-b', 'root-a'], 'newer root should be first')
    })
  })

  await check('[2] old root with fresh reply beats newer root without replies', async () => {
    await withPage(async (page) => {
      const a = await makeRoot(page, { seq: 20, id: 'root-a', body: 'A fresh root', createdAt: iso('2026-08-13T10:00:00Z') })
      const b = await makeRoot(page, { seq: 21, id: 'root-b', body: 'B old active root', createdAt: iso('2026-08-10T10:00:00Z'), lastActivityAt: iso('2026-08-13T10:01:50Z') })
      await openWithMessages(page, [a, b])
      assertArrayPrefix(await getOrder(page), ['root-b', 'root-a'], 'reply activity should order old root above fresh root')
    })
  })

  await check('[3] like and edit do not reorder roots', async () => {
    await withPage(async (page) => {
      const a = await makeRoot(page, { seq: 30, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z') })
      const b = await makeRoot(page, { seq: 31, id: 'root-b', body: 'B', createdAt: iso('2026-08-13T10:05:00Z') })
      await openWithMessages(page, [a, b])
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { type: 'topic_message_like_changed', messageId: 'root-a', likeCount: 50 })
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { type: 'topic_message_edited', topicId: 'topic-general', messageId: 'root-a', parentMessageId: null, body: 'A edited', editedAt: iso('2026-08-13T11:00:00Z') })
      await page.waitForTimeout(80)
      assertArrayPrefix(await getOrder(page), ['root-b', 'root-a'], 'like/edit must not change activity order')
    })
  })

  await check('[4] realtime reply bumps loaded root', async () => {
    await withPage(async (page) => {
      const a = await makeRoot(page, { seq: 40, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z') })
      const b = await makeRoot(page, { seq: 41, id: 'root-b', body: 'B', createdAt: iso('2026-08-13T10:05:00Z') })
      await openWithMessages(page, [a, b])
      const reply = await makeReplyMessage(page, { seq: 900, id: 'reply-a-new', parentMessageId: 'root-a', body: 'new reply', createdAt: iso('2026-08-13T10:06:00Z') })
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { ...reply, type: 'topic_reply' })
      await page.waitForTimeout(80)
      assertArrayPrefix(await getOrder(page), ['root-a', 'root-b'], 'live reply should bump loaded root')
    })
  })

  await check('[5] deleting latest reply falls back to canonical refreshed activity', async () => {
    await withPage(async (page) => {
      const aHot = await makeRoot(page, { seq: 50, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z'), lastActivityAt: iso('2026-08-13T10:10:00Z') })
      const b = await makeRoot(page, { seq: 51, id: 'root-b', body: 'B', createdAt: iso('2026-08-13T10:05:00Z') })
      await openWithMessages(page, [aHot, b])
      const aFallback = await makeRoot(page, { seq: 50, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z') })
      await call(page, (h: H, messages: unknown[]) => h.setNextMessagesResult(messages, false), [b, aFallback])
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { type: 'topic_message_deleted', topicId: 'topic-general', messageId: 'reply-a-latest', parentMessageId: 'root-a' })
      await page.waitForFunction(() => {
        const ids = Array.from(document.querySelectorAll<HTMLElement>('[data-topic-message]')).map((el) => el.dataset.topicMessage ?? '')
        return ids[0] === 'root-b' && ids[1] === 'root-a'
      }, undefined, { timeout: 5000 })
    })
  })

  await check('[6] old root outside current page appears after fresh reply refresh', async () => {
    await withPage(async (page) => {
      const a = await makeRoot(page, { seq: 60, id: 'root-a', body: 'A', createdAt: iso('2026-08-13T10:00:00Z') })
      const b = await makeRoot(page, { seq: 61, id: 'root-b', body: 'B', createdAt: iso('2026-08-13T10:05:00Z') })
      const oldActive = await makeRoot(page, { seq: 1, id: 'root-old', body: 'Old active', createdAt: iso('2026-08-01T10:00:00Z'), lastActivityAt: iso('2026-08-13T10:06:00Z') })
      await openWithMessages(page, [a, b], true)
      await call(page, (h: H, messages: unknown[]) => h.setNextMessagesResult(messages, true), [oldActive, b, a])
      const reply = await makeReplyMessage(page, { seq: 901, id: 'reply-old-new', parentMessageId: 'root-old', body: 'fresh old reply', createdAt: iso('2026-08-13T10:06:00Z') })
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { ...reply, type: 'topic_reply' })
      await page.waitForFunction(() => document.querySelector('[data-topic-message="root-old"]') !== null, undefined, { timeout: 5000 })
      assertArrayPrefix(await getOrder(page), ['root-old', 'root-b', 'root-a'], 'old active root should enter current page')
    })
  })

  await check('[7] activity label formats relative and compact date values', async () => {
    await withPage(async (page) => {
      const now = Date.now()
      const recent = await makeRoot(page, { seq: 70, id: 'root-now', body: 'Now', createdAt: new Date(now).toISOString(), lastActivityAt: new Date(now - 30_000).toISOString() })
      const minutes = await makeRoot(page, { seq: 71, id: 'root-min', body: 'Minutes', createdAt: new Date(now - 5 * 60_000).toISOString() })
      const hours = await makeRoot(page, { seq: 72, id: 'root-hour', body: 'Hours', createdAt: new Date(now - 2 * 60 * 60_000).toISOString() })
      const days = await makeRoot(page, { seq: 73, id: 'root-day', body: 'Days', createdAt: new Date(now - 3 * 24 * 60 * 60_000).toISOString() })
      const old = await makeRoot(page, { seq: 74, id: 'root-old-date', body: 'Old date', createdAt: iso('2026-08-06T10:00:00Z') })
      await openWithMessages(page, [recent, minutes, hours, days, old])
      assert((await getActivityText(page, 'root-now')).includes('Сега'), 'expected Сега label')
      assert((await getActivityText(page, 'root-min')).includes('Преди 5 м.'), 'expected minutes label')
      assert((await getActivityText(page, 'root-hour')).includes('Преди 2 ч.'), 'expected hours label')
      assert((await getActivityText(page, 'root-day')).includes('Преди 3 д.'), 'expected days label')
      assert((await getActivityText(page, 'root-old-date')).includes('06.08.'), 'expected compact date label')
      assert(!(await getActivityText(page, 'root-min')).includes('Активност:'), 'activity presentation must not include the Активност: prefix')
    })
  })

  await check('[8] realtime reorder preserves stable root anchor while reading lower', async () => {
    await withPage(async (page) => {
      const roots = []
      for (let i = 0; i < 42; i++) {
        roots.push(await makeRoot(page, {
          seq: 100 + i,
          id: `root-${i}`,
          body: `Root ${i} ${'body '.repeat(10)}`,
          createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        }))
      }
      await openWithMessages(page, roots)
      await call(page, (h: H, id: string) => {
        const scroll = document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
        const anchor = document.querySelector<HTMLElement>(`[data-topic-message="${CSS.escape(id)}"]`)
        if (!scroll || !anchor) throw new Error('missing scroll/anchor')
        scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24
        scroll.dispatchEvent(new Event('scroll', { bubbles: true }))
      }, 'root-24')
      await assertAnchorPreserved(page, 'root-24', 'reply reorder anchor', async () => {
        const reply = await makeReplyMessage(page, { seq: 999, id: 'reply-root-30', parentMessageId: 'root-30', body: 'bump root 30', createdAt: new Date(Date.now() + 60_000).toISOString() })
        await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { ...reply, type: 'topic_reply' })
      })
    })
  })

  await check('[9] root send ack scrolls to top of activity feed', async () => {
    await withPage(async (page) => {
      const roots = []
      for (let i = 0; i < 32; i++) {
        roots.push(await makeRoot(page, {
          seq: 200 + i,
          id: `send-root-${i}`,
          body: `Root ${i} ${'body '.repeat(10)}`,
          createdAt: new Date(Date.now() - i * 60_000).toISOString(),
        }))
      }
      await openWithMessages(page, roots)
      await call(page, (h: H) => h.setMessagesScrollTop(500))
      await call(page, (h: H) => h.setComposerValue('new own root'))
      await call(page, (h: H) => h.submitComposerForm())
      await page.waitForTimeout(30)
      const log = await call(page, (h: H) => h.getSendLog())
      const requestId = log[log.length - 1]?.requestId ?? ''
      const own = await makeRoot(page, { seq: 999, id: 'own-root', body: 'new own root', createdAt: new Date(Date.now() + 120_000).toISOString() })
      await call(page, (h: H, msg: Record<string, unknown>) => h.simulateServerMessage(msg), { ...own, type: 'topic_message', requestId })
      await page.waitForTimeout(80)
      assertEqual(await call(page, (h: H) => h.getMessagesScrollTop()), 0, 'own root ack should show top')
    })
  })
} finally {
  if (browser) await browser.close()
  await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)

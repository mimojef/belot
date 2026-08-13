import { createServer as createNetServer } from 'node:net'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import {
  formatNotificationBadgeCount,
  getFriendChatUnreadRaw,
  getFriendsNotificationRaw,
  getMobileMenuNotificationRaw,
  getSupportUnreadRaw,
  getTopicsMessagesUnreadRaw,
  getTopicsPersonalUnreadRaw,
  getTopicsTotalUnreadRaw,
} from '../src/app/lobby/renderLobbyScreen.ts'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function rectsOverlap(a: DomRectSnapshot, b: DomRectSnapshot): boolean {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not allocate a free port.'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

function makeState(options: {
  friendUnread?: number
  vipDmUnread?: number
  pikaSupportUnread?: number
  topicUnreadCounts?: number[]
  supportUnread?: number
  guestUnread?: number
  isAdmin?: boolean
  friendRequests?: number
} = {}): any {
  const now = new Date().toISOString()
  return {
    isAdmin: options.isAdmin ?? false,
    supportUnreadCount: options.supportUnread ?? 0,
    adminGuestContactUnreadCount: options.guestUnread ?? 0,
    chatConversations: [
      { friendshipId: 'friend-id', kind: 'friend', unreadCount: options.friendUnread ?? 0 },
      { friendshipId: 'vip-id', kind: 'vip_dm', unreadCount: options.vipDmUnread ?? 0 },
      { friendshipId: 'support-id', kind: 'pika_support', unreadCount: options.pikaSupportUnread ?? 0 },
    ],
    topics: (options.topicUnreadCounts ?? []).map((unreadCount, index) => ({
      topicId: `topic-${index + 1}`,
      unreadCount,
    })),
    pendingFriendRequests: [],
    friendships: {
      incomingPending: Array.from({ length: options.friendRequests ?? 0 }, (_value, index) => ({
        friendshipId: `pending-${index + 1}`,
        status: 'pending',
        direction: 'incoming',
        profile: { profileId: `friend-${index + 1}`, displayName: `Friend ${index + 1}`, avatarUrl: null },
        createdAt: now,
        updatedAt: now,
      })),
      outgoingPending: [],
      friends: [],
    },
  }
}

async function makeConversation(page: Page, friendshipId: string, kind: 'friend' | 'vip_dm', unreadCount: number): Promise<unknown> {
  const conversation = await page.evaluate(
    ([id, conversationKind]) => (window as any).__topicsComposerVipGateHarness.makeConversation(id, conversationKind, `${id}-profile`, id, true),
    [friendshipId, kind] as [string, 'friend' | 'vip_dm'],
  )
  return { ...(conversation as Record<string, unknown>), unreadCount }
}

async function setChatConversations(page: Page, conversations: unknown[]): Promise<void> {
  await page.evaluate((items) => (window as any).__topicsComposerVipGateHarness.setChatConversations(items), conversations)
}

async function setIncomingFriendRequests(page: Page, count: number): Promise<void> {
  await page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.setIncomingFriendRequests(value), count)
}

async function setSupportUnread(page: Page, supportUnreadCount: number, guestUnreadCount = 0): Promise<void> {
  await page.evaluate(
    ([support, guest]) => (window as any).__topicsComposerVipGateHarness.setSupportUnread(support, guest),
    [supportUnreadCount, guestUnreadCount],
  )
  await page.waitForTimeout(40)
}

async function setTopicUnreadCounts(page: Page, counts: Record<string, number>): Promise<void> {
  await page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.setTopicUnreadCounts(value), counts)
}

async function setTopicDirectoryResponse(
  page: Page,
  topics: Array<{ topicId: string; slug?: string; title?: string; isGeneral?: boolean; unreadCount: number }>,
): Promise<void> {
  await page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.setTopicDirectoryResponse(value), topics)
}

async function refreshTopicsDirectoryMetadata(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.refreshTopicsDirectoryMetadata())
}

async function clearTopicsDirectoryMetadata(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.clearTopicsDirectoryMetadata())
}

async function setAuthProfile(page: Page, profileId: string, displayName = profileId): Promise<void> {
  await page.evaluate(([id, name]) => (window as any).__topicsComposerVipGateHarness.setAuthProfile(id, name), [profileId, displayName])
}

async function getTopicsLoadCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getTopicsLoadCallCount())
}

async function getTopicMessagesLoadCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getTopicMessagesLoadCallCount())
}

async function openTopics(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.openTopicsScreen())
  await page.waitForSelector('[data-topics-header-row="1"]', { state: 'attached' })
  await page.waitForTimeout(80)
}

async function openMobileMenu(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__topicsComposerVipGateHarness.openMobileMenu())
  await page.waitForTimeout(20)
}

async function getMobileMenuTotalBadgeText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getMobileMenuTotalBadgeText())
}

async function getMobileMenuItemBadgeText(page: Page, icon: string): Promise<string | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getMobileMenuItemBadgeText(value), icon)
}

async function getMobileMenuItemBadgeColor(page: Page, icon: string): Promise<string | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getMobileMenuItemBadgeColor(value), icon)
}

async function getMobileMenuItemBadgeRect(page: Page, icon: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getMobileMenuItemBadgeRect(value), icon)
}

type DomRectSnapshot = { x: number; y: number; width: number; height: number }

async function getDesktopNavBadgeText(page: Page, item: string): Promise<string | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavBadgeText(value), item)
}

async function getDesktopNavBadgeColor(page: Page, item: string): Promise<string | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavBadgeColor(value), item)
}

async function getDesktopNavBadgeRect(page: Page, item: string): Promise<DomRectSnapshot | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavBadgeRect(value), item)
}

async function getDesktopNavItemRect(page: Page, item: string): Promise<DomRectSnapshot | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavItemRect(value), item)
}

async function getDesktopNavItemIconRect(page: Page, item: string): Promise<DomRectSnapshot | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavItemIconRect(value), item)
}

async function getDesktopNavItemLabelRect(page: Page, item: string): Promise<DomRectSnapshot | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getDesktopNavItemLabelRect(value), item)
}

async function getDesktopNavRect(page: Page): Promise<DomRectSnapshot | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getDesktopNavRect())
}

async function getTopicChipBadgeText(page: Page, topicId: string): Promise<string | null> {
  return page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.getTopicChipBadgeText(value), topicId)
}

async function getTopicsPersonalBadgeText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__topicsComposerVipGateHarness.getTopicsPersonalBadgeText())
}

async function handleServerMessage(page: Page, message: Record<string, unknown>): Promise<void> {
  await page.evaluate((value) => (window as any).__topicsComposerVipGateHarness.handleServerMessage(value), message)
  await page.waitForTimeout(60)
}

console.log('\ncheckUnifiedNotificationBadges\n')

await check('[1] formatter hides zero, shows 1..99 exactly, and renders 100+ as 99+', () => {
  assertEqual(formatNotificationBadgeCount(0), null, '0 hidden')
  assertEqual(formatNotificationBadgeCount(-3), null, 'negative hidden')
  assertEqual(formatNotificationBadgeCount(1), '1', '1 exact')
  assertEqual(formatNotificationBadgeCount(99), '99', '99 exact')
  assertEqual(formatNotificationBadgeCount(100), '99+', '100 cap')
  assertEqual(formatNotificationBadgeCount(101), '99+', '101 cap')
})

await check('[2] CASE 1 raw menu formula: friend 3 + topics 55 + support 1 + friends 2 = 61', () => {
  const state = makeState({ friendUnread: 3, topicUnreadCounts: [20, 30, 5], supportUnread: 1, friendRequests: 2 })
  assertEqual(getFriendChatUnreadRaw(state), 3, 'Chat')
  assertEqual(getTopicsMessagesUnreadRaw(state), 55, 'Topics messages')
  assertEqual(getTopicsPersonalUnreadRaw(state), 0, 'Topics Personal')
  assertEqual(getTopicsTotalUnreadRaw(state), 55, 'Topics total')
  assertEqual(getSupportUnreadRaw(state), 1, 'Support')
  assertEqual(getFriendsNotificationRaw(state), 2, 'Friends')
  assertEqual(getMobileMenuNotificationRaw(state), 61, 'Menu')
})

await check('[3] CASE 2 raw menu formula includes vip_dm in Topics, not Chat', () => {
  const state = makeState({ friendUnread: 3, vipDmUnread: 3, topicUnreadCounts: [52], supportUnread: 1, friendRequests: 2 })
  assertEqual(getFriendChatUnreadRaw(state), 3, 'Chat')
  assertEqual(getTopicsPersonalUnreadRaw(state), 3, 'Topics Personal')
  assertEqual(getTopicsTotalUnreadRaw(state), 55, 'Topics total')
  assertEqual(getMobileMenuNotificationRaw(state), 61, 'Menu')
})

await check('[4] CASE 3 display uses raw total, not preformatted child values', () => {
  const state = makeState({ friendUnread: 70, topicUnreadCounts: [80] })
  assertEqual(getMobileMenuNotificationRaw(state), 150, 'raw menu total')
  assertEqual(formatNotificationBadgeCount(getFriendChatUnreadRaw(state)), '70', 'Chat display')
  assertEqual(formatNotificationBadgeCount(getTopicsTotalUnreadRaw(state)), '80', 'Topics display')
  assertEqual(formatNotificationBadgeCount(getMobileMenuNotificationRaw(state)), '99+', 'Menu display')
})

await check('[5] Topics Personal and topic chip boundary display is shared', () => {
  assertEqual(formatNotificationBadgeCount(getTopicsPersonalUnreadRaw(makeState({ vipDmUnread: 99 }))), '99', 'Personal 99')
  assertEqual(formatNotificationBadgeCount(getTopicsPersonalUnreadRaw(makeState({ vipDmUnread: 100 }))), '99+', 'Personal 100')
  assertEqual(formatNotificationBadgeCount(getTopicsMessagesUnreadRaw(makeState({ topicUnreadCounts: [99] }))), '99', 'Topic chip 99')
  assertEqual(formatNotificationBadgeCount(getTopicsMessagesUnreadRaw(makeState({ topicUnreadCounts: [100] }))), '99+', 'Topic chip 100')
})

await check('[6] CASE 7 reading vip_dm only lowers Topics Personal/Topics/Menu, not Chat', () => {
  const before = makeState({ friendUnread: 3, vipDmUnread: 5, topicUnreadCounts: [4] })
  const after = makeState({ friendUnread: 3, vipDmUnread: 0, topicUnreadCounts: [4] })
  assertEqual(getFriendChatUnreadRaw(before), 3, 'before Chat')
  assertEqual(getTopicsPersonalUnreadRaw(before), 5, 'before Personal')
  assertEqual(getTopicsTotalUnreadRaw(before), 9, 'before Topics')
  assertEqual(getMobileMenuNotificationRaw(before), 12, 'before Menu')
  assertEqual(getFriendChatUnreadRaw(after), 3, 'after Chat')
  assertEqual(getTopicsPersonalUnreadRaw(after), 0, 'after Personal')
  assertEqual(getTopicsTotalUnreadRaw(after), 4, 'after Topics')
  assertEqual(getMobileMenuNotificationRaw(after), 7, 'after Menu')
})

await check('[7] CASE 8 friend/vip isolation is by conversation kind, not counterpart profile', () => {
  const incomingFriend = makeState({ friendUnread: 1, vipDmUnread: 0 })
  const incomingVip = makeState({ friendUnread: 0, vipDmUnread: 1 })
  assertEqual(getFriendChatUnreadRaw(incomingFriend), 1, 'friend affects Chat')
  assertEqual(getTopicsPersonalUnreadRaw(incomingFriend), 0, 'friend does not affect Personal')
  assertEqual(getFriendChatUnreadRaw(incomingVip), 0, 'vip_dm does not affect Chat')
  assertEqual(getTopicsPersonalUnreadRaw(incomingVip), 1, 'vip_dm affects Personal')
})

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
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/topicsComposerVipGateHarness.html`

  browser = await chromium.launch()

  async function withMobilePage(viewport: { width: number; height: number }, fn: (page: Page) => Promise<void>): Promise<void> {
    const context: BrowserContext = await browser!.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })
    try {
      await fn(page)
    } finally {
      await context.close()
    }
  }

  async function withDesktopPage(viewport: { width: number; height: number }, fn: (page: Page) => Promise<void>): Promise<void> {
    const context: BrowserContext = await browser!.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__topicsComposerVipGateHarness !== undefined, undefined, { timeout: 10_000 })
    try {
      await fn(page)
    } finally {
      await context.close()
    }
  }

  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }]) {
    await check(`[8] login regression at ${viewport.width}px: vip_dm unread shows in Menu and Topics before opening Topics`, async () => {
      await withMobilePage(viewport, async (page) => {
        const vip = await makeConversation(page, 'VIP_LOGIN', 'vip_dm', 3)
        await setChatConversations(page, [vip])

        await openMobileMenu(page)
        assertEqual(await getMobileMenuTotalBadgeText(page), '3', 'Menu badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '3', 'Topics dropdown badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), null, 'Chat dropdown badge')

        await openTopics(page)
        assertEqual(await getTopicsPersonalBadgeText(page), '3', 'Topics Personal badge')
      })
    })

    await check(`[9] mobile visual at ${viewport.width}px: red 99+ badges fit menu rows and topic chips`, async () => {
      await withMobilePage(viewport, async (page) => {
        const friend = await makeConversation(page, 'FRIEND_70', 'friend', 70)
        const vip = await makeConversation(page, 'VIP_30', 'vip_dm', 30)
        await setChatConversations(page, [friend, vip])
        await setIncomingFriendRequests(page, 2)
        await setSupportUnread(page, 1)
        await setTopicUnreadCounts(page, { 'topic-general': 80, 'topic-b': 100 })
        await openTopics(page)
        await openMobileMenu(page)

        assertEqual(await getMobileMenuTotalBadgeText(page), '99+', 'Menu total badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), '70', 'Chat row badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '99+', 'Topics row badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'support'), '1', 'Support row badge')
        assertEqual(await getMobileMenuItemBadgeText(page, 'friends'), '2', 'Friends row badge')
        assertEqual(await getTopicChipBadgeText(page, 'topic-b'), '99+', 'inactive topic chip')
        assertEqual(await getTopicsPersonalBadgeText(page), '30', 'Topics Personal badge')

        const topicsBadgeColor = await getMobileMenuItemBadgeColor(page, 'topics')
        assertEqual(topicsBadgeColor, 'rgb(239, 68, 68)', 'Topics row badge red')
        const topicsBadgeRect = await getMobileMenuItemBadgeRect(page, 'topics')
        assert(topicsBadgeRect !== null, 'Topics badge rect missing')
        assert(topicsBadgeRect!.width >= 22, `Topics 99+ badge too narrow: ${JSON.stringify(topicsBadgeRect)}`)
        assert(topicsBadgeRect!.x + topicsBadgeRect!.width <= viewport.width + 1, `Topics 99+ badge overflows viewport: ${JSON.stringify(topicsBadgeRect)}`)
      })
    })
  }

  await check('[10] realtime propagation: friend, vip_dm, and topic updates affect only their categories', async () => {
    await withMobilePage({ width: 390, height: 844 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_RT', 'friend', 0)
      const vip = await makeConversation(page, 'VIP_RT', 'vip_dm', 0)
      await setChatConversations(page, [friend, vip])
      await setTopicUnreadCounts(page, { 'topic-general': 0, 'topic-b': 0 })
      await openTopics(page)

      await handleServerMessage(page, { type: 'chat_message_received', friendshipId: 'FRIEND_RT' })
      await openMobileMenu(page)
      assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), '1', 'friend message increments Chat')
      assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), null, 'friend message does not increment Topics')

      await handleServerMessage(page, { type: 'chat_message_received', friendshipId: 'VIP_RT' })
      await openMobileMenu(page)
      assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), '1', 'vip_dm does not increment Chat')
      assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '1', 'vip_dm increments Topics')
      assertEqual(await getTopicsPersonalBadgeText(page), '1', 'vip_dm increments Personal')

      await handleServerMessage(page, { type: 'topic_unread_count_changed', topicId: 'topic-b', unreadCount: 6 })
      await openMobileMenu(page)
      assertEqual(await getTopicChipBadgeText(page, 'topic-b'), '6', 'topic chip updates')
      assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '7', 'topic message increments Topics aggregate')
      assertEqual(await getMobileMenuTotalBadgeText(page), '8', 'Menu includes Chat + Topics')
    })
  })

  await check('[11] desktop login regression: vip_dm unread shows on Topics before opening Topics', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const vip = await makeConversation(page, 'VIP_DESKTOP_LOGIN', 'vip_dm', 3)
      await setChatConversations(page, [vip])

      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '3', 'desktop Topics badge')
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), null, 'desktop Chat badge')
      assertEqual(await getDesktopNavBadgeColor(page, 'topics'), 'rgb(239, 68, 68)', 'desktop Topics badge red')
    })
  })

  await check('[12] desktop aggregate regression: topic unread 52 + vip_dm 3 renders Topics 55', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const vip = await makeConversation(page, 'VIP_DESKTOP_AGG', 'vip_dm', 3)
      await setChatConversations(page, [vip])
      await setTopicUnreadCounts(page, { 'topic-b': 52 })
      await openTopics(page)

      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '55', 'desktop Topics badge')
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), null, 'desktop Chat badge')
    })
  })

  await check('[13] desktop formatter boundary: raw 99 renders 99 and raw 100 renders 99+', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const vip = await makeConversation(page, 'VIP_DESKTOP_BOUNDARY', 'vip_dm', 3)
      await setChatConversations(page, [vip])
      await setTopicUnreadCounts(page, { 'topic-b': 96 })
      await openTopics(page)

      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '99', 'desktop Topics raw 99')

      await setTopicUnreadCounts(page, { 'topic-b': 97 })
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '99+', 'desktop Topics raw 100')
    })
  })

  await check('[14] desktop realtime isolation: friend updates Chat, vip_dm/topic updates Topics', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_DESKTOP_RT', 'friend', 0)
      const vip = await makeConversation(page, 'VIP_DESKTOP_RT', 'vip_dm', 0)
      await setChatConversations(page, [friend, vip])
      await setTopicUnreadCounts(page, { 'topic-general': 0, 'topic-b': 0 })
      await openTopics(page)

      await handleServerMessage(page, { type: 'chat_message_received', friendshipId: 'FRIEND_DESKTOP_RT' })
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '1', 'friend message increments desktop Chat')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), null, 'friend message does not increment desktop Topics')

      await handleServerMessage(page, { type: 'chat_message_received', friendshipId: 'VIP_DESKTOP_RT' })
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '1', 'vip_dm does not increment desktop Chat')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '1', 'vip_dm increments desktop Topics')

      await handleServerMessage(page, { type: 'topic_unread_count_changed', topicId: 'topic-b', unreadCount: 6 })
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '7', 'topic unread increments desktop Topics aggregate')
    })
  })

  await check('[15] desktop read/seen regression: vip_dm/topic reads lower Topics without changing Chat', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_DESKTOP_READ', 'friend', 3)
      const vip = await makeConversation(page, 'VIP_DESKTOP_READ', 'vip_dm', 5)
      await setChatConversations(page, [friend, vip])
      await setTopicUnreadCounts(page, { 'topic-b': 4 })
      await openTopics(page)

      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '3', 'desktop Chat before read')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '9', 'desktop Topics before read')

      const readVip = await makeConversation(page, 'VIP_DESKTOP_READ', 'vip_dm', 0)
      await setChatConversations(page, [friend, readVip])
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '3', 'desktop Chat after vip_dm read')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '4', 'desktop Topics after vip_dm read')

      await setTopicUnreadCounts(page, { 'topic-b': 0 })
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '3', 'desktop Chat after topic read')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), null, 'desktop Topics hidden after all Topics unread is read')
    })
  })

  for (const viewport of [{ width: 1366, height: 900 }, { width: 1920, height: 1080 }]) {
    await check(`[16] desktop visual at ${viewport.width}px: red 99+ Topics badge fits without moving navbar`, async () => {
      await withDesktopPage(viewport, async (page) => {
        await setChatConversations(page, [])
        await setTopicUnreadCounts(page, { 'topic-general': 0, 'topic-b': 0 })
        await openTopics(page)
        const navBefore = await getDesktopNavRect(page)
        assert(navBefore !== null, 'desktop nav rect missing before badge')
        assert(navBefore!.height === 72, `desktop Topics nav height before badge changed: ${JSON.stringify(navBefore)}`)

        const vip = await makeConversation(page, 'VIP_DESKTOP_VISUAL', 'vip_dm', 3)
        await setChatConversations(page, [vip])
        await setTopicUnreadCounts(page, { 'topic-b': 97 })

        assertEqual(await getDesktopNavBadgeText(page, 'topics'), '99+', 'desktop Topics visual badge')
        assertEqual(await getDesktopNavBadgeColor(page, 'topics'), 'rgb(239, 68, 68)', 'desktop Topics visual badge red')

        const navAfter = await getDesktopNavRect(page)
        const itemRect = await getDesktopNavItemRect(page, 'topics')
        const iconRect = await getDesktopNavItemIconRect(page, 'topics')
        const labelRect = await getDesktopNavItemLabelRect(page, 'topics')
        const badgeRect = await getDesktopNavBadgeRect(page, 'topics')
        assert(navAfter !== null, 'desktop nav rect missing after badge')
        assert(itemRect !== null, 'desktop Topics nav item rect missing')
        assert(iconRect !== null, 'desktop Topics icon rect missing')
        assert(labelRect !== null, 'desktop Topics label rect missing')
        assert(badgeRect !== null, 'desktop Topics badge rect missing')
        assert(navAfter!.height === navBefore!.height, `desktop nav height moved: before ${JSON.stringify(navBefore)} after ${JSON.stringify(navAfter)}`)
        assert(badgeRect!.width >= 24, `desktop Topics 99+ badge too narrow: ${JSON.stringify(badgeRect)}`)
        assert(badgeRect!.height === 18, `desktop Topics badge height changed: ${JSON.stringify(badgeRect)}`)
        assert(badgeRect!.x >= itemRect!.x, `desktop Topics badge starts outside nav item: ${JSON.stringify({ itemRect, badgeRect })}`)
        assert(badgeRect!.x + badgeRect!.width <= itemRect!.x + itemRect!.width + 1, `desktop Topics badge overflows nav item: ${JSON.stringify({ itemRect, badgeRect })}`)
        assert(badgeRect!.y >= navAfter!.y, `desktop Topics badge starts above nav: ${JSON.stringify({ navAfter, badgeRect })}`)
        assert(badgeRect!.y + badgeRect!.height <= navAfter!.y + navAfter!.height, `desktop Topics badge overflows nav height: ${JSON.stringify({ navAfter, badgeRect })}`)
        assert(!rectsOverlap(badgeRect!, iconRect!), `desktop Topics badge overlaps icon: ${JSON.stringify({ iconRect, badgeRect })}`)
        assert(!rectsOverlap(badgeRect!, labelRect!), `desktop Topics badge overlaps text: ${JSON.stringify({ labelRect, badgeRect })}`)
      })
    })
  }

  await check('[17] login lifecycle regression: mobile badges use /api/topics unread before opening Topics', async () => {
    await withMobilePage({ width: 390, height: 844 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_LIFECYCLE', 'friend', 1)
      const vip = await makeConversation(page, 'VIP_LIFECYCLE_ZERO', 'vip_dm', 0)
      await setChatConversations(page, [friend, vip])
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 2 },
        { topicId: 'topic-new', slug: 'topic-new', title: 'Нова тема', unreadCount: 1 },
      ])

      const messageLoadsBefore = await getTopicMessagesLoadCallCount(page)
      const topicLoadsBefore = await getTopicsLoadCallCount(page)
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'initial topics metadata refresh')
      assertEqual(await getTopicsLoadCallCount(page), topicLoadsBefore + 1, 'GET /api/topics metadata call')
      assertEqual(await getTopicMessagesLoadCallCount(page), messageLoadsBefore, 'no message history loaded before opening Topics')

      await openMobileMenu(page)
      assertEqual(await getMobileMenuTotalBadgeText(page), '4', 'Menu badge')
      assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), '1', 'Chat dropdown badge')
      assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '3', 'Topics dropdown badge')

      await openTopics(page)
      assertEqual(await getTopicChipBadgeText(page, 'topic-new'), '1', 'new topic chip after opening Topics')
    })
  })

  await check('[18] login lifecycle regression: desktop badges use /api/topics unread before opening Topics', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_DESKTOP_LIFECYCLE', 'friend', 1)
      await setChatConversations(page, [friend])
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 2 },
        { topicId: 'topic-new', slug: 'topic-new', title: 'Нова тема', unreadCount: 1 },
      ])

      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'initial desktop topics metadata refresh')
      assertEqual(await getTopicMessagesLoadCallCount(page), 0, 'desktop initial metadata does not load message history')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '3', 'desktop Topics badge')
      assertEqual(await getDesktopNavBadgeText(page, 'chat'), '1', 'desktop Chat badge')
    })
  })

  await check('[19] topic_created is directory metadata only; unread increases only after canonical unread update', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      await setChatConversations(page, [])
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 2 },
      ])
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'initial metadata refresh')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '2', 'initial Topics badge')

      await handleServerMessage(page, {
        type: 'topic_created',
        topic: {
          topicId: 'topic-created-zero',
          slug: 'topic-created-zero',
          title: 'Created Zero',
          description: null,
          isGeneral: false,
          createdByProfileId: 'creator',
          status: 'active',
          sortOrder: 1,
          createdAt: new Date().toISOString(),
          unreadCount: 0,
        },
      })
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '2', 'topic_created does not increment unread')

      await handleServerMessage(page, { type: 'topic_unread_count_changed', topicId: 'topic-created-zero', unreadCount: 1 })
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '3', 'canonical unread update increments Topics')
    })
  })

  await check('[20] profile switch regression: topic unread metadata belongs to the current profile', async () => {
    await withDesktopPage({ width: 1366, height: 900 }, async (page) => {
      await setAuthProfile(page, 'profile-a', 'Profile A')
      await clearTopicsDirectoryMetadata(page)
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 0 },
      ])
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'profile A metadata refresh')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), null, 'profile A has no Topics badge')

      await setAuthProfile(page, 'profile-b', 'Profile B')
      await clearTopicsDirectoryMetadata(page)
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 2 },
        { topicId: 'topic-new', slug: 'topic-new', title: 'Нова тема', unreadCount: 1 },
      ])
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'profile B metadata refresh')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), '3', 'profile B Topics badge')

      await setAuthProfile(page, 'profile-a', 'Profile A')
      await clearTopicsDirectoryMetadata(page)
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 0 },
      ])
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'profile A metadata refresh after switch back')
      assertEqual(await getDesktopNavBadgeText(page, 'topics'), null, 'profile B Topics badge is not reused for profile A')
    })
  })

  await check('[21] combined friend/topic/vip_dm regression works before opening Topics', async () => {
    await withMobilePage({ width: 390, height: 844 }, async (page) => {
      const friend = await makeConversation(page, 'FRIEND_COMBINED', 'friend', 1)
      const vip = await makeConversation(page, 'VIP_COMBINED', 'vip_dm', 2)
      await setChatConversations(page, [friend, vip])
      await setTopicDirectoryResponse(page, [
        { topicId: 'topic-general', slug: 'general', title: 'Общ чат', isGeneral: true, unreadCount: 0 },
        { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б', unreadCount: 3 },
      ])
      assertEqual(await refreshTopicsDirectoryMetadata(page), true, 'combined metadata refresh')

      await openMobileMenu(page)
      assertEqual(await getMobileMenuItemBadgeText(page, 'chat'), '1', 'combined Chat badge')
      assertEqual(await getMobileMenuItemBadgeText(page, 'topics'), '5', 'combined Topics badge')
      assertEqual(await getMobileMenuTotalBadgeText(page), '6', 'combined Menu badge')

      await openTopics(page)
      assertEqual(await getTopicsPersonalBadgeText(page), '2', 'combined Topics Personal badge')
    })
  })
} finally {
  await browser?.close()
  await vite?.close()
}

if (failed > 0) {
  console.error(`\nUnified notification badge checks failed: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}

console.log(`\nUnified notification badge checks passed: ${passed} checks.\n`)

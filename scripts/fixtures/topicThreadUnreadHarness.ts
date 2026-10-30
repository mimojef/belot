// Браузърна сглобка за checkTopicThreadUnreadClient.ts.
//
// Кара реалния createLobbyFlowController + renderLobbyScreen (през Vite, в
// истински Chromium) срещу фалшив „сървър“, който огледално повтаря
// handleTopicRepliesRequest (window=unread/latest, before/after) и
// POST .../seen с throughSeq (MAX, ограничен до последния отговор).
// Състоянието на фалшивия сървър е в localStorage — споделено между две
// страници в един browser context (второ устройство) и оцелява при reload.
import { createLobbyFlowController, type LobbyAuthSession } from '/src/app/lobby/createLobbyFlowController.ts'
import type { ServerMessage, TopicMessageSnapshot, TopicReplySnapshot, TopicSnapshot, TopicThreadRepliesCursor, TopicThreadRepliesPageResult } from '/src/app/network/createGameServerClient.ts'

const STORAGE_KEY = 'topicThreadUnreadHarnessDb'
const OWN = 'me'
const CONTEXT = 10
const PAGE = 30

type DbReply = { seq: number; messageId: string; senderProfileId: string; body: string; deleted: boolean; image?: boolean }

// Реална снимка (не 1×1) с фиксирано съотношение — като production attachment.
const IMAGE_DATA_URL = (() => {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#7a5a12'
    ctx.fillRect(0, 0, 320, 180)
    ctx.fillStyle = '#f4c95b'
    ctx.fillRect(20, 20, 120, 60)
  }
  return canvas.toDataURL('image/png')
})()
type DbRoot = { seq: number; messageId: string; senderProfileId: string; body: string; replies: DbReply[] }
type Db = {
  nextSeq: number
  topicThreshold: number
  roots: DbRoot[]
  lafche: Array<{ seq: number; messageId: string; senderProfileId: string; body: string }>
  /** rootId → last_seen_seq (topic_thread_read_state). */
  threadSeen: Record<string, number>
}

function emptyDb(): Db {
  return { nextSeq: 1, topicThreshold: 0, roots: [], lafche: [], threadSeen: {} }
}

function loadDb(): Db {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === null ? emptyDb() : (JSON.parse(raw) as Db)
}

function saveDb(db: Db): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
}

function mutate<T>(fn: (db: Db) => T): T {
  const db = loadDb()
  const result = fn(db)
  saveDb(db)
  return result
}

const nowIso = () => new Date(Date.UTC(2026, 9, 30, 12, 0, 0)).toISOString()

function threshold(db: Db, rootId: string): number {
  return db.threadSeen[rootId] ?? db.topicThreshold
}

function isUnread(db: Db, rootId: string, item: { senderProfileId: string; seq: number }): boolean {
  return item.senderProfileId !== OWN && item.seq > threshold(db, rootId)
}

function liveReplies(root: DbRoot): DbReply[] {
  return root.replies.filter((reply) => !reply.deleted).sort((a, b) => a.seq - b.seq)
}

function toReplySnapshot(db: Db, root: DbRoot, reply: DbReply): TopicReplySnapshot {
  return {
    seq: reply.seq,
    messageId: reply.messageId,
    topicId: 'topic-general',
    parentMessageId: root.messageId,
    senderProfileId: reply.senderProfileId,
    senderDisplayName: reply.senderProfileId === OWN ? 'Me' : `Автор ${reply.senderProfileId}`,
    senderAvatarUrl: null,
    senderRole: 'player',
    body: reply.body,
    createdAt: nowIso(),
    editedAt: null,
    likeCount: 0,
    viewerHasLiked: false,
    attachment: reply.image
      ? { attachmentId: `att-${reply.messageId}`, width: 320, height: 180, byteSize: 1024, viewUrl: IMAGE_DATA_URL, downloadUrl: IMAGE_DATA_URL }
      : null,
    isTopicsSectionMuted: false,
    isUnread: isUnread(db, root.messageId, reply),
  }
}

function threadUnreadCount(db: Db, root: DbRoot): number {
  const rootUnread = isUnread(db, root.messageId, root) ? 1 : 0
  return rootUnread + liveReplies(root).filter((reply) => isUnread(db, root.messageId, reply)).length
}

function toRootSnapshot(db: Db, root: DbRoot): TopicMessageSnapshot {
  return {
    seq: root.seq,
    messageId: root.messageId,
    topicId: 'topic-general',
    parentMessageId: null,
    senderProfileId: root.senderProfileId,
    senderDisplayName: `Автор ${root.senderProfileId}`,
    senderAvatarUrl: null,
    senderRole: 'player',
    body: root.body,
    createdAt: nowIso(),
    lastActivityAt: nowIso(),
    editedAt: null,
    likeCount: 0,
    replyCount: liveReplies(root).length,
    viewerHasLiked: false,
    attachment: null,
    unreadCount: threadUnreadCount(db, root),
    isTopicsSectionMuted: false,
  } as TopicMessageSnapshot
}

const topics: TopicSnapshot[] = [
  { topicId: 'topic-general', slug: 'general', title: 'Общ чат', description: null, isGeneral: true, createdByProfileId: null, status: 'active', sortOrder: 0, createdAt: nowIso(), unreadCount: 0 },
  { topicId: 'topic-lafche', slug: 'lafche', title: 'Лафче', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: -1, createdAt: nowIso(), unreadCount: 0 },
]

const threadLoadLog: Array<{ rootMessageId: string; cursor: TopicThreadRepliesCursor }> = []
const legacyRepliesLoadLog: string[] = []
const seenLog: Array<{ rootMessageId: string; throughSeq: number | undefined }> = []
const topicSeenLog: string[] = []
const replySendLog: Array<{ parentMessageId: string; body: string; requestId: string }> = []
let responseDelayMs = 0
let threadLoadsInFlight = 0
let maxThreadLoadsInFlight = 0

const authSession: LobbyAuthSession = {
  account: { role: 'player' },
  profile: { profileId: OWN, displayName: 'Me' } as any,
}

async function delay(): Promise<void> {
  if (responseDelayMs > 0) await new Promise((done) => setTimeout(done, responseDelayMs))
}

function loadThreadPage(rootMessageId: string, cursor: TopicThreadRepliesCursor): TopicThreadRepliesPageResult {
  const db = loadDb()
  const root = db.roots.find((candidate) => candidate.messageId === rootMessageId)
  if (!root) return { ok: false, message: 'Съобщението не беше намерено.' }
  const replies = liveReplies(root)
  let page: DbReply[] = []
  let hasMoreBefore = false
  let hasMoreAfter = false
  let firstUnreadSeq: number | null = null
  let deletedMessageIds: string[] = []
  if ('window' in cursor && cursor.window === 'unread') {
    firstUnreadSeq = replies.find((reply) => isUnread(db, rootMessageId, reply))?.seq ?? null
    if (firstUnreadSeq === null) {
      page = replies.slice(-PAGE)
      hasMoreBefore = replies.length > PAGE
    } else {
      const index = replies.findIndex((reply) => reply.seq === firstUnreadSeq)
      const start = Math.max(0, index - CONTEXT)
      page = replies.slice(start, index + PAGE)
      hasMoreBefore = start > 0
      hasMoreAfter = index + PAGE < replies.length
    }
  } else if ('window' in cursor) {
    page = replies.slice(-PAGE)
    hasMoreBefore = replies.length > PAGE
  } else if ('beforeSeq' in cursor) {
    const older = replies.filter((reply) => reply.seq < cursor.beforeSeq)
    page = older.slice(-PAGE)
    hasMoreBefore = older.length > PAGE
  } else {
    const newer = replies.filter((reply) => reply.seq > cursor.afterSeq)
    page = newer.slice(0, PAGE)
    hasMoreAfter = newer.length > PAGE
    deletedMessageIds = root.replies.filter((reply) => reply.deleted && reply.seq <= cursor.afterSeq).map((reply) => reply.messageId)
  }
  return {
    ok: true,
    replies: page.map((reply) => toReplySnapshot(db, root, reply)),
    hasMoreBefore,
    hasMoreAfter,
    deletedMessageIds,
    readState: { lastSeenSeq: threshold(db, rootMessageId), firstUnreadSeq, rootIsUnread: isUnread(db, rootMessageId, root) },
  }
}

function generalUnread(db: Db): number {
  return db.roots.reduce((sum, root) => sum + threadUnreadCount(db, root), 0)
}

const root = document.createElement('div')
document.body.appendChild(root)

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => authSession,
  onTopicsLoad: async () => {
    const db = loadDb()
    return {
      ok: true,
      topics: topics.map((topic) => ({ ...topic, unreadCount: topic.topicId === 'topic-general' ? generalUnread(db) : 0 })),
      viewerSectionMute: null,
    }
  },
  onTopicMessagesLoad: async (topicId: string) => {
    const db = loadDb()
    if (topicId === 'topic-lafche') {
      const messages = db.lafche.map((post) => ({
        ...toRootSnapshot(db, { ...post, replies: [] }),
        topicId: 'topic-lafche',
        unreadCount: 0,
      }))
      return { ok: true, messages: [...messages].reverse(), hasMore: false, oldestSeq: messages[0]?.seq ?? null }
    }
    const messages = db.roots.map((candidate) => toRootSnapshot(db, candidate))
    return { ok: true, messages: [...messages].reverse(), hasMore: false, oldestSeq: messages[0]?.seq ?? null }
  },
  onTopicMessagesSubscribe: () => {},
  onTopicMessagesUnsubscribe: () => {},
  onTopicMarkSeen: async (topicId: string) => {
    topicSeenLog.push(topicId)
    return { ok: true, lastSeenSeq: 0, unreadCount: 0 }
  },
  onTopicThreadMarkSeen: async (_topicId: string, rootMessageId: string, throughSeq?: number) => {
    seenLog.push({ rootMessageId, throughSeq })
    const result = mutate((db) => {
      const rootRecord = db.roots.find((candidate) => candidate.messageId === rootMessageId)
      if (!rootRecord) return null
      const latest = Math.max(rootRecord.seq, ...rootRecord.replies.map((reply) => reply.seq))
      const target = throughSeq === undefined ? latest : Math.min(throughSeq, latest)
      db.threadSeen[rootMessageId] = Math.max(threshold(db, rootMessageId), target)
      return { lastSeenSeq: db.threadSeen[rootMessageId]!, unreadCount: threadUnreadCount(db, rootRecord), topicUnreadCount: generalUnread(db) }
    })
    await delay()
    return result === null ? { ok: false, message: 'Разговорът не беше намерен.' } : { ok: true, ...result }
  },
  onTopicThreadRepliesLoad: async (_topicId: string, rootMessageId: string, cursor: TopicThreadRepliesCursor) => {
    threadLoadLog.push({ rootMessageId, cursor })
    threadLoadsInFlight++
    maxThreadLoadsInFlight = Math.max(maxThreadLoadsInFlight, threadLoadsInFlight)
    try {
      const result = loadThreadPage(rootMessageId, cursor)
      await delay()
      return result
    } finally {
      threadLoadsInFlight--
    }
  },
  onTopicRepliesLoad: async (_topicId: string, rootMessageId: string) => {
    legacyRepliesLoadLog.push(rootMessageId)
    return { ok: true, replies: [], hasMore: false, oldestSeq: null, deletedMessageIds: [] }
  },
  onTopicMessageSend: () => {},
  onTopicReplySend: (_topicId: string, parentMessageId: string, body: string, requestId: string) => {
    replySendLog.push({ parentMessageId, body, requestId })
  },
  onGetTopicsVipGateStatus: async () => ({ ok: true, isActive: true, hasClaimedLaunchGift: true, launchGiftDays: 30 }),
})

function q<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

function threadScroll(): HTMLElement | null {
  return q<HTMLElement>('[data-topic-thread-scroll="1"]')
}

function replyBody(index: number): string {
  // Различна дължина → реалистични, различни височини на редовете.
  return `Отговор ${index} ${'текст на отговора '.repeat(2 + (index % 5) * 3)}`
}

;(window as any).__topicThreadUnreadHarness = {
  controller,
  reset: () => {
    localStorage.removeItem(STORAGE_KEY)
    threadLoadLog.length = 0
    legacyRepliesLoadLog.length = 0
    seenLog.length = 0
    topicSeenLog.length = 0
    replySendLog.length = 0
    maxThreadLoadsInFlight = 0
  },
  getMaxConcurrentThreadLoads: () => maxThreadLoadsInFlight,
  /** Заредено над/под изгледа, видими ли са root картата и маркерите за зареждане. */
  getLoadedBeyond: () => {
    const scroll = threadScroll()
    if (!scroll) return null
    const view = scroll.getBoundingClientRect()
    const rects = Array.from(scroll.querySelectorAll<HTMLElement>('[data-topic-replies-section] [data-topic-reply]')).map((el) => el.getBoundingClientRect())
    const inView = (el: Element | null) => {
      if (!el) return false
      const rect = el.getBoundingClientRect()
      return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom
    }
    return {
      aboveCount: rects.filter((rect) => rect.bottom <= view.top).length,
      belowCount: rects.filter((rect) => rect.top >= view.bottom).length,
      abovePx: rects.length > 0 ? Math.max(0, view.top - rects[0]!.top) : 0,
      belowPx: rects.length > 0 ? Math.max(0, rects[rects.length - 1]!.bottom - view.bottom) : 0,
      viewHeight: view.height,
      rootVisible: inView(scroll.querySelector('[data-topic-thread-list] > [data-topic-message]')),
      olderSentinelVisible: inView(scroll.querySelector('[data-topic-thread-older-sentinel="1"]')),
      newerSentinelVisible: inView(scroll.querySelector('[data-topic-thread-newer-sentinel="1"]')),
    }
  },
  /** Нишка с replyCount отговора; readThrough = колко от тях са прочетени (null = нишката никога не е отваряна). */
  /** longAt — номера на отговори (от 1) с много дълъг текст (няколко екрана). */
  /** variety: true — всеки 7-и със снимка, всеки 11-и дълъг (около екран); 'long' — всеки отговор около 1-2 екрана. */
  seedThread: (rootMessageId: string, replyCount: number, readThrough: number | null, ownEvery = 0, longAt: number[] = [], variety: boolean | 'long' = false) => mutate((db) => {
    const rootRecord: DbRoot = { seq: db.nextSeq++, messageId: rootMessageId, senderProfileId: 'alice', body: `Тема ${rootMessageId}`, replies: [] }
    for (let i = 1; i <= replyCount; i++) {
      const sender = ownEvery > 0 && i % ownEvery === 0 ? OWN : (i % 2 === 0 ? 'bob' : 'carol')
      const body = longAt.includes(i) ? `Дълъг отговор ${i} ${'много дълъг текст на отговора, който заема няколко екрана '.repeat(160)}` : replyBody(i)
      const varietyBody = variety === 'long' ? `Дълъг отговор ${i} ${'по-дълъг текст за проверка на различни височини '.repeat(30 + (i % 4) * 15)}` : variety && i % 11 === 0 ? `Дълъг отговор ${i} ${'по-дълъг текст за проверка на различни височини '.repeat(40)}` : body
      rootRecord.replies.push({ seq: db.nextSeq++, messageId: `${rootMessageId}-r${i}`, senderProfileId: sender, body: varietyBody, deleted: false, image: variety === true && i % 7 === 0 })
    }
    db.roots.push(rootRecord)
    if (readThrough !== null) {
      db.threadSeen[rootMessageId] = readThrough === 0 ? rootRecord.seq : rootRecord.replies[readThrough - 1]!.seq
    }
    return rootRecord.replies.map((reply) => reply.seq)
  }),
  seedLafche: (count: number) => mutate((db) => {
    for (let i = 1; i <= count; i++) db.lafche.push({ seq: db.nextSeq++, messageId: `lafche-${i}`, senderProfileId: 'bob', body: `Лафче ${i}` })
  }),
  /** Нов отговор „на сървъра“; връща topic_reply push-а (без да го доставя). */
  addServerReply: (rootMessageId: string, senderProfileId = 'bob', requestId?: string) => mutate((db) => {
    const rootRecord = db.roots.find((candidate) => candidate.messageId === rootMessageId)!
    const index = rootRecord.replies.length + 1
    const reply: DbReply = { seq: db.nextSeq++, messageId: `${rootMessageId}-r${index}`, senderProfileId, body: replyBody(index), deleted: false }
    rootRecord.replies.push(reply)
    const { isUnread: _ignored, ...snapshot } = toReplySnapshot(db, rootRecord, reply)
    return requestId === undefined ? { type: 'topic_reply', ...snapshot } : { type: 'topic_reply', ...snapshot, requestId }
  }),
  deleteServerReply: (rootMessageId: string, messageId: string) => mutate((db) => {
    const rootRecord = db.roots.find((candidate) => candidate.messageId === rootMessageId)!
    const reply = rootRecord.replies.find((candidate) => candidate.messageId === messageId)!
    reply.deleted = true
    return { type: 'topic_message_deleted', topicId: 'topic-general', messageId, parentMessageId: rootMessageId }
  }),
  getWatermark: (rootMessageId: string) => loadDb().threadSeen[rootMessageId] ?? null,
  getThreadUnread: (rootMessageId: string) => {
    const db = loadDb()
    const rootRecord = db.roots.find((candidate) => candidate.messageId === rootMessageId)
    return rootRecord ? threadUnreadCount(db, rootRecord) : null
  },
  threadSeenPush: (rootMessageId: string) => {
    const db = loadDb()
    const rootRecord = db.roots.find((candidate) => candidate.messageId === rootMessageId)!
    return {
      type: 'topic_thread_seen_updated',
      topicId: 'topic-general',
      rootMessageId,
      lastSeenSeq: threshold(db, rootMessageId),
      unreadCount: threadUnreadCount(db, rootRecord),
      topicUnreadCount: generalUnread(db),
    }
  },
  setResponseDelay: (ms: number) => {
    responseDelayMs = ms
  },
  openTopicsScreen: () => controller.navigateToTopics(),
  openLafche: () => q<HTMLButtonElement>('[data-topics-lafche-open="1"]')?.click(),
  openGeneral: () => q<HTMLButtonElement>('[data-topics-back-to-general="1"]')?.click(),
  openThread: (rootMessageId: string) => q<HTMLElement>(`[data-topic-card-open="${rootMessageId}"]`)?.click(),
  clickThreadBack: () => q<HTMLButtonElement>('[data-topic-thread-back="1"]')?.click(),
  simulateServerMessage: (message: ServerMessage) => controller.handleServerMessage(message),
  reconnect: () => controller.forceTopicMessagesResubscribeIfOnTopicsScreen(),
  getThreadLoadLog: () => threadLoadLog,
  getLegacyRepliesLoadLog: () => legacyRepliesLoadLog,
  getSeenLog: () => seenLog,
  getTopicSeenLog: () => topicSeenLog,
  getRootCardBadge: (rootMessageId: string) => q<HTMLElement>(`[data-topic-thread-unread-badge="${rootMessageId}"]`)?.textContent?.trim() ?? null,
  getLoadedReplySeqs: () => Array.from(document.querySelectorAll<HTMLElement>('[data-topic-replies-section] [data-topic-reply]')).map((el) => Number(el.dataset.topicThreadSeq)),
  /** Горният ръб на първия изцяло видим отговор спрямо изгледа. */
  getTopVisibleReply: () => {
    const scroll = threadScroll()
    if (!scroll) return null
    const view = scroll.getBoundingClientRect()
    for (const el of Array.from(scroll.querySelectorAll<HTMLElement>('[data-topic-replies-section] [data-topic-reply]'))) {
      const rect = el.getBoundingClientRect()
      if (rect.top >= view.top && rect.top < view.bottom) return { seq: Number(el.dataset.topicThreadSeq), top: rect.top - view.top, bottom: rect.bottom - view.top }
    }
    return null
  },
  countThreadRequests: (kind: 'before' | 'after' | 'window') => threadLoadLog.filter((entry) =>
    kind === 'window' ? 'window' in entry.cursor : kind === 'before' ? 'beforeSeq' in entry.cursor : 'afterSeq' in entry.cursor).length,
  getLoadedReplyIds: () => Array.from(document.querySelectorAll<HTMLElement>('[data-topic-replies-section] [data-topic-reply]')).map((el) => el.dataset.topicReply ?? ''),
  hasDivider: () => q('[data-topic-thread-unread-divider="1"]') !== null,
  /** Изпраща собствен отговор през реалния composer; връща requestId-то. */
  sendOwnReply: (rootMessageId: string, body: string) => {
    const form = q<HTMLFormElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"]`)
    const textarea = form?.querySelector<HTMLTextAreaElement>('[data-topics-reply-composer-text="1"]') ?? null
    if (!form || !textarea) return null
    textarea.value = body
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    form.requestSubmit()
    return replySendLog[replySendLog.length - 1]?.requestId ?? null
  },
  getReplyComposerValue: (rootMessageId: string) =>
    q<HTMLTextAreaElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"] [data-topics-reply-composer-text="1"]`)?.value ?? null,
  hasOwnReplyNotice: () => q('[data-topic-thread-own-reply-reveal="1"]') !== null,
  isOwnReplyNoticeOnScreen: () => {
    const button = q<HTMLElement>('[data-topic-thread-own-reply-reveal="1"]')
    const scroll = threadScroll()
    if (!button || !scroll) return false
    const rect = button.getBoundingClientRect()
    const view = scroll.getBoundingClientRect()
    return rect.height > 0 && rect.top >= view.top && rect.bottom <= view.bottom
  },
  clickOwnReplyNotice: () => q<HTMLButtonElement>('[data-topic-thread-own-reply-reveal="1"]')?.click(),
  getThreadClientHeight: () => threadScroll()?.clientHeight ?? null,
  getItemHeight: (seq: number) => q<HTMLElement>(`[data-topic-thread-seq="${seq}"]`)?.getBoundingClientRect().height ?? null,
  /** Позиционира горния ръб на елемента offset px под горния ръб на изгледа. */
  scrollItemToTop: (seq: number, offset = 0) => {
    const el = q<HTMLElement>(`[data-topic-thread-seq="${seq}"]`)
    const scroll = threadScroll()
    if (!el || !scroll) return
    scroll.scrollTop += el.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset
    scroll.dispatchEvent(new Event('scroll'))
  },
  /** seq на отговора непосредствено след разделителя. */
  getDividerNextSeq: () => {
    const divider = q<HTMLElement>('[data-topic-thread-unread-divider="1"]')
    const next = divider?.nextElementSibling as HTMLElement | null
    return next ? Number(next.dataset.topicThreadSeq) : null
  },
  /** Позиция на разделителя спрямо горния ръб на скрол изгледа (px). */
  getDividerOffset: () => {
    const divider = q<HTMLElement>('[data-topic-thread-unread-divider="1"]')
    const scroll = threadScroll()
    return divider && scroll ? divider.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null
  },
  getItemBottom: (seq: number) => {
    const el = q<HTMLElement>(`[data-topic-thread-seq="${seq}"]`)
    const scroll = threadScroll()
    return el && scroll ? el.getBoundingClientRect().bottom - scroll.getBoundingClientRect().top : null
  },
  getItemTop: (seq: number) => {
    const el = q<HTMLElement>(`[data-topic-thread-seq="${seq}"]`)
    const scroll = threadScroll()
    return el && scroll ? el.getBoundingClientRect().top - scroll.getBoundingClientRect().top : null
  },
  getVisibleSeqs: () => {
    const scroll = threadScroll()
    if (!scroll) return []
    const view = scroll.getBoundingClientRect()
    return Array.from(scroll.querySelectorAll<HTMLElement>('[data-topic-thread-seq]'))
      .filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.bottom > view.top && rect.top < view.bottom
      })
      .map((el) => Number(el.dataset.topicThreadSeq))
  },
  getThreadScrollTop: () => threadScroll()?.scrollTop ?? null,
  getThreadBottomDistance: () => {
    const scroll = threadScroll()
    return scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null
  },
  setThreadScrollTop: (value: number) => {
    const scroll = threadScroll()
    if (!scroll) return
    scroll.scrollTop = value
    scroll.dispatchEvent(new Event('scroll'))
  },
  scrollThreadBy: (delta: number) => {
    const scroll = threadScroll()
    if (!scroll) return
    scroll.scrollTop += delta
    scroll.dispatchEvent(new Event('scroll'))
  },
  scrollThreadToBottom: () => {
    const scroll = threadScroll()
    if (!scroll) return
    scroll.scrollTop = scroll.scrollHeight
    scroll.dispatchEvent(new Event('scroll'))
  },
  hasLoadMoreButton: () => q('[data-topic-replies-load-more]') !== null || document.body.textContent?.includes('Покажи още') === true,
  getSentinelVisibility: () => ({
    older: q<HTMLElement>('[data-topic-thread-older-sentinel="1"]')?.style.display ?? null,
    newer: q<HTMLElement>('[data-topic-thread-newer-sentinel="1"]')?.style.display ?? null,
  }),
  getTopicsScrollTop: () => q<HTMLElement>('[data-topic-messages-scroll="1"]')?.scrollTop ?? null,
  getTopicsBottomDistance: () => {
    const scroll = q<HTMLElement>('[data-topic-messages-scroll="1"]')
    return scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : null
  },
  countLafchePosts: () => document.querySelectorAll('.lafche-post').length,
}

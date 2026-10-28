// Браузърна тестова "сглобка" (fixture) за checkTopicsCountPushNoMarkSeen.ts.
//
// Реалният createLobbyFlowController + renderLobbyScreen (през Vite dev server,
// в Playwright), със stub-нати мрежови callback-ове. Записва всяко извикване
// на onTopicMarkSeen / onTopicThreadMarkSeen, за да провери, че push за брояч
// никога сам не маркира като прочетено, а пристигнало съдържание — да.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { getRenderLobbyScreenCallCount } from '/src/app/lobby/renderLobbyScreen.ts'
import type { TopicSnapshot, TopicMessageSnapshot, TopicReplySnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const now = new Date().toISOString()
const topics: TopicSnapshot[] = [
  { topicId: 'topic-general', slug: 'general', title: 'Общ чат', description: null, isGeneral: true, createdByProfileId: null, status: 'active', sortOrder: 0, createdAt: now, unreadCount: 0 },
  { topicId: 'topic-lafche', slug: 'lafche', title: 'Лафче', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: 1, createdAt: now, unreadCount: 0 },
]

let nextSeq = 100
function makeMessage(topicId: string, messageId: string, unreadCount = 0, minutesAgo = 0): TopicMessageSnapshot {
  const createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  return {
    seq: nextSeq++,
    messageId,
    topicId,
    parentMessageId: null,
    senderProfileId: 'someone',
    senderDisplayName: 'Someone',
    senderAvatarUrl: null,
    senderRole: 'player',
    body: `Съобщение ${messageId}`,
    createdAt,
    lastActivityAt: createdAt,
    unreadCount,
    editedAt: null,
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
    attachment: null,
    isTopicsSectionMuted: false,
  } as TopicMessageSnapshot
}

function makeReply(rootMessageId: string, messageId: string): TopicReplySnapshot {
  return {
    seq: nextSeq++,
    messageId,
    topicId: 'topic-general',
    parentMessageId: rootMessageId,
    senderProfileId: 'someone',
    senderDisplayName: 'Someone',
    senderAvatarUrl: null,
    senderRole: 'player',
    body: `Отговор ${messageId}`,
    createdAt: new Date().toISOString(),
    editedAt: null,
    likeCount: 0,
    viewerHasLiked: false,
    attachment: null,
    isTopicsSectionMuted: false,
  }
}

// 30 карти в „Общи“ (за скрол): general-root-a/-b са най-новите, после
// general-root-02..29 с активност преди 2..29 минути.
const generalHistory = [
  makeMessage('topic-general', 'general-root-a', 0, 0),
  makeMessage('topic-general', 'general-root-b', 0, 1),
  ...Array.from({ length: 28 }, (_, i) => makeMessage('topic-general', `general-root-${String(i + 2).padStart(2, '0')}`, 0, i + 2)),
]
const historyByTopicId: Record<string, TopicMessageSnapshot[]> = {
  'topic-general': generalHistory,
  'topic-lafche': [makeMessage('topic-lafche', 'lafche-1')],
}

function getMessagesScrollEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
}

const markSeenLog: string[] = []
const threadMarkSeenLog: string[] = []

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me', galleryImages: [] } as any,
  }) as any,
  onTopicsLoad: async () => ({ ok: true, topics, viewerSectionMute: null }),
  onTopicMessagesLoad: async (topicId: string) => ({
    ok: true,
    messages: historyByTopicId[topicId] ?? [],
    hasMore: false,
    oldestSeq: null,
  }),
  onTopicRepliesLoad: async () => ({ ok: true, replies: [], hasMore: false, oldestSeq: null }),
  onTopicMarkSeen: async (topicId: string) => {
    markSeenLog.push(topicId)
    return { ok: true, lastSeenSeq: nextSeq, unreadCount: 0 }
  },
  onTopicThreadMarkSeen: async (_topicId: string, rootMessageId: string) => {
    threadMarkSeenLog.push(rootMessageId)
    return { ok: true, lastSeenSeq: nextSeq, unreadCount: 0, topicUnreadCount: 0 }
  },
})

;(window as any).__topicsCountPushNoMarkSeenHarness = {
  openTopicsScreen: () => controller.navigateToTopics(),
  openGeneral: () => document.querySelector<HTMLElement>('[data-topics-back-to-general="1"]')?.click(),
  openLafche: () => document.querySelector<HTMLElement>('[data-topics-lafche-open="1"]')?.click(),
  openThread: (rootMessageId: string) => document.querySelector<HTMLElement>(`[data-topic-card-open="${rootMessageId}"]`)?.click(),
  backFromThread: () => document.querySelector<HTMLElement>('[data-topic-thread-back="1"]')?.click(),
  isThreadOpen: () => document.querySelector('[data-topic-thread-header="1"]') !== null,
  hasCard: (rootMessageId: string) => document.querySelector(`[data-topic-card-open="${rootMessageId}"]`) !== null,
  send: (message: unknown) => controller.handleServerMessage(message as any),
  makeMessage,
  makeReply,
  getMarkSeenLog: () => [...markSeenLog],
  getThreadMarkSeenLog: () => [...threadMarkSeenLog],
  clearLogs: () => { markSeenLog.length = 0; threadMarkSeenLog.length = 0 },
  getThreadBadgeText: (rootMessageId: string) =>
    document.querySelector(`[data-topic-thread-unread-badge="${rootMessageId}"]`)?.textContent ?? null,
  getGeneralBadgeText: () => {
    const el = document.querySelector<HTMLElement>('[data-topics-general-badge="1"]')
    return el !== null && el.style.display !== 'none' ? el.textContent : null
  },
  isLafcheBadgeVisible: () => {
    const el = document.querySelector<HTMLElement>('[data-topics-lafche-badge="1"]')
    return el !== null && el.style.display !== 'none'
  },
  getRenderCount: () => getRenderLobbyScreenCallCount(),
  getCardOrder: () => [...document.querySelectorAll<HTMLElement>('[data-topic-card-open]')].map((el) => el.getAttribute('data-topic-card-open')),
  // Скролва така, че картата да е най-горе във видимата зона.
  scrollCardToTop: (rootMessageId: string) => {
    const scrollEl = getMessagesScrollEl()
    const card = document.querySelector<HTMLElement>(`[data-topic-card-open="${rootMessageId}"]`)
    if (scrollEl === null || card === null) return false
    scrollEl.scrollTop += card.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top
    return true
  },
  // Позиция на картата спрямо горния ръб на скрол контейнера (видимо отместване).
  getCardOffset: (rootMessageId: string) => {
    const scrollEl = getMessagesScrollEl()
    const card = document.querySelector<HTMLElement>(`[data-topic-card-open="${rootMessageId}"]`)
    if (scrollEl === null || card === null) return null
    return Math.round(card.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top)
  },
}

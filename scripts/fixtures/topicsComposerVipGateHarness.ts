// Браузърна тестова "сглобка" (fixture) за checkTopicsComposerVipGate.ts.
//
// Кара реалния createLobbyFlowController + renderLobbyScreen (същия production
// код, зареден през Vite dev server, БЕЗ jsdom) в истински браузър (Playwright),
// със stub-нати мрежови/WS callback-ове вместо реален backend. Огледално на
// topicsSwitchRaceHarness.ts (виж него за rationale на подхода), но фокусиран
// върху Етап 2: composer/VIP gate/realtime merge поведение.
import { createLobbyFlowController, type LobbyAuthSession } from '/src/app/lobby/createLobbyFlowController.ts'
import type { ChatConversationSnapshot, FriendshipsSnapshot, TopicSnapshot, TopicMessageSnapshot, TopicReplySnapshot, ServerMessage } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const topics: TopicSnapshot[] = [
  { topicId: 'topic-general', slug: 'general', title: 'Общ чат', description: null, isGeneral: true, createdByProfileId: null, status: 'active', sortOrder: 0, createdAt: new Date().toISOString(), unreadCount: 0 },
  { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: 1, createdAt: new Date().toISOString(), unreadCount: 0 },
]

let authSession: LobbyAuthSession = {
  account: { role: 'player' },
  profile: { profileId: 'me', displayName: 'Me' } as any,
}

function makeMessage(topicId: string, seq: number, body: string, senderProfileId = 'someone', senderDisplayName = 'Someone'): TopicMessageSnapshot {
  const createdAt = new Date().toISOString()
  return {
    seq,
    messageId: `${topicId}-${seq}-${body}`,
    topicId,
    parentMessageId: null,
    senderProfileId,
    senderDisplayName,
    senderAvatarUrl: null,
    senderRole: 'player',
    body,
    createdAt,
    lastActivityAt: createdAt,
    unreadCount: 0,
    editedAt: null,
    likeCount: 0,
    replyCount: 0,
    viewerHasLiked: false,
  }
}

function makeReply(topicId: string, seq: number, parentMessageId: string, body: string, senderProfileId = 'someone', senderDisplayName = 'Someone'): TopicReplySnapshot {
  return {
    seq,
    messageId: `${topicId}-reply-${seq}-${body}`,
    topicId,
    parentMessageId,
    senderProfileId,
    senderDisplayName,
    senderAvatarUrl: null,
    senderRole: 'player',
    body,
    createdAt: new Date().toISOString(),
    editedAt: null,
    likeCount: 0,
    viewerHasLiked: false,
  }
}

let vipGate = { isActive: false, hasClaimedLaunchGift: false }
let claimResult: { ok: true; isActive: boolean; activeUntil?: string | null } | { ok: false; alreadyClaimed: boolean } = { ok: true, isActive: true, activeUntil: null }
let nextMessagesResult: { ok: true; messages: TopicMessageSnapshot[]; hasMore: boolean; oldestSeq: number | null } = {
  ok: true,
  messages: [],
  hasMore: false,
  oldestSeq: null,
}
let nextRepliesResult: { ok: true; replies: TopicReplySnapshot[]; hasMore: boolean; oldestSeq: number | null } = {
  ok: true,
  replies: [],
  hasMore: false,
  oldestSeq: null,
}

const subscribeLog: Array<{ topicId: string; afterSeq: number }> = []
const unsubscribeLog: string[] = []
const sendLog: Array<{ topicId: string; body: string; requestId: string }> = []
const replySendLog: Array<{ topicId: string; parentMessageId: string; body: string; requestId: string }> = []
const likeToggleLog: Array<{ messageId: string; requestId: string }> = []
const repliesLoadLog: Array<{ topicId: string; rootMessageId: string; afterSeq: number | null }> = []
const threadSeenLog: Array<{ topicId: string; rootMessageId: string }> = []
const vipDmStartLog: string[] = []
let chatConversations: ChatConversationSnapshot[] = []
let vipDmStartResult:
  | { ok: true; conversation: ChatConversationSnapshot }
  | { ok: false; message: string; code?: 'blocked' | 'vip_required' | 'vip_counterpart_required' } = {
    ok: false,
    message: 'Личните съобщения към потребители извън приятелите са достъпни само за VIP.',
    code: 'vip_required',
  }
let profileLoadResult: { ok: true; profile: any } | { ok: false; message: string; code?: 'profile_blocked_by_viewer' | 'profile_blocked_viewer' } = {
  ok: true,
  profile: null,
}
let chatConversationsAfterVipDmStart: ChatConversationSnapshot[] | null = null
let supportUnreadResult = { unreadCount: 0, supportUnreadCount: 0, guestUnreadCount: 0 }
let vipGateCallCount = 0
let claimCallCount = 0
let topicsLoadCallCount = 0
let topicMessagesLoadCallCount = 0

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => authSession,
  onTopicsLoad: async () => {
    topicsLoadCallCount++
    return { ok: true, topics }
  },
  onTopicMessagesLoad: async (_topicId: string, _beforeSeq: number | null) => {
    topicMessagesLoadCallCount++
    return nextMessagesResult
  },
  onTopicMessagesSubscribe: (topicId: string, afterSeq: number) => {
    subscribeLog.push({ topicId, afterSeq })
  },
  onTopicThreadMarkSeen: async (topicId: string, rootMessageId: string) => {
    threadSeenLog.push({ topicId, rootMessageId })
    const topic = topics.find((candidate) => candidate.topicId === topicId)
    const root = nextMessagesResult.messages.find((message) => message.messageId === rootMessageId)
    if (topic) topic.unreadCount = Math.max(0, topic.unreadCount - (root?.unreadCount ?? 0))
    if (root) root.unreadCount = 0
    return { ok: true, lastSeenSeq: root?.seq ?? 0, unreadCount: 0, topicUnreadCount: topic?.unreadCount ?? 0 }
  },
  onTopicMessagesUnsubscribe: (topicId: string) => {
    unsubscribeLog.push(topicId)
  },
  onTopicMessageSend: (topicId: string, body: string, requestId: string) => {
    sendLog.push({ topicId, body, requestId })
  },
  onTopicReplySend: (topicId: string, parentMessageId: string, body: string, requestId: string) => {
    replySendLog.push({ topicId, parentMessageId, body, requestId })
  },
  onTopicMessageLikeToggle: (messageId: string, requestId: string) => {
    likeToggleLog.push({ messageId, requestId })
  },
  onTopicRepliesLoad: async (topicId: string, rootMessageId: string, afterSeq: number | null) => {
    repliesLoadLog.push({ topicId, rootMessageId, afterSeq })
    return nextRepliesResult
  },
  onChatConversationsLoad: async () => ({ ok: true, conversations: chatConversations }),
  onChatMessagesLoad: async () => ({ ok: true, messages: [] }),
  onSupportUnreadLoad: async () => ({ ok: true, ...supportUnreadResult }),
  onVipDmChatStart: async (recipientProfileId: string) => {
    vipDmStartLog.push(recipientProfileId)
    if (vipDmStartResult.ok) {
      chatConversations = chatConversationsAfterVipDmStart ?? [
        vipDmStartResult.conversation,
        ...chatConversations.filter((conversation) => conversation.friendshipId !== vipDmStartResult.conversation.friendshipId),
      ]
      chatConversationsAfterVipDmStart = null
    }
    return vipDmStartResult
  },
  onProfileByIdLoad: async (profileId: string) => {
    if (!profileLoadResult.ok) return profileLoadResult
    return {
      ok: true,
      profile: profileLoadResult.profile ?? {
        profileId,
        displayName: 'Target',
        avatarUrl: null,
        isVip: true,
      },
    }
  },
  onGetTopicsVipGateStatus: async () => {
    vipGateCallCount++
    return { ok: true, isActive: vipGate.isActive, hasClaimedLaunchGift: vipGate.hasClaimedLaunchGift }
  },
  onClaimTopicsLaunchGift: async () => {
    claimCallCount++
    return claimResult
  },
})

function q<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector)
}

;(window as any).__topicsComposerVipGateHarness = {
  controller,
  openTopicsScreen: () => controller.navigateToTopics(),
  clickTopicChip: (topicId: string) => q<HTMLButtonElement>(`[data-topic-chip="${topicId}"]`)?.click(),
  setVipGate: (isActive: boolean, hasClaimedLaunchGift: boolean) => {
    vipGate = { isActive, hasClaimedLaunchGift }
  },
  setClaimResult: (result: typeof claimResult) => {
    claimResult = result
  },
  setNextMessagesResult: (messages: TopicMessageSnapshot[], hasMore = false) => {
    nextMessagesResult = {
      ok: true,
      messages,
      hasMore,
      oldestSeq: messages.length > 0 ? messages[messages.length - 1]!.seq : null,
    }
  },
  setNextRepliesResult: (replies: TopicReplySnapshot[], hasMore = false) => {
    nextRepliesResult = {
      ok: true,
      replies,
      hasMore,
      oldestSeq: replies.length > 0 ? replies[replies.length - 1]!.seq : null,
    }
  },
  setChatConversations: (conversations: ChatConversationSnapshot[]) => {
    chatConversations = conversations
    controller.setChatConversations(conversations)
  },
  setIncomingFriendRequests: (count: number) => {
    const now = new Date().toISOString()
    const friendships: FriendshipsSnapshot = {
      incomingPending: Array.from({ length: count }, (_value, index) => ({
        friendshipId: `pending-${index + 1}`,
        status: 'pending',
        direction: 'incoming',
        profile: { profileId: `friend-request-${index + 1}`, displayName: `Friend ${index + 1}`, avatarUrl: null } as any,
        createdAt: now,
        updatedAt: now,
      })),
      outgoingPending: [],
      friends: [],
    }
    controller.setFriendships(friendships)
  },
  setSupportUnread: (supportUnreadCount: number, guestUnreadCount = 0) => {
    supportUnreadResult = {
      unreadCount: supportUnreadCount + guestUnreadCount,
      supportUnreadCount,
      guestUnreadCount,
    }
    controller.refreshSupportUnread()
  },
  setTopicUnreadCounts: (counts: Record<string, number>) => {
    for (const topic of topics) {
      topic.unreadCount = counts[topic.topicId] ?? 0
    }
    controller.render()
  },
  setTopicDirectoryResponse: (items: Array<{ topicId: string; slug?: string; title?: string; isGeneral?: boolean; unreadCount: number }>) => {
    topics.splice(0, topics.length, ...items.map((item, index) => ({
      topicId: item.topicId,
      slug: item.slug ?? item.topicId,
      title: item.title ?? `Topic ${index + 1}`,
      description: null,
      isGeneral: item.isGeneral ?? false,
      createdByProfileId: null,
      status: 'active' as const,
      sortOrder: index,
      createdAt: new Date().toISOString(),
      unreadCount: item.unreadCount,
    })))
  },
  render: () => controller.render(),
  setAuthProfile: (profileId: string, displayName = profileId) => {
    authSession = {
      account: { role: 'player' },
      profile: { profileId, displayName } as any,
    }
  },
  refreshTopicsDirectoryMetadata: () => controller.refreshTopicsDirectoryMetadata(),
  clearTopicsDirectoryMetadata: () => controller.clearTopicsDirectoryMetadata(),
  setChatConversationsAfterVipDmStart: (conversations: ChatConversationSnapshot[] | null) => {
    chatConversationsAfterVipDmStart = conversations
  },
  setVipDmStartResult: (result: typeof vipDmStartResult) => {
    vipDmStartResult = result
  },
  setProfileLoadResult: (result: typeof profileLoadResult) => {
    profileLoadResult = result
  },
  makeMessage,
  makeReply,
  makeConversation: (friendshipId: string, kind: 'friend' | 'vip_dm', friendProfileId: string, friendDisplayName = 'Friend', friendIsVip: boolean | null | undefined = true): ChatConversationSnapshot => {
    const friend: Record<string, unknown> = { profileId: friendProfileId, displayName: friendDisplayName, avatarUrl: null }
    if (friendIsVip !== undefined) friend.isVip = friendIsVip
    return {
      friendshipId,
      kind,
      friend: friend as any,
      lastMessage: null,
      updatedAt: new Date().toISOString(),
      unreadCount: 0,
      isArchived: false,
    }
  },
  getSubscribeLog: () => subscribeLog,
  getUnsubscribeLog: () => unsubscribeLog,
  getSendLog: () => sendLog,
  getReplySendLog: () => replySendLog,
  getLikeToggleLog: () => likeToggleLog,
  getRepliesLoadLog: () => repliesLoadLog,
  getThreadSeenLog: () => threadSeenLog,
  getVipDmStartLog: () => vipDmStartLog,
  clearVipDmStartLog: () => { vipDmStartLog.length = 0 },
  handleServerMessage: (message: ServerMessage) => {
    if (message.type === 'chat_message_received') {
      chatConversations = chatConversations.map((conversation) => (
        conversation.friendshipId === message.friendshipId
          ? { ...conversation, unreadCount: conversation.unreadCount + 1, updatedAt: new Date().toISOString() }
          : conversation
      ))
    }
    return controller.handleServerMessage(message)
  },
  getVipGateCallCount: () => vipGateCallCount,
  getClaimCallCount: () => claimCallCount,
  getTopicsLoadCallCount: () => topicsLoadCallCount,
  getTopicMessagesLoadCallCount: () => topicMessagesLoadCallCount,
  clickRootCard: (rootMessageId: string) => q<HTMLElement>(`[data-topic-card-open="${CSS.escape(rootMessageId)}"]`)?.click(),
  clickThreadBack: () => q<HTMLButtonElement>('[data-topic-thread-back="1"]')?.click(),
  isThreadVisible: () => q('[data-topic-thread-scroll="1"]') !== null,
  getThreadRootMessageId: () => q<HTMLElement>('[data-topic-thread-list="1"] [data-topic-message]')?.dataset.topicMessage ?? null,
  getThreadScrollTop: () => q<HTMLElement>('[data-topic-thread-scroll="1"]')?.scrollTop ?? null,
  getThreadScrollHeight: () => q<HTMLElement>('[data-topic-thread-scroll="1"]')?.scrollHeight ?? null,
  getThreadClientHeight: () => q<HTMLElement>('[data-topic-thread-scroll="1"]')?.clientHeight ?? null,
  getThreadBottomDistance: () => {
    const el = q<HTMLElement>('[data-topic-thread-scroll="1"]')
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : null
  },
  setThreadScrollTop: (value: number) => {
    const el = q<HTMLElement>('[data-topic-thread-scroll="1"]')
    if (el) {
      el.scrollTop = value
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
  },
  isReplyComposerReadonly: (rootMessageId: string) =>
    q<HTMLTextAreaElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${CSS.escape(rootMessageId)}"] [data-topics-reply-composer-text="1"]`)?.readOnly ?? null,
  clickReplyButton: (rootMessageId: string) => q<HTMLButtonElement>(`[data-topic-message-reply="${rootMessageId}"]`)?.click(),
  clickLikeButton: (messageId: string) => q<HTMLButtonElement>(`[data-topic-message-like="${messageId}"]`)?.click(),
  clickDirectPersonalButton: (profileId: string) => q<HTMLButtonElement>(`[data-topic-message-personal="${profileId}"]`)?.click(),
  clickChatNav: () => q<HTMLButtonElement>('[data-lobby-nav-chat="1"]')?.click(),
  openChatConversation: (friendshipId: string) => controller.openChatWithFriend(friendshipId),
  getChatConversationText: (friendshipId: string) => q(`[data-lobby-chat-conversation="${CSS.escape(friendshipId)}"]`)?.textContent ?? null,
  getChatFormFriendshipId: () => q<HTMLFormElement>('[data-lobby-chat-form]')?.dataset.lobbyChatForm ?? null,
  getBodyText: () => document.body.textContent ?? '',
  openMobileMenu: () => {
    const details = q<HTMLDetailsElement>('[data-lobby-mobile-menu="1"]')
    if (details) details.open = true
  },
  getMobileMenuTotalBadgeText: () => q('[data-mobile-menu-total-badge="1"]')?.textContent ?? null,
  getMobileMenuItemBadgeText: (icon: string) => q(`[data-mobile-menu-item-badge="${CSS.escape(icon)}"]`)?.textContent ?? null,
  getMobileMenuItemBadgeColor: (icon: string) => {
    const el = q<HTMLElement>(`[data-mobile-menu-item-badge="${CSS.escape(icon)}"]`)
    return el ? getComputedStyle(el).backgroundColor : null
  },
  getMobileMenuItemBadgeRect: (icon: string) => {
    const el = q<HTMLElement>(`[data-mobile-menu-item-badge="${CSS.escape(icon)}"]`)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  },
  getDesktopNavBadgeText: (item: string) => q(`nav [data-desktop-nav-badge="${CSS.escape(item)}"]`)?.textContent ?? null,
  getDesktopNavBadgeColor: (item: string) => {
    const el = q<HTMLElement>(`nav [data-desktop-nav-badge="${CSS.escape(item)}"]`)
    return el ? getComputedStyle(el).backgroundColor : null
  },
  getDesktopNavBadgeRect: (item: string) => {
    const el = q<HTMLElement>(`nav [data-desktop-nav-badge="${CSS.escape(item)}"]`)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  },
  getDesktopNavItemRect: (item: string) => {
    const el = q<HTMLElement>(`nav [data-lobby-nav-${CSS.escape(item)}="1"]`)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  },
  getDesktopNavItemIconRect: (item: string) => {
    const el = q<HTMLElement>(`nav [data-lobby-nav-${CSS.escape(item)}="1"] svg`)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  },
  getDesktopNavItemLabelRect: (item: string) => {
    const el = q<HTMLElement>(`nav [data-lobby-nav-${CSS.escape(item)}="1"]`)
    if (!el) return null
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node !== null) {
      if ((node.textContent ?? '').trim().length > 0) {
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        range.detach()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
      node = walker.nextNode()
    }
    return null
  },
  getDesktopNavRect: () => {
    const el = q<HTMLElement>('nav')
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  },
  // Master navigation order regression (locked product order) — връща
  // видимите data-lobby-nav-* keys в DOM ред в рамките на containerSelector,
  // за да можем да асъртнем relative order без да пипаме index-базирани
  // селектори (badge/click wiring си остават keyed по data-attribute).
  getNavKeyOrder: (containerSelector: string, keys: string[]) => {
    const container = q<HTMLElement>(containerSelector)
    if (!container) return []
    const selector = keys.map((key) => `[data-lobby-nav-${key}="1"]`).join(',')
    const elements = Array.from(container.querySelectorAll<HTMLElement>(selector))
    const seen = new Set<HTMLElement>()
    const ordered: string[] = []
    for (const el of elements) {
      if (seen.has(el)) continue
      seen.add(el)
      const key = keys.find((candidate) => el.hasAttribute(`data-lobby-nav-${candidate}`))
      if (key) ordered.push(key)
    }
    return ordered
  },
  getTopicChipBadgeText: (topicId: string) => q(`[data-topic-chip="${CSS.escape(topicId)}"] .topic-unread-badge`)?.textContent ?? null,
  getTopicsPersonalBadgeText: () => q('[data-topics-personal-badge="1"]')?.textContent ?? null,
  clickTopicsPersonalOpen: () => q<HTMLButtonElement>('[data-topics-personal-open="1"]')?.click(),
  clickTopicsBackToGeneral: () => (q<HTMLButtonElement>('[data-topics-personal-back="1"]') ?? q<HTMLButtonElement>('[data-topics-back-to-general="1"]'))?.click(),
  isTopicsStreamVisible: () => q('[data-topic-messages-scroll="1"]') !== null,
  isTopicsPersonalDetailVisible: () => q('[data-topics-personal-detail="1"]') !== null,
  getTopicsPersonalPanelView: () => q<HTMLElement>('[data-topics-personal-panel="1"]')?.dataset.personalView ?? null,
  getChatComposerDisabledReason: () => q('[data-chat-composer-disabled-reason="1"]')?.textContent ?? null,
  isChatComposerDisabled: () => q<HTMLFormElement>('[data-lobby-chat-form]')?.dataset.chatComposerDisabled === '1',
  isRepliesSectionExpanded: (rootMessageId: string) => q(`[data-topic-replies-section="${rootMessageId}"]`) !== null,
  getReplyComposerValue: (rootMessageId: string) =>
    q<HTMLTextAreaElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"] [data-topics-reply-composer-text="1"]`)?.value ?? null,
  setReplyComposerValue: (rootMessageId: string, value: string) => {
    const el = q<HTMLTextAreaElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"] [data-topics-reply-composer-text="1"]`)
    if (!el) return
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  submitReplyComposer: (rootMessageId: string) =>
    q<HTMLFormElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"]`)?.requestSubmit(),
  pressEnterInReplyComposer: (rootMessageId: string, shiftKey: boolean) => {
    const el = q<HTMLTextAreaElement>(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"] [data-topics-reply-composer-text="1"]`)
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }))
  },
  isReplyComposerOpen: (rootMessageId: string) =>
    q(`[data-topics-reply-composer-form][data-topics-reply-composer-root-id="${rootMessageId}"]`) !== null,
  getLikeButtonState: (messageId: string) => {
    const btn = q<HTMLButtonElement>(`[data-topic-message-like="${messageId}"]`)
    if (!btn) return null
    const countEl = btn.querySelector('.topic-message-action-count')
    return {
      pressed: btn.getAttribute('aria-pressed'),
      liked: btn.getAttribute('aria-pressed') === 'true',
      count: countEl ? Number(countEl.textContent) : 0,
      disabled: btn.disabled,
    }
  },
  getReplyButtonCount: (rootMessageId: string) => {
    const btn = q<HTMLButtonElement>(`[data-topic-message-reply="${rootMessageId}"]`)
    const countEl = btn?.querySelector('.topic-message-action-count')
    return countEl ? Number(countEl.textContent) : 0
  },
  getVisibleReplyIds: (rootMessageId: string) =>
    Array.from(document.querySelectorAll(`[data-topic-replies-section="${rootMessageId}"] [data-topic-reply]`)).map((el) => el.getAttribute('data-topic-reply')),
  simulateServerMessage: (message: ServerMessage) => controller.handleServerMessage(message),
  getComposerValue: () => q<HTMLTextAreaElement>('[data-topics-composer-text="1"]')?.value ?? null,
  isComposerReadonly: () => q<HTMLTextAreaElement>('[data-topics-composer-text="1"]')?.readOnly ?? null,
  isComposerVipLocked: () => q<HTMLFormElement>('[data-topics-composer-form="1"]')?.dataset.topicsComposerVipLocked === '1',
  setComposerValue: (value: string) => {
    const el = q<HTMLTextAreaElement>('[data-topics-composer-text="1"]')
    if (!el) return
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  submitComposerForm: () => q<HTMLFormElement>('[data-topics-composer-form="1"]')?.requestSubmit(),
  clickComposerTextarea: () => {
    // Реален потребителски tap е pointerdown → (browser-native focus/click
    // chain) → click. Production non-VIP handler-ите (renderLobbyScreen.ts)
    // са нарочно разделени: pointerdown прави САМО preventDefault() (спира
    // mobile keyboard focus), а popup-ът се отваря на click (изчаква пълен
    // press-release цикъл, за да няма self-closing race — виж коментара на
    // wiring-а). dispatchEvent() не symuliра native event chaining, затова
    // тук explicit-но пращаме и двете, mirror на реален click().
    const el = q<HTMLTextAreaElement>('[data-topics-composer-text="1"]')
    el?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    el?.click()
  },
  focusComposerTextarea: () => q<HTMLTextAreaElement>('[data-topics-composer-text="1"]')?.focus(),
  isComposerTextareaFocused: () => document.activeElement === q<HTMLTextAreaElement>('[data-topics-composer-text="1"]'),
  isVipPopupOpen: () => q('[data-topics-vip-popup-backdrop="1"]') !== null,
  getVipPopupText: () => q('[data-topics-vip-popup-card="1"]')?.textContent ?? null,
  clickVipPopupClaim: () => q<HTMLButtonElement>('[data-topics-vip-popup-claim="1"]')?.click(),
  clickVipPopupSeePlans: () => q<HTMLButtonElement>('[data-topics-vip-popup-see-plans="1"]')?.click(),
  clickVipPopupClose: () => q<HTMLButtonElement>('[data-topics-vip-popup-close="1"]')?.click(),
  getVisibleMessageBodies: () => Array.from(document.querySelectorAll('[data-topic-message]')).map((el) => el.textContent ?? ''),
  getComposerErrorText: () => q('[data-topics-composer-error="1"]')?.textContent ?? null,
  getMessagesScrollTop: () => q<HTMLElement>('[data-topic-messages-scroll="1"]')?.scrollTop ?? null,
  getMessagesScrollHeight: () => q<HTMLElement>('[data-topic-messages-scroll="1"]')?.scrollHeight ?? null,
  getMessagesClientHeight: () => q<HTMLElement>('[data-topic-messages-scroll="1"]')?.clientHeight ?? null,
  getMessagesBottomDistance: () => {
    const el = q<HTMLElement>('[data-topic-messages-scroll="1"]')
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : null
  },
  getMessageTop: (messageId: string) => q<HTMLElement>(`[data-topic-message="${CSS.escape(messageId)}"]`)?.getBoundingClientRect().top ?? null,
  getMessageBottom: (messageId: string) => q<HTMLElement>(`[data-topic-message="${CSS.escape(messageId)}"]`)?.getBoundingClientRect().bottom ?? null,
  getMessageCount: () => document.querySelectorAll('[data-topic-message]').length,
  dispatchMessagesScroll: () => {
    q<HTMLElement>('[data-topic-messages-scroll="1"]')?.dispatchEvent(new Event('scroll', { bubbles: true }))
  },
  setMessagesScrollTop: (value: number) => {
    const el = q<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (el) el.scrollTop = value
  },
}

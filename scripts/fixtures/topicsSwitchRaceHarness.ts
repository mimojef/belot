// Браузърна тестова "сглобка" (fixture) за checkTopicsSwitchRace.ts.
//
// Кара реалния createLobbyFlowController + renderLobbyScreen (същия production
// код, зареден през Vite dev server, БЕЗ jsdom) в истински браузър (Playwright),
// но със stub-нати мрежови callback-ове вместо реален backend. Проверяваме
// чисто client-side race guard логиката (generation token в
// loadTopicMessagesForActiveTopic/openTopic) — не зависи от реален
// сървър/WebSocket.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { getRenderLobbyScreenCallCount } from '/src/app/lobby/renderLobbyScreen.ts'
import type { TopicSnapshot, TopicMessageSnapshot, PlayerPublicProfileSnapshot, ChatConversationSnapshot, ChatMessageSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const topics: TopicSnapshot[] = [
  { topicId: 'topic-general', slug: 'general', title: 'Общ чат', description: null, isGeneral: true, createdByProfileId: null, status: 'active', sortOrder: 0, createdAt: new Date().toISOString(), unreadCount: 0 },
  { topicId: 'topic-a', slug: 'topic-a', title: 'Тема A', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: 1, createdAt: new Date().toISOString(), unreadCount: 0 },
  { topicId: 'topic-b', slug: 'topic-b', title: 'Тема B', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: 2, createdAt: new Date().toISOString(), unreadCount: 0 },
]

function makeMessage(topicId: string, body: string, senderProfileId = 'someone', senderDisplayName = 'Someone'): TopicMessageSnapshot {
  const createdAt = new Date().toISOString()
  return {
    seq: Math.floor(Math.random() * 100000),
    messageId: `${topicId}-${body}-${Math.random()}`,
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

// Deferred-response контрол за GET /api/profiles/:id (profile popup canonical
// fetch) — аналогично на pendingResolvers за topic history, но keyed по
// profileId вместо topicId.
const pendingProfileResolvers = new Map<string, Array<(result: { ok: true; profile: PlayerPublicProfileSnapshot }) => void>>()

function makeProfile(profileId: string, displayName: string, overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName,
    avatarUrl: null,
    level: 1,
    rankTitle: null,
    skillRating: null,
    completedGamesCount: null,
    wonGamesCount: null,
    currentRankGames: null,
    nextRankGames: null,
    gamesUntilNextRank: null,
    rankProgressRatio: null,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: null,
    galleryImages: [],
    gender: null,
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: null,
    vipActiveUntil: null,
    ...overrides,
  }
}

function deliverNextProfileResponse(profileId: string): void {
  const queue = pendingProfileResolvers.get(profileId)
  const resolver = queue?.shift()
  if (!resolver) return
  resolver({ ok: true, profile: makeProfile(profileId, `Canonical ${profileId}`) })
}

// Вариант с explicit profile overrides — нужен за responsive/layout regression
// теста (checkProfilePopupMobileResponsive.ts): позволява доставяне на профил
// С avatar, VIP статус, попълнени stats и т.н., вместо минималния default
// profile от deliverNextProfileResponse (нужен само за race-guard теста).
function deliverNextProfileResponseWithOverrides(profileId: string, displayName: string, overrides: Partial<PlayerPublicProfileSnapshot>): void {
  const queue = pendingProfileResolvers.get(profileId)
  const resolver = queue?.shift()
  if (!resolver) return
  resolver({ ok: true, profile: makeProfile(profileId, displayName, overrides) })
}

// Deferred-response контрол per topicId — позволява на теста да контролира
// ТОЧНО кога всяка заявка за история resolve-ва, за да симулира "заявка за A
// resolve-ва СЛЕД заявка за B" (rapid switch race сценарий).
const pendingResolvers = new Map<string, Array<(result: { ok: true; messages: TopicMessageSnapshot[]; hasMore: boolean; oldestSeq: number | null }) => void>>()
const loadCallLog: string[] = []

function deliverNextResponse(topicId: string): void {
  deliverNextResponseWithBody(topicId, `Отговор за ${topicId} #${Date.now()}`)
}

// Позволява explicit контрол на СЪДЪРЖАНИЕТО на всеки resolve — нужно за
// A→B→A теста, за да различим "A-old" (първата, остаряла заявка) от
// "A-new" (втората, актуална заявка) по текст, вместо само по topicId (и
// двете заявки са технически "за topic-a").
function deliverNextResponseWithBody(topicId: string, body: string): void {
  deliverNextResponseWithAuthor(topicId, body, 'someone', 'Someone')
}

// Вариант с explicit автор — нужен за profile-popup click теста (за да имаме
// кликаем data-topic-message-author бутон с известен profileId в DOM-а).
function deliverNextResponseWithAuthor(topicId: string, body: string, senderProfileId: string, senderDisplayName: string): void {
  const queue = pendingResolvers.get(topicId)
  const resolver = queue?.shift()
  if (!resolver) return
  resolver({
    ok: true,
    messages: [makeMessage(topicId, body, senderProfileId, senderDisplayName)],
    hasMore: false,
    oldestSeq: 1,
  })
}

// Доставя ЕДИН response с НЯКОЛКО съобщения от различни автори наведнъж —
// нужно за profile-popup click теста, за да имаме едновременно два реални
// data-topic-message-author бутона в DOM-а (само 1 onTopicMessagesLoad
// заявка се прави при отваряне на тема, не по 1 за всеки автор).
function deliverNextResponseWithAuthors(topicId: string, authors: Array<{ body: string; senderProfileId: string; senderDisplayName: string }>): void {
  deliverNextResponseWithAuthorsAndHasMore(topicId, authors, false)
}

// Вариант с explicit hasMore — нужен за load-older regression теста
// (checkTopicsSwitchRace [24]): без hasMore:true отговор, "load older"
// scroll-triggered callback-ът (onTopicMessagesLoadOlder) никога не прави
// втора заявка, защото loadOlderTopicMessages() early-return-ва при
// state.topicMessagesHasMore === false.
function deliverNextResponseWithAuthorsAndHasMore(
  topicId: string,
  authors: Array<{ body: string; senderProfileId: string; senderDisplayName: string }>,
  hasMore: boolean,
): void {
  const queue = pendingResolvers.get(topicId)
  const resolver = queue?.shift()
  if (!resolver) return
  const messages = authors.map((a) => makeMessage(topicId, a.body, a.senderProfileId, a.senderDisplayName))
  resolver({
    ok: true,
    messages,
    hasMore,
    oldestSeq: messages.length > 0 ? messages[messages.length - 1]!.seq : 1,
  })
}

// Мутируем own-profile snapshot — по подразбиране минимален (profileId='me'),
// но тестовете (напр. own profile popup VIP/balance layout) могат да
// презаписват overrides (yellowCoinsBalance и т.н.) ПРЕДИ да отворят popup-а.
let ownAuthProfileOverrides: Record<string, unknown> = {}

// Deferred-response контрол за onGetOwnVipStatus — аналогично на
// pendingProfileResolvers по-горе, за да можем детерминистично да
// доставяме active_until (или грешка) точно когато теста иска.
const pendingOwnVipStatusResolvers: Array<(result: { ok: true; activeUntil: string | null } | { ok: false }) => void> = []
// Общ брой РЕАЛНО стартирани onGetOwnVipStatus заявки за целия session —
// за request-dedupe regression (репетативни generic render() цикли, докато
// popup-ът стои отворен, НЕ трябва да множат заявките).
let ownVipStatusCallCount = 0

// Mock резултат за следващото onProfileEditSubmit — нужен за profile-popup
// ↔ edit-екран flow regression теста (Cancel/X връща popup със СТАРИ данни,
// успешен Save връща popup с НОВИ данни, без fallback към Lobby).
let nextProfileEditSubmitError: string | null = null
let nextProfileEditSubmitAvatarUrl: string | null = null

// Ролята на own-профила (account.role) — определя isFullAdminAuthSession
// client-side (viewerIsFullAdmin/isAdmin). По подразбиране 'player'; тестовете
// за "Дай VIP" (само admin) я превключват преди да отворят чужд profile popup.
let ownAuthAccountRole: 'player' | 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin' = 'player'

// Mock резултат за следващото onAdminGrantVip — тестовете задават точния
// очакван резултатен профил (или грешка) преди да submit-нат "Дай VIP" формата.
let nextAdminGrantVipResult:
  | { ok: true; profile: PlayerPublicProfileSnapshot }
  | { ok: false; message: string }
  | null = null

// ─── Personal chat / PIKABG official support chat (checkPikaSupportChatRouting.ts) ───
// Мутируем "сървърен" списък разговори (kind='friend'|'vip_dm'|'pika_support')
// + съобщения per friendshipId — достатъчно за да проверим client-only route-ването
// от profile popup "ЧАТ" бутона до renderChatPanel/activeChatFriendshipId, без
// нужда от реален backend (същият принцип като chatDraftHarness.ts).
let chatConversationsSnapshot: ChatConversationSnapshot[] = []
const chatMessagesByFriendship: Record<string, ChatMessageSnapshot[]> = {}
const chatSentLog: Array<{ friendshipId: string; body: string }> = []
// Deferred queue за onPikaSupportChatStart — позволява на теста да контролира
// ТОЧНО кога всяка "start/find pika_support conversation" заявка resolve-ва,
// нужно за race-guard сценария (по-бавна по-РАНО кликната заявка, resolve-ваща
// СЛЕД по-бърза по-КЪСНО кликната).
const pendingPikaStartResolvers = new Map<
  string,
  Array<(result: { ok: true; friendshipId: string } | { ok: false; message: string }) => void>
>()
// Симулира реалната сървърна block policy (chatStore.ts authorizeSendMessage/
// sendMessage): blockChecker.isBlocked се проверява само на SEND, НЕ на
// getOrCreatePikaSupportConversation (conversation start/find success-ва
// независимо от block статус) — виж checkOfficialPikaSupportChat.ts
// "[extra] blocked recipients still cannot receive new messages...".
const blockedChatFriendshipIds = new Set<string>()

function findChatConversation(friendshipId: string): ChatConversationSnapshot | undefined {
  return chatConversationsSnapshot.find((c) => c.friendshipId === friendshipId)
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => ({
    account: { role: ownAuthAccountRole },
    // galleryImages:[] по подразбиране — реалният PlayerPublicProfileSnapshot
    // от сървъра винаги го включва; profile edit модалът го итерира директно
    // ([...editorProfile.galleryImages]), затова mock-ът трябва да го има.
    profile: { profileId: 'me', displayName: 'Me', galleryImages: [], ...ownAuthProfileOverrides } as any,
  }),
  onTopicsLoad: async () => ({ ok: true, topics, viewerSectionMute: null }),
  onTopicMessagesLoad: (topicId: string, _beforeSeq: number | null) => {
    loadCallLog.push(topicId)
    return new Promise((resolve) => {
      const queue = pendingResolvers.get(topicId) ?? []
      queue.push(resolve)
      pendingResolvers.set(topicId, queue)
    })
  },
  onProfileByIdLoad: (profileId: string) => {
    return new Promise((resolve) => {
      const queue = pendingProfileResolvers.get(profileId) ?? []
      queue.push(resolve)
      pendingProfileResolvers.set(profileId, queue)
    })
  },
  onGetOwnVipStatus: () => {
    ownVipStatusCallCount += 1
    return new Promise((resolve) => {
      pendingOwnVipStatusResolvers.push(resolve)
    })
  },
  // Instant same-tick ack (не deferred queue) — [28]/[29] тестват само UI
  // icon-only/tooltip/optimistic-flip поведението, не пълния WS roundtrip
  // timing (тествано отделно в server/scripts/checkTopicMessagesRealtime.ts).
  // БЕЗ instant ack, бутонът остава disabled (pending state) завинаги в тази
  // тестова сесия — счупва Tab focus order-а на следващи тестове (disabled
  // елементи не са focusable).
  onTopicMessageLikeToggle: (messageId: string, requestId: string) => {
    controller.handleServerMessage({
      type: 'topic_message_like_changed_self',
      messageId,
      likeCount: 1,
      viewerHasLiked: true,
      requestId,
    })
  },
  onTopicReplySend: () => {},
  onTopicRepliesLoad: async () => ({ ok: true, replies: [], hasMore: false, oldestSeq: null }),
  onProfileEditSubmit: async () => {
    if (nextProfileEditSubmitError !== null) {
      const message = nextProfileEditSubmitError
      nextProfileEditSubmitError = null
      return message
    }
    if (nextProfileEditSubmitAvatarUrl !== null) {
      ownAuthProfileOverrides = { ...ownAuthProfileOverrides, avatarUrl: nextProfileEditSubmitAvatarUrl }
      nextProfileEditSubmitAvatarUrl = null
    }
    return null
  },
  onAdminGrantVip: async () => {
    if (nextAdminGrantVipResult === null) {
      return { ok: false, message: 'no mock result configured for this test' }
    }
    const result = nextAdminGrantVipResult
    nextAdminGrantVipResult = null
    return result
  },
  onPikaSupportChatStart: (recipientProfileId: string) => {
    return new Promise((resolve) => {
      const queue = pendingPikaStartResolvers.get(recipientProfileId) ?? []
      queue.push(resolve)
      pendingPikaStartResolvers.set(recipientProfileId, queue)
    })
  },
  onChatConversationsLoad: async () => ({ ok: true, conversations: chatConversationsSnapshot }),
  onChatMessagesLoad: async (friendshipId: string) => ({
    ok: true,
    messages: chatMessagesByFriendship[friendshipId] ?? [],
  }),
  onChatMarkRead: async () => {},
  onChatSend: async (friendshipId: string, body: string) => {
    if (blockedChatFriendshipIds.has(friendshipId)) {
      return { ok: false, message: 'Чатът е недостъпен поради блокиране.' }
    }
    chatSentLog.push({ friendshipId, body })
    const message: ChatMessageSnapshot = {
      messageId: `own-${Date.now()}-${Math.random()}`,
      friendshipId,
      senderProfileId: 'pika-sender-self',
      body,
      createdAt: new Date().toISOString(),
      isOwnMessage: true,
      attachment: null,
    }
    chatMessagesByFriendship[friendshipId] = [...(chatMessagesByFriendship[friendshipId] ?? []), message]
    const existing = findChatConversation(friendshipId)
    if (existing) {
      existing.lastMessage = message
      existing.updatedAt = message.createdAt
    }
    const conversation = findChatConversation(friendshipId)
    if (!conversation) {
      return { ok: false, message: 'conversation not found in fixture' }
    }
    return { ok: true, conversation, messages: chatMessagesByFriendship[friendshipId], newMessage: message }
  },
})

// ─── Тестова кука, извиквана от Playwright през page.evaluate ───────────────
;(window as any).__topicsSwitchRaceHarness = {
  controller,
  openTopicsScreen: () => {
    controller.navigateToTopics()
  },
  clickTopicChip: (topicId: string) => {
    const btn = document.querySelector<HTMLButtonElement>(`[data-topic-chip="${topicId}"]`)
    btn?.click()
  },
  deliverNextResponse,
  deliverNextResponseWithBody,
  deliverNextResponseWithAuthor,
  deliverNextResponseWithAuthors,
  deliverNextResponseWithAuthorsAndHasMore,
  getLoadCallLog: () => loadCallLog,
  getVisibleMessageBodies: () => {
    return Array.from(document.querySelectorAll('[data-topic-message]'))
      .map((el) => el.textContent ?? '')
  },
  clickMessageAuthor: (profileId: string) => {
    const btn = document.querySelector<HTMLButtonElement>(`[data-topic-message-author="${profileId}"]`)
    btn?.click()
  },
  deliverNextProfileResponse,
  deliverNextProfileResponseWithOverrides,
  isProfilePopupOpen: () => {
    return document.querySelector('[data-player-profile-popup-root="1"]') !== null
  },
  getProfilePopupText: () => {
    return document.querySelector('[data-player-profile-popup-root="1"]')?.textContent ?? null
  },
  closeProfilePopup: () => {
    const closeBtn = document.querySelector<HTMLButtonElement>('[data-player-profile-popup-close="1"]')
    closeBtn?.click()
  },
  // ─── Own profile popup (VIP/balance summary row тестове) ────────────────
  render: () => controller.render(),
  setOwnProfileOverrides: (overrides: Record<string, unknown>) => {
    ownAuthProfileOverrides = overrides
  },
  openOwnProfile: () => {
    // Реалният production trigger: клик върху "Профил" бутона на lobby
    // екрана (data-lobby-profile-button="1") — огледално на onProfileClick
    // wiring-а в createLobbyFlowController.ts/renderLobbyScreen.ts, НЕ
    // директен controller-only shortcut, за да тестваме реалния DOM path.
    const btn = document.querySelector<HTMLButtonElement>('[data-lobby-profile-button="1"]')
    btn?.click()
  },
  deliverOwnVipStatus: (activeUntil: string | null) => {
    const resolver = pendingOwnVipStatusResolvers.shift()
    resolver?.({ ok: true, activeUntil })
  },
  getOwnVipStatusPendingCount: () => pendingOwnVipStatusResolvers.length,
  getOwnVipStatusCallCount: () => ownVipStatusCallCount,
  getOwnProfileSummaryText: () => document.querySelector('[data-player-profile-own-summary="1"]')?.textContent ?? null,
  getOwnVipDaysText: () => document.querySelector('[data-player-profile-own-vip-days="1"]')?.textContent ?? null,
  getOwnBalanceText: () => document.querySelector('[data-player-profile-balance-own="1"]')?.textContent ?? null,
  isOwnEditVisible: () => document.querySelector('[data-player-profile-edit="1"]') !== null,
  // ─── Profile popup ↔ profile edit screen flow (Cancel/X/Save regression) ─
  clickOwnEdit: () => {
    document.querySelector<HTMLButtonElement>('[data-player-profile-edit="1"]')?.click()
  },
  isProfileEditorOpen: () => document.querySelector('[data-lobby-profile-editor-root="1"]') !== null,
  clickProfileEditorCancel: () => {
    document.querySelector<HTMLButtonElement>('[data-lobby-profile-editor-cancel="1"]')?.click()
  },
  clickProfileEditorClose: () => {
    document.querySelector<HTMLButtonElement>('[data-lobby-profile-editor-close="1"]')?.click()
  },
  setNextProfileEditSubmitAvatarUrl: (avatarUrl: string) => {
    nextProfileEditSubmitAvatarUrl = avatarUrl
  },
  submitProfileEditorForm: () => {
    document.querySelector<HTMLButtonElement>('[data-lobby-profile-editor-form="1"] button[type="submit"]')?.click()
  },
  getOwnAvatarImgSrc: () => document.querySelector<HTMLImageElement>('[data-player-profile-avatar="1"] img')?.getAttribute('src') ?? null,
  getRenderLobbyScreenCallCount,
  // ─── "Дай VIP" admin grant (foreign profile popup) ───────────────────────
  setOwnAccountRole: (role: 'player' | 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin') => {
    ownAuthAccountRole = role
  },
  isVipGrantTriggerVisible: () => document.querySelector('[data-player-profile-vip-grant-open="1"]') !== null,
  isVipGrantFormOpen: () => document.querySelector('[data-player-profile-vip-grant-form="1"]') !== null,
  clickVipGrantOpen: () => {
    document.querySelector<HTMLButtonElement>('[data-player-profile-vip-grant-open="1"]')?.click()
  },
  clickVipGrantCancel: () => {
    document.querySelector<HTMLButtonElement>('[data-player-profile-vip-grant-cancel="1"]')?.click()
  },
  setVipGrantDaysInput: (value: string) => {
    const input = document.querySelector<HTMLInputElement>('[data-player-profile-vip-grant-input="1"]')
    if (input) input.value = value
  },
  submitVipGrantForm: () => {
    document.querySelector<HTMLButtonElement>('[data-player-profile-vip-grant-submit="1"]')?.click()
  },
  getVipGrantErrorText: () => document.querySelector('[data-player-profile-vip-grant-error="1"]')?.textContent ?? null,
  setNextAdminGrantVipSuccess: (profileId: string, displayName: string, overrides: Partial<PlayerPublicProfileSnapshot>) => {
    nextAdminGrantVipResult = { ok: true, profile: makeProfile(profileId, displayName, overrides) }
  },
  setNextAdminGrantVipError: (message: string) => {
    nextAdminGrantVipResult = { ok: false, message }
  },
  // ─── Personal chat / PIKABG official support chat routing ────────────────
  setChatConversations: (conversations: ChatConversationSnapshot[]) => {
    chatConversationsSnapshot = conversations
  },
  addChatConversation: (conversation: ChatConversationSnapshot) => {
    chatConversationsSnapshot = [conversation, ...chatConversationsSnapshot]
  },
  seedChatMessage: (friendshipId: string, message: ChatMessageSnapshot) => {
    chatMessagesByFriendship[friendshipId] = [...(chatMessagesByFriendship[friendshipId] ?? []), message]
  },
  clickPikaSupportChatButton: () => {
    document.querySelector<HTMLButtonElement>('[data-player-profile-pika-support-chat]')?.click()
  },
  isPikaSupportChatButtonVisible: () => document.querySelector('[data-player-profile-pika-support-chat]') !== null,
  isPikaStartPending: (recipientProfileId: string): boolean =>
    (pendingPikaStartResolvers.get(recipientProfileId)?.length ?? 0) > 0,
  deliverNextPikaStartResponse: (recipientProfileId: string, friendshipId: string) => {
    const queue = pendingPikaStartResolvers.get(recipientProfileId)
    const resolver = queue?.shift()
    resolver?.({ ok: true, friendshipId })
  },
  deliverNextPikaStartError: (recipientProfileId: string, message: string) => {
    const queue = pendingPikaStartResolvers.get(recipientProfileId)
    const resolver = queue?.shift()
    resolver?.({ ok: false, message })
  },
  isChatFormPresent: () => document.querySelector('[data-lobby-chat-form]') !== null,
  getChatFormFriendshipId: () => document.querySelector('[data-lobby-chat-form]')?.getAttribute('data-lobby-chat-form') ?? null,
  getActiveChatHeaderText: () => {
    const form = document.querySelector('[data-lobby-chat-form]')
    const panel = form?.parentElement ?? null
    return panel?.children?.[0]?.textContent ?? null
  },
  isChatEmptyStateShown: () => {
    const text = document.body.textContent ?? ''
    return document.querySelector('[data-lobby-chat-form]') === null && text.includes('Избери приятел от списъка')
  },
  fillAndSubmitChatForm: (body: string) => {
    const form = document.querySelector<HTMLFormElement>('[data-lobby-chat-form]')
    if (!form) return false
    const input = form.querySelector<HTMLInputElement>('[data-lobby-chat-message-input="1"]')
    if (input) {
      input.value = body
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    return true
  },
  getChatSentLog: () => chatSentLog,
  getChatMessageBodies: (friendshipId: string) => (chatMessagesByFriendship[friendshipId] ?? []).map((m) => m.body),
  setChatSendBlocked: (friendshipId: string, blocked: boolean) => {
    if (blocked) blockedChatFriendshipIds.add(friendshipId)
    else blockedChatFriendshipIds.delete(friendshipId)
  },
}

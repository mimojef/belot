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
import type { TopicSnapshot, TopicMessageSnapshot, PlayerPublicProfileSnapshot } from '/src/app/network/createGameServerClient.ts'

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

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    // galleryImages:[] по подразбиране — реалният PlayerPublicProfileSnapshot
    // от сървъра винаги го включва; profile edit модалът го итерира директно
    // ([...editorProfile.galleryImages]), затова mock-ът трябва да го има.
    profile: { profileId: 'me', displayName: 'Me', galleryImages: [], ...ownAuthProfileOverrides } as any,
  }),
  onTopicsLoad: async () => ({ ok: true, topics }),
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
}

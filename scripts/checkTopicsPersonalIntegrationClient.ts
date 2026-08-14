import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderTopicsScreen, renderTopicMessageRow, renderTopicReplyRow } from '../src/app/lobby/renderTopicsScreen'
import type { LobbyScreenState } from '../src/app/lobby/renderLobbyScreen'

const args = process.argv.slice(2)
const rootArgIndex = args.indexOf('--project-root')
const projectRoot = rootArgIndex >= 0 && args[rootArgIndex + 1]
  ? resolve(args[rootArgIndex + 1])
  : process.cwd()

async function read(path: string): Promise<string> {
  return readFile(resolve(projectRoot, path), 'utf8')
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  console.log(`PASS ${name}`)
}

const renderTopics = await read('src/app/lobby/renderTopicsScreen.ts')
const renderLobby = await read('src/app/lobby/renderLobbyScreen.ts')
const profilePopupSource = await read('src/ui/overlays/renderPlayerProfilePopup.ts')
const controller = await read('src/app/lobby/createLobbyFlowController.ts')
const mainSource = await read('src/main.ts')
const packageJson = await read('package.json')
const topicsPersonalPanelSource = renderLobby.slice(
  renderLobby.indexOf('function renderTopicsPersonalMessages'),
  renderLobby.indexOf('function renderChatPanel'),
)
const standaloneChatPanelSource = renderLobby.slice(
  renderLobby.indexOf('function renderChatPanel'),
  renderLobby.indexOf('export function renderPlayersDirectory'),
)

function createRenderState(overrides: Partial<LobbyScreenState> = {}): LobbyScreenState {
  return {
    apiBaseUrl: '',
    view: 'topics',
    topicsLoading: false,
    topicsErrorText: null,
    topics: [{ topicId: 'topic-general', title: 'General', isGeneral: true, unreadCount: 0 }],
    activeTopicId: 'topic-general',
    topicsMode: 'personal',
    topicsPersonalView: 'conversation',
    topicMessagesLoading: false,
    topicMessagesErrorText: null,
    topicMessages: [],
    topicMessagesHasMore: false,
    topicMessagesOldestSeq: null,
    topicOlderMessagesLoading: false,
    topicMessagesRenderReason: null,
    topicComposerDraftByTopicId: {},
    topicComposerPendingRequestIdByTopicId: {},
    topicComposerErrorTextByTopicId: {},
    topicComposerPendingImageByTopicId: {},
    topicExpandedReplyRootIds: [],
    topicRepliesByRootId: {},
    topicRepliesHasMoreByRootId: {},
    topicRepliesLoadingByRootId: {},
    topicReplyComposerDraftByRootId: {},
    topicReplyComposerPendingRequestIdByRootId: {},
    topicReplyComposerErrorTextByRootId: {},
    topicReplyComposerOpenRootId: null,
    topicReplyComposerPendingImageByRootId: {},
    imageViewer: null,
    topicMessageLikeCountById: {},
    topicMessageViewerHasLikedById: {},
    topicMessageLikePendingRequestIdById: {},
    topicsVipGate: { isActive: true, hasClaimedLaunchGift: true },
    topicsVipGateLoading: false,
    topicsVipPopupOpen: false,
    topicsVipClaimSubmitting: false,
    topicsVipClaimErrorText: null,
    topicsVipSeePlansMessageVisible: false,
    topicsInfoToast: null,
    topicsPersonalMessagePendingProfileId: null,
    topicCreatePopupOpen: false,
    topicCreateBusy: false,
    topicCreateErrorText: null,
    topicCreateTitleDraft: '',
    activeTopicLock: null,
    activeTopicViewerMute: null,
    topicModerationActionPopup: null,
    topicModerationActionDurationMs: null,
    topicModerationActionReason: '',
    topicMuteStatusLoadingProfileId: null,
    topicModerationActionBusy: false,
    topicModerationActionErrorText: null,
    topicDeleteConfirm: null,
    topicDeleteReason: '',
    topicDeleteBusy: false,
    topicDeleteErrorText: null,
    topicMessageDeleteConfirm: null,
    topicMessageDeleteBusy: false,
    topicMessageDeleteErrorText: null,
    topicMessageEdit: null,
    topicMessageEditBusy: false,
    topicMessageEditErrorText: null,
    topicReportPopupOpen: false,
    topicReportReason: '',
    topicReportBusy: false,
    topicReportErrorText: null,
    topicReportSuccessToast: false,
    adminTopicReportsPopupOpen: false,
    adminTopicReportsLoading: false,
    adminTopicReportsErrorText: null,
    adminTopicReports: null,
    adminTopicReportsPendingCount: 0,
    adminTopicReportsFilter: null,
    isTopicModerator: false,
    isWholeTopicModerator: false,
    isTopicMessageModerator: false,
    blockedPlayersPopupOpen: false,
    blockedPlayers: null,
    blockedPlayersLoading: false,
    blockedPlayersErrorText: null,
    blockedPlayersLimit: 0,
    blockLimitPopupOpen: false,
    profileAccessBlockPopup: null,
    noPlayersModalOpen: false,
    isInGame: false,
    displayName: 'Viewer',
    selectedStake: 10,
    isConnected: true,
    isSearching: false,
    queuedPlayers: 0,
    requiredPlayers: 4,
    remainingMs: null,
    statusText: '',
    errorText: null,
    profilePopupOpen: false,
    profile: { profileId: 'viewer', displayName: 'Viewer', avatarUrl: null },
    profilePopupProfile: null,
    profilePopupCanEdit: false,
    profilePopupTargetRole: null,
    subadminActionConfirm: null,
    subadminActionBusy: false,
    subadminActionToast: null,
    chatAdminActionConfirm: null,
    chatAdminActionBusy: false,
    chatAdminActionToast: null,
    chatConversations: [{
      friendshipId: 'friend-b',
      kind: 'vip_dm',
      friend: { profileId: 'friend-profile', displayName: 'Mimojef', avatarUrl: null },
      lastMessage: null,
      updatedAt: '2026-08-12T10:00:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    chatShowArchived: false,
    chatArchivedConversations: [],
    chatArchivedLoading: false,
    activeChatFriendshipId: 'friend-b',
    chatMessages: [{
      messageId: 'personal-b',
      friendshipId: 'friend-b',
      senderProfileId: 'friend-profile',
      body: 'PERSONAL_ONLY_MESSAGE_B',
      createdAt: '2026-08-12T10:00:00.000Z',
      isOwnMessage: false,
      attachment: null,
    }],
    chatMessagesFriendshipId: 'friend-b',
    chatLoading: false,
    chatMessagesLoading: false,
    chatErrorText: null,
    chatDraftByFriendshipId: {},
    chatPendingImageByFriendshipId: {},
    chatUploadingFriendshipIds: new Set(),
    lobbyChatMessages: [],
    lobbyChatSubscribed: false,
    lobbyChatDraft: '',
    lobbyChatSending: false,
    lobbyChatPendingRequestId: null,
    lobbyChatErrorText: null,
    lobbyChatFullscreen: false,
    notificationsOpen: false,
    privateRoomInGameNotificationsEnabled: true,
    pendingFriendRequests: [],
    missionsPopupOpen: false,
    dailyMissions: [],
    dailyMissionsLoading: false,
    dailyMissionsErrorText: null,
    weeklyMissions: [],
    weeklyMissionsLoading: false,
    weeklyMissionsErrorText: null,
    ...overrides,
  } as LobbyScreenState
}

await check('[1] Topics header has locked top row and Personal button', () => {
  assert(renderTopics.includes('data-topics-header-row="1"'), 'missing topics header row')
  assert(renderTopics.includes('data-topics-personal-open="1"'), 'missing Personal open button')
  assert(renderTopics.includes('<span>Лични</span>'), 'missing visible Лични label')
  assert(renderTopics.includes('<h1 style="margin:0;font-size:20px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Теми</h1>'), 'Теми is not the stable left header title')
})

await check('[2] Personal button is not rendered as a topic chip and legacy topic strip is hidden', () => {
  assert(renderTopics.includes('data-topics-back-to-general="1"'), 'missing visible General top action')
  assert(!/data-topic-chip=.*Лични/.test(renderTopics), 'Лични must not be a topic chip')
  assert(!renderTopics.includes('data-topics-bar-scroll="1"'), 'legacy horizontal topics strip must not render')
  assert(!renderTopics.includes('data-topics-create="1"'), 'legacy create topic control must not render')
})

await check('[3] Topics Personal mode hides topic stream/chips and renders personal panel', () => {
  assert(renderTopics.includes('const isPersonalMode = state.topicsMode === \'personal\''), 'missing personal mode guard')
  assert(renderTopics.includes('renderTopicsPersonalChatPanel(state)'), 'missing personal panel render')
  assert(renderLobby.includes('topicsMode: \'topics\' | \'thread\' | \'personal\''), 'LobbyScreenState missing topicsMode')
  assert(renderLobby.includes('topicsPersonalView: \'list\' | \'conversation\''), 'LobbyScreenState missing personal view')
  assert(controller.includes('topicsMode: \'topics\' | \'thread\' | \'personal\''), 'controller state missing topicsMode')
  assert(controller.includes('topicsPersonalView: \'list\' | \'conversation\''), 'controller state missing personal view')
  assert(renderLobby.includes("const activeConversation = state.topicsPersonalView === 'conversation'"), 'detail must render only after selecting a conversation')
})

await check('[4] Topics Personal badge uses vip_dm-only unread message sum and shared 99+ display cap', () => {
  assert(renderLobby.includes('export function getPersonalChatUnreadTotal'), 'missing global unread helper')
  assert(renderLobby.includes("conversation.kind === 'vip_dm'"), 'global unread must include vip_dm conversations')
  assert(!renderLobby.includes("conversation.kind === 'friend' || conversation.kind === 'vip_dm'"), 'global unread/personal filters must not include friend conversations')
  assert(renderLobby.includes('conversation.unreadCount'), 'global unread must use unreadCount values')
  assert(renderLobby.includes('reduce((total, conversation) => total +'), 'global unread must sum message counts')
  assert(renderLobby.includes('export function formatPersonalChatUnreadBadgeCount'), 'missing badge formatter')
  assert(renderLobby.includes('return formatNotificationBadgeCount(count)'), 'personal badge formatter must reuse shared notification formatter')
  assert(renderLobby.includes("return normalized >= 100 ? '99+' : String(normalized)"), 'shared badge formatter must render 100+ as 99+')
  assert(renderTopics.includes('data-topics-personal-badge="1"'), 'missing global Personal badge node')
})

await check('[5] Topics Personal list includes vip_dm only and excludes friend/pika_support', () => {
  assert(controller.includes("return state.chatConversations.filter((conversation) => conversation.kind === 'vip_dm')"), 'personal list helper must include only vip_dm')
  assert(topicsPersonalPanelSource.length > 0, 'could not isolate Topics Personal panel source')
  assert(!topicsPersonalPanelSource.includes('pikaSupportBadge'), 'Topics Personal panel must not render pika support badge/list items')
  assert(controller.includes('getTopicsPersonalChatConversations()'), 'controller must use Topics Personal conversation helper')
})

await check('[6] Per-conversation badges use shared 99+ cap and are hidden at zero', () => {
  assert(renderLobby.includes('data-topics-personal-row-badge="1"'), 'missing row unread badge')
  assert(renderLobby.includes('formatPersonalChatUnreadBadgeCount(conversation.unreadCount)'), 'row badge must use capped formatter')
  assert(renderLobby.includes('unreadBadge !== null'), 'row badge must hide when zero')
  assert(renderLobby.includes('const activityTime = formatChatTime(conversation.updatedAt)'), 'row timestamp must come from conversation.updatedAt')
  assert(renderLobby.includes('data-topics-personal-row-time="1"'), 'row timestamp node must be rendered when available')
})

await check('[7] Open/read behavior reuses canonical chat state and clears only the opened conversation', () => {
  assert(renderLobby.includes('data-lobby-chat-conversation'), 'Personal rows must reuse chat conversation click selector')
  assert(renderLobby.includes('data-lobby-chat-form'), 'Personal detail must reuse chat form selector')
  assert(renderLobby.includes('data-lobby-chat-message-input="1"'), 'Personal detail must reuse chat input selector')
  assert(controller.includes('markChatConversationReadLocally(friendshipId)'), 'read action must clear selected conversation locally')
  assert(controller.includes('c.friendshipId === friendshipId ? { ...c, unreadCount: 0 } : c'), 'read clearing must be per-conversation')
})

await check('[8] Active/inactive realtime semantics include Topics Personal active conversation', () => {
  assert(controller.includes('function isActivePersonalChatConversation'), 'missing active personal chat helper')
  assert(controller.includes("state.currentScreen === 'topics'"), 'active helper must include Topics context')
  assert(controller.includes("state.topicsMode === 'personal'"), 'active helper must require personal mode')
  assert(controller.includes("state.topicsPersonalView === 'conversation'"), 'active helper must require conversation detail')
  assert(controller.includes('const isActiveConversation = isActivePersonalChatConversation(message.friendshipId)'), 'incoming chat handler must reuse active helper')
  assert(controller.includes('if (!isActiveConversation)'), 'inactive conversations must still increment unread locally')
})

await check('[9] openChatWithFriend routes by canonical conversation kind, not by current screen (production hotfix)', () => {
  assert(controller.includes('openChatWithFriend: (friendshipId: string) => {'), 'missing openChatWithFriend public entry')
  const openFn = controller.slice(controller.indexOf('openChatWithFriend: (friendshipId: string) => {'), controller.indexOf('getFriendshipActionForProfile: (profileId: string) => {'))
  assert(!openFn.includes("state.currentScreen === 'topics'"), 'openChatWithFriend must NOT branch by state.currentScreen — this was the friend-notification-popup regression (kind=friend popup incorrectly opened Topics Personal whenever the viewer happened to be on the Topics screen)')
  assert(openFn.includes('state.chatConversations.find((c) => c.friendshipId === friendshipId)'), 'openChatWithFriend must look up the exact conversation by canonical friendshipId')
  assert(openFn.includes("conversation?.kind === 'vip_dm'"), 'routing must be keyed by the canonical kind of THIS conversation, not by viewer UI context')
  assert(openFn.includes('void showTopicsPersonalChat(friendshipId)'), 'kind=vip_dm must still open Topics Personal conversation')
  assert(openFn.includes('void showChatPanel().then'), 'kind=friend (default/unknown) must open legacy Chat')
})

await check('[10] Composer, attachments and image viewer reuse existing Personal Chat selectors/helpers', () => {
  assert(renderLobby.includes('renderChatImagePickerControls(state, activeConversation.friendshipId)'), 'must reuse chat image picker controls')
  assert(renderLobby.includes('renderChatAttachmentBubble(message.attachment, state.apiBaseUrl)'), 'must reuse chat attachment bubble')
  assert(renderLobby.includes('renderPersonalChatMessageBody(message.body)'), 'must reuse personal chat message body rendering')
  assert(renderLobby.includes('data-chat-image-pick'), 'chat image pick selector must remain')
  assert(renderLobby.includes('data-chat-image-input'), 'chat image input selector must remain')
  assert(renderLobby.includes('renderImageViewerOverlay(state)'), 'shared image viewer must remain wired')
  assert(topicsPersonalPanelSource.includes('data-topics-personal-send="1"'), 'Topics Personal must render its own compact send button marker')
  assert(topicsPersonalPanelSource.includes('aria-label="Изпрати"'), 'Topics Personal icon send button must keep Bulgarian accessible label')
  assert(topicsPersonalPanelSource.includes('title="Изпрати"'), 'Topics Personal icon send button must keep Bulgarian title')
  assert(topicsPersonalPanelSource.includes('<span aria-hidden="true">&#10148;</span>'), 'Topics Personal send button must use the canonical send icon glyph')
  assert(topicsPersonalPanelSource.includes('width:42px;flex:0 0 42px;display:inline-flex;align-items:center;justify-content:center'), 'Topics Personal send button must be compact and centered for mobile')
  assert(topicsPersonalPanelSource.includes('${isComposerDisabled ? \'disabled\' : \'\'}'), 'Topics Personal icon send button must preserve disabled/pending semantics')
  assert(standaloneChatPanelSource.includes("state.chatUploadingFriendshipIds.has(activeConversation.friendshipId) ? 'Качване…' : 'Изпрати'"), 'legacy standalone Chat send button must remain text-based')
  assert(!standaloneChatPanelSource.includes('data-topics-personal-send="1"'), 'legacy standalone Chat must not receive the Topics Personal send marker')
})

await check('[11] Navigation/back and mobile list/detail state are wired', () => {
  assert(renderTopics.includes('data-topics-personal-back="1"'), 'missing Personal to Topics back control')
  assert(renderLobby.includes('data-topics-personal-conversation-back="1"'), 'missing detail to list back control')
  assert(renderLobby.includes('[data-topics-personal-panel="1"] { display:flex; flex-direction:column; }'), 'mobile personal panel must be flex column to avoid body overflow')
  assert(/\[data-topics-personal-panel="1"\]\[data-personal-view="conversation"\] \[data-topics-personal-list="1"\] \{ display:none(?: !important)?; \}/.test(renderLobby), 'mobile conversation view must hide list')
  assert(/\[data-topics-personal-panel="1"\]\[data-personal-view="list"\] \[data-topics-personal-detail="1"\] \{ display:none(?: !important)?; \}/.test(renderLobby), 'mobile list view must hide detail')
  assert(controller.includes('closeTopicsPersonalChat()'), 'missing Personal back controller')
  assert(controller.includes('backToTopicsPersonalList()'), 'missing conversation back controller')
  assert(controller.includes("state.topicsPersonalView = targetFriendshipId === null ? 'list' : 'conversation'"), 'Personal button must open list first')
})

await check('[12] Empty state is inbox-only and has no generic new conversation search', () => {
  assert(renderLobby.includes('Нямате лични разговори.'), 'missing required empty state')
  assert(renderLobby.includes('Можете да започнете разговор от профила на приятел.'), 'missing secondary empty state')
  assert(!renderLobby.includes('data-topics-personal-new-conversation'), 'must not add new conversation action')
  assert(!renderLobby.includes('data-topics-personal-search'), 'must not add personal people search')
})

await check('[13] Initial Topics load refreshes existing chat conversation summaries without N+1', () => {
  assert(controller.includes('if ((options.getAuthSession?.() ?? null) !== null && options.onChatConversationsLoad)'), 'Topics load should refresh chat summaries for badge')
  assert(controller.includes('void loadChatConversations().then'), 'Topics load should reuse existing conversation list request')
  assert(!controller.includes('/api/chat/conversations'), 'controller must not hardcode a second chat endpoint')
})

await check('[14] No DB/backend/protocol duplication or migration is introduced', () => {
  assert(!renderLobby.includes('personal_chat_messages'), 'must not introduce personal_chat_messages table concept')
  assert(!controller.includes('personal_chat_messages'), 'must not introduce personal_chat_messages table concept')
  assert(!renderLobby.includes('topic_personal_messages'), 'must not introduce topic personal message model')
  assert(!controller.includes('topic_personal_messages'), 'must not introduce topic personal message model')
  assert(!controller.includes('topics_personal_message_received'), 'must not introduce second WS event')
})

await check('[15] Permanent npm script is registered with local tsx runner', () => {
  assert(packageJson.includes('"check:topics-personal-integration-client"'), 'missing package script')
  assert(packageJson.includes('node server/node_modules/tsx/dist/cli.mjs scripts/checkTopicsPersonalIntegrationClient.ts --project-root=.'), 'script must use local tsx runner')
})

await check('[16] Topics Personal list uses the new inbox shell, not the standalone Chat screen', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    activeChatFriendshipId: 'friend-b',
    chatMessages: [{
      messageId: 'stale-personal',
      friendshipId: 'friend-b',
      senderProfileId: 'friend-profile',
      body: 'SHOULD_NOT_RENDER_BEFORE_SELECT',
      createdAt: '2026-08-12T10:00:00.000Z',
      isOwnMessage: false,
      attachment: null,
    }],
    chatMessagesFriendshipId: 'friend-b',
  }))

  assert(html.includes('data-topics-screen="1"'), 'Topics Personal must stay inside Topics shell')
  assert(html.includes('data-topics-personal-panel="1"'), 'Topics Personal must render the new inbox panel')
  assert(html.includes('data-topics-personal-list="1"'), 'first Personal open must render conversation list')
  assert(!html.includes('data-lobby-chat-toggle-archived="1"'), 'Topics Personal must not render standalone Chat archived selector')
  assert(!html.includes('Само между приятели'), 'Topics Personal must not render standalone Chat subtitle')
  assert(!html.includes('data-lobby-scale-stage'), 'Topics Personal must not render standalone Chat screen shell')
  assert(!html.includes('SHOULD_NOT_RENDER_BEFORE_SELECT'), 'first Personal open must not auto-render stale selected detail')
})

await check('[17] Topics Personal detail renders only canonical chatMessages for the selected friendship', () => {
  const html = renderTopicsScreen(createRenderState({
    topicMessages: [{
      messageId: 'topic-a',
      topicId: 'topic-general',
      parentMessageId: null,
      senderProfileId: 'friend-profile',
      senderDisplayName: 'Mimojef',
      senderAvatarUrl: null,
      senderRole: 'player',
      body: 'TOPIC_ONLY_MESSAGE_A',
      createdAt: '2026-08-12T09:00:00.000Z',
      unreadCount: 0,
      deletedAt: null,
      editedAt: null,
      attachment: null,
      replyCount: 0,
      likeCount: 0,
      viewerHasLiked: false,
    }],
  }))

  assert(html.includes('PERSONAL_ONLY_MESSAGE_B'), 'selected Personal detail must render canonical chatMessages')
  assert(!html.includes('TOPIC_ONLY_MESSAGE_A'), 'selected Personal detail must not render topicMessages')
})

await check('[18] Topics Personal detail refuses stale chatMessages from another friendship', () => {
  const html = renderTopicsScreen(createRenderState({
    activeChatFriendshipId: 'friend-b',
    chatMessagesFriendshipId: 'friend-a',
    chatMessages: [{
      messageId: 'friend-a-message',
      friendshipId: 'friend-a',
      senderProfileId: 'friend-a-profile',
      body: 'STALE_FRIEND_A_MESSAGE',
      createdAt: '2026-08-12T09:30:00.000Z',
      isOwnMessage: false,
      attachment: null,
    }],
    chatMessagesLoading: false,
  }))

  assert(!html.includes('STALE_FRIEND_A_MESSAGE'), 'late response from a previous friendship must not render in selected detail')
  assert(html.includes('Зареждане'), 'mismatched message owner should render a clean loading state')
})

await check('[19] kind=vip_dm notification opens Topics Personal while kind=friend notification opens standalone legacy Chat', () => {
  const openFn = controller.slice(controller.indexOf('openChatWithFriend: (friendshipId: string) => {'), controller.indexOf('getFriendshipActionForProfile: (profileId: string) => {'))
  assert(openFn.includes("conversation?.kind === 'vip_dm'"), 'vip_dm conversation action must branch by canonical kind, not viewer screen context')
  assert(openFn.includes('void showTopicsPersonalChat(friendshipId)'), 'vip_dm chat action must open Topics Personal conversation')
  assert(openFn.includes('void showChatPanel().then'), 'friend (default) chat entry must still use standalone Chat screen')
  assert(controller.includes("state.currentScreen = 'chat'"), 'standalone Chat screen must still exist for legacy entry')
})

await check('[20] Legacy Chat remains friend-only while Topics Personal is vip_dm-only', () => {
  assert(renderLobby.includes(".filter((conversation) => conversation.kind === 'friend')"), 'legacy Chat must filter strictly to friend conversations')
  assert(controller.includes("return state.chatConversations.filter((conversation) => conversation.kind === 'vip_dm')"), 'Topics Personal helper must filter strictly to vip_dm conversations')
  assert(!topicsPersonalPanelSource.includes('pikaSupportBadge'), 'Topics Personal must keep pika_support isolated')
})

await check('[20b] Active conversation reconciliation is kind-aware across Chat and Topics Personal', () => {
  assert(controller.includes('function isChatConversationValidForCurrentSurface'), 'missing kind-aware active conversation guard')
  assert(controller.includes("if (state.currentScreen === 'chat') return conversation.kind === 'friend'"), 'legacy Chat active guard must accept only friend conversations')
  assert(controller.includes("if (state.currentScreen === 'topics' && state.topicsMode === 'personal') return conversation.kind === 'vip_dm'"), 'Topics Personal active guard must accept only vip_dm conversations')
  assert(controller.includes('reconcileActiveChatConversation()'), 'conversation loads must reconcile active friendshipId against current surface')
  assert(controller.includes('const activeFriendConversation = state.activeChatFriendshipId !== null'), 'showChatPanel must verify active id is a friend conversation before skipping auto-open')
})

await check('[20c] Legacy Chat unread badges and mobile list are friend-only', () => {
  assert(renderLobby.includes("return sumConversationUnreadByKind(state, 'friend')"), 'Chat unread helper must count only friend conversations')
  assert(renderLobby.includes('const friendChatUnreadCount = getFriendChatUnreadRaw(state)'), 'desktop/mobile Chat badges must use the friend-only raw helper')
  assert(renderLobby.includes(".filter((conversation) => conversation.kind === 'friend')"), 'mobile/desktop Chat lists must filter strictly to friend conversations')
  assert(!renderLobby.includes("conversation.kind !== 'vip_dm'"), 'legacy Chat must not use broad not-vip_dm filters')
})

await check('[21] Profile block denial popup uses exact safe UX copy and unblock semantics', () => {
  assert(renderLobby.includes('Вие сте блокирали този потребител.'), 'viewer-is-blocker text missing')
  assert(renderLobby.includes('Този потребител ви е блокирал.'), 'target-is-blocker text missing')
  assert(renderLobby.includes('data-profile-access-block-unblock'), 'blocked-by-viewer popup must expose unblock action')
  assert(renderLobby.includes("popup.code === 'profile_blocked_by_viewer'"), 'unblock action must be gated to viewer-is-blocker denial')
})

await check('[22] Other-user profile entry points use protected canonical profile open flow', () => {
  assert(controller.includes('async function openProtectedProfileById'), 'missing protected profile-open helper')
  assert(controller.includes('const requestToken = ++state.profilePopupRequestToken'), 'protected profile flow must keep stale-response generation guard')
  assert(controller.includes('state.profileAccessBlockPopup = { profileId, code: result.code }'), 'block denial must render safe popup instead of profile content')
  assert(controller.includes('void openProtectedProfileById(profile.profileId, profile.displayName)'), 'directory/profile row handlers must use protected flow')
  assert(mainSource.includes("code?: 'profile_blocked_by_viewer' | 'profile_blocked_viewer'"), 'HTTP profile loader must preserve profile block denial code')
})

await check('[23] Topics post row shows Personal button for other users and hides it for own posts', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'topics',
    topicMessages: [
      {
        messageId: 'foreign-post',
        topicId: 'topic-general',
        parentMessageId: null,
        senderProfileId: 'other-profile',
        senderDisplayName: 'Other Player',
        senderAvatarUrl: null,
        senderRole: 'player',
        body: 'FOREIGN_POST',
        createdAt: '2026-08-12T09:00:00.000Z',
        unreadCount: 0,
        deletedAt: null,
        editedAt: null,
        attachment: null,
        replyCount: 0,
        likeCount: 0,
        viewerHasLiked: false,
      },
      {
        messageId: 'own-post',
        topicId: 'topic-general',
        parentMessageId: null,
        senderProfileId: 'viewer',
        senderDisplayName: 'Viewer',
        senderAvatarUrl: null,
        senderRole: 'player',
        body: 'OWN_POST',
        createdAt: '2026-08-12T09:01:00.000Z',
        unreadCount: 0,
        deletedAt: null,
        editedAt: null,
        attachment: null,
        replyCount: 0,
        likeCount: 0,
        viewerHasLiked: false,
      },
    ],
  }))

  assert(html.includes('data-topic-message-personal="other-profile"'), 'foreign Topics post must expose direct Personal button')
  assert(html.includes('>Лично</button>'), 'direct Personal button must use exact compact label')
  assert(!html.includes('data-topic-message-personal="viewer"'), 'own Topics post must not expose direct Personal button')
})

await check('[24] Topics author avatar/name still open profile, while profile popup has no Topics Personal entry', () => {
  assert(renderTopics.includes('data-topic-message-author="${escapeHtml(senderProfileId)}"'), 'avatar/name profile hook must remain')
  assert(renderLobby.includes('options.onTopicMessageAuthorClick(profileId, displayName)'), 'author click must still open profile flow')
  assert(controller.includes("void openProtectedProfileById(profileId, displayName, 'topics')"), 'Topics author click must keep protected profile authorization')
  assert(controller.includes('const showTopicsPersonalMessageButton = false'), 'Topics profile popup must not expose Personal Message action anymore')
})

await check('[25] Direct Topics Personal button ignores existing friend and opens existing vip_dm before start', () => {
  assert(renderLobby.includes('[data-topic-message-personal]'), 'render wiring must listen for direct post-row Personal button')
  assert(controller.includes('async function openTopicsPersonalMessageFromPost'), 'missing direct post-row Personal helper')
  assert(controller.includes('function findTopicsPersonalConversationByProfileId'), 'missing canonical existing-conversation lookup')
  assert(controller.includes('conversation.friend.profileId === profileId'), 'existing lookup must match the exact target profileId')
  assert(controller.includes("conversation.kind === 'vip_dm'"), 'existing lookup must include only vip_dm')
  assert(!controller.includes("conversation.kind === 'friend' || conversation.kind === 'vip_dm'"), 'direct lookup must not include friend conversations')
  assert(controller.includes('await loadChatConversations()'), 'direct action must refresh/reconcile conversations before deciding')
  assert(controller.includes('await showTopicsPersonalChat(existingConversation.friendshipId)'), 'existing conversation must open exact canonical friendshipId')
  assert(controller.includes('state.topicsVipGate !== null && !state.topicsVipGate.isActive'), 'known inactive viewer VIP state must short-circuit only after existing lookup')
  assert(controller.includes('openTopicsVipPopup()'), 'known inactive viewer VIP state must open canonical Topics VIP popup')
  assert(controller.includes('if (!options.onVipDmChatStart)'), 'new vip_dm start must be behind backend start option')
  const refreshIndex = controller.indexOf('await loadChatConversations()')
  const existingIndex = controller.indexOf('const existingConversation = findTopicsPersonalConversationByProfileId(recipientProfileId)')
  const inactiveVipIndex = controller.indexOf('state.topicsVipGate !== null && !state.topicsVipGate.isActive')
  const startIndex = controller.indexOf('const result = await options.onVipDmChatStart(recipientProfileId)')
  assert(refreshIndex !== -1 && existingIndex !== -1 && startIndex !== -1 && refreshIndex < existingIndex && existingIndex < startIndex, 'existing vip_dm lookup must happen before vip-dm/start')
  assert(inactiveVipIndex !== -1 && existingIndex < inactiveVipIndex && inactiveVipIndex < startIndex, 'known inactive viewer VIP short-circuit must happen after existing lookup and before vip-dm/start')
})

await check('[26] New direct VIP DM start uses backend canonical conversation and prevents duplicate rows', () => {
  assert(mainSource.includes("/api/chat/vip-dm/start"), 'main client must call the canonical vip-dm/start endpoint')
  assert(mainSource.includes('body: JSON.stringify({ recipientProfileId })'), 'vip-dm/start must send recipientProfileId body')
  assert(controller.includes('mergeCanonicalChatConversation(result.conversation)'), 'successful start must merge returned canonical conversation')
  assert(controller.includes('state.chatConversations.filter((c) => c.friendshipId !== conversation.friendshipId)'), 'merge must dedupe by canonical friendshipId')
  assert(controller.includes('!state.chatConversations.some((conversation) => conversation.friendshipId === result.conversation.friendshipId)'), 'fresh canonical conversations must not be overwritten by stale start response')
  assert(controller.includes('await showTopicsPersonalChat(result.conversation.friendshipId)'), 'successful start must open returned canonical friendshipId')
  assert(renderLobby.includes('activeConversation.friend.isVip === false'), 'counterpart VIP disabled state must require canonical false, not unknown/missing')
})

await check('[27] Direct Topics Personal block/VIP failures use safe Bulgarian UX', () => {
  assert(controller.includes('async function authorizeTopicsPersonalMessageTarget'), 'direct action must preflight protected profile authorization')
  assert(controller.includes('state.profileAccessBlockPopup = { profileId: recipientProfileId, code: result.code }'), 'blocked-by-viewer/target must render exact block popup')
  assert(mainSource.includes("case 'vip_required':"), 'vip_required must be mapped')
  assert(mainSource.includes('Личните съобщения към потребители извън приятелите са достъпни само за VIP.'), 'viewer VIP-required Bulgarian UX missing')
  assert(controller.includes("if (result.code === 'vip_required')"), 'new direct vip_required start must have dedicated Topics VIP gate branch')
  assert(controller.includes('openTopicsVipPopup()'), 'new direct vip_required start must reuse canonical Topics VIP popup')
  assert(controller.includes('void refreshTopicsVipGateStatus()'), 'new direct vip_required start must refresh canonical VIP gate state')
  assert(mainSource.includes("case 'vip_counterpart_required':"), 'vip_counterpart_required must be mapped')
  assert(mainSource.includes('Този потребител в момента не е активен VIP.'), 'counterpart inactive Bulgarian UX missing')
  assert(mainSource.includes("case 'blocked':"), 'blocked must be mapped')
  assert(mainSource.includes('code: data.code'), 'vip-dm/start code must be preserved for direct block popup mapping')
  assert(controller.includes('state.topicsInfoToast = { text: result.message }'), 'VIP failures must show Bulgarian UX in Topics without profile popup')
  const vipRequiredIndex = controller.indexOf("if (result.code === 'vip_required')")
  const vipPopupIndex = controller.indexOf('openTopicsVipPopup()', vipRequiredIndex)
  const toastIndex = controller.indexOf('state.topicsInfoToast = { text: result.message }', vipRequiredIndex)
  assert(vipRequiredIndex !== -1 && vipPopupIndex !== -1 && toastIndex !== -1 && vipRequiredIndex < vipPopupIndex && vipPopupIndex < toastIndex, 'vip_required must open VIP popup before generic transient toast branch')
})

await check('[28] Direct Personal button layout is mobile/desktop overflow-safe', () => {
  assert(renderTopics.includes('class="topic-message-author-row"'), 'author header row wrapper missing')
  assert(renderTopics.includes('class="topic-message-author-meta"'), 'author metadata wrapper missing')
  assert(renderTopics.includes('function renderTopicMetaRow'), 'root/thread/reply rows must share a dedicated meta/control row renderer')
  assert(renderTopics.includes('class="topic-root-meta-row"'), 'meta row class missing')
  assert(renderTopics.includes('class="topic-root-activity-time"'), 'relative time must have its own meta row slot')
  assert(renderTopics.includes('class="topic-root-meta-actions"'), 'meta actions wrapper missing')
  assert(!renderTopics.includes('showPersonalButton'), 'author header must never keep a Personal-button escape hatch, it always lives in the meta row')
  assert(renderTopics.includes('class="topic-message-personal-btn"'), 'Personal button class missing')
  assert(renderTopics.includes('topicsPersonalMessagePendingProfileId === senderProfileId'), 'Personal button must expose pending disabled state')
  assert(renderTopics.includes('.topic-message-personal-btn:disabled'), 'Personal button disabled style missing')
  assert(renderTopics.includes('.topic-root-card-has-unread .topic-message-author-row'), 'unread root cards must reserve header space for the top-right badge')
  assert(!renderTopics.includes('Активност:'), 'General root activity text must not include the Активност: prefix')
  assert(renderTopics.includes('overflow:hidden;text-overflow:ellipsis;white-space:nowrap'), 'author name must keep overflow guard')
  assert(renderTopics.includes('@media (hover: none) and (pointer: coarse)'), 'mobile touch media query must keep layout safe')
})

await check('[29] Direct Personal click is one-flight guarded and survives rerender without duplicate start', () => {
  assert(controller.includes('if (state.topicsPersonalMessagePendingProfileId !== null) return'), 'direct Personal click must be guarded while a previous click is pending')
  assert(controller.includes('state.topicsPersonalMessagePendingProfileId = recipientProfileId'), 'direct Personal click must mark the exact pending recipient')
  assert(controller.includes('finally {'), 'pending direct Personal click state must clear via finally')
  assert(controller.includes('state.topicsPersonalMessagePendingProfileId = null'), 'pending direct Personal click state must clear')
  assert(renderTopics.includes("${isPending ? 'disabled' : ''}"), 'pending direct Personal button must be disabled in DOM')
  const listenerOccurrences = (renderLobby.match(/querySelectorAll<HTMLButtonElement>\('\[data-topic-message-personal\]'\)/g) ?? []).length
  assert(listenerOccurrences === 1, 'direct Personal listener must be wired once per render')
})

await check('[30] Failed new Direct Personal start does not leave Personal detail/composer state sticky', () => {
  assert(controller.includes('function clearTopicsPersonalTransientState'), 'missing Topics Personal transient cleanup helper')
  assert(controller.includes('state.chatErrorText = null'), 'cleanup must clear chat error text')
  assert(controller.includes('state.chatLoading = false'), 'cleanup must clear chat loading state')
  assert(controller.includes('state.chatMessagesLoading = false'), 'cleanup must clear chat message loading state')
  assert(controller.includes('state.topicsInfoToast = null'), 'returning to Topics stream must clear stale transient inline toast')
  assert(controller.includes("state.topicsMode = 'topics'"), 'cleanup must run on Topics stream/list return paths')
  assert(controller.includes("state.topicsPersonalView = 'list'"), 'returning to Topics must leave Personal detail view')
})

await check('[31] Thread root header and thread replies move Personal/edit controls into the shared meta row without duplicating them', () => {
  const baseState = createRenderState()

  const foreignThreadRoot = {
    seq: 1,
    messageId: 'thread-root-foreign',
    topicId: 'topic-general',
    parentMessageId: null,
    senderProfileId: 'other-profile',
    senderDisplayName: 'Other Player',
    senderAvatarUrl: null,
    senderRole: 'player',
    body: 'THREAD_ROOT_FOREIGN',
    createdAt: '2026-08-12T09:00:00.000Z',
    lastActivityAt: '2026-08-12T09:05:00.000Z',
    unreadCount: 0,
    deletedAt: null,
    editedAt: null,
    attachment: null,
    replyCount: 1,
    likeCount: 0,
    viewerHasLiked: false,
  }
  const foreignRootHtml = renderTopicMessageRow(baseState, foreignThreadRoot as any, { variant: 'thread' })
  const foreignRootMetaIndex = foreignRootHtml.indexOf('class="topic-root-meta-row"')
  assert(foreignRootMetaIndex !== -1, 'thread root must render the shared meta row')
  assert((foreignRootHtml.match(/Лично<\/button>/g) ?? []).length === 1, '[G] thread root Personal button must not be duplicated')
  assert(foreignRootHtml.indexOf('Лично</button>') > foreignRootMetaIndex, '[B] thread root Personal button for foreign author must live inside the meta row, not the header')
  assert(!foreignRootHtml.includes('data-topic-message-edit="thread-root-foreign"'), 'foreign thread root must not expose an owner edit pencil')
  assert(!foreignRootHtml.slice(0, foreignRootMetaIndex).includes('Лично'), '[A] thread root header must not render Personal even for a foreign author')

  const ownThreadRoot = { ...foreignThreadRoot, messageId: 'thread-root-own', senderProfileId: 'viewer', senderDisplayName: 'Viewer', createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), replyCount: 0 }
  const ownRootHtml = renderTopicMessageRow(baseState, ownThreadRoot as any, { variant: 'thread' })
  const ownRootMetaIndex = ownRootHtml.indexOf('class="topic-root-meta-row"')
  assert(!ownRootHtml.includes('Лично'), '[A] own thread root must never show Personal, in header or meta row')
  assert(!ownRootHtml.slice(0, ownRootMetaIndex).includes('data-topic-message-edit='), 'thread root header must not render the edit pencil, only the meta row does')
  const ownRootPencilIndex = ownRootHtml.indexOf('data-topic-message-edit="thread-root-own"')
  assert(ownRootPencilIndex !== -1 && ownRootPencilIndex > ownRootMetaIndex, 'own thread root edit pencil must live in the meta row when allowed')
  assert((ownRootHtml.match(/data-topic-message-edit="thread-root-own"/g) ?? []).length === 1, '[G] thread root edit pencil must not be duplicated')

  const foreignReply = {
    seq: 2,
    messageId: 'reply-foreign',
    topicId: 'topic-general',
    parentMessageId: 'thread-root-foreign',
    senderProfileId: 'other-profile',
    senderDisplayName: 'Other Player',
    senderAvatarUrl: null,
    senderRole: 'player',
    body: 'REPLY_FOREIGN',
    createdAt: '2026-08-12T09:10:00.000Z',
    editedAt: null,
    likeCount: 0,
    viewerHasLiked: false,
    attachment: null,
  }
  const foreignReplyHtml = renderTopicReplyRow(baseState, foreignReply as any)
  const foreignReplyMetaIndex = foreignReplyHtml.indexOf('class="topic-root-meta-row"')
  assert(foreignReplyMetaIndex !== -1, 'reply must render the shared meta row')
  assert((foreignReplyHtml.match(/Лично<\/button>/g) ?? []).length === 1, '[G] reply Personal button must not be duplicated')
  assert(foreignReplyHtml.indexOf('Лично</button>') > foreignReplyMetaIndex, '[D] foreign reply Personal button must live in the meta row')
  assert(!foreignReplyHtml.slice(0, foreignReplyMetaIndex).includes('Лично'), '[C] reply header must not render Personal even for a foreign author')
  assert(!foreignReplyHtml.includes('data-topic-message-edit="reply-foreign"'), 'foreign reply must not expose an owner edit pencil')

  const ownReply = { ...foreignReply, messageId: 'reply-own', senderProfileId: 'viewer', senderDisplayName: 'Viewer', createdAt: new Date().toISOString() }
  const ownReplyHtml = renderTopicReplyRow(baseState, ownReply as any)
  const ownReplyMetaIndex = ownReplyHtml.indexOf('class="topic-root-meta-row"')
  assert(!ownReplyHtml.includes('Лично'), '[E] own reply must never show Personal')
  assert(!ownReplyHtml.slice(0, ownReplyMetaIndex).includes('data-topic-message-edit='), 'reply header must not render the edit pencil, only the meta row does')
  const ownReplyPencilIndex = ownReplyHtml.indexOf('data-topic-message-edit="reply-own"')
  assert(ownReplyPencilIndex !== -1 && ownReplyPencilIndex > ownReplyMetaIndex, '[F] own editable reply must show the edit pencil inside the meta row')
  assert((ownReplyHtml.match(/data-topic-message-edit="reply-own"/g) ?? []).length === 1, '[G] reply edit pencil must not be duplicated')
})

await check('[32] Denied pencil toast UX ([H]) is unaffected by moving the pencil into the meta row', () => {
  assert(renderTopics.includes('data-topic-message-edit-blocked="1"'), 'blocked edit data attribute missing')
  assert(renderTopics.includes('data-topic-message-edit-denied-reason'), 'blocked edit denied reason data attribute missing')
  assert(renderLobby.includes('options.onTopicsInfoToast(reason)'), 'blocked edit click must still open the canonical Topics toast')
  assert(controller.includes('function showTopicsInfoToast(text: string): void'), 'controller must still expose the canonical Topics toast helper')
})

// [33] Empty vip_dm rows (0 messages) must never appear as a Personal list row,
// while remaining fully usable as the active detail/compose context — this is
// the client-only fix for empty "Лично" conversations leaking into the list.
// See §1-§8 of the audit: only the render-time list collection is filtered,
// state.chatConversations (canonical) and detail resolution stay untouched.

await check('[33a] Existing empty vip_dm (lastMessage=null) is not rendered as a Personal list row', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    chatConversations: [{
      friendshipId: 'empty-vip-dm',
      kind: 'vip_dm',
      friend: { profileId: 'empty-friend', displayName: 'EmptyPerson', avatarUrl: null },
      lastMessage: null,
      updatedAt: '2026-08-12T10:00:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    activeChatFriendshipId: null,
  }))

  assert(!html.includes('EmptyPerson'), 'empty vip_dm (0 messages) must not render as a Personal list row')
  assert(html.includes('data-topics-personal-empty="1"'), 'list must fall back to the empty-state placeholder when only empty vip_dm rows exist')
})

await check('[33b] vip_dm with at least one message renders normally in the Personal list', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    chatConversations: [{
      friendshipId: 'friend-b',
      kind: 'vip_dm',
      friend: { profileId: 'friend-profile', displayName: 'Mimojef', avatarUrl: null },
      lastMessage: {
        messageId: 'personal-b',
        friendshipId: 'friend-b',
        senderProfileId: 'friend-profile',
        body: 'REAL_MESSAGE',
        createdAt: '2026-08-12T10:00:00.000Z',
        isOwnMessage: false,
        attachment: null,
      },
      updatedAt: '2026-08-12T10:00:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    activeChatFriendshipId: null,
  }))

  assert(html.includes('Mimojef'), 'vip_dm with a real message must render as a Personal list row')
  assert(!html.includes('data-topics-personal-empty="1"'), 'list must not show the empty-state placeholder when a real conversation exists')
})

await check('[33c] Fresh "Лично" start (empty vip_dm) opens detail/composer without appearing in the left list', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'conversation',
    chatConversations: [{
      friendshipId: 'fresh-vip-dm',
      kind: 'vip_dm',
      friend: { profileId: 'fresh-friend', displayName: 'FreshTarget', avatarUrl: null },
      lastMessage: null,
      updatedAt: '2026-08-12T11:00:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    activeChatFriendshipId: 'fresh-vip-dm',
    chatMessages: [],
    chatMessagesFriendshipId: 'fresh-vip-dm',
  }))

  assert(html.includes('data-topics-personal-detail="1"'), 'detail panel must render')
  assert(html.includes('FreshTarget'), 'fresh empty vip_dm must still resolve as the active detail conversation (full collection, not filtered)')
  assert(!html.includes('data-topics-personal-row="1"'), 'fresh empty vip_dm must not be rendered as a left-list row')
})

await check('[33d] Back without send leaves no empty row behind (list view shows empty state again)', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    chatConversations: [{
      friendshipId: 'fresh-vip-dm',
      kind: 'vip_dm',
      friend: { profileId: 'fresh-friend', displayName: 'FreshTarget', avatarUrl: null },
      lastMessage: null,
      updatedAt: '2026-08-12T11:00:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    activeChatFriendshipId: 'fresh-vip-dm',
  }))

  assert(!html.includes('data-topics-personal-row="1"'), 'navigating back to the list without sending must not leave a visible empty row')
  assert(html.includes('data-topics-personal-empty="1"'), 'list must show the standard empty state, not a phantom conversation row')
})

await check('[33e] After first send, the conversation appears in the list with the real lastMessage', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    chatConversations: [{
      friendshipId: 'fresh-vip-dm',
      kind: 'vip_dm',
      friend: { profileId: 'fresh-friend', displayName: 'FreshTarget', avatarUrl: null },
      lastMessage: {
        messageId: 'first-message',
        friendshipId: 'fresh-vip-dm',
        senderProfileId: 'viewer',
        body: 'FIRST_SENT_MESSAGE',
        createdAt: '2026-08-12T11:05:00.000Z',
        isOwnMessage: true,
        attachment: null,
      },
      updatedAt: '2026-08-12T11:05:00.000Z',
      unreadCount: 0,
      isArchived: false,
    }],
    activeChatFriendshipId: 'fresh-vip-dm',
  }))

  assert(html.includes('FreshTarget'), 'conversation must appear as a list row immediately once lastMessage is non-null')
  assert(html.includes('FIRST_SENT_MESSAGE'), 'list row preview must reflect the real sent message')
})

await check('[33f] Same pair with friend + empty vip_dm: friend stays out of Topics Personal, empty vip_dm stays out of the list', () => {
  const html = renderTopicsScreen(createRenderState({
    topicsMode: 'personal',
    topicsPersonalView: 'list',
    chatConversations: [
      {
        friendshipId: 'friend-row',
        kind: 'friend',
        friend: { profileId: 'shared-profile', displayName: 'SharedFriend', avatarUrl: null },
        lastMessage: null,
        updatedAt: '2026-08-12T09:00:00.000Z',
        unreadCount: 0,
        isArchived: false,
      },
      {
        friendshipId: 'shared-vip-dm',
        kind: 'vip_dm',
        friend: { profileId: 'shared-profile', displayName: 'SharedFriend', avatarUrl: null },
        lastMessage: null,
        updatedAt: '2026-08-12T09:00:00.000Z',
        unreadCount: 0,
        isArchived: false,
      },
    ],
    activeChatFriendshipId: null,
  }))

  assert(!html.includes('SharedFriend'), 'neither the friend row (wrong surface) nor the empty vip_dm (0 messages) should render in Topics Personal list')
  assert(html.includes('data-topics-personal-empty="1"'), 'list must show the empty state, unaffected by the coexisting friend conversation')
})

await check('[33g] pika_support is unaffected by the empty vip_dm visibility filter', () => {
  assert(!renderLobby.includes("kind === 'pika_support' && conversation.lastMessage"), 'pika_support list logic must not gain a message-existence filter')
  const supportPanelSource = renderLobby.slice(renderLobby.indexOf('function renderChatPanel'), renderLobby.indexOf('export function renderPlayersDirectory'))
  assert(!supportPanelSource.includes('visiblePersonalConversations'), 'legacy Chat/pika_support panel must not use the new Topics Personal visibility filter')
})

await check('[33h] Notification routing (openChatWithFriend) still resolves vip_dm conversations by canonical friendshipId, unaffected by the list-visibility filter', () => {
  const openFn = controller.slice(controller.indexOf('openChatWithFriend: (friendshipId: string) => {'), controller.indexOf('getFriendshipActionForProfile: (profileId: string) => {'))
  assert(openFn.includes('state.chatConversations.find((c) => c.friendshipId === friendshipId)'), 'notification routing must still look up the canonical conversation from full state.chatConversations, not a filtered/visible subset')
  assert(!openFn.includes('visiblePersonalConversations'), 'notification routing must not depend on the render-only visible list')
})

await check('[33i] Personal list rendering isolates a full identity/detail collection from the filtered visible-rows collection', () => {
  assert(renderLobby.includes('const personalConversations = state.chatConversations'), 'full vip_dm collection must still be derived from canonical state.chatConversations')
  assert(renderLobby.includes('const visiblePersonalConversations = personalConversations.filter('), 'visible rows must be a filtered derivative of the full collection, not a second independent query')
  assert(renderLobby.includes("conversation.lastMessage !== null"), 'visibility filter must key off lastMessage presence, matching the locked product rule')
  assert(renderLobby.includes('personalConversations.find((conversation) => conversation.friendshipId === state.activeChatFriendshipId)'), 'active/detail conversation resolution must use the full collection so a fresh empty vip_dm still opens')
  assert(renderLobby.includes('visiblePersonalConversations.map((conversation) => renderTopicsPersonalConversationRow'), 'left-list rows must be rendered from the filtered visible collection only')
})

console.log('PASS topics personal integration client checks')

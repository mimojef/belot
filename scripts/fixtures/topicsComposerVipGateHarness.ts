// Браузърна тестова "сглобка" (fixture) за checkTopicsComposerVipGate.ts.
//
// Кара реалния createLobbyFlowController + renderLobbyScreen (същия production
// код, зареден през Vite dev server, БЕЗ jsdom) в истински браузър (Playwright),
// със stub-нати мрежови/WS callback-ове вместо реален backend. Огледално на
// topicsSwitchRaceHarness.ts (виж него за rationale на подхода), но фокусиран
// върху Етап 2: composer/VIP gate/realtime merge поведение.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { TopicSnapshot, TopicMessageSnapshot, TopicReplySnapshot, ServerMessage } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const topics: TopicSnapshot[] = [
  { topicId: 'topic-general', slug: 'general', title: 'Общ чат', description: null, isGeneral: true, createdByProfileId: null, status: 'active', sortOrder: 0, createdAt: new Date().toISOString(), unreadCount: 0 },
  { topicId: 'topic-b', slug: 'topic-b', title: 'Тема Б', description: null, isGeneral: false, createdByProfileId: null, status: 'active', sortOrder: 1, createdAt: new Date().toISOString(), unreadCount: 0 },
]

function makeMessage(topicId: string, seq: number, body: string, senderProfileId = 'someone', senderDisplayName = 'Someone'): TopicMessageSnapshot {
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
    createdAt: new Date().toISOString(),
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
let claimResult: { ok: true; isActive: boolean } | { ok: false; alreadyClaimed: boolean } = { ok: true, isActive: true }
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
let vipGateCallCount = 0
let claimCallCount = 0

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  onTopicsLoad: async () => ({ ok: true, topics }),
  onTopicMessagesLoad: async (_topicId: string, _beforeSeq: number | null) => nextMessagesResult,
  onTopicMessagesSubscribe: (topicId: string, afterSeq: number) => {
    subscribeLog.push({ topicId, afterSeq })
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
      oldestSeq: messages.length > 0 ? messages[0]!.seq : null,
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
  makeMessage,
  makeReply,
  getSubscribeLog: () => subscribeLog,
  getUnsubscribeLog: () => unsubscribeLog,
  getSendLog: () => sendLog,
  getReplySendLog: () => replySendLog,
  getLikeToggleLog: () => likeToggleLog,
  getRepliesLoadLog: () => repliesLoadLog,
  getVipGateCallCount: () => vipGateCallCount,
  getClaimCallCount: () => claimCallCount,
  clickReplyButton: (rootMessageId: string) => q<HTMLButtonElement>(`[data-topic-message-reply="${rootMessageId}"]`)?.click(),
  clickLikeButton: (messageId: string) => q<HTMLButtonElement>(`[data-topic-message-like="${messageId}"]`)?.click(),
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
    const icon = btn.querySelector('.topic-message-action-icon')?.textContent ?? ''
    const countEl = btn.querySelector('.topic-message-action-count')
    return {
      pressed: btn.getAttribute('aria-pressed'),
      liked: icon.includes('♥'),
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
  setMessagesScrollTop: (value: number) => {
    const el = q<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (el) el.scrollTop = value
  },
}

// "Персонализация", Етап 3 — browser harness (checkProfileCustomizationDisplayUi.ts).
// Рендерира с РЕАЛНИТЕ production функции: редове в Лафче, публикации и
// отговори в Теми, личния VIP чат (десктоп) и светлия мобилен чат, плюс
// попъпа след Stripe. Данните са synthetic (сървърът е покрит от
// server/scripts/checkProfileCustomizationCheckoutWebhookHttp.ts и
// checkProfileCustomizationRealtimeWs.ts).
import { renderLafcheMessageRow, renderTopicMessageRow, renderTopicReplyRow } from '/src/app/lobby/renderTopicsScreen.ts'
import { renderLightMobileChatConversation, renderTopicsPersonalChatPanel } from '/src/app/lobby/renderLobbyScreen.ts'
import { setProfileCustomizationExpiryHandler } from '/src/app/profileCustomization/customizationDisplay.ts'
import {
  getPendingProfileCustomizationCheckout,
  rememberPendingProfileCustomizationCheckout,
  showProfileCustomizationPurchasePopup,
  wasProfileCustomizationResultShown,
} from '/src/app/profileCustomization/showProfileCustomizationPurchasePopup.ts'

// Минимален LobbyScreenState: липсващите полета получават неутрални стойности.
function makeState(overrides: Record<string, unknown> = {}): any {
  const base: Record<string, unknown> = {
    profile: { profileId: 'viewer', displayName: 'Зрител', isVip: true },
    apiBaseUrl: '',
    topicMessages: [],
    topicRepliesByRootId: {},
    chatMessages: [],
    chatUploadingFriendshipIds: new Set(),
    chatMessagesLoading: false,
    topicsVipGate: { isActive: true },
    ...overrides,
  }
  return new Proxy(base, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (key in target) return target[key]
      if (/(Ids|Set)$/.test(key)) return new Set()
      if (/By[A-Z]\w*$/.test(key)) return {}
      return undefined
    },
  })
}

let renderCount = 0
let lastRender: (() => void) | null = null
setProfileCustomizationExpiryHandler(() => {
  renderCount += 1
  lastRender?.()
})

const container = () => document.getElementById('rows') as HTMLElement

;(window as any).__displayHarness = {
  renderTopics(messages: any[]) {
    lastRender = () => {
      const state = makeState()
      container().innerHTML = messages.map((m) => `<section data-case="${m.case}">
        <div data-kind="lafche">${renderLafcheMessageRow(state, m)}</div>
        <div data-kind="root">${renderTopicMessageRow(state, m)}</div>
        <div data-kind="reply">${renderTopicReplyRow(state, { ...m, parentMessageId: 'root' })}</div>
      </section>`).join('')
    }
    lastRender()
  },
  renderPersonalChat(conversation: any, messages: any[]) {
    lastRender = () => {
      const state = makeState({
        topicsMode: 'personal',
        topicsPersonalView: 'conversation',
        chatConversations: [conversation],
        activeChatFriendshipId: conversation.friendshipId,
        chatMessagesFriendshipId: conversation.friendshipId,
        chatMessages: messages,
      })
      container().innerHTML = `<div data-kind="desktop-chat">${renderTopicsPersonalChatPanel(state)}</div>
        <div data-kind="mobile-chat">${renderLightMobileChatConversation(state, conversation, true, '')}</div>`
    }
    lastRender()
  },
  renderCount: () => renderCount,
  showPopup(checkoutSessionId: string | null, theme: 'dark' | 'light', role: string | null = null) {
    showProfileCustomizationPurchasePopup({ getApiBaseUrl: () => '', checkoutSessionId, displayName: 'Мишо', nameHighlightRole: role, theme })
  },
  rememberPending: (id: string) => rememberPendingProfileCustomizationCheckout(id),
  getPending: () => getPendingProfileCustomizationCheckout(),
  wasShown: (id: string) => wasProfileCustomizationResultShown(id),
}

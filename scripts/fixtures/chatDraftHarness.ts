// Браузърна тестова "сглобка" (fixture) за checkChatDraftPreserved.ts.
//
// Кара реалния createLobbyFlowController + renderLobbyScreen (същия production
// код, зареден през Vite dev server, БЕЗ jsdom) в истински браузър (Playwright),
// но със stub-нати мрежови callback-ове вместо реален backend — бъгът, който
// проверяваме, е чисто client-side (re-render изтрива недовършена чернова) и
// не зависи от реален сървър/WebSocket.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type {
  ChatConversationSnapshot,
  ChatMessageSnapshot,
  SupportMessageSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const friendA = {
  profileId: 'friend-a',
  displayName: 'Anna',
  avatarUrl: null,
  isOnline: true,
} as any

const friendB = {
  profileId: 'friend-b',
  displayName: 'Boris',
  avatarUrl: null,
  isOnline: true,
} as any

const messagesByFriendship: Record<string, ChatMessageSnapshot[]> = {
  'friendship-a': [],
  'friendship-b': [],
}

function makeConversation(
  friendshipId: string,
  friend: any,
  unreadCount: number,
): ChatConversationSnapshot {
  const msgs = messagesByFriendship[friendshipId] ?? []
  const last = msgs[msgs.length - 1] ?? null
  return {
    friendshipId,
    friend,
    lastMessage: last,
    updatedAt: new Date().toISOString(),
    unreadCount,
  }
}

let unreadByFriendship: Record<string, number> = {
  'friendship-a': 0,
  'friendship-b': 0,
}
let lobbyChatSeq = 0
const personalSentBodies: string[] = []
const supportSentBodies: string[] = []
let delayNextPersonalSend = false
let delayedPersonalSend: {
  friendshipId: string
  resolve: (value: { ok: true; messages: ChatMessageSnapshot[]; conversation: ChatConversationSnapshot }) => void
} | null = null
const supportMessages: SupportMessageSnapshot[] = Array.from({ length: 16 }, (_, index) => ({
  messageId: `support-${index + 1}`,
  profileId: 'me',
  body: `Support history ${index + 1}`,
  isFromAdmin: index % 2 === 0,
  createdAt: new Date(2026, 7, 3, 10, index).toISOString(),
  attachment: null,
}))

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
  onChatConversationsLoad: async () => ({
    ok: true,
    conversations: [
      makeConversation('friendship-a', friendA, unreadByFriendship['friendship-a']),
      makeConversation('friendship-b', friendB, unreadByFriendship['friendship-b']),
    ],
  }),
  onChatMessagesLoad: async (friendshipId: string) => ({
    ok: true,
    messages: messagesByFriendship[friendshipId] ?? [],
  }),
  onChatSend: async (friendshipId: string, body: string) => {
    // Тестова кука за симулиране на неуспешно изпращане (мрежова/сървърна грешка) —
    // без реален backend, само маркерен string в тялото на съобщението.
    if (body.includes('__FAIL_SEND__')) {
      return { ok: false, message: 'Симулирана грешка при изпращане.' }
    }
    personalSentBodies.push(body)
    const message: ChatMessageSnapshot = {
      messageId: `own-${Date.now()}-${Math.random()}`,
      friendshipId,
      senderProfileId: 'me',
      body,
      createdAt: new Date().toISOString(),
      isOwnMessage: true,
    }
    messagesByFriendship[friendshipId] = [...(messagesByFriendship[friendshipId] ?? []), message]
    const friend = friendshipId === 'friendship-a' ? friendA : friendB
    if (delayNextPersonalSend) {
      delayNextPersonalSend = false
      return await new Promise((resolve) => {
        delayedPersonalSend = {
          friendshipId,
          resolve,
        }
      })
    }
    return {
      ok: true,
      messages: messagesByFriendship[friendshipId],
      conversation: makeConversation(friendshipId, friend, unreadByFriendship[friendshipId] ?? 0),
    }
  },
  onChatMarkRead: async (friendshipId: string) => {
    unreadByFriendship[friendshipId] = 0
  },
  onSupportMessagesLoad: async () => ({
    ok: true,
    messages: supportMessages,
  }),
  onSupportSend: async (body: string) => {
    if (body.includes('__FAIL_SUPPORT__')) {
      return { ok: false, message: 'Simulated support send failure.' }
    }
    supportSentBodies.push(body)
    return {
      ok: true,
      messages: [
        ...supportMessages,
        {
          messageId: `support-own-${Date.now()}`,
          profileId: 'me',
          body,
          isFromAdmin: false,
          createdAt: new Date().toISOString(),
          attachment: null,
        },
      ],
    }
  },
})

// ─── Тестова кука, извиквана от Playwright през page.evaluate ───────────────
;(window as any).__chatDraftHarness = {
  controller,
  openConversation: (friendshipId: string) => {
    controller.openChatWithFriend(friendshipId)
  },
  getPersonalSentBodies: () => personalSentBodies,
  getSupportSentBodies: () => supportSentBodies,
  delayNextPersonalSend: () => {
    delayNextPersonalSend = true
  },
  resolveDelayedPersonalSend: () => {
    if (delayedPersonalSend === null) return
    const pending = delayedPersonalSend
    delayedPersonalSend = null
    const friend = pending.friendshipId === 'friendship-a' ? friendA : friendB
    pending.resolve({
      ok: true,
      messages: messagesByFriendship[pending.friendshipId] ?? [],
      conversation: makeConversation(pending.friendshipId, friend, unreadByFriendship[pending.friendshipId] ?? 0),
    })
  },
  // Симулира реално входящо съобщение от отсрещния потребител — по същия
  // път, по който main.ts подава реални WS 'chat_message_received' кадри.
  deliverIncomingMessage: (friendshipId: string, body: string) => {
    const message: ChatMessageSnapshot = {
      messageId: `srv-${Date.now()}-${Math.random()}`,
      friendshipId,
      senderProfileId: friendshipId === 'friendship-a' ? 'friend-a' : 'friend-b',
      body,
      createdAt: new Date().toISOString(),
      isOwnMessage: false,
    }
    messagesByFriendship[friendshipId] = [...(messagesByFriendship[friendshipId] ?? []), message]
    if (!controller.isConversationOpen(friendshipId)) {
      unreadByFriendship[friendshipId] = (unreadByFriendship[friendshipId] ?? 0) + 1
    }
    controller.handleServerMessage({ type: 'chat_message_received', friendshipId } as any)
  },
  // Симулира фоново обновяване, несвързано със самия чат (напр. admin-info
  // /api/auth/me polling tick, unread badge refresh) — просто предизвиква
  // пълен render() без да пипа chat state-а изобщо.
  triggerUnrelatedBackgroundRender: () => {
    controller.render()
  },
  openLobbyChat: () => {
    controller.resetToLobby()
    controller.setConnected(true)
    controller.render()
  },
  deliverLobbyChatMessage: (body: string) => {
    lobbyChatSeq++
    controller.handleServerMessage({
      type: 'lobby_chat_message',
      seq: lobbyChatSeq,
      messageId: `lobby-${Date.now()}-${Math.random()}`,
      senderProfileId: 'other-player',
      senderDisplayName: 'Other Player',
      senderIsChatAdmin: false,
      senderRole: 'player',
      body,
      createdAt: new Date().toISOString(),
    } as any)
  },
  setLobbyChatFullscreenViaDom: (value: boolean) => {
    const isFullscreen = document.querySelector('[data-lobby-livechat-fullscreen="1"]') !== null
    if (isFullscreen === value) return
    document.querySelector<HTMLButtonElement>('[data-lobby-livechat-fullscreen-toggle="1"]')?.click()
  },
  openSupportPopup: async () => {
    controller.resetToLobby()
    controller.setConnected(true)
    controller.render()
    document.querySelector<HTMLButtonElement>('[data-lobby-nav-support="1"]')?.click()
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('[data-support-send-form="1"] textarea[name="body"]') !== null) return
      await new Promise((resolve) => window.setTimeout(resolve, 16))
    }
  },
}

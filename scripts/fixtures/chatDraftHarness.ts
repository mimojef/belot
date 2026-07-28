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

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
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
    return {
      ok: true,
      messages: messagesByFriendship[friendshipId],
      conversation: makeConversation(friendshipId, friend, unreadByFriendship[friendshipId] ?? 0),
    }
  },
  onChatMarkRead: async (friendshipId: string) => {
    unreadByFriendship[friendshipId] = 0
  },
})

// ─── Тестова кука, извиквана от Playwright през page.evaluate ───────────────
;(window as any).__chatDraftHarness = {
  controller,
  openConversation: (friendshipId: string) => {
    controller.openChatWithFriend(friendshipId)
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
}

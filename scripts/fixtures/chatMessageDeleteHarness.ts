// Браузърна тестова "сглобка" за checkPersonalChatMessageDeleteBrowser.ts.
//
// Реалният createLobbyFlowController + renderLobbyScreen (production код през
// Vite dev server) в истински браузър (Playwright), със stub-нати мрежови
// callback-ове — по модела на chatDraftHarness.ts. Сървърната сигурност на
// изтриването се проверява отделно (server/scripts/checkPersonalChatOwnMessageDelete.ts).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { ChatConversationSnapshot, ChatMessageSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const friend = { profileId: 'friend-a', displayName: 'Anna', avatarUrl: null, isOnline: true } as any

function message(messageId: string, own: boolean, body: string, minutesAgo: number): ChatMessageSnapshot {
  return {
    messageId,
    friendshipId: 'friendship-a',
    senderProfileId: own ? 'me' : 'friend-a',
    body,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    isOwnMessage: own,
    attachment: null,
  } as ChatMessageSnapshot
}

// „Сървърното“ състояние на разговора.
let serverMessages: ChatMessageSnapshot[] = [
  message('own-old', true, 'Моето старо съобщение', 600),
  message('their-1', false, 'Съобщение от Anna', 30),
  message('own-fail', true, 'Това изтриване ще се провали', 20),
  message('own-tab', true, 'Изтрито от друг таб', 10),
  message('own-silent', true, 'Изтрито, докато нямаше връзка', 5),
  message('own-last', true, 'Последното ми съобщение', 1),
]
const deleteCalls: Array<{ friendshipId: string; messageId: string }> = []

function conversation(): ChatConversationSnapshot {
  return {
    friendshipId: 'friendship-a',
    kind: 'friend',
    friend,
    lastMessage: serverMessages[serverMessages.length - 1] ?? null,
    updatedAt: new Date().toISOString(),
    unreadCount: 0,
    isArchived: false,
  } as ChatConversationSnapshot
}

let holdNextHistory = false
let releaseHistory: (() => void) | null = null
let holdNextConversations = false
let releaseConversations: (() => void) | null = null

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  onLobbyChatSend: () => {},
  getAuthSession: () => ({ account: { role: 'player' }, profile: { profileId: 'me', displayName: 'Me' } as any }),
  onChatConversationsLoad: async () => {
    const result = { ok: true, conversations: [conversation()] }
    if (holdNextConversations) {
      holdNextConversations = false
      await new Promise<void>((resolve) => { releaseConversations = resolve })
    }
    return result
  },
  onChatMessagesLoad: async () => {
    const result = { ok: true, messages: [...serverMessages], hasMore: false }
    if (holdNextHistory) {
      holdNextHistory = false
      await new Promise<void>((resolve) => { releaseHistory = resolve })
    }
    return result
  },
  onChatMarkRead: async () => {},
  onChatMessageDelete: async (friendshipId: string, messageId: string) => {
    deleteCalls.push({ friendshipId, messageId })
    if (messageId === 'own-fail') return { ok: false, message: 'Симулирана грешка при изтриване.' }
    serverMessages = serverMessages.filter((m) => m.messageId !== messageId)
    return { ok: true, conversation: conversation() }
  },
} as any)

;(window as any).__chatDeleteHarness = {
  openConversation: () => {
    controller.setConnected(true)
    controller.openChatWithFriend('friendship-a')
  },
  getDeleteCalls: () => deleteCalls,
  getServerMessageIds: () => serverMessages.map((m) => m.messageId),
  holdHistoryRefresh: () => {
    holdNextHistory = true
    controller.refreshOpenPersonalChatAfterReconnect()
  },
  hasHeldHistory: () => releaseHistory !== null,
  releaseHistory: () => { releaseHistory?.(); releaseHistory = null },
  holdConversationRefresh: () => {
    holdNextConversations = true
    controller.refreshOpenPersonalChatAfterReconnect()
  },
  hasHeldConversations: () => releaseConversations !== null,
  releaseConversations: () => { releaseConversations?.(); releaseConversations = null },
  // Изтриване от друг таб/сесия: сървърът го е премахнал и праща WS събитие.
  deleteFromOtherTab: (messageId: string) => {
    serverMessages = serverMessages.filter((m) => m.messageId !== messageId)
    controller.handleServerMessage({ type: 'chat_message_deleted', friendshipId: 'friendship-a', messageId } as any)
  },
  // Изтриване, чието WS събитие е пропуснато (прекъсната връзка), последвано
  // от ново входящо съобщение → refresh трябва да съгласува изтритото.
  deleteSilentlyThenIncoming: (messageId: string) => {
    serverMessages = serverMessages.filter((m) => m.messageId !== messageId)
    serverMessages = [...serverMessages, message(`their-${Date.now()}`, false, 'Ново от Anna', 0)]
    controller.handleServerMessage({ type: 'chat_message_received', friendshipId: 'friendship-a' } as any)
  },
}

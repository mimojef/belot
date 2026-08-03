import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type {
  SupportConversationSnapshot,
  SupportMessageSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const sentBodies: string[] = []
let delayNextReply = false
let delayedReply: {
  profileId: string
  body: string
  resolve: (value: { ok: true; messages: SupportMessageSnapshot[] }) => void
} | null = null

const conversations: SupportConversationSnapshot[] = [
  {
    profileId: 'user-profile',
    displayName: 'Support User',
    avatarUrl: null,
    lastMessageBody: 'Needs help',
    lastMessageIsFromAdmin: false,
    unreadByAdmin: 1,
    updatedAt: new Date('2026-08-03T10:00:00Z').toISOString(),
  },
  {
    profileId: 'other-profile',
    displayName: 'Other User',
    avatarUrl: null,
    lastMessageBody: 'Other help',
    lastMessageIsFromAdmin: false,
    unreadByAdmin: 0,
    updatedAt: new Date('2026-08-03T10:01:00Z').toISOString(),
  },
]

const messagesByProfile: Record<string, SupportMessageSnapshot[]> = {
  'user-profile': Array.from({ length: 12 }, (_, index) => ({
    messageId: `user-message-${index + 1}`,
    profileId: 'user-profile',
    body: `Support history ${index + 1}`,
    isFromAdmin: index % 2 === 1,
    createdAt: new Date(2026, 7, 3, 10, index).toISOString(),
    attachment: null,
  })),
  'other-profile': [],
}

function appendAdminReply(profileId: string, body: string): SupportMessageSnapshot[] {
  const message: SupportMessageSnapshot = {
    messageId: `admin-reply-${Date.now()}-${Math.random()}`,
    profileId,
    body,
    isFromAdmin: true,
    createdAt: new Date().toISOString(),
    attachment: null,
  }
  messagesByProfile[profileId] = [...(messagesByProfile[profileId] ?? []), message]
  return messagesByProfile[profileId]
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'admin' },
    profile: { profileId: 'admin-profile', displayName: 'Admin' } as any,
  }),
  onAdminSupportConversationsLoad: async () => ({
    ok: true,
    conversations,
  }),
  onAdminSupportMessagesLoad: async (profileId: string) => ({
    ok: true,
    messages: messagesByProfile[profileId] ?? [],
  }),
  onAdminSupportReply: async (profileId: string, body: string) => {
    if (body.includes('__FAIL_ADMIN_SUPPORT__')) {
      return { ok: false, message: 'Simulated admin support failure.' }
    }
    sentBodies.push(body)
    const messages = appendAdminReply(profileId, body)
    if (delayNextReply) {
      delayNextReply = false
      return await new Promise((resolve) => {
        delayedReply = { profileId, body, resolve }
      })
    }
    return { ok: true, messages }
  },
})

;(window as any).__adminSupportHarness = {
  controller,
  openInbox: async () => {
    controller.render()
    const supportButton = document.querySelector<HTMLButtonElement>('[data-lobby-nav-support-users="1"]') ??
      document.querySelector<HTMLButtonElement>('[data-lobby-nav-support="1"]')
    supportButton?.click()
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('[data-admin-support-conv="user-profile"]') !== null) return
      await new Promise((resolve) => window.setTimeout(resolve, 16))
    }
  },
  openConversation: async (profileId: string) => {
    document.querySelector<HTMLButtonElement>(`[data-admin-support-conv="${CSS.escape(profileId)}"]`)?.click()
    for (let i = 0; i < 60; i++) {
      const form = document.querySelector<HTMLFormElement>(`[data-admin-support-reply-form="${CSS.escape(profileId)}"]`)
      if (form !== null) return
      await new Promise((resolve) => window.setTimeout(resolve, 16))
    }
  },
  getSentBodies: () => sentBodies,
  delayNextReply: () => {
    delayNextReply = true
  },
  resolveDelayedReply: () => {
    if (delayedReply === null) return
    const pending = delayedReply
    delayedReply = null
    pending.resolve({
      ok: true,
      messages: messagesByProfile[pending.profileId] ?? [],
    })
  },
}

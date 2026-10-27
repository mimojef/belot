// Browser fixture за checkPrivateRoomPartnerInviteUi.ts — като
// privateRoomRealWsHarness.ts (реален production lobby controller + реален
// WebSocket към реален backend), плюс "Покани партньор" callback-ите.
// Приятелите се подават от теста (setFriendships) — сървърът така или иначе
// проверява наново приятелство/онлайн/"играе" при invite_private_room_partner.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { __setBelotPrivateBotFillOverrideForTests } from '/src/app/lobby/privateRoomBotFillFeatureFlag.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let socket: WebSocket | null = null
const receivedFrames: any[] = []
const sentFrames: any[] = []

function send(message: Record<string, unknown>): void {
  sentFrames.push(message)
  socket?.send(JSON.stringify(message))
}

let localProfileId: string | null = null
let localDisplayName = 'Me'
let friendshipsSnapshot: any = { incomingPending: [], outgoingPending: [], friends: [] }

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () =>
    localProfileId === null
      ? null
      : {
          account: { role: 'player' },
          profile: { profileId: localProfileId, displayName: localDisplayName, level: 1, yellowCoinsBalance: 100_000 } as any,
        },
  // Формата "Нова маса" предлага само активните залози — сървърът проверява
  // наново (checkPrivateRoomStakeEligibility) при create_private_room.
  onMatchRoomsLoad: async () => ({ ok: true, rooms: [{ stakeAmount: 5000, minLevel: 1, prizeAmount: 0, isEnabled: true }] }),
  onPrivateRoomsOpen: () => send({ type: 'request_private_rooms_list' }),
  onPrivateRoomCreate: (stake, isLocked, waitMinutes, manualStart, humanTurnTimeoutMs, invitePartner) =>
    send({ type: 'create_private_room', stake, isLocked, waitMinutes, manualStart, humanTurnTimeoutMs, invitePartner }),
  onPrivateRoomJoinSlot: (privateRoomId, team, slotIndex) => send({ type: 'join_private_room', privateRoomId, team, slotIndex }),
  onPrivateRoomLeave: () => send({ type: 'leave_private_room' }),
  onPrivateRoomInviteRespond: (inviteId, accept) => send({ type: 'respond_private_room_invite', inviteId, accept }),
  onPrivateRoomPartnerInvite: (toProfileId) => send({ type: 'invite_private_room_partner', toProfileId }),
  onPrivateRoomPartnerInviteCancel: () => send({ type: 'cancel_private_room_partner_invite' }),
  onPrivateRoomAddBot: (team) => send({ type: 'add_bot_to_private_room_team', team }),
  onPrivateRoomRemoveBot: (team) => send({ type: 'remove_bot_from_private_room_team', team }),
  onPrivateRoomChatSubscribe: (privateRoomId) => send({ type: 'subscribe_private_room_chat', privateRoomId }),
  onPrivateRoomChatUnsubscribe: (privateRoomId) => send({ type: 'unsubscribe_private_room_chat', privateRoomId }),
  onPrivateRoomChatSend: (privateRoomId, body, requestId) => send({ type: 'send_private_room_chat_message', privateRoomId, body, requestId }),
  onFriendshipsLoad: async () => ({ ok: true, friendships: friendshipsSnapshot }),
})

;(window as any).__partnerHarness = {
  controller,
  setLocalProfile: (profileId: string, displayName: string) => {
    localProfileId = profileId
    localDisplayName = displayName
  },
  setFriendships: (friends: any[]) => {
    friendshipsSnapshot = { incomingPending: [], outgoingPending: [], friends }
  },
  connect: (url: string): Promise<void> => {
    return new Promise((resolveOpen, reject) => {
      socket = new WebSocket(url)
      socket.addEventListener('message', (ev) => {
        let msg: any
        try {
          msg = JSON.parse(ev.data as string)
        } catch {
          return
        }
        receivedFrames.push(msg)
        controller.handleServerMessage(msg)
      })
      socket.addEventListener('open', () => resolveOpen())
      socket.addEventListener('error', reject)
    })
  },
  send,
  render: () => controller.render(),
  // "Запълни с бот" е скрит в продукция (feature flag) — тестът го включва временно.
  setBotFillOverride: (value: boolean | undefined) => __setBelotPrivateBotFillOverrideForTests(value),
  openCreatePopup: async () => {
    controller.resetToLobby()
    // resetToLobby() стартира (async) зареждането на залозите.
    await new Promise((r) => setTimeout(r, 50))
    controller.navigateToPrivateRooms()
    root.querySelector<HTMLButtonElement>('[data-private-rooms-create-open="1"]')?.click()
  },
  getReceivedFrames: () => receivedFrames,
  getSentFrames: () => sentFrames,
  getCurrentScreen: () => controller.getCurrentScreen(),
}

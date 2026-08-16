// Browser fixture for checkPrivateRoomRealSecondProfileJoin.ts — unlike
// privateRoomWaitingHarness.ts (which stubs every network callback and only
// simulates server pushes via controller.handleServerMessage(...)), THIS
// harness wires the private-room callbacks to a REAL browser-native
// WebSocket connected to a REAL backend. It boots the exact same production
// code (createLobbyFlowController + renderPrivateRoomWaitingScreen +
// renderLobbyScreen) but exercises the genuine click -> callback -> WS send
// -> server -> WS response -> handleServerMessage -> re-render round trip,
// closing the gap that privateRoomWaitingHarness.ts's simulated-push design
// cannot cover (it can only prove DOM->callback wiring, never the actual
// network leg).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

type RecordedCall = { name: string; args: unknown[] }
const calls: RecordedCall[] = []
function record(name: string) {
  return (...args: unknown[]) => {
    calls.push({ name, args })
  }
}

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
          profile: { profileId: localProfileId, displayName: localDisplayName } as any,
        },
  onPrivateRoomsOpen: record('onPrivateRoomsOpen'),
  onPrivateRoomsClose: record('onPrivateRoomsClose'),
  onPrivateRoomCreate: (stake, isLocked) => send({ type: 'create_private_room', stake, isLocked }),
  onPrivateRoomJoinSlot: (privateRoomId, team, slotIndex) => send({ type: 'join_private_room', privateRoomId, team, slotIndex }),
  onPrivateRoomLeave: () => send({ type: 'leave_private_room' }),
  onPrivateRoomInvite: (toProfiles) => send({ type: 'invite_to_private_room', toProfiles }),
  onPrivateRoomInviteRespond: (inviteId, accept) => send({ type: 'respond_private_room_invite', inviteId, accept }),
  onPrivateRoomAddBot: (team) => send({ type: 'add_bot_to_private_room_team', team }),
  onPrivateRoomRemoveBot: (team) => send({ type: 'remove_bot_from_private_room_team', team }),
  onPrivateRoomChatSubscribe: (privateRoomId) => send({ type: 'subscribe_private_room_chat', privateRoomId }),
  onPrivateRoomChatUnsubscribe: (privateRoomId) => send({ type: 'unsubscribe_private_room_chat', privateRoomId }),
  onPrivateRoomChatSend: (privateRoomId, body, requestId) => send({ type: 'send_private_room_chat_message', privateRoomId, body, requestId }),
  onFriendshipsLoad: async () => ({ ok: true, friendships: friendshipsSnapshot }),
})

;(window as any).__diagHarness = {
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
  // Pure client-side preview navigation — real production method, no WS
  // send (mirrors clicking a room row in the list screen).
  previewRoom: (roomId: string) => controller.joinPrivateRoom(roomId),
  handleServerMessage: (msg: any) => controller.handleServerMessage(msg),
  getReceivedFrames: () => receivedFrames,
  getSentFrames: () => sentFrames,
  getCurrentScreen: () => controller.getCurrentScreen(),
  getCalls: () => calls,
  destroy: () => controller.destroy(),
}

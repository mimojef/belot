// Браузърна тестова "сглобка" (fixture) за
// checkPrivateRoomWaitingMobile.ts — кара реалния production код
// (createLobbyFlowController + renderPrivateRoomWaitingScreen +
// renderLobbyScreen), зареден през Vite dev server (без build, без jsdom),
// в истински браузър (Playwright). Мрежовите callback-ове са stub-нати
// (записват какво е извикано); server push съобщенията (private_room_updated,
// private_room_chat_*, private_room_full/expired/closed/left, error) се
// подават директно през controller.handleServerMessage(...) — точно по
// пътя, по който main.ts подава реални WS кадри. Самият екран/DOM/CSS под
// тест е 100% истинският production render код, не мокап.
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

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me' } as any,
  }),
  onPrivateRoomsOpen: record('onPrivateRoomsOpen'),
  onPrivateRoomsClose: record('onPrivateRoomsClose'),
  onPrivateRoomCreate: record('onPrivateRoomCreate'),
  onPrivateRoomJoin: record('onPrivateRoomJoin'),
  onPrivateRoomLeave: record('onPrivateRoomLeave'),
  onPrivateRoomInvite: record('onPrivateRoomInvite'),
  onPrivateRoomInviteRespond: record('onPrivateRoomInviteRespond'),
  onPrivateRoomFillWithBots: record('onPrivateRoomFillWithBots'),
  onPrivateRoomChatSubscribe: record('onPrivateRoomChatSubscribe'),
  onPrivateRoomChatUnsubscribe: record('onPrivateRoomChatUnsubscribe'),
  onPrivateRoomChatSend: record('onPrivateRoomChatSend'),
})

;(window as any).__prwHarness = {
  controller,
  navigateToPrivateRooms: () => controller.navigateToPrivateRooms(),
  // Server-authoritative push: this is exactly what arrives right after a
  // successful create_private_room / join_private_room / invite-accept —
  // the controller reacts by redirecting to 'private-room-waiting'.
  pushRoomUpdated: (room: unknown) => {
    controller.handleServerMessage({ type: 'private_room_updated', room } as any)
  },
  pushChatHistory: (privateRoomId: string, messages: unknown[]) => {
    controller.handleServerMessage({ type: 'private_room_chat_history', privateRoomId, messages } as any)
  },
  pushChatMessage: (privateRoomId: string, message: any) => {
    controller.handleServerMessage({ type: 'private_room_chat_message', privateRoomId, ...message } as any)
  },
  pushChatError: (code: string, message: string, requestId?: string) => {
    controller.handleServerMessage({ type: 'private_room_chat_error', code, message, ...(requestId ? { requestId } : {}) } as any)
  },
  pushGenericError: (message: string) => {
    controller.handleServerMessage({ type: 'error', message } as any)
  },
  pushRoomFull: (roomId: string, seat: string, stake: number) => {
    controller.handleServerMessage({ type: 'private_room_full', roomId, seat, stake } as any)
  },
  pushRoomLeft: (privateRoomId: string) => {
    controller.handleServerMessage({ type: 'private_room_left', privateRoomId } as any)
  },
  pushRoomClosed: (privateRoomId: string) => {
    controller.handleServerMessage({ type: 'private_room_closed', privateRoomId } as any)
  },
  pushRoomExpired: (privateRoomId: string) => {
    controller.handleServerMessage({ type: 'private_room_expired', privateRoomId } as any)
  },
  getCurrentScreen: () => controller.getCurrentScreen(),
  getCalls: () => calls,
  clearCalls: () => { calls.length = 0 },
  lastCallArgs: (name: string) => {
    const found = [...calls].reverse().find((c) => c.name === name)
    return found ? found.args : undefined
  },
}

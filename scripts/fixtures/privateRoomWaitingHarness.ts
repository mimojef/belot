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

// Instrument window.setInterval/clearInterval so tests can assert "at most
// one active interval at a time" for the private-room countdown loop,
// without reaching into controller internals.
const activeIntervalIds = new Set<number>()
const nativeSetInterval = window.setInterval.bind(window)
const nativeClearInterval = window.clearInterval.bind(window)
;(window as any).setInterval = (...args: Parameters<typeof window.setInterval>) => {
  const id = nativeSetInterval(...(args as [any, any]))
  activeIntervalIds.add(id as unknown as number)
  return id
}
;(window as any).clearInterval = (id?: number) => {
  if (id !== undefined) activeIntervalIds.delete(id)
  return nativeClearInterval(id)
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

// Tracks which room id this harness has already simulated an explicit
// join for — see pushRoomUpdated below. A real client only marks
// privateRoomJoinInFlight for its OWN join/create click, never for a
// later live update (e.g. member count changing) about the SAME room it's
// already in; joinPrivateRoom() would incorrectly re-trigger the "already
// in a room" conflict prompt if called again for an unchanged room id.
let lastJoinedRoomId: string | null = null

;(window as any).__prwHarness = {
  controller,
  navigateToPrivateRooms: () => controller.navigateToPrivateRooms(),
  // Server-authoritative push: this is exactly what arrives right after a
  // successful create_private_room / join_private_room / invite-accept —
  // the controller reacts by redirecting to 'private-room-waiting'. Calling
  // joinPrivateRoom() first (only once per distinct room id) faithfully
  // reproduces the real click-then-server-response sequence, arming
  // privateRoomJoinInFlight exactly like a real "Присъедини" click would —
  // without it, private_room_updated correctly treats the push as a
  // passive resync (e.g. reconnect) and does NOT force-navigate, per the
  // "Изчакай в лоби" task spec.
  pushRoomUpdated: (room: any) => {
    if (room?.id !== lastJoinedRoomId) {
      lastJoinedRoomId = room.id
      controller.joinPrivateRoom(room.id)
    }
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
  getActiveIntervalCount: () => activeIntervalIds.size,
  // Returns the sole active interval id (or null), so tests can prove the
  // *same* interval survives a re-render (idempotent) versus being cleared
  // and re-created with a coincidentally-equal count.
  getSoleActiveIntervalId: () => (activeIntervalIds.size === 1 ? [...activeIntervalIds][0] : null),
  destroy: () => controller.destroy(),
}

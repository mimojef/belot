// Браузърна тестова "сглобка" (fixture) за
// checkPrivateRoomWaitTimeCountdown.ts — кара реалния production код
// (createLobbyFlowController + renderLobbyScreen), зареден през Vite dev
// server (без build, без jsdom), в истински браузър (Playwright), за да
// провери формата за създаване на частна маса (полето "Време за изчакване
// на играчи"). Мрежовите callback-ове са stub-нати (записват какво е
// извикано); самата форма/DOM под тест е 100% истинският production render
// код, не мокап.
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
  onPrivateRoomJoinSlot: record('onPrivateRoomJoinSlot'),
  onPrivateRoomLeave: record('onPrivateRoomLeave'),
  onPrivateRoomInvite: record('onPrivateRoomInvite'),
  onPrivateRoomInviteRespond: record('onPrivateRoomInviteRespond'),
  onPrivateRoomAddBot: record('onPrivateRoomAddBot'),
  onPrivateRoomRemoveBot: record('onPrivateRoomRemoveBot'),
  onPrivateRoomChatSubscribe: record('onPrivateRoomChatSubscribe'),
  onPrivateRoomChatUnsubscribe: record('onPrivateRoomChatUnsubscribe'),
  onPrivateRoomChatSend: record('onPrivateRoomChatSend'),
})

;(window as any).__prcpHarness = {
  controller,
  openCreatePopup: () => {
    controller.navigateToPrivateRooms()
    const openButton = root.querySelector<HTMLButtonElement>('[data-private-rooms-create-open="1"]')
    openButton?.click()
  },
  getCalls: () => calls,
  clearCalls: () => { calls.length = 0 },
  getLastCreateArgs: () => {
    const found = [...calls].reverse().find((c) => c.name === 'onPrivateRoomCreate')
    return found ? found.args : undefined
  },
}

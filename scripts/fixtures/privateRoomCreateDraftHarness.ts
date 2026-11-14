// Браузърна сглобка (fixture) за checkPrivateRoomCreateDraft.ts — реалният
// production код (createLobbyFlowController + renderLobbyScreen) през Vite dev
// server, в истински браузър. Мрежата е stub-ната: залози, видима/разрешена
// опция „Гласов чат“ и външни private_rooms_list съобщения, подадени директно
// през controller.handleServerMessage (както ги подава main.ts).
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

type RecordedCall = { name: string; args: unknown[] }
const calls: RecordedCall[] = []
const record = (name: string) => (...args: unknown[]) => { calls.push({ name, args }) }

const STAKES = [5000, 8000, 10000]

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'player' },
    profile: { profileId: 'me', displayName: 'Me', level: 50, yellowCoinsBalance: 50_000_000 } as any,
  }) as any,
  onMatchRoomsLoad: async () => ({ ok: true as const, rooms: STAKES.map((stakeAmount) => ({ stakeAmount, minLevel: 1, prizeAmount: stakeAmount * 2, isEnabled: true })) }),
  loadVoiceCreateOption: async () => ({ visible: true, canCreate: true, reason: null }),
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
} as any)

let listSeq = 0
function externalRoom(index: number) {
  return {
    id: `ext-${listSeq}-${index}`,
    kind: 'open',
    stake: STAKES[index % STAKES.length],
    slots: [
      { team: 'A', slotIndex: 0, occupant: { profileId: `host-${listSeq}-${index}`, displayName: `Домакин ${index}`, avatarUrl: null, level: 3, rankTitle: null, isHost: true, isBot: false } },
      { team: 'A', slotIndex: 1, occupant: null },
      { team: 'B', slotIndex: 0, occupant: null },
      { team: 'B', slotIndex: 1, occupant: null },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 10 * 60_000,
    manualStart: false,
    canManualStart: false,
  }
}

;(window as any).__prcdHarness = {
  openCreatePopup: () => {
    controller.navigateToPrivateRooms()
    root.querySelector<HTMLButtonElement>('[data-private-rooms-create-open="1"]')?.click()
  },
  /** Външно обновяване на списъка (друг играч създава/затваря маса). */
  pushRoomsList: () => {
    listSeq += 1
    const rooms = Array.from({ length: 1 + (listSeq % 3) }, (_, i) => externalRoom(i))
    return controller.handleServerMessage({ type: 'private_rooms_list', rooms } as any)
  },
  getLastCreateArgs: () => [...calls].reverse().find((c) => c.name === 'onPrivateRoomCreate')?.args,
  getCreateCallCount: () => calls.filter((c) => c.name === 'onPrivateRoomCreate').length,
}

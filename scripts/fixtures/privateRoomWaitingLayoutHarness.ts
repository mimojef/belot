// Браузърна сглобка (fixture) за checkPrivateRoomWaitingLayout.ts — layout-ът
// на чакалнята в production обвивката: реалният src/style.css (body/#app с
// фиксирана височина и overflow:hidden) и root = #app, както в main.ts.
// Реалният контролер на лобито рендерира чакалнята; лентата за гласов чат се
// попълва от реалния createVoiceMobileUi (гласовият контролер е фиктивен —
// само snapshot, без мрежа и без LiveKit); известието „приета покана“ идва от
// сървърния snapshot (partnerReservation.notice), както в production.
import '/src/style.css'
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import { createVoiceMobileUi } from '/src/app/voice/ui/createVoiceMobileUi.ts'
import { isPhoneLayoutViewport } from '/src/ui/layout/viewportStage.ts'

const root = document.getElementById('app') as HTMLDivElement

const voiceSnapshot = {
  status: 'connected_listening', voiceTableId: 'pr-layout', screen: 'waiting', speak: { canSpeak: true, blockedReason: null },
  wantsToSpeak: false, microphone: 'off', playbackBlocked: false, uiError: null, canRestore: false, offerDismissed: true,
  microphoneDevicesChanged: false, generation: 1, locallyMutedProfileIds: [], participants: [], speakingProfileIds: [],
}
const noop = () => {}
const fakeVoice = new Proxy({
  getSnapshot: () => voiceSnapshot,
  subscribe: () => noop,
  subscribeSpeaking: () => noop,
}, { get: (target, key) => (key in target ? (target as any)[key] : noop) })

const voiceUi = createVoiceMobileUi({
  voice: fakeVoice as any,
  getSeats: () => [],
  getOwnVipStatus: () => ({ state: 'vip' }) as any,
  getSpeakPreview: () => null,
  isPhoneLayout: () => isPhoneLayoutViewport(),
  onGetVip: noop,
})

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: noop,
  leaveMatchmaking: noop,
  onMatchFound: noop,
  getAuthSession: () => ({ account: { role: 'player' }, profile: { profileId: 'me', displayName: 'Me' } as any }) as any,
  onPrivateRoomWaitingRendered: (r: HTMLElement) => voiceUi.syncWaitingStrip(r),
  onPrivateRoomsOpen: noop, onPrivateRoomsClose: noop, onPrivateRoomCreate: noop, onPrivateRoomJoinSlot: noop,
  onPrivateRoomLeave: noop, onPrivateRoomInvite: noop, onPrivateRoomInviteRespond: noop, onPrivateRoomAddBot: noop,
  onPrivateRoomRemoveBot: noop, onPrivateRoomChatSubscribe: noop, onPrivateRoomChatUnsubscribe: noop, onPrivateRoomChatSend: noop,
} as any)

function occupant(profileId: string, displayName: string, isHost = false) {
  return { profileId, displayName, avatarUrl: null, level: 12, rankTitle: null, isHost, isBot: false }
}

function makeRoom(opts: { voice: boolean; notice: boolean }) {
  return {
    id: 'pr-layout', kind: 'locked', stake: 5000,
    slots: [
      { team: 'A', slotIndex: 0, occupant: occupant('me', 'Me', true) },
      { team: 'A', slotIndex: 1, occupant: occupant('p2', 'Партньор') },
      { team: 'B', slotIndex: 0, occupant: occupant('p3', 'Противник') },
      { team: 'B', slotIndex: 1, occupant: null },
    ],
    createdAt: Date.now(), expiresAt: Date.now() + 15 * 60_000,
    manualStart: true, canManualStart: false, voiceEnabled: opts.voice,
    partnerReservation: opts.notice
      ? { team: 'A', slotIndex: 1, invitePending: false, invite: null, notice: { kind: 'accepted', toDisplayName: 'Партньор', createdAt: Date.now() } }
      : null,
  }
}

// Скрива началния loading overlay на лобито (в production — след WS връзка).
controller.setConnected(true)

let joined = false
;(window as any).__prwlHarness = {
  show(opts: { voice: boolean; notice: boolean; messages: number }) {
    const room = makeRoom(opts)
    if (!joined) {
      joined = true
      controller.handleServerMessage({ type: 'private_rooms_list', rooms: [room] } as any)
      controller.joinPrivateRoom(room.id)
    }
    controller.handleServerMessage({ type: 'private_room_updated', room } as any)
    controller.handleServerMessage({
      type: 'private_room_chat_history', privateRoomId: room.id,
      messages: Array.from({ length: opts.messages }, (_, i) => ({
        seq: i + 1, messageId: `m${i}`, senderProfileId: i % 2 === 0 ? 'p2' : 'me', senderDisplayName: i % 2 === 0 ? 'Партньор' : 'Me',
        body: `Съобщение ${i + 1}`, createdAt: Date.now() - (opts.messages - i) * 1000,
      })),
    } as any)
  },
  /** Ново съобщение от друг играч — пълно прерисуване на чакалнята. */
  pushMessage(seq: number) {
    controller.handleServerMessage({
      type: 'private_room_chat_message', privateRoomId: 'pr-layout',
      seq, messageId: `x${seq}`, senderProfileId: 'p3', senderDisplayName: 'Противник', body: `Ново ${seq}`, createdAt: Date.now(),
    } as any)
  },
}

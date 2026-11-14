// Браузърна сглобка за checkVoiceMobileUi.ts (Гласов чат, Етап 4).
//
// РЕАЛНИЯТ production код: createLobbyFlowController („Нова маса“, чакалня),
// createActiveRoomFlowController (игрална маса) и createVoiceMobileUi (лента,
// бутон, панел, прозорец, индикатор „говори“). Само VoiceController е fixture:
// FakeVoiceController с фиксирани ВИЗУАЛНИ състояния — без LiveKit, без аудио,
// без микрофон. Това НЕ е браузърен аудиотест.

import type { VoiceController, VoiceSnapshot } from '/src/app/voice/createVoiceController.ts'
import type { RoomGameSnapshot, RoomSeatSnapshot, RoomSnapshotMessage } from '/src/app/network/createGameServerClient.ts'

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> { return Promise.resolve() }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

const params = new URLSearchParams(location.search)
const isVip = params.get('vip') !== '0'
// Статусът от /api/vip/status (voiceOwnVipStatus): vip=0 -> inactive, vip=error/pending -> error/unknown.
const ownVipStatus = params.get('vip') === 'error' ? 'error' as const : params.get('vip') === 'pending' ? 'unknown' as const : isVip ? 'active' as const : 'inactive' as const
const createOption = params.get('option') === 'locked'
  ? { visible: true, canCreate: false, reason: 'vip_required' as const }
  : { visible: true, canCreate: true, reason: null }

// Глобалният стил на виолетовите бутони — main.ts го зарежда при старт.
const { ensureViolet3dButtonStyles } = await import('/src/ui/layout/violet3dButton.ts')
ensureViolet3dButtonStyles()
const { createLobbyFlowController } = await import('/src/app/lobby/createLobbyFlowController.ts')
const { createActiveRoomFlowController } = await import('/src/app/activeRoom/createActiveRoomFlowController.ts')
const { createVoiceMobileUi } = await import('/src/app/voice/ui/createVoiceMobileUi.ts')
const { setVoiceSpeakingSlotsEnabled } = await import('/src/app/voice/ui/voiceSpeakingIndicator.ts')
const { isPhoneLayoutViewport } = await import('/src/ui/layout/viewportStage.ts')

const TABLE = '11111111-2222-4333-8444-555555555555'
const PEOPLE = [
  { profileId: 'me', displayName: 'Милена', team: 'A' as const, slotIndex: 0 as const, seat: 'bottom' },
  { profileId: 'p2', displayName: 'Георги Петров', team: 'B' as const, slotIndex: 0 as const, seat: 'right' },
  { profileId: 'p3', displayName: 'Иван', team: 'A' as const, slotIndex: 1 as const, seat: 'top' },
  { profileId: 'p4', displayName: 'Мария Иванова', team: 'B' as const, slotIndex: 1 as const, seat: 'left' },
]

// ─── Fake VoiceController (само визуални състояния) ─────────────────────

const actions: string[] = []
let snapshot: VoiceSnapshot = baseSnapshot('waiting')
const listeners = new Set<(s: VoiceSnapshot) => void>()
const speakingListeners = new Set<(ids: readonly string[]) => void>()

function baseSnapshot(screen: 'waiting' | 'game'): VoiceSnapshot {
  return {
    status: 'idle', voiceTableId: TABLE, screen, speak: null, wantsToSpeak: false, microphone: 'off', playbackBlocked: false,
    uiError: null, canRestore: false, offerDismissed: false, microphoneDevicesChanged: false, generation: null,
    locallyMutedProfileIds: [], speakingProfileIds: [],
    participants: PEOPLE.map((p) => ({ profileId: p.profileId, isSelf: p.profileId === 'me', voiceConnected: null, microphonePublished: null, speaking: false, listening: null, locallyMuted: false, unknown: true })),
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener(snapshot)
}

const record = (name: string) => () => { actions.push(name) }
const fakeVoice: VoiceController = {
  setContext: () => {},
  handleServerMessage: () => false,
  setGameConnection: () => {},
  endSession: record('endSession'),
  onPageHide: () => {},
  onPageShow: () => {},
  joinAsListener: record('joinAsListener'),
  joinWithMicrophone: record('joinWithMicrophone'),
  notNow: record('notNow'),
  requestVip: record('requestVip'),
  leaveVoice: record('leaveVoice'),
  enableMicrophone: record('enableMicrophone'),
  disableMicrophone: record('disableMicrophone'),
  retryMicrophone: record('retryMicrophone'),
  unlockAudio: record('unlockAudio'),
  retryConnection: record('retryConnection'),
  muteRemoteParticipant: (id) => { actions.push(`mute:${id}`) },
  unmuteRemoteParticipant: (id) => { actions.push(`unmute:${id}`) },
  getSnapshot: () => snapshot,
  subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  subscribeSpeaking: (listener) => { speakingListeners.add(listener); return () => speakingListeners.delete(listener) },
  dispose: () => {},
  debugCounters: () => ({}),
}

/** Свързано състояние: аз + участниците; connectedIds — свързаните отдалечени. */
function connected(options: { mic: boolean; muted?: boolean; canSpeak?: boolean; remotes: Record<string, 'mic' | 'listen' | 'out'>; locallyMuted?: string[] }): Partial<VoiceSnapshot> {
  const muted = options.muted === true
  const canSpeak = !muted && options.canSpeak !== false
  return {
    status: muted ? 'connected_muted' : options.mic ? 'connected_speaking' : 'connected_listening',
    speak: { canSpeak, blockedReason: muted ? 'muted' : canSpeak ? null : 'vip_required', hasSpeakingEntitlement: true, mutedUntil: muted ? new Date(Date.now() + 2 * 60 * 60_000).toISOString() : null },
    microphone: options.mic ? 'live' : 'off',
    generation: 1,
    locallyMutedProfileIds: options.locallyMuted ?? [],
    participants: PEOPLE.map((p) => {
      if (p.profileId === 'me') return { profileId: 'me', isSelf: true, voiceConnected: true, microphonePublished: options.mic, speaking: false, listening: !options.mic, locallyMuted: false, unknown: false }
      const state = options.remotes[p.profileId] ?? 'out'
      return { profileId: p.profileId, isSelf: false, voiceConnected: state !== 'out', microphonePublished: state === 'out' ? null : state === 'mic', speaking: false, listening: state === 'out' ? null : state === 'listen', locallyMuted: (options.locallyMuted ?? []).includes(p.profileId), unknown: false }
    }),
  }
}

// ─── Лоби + чакалня ─────────────────────────────────────────────────────

const lobbyRoot = document.createElement('div')
document.body.appendChild(lobbyRoot)
let ui: ReturnType<typeof createVoiceMobileUi> | null = null

const lobby = createLobbyFlowController({
  root: lobbyRoot,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({ account: { role: 'player' }, profile: { profileId: 'me', displayName: 'Милена', isVip, level: 12, yellowCoinsBalance: 500_000 } as any }),
  onMatchRoomsLoad: async () => ({ ok: true, rooms: [{ stakeAmount: 5000, minLevel: 1, prizeAmount: 18000, isEnabled: true }, { stakeAmount: 20000, minLevel: 1, prizeAmount: 72000, isEnabled: true }] }),
  loadVoiceCreateOption: async () => createOption,
  onGetTopicsVipGateStatus: async () => ({ ok: true, isActive: isVip, hasClaimedLaunchGift: false, launchGiftDays: 7 }),
  onPrivateRoomWaitingRendered: (root: HTMLElement) => ui?.syncWaitingStrip(root),
  onPrivateRoomsOpen: () => {},
  onPrivateRoomsClose: () => {},
  onPrivateRoomCreate: (...args: unknown[]) => { actions.push(`create:${JSON.stringify(args)}`) },
  onPrivateRoomChatSubscribe: () => {},
  onPrivateRoomChatUnsubscribe: () => {},
} as any)

function waitingRoom() {
  return {
    id: 'room-voice', kind: 'open', stake: 5000, createdAt: Date.now(), expiresAt: Date.now() + 12 * 60_000,
    manualStart: false, canManualStart: false, partnerReservation: null, voiceEnabled: true, voiceTableId: TABLE,
    slots: PEOPLE.map((p, index) => ({
      team: p.team, slotIndex: p.slotIndex,
      occupant: index < 3 ? { profileId: p.profileId, displayName: p.displayName, avatarUrl: null, level: 8 + index, rankTitle: 'Играч', isHost: index === 0, isBot: false } : null,
    })),
  }
}

// ─── Игрална маса ───────────────────────────────────────────────────────

const gameRoot = document.createElement('div')
document.body.appendChild(gameRoot)
const activeRoom = createActiveRoomFlowController({
  root: gameRoot as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: () => {}, submitCutIndex: () => {}, submitBidAction: () => {}, submitPlayCard: () => {}, resumeHumanControl: () => {},
  submitPartnerRating: () => {}, sendReplayVote: () => {}, sendLeaveMatchVote: () => {}, sendEmojiReaction: () => {}, sendPhraseReaction: () => {},
  requestPlayerProfile: () => {}, getFriendshipAction: () => null, onSendFriendRequest: async () => ({ ok: false, message: '' }),
  onLikeProfile: async () => ({ ok: false }), onBlockProfile: async () => ({ message: '' }), showLobby: () => {}, startNewGame: () => {},
  onGuestTrialReplayRequested: () => {}, fetchTournamentDetail: async () => null, onEnterWaitingForNextTournamentRound: () => {},
  requestBidResync: () => {}, forceReconnectForZombieConnection: () => {},
} as any)

const seats: RoomSeatSnapshot[] = PEOPLE.map((p) => ({
  seat: p.seat as RoomSeatSnapshot['seat'], profileId: p.profileId, isOccupied: true, isConnected: true, isBot: false, isControlledByBot: false,
  displayName: p.displayName, avatarUrl: null, gender: null, level: 10, rankTitle: null, skillRating: null,
}))

function playingGame(): RoomGameSnapshot {
  const ownHand = [
    { id: 'c7', suit: 'clubs', rank: '7' }, { id: 'd9', suit: 'diamonds', rank: '9' }, { id: 'hJ', suit: 'hearts', rank: 'J' },
    { id: 'sA', suit: 'spades', rank: 'A' }, { id: 'cK', suit: 'clubs', rank: 'K' }, { id: 'hQ', suit: 'hearts', rank: 'Q' },
  ]
  return {
    phase: 'playing', authoritativePhase: 'playing', timerDeadlineAt: Date.now() + 60_000, dealerSeat: 'left', firstDealSeat: 'bottom',
    cutting: null, bidding: null,
    playing: {
      winningBid: { seat: 'right', contract: 'suit', trumpSuit: 'hearts', doubled: false, redoubled: false },
      currentTurnSeat: 'right', currentTrickPlays: [{ seat: 'top', card: { id: 'sK', suit: 'spades', rank: 'K' } }],
      completedTricksCount: 2, latestCompletedTrick: null, validCardIds: null,
    },
    scoring: null, matchEnded: null, declarations: [], score: { match: { teamA: 42, teamB: 61 } },
    handCounts: { bottom: ownHand.length, right: 6, top: 5, left: 6 }, ownHand,
  } as unknown as RoomGameSnapshot
}

async function frames(count = 2): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
}

;(window as any).__voiceUiHarness = {
  actions,
  async openCreate(): Promise<void> {
    lobby.navigateToPrivateRooms()
    await new Promise((resolve) => setTimeout(resolve, 150))
    lobbyRoot.querySelector<HTMLButtonElement>('[data-private-rooms-create-open="1"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
  },
  checkVoiceAndSubmit(): void {
    const box = lobbyRoot.querySelector<HTMLInputElement>('[data-private-room-voice-checkbox="1"]')
    if (box) box.checked = true
    lobbyRoot.querySelector<HTMLFormElement>('[data-private-room-create-form="1"]')?.requestSubmit()
  },
  pushCapacityError(): void {
    lobby.handleServerMessage({ type: 'error', code: 'voice_chat_capacity_reached', message: 'В момента всички гласови маси са заети. Можете да създадете масата без гласов чат.', voiceActiveTables: 10, voiceMaxTables: 10 } as any)
  },
  clickVoiceVipRow(): void {
    lobbyRoot.querySelector<HTMLButtonElement>('[data-private-room-voice-vip="1"]')?.click()
  },
  /** Списъкът „Частни маси“: гласова+ръчен старт, само гласова, само ръчен старт, обикновена. */
  async showList(): Promise<void> {
    lobby.navigateToPrivateRooms()
    const host = (name: string, id: string) => ({ profileId: id, displayName: name, avatarUrl: null, level: 9, rankTitle: 'Играч', isHost: true, isBot: false })
    const guest = (name: string, id: string) => ({ profileId: id, displayName: name, avatarUrl: null, level: 7, rankTitle: 'Играч', isHost: false, isBot: false })
    const room = (id: string, hostName: string, options: { voice: boolean; manual: boolean; guests?: number }) => ({
      id, kind: 'open', stake: 5000, createdAt: Date.now(), expiresAt: Date.now() + 11 * 60_000, manualStart: options.manual, canManualStart: false,
      humanTurnTimeoutMs: 15000, partnerReservation: null, voiceEnabled: options.voice, voiceTableId: null,
      slots: [
        { team: 'A', slotIndex: 0, occupant: host(hostName, `${id}-h`) },
        { team: 'B', slotIndex: 0, occupant: (options.guests ?? 0) > 0 ? guest('Петър', `${id}-g1`) : null },
        { team: 'A', slotIndex: 1, occupant: (options.guests ?? 0) > 1 ? guest('Ели', `${id}-g2`) : null },
        { team: 'B', slotIndex: 1, occupant: null },
      ],
    })
    lobby.handleServerMessage({ type: 'private_rooms_list', rooms: [
      room('r1', 'Георги Петров', { voice: true, manual: true, guests: 2 }),
      room('r2', 'Мария', { voice: true, manual: false, guests: 1 }),
      room('r3', 'Иван Иванов', { voice: false, manual: true, guests: 1 }),
      room('r4', 'Константин-Александър Величковски', { voice: true, manual: true }),
      room('r5', 'Стефан', { voice: false, manual: false }),
    ] } as any)
    await new Promise((resolve) => setTimeout(resolve, 200))
  },
  async showWaiting(): Promise<void> {
    snapshot = baseSnapshot('waiting')
    ui ??= createVoiceMobileUi({ voice: fakeVoice, getSeats: () => harnessSeats(true), getOwnVipStatus: () => ownVipStatus, getSpeakPreview: () => null, isPhoneLayout: () => isPhoneLayoutViewport(), onGetVip: record('getVip') })
    const room = waitingRoom()
    lobby.handleServerMessage({ type: 'private_rooms_list', rooms: [room] } as any)
    lobby.joinPrivateRoom(room.id)
    lobby.handleServerMessage({ type: 'private_room_updated', room } as any)
    emit()
    await frames()
  },
  async showGame(): Promise<void> {
    // Игралният екран е самостоятелен (в production lobby root-ът не се показва по време на игра).
    lobbyRoot.style.display = 'none'
    document.querySelectorAll('[data-lobby-bottom-nav], nav').forEach((el) => { if (!gameRoot.contains(el)) (el as HTMLElement).style.display = 'none' })
    document.querySelector('[data-voice-prompt-layer="1"]')?.remove()
    setVoiceSpeakingSlotsEnabled(true)
    activeRoom.enterActiveRoom({ roomId: 'room-play', seat: 'bottom', stake: 5000, humanPlayers: 4, botPlayers: 0, shouldStartImmediately: false } as any, true)
    await frames()
    const message = { type: 'room_snapshot', roomId: 'room-play', roomStatus: 'playing', yourSeat: 'bottom', reconnectToken: 't', seats, game: playingGame(), isGuestTrial: false, isPrivateTableOrigin: true, isTournamentMatchOrigin: false, stakeAmount: 5000, voiceTableId: TABLE } as RoomSnapshotMessage
    activeRoom.handleServerMessage(message)
    snapshot = baseSnapshot('game')
    ui ??= createVoiceMobileUi({ voice: fakeVoice, getSeats: () => harnessSeats(false), getOwnVipStatus: () => ownVipStatus, getSpeakPreview: () => null, isPhoneLayout: () => isPhoneLayoutViewport(), onGetVip: record('getVip') })
    emit()
    const startedAt = performance.now()
    while (document.querySelector('[data-playing-bottom-hand-host] [data-card-id]') === null && performance.now() - startedAt < 8000) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await new Promise((resolve) => setTimeout(resolve, 3200))
  },
  /** Финален екран на мача (същата маса; гласът продължава). */
  async showMatchEnded(): Promise<void> {
    const game = {
      phase: 'finished', authoritativePhase: 'match-ended', timerDeadlineAt: null, dealerSeat: 'left', firstDealSeat: 'bottom',
      cutting: null, bidding: null, playing: null, scoring: null,
      matchEnded: { winnerTeam: 'A', targetScore: 151, finalScore: { teamA: 162, teamB: 131 }, endedAt: Date.now(), replayVotes: ['right'], leaveVotes: [], awardedPrizeAmount: 18000 },
      declarations: [], score: { match: { teamA: 162, teamB: 131 } }, handCounts: { bottom: 0, right: 0, top: 0, left: 0 }, ownHand: [],
    } as unknown as RoomGameSnapshot
    activeRoom.handleServerMessage({ type: 'room_snapshot', roomId: 'room-play', roomStatus: 'finished', yourSeat: 'bottom', reconnectToken: 't', seats, game, isGuestTrial: false, isPrivateTableOrigin: true, isTournamentMatchOrigin: false, stakeAmount: 5000, voiceTableId: TABLE } as RoomSnapshotMessage)
    await new Promise((resolve) => setTimeout(resolve, 600))
  },
  /** Не е включен (както controller-а: участниците са „неизвестно“). */
  resetIdle(): void {
    snapshot = baseSnapshot(snapshot.screen === 'game' ? 'game' : 'waiting')
    emit()
  },
  setVoice(partial: Partial<VoiceSnapshot>): void {
    snapshot = { ...snapshot, ...partial }
    emit()
  },
  setConnected(options: Parameters<typeof connected>[0], extra: Partial<VoiceSnapshot> = {}): void {
    snapshot = { ...snapshot, uiError: null, playbackBlocked: false, microphoneDevicesChanged: false, ...connected(options), ...extra }
    emit()
  },
  setSpeaking(ids: string[]): void {
    for (const listener of [...speakingListeners]) listener(ids)
  },
  openPanel: () => ui?.openPanel(),
  closePanel: () => ui?.closePanel(),
}

function harnessSeats(waiting: boolean) {
  const people = waiting ? PEOPLE.slice(0, 3) : PEOPLE
  const seatsForPanel = people.map((p) => ({ profileId: p.profileId, displayName: p.displayName, avatarUrl: null, isBot: false, isSelf: p.profileId === 'me' }))
  return waiting ? seatsForPanel : seatsForPanel
}

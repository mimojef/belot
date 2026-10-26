// Браузърна сглобка за checkGameplayDeadSocketRecovery.ts.
//
// РЕАЛНИ: createGameServerClient (истински WebSocket), createConnectionLivenessMonitor
// (продукционните стойности), decideSocketCloseAction/decideSocketOpenAction и
// createActiveRoomFlowController + renderPlayingScreen. Отсреща е реален WS
// сървър (Node, в теста) зад TCP proxy, който може да "замрази" съществуващата
// връзка без FIN/RST — точно полуотворената мобилна връзка от бъга.
//
// Лепилото onOpen/onClose/recover по-долу е огледало на main.ts
// (recoverFromUnresponsiveSocket, onClose 'active-room-silent-reconnect',
// onOpen 'zombie-bid-resume') — main.ts не може да се зареди изолирано.
import { createGameServerClient, type ServerMessage } from '/src/app/network/createGameServerClient.ts'
import { createConnectionLivenessMonitor } from '/src/app/network/createConnectionLivenessMonitor.ts'
import { decideSocketCloseAction, decideSocketOpenAction } from '/src/app/network/socketReconnectPolicy.ts'

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> {
    return Promise.resolve()
  }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

const { createActiveRoomFlowController } = await import('/src/app/activeRoom/createActiveRoomFlowController.ts')

const params = new URLSearchParams(location.search)
const wsUrl = params.get('ws') ?? ''
const ROOM_ID = 'room-dead-socket'
const RECONNECT_DELAY_MS = 1_000 // SERVER_RECONNECT_DELAY_MS в main.ts

const root = document.createElement('div')
document.body.appendChild(root)

const log: string[] = []
let isZombieBidReconnectInFlight = false
let reconnectTimerId: number | null = null
let openCount = 0
let unexpectedCloseDecisions = 0
let recoverCalls: string[] = []

function scheduleServerReconnect(): void {
  if (reconnectTimerId !== null) return
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null
    client.connect()
  }, RECONNECT_DELAY_MS)
}

function recoverFromUnresponsiveSocket(reason: string): void {
  if (!controller.hasActiveRoom()) return
  recoverCalls.push(reason)
  log.push(`${Date.now()} recover ${reason}`)
  isZombieBidReconnectInFlight = true
  if (!client.abandonUnresponsiveSocket(reason)) scheduleServerReconnect()
}

const client = createGameServerClient({
  url: wsUrl,
  onOpen: () => {
    openCount += 1
    log.push(`${Date.now()} open #${openCount}`)
    const wasZombie = isZombieBidReconnectInFlight
    isZombieBidReconnectInFlight = false
    const decision = decideSocketOpenAction({
      isZombieBidReconnectInFlight: wasZombie,
      isBelotSpectatorReconnectInFlight: false,
      spectatingBelotRoomId: null,
      shouldReloadLobbyOnReconnect: false,
      hasActiveRoom: controller.hasActiveRoom(),
    })
    if (decision === 'zombie-bid-resume') {
      controller.setConnectionState(true, 'Възстановяване на играта...')
      const info = controller.getResumeInfo()
      if (info) client.resumeRoom(info.roomId, info.reconnectToken)
      return
    }
    if (openCount === 1) {
      controller.enterActiveRoom({
        roomId: ROOM_ID,
        seat: 'bottom',
        stake: 5000,
        humanPlayers: 1,
        botPlayers: 3,
        shouldStartImmediately: false,
      } as any, true)
      client.resumeRoom(ROOM_ID, 'token-1')
    }
  },
  onClose: () => {
    const decision = decideSocketCloseAction({
      isBelotSpectatorSessionActive: false,
      hasActiveRoom: controller.hasActiveRoom(),
      isZombieBidReconnectInFlight,
    })
    log.push(`${Date.now()} close -> ${decision}`)
    if (decision === 'active-room-silent-reconnect') {
      controller.setConnectionState(false, 'Връзката със сървъра се възстановява...')
      scheduleServerReconnect()
      return
    }
    unexpectedCloseDecisions += 1
    scheduleServerReconnect()
  },
  onMessage: (message: ServerMessage) => {
    controller.handleServerMessage(message)
  },
})

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => client.isConnected(),
  leaveActiveRoom: () => {},
  submitCutIndex: () => {},
  submitBidAction: () => {},
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => {
    client.submitPlayCard(roomId, cardId, declarationKeys ?? [])
  },
  resumeHumanControl: () => {},
  submitPartnerRating: () => {},
  sendReplayVote: () => {},
  sendLeaveMatchVote: () => {},
  sendEmojiReaction: () => {},
  sendPhraseReaction: () => {},
  requestPlayerProfile: () => {},
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: 'unused' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: 'unused' }),
  showLobby: () => {},
  startNewGame: () => {},
  onGuestTrialReplayRequested: () => {},
  fetchTournamentDetail: async () => null,
  onEnterWaitingForNextTournamentRound: () => {},
  requestBidResync: () => {
    const info = controller.getResumeInfo()
    if (info) client.resumeRoom(info.roomId, info.reconnectToken)
  },
  forceReconnectForZombieConnection: () => recoverFromUnresponsiveSocket('submit_watchdog'),
} as any)

const livenessMonitor = createConnectionLivenessMonitor({
  isEnabled: () => controller.getResumeInfo() !== null,
  getMsSinceLastServerMessage: () => client.getMsSinceLastServerMessage(),
  sendPing: () => client.ping(),
  onUnresponsive: () => recoverFromUnresponsiveSocket('liveness_timeout'),
})
livenessMonitor.start()

client.connect()

function handButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]'))
}

;(window as any).__deadSocketHarness = {
  ready: true,
  handCardIds: () => handButtons().map((button) => button.dataset.cardId ?? ''),
  activeHandCardIds: () => handButtons().filter((button) => !button.disabled && button.classList.contains('play-hand-card--active')).map((button) => button.dataset.cardId ?? ''),
  clickCard: (cardId: string): boolean => {
    const button = handButtons().find((candidate) => candidate.dataset.cardId === cardId)
    if (!button || button.disabled) return false
    button.click()
    return true
  },
  cardTransform: (cardId: string): string | null =>
    handButtons().find((candidate) => candidate.dataset.cardId === cardId)?.style.transform ?? null,
  // Изиграните карти на масата (desktop trick area или mobile trick layer).
  tableCardIds: (): string[] =>
    Array.from(document.body.querySelectorAll<HTMLElement>('[data-trick-seat][data-card-id]'))
      .filter((element) => element.closest('[data-played-card-fly-overlay]') === null)
      .map((element) => `${element.dataset.trickSeat}:${element.dataset.cardId}`),
  bannerText: (): string | null =>
    document.body.querySelector<HTMLElement>('[data-active-room-connection-banner="1"]')?.textContent ?? null,
  noticeText: (): string | null =>
    document.body.querySelector<HTMLElement>('[data-playing-input-notice]')?.textContent ?? null,
  isTransportConnected: () => client.isConnected(),
  openCount: () => openCount,
  recoverCalls: () => [...recoverCalls],
  unexpectedCloseDecisions: () => unexpectedCloseDecisions,
  livenessDebug: () => ({
    enabled: controller.getResumeInfo() !== null,
    msSinceLastServerMessage: client.getMsSinceLastServerMessage(),
  }),
  log: () => [...log],
}

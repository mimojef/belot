// Етап 1 — реален createActiveRoomFlowController + реален createGameServerClient
// срещу фалшив Белот сървър (scripts/checkBelotErrorIsolation.ts). Повтаря
// тихия път от main.ts: при затваряне prepareForSilentReconnect(), при
// отваряне syncConnectionIndicator(); resume_room се праща по команда от
// теста (за да се види прозорецът „транспорт отворен, играта не е синхронизирана“).
import { createGameServerClient, type ServerMessage } from '/src/app/network/createGameServerClient.ts'

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
const ROOM_ID = 'room-error-isolation'

const root = document.createElement('div')
document.body.appendChild(root)
let openCount = 0

const client = createGameServerClient({
  url: wsUrl,
  onOpen: () => {
    openCount += 1
    if (openCount === 1) {
      controller.enterActiveRoom({
        roomId: ROOM_ID, seat: 'bottom', stake: 5000, humanPlayers: 1, botPlayers: 3, shouldStartImmediately: false,
      } as any, true)
      client.resumeRoom(ROOM_ID, 'token-1')
      return
    }
    // main.ts: lobbySoftReconnect.handleOpen() -> activeRoom.syncConnectionIndicator()
    controller.syncConnectionIndicator()
  },
  onClose: () => {
    // main.ts (тихо възстановяване): activeRoom.prepareForSilentReconnect()
    controller.prepareForSilentReconnect()
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
  requestBidResync: () => {
    const info = controller.getResumeInfo()
    if (info) client.resumeRoom(info.roomId, info.reconnectToken)
  },
  forceReconnectForZombieConnection: () => {},
} as any)

client.connect()

function handButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]'))
}
function rectOf(selector: string): { top: number; bottom: number; left: number; right: number } | null {
  const element = document.body.querySelector<HTMLElement>(selector)
  if (!element) return null
  const r = element.getBoundingClientRect()
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
}

;(window as any).__errorIsolationHarness = {
  ready: true,
  activeHandCardIds: () => handButtons().filter((button) => !button.disabled && button.classList.contains('play-hand-card--active')).map((button) => button.dataset.cardId ?? ''),
  clickCard: (cardId: string): boolean => {
    const button = handButtons().find((candidate) => candidate.dataset.cardId === cardId)
    if (!button || button.disabled) return false
    button.click()
    return true
  },
  cardTransform: (cardId: string): string | null =>
    handButtons().find((candidate) => candidate.dataset.cardId === cardId)?.style.transform ?? null,
  bannerText: (): string | null => document.body.querySelector<HTMLElement>('[data-active-room-connection-banner="1"]')?.textContent ?? null,
  bannerRect: () => rectOf('[data-active-room-connection-banner="1"]'),
  noticeText: (): string | null => document.body.querySelector<HTMLElement>('[data-playing-input-notice]')?.textContent ?? null,
  noticeRect: () => rectOf('[data-playing-input-notice]'),
  biddingErrorText: (): string | null => document.body.querySelector<HTMLElement>('[data-bidding-error="1"]')?.textContent?.trim() ?? null,
  biddingErrorRect: () => rectOf('[data-bidding-error="1"]'),
  bodyText: (): string => document.body.innerText,
  isTransportConnected: () => client.isConnected(),
  drop: () => client.disconnect('e2e_drop'),
  reconnect: () => client.connect(),
  resume: () => {
    const info = controller.getResumeInfo()
    if (info) client.resumeRoom(info.roomId, info.reconnectToken)
  },
}

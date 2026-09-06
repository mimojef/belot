// Споделена браузърна тестова "сглобка" за checkBiddingBoardOverlayInvariant.ts
// и checkBidSubmitRecovery.ts — зарежда РЕАЛНИЯ createActiveRoomFlowController()
// и го движи с реални handleServerMessage()/render()/click() извиквания, за да
// докаже на реален DOM (1) инварианта: authoritativePhase !== 'bidding' => нула
// bidding-popup document.body host node-ове, и (2) bid-submission
// watchdog/resync/reconnect-fallback fix-а. Огледало на matchEndedHarness.ts/
// chatDraftHarness.ts установения patter в тази директория.
import { createActiveRoomFlowController } from '/src/app/activeRoom/createActiveRoomFlowController.ts'
import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomSnapshotMessage,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let bidCommands = 0
let resyncRequestCount = 0
let reconnectFallbackCount = 0
const requestedPlayerProfiles: Array<{ roomId: string; seat: string }> = []

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> {
    return Promise.resolve()
  }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

const seats: RoomSeatSnapshot[] = ['bottom', 'right', 'top', 'left'].map((seat, index) => ({
  seat: seat as RoomSeatSnapshot['seat'],
  isOccupied: true,
  isConnected: true,
  isBot: index !== 0,
  isControlledByBot: false,
  displayName: index === 0 ? 'Harness Human' : `Bot ${index}`,
  avatarUrl: null,
  gender: null,
  level: 1,
  rankTitle: null,
  skillRating: null,
}))

const score = { match: { teamA: 0, teamB: 0 } }
const noVisibleHands = { bottom: 0, right: 0, top: 0, left: 0 }
const dealtHandCounts = { bottom: 5, right: 5, top: 5, left: 5 }
const fullHand = { bottom: 8, right: 8, top: 8, left: 8 }
const ownHand = [
  { id: 'c7', suit: 'clubs' as const, rank: '7' as const },
  { id: 'd8', suit: 'diamonds' as const, rank: '8' as const },
  { id: 'h9', suit: 'hearts' as const, rank: '9' as const },
  { id: 's10', suit: 'spades' as const, rank: '10' as const },
  { id: 'cj', suit: 'clubs' as const, rank: 'J' as const },
]

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: () => {},
  submitCutIndex: () => {},
  submitBidAction: () => { bidCommands += 1 },
  submitPlayCard: () => {},
  resumeHumanControl: () => {},
  submitPartnerRating: () => {},
  sendReplayVote: () => {},
  sendLeaveMatchVote: () => {},
  sendEmojiReaction: () => {},
  sendPhraseReaction: () => {},
  requestPlayerProfile: (roomId: string, seat: string) => { requestedPlayerProfiles.push({ roomId, seat }) },
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: 'unused' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: 'unused' }),
  showLobby: () => {},
  startNewGame: () => {},
  onGuestTrialReplayRequested: () => {},
  fetchTournamentDetail: async () => null,
  onEnterWaitingForNextTournamentRound: () => {},
  requestBidResync: () => { resyncRequestCount += 1 },
  forceReconnectForZombieConnection: () => { reconnectFallbackCount += 1 },
})

// createActiveRoomFlowController.ts coalesce-ва renderActiveRoomScreen() през
// requestAnimationFrame (render scheduling fix — виж scheduleActiveRoomRender
// коментара там): контролерните методи по-долу вече само SCHEDULE-ват render,
// не го изпълняват синхронно. Тестовете тук асертват върху реалния DOM веднага
// след тези извиквания, затова изчакваме поне един рендернат кадър, преди да
// resolve-нем — двоен requestAnimationFrame (established "wait for paint"
// идиом), не единичен, за да сме защитени дори ако бъдещ caller добави own
// rAF hop преди действителния render.
function waitForRenderedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function enter(roomId: string): Promise<void> {
  controller.enterActiveRoom({
    roomId,
    seat: 'bottom',
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  } as any, true)
  await waitForRenderedFrame()
}

async function enterFromResume(roomId: string): Promise<void> {
  controller.enterActiveRoomFromResume(roomId, 'bottom', 5000 as any)
  await waitForRenderedFrame()
}

async function snapshot(roomId: string, game: RoomGameSnapshot | null): Promise<void> {
  const message: RoomSnapshotMessage = {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game: game ?? undefined,
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: false,
    stakeAmount: 5000,
  }
  controller.handleServerMessage(message)
  await waitForRenderedFrame()
}

async function resumed(roomId: string): Promise<void> {
  controller.handleServerMessage({ type: 'room_resumed', roomId, seat: 'bottom' } as any)
  await waitForRenderedFrame()
}

async function serverError(message: string): Promise<void> {
  controller.handleServerMessage({ type: 'error', message } as any)
  await waitForRenderedFrame()
}

function biddingGame(overrides: Partial<RoomGameSnapshot> = {}): RoomGameSnapshot {
  return {
    phase: 'bidding',
    authoritativePhase: 'bidding',
    timerDeadlineAt: Date.now() + 20_000,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: {
      winningBid: null,
      currentBidderSeat: 'bottom',
      entries: [],
      canSubmitBid: true,
      validActions: {
        pass: true,
        noTrumps: true,
        allTrumps: true,
        double: false,
        redouble: false,
        suits: { clubs: true, diamonds: true, hearts: true, spades: true },
      },
    },
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: dealtHandCounts,
    ownHand: [],
    ...overrides,
  }
}

function dealLastThreeGame(): RoomGameSnapshot {
  return {
    phase: 'dealing',
    authoritativePhase: 'deal-last-3',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: fullHand,
    ownHand,
  }
}

function nextRoundGame(): RoomGameSnapshot {
  return {
    phase: 'dealing',
    authoritativePhase: 'next-round',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: noVisibleHands,
    ownHand: [],
  }
}

function playingGame(): RoomGameSnapshot {
  return {
    phase: 'playing',
    authoritativePhase: 'playing',
    timerDeadlineAt: Date.now() + 20_000,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: {
      winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
      currentTurnSeat: 'bottom',
      currentTrickPlays: [],
      completedTricksCount: 0,
      latestCompletedTrick: null,
      validCardIds: ownHand.map((c) => c.id),
    },
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: fullHand,
    ownHand,
  }
}

function biddingPopupHostCount(): number {
  return document.body.querySelectorAll('[data-bidding-popup-host]').length
}

function biddingPopupVisibleNodeCount(): number {
  return document.body.querySelectorAll('[data-bidding-popup="1"]').length
}

function render(): void {
  controller.render()
}

function dispatchResize(): void {
  window.dispatchEvent(new Event('resize'))
}

function biddingPopupState(): {
  exists: boolean
  opacity: string | null
  pointerEvents: string | null
  buttonsDisabled: boolean | null
  errorText: string | null
} {
  const popup = document.body.querySelector<HTMLElement>('[data-bidding-popup="1"]')
  const buttons = popup ? Array.from(popup.querySelectorAll<HTMLButtonElement>('button')) : []
  const errorNode = document.body.querySelector<HTMLElement>('[data-bidding-error="1"]')
  return {
    exists: popup !== null,
    opacity: popup ? popup.style.opacity : null,
    pointerEvents: popup ? popup.style.pointerEvents : null,
    buttonsDisabled: buttons.length > 0 ? buttons.every((b) => b.disabled) : null,
    errorText: errorNode ? errorNode.textContent : null,
  }
}

function clickBidAction(action: string): boolean {
  const btn = document.body.querySelector<HTMLButtonElement>(
    `[data-bidding-popup-host] [data-bid-action="${action}"]`,
  )
  if (!btn || btn.disabled) return false
  btn.click()
  return true
}

// Симулира "стар document.body-hosted overlay е останал в DOM-а по каквато и
// да е причина" — инжектира ръчно fake popup host, БЕЗ да минава през
// syncBiddingPopupOverlay(), за да тестваме самия ИНВАРИАНТ (следващият
// state-driven render трябва да го премахне), независимо от точния trigger,
// който първоначално го е оставил.
function injectStaleBiddingPopupHost(): void {
  if (document.body.querySelector('[data-bidding-popup-host]')) return
  const host = document.createElement('div')
  host.setAttribute('data-bidding-popup-host', '1')
  host.innerHTML = '<div data-bidding-popup="1"><button data-bid-action="pass">Пас</button></div>'
  document.body.appendChild(host)
}

function reset(): void {
  bidCommands = 0
  resyncRequestCount = 0
  reconnectFallbackCount = 0
  requestedPlayerProfiles.length = 0
  document.body.querySelectorAll('[data-bidding-popup-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-seat-panels-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-playing-bottom-hand-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-player-profile-popup-root]').forEach((n) => n.remove())
}

// Real click on the seat's profile button, exactly the DOM path
// document.body's global click listener in createActiveRoomFlowController.ts
// listens for ([data-profile-seat-btn] via closest()).
function clickSeatProfile(seat: string): boolean {
  const btn = document.body.querySelector<HTMLElement>(`[data-profile-seat-btn="${seat}"]`)
  if (!btn) return false
  btn.click()
  return true
}

function pushPlayerProfile(roomId: string, seat: string, profile: unknown): void {
  controller.handleServerMessage({ type: 'player_profile', roomId, seat, profile } as any)
}

function getPopupBodyText(): string | null {
  const root = document.body.querySelector<HTMLElement>('[data-player-profile-popup-root="1"]')
  return root ? (root.textContent ?? '') : null
}

;(window as any).__biddingLifecycleHarness = {
  enter,
  enterFromResume,
  snapshot,
  resumed,
  serverError,
  biddingGame,
  dealLastThreeGame,
  nextRoundGame,
  playingGame,
  biddingPopupHostCount,
  biddingPopupVisibleNodeCount,
  biddingPopupState,
  clickBidAction,
  clickSeatProfile,
  pushPlayerProfile,
  getPopupBodyText,
  getRequestedPlayerProfiles: () => requestedPlayerProfiles,
  render,
  dispatchResize,
  injectStaleBiddingPopupHost,
  getBidCommands: () => bidCommands,
  getResyncRequestCount: () => resyncRequestCount,
  getReconnectFallbackCount: () => reconnectFallbackCount,
  reset,
}

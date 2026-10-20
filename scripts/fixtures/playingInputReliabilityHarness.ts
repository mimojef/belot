// Браузърна сглобка за checkPlayingInputReliability.ts — РЕАЛНИЯТ
// createActiveRoomFlowController() + renderPlayingScreen(), реален DOM и
// реални click-ове по картите. Проверява надеждността на изиграване на карта:
// незабавна визуална обратна връзка, без двойно изпращане, watchdog/resync/
// reconnect при изгубена команда, отключване само след resync, без
// автоматично изпращане на друга карта, offline submit и стабилен
// declaration prompt при re-render.
//
// Watchdog таймерите (response: 1.5/3/4.5 сек според времето за ход 5/10/15;
// resync timeout: 5 сек) се прихващат и се пускат ръчно — тестът е
// детерминистичен и не чака реално време.
import type {
  RoomCardSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomSnapshotMessage,
} from '/src/app/network/createGameServerClient.ts'

const WATCHDOG_DELAYS_MS = new Set([1500, 3000, 4500, 5000])
const realSetTimeout = window.setTimeout.bind(window)
const realClearTimeout = window.clearTimeout.bind(window)
const heldTimers = new Map<number, () => void>()
const heldTimerDelayById = new Map<number, number>()
let nextHeldTimerId = 1_000_000

;(window as any).setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]): number => {
  if (delay !== undefined && WATCHDOG_DELAYS_MS.has(delay) && typeof handler === 'function') {
    const id = nextHeldTimerId++
    heldTimers.set(id, () => (handler as (...a: unknown[]) => void)(...args))
    heldTimerDelayById.set(id, delay)
    return id
  }
  return realSetTimeout(handler, delay, ...args)
}
;(window as any).clearTimeout = (id?: number): void => {
  if (id !== undefined && heldTimers.delete(id)) {
    heldTimerDelayById.delete(id)
    return
  }
  realClearTimeout(id)
}

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

const root = document.createElement('div')
document.body.appendChild(root)

let connected = true
const playCommands: Array<{ roomId: string; cardId: string; declarationKeys: string[] }> = []
let resyncRequestCount = 0
let reconnectFallbackCount = 0

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

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => connected,
  leaveActiveRoom: () => {},
  submitCutIndex: () => {},
  submitBidAction: () => {},
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => {
    playCommands.push({ roomId, cardId, declarationKeys: declarationKeys ?? [] })
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
  requestBidResync: () => { resyncRequestCount += 1 },
  forceReconnectForZombieConnection: () => { reconnectFallbackCount += 1 },
} as any)

function waitForRenderedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

// Без последователни рангове в една боя -> без анонси (освен ако тестът не
// поиска изрично ръка с терца).
const PLAIN_HAND: RoomCardSnapshot[] = [
  { id: 'c7', suit: 'clubs', rank: '7' },
  { id: 'd9', suit: 'diamonds', rank: '9' },
  { id: 'hJ', suit: 'hearts', rank: 'J' },
  { id: 'sA', suit: 'spades', rank: 'A' },
  { id: 'cK', suit: 'clubs', rank: 'K' },
]
const TIERCE_HAND: RoomCardSnapshot[] = [
  { id: 'c7', suit: 'clubs', rank: '7' },
  { id: 'c8', suit: 'clubs', rank: '8' },
  { id: 'c9', suit: 'clubs', rank: '9' },
  { id: 'dA', suit: 'diamonds', rank: 'A' },
  { id: 'hJ', suit: 'hearts', rank: 'J' },
]

let turnTimeoutMs: number | null = null

function setTurnTimeoutMs(value: number | null): void {
  turnTimeoutMs = value
}

function playingGame(options: { hand?: 'plain' | 'tierce'; turnSeat?: string; removeCardId?: string } = {}): RoomGameSnapshot {
  const baseHand = options.hand === 'tierce' ? TIERCE_HAND : PLAIN_HAND
  const ownHand = baseHand.filter((card) => card.id !== options.removeCardId)
  const turnSeat = (options.turnSeat ?? 'bottom') as RoomGameSnapshot['dealerSeat']
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
      currentTurnSeat: turnSeat,
      currentTrickPlays: options.removeCardId
        ? [{ seat: 'bottom', card: baseHand.find((card) => card.id === options.removeCardId)! }]
        : [],
      completedTricksCount: 0,
      latestCompletedTrick: null,
      validCardIds: turnSeat === 'bottom' ? ownHand.map((card) => card.id) : null,
    },
    scoring: null,
    matchEnded: null,
    declarations: [],
    score: { match: { teamA: 0, teamB: 0 } },
    handCounts: { bottom: ownHand.length, right: 8, top: 8, left: 8 },
    ownHand,
    ...(turnTimeoutMs !== null ? { humanTurnTimeoutMs: turnTimeoutMs } : {}),
  } as RoomGameSnapshot
}

let roomCounter = 0

async function enterPlaying(hand: 'plain' | 'tierce' = 'plain'): Promise<string> {
  roomCounter += 1
  const roomId = `room-play-${roomCounter}`
  controller.enterActiveRoom({
    roomId,
    seat: 'bottom',
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  } as any, true)
  await waitForRenderedFrame()
  await snapshot(roomId, playingGame({ hand }))
  // Входната (deal) презентация държи playing ръката ~2-3 сек.
  const startedAt = performance.now()
  while (document.body.querySelector('[data-playing-bottom-hand-host] .play-hand-card--active') === null) {
    if (performance.now() - startedAt > 10_000) throw new Error('playing hand did not become active')
    await new Promise((resolve) => realSetTimeout(resolve, 50))
  }
  return roomId
}

async function snapshot(roomId: string, game: RoomGameSnapshot): Promise<void> {
  const message: RoomSnapshotMessage = {
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game,
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: false,
    stakeAmount: 5000,
  } as RoomSnapshotMessage
  controller.handleServerMessage(message)
  await waitForRenderedFrame()
}

// Реалният отговор на resume_room: room_resumed + веднага room_snapshot.
async function resumed(roomId: string): Promise<void> {
  controller.handleServerMessage({ type: 'room_resumed', roomId, seat: 'bottom' } as any)
  await waitForRenderedFrame()
}

async function serverError(message: string): Promise<void> {
  controller.handleServerMessage({ type: 'error', message } as any)
  await waitForRenderedFrame()
}

async function setConnectionState(isConnected: boolean): Promise<void> {
  connected = isConnected
  controller.setConnectionState(isConnected, isConnected ? null : 'reconnecting')
  await waitForRenderedFrame()
}

function setTransportConnected(value: boolean): void {
  connected = value
}

function handButton(cardId: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`[data-playing-bottom-hand-host] [data-card-id="${cardId}"]`)
}

function clickCard(cardId: string): boolean {
  const button = handButton(cardId)
  if (!button || button.disabled) return false
  button.click()
  return true
}

function cardTransform(cardId: string): string | null {
  return handButton(cardId)?.style.transform ?? null
}

async function fireWatchdogTimers(): Promise<number> {
  const callbacks = [...heldTimers.values()]
  heldTimers.clear()
  heldTimerDelayById.clear()
  for (const callback of callbacks) callback()
  await waitForRenderedFrame()
  return callbacks.length
}

function noticeText(): string | null {
  return document.body.querySelector<HTMLElement>('[data-playing-input-notice]')?.textContent ?? null
}

function clearNotice(): void {
  document.body.querySelector('[data-playing-input-notice]')?.remove()
}

function declarationPromptNode(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[data-declaration-prompt-root="1"]')
}

function markDeclarationPrompt(): boolean {
  const node = declarationPromptNode()
  if (!node) return false
  ;(node as any).__identityMarker = true
  return true
}

function isDeclarationPromptSameNode(): boolean {
  return (declarationPromptNode() as any)?.__identityMarker === true
}

function clickDeclarationContinue(): boolean {
  const button = declarationPromptNode()?.querySelector<HTMLButtonElement>('[data-declaration-continue="1"]')
  if (!button) return false
  button.click()
  return true
}

async function rerender(): Promise<void> {
  controller.render()
  await waitForRenderedFrame()
}

function handCardRects(): Array<{ cardId: string; left: number; top: number; right: number; bottom: number }> {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]'))
    .map((button) => {
      const rect = button.getBoundingClientRect()
      return { cardId: button.dataset.cardId ?? '', left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    })
}

// Какво РЕАЛНО е под точката в пълната маса (панели, балончета, trick layer).
function hitTestAt(x: number, y: number): { cardId: string | null; enabled: boolean; owner: string } {
  const element = document.elementFromPoint(x, y)
  if (element === null) return { cardId: null, enabled: false, owner: 'none' }
  const card = element.closest<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]')
  if (card) return { cardId: card.dataset.cardId ?? null, enabled: !card.disabled, owner: 'hand' }
  const host = element.closest('[data-seat-panels-host],[data-mobile-bubble-layer-host],[data-mobile-trick-layer-host],[data-active-room-desktop-action-bar]')
  const ownerAttr = host ? Array.from(host.attributes).map((attr) => attr.name).find((name) => name.startsWith('data-')) : null
  return { cardId: null, enabled: false, owner: ownerAttr ?? describeElement(element) }
}

function describeElement(element: Element): string {
  const chain: string[] = []
  let node: Element | null = element
  while (node && node !== document.body && chain.length < 6) {
    const attrs = Array.from(node.attributes).map((attr) => attr.name).filter((name) => name.startsWith('data-'))
    const style = getComputedStyle(node)
    chain.push(`${node.tagName}${attrs.length ? '[' + attrs.join(',') + ']' : ''}{pos:${style.position},z:${style.zIndex},pe:${style.pointerEvents}}`)
    node = node.parentElement
  }
  return chain.join(' < ')
}

function reset(): void {
  playCommands.length = 0
  resyncRequestCount = 0
  reconnectFallbackCount = 0
  connected = true
  turnTimeoutMs = null
  heldTimers.clear()
  heldTimerDelayById.clear()
  clearNotice()
}

;(window as any).__playingInputHarness = {
  enterPlaying,
  snapshot,
  resumed,
  serverError,
  setTurnTimeoutMs,
  heldTimerDelays: () => [...heldTimerDelayById.values()],
  setConnectionState,
  setTransportConnected,
  playingGame,
  clickCard,
  cardTransform,
  fireWatchdogTimers,
  heldTimerCount: () => heldTimers.size,
  noticeText,
  clearNotice,
  declarationPromptNode: () => declarationPromptNode() !== null,
  markDeclarationPrompt,
  isDeclarationPromptSameNode,
  clickDeclarationContinue,
  rerender,
  handCardRects,
  hitTestAt,
  getPlayCommands: () => [...playCommands],
  getResyncRequestCount: () => resyncRequestCount,
  getReconnectFallbackCount: () => reconnectFallbackCount,
  reset,
  ready: true,
}

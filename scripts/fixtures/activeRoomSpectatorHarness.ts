// Browser fixture за checkBelotSpectatorActiveRoomView.ts — mount-ва РЕАЛНИЯ
// createActiveRoomFlowController() (Phase 3B), движен с реални
// enterActiveRoomAsSpectator/applySpectatorSnapshotToActiveRoom/
// exitSpectatorView/handleServerMessage/render() извиквания, mirror на
// установения biddingBoardLifecycleHarness.ts pattern (synthetic snapshots,
// без реален WS/server — client-side viewer-model/rendering safety е под
// тест, не server protocol-а, вече покрит в Phase 2A/2C/3A server тестовете).
import { createActiveRoomFlowController } from '/src/app/activeRoom/createActiveRoomFlowController.ts'
import type {
  BelotSpectatorSnapshotMessage,
  RoomCardSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

class FakeAudio {
  constructor(_src?: string) {}
  preload = ''
  volume = 1
  play(): Promise<void> {
    return Promise.resolve()
  }
}
Object.defineProperty(window, 'Audio', { configurable: true, value: FakeAudio })

type RecordedCall = { name: string; args: unknown[] }
const calls: RecordedCall[] = []
function record(name: string) {
  return (...args: unknown[]) => { calls.push({ name, args }) }
}

const controller = createActiveRoomFlowController({
  root: root as unknown as HTMLDivElement,
  isConnected: () => true,
  leaveActiveRoom: record('leaveActiveRoom'),
  submitCutIndex: record('submitCutIndex'),
  submitBidAction: record('submitBidAction'),
  submitPlayCard: record('submitPlayCard'),
  submitSweepDecision: record('submitSweepDecision'),
  resumeHumanControl: record('resumeHumanControl'),
  submitPartnerRating: record('submitPartnerRating'),
  sendReplayVote: record('sendReplayVote'),
  sendLeaveMatchVote: record('sendLeaveMatchVote'),
  sendEmojiReaction: record('sendEmojiReaction'),
  sendPhraseReaction: record('sendPhraseReaction'),
  sendTableGift: record('sendTableGift'),
  onGiftItemCatalogLoad: async () => ({ ok: true, items: [] }),
  getAuthSession: () => ({ profile: { yellowCoinsBalance: 50000 } }),
  requestPlayerProfile: record('requestPlayerProfile'),
  getFriendshipAction: () => null,
  onSendFriendRequest: async () => ({ ok: false, message: 'unused' }),
  onLikeProfile: async () => ({ ok: false }),
  onBlockProfile: async () => ({ message: 'unused' }),
  onBlockProfileFull: async () => ({ ok: false, message: 'unused' }),
  showLobby: record('showLobby'),
  startNewGame: record('startNewGame'),
  onGuestTrialReplayRequested: record('onGuestTrialReplayRequested'),
  fetchTournamentDetail: async () => null,
  acknowledgeTournamentSemifinalResult: record('acknowledgeTournamentSemifinalResult'),
  onEnterWaitingForNextTournamentRound: record('onEnterWaitingForNextTournamentRound'),
  onTournamentFinalResultContinue: record('onTournamentFinalResultContinue'),
  requestBidResync: record('requestBidResync'),
  forceReconnectForZombieConnection: record('forceReconnectForZombieConnection'),
  onSpectatorExitRequested: record('onSpectatorExitRequested'),
})

function waitForRenderedFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeSeats(occupantsControlledByBot: Partial<Record<string, boolean>> = {}): RoomSeatSnapshot[] {
  return (['bottom', 'right', 'top', 'left'] as const).map((seat, index) => ({
    seat,
    isOccupied: true,
    isConnected: true,
    isBot: false,
    isControlledByBot: occupantsControlledByBot[seat] === true,
    displayName: index === 0 ? 'Host' : `Player ${index}`,
    avatarUrl: null,
    gender: null,
    level: 1,
    rankTitle: null,
    skillRating: null,
    profileId: `profile-${seat}`,
  }))
}

const score = { match: { teamA: 0, teamB: 0 } }
const fourHandCounts = { bottom: 8, right: 8, top: 8, left: 8 }
const realOwnHand: RoomCardSnapshot[] = [
  { id: 'c7', suit: 'clubs', rank: '7' },
  { id: 'd8', suit: 'diamonds', rank: '8' },
]

function cuttingGame(overrides: Partial<RoomGameSnapshot> = {}): RoomGameSnapshot {
  return {
    phase: 'cutting',
    authoritativePhase: 'cutting',
    timerDeadlineAt: Date.now() + 15_000,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: { cutterSeat: 'bottom', selectedCutIndex: null, deckCount: 32, canSubmitCut: false },
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
    ownHand: [],
    ...overrides,
  }
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
      canSubmitBid: false,
      validActions: null,
    },
    playing: null,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    // 5, НЕ 8 — реалистично за bidding (deal-next-2 вече е минал, deal-last-3
    // идва едва СЛЕД приключена bidding). handCounts>=8 за ВСИЧКИ seats по
    // време на 'bidding' кара hasVisibleLastThreeHands() (което, за разлика
    // от first-three/next-two checks, НЕ excludes 'bidding') да заключи
    // isShowingAnyDealPhase завинаги true, потискайки bidding popup-а изцяло
    // — unrelated на Phase 3B, чист fixture-realism детайл.
    handCounts: { bottom: 5, right: 5, top: 5, left: 5 },
    ownHand: [],
    ...overrides,
  }
}

function playingGame(overrides: Partial<RoomGameSnapshot> = {}): RoomGameSnapshot {
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
      validCardIds: null,
      sweepOffer: null,
      sweepResolution: null,
    } as any,
    scoring: null,
    matchEnded: null,
    declarations: [],
    score,
    handCounts: fourHandCounts,
    ownHand: [],
    ...overrides,
  }
}

function scoringGame(overrides: Partial<RoomGameSnapshot> = {}): RoomGameSnapshot {
  return {
    phase: 'dealing',
    authoritativePhase: 'scoring',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: {
      winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
      rawHandPoints: { teamA: 90, teamB: 72 },
      rawHandTricksWon: { teamA: 5, teamB: 3 },
      declarationPoints: { teamA: 0, teamB: 0 },
      belotePoints: { teamA: 0, teamB: 0 },
      sumPoints: { teamA: 90, teamB: 72 },
      officialRoundPoints: { teamA: 90, teamB: 72 },
      matchTotals: { teamA: 90, teamB: 72 },
      carryOver: { teamA: 0, teamB: 0 },
      isCapotRound: false,
      isNonCapotRound: false,
      outcomeLabel: 'normal',
    } as any,
    matchEnded: null,
    declarations: [],
    score: { match: { teamA: 90, teamB: 72 } },
    handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
    ownHand: [],
    ...overrides,
  }
}

function matchEndedGame(overrides: Partial<RoomGameSnapshot> = {}): RoomGameSnapshot {
  return {
    phase: 'dealing',
    authoritativePhase: 'match-ended',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: {
      winnerTeam: 'A',
      targetScore: 151,
      finalScore: { teamA: 160, teamB: 90 },
      endedAt: Date.now(),
      replayVotes: [],
      leaveVotes: [],
      awardedPrizeAmount: null,
    },
    declarations: [],
    score: { match: { teamA: 160, teamB: 90 } },
    handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
    ownHand: [],
    ...overrides,
  }
}

function makeSpectatorSnapshot(roomId: string, game: RoomGameSnapshot, seats = makeSeats()): BelotSpectatorSnapshotMessage {
  return {
    type: 'belot_spectator_snapshot',
    viewerRole: 'spectator',
    roomId,
    roomStatus: 'playing',
    yourSeat: null,
    reconnectToken: null,
    seats,
    game,
    stakeAmount: 5000,
    isGuestTrial: false,
    isPrivateTableOrigin: true,
    isTournamentMatchOrigin: false,
    activeTableGifts: [],
  }
}

// ─── Entry/lifecycle ────────────────────────────────────────────────────────

async function enterAsSpectator(roomId: string, game: RoomGameSnapshot, seats = makeSeats()): Promise<void> {
  controller.enterActiveRoomAsSpectator(roomId, makeSpectatorSnapshot(roomId, game, seats))
  await waitForRenderedFrame()
}

async function applySpectatorSnapshot(roomId: string, game: RoomGameSnapshot, seats = makeSeats()): Promise<boolean> {
  const result = controller.applySpectatorSnapshotToActiveRoom(makeSpectatorSnapshot(roomId, game, seats))
  await waitForRenderedFrame()
  return result
}

async function exitSpectator(): Promise<void> {
  controller.exitSpectatorView()
  await waitForRenderedFrame()
}

async function enterAsParticipant(roomId: string, seat: 'bottom' | 'right' | 'top' | 'left' = 'bottom'): Promise<void> {
  controller.enterActiveRoom({
    roomId,
    seat,
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  } as any, true)
  await waitForRenderedFrame()
}

async function applyParticipantSnapshot(roomId: string, game: RoomGameSnapshot, seats = makeSeats()): Promise<void> {
  controller.handleServerMessage({
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats,
    game,
    isGuestTrial: false,
    isPrivateTableOrigin: true,
    isTournamentMatchOrigin: false,
    stakeAmount: 5000,
  } as any)
  await waitForRenderedFrame()
}

async function render(): Promise<void> {
  controller.render()
  await waitForRenderedFrame()
}

// ─── DOM/state query helpers ────────────────────────────────────────────────

function cardFanElements(seat: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(`[data-active-room-seat-card-fan="${seat}"]`))
}

function countVisibleCardsInFan(seat: string): number {
  const fans = cardFanElements(seat)
  if (fans.length === 0) return 0
  // Всяко card div е директно дете на фен контейнера.
  return fans[0]!.children.length
}

function fanHasAnyFaceCard(seat: string): boolean {
  const fans = cardFanElements(seat)
  return fans.some((fan) => fan.querySelector('img') !== null)
}

function hasBottomHandOverlay(): boolean {
  return document.body.querySelector('[data-playing-bottom-hand-host]') !== null
}

function bottomHandOverlayCardCount(): number {
  return document.body.querySelectorAll('[data-playing-bottom-hand-host] [data-card-id]').length
}

function hasCuttingInteractiveArea(): boolean {
  return document.body.querySelector('[data-active-room-cut-hit-area="1"]') !== null
}

function hasBiddingPopup(): boolean {
  return document.body.querySelector('[data-bidding-popup="1"]') !== null
}

function hasSweepOfferPopup(): boolean {
  return document.body.querySelector('[data-sweep-offer-prompt-root="1"]') !== null
}

function hasBotTakeoverPopup(): boolean {
  return document.body.querySelector('[data-bot-takeover-overlay="1"]') !== null
}

function hasEmojiToggle(): boolean {
  return document.body.querySelector('[data-emoji-toggle="1"]') !== null
}

function hasPhraseToggle(): boolean {
  return document.body.querySelector('[data-phrase-toggle="1"]') !== null
}

function hasGiftIcon(seat: string): boolean {
  return document.body.querySelector(`[data-active-room-gift-icon="${seat}"]`) !== null
}

function hasAnyGiftIcon(): boolean {
  return document.body.querySelector('[data-active-room-gift-icon]') !== null
}

function hasLeaveButton(): boolean {
  return document.body.querySelector('[data-active-room-leave-button="1"]') !== null
}

function hasSettingsButton(): boolean {
  return document.body.querySelector('[data-active-room-settings-button="1"]') !== null
}

function clickLeaveButton(): boolean {
  const btn = document.body.querySelector<HTMLButtonElement>('[data-active-room-leave-button="1"]')
  if (!btn) return false
  btn.click()
  return true
}

function clickSettingsButton(): boolean {
  const btn = document.body.querySelector<HTMLButtonElement>('[data-active-room-settings-button="1"]')
  if (!btn) return false
  btn.click()
  return true
}

function hasSettingsPanelOpen(): boolean {
  return document.body.querySelector('[data-active-room-settings-backdrop="1"]') !== null
}

function hasSoundToggle(): boolean {
  return document.body.querySelector('[data-active-room-game-sounds-toggle="1"]') !== null
}

function clickSeatProfile(seat: string): boolean {
  const btn = document.body.querySelector<HTMLElement>(`[data-profile-seat-btn="${seat}"]`)
  if (!btn) return false
  btn.click()
  return true
}

function hasProfilePopupOpen(): boolean {
  return document.body.querySelector('[data-player-profile-popup-root="1"]') !== null
}

function hasMatchEndedActionButtons(): boolean {
  return (
    document.body.querySelector('[data-match-ended-lobby-button="1"]') !== null ||
    document.body.querySelector('[data-match-ended-replay-button="1"]') !== null ||
    document.body.querySelector('[data-match-ended-new-game-button="1"]') !== null ||
    document.body.querySelector('[data-partner-rating-value]') !== null
  )
}

function hasPrizeCounter(): boolean {
  return document.body.querySelector('[data-prize-counter="1"]') !== null
}

function reset(): void {
  calls.length = 0
  document.body.querySelectorAll('[data-bidding-popup-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-seat-panels-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-playing-bottom-hand-host]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-player-profile-popup-root]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-bot-takeover-overlay]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-active-room-leave-button]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-active-room-mobile-action-bar]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-active-room-desktop-action-bar]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-active-room-settings-backdrop]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-emoji-toggle]').forEach((n) => n.remove())
  document.body.querySelectorAll('[data-phrase-toggle]').forEach((n) => n.remove())
}

;(window as any).__activeRoomSpectatorHarness = {
  // entry/lifecycle
  enterAsSpectator,
  applySpectatorSnapshot,
  exitSpectator,
  enterAsParticipant,
  applyParticipantSnapshot,
  render,
  reset,
  // fixtures
  cuttingGame,
  biddingGame,
  playingGame,
  scoringGame,
  matchEndedGame,
  makeSeats,
  // state getters
  hasActiveRoomFn: () => controller.hasActiveRoom(),
  isActiveRoomParticipantFn: () => controller.isActiveRoomParticipant(),
  isSpectatorViewFn: () => controller.isSpectatorView(),
  getCurrentRoomIdFn: () => controller.getCurrentRoomId(),
  // DOM queries
  countVisibleCardsInFan,
  fanHasAnyFaceCard,
  hasBottomHandOverlay,
  bottomHandOverlayCardCount,
  hasCuttingInteractiveArea,
  hasBiddingPopup,
  hasSweepOfferPopup,
  hasBotTakeoverPopup,
  hasEmojiToggle,
  hasPhraseToggle,
  hasGiftIcon,
  hasAnyGiftIcon,
  hasLeaveButton,
  hasSettingsButton,
  clickLeaveButton,
  clickSettingsButton,
  hasSettingsPanelOpen,
  hasSoundToggle,
  clickSeatProfile,
  hasProfilePopupOpen,
  hasMatchEndedActionButtons,
  hasPrizeCounter,
  getCalls: () => calls,
}

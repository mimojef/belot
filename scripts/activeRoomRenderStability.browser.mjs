import { createActiveRoomFlowController } from '../src/app/activeRoom/createActiveRoomFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

let cutCommands = 0
let bidCommands = 0
let audioPlays = 0

class FakeAudio {
  constructor(src) {
    this.src = src
    this.preload = ''
    this.volume = 1
  }

  play() {
    audioPlays += 1
    return Promise.resolve()
  }
}

Object.defineProperty(window, 'Audio', {
  configurable: true,
  value: FakeAudio,
})

const seats = ['bottom', 'right', 'top', 'left'].map((seat, index) => ({
  seat,
  isOccupied: true,
  isConnected: true,
  isBot: index !== 0,
  isControlledByBot: false,
  displayName: index === 0 ? 'Human' : `Bot ${index}`,
  avatarUrl: null,
  gender: null,
  level: 1,
}))
const score = { match: { teamA: 0, teamB: 0 } }
const handCounts = { bottom: 5, right: 5, top: 5, left: 5 }
const noVisibleHands = { bottom: 0, right: 0, top: 0, left: 0 }
const ownHand = [
  { id: 'c7', suit: 'clubs', rank: '7' },
  { id: 'd8', suit: 'diamonds', rank: '8' },
  { id: 'h9', suit: 'hearts', rank: '9' },
  { id: 's10', suit: 'spades', rank: '10' },
  { id: 'cj', suit: 'clubs', rank: 'J' },
]

const controller = createActiveRoomFlowController({
  root,
  isConnected: () => true,
  leaveActiveRoom: () => {},
  submitCutIndex: () => { cutCommands += 1 },
  submitBidAction: () => { bidCommands += 1 },
  submitPlayCard: () => {},
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
  acknowledgeTournamentSemifinalResult: () => {},
  onEnterWaitingForNextTournamentRound: () => {},
  onTournamentFinalResultContinue: () => {},
})

function enter(roomId) {
  controller.enterActiveRoom({
    roomId,
    seat: 'bottom',
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  }, true)
}

function snapshot(roomId, game) {
  controller.handleServerMessage({
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
    tournamentId: null,
    tournamentMatchId: null,
    tournamentRoundType: null,
    tournamentAttendance: null,
    tournamentBotReplacements: [],
    tournamentBanners: [],
    stakeAmount: 5000,
  })
}

const cuttingGame = {
  phase: 'cutting',
  authoritativePhase: 'cutting',
  timerDeadlineAt: Date.now() + 20_000,
  dealerSeat: 'left',
  firstDealSeat: null,
  cutting: { cutterSeat: 'bottom', deckCount: 32, selectedCutIndex: null, canSubmitCut: true },
  bidding: null,
  playing: null,
  scoring: null,
  matchEnded: null,
  declarations: [],
  score,
  handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
  ownHand: [],
}

enter('cut-room')
snapshot('cut-room', cuttingGame)
const cutButtonBefore = root.querySelector('[data-active-room-cut-index]')
cutButtonBefore?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
snapshot('cut-room', { ...cuttingGame, timerDeadlineAt: cuttingGame.timerDeadlineAt })
const cutButtonAfterTick = root.querySelector('[data-active-room-cut-index]')
cutButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
cutButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
const cutCommandsAfterDoubleClick = cutCommands
controller.handleServerMessage({ type: 'error', message: 'rejected' })
root.querySelector('[data-active-room-cut-index]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

const biddingGame = {
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
  handCounts: noVisibleHands,
  ownHand: [],
}

enter('bid-room')
snapshot('bid-room', biddingGame)
// Bid popup-ът живее в собствен document.body host (syncBiddingPopupOverlay),
// не вътре в root — виж BIDDING_POPUP_HOST_ATTR в createActiveRoomFlowController.ts.
const bidButtonBefore = document.querySelector('[data-bid-action="pass"]')
const bidRootHtml = root.innerHTML.slice(0, 240)
const bidPhaseAttr = root.querySelector('[data-active-room-phase]')?.getAttribute('data-active-room-phase') ?? null
const bidHasPopup = document.querySelector('[data-bidding-popup="1"]') !== null
bidButtonBefore?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
snapshot('bid-room', { ...biddingGame, timerDeadlineAt: biddingGame.timerDeadlineAt })
const bidButtonAfterTick = document.querySelector('[data-bid-action="pass"]')
bidButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
bidButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

function scoringGame(sumA, sumB) {
  return {
    phase: 'scoring',
    authoritativePhase: 'scoring',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: {
      winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
      rawHandPoints: { teamA: sumA - 20, teamB: sumB },
      rawHandTricksWon: { teamA: 5, teamB: 3 },
      declarationPoints: { teamA: 20, teamB: 0 },
      belotePoints: { teamA: 0, teamB: 0 },
      sumPoints: { teamA: sumA, teamB: sumB },
      officialRoundPoints: { teamA: sumA, teamB: sumB },
      matchTotals: { teamA: sumA, teamB: sumB },
      carryOver: { teamA: 0, teamB: 0 },
      isCapotRound: false,
      isNonCapotRound: true,
      outcomeLabel: 'OK',
      outcomeShortLabel: 'OK',
      counterMultiplier: 1,
    },
    matchEnded: null,
    declarations: [],
    score: { match: { teamA: 0, teamB: 0 } },
    handCounts: noVisibleHands,
    ownHand: [],
  }
}

enter('score-room')
snapshot('score-room', scoringGame(82, 80))
const animatedCountersFirst = root.querySelectorAll('[data-scoring-sum-counter="1"]').length
const scoringRootHtml = root.innerHTML.slice(0, 240)
const scoringText = root.textContent?.slice(0, 200) ?? ''
snapshot('score-room', scoringGame(82, 80))
const animatedCountersDuplicate = root.querySelectorAll('[data-scoring-sum-counter="1"]').length
snapshot('score-room', scoringGame(92, 70))
const animatedCountersNewKey = root.querySelectorAll('[data-scoring-sum-counter="1"]').length

window.__activeRoomRenderStabilityResult = {
  cutNodeStable: cutButtonBefore === cutButtonAfterTick,
  cutCommandsAfterDoubleClick,
  cutCommandsAfterRejectionRetry: cutCommands,
  bidNodeStable: bidButtonBefore === bidButtonAfterTick,
  bidCommands,
  bidRootHtml,
  bidPhaseAttr,
  bidHasPopup,
  animatedCountersFirst,
  scoringRootHtml,
  scoringText,
  animatedCountersDuplicate,
  animatedCountersNewKey,
  audioPlays,
}

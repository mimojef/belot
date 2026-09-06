import { createActiveRoomFlowController } from '../src/app/activeRoom/createActiveRoomFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

// scheduleActiveRoomRender() е RAF-deferred (Fix №1) — всяко assertion, което
// чете DOM СЛЕД state мутация, трябва да изчака реален flush, иначе вижда
// pre-render DOM. Established pattern, виж scripts/fixtures/biddingBoardLifecycleHarness.ts.
function waitForRenderedFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

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

async function enter(roomId) {
  controller.enterActiveRoom({
    roomId,
    seat: 'bottom',
    stake: 5000,
    humanPlayers: 1,
    botPlayers: 3,
    shouldStartImmediately: false,
  }, true)
  await waitForRenderedFrame()
}

async function snapshot(roomId, game, overrides = {}) {
  controller.handleServerMessage({
    type: 'room_snapshot',
    roomId,
    roomStatus: 'playing',
    yourSeat: 'bottom',
    reconnectToken: 'token',
    seats: overrides.seats ?? seats,
    game,
    isGuestTrial: false,
    isPrivateTableOrigin: false,
    isTournamentMatchOrigin: false,
    tournamentId: null,
    tournamentMatchId: null,
    tournamentRoundType: null,
    tournamentAttendance: null,
    tournamentBotReplacements: [],
    tournamentBanners: overrides.tournamentBanners ?? [],
    stakeAmount: 5000,
  })
  await waitForRenderedFrame()
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

await enter('cut-room')
await snapshot('cut-room', cuttingGame)
const cutButtonBefore = root.querySelector('[data-active-room-cut-index]')
cutButtonBefore?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
await snapshot('cut-room', { ...cuttingGame, timerDeadlineAt: cuttingGame.timerDeadlineAt })
const cutButtonAfterTick = root.querySelector('[data-active-room-cut-index]')
cutButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
cutButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
const cutCommandsAfterDoubleClick = cutCommands
controller.handleServerMessage({ type: 'error', message: 'rejected' })
await waitForRenderedFrame()
root.querySelector('[data-active-room-cut-index]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()

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

await enter('bid-room')
await snapshot('bid-room', biddingGame)
// Bid popup-ът живее в собствен document.body host (syncBiddingPopupOverlay),
// не вътре в root — виж BIDDING_POPUP_HOST_ATTR в createActiveRoomFlowController.ts.
const bidButtonBefore = document.querySelector('[data-bid-action="pass"]')
const bidRootHtml = root.innerHTML.slice(0, 240)
const bidPhaseAttr = root.querySelector('[data-active-room-phase]')?.getAttribute('data-active-room-phase') ?? null
const bidHasPopup = document.querySelector('[data-bidding-popup="1"]') !== null
bidButtonBefore?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
await snapshot('bid-room', { ...biddingGame, timerDeadlineAt: biddingGame.timerDeadlineAt })
const bidButtonAfterTick = document.querySelector('[data-bid-action="pass"]')
bidButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
bidButtonAfterTick?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()

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

await enter('score-room')
await snapshot('score-room', scoringGame(82, 80))
const animatedCountersFirst = root.querySelectorAll('[data-scoring-sum-counter="1"]').length
const scoringRootHtml = root.innerHTML.slice(0, 240)
const scoringText = root.textContent?.slice(0, 200) ?? ''
await snapshot('score-room', scoringGame(82, 80))
const animatedCountersDuplicate = root.querySelectorAll('[data-scoring-sum-counter="1"]').length
await snapshot('score-room', scoringGame(92, 70))
const animatedCountersNewKey = root.querySelectorAll('[data-scoring-sum-counter="1"]').length

// ─────────────────────────────────────────────────────────────────────────
// Fix №3: ancillary UI (tournament banners / leave warning / persistent bot
// takeover) трябва да се materialize-ва дори когато renderActiveRoomScreen()
// удря cutting/bidding "same stable key" early-return-и, които преди Fix №3
// пропускаха целия ancillary tail. Отделна стая (без cut-index interaction
// noise), cutterSeat='right' (локалният играч НЕ е cutter) — за да не влияе
// isCutSubmissionPending/isInteractive върху stable key-я между snapshot-ите.
// ─────────────────────────────────────────────────────────────────────────

const ancillaryCuttingGame = {
  phase: 'cutting',
  authoritativePhase: 'cutting',
  timerDeadlineAt: Date.now() + 20_000,
  dealerSeat: 'left',
  firstDealSeat: null,
  cutting: { cutterSeat: 'right', deckCount: 32, selectedCutIndex: null, canSubmitCut: false },
  bidding: null,
  playing: null,
  scoring: null,
  matchEnded: null,
  declarations: [],
  score,
  handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
  ownHand: [],
}

await enter('ancillary-room')
await snapshot('ancillary-room', ancillaryCuttingGame)

const banner1 = { id: 'banner-1', kind: 'bots_inserted', message: 'Banner one', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }
const banner2 = { id: 'banner-2', kind: 'takeover_pending', message: 'Banner two', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() }

// [1] banner arrival докато cutting е в "same stable key" early-return (нищо
// cutting-relevant не се променя между двата snapshot-а — само banners).
await snapshot('ancillary-room', ancillaryCuttingGame, { tournamentBanners: [banner1] })
const bannerHostAfterArrival = root.querySelector('[data-tournament-banner-host="1"]')
const bannerArrivedAtEarlyReturn = bannerHostAfterArrival !== null
const bannerShowsCorrectId = bannerHostAfterArrival?.dataset.bannerId === banner1.id

// [6] repeated ancillary sync (несвързан no-op snapshot) не пресъздава host-а
// (доказва идемпотентния no-op път, не duplicate-listener risk).
await snapshot('ancillary-room', ancillaryCuttingGame, { tournamentBanners: [banner1] })
const bannerHostAfterNoopSync = root.querySelector('[data-tournament-banner-host="1"]')
const bannerHostStableAcrossNoopSync = bannerHostAfterArrival === bannerHostAfterNoopSync

// [3] втори queued banner: добавяме banner2 (топ = последният в масива) —
// проверяваме коректния нов dataset.bannerId, после dismiss-ваме топа и
// проверяваме, че опашката коректно показва banner1 със собствен коректен id.
await snapshot('ancillary-room', ancillaryCuttingGame, { tournamentBanners: [banner1, banner2] })
const bannerHostShowsSecondQueued = root.querySelector('[data-tournament-banner-host="1"]')?.dataset.bannerId === banner2.id

root.querySelector('[data-tournament-banner-dismiss="1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()
const bannerHostAfterFirstDismiss = root.querySelector('[data-tournament-banner-host="1"]')
const queuedBannerShowsCorrectIdAfterDismiss = bannerHostAfterFirstDismiss?.dataset.bannerId === banner1.id

// [2] dismiss на последния banner премахва DOM-а изцяло.
root.querySelector('[data-tournament-banner-dismiss="1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()
const bannerHostRemovedAfterLastDismiss = root.querySelector('[data-tournament-banner-host="1"]') === null

// [4] leave warning се показва при cutting same-stable-key early-return.
document.body.querySelector('[data-active-room-leave-button="1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()
const leaveWarningHostAfterOpen = root.querySelector('[data-active-room-leave-warning="1"]')
const leaveWarningShownAtEarlyReturn = leaveWarningHostAfterOpen !== null

// [6] repeated sync — warning host не се пресъздава при несвързан no-op snapshot.
await snapshot('ancillary-room', ancillaryCuttingGame)
const leaveWarningHostAfterNoopSync = root.querySelector('[data-active-room-leave-warning="1"]')
const leaveWarningHostStableAcrossNoopSync = leaveWarningHostAfterOpen === leaveWarningHostAfterNoopSync

// [5] cancel премахва warning-а.
root.querySelector('[data-active-room-leave-cancel="1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
await waitForRenderedFrame()
const leaveWarningRemovedAfterCancel = root.querySelector('[data-active-room-leave-warning="1"]') === null

// [7] persistent bot takeover materialize-ва при early-return snapshot —
// само seats се променя (локалният seat 'bottom' минава isControlledByBot),
// нито едно cutting-relevant поле не се променя.
const seatsWithLocalBotTakeover = seats.map((seatSnapshot) =>
  seatSnapshot.seat === 'bottom' ? { ...seatSnapshot, isControlledByBot: true } : seatSnapshot,
)
await snapshot('ancillary-room', ancillaryCuttingGame, { seats: seatsWithLocalBotTakeover })
const botTakeoverPopupShownAtEarlyReturn = document.body.querySelector('[data-bot-takeover-overlay="1"]') !== null

// Връщаме seats фикстурата в нормално състояние за евентуални бъдещи scenario-та.
await snapshot('ancillary-room', ancillaryCuttingGame, { seats })

// [8] bidding early-return не блокира banner sync — идентичен принцип,
// отделна bidding стая с непроменени bidding-stable-key полета между двата
// snapshot-а, само banners се различават.
const ancillaryBiddingGame = {
  phase: 'bidding',
  authoritativePhase: 'bidding',
  timerDeadlineAt: Date.now() + 20_000,
  dealerSeat: 'left',
  firstDealSeat: 'bottom',
  cutting: null,
  bidding: {
    winningBid: null,
    currentBidderSeat: 'right',
    entries: [],
    canSubmitBid: false,
    validActions: null,
  },
  playing: null,
  scoring: null,
  matchEnded: null,
  declarations: [],
  score,
  handCounts: noVisibleHands,
  ownHand: [],
}

await enter('ancillary-bid-room')
await snapshot('ancillary-bid-room', ancillaryBiddingGame)
await snapshot('ancillary-bid-room', ancillaryBiddingGame, { tournamentBanners: [banner1] })
const biddingEarlyReturnShowsBanner = root.querySelector('[data-tournament-banner-host="1"]')?.dataset.bannerId === banner1.id

// ─────────────────────────────────────────────────────────────────────────
// Fix №4: emoji/phrase reactions вече минават scheduleActiveRoomRender(true)
// (PATCH_ALLOWED). По време на активна cutting анимация това трябва да hit-не
// patchEmojiOnlyInPanels (document.body target) — options.root cutting shell-ът
// не бива да се пресъздава изобщо. Доказваме чрез DOM identity stability на
// [data-active-room-phase="cutting"] node-а (не само на cuttingVisualRoot,
// за да хванем и евентуален options.root.innerHTML= regression, не само
// cuttingVisualRoot.innerHTML= regression).
// ─────────────────────────────────────────────────────────────────────────

const emojiCuttingGameArmed = {
  phase: 'cutting',
  authoritativePhase: 'cutting',
  timerDeadlineAt: Date.now() + 20_000,
  dealerSeat: 'left',
  firstDealSeat: null,
  cutting: { cutterSeat: 'top', deckCount: 32, selectedCutIndex: null, canSubmitCut: false },
  bidding: null,
  playing: null,
  scoring: null,
  matchEnded: null,
  declarations: [],
  score,
  handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
  ownHand: [],
}

await enter('emoji-cutting-room')
await snapshot('emoji-cutting-room', emojiCuttingGameArmed)
// selectedCutIndex: null -> конкретна стойност стартира pile-split cutting
// анимацията (startCuttingAnimation), FULL rebuild-ва shell-а веднъж и
// установява cuttingAnimation.renderedSelectionKey.
await snapshot('emoji-cutting-room', {
  ...emojiCuttingGameArmed,
  cutting: { ...emojiCuttingGameArmed.cutting, selectedCutIndex: 5 },
})

const cuttingShellBeforeReactions = root.querySelector('[data-active-room-phase="cutting"]')
const cuttingAnimationActiveBeforeReactions = cuttingShellBeforeReactions !== null

controller.handleServerMessage({
  type: 'emoji_reaction',
  roomId: 'emoji-cutting-room',
  seat: 'top',
  emojiId: '01',
})
await waitForRenderedFrame()

const cuttingShellAfterEmoji = root.querySelector('[data-active-room-phase="cutting"]')
const cuttingShellStableAfterEmoji = cuttingShellBeforeReactions === cuttingShellAfterEmoji
const emojiBubbleAppearedDuringCutAnimation =
  (document.body.querySelector('[data-seat-emoji-bubble="top"]')?.innerHTML.length ?? 0) > 0

controller.handleServerMessage({
  type: 'phrase_reaction',
  roomId: 'emoji-cutting-room',
  seat: 'top',
  phraseId: 'phrase_01',
})
await waitForRenderedFrame()

const cuttingShellAfterPhrase = root.querySelector('[data-active-room-phase="cutting"]')
const cuttingShellStableAfterPhrase = cuttingShellBeforeReactions === cuttingShellAfterPhrase
const phraseBubbleAppearedDuringCutAnimation =
  (document.body.querySelector('[data-seat-phrase-bubble="top"]')?.innerHTML.length ?? 0) > 0

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
  bannerArrivedAtEarlyReturn,
  bannerShowsCorrectId,
  bannerHostStableAcrossNoopSync,
  bannerHostShowsSecondQueued,
  queuedBannerShowsCorrectIdAfterDismiss,
  bannerHostRemovedAfterLastDismiss,
  leaveWarningShownAtEarlyReturn,
  leaveWarningHostStableAcrossNoopSync,
  leaveWarningRemovedAfterCancel,
  botTakeoverPopupShownAtEarlyReturn,
  biddingEarlyReturnShowsBanner,
  cuttingAnimationActiveBeforeReactions,
  cuttingShellStableAfterEmoji,
  emojiBubbleAppearedDuringCutAnimation,
  cuttingShellStableAfterPhrase,
  phraseBubbleAppearedDuringCutAnimation,
}

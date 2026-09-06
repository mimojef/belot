import {
  type ClientBidAction,
  type MatchFoundMessage,
  type MatchStake,
  type RoomBiddingSnapshot,
  type RoomCuttingSnapshot,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type TournamentAttendanceSnapshot,
  type TournamentRoundType,
  type RoomWinningBidSnapshot,
  type Seat,
  type ServerMessage,
} from '../network/createGameServerClient'
import {
  createCuttingSeatPanelsHtml,
  type DealtHandsData,
  type SeatEmojiBubble,
  type SeatPhraseBubble,
} from './cutting/renderCuttingSeatPanels'
import { getAnimatedEmojiPreviewUrl } from '../animatedEmoji/animatedEmojiAssets'
import {
  removeMobilePhraseBubbleFromOverlay,
  removeMobilePhraseOverlay,
  syncMobilePhraseOverlay,
} from './cutting/syncMobilePhraseOverlay'
import {
  type ActiveRoomFlowController,
  type ActiveRoomState,
  type BiddingUiState,
  type CreateActiveRoomFlowControllerOptions,
  type CuttingAnimationCache,
  type DealingAnimationCache,
  type EmojiReactionUiState,
  type PhraseReactionUiState,
  type PlayingUiCache,
} from './activeRoomTypes'
import {
  ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT,
  ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND,
  ACTIVE_ROOM_TABLE_BACKGROUND,
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
  ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
  SERVER_DEAL_ORDER,
  createBiddingUiState,
  createCuttingAnimationCache,
  createDealingAnimationCache,
  createEmojiReactionUiState,
  createPhraseReactionUiState,
  createPlayingUiCache,
  escapeHtml,
  getActiveRoomStageMetrics,
  getSeatAfterDealerForDealFallback,
  resetPlayingUiCache,
  computeNextLastKnownWinningBid,
} from './activeRoomShared'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'
import {
  getCuttingCycleKey,
  getDealFirstThreePhaseKey,
  getDealLastThreePhaseKey,
  getDealNextTwoPhaseKey,
  shouldKeepFirstThreeHandsVisible,
  shouldKeepLastThreeHandsVisible,
  shouldKeepNextTwoHandsVisible,
} from './activeRoomPhaseHelpers'
import {
  addBidBubble as addBidBubbleToState,
  clearBiddingUiState as clearBiddingUiStateFromStore,
  clearPendingBidSubmission as clearPendingBidSubmissionFromStore,
  getBidBubblesForRender as getBidBubblesForRenderFromStore,
} from './biddingUiState'
import { createCuttingVisualCountdownTracker } from './cutting/cuttingVisualCountdown'
import {
  CUTTING_VISUAL_ANIMATION_TOTAL_MS,
  type RenderCuttingAnimationState,
  renderCuttingScreen,
} from './renderCuttingScreen'
import {
  DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
  DEAL_FIRST_THREE_PACKET_DELAY_STEP_MS,
  DEAL_FIRST_THREE_PACKET_START_DELAY_MS,
  DEAL_FIRST_THREE_REVEAL_AFTER_PACKET_MS,
  DEAL_LAST_THREE_VISUAL_TOTAL_MS,
  DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
  DEAL_PACKET_DURATION_MS,
  DEAL_PACKET_DELAY_STEP_MS,
  DEAL_REVEAL_OVERLAP_MS,
  DEAL_PACKET_START_DELAY_MS,
  type RenderDealingAnimationState,
  renderDealFirstThreePacketsHtml,
  renderDealLastThreePacketsHtml,
  renderDealNextTwoPacketsHtml,
  renderDealingScreen,
  syncDealingScreenTargets,
} from './renderDealingScreen'
import {
  type DealPacketOverlayState,
  createDealPacketOverlayState,
  getDealPacketOverlayElapsedMs,
  mountDealPacketOverlay,
  unmountDealPacketOverlay,
} from './dealPacketOverlay'
import {
  BID_BOT_DELAY_MS,
  BID_HUMAN_TIMEOUT_MS,
  getBidActionLabel,
  renderBiddingStageHtml,
  createBiddingInteractionHtml,
} from './renderBiddingScreen'
import { sortLocalHandForAllTrumps, sortLocalHandForDisplay, type SortDisplayOptions } from './sortLocalHand'
import { renderPlayingScreen, removeBottomHandOverlay, type RenderPlayingScreenOptions } from './renderPlayingScreen'
import { renderScoringScreen } from './renderScoringPanel'
import { renderMatchEndedScreen } from './renderMatchEndedScreen'
import { renderScoreHud } from './renderScoreHud'
import { showStakeDeductionEffect } from './renderStakeDeductionEffect'
import { PHRASE_REACTIONS, getPhraseReactionText } from './phraseReactions'
import {
  removeSeatProfileOverlay,
  showSeatProfileOverlay,
  updateSeatProfileOverlay,
} from './renderSeatProfileOverlay'
import {
  mountStandaloneProfileAccessBlockPopup,
  type ProfileAccessBlockPopupState,
} from '../../ui/overlays/renderProfileAccessBlockPopup'

const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

const REACTION_COUNTDOWN_WARNING_THRESHOLD_MS = 7_000

// submit_bid_action е fire-and-forget (createGameServerClient.ts) — ако
// сървърът никога не отговори (silent drop, изгубен snapshot и т.н.),
// markBiddingPopupPending() няма собствен self-recovery и popup-ът би
// останал блокиран завинаги. Двата timeout-а по-долу ограничават колко
// дълго чакаме, преди да опитаме resync, и после reconnect fallback.
// Реален healthy round-trip приключва за части от секундата; 5s е щедър
// marge за нормален mobile latency, но достатъчно кратък играчът да не
// седи дълго на заклещен UI.
const BID_RESPONSE_WATCHDOG_MS = 5_000
const BID_RESYNC_RESPONSE_TIMEOUT_MS = 5_000

// Огледало на server round ladder-а (round_of_16/quarterfinal/semifinal/final),
// виж tournamentRoundTypeLabel в renderTournamentsScreen.ts — дублирано тук
// умишлено (малък pure string helper), за да не се вкарва cross-module
// зависимост само заради едно label switch-ване.
function tournamentWaitingRoundLabel(roundType: string | null): string {
  if (roundType === 'round_of_16') return 'Осминафинал'
  if (roundType === 'quarterfinal') return 'Четвъртфинал'
  if (roundType === 'final') return 'Финал'
  if (roundType === 'semifinal') return 'Полуфинал'
  return 'Турнирен мач'
}


export function createActiveRoomFlowController(
  options: CreateActiveRoomFlowControllerOptions,
): ActiveRoomFlowController {
  const pendingRoomSnapshots = new Map<string, RoomSnapshotMessage>()
  // STATE B silent attach watch (armPendingTournamentSilentEntry) — see the
  // room_snapshot branch of handleServerMessage below.
  let pendingTournamentSilentEntry: { roomId: string; seat: Seat; stake: MatchStake } | null = null
  let activeRoomState: ActiveRoomState | null = null
  // In-game/private-room seat popup denial state — mount-натo self-contained
  // на document.body (виж renderProfileAccessBlockPopup.ts), тъй като active
  // room-ът няма lobby root DOM да вгради inline HTML в него. Общ path с
  // lobby-я — не копирано UI/block logic, виж task brief-а.
  let profileAccessBlockPopup: ProfileAccessBlockPopupState = null
  let profileAccessBlockSuccessTimeoutId: number | null = null
  const cuttingVisualCountdown = createCuttingVisualCountdownTracker()
  const cuttingAnimation: CuttingAnimationCache = createCuttingAnimationCache()
  const dealingAnimation: DealingAnimationCache = createDealingAnimationCache()
  const dealNextTwoAnimation: DealingAnimationCache = createDealingAnimationCache()
  const dealLastThreeAnimation: DealingAnimationCache = createDealingAnimationCache()
  const firstThreeOverlay: DealPacketOverlayState = createDealPacketOverlayState()
  const nextTwoOverlay: DealPacketOverlayState = createDealPacketOverlayState()
  const lastThreeOverlay: DealPacketOverlayState = createDealPacketOverlayState()
  const biddingUiState: BiddingUiState = createBiddingUiState()
  // Watchdog state за submit_bid_action fire-and-forget freeze (виж
  // BID_RESPONSE_WATCHDOG_MS по-горе). resyncRequested/reconnectTriggered
  // дедуплират: най-много един resync опит и най-много един reconnect
  // fallback на pending bid.
  const bidWatchdog: {
    bidResponseTimerId: number | null
    resyncTimeoutId: number | null
    resyncRequested: boolean
    reconnectFallbackTriggered: boolean
  } = {
    bidResponseTimerId: null,
    resyncTimeoutId: null,
    resyncRequested: false,
    reconnectFallbackTriggered: false,
  }
  const emojiReactionUiState: EmojiReactionUiState = createEmojiReactionUiState()
  const phraseReactionUiState: PhraseReactionUiState = createPhraseReactionUiState()
  let emojiPickerOpen = false
  let phrasePickerOpen = false
  const EMOJI_BUBBLE_DURATION_MS = 4000
  const PHRASE_BUBBLE_DURATION_MS = 4500
  const EMOJI_COUNT = 24
  const SCORING_VISUAL_COUNTDOWN_MS = 5000
  const TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS = 2500
  const playingCache: PlayingUiCache = createPlayingUiCache()
  let lastKnownWinningBid: NonNullable<RoomWinningBidSnapshot> | null = null
  let scoringCountdownIntervalId: number | null = null
  let scoringVisualCountdownKey: string | null = null
  let scoringVisualCountdownStartedAt = 0
  let stablePhaseRenderKey: string | null = null
  let lastLeaveWarningHtml: string | null = null
  const playedScoringPresentationKeys = new Set<string>()
  let reactionCountdownAudioIntervalId: number | null = null
  let matchEndedSoundPlayed = false
  let matchEndedPrizeAnimated = false
  let matchEndedPrizeAnimatedTimerId: number | null = null
  let replayStakeEffectShown = false
  let initialStakeEffectShown = false
  let shouldSilenceNextBiddingSnapshot = false
  let matchEndedCountdownDeadlineAt: number | null = null
  // Tournament round-result екран (§8 в task spec-а) — feeder match info
  // (sibling match от текущия round, който определя следващия съперник) се
  // fetch-ва еднократно (HTTP) при завършек на не-финален турнирен мач,
  // после се обновява само чрез tournament_feeder_match_completed push
  // (§9 от планирането: "WS push само при completion", не polling).
  let tournamentRoundResultMatchId: string | null = null
  let tournamentRoundResultFeederLabel: string | null = null
  let tournamentRoundResultFeederMatchId: string | null = null
  let tournamentRoundResultFeederStatus: 'in_progress' | 'completed' | null = null
  let tournamentRoundResultFeederScoreA: number | null = null
  let tournamentRoundResultFeederScoreB: number | null = null
  let tournamentRoundResultFetchInFlight = false
  let tournamentRoundResultAutoTransitionTimerId: number | null = null
  let tournamentRoundResultAutoTransitionKey: string | null = null
  let tournamentRoundResultCompletedTransitionKey: string | null = null
  // Final-резултат prize сума (§ "Champion/Runner-up prize popup" в task
  // spec-а) — matchEnded.awardedPrizeAmount е structurally null за турнирни
  // стаи (виж payoutMatchWinners exclusion в server/src/index.ts), затова
  // единственият authoritative източник е viewer.myPrizeAmount от
  // tournament detail fetch-а, огледално на tournamentRoundResultFeeder*
  // pattern-а по-горе.
  let tournamentFinalResultMatchId: string | null = null
  let tournamentFinalResultPrizeAmount: number | null = null
  let tournamentFinalResultFetchInFlight = false
  let tournamentFinalResultPendingRetryTimerId: number | null = null
  let tournamentFinalResultFastRetryCount = 0
  let tournamentFinalResultSlowRetryCount = 0

  function getSeatGender(seat: Seat): RoomSeatSnapshot['gender'] {
    return activeRoomState?.seats.find((entry) => entry.seat === seat)?.gender ?? null
  }
  let matchEndedCountdownSeconds = 120
  let matchEndedCountdownIntervalId: number | null = null
  // Targeted ticker за tournament attendance екрана (§"3-MINUTE SCREEN
  // REALTIME BEHAVIOR" в task spec-а) — patch-ва само timer текста между
  // реалните room_snapshot push-ове (сървърът вече push-ва цял snapshot при
  // всеки coordinator tick/presence промяна), вместо да прави пълен
  // renderActiveRoomScreen() rebuild всяка секунда (старото поведение).
  let tournamentAttendanceTickerIntervalId: number | null = null
  let tournamentAttendanceTickerRenderKey: string | null = null

  function getMatchEndedCountdownSeconds(): number {
    if (matchEndedCountdownDeadlineAt === null) {
      return matchEndedCountdownSeconds
    }

    return Math.max(0, Math.ceil((matchEndedCountdownDeadlineAt - Date.now()) / 1000))
  }

  function syncMatchEndedCountdownDisplay(): void {
    matchEndedCountdownSeconds = getMatchEndedCountdownSeconds()
    const el = options.root.querySelector<HTMLElement>('[data-match-ended-countdown="1"]')
    if (el) {
      el.textContent = `${matchEndedCountdownSeconds}с`
      el.style.color = matchEndedCountdownSeconds <= 30 ? '#f87171' : 'rgba(226,232,240,0.44)'
    }

    if (matchEndedCountdownSeconds <= 0) {
      clearMatchEndedCountdown()
      returnToLobbyFromMatchEnded()
    }
  }

  function clearMatchEndedCountdown(): void {
    if (matchEndedCountdownIntervalId !== null) {
      clearInterval(matchEndedCountdownIntervalId)
      matchEndedCountdownIntervalId = null
    }
    matchEndedCountdownDeadlineAt = null
    if (matchEndedPrizeAnimatedTimerId !== null) {
      clearTimeout(matchEndedPrizeAnimatedTimerId)
      matchEndedPrizeAnimatedTimerId = null
    }
    clearTournamentRoundResultAutoTransitionTimer()
  }

  function startMatchEndedCountdown(): void {
    clearMatchEndedCountdown()
    matchEndedCountdownDeadlineAt = Date.now() + 120_000
    matchEndedCountdownSeconds = 120
    matchEndedCountdownIntervalId = window.setInterval(() => {
      syncMatchEndedCountdownDisplay()
    }, 1000)
  }

  function clearTournamentRoundResultAutoTransitionTimer(): void {
    if (tournamentRoundResultAutoTransitionTimerId !== null) {
      clearTimeout(tournamentRoundResultAutoTransitionTimerId)
      tournamentRoundResultAutoTransitionTimerId = null
    }
    tournamentRoundResultAutoTransitionKey = null
  }

  function clearTournamentRoundResultState(): void {
    clearTournamentRoundResultAutoTransitionTimer()
    tournamentRoundResultMatchId = null
    tournamentRoundResultFeederLabel = null
    tournamentRoundResultFeederMatchId = null
    tournamentRoundResultFeederStatus = null
    tournamentRoundResultFeederScoreA = null
    tournamentRoundResultFeederScoreB = null
    tournamentRoundResultCompletedTransitionKey = null
  }

  // Намира "sibling" мача от СЪЩИЯ round (двойката, чийто победител определя
  // следващия съперник) — pairing правилото на coordinator-а е adjacent по
  // match/round_index ред (winner[0] vs winner[1], winner[2] vs winner[3]...),
  // виж коментара при ensureNextRound в tournamentCoordinator.ts. Round
  // matches идват в roundIndex ред от HTTP detail-а, затова индексът в
  // масива директно определя pair-а: (0,1), (2,3)...
  function findTournamentFeederMatch(
    detail: import('../network/createGameServerClient').TournamentDetailSnapshot,
    completedMatchId: string,
  ): { label: string; matchId: string; status: 'in_progress' | 'completed'; scoreA: number | null; scoreB: number | null } | null {
    for (const round of detail.rounds) {
      const index = round.matches.findIndex((match) => match.matchId === completedMatchId)
      if (index === -1) continue
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1
      const sibling = round.matches[siblingIndex]
      if (!sibling) return null
      const roundLabel = tournamentWaitingRoundLabel(round.roundType)
      return {
        label: `${roundLabel} — Мач ${round.matches.indexOf(sibling) + 1}`,
        matchId: sibling.matchId,
        status: sibling.status === 'completed' ? 'completed' : 'in_progress',
        scoreA: sibling.finalScoreTeamA ?? sibling.liveScoreTeamA ?? null,
        scoreB: sibling.finalScoreTeamB ?? sibling.liveScoreTeamB ?? null,
      }
    }
    return null
  }

  // Споделено между нормалния round-result екран и walkover-result екрана
  // (§7 в task spec-а) — и двата показват същата "Изчаква се краят на
  // другия полуфинал" кутия, захранена от tournamentRoundResultFeeder* state-а.
  function computeFeederStatusText(): string {
    return tournamentRoundResultFeederStatus === 'completed'
      ? `${tournamentRoundResultFeederScoreA ?? 0} : ${tournamentRoundResultFeederScoreB ?? 0} — завършен`
      : tournamentRoundResultFeederStatus === 'in_progress'
        ? tournamentRoundResultFeederScoreA !== null && tournamentRoundResultFeederScoreB !== null
          ? `${tournamentRoundResultFeederScoreA} : ${tournamentRoundResultFeederScoreB} — мачът е в ход`
          : 'Мачът е в ход'
        : 'Изчаква се...'
  }

  function getTournamentRoundResultTransitionContext(): {
    key: string
    tournamentId: string
    semifinalMatchId: string
    currentRoundType: TournamentRoundType
    wonRound: boolean
    semifinalScoreA: number | null
    semifinalScoreB: number | null
    feeder: { tournamentId: string; label: string; scoreA: number | null; scoreB: number | null; status: 'in_progress' | 'completed' } | null
  } | null {
    if (
      activeRoomState === null ||
      !activeRoomState.isTournamentMatchOrigin ||
      activeRoomState.tournamentId === null ||
      activeRoomState.tournamentRoundType === null ||
      activeRoomState.tournamentRoundType === 'final' ||
      activeRoomState.tournamentMatchId === null ||
      activeRoomState.game?.matchEnded == null ||
      // game.matchEnded вече е populated по време на самата 'scoring' фаза на
      // печелившата ръка (сървърът изчислява winner/matchEnded в момента на
      // влизане в scoring, преди authoritative-ния 5s summaryVisibleMs delay
      // — виж startServerScoringPhase.ts). Без тази проверка, произволно
      // tournament_match_assigned съобщение (coordinator-ът ги преизпраща на
      // всеки tick за ВСЕКИ runnable мач, включително вече in_progress —
      // виж main.ts:completePendingTournamentRoundResultTransition()) би
      // приело контекста за валиден и би прекъснало scoring панела преди
      // сървърът реално да е преминал в 'match-ended'.
      activeRoomState.game.authoritativePhase !== 'match-ended'
    ) {
      return null
    }
    const tournamentId = activeRoomState.tournamentId
    const localTeam = activeRoomState.seat === 'bottom' || activeRoomState.seat === 'top' ? 'A' : 'B'
    const wonRound = activeRoomState.game.matchEnded.winnerTeam === localTeam
    const feeder = tournamentRoundResultFeederLabel !== null
      ? {
          tournamentId,
          label: tournamentRoundResultFeederLabel,
          scoreA: tournamentRoundResultFeederScoreA,
          scoreB: tournamentRoundResultFeederScoreB,
          status: tournamentRoundResultFeederStatus ?? 'in_progress',
        }
      : null
    return {
      key: `${activeRoomState.roomId}:${activeRoomState.tournamentMatchId}:${activeRoomState.game.matchEnded.winnerTeam}`,
      tournamentId,
      semifinalMatchId: activeRoomState.tournamentMatchId,
      currentRoundType: activeRoomState.tournamentRoundType,
      wonRound,
      semifinalScoreA: activeRoomState.game.matchEnded.finalScore.teamA,
      semifinalScoreB: activeRoomState.game.matchEnded.finalScore.teamB,
      feeder,
    }
  }

  function completeTournamentRoundResultTransition(expectedKey?: string): boolean {
    const context = getTournamentRoundResultTransitionContext()
    if (context === null) return false
    if (expectedKey !== undefined && context.key !== expectedKey) return false
    if (!context.wonRound) return false
    if (tournamentRoundResultCompletedTransitionKey === context.key) return false

    tournamentRoundResultCompletedTransitionKey = context.key
    clearTournamentRoundResultAutoTransitionTimer()
    options.acknowledgeTournamentSemifinalResult(context.tournamentId, context.semifinalMatchId)
    returnToLobbyFromMatchEnded()
    options.onEnterWaitingForNextTournamentRound(context.feeder, context.tournamentId, {
      currentRoundType: context.currentRoundType,
      semifinalScoreA: context.semifinalScoreA,
      semifinalScoreB: context.semifinalScoreB,
    })
    return true
  }

  function continueFromTournamentRoundResultButton(): boolean {
    const context = getTournamentRoundResultTransitionContext()
    if (context === null) return false
    if (context.wonRound) {
      return completeTournamentRoundResultTransition(context.key)
    }
    if (tournamentRoundResultCompletedTransitionKey === context.key) return false
    tournamentRoundResultCompletedTransitionKey = context.key
    clearTournamentRoundResultAutoTransitionTimer()
    returnToLobbyFromMatchEnded()
    return true
  }

  function ensureTournamentRoundResultAutoTransitionTimer(): void {
    const context = getTournamentRoundResultTransitionContext()
    if (context === null || !context.wonRound) {
      clearTournamentRoundResultAutoTransitionTimer()
      return
    }
    if (
      tournamentRoundResultAutoTransitionTimerId !== null &&
      tournamentRoundResultAutoTransitionKey === context.key
    ) {
      return
    }

    clearTournamentRoundResultAutoTransitionTimer()
    tournamentRoundResultAutoTransitionKey = context.key
    tournamentRoundResultAutoTransitionTimerId = window.setTimeout(() => {
      completeTournamentRoundResultTransition(context.key)
    }, TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS)
  }

  // Walkover-специфичен аналог на completeTournamentRoundResultTransition/
  // ensureTournamentRoundResultAutoTransitionTimer по-горе. Не може да се
  // преизползва directly getTournamentRoundResultTransitionContext(), защото
  // тя изисква реален activeRoomState.game?.matchEnded snapshot — а при
  // walkover room.game.phase остава 'bootstrap' завинаги (виж коментара при
  // walkover клона по-долу), т.е. контекстът винаги би бил null. Затова
  // walkover-ът има собствен, паралелен "complete" helper — споделен между
  // ръчния "Към турнира" бутон И auto-transition таймера, за да не се
  // дублира acknowledgement логиката на две места.
  //
  // acknowledgeTournamentSemifinalResult е idempotent на сървъра (UNIQUE
  // constraint + ON CONFLICT DO NOTHING в
  // tournament_semifinal_result_acknowledgements, виж миграция
  // 20260801_003) — затова е безопасно да бъде извикан и от manual click,
  // и от auto-timer при race, без клиентски dedup guard за самия ack.
  function acknowledgeTournamentSemifinalWalkoverIfNeeded(
    tournamentId: string,
    semifinalMatchId: string,
    wonByWalkover: boolean,
    isFinalRound: boolean,
  ): void {
    if (wonByWalkover && !isFinalRound) {
      options.acknowledgeTournamentSemifinalResult(tournamentId, semifinalMatchId)
    }
  }

  function completeTournamentWalkoverTransition(
    key: string,
    tournamentId: string,
    semifinalMatchId: string,
    wonByWalkover: boolean,
    isFinalRound: boolean,
    currentRoundType: TournamentRoundType,
    feeder: { tournamentId: string; label: string; scoreA: number | null; scoreB: number | null; status: 'in_progress' | 'completed' } | null,
  ): void {
    if (tournamentRoundResultCompletedTransitionKey === key) return
    tournamentRoundResultCompletedTransitionKey = key
    clearTournamentRoundResultAutoTransitionTimer()
    acknowledgeTournamentSemifinalWalkoverIfNeeded(tournamentId, semifinalMatchId, wonByWalkover, isFinalRound)
    returnToLobbyFromMatchEnded()
    if (wonByWalkover && !isFinalRound) {
      options.onEnterWaitingForNextTournamentRound(feeder, tournamentId, {
        currentRoundType,
        semifinalScoreA: null,
        semifinalScoreB: null,
      })
    }
  }

  function ensureTournamentWalkoverAutoTransitionTimer(
    key: string,
    tournamentId: string,
    semifinalMatchId: string,
    wonByWalkover: boolean,
    isFinalRound: boolean,
    currentRoundType: TournamentRoundType,
    feeder: { tournamentId: string; label: string; scoreA: number | null; scoreB: number | null; status: 'in_progress' | 'completed' } | null,
  ): void {
    if (!wonByWalkover || isFinalRound) {
      clearTournamentRoundResultAutoTransitionTimer()
      return
    }
    if (
      tournamentRoundResultAutoTransitionTimerId !== null &&
      tournamentRoundResultAutoTransitionKey === key
    ) {
      return
    }

    clearTournamentRoundResultAutoTransitionTimer()
    tournamentRoundResultAutoTransitionKey = key
    tournamentRoundResultAutoTransitionTimerId = window.setTimeout(() => {
      completeTournamentWalkoverTransition(key, tournamentId, semifinalMatchId, wonByWalkover, isFinalRound, currentRoundType, feeder)
    }, TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS)
  }

  function shouldEnterTournamentInterRoundWaitingImmediately(): boolean {
    const context = getTournamentRoundResultTransitionContext()
    return context !== null && context.wonRound
  }

  function continueFromTournamentFinalResult(tournamentId: string): void {
    returnToLobbyFromMatchEnded()
    options.onTournamentFinalResultContinue(tournamentId)
  }

  function renderTournamentFinalResultScreen(input: {
    mobileLayoutAttribute: string
    tableBackground: string
  }): boolean {
    if (
      activeRoomState === null ||
      activeRoomState.game === null ||
      activeRoomState.game.matchEnded === null ||
      !activeRoomState.isTournamentMatchOrigin ||
      activeRoomState.tournamentRoundType !== 'final' ||
      activeRoomState.tournamentId === null
    ) {
      return false
    }

    const matchEnded = activeRoomState.game.matchEnded
    const localTeam = activeRoomState.seat === 'bottom' || activeRoomState.seat === 'top' ? 'A' : 'B'
    const wonFinal = matchEnded.winnerTeam === localTeam
    const finalScore = matchEnded.finalScore ?? activeRoomState.game.score.match
    const myScore = localTeam === 'A' ? finalScore.teamA : finalScore.teamB
    const opponentScore = localTeam === 'A' ? finalScore.teamB : finalScore.teamA
    const tournamentId = activeRoomState.tournamentId

    if (
      activeRoomState.tournamentMatchId !== null &&
      tournamentFinalResultMatchId !== activeRoomState.tournamentMatchId
    ) {
      tournamentFinalResultMatchId = activeRoomState.tournamentMatchId
      tournamentFinalResultPrizeAmount = null
      clearTournamentFinalResultPendingRetry()
      void loadTournamentFinalResultPrizeInfo(tournamentId, activeRoomState.tournamentMatchId)
    }

    // viewer.myPrizeAmount (authoritative, settlement-backed) — НЕ
    // matchEnded.awardedPrizeAmount, което е structurally null за турнирни
    // стаи (виж коментара при loadTournamentFinalResultPrizeInfo).
    const prizeAmount = tournamentFinalResultPrizeAmount
    const prizeText = prizeAmount !== null && prizeAmount > 0
      ? `Награда: +${prizeAmount.toLocaleString('bg-BG')} жълтици`
      : 'Наградата се обработва.'

    cuttingVisualCountdown.resetCuttingVisualCountdownState()
    clearMatchEndedCountdown()
    if (!matchEndedSoundPlayed) {
      matchEndedSoundPlayed = true
      options.gameAudio?.playMatchEnded()
    }

    options.root.innerHTML = `
      <div
        ${input.mobileLayoutAttribute}
        style="
          min-height:100vh;width:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
          overflow:hidden;background:${input.tableBackground};font-family:Inter, system-ui, sans-serif;
        "
      >
        <div style="
          width:min(92vw, 500px);max-height:calc(100dvh - 32px);overflow:auto;box-sizing:border-box;
          border:1px solid ${wonFinal ? 'rgba(34,197,94,0.45)' : 'rgba(250,204,21,0.38)'};
          border-radius:8px;padding:24px;background:rgba(15,23,42,0.94);color:#f8fafc;
          box-shadow:0 24px 70px rgba(2,6,23,0.45);text-align:center;
        ">
          <div style="font-size:13px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:#93c5fd;">Финал</div>
          <div data-tournament-final-result-title="1" style="margin-top:10px;font-size:28px;font-weight:900;color:${wonFinal ? '#22c55e' : '#facc15'};">${wonFinal ? 'Вие спечелихте турнира!' : 'Класирахте се на второ място!'}</div>
          <div style="margin-top:12px;font-size:20px;font-weight:900;">${myScore} : ${opponentScore}</div>
          <div data-tournament-final-result-prize="1" style="margin-top:12px;font-size:14px;font-weight:800;color:${prizeAmount !== null && prizeAmount > 0 ? '#dcfce7' : '#fde68a'};">${escapeHtml(prizeText)}</div>
          <div style="margin-top:20px;">
            <button type="button" data-tournament-final-result-detail="1" style="height:44px;padding:0 20px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:rgba(255,255,255,0.06);color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Към турнира</button>
          </div>
        </div>
      </div>
    `
    options.root.querySelector('[data-tournament-final-result-detail]')?.addEventListener('click', () => {
      continueFromTournamentFinalResult(tournamentId)
    })
    return true
  }

  async function loadTournamentRoundResultFeederInfo(tournamentId: string, completedMatchId: string): Promise<void> {
    if (tournamentRoundResultFetchInFlight) return
    tournamentRoundResultFetchInFlight = true
    try {
      const detail = await options.fetchTournamentDetail(tournamentId)
      if (detail === null || tournamentRoundResultMatchId !== completedMatchId) return
      const feeder = findTournamentFeederMatch(detail, completedMatchId)
      if (feeder === null) return
      tournamentRoundResultFeederLabel = feeder.label
      tournamentRoundResultFeederMatchId = feeder.matchId
      tournamentRoundResultFeederStatus = feeder.status
      tournamentRoundResultFeederScoreA = feeder.scoreA
      tournamentRoundResultFeederScoreB = feeder.scoreB
      scheduleActiveRoomRender()
    } finally {
      tournamentRoundResultFetchInFlight = false
    }
  }

  // FAST фазата покрива happy-path случая (settlement обикновено вече е
  // приключил синхронно преди този fetch, виж коментара по-долу). SLOW
  // фазата покрива доказан production gap: ако първият settlement опит
  // fail-не, tournamentCoordinator.reconcileSettlementDueTournament го
  // retry-ва едва на СЛЕДВАЩИЯ coordinator tick (DEFAULT_INTERVAL_MS = 5s
  // production, 1s local-test) — над FAST бюджета (1.75s). SLOW бюджетът
  // (~12s допълнително, общо ~13.75s) покрива поне два такива tick-а, докато
  // остава строго bounded (не unbounded polling).
  const TOURNAMENT_FINAL_RESULT_FAST_RETRY_MS = 350
  const TOURNAMENT_FINAL_RESULT_FAST_RETRY_MAX_ATTEMPTS = 5
  const TOURNAMENT_FINAL_RESULT_SLOW_RETRY_MS = 2000
  const TOURNAMENT_FINAL_RESULT_SLOW_RETRY_MAX_ATTEMPTS = 6

  function clearTournamentFinalResultPendingRetry(): void {
    if (tournamentFinalResultPendingRetryTimerId !== null) {
      window.clearTimeout(tournamentFinalResultPendingRetryTimerId)
      tournamentFinalResultPendingRetryTimerId = null
    }
    tournamentFinalResultFastRetryCount = 0
    tournamentFinalResultSlowRetryCount = 0
  }

  // matchEnded.awardedPrizeAmount е structurally null за турнирни стаи (виж
  // payoutMatchWinners exclusion в server/src/index.ts) — единственият
  // authoritative източник за реално начислената награда е
  // viewer.myPrizeAmount от tournament detail.
  async function loadTournamentFinalResultPrizeInfo(tournamentId: string, finalMatchId: string): Promise<void> {
    if (tournamentFinalResultFetchInFlight) return
    tournamentFinalResultFetchInFlight = true
    try {
      const detail = await options.fetchTournamentDetail(tournamentId)
      if (detail === null || tournamentFinalResultMatchId !== finalMatchId) return
      if (detail.viewer.myPrizeAmount !== null) {
        tournamentFinalResultPrizeAmount = detail.viewer.myPrizeAmount
        clearTournamentFinalResultPendingRetry()
        scheduleActiveRoomRender()
        return
      }
      const scheduleRetry = (delayMs: number): void => {
        tournamentFinalResultPendingRetryTimerId = window.setTimeout(() => {
          tournamentFinalResultPendingRetryTimerId = null
          if (tournamentFinalResultMatchId === finalMatchId) {
            void loadTournamentFinalResultPrizeInfo(tournamentId, finalMatchId)
          }
        }, delayMs)
      }
      if (tournamentFinalResultFastRetryCount < TOURNAMENT_FINAL_RESULT_FAST_RETRY_MAX_ATTEMPTS) {
        tournamentFinalResultFastRetryCount += 1
        scheduleRetry(TOURNAMENT_FINAL_RESULT_FAST_RETRY_MS)
        return
      }
      if (tournamentFinalResultSlowRetryCount < TOURNAMENT_FINAL_RESULT_SLOW_RETRY_MAX_ATTEMPTS) {
        tournamentFinalResultSlowRetryCount += 1
        scheduleRetry(TOURNAMENT_FINAL_RESULT_SLOW_RETRY_MS)
        return
      }
      // И двете bounded фази са изчерпани — спри окончателно, без повече
      // fetch-ове. Popup-ът остава на "Наградата се обработва.".
    } finally {
      tournamentFinalResultFetchInFlight = false
    }
  }

  function getLocalSeatSnapshot(): RoomSeatSnapshot | null {
    if (!activeRoomState) {
      return null
    }

    return activeRoomState.seats.find((seat) => seat.seat === activeRoomState!.seat) ?? null
  }

  function formatCoinAmount(value: number): string {
    return value.toLocaleString('bg-BG')
  }

  function isMatchEndedState(): boolean {
    if (!activeRoomState) {
      return false
    }

    return (
      activeRoomState.roomStatus === 'finished' ||
      activeRoomState.game?.authoritativePhase === 'match-ended' ||
      activeRoomState.game?.matchEnded != null
    )
  }

  function shouldWarnBeforeLeavingActiveRoom(): boolean {
    if (!activeRoomState) {
      return false
    }

    return activeRoomState.roomStatus !== null && !isMatchEndedState()
  }

  function renderFloatingLeaveButton(): string {
    if (isPhoneLayoutViewport()) {
      return `
        <div
          data-active-room-mobile-action-bar="1"
          style="
            position:fixed;
            left:0;
            right:0;
            bottom:0;
            z-index:9399;
            height:${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT}px;
            background:#000000;
            pointer-events:none;
          "
        >
          <button
            type="button"
            data-active-room-leave-button="1"
            title="Напусни масата"
            style="
              position:absolute;
              left:16px;
              top:50%;
              transform:translateY(-50%);
              height:40px;
              min-width:104px;
              border:0;
              border-radius:8px;
              padding:0 16px;
              background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
              color:#171717;
              font-size:14px;
              font-weight:900;
              cursor:pointer;
              box-shadow:0 10px 22px rgba(0,0,0,0.30);
              pointer-events:auto;
            "
          >
            Изход
          </button>
        </div>
      `
    }

    return `
      <button
        type="button"
        data-active-room-leave-button="1"
        title="Напусни масата"
        style="
          position:fixed;
          left:18px;
          bottom:24px;
          z-index:9400;
          border:1px solid rgba(251,191,36,0.45);
          border-radius:12px;
          padding:14px 22px;
          background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
          color:#171717;
          font-size:15px;
          font-weight:900;
          cursor:pointer;
          box-shadow:0 16px 34px rgba(0,0,0,0.28);
        "
      >
        Изход
      </button>
    `
  }

  function renderLeavePenaltyWarning(): string {
    if (!activeRoomState) {
      return ''
    }

    const phase = activeRoomState.game?.authoritativePhase ?? null
    const isPlayingPhase =
      phase === 'cutting' ||
      phase === 'deal-first-3' ||
      phase === 'deal-next-2' ||
      phase === 'bidding' ||
      phase === 'deal-last-3' ||
      phase === 'playing' ||
      phase === 'scoring'
    const extraPenaltyAmount = activeRoomState.stake
    const totalLossAmount = activeRoomState.stake + extraPenaltyAmount

    const bodyHtml = activeRoomState.isGuestTrial
      ? `
          <div style="font-size:24px;line-height:1.18;font-weight:900;color:#f8fafc;">
            Напускане на играта
          </div>
          <div style="margin-top:12px;font-size:15px;line-height:1.55;color:#d4d4d8;">
            Сигурен ли си, че искаш да напуснеш играта?
          </div>
        `
      : isPlayingPhase
      ? `
          <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#f6d36b;margin-bottom:10px;">
            Предупреждение
          </div>
          <div style="font-size:24px;line-height:1.18;font-weight:900;color:#f8fafc;">
            Напускане на масата
          </div>
          <div style="margin-top:12px;font-size:15px;line-height:1.55;color:#d4d4d8;">
            Залогът вече е платен. Ако напуснеш сега, губиш залога
            <strong style="color:#f6d36b;">${formatCoinAmount(activeRoomState.stake)}</strong>
            жълтици плюс още толкова като санкция. Обща загуба:
            <strong style="color:#f6d36b;">${formatCoinAmount(totalLossAmount)}</strong>
            жълтици.
          </div>
        `
      : `
          <div style="font-size:24px;line-height:1.18;font-weight:900;color:#f8fafc;">
            Напускане на стаята
          </div>
          <div style="margin-top:12px;font-size:15px;line-height:1.55;color:#d4d4d8;">
            Сигурен ли си, че искаш да напуснеш стаята?
          </div>
        `

    const confirmLabel = !activeRoomState.isGuestTrial && isPlayingPhase ? 'Напусни и плати' : 'Напусни'

    return `
      <div
        data-active-room-leave-warning="1"
        style="
          position:fixed;
          inset:0;
          z-index:11000;
          display:flex;
          align-items:center;
          justify-content:center;
          padding:22px;
          box-sizing:border-box;
          background:rgba(0,0,0,0.68);
          font-family:Inter, system-ui, sans-serif;
        "
      >
        <div
          style="
            width:min(92vw, 460px);
            border:1px solid rgba(251,191,36,0.34);
            border-radius:18px;
            padding:26px;
            background:linear-gradient(180deg, rgba(24,24,27,0.98) 0%, rgba(9,9,11,0.98) 100%);
            box-shadow:0 28px 80px rgba(0,0,0,0.54);
            color:#f8fafc;
            text-align:left;
          "
        >
          ${bodyHtml}

          <div
            style="
              margin-top:24px;
              display:flex;
              justify-content:flex-end;
              gap:12px;
              flex-wrap:wrap;
            "
          >
            <button
              type="button"
              data-active-room-leave-cancel="1"
              style="
                border:1px solid rgba(212,212,216,0.22);
                border-radius:12px;
                padding:12px 16px;
                background:rgba(39,39,42,0.92);
                color:#f4f4f5;
                font-size:14px;
                font-weight:900;
                cursor:pointer;
              "
            >
              Остани
            </button>

            <button
              type="button"
              data-active-room-leave-confirm="1"
              style="
                border:1px solid rgba(251,191,36,0.55);
                border-radius:12px;
                padding:12px 16px;
                background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
                color:#171717;
                font-size:14px;
                font-weight:900;
                cursor:pointer;
                box-shadow:0 14px 30px rgba(0,0,0,0.28);
              "
            >
              ${confirmLabel}
            </button>
          </div>
        </div>
      </div>
    `
  }

  function removeLeaveButton(): void {
    document.body.querySelector('[data-active-room-leave-button="1"]')?.remove()
    document.body.querySelector('[data-active-room-mobile-action-bar="1"]')?.remove()
    // Warning-ът живее в options.root (не document.body), но трябва да умре
    // заедно с останалия leave UI на всяко от местата, откъдето тази функция
    // вече се вика (match-ended, room exit/reset) — иначе би останал stale
    // DOM node И stale lastLeaveWarningHtml кеш, разчитайки единствено на
    // бъдещ options.root.innerHTML wipe, който не е гарантиран тук.
    options.root.querySelector('[data-active-room-leave-warning="1"]')?.remove()
    lastLeaveWarningHtml = null
  }

  function syncLeaveControls(): void {
    if (!activeRoomState || isMatchEndedState()) {
      removeLeaveButton()
      return
    }

    if (!document.body.querySelector('[data-active-room-leave-button="1"]')) {
      document.body.insertAdjacentHTML('beforeend', renderFloatingLeaveButton())
      document.body
        .querySelector<HTMLButtonElement>('[data-active-room-leave-button="1"]')
        ?.addEventListener('click', () => {
          if (!activeRoomState) {
            return
          }

          if (!options.isConnected()) {
            activeRoomState.errorText = 'Няма връзка със сървъра.'
            scheduleActiveRoomRender()
            return
          }

          requestActiveRoomLeave()
        })
    }

    const existingWarningHost = options.root.querySelector<HTMLElement>(
      '[data-active-room-leave-warning="1"]',
    )

    if (!activeRoomState.leavePenaltyWarningOpen) {
      existingWarningHost?.remove()
      lastLeaveWarningHtml = null
      return
    }

    const html = renderLeavePenaltyWarning()

    if (existingWarningHost && html === lastLeaveWarningHtml) {
      return
    }

    if (existingWarningHost) {
      existingWarningHost.outerHTML = html
    } else {
      options.root.insertAdjacentHTML('beforeend', html)
    }

    // outerHTML/insertAdjacentHTML създават НОВ node — старата referenced
    // node (ако имаше) е вече detached, затова re-query-ваме fresh преди да
    // cache-нем и bind-нем. Cache-ваме HTML-а само СЛЕД потвърдено успешен
    // DOM materialization — ако fresh host по някаква причина липсва, НЕ
    // cache-ваме нищо, за да не заклещим DOM/cache в перманентно
    // разминаване (следващият sync ще опита пак от нулата).
    const freshWarningHost = options.root.querySelector<HTMLElement>(
      '[data-active-room-leave-warning="1"]',
    )

    if (!freshWarningHost) {
      return
    }

    lastLeaveWarningHtml = html
    freshWarningHost.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      if (target.closest('[data-active-room-leave-cancel="1"]')) {
        if (!activeRoomState) {
          return
        }

        activeRoomState.leavePenaltyWarningOpen = false
        scheduleActiveRoomRender()
        return
      }

      if (target.closest('[data-active-room-leave-confirm="1"]')) {
        if (!activeRoomState) {
          return
        }

        if (!options.isConnected()) {
          activeRoomState.errorText = 'Няма връзка със сървъра.'
          activeRoomState.leavePenaltyWarningOpen = false
          scheduleActiveRoomRender()
          return
        }

        activeRoomState.leavePenaltyWarningOpen = false
        options.leaveActiveRoom(activeRoomState.roomId, true)
      }
    })
  }

  function requestActiveRoomLeave(): void {
    if (!activeRoomState) {
      return
    }

    if (!options.isConnected()) {
      activeRoomState.errorText = 'Няма връзка със сървъра.'
      activeRoomState.leavePenaltyWarningOpen = false
      scheduleActiveRoomRender()
      return
    }

    if (shouldWarnBeforeLeavingActiveRoom()) {
      activeRoomState.leavePenaltyWarningOpen = true
      scheduleActiveRoomRender()
      return
    }

    options.leaveActiveRoom(activeRoomState.roomId)
  }

  function renderPersistentBotTakeoverPopup(): string {
    return `
      <div
        data-bot-takeover-overlay="1"
        style="
          position:fixed;
          inset:0;
          z-index:10000;
          display:flex;
          align-items:center;
          justify-content:center;
          background:rgba(2,6,23,0.62);
          font-family:Inter, system-ui, sans-serif;
        "
      >
        <div style="
          width:min(88vw, 480px);
          background:rgba(15,23,42,0.98);
          border:1px solid rgba(148,163,184,0.22);
          border-radius:24px;
          padding:32px 28px;
          box-shadow:0 32px 72px rgba(0,0,0,0.42);
          text-align:center;
        ">
          <img
            src="/images/ui/robot_100x100.png"
            alt="Robot"
            style="
              width:64px;
              height:64px;
              object-fit:contain;
              margin-bottom:18px;
              filter:drop-shadow(0 10px 18px rgba(0,0,0,0.28));
            "
          >
          <div style="
            color:#f8fafc;
            font-size:18px;
            font-weight:700;
            line-height:1.5;
            margin-bottom:28px;
          ">
            Поради изтичане на времето за реакция,<br>играта беше поета от робот.
          </div>
          <button
            type="button"
            data-bot-takeover-dismiss="1"
            style="
              border:0;
              border-radius:14px;
              padding:14px 32px;
              background:linear-gradient(180deg,#3b82f6 0%,#1d4ed8 100%);
              color:#fff;
              font-size:16px;
              font-weight:800;
              cursor:pointer;
              font-family:inherit;
              box-shadow:0 8px 20px rgba(29,78,216,0.32);
            "
          >
            Върни се
          </button>
        </div>
      </div>
    `
  }

  function removePersistentBotTakeoverPopup(): void {
    document.body.querySelector('[data-bot-takeover-overlay="1"]')?.remove()
  }

  function removeSeatPanels(): void {
    document.body.querySelector('[data-seat-panels-host="1"]')?.remove()
    removeMobilePhraseOverlay()
    removeBiddingPopupOverlay()
  }

  const BIDDING_POPUP_HOST_ATTR = 'data-bidding-popup-host'

  // Bid popup живее в собствен host, синхронизиран с incremental DOM
  // diffing — same причина/похват като bottom-hand card buttons
  // (renderPlayingScreen.ts): submitBidActionFromUi разчита изцяло на
  // нативния 'click' event; ако options.root.innerHTML rewrite-ва popup-а
  // между pointerdown/pointerup на потребителя (напр. при room_snapshot
  // по време на активен bidding turn), браузърът не синтезира 'click' на
  // detached node-а и tap-ът се губи. Popup структурата е statична
  // (същите tiles) докато е visible, затова diff-ът само patch-ва
  // disabled/style атрибути на съществуващи бутони; rebuild само при
  // появяване/изчезване/промяна в набора активни бутони.
  function syncBiddingPopupOverlay(html: string): void {
    if (html === '') {
      removeBiddingPopupOverlay()
      return
    }

    let host = document.body.querySelector<HTMLDivElement>(`[${BIDDING_POPUP_HOST_ATTR}]`)
    if (!host) {
      host = document.createElement('div')
      host.setAttribute(BIDDING_POPUP_HOST_ATTR, '1')
      document.body.appendChild(host)
      host.innerHTML = html
      return
    }

    const temp = document.createElement('div')
    temp.innerHTML = html

    const newPopup = temp.querySelector<HTMLElement>('[data-bidding-popup="1"]')
    const existingPopup = host.querySelector<HTMLElement>('[data-bidding-popup="1"]')

    if (!newPopup || !existingPopup) {
      host.innerHTML = html
      return
    }

    const buttonKey = (btn: HTMLElement) => btn.dataset.bidAction ?? btn.dataset.bidSuit ?? ''
    const newButtons = Array.from(newPopup.querySelectorAll<HTMLButtonElement>('button[data-bid-action], button[data-bid-suit]'))
    const existingButtons = Array.from(existingPopup.querySelectorAll<HTMLButtonElement>('button[data-bid-action], button[data-bid-suit]'))
    const newKeys = new Set(newButtons.map(buttonKey))
    const existingKeys = new Set(existingButtons.map(buttonKey))
    const sameButtonSet = newKeys.size === existingKeys.size && [...newKeys].every((k) => existingKeys.has(k))

    if (!sameButtonSet) {
      host.innerHTML = html
      return
    }

    // Патчваме popup wrapper-а (opacity/transform/filter/pointer-events —
    // enter animation и pending-submission state) и всеки бутон, без да
    // пресъздаваме DOM node-овете.
    for (const attr of ['data-bidding-popup-enter', 'data-bidding-popup-final-opacity', 'data-bidding-popup-final-filter', 'data-bidding-popup-stage-scale']) {
      const newValue = newPopup.getAttribute(attr)
      if (newValue !== null && existingPopup.getAttribute(attr) !== newValue) {
        existingPopup.setAttribute(attr, newValue)
      }
    }
    const newPopupStyle = newPopup.getAttribute('style') ?? ''
    if (existingPopup.getAttribute('style') !== newPopupStyle) {
      existingPopup.setAttribute('style', newPopupStyle)
    }

    for (const newButton of newButtons) {
      const key = buttonKey(newButton)
      const existingButton = existingButtons.find((b) => buttonKey(b) === key)
      if (!existingButton) continue

      if (existingButton.disabled !== newButton.disabled) {
        existingButton.disabled = newButton.disabled
      }
      const newButtonStyle = newButton.getAttribute('style') ?? ''
      if (existingButton.getAttribute('style') !== newButtonStyle) {
        existingButton.setAttribute('style', newButtonStyle)
      }
    }
  }

  function removeBiddingPopupOverlay(): void {
    document.body.querySelector(`[${BIDDING_POPUP_HOST_ATTR}]`)?.remove()
  }

  function syncSeatPanels(html: string): void {
    let host = document.body.querySelector<HTMLDivElement>('[data-seat-panels-host="1"]')

    if (host && host.innerHTML.length > 0) {
      const temp = document.createElement('div')
      temp.innerHTML = html
      let ok = true

      // Force full rebuild if any seat's avatarUrl or highlighted state changed
      for (const anchor of Array.from(temp.querySelectorAll<HTMLElement>('[data-active-room-seat-anchor]'))) {
        const seatKey = anchor.getAttribute('data-active-room-seat-anchor')!
        const existing = host.querySelector<HTMLElement>(`[data-active-room-seat-anchor="${seatKey}"]`)
        if (
          !existing ||
          existing.getAttribute('data-seat-avatar-url') !== anchor.getAttribute('data-seat-avatar-url') ||
          existing.getAttribute('data-seat-highlighted') !== anchor.getAttribute('data-seat-highlighted')
        ) {
          ok = false
          break
        }
      }

      // Update countdown fill styles — only restart animation when the countdown key changes.
      // Same key = same turn still running, let CSS animation continue undisturbed.
      for (const fill of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-countdown-fill]'))) {
        const seat = fill.getAttribute('data-seat-countdown-fill')!
        const existing = host.querySelector<HTMLElement>(`[data-seat-countdown-fill="${seat}"]`)
        if (!existing) { ok = false; break }
        const newKey = fill.getAttribute('data-countdown-key') ?? ''
        const existingKey = existing.getAttribute('data-countdown-key') ?? ''
        const newActive = fill.getAttribute('data-countdown-active') ?? '0'
        const existingActive = existing.getAttribute('data-countdown-active') ?? '0'
        const sameCountdown = newKey !== '' && newKey === existingKey
        if (!sameCountdown || newActive !== existingActive) {
          if (newKey !== existingKey) existing.setAttribute('data-countdown-key', newKey)
          if (newActive !== existingActive) existing.setAttribute('data-countdown-active', newActive)
          const newStyle = fill.getAttribute('style') ?? ''
          if (existing.getAttribute('style') !== newStyle) existing.setAttribute('style', newStyle)
        }
      }

      // Update bid bubble wrappers (innerHTML only)
      if (ok) {
        for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-bid-bubble]'))) {
          const seat = bHost.getAttribute('data-seat-bid-bubble')!
          const existing = host.querySelector<HTMLElement>(`[data-seat-bid-bubble="${seat}"]`)
          if (!existing) { ok = false; break }
          if (existing.innerHTML !== bHost.innerHTML) {
            existing.innerHTML = bHost.innerHTML
          }
        }
      }

      // Update declaration bubble wrappers (innerHTML only)
      if (ok) {
        for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-declaration-bubble]'))) {
          const seat = bHost.getAttribute('data-seat-declaration-bubble')!
          const existing = host.querySelector<HTMLElement>(`[data-seat-declaration-bubble="${seat}"]`)
          if (!existing) { ok = false; break }
          if (existing.innerHTML !== bHost.innerHTML) {
            existing.innerHTML = bHost.innerHTML
          }
        }
      }

      // Update emoji bubble wrappers (innerHTML only) — сравняваме по
      // data-emoji-reaction-key (стабилен за живота на конкретната
      // reaction instance), не по цялото innerHTML, защото
      // animation-delay в markup-а се преизчислява от elapsedMs при
      // всеки render и би различавал string-и дори за СЪЩАТА активна
      // reaction. Replacement само когато ключът реално се е сменил (нова
      // reaction) — иначе <img> DOM node-ът остава недокоснат и animated
      // webp playback-ът не се рестартира.
      if (ok) {
        for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-emoji-bubble]'))) {
          const seat = bHost.getAttribute('data-seat-emoji-bubble')!
          const existing = host.querySelector<HTMLElement>(`[data-seat-emoji-bubble="${seat}"]`)
          if (!existing) { ok = false; break }
          const newKey = bHost.querySelector<HTMLElement>('[data-emoji-reaction-key]')
            ?.getAttribute('data-emoji-reaction-key') ?? null
          const existingKey = existing.querySelector<HTMLElement>('[data-emoji-reaction-key]')
            ?.getAttribute('data-emoji-reaction-key') ?? null
          if (newKey !== existingKey) {
            existing.innerHTML = bHost.innerHTML
          }
        }
      }

      if (ok) {
        for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-phrase-bubble]'))) {
          const seat = bHost.getAttribute('data-seat-phrase-bubble')!
          const existing = host.querySelector<HTMLElement>(`[data-seat-phrase-bubble="${seat}"]`)
          if (!existing) { ok = false; break }
          if (existing.innerHTML !== bHost.innerHTML) {
            existing.innerHTML = bHost.innerHTML
          }
        }
      }

      // Update card fan content (innerHTML only)
      if (ok) {
        const newFans = Array.from(temp.querySelectorAll<HTMLElement>('[data-active-room-seat-card-fan]'))
        const existingFans = Array.from(host.querySelectorAll<HTMLElement>('[data-active-room-seat-card-fan]'))
        const newSeats = new Set(newFans.map((f) => f.getAttribute('data-active-room-seat-card-fan')!))
        const existingSeats = new Set(existingFans.map((f) => f.getAttribute('data-active-room-seat-card-fan')!))

        // If fan set differs structurally, fall back to full rebuild
        const setsEqual = newSeats.size === existingSeats.size && [...newSeats].every((s) => existingSeats.has(s))
        if (!setsEqual) {
          ok = false
        } else {
          for (const fan of newFans) {
            const seat = fan.getAttribute('data-active-room-seat-card-fan')!
            const existing = host.querySelector<HTMLElement>(`[data-active-room-seat-card-fan="${seat}"]`)!
            if (existing.innerHTML !== fan.innerHTML) {
              existing.innerHTML = fan.innerHTML
            }
          }
        }
      }

      if (ok) return
    }

    // Full rebuild (first render or structural change)
    if (!host) {
      const el = document.createElement('div')
      el.setAttribute('data-seat-panels-host', '1')
      document.body.appendChild(el)
      host = el
    }
    host.innerHTML = html
  }

  function patchEmojiOnlyInPanels(html: string): void {
    const host = document.body.querySelector<HTMLElement>('[data-seat-panels-host="1"]')
    if (!host) return
    const temp = document.createElement('div')
    temp.innerHTML = html
    for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-emoji-bubble]'))) {
      const seat = bHost.getAttribute('data-seat-emoji-bubble')!
      const existing = host.querySelector<HTMLElement>(`[data-seat-emoji-bubble="${seat}"]`)
      if (!existing) continue
      if (existing.innerHTML !== bHost.innerHTML) {
        existing.innerHTML = bHost.innerHTML
      }
    }
    for (const bHost of Array.from(temp.querySelectorAll<HTMLElement>('[data-seat-phrase-bubble]'))) {
      const seat = bHost.getAttribute('data-seat-phrase-bubble')!
      const existing = host.querySelector<HTMLElement>(`[data-seat-phrase-bubble="${seat}"]`)
      if (!existing) continue
      if (existing.innerHTML !== bHost.innerHTML) {
        existing.innerHTML = bHost.innerHTML
      }
    }
  }

  function clearPhraseInPanels(seat: Seat): void {
    const host = document.body.querySelector<HTMLElement>('[data-seat-panels-host="1"]')
    if (!host) return
    const el = host.querySelector<HTMLElement>(`[data-seat-phrase-bubble="${seat}"]`)
    if (el) el.innerHTML = ''
  }

  function clearEmojiInPanels(seat: Seat): void {
    const host = document.body.querySelector<HTMLElement>('[data-seat-panels-host="1"]')
    if (!host) return
    const el = host.querySelector<HTMLElement>(`[data-seat-emoji-bubble="${seat}"]`)
    if (el) el.innerHTML = ''
  }

  function syncPersistentBotTakeoverPopup(): void {
    const localSeatSnapshot = getLocalSeatSnapshot()

    if (!activeRoomState || isMatchEndedState() || !localSeatSnapshot?.isControlledByBot) {
      removePersistentBotTakeoverPopup()
      return
    }

    if (document.body.querySelector('[data-bot-takeover-overlay="1"]')) {
      return
    }

    document.body.insertAdjacentHTML('beforeend', renderPersistentBotTakeoverPopup())

    const dismissBtn = document.body.querySelector<HTMLButtonElement>('[data-bot-takeover-dismiss="1"]')
    dismissBtn?.addEventListener('click', () => {
      if (!activeRoomState) {
        return
      }

      if (!options.isConnected()) {
        activeRoomState.errorText = 'Няма връзка със сървъра.'
        scheduleActiveRoomRender()
        return
      }

      options.resumeHumanControl(activeRoomState.roomId)
    })
  }

  function getContractSortOptions(): SortDisplayOptions {
    if (!lastKnownWinningBid) return { contract: 'default' }
    if (lastKnownWinningBid.contract === 'no-trumps') return { contract: 'no-trumps' }
    if (lastKnownWinningBid.contract === 'all-trumps') return { contract: 'all-trumps' }
    return { contract: 'suit', trumpSuit: lastKnownWinningBid.trumpSuit! }
  }

  function createSeatCardHtml(seat: RoomSeatSnapshot): string {
    const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'
    const occupancyText = seat.isOccupied
      ? seat.isBot
        ? 'Бот'
        : 'Играч'
      : 'Празно'
    const connectionText = seat.isOccupied
      ? seat.isConnected
        ? 'Свързан'
        : 'Изключен'
      : '—'

    return `
      <div
        style="
          border:1px solid rgba(148,163,184,0.22);
          border-radius:18px;
          padding:16px;
          background:rgba(15,23,42,0.58);
          box-shadow:0 14px 36px rgba(2,6,23,0.28);
        "
      >
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:12px;
            margin-bottom:12px;
          "
        >
          <div
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.08em;
              text-transform:uppercase;
              color:#93c5fd;
            "
          >
            ${SEAT_LABELS[seat.seat]}
          </div>

          <div
            style="
              font-size:11px;
              font-weight:800;
              color:${seat.isOccupied ? '#c4b5fd' : '#94a3b8'};
              text-transform:uppercase;
              letter-spacing:0.06em;
            "
          >
            ${occupancyText}
          </div>
        </div>

        <div
          style="
            display:flex;
            align-items:center;
            gap:12px;
          "
        >
          <div style="position:relative;width:56px;height:56px;flex:0 0 56px;">
            <div
              style="
                width:100%;
                height:100%;
                border-radius:16px;
                background:linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
                border:1px solid rgba(148,163,184,0.24);
                overflow:hidden;
              "
            >
              ${
                seat.avatarUrl
                  ? `<img
                      src="${escapeHtml(seat.avatarUrl)}"
                      alt="${escapeHtml(displayName)}"
                      style="width:100%;height:100%;object-fit:cover;display:block;"
                    />`
                  : `<div
                      style="
                        width:100%;
                        height:100%;
                        display:flex;
                        align-items:center;
                        justify-content:center;
                        color:#94a3b8;
                        font-size:11px;
                        font-weight:800;
                        letter-spacing:0.06em;
                        text-transform:uppercase;
                      "
                    >
                      Аватар
                    </div>`
              }
            </div>
            ${typeof seat.level === 'number' && seat.level >= 1 ? `<div style="position:absolute;right:5px;bottom:5px;display:flex;align-items:center;justify-content:center;padding:0 2px;line-height:1;z-index:1;color:#ffffff;font-size:14px;font-weight:400;text-shadow:-2px -2px 0 #000,0 -2px 0 #000,2px -2px 0 #000,-2px 0 0 #000,2px 0 0 #000,-2px 2px 0 #000,0 2px 0 #000,2px 2px 0 #000;">${Math.trunc(seat.level)}</div>` : ''}
          </div>

          <div style="min-width:0;flex:1 1 auto;">
            <div
              style="
                font-size:16px;
                font-weight:800;
                color:#f8fafc;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              "
            >
              ${escapeHtml(displayName)}
            </div>

            <div
              style="
                margin-top:4px;
                font-size:12px;
                color:#cbd5e1;
              "
            >
              ${connectionText}
            </div>
          </div>
        </div>
      </div>
    `
  }

  // Нов dedicated 3-минутен/pre-game tournament attendance екран (§"НОВ
  // 3-MINUTE WAITING SCREEN" в task spec-а) — заменя старата generic room
  // waiting card. Пълен rebuild само когато roster/state/resolutionKind
  // реално се промени (см. renderKey guard-а в главния render клон по-долу);
  // самият timer текст се patch-ва targeted от syncTournamentAttendanceCountdownDisplay,
  // без нов renderActiveRoomScreen() call всяка секунда.
  function renderTournamentAttendanceScreenHtml(
    tournamentAttendance: NonNullable<typeof activeRoomState>['tournamentAttendance'] & object,
    scoreHudHtml: string,
    mobileLayoutAttribute: string,
    tableBackground: string,
  ): string {
    const isCountdown = tournamentAttendance.state === 'countdown'
    const title = isCountdown
      ? tournamentAttendance.resolutionKind === 'bots_inserted'
        ? 'Липсващите места са запълнени с ботове'
        : 'Всички играчи са на масата'
      : 'Изчакване на играчите'
    const roundLabel = tournamentWaitingRoundLabel(activeRoomState!.tournamentRoundType)
    const botReplacementBySeat = new Map(
      activeRoomState!.tournamentBotReplacements.filter((item) => item.replacementActive).map((item) => [item.seat, item]),
    )
    const teamASeats: Seat[] = ['bottom', 'top']
    const teamBSeats: Seat[] = ['left', 'right']
    const renderTeamRosterHtml = (teamSeats: Seat[], teamLabel: string): string => {
      const rows = teamSeats.map((seat) => {
        const rosterEntry = tournamentAttendance.roster.find((item) => item.seat === seat)
        const isBotReplaced = botReplacementBySeat.has(seat)
        const displayName = rosterEntry?.displayName ?? 'Играч'
        const isOnline = isBotReplaced || (rosterEntry?.isOnline ?? false)
        const statusText = isBotReplaced ? 'БОТ' : isOnline ? 'Онлайн' : 'Офлайн'
        const statusColor = isBotReplaced ? '#facc15' : isOnline ? '#22c55e' : 'rgba(248,250,252,0.45)'
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:5px 0;">
            <span style="font-size:13px;font-weight:700;color:#f1f5f9;overflow-wrap:anywhere;">${escapeHtml(displayName)}</span>
            <span style="font-size:11px;font-weight:900;letter-spacing:0.03em;color:${statusColor};flex:0 0 auto;">${statusText}</span>
          </div>
        `
      }).join('')
      return `
        <div style="flex:1;min-width:0;text-align:left;">
          <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;color:#93c5fd;margin-bottom:4px;">${escapeHtml(teamLabel)}</div>
          ${rows}
        </div>
      `
    }
    const botRuleText = 'Ако играч не се яви до края на времето, мястото му временно ще бъде поето от бот. Играчът може да си поеме мястото, когато се появи.'

    return `
      <div
        ${mobileLayoutAttribute}
        style="
          min-height:100vh;
          width:100%;
          box-sizing:border-box;
          display:flex;
          align-items:center;
          justify-content:center;
          overflow:hidden;
          background:${tableBackground};
          font-family:Inter, system-ui, sans-serif;
        "
      >
        <div
          style="
            width:min(92vw, 540px);
            max-height:calc(100dvh - 32px);
            overflow:auto;
            box-sizing:border-box;
            border:1px solid rgba(255,255,255,0.18);
            border-radius:8px;
            padding:24px;
            background:rgba(15,23,42,0.92);
            color:#f8fafc;
            box-shadow:0 24px 70px rgba(2,6,23,0.45);
            text-align:center;
          "
        >
          <div style="font-size:13px;font-weight:900;text-transform:uppercase;color:#93c5fd;">${escapeHtml(roundLabel)}</div>
          <div style="margin-top:10px;font-size:20px;font-weight:900;line-height:1.3;">${escapeHtml(title)}</div>
          <div style="margin-top:6px;font-size:13px;line-height:1.5;color:rgba(248,250,252,0.65);">Мачът ще започне, когато всички се явят или след изтичане на времето.</div>
          <div data-tournament-attendance-timer="1" style="margin-top:16px;font-size:40px;font-weight:900;color:#facc15;font-variant-numeric:tabular-nums;"></div>
          <div style="margin-top:18px;display:flex;gap:18px;align-items:flex-start;justify-content:center;">
            ${renderTeamRosterHtml(teamASeats, 'Отбор A')}
            <div style="align-self:center;font-size:12px;font-weight:900;color:rgba(248,250,252,0.4);">VS</div>
            ${renderTeamRosterHtml(teamBSeats, 'Отбор Б')}
          </div>
          <div style="margin-top:16px;font-size:13px;line-height:1.5;color:#cbd5e1;">${escapeHtml(botRuleText)}</div>
        </div>
        ${scoreHudHtml}
      </div>
    `
  }

  function getTournamentAttendanceCountdownSeconds(): number {
    const tournamentAttendance = activeRoomState?.tournamentAttendance ?? null
    if (tournamentAttendance === null) return 0
    return tournamentAttendance.state === 'countdown'
      ? tournamentAttendance.startSecondsRemaining
      : tournamentAttendance.secondsRemaining
  }

  function syncTournamentAttendanceCountdownDisplay(): void {
    const el = options.root.querySelector<HTMLElement>('[data-tournament-attendance-timer="1"]')
    if (!el) return
    const seconds = Math.max(0, getTournamentAttendanceCountdownSeconds())
    el.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }

  function clearTournamentAttendanceTicker(): void {
    if (tournamentAttendanceTickerIntervalId !== null) {
      window.clearInterval(tournamentAttendanceTickerIntervalId)
      tournamentAttendanceTickerIntervalId = null
    }
    tournamentAttendanceTickerRenderKey = null
  }

  function startTournamentAttendanceTicker(): void {
    if (tournamentAttendanceTickerIntervalId !== null) {
      window.clearInterval(tournamentAttendanceTickerIntervalId)
    }
    syncTournamentAttendanceCountdownDisplay()
    tournamentAttendanceTickerIntervalId = window.setInterval(() => {
      syncTournamentAttendanceCountdownDisplay()
    }, 1000)
  }

  function clearScoringCountdownTicker(): void {
    if (scoringCountdownIntervalId === null) {
      scoringVisualCountdownKey = null
      scoringVisualCountdownStartedAt = 0
      return
    }

    window.clearInterval(scoringCountdownIntervalId)
    scoringCountdownIntervalId = null
    scoringVisualCountdownKey = null
    scoringVisualCountdownStartedAt = 0
  }

  function clearStablePhaseRenderKey(): void {
    stablePhaseRenderKey = null
  }

  function clearScoringPresentationGuards(): void {
    playedScoringPresentationKeys.clear()
  }

  function clearRenderStabilityGuards(): void {
    clearStablePhaseRenderKey()
    clearScoringPresentationGuards()
  }

  function getScoringPresentationKey(): string | null {
    const game = activeRoomState?.game ?? null
    const scoring = game?.scoring ?? null
    if (activeRoomState === null || game === null || scoring === null) {
      return null
    }

    return JSON.stringify({
      roomId: activeRoomState.roomId,
      phase: game.authoritativePhase,
      winningBid: scoring.winningBid,
      rawHandPoints: scoring.rawHandPoints,
      rawHandTricksWon: scoring.rawHandTricksWon,
      declarationPoints: scoring.declarationPoints,
      belotePoints: scoring.belotePoints,
      sumPoints: scoring.sumPoints,
      officialRoundPoints: scoring.officialRoundPoints,
      matchTotals: scoring.matchTotals,
      carryOver: scoring.carryOver,
      outcomeLabel: scoring.outcomeLabel,
      outcomeShortLabel: scoring.outcomeShortLabel,
      counterMultiplier: scoring.counterMultiplier,
      declarations: game.declarations.map((declaration) => ({
        seat: declaration.seat,
        team: declaration.team,
        type: declaration.type,
        points: declaration.points,
        cardIds: declaration.cardIds,
        announced: declaration.announced,
        valid: declaration.valid,
      })),
    })
  }

  function shouldAnimateScoringPresentation(): boolean {
    const key = getScoringPresentationKey()
    if (key === null) {
      return false
    }
    if (playedScoringPresentationKeys.has(key)) {
      return false
    }
    playedScoringPresentationKeys.add(key)
    return true
  }

  function getScoringVisualCountdownKey(): string | null {
    if (
      !activeRoomState ||
      activeRoomState.game?.authoritativePhase !== 'scoring' ||
      !activeRoomState.game.scoring
    ) {
      return null
    }

    return [
      activeRoomState.roomId,
      'scoring',
    ].join(':')
  }

  function syncScoringVisualCountdownState(): void {
    const countdownKey = getScoringVisualCountdownKey()

    if (countdownKey === null) {
      scoringVisualCountdownKey = null
      scoringVisualCountdownStartedAt = 0
      return
    }

    if (scoringVisualCountdownKey === countdownKey) {
      return
    }

    scoringVisualCountdownKey = countdownKey
    scoringVisualCountdownStartedAt = performance.now()
  }

  function getScoringVisualCountdownSeconds(): number {
    syncScoringVisualCountdownState()

    if (
      scoringVisualCountdownKey === null ||
      !Number.isFinite(scoringVisualCountdownStartedAt) ||
      scoringVisualCountdownStartedAt <= 0
    ) {
      return 5
    }

    const elapsedMs = Math.max(0, performance.now() - scoringVisualCountdownStartedAt)
    const remainingMs = Math.max(0, SCORING_VISUAL_COUNTDOWN_MS - elapsedMs)

    return Math.max(1, Math.ceil(remainingMs / 1000))
  }

  function getScoringCountdownText(): string {
    return `${getScoringVisualCountdownSeconds()} сек.`
  }

  function updateScoringCountdownText(): void {
    const countdownElement = options.root.querySelector<HTMLElement>('[data-scoring-countdown="1"]')

    if (countdownElement === null) {
      return
    }

    countdownElement.textContent = getScoringCountdownText()
  }

  function syncScoringCountdownTicker(): void {
    const isScoringPhase = activeRoomState?.game?.authoritativePhase === 'scoring'

    if (!isScoringPhase) {
      clearScoringCountdownTicker()
      return
    }

    updateScoringCountdownText()

    if (scoringCountdownIntervalId !== null) {
      return
    }

    scoringCountdownIntervalId = window.setInterval(() => {
      if (activeRoomState?.game?.authoritativePhase !== 'scoring') {
        clearScoringCountdownTicker()
        return
      }

      updateScoringCountdownText()
    }, 250)
  }

  function getLocalReactionCountdownRemainingMs(): number | null {
    const game = activeRoomState?.game ?? null
    const timerDeadlineAt = game?.timerDeadlineAt ?? null

    if (game === null || timerDeadlineAt === null) {
      return null
    }

    const { seat } = activeRoomState!
    const localSeatSnapshot = getLocalSeatSnapshot()

    if (localSeatSnapshot?.isBot || localSeatSnapshot?.isControlledByBot) {
      return null
    }

    if (
      game.authoritativePhase === 'cutting' &&
      game.cutting?.cutterSeat === seat &&
      game.cutting.selectedCutIndex === null
    ) {
      const currentCutCycleKey = getCuttingCycleKey(activeRoomState!.roomId, game)

      if (
        currentCutCycleKey !== null &&
        cuttingAnimation.pendingCycleKey !== currentCutCycleKey
      ) {
        return Math.max(0, timerDeadlineAt - Date.now())
      }
    }

    if (
      game.authoritativePhase === 'bidding' &&
      game.bidding?.canSubmitBid &&
      !biddingUiState.pendingBidSent
    ) {
      return Math.max(0, timerDeadlineAt - Date.now())
    }

    if (
      game.authoritativePhase === 'playing' &&
      game.playing?.currentTurnSeat === seat &&
      !playingCache.pendingPlayCardSent
    ) {
      return Math.max(0, timerDeadlineAt - Date.now())
    }

    return null
  }

  function updateReactionCountdownAudio(): void {
    const remainingMs = getLocalReactionCountdownRemainingMs()
    const shouldPlay =
      remainingMs !== null &&
      remainingMs > 0 &&
      remainingMs <= REACTION_COUNTDOWN_WARNING_THRESHOLD_MS

    options.gameAudio?.syncReactionCountdownWarning(shouldPlay)
  }

  function clearReactionCountdownAudioTicker(): void {
    if (reactionCountdownAudioIntervalId !== null) {
      window.clearInterval(reactionCountdownAudioIntervalId)
      reactionCountdownAudioIntervalId = null
    }

    options.gameAudio?.syncReactionCountdownWarning(false)
  }

  function syncReactionCountdownAudioTicker(): void {
    if (!options.gameAudio) {
      return
    }

    const remainingMs = getLocalReactionCountdownRemainingMs()

    if (remainingMs === null || remainingMs <= 0) {
      clearReactionCountdownAudioTicker()
      return
    }

    updateReactionCountdownAudio()

    if (reactionCountdownAudioIntervalId !== null) {
      return
    }

    reactionCountdownAudioIntervalId = window.setInterval(() => {
      const nextRemainingMs = getLocalReactionCountdownRemainingMs()

      if (nextRemainingMs === null || nextRemainingMs <= 0) {
        clearReactionCountdownAudioTicker()
        return
      }

      updateReactionCountdownAudio()
    }, 200)
  }

  function cancelCuttingAnimationCompletionTimer(): void {
    if (cuttingAnimation.completionTimerId === null) {
      return
    }

    window.clearTimeout(cuttingAnimation.completionTimerId)
    cuttingAnimation.completionTimerId = null
  }

  function clearCuttingAnimationLatch(): void {
    cuttingAnimation.activeCycleKey = null
    cuttingAnimation.activeSelectionKey = null
    cuttingAnimation.renderedSelectionKey = null
    cuttingAnimation.startedAt = 0
    cuttingAnimation.latchedCuttingSnapshot = null
    cuttingAnimation.latchedCutterDisplayName = ''
    cuttingAnimation.latchedDealerSeat = null
    cuttingAnimation.isAnimating = false
    cuttingAnimation.hasCompleted = false
  }

  function clearPendingCutSubmission(): void {
    cuttingAnimation.pendingCycleKey = null
  }

  function resetCuttingAnimationState(): void {
    cancelCuttingAnimationCompletionTimer()
    cuttingAnimation.armedCycleKey = null
    clearPendingCutSubmission()
    clearCuttingAnimationLatch()
  }

  function cancelDealingAnimationCompletionTimer(): void {
    if (dealingAnimation.completionTimerId === null) {
      return
    }

    window.clearTimeout(dealingAnimation.completionTimerId)
    dealingAnimation.completionTimerId = null
  }

  function clearDealingAnimationState(): void {
    cancelDealingAnimationCompletionTimer()
    unmountDealPacketOverlay(firstThreeOverlay)
    options.gameAudio?.clearDealPacketSounds()
    dealingAnimation.activePhaseKey = null
    dealingAnimation.renderedPhaseKey = null
    dealingAnimation.renderedFirstDealSeat = null
    dealingAnimation.startedAt = 0
    dealingAnimation.isAnimating = false
    dealingAnimation.hasCompleted = false
  }

  function scheduleDealingAnimationCompletion(): void {
    if (!dealingAnimation.isAnimating || dealingAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_FIRST_THREE_VISUAL_TOTAL_MS - (performance.now() - dealingAnimation.startedAt),
    )

    dealingAnimation.completionTimerId = window.setTimeout(() => {
      dealingAnimation.completionTimerId = null

      if (!activeRoomState || !dealingAnimation.isAnimating) {
        return
      }

      dealingAnimation.isAnimating = false
      dealingAnimation.hasCompleted = true
      unmountDealPacketOverlay(firstThreeOverlay)
      scheduleActiveRoomRender()
    }, remainingMs)
  }

  function cancelDealNextTwoAnimationCompletionTimer(): void {
    if (dealNextTwoAnimation.completionTimerId === null) {
      return
    }
    window.clearTimeout(dealNextTwoAnimation.completionTimerId)
    dealNextTwoAnimation.completionTimerId = null
  }

  function clearDealNextTwoAnimationState(): void {
    cancelDealNextTwoAnimationCompletionTimer()
    unmountDealPacketOverlay(nextTwoOverlay)
    options.gameAudio?.clearDealPacketSounds()
    dealNextTwoAnimation.activePhaseKey = null
    dealNextTwoAnimation.renderedPhaseKey = null
    dealNextTwoAnimation.renderedFirstDealSeat = null
    dealNextTwoAnimation.startedAt = 0
    dealNextTwoAnimation.isAnimating = false
    dealNextTwoAnimation.hasCompleted = false
  }

  function scheduleDealNextTwoAnimationCompletion(): void {
    if (!dealNextTwoAnimation.isAnimating || dealNextTwoAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_NEXT_TWO_VISUAL_TOTAL_MS - (performance.now() - dealNextTwoAnimation.startedAt),
    )

    dealNextTwoAnimation.completionTimerId = window.setTimeout(() => {
      dealNextTwoAnimation.completionTimerId = null

      if (!activeRoomState || !dealNextTwoAnimation.isAnimating) {
        return
      }

      dealNextTwoAnimation.isAnimating = false
      dealNextTwoAnimation.hasCompleted = true
      unmountDealPacketOverlay(nextTwoOverlay)
      // If the server has already moved past deal-next-2, trigger a re-render now.
      const postAnimPhase = activeRoomState.game?.authoritativePhase ?? null
      if (postAnimPhase !== null && postAnimPhase !== 'deal-next-2') {
        scheduleActiveRoomRender()
      }
    }, remainingMs)
  }

  function cancelDealLastThreeAnimationCompletionTimer(): void {
    if (dealLastThreeAnimation.completionTimerId === null) {
      return
    }
    window.clearTimeout(dealLastThreeAnimation.completionTimerId)
    dealLastThreeAnimation.completionTimerId = null
  }

  function clearDealLastThreeAnimationState(): void {
    cancelDealLastThreeAnimationCompletionTimer()
    unmountDealPacketOverlay(lastThreeOverlay)
    options.gameAudio?.clearDealPacketSounds()
    dealLastThreeAnimation.activePhaseKey = null
    dealLastThreeAnimation.renderedPhaseKey = null
    dealLastThreeAnimation.renderedFirstDealSeat = null
    dealLastThreeAnimation.startedAt = 0
    dealLastThreeAnimation.isAnimating = false
    dealLastThreeAnimation.hasCompleted = false
  }

  function scheduleDealLastThreeAnimationCompletion(): void {
    if (!dealLastThreeAnimation.isAnimating || dealLastThreeAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      DEAL_LAST_THREE_VISUAL_TOTAL_MS - (performance.now() - dealLastThreeAnimation.startedAt),
    )

    dealLastThreeAnimation.completionTimerId = window.setTimeout(() => {
      dealLastThreeAnimation.completionTimerId = null

      if (!activeRoomState || !dealLastThreeAnimation.isAnimating) {
        return
      }

      dealLastThreeAnimation.isAnimating = false
      dealLastThreeAnimation.hasCompleted = true
      unmountDealPacketOverlay(lastThreeOverlay)
      const postAnimPhase = activeRoomState.game?.authoritativePhase ?? null
      if (postAnimPhase !== null && postAnimPhase !== 'deal-last-3') {
        scheduleActiveRoomRender()
      }
    }, remainingMs)
  }

  function cancelBidWatchdog(): void {
    if (bidWatchdog.bidResponseTimerId !== null) {
      window.clearTimeout(bidWatchdog.bidResponseTimerId)
      bidWatchdog.bidResponseTimerId = null
    }
    if (bidWatchdog.resyncTimeoutId !== null) {
      window.clearTimeout(bidWatchdog.resyncTimeoutId)
      bidWatchdog.resyncTimeoutId = null
    }
    bidWatchdog.resyncRequested = false
    bidWatchdog.reconnectFallbackTriggered = false
  }

  function handleBidResyncTimedOut(): void {
    bidWatchdog.resyncTimeoutId = null
    if (!activeRoomState || !biddingUiState.pendingBidSent) {
      return
    }
    if (bidWatchdog.reconnectFallbackTriggered) {
      return
    }
    bidWatchdog.reconnectFallbackTriggered = true
    options.forceReconnectForZombieConnection()
  }

  function handleBidWatchdogExpired(): void {
    bidWatchdog.bidResponseTimerId = null
    if (!activeRoomState || !biddingUiState.pendingBidSent) {
      return
    }
    if (bidWatchdog.resyncRequested) {
      return
    }
    bidWatchdog.resyncRequested = true
    options.requestBidResync()
    bidWatchdog.resyncTimeoutId = window.setTimeout(
      handleBidResyncTimedOut,
      BID_RESYNC_RESPONSE_TIMEOUT_MS,
    )
  }

  function startBidResponseWatchdog(): void {
    cancelBidWatchdog()
    bidWatchdog.bidResponseTimerId = window.setTimeout(
      handleBidWatchdogExpired,
      BID_RESPONSE_WATCHDOG_MS,
    )
  }

  function clearBiddingUiState(): void {
    cancelBidWatchdog()
    clearBiddingUiStateFromStore(biddingUiState)
  }

  function clearPendingBidSubmission(): void {
    cancelBidWatchdog()
    clearPendingBidSubmissionFromStore(biddingUiState)
  }

  function addBidBubble(seat: Seat, label: string): void {
    addBidBubbleToState(biddingUiState, seat, label, () => scheduleActiveRoomRender())
  }

  function getBidBubblesForRender() {
    return getBidBubblesForRenderFromStore(biddingUiState)
  }

  function addEmojiBubble(seat: Seat, emojiId: string): void {
    const existing = emojiReactionUiState.timerIds[seat]
    if (existing !== undefined) {
      window.clearTimeout(existing)
    }
    emojiReactionUiState.activeBubbles[seat] = { emojiId, startedAt: performance.now() }
    emojiReactionUiState.timerIds[seat] = window.setTimeout(() => {
      delete emojiReactionUiState.activeBubbles[seat]
      delete emojiReactionUiState.timerIds[seat]
      clearEmojiInPanels(seat)
    }, EMOJI_BUBBLE_DURATION_MS)
  }

  function addPhraseBubble(seat: Seat, phraseId: string): void {
    const existing = phraseReactionUiState.timerIds[seat]
    if (existing !== undefined) {
      window.clearTimeout(existing)
    }
    phraseReactionUiState.activeBubbles[seat] = { phraseId, startedAt: performance.now() }
    phraseReactionUiState.timerIds[seat] = window.setTimeout(() => {
      delete phraseReactionUiState.activeBubbles[seat]
      delete phraseReactionUiState.timerIds[seat]
      clearPhraseInPanels(seat)
      removeMobilePhraseBubbleFromOverlay(seat)
    }, PHRASE_BUBBLE_DURATION_MS)
  }

  function clearEmojiReactionUiState(): void {
    for (const timerId of Object.values(emojiReactionUiState.timerIds)) {
      if (timerId !== undefined) window.clearTimeout(timerId)
    }
    emojiReactionUiState.activeBubbles = {}
    emojiReactionUiState.timerIds = {}
  }

  function clearPhraseReactionUiState(): void {
    for (const timerId of Object.values(phraseReactionUiState.timerIds)) {
      if (timerId !== undefined) window.clearTimeout(timerId)
    }
    phraseReactionUiState.activeBubbles = {}
    phraseReactionUiState.timerIds = {}
  }

  function getEmojiBubblesForRender(): Partial<Record<Seat, SeatEmojiBubble>> | null {
    const result: Partial<Record<Seat, SeatEmojiBubble>> = {}
    for (const [seat, bubble] of Object.entries(emojiReactionUiState.activeBubbles) as [Seat, { emojiId: string; startedAt: number }][]) {
      result[seat] = {
        emojiId: bubble.emojiId,
        elapsedMs: Math.round(performance.now() - bubble.startedAt),
        reactionKey: `${seat}:${bubble.emojiId}:${bubble.startedAt}`,
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }

  function getPhraseBubblesForRender(): Partial<Record<Seat, SeatPhraseBubble>> | null {
    const result: Partial<Record<Seat, SeatPhraseBubble>> = {}
    for (const [seat, bubble] of Object.entries(phraseReactionUiState.activeBubbles) as [Seat, { phraseId: string; startedAt: number }][]) {
      const text = getPhraseReactionText(bubble.phraseId)
      if (text === null) {
        continue
      }
      result[seat] = {
        text,
        elapsedMs: Math.round(performance.now() - bubble.startedAt),
      }
    }
    return Object.keys(result).length > 0 ? result : null
  }

  function renderEmojiPickerHtml(stageScale: number): string {
    const isPhoneLayout = isPhoneLayoutViewport()
    const uiScale = isPhoneLayout ? 1 : stageScale
    const uiScaleKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${uiScale.toFixed(3)}`
    const rows: string[] = []
    for (let i = 1; i <= EMOJI_COUNT; i++) {
      const id = String(i).padStart(2, '0')
      rows.push(`
        <button
          type="button"
          data-emoji-pick="${id}"
          style="
            width:52px;height:52px;border:0;background:transparent;cursor:pointer;
            border-radius:10px;padding:2px;
            display:flex;align-items:center;justify-content:center;
            transition:background 0.12s;
          "
          onmouseenter="this.style.background='rgba(255,255,255,0.15)'"
          onmouseleave="this.style.background='transparent'"
        >
          <img src="${getAnimatedEmojiPreviewUrl(id)}" alt="" style="width:44px;height:44px;object-fit:contain;">
        </button>
      `)
    }
    return `
      <div
        data-emoji-picker="1"
        data-reaction-ui-scale="${uiScaleKey}"
        style="
          position:fixed;
          bottom:${isPhoneLayout ? `${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT + 8}px` : '76px'};
          right:${isPhoneLayout ? '14px' : '16px'};
          top:${isPhoneLayout ? '14px' : 'auto'};
          transform:scale(${uiScale});
          transform-origin:bottom right;
          z-index:9999;
          background:rgba(20,20,24,0.96);
          border:1px solid rgba(255,255,255,0.12);
          border-radius:16px;
          padding:12px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
          ${isPhoneLayout ? 'display:flex;flex-direction:column;overflow:hidden;' : ''}
        "
      >
        <div
          style="
            display:grid;
            grid-template-columns:repeat(${isPhoneLayout ? '3' : '8'},52px);
            gap:4px;
            ${isPhoneLayout ? 'overflow-y:auto;min-height:0;justify-content:center;' : ''}
          "
        >
          ${rows.join('')}
        </div>
      </div>
    `
  }

  function renderPhrasePickerHtml(stageScale: number): string {
    const isPhoneLayout = isPhoneLayoutViewport()
    const uiScale = isPhoneLayout ? 1 : stageScale
    const uiScaleKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${uiScale.toFixed(3)}`
    const rows = PHRASE_REACTIONS.map((phrase) => `
      <button
        type="button"
        data-phrase-pick="${escapeHtml(phrase.id)}"
        style="
          border:1px solid rgba(212,165,32,0.36);
          background:rgba(255,255,255,0.055);
          color:#ffffff;
          border-radius:10px;
          padding:10px 12px;
          cursor:pointer;
          font:${isPhoneLayout ? '800' : '400'} ${isPhoneLayout ? '13px' : '14px'}/1.15 Arial, Helvetica, sans-serif;
          text-align:left;
          min-height:42px;
          transition:background 0.12s,border-color 0.12s,color 0.12s;
          display:flex;
          align-items:center;
          justify-content:center;
        "
        onmouseenter="this.style.background='rgba(212,165,32,0.16)';this.style.borderColor='rgba(212,165,32,0.72)'"
        onmouseleave="this.style.background='rgba(255,255,255,0.055)';this.style.borderColor='rgba(212,165,32,0.36)'"
      >
        ${escapeHtml(phrase.text)}
      </button>
    `)

    return `
      <div
        data-phrase-picker="1"
        data-reaction-ui-scale="${uiScaleKey}"
        style="
          position:fixed;
          bottom:${isPhoneLayout ? `${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT + 8}px` : '76px'};
          right:${isPhoneLayout ? '14px' : '16px'};
          transform:scale(${uiScale});
          transform-origin:bottom right;
          z-index:9999;
          width:${isPhoneLayout ? 'min(360px, calc(100vw - 28px))' : '420px'};
          max-height:${isPhoneLayout ? '52vh' : 'none'};
          overflow:${isPhoneLayout ? 'auto' : 'visible'};
          background:rgba(20,20,24,0.96);
          border:1px solid rgba(255,255,255,0.12);
          border-radius:16px;
          padding:12px;
          display:grid;
          grid-template-columns:${isPhoneLayout ? '1fr' : '1fr 1fr'};
          gap:7px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
        "
      >
        ${rows.join('')}
      </div>
    `
  }

  function ensureEmojiButton(isScoring: boolean, stageScale: number): void {
    if (isScoring || !activeRoomState) {
      removeEmojiButton()
      return
    }

    const isPhoneLayout = isPhoneLayoutViewport()
    const uiScale = isPhoneLayout ? 1 : stageScale
    const uiScaleKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${uiScale.toFixed(3)}`
    const emojiToggle = document.body.querySelector<HTMLButtonElement>('[data-emoji-toggle="1"]')
    const phraseToggle = document.body.querySelector<HTMLButtonElement>('[data-phrase-toggle="1"]')

    if (emojiToggle && emojiToggle.dataset.reactionUiScale !== uiScaleKey) {
      emojiToggle.remove()
      document.body.querySelector('[data-emoji-picker="1"]')?.remove()
    }

    if (phraseToggle && phraseToggle.dataset.reactionUiScale !== uiScaleKey) {
      phraseToggle.remove()
      document.body.querySelector('[data-phrase-picker="1"]')?.remove()
    }

    if (!document.body.querySelector('[data-emoji-toggle="1"]')) {
      document.body.insertAdjacentHTML('beforeend', `
        <button
          type="button"
          data-emoji-toggle="1"
          data-reaction-ui-scale="${uiScaleKey}"
          style="
            position:fixed;
            bottom:${isPhoneLayout ? '5px' : '16px'};
            right:${isPhoneLayout ? '18px' : '16px'};
            z-index:9998;
            width:${isPhoneLayout ? '40px' : '80px'};height:${isPhoneLayout ? '40px' : '80px'};
            transform:scale(${uiScale});
            transform-origin:bottom right;
            border:0;border-radius:50%;
            background:rgba(20,20,24,0.92);
            border:2px solid rgba(212,165,32,0.80);
            box-shadow:0 0 12px rgba(212,165,32,0.25), 0 6px 20px rgba(0,0,0,0.50);
            cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
          "
        >
          <img src="${getAnimatedEmojiPreviewUrl('08')}" alt="" style="width:${isPhoneLayout ? '30px' : '56px'};height:${isPhoneLayout ? '30px' : '56px'};object-fit:contain;">
        </button>
      `)
      document.body.querySelector('[data-emoji-toggle="1"]')?.addEventListener('click', () => {
        emojiPickerOpen = !emojiPickerOpen
        if (emojiPickerOpen) {
          phrasePickerOpen = false
          document.body.querySelector('[data-phrase-picker="1"]')?.remove()
        }
        syncEmojiPickerPanel(stageScale)
      })
    }

    if (!document.body.querySelector('[data-phrase-toggle="1"]')) {
      document.body.insertAdjacentHTML('beforeend', `
        <button
          type="button"
          data-phrase-toggle="1"
          data-reaction-ui-scale="${uiScaleKey}"
          aria-label="Фрази"
          style="
            position:fixed;
            bottom:${isPhoneLayout ? '5px' : '16px'};
            right:${isPhoneLayout ? '64px' : '108px'};
            z-index:9998;
            width:${isPhoneLayout ? '40px' : '80px'};height:${isPhoneLayout ? '40px' : '80px'};
            transform:scale(${uiScale});
            transform-origin:bottom right;
            border:0;border-radius:50%;
            background:rgba(20,20,24,0.92);
            border:2px solid rgba(212,165,32,0.80);
            box-shadow:0 0 12px rgba(212,165,32,0.25), 0 6px 20px rgba(0,0,0,0.50);
            cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
            color:#f4c432;
            font-size:${isPhoneLayout ? '22px' : '42px'};
            font-weight:900;
            line-height:1;
          "
        >
          <span
            aria-hidden="true"
            style="
              position:relative;
              width:${isPhoneLayout ? '25px' : '50px'};
              height:${isPhoneLayout ? '18px' : '36px'};
              display:flex;
              align-items:center;
              justify-content:center;
              gap:${isPhoneLayout ? '4px' : '8px'};
              border-radius:50%;
              background:#d4a520;
            "
          >
            <span
              style="
                position:absolute;
                left:${isPhoneLayout ? '0px' : '0px'};
                bottom:${isPhoneLayout ? '-4px' : '-8px'};
                width:${isPhoneLayout ? '13px' : '26px'};
                height:${isPhoneLayout ? '10px' : '20px'};
                background:#d4a520;
                clip-path:polygon(0 100%, 42% 0, 100% 18%);
              "
            ></span>
            <span style="width:${isPhoneLayout ? '4px' : '8px'};height:${isPhoneLayout ? '4px' : '8px'};border-radius:50%;background:#2a2018;z-index:1;"></span>
            <span style="width:${isPhoneLayout ? '4px' : '8px'};height:${isPhoneLayout ? '4px' : '8px'};border-radius:50%;background:#2a2018;z-index:1;"></span>
            <span style="width:${isPhoneLayout ? '4px' : '8px'};height:${isPhoneLayout ? '4px' : '8px'};border-radius:50%;background:#2a2018;z-index:1;"></span>
          </span>
        </button>
      `)
      document.body.querySelector('[data-phrase-toggle="1"]')?.addEventListener('click', () => {
        phrasePickerOpen = !phrasePickerOpen
        if (phrasePickerOpen) {
          emojiPickerOpen = false
          document.body.querySelector('[data-emoji-picker="1"]')?.remove()
        }
        syncPhrasePickerPanel(stageScale)
      })
    }
  }

  function removeEmojiButton(): void {
    document.body.querySelector('[data-emoji-toggle="1"]')?.remove()
    document.body.querySelector('[data-emoji-picker="1"]')?.remove()
    document.body.querySelector('[data-phrase-toggle="1"]')?.remove()
    document.body.querySelector('[data-phrase-picker="1"]')?.remove()
    emojiPickerOpen = false
    phrasePickerOpen = false
  }

  function syncEmojiPickerPanel(stageScale: number): void {
    let existing = document.body.querySelector('[data-emoji-picker="1"]')
    const isPhoneLayout = isPhoneLayoutViewport()
    const uiScale = isPhoneLayout ? 1 : stageScale
    const uiScaleKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${uiScale.toFixed(3)}`
    if (emojiPickerOpen && existing && existing.getAttribute('data-reaction-ui-scale') !== uiScaleKey) {
      existing.remove()
      existing = null
    }
    if (emojiPickerOpen && !existing) {
      document.body.insertAdjacentHTML('beforeend', renderEmojiPickerHtml(stageScale))
      document.body.querySelectorAll<HTMLButtonElement>('[data-emoji-pick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const emojiId = btn.getAttribute('data-emoji-pick')
          if (!activeRoomState || !emojiId) return
          options.sendEmojiReaction(activeRoomState.roomId, emojiId)
          emojiPickerOpen = false
          document.body.querySelector('[data-emoji-picker="1"]')?.remove()
        })
      })
    } else if (!emojiPickerOpen && existing) {
      existing.remove()
    }
  }

  function syncPhrasePickerPanel(stageScale: number): void {
    let existing = document.body.querySelector('[data-phrase-picker="1"]')
    const isPhoneLayout = isPhoneLayoutViewport()
    const uiScale = isPhoneLayout ? 1 : stageScale
    const uiScaleKey = `${isPhoneLayout ? 'phone' : 'desktop'}:${uiScale.toFixed(3)}`
    if (phrasePickerOpen && existing && existing.getAttribute('data-reaction-ui-scale') !== uiScaleKey) {
      existing.remove()
      existing = null
    }
    if (phrasePickerOpen && !existing) {
      document.body.insertAdjacentHTML('beforeend', renderPhrasePickerHtml(stageScale))
      document.body.querySelectorAll<HTMLButtonElement>('[data-phrase-pick]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const phraseId = btn.getAttribute('data-phrase-pick')
          if (!activeRoomState || !phraseId) return
          options.sendPhraseReaction(activeRoomState.roomId, phraseId)
          phrasePickerOpen = false
          document.body.querySelector('[data-phrase-picker="1"]')?.remove()
        })
      })
    } else if (!phrasePickerOpen && existing) {
      existing.remove()
    }
  }

  function closeReactionPickersOnOutsideClick(target: Element): void {
    const isInsideEmojiPicker = target.closest('[data-emoji-picker="1"]') !== null
    const isEmojiToggle = target.closest('[data-emoji-toggle="1"]') !== null
    const isInsidePhrasePicker = target.closest('[data-phrase-picker="1"]') !== null
    const isPhraseToggle = target.closest('[data-phrase-toggle="1"]') !== null

    if (emojiPickerOpen && !isInsideEmojiPicker && !isEmojiToggle) {
      emojiPickerOpen = false
      document.body.querySelector('[data-emoji-picker="1"]')?.remove()
    }

    if (phrasePickerOpen && !isInsidePhrasePicker && !isPhraseToggle) {
      phrasePickerOpen = false
      document.body.querySelector('[data-phrase-picker="1"]')?.remove()
    }
  }

  function getBidActionAudioLabel(action: RoomBiddingSnapshot['entries'][number]['action']): string {
    if (action.type === 'pass') return 'Пас'
    if (action.type === 'no-trumps') return 'Без коз'
    if (action.type === 'all-trumps') return 'Всичко коз'
    if (action.type === 'double') return 'Контра'
    if (action.type === 'redouble') return 'Реконтра'
    if (action.type === 'suit') {
      if (action.suit === 'clubs') return 'Спатия'
      if (action.suit === 'diamonds') return 'Каро'
      if (action.suit === 'hearts') return 'Купа'
      return 'Пика'
    }
    return ''
  }

  function scheduleDealFirstThreePacketSounds(sequenceKey: string): void {
    options.gameAudio?.scheduleDealPacketSounds(sequenceKey, {
      packetCount: SERVER_DEAL_ORDER.length,
      packetStartDelayMs: DEAL_FIRST_THREE_PACKET_START_DELAY_MS,
      packetDelayStepMs: DEAL_FIRST_THREE_PACKET_DELAY_STEP_MS,
      packetLiftOffsetMs: 0,
    })
  }

  function scheduleDefaultDealPacketSounds(sequenceKey: string): void {
    options.gameAudio?.scheduleDealPacketSounds(sequenceKey, {
      packetCount: SERVER_DEAL_ORDER.length,
      packetStartDelayMs: DEAL_PACKET_START_DELAY_MS,
      packetDelayStepMs: DEAL_PACKET_DELAY_STEP_MS,
      packetLiftOffsetMs: 0,
    })
  }

  function markBiddingPopupPending(): void {
    const popup = document.body.querySelector<HTMLElement>('[data-bidding-popup="1"]')
    if (!popup) {
      return
    }

    const stageScale = Number.parseFloat(popup.dataset.biddingPopupStageScale ?? '1') || 1
    popup.style.pointerEvents = 'none'
    popup.style.opacity = '0.72'
    popup.style.transform = `translateX(-50%) scale(${stageScale * 0.985})`
    popup.style.filter = 'saturate(0.9)'

    popup.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = true
    })
  }

  function activateBiddingPopupEnter(turnKey: string | null): void {
    if (turnKey === null || biddingUiState.popupAnimatedTurnKey === turnKey) {
      return
    }

    const popup = document.body.querySelector<HTMLElement>('[data-bidding-popup="1"]')
    if (!popup || popup.dataset.biddingPopupEnter !== '1') {
      return
    }

    biddingUiState.popupAnimatedTurnKey = turnKey
    window.requestAnimationFrame(() => {
      if (!popup.isConnected) {
        return
      }

      popup.style.opacity = popup.dataset.biddingPopupFinalOpacity ?? '1'
      const stageScale = Number.parseFloat(popup.dataset.biddingPopupStageScale ?? '1') || 1
      popup.style.transform = `translateX(-50%) scale(${stageScale})`
      popup.style.filter = popup.dataset.biddingPopupFinalFilter ?? 'none'
    })
  }

  function submitBidActionFromUi(action: ClientBidAction): void {
    options.gameAudio?.primeGameplaySfx()

    if (!activeRoomState || biddingUiState.pendingBidSent) {
      return
    }

    if (!options.isConnected()) {
      clearPendingBidSubmission()
      activeRoomState.errorText = 'Няма връзка със сървъра.'
      scheduleActiveRoomRender()
      return
    }

    biddingUiState.pendingBidSent = true
    activeRoomState.errorText = null
    markBiddingPopupPending()
    options.submitBidAction(activeRoomState.roomId, action)
    startBidResponseWatchdog()
  }

  function syncBiddingUiState(
    biddingSnapshot: RoomBiddingSnapshot | null,
    localSeat: Seat,
  ): void {
    if (!biddingSnapshot) {
      clearBiddingUiState()
      return
    }

    const currentCount = biddingSnapshot.entries.length

    // Detect new entries since last render
    if (currentCount > biddingUiState.lastKnownEntriesCount) {
      for (let i = biddingUiState.lastKnownEntriesCount; i < currentCount; i++) {
        const entry = biddingSnapshot.entries[i]
        if (entry) {
          const bidLabel = getBidActionLabel(entry.action)
          addBidBubble(entry.seat, bidLabel)
          options.gameAudio?.playBidBubble(getBidActionAudioLabel(entry.action), getSeatGender(entry.seat))
          // If this entry is for the local seat and we didn't send it → bot takeover
          if (entry.seat === localSeat && !biddingUiState.pendingBidSent && biddingUiState.wasMyTurn) {
            biddingUiState.showBotTakeover = true
          }
          if (entry.seat === localSeat) {
            biddingUiState.pendingBidSent = false
          }
        }
      }
      biddingUiState.lastKnownEntriesCount = currentCount
    }

    biddingUiState.wasMyTurn = biddingSnapshot.canSubmitBid
  }

  function syncDealNextTwoAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealNextTwoPhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealNextTwoAnimation.isAnimating) {
        clearDealNextTwoAnimationState()
      }
      return
    }

    if (dealNextTwoAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealNextTwoAnimationCompletionTimer()
    dealNextTwoAnimation.activePhaseKey = phaseKey
    dealNextTwoAnimation.renderedPhaseKey = null
    dealNextTwoAnimation.renderedFirstDealSeat = null
    dealNextTwoAnimation.startedAt = performance.now()
    dealNextTwoAnimation.isAnimating = true
    dealNextTwoAnimation.hasCompleted = false
    scheduleDefaultDealPacketSounds(phaseKey)
    scheduleDealNextTwoAnimationCompletion()
  }

  function syncDealLastThreeAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealLastThreePhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealLastThreeAnimation.isAnimating) {
        clearDealLastThreeAnimationState()
      }
      return
    }

    if (dealLastThreeAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealLastThreeAnimationCompletionTimer()
    dealLastThreeAnimation.activePhaseKey = phaseKey
    dealLastThreeAnimation.renderedPhaseKey = null
    dealLastThreeAnimation.renderedFirstDealSeat = null
    dealLastThreeAnimation.startedAt = performance.now()
    dealLastThreeAnimation.isAnimating = true
    dealLastThreeAnimation.hasCompleted = false
    scheduleDefaultDealPacketSounds(phaseKey)
    scheduleDealLastThreeAnimationCompletion()
  }

  function syncDealingAnimationState(roomId: string, game: RoomGameSnapshot | null): void {
    const phaseKey = getDealFirstThreePhaseKey(roomId, game)

    if (phaseKey === null) {
      if (!dealingAnimation.isAnimating) {
        clearDealingAnimationState()
      }

      return
    }

    if (dealingAnimation.activePhaseKey === phaseKey) {
      return
    }

    cancelDealingAnimationCompletionTimer()
    dealingAnimation.activePhaseKey = phaseKey
    dealingAnimation.renderedPhaseKey = null
    dealingAnimation.renderedFirstDealSeat = null
    dealingAnimation.startedAt = performance.now()
    dealingAnimation.isAnimating = true
    dealingAnimation.hasCompleted = false
    scheduleDealFirstThreePacketSounds(phaseKey)
    scheduleDealingAnimationCompletion()
  }

  function scheduleCuttingAnimationCompletion(): void {
    if (!cuttingAnimation.isAnimating || cuttingAnimation.completionTimerId !== null) {
      return
    }

    const remainingMs = Math.max(
      0,
      CUTTING_VISUAL_ANIMATION_TOTAL_MS - (performance.now() - cuttingAnimation.startedAt),
    )

    cuttingAnimation.completionTimerId = window.setTimeout(() => {
      cuttingAnimation.completionTimerId = null

      if (!activeRoomState || !cuttingAnimation.isAnimating) {
        return
      }

      cuttingAnimation.isAnimating = false
      cuttingAnimation.hasCompleted = true
      scheduleActiveRoomRender()
    }, remainingMs)
  }

  function startCuttingAnimation(
    cuttingSnapshot: RoomCuttingSnapshot,
    cutterDisplayName: string,
    dealerSeat: Seat | null,
    cycleKey: string,
    selectionKey: string,
  ): void {
    cancelCuttingAnimationCompletionTimer()
    cuttingAnimation.activeCycleKey = cycleKey
    cuttingAnimation.activeSelectionKey = selectionKey
    cuttingAnimation.renderedSelectionKey = null
    cuttingAnimation.startedAt = performance.now()
    cuttingAnimation.latchedCuttingSnapshot = { ...cuttingSnapshot }
    cuttingAnimation.latchedCutterDisplayName = cutterDisplayName
    cuttingAnimation.latchedDealerSeat = dealerSeat
    cuttingAnimation.isAnimating = true
    cuttingAnimation.hasCompleted = false
    scheduleCuttingAnimationCompletion()
  }

  function syncCuttingAnimationState(
    roomId: string,
    game: RoomGameSnapshot | null,
    cuttingSnapshot: RoomCuttingSnapshot | null,
    cutterDisplayName: string,
    dealerSeat: Seat | null,
  ): void {
    const cycleKey = getCuttingCycleKey(roomId, game)
    const isAwaitingHumanCutSelection = game?.authoritativePhase === 'cutting'

    if (
      cuttingSnapshot &&
      cuttingSnapshot.selectedCutIndex === null &&
      cycleKey !== null &&
      isAwaitingHumanCutSelection
    ) {
      const shouldResetForNewPendingCycle =
        cuttingAnimation.activeCycleKey !== null &&
        (cuttingAnimation.activeCycleKey !== cycleKey ||
          (cuttingAnimation.activeCycleKey === cycleKey && cuttingAnimation.hasCompleted))

      if (shouldResetForNewPendingCycle) {
        cancelCuttingAnimationCompletionTimer()
        clearCuttingAnimationLatch()
      }

      if (cuttingAnimation.pendingCycleKey !== null && cuttingAnimation.pendingCycleKey !== cycleKey) {
        clearPendingCutSubmission()
      }

      cuttingAnimation.armedCycleKey = cycleKey
      return
    }

    if (cuttingSnapshot && cuttingSnapshot.selectedCutIndex !== null) {
      const selectionCycleKey =
        cuttingAnimation.activeCycleKey ?? cuttingAnimation.armedCycleKey ?? cycleKey
      const selectionKey =
        selectionCycleKey !== null ? `${selectionCycleKey}:${cuttingSnapshot.selectedCutIndex}` : null

      if (selectionCycleKey === null || selectionKey === null) {
        return
      }

      clearPendingCutSubmission()

      if (cuttingAnimation.activeCycleKey === selectionCycleKey) {
        if (cuttingAnimation.activeSelectionKey === selectionKey) {
          cuttingAnimation.latchedCuttingSnapshot = { ...cuttingSnapshot }
          cuttingAnimation.latchedCutterDisplayName = cutterDisplayName
          cuttingAnimation.latchedDealerSeat = dealerSeat
        }

        return
      }

      if (!cuttingAnimation.isAnimating) {
        startCuttingAnimation(
          cuttingSnapshot,
          cutterDisplayName,
          dealerSeat,
          selectionCycleKey,
          selectionKey,
        )
        return
      }

      return
    }

    if (!cuttingSnapshot && !cuttingAnimation.isAnimating) {
      resetCuttingAnimationState()
    }
  }

  // Coalescing scheduler за renderActiveRoomScreen() — render fix №1 (виж
  // read-only audit-а: ~30 synchronous call sites, включително WebSocket
  // snapshot handling, timer callbacks и animation-completion callbacks,
  // могат да се струпат в кратък burst — reconnect catch-up, няколко
  // съобщения близо едно до друго, deal/cut completion timers).
  //
  // Най-много ЕДНА pending render заявка наведнъж — втора/трета заявка,
  // пристигнала преди flush-а, само marks pending отново, без допълнителна
  // DOM работа. renderActiveRoomScreen() чете activeRoomState (и
  // cutting/dealing animation state closures) FRESH в момента, в който
  // реално се изпълни — значи coalesced render винаги вижда най-актуалния
  // authoritative state, никога междинен/stale snapshot.
  //
  // requestAnimationFrame, НЕ queueMicrotask: отделните WebSocket съобщения
  // пристигат като отделни macrotasks (не синхронни извиквания в рамките на
  // един tick) — queueMicrotask би flush-нал СЛЕД всяко съобщение
  // поотделно (микротаск опашката вече е drain-ната преди следващата WS
  // message task да започне), т.е. нулев coalescing ефект точно за burst
  // сценария, който адресираме. rAF е единственият механизъм, който реално
  // събира N отделни tasks в рамките на един browser frame в ЕДИН render
  // pass, точно преди paint-а — идентичен established pattern вече се
  // ползва в createViewportResizeHandler (viewportStage.ts).
  //
  // preferAnimationPatch merge: НЕ last-write-wins. Съществуващата семантика
  // на самия параметър (виж renderActiveRoomScreen/§cutting branch по-долу)
  // е бинарна: true = "PATCH_ALLOWED" (caller-ът позволява patch, АКО
  // callee-то реши, че има какво да се preserve-не), false = "FULL_REQUIRED"
  // (caller-ът изисква нормален/пълен render — leave/tournament banner/
  // ancillary UI страни ефекти, които в момента живеят само в trailing блока
  // на FULL пътя, виж read-only audit-а). FULL_REQUIRED е STRICT superset на
  // PATCH_ALLOWED-ефектите (FULL прави и cutting rebuild, ако е нужен, ПЛЮС
  // всичко, до което PATCH early-return никога не достига) — затова FULL
  // трябва да доминира монотонно в рамките на един pending batch, независимо
  // от реда, в който заявките пристигат:
  //
  //   PATCH + PATCH = PATCH
  //   PATCH + FULL  = FULL
  //   FULL  + PATCH = FULL
  //   FULL  + FULL  = FULL
  //
  // pendingFullRenderRequired е monotonic within всеки pending frame — веднъж
  // вдигнат на true от коя да е FULL_REQUIRED заявка, никоя следваща
  // PATCH_ALLOWED заявка не може да го свали обратно на false преди flush-а.
  // Нулира се безопасно веднага след flush-а, за да не "изтече" в следващия
  // pending прозорец.
  //
  // Fresh safety net непроменен: дори batch-ът да е чист PATCH_ALLOWED
  // (pendingFullRenderRequired остава false), renderActiveRoomScreen пак
  // проверява cutAnimationForRender fresh при самото изпълнение — ако
  // анимацията вече е приключила до момента на flush-а, пада обратно на
  // FULL там, независимо от подадения флаг.
  let pendingActiveRoomRenderHandle: number | null = null
  let pendingFullRenderRequired = false

  function scheduleActiveRoomRender(preferAnimationPatch = false): void {
    if (!preferAnimationPatch) {
      pendingFullRenderRequired = true
    }

    if (pendingActiveRoomRenderHandle !== null) {
      return
    }

    pendingActiveRoomRenderHandle = window.requestAnimationFrame(() => {
      pendingActiveRoomRenderHandle = null
      const shouldPreferAnimationPatch = !pendingFullRenderRequired
      pendingFullRenderRequired = false
      renderActiveRoomScreen(shouldPreferAnimationPatch)
    })
  }

  function renderActiveRoomScreen(preferAnimationPatch = false): void {
    if (!activeRoomState) {
      clearReactionCountdownAudioTicker()
      return
    }

    const isPhoneLayout = isPhoneLayoutViewport()
    const mobileLayoutAttribute = isPhoneLayout ? 'data-mobile-layout="1"' : ''
    const tableBackground = isPhoneLayout
      ? ACTIVE_ROOM_MOBILE_TABLE_BACKGROUND
      : ACTIVE_ROOM_TABLE_BACKGROUND

    lastKnownWinningBid = computeNextLastKnownWinningBid(lastKnownWinningBid, activeRoomState.game)

    const cuttingSnapshot = activeRoomState.game?.cutting ?? null
    const dealerSeat = activeRoomState.game?.dealerSeat ?? null
    const firstDealSeat = activeRoomState.game?.firstDealSeat ?? null
    const cutterSeat = cuttingSnapshot?.cutterSeat ?? null
    const cutterSeatSnapshot =
      cutterSeat !== null
        ? activeRoomState.seats.find((seat) => seat.seat === cutterSeat) ?? null
        : null
    const cutterDisplayName =
      cutterSeatSnapshot?.displayName.trim()
        ? cutterSeatSnapshot.displayName.trim()
        : cutterSeat !== null
          ? SEAT_LABELS[cutterSeat]
          : 'играч'
    syncCuttingAnimationState(
      activeRoomState.roomId,
      activeRoomState.game,
      cuttingSnapshot,
      cutterDisplayName,
      dealerSeat,
    )

    const authoritativePhase = activeRoomState.game?.authoritativePhase ?? null
    const shouldKeepFirstThreeHands = shouldKeepFirstThreeHandsVisible(activeRoomState.game)
    const currentCutCycleKey = getCuttingCycleKey(activeRoomState.roomId, activeRoomState.game)
    const isCutSubmissionPending =
      currentCutCycleKey !== null &&
      cuttingAnimation.pendingCycleKey === currentCutCycleKey &&
      cuttingSnapshot?.selectedCutIndex === null
    const shouldRenderCompletedCutAnimation =
      cuttingAnimation.hasCompleted &&
      cuttingSnapshot !== null &&
      !shouldKeepFirstThreeHands &&
      authoritativePhase !== 'deal-first-3'
    const shouldRenderCutAnimation =
      cuttingAnimation.isAnimating || shouldRenderCompletedCutAnimation
    if (!shouldRenderCutAnimation) {
      syncDealingAnimationState(activeRoomState.roomId, activeRoomState.game)
      if (
        authoritativePhase === 'deal-next-2' ||
        dealingAnimation.hasCompleted ||
        !dealingAnimation.isAnimating
      ) {
        syncDealNextTwoAnimationState(activeRoomState.roomId, activeRoomState.game)
        if (dealNextTwoAnimation.hasCompleted || !dealNextTwoAnimation.isAnimating) {
          syncDealLastThreeAnimationState(activeRoomState.roomId, activeRoomState.game)
        }
      }
    }

    const shouldRenderDealFirstThreeAnimation =
      (authoritativePhase === 'deal-first-3' && !dealingAnimation.hasCompleted) ||
      dealingAnimation.isAnimating
    const shouldRenderCompletedDealFirstThreeHands =
      !shouldRenderDealFirstThreeAnimation &&
      shouldKeepFirstThreeHands &&
      authoritativePhase !== 'bidding' &&
      authoritativePhase !== 'deal-last-3' &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const shouldRenderDealNextTwoAnimation =
      (authoritativePhase === 'deal-next-2' && !dealNextTwoAnimation.hasCompleted) ||
      dealNextTwoAnimation.isAnimating
    const shouldRenderCompletedDealNextTwoHands =
      !shouldRenderDealNextTwoAnimation &&
      shouldKeepNextTwoHandsVisible(activeRoomState.game) &&
      authoritativePhase !== 'bidding' &&
      authoritativePhase !== 'deal-last-3' &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const shouldRenderDealLastThreeAnimation =
      (authoritativePhase === 'deal-last-3' && !dealLastThreeAnimation.hasCompleted) ||
      dealLastThreeAnimation.isAnimating
    const shouldRenderCompletedDealLastThreeHands =
      !shouldRenderDealLastThreeAnimation &&
      shouldKeepLastThreeHandsVisible(activeRoomState.game) &&
      authoritativePhase !== 'playing' &&
      authoritativePhase !== 'scoring'
    const isShowingAnyDealPhase =
      shouldRenderDealFirstThreeAnimation ||
      shouldRenderCompletedDealFirstThreeHands ||
      shouldRenderDealNextTwoAnimation ||
      shouldRenderCompletedDealNextTwoHands ||
      shouldRenderDealLastThreeAnimation ||
      shouldRenderCompletedDealLastThreeHands
    const isShowingNextRoundPause = authoritativePhase === 'next-round'
    const isShowingBiddingPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'bidding'
    const isShowingScoringPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'scoring'
    const isShowingMatchEndedPhase = authoritativePhase === 'match-ended'
    const isShowingPlayingPhase =
      !isShowingAnyDealPhase && authoritativePhase === 'playing'
    if (!isShowingMatchEndedPhase && matchEndedCountdownIntervalId !== null) {
      clearMatchEndedCountdown()
      matchEndedCountdownSeconds = 120
    }
    if (!isShowingScoringPhase) {
      clearScoringCountdownTicker()
    }
    syncReactionCountdownAudioTicker()
    if (!isShowingPlayingPhase) {
      resetPlayingUiCache(playingCache)
      removeBottomHandOverlay()
    }
    // Bidding popup/bottom-hand card buttons live in their own document.body
    // host (see syncBiddingPopupOverlay/syncBottomHandOverlay) instead of
    // options.root, so a native 'click' still fires even if a server
    // snapshot rewrites root mid-gesture (b6354f2). That means neither host
    // is wiped by root's own re-render — removal must be driven explicitly
    // by authoritativePhase, unconditionally, on every render call. Bidding
    // can end and jump straight to 'deal-last-3'/'next-round'/'playing' in
    // a single atomic server snapshot (submitServerBidAction resolves and
    // transitions phase in one step — see finalizeServerBiddingPhase), with
    // no intermediate "bidding but nobody's turn" render to hang this off
    // of. Keying cleanup off authoritativePhase directly (not the render-
    // local isShowingBiddingPhase, which can be temporarily suppressed by a
    // lingering deal animation) guarantees removal fires the instant the
    // phase is no longer 'bidding', regardless of which phase it jumped to.
    if (authoritativePhase !== 'bidding') {
      removeBiddingPopupOverlay()
    }
    const hasSeatPanelPhase =
      isShowingPlayingPhase ||
      isShowingAnyDealPhase ||
      isShowingBiddingPhase ||
      authoritativePhase === 'cutting' ||
      authoritativePhase === 'next-round'
    if (!hasSeatPanelPhase) {
      removeSeatPanels()
    }
    const shouldSyncBiddingSnapshot =
      isShowingBiddingPhase || authoritativePhase === 'deal-last-3' || isShowingNextRoundPause

    if (shouldSyncBiddingSnapshot) {
      syncBiddingUiState(activeRoomState.game?.bidding ?? null, activeRoomState.seat)
    } else if (!isShowingNextRoundPause) {
      clearBiddingUiState()
    }

    const cuttingSnapshotForRender =
      shouldRenderCutAnimation
        ? cuttingAnimation.latchedCuttingSnapshot ?? cuttingSnapshot
        : isShowingAnyDealPhase || isShowingBiddingPhase
          ? null
          : cuttingSnapshot
    const dealerSeatForRender =
      shouldRenderCutAnimation
        ? cuttingAnimation.latchedDealerSeat ?? dealerSeat
        : dealerSeat
    const dealFirstSeatForRender = firstDealSeat ?? getSeatAfterDealerForDealFallback(dealerSeat)
    const cutterSeatForRender = cuttingSnapshotForRender?.cutterSeat ?? null
    const cutterDisplayNameForRender =
      shouldRenderCutAnimation && cuttingAnimation.latchedCutterDisplayName.trim()
        ? cuttingAnimation.latchedCutterDisplayName
        : cutterDisplayName
    const isLocalPlayerCutter =
      cutterSeatForRender !== null && activeRoomState.seat === cutterSeatForRender
    const cutAnimationForRender: RenderCuttingAnimationState | null =
      shouldRenderCutAnimation && cuttingAnimation.latchedCuttingSnapshot?.selectedCutIndex !== null
        ? {
            elapsedMs: cuttingAnimation.isAnimating
              ? performance.now() - cuttingAnimation.startedAt
              : CUTTING_VISUAL_ANIMATION_TOTAL_MS,
            totalDurationMs: CUTTING_VISUAL_ANIMATION_TOTAL_MS,
          }
        : null
    const dealAnimationForRender: RenderDealingAnimationState | null =
      shouldRenderDealLastThreeAnimation && dealLastThreeAnimation.activePhaseKey !== null
        ? {
            elapsedMs: dealLastThreeAnimation.isAnimating
              ? performance.now() - dealLastThreeAnimation.startedAt
              : DEAL_LAST_THREE_VISUAL_TOTAL_MS,
            totalDurationMs: DEAL_LAST_THREE_VISUAL_TOTAL_MS,
          }
        : shouldRenderDealNextTwoAnimation && dealNextTwoAnimation.activePhaseKey !== null
        ? {
            elapsedMs: dealNextTwoAnimation.isAnimating
              ? performance.now() - dealNextTwoAnimation.startedAt
              : DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
            totalDurationMs: DEAL_NEXT_TWO_VISUAL_TOTAL_MS,
          }
        : shouldRenderDealFirstThreeAnimation && dealingAnimation.activePhaseKey !== null
          ? {
              elapsedMs: dealingAnimation.isAnimating
                ? performance.now() - dealingAnimation.startedAt
                : DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
              totalDurationMs: DEAL_FIRST_THREE_VISUAL_TOTAL_MS,
            }
          : null
    const activeDealPhase: 'deal-first-3' | 'deal-next-2' | 'deal-last-3' =
      shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
        ? 'deal-last-3'
        : shouldRenderDealNextTwoAnimation || shouldRenderCompletedDealNextTwoHands
          ? 'deal-next-2'
          : 'deal-first-3'
    const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
    const scoreHudHtml = activeRoomState.game
      ? renderScoreHud({
          game: activeRoomState.game,
          seats: activeRoomState.seats,
          localSeat: activeRoomState.seat,
          winningBid: lastKnownWinningBid,
          stageScale,
        })
      : ''

    const tournamentAttendance = activeRoomState.tournamentAttendance
    if (
      tournamentAttendance !== null &&
      tournamentAttendance.state !== 'started' &&
      tournamentAttendance.state !== 'completed'
    ) {
      const renderKey = JSON.stringify({
        roomId: activeRoomState.roomId,
        state: tournamentAttendance.state,
        resolutionKind: tournamentAttendance.resolutionKind,
        roster: tournamentAttendance.roster,
      })
      if (renderKey !== tournamentAttendanceTickerRenderKey) {
        options.root.innerHTML = renderTournamentAttendanceScreenHtml(
          tournamentAttendance,
          scoreHudHtml,
          mobileLayoutAttribute,
          tableBackground,
        )
        tournamentAttendanceTickerRenderKey = renderKey
        startTournamentAttendanceTicker()
      } else {
        syncTournamentAttendanceCountdownDisplay()
      }
      return
    }
    clearTournamentAttendanceTicker()

    // Walkover резултат (виж fix(tournaments): route both teams after
    // walkover) — мачът е приключил СЛУЖЕБНО, преди реален game state изобщо
    // да е стартирал (room.game.phase остава 'bootstrap' на сървъра до
    // момента на затваряне на стаята). Без този клон клиентът пада в generic
    // "Зареждане на играта..." fallback ЗАВИНАГИ, защото нито един
    // cutting/dealing/bidding/playing/match-ended клон по-долу не съвпада с
    // bootstrap фаза — точно симптомът от production инцидента.
    // "Печели ли локалният играч" се извежда от missingPlayers (ако моят seat
    // НЕ е сред липсващите, моят отбор е присъствал и печели служебно) — без
    // нужда от допълнително сравнение по team id. Победителят на не-финален
    // кръг минава през СЪЩИЯ next-round waiting/feeder flow като нормално
    // спечелен мач (loadTournamentRoundResultFeederInfo +
    // onEnterWaitingForNextTournamentRound) — не се създава отделен waiting
    // екран, само transient result съобщението се различава (няма реален
    // резултат за показване).
    if (tournamentAttendance !== null && tournamentAttendance.walkover !== null) {
      const localSeat = activeRoomState.seat
      const wonByWalkover = !tournamentAttendance.missingPlayers.some((player) => player.seat === localSeat)
      const isFinalRound = activeRoomState.tournamentRoundType === 'final'
      const roundLabel = tournamentWaitingRoundLabel(activeRoomState.tournamentRoundType)

      if (
        wonByWalkover &&
        !isFinalRound &&
        activeRoomState.tournamentMatchId !== null &&
        tournamentRoundResultMatchId !== activeRoomState.tournamentMatchId
      ) {
        clearTournamentRoundResultState()
        tournamentRoundResultMatchId = activeRoomState.tournamentMatchId
        if (activeRoomState.tournamentId !== null) {
          void loadTournamentRoundResultFeederInfo(activeRoomState.tournamentId, activeRoomState.tournamentMatchId)
        }
      }

      const title = wonByWalkover ? 'Служебна победа' : 'Служебна загуба'
      const subtitle = wonByWalkover
        ? (isFinalRound ? 'Спечелихте финала служебно.' : 'Класирахте се за финала.')
        : (isFinalRound ? 'Загубихте финала служебно.' : 'Вашият отбор отпадна, защото съотборникът ви не се включи навреме.')
      const showFeederBox = wonByWalkover && !isFinalRound && tournamentRoundResultFeederLabel !== null
      const feederStatusText = computeFeederStatusText()

      const buildWalkoverFeeder = (): { tournamentId: string; label: string; scoreA: number | null; scoreB: number | null; status: 'in_progress' | 'completed' } | null => {
        const tid = activeRoomState?.tournamentId ?? null
        return wonByWalkover && !isFinalRound && tid !== null && tournamentRoundResultFeederLabel !== null
          ? {
              tournamentId: tid,
              label: tournamentRoundResultFeederLabel,
              scoreA: tournamentRoundResultFeederScoreA,
              scoreB: tournamentRoundResultFeederScoreB,
              status: tournamentRoundResultFeederStatus ?? 'in_progress' as const,
            }
          : null
      }

      // Победителят чрез walkover трябва да изпрати semifinal acknowledgement
      // независимо дали ще натисне ръчно "Към турнира", или ще излезе през
      // auto-transition таймера по-долу — финалният мач не трябва да зависи
      // от ръчен click (виж completeTournamentWalkoverTransition/
      // ensureTournamentWalkoverAutoTransitionTimer по-горе).
      if (activeRoomState.tournamentId !== null && activeRoomState.tournamentMatchId !== null && activeRoomState.tournamentRoundType !== null) {
        const walkoverKey = `${activeRoomState.roomId}:${activeRoomState.tournamentMatchId}:walkover:${wonByWalkover}`
        ensureTournamentWalkoverAutoTransitionTimer(
          walkoverKey,
          activeRoomState.tournamentId,
          activeRoomState.tournamentMatchId,
          wonByWalkover,
          isFinalRound,
          activeRoomState.tournamentRoundType,
          buildWalkoverFeeder(),
        )
      }

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          style="
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              width:min(92vw, 480px);
              max-height:calc(100dvh - 32px);
              overflow:auto;
              box-sizing:border-box;
              border:1px solid ${wonByWalkover ? 'rgba(34,197,94,0.45)' : 'rgba(255,255,255,0.18)'};
              border-radius:8px;
              padding:24px;
              background:rgba(15,23,42,0.94);
              color:#f8fafc;
              box-shadow:0 24px 70px rgba(2,6,23,0.45);
              text-align:center;
            "
          >
            <div style="font-size:13px;font-weight:900;text-transform:uppercase;color:#93c5fd;">${escapeHtml(roundLabel)}</div>
            <div style="margin-top:12px;font-size:24px;font-weight:900;color:${wonByWalkover ? '#22c55e' : '#f87171'};">${escapeHtml(title)}</div>
            <div style="margin-top:10px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.75);">${escapeHtml(subtitle)}</div>
            ${showFeederBox ? `
              <div style="margin-top:16px;padding:12px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);">
                <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;color:#93c5fd;">Изчаква се краят на другия полуфинал</div>
                <div style="margin-top:4px;font-size:14px;font-weight:800;">${escapeHtml(tournamentRoundResultFeederLabel ?? '')}</div>
                <div style="margin-top:6px;font-size:13px;font-weight:700;color:${tournamentRoundResultFeederStatus === 'completed' ? '#22c55e' : '#facc15'};">${escapeHtml(feederStatusText)}</div>
              </div>
            ` : ''}
            <div style="margin-top:20px;">
              <button type="button" data-tournament-walkover-continue="1" style="height:44px;padding:0 20px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:rgba(255,255,255,0.06);color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Към турнира</button>
            </div>
          </div>
        </div>
      `
      options.root.querySelector('[data-tournament-walkover-continue]')?.addEventListener('click', () => {
        const tournamentId = activeRoomState?.tournamentId ?? null
        const tournamentMatchId = activeRoomState?.tournamentMatchId ?? null
        const currentRoundType = activeRoomState?.tournamentRoundType ?? null
        const roomId = activeRoomState?.roomId ?? null
        if (tournamentId === null || tournamentMatchId === null || currentRoundType === null || roomId === null) {
          returnToLobbyFromMatchEnded()
          return
        }
        const walkoverKey = `${roomId}:${tournamentMatchId}:walkover:${wonByWalkover}`
        completeTournamentWalkoverTransition(
          walkoverKey,
          tournamentId,
          tournamentMatchId,
          wonByWalkover,
          isFinalRound,
          currentRoundType,
          buildWalkoverFeeder(),
        )
      })
      return
    }

    if (cuttingSnapshotForRender) {
      if (!initialStakeEffectShown) {
        initialStakeEffectShown = true
        showStakeDeductionEffect(activeRoomState.stake, {
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        })
      }

      if (matchEndedSoundPlayed && !replayStakeEffectShown) {
        replayStakeEffectShown = true
        showStakeDeductionEffect(activeRoomState.stake, {
          x: window.innerWidth / 2,
          y: window.innerHeight / 2,
        })
      }

      const cuttingVisualCountdownContext = {
        roomId: activeRoomState.roomId,
        game: activeRoomState.game,
      }

      cuttingVisualCountdown.syncCuttingVisualCountdownState(cuttingVisualCountdownContext)
      const cuttingCountdownRemainingMs =
        cuttingVisualCountdown.getCuttingVisualCountdownRemainingMs(
          cuttingVisualCountdownContext,
        )
      const cuttingCountdownRemainingMsForRender =
        shouldRenderCutAnimation || isCutSubmissionPending
          ? null
          : cuttingCountdownRemainingMs
      const bidBubblesForRender = getBidBubblesForRender()
      const cuttingScreenHtml = renderCuttingScreen({
        cuttingSnapshot: cuttingSnapshotForRender,
        cutterDisplayName: cutterDisplayNameForRender,
        isInteractive:
          cutAnimationForRender === null &&
          !isCutSubmissionPending &&
          cuttingSnapshotForRender.canSubmitCut &&
          isLocalPlayerCutter,
        cutAnimation: cutAnimationForRender,
      })
      const cuttingPanelsHtml = createCuttingSeatPanelsHtml({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        dealerSeat: dealerSeatForRender,
        cutterSeat: cutterSeatForRender,
        cuttingCountdownRemainingMs: cuttingCountdownRemainingMsForRender,
        countdownKey: cutterSeatForRender !== null &&
          cuttingCountdownRemainingMsForRender !== null &&
          activeRoomState.game?.timerDeadlineAt != null
          ? `c:${cutterSeatForRender}:${activeRoomState.game.timerDeadlineAt}`
          : null,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: null,
        bidBubbles: isShowingNextRoundPause ? bidBubblesForRender : null,
        emojiBubbles: getEmojiBubblesForRender(),
        phraseBubbles: getPhraseBubblesForRender(),
        tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
      })
      const cuttingStableRenderKey = cutAnimationForRender === null
        ? JSON.stringify({
            phase: 'cutting',
            roomId: activeRoomState.roomId,
            mobileLayoutAttribute,
            stageScale: stageScale.toFixed(3),
            scaledStageWidth,
            scaledStageHeight,
            dealerSeat: dealerSeatForRender,
            cutterSeat: cutterSeatForRender,
            cutterDisplayName: cutterDisplayNameForRender,
            deckCount: cuttingSnapshotForRender.deckCount,
            selectedCutIndex: cuttingSnapshotForRender.selectedCutIndex,
            canSubmitCut: cuttingSnapshotForRender.canSubmitCut,
            isLocalPlayerCutter,
            isCutSubmissionPending,
            tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
          })
        : null

      if (
        cuttingStableRenderKey !== null &&
        stablePhaseRenderKey === cuttingStableRenderKey &&
        options.root.querySelector('[data-active-room-phase="cutting"]') !== null
      ) {
        syncSeatPanels(cuttingPanelsHtml)
        syncMobilePhraseOverlay({
          seats: activeRoomState.seats,
          localSeat: activeRoomState.seat,
          phraseBubbles: getPhraseBubblesForRender(),
          panelScale: stageScale,
        })
        syncActiveRoomOverlayEffects()
        return
      }

      if (preferAnimationPatch && cutAnimationForRender !== null) {
        const cuttingVisualRoot = options.root.querySelector<HTMLDivElement>(
          '[data-active-room-cutting-visual="1"]',
        )

        if (cuttingVisualRoot) {
          const cuttingRenderSelectionKey = cuttingAnimation.activeSelectionKey !== null
            ? `${cuttingAnimation.activeSelectionKey}|scale:${stageScale.toFixed(3)}`
            : null

          if (
            cuttingAnimation.isAnimating &&
            cuttingAnimation.activeSelectionKey !== null &&
            cuttingAnimation.renderedSelectionKey === cuttingRenderSelectionKey
          ) {
            patchEmojiOnlyInPanels(cuttingPanelsHtml)
            syncActiveRoomOverlayEffects()
            return
          }

          cuttingVisualRoot.innerHTML = cuttingScreenHtml
          cuttingAnimation.renderedSelectionKey = cuttingRenderSelectionKey
          syncSeatPanels(cuttingPanelsHtml)
          syncActiveRoomOverlayEffects()
          return
        }
      }

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          data-active-room-phase="cutting"
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                data-active-room-cutting-visual="1"
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                "
              >
                ${cuttingScreenHtml}
              </div>
            </div>
          </div>
          ${scoreHudHtml}
        </div>
      `

      stablePhaseRenderKey = cuttingStableRenderKey
      syncSeatPanels(cuttingPanelsHtml)
      syncMobilePhraseOverlay({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        phraseBubbles: getPhraseBubblesForRender(),
        panelScale: stageScale,
      })

      if (cutAnimationForRender !== null) {
        cuttingAnimation.renderedSelectionKey = cuttingAnimation.activeSelectionKey !== null
          ? `${cuttingAnimation.activeSelectionKey}|scale:${stageScale.toFixed(3)}`
          : null
      }
    } else if (isShowingAnyDealPhase) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()

      const handCounts = activeRoomState.game?.handCounts ?? {
        bottom: 0,
        right: 0,
        top: 0,
        left: 0,
      }
      const showPackets =
        shouldRenderDealFirstThreeAnimation ||
        shouldRenderDealNextTwoAnimation ||
        shouldRenderDealLastThreeAnimation
      // Overlay mode: deal packets live in the active-room visual layer so
      // they can sit above the table but below the seat panels.
      const isUsingFirstThreeOverlay =
        shouldRenderDealFirstThreeAnimation &&
        activeDealPhase === 'deal-first-3' &&
        !shouldRenderDealNextTwoAnimation &&
        !shouldRenderDealLastThreeAnimation
      const isUsingNextTwoOverlay =
        shouldRenderDealNextTwoAnimation &&
        activeDealPhase === 'deal-next-2' &&
        !shouldRenderDealLastThreeAnimation
      const isUsingLastThreeOverlay =
        shouldRenderDealLastThreeAnimation &&
        activeDealPhase === 'deal-last-3'
      const isUsingDealPacketOverlay = isUsingFirstThreeOverlay || isUsingNextTwoOverlay || isUsingLastThreeOverlay

      if (!isUsingFirstThreeOverlay && firstThreeOverlay.element !== null) {
        unmountDealPacketOverlay(firstThreeOverlay)
      }
      if (!isUsingNextTwoOverlay && nextTwoOverlay.element !== null) {
        unmountDealPacketOverlay(nextTwoOverlay)
      }
      if (!isUsingLastThreeOverlay && lastThreeOverlay.element !== null) {
        unmountDealPacketOverlay(lastThreeOverlay)
      }

      const rawOwnHand = activeRoomState.game?.ownHand ?? []

      const dealMaxCards =
        shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
          ? 8
          : shouldRenderDealNextTwoAnimation || shouldRenderCompletedDealNextTwoHands
            ? 5
            : 3
      const dealPrevCards = showPackets
        ? shouldRenderDealLastThreeAnimation
          ? 5
          : shouldRenderDealNextTwoAnimation
            ? 3
            : 0
        : dealMaxCards
      const isLastThreeDeal = shouldRenderDealLastThreeAnimation || shouldRenderCompletedDealLastThreeHands
      const displaySortOptions: SortDisplayOptions = isLastThreeDeal
        ? getContractSortOptions()
        : { contract: 'default' }
      const displayOwnHand = sortLocalHandForDisplay(rawOwnHand.slice(0, dealMaxCards), displaySortOptions)
      const previousDisplayOwnHand = showPackets
        ? sortLocalHandForDisplay(rawOwnHand.slice(0, dealPrevCards), { contract: 'default' })
        : null
      const ownHand = displayOwnHand

      const dealingScreenHtml = renderDealingScreen({
        firstDealSeat: dealFirstSeatForRender,
        selectedCutIndex:
          cuttingAnimation.latchedCuttingSnapshot?.selectedCutIndex ??
          cuttingSnapshot?.selectedCutIndex ??
          null,
        localSeat: activeRoomState.seat,
        handCounts,
        ownHand,
        stageScale,
        dealAnimation: dealAnimationForRender,
        showPackets: isUsingDealPacketOverlay ? false : showPackets,
        // For deal-last-3 overlay the packets are in the overlay layer (showPackets=false above),
        // but the pile in the root must still animate as if packets are flying from it.
        showPileAnim: isUsingLastThreeOverlay ? showPackets : undefined,
        dealPhase: activeDealPhase,
      })

      const computeSeatAnimDelays = (): Partial<Record<Seat, number>> => {
        const firstIdx = SERVER_DEAL_ORDER.indexOf(dealFirstSeatForRender ?? 'bottom')
        const order = [0, 1, 2, 3].map(
          (offset) => SERVER_DEAL_ORDER[(firstIdx + offset) % 4],
        ) as Seat[]
        const delays: Partial<Record<Seat, number>> = {}
        const packetStartDelayMs =
          activeDealPhase === 'deal-first-3'
            ? DEAL_FIRST_THREE_PACKET_START_DELAY_MS
            : DEAL_PACKET_START_DELAY_MS
        const packetDelayStepMs =
          activeDealPhase === 'deal-first-3'
            ? DEAL_FIRST_THREE_PACKET_DELAY_STEP_MS
            : DEAL_PACKET_DELAY_STEP_MS
        const revealAfterPacketMs =
          activeDealPhase === 'deal-first-3'
            ? DEAL_FIRST_THREE_REVEAL_AFTER_PACKET_MS
            : DEAL_PACKET_DURATION_MS - DEAL_REVEAL_OVERLAP_MS
        order.forEach((seat, i) => {
          const packetStartMs = packetStartDelayMs + i * packetDelayStepMs
          delays[seat] = packetStartMs + revealAfterPacketMs
        })
        return delays
      }
      const hideNewCardsUntilAnimDelaySeats: Partial<Record<Seat, boolean>> = {}
      if (showPackets && (activeDealPhase === 'deal-next-2' || activeDealPhase === 'deal-last-3')) {
        SERVER_DEAL_ORDER.forEach((seat) => {
          hideNewCardsUntilAnimDelaySeats[seat] = true
        })
      }

      const dealtHandsForPanels: DealtHandsData | null = isShowingAnyDealPhase
        ? {
            handCounts,
            ownHand: displayOwnHand,
            previousOwnHand: previousDisplayOwnHand,
            localSeat: activeRoomState.seat,
            maxCardsPerSeat: dealMaxCards,
            hideNewCardsUntilAnimDelaySeats,
            replaceLocalHandAtRevealSeats:
              showPackets && activeDealPhase === 'deal-last-3'
                ? { [activeRoomState.seat]: true }
                : undefined,
            animStartIndex:
              shouldRenderDealLastThreeAnimation
                ? 5
                : shouldRenderDealNextTwoAnimation
                  ? 3
                  : 0,
            seatAnimDelays: showPackets
              ? (() => {
                  const raw = computeSeatAnimDelays()
                  const overlayState = isUsingFirstThreeOverlay
                    ? firstThreeOverlay
                    : isUsingNextTwoOverlay
                      ? nextTwoOverlay
                      : isUsingLastThreeOverlay
                        ? lastThreeOverlay
                        : null
                  if (overlayState === null) return raw
                  const elapsed = getDealPacketOverlayElapsedMs(overlayState)
                  const compensated: Partial<Record<Seat, number>> = {}
                  for (const seat of Object.keys(raw) as Seat[]) {
                    compensated[seat] = Math.max(0, (raw[seat] ?? 0) - elapsed)
                  }
                  return compensated
                })()
              : null,
          }
        : null

      const activeAnimCache =
        shouldRenderDealLastThreeAnimation
          ? dealLastThreeAnimation
          : shouldRenderDealNextTwoAnimation
            ? dealNextTwoAnimation
            : dealingAnimation

      if (dealAnimationForRender !== null && showPackets && !isUsingDealPacketOverlay) {
        const dealingVisualRoot = options.root.querySelector<HTMLDivElement>(
          '[data-active-room-dealing-visual="1"]',
        )

        if (
          dealingVisualRoot !== null &&
          activeAnimCache.isAnimating &&
          activeAnimCache.activePhaseKey !== null &&
          activeAnimCache.renderedPhaseKey === activeAnimCache.activePhaseKey &&
          activeAnimCache.renderedFirstDealSeat === dealFirstSeatForRender
        ) {
          return
        }
      }
      const dealOverlayEarlyReturnPanelsHtml = (): string => createCuttingSeatPanelsHtml({
        seats: activeRoomState!.seats,
        localSeat: activeRoomState!.seat,
        dealerSeat,
        cutterSeat: null,
        cuttingCountdownRemainingMs: null,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: dealtHandsForPanels,
        bidBubbles: getBidBubblesForRender(),
        emojiBubbles: getEmojiBubblesForRender(),
        phraseBubbles: getPhraseBubblesForRender(),
        tournamentBotReplacements: activeRoomState!.tournamentBotReplacements,
      })

      if (
        isUsingFirstThreeOverlay &&
        firstThreeOverlay.phaseKey === dealingAnimation.activePhaseKey &&
        firstThreeOverlay.stageScale === stageScale &&
        firstThreeOverlay.element !== null &&
        firstThreeOverlay.element.isConnected
      ) {
        patchEmojiOnlyInPanels(dealOverlayEarlyReturnPanelsHtml())
        return
      }
      if (
        isUsingNextTwoOverlay &&
        nextTwoOverlay.phaseKey === dealNextTwoAnimation.activePhaseKey &&
        nextTwoOverlay.stageScale === stageScale &&
        nextTwoOverlay.element !== null &&
        nextTwoOverlay.element.isConnected
      ) {
        patchEmojiOnlyInPanels(dealOverlayEarlyReturnPanelsHtml())
        return
      }
      if (
        isUsingLastThreeOverlay &&
        lastThreeOverlay.phaseKey === dealLastThreeAnimation.activePhaseKey &&
        lastThreeOverlay.stageScale === stageScale &&
        lastThreeOverlay.element !== null &&
        lastThreeOverlay.element.isConnected
      ) {
        patchEmojiOnlyInPanels(dealOverlayEarlyReturnPanelsHtml())
        return
      }

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                data-active-room-dealing-visual="1"
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:visible;
                "
              >
                ${dealingScreenHtml}
              </div>
            </div>
          </div>
          ${scoreHudHtml}
        </div>
      `

      syncSeatPanels(createCuttingSeatPanelsHtml({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        dealerSeat,
        cutterSeat: null,
        cuttingCountdownRemainingMs: null,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: dealtHandsForPanels,
        bidBubbles: getBidBubblesForRender(),
        emojiBubbles: getEmojiBubblesForRender(),
        phraseBubbles: getPhraseBubblesForRender(),
        tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
      }))
      syncMobilePhraseOverlay({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        phraseBubbles: getPhraseBubblesForRender(),
        panelScale: stageScale,
      })

      if (isUsingFirstThreeOverlay && dealingAnimation.activePhaseKey !== null) {
        const overlayHost =
          options.root.firstElementChild instanceof HTMLElement
            ? options.root.firstElementChild
            : options.root
        mountDealPacketOverlay(
          firstThreeOverlay,
          dealingAnimation.activePhaseKey,
          renderDealFirstThreePacketsHtml(dealFirstSeatForRender, activeRoomState.seat),
          stageScale,
          ACTIVE_ROOM_STAGE_WIDTH,
          ACTIVE_ROOM_STAGE_HEIGHT,
          overlayHost,
        )
      }
      if (isUsingNextTwoOverlay && dealNextTwoAnimation.activePhaseKey !== null) {
        const overlayHost =
          options.root.firstElementChild instanceof HTMLElement
            ? options.root.firstElementChild
            : options.root
        mountDealPacketOverlay(
          nextTwoOverlay,
          dealNextTwoAnimation.activePhaseKey,
          renderDealNextTwoPacketsHtml(dealFirstSeatForRender, activeRoomState.seat),
          stageScale,
          ACTIVE_ROOM_STAGE_WIDTH,
          ACTIVE_ROOM_STAGE_HEIGHT,
          overlayHost,
        )
      }
      if (isUsingLastThreeOverlay && dealLastThreeAnimation.activePhaseKey !== null) {
        const overlayHost =
          options.root.firstElementChild instanceof HTMLElement
            ? options.root.firstElementChild
            : options.root
        mountDealPacketOverlay(
          lastThreeOverlay,
          dealLastThreeAnimation.activePhaseKey,
          renderDealLastThreePacketsHtml(dealFirstSeatForRender, activeRoomState.seat),
          stageScale,
          ACTIVE_ROOM_STAGE_WIDTH,
          ACTIVE_ROOM_STAGE_HEIGHT,
          overlayHost,
        )
      }

      if (dealAnimationForRender !== null && !isUsingDealPacketOverlay) {
        activeAnimCache.renderedPhaseKey = activeAnimCache.activePhaseKey
        activeAnimCache.renderedFirstDealSeat = dealFirstSeatForRender
      }

      syncDealingScreenTargets(options.root, stageScale)
    } else if (isShowingBiddingPhase) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()

      const biddingGame = activeRoomState.game!
      const biddingSnapshot = biddingGame.bidding!
      const handCounts = biddingGame.handCounts ?? { bottom: 0, right: 0, top: 0, left: 0 }
      const ownHand = sortLocalHandForAllTrumps(biddingGame.ownHand ?? [])

      const dealtHandsForBidding: DealtHandsData = {
        handCounts,
        ownHand,
        previousOwnHand: null,
        localSeat: activeRoomState.seat,
        maxCardsPerSeat: 5,
        animStartIndex: 0,
        seatAnimDelays: null,
      }

      const bidBubbles = getBidBubblesForRender()

      const biddingStageHtml = renderBiddingStageHtml(
        biddingSnapshot.winningBid,
        biddingSnapshot.currentBidderSeat,
        handCounts,
      )
      const biddingCurrentSeatSnapshot =
        biddingSnapshot.currentBidderSeat !== null
          ? activeRoomState.seats.find((seat) => seat.seat === biddingSnapshot.currentBidderSeat) ?? null
          : null
      const biddingCountdownTotalMs = BID_HUMAN_TIMEOUT_MS
      const rawBiddingCountdownRemainingMs =
        biddingSnapshot.currentBidderSeat !== null &&
        biddingGame.timerDeadlineAt !== null
          ? Math.max(0, biddingGame.timerDeadlineAt - Date.now())
          : null
      const biddingCountdownRemainingMs =
        rawBiddingCountdownRemainingMs === null
          ? null
          : biddingCurrentSeatSnapshot?.isBot || biddingCurrentSeatSnapshot?.isControlledByBot
            ? Math.max(
                0,
                BID_HUMAN_TIMEOUT_MS -
                  (BID_BOT_DELAY_MS - Math.min(BID_BOT_DELAY_MS, rawBiddingCountdownRemainingMs)),
              )
            : rawBiddingCountdownRemainingMs

      const biddingPopupTurnKey =
        biddingSnapshot.canSubmitBid &&
        biddingSnapshot.currentBidderSeat === activeRoomState.seat &&
        !biddingUiState.pendingBidSent
          ? `${activeRoomState.roomId}:${biddingSnapshot.currentBidderSeat}:${biddingSnapshot.entries.length}:${biddingGame.timerDeadlineAt ?? 'none'}`
          : null
      const showBidPopup = biddingPopupTurnKey !== null
      const animateBidPopup =
        showBidPopup &&
        biddingPopupTurnKey !== null &&
        biddingUiState.popupAnimatedTurnKey !== biddingPopupTurnKey

      const biddingInteractionHtml = createBiddingInteractionHtml({
        biddingSnapshot,
        isPendingSubmission: biddingUiState.pendingBidSent,
        showBidPopup,
        animateBidPopup,
        showBotTakeover: false,
        stageScale,
      })

      const biddingErrorHtml = activeRoomState.errorText
        ? `
          <div
            data-bidding-error="1"
            style="
              position:fixed;
              left:50%;
              top:24px;
              transform:translateX(-50%);
              z-index:18;
              width:min(92vw, 560px);
              border-radius:16px;
              padding:14px 16px;
              background:rgba(127,29,29,0.86);
              border:1px solid rgba(248,113,113,0.34);
              box-shadow:0 14px 32px rgba(69,10,10,0.24);
              color:#fee2e2;
              font-size:14px;
              font-weight:700;
              line-height:1.4;
              text-align:center;
              font-family:Inter, system-ui, sans-serif;
            "
          >
            ${escapeHtml(activeRoomState.errorText)}
          </div>
        `
        : ''

      const biddingSeatPanelsHtml = createCuttingSeatPanelsHtml({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        dealerSeat,
        cutterSeat: null,
        cuttingCountdownRemainingMs: null,
        countdownSeat: biddingSnapshot.currentBidderSeat,
        countdownRemainingMs: biddingCountdownRemainingMs,
        countdownTotalMs: biddingCountdownTotalMs,
        countdownKey: biddingSnapshot.currentBidderSeat !== null && biddingGame.timerDeadlineAt !== null
          ? `b:${biddingSnapshot.currentBidderSeat}:${biddingGame.timerDeadlineAt}`
          : null,
        highlightSeat: biddingSnapshot.currentBidderSeat,
        highlightBadgeLabel: null,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: dealtHandsForBidding,
        bidBubbles,
        emojiBubbles: getEmojiBubblesForRender(),
        phraseBubbles: getPhraseBubblesForRender(),
        tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
      })
      const biddingStableRenderKey = JSON.stringify({
        phase: 'bidding',
        roomId: activeRoomState.roomId,
        mobileLayoutAttribute,
        stageScale: stageScale.toFixed(3),
        scaledStageWidth,
        scaledStageHeight,
        dealerSeat,
        currentBidderSeat: biddingSnapshot.currentBidderSeat,
        entries: biddingSnapshot.entries,
        winningBid: biddingSnapshot.winningBid,
        validActions: biddingSnapshot.validActions,
        canSubmitBid: biddingSnapshot.canSubmitBid,
        pendingBidSent: biddingUiState.pendingBidSent,
        showBidPopup,
        showBotTakeover: biddingUiState.showBotTakeover,
        errorText: activeRoomState.errorText,
        handCounts,
        ownHandIds: ownHand.map((card) => card.id),
        tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
      })

      if (
        stablePhaseRenderKey === biddingStableRenderKey &&
        options.root.querySelector('[data-active-room-phase="bidding"]') !== null
      ) {
        syncSeatPanels(biddingSeatPanelsHtml)
        syncBiddingPopupOverlay(biddingInteractionHtml)
        activateBiddingPopupEnter(animateBidPopup ? biddingPopupTurnKey : null)
        syncMobilePhraseOverlay({
          seats: activeRoomState.seats,
          localSeat: activeRoomState.seat,
          phraseBubbles: getPhraseBubblesForRender(),
          panelScale: stageScale,
        })
        syncActiveRoomOverlayEffects()
        return
      }

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          data-active-room-phase="bidding"
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:visible;
                "
              >
                ${biddingStageHtml}
              </div>
            </div>
          </div>
          ${scoreHudHtml}
          ${biddingErrorHtml}
        </div>
      `
      stablePhaseRenderKey = biddingStableRenderKey
      syncBiddingPopupOverlay(biddingInteractionHtml)
      activateBiddingPopupEnter(animateBidPopup ? biddingPopupTurnKey : null)

      syncSeatPanels(biddingSeatPanelsHtml)
      syncMobilePhraseOverlay({
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        phraseBubbles: getPhraseBubblesForRender(),
        panelScale: stageScale,
      })

      // Wire bid popup buttons. Popup-ът вече живее в собствен host
      // (syncBiddingPopupOverlay), чиито button node-ове се reuse-ват
      // между re-renders — attach-ът затова е guard-нат с
      // data-listeners-bound, за да не се закачат дублирани listeners на
      // reused node-ове.
      document.body
        .querySelectorAll<HTMLButtonElement>(`[${BIDDING_POPUP_HOST_ATTR}] [data-bid-suit]`)
        .forEach((btn) => {
          if (btn.dataset.listenersBound === '1') return
          btn.dataset.listenersBound = '1'
          btn.addEventListener('click', () => {
            const suit = btn.dataset.bidSuit as 'clubs' | 'diamonds' | 'hearts' | 'spades'
            submitBidActionFromUi({ type: 'suit', suit })
          })
        })

      document.body
        .querySelectorAll<HTMLButtonElement>(`[${BIDDING_POPUP_HOST_ATTR}] [data-bid-action]`)
        .forEach((btn) => {
          if (btn.dataset.listenersBound === '1') return
          btn.dataset.listenersBound = '1'
          btn.addEventListener('click', () => {
            const action = btn.dataset.bidAction as ClientBidAction['type']
            if (action === 'pass' || action === 'no-trumps' || action === 'all-trumps' || action === 'double' || action === 'redouble') {
              submitBidActionFromUi({ type: action })
            }
          })
        })

      const dismissBtn = options.root.querySelector<HTMLButtonElement>('[data-bot-takeover-dismiss="1"]')
      dismissBtn?.addEventListener('click', () => {
        biddingUiState.showBotTakeover = false
        scheduleActiveRoomRender()
      })
    } else if (
      isShowingMatchEndedPhase &&
      activeRoomState.game &&
      activeRoomState.isTournamentMatchOrigin &&
      activeRoomState.tournamentRoundType !== null &&
      activeRoomState.tournamentRoundType !== 'final'
    ) {
      // Не-финален турнирен мач — вместо стандартния replay/new-game екран,
      // показваме резултата от рунда + live feeder match (§8/§10 в task
      // spec-а). Финалът продължава по стандартния renderMatchEndedScreen
      // path по-долу (payout animation, settlement — непроменено).
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      const matchEnded = activeRoomState.game.matchEnded
      const localTeam = activeRoomState.seat === 'bottom' || activeRoomState.seat === 'top' ? 'A' : 'B'
      const wonRound = matchEnded?.winnerTeam === localTeam
      const finalScore = matchEnded?.finalScore ?? activeRoomState.game.score.match
      const myScore = localTeam === 'A' ? finalScore.teamA : finalScore.teamB
      const opponentScore = localTeam === 'A' ? finalScore.teamB : finalScore.teamA

      if (!matchEndedSoundPlayed) {
        matchEndedSoundPlayed = true
        options.gameAudio?.playMatchEnded()
      }
      if (
        wonRound &&
        activeRoomState.tournamentMatchId !== null &&
        tournamentRoundResultMatchId !== activeRoomState.tournamentMatchId
      ) {
        clearTournamentRoundResultState()
        tournamentRoundResultMatchId = activeRoomState.tournamentMatchId
        if (activeRoomState.tournamentId !== null) {
          void loadTournamentRoundResultFeederInfo(activeRoomState.tournamentId, activeRoomState.tournamentMatchId)
        }
      }

      const roundLabel = tournamentWaitingRoundLabel(activeRoomState.tournamentRoundType)
      const feederStatusText = computeFeederStatusText()
      if (shouldEnterTournamentInterRoundWaitingImmediately()) {
        completeTournamentRoundResultTransition()
        return
      }
      ensureTournamentRoundResultAutoTransitionTimer()

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          style="
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              width:min(92vw, 480px);
              max-height:calc(100dvh - 32px);
              overflow:auto;
              box-sizing:border-box;
              border:1px solid ${wonRound ? 'rgba(34,197,94,0.45)' : 'rgba(255,255,255,0.18)'};
              border-radius:8px;
              padding:24px;
              background:rgba(15,23,42,0.94);
              color:#f8fafc;
              box-shadow:0 24px 70px rgba(2,6,23,0.45);
              text-align:center;
            "
          >
            <div style="font-size:28px;font-weight:900;color:${wonRound ? '#22c55e' : '#f87171'};">${wonRound ? 'Победихте!' : 'Загубихте мача'}</div>
            <div style="margin-top:10px;font-size:18px;font-weight:800;">${myScore} : ${opponentScore}</div>
            ${wonRound ? `
              <div style="margin-top:14px;font-size:14px;font-weight:700;color:#dbeafe;">Продължавате към следващия кръг.</div>
              ${tournamentRoundResultFeederLabel !== null ? `
                <div style="margin-top:16px;padding:12px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);">
                  <div style="font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.05em;color:#93c5fd;">Очаквате победителя от</div>
                  <div style="margin-top:4px;font-size:14px;font-weight:800;">${escapeHtml(tournamentRoundResultFeederLabel)}</div>
                  <div style="margin-top:6px;font-size:13px;font-weight:700;color:${tournamentRoundResultFeederStatus === 'completed' ? '#22c55e' : '#facc15'};">${escapeHtml(feederStatusText)}</div>
                </div>
              ` : ''}
            ` : `
              <div style="margin-top:14px;font-size:14px;font-weight:800;color:rgba(248,250,252,0.82);">Отпадате от турнира.</div>
              <div style="margin-top:14px;font-size:14px;font-weight:700;color:rgba(248,250,252,0.7);">Достигнат кръг: ${escapeHtml(roundLabel)}</div>
            `}
            <div style="margin-top:20px;">
              <button type="button" data-tournament-round-result-lobby="1" style="height:44px;padding:0 20px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:rgba(255,255,255,0.06);color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">${wonRound ? 'Към турнира' : 'Към лобито'}</button>
            </div>
          </div>
        </div>
      `
      options.root.querySelector('[data-tournament-round-result-lobby]')?.addEventListener('click', () => {
        continueFromTournamentRoundResultButton()
      })
      return
    } else if (
      isShowingMatchEndedPhase &&
      activeRoomState.game &&
      activeRoomState.isTournamentMatchOrigin &&
      activeRoomState.tournamentRoundType === 'final'
    ) {
      if (renderTournamentFinalResultScreen({ mobileLayoutAttribute, tableBackground })) return
    } else if (isShowingMatchEndedPhase && activeRoomState.game) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      if (!matchEndedSoundPlayed) {
        matchEndedSoundPlayed = true
        options.gameAudio?.playMatchEnded()
        startMatchEndedCountdown()
      }

      // Ако някой е гласувал за изход → скочи на 30 сек.
      const leaveVotes = activeRoomState.game.matchEnded?.leaveVotes ?? []
      const currentCountdownSeconds = getMatchEndedCountdownSeconds()
      if (leaveVotes.length > 0 && currentCountdownSeconds > 30) {
        const shortenedDeadlineAt = Date.now() + 30_000
        matchEndedCountdownDeadlineAt =
          matchEndedCountdownDeadlineAt === null
            ? shortenedDeadlineAt
            : Math.min(matchEndedCountdownDeadlineAt, shortenedDeadlineAt)
      }

      matchEndedCountdownSeconds = getMatchEndedCountdownSeconds()
      if (matchEndedCountdownSeconds <= 0) {
        clearMatchEndedCountdown()
        returnToLobbyFromMatchEnded()
        return
      }

      renderMatchEndedScreen({
        root: options.root,
        game: activeRoomState.game,
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        stageScale,
        scaledStageWidth,
        scaledStageHeight,
        prizeAmount: activeRoomState.game?.matchEnded?.awardedPrizeAmount ?? null,
        skipPrizeAnimation: matchEndedPrizeAnimated,
        countdownSeconds: matchEndedCountdownSeconds,
        isPrivateTableOrigin:
          activeRoomState.isPrivateTableOrigin || activeRoomState.isTournamentMatchOrigin,
        onReturnToLobby: returnToLobbyFromMatchEnded,
        onStartNewGame: startNewGameFromMatchEnded,
        onSubmitPartnerRating: (ratingValue) => {
          if (!activeRoomState) {
            return
          }

          options.submitPartnerRating(activeRoomState.roomId, ratingValue)
        },
        onReplayVote: () => {
          if (!activeRoomState) {
            return
          }

          if (activeRoomState.isGuestTrial) {
            returnToLobbyFromMatchEnded()
            options.onGuestTrialReplayRequested()
            return
          }

          options.sendReplayVote(activeRoomState.roomId)
        },
        onLeaveVote: () => {
          if (!activeRoomState) {
            return
          }

          options.sendLeaveMatchVote(activeRoomState.roomId)
        },
      })

      const currentPrizeAmount = activeRoomState.game?.matchEnded?.awardedPrizeAmount ?? null
      if (!matchEndedPrizeAnimated && matchEndedPrizeAnimatedTimerId === null && currentPrizeAmount !== null && currentPrizeAmount > 0) {
        matchEndedPrizeAnimatedTimerId = window.setTimeout(() => {
          matchEndedPrizeAnimated = true
          matchEndedPrizeAnimatedTimerId = null
        }, 1700)
      }
    } else if (isShowingScoringPhase && activeRoomState.game?.scoring) {
      clearStablePhaseRenderKey()
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      renderScoringScreen({
        root: options.root,
        game: activeRoomState.game,
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        winningBid: lastKnownWinningBid,
        countdownSeconds: getScoringVisualCountdownSeconds(),
        animateSumCounters: shouldAnimateScoringPresentation(),
        stageScale,
        scaledStageWidth,
        scaledStageHeight,
      })
      syncScoringCountdownTicker()
    } else if (isShowingPlayingPhase && activeRoomState.game) {
      clearStablePhaseRenderKey()
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      renderPlayingScreen({
        root: options.root,
        game: activeRoomState.game,
        seats: activeRoomState.seats,
        localSeat: activeRoomState.seat,
        roomId: activeRoomState.roomId,
        winningBid: lastKnownWinningBid,
        stageScale,
        scaledStageWidth,
        scaledStageHeight,
        submitPlayCard: options.submitPlayCard,
        onDeclarationBubbleShown: (seat, lines) => {
          options.gameAudio?.playDeclarationBubble(lines, getSeatGender(seat))
        },
        onPlayedCardLanded: () => {
          options.gameAudio?.playCardOnTable()
        },
        syncSeatPanels,
        emojiBubbles: getEmojiBubblesForRender(),
        phraseBubbles: getPhraseBubblesForRender(),
        tournamentBotReplacements: activeRoomState.tournamentBotReplacements,
        cache: playingCache,
      } satisfies RenderPlayingScreenOptions)
    } else if (activeRoomState.game !== null) {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:${tableBackground};
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              width:min(90vw, 560px);
              border:1px solid rgba(255,255,255,0.16);
              border-radius:24px;
              padding:28px 30px;
              background:rgba(15,23,42,0.72);
              box-shadow:0 24px 60px rgba(2,6,23,0.34);
              text-align:center;
              color:#e2e8f0;
            "
          >
            <div
              style="
                font-size:13px;
                font-weight:900;
                letter-spacing:0.08em;
                text-transform:uppercase;
                color:#93c5fd;
              "
            >
              Зареждане
            </div>

            <div
              style="
                margin-top:12px;
                font-size:28px;
                font-weight:900;
                color:#f8fafc;
              "
            >
              Зареждане на играта...
            </div>

            <div
              style="
                margin-top:10px;
                font-size:15px;
                line-height:1.5;
                color:#cbd5e1;
              "
            >
              Зареждане на играта...
            </div>
          </div>
          ${scoreHudHtml}
        </div>
      `
    } else {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      const seatsHtml =
        activeRoomState.seats.length > 0
          ? activeRoomState.seats.map(createSeatCardHtml).join('')
          : `
            <div
              style="
                border:1px dashed rgba(148,163,184,0.28);
                border-radius:18px;
                padding:24px;
                color:#cbd5e1;
                text-align:center;
                background:rgba(15,23,42,0.42);
              "
            >
              Зареждане на играта...
            </div>
          `

      options.root.innerHTML = `
        <div
          ${mobileLayoutAttribute}
          style="
            min-height:100vh;
            box-sizing:border-box;
            padding:${ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING / 2}px ${ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING / 2}px;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
              linear-gradient(180deg, #081120 0%, #0f172a 100%);
            font-family:Inter, system-ui, sans-serif;
          "
        >
          <div
            style="
              position:relative;
              width:${scaledStageWidth}px;
              height:${scaledStageHeight}px;
              flex:0 0 auto;
            "
          >
            <div
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                  background:
                    radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
                    linear-gradient(180deg, #081120 0%, #0f172a 100%);
                  color:#e2e8f0;
                "
              >
                <div
                  style="
                    width:1180px;
                    margin:0 auto;
                    padding:34px 0 40px;
                    display:grid;
                    gap:20px;
                  "
                >
                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                      box-shadow:0 24px 60px rgba(2,6,23,0.34);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        align-items:center;
                        justify-content:space-between;
                        gap:16px;
                      "
                    >
                      <div>
                        <div
                          style="
                            font-size:12px;
                            font-weight:900;
                            letter-spacing:0.08em;
                            text-transform:uppercase;
                            color:#93c5fd;
                            margin-bottom:8px;
                          "
                        >
                          Зареждане
                        </div>

                        <h1
                          style="
                            margin:0;
                            font-size:30px;
                            line-height:1.1;
                            font-weight:900;
                            color:#f8fafc;
                          "
                        >
                          Зареждане на играта...
                        </h1>

                        <div
                          style="
                            margin-top:10px;
                            font-size:15px;
                            color:#cbd5e1;
                          "
                        >
                          Изчакваме информация от сървъра.
                        </div>
                      </div>

                      <button
                        type="button"
                        data-active-room-leave-button="1"
                        style="
                          border:0;
                          border-radius:16px;
                          padding:14px 18px;
                          border:1px solid rgba(251,191,36,0.45);
                          background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
                          color:#171717;
                          font-size:14px;
                          font-weight:900;
                          cursor:pointer;
                          box-shadow:0 14px 32px rgba(0,0,0,0.28);
                        "
                      >
                        Напусни активната стая
                      </button>
                    </div>
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Стая
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${escapeHtml(activeRoomState.roomId)}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Твоето място
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${SEAT_LABELS[activeRoomState.seat]}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Залог
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${activeRoomState.stake}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Статус
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${
                          activeRoomState.isConnected
                            ? 'Свързан със сървъра'
                            : 'Връзката е прекъсната'
                        }
                      </div>
                    </div>
                  </div>

                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        gap:10px 18px;
                        font-size:14px;
                        color:#cbd5e1;
                      "
                    >
                      <div><strong style="color:#f8fafc;">Хора:</strong> ${activeRoomState.humanPlayers}</div>
                      <div><strong style="color:#f8fafc;">Ботове:</strong> ${activeRoomState.botPlayers}</div>
                      <div><strong style="color:#f8fafc;">Статус на стаята:</strong> ${activeRoomState.roomStatus ?? 'няма още'}</div>
                      <div><strong style="color:#f8fafc;">Старт:</strong> ${
                        activeRoomState.shouldStartImmediately ? 'веднага' : 'нормален'
                      }</div>
                    </div>

                    ${
                      activeRoomState.errorText
                        ? `
                          <div
                            style="
                              margin-top:16px;
                              border-radius:16px;
                              padding:14px 16px;
                              background:rgba(127,29,29,0.34);
                              border:1px solid rgba(248,113,113,0.24);
                              color:#fecaca;
                              font-size:14px;
                              font-weight:700;
                            "
                          >
                            ${escapeHtml(activeRoomState.errorText)}
                          </div>
                        `
                        : ''
                    }
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    ${seatsHtml}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    }

    ensureEmojiButton(Boolean(isShowingScoringPhase || isShowingMatchEndedPhase), stageScale)
    syncEmojiPickerPanel(stageScale)
    syncPhrasePickerPanel(stageScale)
    syncActiveRoomOverlayEffects()

    options.root
      .querySelectorAll<HTMLButtonElement>('[data-active-room-cut-index]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          options.gameAudio?.primeGameplaySfx()

          if (!activeRoomState) {
            return
          }

          const cutIndex = Number(button.dataset.activeRoomCutIndex)

          if (!Number.isInteger(cutIndex)) {
            return
          }

          if (!options.isConnected()) {
            activeRoomState.errorText = 'Няма връзка със сървъра.'
            scheduleActiveRoomRender()
            return
          }

          const currentCycleKey = getCuttingCycleKey(activeRoomState.roomId, activeRoomState.game)

          if (
            currentCycleKey === null ||
            cuttingAnimation.pendingCycleKey === currentCycleKey ||
            cuttingAnimation.isAnimating
          ) {
            return
          }

          cuttingAnimation.pendingCycleKey = currentCycleKey
          if (!isPhoneLayoutViewport()) {
            scheduleActiveRoomRender()
          }
          options.submitCutIndex(activeRoomState.roomId, cutIndex)
        })
      })
  }

  function renderTournamentBannerInnerHtml(banner: { message: string }): string {
    return `
      <div style="display:flex;gap:12px;align-items:flex-start;border:1px solid rgba(250,204,21,0.35);border-radius:8px;background:rgba(15,23,42,0.94);box-shadow:0 16px 44px rgba(2,6,23,0.35);color:#f8fafc;padding:12px 14px;font-size:14px;line-height:1.4;">
        <div style="flex:1;min-width:0;">${escapeHtml(banner.message)}</div>
        <button type="button" data-tournament-banner-dismiss="1" aria-label="Затвори" style="width:28px;height:28px;border:0;border-radius:999px;background:rgba(255,255,255,0.12);color:#fff;font-weight:900;cursor:pointer;">×</button>
      </div>
    `
  }

  // Идемпотентен sync (замества append-only appendTournamentBanners()).
  // Server-side контракт (tournamentCoordinator.ts addBanner(): existing id
  // → връща room-а непроменен) гарантира render-relevant полетата на даден
  // banner.id са immutable за живота му — затова dataset.bannerId-only
  // сравнение е достатъчно, не е нужен content-aware key.
  function syncTournamentBanners(): void {
    if (!activeRoomState) {
      options.root.querySelector('[data-tournament-banner-host="1"]')?.remove()
      return
    }

    const activeBanners = activeRoomState.tournamentBanners.filter(
      (banner) => Date.parse(banner.expiresAt) > Date.now(),
    )
    activeRoomState.tournamentBanners = activeBanners

    const existing = options.root.querySelector<HTMLElement>('[data-tournament-banner-host="1"]')

    if (activeBanners.length === 0) {
      existing?.remove()
      return
    }

    const topBanner = activeBanners[activeBanners.length - 1]!

    if (existing) {
      if (existing.dataset.bannerId === topBanner.id) {
        return
      }

      existing.dataset.bannerId = topBanner.id
      existing.innerHTML = renderTournamentBannerInnerHtml(topBanner)
      return
    }

    const host = document.createElement('div')
    host.setAttribute('data-tournament-banner-host', '1')
    host.dataset.bannerId = topBanner.id
    host.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:max(12px, env(safe-area-inset-top))',
      'transform:translateX(-50%)',
      'z-index:40',
      'width:min(92vw, 560px)',
      'pointer-events:auto',
    ].join(';')
    host.innerHTML = renderTournamentBannerInnerHtml(topBanner)
    // Делегиран listener върху persistent host-а (bind-нат само тук, при
    // създаване) — НЕ closure към конкретния banner.id. Четем
    // host.dataset.bannerId fresh при click, така че dismiss винаги уцелва
    // текущо показания banner, включително след content-update без rebind.
    host.addEventListener('click', (event) => {
      if (!(event.target as HTMLElement).closest('[data-tournament-banner-dismiss="1"]')) {
        return
      }
      if (!activeRoomState) return
      const dismissedId = host.dataset.bannerId
      activeRoomState.tournamentBanners = activeRoomState.tournamentBanners.filter(
        (item) => item.id !== dismissedId,
      )
      scheduleActiveRoomRender()
    })
    options.root.appendChild(host)
  }

  function syncActiveRoomOverlayEffects(): void {
    syncTournamentBanners()
    syncLeaveControls()
    syncPersistentBotTakeoverPopup()
  }

  function applyRoomSnapshotToActiveRoom(message: RoomSnapshotMessage): boolean {
    if (!activeRoomState) {
      return false
    }

    if (message.roomId !== activeRoomState.roomId) {
      return false
    }

    // Всеки реален snapshot за активната стая доказва, че връзката е жива —
    // bid-watchdog-ът (виж submitBidActionFromUi/BID_RESPONSE_WATCHDOG_MS)
    // вече е изпълнил единствената си задача, независимо дали ТОЗИ snapshot
    // разрешава pending bid-а. wasPendingBidSentBeforeSnapshot се пази
    // отделно, за да различим по-долу "bid-ът никога не е бил приложен"
    // (currentBidderSeat все още сочи локалния играч) от нормалното
    // разрешаване (нов entry за локалния seat, вече обработено от
    // syncBiddingUiState по-надолу в renderActiveRoomScreen).
    const wasPendingBidSentBeforeSnapshot = biddingUiState.pendingBidSent
    cancelBidWatchdog()

    activeRoomState.roomStatus = message.roomStatus
    activeRoomState.reconnectToken = message.reconnectToken
    activeRoomState.seats = message.seats
    activeRoomState.game = message.game ?? null
    activeRoomState.errorText = null
    activeRoomState.isGuestTrial = message.isGuestTrial
    activeRoomState.isPrivateTableOrigin = message.isPrivateTableOrigin
    activeRoomState.isTournamentMatchOrigin = message.isTournamentMatchOrigin
    activeRoomState.tournamentId = message.tournamentId ?? null
    activeRoomState.tournamentMatchId = message.tournamentMatchId ?? null
    activeRoomState.tournamentRoundType = message.tournamentRoundType ?? null
    activeRoomState.tournamentAttendance = message.tournamentAttendance ?? null
    activeRoomState.tournamentBotReplacements = message.tournamentBotReplacements ?? []
    activeRoomState.tournamentBanners = message.tournamentBanners ?? []
    if (message.stakeAmount !== null && message.stakeAmount > 0) {
      activeRoomState.stake = message.stakeAmount as MatchStake
    }

    const tournamentRoundResultContext = getTournamentRoundResultTransitionContext()
    if (
      tournamentRoundResultAutoTransitionKey !== null &&
      (tournamentRoundResultContext === null || tournamentRoundResultContext.key !== tournamentRoundResultAutoTransitionKey)
    ) {
      clearTournamentRoundResultAutoTransitionTimer()
    }

    if (shouldSilenceNextBiddingSnapshot) {
      const biddingSnapshot = activeRoomState.game?.bidding ?? null
      if (biddingSnapshot) {
        biddingUiState.lastKnownEntriesCount = biddingSnapshot.entries.length
        biddingUiState.wasMyTurn = biddingSnapshot.canSubmitBid
        biddingUiState.pendingBidSent = false
      }
      shouldSilenceNextBiddingSnapshot = false
    }

    // Fresh snapshot (нормален или resync-предизвикан) показва, че сървърът
    // ВСЕ ОЩЕ чака точно от този играч обява — т.е. предишният bid никога не
    // е бил приложен server-side (иначе currentBidderSeat щеше да се смени
    // или щеше да има нов entry, което syncBiddingUiState вече би обработил
    // по-долу). Разблокирай UI-я вместо да оставяш popup-а в заклещено
    // pending/faded състояние — НЕ пращаме автоматично втори bid.
    if (
      wasPendingBidSentBeforeSnapshot &&
      biddingUiState.pendingBidSent &&
      activeRoomState.game?.authoritativePhase === 'bidding' &&
      activeRoomState.game.bidding?.currentBidderSeat === activeRoomState.seat
    ) {
      biddingUiState.pendingBidSent = false
      activeRoomState.errorText = 'Обявата не беше потвърдена. Опитайте отново.'
    }

    scheduleActiveRoomRender(
      cuttingAnimation.isAnimating ||
        dealingAnimation.isAnimating ||
        dealNextTwoAnimation.isAnimating ||
        dealLastThreeAnimation.isAnimating,
    )
    return true
  }

  function enterActiveRoomFromResume(roomId: string, seat: Seat, stake: MatchStake): void {
    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearDealLastThreeAnimationState()
    clearScoringCountdownTicker()
    clearTournamentAttendanceTicker()
    clearRenderStabilityGuards()
    clearTournamentRoundResultAutoTransitionTimer()
    clearReactionCountdownAudioTicker()
    clearBiddingUiState()
    clearEmojiReactionUiState()
    clearPhraseReactionUiState()
    shouldSilenceNextBiddingSnapshot = true
    lastKnownWinningBid = null
    matchEndedSoundPlayed = false
    matchEndedPrizeAnimated = false
    replayStakeEffectShown = false
    initialStakeEffectShown = true
    clearMatchEndedCountdown()
    matchEndedCountdownSeconds = 120
    clearTournamentRoundResultState()
    resetPlayingUiCache(playingCache)
    removePersistentBotTakeoverPopup()
    removeSeatProfileOverlay()
    closeProfileAccessBlockPopup()
    removeSeatPanels()
    removeLeaveButton()
    activeRoomState = {
      roomId,
      seat,
      stake,
      humanPlayers: 4,
      botPlayers: 0,
      shouldStartImmediately: false,
      roomStatus: null,
      reconnectToken: null,
      seats: [],
      game: null,
      isConnected: options.isConnected(),
      errorText: null,
      leavePenaltyWarningOpen: false,
      isGuestTrial: false,
      isPrivateTableOrigin: false,
      isTournamentMatchOrigin: false,
      tournamentId: null,
      tournamentMatchId: null,
      tournamentRoundType: null,
      tournamentAttendance: null,
      tournamentBotReplacements: [],
      tournamentBanners: [],
    }

    const pendingRoomSnapshot = pendingRoomSnapshots.get(roomId)
    if (pendingRoomSnapshot) {
      applyRoomSnapshotToActiveRoom(pendingRoomSnapshot)
      return
    }

    scheduleActiveRoomRender()
  }

  function enterActiveRoom(message: MatchFoundMessage, stakeAlreadyShown = false): void {
    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearDealLastThreeAnimationState()
    clearScoringCountdownTicker()
    clearTournamentAttendanceTicker()
    clearRenderStabilityGuards()
    clearReactionCountdownAudioTicker()
    clearBiddingUiState()
    clearEmojiReactionUiState()
    clearPhraseReactionUiState()
    lastKnownWinningBid = null
    matchEndedSoundPlayed = false
    matchEndedPrizeAnimated = false
    replayStakeEffectShown = false
    initialStakeEffectShown = stakeAlreadyShown
    clearMatchEndedCountdown()
    matchEndedCountdownSeconds = 120
    clearTournamentRoundResultState()
    resetPlayingUiCache(playingCache)
    removePersistentBotTakeoverPopup()
    removeSeatProfileOverlay()
    closeProfileAccessBlockPopup()
    removeSeatPanels()
    removeLeaveButton()
    activeRoomState = {
      roomId: message.roomId,
      seat: message.seat,
      stake: message.stake,
      humanPlayers: message.humanPlayers,
      botPlayers: message.botPlayers,
      shouldStartImmediately: message.shouldStartImmediately,
      roomStatus: null,
      reconnectToken: null,
      seats: [],
      game: null,
      isConnected: options.isConnected(),
      errorText: null,
      leavePenaltyWarningOpen: false,
      isGuestTrial: false,
      isPrivateTableOrigin: false,
      isTournamentMatchOrigin: false,
      tournamentId: null,
      tournamentMatchId: null,
      tournamentRoundType: null,
      tournamentAttendance: null,
      tournamentBotReplacements: [],
      tournamentBanners: [],
    }

    const pendingRoomSnapshot = pendingRoomSnapshots.get(message.roomId)

    if (pendingRoomSnapshot) {
      applyRoomSnapshotToActiveRoom(pendingRoomSnapshot)
      return
    }

    scheduleActiveRoomRender()
  }

  function renderProfileAccessBlockPopupState(): void {
    mountStandaloneProfileAccessBlockPopup(profileAccessBlockPopup, {
      onClose: closeProfileAccessBlockPopup,
      onUnblock: unblockFromProfileAccessBlockPopup,
      onBlock: blockFromProfileAccessBlockPopup,
    })
  }

  function closeProfileAccessBlockPopup(): void {
    if (profileAccessBlockSuccessTimeoutId !== null) {
      window.clearTimeout(profileAccessBlockSuccessTimeoutId)
      profileAccessBlockSuccessTimeoutId = null
    }
    profileAccessBlockPopup = null
    renderProfileAccessBlockPopupState()
  }

  function unblockFromProfileAccessBlockPopup(profileId: string): void {
    void (async () => {
      const result = await options.onBlockProfileFull(profileId)
      if (profileAccessBlockPopup?.profileId !== profileId) return
      if ('ok' in result && !result.ok) return
      // За разлика от lobby-я, RoomSeatSnapshot не носи profileId (клиентът
      // никога не получава opponent profileId-та напред), затова не можем
      // да resolve-нем кой seat съответства на profileId, за да
      // auto-reopen-нем профила тук. Затваряме popup-a — потребителят може
      // да кликне seat-а отново, ако иска да види профила, точно както при
      // всеки друг клик върху зает seat.
      profileAccessBlockPopup = null
      renderProfileAccessBlockPopupState()
    })()
  }

  // "Блокирай" от access-denial popup-a (target вече е блокирал viewer-а).
  // Reuse-ва СЪЩИЯ authoritative onBlockProfileFull endpoint като нормалния
  // "Блокирай" бутон в profile popup-a (renderSeatProfileOverlay.ts's
  // _onBlockProfile) — не local UI state. Профилът на target-а не се отваря
  // — само viewer -> target block се записва server-side, резултирайки в
  // mutual block. Success показва кратко inline потвърждение, после
  // popup-ът се затваря автоматично; failure оставя popup-a отворен с
  // inline server error.
  function blockFromProfileAccessBlockPopup(profileId: string): void {
    if (profileAccessBlockPopup?.profileId !== profileId) return

    profileAccessBlockPopup = { ...profileAccessBlockPopup, blockSubmitting: true, blockErrorText: null }
    renderProfileAccessBlockPopupState()

    void (async () => {
      const result = await options.onBlockProfileFull(profileId)
      if (profileAccessBlockPopup?.profileId !== profileId) return

      if ('ok' in result && !result.ok) {
        profileAccessBlockPopup = {
          ...profileAccessBlockPopup,
          blockSubmitting: false,
          blockErrorText: result.limitReached
            ? 'Достигнахте лимита блокирани играчи.'
            : result.message,
        }
        renderProfileAccessBlockPopupState()
        return
      }

      if (profileAccessBlockSuccessTimeoutId !== null) {
        window.clearTimeout(profileAccessBlockSuccessTimeoutId)
        profileAccessBlockSuccessTimeoutId = null
      }
      profileAccessBlockPopup = { profileId, code: profileAccessBlockPopup.code, blockSuccess: true }
      renderProfileAccessBlockPopupState()

      profileAccessBlockSuccessTimeoutId = window.setTimeout(() => {
        profileAccessBlockSuccessTimeoutId = null
        if (profileAccessBlockPopup?.profileId === profileId && profileAccessBlockPopup.blockSuccess) {
          profileAccessBlockPopup = null
          renderProfileAccessBlockPopupState()
        }
      }, 900)
    })()
  }

  function handleServerMessage(message: ServerMessage): boolean {
    if (message.type === 'room_snapshot') {
      pendingRoomSnapshots.set(message.roomId, message)

      // STATE B gameplay entry (§ "GAMEPLAY ENTRY") — while silently attached
      // and still lobby-visible (activeRoomState === null), watch this room's
      // snapshot stream for the authoritative signal that attendance has
      // resolved (bot replacement/walkover included — existing resolution
      // paths, unchanged) or the match has actually started. No client-side
      // wall-clock timeout — this is driven purely by the server-pushed
      // snapshot. See isTournamentAttendanceReadyForSilentEntry for why this
      // requires an actual populated attendance snapshot (unlike the
      // pre-existing in-room "should the raw attendance card show" check,
      // which also treats a null attendance as "ready" — safe there because
      // it only ever runs for an already-seated player past room creation,
      // not for a freshly-armed watch that could observe the very first,
      // not-yet-attendance-hydrated commit of a brand-new tournament room).
      if (
        activeRoomState === null &&
        pendingTournamentSilentEntry !== null &&
        pendingTournamentSilentEntry.roomId === message.roomId &&
        isTournamentAttendanceReadyForSilentEntry(message.tournamentAttendance)
      ) {
        const entry = pendingTournamentSilentEntry
        pendingTournamentSilentEntry = null
        enterActiveRoomFromResume(entry.roomId, entry.seat, entry.stake)
        return true
      }

      if (applyRoomSnapshotToActiveRoom(message)) {
        return true
      }

      return false
    }

    if (message.type === 'tournament_feeder_match_completed') {
      if (tournamentRoundResultFeederMatchId === message.matchId) {
        tournamentRoundResultFeederStatus = 'completed'
        tournamentRoundResultFeederScoreA = message.finalScoreTeamA
        tournamentRoundResultFeederScoreB = message.finalScoreTeamB
        scheduleActiveRoomRender()
      }
      return false
    }

    if (message.type === 'tournament_feeder_score_progress') {
      if (tournamentRoundResultFeederMatchId === message.matchId) {
        tournamentRoundResultFeederStatus = 'in_progress'
        tournamentRoundResultFeederScoreA = message.scoreTeamA
        tournamentRoundResultFeederScoreB = message.scoreTeamB
        scheduleActiveRoomRender()
      }
      return false
    }

    if (!activeRoomState) {
      return false
    }

    if (message.type === 'left_active_room' && message.roomId === activeRoomState.roomId) {
      resetCuttingAnimationState()
      clearDealingAnimationState()
      clearDealNextTwoAnimationState()
      clearDealLastThreeAnimationState()
      clearScoringCountdownTicker()
      clearRenderStabilityGuards()
      clearTournamentRoundResultState()
      clearReactionCountdownAudioTicker()
      clearBiddingUiState()
      clearEmojiReactionUiState()
      clearPhraseReactionUiState()
      removeEmojiButton()
      lastKnownWinningBid = null
      resetPlayingUiCache(playingCache)
      removePersistentBotTakeoverPopup()
      removeSeatProfileOverlay()
      closeProfileAccessBlockPopup()
      removeSeatPanels()
      removeLeaveButton()
      activeRoomState = null
      options.showLobby(
        message.penalty
          ? `Санкция при напускане: ${formatCoinAmount(message.penalty.chargedAmount)} жълтици.`
          : null,
        message.roomId,
      )
      return true
    }

    if (message.type === 'room_resumed' && message.roomId === activeRoomState.roomId) {
      activeRoomState.isConnected = true
      activeRoomState.errorText = null
      scheduleActiveRoomRender()
      return true
    }

    if (message.type === 'room_resume_failed' && message.roomId === activeRoomState.roomId) {
      resetCuttingAnimationState()
      clearDealingAnimationState()
      clearDealNextTwoAnimationState()
      clearDealLastThreeAnimationState()
      clearScoringCountdownTicker()
      clearRenderStabilityGuards()
      clearTournamentRoundResultState()
      clearReactionCountdownAudioTicker()
      clearBiddingUiState()
      clearEmojiReactionUiState()
      clearPhraseReactionUiState()
      removeEmojiButton()
      lastKnownWinningBid = null
      resetPlayingUiCache(playingCache)
      removePersistentBotTakeoverPopup()
      removeSeatProfileOverlay()
      closeProfileAccessBlockPopup()
      removeSeatPanels()
      removeLeaveButton()
      activeRoomState = null
      options.showLobby(message.message, message.roomId)
      return true
    }

    if (message.type === 'player_profile' && message.roomId === activeRoomState.roomId) {
      if (
        (message.code === 'profile_blocked_by_viewer' || message.code === 'profile_blocked_viewer') &&
        message.deniedProfileId != null
      ) {
        // Server-side profile access denial (block в която и да е посока) —
        // общ denied-profile popup, не generic empty-content текст. Затваря
        // seat loading overlay-a (той никога не е получил profile данните),
        // и mount-ва standalone denial popup-a вместо него.
        removeSeatProfileOverlay()
        profileAccessBlockPopup = { profileId: message.deniedProfileId, code: message.code }
        renderProfileAccessBlockPopupState()
        return true
      }

      const seatSnapshot = activeRoomState.seats.find((s) => s.seat === message.seat) ?? null
      if (seatSnapshot) {
        updateSeatProfileOverlay(seatSnapshot, message.profile, message.message ?? null)
      }
      return true
    }

    if (message.type === 'error') {
      clearPendingCutSubmission()
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
      activeRoomState.errorText = message.message
      scheduleActiveRoomRender()
      return true
    }

    if (message.type === 'emoji_reaction' && message.roomId === activeRoomState.roomId) {
      addEmojiBubble(message.seat as Seat, message.emojiId)
      scheduleActiveRoomRender()
      return true
    }

    if (message.type === 'phrase_reaction' && message.roomId === activeRoomState.roomId) {
      addPhraseBubble(message.seat as Seat, message.phraseId)
      scheduleActiveRoomRender()
      return true
    }

    return false
  }

  function getResumeInfo(): { roomId: string; reconnectToken: string } | null {
    if (!activeRoomState || !activeRoomState.reconnectToken) {
      return null
    }

    return {
      roomId: activeRoomState.roomId,
      reconnectToken: activeRoomState.reconnectToken,
    }
  }

  function setConnected(value: boolean): void {
    if (!activeRoomState) {
      return
    }

    if (!value) {
      clearPendingCutSubmission()
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
    }

    activeRoomState.isConnected = value
    scheduleActiveRoomRender()
  }

  function setConnectionError(message: string | null): void {
    if (!activeRoomState) {
      return
    }

    if (message) {
      clearPendingCutSubmission()
      clearPendingBidSubmission()
      playingCache.pendingPlayCardSent = false
    }

    activeRoomState.errorText = message
    scheduleActiveRoomRender()
  }

  function setConnectionState(isConnected: boolean, message: string | null): void {
    if (!activeRoomState) {
      return
    }

    if (!isConnected || message) {
      clearPendingCutSubmission()
      clearPendingBidSubmission()
    }

    activeRoomState.isConnected = isConnected
    activeRoomState.errorText = message
    scheduleActiveRoomRender()
  }

  function leaveActiveRoom(): void {
    if (!activeRoomState) {
      return
    }

    requestActiveRoomLeave()
  }

  function returnToLobbyFromMatchEnded(): void {
    if (!activeRoomState) {
      return
    }

    const roomId = activeRoomState.roomId

    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearDealLastThreeAnimationState()
    clearScoringCountdownTicker()
    clearRenderStabilityGuards()
    clearReactionCountdownAudioTicker()
    clearBiddingUiState()
    clearEmojiReactionUiState()
    clearPhraseReactionUiState()
    clearTournamentFinalResultPendingRetry()
    tournamentFinalResultMatchId = null
    tournamentFinalResultPrizeAmount = null
    lastKnownWinningBid = null
    resetPlayingUiCache(playingCache)
    removePersistentBotTakeoverPopup()
    removeSeatProfileOverlay()
    closeProfileAccessBlockPopup()
    removeSeatPanels()
    removeLeaveButton()
    options.leaveActiveRoom(roomId)
    activeRoomState = null
    options.showLobby(null, roomId)
  }

  function startNewGameFromMatchEnded(): void {
    if (!activeRoomState) {
      return
    }

    const roomId = activeRoomState.roomId
    const stake = activeRoomState.stake
    const displayName = activeRoomState.seats
      .find((seat) => seat.seat === activeRoomState?.seat)
      ?.displayName.trim()

    resetCuttingAnimationState()
    clearDealingAnimationState()
    clearDealNextTwoAnimationState()
    clearDealLastThreeAnimationState()
    clearScoringCountdownTicker()
    clearRenderStabilityGuards()
    clearReactionCountdownAudioTicker()
    clearBiddingUiState()
    clearEmojiReactionUiState()
    clearPhraseReactionUiState()
    lastKnownWinningBid = null
    resetPlayingUiCache(playingCache)
    removePersistentBotTakeoverPopup()
    removeSeatProfileOverlay()
    closeProfileAccessBlockPopup()
    removeSeatPanels()
    removeLeaveButton()
    options.leaveActiveRoom(roomId)
    activeRoomState = null
    options.startNewGame(stake, displayName || undefined)
  }

  function hasActiveRoom(): boolean {
    return activeRoomState !== null
  }

  function getActiveNonTournamentRoomInfo(): { roomId: string; stakeAmount: number } | null {
    if (activeRoomState === null || activeRoomState.isTournamentMatchOrigin) {
      return null
    }
    return { roomId: activeRoomState.roomId, stakeAmount: activeRoomState.stake }
  }

  function getCurrentRoomId(): string | null {
    return activeRoomState?.roomId ?? null
  }

  // A tournament room's very first commit (ensureMatchRoom's brand-new-room
  // branch in tournamentCoordinator.ts) writes the bare room BEFORE
  // resolveAttendance's follow-up commitSnapshot populates
  // config.tournamentAttendance — so tournamentAttendance === null on a
  // tournament-origin room can genuinely mean "not hydrated yet", not just
  // "attendance lifecycle doesn't apply". This watch is only ever armed for a
  // known tournament round-transition room (armPendingTournamentSilentEntry
  // callers), so unlike the null-tolerant check the in-room attendance-card
  // gate uses for an already-seated player, treating null here as "ready"
  // would risk a premature enter on that first snapshot. Require an actual
  // populated attendance snapshot confirming started/completed instead.
  function isTournamentAttendanceReadyForSilentEntry(
    attendance: TournamentAttendanceSnapshot | null | undefined,
  ): boolean {
    return attendance != null && (attendance.state === 'started' || attendance.state === 'completed')
  }

  // Counterpart to armPendingTournamentSilentEntry's idempotency guard — must
  // be called when a silent resume_room is known to have failed (e.g.
  // room_resume_failed) so a later retry for the SAME roomId isn't blocked by
  // the stale watch left over from the failed attempt.
  function clearPendingTournamentSilentEntry(roomId: string): void {
    if (pendingTournamentSilentEntry !== null && pendingTournamentSilentEntry.roomId === roomId) {
      pendingTournamentSilentEntry = null
    }
  }

  function armPendingTournamentSilentEntry(input: { roomId: string; seat: Seat; stake: MatchStake }): void {
    if (pendingTournamentSilentEntry !== null && pendingTournamentSilentEntry.roomId === input.roomId) {
      return
    }
    pendingTournamentSilentEntry = input
    // A room_snapshot for this room may already be cached (e.g. it arrived
    // before this arm call, or a previous arm for the same room already
    // primed pendingRoomSnapshots) — re-check it immediately instead of only
    // reacting to the NEXT push, so a match that's already attendance-resolved
    // by the time the lobby calls this doesn't wait for another snapshot.
    const cached = pendingRoomSnapshots.get(input.roomId)
    if (
      cached !== undefined &&
      activeRoomState === null &&
      isTournamentAttendanceReadyForSilentEntry(cached.tournamentAttendance)
    ) {
      pendingTournamentSilentEntry = null
      enterActiveRoomFromResume(input.roomId, input.seat, input.stake)
    }
  }

  document.body.addEventListener('click', (e) => {
    const target = e.target
    if (!(target instanceof Element)) return

    closeReactionPickersOnOutsideClick(target)

    const btn = target.closest<HTMLElement>('[data-profile-seat-btn]')
    if (!btn || !activeRoomState) return
    const seatAttr = btn.getAttribute('data-profile-seat-btn') as Seat | null
    if (!seatAttr) return
    const seatSnapshot = activeRoomState.seats.find((s) => s.seat === seatAttr)
    if (!seatSnapshot) return
    const isOwnSeat = seatAttr === activeRoomState.seat
    showSeatProfileOverlay(
      seatSnapshot,
      () => removeSeatProfileOverlay(),
      isOwnSeat,
      isOwnSeat ? null : options.getFriendshipAction,
      isOwnSeat ? null : options.onSendFriendRequest,
      isOwnSeat ? null : options.onLikeProfile,
      isOwnSeat ? null : options.onBlockProfile,
    )
    options.requestPlayerProfile(activeRoomState.roomId, seatAttr)
  })

  return {
    render: renderActiveRoomScreen,
    enterActiveRoom,
    enterActiveRoomFromResume,
    handleServerMessage,
    completePendingTournamentRoundResultTransition: completeTournamentRoundResultTransition,
    getResumeInfo,
    setConnected,
    setConnectionError,
    setConnectionState,
    leaveActiveRoom,
    hasActiveRoom,
    getActiveNonTournamentRoomInfo,
    getCurrentRoomId,
    armPendingTournamentSilentEntry,
    clearPendingTournamentSilentEntry,
  }
}

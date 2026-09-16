// Браузърна тестова "сглобка" за checkPrivateRoomWaitingMobile.ts's end-game
// coverage — рендира реалния production renderMatchEndedScreen() (същия код
// зад previewMatchEndedScreen.ts) с конфигурируем isPrivateTableOrigin, за
// да докаже реално на мобилни viewport-и, че "Нова игра" се крие за частни
// маси (включително стартирани със "Запълни с ботове") и остава за публични.
import { renderMatchEndedScreen } from '/src/app/activeRoom/renderMatchEndedScreen.ts'
import { getActiveRoomStageMetrics } from '/src/app/activeRoom/activeRoomShared.ts'
import type { RoomGameSnapshot, RoomSeatSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
root.style.position = 'fixed'
root.style.inset = '0'
document.body.appendChild(root)

function buildSeats(longNames: boolean): RoomSeatSnapshot[] {
  return [
    {
      seat: 'bottom',
      displayName: longNames ? 'Константин Александров-Величков' : 'Гост',
      isOccupied: true,
      isBot: false,
      isControlledByBot: false,
      isConnected: true,
      avatarUrl: null,
      level: 14,
      rankTitle: 'Майстор',
      skillRating: 1260,
      gender: null,
    },
    {
      seat: 'right',
      displayName: longNames ? 'Aleksandrinaaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'Moby65564',
      isOccupied: true,
      isBot: true,
      isControlledByBot: false,
      isConnected: true,
      avatarUrl: null,
      level: 9,
      rankTitle: null,
      skillRating: 980,
      gender: null,
    },
    {
      seat: 'top',
      displayName: 'A6456655',
      isOccupied: true,
      isBot: false,
      isControlledByBot: false,
      isConnected: true,
      avatarUrl: null,
      level: 11,
      rankTitle: null,
      skillRating: 1040,
      gender: null,
    },
    {
      seat: 'left',
      displayName: 'B54645656',
      isOccupied: true,
      isBot: true,
      isControlledByBot: false,
      isConnected: true,
      avatarUrl: null,
      level: 7,
      rankTitle: null,
      skillRating: 910,
      gender: null,
    },
  ]
}

function buildGame(winnerTeam: 'A' | 'B', awardedPrizeAmount: number | null): RoomGameSnapshot {
  return {
    phase: 'finished',
    authoritativePhase: 'match-ended',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: null,
    scoring: null,
    matchEnded: {
      winnerTeam,
      targetScore: 151,
      finalScore: { teamA: 160, teamB: 134 },
      endedAt: Date.now(),
      replayVotes: ['bottom'],
      leaveVotes: [],
      awardedPrizeAmount,
    },
    declarations: [],
    score: { match: { teamA: 160, teamB: 134 } },
    handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
    ownHand: [],
  }
}

function paint(isPrivateTableOrigin: boolean, longNames: boolean): void {
  const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
  renderMatchEndedScreen({
    root: root as unknown as HTMLDivElement,
    game: buildGame('A', 13000),
    seats: buildSeats(longNames),
    localSeat: 'bottom',
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    prizeAmount: 13000,
    countdownSeconds: 87,
    prizeAnimationStartedAt: Date.now(),
    isPrivateTableOrigin,
    onReturnToLobby: () => {},
    onStartNewGame: () => {},
    onReplayVote: () => {},
    onLeaveVote: () => {},
  })
}

// Симулира точно createActiveRoomFlowController.ts-овото
// matchEndedPrizeAnimationStartedAt state management — стойността се пази
// ТУК (harness-level, module state), не се re-derive-ва при всеки повикване,
// точно както в production controller-а (виж doc коментара в
// renderMatchEndedScreen.ts). resetPrizeAnimation() симулира нов match-ended
// lifecycle (нов мач/нова прозоречна сесия).
let prizeAnimationStartedAt: number | null = null

function resetPrizeAnimation(): void {
  prizeAnimationStartedAt = null
}

// Параметризирана paint функция за prize display regression check-а (виж
// task-а — "числото никога не трябва да остане stuck на междинна стойност
// при re-render"). winnerTeam='A' + localSeat='bottom' (team A) =>
// победител, локалният играч вижда prize; winnerTeam='B' => губещ, localSeat
// остава 'bottom' — CASE J (losing player, no prize counter). prizeAmount=
// null/0 покрива CASE J. Всяко повикване е еквивалентно на ЕДИН
// renderMatchEndedScreen() call в production (напр. countdown tick
// re-render) — тестът симулира re-render-и, като вика тази функция
// многократно, докато очаква конкретен elapsed спрямо ПЪРВОТО повикване.
function paintPrize(winnerTeam: 'A' | 'B', prizeAmount: number | null): void {
  const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
  renderMatchEndedScreen({
    root: root as unknown as HTMLDivElement,
    game: buildGame(winnerTeam, prizeAmount),
    seats: buildSeats(false),
    localSeat: 'bottom',
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    prizeAmount,
    countdownSeconds: 87,
    prizeAnimationStartedAt,
    onPrizeAnimationStart: (startedAt) => {
      prizeAnimationStartedAt = startedAt
    },
    isPrivateTableOrigin: false,
    onReturnToLobby: () => {},
    onStartNewGame: () => {},
    onReplayVote: () => {},
    onLeaveVote: () => {},
  })
}

// Симулира createActiveRoomFlowController.ts-овото
// matchEndedPartnerRatingState tri-state management (виж
// renderMatchEndedScreen.ts::RenderMatchEndedScreenOptions.partnerRatingStatus
// doc коментара за пълния "false-success UI" root cause/fix rationale) —
// стойността се пази ТУК (harness-level, module state), не се re-derive-ва
// при всеки render call, точно както в production controller-а.
// 'submitting' се задава СИНХРОННО при клик (onPartnerRatingSubmitted) —
// temporary optimistic disable. 'submitted' се задава ЕДИНСТВЕНО от
// resolveSubmit() (симулира получаване на реален partner_rating_result
// server response), точно както production handleServerMessage-а.
// onSubmitPartnerRatingCallCount проследява колко пъти onSubmitPartnerRating
// действително е бил извикан (симулира WebSocket submit_partner_rating
// изпращания) — за R6 (втори клик да НЕ прати втори submit call).
let partnerRatingStatus: 'idle' | 'submitting' | 'submitted' = 'idle'
let onSubmitPartnerRatingCallCount = 0

function resetPartnerRating(): void {
  partnerRatingStatus = 'idle'
  onSubmitPartnerRatingCallCount = 0
}

function getOnSubmitPartnerRatingCallCount(): number {
  return onSubmitPartnerRatingCallCount
}

function getPartnerRatingStatus(): 'idle' | 'submitting' | 'submitted' {
  return partnerRatingStatus
}

// Симулира получаването на partner_rating_result WebSocket съобщение —
// точно репликира handleServerMessage 'partner_rating_result' клона в
// createActiveRoomFlowController.ts: ok:true ИЛИ alreadyRated:true ->
// 'submitted' (permanent); generic failure -> 'idle' (retry-able).
function resolveSubmit(ok: boolean, alreadyRated: boolean): void {
  if (partnerRatingStatus !== 'submitting') {
    return
  }
  partnerRatingStatus = ok || alreadyRated ? 'submitted' : 'idle'
}

// Параметризирана paint функция за partner-rating regression check-а.
// Всяко повикване е еквивалентно на ЕДИН renderMatchEndedScreen() call в
// production (напр. re-render, предизвикан от room_snapshot при leave/
// replay vote) — тестът симулира re-render-и, като вика тази функция
// многократно, докато partnerRatingStatus module state-ът persist-ва между
// повикванията точно както matchEndedPartnerRatingState в production
// controller-а.
function paintRating(winnerTeam: 'A' | 'B'): void {
  const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
  renderMatchEndedScreen({
    root: root as unknown as HTMLDivElement,
    game: buildGame(winnerTeam, 13000),
    seats: buildSeats(false),
    localSeat: 'bottom',
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    prizeAmount: 13000,
    countdownSeconds: 87,
    prizeAnimationStartedAt: Date.now(),
    partnerRatingStatus,
    isPrivateTableOrigin: false,
    onReturnToLobby: () => {},
    onStartNewGame: () => {},
    onReplayVote: () => {},
    onLeaveVote: () => {},
    onSubmitPartnerRating: () => {
      onSubmitPartnerRatingCallCount += 1
    },
    onPartnerRatingSubmitted: () => {
      partnerRatingStatus = 'submitting'
    },
  })
}

;(window as any).__matchEndedHarness = {
  paint,
  paintPrize,
  resetPrizeAnimation,
  paintRating,
  resetPartnerRating,
  getOnSubmitPartnerRatingCallCount,
  getPartnerRatingStatus,
  resolveSubmit,
}

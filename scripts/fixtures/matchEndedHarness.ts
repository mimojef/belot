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

function buildGame(): RoomGameSnapshot {
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
      winnerTeam: 'A',
      targetScore: 151,
      finalScore: { teamA: 160, teamB: 134 },
      endedAt: Date.now(),
      replayVotes: ['bottom'],
      leaveVotes: [],
      awardedPrizeAmount: 13000,
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
    game: buildGame(),
    seats: buildSeats(longNames),
    localSeat: 'bottom',
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    countdownSeconds: 87,
    skipPrizeAnimation: true,
    isPrivateTableOrigin,
    onReturnToLobby: () => {},
    onStartNewGame: () => {},
    onReplayVote: () => {},
    onLeaveVote: () => {},
  })
}

;(window as any).__matchEndedHarness = {
  paint,
}

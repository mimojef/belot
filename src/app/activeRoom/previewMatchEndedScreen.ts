import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
} from '../network/createGameServerClient'
import { getActiveRoomStageMetrics } from './activeRoomShared'
import { renderMatchEndedScreen } from './renderMatchEndedScreen'

const PREVIEW_QUERY_KEY = 'preview'
const PREVIEW_QUERY_VALUE = 'match-ended'

const previewSeats: RoomSeatSnapshot[] = [
  {
    seat: 'bottom',
    displayName: 'Гост',
    isOccupied: true,
    isBot: false,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: null,
    level: 14,
    rankTitle: 'Майстор',
    skillRating: 1260,
  },
  {
    seat: 'right',
    displayName: 'Moby65564',
    isOccupied: true,
    isBot: true,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: null,
    level: 9,
    rankTitle: null,
    skillRating: 980,
  },
  {
    seat: 'top',
    displayName: 'A6456655',
    isOccupied: true,
    isBot: true,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: null,
    level: 11,
    rankTitle: null,
    skillRating: 1040,
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
  },
]

const previewGame: RoomGameSnapshot = {
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
    finalScore: {
      teamA: 160,
      teamB: 134,
    },
    endedAt: Date.now(),
  },
  declarations: [],
  score: {
    match: {
      teamA: 160,
      teamB: 134,
    },
  },
  handCounts: {
    bottom: 0,
    right: 0,
    top: 0,
    left: 0,
  },
  ownHand: [],
}

export function isMatchEndedPreviewRequest(): boolean {
  return new URLSearchParams(window.location.search).get(PREVIEW_QUERY_KEY) === PREVIEW_QUERY_VALUE
}

export function renderMatchEndedPreview(root: HTMLDivElement): void {
  const {
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
  } = getActiveRoomStageMetrics()

  renderMatchEndedScreen({
    root,
    game: previewGame,
    seats: previewSeats,
    localSeat: 'bottom',
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    onReturnToLobby: () => {
      console.info('[preview] Return to lobby clicked.')
    },
  })
}

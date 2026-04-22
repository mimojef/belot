import type { Seat, Team } from '../core/serverTypes.js'
import type {
  ServerBiddingState,
  ServerCard,
  ServerCarryOverPoints,
  ServerDeclaration,
  ServerPlayingState,
  ServerRoundScore,
  ServerScoreBreakdown,
  ServerTimerState,
  ServerTrickState,
} from './serverGameTypes.js'

export function createEmptyHands(): Record<Seat, ServerCard[]> {
  return {
    bottom: [],
    right: [],
    top: [],
    left: [],
  }
}

export function createEmptyBiddingState(): ServerBiddingState {
  return {
    entries: [],
    currentSeat: null,
    winningBid: null,
    hasStarted: false,
    hasEnded: false,
    consecutivePasses: 0,
  }
}

export function createEmptyDeclarations(): ServerDeclaration[] {
  return []
}

export function createEmptyTrickState(): ServerTrickState {
  return {
    leaderSeat: null,
    currentSeat: null,
    plays: [],
    winnerSeat: null,
    trickIndex: 0,
  }
}

export function createEmptyWonTricks(): Record<Team, ServerCard[][]> {
  return {
    A: [],
    B: [],
  }
}

export function createEmptyWonTricksBySeat(): Record<Seat, ServerCard[][]> {
  return {
    bottom: [],
    right: [],
    top: [],
    left: [],
  }
}

export function createEmptyPlayingState(): ServerPlayingState {
  return {
    hasStarted: false,
    currentTurnSeat: null,
    currentTrick: createEmptyTrickState(),
    completedTricks: [],
    lastCompletedTrickWinnerSeat: null,
    lastCompletedTrickWinnerTeam: null,
    wonTricksBySeat: createEmptyWonTricksBySeat(),
    wonTricksByTeam: createEmptyWonTricks(),
  }
}

export function createEmptyRoundScore(): ServerRoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

export function createEmptyScoreBreakdown(): ServerScoreBreakdown {
  return {
    tricks: createEmptyRoundScore(),
    declarations: createEmptyRoundScore(),
    belote: createEmptyRoundScore(),
    lastTen: createEmptyRoundScore(),
    capot: createEmptyRoundScore(),
    total: createEmptyRoundScore(),
  }
}

export function createEmptyCarryOverPoints(): ServerCarryOverPoints {
  return {
    teamA: 0,
    teamB: 0,
  }
}

export function createEmptyTimerState(): ServerTimerState {
  return {
    activeSeat: null,
    startedAt: null,
    durationMs: null,
    expiresAt: null,
  }
}
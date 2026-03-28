import type { Seat } from '../../data/constants/seatOrder'
import type {
  BiddingState,
  Card,
  CarryOverPoints,
  Declaration,
  PlayerState,
  RoundScore,
  ScoreBreakdown,
  Team,
  TimerState,
  TrickState,
} from './gameTypes'

export function createPlayersState(): Record<Seat, PlayerState> {
  return {
    bottom: {
      seat: 'bottom',
      team: 'A',
      mode: 'human',
      controlledByBot: false,
    },
    right: {
      seat: 'right',
      team: 'B',
      mode: 'bot',
      controlledByBot: false,
    },
    top: {
      seat: 'top',
      team: 'A',
      mode: 'bot',
      controlledByBot: false,
    },
    left: {
      seat: 'left',
      team: 'B',
      mode: 'bot',
      controlledByBot: false,
    },
  }
}

export function createEmptyHands(): Record<Seat, Card[]> {
  return {
    bottom: [],
    right: [],
    top: [],
    left: [],
  }
}

export function createEmptyBiddingState(): BiddingState {
  return {
    entries: [],
    currentSeat: null,
    winningBid: null,
    hasStarted: false,
    hasEnded: false,
    consecutivePasses: 0,
  }
}

export function createEmptyDeclarations(): Declaration[] {
  return []
}

export function createEmptyTrickState(): TrickState {
  return {
    leaderSeat: null,
    currentSeat: null,
    plays: [],
    winnerSeat: null,
    trickIndex: 0,
  }
}

export function createEmptyWonTricks(): Record<Team, Card[][]> {
  return {
    A: [],
    B: [],
  }
}

export function createEmptyRoundScore(): RoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

export function createEmptyScoreBreakdown(): ScoreBreakdown {
  return {
    tricks: createEmptyRoundScore(),
    declarations: createEmptyRoundScore(),
    belote: createEmptyRoundScore(),
    lastTen: createEmptyRoundScore(),
    capot: createEmptyRoundScore(),
    total: createEmptyRoundScore(),
  }
}

export function createEmptyCarryOverPoints(): CarryOverPoints {
  return {
    teamA: 0,
    teamB: 0,
  }
}

export function createEmptyTimerState(): TimerState {
  return {
    activeSeat: null,
    startedAt: null,
    durationMs: null,
    expiresAt: null,
  }
}
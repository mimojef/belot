import type { Seat } from '../../data/constants/seatOrder'
import type { PhaseType } from '../phases/phaseTypes'

export type Team = 'A' | 'B'
export type PlayerMode = 'human' | 'bot'

export type ContractType =
  | 'suit'
  | 'no-trumps'
  | 'all-trumps'
  | 'double'
  | 'redouble'
  | 'pass'

export type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'

export type Rank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'

export type Card = {
  id: string
  suit: Suit
  rank: Rank
}

export type PlayerState = {
  seat: Seat
  team: Team
  mode: PlayerMode
  controlledByBot: boolean
}

export type BidAction =
  | { type: 'pass' }
  | { type: 'suit'; suit: Suit }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type BidEntry = {
  seat: Seat
  action: BidAction
}

export type WinningBid =
  | null
  | {
      seat: Seat
      contract: 'suit' | 'no-trumps' | 'all-trumps'
      trumpSuit: Suit | null
      doubled: boolean
      redoubled: boolean
    }

export type BiddingState = {
  entries: BidEntry[]
  currentSeat: Seat | null
  winningBid: WinningBid
  hasStarted: boolean
  hasEnded: boolean
  consecutivePasses: number
}

export type DeclarationType = 'sequence-3' | 'sequence-4' | 'sequence-5-plus' | 'belote'

export type Declaration = {
  seat: Seat
  team: Team
  type: DeclarationType
  points: number
  cards: Card[]
  suit: Suit | null
  highRank: Rank | null
  announced: boolean
  valid: boolean
}

export type TrickPlay = {
  seat: Seat
  card: Card
}

export type TrickState = {
  leaderSeat: Seat | null
  currentSeat: Seat | null
  plays: TrickPlay[]
  winnerSeat: Seat | null
  trickIndex: number
}

export type CompletedTrick = {
  trickIndex: number
  leaderSeat: Seat
  plays: TrickPlay[]
  winnerSeat: Seat
  winningTeam: Team
}

export type PlayingState = {
  hasStarted: boolean
  currentTurnSeat: Seat | null
  currentTrick: TrickState
  completedTricks: CompletedTrick[]
  lastCompletedTrickWinnerSeat: Seat | null
  lastCompletedTrickWinnerTeam: Team | null
  wonTricksBySeat: Record<Seat, Card[][]>
  wonTricksByTeam: Record<Team, Card[][]>
}

export type RoundScore = {
  teamA: number
  teamB: number
}

export type ScoreBreakdown = {
  tricks: RoundScore
  declarations: RoundScore
  belote: RoundScore
  lastTen: RoundScore
  capot: RoundScore
  total: RoundScore
}

export type CarryOverPoints = {
  teamA: number
  teamB: number
}

export type TimerState = {
  activeSeat: Seat | null
  startedAt: number | null
  durationMs: number | null
  expiresAt: number | null
}

export type RoundMeta = {
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  firstBidderSeat: Seat | null
  firstDealSeat: Seat | null
  selectedCutIndex: number | null
}

export type GameState = {
  phase: PhaseType
  players: Record<Seat, PlayerState>
  round: RoundMeta
  deck: Card[]
  hands: Record<Seat, Card[]>
  bidding: BiddingState
  declarations: Declaration[]
  currentTrick: TrickState
  wonTricks: Record<Team, Card[][]>
  playing?: PlayingState
  score: {
    round: ScoreBreakdown
    match: RoundScore
    carryOver: CarryOverPoints
  }
  timer: TimerState
}
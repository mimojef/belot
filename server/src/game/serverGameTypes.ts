import type { Seat, Team } from '../core/serverTypes.js'
import type { AuthoritativePhaseType } from './serverPhaseTypes.js'

export type ServerPlayerMode = 'human' | 'bot'

export type ServerSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
export type ServerRank = '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'

export type ServerCard = {
  id: string
  suit: ServerSuit
  rank: ServerRank
}

export type ServerPlayerState = {
  seat: Seat
  team: Team
  mode: ServerPlayerMode
  controlledByBot: boolean
}

export type ServerBidAction =
  | { type: 'pass' }
  | { type: 'suit'; suit: ServerSuit }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type ServerBidEntry = {
  seat: Seat
  action: ServerBidAction
}

export type ServerWinningBid =
  | null
  | {
      seat: Seat
      contract: 'suit' | 'no-trumps' | 'all-trumps'
      trumpSuit: ServerSuit | null
      doubled: boolean
      redoubled: boolean
    }

export type ServerBiddingState = {
  entries: ServerBidEntry[]
  currentSeat: Seat | null
  winningBid: ServerWinningBid
  hasStarted: boolean
  hasEnded: boolean
  consecutivePasses: number
}

export type ServerDeclarationType = 'sequence' | 'square' | 'belote'

export type ServerDeclaration = {
  seat: Seat
  team: Team
  type: ServerDeclarationType
  points: number
  cards: ServerCard[]
  suit: ServerSuit | null
  highRank: ServerRank | null
  announced: boolean
  valid: boolean
}

export type ServerTrickPlay = {
  seat: Seat
  card: ServerCard
}

export type ServerTrickState = {
  leaderSeat: Seat | null
  currentSeat: Seat | null
  plays: ServerTrickPlay[]
  winnerSeat: Seat | null
  trickIndex: number
}

export type ServerCompletedTrick = {
  trickIndex: number
  leaderSeat: Seat
  plays: ServerTrickPlay[]
  winnerSeat: Seat
  winningTeam: Team
}

export type ServerTimerState = {
  activeSeat: Seat | null
  startedAt: number | null
  durationMs: number | null
  expiresAt: number | null
}

export type ServerRoundMeta = {
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  firstBidderSeat: Seat | null
  firstDealSeat: Seat | null
  selectedCutIndex: number | null
}

export type ServerRoundScore = {
  teamA: number
  teamB: number
}

export type ServerCarryOverPoints = {
  teamA: number
  teamB: number
}

export type ServerScoreBreakdown = {
  tricks: ServerRoundScore
  declarations: ServerRoundScore
  belote: ServerRoundScore
  lastTen: ServerRoundScore
  capot: ServerRoundScore
  total: ServerRoundScore
}

export type ServerPlayingState = {
  hasStarted: boolean
  currentTurnSeat: Seat | null
  currentTrick: ServerTrickState
  completedTricks: ServerCompletedTrick[]
  lastCompletedTrickWinnerSeat: Seat | null
  lastCompletedTrickWinnerTeam: Team | null
  wonTricksBySeat: Record<Seat, ServerCard[][]>
  wonTricksByTeam: Record<Team, ServerCard[][]>
}

export type ServerScoringState = {
  winningBid: NonNullable<ServerWinningBid>
  rawHandPoints: ServerRoundScore
  declarationPoints: ServerRoundScore
  belotePoints: ServerRoundScore
  sumPoints: ServerRoundScore
  officialRoundPoints: ServerRoundScore
  matchTotals: ServerRoundScore
  carryOver: ServerCarryOverPoints
  outcomeLabel: string
  outcomeShortLabel: string
  counterMultiplier: number
}

export type ServerAuthoritativeGameState = {
  phase: AuthoritativePhaseType
  phaseEnteredAt: number | null
  players: Record<Seat, ServerPlayerState>
  round: ServerRoundMeta
  deck: ServerCard[]
  hands: Record<Seat, ServerCard[]>
  bidding: ServerBiddingState
  declarations: ServerDeclaration[]
  currentTrick: ServerTrickState
  wonTricks: Record<Team, ServerCard[][]>
  playing: ServerPlayingState | null
  scoring: ServerScoringState | null
  score: {
    round: ServerScoreBreakdown
    match: ServerRoundScore
    carryOver: ServerCarryOverPoints
  }
  timer: ServerTimerState
}

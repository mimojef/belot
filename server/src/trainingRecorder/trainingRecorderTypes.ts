import type { Seat, Team } from '../core/serverTypes.js'
import type { ServerCard, ServerSuit } from '../game/serverGameTypes.js'

// ─── Re-exports for convenience ──────────────────────────────────────────────

export type { ServerCard as TrainingCard }
export type { ServerSuit as TrainingCardSuit }
export type { Seat, Team }

// ─── Actor kind ───────────────────────────────────────────────────────────────

export type TrainingActorKind =
  | 'human_manual'
  | 'human_timeout'
  | 'bot_original'
  | 'bot_takeover'

// ─── Bid action (compact) ─────────────────────────────────────────────────────

export type TrainingBidActionType =
  | 'pass'
  | 'suit'
  | 'no-trumps'
  | 'all-trumps'
  | 'double'
  | 'redouble'

export type TrainingCompactBidAction =
  | { type: 'pass' }
  | { type: 'suit'; suit: ServerSuit }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

// ─── Played card reference (compact) ─────────────────────────────────────────

export type TrainingCompactPlayedCard = {
  sequence: number
  trickIndex: number
  positionInTrick: number
  seat: Seat
  card: ServerCard
}

// ─── Visible state snapshots ─────────────────────────────────────────────────

export type TrainingScoreSnapshot = {
  team0: number
  team1: number
}

export type TrainingBidVisibleState = {
  ownHand: ServerCard[]
  dealerSeat: Seat
  ownSeat: Seat
  scoreBeforeDeal: TrainingScoreSnapshot
  previousBids: TrainingCompactBidAction[]
  legalActions: TrainingCompactBidAction[]
}

export type TrainingCardVisibleState = {
  ownHand: ServerCard[]
  legalCards: ServerCard[]
  contract: TrainingFinalContract
  cardsPlayedBeforeAction: TrainingCompactPlayedCard[]
  currentTrick: TrainingCompactPlayedCard[]
  currentWinningSeat: Seat | null
  currentWinningCard: ServerCard | null
  dealerSeat: Seat
  leaderSeat: Seat
  scoreBeforeDeal: TrainingScoreSnapshot
}

// ─── Final contract ───────────────────────────────────────────────────────────

export type TrainingFinalContract = {
  bidderSeat: Seat
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: ServerSuit | null
  doubled: boolean
  redoubled: boolean
}

// ─── Bidding action ───────────────────────────────────────────────────────────

export type TrainingBiddingAction = {
  sequence: number
  timestamp: string
  seat: Seat
  actorKind: TrainingActorKind
  visibleBeforeAction: TrainingBidVisibleState
  chosenAction: TrainingCompactBidAction
}

// ─── Card action ─────────────────────────────────────────────────────────────

export type TrainingCardAction = {
  sequence: number
  timestamp: string
  trickIndex: number
  positionInTrick: number
  seat: Seat
  actorKind: TrainingActorKind
  visibleBeforeAction: TrainingCardVisibleState
  chosenCard: ServerCard
}

// ─── Trick result ─────────────────────────────────────────────────────────────

export type TrainingTrickPlay = {
  sequence: number
  seat: Seat
  card: ServerCard
}

export type TrainingTrickResult = {
  trickIndex: number
  leaderSeat: Seat
  plays: TrainingTrickPlay[]
  winnerSeat: Seat
  winningCard: ServerCard
  points: number
}

// ─── Seat metadata ────────────────────────────────────────────────────────────

export type TrainingSeatMetadata = {
  playerKey: string | null
  isBot: boolean
  isTakeover: boolean
}

// ─── Deal result ──────────────────────────────────────────────────────────────

export type TrainingDealResult = {
  bidderSeat: Seat
  bidderTeam: Team
  contractTeam: Team
  contract: TrainingFinalContract
  contractMade: boolean
  isCapot: boolean
  isTie: boolean
  pointsTeam0Raw: number
  pointsTeam1Raw: number
  pointsTeam0Official: number
  pointsTeam1Official: number
  outcomeLabel: string
  counterMultiplier: number
}

// ─── Integrity info ───────────────────────────────────────────────────────────

export type TrainingIntegrity = {
  initialCardCount: number
  playedCardCount: number
  uniqueInitialCardCount: number
  uniquePlayedCardCount: number
  valid: boolean
  violations: string[]
}

// ─── Full deal record ─────────────────────────────────────────────────────────

export type TrainingDealRecord = {
  schemaVersion: 1
  recordingId: string
  recordedAt: string

  roomKey: string
  dealIndex: number

  startedAt: string
  completedAt: string
  completed: true

  dealerSeat: Seat
  startingSeat: Seat

  scoreBeforeDeal: TrainingScoreSnapshot
  scoreAfterDeal: TrainingScoreSnapshot

  initialHands: Record<Seat, ServerCard[]>

  seats: Record<Seat, TrainingSeatMetadata>

  biddingActions: TrainingBiddingAction[]
  finalContract: TrainingFinalContract | null

  cardActions: TrainingCardAction[]
  tricks: TrainingTrickResult[]

  dealResult: TrainingDealResult

  integrity: TrainingIntegrity
}

// ─── Incomplete deal record (abandoned/disconnected) ─────────────────────────

export type TrainingIncompleteDealRecord = {
  schemaVersion: 1
  recordingId: string
  recordedAt: string

  roomKey: string
  dealIndex: number

  startedAt: string
  completedAt: string
  completed: false
  terminationReason: string
}

export type AnyTrainingRecord = TrainingDealRecord | TrainingIncompleteDealRecord

import { randomUUID } from 'node:crypto'
import type { Seat } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
} from '../game/serverGameTypes.js'
import { getServerTrickWinner } from '../game/getServerTrickWinner.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import { getValidServerBidActions } from '../game/getValidServerBidActions.js'
import { getServerCounterMultiplier } from '../game/serverScoring.js'
import type {
  TrainingActorKind,
  TrainingBiddingAction,
  TrainingCardAction,
  TrainingCompactBidAction,
  TrainingCompactPlayedCard,
  TrainingDealRecord,
  TrainingDealResult,
  TrainingFinalContract,
  TrainingSeatMetadata,
  TrainingTrickResult,
} from './trainingRecorderTypes.js'
import { validateTrainingRecord } from './trainingRecorderIntegrity.js'
import { computePlayerKey } from './trainingRecorderHash.js'

// ─── Seat profile extraction ──────────────────────────────────────────────────

type SeatProfileInfo = {
  profileId: string | null
  isBot: boolean
  isTakeover: boolean
}

function getSeatProfileInfo(
  room: { seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }> },
  seat: Seat,
  state: ServerAuthoritativeGameState,
): SeatProfileInfo {
  const participant = room.seats[seat]?.participant ?? null
  const isOriginalBot = participant?.kind === 'bot'
  const player = state.players[seat]
  const isTakeover = !isOriginalBot && (player?.controlledByBot ?? false)
  const profileId =
    participant !== null && 'identity' in participant
      ? (participant.identity.profileId ?? null)
      : null

  return {
    profileId,
    isBot: isOriginalBot,
    isTakeover,
  }
}

// ─── Actor kind determination ─────────────────────────────────────────────────

function determineActorKind(
  seat: Seat,
  state: ServerAuthoritativeGameState,
  wasTimedOut: boolean,
): TrainingActorKind {
  const player = state.players[seat]

  if (!player) return 'bot_original'

  if (player.mode === 'bot' && !player.controlledByBot) {
    return 'bot_original'
  }

  if (player.controlledByBot && player.mode !== 'bot') {
    // Human seat now controlled by bot
    return wasTimedOut ? 'bot_takeover' : 'bot_takeover'
  }

  if (player.mode === 'bot' && player.controlledByBot) {
    return 'bot_original'
  }

  // Human player
  return wasTimedOut ? 'human_timeout' : 'human_manual'
}

// ─── Bid action conversion ────────────────────────────────────────────────────

function toBidCompact(
  action: ServerAuthoritativeGameState['bidding']['entries'][number]['action'],
): TrainingCompactBidAction {
  return action as TrainingCompactBidAction
}

// ─── Legal bid actions list ───────────────────────────────────────────────────

function getLegalBidActions(
  seat: Seat,
  state: ServerAuthoritativeGameState,
): TrainingCompactBidAction[] {
  const valid = getValidServerBidActions(seat, state.bidding.winningBid)
  const result: TrainingCompactBidAction[] = []

  if (valid.pass) result.push({ type: 'pass' })
  if (valid.suits.clubs) result.push({ type: 'suit', suit: 'clubs' })
  if (valid.suits.diamonds) result.push({ type: 'suit', suit: 'diamonds' })
  if (valid.suits.hearts) result.push({ type: 'suit', suit: 'hearts' })
  if (valid.suits.spades) result.push({ type: 'suit', suit: 'spades' })
  if (valid.noTrumps) result.push({ type: 'no-trumps' })
  if (valid.allTrumps) result.push({ type: 'all-trumps' })
  if (valid.double) result.push({ type: 'double' })
  if (valid.redouble) result.push({ type: 'redouble' })

  return result
}

// ─── Trick scoring ────────────────────────────────────────────────────────────

function scoreTrick(
  trick: ServerCompletedTrick,
  state: ServerAuthoritativeGameState,
): number {
  const winningBid = state.bidding.winningBid
  if (!winningBid) return 0

  const isAllTrumps = winningBid.contract === 'all-trumps'
  const isNoTrumps = winningBid.contract === 'no-trumps'
  const trumpSuit = winningBid.trumpSuit

  function cardPoints(card: ServerCard): number {
    const r = card.rank

    if (isAllTrumps) {
      if (r === 'J') return 20
      if (r === '9') return 14
      if (r === 'A') return 11
      if (r === '10') return 10
      if (r === 'K') return 4
      if (r === 'Q') return 3
      return 0
    }

    if (!isNoTrumps && trumpSuit !== null && card.suit === trumpSuit) {
      if (r === 'J') return 20
      if (r === '9') return 14
      if (r === 'A') return 11
      if (r === '10') return 10
      if (r === 'K') return 4
      if (r === 'Q') return 3
      return 0
    }

    if (r === 'A') return 11
    if (r === '10') return 10
    if (r === 'K') return 4
    if (r === 'Q') return 3
    if (r === 'J') return 2
    return 0
  }

  const pts = trick.plays.reduce((sum, p) => sum + cardPoints(p.card), 0)
  return isNoTrumps ? pts * 2 : pts
}

// ─── Deal collector state ─────────────────────────────────────────────────────

type RoomLike = {
  id: string
  seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }>
}

type DealCollectorState = {
  recordingId: string
  roomKey: string
  dealIndex: number
  startedAt: string
  scoreBeforeDeal: { team0: number; team1: number }
  initialHands: Record<Seat, ServerCard[]>
  seats: Record<Seat, TrainingSeatMetadata>
  biddingActions: TrainingBiddingAction[]
  cardActions: TrainingCardAction[]
  cardSequence: number
  bidSequence: number
  playedCardsBefore: TrainingCompactPlayedCard[]
  finalContract: TrainingFinalContract | null
  finalized: boolean
}

// ─── Global per-room collector registry ──────────────────────────────────────

const activeDealStates = new Map<string, DealCollectorState>()
const finalizedRecordingIds = new Set<string>()

// Generate a stable recordingId from room + deal context
function makeRecordingId(roomId: string, dealIndex: number, dealerSeat: Seat | null): string {
  return `${roomId}::deal-${dealIndex}::dealer-${dealerSeat ?? 'unknown'}`
}

// ─── Public collector API ─────────────────────────────────────────────────────

export function collectorOnDealStart(
  room: RoomLike,
  state: ServerAuthoritativeGameState,
  dealIndex: number,
  hashSecret: string,
): void {
  const roomKey = room.id
  const key = `${roomKey}::${dealIndex}`

  // Check all 32 initial cards are dealt
  const allCards = (
    Object.values(state.hands) as ServerCard[][]
  ).flat()
  if (allCards.length !== 32) return

  const recordingId = makeRecordingId(roomKey, dealIndex, state.round.dealerSeat)

  if (finalizedRecordingIds.has(recordingId)) return

  const seats: Record<Seat, TrainingSeatMetadata> = {} as Record<Seat, TrainingSeatMetadata>
  for (const seat of ['bottom', 'right', 'top', 'left'] as Seat[]) {
    const info = getSeatProfileInfo(room, seat, state)
    seats[seat] = {
      playerKey: info.isBot ? null : computePlayerKey(hashSecret, info.profileId),
      isBot: info.isBot,
      isTakeover: info.isTakeover,
    }
  }

  const initialHands: Record<Seat, ServerCard[]> = {
    bottom: [...state.hands.bottom],
    right: [...state.hands.right],
    top: [...state.hands.top],
    left: [...state.hands.left],
  }

  activeDealStates.set(key, {
    recordingId,
    roomKey,
    dealIndex,
    startedAt: new Date().toISOString(),
    scoreBeforeDeal: {
      team0: state.score.match.teamA,
      team1: state.score.match.teamB,
    },
    initialHands,
    seats,
    biddingActions: [],
    cardActions: [],
    cardSequence: 0,
    bidSequence: 0,
    playedCardsBefore: [],
    finalContract: null,
    finalized: false,
  })
}

export function collectorOnBidAction(
  roomId: string,
  dealIndex: number,
  state: ServerAuthoritativeGameState,
  seat: Seat,
  wasTimedOut: boolean,
): void {
  const key = `${roomId}::${dealIndex}`
  const ds = activeDealStates.get(key)
  if (!ds || ds.finalized) return

  // The action was just applied — the LAST entry in bidding is the one we want
  const lastEntry = state.bidding.entries[state.bidding.entries.length - 1]
  if (!lastEntry || lastEntry.seat !== seat) return

  const previousBids = state.bidding.entries
    .slice(0, -1)
    .map((e) => toBidCompact(e.action))

  const actorKind = determineActorKind(seat, state, wasTimedOut)

  const action: TrainingBiddingAction = {
    sequence: ++ds.bidSequence,
    timestamp: new Date().toISOString(),
    seat,
    actorKind,
    visibleBeforeAction: {
      ownHand: [...ds.initialHands[seat]],
      dealerSeat: state.round.dealerSeat ?? 'bottom',
      ownSeat: seat,
      scoreBeforeDeal: ds.scoreBeforeDeal,
      previousBids,
      legalActions: getLegalBidActions(seat, {
        ...state,
        bidding: { ...state.bidding, entries: state.bidding.entries.slice(0, -1) },
      }),
    },
    chosenAction: toBidCompact(lastEntry.action),
  }

  ds.biddingActions.push(action)

  // Capture final contract after bidding ends
  if (state.bidding.hasEnded && state.bidding.winningBid !== null) {
    const wb = state.bidding.winningBid
    ds.finalContract = {
      bidderSeat: wb.seat,
      contract: wb.contract,
      trumpSuit: wb.trumpSuit,
      doubled: wb.doubled,
      redoubled: wb.redoubled,
    }
  }
}

export function collectorOnCardPlayed(
  roomId: string,
  dealIndex: number,
  stateBefore: ServerAuthoritativeGameState,
  stateAfter: ServerAuthoritativeGameState,
  seat: Seat,
  cardId: string,
  wasTimedOut: boolean,
): void {
  const key = `${roomId}::${dealIndex}`
  const ds = activeDealStates.get(key)
  if (!ds || ds.finalized) return

  const playing = stateBefore.playing
  if (!playing) return

  const card = ds.initialHands[seat].find((c) => c.id === cardId)
  if (!card) return

  const legalCards = getServerValidPlayCards(stateBefore, seat)
  const currentTrick: TrainingCompactPlayedCard[] = playing.currentTrick.plays.map((p, i) => ({
    sequence: ds.cardSequence - playing.currentTrick.plays.length + i,
    trickIndex: playing.currentTrick.trickIndex,
    positionInTrick: i,
    seat: p.seat,
    card: p.card,
  }))

  const winnerPlay =
    playing.currentTrick.plays.length > 0
      ? getServerTrickWinner(playing.currentTrick.plays, stateBefore.bidding.winningBid)
      : null

  const contract: TrainingFinalContract = ds.finalContract ?? {
    bidderSeat: stateBefore.bidding.winningBid?.seat ?? 'bottom',
    contract: stateBefore.bidding.winningBid?.contract ?? 'suit',
    trumpSuit: stateBefore.bidding.winningBid?.trumpSuit ?? null,
    doubled: stateBefore.bidding.winningBid?.doubled ?? false,
    redoubled: stateBefore.bidding.winningBid?.redoubled ?? false,
  }

  const actorKind = determineActorKind(seat, stateBefore, wasTimedOut)
  const trickIndex = playing.currentTrick.trickIndex
  const positionInTrick = playing.currentTrick.plays.length

  const action: TrainingCardAction = {
    sequence: ++ds.cardSequence,
    timestamp: new Date().toISOString(),
    trickIndex,
    positionInTrick,
    seat,
    actorKind,
    visibleBeforeAction: {
      ownHand: stateBefore.hands[seat].map((c) => ({ ...c })),
      legalCards: legalCards.map((c) => ({ ...c })),
      contract,
      cardsPlayedBeforeAction: [...ds.playedCardsBefore],
      currentTrick,
      currentWinningSeat: winnerPlay?.seat ?? null,
      currentWinningCard: winnerPlay?.card ?? null,
      dealerSeat: stateBefore.round.dealerSeat ?? 'bottom',
      leaderSeat: playing.currentTrick.leaderSeat ?? seat,
      scoreBeforeDeal: ds.scoreBeforeDeal,
    },
    chosenCard: { ...card },
  }

  ds.cardActions.push(action)

  // Record this card in the played sequence
  ds.playedCardsBefore.push({
    sequence: ds.cardSequence,
    trickIndex,
    positionInTrick,
    seat,
    card: { ...card },
  })

  // Update finalContract if it's now set
  if (ds.finalContract === null && stateBefore.bidding.winningBid !== null) {
    const wb = stateBefore.bidding.winningBid
    ds.finalContract = {
      bidderSeat: wb.seat,
      contract: wb.contract,
      trumpSuit: wb.trumpSuit,
      doubled: wb.doubled,
      redoubled: wb.redoubled,
    }
  }
}

export function collectorOnDealComplete(
  roomId: string,
  dealIndex: number,
  state: ServerAuthoritativeGameState,
): TrainingDealRecord | null {
  const key = `${roomId}::${dealIndex}`
  const ds = activeDealStates.get(key)
  if (!ds || ds.finalized) return null

  // Duplicate guard
  if (finalizedRecordingIds.has(ds.recordingId)) {
    ds.finalized = true
    activeDealStates.delete(key)
    return null
  }

  const scoring = state.scoring
  const playing = state.playing
  const winningBid = state.bidding.winningBid

  if (!scoring || !playing || !winningBid) return null

  // Build tricks from completedTricks
  const tricks: TrainingTrickResult[] = playing.completedTricks.map((trick) => {
    const winnerPlay = getServerTrickWinner(trick.plays, winningBid)
    const winnerSeat: Seat = winnerPlay?.seat ?? trick.winnerSeat
    const winningCard = winnerPlay?.card ?? trick.plays[trick.plays.length - 1]!.card

    return {
      trickIndex: trick.trickIndex,
      leaderSeat: trick.leaderSeat,
      plays: trick.plays.map((p, i) => ({
        sequence: i,
        seat: p.seat,
        card: { ...p.card },
      })),
      winnerSeat,
      winningCard: { ...winningCard },
      points: scoreTrick(trick, state),
    }
  })

  const finalContract: TrainingFinalContract = ds.finalContract ?? {
    bidderSeat: winningBid.seat,
    contract: winningBid.contract,
    trumpSuit: winningBid.trumpSuit,
    doubled: winningBid.doubled,
    redoubled: winningBid.redoubled,
  }

  const isMade = scoring.outcomeShortLabel === 'Изкарана'
  const isTie = scoring.outcomeShortLabel === 'Равна'
  const isCapot = scoring.isCapotRound

  const teamA = state.score.match.teamA
  const teamB = state.score.match.teamB

  const dealResult: TrainingDealResult = {
    bidderSeat: winningBid.seat,
    bidderTeam: winningBid.seat === 'bottom' || winningBid.seat === 'top' ? 'A' : 'B',
    contractTeam: winningBid.seat === 'bottom' || winningBid.seat === 'top' ? 'A' : 'B',
    contract: finalContract,
    contractMade: isMade,
    isCapot,
    isTie,
    pointsTeam0Raw: scoring.rawHandPoints.teamA,
    pointsTeam1Raw: scoring.rawHandPoints.teamB,
    pointsTeam0Official: scoring.officialRoundPoints.teamA,
    pointsTeam1Official: scoring.officialRoundPoints.teamB,
    outcomeLabel: scoring.outcomeLabel,
    counterMultiplier: getServerCounterMultiplier(winningBid),
  }

  const completedAt = new Date().toISOString()

  const record: TrainingDealRecord = {
    schemaVersion: 1,
    recordingId: ds.recordingId,
    recordedAt: completedAt,
    roomKey: ds.roomKey,
    dealIndex: ds.dealIndex,
    startedAt: ds.startedAt,
    completedAt,
    completed: true,
    dealerSeat: state.round.dealerSeat ?? 'bottom',
    startingSeat: state.round.firstDealSeat ?? 'bottom',
    scoreBeforeDeal: ds.scoreBeforeDeal,
    scoreAfterDeal: { team0: teamA, team1: teamB },
    initialHands: {
      bottom: ds.initialHands.bottom.map((c) => ({ ...c })),
      right: ds.initialHands.right.map((c) => ({ ...c })),
      top: ds.initialHands.top.map((c) => ({ ...c })),
      left: ds.initialHands.left.map((c) => ({ ...c })),
    },
    seats: { ...ds.seats },
    biddingActions: [...ds.biddingActions],
    finalContract,
    cardActions: [...ds.cardActions],
    tricks,
    dealResult,
    integrity: {
      initialCardCount: 0,
      playedCardCount: 0,
      uniqueInitialCardCount: 0,
      uniquePlayedCardCount: 0,
      valid: false,
      violations: [],
    },
  }

  // Run integrity check and attach
  const serialized = JSON.stringify(record)
  const integrity = validateTrainingRecord(record, serialized)
  record.integrity = integrity

  // Mark as finalized
  ds.finalized = true
  finalizedRecordingIds.add(ds.recordingId)
  activeDealStates.delete(key)

  // Prevent the finalizedRecordingIds set from growing forever (keep last 10k)
  if (finalizedRecordingIds.size > 10_000) {
    const toDelete = [...finalizedRecordingIds].slice(0, 1000)
    for (const id of toDelete) finalizedRecordingIds.delete(id)
  }

  return record
}

export function collectorDropDeal(roomId: string, dealIndex: number): void {
  const key = `${roomId}::${dealIndex}`
  activeDealStates.delete(key)
}

export function collectorGetActiveDealCount(): number {
  return activeDealStates.size
}

import { randomUUID, createHmac } from 'node:crypto'
import type { Seat } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidEntry,
  ServerCard,
} from '../game/serverGameTypes.js'
import { getServerTrickWinner } from '../game/getServerTrickWinner.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import { getValidServerBidActions } from '../game/getValidServerBidActions.js'
import { getServerCounterMultiplier, getServerTrickCardPoints } from '../game/serverScoring.js'
import type {
  TrainingActionOrigin,
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

// ─── Room key pseudonymization ────────────────────────────────────────────────

function pseudonymizeRoomId(hashSecret: string, roomId: string): string {
  return createHmac('sha256', hashSecret).update(roomId).digest('hex')
}

// ─── Actor kind determination ─────────────────────────────────────────────────
//
// actionOrigin = 'human_manual': voluntarily submitted by a live human.
// actionOrigin = 'auto': submitted by timer expiry or bot tick.
//   - If stateBefore.players[seat].controlledByBot is false but stateAfter has it true
//     → first timeout action for this human seat → human_timeout
//   - If stateBefore.players[seat].controlledByBot is already true AND seat mode is human
//     → subsequent bot takeover action → bot_takeover
//   - If seat.mode === 'bot' (original bot, never human)
//     → bot_original

function determineActorKind(
  seat: Seat,
  stateBefore: ServerAuthoritativeGameState,
  stateAfter: ServerAuthoritativeGameState,
  actionOrigin: TrainingActionOrigin,
): TrainingActorKind {
  const playerBefore = stateBefore.players[seat]
  const playerAfter = stateAfter.players[seat]

  // Original bot seat (participant.kind === 'bot', mode === 'bot')
  if (!playerBefore || playerBefore.mode === 'bot') return 'bot_original'

  // Human submitted voluntarily
  if (actionOrigin === 'human_manual') return 'human_manual'

  // Auto path: timer expiry or bot step
  // First takeover: was not controlled before, now is
  if (!playerBefore.controlledByBot && (playerAfter?.controlledByBot ?? false)) {
    return 'human_timeout'
  }

  // Subsequent auto actions for already-taken-over seat
  if (playerBefore.controlledByBot) {
    return 'bot_takeover'
  }

  // Fallback: human timed out but controlledByBot wasn't set (shouldn't happen)
  return 'human_timeout'
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

// ─── Deal collector state ─────────────────────────────────────────────────────

type RoomLike = {
  id: string
  seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }>
}

type DealCollectorState = {
  recordingId: string
  // Pseudonymized room key (HMAC of room.id) — never raw room ID
  roomKey: string
  // Recorder-owned per-room sequence number, metadata only — never derived
  // from match score, never used as a correlation key.
  dealIndex: number
  startedAt: string
  scoreBeforeDeal: { team0: number; team1: number }
  // 5 cards per seat at deal-next-2 → bidding
  handsAtBiddingStart: Record<Seat, ServerCard[]>
  // 8 cards per seat at deal-last-3 → playing (null until that transition fires)
  initialPlayingHands: Record<Seat, ServerCard[]> | null
  seats: Record<Seat, TrainingSeatMetadata>
  biddingActions: TrainingBiddingAction[]
  cardActions: TrainingCardAction[]
  cardSequence: number
  bidSequence: number
  playedCardsBefore: TrainingCompactPlayedCard[]
  finalContract: TrainingFinalContract | null
  finalized: boolean
  // Action-level dedup guard — see collectorOnBidAction / collectorOnCardPlayed.
  seenActionFingerprints: Set<string>
}

// ─── Global per-room collector registry ──────────────────────────────────────
//
// A room can have at most one active deal at a time — the map key is the
// raw roomId (used only in-process, never persisted; persisted records only
// ever carry the HMAC roomKey).

const activeDealStates = new Map<string, DealCollectorState>()
const dealSequenceByRoom = new Map<string, number>()
const finalizedRecordingIds = new Set<string>()

function nextDealSequence(roomId: string): number {
  const next = (dealSequenceByRoom.get(roomId) ?? 0) + 1
  dealSequenceByRoom.set(roomId, next)
  return next
}

// ─── Public collector API ─────────────────────────────────────────────────────

export type CollectorBiddingStartResult = 'started' | 'ignored_card_count' | 'replaced_stale'

// Called at deal-next-2 → bidding. Captures 5 cards per seat.
export function collectorOnBiddingStart(
  room: RoomLike,
  state: ServerAuthoritativeGameState,
  hashSecret: string,
): CollectorBiddingStartResult {
  // Each seat must have exactly 5 cards at this point
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const totalCards = seats.reduce((n, s) => n + (state.hands[s]?.length ?? 0), 0)
  if (totalCards !== 20) return 'ignored_card_count'

  const roomKey = pseudonymizeRoomId(hashSecret, room.id)
  const recordingId = randomUUID()
  const dealIndex = nextDealSequence(room.id)

  const existing = activeDealStates.get(room.id)
  const replacedStale = existing !== undefined && !existing.finalized

  const seatMeta: Record<Seat, TrainingSeatMetadata> = {} as Record<Seat, TrainingSeatMetadata>
  for (const seat of seats) {
    const info = getSeatProfileInfo(room, seat, state)
    seatMeta[seat] = {
      playerKey: info.isBot ? null : computePlayerKey(hashSecret, info.profileId),
      isBot: info.isBot,
      isTakeover: info.isTakeover,
    }
  }

  const handsAtBiddingStart: Record<Seat, ServerCard[]> = {
    bottom: [...state.hands.bottom],
    right: [...state.hands.right],
    top: [...state.hands.top],
    left: [...state.hands.left],
  }

  activeDealStates.set(room.id, {
    recordingId,
    roomKey,
    dealIndex,
    startedAt: new Date().toISOString(),
    scoreBeforeDeal: {
      team0: state.score.match.teamA,
      team1: state.score.match.teamB,
    },
    handsAtBiddingStart,
    initialPlayingHands: null,
    seats: seatMeta,
    biddingActions: [],
    cardActions: [],
    cardSequence: 0,
    bidSequence: 0,
    playedCardsBefore: [],
    finalContract: null,
    finalized: false,
    seenActionFingerprints: new Set(),
  })

  return replacedStale ? 'replaced_stale' : 'started'
}

// Called at deal-last-3 → playing. Captures 8 cards per seat.
export function collectorOnPlayingStart(
  roomId: string,
  state: ServerAuthoritativeGameState,
): void {
  const ds = activeDealStates.get(roomId)
  if (!ds || ds.finalized) return

  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  const totalCards = seats.reduce((n, s) => n + (state.hands[s]?.length ?? 0), 0)
  if (totalCards !== 32) return

  ds.initialPlayingHands = {
    bottom: [...state.hands.bottom],
    right: [...state.hands.right],
    top: [...state.hands.top],
    left: [...state.hands.left],
  }
}

export type CollectorActionResult = 'recorded' | 'duplicate' | 'no_active_deal'

function bidActionFingerprint(action: TrainingCompactBidAction): string {
  return action.type === 'suit' ? `suit:${action.suit}` : action.type
}

export function collectorOnBidAction(
  roomId: string,
  stateBefore: ServerAuthoritativeGameState,
  stateAfter: ServerAuthoritativeGameState,
  addedEntry: ServerBidEntry,
  actionOrigin: TrainingActionOrigin,
): CollectorActionResult {
  const ds = activeDealStates.get(roomId)
  if (!ds || ds.finalized) return 'no_active_deal'

  const seat = addedEntry.seat
  const entryCount = stateAfter.bidding.entries.length
  const chosenAction = toBidCompact(addedEntry.action)
  const fingerprint = `${ds.recordingId}:bid:${entryCount}:${seat}:${bidActionFingerprint(chosenAction)}`

  if (ds.seenActionFingerprints.has(fingerprint)) return 'duplicate'
  ds.seenActionFingerprints.add(fingerprint)

  // Build stateBefore-equivalent for legalActions: stateAfter without the last entry
  const stateBeforeForLegal: ServerAuthoritativeGameState = {
    ...stateAfter,
    bidding: {
      ...stateAfter.bidding,
      entries: stateAfter.bidding.entries.slice(0, -1),
      hasEnded: false,
      winningBid: stateBefore.bidding.winningBid,
    },
  }

  const previousBids = stateAfter.bidding.entries
    .slice(0, -1)
    .map((e) => toBidCompact(e.action))

  const actorKind = determineActorKind(seat, stateBefore, stateAfter, actionOrigin)

  const action: TrainingBiddingAction = {
    sequence: ++ds.bidSequence,
    timestamp: new Date().toISOString(),
    seat,
    actorKind,
    visibleBeforeAction: {
      ownHand: [...ds.handsAtBiddingStart[seat]],
      dealerSeat: stateAfter.round.dealerSeat ?? 'bottom',
      ownSeat: seat,
      scoreBeforeDeal: ds.scoreBeforeDeal,
      previousBids,
      legalActions: getLegalBidActions(seat, stateBeforeForLegal),
    },
    chosenAction,
  }

  ds.biddingActions.push(action)

  // Capture final contract after bidding ends
  if (stateAfter.bidding.hasEnded && stateAfter.bidding.winningBid !== null) {
    const wb = stateAfter.bidding.winningBid
    ds.finalContract = {
      bidderSeat: wb.seat,
      contract: wb.contract,
      trumpSuit: wb.trumpSuit,
      doubled: wb.doubled,
      redoubled: wb.redoubled,
    }
  }

  return 'recorded'
}

export function collectorOnCardPlayed(
  roomId: string,
  stateBefore: ServerAuthoritativeGameState,
  stateAfter: ServerAuthoritativeGameState,
  addedPlay: TrainingCompactPlayedCard,
  actionOrigin: TrainingActionOrigin,
): CollectorActionResult {
  const ds = activeDealStates.get(roomId)
  if (!ds || ds.finalized) return 'no_active_deal'

  const playing = stateBefore.playing
  if (!playing) return 'no_active_deal'

  const seat = addedPlay.seat
  const card = addedPlay.card
  const fingerprint = `${ds.recordingId}:card:${addedPlay.sequence}:${seat}:${card.id}`

  if (ds.seenActionFingerprints.has(fingerprint)) return 'duplicate'
  ds.seenActionFingerprints.add(fingerprint)

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

  const actorKind = determineActorKind(seat, stateBefore, stateAfter, actionOrigin)

  const action: TrainingCardAction = {
    sequence: ++ds.cardSequence,
    timestamp: new Date().toISOString(),
    trickIndex: addedPlay.trickIndex,
    positionInTrick: addedPlay.positionInTrick,
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

  ds.playedCardsBefore.push({
    sequence: ds.cardSequence,
    trickIndex: addedPlay.trickIndex,
    positionInTrick: addedPlay.positionInTrick,
    seat,
    card: { ...card },
  })

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

  return 'recorded'
}

export type CollectorDealCompleteResult =
  | { kind: 'enqueued'; record: TrainingDealRecord }
  | { kind: 'duplicate' }
  | { kind: 'no_active_deal' }
  | { kind: 'not_ready' }
  | { kind: 'invalid' }

export function collectorOnDealComplete(
  roomId: string,
  state: ServerAuthoritativeGameState,
): CollectorDealCompleteResult {
  const ds = activeDealStates.get(roomId)
  if (!ds || ds.finalized) return { kind: 'no_active_deal' }

  if (finalizedRecordingIds.has(ds.recordingId)) {
    ds.finalized = true
    activeDealStates.delete(roomId)
    return { kind: 'duplicate' }
  }

  const scoring = state.scoring
  const playing = state.playing
  const winningBid = state.bidding.winningBid

  if (!scoring || !playing || !winningBid) return { kind: 'not_ready' }

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
      // Canonical trick points — same helper used by gameplay scoring.
      points: getServerTrickCardPoints(trick, winningBid.contract, winningBid.trumpSuit),
    }
  })

  const finalContract: TrainingFinalContract = ds.finalContract ?? {
    bidderSeat: winningBid.seat,
    contract: winningBid.contract,
    trumpSuit: winningBid.trumpSuit,
    doubled: winningBid.doubled,
    redoubled: winningBid.redoubled,
  }

  // Semantic outcome from the scoring engine — no dependency on localized labels.
  const isTie = scoring.outcome === 'tie'
  const isInside = scoring.outcome === 'inside'
  const isMade = scoring.outcome === 'made'
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
    recordKind: 'full',
    dealerSeat: state.round.dealerSeat ?? 'bottom',
    startingSeat: state.round.firstDealSeat ?? 'bottom',
    scoreBeforeDeal: ds.scoreBeforeDeal,
    scoreAfterDeal: { team0: teamA, team1: teamB },
    handsAtBiddingStart: {
      bottom: ds.handsAtBiddingStart.bottom.map((c) => ({ ...c })),
      right: ds.handsAtBiddingStart.right.map((c) => ({ ...c })),
      top: ds.handsAtBiddingStart.top.map((c) => ({ ...c })),
      left: ds.handsAtBiddingStart.left.map((c) => ({ ...c })),
    },
    initialHands: ds.initialPlayingHands
      ? {
          bottom: ds.initialPlayingHands.bottom.map((c) => ({ ...c })),
          right: ds.initialPlayingHands.right.map((c) => ({ ...c })),
          top: ds.initialPlayingHands.top.map((c) => ({ ...c })),
          left: ds.initialPlayingHands.left.map((c) => ({ ...c })),
        }
      : null,
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

  const serialized = JSON.stringify(record)
  const integrity = validateTrainingRecord(record, serialized)
  record.integrity = integrity

  ds.finalized = true
  finalizedRecordingIds.add(ds.recordingId)
  activeDealStates.delete(roomId)

  if (finalizedRecordingIds.size > 10_000) {
    const toDelete = [...finalizedRecordingIds].slice(0, 1000)
    for (const id of toDelete) finalizedRecordingIds.delete(id)
  }

  return { kind: 'enqueued', record }
}

// Called on bidding → next-round (all pass). Writes a bidding_only record.
export function collectorOnAllPass(
  roomId: string,
  state: ServerAuthoritativeGameState,
): CollectorDealCompleteResult {
  const ds = activeDealStates.get(roomId)
  if (!ds || ds.finalized) return { kind: 'no_active_deal' }

  if (finalizedRecordingIds.has(ds.recordingId)) {
    ds.finalized = true
    activeDealStates.delete(roomId)
    return { kind: 'duplicate' }
  }

  const completedAt = new Date().toISOString()

  const teamA = state.score.match.teamA
  const teamB = state.score.match.teamB

  const record: TrainingDealRecord = {
    schemaVersion: 1,
    recordingId: ds.recordingId,
    recordedAt: completedAt,
    roomKey: ds.roomKey,
    dealIndex: ds.dealIndex,
    startedAt: ds.startedAt,
    completedAt,
    completed: true,
    recordKind: 'bidding_only',
    dealerSeat: state.round.dealerSeat ?? 'bottom',
    startingSeat: state.round.firstDealSeat ?? 'bottom',
    scoreBeforeDeal: ds.scoreBeforeDeal,
    scoreAfterDeal: { team0: teamA, team1: teamB },
    handsAtBiddingStart: {
      bottom: ds.handsAtBiddingStart.bottom.map((c) => ({ ...c })),
      right: ds.handsAtBiddingStart.right.map((c) => ({ ...c })),
      top: ds.handsAtBiddingStart.top.map((c) => ({ ...c })),
      left: ds.handsAtBiddingStart.left.map((c) => ({ ...c })),
    },
    initialHands: null,
    seats: { ...ds.seats },
    biddingActions: [...ds.biddingActions],
    finalContract: null,
    cardActions: [],
    tricks: [],
    dealResult: null,
    integrity: {
      initialCardCount: 0,
      playedCardCount: 0,
      uniqueInitialCardCount: 0,
      uniquePlayedCardCount: 0,
      valid: false,
      violations: [],
    },
  }

  const serialized = JSON.stringify(record)
  const integrity = validateTrainingRecord(record, serialized)
  record.integrity = integrity

  ds.finalized = true
  finalizedRecordingIds.add(ds.recordingId)
  activeDealStates.delete(roomId)

  if (finalizedRecordingIds.size > 10_000) {
    const toDelete = [...finalizedRecordingIds].slice(0, 1000)
    for (const id of toDelete) finalizedRecordingIds.delete(id)
  }

  return { kind: 'enqueued', record }
}

export function collectorDropDeal(roomId: string): void {
  activeDealStates.delete(roomId)
}

export function collectorGetActiveDealCount(): number {
  return activeDealStates.size
}

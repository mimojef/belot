import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../core/serverTypes.js'
import { getValidServerBidActions } from '../game/getValidServerBidActions.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import {
  getDisplayNameFromIdentity,
  type RoomBiddingSnapshot,
  type RoomCardSnapshot,
  type RoomCompletedTrickSnapshot,
  type RoomDeclarationSnapshot,
  type RoomGameSnapshot,
  type RoomMatchEndedSnapshot,
  type RoomPlayingSnapshot,
  type RoomScoringSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type RoomTeamPointsSnapshot,
} from './messageTypes.js'

function createSeatSnapshot(room: ServerRoom, seat: Seat): RoomSeatSnapshot {
  const participant = room.seats[seat].participant
  const authoritativeState = room.game.authoritativeState
  const isAuthoritativeState =
    authoritativeState !== null && !('kind' in authoritativeState)

  if (participant === null) {
    return {
      seat,
      displayName: 'Празно място',
      isOccupied: false,
      isBot: false,
      isControlledByBot: false,
      isConnected: false,
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
      gender: null,
    }
  }

  return {
    seat,
    displayName: getDisplayNameFromIdentity(participant.identity),
    isOccupied: true,
    isBot: participant.kind === 'bot',
    isControlledByBot:
      participant.kind !== 'bot' && isAuthoritativeState
        ? authoritativeState.players[seat]?.controlledByBot ?? false
        : false,
    isConnected: participant.kind === 'bot' ? true : participant.isConnected,
    avatarUrl: participant.identity.avatarUrl,
    level: participant.identity.level,
    rankTitle: participant.identity.rankTitle,
    skillRating: participant.identity.skillRating,
    gender: participant.identity.gender ?? participant.publicProfile?.gender ?? null,
  }
}

function getReconnectTokenForSeat(
  room: ServerRoom,
  yourSeat: Seat | null,
): string | null {
  if (yourSeat === null) {
    return null
  }

  const participant = room.seats[yourSeat].participant

  if (participant === null || participant.kind !== 'human') {
    return null
  }

  return participant.reconnectToken
}

function isAuthoritativeGameState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && !('kind' in value)
}

function createCardSnapshot(card: ServerAuthoritativeGameState['deck'][number]): RoomCardSnapshot {
  return {
    id: card.id,
    suit: card.suit,
    rank: card.rank,
  }
}

function createDeclarationSnapshot(
  declaration: ServerAuthoritativeGameState['declarations'][number],
): RoomDeclarationSnapshot {
  return {
    seat: declaration.seat,
    team: declaration.team,
    type: declaration.type,
    publicLabel: declaration.publicLabel,
    points: declaration.points,
    cards: declaration.cards.map(createCardSnapshot),
    cardIds: declaration.cardIds,
    suit: declaration.suit,
    highRank: declaration.highRank,
    declaredAtTrickIndex: declaration.declaredAtTrickIndex,
    announced: declaration.announced,
    valid: declaration.valid,
  }
}

function createTeamPointsSnapshot(score: {
  teamA: number
  teamB: number
}): RoomTeamPointsSnapshot {
  return {
    teamA: score.teamA,
    teamB: score.teamB,
  }
}

function createBiddingSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  yourSeat: Seat | null,
): RoomBiddingSnapshot | null {
  const shouldExposeBiddingSnapshot =
    authoritativeState.phase === 'bidding' ||
    (authoritativeState.phase === 'deal-last-3' && authoritativeState.bidding.hasEnded) ||
    (authoritativeState.phase === 'next-round' &&
      authoritativeState.bidding.hasEnded &&
      authoritativeState.bidding.winningBid === null)

  if (!shouldExposeBiddingSnapshot) {
    return null
  }

  const { bidding } = authoritativeState
  const canSubmitBid = yourSeat !== null && bidding.currentSeat === yourSeat

  let validActions: RoomBiddingSnapshot['validActions'] = null
  if (canSubmitBid && yourSeat !== null) {
    const v = getValidServerBidActions(yourSeat, bidding.winningBid)
    validActions = {
      pass: v.pass,
      suits: v.suits,
      noTrumps: v.noTrumps,
      allTrumps: v.allTrumps,
      double: v.double,
      redouble: v.redouble,
    }
  }

  return {
    currentBidderSeat: bidding.currentSeat,
    canSubmitBid,
    entries: bidding.entries.map((e) => ({ seat: e.seat, action: e.action })),
    winningBid: bidding.winningBid ?? null,
    validActions,
  }
}

function createPlayingSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  yourSeat: Seat | null,
): RoomPlayingSnapshot | null {
  if (authoritativeState.phase !== 'playing') {
    return null
  }

  const playing = authoritativeState.playing
  if (!playing?.hasStarted) {
    return null
  }

  const currentTrickPlays =
    playing.currentTrick?.plays.map((p) => ({
      seat: p.seat,
      card: createCardSnapshot(p.card),
    })) ?? []

  const isMyTurn = yourSeat !== null && playing.currentTurnSeat === yourSeat
  const validCardIds = isMyTurn
    ? getServerValidPlayCards(authoritativeState, yourSeat).map((c) => c.id)
    : null
  const latestCompletedTrick: RoomCompletedTrickSnapshot | null =
    playing.completedTricks.length > 0
      ? {
          trickIndex: playing.completedTricks[playing.completedTricks.length - 1]!.trickIndex,
          leaderSeat: playing.completedTricks[playing.completedTricks.length - 1]!.leaderSeat,
          plays: playing.completedTricks[playing.completedTricks.length - 1]!.plays.map((play) => ({
            seat: play.seat,
            card: createCardSnapshot(play.card),
          })),
          winnerSeat: playing.completedTricks[playing.completedTricks.length - 1]!.winnerSeat,
        }
      : null

  return {
    winningBid: authoritativeState.bidding.winningBid ?? null,
    currentTurnSeat: playing.currentTurnSeat,
    currentTrickPlays,
    completedTricksCount: playing.completedTricks.length,
    latestCompletedTrick,
    validCardIds,
  }
}

function createScoringSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
): RoomScoringSnapshot | null {
  const scoring = authoritativeState.scoring

  if (scoring === null) {
    return null
  }

  return {
    winningBid: {
      ...scoring.winningBid,
    },
    rawHandPoints: createTeamPointsSnapshot(scoring.rawHandPoints),
    rawHandTricksWon: createTeamPointsSnapshot(scoring.rawHandTricksWon),
    declarationPoints: createTeamPointsSnapshot(scoring.declarationPoints),
    belotePoints: createTeamPointsSnapshot(scoring.belotePoints),
    sumPoints: createTeamPointsSnapshot(scoring.sumPoints),
    officialRoundPoints: createTeamPointsSnapshot(scoring.officialRoundPoints),
    matchTotals: createTeamPointsSnapshot(scoring.matchTotals),
    carryOver: createTeamPointsSnapshot(scoring.carryOver),
    isCapotRound: scoring.isCapotRound,
    isNonCapotRound: scoring.isNonCapotRound,
    outcomeLabel: scoring.outcomeLabel,
    outcomeShortLabel: scoring.outcomeShortLabel,
    counterMultiplier: scoring.counterMultiplier,
  }
}

function createMatchEndedSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  replayVotes: import('../core/serverTypes.js').Seat[],
  leaveVotes: import('../core/serverTypes.js').Seat[],
  awardedPrizePerSeat: Partial<Record<import('../core/serverTypes.js').Seat, number>> | undefined,
  yourSeat: import('../core/serverTypes.js').Seat | null,
): RoomMatchEndedSnapshot | null {
  const matchEnded = authoritativeState.matchEnded

  if (matchEnded === null) {
    return null
  }

  const awardedPrizeAmount =
    yourSeat !== null ? (awardedPrizePerSeat?.[yourSeat] ?? null) : null

  return {
    winnerTeam: matchEnded.winnerTeam,
    targetScore: matchEnded.targetScore,
    finalScore: createTeamPointsSnapshot(matchEnded.finalScore),
    endedAt: matchEnded.endedAt,
    replayVotes,
    leaveVotes,
    awardedPrizeAmount,
  }
}

function createGameSnapshot(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomGameSnapshot | null {
  const authoritativeState = room.game.authoritativeState

  if (!isAuthoritativeGameState(authoritativeState)) {
    return null
  }

  const phase = authoritativeState.phase
  const includeCuttingSnapshot =
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3'

  return {
    phase: room.game.phase,
    authoritativePhase: phase,
    timerDeadlineAt: room.game.timerDeadlineAt,
    dealerSeat: authoritativeState.round.dealerSeat,
    firstDealSeat: authoritativeState.round.firstDealSeat,
    cutting: includeCuttingSnapshot
      ? {
          cutterSeat: authoritativeState.round.cutterSeat,
          selectedCutIndex: authoritativeState.round.selectedCutIndex,
          deckCount: authoritativeState.deck.length,
          canSubmitCut:
            yourSeat !== null &&
            yourSeat === authoritativeState.round.cutterSeat &&
            phase === 'cutting' &&
            authoritativeState.round.selectedCutIndex === null,
        }
      : null,
    bidding: createBiddingSnapshot(authoritativeState, yourSeat),
    playing: createPlayingSnapshot(authoritativeState, yourSeat),
    scoring: createScoringSnapshot(authoritativeState),
    matchEnded: createMatchEndedSnapshot(authoritativeState, room.replayVotes ?? [], room.leaveVotes ?? [], room.awardedPrizePerSeat, yourSeat),
    declarations: authoritativeState.declarations.map(createDeclarationSnapshot),
    score: {
      match: createTeamPointsSnapshot(authoritativeState.score.match),
    },
    handCounts: {
      bottom: authoritativeState.hands.bottom.length,
      right: authoritativeState.hands.right.length,
      top: authoritativeState.hands.top.length,
      left: authoritativeState.hands.left.length,
    },
    ownHand:
      yourSeat !== null
        ? authoritativeState.hands[yourSeat].map(createCardSnapshot)
        : [],
  }
}

export function createRoomSnapshotMessage(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomSnapshotMessage {
  return {
    type: 'room_snapshot',
    roomId: room.id,
    roomStatus: room.status,
    yourSeat,
    reconnectToken: getReconnectTokenForSeat(room, yourSeat),
    seats: SERVER_SEAT_ORDER.map((seat) => createSeatSnapshot(room, seat)),
    game: createGameSnapshot(room, yourSeat),
    stakeAmount: room.config.stakeAmount ?? null,
    isGuestTrial: room.config.isGuestTrial === true,
    isPrivateTableOrigin: room.config.isPrivateTableOrigin === true,
    isTournamentMatchOrigin: room.config.isTournamentMatchOrigin === true,
    tournamentId: room.config.tournamentId ?? null,
    tournamentMatchId: room.config.tournamentMatchId ?? null,
    tournamentRoundType: room.config.tournamentRoundType ?? null,
    tournamentAttendance: room.config.tournamentAttendance ?? null,
    tournamentBotReplacements: room.config.tournamentBotReplacements ?? [],
    tournamentBanners: room.config.tournamentBanners ?? [],
  }
}

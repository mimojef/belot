import type { Seat, ServerRoom } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { findAddedPlayedCard } from './gameplayActionDiff.js'

// Always-on, lightweight structured logging for card-play provenance.
// Written to stdout with a stable `[gameplay-audit]` prefix so it flows into
// the existing PM2 log capture used for every other server log line, without
// introducing a new storage system or retention mechanism. Never throws into
// gameplay.

function getAuthState(room: ServerRoom): ServerAuthoritativeGameState | null {
  const state = room.game.authoritativeState
  if (state === null || typeof state !== 'object' || !('phase' in state)) {
    return null
  }
  return state as ServerAuthoritativeGameState
}

export type GameplayActionSource =
  | 'human_manual'
  | 'human_timeout_auto'
  | 'bot_original'
  | 'bot_takeover'

function classifyActionSource(
  seat: Seat,
  stateBefore: ServerAuthoritativeGameState,
  isHumanManualSubmission: boolean,
): GameplayActionSource {
  const playerBefore = stateBefore.players[seat]

  if (!playerBefore || playerBefore.mode === 'bot') {
    return 'bot_original'
  }

  if (isHumanManualSubmission) {
    return 'human_manual'
  }

  return playerBefore.controlledByBot ? 'bot_takeover' : 'human_timeout_auto'
}

export function logAcceptedCardPlayAudit(options: {
  previousRoom: ServerRoom
  nextRoom: ServerRoom
  isHumanManualSubmission: boolean
  connectionId: string | null
}): void {
  try {
    const prevState = getAuthState(options.previousRoom)
    const nextState = getAuthState(options.nextRoom)

    if (prevState === null || nextState === null || prevState.phase !== 'playing') {
      return
    }

    const diff = findAddedPlayedCard(prevState, nextState)

    if (diff.kind !== 'added') {
      return
    }

    const { seat, card } = diff.play
    const seatSlot = options.nextRoom.seats[seat]
    const participant = seatSlot.participant
    const profileId = participant !== null && participant.kind === 'human'
      ? participant.identity.profileId
      : null

    console.log('[gameplay-audit]', JSON.stringify({
      event: 'card_play_accepted',
      roomId: options.nextRoom.id,
      seat,
      profileId,
      cardId: card.id,
      suit: card.suit,
      rank: card.rank,
      trickIndex: diff.play.trickIndex,
      positionInTrick: diff.play.positionInTrick,
      actionSource: classifyActionSource(seat, prevState, options.isHumanManualSubmission),
      wasControlledByBotBeforeAction: prevState.players[seat]?.controlledByBot ?? false,
      contract: prevState.bidding.winningBid?.contract ?? null,
      trumpSuit: prevState.bidding.winningBid?.trumpSuit ?? null,
      turnDeadlineAtBeforeAction: prevState.timer?.expiresAt ?? null,
      connectionId: options.connectionId,
      serverTimestamp: new Date().toISOString(),
    }))
  } catch {
    // Audit logging must never affect gameplay.
  }
}

export function logRejectedGameplayAction(options: {
  actionType: 'submit_play_card' | 'submit_bid_action' | 'submit_cut_index'
  roomId: string | null
  seat: Seat | null
  cardId?: string | null
  connectionId: string
  connectionStatus: string
  reason: string
}): void {
  try {
    console.log('[gameplay-audit]', JSON.stringify({
      event: 'gameplay_action_rejected',
      actionType: options.actionType,
      roomId: options.roomId,
      seat: options.seat,
      cardId: options.cardId ?? null,
      connectionId: options.connectionId,
      connectionStatus: options.connectionStatus,
      reason: options.reason,
      serverTimestamp: new Date().toISOString(),
    }))
  } catch {
    // Audit logging must never affect gameplay.
  }
}

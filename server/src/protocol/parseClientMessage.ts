import {
  SUPPORTED_MATCH_STAKES,
  type MatchStake,
} from '../matchmaking/matchmakingTypes.js'
import { SERVER_SEAT_ORDER, type Seat } from '../core/serverTypes.js'
import type { ClientBidAction, ClientMessage } from './messageTypes.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeOptionalDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return undefined
  }

  return trimmed
}

function normalizeRequiredText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()

  if (trimmed.length === 0) {
    return null
  }

  return trimmed
}

function isSupportedStake(value: unknown): value is MatchStake {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    SUPPORTED_MATCH_STAKES.includes(value as MatchStake)
  )
}

function isSeat(value: unknown): value is Seat {
  return typeof value === 'string' && SERVER_SEAT_ORDER.includes(value as Seat)
}

function isBidSuit(
  value: unknown,
): value is 'clubs' | 'diamonds' | 'hearts' | 'spades' {
  return (
    value === 'clubs' ||
    value === 'diamonds' ||
    value === 'hearts' ||
    value === 'spades'
  )
}

function normalizeBidAction(value: unknown): ClientBidAction | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null
  }

  if (value.type === 'pass') {
    return { type: 'pass' }
  }

  if (value.type === 'no-trumps') {
    return { type: 'no-trumps' }
  }

  if (value.type === 'all-trumps') {
    return { type: 'all-trumps' }
  }

  if (value.type === 'double') {
    return { type: 'double' }
  }

  if (value.type === 'redouble') {
    return { type: 'redouble' }
  }

  if (value.type === 'suit' && isBidSuit(value.suit)) {
    return {
      type: 'suit',
      suit: value.suit,
    }
  }

  return null
}

function normalizeCutIndex(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null
  }

  if (value < 0 || value > 31) {
    return null
  }

  return value
}

export function parseClientMessage(rawText: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(rawText) as unknown

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return null
    }

    if (parsed.type === 'ping') {
      return { type: 'ping' }
    }

    if (parsed.type === 'create_room') {
      return {
        type: 'create_room',
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (parsed.type === 'join_room') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      return {
        type: 'join_room',
        roomId,
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (
      parsed.type === 'join_matchmaking' ||
      parsed.type === 'enter_matchmaking' ||
      parsed.type === 'find_match'
    ) {
      if (!isSupportedStake(parsed.stake)) {
        return null
      }

      return {
        type: 'join_matchmaking',
        stake: parsed.stake,
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (
      parsed.type === 'leave_matchmaking' ||
      parsed.type === 'cancel_matchmaking' ||
      parsed.type === 'stop_matchmaking'
    ) {
      return {
        type: 'leave_matchmaking',
      }
    }

    if (parsed.type === 'request_player_profile') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      if (!isSeat(parsed.seat)) {
        return null
      }

      return {
        type: 'request_player_profile',
        roomId,
        seat: parsed.seat,
      }
    }

    if (parsed.type === 'resume_room') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const reconnectToken = normalizeRequiredText(parsed.reconnectToken)

      if (roomId === null || reconnectToken === null) {
        return null
      }

      return {
        type: 'resume_room',
        roomId,
        reconnectToken,
      }
    }

    if (parsed.type === 'leave_active_room') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      return {
        type: 'leave_active_room',
        roomId,
      }
    }

    if (parsed.type === 'submit_bid_action') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const action = normalizeBidAction(parsed.action)

      if (roomId === null || action === null) {
        return null
      }

      return {
        type: 'submit_bid_action',
        roomId,
        action,
      }
    }

    if (parsed.type === 'submit_cut_index') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const cutIndex = normalizeCutIndex(parsed.cutIndex)

      if (roomId === null || cutIndex === null) {
        return null
      }

      return {
        type: 'submit_cut_index',
        roomId,
        cutIndex,
      }
    }

    if (parsed.type === 'submit_play_card') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const cardId = normalizeRequiredText(parsed.cardId)

      if (roomId === null || cardId === null) {
        return null
      }

      return {
        type: 'submit_play_card',
        roomId,
        cardId,
      }
    }

    if (parsed.type === 'resume_human_control') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      return {
        type: 'resume_human_control',
        roomId,
      }
    }

    return null
  } catch {
    return null
  }
}

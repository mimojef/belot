import {
  SUPPORTED_MATCH_STAKES,
  type MatchStake,
} from '../matchmaking/matchmakingTypes.js'
import type { ClientMessage } from './messageTypes.js'

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

function isSupportedStake(value: unknown): value is MatchStake {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    SUPPORTED_MATCH_STAKES.includes(value as MatchStake)
  )
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
      if (typeof parsed.roomId !== 'string') {
        return null
      }

      const roomId = parsed.roomId.trim()

      if (roomId.length === 0) {
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

    return null
  } catch {
    return null
  }
}
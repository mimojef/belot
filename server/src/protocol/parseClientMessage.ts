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

function normalizeDeclarationKeys(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, 8)
}

function normalizePartnerRatingValue(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null
  }

  if (value < 1 || value > 6) {
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

    if (parsed.type === 'join_guest_trial') {
      if (typeof parsed.stake !== 'number' || !Number.isInteger(parsed.stake)) {
        return null
      }

      return {
        type: 'join_guest_trial',
        stake: parsed.stake,
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
        acceptPenalty: parsed.acceptPenalty === true,
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
      const declarationKeys = normalizeDeclarationKeys(parsed.declarationKeys)

      if (roomId === null || cardId === null) {
        return null
      }

      return {
        type: 'submit_play_card',
        roomId,
        cardId,
        declarationKeys,
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

    if (parsed.type === 'submit_partner_rating') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const ratingValue = normalizePartnerRatingValue(parsed.ratingValue)

      if (roomId === null || ratingValue === null) {
        return null
      }

      return {
        type: 'submit_partner_rating',
        roomId,
        ratingValue,
      }
    }

    if (parsed.type === 'request_replay') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      return {
        type: 'request_replay',
        roomId,
      }
    }

    if (parsed.type === 'request_leave_match') {
      const roomId = normalizeRequiredText(parsed.roomId)

      if (roomId === null) {
        return null
      }

      return {
        type: 'request_leave_match',
        roomId,
      }
    }

    if (parsed.type === 'send_emoji_reaction') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const emojiId = normalizeRequiredText(parsed.emojiId)

      if (roomId === null || emojiId === null) {
        return null
      }

      if (!/^(?:0[1-9]|1[0-9]|2[0-4])$/.test(emojiId)) {
        return null
      }

      return {
        type: 'send_emoji_reaction',
        roomId,
        emojiId,
      }
    }

    if (parsed.type === 'send_phrase_reaction') {
      const roomId = normalizeRequiredText(parsed.roomId)
      const phraseId = normalizeRequiredText(parsed.phraseId)

      if (roomId === null || phraseId === null) {
        return null
      }

      if (!/^phrase_(?:0[1-9]|1[0-9]|2[0-4])$/.test(phraseId)) {
        return null
      }

      return {
        type: 'send_phrase_reaction',
        roomId,
        phraseId,
      }
    }

    if (parsed.type === 'request_private_rooms_list') {
      return { type: 'request_private_rooms_list' }
    }

    if (parsed.type === 'create_private_room') {
      if (!isSupportedStake(parsed.stake)) {
        return null
      }

      return {
        type: 'create_private_room',
        stake: parsed.stake,
        isLocked: parsed.isLocked === true,
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (parsed.type === 'join_private_room') {
      const privateRoomId = normalizeRequiredText(parsed.privateRoomId)

      if (privateRoomId === null) {
        return null
      }

      return {
        type: 'join_private_room',
        privateRoomId,
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (parsed.type === 'leave_private_room') {
      return { type: 'leave_private_room' }
    }

    if (parsed.type === 'invite_to_private_room') {
      if (!Array.isArray(parsed.toProfiles)) return null
      const toProfiles: Array<{ profileId: string; displayName: string }> = []
      for (const item of parsed.toProfiles) {
        const profileId = normalizeRequiredText(item?.profileId)
        const displayName = normalizeRequiredText(item?.displayName)
        if (profileId === null || displayName === null) return null
        toProfiles.push({ profileId, displayName })
      }
      if (toProfiles.length === 0) return null
      return { type: 'invite_to_private_room', toProfiles }
    }

    if (parsed.type === 'cancel_private_room_invite') {
      const inviteId = normalizeRequiredText(parsed.inviteId)
      if (inviteId === null) return null
      return { type: 'cancel_private_room_invite', inviteId }
    }

    if (parsed.type === 'respond_private_room_invite') {
      const inviteId = normalizeRequiredText(parsed.inviteId)

      if (inviteId === null) {
        return null
      }

      return {
        type: 'respond_private_room_invite',
        inviteId,
        accept: parsed.accept === true,
      }
    }

    return null
  } catch {
    return null
  }
}

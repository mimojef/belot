import {
  SUPPORTED_MATCH_STAKES,
  type MatchStake,
} from '../matchmaking/matchmakingTypes.js'
import { SERVER_SEAT_ORDER, type Seat } from '../core/serverTypes.js'
import type { ClientBidAction, ClientMessage, PrivateRoomWaitMinutes } from './messageTypes.js'

const ALLOWED_PRIVATE_ROOM_WAIT_MINUTES: readonly PrivateRoomWaitMinutes[] = [5, 10, 15, 30]
const DEFAULT_PRIVATE_ROOM_WAIT_MINUTES: PrivateRoomWaitMinutes = 15

// Returns the normalized value if `value` is missing (undefined), the exact
// default if `value` is present but invalid signals a parse failure so the
// whole message is rejected — a legacy client omitting the field is fine, but
// a client (or attacker) sending a bogus value is not silently coerced.
function parsePrivateRoomWaitMinutes(value: unknown): PrivateRoomWaitMinutes | null {
  if (value === undefined) {
    return DEFAULT_PRIVATE_ROOM_WAIT_MINUTES
  }

  if (typeof value === 'number' && (ALLOWED_PRIVATE_ROOM_WAIT_MINUTES as readonly number[]).includes(value)) {
    return value as PrivateRoomWaitMinutes
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePrivateRoomTeam(value: unknown): 'A' | 'B' | null {
  return value === 'A' || value === 'B' ? value : null
}

function parsePrivateRoomSlotIndex(value: unknown): 0 | 1 | null {
  return value === 0 || value === 1 ? value : null
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

// create_private_room намерено допуска всяко положително цяло число тук —
// само формата се проверява. Дали залогът реално е конфигуриран/активен/
// покрит от баланс и ниво се решава от checkPrivateRoomStakeEligibility в
// index.ts, за да може клиентът да получи структуриран error code (напр.
// private_room_stake_unavailable) вместо генеричен "Invalid message payload".
function isPositiveIntegerStake(value: unknown): value is MatchStake {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
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

    if (parsed.type === 'request_private_games_list') {
      return { type: 'request_private_games_list' }
    }

    if (parsed.type === 'create_private_room') {
      if (!isPositiveIntegerStake(parsed.stake)) {
        return null
      }

      const waitMinutes = parsePrivateRoomWaitMinutes(parsed.waitMinutes)
      if (waitMinutes === null) {
        return null
      }

      return {
        type: 'create_private_room',
        stake: parsed.stake,
        isLocked: parsed.isLocked === true,
        waitMinutes,
        displayName: normalizeOptionalDisplayName(parsed.displayName),
      }
    }

    if (parsed.type === 'join_private_room') {
      const privateRoomId = normalizeRequiredText(parsed.privateRoomId)
      const team = parsePrivateRoomTeam(parsed.team)
      const slotIndex = parsePrivateRoomSlotIndex(parsed.slotIndex)

      if (privateRoomId === null || team === null || slotIndex === null) {
        return null
      }

      return {
        type: 'join_private_room',
        privateRoomId,
        team,
        slotIndex,
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

    if (parsed.type === 'add_bot_to_private_room_team') {
      const team = parsePrivateRoomTeam(parsed.team)
      if (team === null) return null
      return { type: 'add_bot_to_private_room_team', team }
    }

    if (parsed.type === 'remove_bot_from_private_room_team') {
      const team = parsePrivateRoomTeam(parsed.team)
      if (team === null) return null
      return { type: 'remove_bot_from_private_room_team', team }
    }

    if (parsed.type === 'subscribe_private_room_chat') {
      const privateRoomId = normalizeRequiredText(parsed.privateRoomId)
      if (privateRoomId === null) return null
      return { type: 'subscribe_private_room_chat', privateRoomId }
    }

    if (parsed.type === 'unsubscribe_private_room_chat') {
      const privateRoomId = normalizeRequiredText(parsed.privateRoomId)
      if (privateRoomId === null) return null
      return { type: 'unsubscribe_private_room_chat', privateRoomId }
    }

    if (parsed.type === 'send_private_room_chat_message') {
      // Само структурна проверка — семантичната валидация (дължина,
      // забранени символи, членство, rate limit) е в index.ts, за да върне
      // конкретен `private_room_chat_error.code` + requestId.
      const privateRoomId = normalizeRequiredText(parsed.privateRoomId)
      if (privateRoomId === null || typeof parsed.body !== 'string') return null

      const requestId = typeof parsed.requestId === 'string' && parsed.requestId.trim() !== ''
        ? parsed.requestId.trim().slice(0, 100)
        : undefined

      return {
        type: 'send_private_room_chat_message',
        privateRoomId,
        body: parsed.body,
        ...(requestId !== undefined ? { requestId } : {}),
      }
    }

    if (parsed.type === 'subscribe_lobby_chat') {
      return { type: 'subscribe_lobby_chat' }
    }

    if (parsed.type === 'unsubscribe_lobby_chat') {
      return { type: 'unsubscribe_lobby_chat' }
    }

    if (parsed.type === 'send_lobby_chat_message') {
      // Само структурна проверка (тип на полето) — семантичните правила
      // (дължина в Unicode code points, забранени символи, rate limit)
      // се прилагат в index.ts, за да могат да върнат конкретен
      // `lobby_chat_error.code` + requestId, а не generic parse failure.
      if (typeof parsed.body !== 'string') {
        return null
      }

      const requestId = typeof parsed.requestId === 'string' && parsed.requestId.trim() !== ''
        ? parsed.requestId.trim().slice(0, 100)
        : undefined

      return {
        type: 'send_lobby_chat_message',
        body: parsed.body,
        ...(requestId !== undefined ? { requestId } : {}),
      }
    }

    if (parsed.type === 'subscribe_topic_messages') {
      const topicId = normalizeRequiredText(parsed.topicId)
      if (topicId === null) return null

      // afterSeq е ЗАДЪЛЖИТЕЛЕН gap-closing cursor (Етап 2 брифа т.1) — 0 е
      // валиден baseline за тема без позната история, но полето трябва да
      // присъства структурно (не undefined), за да не се "изплъзне" случайно
      // subscribe без cursor покрай бъдещ refactor на клиента.
      if (typeof parsed.afterSeq !== 'number' || !Number.isInteger(parsed.afterSeq) || parsed.afterSeq < 0) {
        return null
      }

      return {
        type: 'subscribe_topic_messages',
        topicId,
        afterSeq: parsed.afterSeq,
      }
    }

    if (parsed.type === 'unsubscribe_topic_messages') {
      const topicId = normalizeRequiredText(parsed.topicId)
      if (topicId === null) return null
      return { type: 'unsubscribe_topic_messages', topicId }
    }

    if (parsed.type === 'send_topic_message') {
      // Само структурна проверка (тип на полетата) — семантичните правила
      // (VIP, topic status, дължина, rate limit) са в index.ts, за да могат
      // да върнат конкретен `topic_message_error.code` + requestId.
      const topicId = normalizeRequiredText(parsed.topicId)
      if (topicId === null || typeof parsed.body !== 'string') return null

      // requestId е ЗАДЪЛЖИТЕЛЕН тук (за разлика от send_lobby_chat_message)
      // — единствен ack-correlation механизъм за draft clearing/pending state
      // (Етап 2 брифа т.7); липсващ/празен requestId е structural failure,
      // не се подразбира default.
      const requestId = normalizeRequiredText(parsed.requestId)
      if (requestId === null) return null

      // imageDataUrl е опционален — само тип-проверка (string), decode/
      // validate/process pipeline-ът (imageAttachments.ts) е в index.ts,
      // симетрично на принципа "структура тук, семантика там" по-горе.
      const imageDataUrl = typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl : undefined

      return {
        type: 'send_topic_message',
        topicId,
        body: parsed.body,
        requestId: requestId.slice(0, 100),
        ...(imageDataUrl !== undefined ? { imageDataUrl } : {}),
      }
    }

    if (parsed.type === 'send_topic_reply') {
      // Само структурна проверка — семантика (VIP, parent exists/root-only,
      // topic status, дължина, rate limit) е в index.ts (виж send_topic_message
      // коментара по-горе за същия принцип).
      const topicId = normalizeRequiredText(parsed.topicId)
      const parentMessageId = normalizeRequiredText(parsed.parentMessageId)
      if (topicId === null || parentMessageId === null || typeof parsed.body !== 'string') return null

      const requestId = normalizeRequiredText(parsed.requestId)
      if (requestId === null) return null

      const imageDataUrl = typeof parsed.imageDataUrl === 'string' ? parsed.imageDataUrl : undefined

      return {
        type: 'send_topic_reply',
        topicId,
        parentMessageId,
        body: parsed.body,
        requestId: requestId.slice(0, 100),
        ...(imageDataUrl !== undefined ? { imageDataUrl } : {}),
      }
    }

    if (parsed.type === 'toggle_topic_message_like') {
      const messageId = normalizeRequiredText(parsed.messageId)
      if (messageId === null) return null

      const requestId = normalizeRequiredText(parsed.requestId)
      if (requestId === null) return null

      return {
        type: 'toggle_topic_message_like',
        messageId,
        requestId: requestId.slice(0, 100),
      }
    }

    if (parsed.type === 'create_topic') {
      // Само структурна проверка — семантичните правила (title validation,
      // VIP, rate limit, duplicate) са в index.ts, mirror на send_topic_message.
      if (typeof parsed.title !== 'string') return null

      const requestId = normalizeRequiredText(parsed.requestId)
      if (requestId === null) return null

      return {
        type: 'create_topic',
        title: parsed.title,
        requestId: requestId.slice(0, 100),
      }
    }

    if (parsed.type === 'subscribe_topics_directory') {
      return { type: 'subscribe_topics_directory' }
    }

    if (parsed.type === 'unsubscribe_topics_directory') {
      return { type: 'unsubscribe_topics_directory' }
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

// Централен, in-memory, O(1) брояч за "logical business activity" —
// отделен от WS/HTTP transport fan-out. Bounded по конструкция: всеки
// counter е фиксирано поле в Record, никога Map с произволни ключове.
// Не пази съдържание (текст/username/profileId/IP/URL) — само числа.

export type ChatActivityCounters = {
  lobbyChatMessages: number
  directChatFriendMessages: number
  directChatPikaTeamMessages: number
  directChatVipDmMessages: number
  officialSupportMessages: number
  privateRoomChatMessages: number
  guestContactMessages: number
}

export type TopicsActivityCounters = {
  topicRootsCreated: number
  topicRepliesCreated: number
  lafcheRootsCreated: number
  lafcheRepliesCreated: number
  topicListRequests: number
  topicMessagesRequests: number
  topicRepliesRequests: number
}

export type GameActivityCounters = {
  gameplayBidAccepted: number
  gameplayCutAccepted: number
  gameplayPlayAccepted: number
  roomSnapshotBroadcasts: number
}

export type RoomsActivityCounters = {
  matchmakingJoin: number
  matchmakingLeave: number
  matchmakingMatchFound: number
  privateRoomCreate: number
  privateRoomJoin: number
  privateRoomLeave: number
}

export type TournamentActivityCounters = {
  tournamentRegistration: number
  tournamentLeave: number
  tournamentRoundStart: number
  tournamentMatchResult: number
}

// WS message.type / HTTP category — bounded enums от протокола/класификатора.
// Пазени като Record<string,number>, но ключовете идват изключително от
// известни, крайни списъци (виж httpCategoryClassifier.ts за HTTP;
// WS типовете идват от протокола) — никога от raw user input.
export type TransportActivityCounters = {
  wsInboundByType: Record<string, number>
  wsOutboundByType: Record<string, number>
  httpRequestsByCategory: Record<string, number>
}

export type ActivityCountersSnapshot = ChatActivityCounters &
  TopicsActivityCounters &
  GameActivityCounters &
  RoomsActivityCounters &
  TournamentActivityCounters &
  TransportActivityCounters

const CHAT_KEYS: Array<keyof ChatActivityCounters> = [
  'lobbyChatMessages',
  'directChatFriendMessages',
  'directChatPikaTeamMessages',
  'directChatVipDmMessages',
  'officialSupportMessages',
  'privateRoomChatMessages',
  'guestContactMessages',
]

const TOPICS_KEYS: Array<keyof TopicsActivityCounters> = [
  'topicRootsCreated',
  'topicRepliesCreated',
  'lafcheRootsCreated',
  'lafcheRepliesCreated',
  'topicListRequests',
  'topicMessagesRequests',
  'topicRepliesRequests',
]

const GAME_KEYS: Array<keyof GameActivityCounters> = [
  'gameplayBidAccepted',
  'gameplayCutAccepted',
  'gameplayPlayAccepted',
  'roomSnapshotBroadcasts',
]

const ROOMS_KEYS: Array<keyof RoomsActivityCounters> = [
  'matchmakingJoin',
  'matchmakingLeave',
  'matchmakingMatchFound',
  'privateRoomCreate',
  'privateRoomJoin',
  'privateRoomLeave',
]

const TOURNAMENT_KEYS: Array<keyof TournamentActivityCounters> = [
  'tournamentRegistration',
  'tournamentLeave',
  'tournamentRoundStart',
  'tournamentMatchResult',
]

function zeroScalarCounters(): ChatActivityCounters &
  TopicsActivityCounters &
  GameActivityCounters &
  RoomsActivityCounters &
  TournamentActivityCounters {
  const result = {} as ChatActivityCounters &
    TopicsActivityCounters &
    GameActivityCounters &
    RoomsActivityCounters &
    TournamentActivityCounters
  for (const key of CHAT_KEYS) result[key] = 0
  for (const key of TOPICS_KEYS) result[key] = 0
  for (const key of GAME_KEYS) result[key] = 0
  for (const key of ROOMS_KEYS) result[key] = 0
  for (const key of TOURNAMENT_KEYS) result[key] = 0
  return result
}

export type ActivityCounters = {
  incrementChat(key: keyof ChatActivityCounters): void
  incrementTopics(key: keyof TopicsActivityCounters): void
  incrementGame(key: keyof GameActivityCounters): void
  incrementRooms(key: keyof RoomsActivityCounters): void
  incrementTournament(key: keyof TournamentActivityCounters): void
  incrementWsInbound(messageType: string): void
  incrementWsOutbound(messageType: string): void
  incrementHttpCategory(category: string): void
  snapshotAndReset(): ActivityCountersSnapshot
  peek(): ActivityCountersSnapshot
}

export function createActivityCounters(): ActivityCounters {
  let scalars = zeroScalarCounters()
  let wsInboundByType: Record<string, number> = {}
  let wsOutboundByType: Record<string, number> = {}
  let httpRequestsByCategory: Record<string, number> = {}

  function bump(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1
  }

  function snapshot(): ActivityCountersSnapshot {
    return {
      ...scalars,
      wsInboundByType: { ...wsInboundByType },
      wsOutboundByType: { ...wsOutboundByType },
      httpRequestsByCategory: { ...httpRequestsByCategory },
    }
  }

  return {
    incrementChat(key) {
      scalars[key] += 1
    },
    incrementTopics(key) {
      scalars[key] += 1
    },
    incrementGame(key) {
      scalars[key] += 1
    },
    incrementRooms(key) {
      scalars[key] += 1
    },
    incrementTournament(key) {
      scalars[key] += 1
    },
    incrementWsInbound(messageType) {
      bump(wsInboundByType, messageType)
    },
    incrementWsOutbound(messageType) {
      bump(wsOutboundByType, messageType)
    },
    incrementHttpCategory(category) {
      bump(httpRequestsByCategory, category)
    },
    snapshotAndReset() {
      const result = snapshot()
      scalars = zeroScalarCounters()
      wsInboundByType = {}
      wsOutboundByType = {}
      httpRequestsByCategory = {}
      return result
    },
    peek() {
      return snapshot()
    },
  }
}

export function emptyActivityCountersSnapshot(): ActivityCountersSnapshot {
  return {
    ...zeroScalarCounters(),
    wsInboundByType: {},
    wsOutboundByType: {},
    httpRequestsByCategory: {},
  }
}

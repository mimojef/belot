// Централен, in-memory, O(1) брояч за "logical business activity" —
// отделен от WS/HTTP transport fan-out. Bounded по конструкция: всеки
// counter е фиксирано поле в Record, никога Map с произволни ключове.
// Не пази съдържание (текст/username/profileId/IP/URL) — само числа.
//
// DUAL-WINDOW ARCHITECTURE (виж final fix pass брифа §1/§2) — всеки
// increment пише едновременно в ДВА напълно независими accumulator-а:
//   - oneSecond: reset-ва се точно веднъж на всеки 1s forensic sample tick
//     (index.ts cpuForensicSampleIntervalId) — представлява activity,
//     станала в completed-ия 1-секунден forensic прозорец.
//   - tenSecond: reset-ва се точно веднъж на всеки 10s bucket tick
//     (index.ts cpuForensicBucketIntervalId) — same семантика както преди,
//     ползва се за ForensicBucket.activity.
// Reset на едното НИКОГА не пипа другото — separate closure state.
// Старият peek() (non-destructive cumulative read) е премахнат от
// production spike-context пътя, защото представяше up-to-10s cumulative
// данни като "activity during the 1-second spike" (FALSE ATTRIBUTION RISK,
// виж review findings). snapshotOneSecondAndReset() е единственият коректен
// начин да получиш "какво стана в тази секунда".

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
  tournamentForceRemoveTeam: number
  tournamentForceRemoveEntry: number
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
  'tournamentForceRemoveTeam',
  'tournamentForceRemoveEntry',
]

type ScalarCounters = ChatActivityCounters &
  TopicsActivityCounters &
  GameActivityCounters &
  RoomsActivityCounters &
  TournamentActivityCounters

function zeroScalarCounters(): ScalarCounters {
  const result = {} as ScalarCounters
  for (const key of CHAT_KEYS) result[key] = 0
  for (const key of TOPICS_KEYS) result[key] = 0
  for (const key of GAME_KEYS) result[key] = 0
  for (const key of ROOMS_KEYS) result[key] = 0
  for (const key of TOURNAMENT_KEYS) result[key] = 0
  return result
}

type WindowState = {
  scalars: ScalarCounters
  wsInboundByType: Record<string, number>
  wsOutboundByType: Record<string, number>
  httpRequestsByCategory: Record<string, number>
}

function zeroWindowState(): WindowState {
  return {
    scalars: zeroScalarCounters(),
    wsInboundByType: {},
    wsOutboundByType: {},
    httpRequestsByCategory: {},
  }
}

function snapshotWindow(w: WindowState): ActivityCountersSnapshot {
  return {
    ...w.scalars,
    wsInboundByType: { ...w.wsInboundByType },
    wsOutboundByType: { ...w.wsOutboundByType },
    httpRequestsByCategory: { ...w.httpRequestsByCategory },
  }
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
  // Completed one-second forensic window — извиква се точно веднъж на всеки
  // 1s forensic sample tick. Reset-ва САМО oneSecond state.
  snapshotOneSecondAndReset(): ActivityCountersSnapshot
  // Completed ten-second forensic window (= стария snapshotAndReset()) —
  // извиква се точно веднъж на всеки 10s bucket tick. Reset-ва САМО
  // tenSecond state.
  snapshotTenSecondAndReset(): ActivityCountersSnapshot
  /** Alias за snapshotTenSecondAndReset(), запазен за source-compat. */
  snapshotAndReset(): ActivityCountersSnapshot
  // Non-destructive read на tenSecond window (не пипа нито едно от двете
  // състояния) — НЕ използвай за spike forensic context (връща cumulative
  // "since last 10s reset", не "during this exact 1-second sample" — виж
  // review findings за FALSE ATTRIBUTION RISK). Ползвай само за
  // debug/inspection, не за incident evidence.
  peek(): ActivityCountersSnapshot
}

export function createActivityCounters(): ActivityCounters {
  let oneSecond = zeroWindowState()
  let tenSecond = zeroWindowState()

  function bump(record: Record<string, number>, key: string): void {
    record[key] = (record[key] ?? 0) + 1
  }

  function incrementBoth(pick: (w: WindowState) => void): void {
    pick(oneSecond)
    pick(tenSecond)
  }

  return {
    incrementChat(key) {
      incrementBoth((w) => {
        w.scalars[key] += 1
      })
    },
    incrementTopics(key) {
      incrementBoth((w) => {
        w.scalars[key] += 1
      })
    },
    incrementGame(key) {
      incrementBoth((w) => {
        w.scalars[key] += 1
      })
    },
    incrementRooms(key) {
      incrementBoth((w) => {
        w.scalars[key] += 1
      })
    },
    incrementTournament(key) {
      incrementBoth((w) => {
        w.scalars[key] += 1
      })
    },
    incrementWsInbound(messageType) {
      incrementBoth((w) => bump(w.wsInboundByType, messageType))
    },
    incrementWsOutbound(messageType) {
      incrementBoth((w) => bump(w.wsOutboundByType, messageType))
    },
    incrementHttpCategory(category) {
      incrementBoth((w) => bump(w.httpRequestsByCategory, category))
    },
    snapshotOneSecondAndReset() {
      const result = snapshotWindow(oneSecond)
      oneSecond = zeroWindowState()
      return result
    },
    snapshotTenSecondAndReset() {
      const result = snapshotWindow(tenSecond)
      tenSecond = zeroWindowState()
      return result
    },
    snapshotAndReset() {
      const result = snapshotWindow(tenSecond)
      tenSecond = zeroWindowState()
      return result
    },
    peek() {
      return snapshotWindow(tenSecond)
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

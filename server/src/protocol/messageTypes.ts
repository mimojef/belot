import type {
  PlayerIdentitySnapshot,
  PlayerGender,
  PlayerPublicProfileSnapshot,
  RoomId,
  RoomStatus,
  Seat,
  Team,
  TournamentAttendanceSnapshot,
  TournamentBotReplacementSnapshot,
  TournamentRoomBannerSnapshot,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'
import type { TournamentMatchAssignment } from '../tournament/tournamentCoordinator.js'
import type { TournamentPartnerInviteDto } from '../tournament/tournamentDto.js'
import type { TournamentRoundType } from '../tournament/tournamentTypes.js'
import type { TopicSnapshot } from '../db/topicStore.js'

export type TournamentMatchAssignedMessage = {
  type: 'tournament_match_assigned'
  assignment: TournamentMatchAssignment
}

// Login/reconnect докато профилът е между кръгове (STATE A/B), без runnable
// match в момента — виж коментара на connection-setup push-а в index.ts.
// Клиентът само знае, че трябва да fetch-не authoritative tournament detail
// за tournamentId и сам да resolve-не destination-а (myInterRoundWaiting) —
// не носи самия destination, за да няма duplicate state изчисление.
export type TournamentActiveParticipationMessage = {
  type: 'tournament_active_participation'
  tournamentId: string
}

export type TournamentFeederMatchCompletedMessage = {
  type: 'tournament_feeder_match_completed'
  tournamentId: string
  matchId: string
  roundType: TournamentRoundType
  winnerTeamId: string
  finalScoreTeamA: number | null
  finalScoreTeamB: number | null
}

export type TournamentFeederScoreProgressMessage = {
  type: 'tournament_feeder_score_progress'
  tournamentId: string
  matchId: string
  teamAId: string
  teamBId: string
  scoreTeamA: number
  scoreTeamB: number
  status: 'in_progress'
}

// Server-initiated entry-fee refund notice (§4 в task spec-а) — изпраща се
// само до реално refund-нати online профили при creator cancellation или
// fill-expiry auto-cancel. Debit-нотификациите (join/partner invite create
// или accept) НЕ минават оттук — те се показват директно от authoritative
// HTTP response-а на действащия клиент, за да няма двойно известие.
// eventId е уникален per push и служи за client-side dedup (виж
// tournamentEconomyNotificationQueue.ts на клиента).
export type TournamentEconomyNoticeMessage = {
  type: 'tournament_economy_notice'
  eventId: string
  tournamentId: string
  reason: 'creator_cancelled' | 'fill_expired' | 'scheduled_underfilled' | 'partner_left' | 'force_removed_by_creator' | 'force_removed_by_admin'
  amount: number
  occurredAt: string
}

export type ClientBidAction =
  | {
      type: 'pass'
    }
  | {
      type: 'suit'
      suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
    }
  | {
      type: 'no-trumps'
    }
  | {
      type: 'all-trumps'
    }
  | {
      type: 'double'
    }
  | {
      type: 'redouble'
    }

export type ClientMessage =
  | {
      type: 'ping'
    }
  | {
      type: 'create_room'
      displayName?: string
    }
  | {
      type: 'join_room'
      roomId: RoomId
      displayName?: string
    }
  | {
      type: 'join_matchmaking'
      displayName?: string
      stake: MatchStake
    }
  | {
      type: 'join_guest_trial'
      stake: MatchStake
    }
  | {
      type: 'leave_matchmaking'
    }
  | {
      type: 'request_player_profile'
      roomId: RoomId
      seat: Seat
    }
  | {
      type: 'resume_room'
      roomId: RoomId
      reconnectToken: string
      // Phase 1 protocol foundation for the unified inter-round popup (task
      // spec §7) — when true, the server performs the exact same seat
      // attachment as a normal resume_room (tryResumeRoomForConnection/
      // attachConnectionToRoomSeat, unchanged), but responds with
      // room_attached_silent instead of room_resumed, so the client is not
      // instructed to navigate to the active-room screen. No lobby UI uses
      // this yet in Phase 1 — this is protocol foundation only.
      silent?: boolean
    }
  | {
      type: 'tournament_semifinal_result_acknowledge'
      tournamentId: string
      semifinalMatchId: string
    }
  | {
      type: 'leave_active_room'
      roomId: RoomId
      acceptPenalty?: boolean
    }
  | {
      type: 'submit_bid_action'
      roomId: RoomId
      action: ClientBidAction
    }
  | {
      type: 'submit_cut_index'
      roomId: RoomId
      cutIndex: number
    }
  | {
      type: 'submit_play_card'
      roomId: RoomId
      cardId: string
      declarationKeys?: string[]
    }
  | {
      type: 'resume_human_control'
      roomId: RoomId
    }
  | {
      type: 'submit_partner_rating'
      roomId: RoomId
      ratingValue: number
    }
  | {
      type: 'request_replay'
      roomId: RoomId
    }
  | {
      type: 'request_leave_match'
      roomId: RoomId
    }
  | {
      type: 'send_emoji_reaction'
      roomId: RoomId
      emojiId: string
    }
  | {
      type: 'send_phrase_reaction'
      roomId: RoomId
      phraseId: string
    }
  | {
      type: 'create_private_room'
      stake: MatchStake
      isLocked: boolean
      waitMinutes: PrivateRoomWaitMinutes
      manualStart?: boolean
      displayName?: string
    }
  | {
      type: 'join_private_room'
      privateRoomId: string
      team: Team
      slotIndex: 0 | 1
      displayName?: string
    }
  | {
      type: 'leave_private_room'
    }
  | {
      type: 'invite_to_private_room'
      toProfiles: Array<{ profileId: string; displayName: string }>
    }
  | {
      type: 'cancel_private_room_invite'
      inviteId: string
    }
  | {
      type: 'respond_private_room_invite'
      inviteId: string
      accept: boolean
    }
  | {
      type: 'request_private_rooms_list'
    }
  | {
      // "Играещи"/"Приключили" табове — виж PrivateGamesListMessage.
      type: 'request_private_games_list'
    }
  | {
      type: 'add_bot_to_private_room_team'
      team: Team
    }
  | {
      type: 'remove_bot_from_private_room_team'
      team: Team
    }
  | {
      // Host-only — вика се само когато room.manualStart===true И стаята вече
      // е 4/4 waiting (виж PrivateRoomSnapshot.manualStart/canManualStart).
      // Server е authoritative за creator/waiting/ready проверките — виж
      // handleStartPrivateRoomRequest в index.ts.
      type: 'start_private_room'
    }
  | {
      // Host-only — маха реален (не бот) занял слот играч от WAITING стаята.
      // Server проверява creator/waiting/target-occupancy authoritative —
      // виж handleKickFromPrivateRoomRequest в index.ts. Няма permanent
      // ban/block ефект — kicked играчът може да опита да влезе отново.
      type: 'kick_from_private_room'
      team: Team
      slotIndex: 0 | 1
    }
  | {
      type: 'subscribe_private_room_chat'
      privateRoomId: string
    }
  | {
      type: 'unsubscribe_private_room_chat'
      privateRoomId: string
    }
  | {
      type: 'send_private_room_chat_message'
      privateRoomId: string
      body: string
      requestId?: string
    }
  | {
      type: 'subscribe_lobby_chat'
    }
  | {
      type: 'unsubscribe_lobby_chat'
    }
  | {
      type: 'send_lobby_chat_message'
      body: string
      requestId?: string
    }
  | {
      type: 'subscribe_topic_messages'
      topicId: string
      /**
       * Последният seq, който клиентът вече знае за тази тема (от REST load
       * или предишна WS сесия) — ЗАДЪЛЖИТЕЛЕН gap-closing cursor (Етап 2
       * брифа т.1): всеки subscribe затваря прозореца между REST snapshot-а
       * и регистрацията на WS interest-а. `0` за тема без никакви познати
       * съобщения все още (празна история).
       */
      afterSeq: number
    }
  | {
      type: 'unsubscribe_topic_messages'
      topicId: string
    }
  | {
      type: 'send_topic_message'
      topicId: string
      body: string
      /** Задължителен (за разлика от lobby chat) — единствен ack-correlation механизъм, виж Етап 2 брифа т.7. */
      requestId: string
      /** Опционален `data:image/...;base64,...` — reuse на СЪЩИЯ decode/validate/process pipeline като friend chat (imageAttachments.ts), виж index.ts. Максимум 1 attachment/съобщение. */
      imageDataUrl?: string
    }
  | {
      type: 'send_topic_reply'
      topicId: string
      /** Винаги root съобщение — reply-към-reply се отхвърля server-side (Етап 3, едно ниво). */
      parentMessageId: string
      body: string
      requestId: string
      imageDataUrl?: string
    }
  | {
      type: 'toggle_topic_message_like'
      /** Работи еднакво за root съобщение и reply — likes не различават нивото. */
      messageId: string
      requestId: string
    }
  | {
      type: 'create_topic'
      title: string
      /** Задължителен — единствен ack-correlation механизъм, mirror на send_topic_message. */
      requestId: string
    }
  | {
      /** Directory-wide "гледам списъка с теми" interest — reuse на subscribe_lobby_chat pattern-а, за да получава клиентът topic_created broadcast без polling. */
      type: 'subscribe_topics_directory'
    }
  | {
      type: 'unsubscribe_topics_directory'
    }

export type RoomSeatSnapshot = {
  seat: Seat
  displayName: string
  isOccupied: boolean
  isBot: boolean
  isControlledByBot: boolean
  isConnected: boolean
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
  gender: PlayerGender | null
}

export type RoomGamePhaseSnapshot =
  | 'bootstrap'
  | 'cutting'
  | 'bidding'
  | 'playing'
  | 'scoring'
  | 'finished'

export type RoomAuthoritativePhaseSnapshot =
  | 'new-game'
  | 'choose-first-dealer'
  | 'cutting'
  | 'cut-resolve'
  | 'deal-first-3'
  | 'deal-next-2'
  | 'bidding'
  | 'deal-last-3'
  | 'playing'
  | 'scoring'
  | 'next-round'
  | 'match-ended'

export type RoomCuttingSnapshot = {
  cutterSeat: Seat | null
  selectedCutIndex: number | null
  deckCount: number
  canSubmitCut: boolean
}

export type RoomBidActionSnapshot =
  | { type: 'pass' }
  | { type: 'suit'; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type RoomBidEntrySnapshot = {
  seat: Seat
  action: RoomBidActionSnapshot
}

export type RoomWinningBidSnapshot = {
  seat: Seat
  contract: 'suit' | 'no-trumps' | 'all-trumps'
  trumpSuit: 'clubs' | 'diamonds' | 'hearts' | 'spades' | null
  doubled: boolean
  redoubled: boolean
} | null

export type RoomValidBidActionsSnapshot = {
  pass: boolean
  suits: { clubs: boolean; diamonds: boolean; hearts: boolean; spades: boolean }
  noTrumps: boolean
  allTrumps: boolean
  double: boolean
  redouble: boolean
}

export type RoomBiddingSnapshot = {
  currentBidderSeat: Seat | null
  canSubmitBid: boolean
  entries: RoomBidEntrySnapshot[]
  winningBid: RoomWinningBidSnapshot
  validActions: RoomValidBidActionsSnapshot | null
}

export type RoomCardSnapshot = {
  id: string
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades'
  rank: '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A'
}

export type RoomPlayCardSnapshot = {
  seat: Seat
  card: RoomCardSnapshot
}

export type RoomCompletedTrickSnapshot = {
  trickIndex: number
  leaderSeat: Seat
  plays: RoomPlayCardSnapshot[]
  winnerSeat: Seat
}

export type RoomDeclarationSnapshot = {
  seat: Seat
  team: 'A' | 'B'
  type: 'sequence' | 'square' | 'belote'
  publicLabel: string
  points: number
  cards: RoomCardSnapshot[]
  cardIds: string[]
  suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' | null
  highRank: '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K' | 'A' | null
  declaredAtTrickIndex: number
  announced: boolean
  valid: boolean
}

export type RoomPlayingSnapshot = {
  winningBid: RoomWinningBidSnapshot
  currentTurnSeat: Seat | null
  currentTrickPlays: RoomPlayCardSnapshot[]
  completedTricksCount: number
  latestCompletedTrick: RoomCompletedTrickSnapshot | null
  validCardIds: string[] | null
}

export type RoomTeamPointsSnapshot = {
  teamA: number
  teamB: number
}

export type RoomScoringSnapshot = {
  winningBid: RoomWinningBidSnapshot
  rawHandPoints: RoomTeamPointsSnapshot
  rawHandTricksWon: RoomTeamPointsSnapshot
  declarationPoints: RoomTeamPointsSnapshot
  belotePoints: RoomTeamPointsSnapshot
  sumPoints: RoomTeamPointsSnapshot
  officialRoundPoints: RoomTeamPointsSnapshot
  matchTotals: RoomTeamPointsSnapshot
  carryOver: RoomTeamPointsSnapshot
  isCapotRound: boolean
  isNonCapotRound: boolean
  outcomeLabel: string
  outcomeShortLabel: string
  counterMultiplier: number
}

export type RoomMatchEndedSnapshot = {
  winnerTeam: 'A' | 'B'
  targetScore: number
  finalScore: RoomTeamPointsSnapshot
  endedAt: number
  replayVotes: Seat[]
  leaveVotes: Seat[]
  awardedPrizeAmount: number | null
}

export type RoomScoreSnapshot = {
  match: RoomTeamPointsSnapshot
}

export type RoomGameSnapshot = {
  phase: RoomGamePhaseSnapshot | null
  authoritativePhase: RoomAuthoritativePhaseSnapshot | null
  timerDeadlineAt: number | null
  dealerSeat: Seat | null
  firstDealSeat: Seat | null
  cutting: RoomCuttingSnapshot | null
  bidding: RoomBiddingSnapshot | null
  playing: RoomPlayingSnapshot | null
  scoring: RoomScoringSnapshot | null
  matchEnded: RoomMatchEndedSnapshot | null
  declarations: RoomDeclarationSnapshot[]
  score: RoomScoreSnapshot
  handCounts: Record<Seat, number>
  ownHand: RoomCardSnapshot[]
}

export type RoomSnapshotMessage = {
  type: 'room_snapshot'
  roomId: RoomId
  roomStatus: RoomStatus
  yourSeat: Seat | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game?: RoomGameSnapshot | null
  stakeAmount: number | null
  isGuestTrial: boolean
  isPrivateTableOrigin: boolean
  isTournamentMatchOrigin: boolean
  tournamentId?: string | null
  tournamentMatchId?: string | null
  tournamentRoundType?: TournamentRoundType | null
  tournamentAttendance?: TournamentAttendanceSnapshot | null
  tournamentBotReplacements?: TournamentBotReplacementSnapshot[]
  tournamentBanners?: TournamentRoomBannerSnapshot[]
}

export type ConnectedMessage = {
  type: 'connected'
  clientId: string
  message: string
}

export type PongMessage = {
  type: 'pong'
  timestamp: number
}

export type PrivateRoomActionErrorCode =
  | 'private_room_slot_taken'
  | 'private_room_team_full'
  | 'private_room_partner_blocked'
  | 'private_room_partner_blocked_by_viewer'
  | 'private_room_bot_owner_missing'
  | 'private_room_not_creator'
  | 'private_room_not_ready_to_start'
  | 'private_room_kick_target_invalid'

export type ErrorMessage = {
  type: 'error'
  message: string
  code?:
    | 'private_room_stake_unavailable'
    | 'private_room_insufficient_balance'
    | 'private_room_level_required'
    | PrivateRoomActionErrorCode
}

export type GuestTrialErrorMessage = {
  type: 'guest_trial_error'
  message: string
  reason: 'guest_trial_limit_reached' | 'guest_trial_invalid_stake' | 'guest_trial_unavailable'
  remaining: number
}

export type GuestTrialStatusMessage = {
  type: 'guest_trial_status'
  gamesUsed: number
  remaining: number
  maxGames: number
  stake: MatchStake
}

export type PlayerProfileMessage = {
  type: 'player_profile'
  roomId: RoomId
  seat: Seat
  profile: PlayerPublicProfileSnapshot | null
  ok?: boolean
  code?: 'profile_blocked_by_viewer' | 'profile_blocked_viewer'
  message?: string
}

export type RoomCreatedMessage = {
  type: 'room_created'
  roomId: RoomId
  seat: Seat
  hostDisplayName: string
}

export type RoomJoinedMessage = {
  type: 'room_joined'
  roomId: RoomId
  seat: Seat
  displayName: string
}

export type RoomResumedMessage = {
  type: 'room_resumed'
  roomId: RoomId
  seat: Seat
}

// Response to resume_room { silent: true } — confirms the exact same server-
// side seat attachment as room_resumed (same tryResumeRoomForConnection/
// attachConnectionToRoomSeat path, see index.ts), but is a distinct message
// type so the client can tell "attach succeeded" apart from "attach
// succeeded AND you should navigate to the active-room screen" without
// relying on a boolean flag that existing room_resumed handlers might
// overlook. Phase 1 protocol foundation only — see ClientMessage's
// resume_room.silent comment; no client code sends silent:true yet.
export type RoomAttachedSilentMessage = {
  type: 'room_attached_silent'
  roomId: RoomId
  seat: Seat
  profileId: string | null
}

export type RoomResumeFailedMessage = {
  type: 'room_resume_failed'
  roomId: RoomId
  message: string
}

export type ActiveRoomLeftMessage = {
  type: 'left_active_room'
  roomId: RoomId
  removed: boolean
  penalty?: {
    penaltyAmount: number
    chargedAmount: number
    balanceAfter: number
  }
}

export type PartnerRatingSubmittedMessage = {
  type: 'partner_rating_submitted'
  roomId: RoomId
  ratingValue: number
  raterDisplayName: string
}

export type MatchmakingQueuedPlayerPreview = {
  id: string
  name: string
  avatarUrl: string | null
  isBot?: boolean
}

export type MatchmakingJoinedMessage = {
  type: 'matchmaking_joined'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
  totalDurationMs?: number
  previewBotDisplayNames?: string[]
  queuedPlayerPreviews?: MatchmakingQueuedPlayerPreview[]
}

export type MatchmakingStatusMessage = {
  type: 'matchmaking_status'
  stake: MatchStake
  queuedPlayers: number
  requiredPlayers: number
  countdownEndsAt: number
  remainingMs: number
  totalDurationMs?: number
  previewBotDisplayNames?: string[]
  queuedPlayerPreviews?: MatchmakingQueuedPlayerPreview[]
  localStakeDeducted?: true
}

export type MatchmakingLeftMessage = {
  type: 'matchmaking_left'
  removed: boolean
}

export type MatchmakingExpiredMessage = {
  type: 'matchmaking_expired'
  stake: MatchStake
}

export type MatchFoundMessage = {
  type: 'match_found'
  roomId: RoomId
  seat: Seat
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
}

export type SessionDisplacedMessage = {
  type: 'session_displaced'
}

export type SessionInGameMessage = {
  type: 'session_in_game'
  roomId: RoomId
  reconnectToken: string
}

export type EmojiReactionMessage = {
  type: 'emoji_reaction'
  roomId: RoomId
  seat: Seat
  emojiId: string
}

export type PhraseReactionMessage = {
  type: 'phrase_reaction'
  roomId: RoomId
  seat: Seat
  phraseId: string
}

// --- Private rooms ---

export type PrivateRoomWaitMinutes = 5 | 10 | 15 | 30

export type PrivateRoomOccupantSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  isHost: boolean
  isBot: boolean
}

export type PrivateRoomSlotSnapshot = {
  team: Team
  slotIndex: 0 | 1
  occupant: PrivateRoomOccupantSnapshot | null
}

export type PrivateRoomSnapshot = {
  id: string
  kind: 'open' | 'locked'
  stake: MatchStake
  // Винаги дължина 4, фиксиран ред A0,A1,B0,B1 — празните слотове се изпращат
  // явно (occupant:null), клиентът вече не гадае team по позиция в масив.
  slots: PrivateRoomSlotSnapshot[]
  createdAt: number
  expiresAt: number
  // "Ръчен старт от създателя" — при true, 4/4 НЕ стартира match-а
  // автоматично; само creator-ът (occupant.isHost===true) може да изпрати
  // start_private_room, и то само когато canManualStart===true.
  manualStart: boolean
  // Server-derived: manualStart===true И всичките 4 слота са заети (readiness
  // все още не е гарантирана тук — block-partnership отказът стига до
  // клиента чрез съществуващия private_room_partner_blocked error path при
  // реален start опит, не преизчислен предварително в snapshot-а).
  canManualStart: boolean
}

export type PrivateRoomsListMessage = {
  type: 'private_rooms_list'
  rooms: PrivateRoomSnapshot[]
}

export type PrivateRoomUpdatedMessage = {
  type: 'private_room_updated'
  room: PrivateRoomSnapshot
}

export type PrivateRoomLeftMessage = {
  type: 'private_room_left'
  privateRoomId: string
}

export type PrivateRoomExpiredMessage = {
  type: 'private_room_expired'
  privateRoomId: string
}

export type PrivateRoomInviteReceivedMessage = {
  type: 'private_room_invite_received'
  inviteId: string
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
  privateRoomId: string
  stake: MatchStake
  expiresAt: number
}

export type PrivateRoomInviteAcceptedMessage = {
  type: 'private_room_invite_accepted'
  toDisplayName: string
}

// Изпраща се само на приемащата връзка при успешен accept — за разлика от
// private_room_updated (значи "това Е твоята стая"), приемащият все още не е
// зает слот, само получава room-lifetime authorization (виж
// privateRoomsStore.authorizedProfileIds). Клиентът ползва privateRoomId, за
// да навигира към preview на точно тази стая.
export type PrivateRoomInviteAcceptConfirmedMessage = {
  type: 'private_room_invite_accept_confirmed'
  privateRoomId: string
}

export type PrivateRoomInviteDeclinedMessage = {
  type: 'private_room_invite_declined'
  toDisplayName: string
}

export type PrivateRoomInviteExpiredMessage = {
  type: 'private_room_invite_expired'
  inviteId: string
}

export type PrivateRoomInviteCancelledMessage = {
  type: 'private_room_invite_cancelled'
  inviteId: string
}

export type PrivateRoomFriendBusyMessage = {
  type: 'private_room_friend_busy'
  busyFriends: Array<{ displayName: string }>
}

export type PrivateRoomMemberLeftMessage = {
  type: 'private_room_member_left'
  displayName: string
}

export type PrivateRoomClosedMessage = {
  type: 'private_room_closed'
  privateRoomId: string
}

// Изпраща се САМО на изритания играч (не на оставащите — те получават
// свежия snapshot през private_room_updated, mirror на handlePrivateRoomLeft
// pattern-а). Клиентът показва dedicated modal ("Бяхте изключен от
// създателя на масата."), не generic error/toast — виж
// handleKickFromPrivateRoomRequest в index.ts.
export type PrivateRoomKickedMessage = {
  type: 'private_room_kicked'
  privateRoomId: string
}

export type PrivateRoomFullMessage = {
  type: 'private_room_full'
  roomId: RoomId
  seat: Seat
  stake: MatchStake
}

// Broadcast-ва се до всички допустими онлайн потребители (без създателя) при
// успешно създаване на нова частна маса. `notificationId` = id-то на самата
// частна стая (уникално per creation, стабилно при redelivery/reconnect —
// клиентът го ползва за dedup). `recipientInActiveGame` се изчислява
// персонализирано за всеки получател на сървъра (isProfileInActiveGame),
// клиентът никога не решава сам този статус.
export type PrivateRoomCreatedNoticeMessage = {
  type: 'private_room_created_notice'
  notificationId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
  recipientInActiveGame: boolean
}

// --- Private table "Играещи"/"Приключили" lobby listing (виж
// privateRoomMatchStore.ts) — тесен, lobby-safe DTO. НИКОГА hands/deck/
// bidding internals/trick state — само public team/score/timestamp данни,
// mirror на PrivateRoomOccupantSnapshot shape-а по-горе. ---

export type PrivateRoomMatchOccupantSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  isBot: boolean
}

export type PrivateRoomMatchSnapshot = {
  roomId: RoomId
  status: 'playing' | 'finished'
  stake: MatchStake
  teamA: [PrivateRoomMatchOccupantSnapshot, PrivateRoomMatchOccupantSnapshot]
  teamB: [PrivateRoomMatchOccupantSnapshot, PrivateRoomMatchOccupantSnapshot]
  teamAScore: number
  teamBScore: number
  startedAt: number
  finishedAt: number | null
}

export type PrivateGamesListMessage = {
  type: 'private_games_list'
  playing: PrivateRoomMatchSnapshot[]
  finished: PrivateRoomMatchSnapshot[]
}

// Targeted score-only delta push докато "Играещи" таб е отворен — избягва
// пращане на пълния playing/finished списък при всяка score промяна (виж
// §7 брифа: без global render, targeted patch). Клиентът merge-ва по roomId
// в locally-cached playing списъка, не заменя целия масив.
export type PrivateGameScoreUpdatedMessage = {
  type: 'private_game_score_updated'
  roomId: RoomId
  teamAScore: number
  teamBScore: number
}

// --- Private room waiting-room chat (изолиран, ефимерен чат за живота на
// чакалнята — виж privateRoomChatStore.ts. Не се бърка с lobby/friend/game
// chat.) ---

export type PrivateRoomChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string | null
  senderDisplayName: string
  body: string
  createdAt: number
}

export type PrivateRoomChatHistoryMessage = {
  type: 'private_room_chat_history'
  privateRoomId: string
  messages: PrivateRoomChatMessageSnapshot[]
}

export type PrivateRoomChatMessageReceivedMessage = PrivateRoomChatMessageSnapshot & {
  type: 'private_room_chat_message'
  privateRoomId: string
  requestId?: string
}

export type PrivateRoomChatErrorCode =
  | 'not_authenticated'
  | 'not_member'
  | 'empty_body'
  | 'body_too_long'
  | 'invalid_body'
  | 'rate_limited'
  | 'duplicate_message'

export type PrivateRoomChatErrorMessage = {
  type: 'private_room_chat_error'
  code: PrivateRoomChatErrorCode
  message: string
  requestId?: string
}

// --- Личен (1:1 приятелски) чат — push нотификация при ново съобщение ---
// (самото изпращане/четене е HTTP REST, виж handleChatRequest в index.ts;
// това съобщение носи само метаданни за известяване — клиентът прави GET
// refresh на историята, за да получи пълното съдържание, вкл. attachment.)
export type ChatMessageReceivedMessage = {
  type: 'chat_message_received'
  friendshipId: string
  senderProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
  messageId: string
  shouldNotify: boolean
}

// --- Client messages for private rooms ---
// (extends ClientMessage union below)

export type ServerMessage =
  | ConnectedMessage
  | PongMessage
  | ErrorMessage
  | GuestTrialErrorMessage
  | GuestTrialStatusMessage
  | SessionDisplacedMessage
  | SessionInGameMessage
  | PlayerProfileMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomResumedMessage
  | RoomAttachedSilentMessage
  | RoomResumeFailedMessage
  | ActiveRoomLeftMessage
  | PartnerRatingSubmittedMessage
  | RoomSnapshotMessage
  | MatchmakingJoinedMessage
  | MatchmakingStatusMessage
  | MatchmakingLeftMessage
  | MatchmakingExpiredMessage
  | MatchFoundMessage
  | EmojiReactionMessage
  | PhraseReactionMessage
  | PrivateRoomsListMessage
  | PrivateRoomUpdatedMessage
  | PrivateRoomLeftMessage
  | PrivateRoomExpiredMessage
  | PrivateRoomInviteReceivedMessage
  | PrivateRoomInviteAcceptedMessage
  | PrivateRoomInviteAcceptConfirmedMessage
  | PrivateRoomInviteDeclinedMessage
  | PrivateRoomInviteExpiredMessage
  | PrivateRoomInviteCancelledMessage
  | PrivateRoomFriendBusyMessage
  | PrivateRoomMemberLeftMessage
  | PrivateRoomClosedMessage
  | PrivateRoomKickedMessage
  | PrivateRoomFullMessage
  | PrivateRoomCreatedNoticeMessage
  | PrivateGamesListMessage
  | PrivateGameScoreUpdatedMessage
  | PrivateRoomChatHistoryMessage
  | PrivateRoomChatMessageReceivedMessage
  | PrivateRoomChatErrorMessage
  | ProfileLikedMessage
  | FriendRequestReceivedMessage
  | FriendRequestCancelledMessage
  | FriendRequestRejectedMessage
  | FriendRequestAcceptedMessage
  | PendingFriendRequestsMessage
  | PendingAcceptanceNotificationsMessage
  | FriendAcceptanceNotificationReadMessage
  | TournamentPartnerInviteReceivedMessage
  | TournamentPartnerInvitePopupDismissedMessage
  | TournamentPartnerInviteResolvedMessage
  | TournamentMatchAssignedMessage
  | TournamentActiveParticipationMessage
  | TournamentFeederMatchCompletedMessage
  | TournamentFeederScoreProgressMessage
  | TournamentEconomyNoticeMessage
  | LobbyChatHistoryMessage
  | LobbyChatMessageReceivedMessage
  | LobbyChatMessageDeletedMessage
  | LobbyChatErrorMessage
  | ChatMessageReceivedMessage
  | TopicMessageCatchupMessage
  | TopicMessageReceivedMessage
  | TopicMessageErrorMessage
  | TopicReplyReceivedMessage
  | TopicReplyErrorMessage
  | TopicMessageLikeChangedMessage
  | TopicMessageLikeChangedSelfMessage
  | TopicMessageLikeErrorMessage
  | TopicCreatedMessage
  | TopicCreateErrorMessage
  | TopicLockStateChangedMessage
  | TopicMuteStateChangedMessage
  | TopicDeletedMessage
  | TopicMessageDeletedMessage
  | TopicMessageEditedMessage
  | TopicProfileMuteStateChangedMessage
  | TopicUnreadCountChangedMessage
  | TopicSeenUpdatedMessage
  | TopicThreadUnreadCountChangedMessage
  | TopicThreadSeenUpdatedMessage

export type ProfileLikedMessage = {
  type: 'profile_liked'
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

export type FriendRequestReceivedMessage = {
  type: 'friend_request_received'
  friendshipId: string
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

export type FriendRequestCancelledMessage = {
  type: 'friend_request_cancelled'
  friendshipId: string
  fromProfileId: string
}

export type FriendRequestRejectedMessage = {
  type: 'friend_request_rejected'
  friendshipId: string
}

export type FriendRequestAcceptedMessage = {
  type: 'friend_request_accepted'
  friendshipId: string
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

export type PendingFriendRequestsMessage = {
  type: 'pending_friend_requests'
  requests: Array<{
    friendshipId: string
    fromProfileId: string
    fromDisplayName: string
    fromAvatarUrl: string | null
  }>
}

export type PendingAcceptanceNotificationsMessage = {
  type: 'pending_acceptance_notifications'
  notifications: Array<{
    friendshipId: string
    fromProfileId: string
    fromDisplayName: string
    fromAvatarUrl: string | null
  }>
}

export type FriendAcceptanceNotificationReadMessage = {
  type: 'friend_acceptance_notification_read'
  friendshipId: string
}

export type TournamentPartnerInviteReceivedMessage = {
  type: 'tournament_partner_invite_received'
  invite: TournamentPartnerInviteDto
}

export type TournamentPartnerInvitePopupDismissedMessage = {
  type: 'tournament_partner_invite_popup_dismissed'
  inviteId: string
  tournamentId: string
  popupDismissedAt: string | null
  notificationReadAt: string | null
}

export type TournamentPartnerInviteResolvedMessage = {
  type: 'tournament_partner_invite_resolved'
  inviteId: string
  tournamentId: string
  status: string
}

// --- Lobby live chat (общ публичен чат в лобито — виж lobbyChatStore.ts) ---

export type LobbyChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string
  senderDisplayName: string
  /** Snapshot към момента на изпращане — само за оцветяване на името в чата. */
  senderIsChatAdmin: boolean
  senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'
  body: string
  createdAt: string
}

export type LobbyChatHistoryMessage = {
  type: 'lobby_chat_history'
  messages: LobbyChatMessageSnapshot[]
}

export type LobbyChatMessageReceivedMessage = LobbyChatMessageSnapshot & {
  type: 'lobby_chat_message'
  requestId?: string
}

export type LobbyChatMessageDeletedMessage = {
  type: 'lobby_chat_message_deleted'
  messageId: string
}

export type LobbyChatErrorCode =
  | 'not_authenticated'
  | 'guest_not_allowed'
  | 'empty_body'
  | 'body_too_long'
  | 'invalid_body'
  | 'duplicate_message'
  | 'rate_limited'
  | 'not_found'
  | 'already_deleted'
  | 'forbidden'

export type LobbyChatErrorMessage = {
  type: 'lobby_chat_error'
  code: LobbyChatErrorCode
  message: string
  requestId?: string
}

// --- "Теми" realtime (root съобщения, Етап 2) — REST (GET /api/topics,
// GET /api/topics/:id/messages) остава canonical за initial/older история;
// тези WS типове са само за: (1) регистриране на interest в текущо
// активната тема, (2) send на ново root съобщение, (3) live push към
// subscribers, (4) bounded gap-closing catch-up при (re)subscribe. Никога не
// broadcast-ват пълна история — виж topicMessageStore.getMessagesAfter.

/**
 * Attachment metadata — reuse на СЪЩИЯ shape като ChatAttachmentSnapshot
 * (chatStore.ts) — viewUrl/downloadUrl вече построени server-side (index.ts),
 * WS payload носи само безопасен descriptor/reference, НИКОГА raw image bytes
 * (изричното изискване от брифа).
 */
export type TopicAttachmentSnapshot = {
  attachmentId: string
  width: number
  height: number
  byteSize: number
  viewUrl: string
  downloadUrl: string
}

/**
 * Съвместим DTO с TopicMessageSnapshot от REST response-а (index.ts
 * enrichment слой, GET /api/topics/:id/messages) — включително
 * senderAvatarUrl, batch-hydrate-нат от canonical profile данни, НЕ по едно
 * запитване на съобщение. WS push (local instant, cross-instance poll,
 * catch-up) трябва да носи същия shape, за да може клиентът да ги merge-ва
 * без DTO-специфични клонове.
 */
export type TopicMessageBroadcastSnapshot = {
  seq: number
  messageId: string
  topicId: string
  parentMessageId: string | null
  senderProfileId: string
  senderDisplayName: string
  senderAvatarUrl: string | null
  senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'
  body: string
  createdAt: string
  lastActivityAt: string
  unreadCount: number
  editedAt: string | null
  /** Attachment feature — максимум 1 image/съобщение, null ако няма. */
  attachment: TopicAttachmentSnapshot | null
  /**
   * Етап 3 — включено в root push-а (не в reply push-а, виж
   * TopicReplyBroadcastSnapshot), за да не се налага отделна REST/WS заявка
   * за aggregate данни веднага след live-append на ново root съобщение.
   * likeCount/replyCount на прясно вмъкнато съобщение винаги са 0 в
   * практика (никой не може да е like-нал/отговорил преди broadcast-а да
   * пристигне), но полетата се пращат explicit за shape симетрия с REST.
   */
  likeCount: number
  replyCount: number
  /**
   * Per-viewer — САМО в payload-а, изпратен КЪМ ТОЗИ subscriber (viewer-side
   * agregation се прави individually per subscriber connection при
   * broadcast, виж index.ts). НЕ е глобално константно поле в DB реда.
   */
  viewerHasLiked: boolean
  /** Derived at read time — авторът В МОМЕНТА има ли активно section-wide Topics заглушаване (mute indicator icon брифа). Само boolean — reason/mutedUntil/moderator НЕ се пращат тук. */
  isTopicsSectionMuted: boolean
}

/**
 * Reply push (нов reply / cross-instance poll / catch-up) — НЕ включва
 * replyCount (replies са едно ниво, reply-и-към-reply не съществуват), и НЕ
 * показва VIP badge-related данни (Етап 3 брифа: "не показвай VIP badge до
 * авторите" — важи и за replies, senderRole вече не носи VIP информация).
 */
export type TopicReplyBroadcastSnapshot = {
  seq: number
  messageId: string
  topicId: string
  parentMessageId: string
  senderProfileId: string
  senderDisplayName: string
  senderAvatarUrl: string | null
  senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'
  body: string
  createdAt: string
  editedAt: string | null
  attachment: TopicAttachmentSnapshot | null
  likeCount: number
  viewerHasLiked: boolean
  /** Derived at read time — виж TopicMessageBroadcastSnapshot.isTopicsSectionMuted. */
  isTopicsSectionMuted: boolean
}

export type TopicMessageCatchupMessage = {
  type: 'topic_message_catchup'
  topicId: string
  messages: TopicMessageBroadcastSnapshot[]
  /**
   * true = имало е повече от cap-а нови съобщения от afterSeq насам — този
   * batch е непълен. Клиентът трябва да падне обратно на обикновен REST
   * recent refresh (същата функция като initial load), merge-нат по
   * messageId, БЕЗ да форсира scroll до дъното ако потребителят е бил
   * scroll-нал нагоре (виж Етап 2 брифа, т.8).
   */
  truncated: boolean
}

export type TopicMessageReceivedMessage = TopicMessageBroadcastSnapshot & {
  type: 'topic_message'
  requestId?: string
}

export type TopicMessageErrorCode =
  | 'not_authenticated'
  | 'guest_not_allowed'
  | 'vip_required'
  | 'topic_not_found'
  | 'topic_locked'
  | 'topic_muted'
  | 'empty_body'
  | 'body_too_long'
  | 'invalid_body'
  | 'duplicate_message'
  | 'rate_limited'
  | 'invalid_image'
  | 'attachment_upload_failed'

export type TopicMessageErrorMessage = {
  type: 'topic_message_error'
  code: TopicMessageErrorCode
  message: string
  requestId?: string
  /** Само при code==='topic_muted' — точния expiry за UI banner-а ("Заглушен сте до 14:30"), server-authoritative, не client timer. */
  mutedUntil?: string
  /** Само при code==='topic_locked'|'topic_muted' — за да може клиентът да потвърди грешката е за АКТИВНАТА тема (rapid topic switch guard), не остаряла заявка от вече напусната тема. */
  topicId?: string
  /** Само при code==='topic_muted' — точната причина, зададена от модератора (GLOBAL TOPICS MUTE брифа §9: клиентът никога не трябва да разчита само на realtime push-а за да покаже reason). */
  reason?: string
}

// ─── Replies (Етап 3) ────────────────────────────────────────────────────

export type TopicReplyReceivedMessage = TopicReplyBroadcastSnapshot & {
  type: 'topic_reply'
  requestId?: string
}

export type TopicReplyErrorCode =
  | TopicMessageErrorCode
  | 'parent_not_found'
  | 'reply_to_reply_denied'

export type TopicReplyErrorMessage = {
  type: 'topic_reply_error'
  code: TopicReplyErrorCode
  message: string
  requestId: string
  mutedUntil?: string
  topicId?: string
  /** Само при code==='topic_muted' — точната причина, зададена от модератора (виж TopicMessageErrorMessage.reason коментара). */
  reason?: string
}

// ─── Likes (Етап 3) ──────────────────────────────────────────────────────
//
// Разделени в ДВЕ съобщения нарочно: `topic_message_like_changed` е
// PUBLIC broadcast към всички subscribers на темата (само messageId +
// likeCount — viewer-agnostic aggregate, никаква liker identity разкрита).
// `topic_message_like_changed_self` се изпраща САМО към connection-а на
// потребителя, който е направил toggle-а — носи и viewerHasLiked (private
// state, само собственика трябва да го знае) + requestId за ack-correlation
// с pending optimistic UI toggle-а на клиента.

export type TopicMessageLikeChangedMessage = {
  type: 'topic_message_like_changed'
  messageId: string
  likeCount: number
}

export type TopicMessageLikeChangedSelfMessage = {
  type: 'topic_message_like_changed_self'
  messageId: string
  likeCount: number
  viewerHasLiked: boolean
  requestId: string
}

export type TopicMessageLikeErrorCode =
  | 'not_authenticated'
  | 'guest_not_allowed'
  | 'message_not_found'
  | 'rate_limited'

export type TopicMessageLikeErrorMessage = {
  type: 'topic_message_like_error'
  code: TopicMessageLikeErrorCode
  message: string
  requestId: string
}

// ─── Topic creation (Custom Topic Creation) ──────────────────────────────

/**
 * Push при успешно създадена тема. До originator-а идва с matching
 * `requestId` (popup lifecycle correlation) — до всички ДРУГИ
 * topics-directory subscribers идва БЕЗ requestId (established
 * isOriginator convention, mirror на topic_message/topic_reply). Клиентът
 * upsert-ва по `topic.topicId`, не append-ва слепешката — гарантира, че
 * directory broadcast и direct success response (edge-case near-simultaneous
 * delivery) никога не създават duplicate chip.
 */
export type TopicCreatedMessage = {
  type: 'topic_created'
  topic: TopicSnapshot
  requestId?: string
}

export type TopicCreateErrorCode =
  | 'not_authenticated'
  | 'guest_not_allowed'
  | 'vip_required'
  | 'topic_muted'
  | 'empty_title'
  | 'title_too_long'
  | 'invalid_title'
  | 'topic_title_exists'
  | 'rate_limited'

export type TopicCreateErrorMessage = {
  type: 'topic_create_error'
  code: TopicCreateErrorCode
  message: string
  requestId: string
  /** Само при code==='topic_muted' — server-authoritative expiry, виж TopicMessageErrorMessage коментара за пълния rationale. */
  mutedUntil?: string
  /** Само при code==='topic_muted' — точната причина, зададена от модератора (GLOBAL TOPICS MUTE брифа §9: клиентът никога не трябва да разчита само на realtime push-а за да покаже reason). */
  reason?: string
}

// ─── Moderation (Етап 4) ────────────────────────────────────────────────
//
// Moderation ЗАПИСВАНЕТО (lock/unlock/mute/unmute/delete) минава през HTTP
// (established convention за moderation actions — виж
// handleLobbyChatDeleteRequest: "прясна cookie-based сесийна проверка на
// всяко изтриване, не роля кеширана само при WS handshake"), но
// РЕЗУЛТАТНОТО state promяна се broadcast-ва към subscribers през
// СЪЩИЯ WS канал като останалите Topics realtime събития (reuse на
// topicMessageSubscribersByTopicId — не втора паралелна infrastructure).

/**
 * Public broadcast към ВСИЧКИ subscribers на темата при lock/unlock —
 * composer state се обновява realtime без refresh (брифа т.10). Носи
 * ПЪЛНОТО текущо lock state (не delta) — клиентът просто overwrite-ва
 * локалния view, симетрично на topic_message_like_changed shape-а.
 */
export type TopicLockStateChangedMessage = {
  type: 'topic_lock_state_changed'
  topicId: string
  isLocked: boolean
  lockedUntil: string | null
  lockedReason: string | null
}

/**
 * Target-only (private) push при mute/unmute — САМО до connections на
 * заглушения потребител, НЕ broadcast към всички subscribers (брифа т.10:
 * "останалите клиенти не трябва да получават чувствителна/ненужна
 * moderation информация"). Виж broadcastToProfileConnections в index.ts.
 *
 * GLOBAL TOPICS MUTE брифа §12: `scope: 'topics_section'` е explicit
 * маркер, че isMuted/mutedUntil/reason важат за ЦЯЛАТА секция "Теми"
 * (create topic, root post, reply, vip_dm), не само за `topicId`.
 * `topicId` остава само audit/source context (от коя тема е задействано
 * действието) — клиентът НЕ трябва да го използва като enforcement scope
 * филтър (напр. "приложи push-а само ако topicId === activeTopicId" е
 * грешно след тази промяна).
 */
export type TopicMuteStateChangedMessage = {
  type: 'topic_mute_state_changed'
  scope: 'topics_section'
  topicId: string
  isMuted: boolean
  mutedUntil: string | null
  reason: string | null
}

/**
 * Public broadcast при изтриване на тема — subscribed клиенти трябва
 * безопасно да се приберат обратно в Topics directory (брифа т.10), без
 * stale subscription/crash. Клиентът маха subscription-а си локално при
 * получаване (аналогично на unsubscribe_topic_messages).
 */
export type TopicDeletedMessage = {
  type: 'topic_deleted'
  topicId: string
}

/**
 * Public broadcast при moderator delete на ОТДЕЛНО root съобщение или reply
 * (individual message/reply moderation — различно от TopicDeletedMessage,
 * който е whole-topic delete). Explicit `parentMessageId` snapshot вместо
 * fragile client-side DOM inspection (individual-message-moderation брифа
 * §15): `parentMessageId === null` → target-ът е бил ROOT, клиентът маха
 * root И всички locally-loaded replies към него; `parentMessageId !== null`
 * → target-ът е бил REPLY, клиентът маха само него.
 */
export type TopicMessageDeletedMessage = {
  type: 'topic_message_deleted'
  topicId: string
  messageId: string
  parentMessageId: string | null
  deletedAt: string
}

export type TopicMessageEditedMessage = {
  type: 'topic_message_edited'
  topicId: string
  messageId: string
  parentMessageId: string | null
  body: string
  editedAt: string
}

/**
 * Public broadcast (mute indicator icon брифа §7) — САМО boolean флаг за
 * конкретен профил, НЕ reason/mutedUntil/moderator identity (тези остават
 * private, само в target-only TopicMuteStateChangedMessage push-а и
 * moderator-only unmute popup-а). Изпраща се до ВСИЧКИ connections,
 * активно subscribe-нати за поне една Topics тема в момента — не e
 * per-topic, защото section-wide mute важи навсякъде.
 */
export type TopicProfileMuteStateChangedMessage = {
  type: 'topic_profile_mute_state_changed'
  profileId: string
  isTopicsSectionMuted: boolean
}

export type TopicUnreadCountChangedMessage = {
  type: 'topic_unread_count_changed'
  topicId: string
  unreadCount: number
}

export type TopicSeenUpdatedMessage = {
  type: 'topic_seen_updated'
  topicId: string
  lastSeenSeq: number
  unreadCount: number
}

export type TopicThreadUnreadCountChangedMessage = {
  type: 'topic_thread_unread_count_changed'
  topicId: string
  rootMessageId: string
  unreadCount: number
  topicUnreadCount: number
}

export type TopicThreadSeenUpdatedMessage = {
  type: 'topic_thread_seen_updated'
  topicId: string
  rootMessageId: string
  lastSeenSeq: number
  unreadCount: number
  topicUnreadCount: number
}

export function getDisplayNameFromIdentity(
  identity: PlayerIdentitySnapshot | null | undefined,
): string {
  if (!identity) {
    return 'Играч'
  }

  return identity.displayName?.trim() || 'Играч'
}

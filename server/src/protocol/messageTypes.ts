import type {
  PlayerIdentitySnapshot,
  PlayerGender,
  PlayerPublicProfileSnapshot,
  RoomId,
  RoomStatus,
  Seat,
} from '../core/serverTypes.js'
import type { MatchStake } from '../matchmaking/matchmakingTypes.js'

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
      displayName?: string
    }
  | {
      type: 'join_private_room'
      privateRoomId: string
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

export type ErrorMessage = {
  type: 'error'
  message: string
}

export type PlayerProfileMessage = {
  type: 'player_profile'
  roomId: RoomId
  seat: Seat
  profile: PlayerPublicProfileSnapshot | null
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

export type PrivateRoomMemberSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  isHost: boolean
}

export type PrivateRoomSnapshot = {
  id: string
  kind: 'open' | 'locked'
  stake: MatchStake
  members: PrivateRoomMemberSnapshot[]
  createdAt: number
  expiresAt: number
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

export type PrivateRoomFullMessage = {
  type: 'private_room_full'
  roomId: RoomId
  seat: Seat
  stake: MatchStake
}

// --- Client messages for private rooms ---
// (extends ClientMessage union below)

export type ServerMessage =
  | ConnectedMessage
  | PongMessage
  | ErrorMessage
  | SessionDisplacedMessage
  | SessionInGameMessage
  | PlayerProfileMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomResumedMessage
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
  | PrivateRoomInviteDeclinedMessage
  | PrivateRoomInviteExpiredMessage
  | PrivateRoomInviteCancelledMessage
  | PrivateRoomFriendBusyMessage
  | PrivateRoomMemberLeftMessage
  | PrivateRoomClosedMessage
  | PrivateRoomFullMessage
  | ProfileLikedMessage
  | FriendRequestReceivedMessage
  | FriendRequestCancelledMessage
  | FriendRequestRejectedMessage
  | FriendRequestAcceptedMessage
  | PendingFriendRequestsMessage
  | PendingAcceptanceNotificationsMessage
  | FriendAcceptanceNotificationReadMessage

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

export function getDisplayNameFromIdentity(
  identity: PlayerIdentitySnapshot | null | undefined,
): string {
  if (!identity) {
    return 'Играч'
  }

  return identity.displayName?.trim() || 'Играч'
}

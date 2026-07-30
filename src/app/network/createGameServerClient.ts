export type Seat = 'bottom' | 'right' | 'top' | 'left'
export type Team = 'A' | 'B'
export type RoomStatus = 'waiting' | 'playing' | 'finished'
export type MatchStake = number

export type MatchRoomSnapshot = {
  stakeAmount: number
  minLevel: number
  prizeAmount: number
  isEnabled: boolean
}

export type ClientBidAction =
  | { type: 'pass' }
  | { type: 'suit'; suit: 'clubs' | 'diamonds' | 'hearts' | 'spades' }
  | { type: 'no-trumps' }
  | { type: 'all-trumps' }
  | { type: 'double' }
  | { type: 'redouble' }

export type PlayerGalleryImageSnapshot = {
  imageId: string
  imageUrl: string
  sortOrder: number
}

export type PlayerGender = 'male' | 'female'

export type PlayerPublicProfileSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  skillRating: number | null
  completedGamesCount: number | null
  wonGamesCount: number | null
  currentRankGames: number | null
  nextRankGames: number | null
  gamesUntilNextRank: number | null
  rankProgressRatio: number | null
  averageRating: number | null
  totalRatingsCount: number | null
  yellowCoinsBalance: number | null
  galleryImages: PlayerGalleryImageSnapshot[]
  gender: PlayerGender | null
  isOnline?: boolean
  isBot?: boolean
  likesCount: number | null
  hasLikedByMe: boolean | null
  isBlockedByMe: boolean | null
}

export type TournamentStatus =
  | 'open'
  | 'starting'
  | 'semifinal_in_progress'
  | 'final_in_progress'
  | 'finished'
  | 'cancelled'
  | 'admin_cancelled'
  | 'auto_cancelled'
  | 'failed'

export type TournamentVisibility = 'public' | 'password'
export type TournamentStartMode = 'fill' | 'scheduled'

export type TournamentCreatorSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
}

export type TournamentPrizePreview = {
  totalEntryFees: number
  systemFee: number
  prizePool: number
  firstTeamPrize: number
  secondTeamPrize: number
  firstPlayerPrize: number
  secondPlayerPrize: number
  systemFeePercent: number
  winnerSharePercent: number
  runnerUpSharePercent: number
  financialRulesVersion: string
  persisted: boolean
}

export type TournamentEntryStatus =
  | 'confirmed'
  | 'withdrawn'
  | 'refunded'
  | 'eliminated'
  | 'finalist'
  | 'champion'

export type TournamentViewerParticipation = {
  isParticipant: boolean
  entryStatus: TournamentEntryStatus | null
  joinedAs: 'solo' | 'partner_inviter' | 'partner_invitee' | null
  canJoinSolo: boolean
  canInvitePartner: boolean
  canLeave: boolean
  canCancel: boolean
}

export type TournamentTeamMemberSnapshot = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  joinedAt: string
  joinedAs: 'solo' | 'partner_inviter' | 'partner_invitee'
}

export type TournamentTeamSnapshot = {
  teamId: string
  status: string
  members: TournamentTeamMemberSnapshot[]
}

export type TournamentMatchStatus =
  | 'awaiting_players'
  | 'countdown'
  | 'in_progress'
  | 'completed'
  | 'walkover'
  | 'cancelled'

export type TournamentRoundType = 'semifinal' | 'final'

export type TournamentMatchSnapshot = {
  matchId: string
  roundId: string
  roomId: string | null
  teamAId: string
  teamBId: string
  status: TournamentMatchStatus
  winnerTeamId: string | null
  resultKind: string | null
  roomReady: boolean
  attendance?: {
    state: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed'
    deadlineAt: string | null
    secondsRemaining: number
    resolutionKind: 'all_present' | 'walkover' | 'bots_inserted' | null
    gameStartAt: string | null
    startSecondsRemaining: number
  }
  progressLabel?: string
  startedAt: string | null
  completedAt: string | null
}

export type TournamentRoundSnapshot = {
  roundId: string
  roundType: TournamentRoundType
  roundIndex: number
  matches: TournamentMatchSnapshot[]
}

export type TournamentMatchAssignmentSnapshot = {
  tournamentId: string
  tournamentName: string
  matchId: string
  roomId: string
  roundType: TournamentRoundType
  seat: Seat
  teamId: string
  partnerProfileId: string
  opponentTeamId: string
  reconnectToken: string | null
}

export type TournamentPartnerInviteSnapshot = {
  inviteId: string
  tournamentId: string
  teamId: string
  inviterProfileId: string
  inviteeProfileId: string
  inviter: TournamentCreatorSnapshot
  invitee: TournamentCreatorSnapshot
  status: string
  expiresAt: string
  popupDismissedAt: string | null
  notificationReadAt: string | null
  createdAt: string
  respondedAt: string | null
  tournamentName?: string
  entryFee?: number
  startMode?: TournamentStartMode
  scheduledStartAt?: string | null
}

export type TournamentPartnerCandidateSnapshot = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  online: boolean
  eligible: boolean
  unavailableReason: string | null
}

export type TournamentSummarySnapshot = {
  tournamentId: string
  name: string
  creator: TournamentCreatorSnapshot
  visibility: TournamentVisibility
  requiresPassword: boolean
  status: TournamentStatus
  statusLabel: string
  entryFee: number
  playerCapacity: number
  confirmedEntriesCount: number
  reservedPlacesCount: number
  occupiedPlacesCount: number
  completedTeamsCount: number
  formingTeamsCount: number
  availablePlaces: number
  isFull: boolean
  startMode: TournamentStartMode
  scheduledStartAt: string | null
  createdAt: string
  prizePreview: TournamentPrizePreview
  isMine: boolean
  viewer: TournamentViewerParticipation
}

export type TournamentDetailSnapshot = TournamentSummarySnapshot & {
  cancelReason: string | null
  startedAt: string | null
  finishedAt: string | null
  myTeam: TournamentTeamSnapshot | null
  teams: TournamentTeamSnapshot[]
  rounds: TournamentRoundSnapshot[]
  myActiveMatch: TournamentMatchAssignmentSnapshot | null
  incomingPartnerInvite: TournamentPartnerInviteSnapshot | null
  outgoingPartnerInvite: TournamentPartnerInviteSnapshot | null
}

export type TournamentCreateInput = {
  name: string
  entryFee: number
  visibility: TournamentVisibility
  password?: string
  startMode: TournamentStartMode
  scheduledStartAt?: string
}

export type TournamentJoinEntrySnapshot = {
  entryId: string
  status: TournamentEntryStatus
  joinedAs: 'solo' | 'partner_inviter' | 'partner_invitee'
  createdAt: string
}

export type FriendshipStatus = 'pending' | 'accepted'
export type FriendshipDirection = 'incoming' | 'outgoing' | 'accepted'

export type FriendRelationshipSnapshot = {
  friendshipId: string
  status: FriendshipStatus
  direction: FriendshipDirection
  profile: PlayerPublicProfileSnapshot
  createdAt: string
  updatedAt: string
  isOnline?: boolean
  isInGame?: boolean
}

export type FriendshipsSnapshot = {
  incomingPending: FriendRelationshipSnapshot[]
  outgoingPending: FriendRelationshipSnapshot[]
  friends: FriendRelationshipSnapshot[]
}

export type ChatAttachmentSnapshot = {
  attachmentId: string
  width: number
  height: number
  byteSize: number
  viewUrl: string
  downloadUrl: string
}

export type ChatMessageSnapshot = {
  messageId: string
  friendshipId: string
  senderProfileId: string
  body: string
  createdAt: string
  isOwnMessage: boolean
  attachment: ChatAttachmentSnapshot | null
}

export type ChatConversationSnapshot = {
  friendshipId: string
  friend: PlayerPublicProfileSnapshot
  lastMessage: ChatMessageSnapshot | null
  updatedAt: string
  unreadCount: number
}

export type LeaderboardCategory = 'balance' | 'rank' | 'wins' | 'rating'

export type LeaderboardsSnapshot = Record<
  LeaderboardCategory,
  PlayerPublicProfileSnapshot[]
>

export type DailyRewardTierSnapshot = {
  tierId: string
  sortOrder: number
  yellowCoinsAmount: number
  claimedToday?: boolean
}

export type SupportMessageSnapshot = {
  messageId: string
  profileId: string
  body: string
  isFromAdmin: boolean
  createdAt: string
}

export type SupportConversationSnapshot = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  lastMessageBody: string
  lastMessageIsFromAdmin: boolean
  unreadByAdmin: number
  updatedAt: string
}

export type GuestContactMessageListItem = {
  messageId: string
  name: string
  email: string
  subject: string
  createdAt: string
  readByAdmin: boolean
  emailDeliveryStatus: 'pending' | 'sent' | 'failed'
  preview: string
}

export type AdminSettingsSnapshot = {
  signupBonusYellowCoins: number
  profileNameChangePrice: number
}

export type AdminPaymentPeriodStats = {
  count: number
  totalCents: number
}

export type AdminVisitorSummary = {
  today: number
  yesterday: number
  last7days: number
  last30days: number
  newToday: number
  newYesterday: number
}

export type AdminViewLayoutPeriodCounts = {
  mobile: number
  desktop: number
}

export type AdminViewLayoutSummary = {
  today: AdminViewLayoutPeriodCounts
  yesterday: AdminViewLayoutPeriodCounts
  last7days: AdminViewLayoutPeriodCounts
  last30days: AdminViewLayoutPeriodCounts
}

export type AdminRegisteredProfilesStats = {
  total: number
  today: number
  yesterday: number
}

export type AdminGamesPlayedStats = {
  userGamesToday: number
  userGamesYesterday: number
  guestTrialGamesToday: number
  guestTrialGamesYesterday: number
}

export type AdminStatsSnapshot = {
  onlineCount: number
  registeredProfiles: AdminRegisteredProfilesStats
  payments: {
    today: AdminPaymentPeriodStats
    yesterday: AdminPaymentPeriodStats
    last7days: AdminPaymentPeriodStats
    thisMonth: AdminPaymentPeriodStats
    allTime: AdminPaymentPeriodStats
  }
  visitors: AdminVisitorSummary
  viewLayout: AdminViewLayoutSummary
  gamesPlayed: AdminGamesPlayedStats
}

export type VisitorListPeriod = 'today' | 'yesterday' | '7d' | '30d'
export type VisitorListType = 'all' | 'guest' | 'registered'
export type VisitorDeviceFilter = 'all' | 'mobile' | 'desktop' | 'tablet' | 'unknown'
export type VisitorOsFilter = 'all' | 'android' | 'ios' | 'windows' | 'macos' | 'linux' | 'chromeos' | 'unknown'
export type AdminVisitorsView = 'visitors' | 'sources'

export type AdminVisitorSourceRow = {
  label: string
  visitors: number
  percent: number
}

export type AdminVisitorSourcesResult = {
  rows: AdminVisitorSourceRow[]
  total: number
}

export type AdminVisitorRow = {
  anonymousVisitorId: string
  isRegistered: boolean
  displayName: string | null
  email: string | null
  lastIpAddress: string | null
  lastDeviceType: string | null
  lastOsType: string | null
  firstSource: string | null
  firstReferrer: string | null
  firstSeenAt: string
  lastSeenAt: string
  pageViews: number
  reloads: number
}

export type AdminVisitorListResult = {
  rows: AdminVisitorRow[]
  total: number
}

export type CoinPackageStatus = 'active' | 'inactive'

export type CoinPackageSnapshot = {
  packageId: string
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  status: CoinPackageStatus
  sortOrder: number
  showInLobby: boolean
  isTopOffer: boolean
}

export type CoinPackageInput = {
  packageId?: string | null
  packageKey: string
  title: string
  description: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  status: CoinPackageStatus
  sortOrder: number
  showInLobby: boolean
  isTopOffer: boolean
}

export type MissionType =
  | 'win_games'
  | 'win_capot_games'
  | 'win_contra_games'
  | 'play_games'
  | 'announce_tersa'
  | 'announce_50'
  | 'announce_100'
  | 'announce_kare'
  | 'announce_belot'

export type MissionTemplateSnapshot = {
  missionId: string
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  isActive: boolean
  isStaged: boolean
  sortOrder: number
}

export type MissionTemplateInput = {
  missionId?: string | null
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  isStaged?: boolean
  sortOrder?: number
}

export type AdminMissionsResponse = {
  ok: true
  activeMissions: MissionTemplateSnapshot[]
  stagedMissions: MissionTemplateSnapshot[]
}

export type PlayerMissionProgressSnapshot = {
  progressId: string
  missionId: string
  missionType: MissionType
  title: string
  targetCount: number
  rewardYellowCoins: number
  progressCount: number
  isClaimed: boolean
  isCompleted: boolean
}

export type DailyMissionsResponse = {
  ok: true
  missions: PlayerMissionProgressSnapshot[]
  unclaimedCount: number
  date: string
}

export type CoinPurchaseStatus = 'pending' | 'paid' | 'canceled' | 'failed'

export type CoinPurchaseSnapshot = {
  purchaseId: string
  packageId: string | null
  packageKey: string
  title: string
  yellowCoinsAmount: number
  priceCents: number
  currency: string
  provider: string
  providerCheckoutSessionId: string | null
  status: CoinPurchaseStatus
  creditedAt: string | null
  hiddenAt: string | null
  createdAt: string
  updatedAt: string
}

export type CoinCheckoutResponse =
  | {
      ok: true
      checkoutUrl: string
      checkoutSessionId: string
      purchase: CoinPurchaseSnapshot
    }
  | {
      ok: false
      message: string
    }

export type CoinResumeCheckoutResponse =
  | {
      ok: true
      checkoutUrl: string
      purchase: CoinPurchaseSnapshot
    }
  | {
      ok: false
      message: string
    }

export type CoinHidePurchaseResponse =
  | {
      ok: true
      purchases: CoinPurchaseSnapshot[]
    }
  | {
      ok: false
      message: string
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
      roomId: string
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
      roomId: string
      seat: Seat
    }
  | {
      type: 'resume_room'
      roomId: string
      reconnectToken: string
    }
  | {
      type: 'leave_active_room'
      roomId: string
      acceptPenalty?: boolean
    }
  | {
      type: 'submit_bid_action'
      roomId: string
      action: ClientBidAction
    }
  | {
      type: 'submit_cut_index'
      roomId: string
      cutIndex: number
    }
  | {
      type: 'submit_play_card'
      roomId: string
      cardId: string
      declarationKeys?: string[]
    }
  | {
      type: 'resume_human_control'
      roomId: string
    }
  | {
      type: 'submit_partner_rating'
      roomId: string
      ratingValue: number
    }
  | {
      type: 'request_replay'
      roomId: string
    }
  | {
      type: 'request_leave_match'
      roomId: string
    }
  | {
      type: 'send_emoji_reaction'
      roomId: string
      emojiId: string
    }
  | {
      type: 'send_phrase_reaction'
      roomId: string
      phraseId: string
    }
  | {
      type: 'create_private_room'
      stake: MatchStake
      isLocked: boolean
      waitMinutes: 5 | 10 | 15 | 30
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
  | {
      type: 'fill_private_room_with_bots'
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
  team: Team
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
  winnerTeam: Team
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

export type RoomCreatedMessage = {
  type: 'room_created'
  roomId: string
  seat: Seat
  hostDisplayName: string
}

export type RoomJoinedMessage = {
  type: 'room_joined'
  roomId: string
  seat: Seat
  displayName: string
}

export type RoomResumedMessage = {
  type: 'room_resumed'
  roomId: string
  seat: Seat
}

export type RoomResumeFailedMessage = {
  type: 'room_resume_failed'
  roomId: string
  message: string
}

export type ActiveRoomLeftMessage = {
  type: 'left_active_room'
  roomId: string
  removed: boolean
  penalty?: {
    penaltyAmount: number
    chargedAmount: number
    balanceAfter: number
  }
}

export type PartnerRatingSubmittedMessage = {
  type: 'partner_rating_submitted'
  roomId: string
  ratingValue: number
  raterDisplayName: string
}

export type RoomSnapshotMessage = {
  type: 'room_snapshot'
  roomId: string
  roomStatus: RoomStatus
  yourSeat: Seat | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game?: RoomGameSnapshot | null
  stakeAmount: number | null
  isGuestTrial: boolean
  isPrivateTableOrigin: boolean
  isTournamentMatchOrigin: boolean
  tournamentAttendance?: TournamentAttendanceSnapshot | null
  tournamentBotReplacements?: TournamentBotReplacementSnapshot[]
  tournamentBanners?: TournamentRoomBannerSnapshot[]
}

export type TournamentAttendancePlayerSummary = {
  seat: Seat
  team: 'A' | 'B'
  displayName: string
  avatarUrl: string | null
}

export type TournamentAttendanceSnapshot = {
  state: 'waiting' | 'resolved' | 'countdown' | 'started' | 'completed'
  serverNow: string
  deadlineAt: string | null
  secondsRemaining: number
  missingPlayers: TournamentAttendancePlayerSummary[]
  missingByTeam: Record<'A' | 'B', TournamentAttendancePlayerSummary[]>
  resolutionKind: 'all_present' | 'walkover' | 'bots_inserted' | null
  gameStartAt: string | null
  startSecondsRemaining: number
  walkover: {
    winnerTeamId: string
    loserTeamId: string
    reason: string
    completedAt: string
  } | null
}

export type TournamentBotReplacementSnapshot = {
  seat: Seat
  replacedPlayer: TournamentAttendancePlayerSummary
  takeoverAvailableForMe: boolean
  takeoverPending: boolean
  takeoverCompleted: boolean
  replacementActive: boolean
}

export type TournamentRoomBannerSnapshot = {
  id: string
  kind: 'bots_inserted' | 'takeover_pending' | 'takeover_completed'
  message: string
  createdAt: string
  expiresAt: string
}

export type PlayerProfileMessage = {
  type: 'player_profile'
  roomId: string
  seat: Seat
  profile: PlayerPublicProfileSnapshot | null
}

export type ChatMessageReceivedMessage = {
  type: 'chat_message_received'
  friendshipId: string
  senderProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
  messageId: string
  shouldNotify: boolean
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
  stake: number
}

export type SessionDisplacedMessage = {
  type: 'session_displaced'
}

export type SessionInGameMessage = {
  type: 'session_in_game'
  roomId: string
  reconnectToken: string
}

export type MatchFoundMessage = {
  type: 'match_found'
  roomId: string
  seat: Seat
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
}

export type EmojiReactionMessage = {
  type: 'emoji_reaction'
  roomId: string
  seat: Seat
  emojiId: string
}

export type PhraseReactionMessage = {
  type: 'phrase_reaction'
  roomId: string
  seat: Seat
  phraseId: string
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
  roomId: string
  seat: Seat
  stake: MatchStake
}

export type PrivateRoomCreatedNoticeMessage = {
  type: 'private_room_created_notice'
  notificationId: string
  creatorDisplayName: string
  creatorAvatarUrl: string | null
  recipientInActiveGame: boolean
}

// --- Чат в чакалнята на частна маса (изолиран от lobby/friend/game chat) ---

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

export type PrivateRoomChatMessageEventMessage = PrivateRoomChatMessageSnapshot & {
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

export type CoinsGiftedMessage = {
  type: 'coins_gifted'
  amount: number
  fromDisplayName: string
  recipientNewBalance: number
}

export type PendingGiftNotificationsMessage = {
  type: 'pending_gift_notifications'
  gifts: Array<{ giftId: string; amount: number; fromDisplayName: string }>
}

export type TournamentPartnerInviteReceivedMessage = {
  type: 'tournament_partner_invite_received'
  invite: TournamentPartnerInviteSnapshot
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

export type TournamentMatchAssignedMessage = {
  type: 'tournament_match_assigned'
  assignment: TournamentMatchAssignmentSnapshot
}

// --- Общ лайв чат в лобито (разделен от ChatMessageReceivedMessage — това
// е публичен broadcast поток, не 1:1 нотификация между приятели) ---

export type LobbyChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string
  senderDisplayName: string
  /** Snapshot към момента на изпращане — само за оцветяване на името в чата. */
  senderIsChatAdmin: boolean
  body: string
  createdAt: string
}

export type LobbyChatHistoryMessage = {
  type: 'lobby_chat_history'
  messages: LobbyChatMessageSnapshot[]
}

export type LobbyChatMessageEventMessage = LobbyChatMessageSnapshot & {
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

export type ServerMessage =
  | ConnectedMessage
  | PongMessage
  | ErrorMessage
  | GuestTrialErrorMessage
  | GuestTrialStatusMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | RoomResumedMessage
  | RoomResumeFailedMessage
  | ActiveRoomLeftMessage
  | PartnerRatingSubmittedMessage
  | RoomSnapshotMessage
  | PlayerProfileMessage
  | ChatMessageReceivedMessage
  | MatchmakingJoinedMessage
  | MatchmakingStatusMessage
  | MatchmakingLeftMessage
  | MatchmakingExpiredMessage
  | MatchFoundMessage
  | SessionDisplacedMessage
  | SessionInGameMessage
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
  | PrivateRoomCreatedNoticeMessage
  | PrivateRoomChatHistoryMessage
  | PrivateRoomChatMessageEventMessage
  | PrivateRoomChatErrorMessage
  | ProfileLikedMessage
  | FriendRequestReceivedMessage
  | FriendRequestCancelledMessage
  | FriendRequestRejectedMessage
  | FriendRequestAcceptedMessage
  | PendingFriendRequestsMessage
  | PendingAcceptanceNotificationsMessage
  | FriendAcceptanceNotificationReadMessage
  | CoinsGiftedMessage
  | PendingGiftNotificationsMessage
  | TournamentPartnerInviteReceivedMessage
  | TournamentPartnerInvitePopupDismissedMessage
  | TournamentPartnerInviteResolvedMessage
  | TournamentMatchAssignedMessage
  | LobbyChatHistoryMessage
  | LobbyChatMessageEventMessage
  | LobbyChatMessageDeletedMessage
  | LobbyChatErrorMessage

type CreateGameServerClientOptions = {
  url?: string
  onOpen?: () => void
  onClose?: () => void
  onError?: (event: Event) => void
  onMessage?: (message: ServerMessage) => void
}

export type GameServerClient = {
  connect: () => void
  disconnect: () => void
  isConnected: () => boolean
  ping: () => void
  createRoom: (displayName?: string) => void
  joinRoom: (roomId: string, displayName?: string) => void
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  joinGuestTrial: (stake: MatchStake) => void
  leaveMatchmaking: () => void
  requestPlayerProfile: (roomId: string, seat: Seat) => void
  resumeRoom: (roomId: string, reconnectToken: string) => void
  leaveActiveRoom: (roomId: string, acceptPenalty?: boolean) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => void
  resumeHumanControl: (roomId: string) => void
  submitPartnerRating: (roomId: string, ratingValue: number) => void
  sendReplayVote: (roomId: string) => void
  sendLeaveMatchVote: (roomId: string) => void
  sendEmojiReaction: (roomId: string, emojiId: string) => void
  sendPhraseReaction: (roomId: string, phraseId: string) => void
  requestPrivateRoomsList: () => void
  createPrivateRoom: (stake: MatchStake, isLocked: boolean, waitMinutes: 5 | 10 | 15 | 30) => void
  joinPrivateRoom: (privateRoomId: string) => void
  leavePrivateRoom: () => void
  inviteToPrivateRoom: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  cancelPrivateRoomInvite: (inviteId: string) => void
  respondPrivateRoomInvite: (inviteId: string, accept: boolean) => void
  fillPrivateRoomWithBots: () => void
  subscribePrivateRoomChat: (privateRoomId: string) => void
  unsubscribePrivateRoomChat: (privateRoomId: string) => void
  sendPrivateRoomChatMessage: (privateRoomId: string, body: string, requestId?: string) => void
  subscribeLobbyChat: () => void
  unsubscribeLobbyChat: () => void
  sendLobbyChatMessage: (body: string, requestId?: string) => void
}

function getDefaultServerUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:3001/ws`
  }
  return `${protocol}//${window.location.host}/ws`
}

function isServerMessage(value: unknown): value is ServerMessage {
  return typeof value === 'object' && value !== null && 'type' in value
}

function safeParseServerMessage(rawText: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(rawText) as unknown

    if (!isServerMessage(parsed)) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

export function createGameServerClient(
  options: CreateGameServerClientOptions = {},
): GameServerClient {
  const url = options.url ?? getDefaultServerUrl()
  let socket: WebSocket | null = null

  function send(message: ClientMessage): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn('[game-server] socket is not open')
      return
    }

    socket.send(JSON.stringify(message))
  }

  function connect(): void {
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      return
    }

    socket = new WebSocket(url)

    socket.addEventListener('open', () => {
      options.onOpen?.()
    })

    socket.addEventListener('close', () => {
      socket = null
      options.onClose?.()
    })

    socket.addEventListener('error', (event) => {
      options.onError?.(event)
    })

    socket.addEventListener('message', (event) => {
      const message = safeParseServerMessage(String(event.data))

      if (!message) {
        console.warn('[game-server] invalid server message:', event.data)
        return
      }

      console.log('[game-server] message', message.type, message)
      options.onMessage?.(message)
    })
  }

  function disconnect(): void {
    if (!socket) {
      return
    }

    socket.close()
    socket = null
  }

  function isConnected(): boolean {
    return socket?.readyState === WebSocket.OPEN
  }

  function ping(): void {
    send({ type: 'ping' })
  }

  function createRoom(displayName?: string): void {
    send({
      type: 'create_room',
      displayName,
    })
  }

  function joinRoom(roomId: string, displayName?: string): void {
    send({
      type: 'join_room',
      roomId,
      displayName,
    })
  }

  function joinMatchmaking(stake: MatchStake, displayName?: string): void {
    send({
      type: 'join_matchmaking',
      stake,
      displayName,
    })
  }

  function leaveMatchmaking(): void {
    send({
      type: 'leave_matchmaking',
    })
  }

  function joinGuestTrial(stake: MatchStake): void {
    send({
      type: 'join_guest_trial',
      stake,
    })
  }

  function requestPlayerProfile(roomId: string, seat: Seat): void {
    send({
      type: 'request_player_profile',
      roomId,
      seat,
    })
  }

  function resumeRoom(roomId: string, reconnectToken: string): void {
    send({
      type: 'resume_room',
      roomId,
      reconnectToken,
    })
  }

  function leaveActiveRoom(roomId: string, acceptPenalty = false): void {
    send({
      type: 'leave_active_room',
      roomId,
      acceptPenalty,
    })
  }

  function submitBidAction(roomId: string, action: ClientBidAction): void {
    send({
      type: 'submit_bid_action',
      roomId,
      action,
    })
  }

  function submitCutIndex(roomId: string, cutIndex: number): void {
    send({
      type: 'submit_cut_index',
      roomId,
      cutIndex,
    })
  }

  function submitPlayCard(
    roomId: string,
    cardId: string,
    declarationKeys: string[] = [],
  ): void {
    send({
      type: 'submit_play_card',
      roomId,
      cardId,
      declarationKeys,
    })
  }

  function resumeHumanControl(roomId: string): void {
    send({
      type: 'resume_human_control',
      roomId,
    })
  }

  function submitPartnerRating(roomId: string, ratingValue: number): void {
    send({
      type: 'submit_partner_rating',
      roomId,
      ratingValue,
    })
  }

  function sendReplayVote(roomId: string): void {
    send({
      type: 'request_replay',
      roomId,
    })
  }

  function sendLeaveMatchVote(roomId: string): void {
    send({
      type: 'request_leave_match',
      roomId,
    })
  }

  function sendEmojiReaction(roomId: string, emojiId: string): void {
    send({
      type: 'send_emoji_reaction',
      roomId,
      emojiId,
    })
  }

  function sendPhraseReaction(roomId: string, phraseId: string): void {
    send({
      type: 'send_phrase_reaction',
      roomId,
      phraseId,
    })
  }

  function requestPrivateRoomsList(): void {
    send({ type: 'request_private_rooms_list' })
  }

  function createPrivateRoom(stake: MatchStake, isLocked: boolean, waitMinutes: 5 | 10 | 15 | 30): void {
    send({ type: 'create_private_room', stake, isLocked, waitMinutes })
  }

  function joinPrivateRoom(privateRoomId: string): void {
    send({ type: 'join_private_room', privateRoomId })
  }

  function leavePrivateRoom(): void {
    send({ type: 'leave_private_room' })
  }

  function inviteToPrivateRoom(toProfiles: Array<{ profileId: string; displayName: string }>): void {
    send({ type: 'invite_to_private_room', toProfiles })
  }

  function cancelPrivateRoomInvite(inviteId: string): void {
    send({ type: 'cancel_private_room_invite', inviteId })
  }

  function respondPrivateRoomInvite(inviteId: string, accept: boolean): void {
    send({ type: 'respond_private_room_invite', inviteId, accept })
  }

  function fillPrivateRoomWithBots(): void {
    send({ type: 'fill_private_room_with_bots' })
  }

  function subscribePrivateRoomChat(privateRoomId: string): void {
    send({ type: 'subscribe_private_room_chat', privateRoomId })
  }

  function unsubscribePrivateRoomChat(privateRoomId: string): void {
    send({ type: 'unsubscribe_private_room_chat', privateRoomId })
  }

  function sendPrivateRoomChatMessage(privateRoomId: string, body: string, requestId?: string): void {
    send({ type: 'send_private_room_chat_message', privateRoomId, body, requestId })
  }

  function subscribeLobbyChat(): void {
    send({ type: 'subscribe_lobby_chat' })
  }

  function unsubscribeLobbyChat(): void {
    send({ type: 'unsubscribe_lobby_chat' })
  }

  function sendLobbyChatMessage(body: string, requestId?: string): void {
    send({ type: 'send_lobby_chat_message', body, requestId })
  }

  return {
    connect,
    disconnect,
    isConnected,
    ping,
    createRoom,
    joinRoom,
    joinMatchmaking,
    joinGuestTrial,
    leaveMatchmaking,
    requestPlayerProfile,
    resumeRoom,
    leaveActiveRoom,
    submitBidAction,
    submitCutIndex,
    submitPlayCard,
    resumeHumanControl,
    submitPartnerRating,
    sendReplayVote,
    sendLeaveMatchVote,
    sendEmojiReaction,
    sendPhraseReaction,
    requestPrivateRoomsList,
    createPrivateRoom,
    joinPrivateRoom,
    leavePrivateRoom,
    inviteToPrivateRoom,
    cancelPrivateRoomInvite,
    respondPrivateRoomInvite,
    fillPrivateRoomWithBots,
    subscribePrivateRoomChat,
    unsubscribePrivateRoomChat,
    sendPrivateRoomChatMessage,
    subscribeLobbyChat,
    unsubscribeLobbyChat,
    sendLobbyChatMessage,
  }
}

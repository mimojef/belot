import type {
  BelotSpectatorSnapshotMessage,
  ClientBidAction,
  MatchFoundMessage,
  MatchStake,
  RoomCompletedTrickSnapshot,
  RoomCuttingSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomStatus,
  Seat,
  ServerMessage,
  TournamentAttendanceSnapshot,
  TournamentDetailSnapshot,
  TournamentRoundType,
  TournamentBotReplacementSnapshot,
  TournamentRoomBannerSnapshot,
} from '../network/createGameServerClient'
import type { GameAudioController } from '../audio/createGameAudioController'
import type { PendingDeclarationPrompt } from './declarations/declarationPromptTypes'

export type ActiveRoomState = {
  roomId: string
  /**
   * Phase 3B viewer model — `seat` остава САМО perspectiveSeat (visual
   * rotation/geometry/layout, напр. getVisualSeatForLocalPerspective), не
   * "кой съм аз за decision логика". За participant `seat` си е реалното
   * място, непроменено от преди. За Belot spectator `seat` е ФИКСИРАНО
   * 'bottom' — чисто координатна перспектива, НЕ значи spectator-ът "е"
   * bottom играчът.
   *
   * `controlledSeat` е единственият достоверен сигнал за "моя decision/
   * turn/bot-takeover/countdown-warning/gift/profile interaction" — Seat за
   * participant (= seat), null за spectator. Виж §2 брифа "VIEWER MODEL".
   */
  seat: Seat
  viewerRole: 'participant' | 'spectator'
  controlledSeat: Seat | null
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
  roomStatus: RoomStatus | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game: RoomGameSnapshot | null
  isConnected: boolean
  errorText: string | null
  leavePenaltyWarningOpen: boolean
  isGuestTrial: boolean
  isPrivateTableOrigin: boolean
  isTournamentMatchOrigin: boolean
  tournamentId: string | null
  tournamentMatchId: string | null
  tournamentRoundType: TournamentRoundType | null
  tournamentAttendance: TournamentAttendanceSnapshot | null
  tournamentBotReplacements: TournamentBotReplacementSnapshot[]
  tournamentBanners: TournamentRoomBannerSnapshot[]
  /**
   * Активни table gift overlay-и, keyed по АБСОЛЮТЕН recipient seat.
   * Нов подарък към същия получател заменя стария (server-side overwrite).
   * Reconnect-safe: пълни се и от room_snapshot.activeTableGifts, така че
   * след reconnect overlay-ът се възстановява с ОСТАВАЩОТО време, без
   * повторно пускане на летящата анимация.
   */
  activeTableGiftOverlays: Partial<Record<Seat, ActiveTableGiftOverlay>>
}

export type ActiveTableGiftOverlay = {
  transactionId: string
  giftItemId: string
  giftName: string
  imageUrl: string
  /** null само за подарък от Belot spectator. */
  senderSeat: Seat | null
  senderDisplayName: string
  expiresAt: string
  /** 'spectator' -> след live landing се показва "От {senderDisplayName}" (4 s). */
  senderKind: 'participant' | 'spectator'
}

export type CreateActiveRoomFlowControllerOptions = {
  root: HTMLDivElement
  gameAudio?: GameAudioController
  isConnected: () => boolean
  leaveActiveRoom: (roomId: string, acceptPenalty?: boolean) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  submitBidAction: (roomId: string, action: ClientBidAction) => void
  submitPlayCard: (roomId: string, cardId: string, declarationKeys?: string[]) => void
  submitSweepDecision?: (roomId: string, decision: 'accept' | 'decline') => void
  resumeHumanControl: (roomId: string) => void
  submitPartnerRating: (roomId: string, ratingValue: number, requestId: string) => void
  sendReplayVote: (roomId: string) => void
  sendLeaveMatchVote: (roomId: string) => void
  sendEmojiReaction: (roomId: string, emojiId: string) => void
  sendPhraseReaction: (roomId: string, phraseId: string) => void
  /** Table gift (Stage 2) — WS action, mirror на останалите gameplay actions. */
  sendTableGift?: (
    roomId: string,
    recipientProfileId: string,
    giftItemId: string,
    requestId: string,
  ) => void
  /** Fresh catalog fetch при всяко отваряне на in-game селектора. */
  onGiftItemCatalogLoad?: () => Promise<
    | { ok: true; items: Array<{ giftItemId: string; name: string; imageUrl: string; price: number }> }
    | { ok: false; message: string }
  >
  /** Reuse на СЪЩОТО authSession balance поле, което ползва и lobby-то. */
  getAuthSession?: () => { profile: { yellowCoinsBalance: number | null } } | null
  requestPlayerProfile: (roomId: string, seat: Seat) => void
  getFriendshipAction: (profileId: string) => import('../../ui/overlays/renderPlayerProfilePopup').PlayerProfileFriendshipAction | null
  onSendFriendRequest: (profileId: string) => Promise<{ ok: true; newLabel: string } | { ok: false; message: string }>
  onLikeProfile: (profileId: string) => Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }>
  onBlockProfile: (profileId: string) => Promise<{ message: string }>
  /**
   * Пълен authoritative block резултат (не truncated {message}) — само за
   * "Блокирай" от access-denial popup-а (target has blocked viewer), където
   * трябва да различим success/failure/limitReached, за да управляваме
   * pending/error/success inline state коректно. Reuse-ва СЪЩИЯ endpoint
   * като onBlockProfile по-горе (виж main.ts wiring-а — и двата викат
   * submitProfileBlock), не втори мрежов път.
   */
  onBlockProfileFull: (profileId: string) => Promise<{ blocked: boolean } | { ok: false; message: string; limitReached?: true }>
  /** leftRoomId — стаята, от която играчът реално/логически излиза точно в
   * този момент (ако има такава) — позволява на извикващия (main.ts) да
   * изчисти всякакъв global "stale" state, обвързан конкретно с тази стая
   * (напр. tournamentMatchStartPopup assignment), без да засяга state за
   * друга, все още валидна стая/assignment. */
  showLobby: (errorText?: string | null, leftRoomId?: string | null) => void
  startNewGame: (stake: MatchStake, displayName?: string) => void
  onGuestTrialReplayRequested: () => void
  fetchTournamentDetail: (tournamentId: string) => Promise<TournamentDetailSnapshot | null>
  acknowledgeTournamentSemifinalResult: (tournamentId: string, semifinalMatchId: string) => void
  onEnterWaitingForNextTournamentRound: (
    feeder: { tournamentId: string; label: string; scoreA: number | null; scoreB: number | null; status: 'in_progress' | 'completed' } | null,
    tournamentId: string,
    result: { currentRoundType: TournamentRoundType; semifinalScoreA: number | null; semifinalScoreB: number | null },
  ) => void
  onTournamentFinalResultContinue: (tournamentId: string) => void
  // Bid-response watchdog fallback (виж submitBidActionFromUi/handleBidWatchdogExpired
  // в createActiveRoomFlowController.ts): помолва main.ts да опита съществуващия
  // resume_room round-trip на текущия socket, без да го затваря/пресъздава.
  requestBidResync: () => void
  // Ако дори resync round-trip-ът не отговори навреме (вероятно "zombie" socket
  // — readyState изглежда OPEN, но нищо реално не се доставя), помолва main.ts
  // да задейства СЪЩЕСТВУВАЩИЯ disconnect->reconnect->resume механизъм.
  forceReconnectForZombieConnection: () => void
  // Belot Spectator Mode ("Гледай", Phase 3B) — "Изход" бутон, докато
  // viewerRole==='spectator', НИКОГА не минава през leaveActiveRoom (без
  // penalty warning, без participant leave semantics). Вика се САМО с
  // roomId — main.ts оркестрира unwatch_belot_room + lobby navigation (виж
  // §14 брифа "Използвай същия navigation helper като Exit").
  onSpectatorExitRequested: (roomId: string) => void
}

export type ActiveRoomFlowController = {
  render: () => void
  enterActiveRoom: (message: MatchFoundMessage, stakeAlreadyShown?: boolean) => void
  enterActiveRoomFromResume: (roomId: string, seat: Seat, stake: MatchStake) => void
  // Belot Spectator Mode ("Гледай", Phase 3B) — отваря activeRoom viewer-а
  // за spectator с ПЪРВИЯ валиден belot_spectator_snapshot (виж §4/§5
  // брифа). НЕ приема reconnectToken/controlled seat, НЕ attach-ва
  // participant semantics, НЕ изпраща resume/join.
  enterActiveRoomAsSpectator: (roomId: string, snapshot: BelotSpectatorSnapshotMessage) => void
  // Последващ belot_spectator_snapshot за ВЕЧЕ отворен spectator view —
  // mirror на applyRoomSnapshotToActiveRoom, но за spectator envelope.
  // Връща false ако няма отворен spectator view за точно тази roomId.
  applySpectatorSnapshotToActiveRoom: (snapshot: BelotSpectatorSnapshotMessage) => boolean
  // Затваря spectator view locally (immediate, optimistic — виж §14 брифа:
  // "ако server unwatch ACK се забави, UX не трябва да остане блокиран").
  // No-op ако текущият view не е spectator view. Използва се И от explicit
  // "Изход", И от belot_spectate_ended/denied-while-viewing — една cleanup
  // пътека (виж §15 брифа "не дублирай два различни cleanup flow-а").
  exitSpectatorView: () => void
  isSpectatorView: () => boolean
  handleServerMessage: (message: ServerMessage) => boolean
  completePendingTournamentRoundResultTransition: () => boolean
  getResumeInfo: () => { roomId: string; reconnectToken: string } | null
  setConnected: (value: boolean) => void
  setConnectionError: (message: string | null) => void
  setConnectionState: (isConnected: boolean, message: string | null) => void
  leaveActiveRoom: () => void
  hasActiveRoom: () => boolean
  // "Реален участник" (seat/decision rights), за разлика от hasActiveRoom()
  // (= "activeRoom view е отворен", вярно и за spectator). Виж §3 брифа.
  isActiveRoomParticipant: () => boolean
  getActiveNonTournamentRoomInfo: () => { roomId: string; stakeAmount: number } | null
  getCurrentRoomId: () => string | null
  // STATE B silent attach (§ "SILENT ATTACH") — arms a watch for roomId's
  // room_snapshot stream (already flowing on the shared WS connection after
  // resume_room {silent:true} → room_attached_silent) so the controller can
  // call enterActiveRoomFromResume itself the instant
  // tournamentAttendance.state reaches 'started'/'completed' (or is absent),
  // WITHOUT the lobby ever calling enterActiveRoomFromResume directly and
  // WITHOUT any client-side wall-clock timeout. Idempotent per roomId.
  armPendingTournamentSilentEntry: (input: { roomId: string; seat: Seat; stake: MatchStake }) => void
  // Counterpart used when a silent resume_room is known to have failed (e.g.
  // room_resume_failed) so a retry for the same roomId isn't blocked by the
  // stale watch from the failed attempt.
  clearPendingTournamentSilentEntry: (roomId: string) => void
}

export type CuttingAnimationCache = {
  armedCycleKey: string | null
  pendingCycleKey: string | null
  activeCycleKey: string | null
  activeSelectionKey: string | null
  renderedSelectionKey: string | null
  startedAt: number
  completionTimerId: number | null
  latchedCuttingSnapshot: RoomCuttingSnapshot | null
  latchedCutterDisplayName: string
  latchedDealerSeat: Seat | null
  isAnimating: boolean
  hasCompleted: boolean
}

export type DealingAnimationCache = {
  activePhaseKey: string | null
  renderedPhaseKey: string | null
  renderedFirstDealSeat: Seat | null
  startedAt: number
  completionTimerId: number | null
  isAnimating: boolean
  hasCompleted: boolean
}

export type PlayingUiCache = {
  lastTrickKey: string | null
  lastCompletedTricksCount: number
  isTrickCollectionAnimating: boolean
  pendingCompletedTrickKey: string | null
  latestCompletedTrickKey: string | null
  bufferedCompletedTrick: RoomCompletedTrickSnapshot | null
  completedTrickEntryKey: string | null
  completedTrickEntryStartedAt: number
  hasRenderedSnapshot: boolean
  animationToken: number
  pendingPlayCardSent: boolean
  wasMyTurn: boolean
  observedPlayKeys: string[]
  showBotTakeover: boolean
  hasShownBotTakeover: boolean
  lastPlayedCardRect: DOMRect | null
  hoveredHandCardId: string | null
  pendingDeclarationPrompt: PendingDeclarationPrompt | null
  submittedDeclarationKeys: string[]
  flyingCardPlayKey: string | null
  lastSeatPanelKey: string | null
  lastPlayingShellKey: string | null
  lastTrickStableKey: string | null
  lastScoreHudRenderedHtml: string | null
  // "Долу картите" — виж renderPlayingScreen.ts / animateSweepThrowDown.ts.
  sweepOfferDismissedKey: string | null
  sweepAcceptSent: boolean
  lastSweepResolutionKey: string | null
  isSweepAnimating: boolean
}

export type BiddingUiState = {
  lastKnownEntriesCount: number
  pendingBidSent: boolean
  wasMyTurn: boolean
  popupAnimatedTurnKey: string | null
  recentBubbles: Partial<Record<Seat, { label: string; startedAt: number }>>
  bubbleTimerIds: Partial<Record<Seat, number>>
  showBotTakeover: boolean
  botTakeoverTimerId: number | null
}

export type EmojiReactionUiState = {
  activeBubbles: Partial<Record<Seat, { emojiId: string; startedAt: number }>>
  timerIds: Partial<Record<Seat, number>>
}

export type PhraseReactionUiState = {
  activeBubbles: Partial<Record<Seat, { phraseId: string; startedAt: number }>>
  timerIds: Partial<Record<Seat, number>>
}

import { SERVER_SEAT_ORDER, type Seat, type ServerRoom } from '../core/serverTypes.js'
import { getValidServerBidActions } from '../game/getValidServerBidActions.js'
import { getServerValidPlayCards } from '../game/getServerValidPlayCards.js'
import { getServerHumanTurnTimeoutMsForPhase } from '../game/serverTimerStateHelpers.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import {
  getDisplayNameFromIdentity,
  type RoomBiddingSnapshot,
  type RoomCardSnapshot,
  type RoomCompletedTrickSnapshot,
  type RoomDeclarationSnapshot,
  type RoomGameSnapshot,
  type RoomMatchEndedSnapshot,
  type RoomPlayingSnapshot,
  type RoomScoringSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type RoomTeamPointsSnapshot,
  type BelotSpectatorSnapshotMessage,
  type RoomSpectatorGameSnapshot,
} from './messageTypes.js'

function createSeatSnapshot(room: ServerRoom, seat: Seat): RoomSeatSnapshot {
  const participant = room.seats[seat].participant
  const authoritativeState = room.game.authoritativeState
  const isAuthoritativeState =
    authoritativeState !== null && !('kind' in authoritativeState)

  if (participant === null) {
    return {
      seat,
      profileId: null,
      displayName: 'Празно място',
      isOccupied: false,
      isBot: false,
      isControlledByBot: false,
      isConnected: false,
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
      gender: null,
    }
  }

  return {
    seat,
    // Stage 2.1: ботовете вече СА допустими gift targets, стига да имат
    // реален DB-backed profileId (regular matchmaking bots имат такъв —
    // виж selectMatchmakingBotProfiles.ts/pickEligibleBotProfileFromDb.ts).
    // Затова profileId вече се излага и за bot participants, не само human —
    // identity.profileId е null за rare fallback bot без DB profile (bot
    // pool изчерпан), което client-side gift icon guard-а вече покрива.
    // Server-side resolveTableGiftParticipants.ts остава authoritative
    // валидация (defense in depth), не само тоя snapshot флаг.
    profileId: participant.identity.profileId ?? null,
    displayName: getDisplayNameFromIdentity(participant.identity),
    isOccupied: true,
    isBot: participant.kind === 'bot',
    isControlledByBot:
      participant.kind !== 'bot' && isAuthoritativeState
        ? authoritativeState.players[seat]?.controlledByBot ?? false
        : false,
    isConnected: participant.kind === 'bot' ? true : participant.isConnected,
    avatarUrl: participant.identity.avatarUrl,
    level: participant.identity.level,
    rankTitle: participant.identity.rankTitle,
    skillRating: participant.identity.skillRating,
    gender: participant.identity.gender ?? participant.publicProfile?.gender ?? null,
  }
}

function getReconnectTokenForSeat(
  room: ServerRoom,
  yourSeat: Seat | null,
): string | null {
  if (yourSeat === null) {
    return null
  }

  const participant = room.seats[yourSeat].participant

  if (participant === null || participant.kind !== 'human') {
    return null
  }

  return participant.reconnectToken
}

function isAuthoritativeGameState(
  value: ServerRoom['game']['authoritativeState'],
): value is ServerAuthoritativeGameState {
  return value !== null && !('kind' in value)
}

function createCardSnapshot(card: ServerAuthoritativeGameState['deck'][number]): RoomCardSnapshot {
  return {
    id: card.id,
    suit: card.suit,
    rank: card.rank,
  }
}

// ─── Declaration disclosure (единствен source of truth) ────────────────────
//
// Authoritative ServerDeclaration носи privateMetadata (cards/cardIds/suit/
// highRank), а card id кодира реалната карта (`${suit}-${rank}`). Преди тази
// проекция пълната metadata отиваше към ВСИЧКИ играчи — противник можеше от
// WebSocket payload-а да научи неизиграни карти от чужда декларация.
//
// Политика: еднаква публична проекция за всеки viewer (собственик, партньор,
// противник, spectator). Собственикът не губи нищо — той вече знае ръката си
// чрез ownHand, а клиентът преди scoring ползва от декларацията само seat/
// type/publicLabel/announced/declaredAtTrickIndex/points (подпис на
// балончето) и cardIds.includes(изиграната карта) за Белот trigger-а.
//
// Само transport/view проекция — authoritative state не се променя.

/**
 * Карта е "скрита", докато е в ръката на някой играч (authoritativeState.hands).
 * Изиграните карти (current/completed tricks) вече не са в hands; при приет
 * "Долу картите" hands се изпразват и всички карти стават публични чрез
 * sweepResolution.handsAtResolution. Декларациите и ръцете се нулират атомарно
 * при нов рунд (createServerRoundStartState), затова стара декларация никога
 * не се сравнява с ръцете на следващия рунд.
 */
function collectHiddenCardIds(authoritativeState: ServerAuthoritativeGameState): Set<string> {
  const hidden = new Set<string>()
  for (const seat of SERVER_SEAT_ORDER) {
    for (const card of authoritativeState.hands[seat]) {
      hidden.add(card.id)
    }
  }
  return hidden
}

/**
 * Публичната презентация на декларацията (seat/team/type/publicLabel/
 * announced/trick index/valid) винаги е видима; metadata, от която се
 * възстановява неизиграна карта — не:
 *  - cards/cardIds: само вече изиграни карти (за Белот това е изиграната
 *    Дама/Поп — достатъчно за trigger-а на балончето в клиента);
 *  - suit/highRank: само ако цялата комбинация е изиграна (изключение: Белот
 *    suit, щом поне една от двете карти е изиграна — мастта е видима от нея);
 *  - points: за Каре стойността (100/150/200) издава ранга -> null докато има
 *    неизиграна карта; за поредици/Белот е еднозначна от publicLabel.
 * При scoring/match-ended всички карти са изиграни -> пълна metadata.
 */
export function createPublicDeclarationSnapshots(
  authoritativeState: ServerAuthoritativeGameState,
): RoomDeclarationSnapshot[] {
  const hiddenCardIds = collectHiddenCardIds(authoritativeState)

  return authoritativeState.declarations.map((declaration) => {
    const visibleCards = declaration.cards.filter((card) => !hiddenCardIds.has(card.id))
    const visibleCardIds = declaration.cardIds.filter((cardId) => !hiddenCardIds.has(cardId))
    const isFullyRevealed =
      visibleCards.length === declaration.cards.length &&
      visibleCardIds.length === declaration.cardIds.length
    const isBeloteWithVisibleCard = declaration.type === 'belote' && visibleCards.length > 0

    return {
      seat: declaration.seat,
      team: declaration.team,
      type: declaration.type,
      publicLabel: declaration.publicLabel,
      points: isFullyRevealed || declaration.type !== 'square' ? declaration.points : null,
      cards: visibleCards.map(createCardSnapshot),
      cardIds: visibleCardIds,
      suit: isFullyRevealed || isBeloteWithVisibleCard ? declaration.suit : null,
      highRank: isFullyRevealed ? declaration.highRank : null,
      declaredAtTrickIndex: declaration.declaredAtTrickIndex,
      announced: declaration.announced,
      valid: declaration.valid,
    }
  })
}

function createTeamPointsSnapshot(score: {
  teamA: number
  teamB: number
}): RoomTeamPointsSnapshot {
  return {
    teamA: score.teamA,
    teamB: score.teamB,
  }
}

function createBiddingSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  yourSeat: Seat | null,
): RoomBiddingSnapshot | null {
  const shouldExposeBiddingSnapshot =
    authoritativeState.phase === 'bidding' ||
    (authoritativeState.phase === 'deal-last-3' && authoritativeState.bidding.hasEnded) ||
    (authoritativeState.phase === 'next-round' &&
      authoritativeState.bidding.hasEnded &&
      authoritativeState.bidding.winningBid === null)

  if (!shouldExposeBiddingSnapshot) {
    return null
  }

  const { bidding } = authoritativeState
  const canSubmitBid = yourSeat !== null && bidding.currentSeat === yourSeat

  let validActions: RoomBiddingSnapshot['validActions'] = null
  if (canSubmitBid && yourSeat !== null) {
    const v = getValidServerBidActions(yourSeat, bidding.winningBid)
    validActions = {
      pass: v.pass,
      suits: v.suits,
      noTrumps: v.noTrumps,
      allTrumps: v.allTrumps,
      double: v.double,
      redouble: v.redouble,
    }
  }

  return {
    currentBidderSeat: bidding.currentSeat,
    canSubmitBid,
    entries: bidding.entries.map((e) => ({ seat: e.seat, action: e.action })),
    winningBid: bidding.winningBid ?? null,
    validActions,
  }
}

// Exported (only beyond this file's own use) so "Долу картите" seat-gating
// logic (sweepOffer vs sweepResolution) can be unit-tested directly without
// needing a full ServerRoom fixture — виж
// scripts/checkSweepDownTheCards.ts §14.
export function createPlayingSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  yourSeat: Seat | null,
): RoomPlayingSnapshot | null {
  if (authoritativeState.phase !== 'playing') {
    return null
  }

  const playing = authoritativeState.playing
  if (!playing?.hasStarted) {
    return null
  }

  const currentTrickPlays =
    playing.currentTrick?.plays.map((p) => ({
      seat: p.seat,
      card: createCardSnapshot(p.card),
    })) ?? []

  const isMyTurn = yourSeat !== null && playing.currentTurnSeat === yourSeat
  const validCardIds = isMyTurn
    ? getServerValidPlayCards(authoritativeState, yourSeat).map((c) => c.id)
    : null
  const latestCompletedTrick: RoomCompletedTrickSnapshot | null =
    playing.completedTricks.length > 0
      ? {
          trickIndex: playing.completedTricks[playing.completedTricks.length - 1]!.trickIndex,
          leaderSeat: playing.completedTricks[playing.completedTricks.length - 1]!.leaderSeat,
          plays: playing.completedTricks[playing.completedTricks.length - 1]!.plays.map((play) => ({
            seat: play.seat,
            card: createCardSnapshot(play.card),
          })),
          winnerSeat: playing.completedTricks[playing.completedTricks.length - 1]!.winnerSeat,
        }
      : null

  // "Долу картите" — sweepOffer е seat-gated (само offered seat-ът го вижда,
  // огледално на validCardIds/canSubmitBid по-горе); sweepResolution НЕ е
  // seat-gated — всички 4 играча трябва да видят reveal/throw-down анимацията.
  const sweepOffer: RoomPlayingSnapshot['sweepOffer'] =
    playing.sweepOffer !== null && yourSeat !== null && playing.sweepOffer.seat === yourSeat
      ? { seat: playing.sweepOffer.seat, expiresAt: playing.sweepOffer.expiresAt }
      : null

  const sweepResolution: RoomPlayingSnapshot['sweepResolution'] =
    playing.sweepResolution !== null
      ? {
          winnerSeat: playing.sweepResolution.winnerSeat,
          winnerTeam: playing.sweepResolution.winnerTeam,
          throwOrder: playing.sweepResolution.throwOrder,
          handsAtResolution: {
            bottom: playing.sweepResolution.handsAtResolution.bottom.map(createCardSnapshot),
            right: playing.sweepResolution.handsAtResolution.right.map(createCardSnapshot),
            top: playing.sweepResolution.handsAtResolution.top.map(createCardSnapshot),
            left: playing.sweepResolution.handsAtResolution.left.map(createCardSnapshot),
          },
          autoCreditedBelotes: playing.sweepResolution.autoCreditedBelotes.map((entry) => ({
            seat: entry.seat,
            team: entry.team,
            suit: entry.suit,
          })),
          resolvedAt: playing.sweepResolution.resolvedAt,
        }
      : null

  return {
    winningBid: authoritativeState.bidding.winningBid ?? null,
    currentTurnSeat: playing.currentTurnSeat,
    currentTrickPlays,
    completedTricksCount: playing.completedTricks.length,
    latestCompletedTrick,
    validCardIds,
    sweepOffer,
    sweepResolution,
  }
}

function createScoringSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
): RoomScoringSnapshot | null {
  const scoring = authoritativeState.scoring

  if (scoring === null) {
    return null
  }

  return {
    winningBid: {
      ...scoring.winningBid,
    },
    rawHandPoints: createTeamPointsSnapshot(scoring.rawHandPoints),
    rawHandTricksWon: createTeamPointsSnapshot(scoring.rawHandTricksWon),
    declarationPoints: createTeamPointsSnapshot(scoring.declarationPoints),
    belotePoints: createTeamPointsSnapshot(scoring.belotePoints),
    sumPoints: createTeamPointsSnapshot(scoring.sumPoints),
    officialRoundPoints: createTeamPointsSnapshot(scoring.officialRoundPoints),
    matchTotals: createTeamPointsSnapshot(scoring.matchTotals),
    carryOver: createTeamPointsSnapshot(scoring.carryOver),
    isCapotRound: scoring.isCapotRound,
    isNonCapotRound: scoring.isNonCapotRound,
    outcomeLabel: scoring.outcomeLabel,
    outcomeShortLabel: scoring.outcomeShortLabel,
    counterMultiplier: scoring.counterMultiplier,
  }
}

function createMatchEndedSnapshot(
  authoritativeState: ServerAuthoritativeGameState,
  replayVotes: import('../core/serverTypes.js').Seat[],
  leaveVotes: import('../core/serverTypes.js').Seat[],
  awardedPrizePerSeat: Partial<Record<import('../core/serverTypes.js').Seat, number>> | undefined,
  yourSeat: import('../core/serverTypes.js').Seat | null,
): RoomMatchEndedSnapshot | null {
  const matchEnded = authoritativeState.matchEnded

  if (matchEnded === null) {
    return null
  }

  const awardedPrizeAmount =
    yourSeat !== null ? (awardedPrizePerSeat?.[yourSeat] ?? null) : null

  return {
    winnerTeam: matchEnded.winnerTeam,
    targetScore: matchEnded.targetScore,
    finalScore: createTeamPointsSnapshot(matchEnded.finalScore),
    endedAt: matchEnded.endedAt,
    replayVotes,
    leaveVotes,
    awardedPrizeAmount,
  }
}

function createGameSnapshot(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomGameSnapshot | null {
  const authoritativeState = room.game.authoritativeState

  if (!isAuthoritativeGameState(authoritativeState)) {
    return null
  }

  const phase = authoritativeState.phase
  const includeCuttingSnapshot =
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3'

  return {
    phase: room.game.phase,
    authoritativePhase: phase,
    timerDeadlineAt: room.game.timerDeadlineAt,
    humanTurnTimeoutMs: getServerHumanTurnTimeoutMsForPhase(authoritativeState),
    serverNow: Date.now(),
    dealerSeat: authoritativeState.round.dealerSeat,
    firstDealSeat: authoritativeState.round.firstDealSeat,
    cutting: includeCuttingSnapshot
      ? {
          cutterSeat: authoritativeState.round.cutterSeat,
          selectedCutIndex: authoritativeState.round.selectedCutIndex,
          deckCount: authoritativeState.deck.length,
          canSubmitCut:
            yourSeat !== null &&
            yourSeat === authoritativeState.round.cutterSeat &&
            phase === 'cutting' &&
            authoritativeState.round.selectedCutIndex === null,
        }
      : null,
    bidding: createBiddingSnapshot(authoritativeState, yourSeat),
    playing: createPlayingSnapshot(authoritativeState, yourSeat),
    scoring: createScoringSnapshot(authoritativeState),
    matchEnded: createMatchEndedSnapshot(authoritativeState, room.replayVotes ?? [], room.leaveVotes ?? [], room.awardedPrizePerSeat, yourSeat),
    declarations: createPublicDeclarationSnapshots(authoritativeState),
    score: {
      match: createTeamPointsSnapshot(authoritativeState.score.match),
    },
    handCounts: {
      bottom: authoritativeState.hands.bottom.length,
      right: authoritativeState.hands.right.length,
      top: authoritativeState.hands.top.length,
      left: authoritativeState.hands.left.length,
    },
    ownHand:
      yourSeat !== null
        ? authoritativeState.hands[yourSeat].map(createCardSnapshot)
        : [],
  }
}

export function createRoomSnapshotMessage(
  room: ServerRoom,
  yourSeat: Seat | null,
): RoomSnapshotMessage {
  const nowMs = Date.now()

  return {
    type: 'room_snapshot',
    roomId: room.id,
    roomStatus: room.status,
    yourSeat,
    reconnectToken: getReconnectTokenForSeat(room, yourSeat),
    seats: SERVER_SEAT_ORDER.map((seat) => createSeatSnapshot(room, seat)),
    game: createGameSnapshot(room, yourSeat),
    stakeAmount: room.config.stakeAmount ?? null,
    isGuestTrial: room.config.isGuestTrial === true,
    isPrivateTableOrigin: room.config.isPrivateTableOrigin === true,
    isTournamentMatchOrigin: room.config.isTournamentMatchOrigin === true,
    tournamentId: room.config.tournamentId ?? null,
    tournamentMatchId: room.config.tournamentMatchId ?? null,
    tournamentRoundType: room.config.tournamentRoundType ?? null,
    tournamentAttendance: room.config.tournamentAttendance ?? null,
    tournamentBotReplacements: room.config.tournamentBotReplacements ?? [],
    tournamentBanners: room.config.tournamentBanners ?? [],
    // Lazy expiry filtering — reconnect-ващ клиент никога не получава вече
    // изтекъл gift overlay. Няма сървърен timer/polling за почистване.
    activeTableGifts: Object.values(room.config.activeTableGifts ?? {}).filter(
      (gift): gift is NonNullable<typeof gift> =>
        gift !== undefined && Date.parse(gift.expiresAt) > nowMs,
    ),
  }
}

// ─── Belot Spectator Mode ("Гледай", Phase 2A) — spectator-safe projection ──
//
// Основата е createRoomSnapshotMessage(room, null) (yourSeat=null вече дава
// ownHand=[], validCardIds/validActions=null, canSubmit*=false, sweepOffer=null,
// reconnectToken=null, awardedPrizeAmount=null), НО резултатът никога не се
// изпраща директно: всяко поле се копира през explicit ALLOWLIST по-долу,
// така че бъдещо ново private поле в RoomSnapshotMessage/RoomGameSnapshot НЕ
// изтича автоматично към spectator. Private/decision полетата се форсират
// повторно (defense in depth), независимо от yourSeat=null семантиката.
// Декларациите идват от base.game — вече публичната canonical проекция
// (createPublicDeclarationSnapshots), обща за всички viewers.

function createSpectatorGameSnapshot(game: RoomGameSnapshot): RoomSpectatorGameSnapshot {
  // "Долу картите" timer side-channel: при чакащ private sweepOffer сървърът
  // държи currentTurnSeat=null, но timerDeadlineAt сочи изтичането на
  // офертата — това би доказало eligibility на победителя във взятката. Във
  // playing фаза без текущ ход клиентът и без това не показва countdown
  // (getPlayingCountdownState изисква currentTurnSeat), затова занулението е
  // безопасно за публичната презентация.
  const shouldHideTimerDeadline =
    game.authoritativePhase === 'playing' && (game.playing?.currentTurnSeat ?? null) === null

  return {
    phase: game.phase,
    authoritativePhase: game.authoritativePhase,
    timerDeadlineAt: shouldHideTimerDeadline ? null : game.timerDeadlineAt,
    // Публични: продължителността е еднаква за всички на масата, а serverNow
    // е само часовник — не разкриват private eligibility.
    humanTurnTimeoutMs: game.humanTurnTimeoutMs,
    serverNow: game.serverNow,
    dealerSeat: game.dealerSeat,
    firstDealSeat: game.firstDealSeat,
    cutting: game.cutting
      ? {
          cutterSeat: game.cutting.cutterSeat,
          selectedCutIndex: game.cutting.selectedCutIndex,
          deckCount: game.cutting.deckCount,
          canSubmitCut: false,
        }
      : null,
    bidding: game.bidding
      ? {
          currentBidderSeat: game.bidding.currentBidderSeat,
          canSubmitBid: false,
          entries: game.bidding.entries,
          winningBid: game.bidding.winningBid,
          validActions: null,
        }
      : null,
    playing: game.playing
      ? {
          winningBid: game.playing.winningBid,
          currentTurnSeat: game.playing.currentTurnSeat,
          currentTrickPlays: game.playing.currentTrickPlays,
          completedTricksCount: game.playing.completedTricksCount,
          latestCompletedTrick: game.playing.latestCompletedTrick,
          validCardIds: null,
          // Hidden before acceptance: sweepOffer е private eligibility —
          // никога за spectator.
          sweepOffer: null,
          // Public only after acceptance: handsAtResolution съществува
          // единствено след приет "Долу картите" и е публичен reveal по
          // дизайн — НЕ се redact-ва.
          sweepResolution: game.playing.sweepResolution,
        }
      : null,
    scoring: game.scoring,
    matchEnded: game.matchEnded
      ? {
          winnerTeam: game.matchEnded.winnerTeam,
          targetScore: game.matchEnded.targetScore,
          finalScore: game.matchEnded.finalScore,
          endedAt: game.matchEnded.endedAt,
          replayVotes: game.matchEnded.replayVotes,
          leaveVotes: game.matchEnded.leaveVotes,
          awardedPrizeAmount: null,
        }
      : null,
    declarations: game.declarations,
    score: game.score,
    handCounts: game.handCounts,
    ownHand: [],
  }
}

export function createSpectatorRoomSnapshotMessage(room: ServerRoom): BelotSpectatorSnapshotMessage {
  const base = createRoomSnapshotMessage(room, null)
  const game = base.game ? createSpectatorGameSnapshot(base.game) : null

  return {
    type: 'belot_spectator_snapshot',
    viewerRole: 'spectator',
    roomId: base.roomId,
    roomStatus: base.roomStatus,
    yourSeat: null,
    reconnectToken: null,
    seats: base.seats,
    game,
    stakeAmount: base.stakeAmount,
    isGuestTrial: base.isGuestTrial,
    isPrivateTableOrigin: base.isPrivateTableOrigin,
    isTournamentMatchOrigin: base.isTournamentMatchOrigin,
    activeTableGifts: base.activeTableGifts ?? [],
  }
}

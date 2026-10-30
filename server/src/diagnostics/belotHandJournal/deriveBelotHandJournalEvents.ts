// Чиста (без I/O) функция: от prevRoom → nextRoom извежда събитията на belot
// hand журнала. Вика се в главната нишка при всеки commit на authoritative
// state (виж createBelotHandJournal.ts). Само ЧЕТЕ state-а — никога не го
// променя и никога не влияе на резултатите.
//
// Защо diff, а не hook в самия engine: game логиката върви и в worker
// нишки, а всяка изиграна карта е отделен commit (stopCatchUpAfterStep),
// затова главната нишка вижда всяка взятка, всяко „Долу картите“ решение и
// прехода към точкуване. Единственият случай, в който commit прескача
// междинни състояния, е catch-up след дълъг престой (рестарт) — тогава
// точкуването се реконструира от последното видяно пълно състояние
// (observedVia: 'catch_up') и се проверява спрямо приложения резултат.

import { createHash } from 'node:crypto'
import { SERVER_SEAT_ORDER, type Seat, type ServerRoom, type Team } from '../../core/serverTypes.js'
import { computeServerSweepEligibility } from '../../game/computeServerSweepEligibility.js'
import { createServerDeck } from '../../game/createServerDeck.js'
import { dealServerCardsInPackets } from '../../game/dealServerCardsInPackets.js'
import { scoreServerDeclarations } from '../../game/declarations/scoreServerDeclarations.js'
import { flattenPlayedCards, type PlayedCardReference } from '../../game/gameplayActionDiff.js'
import { getServerTrickWinner } from '../../game/getServerTrickWinner.js'
import { getServerValidPlayCards } from '../../game/getServerValidPlayCards.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerDeclaration,
  ServerRoundScore,
  ServerTrickPlay,
} from '../../game/serverGameTypes.js'
import { getNextSeat } from '../../game/serverPhaseHelpers.js'
import {
  explainServerScoring,
  getServerCardPoints,
  type ServerScoringExplanation,
} from '../../game/serverScoring.js'
import { getTeamBySeat } from '../../game/serverStateHelpers.js'
import {
  createRoomSnapshotMessage,
  createSpectatorRoomSnapshotMessage,
} from '../../protocol/createRoomSnapshotMessage.js'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalCheck,
  type BelotHandJournalEvent,
  type BelotHandJournalEventType,
  type BelotHandJournalOrigin,
  type BelotHandJournalPlaySource,
  type BelotHandJournalSeatPlayer,
} from './belotHandJournalTypes.js'

const TRICKS_PER_ROUND = 8
const FULL_DECK_IDS = createServerDeck().map((card) => card.id).sort()

// Фази, в които раздаването вече е фиксирано, но още не се играе.
const PRE_PLAY_DEALT_PHASES = new Set<ServerAuthoritativeGameState['phase']>([
  'deal-first-3',
  'deal-next-2',
  'bidding',
  'deal-last-3',
  'next-round',
])
const PLAY_PHASES = new Set<ServerAuthoritativeGameState['phase']>([
  'playing',
  'scoring',
  'match-ended',
])

export type BelotHandJournalPlaySourceRegistry = {
  get: (handId: string, cardId: string) => BelotHandJournalPlaySource | undefined
  set: (handId: string, cardId: string, source: BelotHandJournalPlaySource) => void
}

export type DeriveBelotHandJournalEventsInput = {
  prevRoom: ServerRoom | null
  nextRoom: ServerRoom
  origin: BelotHandJournalOrigin
  nowMs: number
  playSources?: BelotHandJournalPlaySourceRegistry
}

export type BelotHandContext = {
  handId: string
  // Пълното раздаване по места (8 карти на място, в реда на раздаване,
  // когато е известен).
  deal: Record<Seat, string[]>
}

// ─── State helpers ─────────────────────────────────────────────────────────

export function getBelotJournalAuthState(room: ServerRoom | null): ServerAuthoritativeGameState | null {
  if (room === null) return null
  const state = room.game.authoritativeState
  if (state === null || typeof state !== 'object' || 'kind' in state || !('phase' in state)) {
    return null
  }
  return state
}

// Мачът в една стая се идентифицира по room.id + game.startedAt —
// startedAt се нулира при „Нова игра“ (applyReplayRestart).
export function getBelotJournalMatchId(room: ServerRoom): string {
  return `${room.id}@${room.game.startedAt ?? 0}`
}

function ids(cards: readonly ServerCard[]): string[] {
  return cards.map((card) => card.id)
}

function handsToIds(hands: Record<Seat, ServerCard[]>): Record<Seat, string[]> {
  return {
    bottom: ids(hands.bottom),
    right: ids(hands.right),
    top: ids(hands.top),
    left: ids(hands.left),
  }
}

function playsToJournal(plays: readonly ServerTrickPlay[]): { seat: Seat; card: string }[] {
  return plays.map((play) => ({ seat: play.seat, card: play.card.id }))
}

function scoreEquals(left: ServerRoundScore, right: ServerRoundScore): boolean {
  return left.teamA === right.teamA && left.teamB === right.teamB
}

function teamKey(team: Team): 'teamA' | 'teamB' {
  return team === 'A' ? 'teamA' : 'teamB'
}

// Възстановява пълното раздаване (8 карти на място) от всяка фаза след
// deal-first-3. Тестето е фиксирано след deal-first-3 (Anti Bad Luck
// пренарежда само преди него), затова оставащите пакети са детерминирани.
export function reconstructBelotFullDeal(state: ServerAuthoritativeGameState): Record<Seat, string[]> | null {
  if (PRE_PLAY_DEALT_PHASES.has(state.phase)) {
    const firstDealSeat = state.round.firstDealSeat
    if (firstDealSeat === null) return null
    const size = state.hands.bottom.length
    if (size === 0 || SERVER_SEAT_ORDER.some((seat) => state.hands[seat].length !== size)) {
      return null
    }
    let hands = state.hands
    let deck = state.deck
    if (hands.bottom.length === 3) {
      const result = dealServerCardsInPackets(deck, hands, firstDealSeat, 2, 1)
      hands = result.hands
      deck = result.remainingDeck
    }
    if (hands.bottom.length === 5) {
      const result = dealServerCardsInPackets(deck, hands, firstDealSeat, 3, 1)
      hands = result.hands
    }
    if (SERVER_SEAT_ORDER.some((seat) => hands[seat].length !== TRICKS_PER_ROUND)) {
      return null
    }
    return handsToIds(hands)
  }

  if (PLAY_PHASES.has(state.phase) && state.playing !== null && state.bidding.winningBid !== null) {
    const played = flattenPlayedCards(state)
    const deal = {} as Record<Seat, string[]>
    for (const seat of SERVER_SEAT_ORDER) {
      deal[seat] = [
        ...played.filter((play) => play.seat === seat).map((play) => play.card.id),
        ...ids(state.hands[seat]),
      ]
      if (deal[seat].length !== TRICKS_PER_ROUND) return null
    }
    return deal
  }

  return null
}

const handContextCache = new WeakMap<object, BelotHandContext | null>()

export function getBelotHandContext(
  room: ServerRoom,
  state: ServerAuthoritativeGameState,
): BelotHandContext | null {
  const cached = handContextCache.get(state)
  if (cached !== undefined) return cached

  const deal = reconstructBelotFullDeal(state)
  let context: BelotHandContext | null = null
  if (deal !== null) {
    const fingerprintSource = [
      getBelotJournalMatchId(room),
      state.round.dealerSeat ?? '-',
      ...SERVER_SEAT_ORDER.map((seat) => `${seat}:${[...deal[seat]].sort().join(',')}`),
    ].join('|')
    const digest = createHash('sha256').update(fingerprintSource).digest('hex').slice(0, 24)
    context = { handId: `h_${digest}`, deal }
  }
  handContextCache.set(state, context)
  return context
}

export function getBelotJournalSeatPlayers(
  room: ServerRoom,
  state: ServerAuthoritativeGameState | null,
): BelotHandJournalSeatPlayer[] {
  return SERVER_SEAT_ORDER.map((seat) => {
    const slot = room.seats[seat]
    const participant = slot.participant
    const statePlayer = state?.players[seat] ?? null
    const base = {
      seat,
      team: slot.team,
      stateMode: statePlayer?.mode ?? null,
      controlledByBot: statePlayer?.controlledByBot ?? false,
    }
    if (participant === null) {
      return { ...base, kind: 'empty', profileId: null, displayName: null, botCode: null, botDifficulty: null }
    }
    if (participant.kind === 'human') {
      return {
        ...base,
        kind: 'human',
        profileId: participant.identity.profileId ?? null,
        displayName: participant.identity.displayName ?? null,
        botCode: null,
        botDifficulty: null,
      }
    }
    return {
      ...base,
      kind: 'bot',
      profileId: participant.botProfileId ?? null,
      displayName: participant.identity.displayName ?? null,
      botCode: participant.botCode,
      botDifficulty: participant.difficulty,
    }
  })
}

function classifyPlaySource(
  origin: BelotHandJournalOrigin,
  prevState: ServerAuthoritativeGameState,
  seat: Seat,
): BelotHandJournalPlaySource {
  if (origin === 'direct_submit') return 'human_manual'
  const player = prevState.players[seat]
  if (!player || player.mode === 'bot') return 'bot_original'
  return player.controlledByBot ? 'bot_takeover' : 'human_timeout_auto'
}

function isSeatBotControlled(state: ServerAuthoritativeGameState, seat: Seat): boolean {
  const player = state.players[seat]
  return !player || player.mode === 'bot' || player.controlledByBot
}

function trickCardPoints(
  plays: readonly ServerTrickPlay[],
  state: ServerAuthoritativeGameState,
): number {
  const winningBid = state.bidding.winningBid
  if (winningBid === null) return 0
  return plays.reduce(
    (sum, play) => sum + getServerCardPoints(play.card.suit, play.card.rank, winningBid.contract, winningBid.trumpSuit),
    0,
  )
}

function cardPointsByTeam(
  tricks: readonly ServerCompletedTrick[],
  state: ServerAuthoritativeGameState,
): ServerRoundScore {
  const result = { teamA: 0, teamB: 0 }
  for (const trick of tricks) {
    result[teamKey(getTeamBySeat(trick.winnerSeat))] += trickCardPoints(trick.plays, state)
  }
  return result
}

function declarationToJournal(declaration: ServerDeclaration): Record<string, unknown> {
  return {
    key: declaration.key,
    seat: declaration.seat,
    team: declaration.team,
    type: declaration.type,
    label: declaration.publicLabel,
    points: declaration.points,
    cards: declaration.cardIds,
    suit: declaration.suit,
    highRank: declaration.highRank,
    declaredAtTrickIndex: declaration.declaredAtTrickIndex,
    announced: declaration.announced,
    valid: declaration.valid,
  }
}

function getSweepSynthesizedCount(state: ServerAuthoritativeGameState): number {
  const resolution = state.playing?.sweepResolution ?? null
  if (resolution === null) return 0
  return resolution.handsAtResolution[resolution.winnerSeat]?.length ?? 0
}

// ─── Event factory ─────────────────────────────────────────────────────────

function createEvent(params: {
  room: ServerRoom
  eventType: BelotHandJournalEventType
  handId: string | null
  nowMs: number
  payload: Record<string, unknown>
  profileIds?: string[]
}): BelotHandJournalEvent {
  const checks = Array.isArray(params.payload.checks) ? (params.payload.checks as BelotHandJournalCheck[]) : null
  const hasFailedCheck = checks !== null && checks.some((check) => !check.ok)
  // Успешните проверки се пазят само с името си (обем), неуспешните — изцяло.
  const payload =
    checks === null
      ? params.payload
      : {
          ...params.payload,
          checks: checks.map((check) => (check.ok ? { name: check.name, ok: true } : check)),
        }
  return {
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: BELOT_HAND_JOURNAL_SCHEMA_VERSION,
    eventType: params.eventType,
    severity: params.eventType === 'anomaly' || hasFailedCheck ? 'anomaly' : 'info',
    occurredAtMs: params.nowMs,
    occurredAt: new Date(params.nowMs).toISOString(),
    roomId: params.room.id,
    matchId: getBelotJournalMatchId(params.room),
    handId: params.handId,
    ...(params.profileIds ? { profileIds: params.profileIds } : {}),
    payload,
  }
}

// Всяка неуспешна проверка става и отделно 'anomaly' събитие — за бързо
// търсене на аномалии без парсване на всички payload-и.
function anomalyEventsFor(
  parent: BelotHandJournalEvent,
  room: ServerRoom,
  checks: readonly BelotHandJournalCheck[],
): BelotHandJournalEvent[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) =>
      createEvent({
        room,
        eventType: 'anomaly',
        handId: parent.handId,
        nowMs: parent.occurredAtMs,
        payload: {
          anomalyType: check.anomalyType ?? 'journal_internal_error',
          relatedEventType: parent.eventType,
          check,
        },
      }),
    )
}

export function createBelotJournalAnomalyEvent(params: {
  room: ServerRoom
  handId: string | null
  nowMs: number
  check: BelotHandJournalCheck
  relatedEventType: BelotHandJournalEventType | null
}): BelotHandJournalEvent {
  return createEvent({
    room: params.room,
    eventType: 'anomaly',
    handId: params.handId,
    nowMs: params.nowMs,
    payload: {
      anomalyType: params.check.anomalyType ?? 'journal_internal_error',
      relatedEventType: params.relatedEventType,
      check: params.check,
    },
  })
}

function withAnomalies(
  room: ServerRoom,
  event: BelotHandJournalEvent,
  checks: readonly BelotHandJournalCheck[],
): BelotHandJournalEvent[] {
  return [event, ...anomalyEventsFor(event, room, checks)]
}

// ─── hand_started ──────────────────────────────────────────────────────────

export function buildBelotHandStartedEvents(params: {
  room: ServerRoom
  state: ServerAuthoritativeGameState
  hand: BelotHandContext
  nowMs: number
  reconstructedMidHand: boolean
}): BelotHandJournalEvent[] {
  const { room, state, hand, nowMs } = params
  const players = getBelotJournalSeatPlayers(room, state)
  const allCards = SERVER_SEAT_ORDER.flatMap((seat) => hand.deal[seat])
  const sortedCards = [...allCards].sort()
  const uniqueCount = new Set(allCards).size
  const missing = FULL_DECK_IDS.filter((id) => !allCards.includes(id))
  const checks: BelotHandJournalCheck[] = [
    {
      name: 'deal_has_32_unique_cards_of_full_deck',
      ok: allCards.length === 32 && uniqueCount === 32 && sortedCards.join(',') === FULL_DECK_IDS.join(','),
      anomalyType: 'deal_integrity',
      detail: `cards=${allCards.length} unique=${uniqueCount} missing=${missing.join(',') || '-'}`,
    },
    {
      name: 'deal_has_8_cards_per_seat',
      ok: SERVER_SEAT_ORDER.every((seat) => hand.deal[seat].length === TRICKS_PER_ROUND),
      anomalyType: 'deal_integrity',
    },
  ]
  const event = createEvent({
    room,
    eventType: 'hand_started',
    handId: hand.handId,
    nowMs,
    profileIds: players.map((player) => player.profileId).filter((id): id is string => id !== null),
    payload: {
      observedPhase: state.phase,
      reconstructedMidHand: params.reconstructedMidHand,
      matchStartedAt: room.game.startedAt,
      room: {
        stakeAmount: room.config.stakeAmount ?? null,
        targetScore: state.targetScore,
        isGuestTrial: room.config.isGuestTrial === true,
        isPrivateTableOrigin: room.config.isPrivateTableOrigin === true,
        isTournamentMatchOrigin: room.config.isTournamentMatchOrigin === true,
        tournamentId: room.config.tournamentId ?? null,
        tournamentMatchId: room.config.tournamentMatchId ?? null,
      },
      players,
      teams: {
        A: players.filter((player) => player.team === 'A').map((player) => player.seat),
        B: players.filter((player) => player.team === 'B').map((player) => player.seat),
      },
      dealerSeat: state.round.dealerSeat,
      cutterSeat: state.round.cutterSeat,
      firstBidderSeat: state.round.firstBidderSeat,
      firstDealSeat: state.round.firstDealSeat,
      selectedCutIndex: state.round.selectedCutIndex,
      // Ред на картите на всяко място: пакет 3 + пакет 2 + пакет 3 (когато
      // е наблюдавано преди игра), иначе изиграните по ред + оставащите.
      deal: hand.deal,
      matchScoreBefore: { ...state.score.match },
      carryOverBefore: { ...state.score.carryOver },
      checks,
    },
  })
  return withAnomalies(room, event, checks)
}

// ─── bidding ───────────────────────────────────────────────────────────────

function buildBiddingCompletedEvents(params: {
  room: ServerRoom
  state: ServerAuthoritativeGameState
  handId: string
  nowMs: number
  finalBidsObserved: boolean
}): BelotHandJournalEvent[] {
  const { room, state, handId, nowMs } = params
  const winningBid = state.bidding.winningBid
  const events: BelotHandJournalEvent[] = [
    createEvent({
      room,
      eventType: 'bidding_completed',
      handId,
      nowMs,
      payload: {
        entries: state.bidding.entries.map((entry, index) => ({ order: index, seat: entry.seat, action: entry.action })),
        finalBidsObserved: params.finalBidsObserved,
        winningBid: winningBid === null
          ? null
          : {
              bidderSeat: winningBid.seat,
              bidderTeam: getTeamBySeat(winningBid.seat),
              contract: winningBid.contract,
              trumpSuit: winningBid.trumpSuit,
              doubled: winningBid.doubled,
              redoubled: winningBid.redoubled,
            },
        // Ръцете в момента на обявяването (5 карти на място).
        handsAtBidding: handsToIds(state.hands),
      },
    }),
  ]
  if (winningBid === null) {
    events.push(
      createEvent({
        room,
        eventType: 'hand_redeal',
        handId,
        nowMs,
        payload: {
          reason: 'all_pass',
          matchScoreUnchanged: { ...state.score.match },
          carryOverUnchanged: { ...state.score.carryOver },
        },
      }),
    )
  }
  return events
}

// ─── tricks ────────────────────────────────────────────────────────────────

function checkCompletedTrick(
  trick: ServerCompletedTrick,
  state: ServerAuthoritativeGameState,
  previousTrick: ServerCompletedTrick | null,
): BelotHandJournalCheck[] {
  const recomputed = getServerTrickWinner(trick.plays, state.bidding.winningBid)
  const expectedOrder: Seat[] = []
  let seat = trick.leaderSeat
  for (let i = 0; i < 4; i += 1) {
    expectedOrder.push(seat)
    seat = getNextSeat(seat)
  }
  const actualOrder = trick.plays.map((play) => play.seat)
  const checks: BelotHandJournalCheck[] = [
    {
      name: 'trick_winner_recomputed',
      ok: recomputed !== null && recomputed.seat === trick.winnerSeat,
      anomalyType: 'trick_winner_mismatch',
      detail: `recorded=${trick.winnerSeat} recomputed=${recomputed?.seat ?? 'null'}`,
    },
    {
      name: 'trick_winning_team_matches_winner_seat',
      ok: trick.winningTeam === getTeamBySeat(trick.winnerSeat),
      anomalyType: 'trick_winner_mismatch',
    },
    {
      name: 'trick_has_4_plays_in_turn_order_from_leader',
      ok: trick.plays.length === 4 && actualOrder.join(',') === expectedOrder.join(','),
      anomalyType: 'trick_sequence_invalid',
      detail: `order=${actualOrder.join(',')} expected=${expectedOrder.join(',')}`,
    },
  ]
  if (previousTrick !== null) {
    checks.push({
      name: 'trick_leader_is_previous_trick_winner',
      ok: trick.leaderSeat === previousTrick.winnerSeat && trick.trickIndex === previousTrick.trickIndex + 1,
      anomalyType: 'trick_sequence_invalid',
      detail: `leader=${trick.leaderSeat} prevWinner=${previousTrick.winnerSeat} index=${trick.trickIndex} prevIndex=${previousTrick.trickIndex}`,
    })
  }
  return checks
}

function buildTrickCompletedEvents(params: {
  room: ServerRoom
  state: ServerAuthoritativeGameState
  handId: string
  trickPosition: number
  nowMs: number
  playSources?: BelotHandJournalPlaySourceRegistry
}): BelotHandJournalEvent[] {
  const { room, state, handId, trickPosition, nowMs } = params
  const playing = state.playing!
  const trick = playing.completedTricks[trickPosition]!
  const previousTrick = trickPosition > 0 ? playing.completedTricks[trickPosition - 1]! : null
  const checks = checkCompletedTrick(trick, state, previousTrick)
  const tricksSoFar = playing.completedTricks.slice(0, trickPosition + 1)
  const winningBid = state.bidding.winningBid
  const event = createEvent({
    room,
    eventType: 'trick_completed',
    handId,
    nowMs,
    payload: {
      trickIndex: trick.trickIndex,
      leaderSeat: trick.leaderSeat,
      plays: trick.plays.map((play, position) => ({
        position,
        seat: play.seat,
        card: play.card.id,
        source: params.playSources?.get(handId, play.card.id) ?? 'unknown',
      })),
      winnerSeat: trick.winnerSeat,
      winnerTeam: trick.winningTeam,
      // Точки на картите във взятката (без ×2 за Без коз и без +10 за
      // последна взятка — те са в hand_scored.explanation).
      cardPoints: trickCardPoints(trick.plays, state),
      contract: winningBid?.contract ?? null,
      trumpSuit: winningBid?.trumpSuit ?? null,
      isLastTrick: trickPosition === TRICKS_PER_ROUND - 1,
      declarationsDuringTrick: state.declarations
        .filter((declaration) => declaration.declaredAtTrickIndex === trick.trickIndex)
        .map(declarationToJournal),
      tricksWonSoFar: {
        teamA: tricksSoFar.filter((t) => getTeamBySeat(t.winnerSeat) === 'A').length,
        teamB: tricksSoFar.filter((t) => getTeamBySeat(t.winnerSeat) === 'B').length,
      },
      cardPointsSoFar: cardPointsByTeam(tricksSoFar, state),
      checks,
    },
  })
  return withAnomalies(room, event, checks)
}

function checkAddedPlays(params: {
  room: ServerRoom
  prevState: ServerAuthoritativeGameState
  nextState: ServerAuthoritativeGameState
  handId: string
  origin: BelotHandJournalOrigin
  nowMs: number
  playSources?: BelotHandJournalPlaySourceRegistry
}): BelotHandJournalEvent[] {
  const { room, prevState, nextState, handId, nowMs } = params
  const prevHistory = flattenPlayedCards(prevState)
  const nextHistory = flattenPlayedCards(nextState)
  const prefixMatches =
    nextHistory.length >= prevHistory.length &&
    prevHistory.every((play, index) => {
      const next = nextHistory[index]!
      return next.seat === play.seat && next.card.id === play.card.id
    })

  if (!prefixMatches) {
    return [
      createBelotJournalAnomalyEvent({
        room,
        handId,
        nowMs,
        relatedEventType: null,
        check: {
          name: 'played_history_is_append_only',
          ok: false,
          anomalyType: 'played_history_mismatch',
          detail: `prev=${prevHistory.length} next=${nextHistory.length}`,
          data: {
            prevPlays: prevHistory.map((play) => `${play.seat}:${play.card.id}`),
            nextPlays: nextHistory.map((play) => `${play.seat}:${play.card.id}`),
          },
        },
      }),
    ]
  }

  const added: PlayedCardReference[] = nextHistory.slice(prevHistory.length)
  const events: BelotHandJournalEvent[] = []
  for (const play of added) {
    params.playSources?.set(handId, play.card.id, classifyPlaySource(params.origin, prevState, play.seat))
  }

  // Легалността се проверява точно, когато commit-ът добавя една карта
  // (нормалният случай); при catch-up с няколко карти междинните състояния
  // липсват — проверява се само принадлежността към ръката.
  for (const [index, play] of added.entries()) {
    const inHand = prevState.hands[play.seat].some((card) => card.id === play.card.id)
    const checks: BelotHandJournalCheck[] = [
      {
        name: 'played_card_was_in_players_hand',
        ok: inHand,
        anomalyType: 'card_not_in_hand',
        detail: `${play.seat} played ${play.card.id}`,
      },
    ]
    if (index === 0 && added.length === 1 && prevState.playing?.currentTurnSeat === play.seat) {
      const legal = getServerValidPlayCards(prevState, play.seat).some((card) => card.id === play.card.id)
      checks.push({
        name: 'played_card_is_legal',
        ok: legal,
        anomalyType: 'illegal_card_play',
        detail: `${play.seat} played ${play.card.id} legal=${ids(getServerValidPlayCards(prevState, play.seat)).join(',')}`,
      })
    }
    for (const check of checks.filter((c) => !c.ok)) {
      events.push(
        createBelotJournalAnomalyEvent({
          room,
          handId,
          nowMs,
          relatedEventType: 'trick_completed',
          check: {
            ...check,
            data: {
              trickIndex: play.trickIndex,
              positionInTrick: play.positionInTrick,
              handBefore: ids(prevState.hands[play.seat]),
              currentTrickBefore: playsToJournal(prevState.playing?.currentTrick.plays ?? []),
            },
          },
        }),
      )
    }
  }
  return events
}

// ─── „Долу картите“ ─────────────────────────────────────────────────────────

const SWEEP_SERVER_RULE = {
  rule: 'guaranteed_sweep_universal_double_dummy_v1',
  description:
    'Предложението се прави на победителя в току-що приключилата взятка, ако не е отказвал в това раздаване, ' +
    'има поне 2 карти и при ВСЕКИ негов ход и ВСЕКИ легален отговор на останалите трима гарантирано печели всички оставащи взятки ' +
    '(computeServerSweepEligibility).',
  minRemainingCards: 2,
} as const

function completedTricksSummary(state: ServerAuthoritativeGameState): Record<string, unknown>[] {
  return (state.playing?.completedTricks ?? []).map((trick) => ({
    trickIndex: trick.trickIndex,
    leaderSeat: trick.leaderSeat,
    plays: playsToJournal(trick.plays),
    winnerSeat: trick.winnerSeat,
    winnerTeam: trick.winningTeam,
    cardPoints: trickCardPoints(trick.plays, state),
  }))
}

function remainingCardPoints(state: ServerAuthoritativeGameState): number {
  return SERVER_SEAT_ORDER.reduce(
    (sum, seat) => sum + trickCardPoints(state.hands[seat].map((card) => ({ seat, card })), state),
    0,
  )
}

function buildSweepOfferedEvents(params: {
  room: ServerRoom
  state: ServerAuthoritativeGameState
  handId: string
  nowMs: number
}): BelotHandJournalEvent[] {
  const { room, state, handId, nowMs } = params
  const playing = state.playing!
  const offer = playing.sweepOffer!
  const lastTrick = playing.completedTricks[playing.completedTricks.length - 1] ?? null
  // Пълната гаранционна проверка (computeServerSweepEligibility) НЕ се
  // повтаря тук: engine-ът току-що я е изпълнил (офертата съществува само при
  // true), а търсенето може да отнеме десетки ms — твърде скъпо за главната
  // нишка. Независимото преизчисляване става офлайн: CLI --verify-sweeps
  // (verifyBelotSweepEventsOffline) върху записаните ръце. Тук — само
  // евтините структурни условия на офертата.
  const checks: BelotHandJournalCheck[] = [
    {
      name: 'sweep_offer_structural_conditions',
      ok:
        lastTrick?.winnerSeat === offer.seat &&
        state.hands[offer.seat].length >= SWEEP_SERVER_RULE.minRemainingCards &&
        playing.currentTurnSeat === null,
      anomalyType: 'sweep_recheck_failed',
      detail: `lastTrickWinner=${lastTrick?.winnerSeat ?? '-'} claimantCards=${state.hands[offer.seat].length} currentTurnSeat=${playing.currentTurnSeat ?? 'null'}`,
    },
  ]
  const event = createEvent({
    room,
    eventType: 'sweep_offered',
    handId,
    nowMs,
    payload: {
      claimantSeat: offer.seat,
      claimantTeam: getTeamBySeat(offer.seat),
      claimantControlledByBot: isSeatBotControlled(state, offer.seat),
      offeredAtTrickIndex: offer.offeredAtTrickIndex,
      expiresAt: offer.expiresAt,
      remainingTricks: TRICKS_PER_ROUND - playing.completedTricks.length,
      remainingHands: handsToIds(state.hands),
      remainingCardPoints: remainingCardPoints(state),
      completedTricks: completedTricksSummary(state),
      cardPointsSoFar: cardPointsByTeam(playing.completedTricks, state),
      declinedSweepSeatsBefore: [...playing.declinedSweepSeats],
      whyAllowed: {
        ...SWEEP_SERVER_RULE,
        engineEligibility: true,
        claimantWonLastTrick: lastTrick?.winnerSeat === offer.seat,
        claimantDeclinedBefore: playing.declinedSweepSeats.includes(offer.seat),
        claimantCardsLeft: state.hands[offer.seat].length,
      },
      contract: state.bidding.winningBid?.contract ?? null,
      trumpSuit: state.bidding.winningBid?.trumpSuit ?? null,
      checks,
    },
  })
  return withAnomalies(room, event, checks)
}

function buildSweepDeclinedEvent(params: {
  room: ServerRoom
  prevState: ServerAuthoritativeGameState
  nextState: ServerAuthoritativeGameState
  handId: string
  origin: BelotHandJournalOrigin
  nowMs: number
}): BelotHandJournalEvent {
  const { room, prevState, nextState, handId, origin, nowMs } = params
  const offer = prevState.playing!.sweepOffer!
  const decidedBy =
    origin === 'direct_submit'
      ? 'player'
      : isSeatBotControlled(prevState, offer.seat)
        ? 'bot_auto_decline'
        : 'timeout_auto_decline'
  return createEvent({
    room,
    eventType: 'sweep_declined',
    handId,
    nowMs,
    payload: {
      claimantSeat: offer.seat,
      claimantTeam: getTeamBySeat(offer.seat),
      decidedBy,
      offeredAtTrickIndex: offer.offeredAtTrickIndex,
      offerExpiresAt: offer.expiresAt,
      msBeforeExpiry: offer.expiresAt - nowMs,
      remainingHands: handsToIds(nextState.hands),
      playContinuesWithSeat: nextState.playing?.currentTurnSeat ?? null,
      declinedSweepSeatsAfter: [...(nextState.playing?.declinedSweepSeats ?? [])],
    },
  })
}

function buildSweepAcceptedEvents(params: {
  room: ServerRoom
  prevState: ServerAuthoritativeGameState
  nextState: ServerAuthoritativeGameState
  handId: string
  nowMs: number
}): BelotHandJournalEvent[] {
  const { room, prevState, nextState, handId, nowMs } = params
  const resolution = nextState.playing!.sweepResolution!
  const synthesized = nextState.playing!.completedTricks.slice(prevState.playing!.completedTricks.length)
  const synthesizedCardPoints = synthesized.reduce((sum, trick) => sum + trickCardPoints(trick.plays, nextState), 0)
  const allRemainingCards = SERVER_SEAT_ORDER.flatMap((seat) => ids(prevState.hands[seat])).sort()
  const synthesizedCards = synthesized.flatMap((trick) => trick.plays.map((play) => play.card.id)).sort()
  // Повторната сървърна проверка се прави от submitServerSweepDecision
  // (resolution съществува само ако е минала); независимото преизчисляване е
  // офлайн (CLI --verify-sweeps) — виж buildSweepOfferedEvents.
  const checks: BelotHandJournalCheck[] = [
    {
      name: 'sweep_resolved_from_pending_offer_of_same_seat',
      ok: prevState.playing!.sweepOffer?.seat === resolution.winnerSeat,
      anomalyType: 'sweep_recheck_failed',
      detail: `offerSeat=${prevState.playing!.sweepOffer?.seat ?? 'null'} resolvedSeat=${resolution.winnerSeat}`,
    },
    {
      name: 'sweep_awards_exactly_all_remaining_cards_to_claimant',
      ok:
        allRemainingCards.join(',') === synthesizedCards.join(',') &&
        synthesized.every((trick) => trick.winnerSeat === resolution.winnerSeat),
      anomalyType: 'hand_cards_integrity',
      detail: `remaining=${allRemainingCards.length} awarded=${synthesizedCards.length}`,
    },
  ]
  const event = createEvent({
    room,
    eventType: 'sweep_accepted',
    handId,
    nowMs,
    payload: {
      claimantSeat: resolution.winnerSeat,
      claimantTeam: resolution.winnerTeam,
      decidedBy: 'player',
      serverRecheck: 'passed_in_submitServerSweepDecision',
      contract: prevState.bidding.winningBid?.contract ?? null,
      trumpSuit: prevState.bidding.winningBid?.trumpSuit ?? null,
      offeredAtTrickIndex: prevState.playing!.sweepOffer?.offeredAtTrickIndex ?? null,
      handsAtResolution: handsToIds(resolution.handsAtResolution),
      // Синтезираните взятки, присъдени на заявилия (картите не са реално
      // изиграни — подредени по място, само за точкуването).
      awardedTricks: synthesized.map((trick) => ({
        trickIndex: trick.trickIndex,
        cards: trick.plays.map((play) => play.card.id),
        cardPoints: trickCardPoints(trick.plays, nextState),
      })),
      awardedTricksCount: synthesized.length,
      awardedCardPoints: synthesizedCardPoints,
      lastTrickBonusGoesToTeam: resolution.winnerTeam,
      autoCreditedBelotes: resolution.autoCreditedBelotes,
      resolvedAt: resolution.resolvedAt,
      checks,
    },
  })
  return withAnomalies(room, event, checks)
}

export function buildBelotSweepAcceptRejectedEvents(params: {
  room: ServerRoom
  seat: Seat
  decision: 'accept' | 'decline'
  reason: string
  nowMs: number
}): BelotHandJournalEvent[] {
  const { room, seat, decision, reason, nowMs } = params
  const state = getBelotJournalAuthState(room)
  const hand = state ? getBelotHandContext(room, state) : null
  const offer = state?.playing?.sweepOffer ?? null
  // Рядко (само при отхвърлено решение на самия заявил) — тогава engine-ът
  // току-що е направил същото търсене, затова цената е приемлива.
  const recheckEligible =
    state !== null && offer !== null && offer.seat === seat
      ? computeServerSweepEligibility({ sweepSeat: seat, hands: state.hands, winningBid: state.bidding.winningBid })
      : null
  return [
    createEvent({
      room,
      eventType: 'sweep_accept_rejected',
      handId: hand?.handId ?? null,
      nowMs,
      payload: {
        seat,
        decision,
        reason,
        pendingOfferSeat: offer?.seat ?? null,
        recheckEligible,
        remainingHands: state ? handsToIds(state.hands) : null,
        completedTricksCount: state?.playing?.completedTricks.length ?? null,
      },
    }),
  ]
}

// ─── hand_scored ───────────────────────────────────────────────────────────

function checkHandCards(state: ServerAuthoritativeGameState): BelotHandJournalCheck[] {
  const tricks = state.playing?.completedTricks ?? []
  const cards = tricks.flatMap((trick) => trick.plays.map((play) => play.card.id))
  const unique = new Set(cards)
  const duplicates = cards.filter((id, index) => cards.indexOf(id) !== index)
  const missing = FULL_DECK_IDS.filter((id) => !unique.has(id))
  return [
    {
      name: 'hand_has_8_completed_tricks',
      ok: tricks.length === TRICKS_PER_ROUND,
      anomalyType: 'hand_cards_integrity',
      detail: `tricks=${tricks.length}`,
    },
    {
      name: 'all_32_cards_played_exactly_once',
      ok: cards.length === 32 && unique.size === 32 && missing.length === 0,
      anomalyType: 'hand_cards_integrity',
      detail: `cards=${cards.length} duplicates=${duplicates.join(',') || '-'} missing=${missing.join(',') || '-'}`,
    },
  ]
}

function checkTricksForScoring(state: ServerAuthoritativeGameState): BelotHandJournalCheck[] {
  const tricks = state.playing?.completedTricks ?? []
  const realTrickCount = tricks.length - getSweepSynthesizedCount(state)
  const checks: BelotHandJournalCheck[] = []
  for (let i = 0; i < realTrickCount; i += 1) {
    const trick = tricks[i]!
    const recomputed = getServerTrickWinner(trick.plays, state.bidding.winningBid)
    if (recomputed === null || recomputed.seat !== trick.winnerSeat) {
      checks.push({
        name: 'scored_trick_winner_recomputed',
        ok: false,
        anomalyType: 'trick_winner_mismatch',
        detail: `trick=${trick.trickIndex} recorded=${trick.winnerSeat} recomputed=${recomputed?.seat ?? 'null'}`,
      })
    }
  }
  if (checks.length === 0) {
    checks.push({ name: 'scored_trick_winners_recomputed', ok: true, detail: `realTricks=${realTrickCount}` })
  }
  return checks
}

function checkScoringExplanation(
  explanation: ServerScoringExplanation,
  state: ServerAuthoritativeGameState,
): BelotHandJournalCheck[] {
  const checks: BelotHandJournalCheck[] = []
  const trace = explanation.official
  const sum = (score: ServerRoundScore) => score.teamA + score.teamB

  checks.push({
    name: 'raw_points_total_matches_contract_total',
    ok: explanation.isPointTotalValid,
    anomalyType: 'raw_points_total_invalid',
    detail: `actual=${explanation.actualTotalPoints} expected=${explanation.expectedTotalPoints}`,
  })

  // Капо: независимо от explanation — броим победителите във взятките.
  const tricks = state.playing?.completedTricks ?? []
  const tricksA = tricks.filter((trick) => getTeamBySeat(trick.winnerSeat) === 'A').length
  const tricksB = tricks.filter((trick) => getTeamBySeat(trick.winnerSeat) === 'B').length
  const independentCapotTeam: Team | null =
    tricks.length === TRICKS_PER_ROUND ? (tricksA === 8 ? 'A' : tricksB === 8 ? 'B' : null) : null
  const capotBonusTeams = (['A', 'B'] as const).filter(
    (team) => explanation.teams[teamKey(team)].capotBonus > 0,
  )
  checks.push({
    name: 'capot_bonus_only_for_team_with_all_8_tricks',
    ok:
      explanation.capotTeam === independentCapotTeam &&
      capotBonusTeams.length === (independentCapotTeam === null ? 0 : 1) &&
      (independentCapotTeam === null || capotBonusTeams[0] === independentCapotTeam) &&
      explanation.isCapotRound === (independentCapotTeam !== null),
    anomalyType: 'capot_misapplied',
    detail: `tricksA=${tricksA} tricksB=${tricksB} capotTeam=${explanation.capotTeam ?? '-'} bonusTeams=${capotBonusTeams.join(',') || '-'}`,
  })

  // Сурови → начислени: всяка точка трябва да е обяснена от клона на
  // правилата (закръгляне, всичко към един отбор, висящи).
  const awardedSum = sum(trace.awardedBeforeMultiplier)
  let rawVsAwardedOk = true
  let rawVsAwardedDetail = ''
  if (explanation.outcome.outcome === 'made' || explanation.outcome.outcome === 'inside') {
    rawVsAwardedOk = awardedSum === trace.recordedTotalWithPremiums && sum(trace.nextCarryOver) === 0
    rawVsAwardedDetail = `awarded=${awardedSum} recordedTotal=${trace.recordedTotalWithPremiums}`
    if (explanation.outcome.outcome === 'inside') {
      const bidderAwarded = trace.awardedBeforeMultiplier[teamKey(explanation.bidderTeam)]
      rawVsAwardedOk = rawVsAwardedOk && bidderAwarded === 0
      rawVsAwardedDetail += ` bidderAwarded=${bidderAwarded}`
    }
    if (trace.ruleBranch === 'made_points_split_by_rounding' && trace.rounding !== null) {
      const expectedA = trace.rounding.teamA
      const expectedB = trace.rounding.teamB
      rawVsAwardedOk =
        rawVsAwardedOk &&
        trace.awardedBeforeMultiplier.teamA === expectedA &&
        trace.awardedBeforeMultiplier.teamB === expectedB
      rawVsAwardedDetail += ` rounding=${expectedA}/${expectedB}`
    }
  } else if (explanation.outcome.outcome === 'tie') {
    // При равна игра nextCarryOver = входящите висящи + новите; тук се
    // обясняват само новите (входящите се пренасят непроменени).
    const newlyHeld: ServerRoundScore = {
      teamA: trace.nextCarryOver.teamA - trace.carryOverIn.teamA,
      teamB: trace.nextCarryOver.teamB - trace.carryOverIn.teamB,
    }
    const heldBeforeMultiplier = sum(newlyHeld) / trace.counterMultiplier
    const defenderHeld = newlyHeld[teamKey(explanation.defenderTeam)]
    rawVsAwardedOk =
      defenderHeld === 0 &&
      trace.awardedBeforeMultiplier[teamKey(explanation.bidderTeam)] === 0 &&
      awardedSum + heldBeforeMultiplier === trace.recordedTotalWithPremiums
    rawVsAwardedDetail = `awarded=${awardedSum} held=${heldBeforeMultiplier} recordedTotal=${trace.recordedTotalWithPremiums}`
  } else {
    rawVsAwardedOk = false
    rawVsAwardedDetail = 'unknown outcome'
  }
  checks.push({
    name: 'raw_to_awarded_points_fully_explained',
    ok: rawVsAwardedOk,
    anomalyType: 'raw_vs_awarded_unexplained',
    detail: `${trace.ruleBranch} ${rawVsAwardedDetail}`,
  })

  const carryInSum = sum(trace.carryOverIn)
  const carryResolvedSum = trace.carryOverResolutions.reduce((total, item) => total + item.points, 0)
  // Равна игра не консумира висящите — те трябва да преминат изцяло към
  // nextCarryOver; решено раздаване ги консумира точно веднъж.
  const isTie = explanation.outcome.outcome === 'tie'
  checks.push({
    name: 'carry_over_in_consumed_exactly_once',
    ok: isTie
      ? carryResolvedSum === 0 &&
        sum(explanation.roundBreakdown.total) === sum(trace.awardedAfterMultiplier) &&
        trace.nextCarryOver.teamA >= trace.carryOverIn.teamA &&
        trace.nextCarryOver.teamB >= trace.carryOverIn.teamB
      : carryResolvedSum === carryInSum &&
      sum(explanation.roundBreakdown.total) === sum(trace.awardedAfterMultiplier) + carryInSum &&
      trace.carryOverResolutions.every(
        (item) =>
          item.awardedTo ===
          (explanation.outcome.winningTeam === item.ownerTeam ? item.ownerTeam : item.ownerTeam === 'A' ? 'B' : 'A'),
      ),
    anomalyType: 'carry_over_misapplied',
    detail: `carryIn=${carryInSum} resolved=${carryResolvedSum} total=${sum(explanation.roundBreakdown.total)} afterMultiplier=${sum(trace.awardedAfterMultiplier)}`,
  })
  return checks
}

function compareAppliedScoring(
  explanation: ServerScoringExplanation,
  nextState: ServerAuthoritativeGameState,
  observedVia: 'direct_transition' | 'catch_up',
): BelotHandJournalCheck[] {
  const checks: BelotHandJournalCheck[] = []
  const applied = nextState.scoring
  if (observedVia === 'direct_transition' && applied !== null) {
    const mismatches: string[] = []
    const compare = (name: string, left: ServerRoundScore, right: ServerRoundScore) => {
      if (!scoreEquals(left, right)) mismatches.push(`${name}: applied=${left.teamA}/${left.teamB} recomputed=${right.teamA}/${right.teamB}`)
    }
    compare('rawHandPoints', applied.rawHandPoints, {
      teamA: explanation.teams.teamA.rawPoints,
      teamB: explanation.teams.teamB.rawPoints,
    })
    compare('rawHandTricksWon', applied.rawHandTricksWon, {
      teamA: explanation.teams.teamA.tricksWon,
      teamB: explanation.teams.teamB.tricksWon,
    })
    compare('declarationPoints', applied.declarationPoints, explanation.declarationPoints)
    compare('belotePoints', applied.belotePoints, explanation.belotePoints)
    compare('officialRoundPoints', applied.officialRoundPoints, explanation.roundBreakdown.total)
    compare('matchTotals', applied.matchTotals, explanation.matchAfter)
    compare('carryOver', applied.carryOver, explanation.carryOverAfter)
    if (applied.isCapotRound !== explanation.isCapotRound) mismatches.push('isCapotRound')
    if (applied.isNonCapotRound !== explanation.isNonCapotRound) mismatches.push('isNonCapotRound')
    if (applied.counterMultiplier !== explanation.official.counterMultiplier) mismatches.push('counterMultiplier')
    if (applied.outcome !== (explanation.outcome.outcome === 'unknown' ? 'tie' : explanation.outcome.outcome)) {
      mismatches.push(`outcome applied=${applied.outcome} recomputed=${explanation.outcome.outcome}`)
    }
    checks.push({
      name: 'applied_scoring_equals_independent_recompute',
      ok: mismatches.length === 0,
      anomalyType: 'scoring_recompute_mismatch',
      detail: mismatches.join('; ') || 'all fields equal',
    })
  }
  checks.push({
    name: 'match_total_after_equals_before_plus_round_total',
    ok: scoreEquals(nextState.score.match, explanation.matchAfter),
    anomalyType: 'match_total_mismatch',
    detail: `applied=${nextState.score.match.teamA}/${nextState.score.match.teamB} expected=${explanation.matchAfter.teamA}/${explanation.matchAfter.teamB}`,
  })
  checks.push({
    name: 'carry_over_after_equals_rule_result',
    ok: scoreEquals(nextState.score.carryOver, explanation.carryOverAfter),
    anomalyType: 'carry_over_misapplied',
    detail: `applied=${nextState.score.carryOver.teamA}/${nextState.score.carryOver.teamB} expected=${explanation.carryOverAfter.teamA}/${explanation.carryOverAfter.teamB}`,
  })
  return checks
}

// Сравнява резултата, който реално би бил изпратен към всеки от четиримата
// играчи и към зрител, с authoritative state-а.
function checkClientSnapshots(nextRoom: ServerRoom, nextState: ServerAuthoritativeGameState): BelotHandJournalCheck {
  const mismatches: string[] = []
  const viewers: { label: string; game: ReturnType<typeof createRoomSnapshotMessage>['game'] }[] = [
    ...SERVER_SEAT_ORDER.map((seat) => ({ label: seat, game: createRoomSnapshotMessage(nextRoom, seat).game })),
    { label: 'spectator', game: createSpectatorRoomSnapshotMessage(nextRoom).game },
  ]
  for (const viewer of viewers) {
    const game = viewer.game
    if (!game) {
      mismatches.push(`${viewer.label}: no game snapshot`)
      continue
    }
    const match = game.score.match
    if (match.teamA !== nextState.score.match.teamA || match.teamB !== nextState.score.match.teamB) {
      mismatches.push(`${viewer.label}: score.match=${match.teamA}/${match.teamB}`)
    }
    const scoring = nextState.scoring
    if (scoring !== null) {
      const sent = game.scoring
      if (sent === null) {
        mismatches.push(`${viewer.label}: scoring missing`)
        continue
      }
      const pairs: [string, { teamA: number; teamB: number }, ServerRoundScore][] = [
        ['officialRoundPoints', sent.officialRoundPoints, scoring.officialRoundPoints],
        ['matchTotals', sent.matchTotals, scoring.matchTotals],
        ['carryOver', sent.carryOver, scoring.carryOver],
        ['rawHandPoints', sent.rawHandPoints, scoring.rawHandPoints],
        ['declarationPoints', sent.declarationPoints, scoring.declarationPoints],
        ['belotePoints', sent.belotePoints, scoring.belotePoints],
      ]
      for (const [name, left, right] of pairs) {
        if (left.teamA !== right.teamA || left.teamB !== right.teamB) {
          mismatches.push(`${viewer.label}: ${name}=${left.teamA}/${left.teamB} server=${right.teamA}/${right.teamB}`)
        }
      }
      if (sent.isCapotRound !== scoring.isCapotRound) mismatches.push(`${viewer.label}: isCapotRound`)
    }
  }
  return {
    name: 'client_snapshots_show_server_result',
    ok: mismatches.length === 0,
    anomalyType: 'client_snapshot_mismatch',
    detail: mismatches.join('; ') || `viewers=${viewers.length}`,
  }
}

function explainDeclarationGroups(state: ServerAuthoritativeGameState): Record<string, unknown> {
  const byType = (type: ServerDeclaration['type']) => state.declarations.filter((declaration) => declaration.type === type)
  return {
    // Каре и последователности се сравняват отделно: точки получава само
    // отборът с най-силния анонс от съответния вид (при равенство — никой).
    squares: scoreServerDeclarations(byType('square')).declarationPoints,
    sequences: scoreServerDeclarations(byType('sequence')).declarationPoints,
    // Белотът винаги се брои за отбора, който го има (ако е обявен).
    belote: scoreServerDeclarations(byType('belote')).belotePoints,
    note: 'Броят се само анонси с announced=true и valid=true.',
  }
}

function buildHandScoredEvents(params: {
  prevRoom: ServerRoom
  prevState: ServerAuthoritativeGameState
  nextRoom: ServerRoom
  nextState: ServerAuthoritativeGameState
  handId: string
  nowMs: number
  observedVia: 'direct_transition' | 'catch_up'
}): BelotHandJournalEvent[] {
  const { prevState, nextRoom, nextState, handId, nowMs, observedVia } = params
  const explanation = explainServerScoring(prevState)
  if (explanation === null) {
    return [
      createBelotJournalAnomalyEvent({
        room: nextRoom,
        handId,
        nowMs,
        relatedEventType: 'hand_scored',
        check: {
          name: 'scoring_explanation_available',
          ok: false,
          anomalyType: 'journal_internal_error',
          detail: 'explainServerScoring returned null (no winning bid or playing state)',
        },
      }),
    ]
  }

  const checks: BelotHandJournalCheck[] = [
    ...checkHandCards(prevState),
    ...checkTricksForScoring(prevState),
    ...checkScoringExplanation(explanation, prevState),
    ...compareAppliedScoring(explanation, nextState, observedVia),
    checkClientSnapshots(nextRoom, nextState),
  ]
  const resolution = prevState.playing?.sweepResolution ?? null
  const event = createEvent({
    room: nextRoom,
    eventType: 'hand_scored',
    handId,
    nowMs,
    payload: {
      observedVia,
      contract: explanation.contract,
      trumpSuit: explanation.trumpSuit,
      bidderSeat: explanation.bidderSeat,
      bidderTeam: explanation.bidderTeam,
      doubled: explanation.doubled,
      redoubled: explanation.redoubled,
      endedBySweep: resolution === null
        ? null
        : {
            claimantSeat: resolution.winnerSeat,
            claimantTeam: resolution.winnerTeam,
            awardedTricksCount: getSweepSynthesizedCount(prevState),
            autoCreditedBelotes: resolution.autoCreditedBelotes,
          },
      declarations: prevState.declarations.map(declarationToJournal),
      declarationGroups: explainDeclarationGroups(prevState),
      // Пълна разбивка: сурови точки по отбор (карти, последна взятка, ×2,
      // капо), анонси, белоти, изход, клон на правилата, закръгляне,
      // множител, висящи преди/след, общ резултат преди/след.
      explanation,
      applied: {
        scoring: nextState.scoring,
        roundBreakdown: observedVia === 'direct_transition' ? nextState.score.round : null,
        matchAfter: { ...nextState.score.match },
        carryOverAfter: { ...nextState.score.carryOver },
        matchEnded: nextState.matchEnded,
        phaseAfter: nextState.phase,
      },
      checks,
    },
  })
  return withAnomalies(nextRoom, event, checks)
}

// ─── Main derive ───────────────────────────────────────────────────────────

function isHandScoringComplete(state: ServerAuthoritativeGameState): boolean {
  return state.phase === 'playing' && (state.playing?.completedTricks.length ?? 0) === TRICKS_PER_ROUND
}

function closePreviousHand(params: {
  prevRoom: ServerRoom
  prevState: ServerAuthoritativeGameState
  prevHand: BelotHandContext
  nextRoom: ServerRoom
  nextState: ServerAuthoritativeGameState | null
  sameMatch: boolean
  nowMs: number
}): BelotHandJournalEvent[] {
  const { prevRoom, prevState, prevHand, nextRoom, nextState, sameMatch, nowMs } = params

  if (prevState.scoring !== null) return []

  if (prevState.bidding.winningBid === null) {
    if (prevState.bidding.hasEnded) return []
    if (sameMatch && nextState !== null) {
      // Всички пас + ново раздаване в един catch-up commit.
      return buildBiddingCompletedEvents({
        room: prevRoom,
        state: prevState,
        handId: prevHand.handId,
        nowMs,
        finalBidsObserved: false,
      }).map((event) =>
        event.eventType === 'hand_redeal'
          ? { ...event, payload: { ...event.payload, reason: 'all_pass_inferred_from_new_deal' } }
          : event,
      )
    }
  }

  if (sameMatch && nextState !== null && isHandScoringComplete(prevState)) {
    return buildHandScoredEvents({
      prevRoom,
      prevState,
      nextRoom,
      nextState,
      handId: prevHand.handId,
      nowMs,
      observedVia: 'catch_up',
    })
  }

  return [
    createEvent({
      room: prevRoom,
      eventType: 'hand_abandoned',
      handId: prevHand.handId,
      nowMs,
      payload: {
        reason: nextState === null ? 'authoritative_state_cleared' : sameMatch ? 'new_hand_without_scoring' : 'match_changed',
        phaseAtAbandon: prevState.phase,
        completedTricks: completedTricksSummary(prevState),
        currentTrickPlays: playsToJournal(prevState.playing?.currentTrick.plays ?? []),
        remainingHands: handsToIds(prevState.hands),
        matchScore: { ...prevState.score.match },
        carryOver: { ...prevState.score.carryOver },
        nextRoomStatus: nextRoom.status,
      },
    }),
  ]
}

export function deriveBelotHandJournalEvents(input: DeriveBelotHandJournalEventsInput): BelotHandJournalEvent[] {
  const { prevRoom, nextRoom, origin, nowMs, playSources } = input
  const prevState = getBelotJournalAuthState(prevRoom)
  const nextState = getBelotJournalAuthState(nextRoom)

  if (prevState === nextState) return []

  const events: BelotHandJournalEvent[] = []
  const sameMatch =
    prevRoom !== null &&
    prevState !== null &&
    nextState !== null &&
    getBelotJournalMatchId(prevRoom) === getBelotJournalMatchId(nextRoom)
  const prevHand = prevRoom !== null && prevState !== null ? getBelotHandContext(prevRoom, prevState) : null
  const nextHand = nextState !== null ? getBelotHandContext(nextRoom, nextState) : null
  const sameHand = sameMatch && prevHand !== null && nextHand !== null && prevHand.handId === nextHand.handId

  if (sameHand && prevState !== null && nextState !== null) {
    const handId = nextHand.handId

    if (!prevState.bidding.hasEnded && nextState.bidding.hasEnded) {
      events.push(...buildBiddingCompletedEvents({ room: nextRoom, state: nextState, handId, nowMs, finalBidsObserved: true }))
    }

    const prevPlaying = prevState.playing
    const nextPlaying = nextState.playing
    if (prevPlaying !== null && nextPlaying !== null && nextPlaying.hasStarted) {
      const sweepAcceptedNow = prevPlaying.sweepResolution === null && nextPlaying.sweepResolution !== null

      if (sweepAcceptedNow) {
        events.push(...buildSweepAcceptedEvents({ room: nextRoom, prevState, nextState, handId, nowMs }))
      } else {
        events.push(...checkAddedPlays({ room: nextRoom, prevState, nextState, handId, origin, nowMs, playSources }))
        for (let position = prevPlaying.completedTricks.length; position < nextPlaying.completedTricks.length; position += 1) {
          events.push(...buildTrickCompletedEvents({ room: nextRoom, state: nextState, handId, trickPosition: position, nowMs, playSources }))
        }
        if (prevPlaying.sweepOffer === null && nextPlaying.sweepOffer !== null) {
          events.push(...buildSweepOfferedEvents({ room: nextRoom, state: nextState, handId, nowMs }))
        } else if (prevPlaying.sweepOffer !== null && nextPlaying.sweepOffer === null) {
          events.push(buildSweepDeclinedEvent({ room: nextRoom, prevState, nextState, handId, origin, nowMs }))
        }
      }
    }

    if (prevState.scoring === null && nextState.scoring !== null) {
      events.push(
        ...buildHandScoredEvents({
          prevRoom: prevRoom!,
          prevState,
          nextRoom,
          nextState,
          handId,
          nowMs,
          observedVia: 'direct_transition',
        }),
      )
    }
  } else {
    if (prevRoom !== null && prevState !== null && prevHand !== null) {
      events.push(...closePreviousHand({ prevRoom, prevState, prevHand, nextRoom, nextState, sameMatch, nowMs }))
    }
    if (nextState !== null && nextHand !== null) {
      events.push(...buildBelotHandStartedEvents({ room: nextRoom, state: nextState, hand: nextHand, nowMs, reconstructedMidHand: false }))
    }
  }

  // Всяка промяна на общия резултат или висящите точки в рамките на един мач
  // трябва да идва от точкуване на раздаване.
  if (
    sameMatch &&
    prevState !== null &&
    nextState !== null &&
    (!scoreEquals(prevState.score.match, nextState.score.match) ||
      !scoreEquals(prevState.score.carryOver, nextState.score.carryOver)) &&
    !events.some((event) => event.eventType === 'hand_scored')
  ) {
    events.push(
      createBelotJournalAnomalyEvent({
        room: nextRoom,
        handId: nextHand?.handId ?? prevHand?.handId ?? null,
        nowMs,
        relatedEventType: null,
        check: {
          name: 'match_score_changes_only_through_hand_scoring',
          ok: false,
          anomalyType: 'unexplained_match_score_change',
          detail: `match ${prevState.score.match.teamA}/${prevState.score.match.teamB} -> ${nextState.score.match.teamA}/${nextState.score.match.teamB}; carryOver ${prevState.score.carryOver.teamA}/${prevState.score.carryOver.teamB} -> ${nextState.score.carryOver.teamA}/${nextState.score.carryOver.teamB}; origin=${origin}`,
          data: { prevPhase: prevState.phase, nextPhase: nextState.phase },
        },
      }),
    )
  }

  if (nextState !== null && nextState.phase === 'match-ended' && (!sameMatch || prevState?.phase !== 'match-ended')) {
    events.push(
      createEvent({
        room: nextRoom,
        eventType: 'match_ended',
        handId: nextHand?.handId ?? null,
        nowMs,
        payload: {
          winnerTeam: nextState.matchEnded?.winnerTeam ?? null,
          targetScore: nextState.targetScore,
          finalScore: { ...nextState.score.match },
          players: getBelotJournalSeatPlayers(nextRoom, nextState),
        },
      }),
    )
  }

  return events
}

import type { Seat } from '../core/serverTypes.js'
import {
  detectServerDeclarationsInHand,
  resolveServerDeclarationConflicts,
  type ServerDeclarationCandidate,
} from './declarations/index.js'
import type {
  ServerAuthoritativeGameState,
  ServerDeclaration,
  ServerPlayingState,
  ServerTrickPlay,
} from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getTeamBySeat } from './serverStateHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'
import { createServerDeclarationRecord } from './serverDeclarationRecordHelpers.js'
import {
  clearServerTimerState,
  getServerTimerNow,
  createServerPlayingTimerState,
  isServerSeatControlledByBot,
} from './serverTimerStateHelpers.js'
import { SERVER_TIMING_CONFIG } from './serverTimingConfig.js'

const TRICKS_PER_ROUND = 8

type ServerDeclarationValidationResult =
  | { ok: true; declarations: ServerDeclaration[] }
  | { ok: false; message: string }

function getCounterpartRank(rank: ServerAuthoritativeGameState['hands'][Seat][number]['rank']) {
  if (rank === 'Q') return 'K'
  if (rank === 'K') return 'Q'
  return null
}

function canDeclareBeloteForCard(
  state: ServerAuthoritativeGameState,
  playing: ServerPlayingState,
  card: ServerAuthoritativeGameState['hands'][Seat][number],
): boolean {
  const contract = state.bidding.winningBid

  if (contract === null || contract.contract === 'no-trumps') {
    return false
  }

  if (contract.contract === 'suit') {
    return contract.trumpSuit === card.suit
  }

  const leadSuit = playing.currentTrick.plays[0]?.card.suit ?? null
  return leadSuit === null || leadSuit === card.suit
}

function validateSelectedDeclarationForPlayedCard(params: {
  state: ServerAuthoritativeGameState
  playing: ServerPlayingState
  seat: Seat
  cardId: string
  candidate: ServerDeclarationCandidate
}): boolean {
  const { state, playing, seat, cardId, candidate } = params

  if (candidate.type !== 'belote') {
    return playing.currentTrick.trickIndex === 0
  }

  const card = state.hands[seat].find((handCard) => handCard.id === cardId)

  if (!card || (card.rank !== 'Q' && card.rank !== 'K')) {
    return false
  }

  const counterpartRank = getCounterpartRank(card.rank)
  const hasCounterpart = counterpartRank !== null && state.hands[seat].some(
    (handCard) => handCard.suit === card.suit && handCard.rank === counterpartRank,
  )

  return (
    hasCounterpart &&
    candidate.cardIds.includes(card.id) &&
    candidate.privateMetadata.suit === card.suit &&
    canDeclareBeloteForCard(state, playing, card)
  )
}

export function validateServerDeclarationKeysForPlay(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  cardId: string,
  declarationKeys: string[],
): ServerDeclarationValidationResult {
  if (declarationKeys.length === 0) {
    return { ok: true, declarations: [] }
  }

  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return { ok: false, message: 'Играта не е в playing фаза.' }
  }

  const uniqueKeys = new Set(declarationKeys)

  if (uniqueKeys.size !== declarationKeys.length) {
    return { ok: false, message: 'Има повторен анонс.' }
  }

  const contract = state.bidding.winningBid
  const candidates = detectServerDeclarationsInHand(state.hands[seat], contract)
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.key, candidate]))
  const selectedCandidates: ServerDeclarationCandidate[] = []

  for (const key of declarationKeys) {
    const candidate = candidatesByKey.get(key)

    if (!candidate) {
      return { ok: false, message: 'Невалиден анонс за текущата ръка.' }
    }

    if (!validateSelectedDeclarationForPlayedCard({
      state,
      playing,
      seat,
      cardId,
      candidate,
    })) {
      return { ok: false, message: 'Анонсът не може да се обяви с тази карта.' }
    }

    selectedCandidates.push(candidate)
  }

  const existingKeysForSeat = new Set(
    state.declarations
      .filter((declaration) => declaration.seat === seat)
      .map((declaration) => declaration.key),
  )

  if (selectedCandidates.some((candidate) => existingKeysForSeat.has(candidate.key))) {
    return { ok: false, message: 'Този анонс вече е записан.' }
  }

  const resolved = resolveServerDeclarationConflicts(selectedCandidates)

  if (resolved.selectedCandidates.length !== selectedCandidates.length) {
    return { ok: false, message: 'Избраните анонси използват една и съща карта.' }
  }

  return {
    ok: true,
    declarations: selectedCandidates.map((candidate) =>
      createServerDeclarationRecord({
        candidate,
        seat,
        declaredAtTrickIndex: playing.currentTrick.trickIndex,
      }),
    ),
  }
}

function applyTrickCompletion(
  state: ServerAuthoritativeGameState,
  playing: ServerPlayingState,
  completedPlays: ServerTrickPlay[],
): ServerAuthoritativeGameState {
  const winningPlay = getServerTrickWinner(completedPlays, state.bidding.winningBid)

  if (!winningPlay) {
    return {
      ...state,
      playing: {
        ...playing,
        currentTurnSeat: null,
        currentTrick: {
          ...playing.currentTrick,
          plays: completedPlays,
          currentSeat: null,
        },
      },
      timer: clearServerTimerState(),
    }
  }

  const winnerSeat = winningPlay.seat
  const winnerTeam = getTeamBySeat(winnerSeat)
  const trickCards = completedPlays.map((p) => p.card)
  const trickIndex = playing.currentTrick.trickIndex

  const completedTrick = {
    trickIndex,
    leaderSeat: playing.currentTrick.leaderSeat ?? winnerSeat,
    plays: completedPlays,
    winnerSeat,
    winningTeam: winnerTeam,
  }

  const nextCompletedTricks = [...playing.completedTricks, completedTrick]
  const isRoundComplete = nextCompletedTricks.length >= TRICKS_PER_ROUND

  const nextPlaying: ServerPlayingState = {
    ...playing,
    currentTurnSeat: isRoundComplete ? null : winnerSeat,
    completedTricks: nextCompletedTricks,
    lastCompletedTrickWinnerSeat: winnerSeat,
    lastCompletedTrickWinnerTeam: winnerTeam,
    currentTrick: {
      leaderSeat: winnerSeat,
      currentSeat: isRoundComplete ? null : winnerSeat,
      plays: [],
      winnerSeat: null,
      trickIndex: trickIndex + 1,
    },
    wonTricksBySeat: {
      ...playing.wonTricksBySeat,
      [winnerSeat]: [...playing.wonTricksBySeat[winnerSeat], trickCards],
    },
    wonTricksByTeam: {
      ...playing.wonTricksByTeam,
      [winnerTeam]: [...playing.wonTricksByTeam[winnerTeam], trickCards],
    },
  }

  if (isRoundComplete) {
    return {
      ...state,
      phase: 'playing',
      phaseEnteredAt: Date.now(),
      playing: nextPlaying,
      timer: clearServerTimerState(),
    }
  }

  const nextState: ServerAuthoritativeGameState = {
    ...state,
    playing: nextPlaying,
  }
  const timerStartsAt =
    getServerTimerNow() + SERVER_TIMING_CONFIG.playAfterTrickCollectionDelayMs
  const winnerTimerStartedAt = isServerSeatControlledByBot(nextState, winnerSeat)
    ? timerStartsAt - SERVER_TIMING_CONFIG.playBotDelayMs
    : timerStartsAt

  return {
    ...nextState,
    timer: createServerPlayingTimerState(
      nextState,
      winnerSeat,
      winnerTimerStartedAt,
    ),
  }
}

export function submitServerPlayCard(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  cardId: string,
  declarationKeys: string[] = [],
): ServerAuthoritativeGameState {
  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return state
  }

  if (playing.currentTurnSeat !== seat) {
    return state
  }

  const hand = state.hands[seat]
  const cardIndex = hand.findIndex((c) => c.id === cardId)

  if (cardIndex === -1) {
    return state
  }

  const card = hand[cardIndex]

  const validCards = getServerValidPlayCards(state, seat)
  const isValidCard = validCards.some((c) => c.id === cardId)

  if (!isValidCard) {
    return state
  }

  const declarationValidation = validateServerDeclarationKeysForPlay(
    state,
    seat,
    cardId,
    declarationKeys,
  )

  if (!declarationValidation.ok) {
    return state
  }

  const nextHand = hand.filter((_, i) => i !== cardIndex)

  const updatedPlays = [...playing.currentTrick.plays, { seat, card }]
  const trickComplete = updatedPlays.length >= 4

  const stateWithCard: ServerAuthoritativeGameState = {
    ...state,
    hands: { ...state.hands, [seat]: nextHand },
    declarations: [
      ...state.declarations,
      ...declarationValidation.declarations,
    ],
  }

  if (trickComplete) {
    return applyTrickCompletion(stateWithCard, playing, updatedPlays)
  }

  const nextSeat = getNextSeat(seat)

  return {
    ...stateWithCard,
    playing: {
      ...playing,
      currentTurnSeat: nextSeat,
      currentTrick: {
        ...playing.currentTrick,
        plays: updatedPlays,
        currentSeat: nextSeat,
      },
    },
    timer: createServerPlayingTimerState(stateWithCard, nextSeat),
  }
}

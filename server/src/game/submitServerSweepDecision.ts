import type { Seat } from '../core/serverTypes.js'
import { SERVER_SEAT_ORDER } from '../core/serverTypes.js'
import { detectServerDeclarationsInHand } from './declarations/index.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerCompletedTrick,
  ServerDeclaration,
  ServerSweepAutoCreditedBelote,
} from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getTeamBySeat } from './serverStateHelpers.js'
import { createServerDeclarationRecord } from './serverDeclarationRecordHelpers.js'
import {
  addDeclarationsToMatchMissionCounts,
  addDeclarationsToMatchMissionCountsBySeat,
} from './serverDeclarationMissionCounts.js'
import {
  clearServerTimerState,
  createServerPlayingTimerState,
  getServerTimerNow,
} from './serverTimerStateHelpers.js'
import { computeServerSweepEligibility } from './computeServerSweepEligibility.js'

const TRICKS_PER_ROUND = 8

function buildThrowOrder(winnerSeat: Seat): Seat[] {
  const order: Seat[] = [winnerSeat]
  let seat = getNextSeat(winnerSeat)
  for (let i = 0; i < 3; i += 1) {
    order.push(seat)
    seat = getNextSeat(seat)
  }
  return order
}

// Undeclared belotes (K+Q of trump pair) across ALL FOUR hands, auto-credited
// to the correct team on sweep accept — скипва вече обявените (dedupe по
// candidate.key в state.declarations за същото място), не прави conflict
// resolution защото belote-кандидатите в ЕДНА ръка никога не делят карти
// помежду си (различни масти), за разлика от square/sequence.
function collectUndeclaredBelotesAcrossAllHands(
  state: ServerAuthoritativeGameState,
  trickIndexForRecord: number,
): { declarations: ServerDeclaration[]; autoCredited: ServerSweepAutoCreditedBelote[] } {
  const declarations: ServerDeclaration[] = []
  const autoCredited: ServerSweepAutoCreditedBelote[] = []

  for (const seat of SERVER_SEAT_ORDER) {
    const existingKeysForSeat = new Set(
      state.declarations
        .filter((declaration) => declaration.seat === seat)
        .map((declaration) => declaration.key),
    )
    const candidates = detectServerDeclarationsInHand(
      state.hands[seat],
      state.bidding.winningBid,
    ).filter((candidate) => candidate.type === 'belote' && !existingKeysForSeat.has(candidate.key))

    for (const candidate of candidates) {
      // valid stays true (per createServerDeclarationRecord) so the EXISTING,
      // unmodified scoring pipeline (scoreServerDeclarations.ts) picks it up —
      // see judgment-call note in the final report: announced is kept TRUE
      // here (not false) because scoreServerDeclarations.ts AND
      // renderScoringPanel.ts both gate on `announced === true`, confirmed by
      // reading both files; the client's "Белот +20" auto-credit indicator is
      // driven separately by ServerSweepResolution.autoCreditedBelotes, not by
      // inspecting this record's announced flag.
      const record = createServerDeclarationRecord({
        candidate,
        seat,
        declaredAtTrickIndex: trickIndexForRecord,
      })
      declarations.push(record)
      autoCredited.push({
        seat,
        team: getTeamBySeat(seat),
        suit: candidate.privateMetadata.suit!,
      })
    }
  }

  return { declarations, autoCredited }
}

export function submitServerSweepDecision(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  decision: 'accept' | 'decline',
): ServerAuthoritativeGameState {
  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return state
  }

  if (playing.sweepOffer === null) {
    return state
  }

  if (playing.sweepOffer.seat !== seat) {
    return state
  }

  if (decision === 'decline') {
    return {
      ...state,
      playing: {
        ...playing,
        sweepOffer: null,
        declinedSweepSeats: playing.declinedSweepSeats.includes(seat)
          ? playing.declinedSweepSeats
          : [...playing.declinedSweepSeats, seat],
        currentTurnSeat: seat,
        currentTrick: {
          ...playing.currentTrick,
          currentSeat: seat,
        },
      },
      timer: createServerPlayingTimerState(state, seat),
    }
  }

  // decision === 'accept' — re-validate server-authoritatively against the
  // CURRENT hands (never trust the client's earlier snapshot of eligibility).
  const stillEligible = computeServerSweepEligibility({
    sweepSeat: seat,
    hands: state.hands,
    winningBid: state.bidding.winningBid,
  })

  if (!stillEligible) {
    return state
  }

  const handsAtResolution: Record<Seat, ServerCard[]> = {
    bottom: [...state.hands.bottom],
    right: [...state.hands.right],
    top: [...state.hands.top],
    left: [...state.hands.left],
  }

  const trickIndexForRecord = playing.currentTrick.trickIndex
  const { declarations: autoBeloteDeclarations, autoCredited } =
    collectUndeclaredBelotesAcrossAllHands(state, trickIndexForRecord)

  const remainingCount = TRICKS_PER_ROUND - playing.completedTricks.length
  const winnerTeam = getTeamBySeat(seat)

  const synthesizedTricks: ServerCompletedTrick[] = []
  for (let i = 0; i < remainingCount; i += 1) {
    synthesizedTricks.push({
      trickIndex: trickIndexForRecord + i,
      leaderSeat: seat,
      winnerSeat: seat,
      winningTeam: winnerTeam,
      plays: SERVER_SEAT_ORDER.map((s) => ({ seat: s, card: handsAtResolution[s][i]! })),
    })
  }

  const synthesizedTrickCardGroups = synthesizedTricks.map((trick) => trick.plays.map((p) => p.card))

  const nextDeclarations = [...state.declarations, ...autoBeloteDeclarations]
  const nextMatchDeclarationMissionCounts = addDeclarationsToMatchMissionCounts(
    state.matchDeclarationMissionCounts,
    autoBeloteDeclarations,
  )
  const nextMatchDeclarationMissionCountsBySeat = addDeclarationsToMatchMissionCountsBySeat(
    state.matchDeclarationMissionCountsBySeat,
    autoBeloteDeclarations,
  )

  const nextState: ServerAuthoritativeGameState = {
    ...state,
    // Re-stamp phaseEnteredAt (phase stays 'playing') so
    // getServerPhaseAutoAdvanceExpiry counts sweepResolutionAutoAdvanceMs
    // from THIS moment (sweep accepted), not from whenever the 'playing'
    // phase originally began — mirrors applyTrickCompletion's isRoundComplete
    // branch in submitServerPlayCard.ts, which does the same for the normal
    // round-complete-via-last-trick case.
    phaseEnteredAt: getServerTimerNow(),
    hands: { bottom: [], right: [], top: [], left: [] },
    declarations: nextDeclarations,
    matchDeclarationMissionCounts: nextMatchDeclarationMissionCounts,
    matchDeclarationMissionCountsBySeat: nextMatchDeclarationMissionCountsBySeat,
    playing: {
      ...playing,
      completedTricks: [...playing.completedTricks, ...synthesizedTricks],
      wonTricksBySeat: {
        ...playing.wonTricksBySeat,
        [seat]: [...playing.wonTricksBySeat[seat], ...synthesizedTrickCardGroups],
      },
      wonTricksByTeam: {
        ...playing.wonTricksByTeam,
        [winnerTeam]: [...playing.wonTricksByTeam[winnerTeam], ...synthesizedTrickCardGroups],
      },
      currentTurnSeat: null,
      currentTrick: {
        leaderSeat: null,
        currentSeat: null,
        plays: [],
        winnerSeat: null,
        trickIndex: trickIndexForRecord + remainingCount,
      },
      lastCompletedTrickWinnerSeat: seat,
      lastCompletedTrickWinnerTeam: winnerTeam,
      sweepOffer: null,
      sweepResolution: {
        winnerSeat: seat,
        winnerTeam,
        throwOrder: buildThrowOrder(seat),
        handsAtResolution,
        autoCreditedBelotes: autoCredited,
        resolvedAt: getServerTimerNow(),
      },
    },
    timer: clearServerTimerState(),
  }

  return nextState
}

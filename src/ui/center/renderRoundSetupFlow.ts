import type { Seat } from '../../data/constants/seatOrder'
import {
  renderRoundSetupSequence,
  type RoundSetupSequencePhase,
} from './renderRoundSetupSequence'

export type RoundSetupFlowResult = {
  isRoundSetupPhase: boolean
  shouldHideCenterDeck: boolean
  centerContent: string
  seatHandCounts: Record<Seat, number>
  nextRerenderInMs: number | null
}

type RoundSetupFlowParams = {
  phase: string
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  selectedCutIndex: number | null | undefined
  actualHandCounts: Record<Seat, number>
  phaseEnteredAt?: number | null
}

function createEmptySeatCounts(): Record<Seat, number> {
  return {
    bottom: 0,
    right: 0,
    top: 0,
    left: 0,
  }
}

function createActualSeatCounts(actualHandCounts: Record<Seat, number>): Record<Seat, number> {
  return {
    bottom: actualHandCounts.bottom,
    right: actualHandCounts.right,
    top: actualHandCounts.top,
    left: actualHandCounts.left,
  }
}

function isRoundSetupSequencePhase(phase: string): phase is RoundSetupSequencePhase {
  return (
    phase === 'new-game' ||
    phase === 'choose-first-dealer' ||
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'deal-last-3'
  )
}

export function getRoundSetupFlowResult(
  params: RoundSetupFlowParams
): RoundSetupFlowResult {
  const {
    phase,
    dealerSeat,
    cutterSeat,
    selectedCutIndex,
    actualHandCounts,
  } = params

  if (!isRoundSetupSequencePhase(phase)) {
    return {
      isRoundSetupPhase: false,
      shouldHideCenterDeck: false,
      centerContent: '',
      seatHandCounts: createActualSeatCounts(actualHandCounts),
      nextRerenderInMs: null,
    }
  }

  if (phase === 'cutting' || phase === 'cut-resolve') {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: renderRoundSetupSequence({
        phase,
        cutterSeat,
        selectedCutIndex,
        dealerSeat,
      }),
      seatHandCounts: createEmptySeatCounts(),
      nextRerenderInMs: null,
    }
  }

  if (phase === 'deal-first-3') {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: renderRoundSetupSequence({
        phase,
        cutterSeat,
        selectedCutIndex,
        dealerSeat,
      }),
      seatHandCounts: createActualSeatCounts(actualHandCounts),
      nextRerenderInMs: null,
    }
  }

  if (phase === 'deal-next-2') {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: renderRoundSetupSequence({
        phase,
        cutterSeat,
        selectedCutIndex,
        dealerSeat,
      }),
      seatHandCounts: createActualSeatCounts(actualHandCounts),
      nextRerenderInMs: null,
    }
  }

  return {
    isRoundSetupPhase: true,
    shouldHideCenterDeck: true,
    centerContent: '',
    seatHandCounts: createActualSeatCounts(actualHandCounts),
    nextRerenderInMs: null,
  }
}
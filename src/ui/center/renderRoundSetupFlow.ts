import type { Seat } from '../../data/constants/seatOrder'
import {
  renderRoundSetupSequence,
  type RoundSetupSequencePhase,
} from './renderRoundSetupSequence'

type RoundSetupFlowResult = {
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
}

function createEmptySeatCounts(): Record<Seat, number> {
  return {
    bottom: 0,
    right: 0,
    top: 0,
    left: 0,
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
    cutterSeat,
    selectedCutIndex,
    actualHandCounts,
  } = params

  if (!isRoundSetupSequencePhase(phase)) {
    return {
      isRoundSetupPhase: false,
      shouldHideCenterDeck: false,
      centerContent: '',
      seatHandCounts: {
        bottom: actualHandCounts.bottom,
        right: actualHandCounts.right,
        top: actualHandCounts.top,
        left: actualHandCounts.left,
      },
      nextRerenderInMs: null,
    }
  }

  const isCutPhase = phase === 'cutting' || phase === 'cut-resolve'

  if (isCutPhase) {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: renderRoundSetupSequence({
        phase,
        cutterSeat,
        selectedCutIndex,
      }),
      seatHandCounts: createEmptySeatCounts(),
      nextRerenderInMs: null,
    }
  }

  return {
    isRoundSetupPhase: true,
    shouldHideCenterDeck: true,
    centerContent: '',
    seatHandCounts: createEmptySeatCounts(),
    nextRerenderInMs: null,
  }
}
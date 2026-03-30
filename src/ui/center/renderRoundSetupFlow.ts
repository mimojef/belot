import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'
import { renderCuttingScreen } from './renderCuttingScreen'
import { renderDealAnimationScreen } from './renderDealAnimationScreen'

type DealAnimationPhase = 'deal-first-3' | 'deal-next-2' | 'deal-last-3'
type RoundSetupPhase = 'cutting' | 'cut-resolve' | DealAnimationPhase

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
}

const DEAL_PACKET_START_DELAY = 180
const DEAL_PACKET_FLIGHT_DURATION = 760
const DEAL_PACKET_DELAY_STEP_DEFAULT = 520
const DEAL_PACKET_DELAY_STEP_NEXT_TWO = 430

let flowClockKey = ''
let flowStartedAt = 0

function createEmptySeatCounts(): Record<Seat, number> {
  return {
    bottom: 0,
    right: 0,
    top: 0,
    left: 0,
  }
}

function cloneSeatCounts(counts: Record<Seat, number>): Record<Seat, number> {
  return {
    bottom: counts.bottom,
    right: counts.right,
    top: counts.top,
    left: counts.left,
  }
}

function isDealAnimationPhase(phase: string): phase is DealAnimationPhase {
  return (
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'deal-last-3'
  )
}

function isRoundSetupPhase(phase: string): phase is RoundSetupPhase {
  return phase === 'cutting' || phase === 'cut-resolve' || isDealAnimationPhase(phase)
}

function getDealOrder(dealerSeat: Seat | null): Seat[] {
  if (!dealerSeat) {
    return ['right', 'top', 'left', 'bottom']
  }

  const dealerIndex = SEAT_ORDER.indexOf(dealerSeat)

  if (dealerIndex === -1) {
    return ['right', 'top', 'left', 'bottom']
  }

  return [
    SEAT_ORDER[(dealerIndex + 1) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 2) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 3) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 4) % SEAT_ORDER.length],
  ]
}

function getFlowKey(
  phase: RoundSetupPhase,
  dealerSeat: Seat | null,
  cutterSeat: Seat | null
): string {
  if (phase === 'cutting') {
    return `${phase}:${cutterSeat ?? 'none'}`
  }

  if (phase === 'cut-resolve') {
    return `${phase}:${cutterSeat ?? 'none'}`
  }

  return `${phase}:${dealerSeat ?? 'none'}`
}

function syncFlowClock(
  phase: string,
  dealerSeat: Seat | null,
  cutterSeat: Seat | null
): void {
  if (!isRoundSetupPhase(phase)) {
    flowClockKey = ''
    flowStartedAt = 0
    return
  }

  const nextKey = getFlowKey(phase, dealerSeat, cutterSeat)

  if (flowClockKey === nextKey) {
    return
  }

  flowClockKey = nextKey
  flowStartedAt = Date.now()
}

function getElapsedMs(): number {
  if (flowStartedAt <= 0) {
    return 0
  }

  return Math.max(0, Date.now() - flowStartedAt)
}

function getPacketDelayStep(phase: DealAnimationPhase): number {
  return phase === 'deal-next-2'
    ? DEAL_PACKET_DELAY_STEP_NEXT_TWO
    : DEAL_PACKET_DELAY_STEP_DEFAULT
}

function getDealInitialCount(phase: DealAnimationPhase): number {
  if (phase === 'deal-first-3') return 0
  if (phase === 'deal-next-2') return 3
  return 5
}

function getDealFinalCount(phase: DealAnimationPhase): number {
  if (phase === 'deal-first-3') return 3
  if (phase === 'deal-next-2') return 5
  return 8
}

function getDealSeatCounts(
  phase: DealAnimationPhase,
  dealerSeat: Seat | null,
  elapsedMs: number
): { seatHandCounts: Record<Seat, number>; nextRerenderInMs: number | null } {
  const initialCount = getDealInitialCount(phase)
  const finalCount = getDealFinalCount(phase)
  const packetDelayStep = getPacketDelayStep(phase)
  const dealOrder = getDealOrder(dealerSeat)

  const seatHandCounts: Record<Seat, number> = {
    bottom: initialCount,
    right: initialCount,
    top: initialCount,
    left: initialCount,
  }

  let nextRevealAt: number | null = null

  for (let index = 0; index < dealOrder.length; index += 1) {
    const seat = dealOrder[index]
    const revealAt =
      DEAL_PACKET_START_DELAY +
      index * packetDelayStep +
      DEAL_PACKET_FLIGHT_DURATION

    if (elapsedMs >= revealAt) {
      seatHandCounts[seat] = finalCount
    } else if (nextRevealAt === null || revealAt < nextRevealAt) {
      nextRevealAt = revealAt
    }
  }

  return {
    seatHandCounts,
    nextRerenderInMs:
      nextRevealAt === null ? null : Math.max(16, nextRevealAt - elapsedMs + 10),
  }
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

  syncFlowClock(phase, dealerSeat, cutterSeat)

  if (!isRoundSetupPhase(phase)) {
    return {
      isRoundSetupPhase: false,
      shouldHideCenterDeck: false,
      centerContent: '',
      seatHandCounts: cloneSeatCounts(actualHandCounts),
      nextRerenderInMs: null,
    }
  }

  if (phase === 'cutting') {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: renderCuttingScreen(cutterSeat, selectedCutIndex),
      seatHandCounts: createEmptySeatCounts(),
      nextRerenderInMs: null,
    }
  }

  if (phase === 'cut-resolve') {
    return {
      isRoundSetupPhase: true,
      shouldHideCenterDeck: true,
      centerContent: '',
      seatHandCounts: createEmptySeatCounts(),
      nextRerenderInMs: null,
    }
  }

  const elapsedMs = getElapsedMs()
  const dealState = getDealSeatCounts(phase, dealerSeat, elapsedMs)

  return {
    isRoundSetupPhase: true,
    shouldHideCenterDeck: true,
    centerContent: renderDealAnimationScreen(phase, dealerSeat),
    seatHandCounts: dealState.seatHandCounts,
    nextRerenderInMs: dealState.nextRerenderInMs,
  }
}
import type { PhaseType } from './phaseTypes'

export const PHASE_FLOW: Record<PhaseType, PhaseType | null> = {
  'new-game': 'choose-first-dealer',
  'choose-first-dealer': 'cutting',
  'cutting': 'cut-resolve',
  'cut-resolve': 'deal-first-3',
  'deal-first-3': 'deal-next-2',
  'deal-next-2': 'bidding',
  'bidding': 'deal-last-3',
  'deal-last-3': 'playing',
  'playing': 'scoring',
  'scoring': 'next-round',
  'next-round': 'cutting',
  'match-ended': null,
}

export function getNextPhase(phase: PhaseType): PhaseType | null {
  return PHASE_FLOW[phase]
}

export function isFinalPhase(phase: PhaseType): boolean {
  return PHASE_FLOW[phase] === null
}
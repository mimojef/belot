import type { AuthoritativePhaseType } from './serverPhaseTypes.js'

export const SERVER_PHASE_FLOW: Record<
  AuthoritativePhaseType,
  AuthoritativePhaseType | null
> = {
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

export function getNextServerPhase(
  phase: AuthoritativePhaseType,
): AuthoritativePhaseType | null {
  return SERVER_PHASE_FLOW[phase]
}

export function isServerFinalPhase(
  phase: AuthoritativePhaseType,
): boolean {
  return SERVER_PHASE_FLOW[phase] === null
}
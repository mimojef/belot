export const AUTHORITATIVE_PHASE_TYPES = [
  'new-game',
  'choose-first-dealer',
  'cutting',
  'cut-resolve',
  'deal-first-3',
  'deal-next-2',
  'bidding',
  'deal-last-3',
  'playing',
  'scoring',
  'next-round',
  'match-ended',
] as const

export type AuthoritativePhaseType = (typeof AUTHORITATIVE_PHASE_TYPES)[number]

export function isAuthoritativeRoundSetupPhase(
  phase: AuthoritativePhaseType,
): boolean {
  return (
    phase === 'new-game' ||
    phase === 'choose-first-dealer' ||
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3'
  )
}

export function isAuthoritativePlayingPhase(
  phase: AuthoritativePhaseType,
): boolean {
  return phase === 'playing'
}

export function isAuthoritativeScoringPhase(
  phase: AuthoritativePhaseType,
): boolean {
  return phase === 'scoring' || phase === 'next-round'
}
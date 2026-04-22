import type { ServerGamePhase } from '../core/serverTypes.js'
import type { AuthoritativePhaseType } from './serverPhaseTypes.js'

export function mapAuthoritativePhaseToRuntimePhase(
  phase: AuthoritativePhaseType,
): ServerGamePhase {
  if (
    phase === 'new-game' ||
    phase === 'choose-first-dealer' ||
    phase === 'cutting' ||
    phase === 'cut-resolve' ||
    phase === 'deal-first-3' ||
    phase === 'deal-next-2'
  ) {
    return 'cutting'
  }

  if (phase === 'bidding') {
    return 'bidding'
  }

  if (phase === 'deal-last-3' || phase === 'playing') {
    return 'playing'
  }

  if (phase === 'scoring' || phase === 'next-round') {
    return 'scoring'
  }

  return 'finished'
}
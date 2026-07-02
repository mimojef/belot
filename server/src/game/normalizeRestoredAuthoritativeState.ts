import type {
  ServerAuthoritativeGameState,
  ServerScoringState,
} from './serverGameTypes.js'

type ServerScoringOutcome = ServerScoringState['outcome']

const LEGACY_OUTCOME_SHORT_LABELS: Record<string, ServerScoringOutcome> = {
  ['\u0418\u0437\u043a\u0430\u0440\u0430\u043d\u0430']: 'made',
  ['\u0412\u044a\u0442\u0440\u0435']: 'inside',
  ['\u0420\u0430\u0432\u043d\u0430']: 'tie',
}

function isServerScoringOutcome(value: unknown): value is ServerScoringOutcome {
  return value === 'made' || value === 'inside' || value === 'tie'
}

export function normalizeServerScoringState(
  scoring: ServerScoringState | null,
): ServerScoringState | null {
  if (scoring === null) return null

  const legacyScoring = scoring as ServerScoringState & {
    outcome?: unknown
    outcomeShortLabel?: unknown
  }

  if (isServerScoringOutcome(legacyScoring.outcome)) {
    return scoring
  }

  const mappedOutcome =
    typeof legacyScoring.outcomeShortLabel === 'string'
      ? LEGACY_OUTCOME_SHORT_LABELS[legacyScoring.outcomeShortLabel]
      : undefined

  return {
    ...scoring,
    outcome: mappedOutcome ?? 'made',
  }
}

export function normalizeRestoredAuthoritativeState(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  const normalizedScoring = normalizeServerScoringState(state.scoring)

  if (normalizedScoring === state.scoring) {
    return state
  }

  return {
    ...state,
    scoring: normalizedScoring,
  }
}

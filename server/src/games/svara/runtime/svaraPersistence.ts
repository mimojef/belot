import type { SvaraMatchState } from '../engine/svaraMatch.js'
import type { SvaraDeadline } from './svaraDeadlines.js'

/** Server-only durable format. Never pass to the client snapshot serializer. */
export type SvaraStoredMatch = {
  formatVersion: 1
  matchId: string
  revision: number
  state: SvaraMatchState
  deadlines: SvaraDeadline[]
  deadlineSequence: number
}

export class SvaraPersistenceError extends Error {
  constructor(readonly code: 'write-failed' | 'revision-conflict' | 'match-exists' | 'invalid-snapshot' | 'recovery-failed' | 'commitment-conflict' | 'schema-missing') {
    super(`Svara persistence ${code}`) // No SQL, hidden state or underlying exception in logs/clients.
    this.name = 'SvaraPersistenceError'
  }
}

export interface SvaraMatchPersistence {
  /** Synchronous commit. null inserts only; a revision replaces exactly that revision. */
  save(snapshot: SvaraStoredMatch, expectedRevision: number | null): void
  /** Strictly server-only validated reads; never a client snapshot. */
  load(matchId: string): SvaraStoredMatch | null
  loadActiveMatches(): SvaraStoredMatch[]
  /** Durable admission guard, including initialization/quarantine. */
  findActiveMatchId(playerId: string): string | null
}

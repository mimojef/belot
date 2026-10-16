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
  constructor(readonly code: 'write-failed' | 'revision-conflict' | 'match-exists' | 'invalid-snapshot') {
    super(`Svara persistence ${code}`) // No SQL, hidden state or underlying exception in logs/clients.
    this.name = 'SvaraPersistenceError'
  }
}

export interface SvaraMatchPersistence {
  /** Synchronous commit. null inserts only; a revision replaces exactly that revision. */
  save(snapshot: SvaraStoredMatch, expectedRevision: number | null): void
  /** Strictly server-only; no automatic startup/recovery in 2Б.3.6А. */
  load(matchId: string): SvaraStoredMatch | null
  /** Read-only admission guard until startup recovery exists. */
  findActiveMatchId(playerId: string): string | null
}

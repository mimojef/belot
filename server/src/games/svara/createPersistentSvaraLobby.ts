import { createSvaraMatchSnapshotStore } from '../../db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from './createSvaraLobby.js'
import { SvaraPersistenceError, type SvaraMatchPersistence } from './runtime/svaraPersistence.js'
import type { SvaraClock } from './runtime/createSvaraLifecycle.js'

/** Isolate Svara startup failures from the rest of the platform. No migrations here. */
export async function createPersistentSvaraLobby(deps: {
  databaseFilePath: string
  hasOtherGameCommitment: (profileId: string) => boolean
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
  clock?: SvaraClock
}) {
  let persistence: SvaraMatchPersistence
  let close = () => {}
  try {
    const store = await createSvaraMatchSnapshotStore(deps.databaseFilePath)
    persistence = store
    close = () => store.close()
  } catch (cause) {
    const safe = cause instanceof SvaraPersistenceError ? cause : new SvaraPersistenceError('write-failed')
    const unavailable = (): never => { throw safe }
    persistence = { save: unavailable, load: unavailable, loadActiveMatches: unavailable,
      // A positively missing table contains no commitments. An unreadable store
      // cannot prove absence: new cross-game admissions must fail closed.
      findActiveMatchId: safe.code === 'schema-missing' ? () => null : unavailable }
  }
  const lobby = createSvaraLobby({ ...deps, persistence })
  return { lobby, close }
}

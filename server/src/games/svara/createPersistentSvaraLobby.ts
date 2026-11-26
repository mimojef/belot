import { createSvaraMatchSnapshotStore } from '../../db/svaraMatchSnapshotStore.js'
import { createSvaraLobby } from './createSvaraLobby.js'
import { SvaraPersistenceError, type SvaraMatchPersistence } from './runtime/svaraPersistence.js'
import type { SvaraClock } from './runtime/createSvaraLifecycle.js'
import type { SvaraTestBotsFactory } from './testBots/createSvaraTestBots.js' // ВРЕМЕННО — тестови ботове
import { createSvaraEconomyStore } from '../../db/svaraEconomyStore.js'
import { isSvaraPaidMatchesEnabled, type SvaraPaidEconomy } from './svaraPaidEconomy.js'

/** Isolate Svara startup failures from the rest of the platform. No migrations here. */
export async function createPersistentSvaraLobby(deps: {
  databaseFilePath: string
  hasOtherGameCommitment: (profileId: string) => boolean
  getPublicProfile?: (profileId: string) => { displayName: string; avatarUrl: string | null; gender?: 'male' | 'female' | null } | null
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
  clock?: SvaraClock
  /** ВРЕМЕННО — тестови ботове (docs/svara-test-bots-local.md). */
  testBots?: SvaraTestBotsFactory
  /** Етап 4Б: интервалът за увеличаване на антето (ms) — от админ настройката. */
  getAnteIncreaseIntervalMs?: () => number
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
  // Етап 3В.2: платената „Свара“ — САМО при SVARA_PAID_MATCHES_ENABLED=1.
  // Недостъпна икономика при включен флаг → 'unavailable' (новите маси се отказват).
  let paidEconomy: SvaraPaidEconomy | 'unavailable' | undefined
  if (isSvaraPaidMatchesEnabled()) {
    try {
      const economy = await createSvaraEconomyStore(deps.databaseFilePath)
      economy.ensureDefaultConfig()
      paidEconomy = economy
      const closeSnapshots = close
      close = () => { closeSnapshots(); economy.close() }
    } catch (cause) {
      deps.onError?.(cause)
      paidEconomy = 'unavailable'
    }
  }
  const lobby = createSvaraLobby({ ...deps, persistence, ...(paidEconomy !== undefined ? { paidEconomy } : {}) })
  return { lobby, close }
}

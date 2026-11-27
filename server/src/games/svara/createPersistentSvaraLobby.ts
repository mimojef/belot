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
  /** purpose 'recovery' — бариерата при рестарт (виж initializeRecovery). */
  hasOtherGameCommitment: (profileId: string, purpose?: 'admission' | 'recovery') => boolean
  getPublicProfile?: (profileId: string) => { displayName: string; avatarUrl: string | null; gender?: 'male' | 'female' | null } | null
  onError?: (error: unknown) => void
  onAdmission?: (profileId: string) => void
  /** Ролята по profileId — достъпът на всички участници при старт на нов мач. */
  getProfileRole?: (profileId: string) => string | null
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
  // Етап 4В: входовете и комисионите идват от общия каталог на масите
  // (match_rooms) → store-ът се създава винаги, и във виртуалния режим.
  // Етап 3В.2: финансовите операции — САМО при SVARA_PAID_MATCHES_ENABLED=1;
  // недостъпна икономика → 'unavailable'.
  let economy: Awaited<ReturnType<typeof createSvaraEconomyStore>> | null = null
  try {
    economy = await createSvaraEconomyStore(deps.databaseFilePath)
    const store = economy
    const closeSnapshots = close
    close = () => { closeSnapshots(); store.close() }
  } catch (cause) {
    deps.onError?.(cause)
    economy = null
  }
  const paidEconomy: SvaraPaidEconomy | 'unavailable' | undefined = isSvaraPaidMatchesEnabled() ? (economy ?? 'unavailable') : undefined
  const lobby = createSvaraLobby({ ...deps, persistence, svaraConfig: economy ?? 'unavailable', ...(paidEconomy !== undefined ? { paidEconomy } : {}) })
  /** Финансовият store (null — недостъпен) — за админ прегледа на задържаните изплащания. */
  return { lobby, close, finance: economy }
}

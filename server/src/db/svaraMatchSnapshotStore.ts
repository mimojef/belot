import { performance } from 'node:perf_hooks'
import { validateSvaraStoredMatch } from '../games/svara/runtime/svaraStoredMatchValidation.js'
import { SvaraPersistenceError, type SvaraMatchPersistence, type SvaraStoredMatch } from '../games/svara/runtime/svaraPersistence.js'

type Database = InstanceType<typeof import('node:sqlite').DatabaseSync>
export type SvaraMatchSnapshotStore = SvaraMatchPersistence & {
  close(): void
  getWriteMetricsForServer(): { writes: number; serializeMs: number; sqliteMs: number; lastBytes: number }
}

/** Reject lossy JSON values instead of silently dropping hidden game data. */
export function serializeSvaraStoredMatch(snapshot: SvaraStoredMatch): string {
  try {
    const json = JSON.stringify(snapshot, function (key, value: unknown) {
      const original: unknown = (this as Record<string, unknown>)[key]
      if (original !== value) throw new Error() // includes custom toJSON transformations
      if (original === undefined || typeof original === 'function' || typeof original === 'symbol' || typeof original === 'bigint') throw new Error()
      if (typeof original === 'number' && !Number.isSafeInteger(original)) throw new Error()
      if (original && typeof original === 'object' && !Array.isArray(original) &&
        Object.getPrototypeOf(original) !== Object.prototype && Object.getPrototypeOf(original) !== null) throw new Error()
      return value
    })
    validateSvaraStoredMatch(snapshot, false)
    return json
  } catch { throw new SvaraPersistenceError('invalid-snapshot') }
}

/** The existing project database, independent synchronous connection, WAL + FULL durability.
 * No upsert: insertion is unique, updates compare revision inside one transaction.
 * Every error is sanitized here; SQL/corrupt JSON can contain private cards. */
export async function createSvaraMatchSnapshotStore(databaseFilePath: string): Promise<SvaraMatchSnapshotStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const database: Database = new DatabaseSync(databaseFilePath, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'svara_match_snapshots'").get()) throw new SvaraPersistenceError('schema-missing')
    const insert = database.prepare(`INSERT OR IGNORE INTO svara_match_snapshots
      (match_id, format_version, revision, match_status, snapshot_json, finished_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? IN ('finished', 'closed') THEN CURRENT_TIMESTAMP ELSE NULL END)`)
    const update = database.prepare(`UPDATE svara_match_snapshots SET format_version = ?, revision = ?, match_status = ?, snapshot_json = ?,
      updated_at = CURRENT_TIMESTAMP, finished_at = CASE WHEN ? IN ('finished', 'closed') THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE NULL END
      WHERE match_id = ? AND revision = ? AND format_version = 1 AND match_status NOT IN ('finished', 'closed')`)
    const read = database.prepare('SELECT format_version, revision, match_status, snapshot_json FROM svara_match_snapshots WHERE match_id = ?')
    const active = database.prepare("SELECT match_id FROM svara_match_snapshots WHERE match_status NOT IN ('finished', 'closed') ORDER BY match_id")
    const commitments = database.prepare(`SELECT match_id, match_status, snapshot_json FROM svara_match_snapshots
      WHERE match_status NOT IN ('finished', 'closed') ORDER BY match_id`)
    const metrics = { writes: 0, serializeMs: 0, sqliteMs: 0, lastBytes: 0 }
    const store: SvaraMatchSnapshotStore = {
      save(snapshot, expectedRevision) {
        const started = performance.now()
        const json = serializeSvaraStoredMatch(snapshot) // before BEGIN: serialization failure cannot write anything
        const serialized = performance.now()
        if (snapshot.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new SvaraPersistenceError('revision-conflict')
        try {
          database.exec('BEGIN IMMEDIATE')
          const status = snapshot.state.phase
          const result = expectedRevision === null
            ? insert.run(snapshot.matchId, snapshot.formatVersion, snapshot.revision, status, json, status)
            : update.run(snapshot.formatVersion, snapshot.revision, status, json, status, snapshot.matchId, expectedRevision)
          if (result.changes !== 1) throw new SvaraPersistenceError(expectedRevision === null ? 'match-exists' : 'revision-conflict')
          database.exec('COMMIT')
          metrics.writes++
          metrics.serializeMs += serialized - started
          metrics.sqliteMs += performance.now() - serialized
          metrics.lastBytes = Buffer.byteLength(json, 'utf8')
        } catch (cause) {
          try { database.exec('ROLLBACK') } catch { /* failed BEGIN has no transaction */ }
          throw cause instanceof SvaraPersistenceError ? cause : new SvaraPersistenceError('write-failed')
        }
      },
      load(matchId) {
        try {
          const row = read.get(matchId) as { format_version: number; revision: number; match_status: string; snapshot_json: string } | undefined
          if (!row) return null
          const snapshot = JSON.parse(row.snapshot_json) as SvaraStoredMatch
          validateSvaraStoredMatch(snapshot)
          if (snapshot.matchId !== matchId || snapshot.formatVersion !== row.format_version || snapshot.revision !== row.revision || snapshot.state.phase !== row.match_status) throw new Error()
          return snapshot
        } catch { throw new SvaraPersistenceError('invalid-snapshot') }
      },
      findActiveMatchId(playerId) {
        try {
          let found: string | null = null
          // A malformed membership must never silently look like "no seat".
          // Validate this small projection separately so bad cards/balances can
          // quarantine Svara without blocking unrelated profiles' other games.
          for (const row of commitments.all() as Array<{ match_id: string; match_status: string; snapshot_json: string }>) {
            const snapshot = JSON.parse(row.snapshot_json) as SvaraStoredMatch, state = snapshot.state
            const seats = state?.seats, status = state?.status
            if (snapshot.formatVersion !== 1 || snapshot.matchId !== row.match_id || !['lobby', 'in-progress'].includes(row.match_status) || state?.phase !== row.match_status ||
              !Array.isArray(seats) || seats.length < 1 || seats.length > 4 || new Set(seats).size !== seats.length ||
              !status || typeof status !== 'object' || Array.isArray(status) || Object.keys(status).length !== seats.length ||
              seats.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128 || !Object.hasOwn(status, id) ||
                !['active', 'absent', 'exited', 'eliminated'].includes(status[id]!))) throw new Error()
            if (seats.includes(playerId) && ['active', 'absent'].includes(status[playerId]!)) found ??= row.match_id
          }
          return found
        }
        catch { throw new SvaraPersistenceError('invalid-snapshot') }
      },
      loadActiveMatches() {
        try {
          database.exec('BEGIN')
          const snapshots = (active.all() as Array<{ match_id: string }>).map((row) => {
            const snapshot = this.load(row.match_id)
            if (!snapshot || !['lobby', 'in-progress'].includes(snapshot.state.phase)) throw new Error()
            return snapshot
          })
          database.exec('COMMIT')
          return snapshots
        } catch {
          try { database.exec('ROLLBACK') } catch { /* failed BEGIN */ }
          throw new SvaraPersistenceError('invalid-snapshot')
        }
      },
      close: () => database.close(),
      getWriteMetricsForServer: () => ({ ...metrics }),
    }
    return store
  } catch (cause) {
    database.close()
    throw cause instanceof SvaraPersistenceError ? cause : new SvaraPersistenceError('write-failed')
  }
}

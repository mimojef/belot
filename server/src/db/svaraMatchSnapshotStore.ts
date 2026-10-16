import { assertSvaraMatchInvariants } from '../games/svara/engine/svaraMatch.js'
import { performance } from 'node:perf_hooks'
import { planSvaraDeadlines } from '../games/svara/runtime/svaraDeadlines.js'
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
    validateSnapshot(snapshot)
    return json
  } catch { throw new SvaraPersistenceError('invalid-snapshot') }
}

function validateSnapshot(snapshot: SvaraStoredMatch): void {
  if (snapshot.formatVersion !== 1 || !snapshot.matchId || snapshot.state.config.tableId !== snapshot.matchId ||
    !['lobby', 'in-progress', 'finished', 'closed'].includes(snapshot.state.phase) ||
    !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
    Object.keys(snapshot.state.processedCommands).length !== snapshot.revision ||
    !Number.isSafeInteger(snapshot.deadlineSequence) || snapshot.deadlineSequence < 0 || !Array.isArray(snapshot.deadlines)) throw new Error()
  assertSvaraMatchInvariants(snapshot.state)
  const kinds = new Set<string>()
  for (const deadline of snapshot.deadlines) {
    if (snapshot.state.phase !== 'in-progress' || deadline.phase !== 'in-progress' ||
      !['turn', 'svara-joining', 'presence-wait'].includes(deadline.kind) || kinds.has(deadline.kind) ||
      typeof deadline.key !== 'string' || !Number.isSafeInteger(deadline.deadlineAt) ||
      !Number.isSafeInteger(deadline.generation) || deadline.generation < 1 || deadline.generation > snapshot.deadlineSequence ||
      !Number.isSafeInteger(deadline.baseRevision) || deadline.baseRevision < 0 || deadline.baseRevision > snapshot.revision ||
      !Number.isSafeInteger(deadline.actionVersion) || deadline.actionVersion < 0 ||
      !(deadline.playerId === null || typeof deadline.playerId === 'string') ||
      !(deadline.roundId === null || typeof deadline.roundId === 'string')) throw new Error()
    kinds.add(deadline.kind)
  }
  const expected = planSvaraDeadlines(snapshot.state, snapshot.revision, snapshot.deadlines, snapshot.deadlineSequence, 0)
  if (expected.deadlineSequence !== snapshot.deadlineSequence || JSON.stringify(expected.deadlines) !== JSON.stringify(snapshot.deadlines)) throw new Error()
}

/** The existing project database, independent synchronous connection, WAL + FULL durability.
 * No upsert: insertion is unique, updates compare revision inside one transaction.
 * Every error is sanitized here; SQL/corrupt JSON can contain private cards. */
export async function createSvaraMatchSnapshotStore(databaseFilePath: string): Promise<SvaraMatchSnapshotStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const database: Database = new DatabaseSync(databaseFilePath, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
    const insert = database.prepare(`INSERT OR IGNORE INTO svara_match_snapshots
      (match_id, format_version, revision, match_status, snapshot_json, finished_at)
      VALUES (?, ?, ?, ?, ?, CASE WHEN ? IN ('finished', 'closed') THEN CURRENT_TIMESTAMP ELSE NULL END)`)
    const update = database.prepare(`UPDATE svara_match_snapshots SET format_version = ?, revision = ?, match_status = ?, snapshot_json = ?,
      updated_at = CURRENT_TIMESTAMP, finished_at = CASE WHEN ? IN ('finished', 'closed') THEN COALESCE(finished_at, CURRENT_TIMESTAMP) ELSE NULL END
      WHERE match_id = ? AND revision = ? AND format_version = 1 AND match_status NOT IN ('finished', 'closed')`)
    const read = database.prepare('SELECT format_version, revision, match_status, snapshot_json FROM svara_match_snapshots WHERE match_id = ?')
    const commitment = database.prepare(`SELECT m.match_id FROM svara_match_snapshots m, json_each(m.snapshot_json, '$.state.seats') seat,
      json_each(m.snapshot_json, '$.state.status') status
      WHERE m.match_status IN ('lobby', 'in-progress') AND seat.value = ?
      AND status.key = seat.value AND status.value IN ('active', 'absent') LIMIT 1`)
    const metrics = { writes: 0, serializeMs: 0, sqliteMs: 0, lastBytes: 0 }
    return {
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
          validateSnapshot(snapshot)
          if (snapshot.matchId !== matchId || snapshot.formatVersion !== row.format_version || snapshot.revision !== row.revision || snapshot.state.phase !== row.match_status) throw new Error()
          return snapshot
        } catch { throw new SvaraPersistenceError('invalid-snapshot') }
      },
      findActiveMatchId(playerId) {
        try { return (commitment.get(playerId) as { match_id: string } | undefined)?.match_id ?? null }
        catch { throw new SvaraPersistenceError('invalid-snapshot') }
      },
      close: () => database.close(),
      getWriteMetricsForServer: () => ({ ...metrics }),
    }
  } catch {
    database.close()
    throw new SvaraPersistenceError('write-failed')
  }
}

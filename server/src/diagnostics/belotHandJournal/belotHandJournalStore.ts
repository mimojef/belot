// SQLite хранилище за belot hand журнала — ОТДЕЛЕН файл от основната база
// (server/database/diagnostics/belot-hand-journal.sqlite), за да не расте
// основната база/бекъпите и да няма lock конкуренция с gameplay таблиците.
//
// Запис: една транзакция на batch (виж createBelotHandJournal.ts — batch-ът
// се събира в рамките на един event-loop оборот). WAL + synchronous=NORMAL:
// редът е в WAL веднага след commit-а и оцелява при crash/PM2 рестарт на
// процеса (губи се само при спиране на захранването на машината).
//
// Тук са само SQLite операциите. Архивирането (ZSTD), сроковете и лимитът
// на диска са в runBelotHandJournalMaintenance.ts.

import { stat } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalEvent,
} from './belotHandJournalTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src|dist/diagnostics/belotHandJournal/ -> ../../.. -> server/
const SERVER_ROOT_PATH = resolve(__dirname, '..', '..', '..')
// Страници от по 500 реда при архивиране — кратки синхронни SQLite четения,
// между тях event loop-ът е свободен (setImmediate).
const ARCHIVE_PAGE_SIZE = 500
// incremental_vacuum на порции (≈2 MB при 4 KB страници), за да не блокира.
const VACUUM_PAGES_PER_STEP = 512
// WAL файлът се съкращава до този размер след checkpoint.
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024

export const BELOT_HAND_JOURNAL_DB_FILE_NAME = 'belot-hand-journal.sqlite'

export function getDefaultBelotHandJournalDirectory(): string {
  const override = process.env.BELOT_HAND_JOURNAL_DIR
  if (override && override.trim() !== '') return resolve(override.trim())
  return join(SERVER_ROOT_PATH, 'database', 'diagnostics')
}

export function getBelotHandJournalDatabasePath(directory: string): string {
  return join(directory, BELOT_HAND_JOURNAL_DB_FILE_NAME)
}

export function getBelotHandJournalArchiveDirectory(directory: string): string {
  return join(directory, 'belot-hand-journal-archive')
}

export function toUtcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export type BelotHandJournalStoredEvent = BelotHandJournalEvent & { id: number }

export type BelotHandJournalQuery = {
  roomId?: string
  matchId?: string
  handId?: string
  handIds?: readonly string[]
  profileId?: string
  sinceMs?: number
  untilMs?: number
  anomaliesOnly?: boolean
  eventTypes?: readonly string[]
  limit?: number
}

export type BelotHandJournalScoredHandClaim =
  | { duplicate: false }
  | { duplicate: true; previous: { roomId: string; matchId: string; scoredAtMs: number; matchBefore: string; matchAfter: string } }

export type BelotHandJournalDuplicateAnomalyBuilder = (
  event: BelotHandJournalEvent,
  claim: Extract<BelotHandJournalScoredHandClaim, { duplicate: true }>,
) => BelotHandJournalEvent

export type BelotHandJournalDayStats = { day: string; count: number; minId: number; maxId: number }

export type BelotHandJournalDbFileUsage = { dbBytes: number; walBytes: number; shmBytes: number }

export type BelotHandJournalStore = {
  readonly directory: string
  readonly databasePath: string
  readonly archiveDirectory: string
  readonly autoVacuumIncremental: boolean
  // Записва batch-а в ЕДНА транзакция. За всяко hand_scored в същата
  // транзакция минава пазачът срещу повторно начисляване (първото
  // hand_scored за handId печели); при дубликат се добавя anomaly ред от
  // buildDuplicateAnomaly. При грешка всичко (вкл. пазача) се rollback-ва.
  insertEvents: (
    events: readonly BelotHandJournalEvent[],
    buildDuplicateAnomaly?: BelotHandJournalDuplicateAnomalyBuilder,
  ) => { inserted: number; bytes: number; duplicates: BelotHandJournalEvent[]; serializeMs?: number }
  hasEventForHand: (handId: string, eventType: string) => boolean
  queryEvents: (query: BelotHandJournalQuery) => BelotHandJournalStoredEvent[]
  listDays: () => string[]
  getDayStats: (day: string) => BelotHandJournalDayStats | null
  countRowsInRange: (day: string, minId: number, maxId: number) => number
  // Редовете на деня (id в [minId, maxId]) като архивни JSONL редове, на
  // страници с пауза между тях.
  iterateDayArchiveLines: (day: string, minId: number, maxId: number) => AsyncGenerator<string>
  deleteDayRange: (day: string, minId: number, maxId: number) => number
  deleteDayIds: (day: string, ids: readonly number[]) => number
  deleteDaysBefore: (cutoffDay: string) => { deletedRows: number; days: string[] }
  deleteDay: (day: string) => number
  deleteScoredHandsBefore: (cutoffMs: number) => number
  // Физическо освобождаване: incremental_vacuum на порции + съкращаване на WAL.
  reclaimSpace: () => Promise<{ freedPages: number }>
  getDbFileUsage: () => Promise<BelotHandJournalDbFileUsage>
  getUsedBytes: () => number
  close: () => void
}

type EventRow = {
  id: number
  schema_version: number
  occurred_at_ms: number
  event_type: string
  severity: string
  room_id: string
  match_id: string
  hand_id: string | null
  profile_ids: string | null
  payload_json: string
}

const EVENT_COLUMNS =
  'id, schema_version, occurred_at_ms, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json'

function parseProfileIds(value: string | null): string[] | null {
  if (!value) return null
  return value.split(',').filter((id) => id !== '')
}

function rowToEvent(row: EventRow): BelotHandJournalStoredEvent {
  const profileIds = parseProfileIds(row.profile_ids)
  return {
    id: row.id,
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: row.schema_version,
    eventType: row.event_type as BelotHandJournalEvent['eventType'],
    severity: row.severity as BelotHandJournalEvent['severity'],
    occurredAtMs: row.occurred_at_ms,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    roomId: row.room_id,
    matchId: row.match_id,
    handId: row.hand_id,
    ...(profileIds ? { profileIds } : {}),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }
}

// Архивен ред = JSON.stringify(rowToEvent(row)) байт по байт, но без да
// парсва и сериализира наново payload-а (вграждаме payload_json директно).
// Ключовете са в същия ред като rowToEvent → JSON.parse връща идентичен обект.
export function rowToArchiveLine(row: EventRow): string {
  const profileIds = parseProfileIds(row.profile_ids)
  const meta = JSON.stringify({
    id: row.id,
    schema: BELOT_HAND_JOURNAL_SCHEMA,
    schemaVersion: row.schema_version,
    eventType: row.event_type,
    severity: row.severity,
    occurredAtMs: row.occurred_at_ms,
    occurredAt: new Date(row.occurred_at_ms).toISOString(),
    roomId: row.room_id,
    matchId: row.match_id,
    handId: row.hand_id,
    ...(profileIds ? { profileIds } : {}),
  })
  return `${meta.slice(0, -1)},"payload":${row.payload_json}}`
}

function initializeSchema(database: SqliteDatabase): void {
  // auto_vacuum трябва да е зададен преди първата таблица — позволява
  // incremental_vacuum да връща място на диска след изтриване (без VACUUM).
  database.exec('PRAGMA auto_vacuum = INCREMENTAL;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA synchronous = NORMAL;')
  database.exec('PRAGMA busy_timeout = 5000;')
  database.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`)
  database.exec(`
    CREATE TABLE IF NOT EXISTS belot_hand_journal_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS belot_hand_journal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schema_version INTEGER NOT NULL,
      occurred_at_ms INTEGER NOT NULL,
      day TEXT NOT NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      room_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      hand_id TEXT,
      profile_ids TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bhj_events_room ON belot_hand_journal_events (room_id, id);
    CREATE INDEX IF NOT EXISTS idx_bhj_events_match ON belot_hand_journal_events (match_id, id);
    CREATE INDEX IF NOT EXISTS idx_bhj_events_hand ON belot_hand_journal_events (hand_id, event_type);
    CREATE INDEX IF NOT EXISTS idx_bhj_events_day ON belot_hand_journal_events (day, id);
    CREATE INDEX IF NOT EXISTS idx_bhj_events_severity ON belot_hand_journal_events (severity, occurred_at_ms);
    CREATE INDEX IF NOT EXISTS idx_bhj_events_type_time ON belot_hand_journal_events (event_type, occurred_at_ms);
    CREATE TABLE IF NOT EXISTS belot_hand_journal_scored_hands (
      hand_id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      scored_at_ms INTEGER NOT NULL,
      match_before_json TEXT NOT NULL,
      match_after_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bhj_scored_time ON belot_hand_journal_scored_hands (scored_at_ms);
  `)
  database
    .prepare('INSERT INTO belot_hand_journal_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('schema_version', String(BELOT_HAND_JOURNAL_SCHEMA_VERSION))
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export async function createBelotHandJournalStore(options: {
  directory?: string
  readOnly?: boolean
} = {}): Promise<BelotHandJournalStore> {
  const directory = options.directory ?? getDefaultBelotHandJournalDirectory()
  const databasePath = getBelotHandJournalDatabasePath(directory)
  const archiveDirectory = getBelotHandJournalArchiveDirectory(directory)
  if (!options.readOnly) {
    await mkdir(directory, { recursive: true })
  }

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databasePath, {
    open: true,
    readOnly: options.readOnly === true,
  })
  if (!options.readOnly) {
    initializeSchema(database)
  }
  const autoVacuumMode = Number((database.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum)
  const autoVacuumIncremental = autoVacuumMode === 2
  if (!options.readOnly && !autoVacuumIncremental) {
    console.warn(
      `[belot-hand-journal] ${databasePath} е създадена без auto_vacuum=INCREMENTAL — изтритото място се преизползва, но файлът не се смалява. Еднократно (при спрян сървър): sqlite3 <db> "PRAGMA auto_vacuum=INCREMENTAL; VACUUM;"`,
    )
  }

  const insertEventStatement = options.readOnly
    ? null
    : database.prepare(`
        INSERT INTO belot_hand_journal_events
          (schema_version, occurred_at_ms, day, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

  function pragmaNumber(name: string): number {
    const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, number>
    return Number(row[name])
  }

  function getUsedBytes(): number {
    return (pragmaNumber('page_count') - pragmaNumber('freelist_count')) * pragmaNumber('page_size')
  }

  function claimScoredHand(event: BelotHandJournalEvent): BelotHandJournalScoredHandClaim {
    if (event.handId === null) return { duplicate: false }
    const explanation = (event.payload.explanation ?? null) as { matchBefore?: unknown; matchAfter?: unknown } | null
    const result = database
      .prepare(`
        INSERT OR IGNORE INTO belot_hand_journal_scored_hands
          (hand_id, room_id, match_id, scored_at_ms, match_before_json, match_after_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.handId,
        event.roomId,
        event.matchId,
        event.occurredAtMs,
        JSON.stringify(explanation?.matchBefore ?? null),
        JSON.stringify(explanation?.matchAfter ?? null),
      )
    if (Number(result.changes) > 0) return { duplicate: false }
    const previous = database
      .prepare('SELECT room_id, match_id, scored_at_ms, match_before_json, match_after_json FROM belot_hand_journal_scored_hands WHERE hand_id = ?')
      .get(event.handId) as
      | { room_id: string; match_id: string; scored_at_ms: number; match_before_json: string; match_after_json: string }
      | undefined
    return {
      duplicate: true,
      previous: {
        roomId: previous?.room_id ?? '',
        matchId: previous?.match_id ?? '',
        scoredAtMs: Number(previous?.scored_at_ms ?? 0),
        matchBefore: previous?.match_before_json ?? 'null',
        matchAfter: previous?.match_after_json ?? 'null',
      },
    }
  }

  function insertEvents(
    events: readonly BelotHandJournalEvent[],
    buildDuplicateAnomaly?: BelotHandJournalDuplicateAnomalyBuilder,
  ): { inserted: number; bytes: number; duplicates: BelotHandJournalEvent[]; serializeMs: number } {
    const duplicates: BelotHandJournalEvent[] = []
    if (insertEventStatement === null || events.length === 0) return { inserted: 0, bytes: 0, duplicates, serializeMs: 0 }
    let bytes = 0
    // Monitoring-only: сумарно време на payload JSON.stringify в batch-а.
    let serializeMs = 0
    const insertOne = (event: BelotHandJournalEvent) => {
      const serializeStartedAt = performance.now()
      const payloadJson = JSON.stringify(event.payload)
      serializeMs += performance.now() - serializeStartedAt
      bytes += payloadJson.length
      insertEventStatement.run(
        event.schemaVersion,
        event.occurredAtMs,
        toUtcDay(event.occurredAtMs),
        event.eventType,
        event.severity,
        event.roomId,
        event.matchId,
        event.handId,
        event.profileIds && event.profileIds.length > 0 ? `,${event.profileIds.join(',')},` : null,
        payloadJson,
      )
    }
    let inserted = 0
    database.exec('BEGIN IMMEDIATE;')
    try {
      for (const event of events) {
        insertOne(event)
        inserted += 1
        if (event.eventType !== 'hand_scored') continue
        const claim = claimScoredHand(event)
        if (claim.duplicate && buildDuplicateAnomaly) {
          const anomaly = buildDuplicateAnomaly(event, claim)
          insertOne(anomaly)
          inserted += 1
          duplicates.push(anomaly)
        }
      }
      database.exec('COMMIT;')
      return { inserted, bytes, duplicates, serializeMs }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // вече rollback-нато
      }
      throw error
    }
  }

  function hasEventForHand(handId: string, eventType: string): boolean {
    const row = database
      .prepare('SELECT 1 AS found FROM belot_hand_journal_events WHERE hand_id = ? AND event_type = ? LIMIT 1')
      .get(handId, eventType)
    return row !== undefined
  }

  function queryEvents(query: BelotHandJournalQuery): BelotHandJournalStoredEvent[] {
    const where: string[] = []
    const params: (string | number)[] = []
    if (query.roomId) {
      where.push('room_id = ?')
      params.push(query.roomId)
    }
    if (query.matchId) {
      where.push('match_id = ?')
      params.push(query.matchId)
    }
    if (query.handId) {
      where.push('hand_id = ?')
      params.push(query.handId)
    }
    if (query.handIds) {
      if (query.handIds.length === 0) return []
      where.push(`hand_id IN (${query.handIds.map(() => '?').join(',')})`)
      params.push(...query.handIds)
    }
    if (query.profileId) {
      // Профилът се пази само в hand_started; връщаме всички събития на
      // раздаванията, в които е участвал.
      where.push(`hand_id IN (
        SELECT hand_id FROM belot_hand_journal_events
        WHERE event_type = 'hand_started' AND profile_ids LIKE ?
      )`)
      params.push(`%,${query.profileId},%`)
    }
    if (query.sinceMs !== undefined) {
      where.push('occurred_at_ms >= ?')
      params.push(query.sinceMs)
    }
    if (query.untilMs !== undefined) {
      where.push('occurred_at_ms < ?')
      params.push(query.untilMs)
    }
    if (query.anomaliesOnly) {
      where.push("severity = 'anomaly'")
    }
    if (query.eventTypes && query.eventTypes.length > 0) {
      where.push(`event_type IN (${query.eventTypes.map(() => '?').join(',')})`)
      params.push(...query.eventTypes)
    }
    const limit = Math.max(1, Math.min(query.limit ?? 500000, 2000000))
    const sql = `
      SELECT ${EVENT_COLUMNS}
      FROM belot_hand_journal_events
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id ASC
      LIMIT ${limit}
    `
    return (database.prepare(sql).all(...params) as EventRow[]).map(rowToEvent)
  }

  function listDays(): string[] {
    return (database.prepare('SELECT DISTINCT day FROM belot_hand_journal_events ORDER BY day ASC').all() as { day: string }[]).map(
      (row) => row.day,
    )
  }

  function getDayStats(day: string): BelotHandJournalDayStats | null {
    const row = database
      .prepare('SELECT COUNT(*) AS count, MIN(id) AS min_id, MAX(id) AS max_id FROM belot_hand_journal_events WHERE day = ?')
      .get(day) as { count: number; min_id: number | null; max_id: number | null }
    if (!row || Number(row.count) === 0) return null
    return { day, count: Number(row.count), minId: Number(row.min_id), maxId: Number(row.max_id) }
  }

  function countRowsInRange(day: string, minId: number, maxId: number): number {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM belot_hand_journal_events WHERE day = ? AND id BETWEEN ? AND ?')
      .get(day, minId, maxId) as { count: number }
    return Number(row.count)
  }

  async function* iterateDayArchiveLines(day: string, minId: number, maxId: number): AsyncGenerator<string> {
    const selectPage = database.prepare(`
      SELECT ${EVENT_COLUMNS}
      FROM belot_hand_journal_events
      WHERE day = ? AND id > ? AND id <= ?
      ORDER BY id ASC
      LIMIT ${ARCHIVE_PAGE_SIZE}
    `)
    let lastId = minId - 1
    for (;;) {
      const rows = selectPage.all(day, lastId, maxId) as EventRow[]
      if (rows.length === 0) return
      for (const row of rows) yield rowToArchiveLine(row)
      lastId = rows[rows.length - 1]!.id
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    }
  }

  function deleteDayRange(day: string, minId: number, maxId: number): number {
    const result = database
      .prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id BETWEEN ? AND ?')
      .run(day, minId, maxId)
    return Number(result.changes)
  }

  function deleteDayIds(day: string, idsToDelete: readonly number[]): number {
    let deleted = 0
    const statement = database.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id = ?')
    database.exec('BEGIN IMMEDIATE;')
    try {
      for (const id of idsToDelete) deleted += Number(statement.run(day, id).changes)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }
    return deleted
  }

  function deleteDaysBefore(cutoffDay: string): { deletedRows: number; days: string[] } {
    const days = listDays().filter((day) => day < cutoffDay)
    if (days.length === 0) return { deletedRows: 0, days }
    const result = database.prepare('DELETE FROM belot_hand_journal_events WHERE day < ?').run(cutoffDay)
    return { deletedRows: Number(result.changes), days }
  }

  function deleteDay(day: string): number {
    return Number(database.prepare('DELETE FROM belot_hand_journal_events WHERE day = ?').run(day).changes)
  }

  function deleteScoredHandsBefore(cutoffMs: number): number {
    return Number(database.prepare('DELETE FROM belot_hand_journal_scored_hands WHERE scored_at_ms < ?').run(cutoffMs).changes)
  }

  async function reclaimSpace(): Promise<{ freedPages: number }> {
    let freedPages = 0
    if (autoVacuumIncremental) {
      for (let step = 0; step < 100000; step += 1) {
        const before = pragmaNumber('freelist_count')
        if (before === 0) break
        database.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES_PER_STEP});`)
        const after = pragmaNumber('freelist_count')
        freedPages += before - after
        if (after >= before) break
        await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
      }
    }
    try {
      // PASSIVE никога не чака читатели/писатели (TRUNCATE/RESTART биха
      // могли да чакат busy_timeout в главната нишка). Размерът на WAL файла
      // се ограничава от journal_size_limit при следващото му нулиране.
      database.exec('PRAGMA wal_checkpoint(PASSIVE);')
    } catch {
      // checkpoint е оптимизация
    }
    return { freedPages }
  }

  async function getDbFileUsage(): Promise<BelotHandJournalDbFileUsage> {
    return {
      dbBytes: await fileSize(databasePath),
      walBytes: await fileSize(`${databasePath}-wal`),
      shmBytes: await fileSize(`${databasePath}-shm`),
    }
  }

  return {
    directory,
    databasePath,
    archiveDirectory,
    autoVacuumIncremental,
    insertEvents,
    hasEventForHand,
    queryEvents,
    listDays,
    getDayStats,
    countRowsInRange,
    iterateDayArchiveLines,
    deleteDayRange,
    deleteDayIds,
    deleteDaysBefore,
    deleteDay,
    deleteScoredHandsBefore,
    reclaimSpace,
    getDbFileUsage,
    getUsedBytes,
    close: () => {
      database.close()
    },
  }
}

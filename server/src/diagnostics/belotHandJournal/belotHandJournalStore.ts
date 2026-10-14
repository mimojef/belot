// SQLite хранилище за belot hand журнала — ОТДЕЛЕН файл от основната база
// (server/database/diagnostics/belot-hand-journal.sqlite), за да не расте
// основната база/бекъпите и да няма lock конкуренция с gameplay таблиците.
//
// Запис: една транзакция на batch (виж createBelotHandJournal.ts — batch-ът
// се събира в рамките на един event-loop оборот). WAL + synchronous=NORMAL:
// редът е в WAL веднага след commit-а и оцелява при crash/PM2 рестарт на
// процеса (губи се само при спиране на захранването на машината).
//
// Задържане: редовете по-стари от retentionDays се архивират в
// archive/belot-hand-journal-YYYY-MM-DD-<ts>.jsonl.gz (един файл на UTC ден)
// и се изтриват. Ако базата надхвърли maxDbBytes, най-старите дни се
// архивират по-рано. Архивите имат собствен лимит по дни и общ размер.

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip, createGzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import {
  BELOT_HAND_JOURNAL_SCHEMA,
  BELOT_HAND_JOURNAL_SCHEMA_VERSION,
  type BelotHandJournalEvent,
} from './belotHandJournalTypes.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

const __dirname = dirname(fileURLToPath(import.meta.url))
// server/src|dist/diagnostics/belotHandJournal/ -> ../../.. -> server/
const SERVER_ROOT_PATH = resolve(__dirname, '..', '..', '..')
const DAY_MS = 24 * 60 * 60 * 1000
const ARCHIVE_FILE_RE = /^belot-hand-journal-(\d{4}-\d{2}-\d{2})-\d+\.jsonl\.gz$/
const ARCHIVE_PAGE_SIZE = 2000

export function getDefaultBelotHandJournalDirectory(): string {
  const override = process.env.BELOT_HAND_JOURNAL_DIR
  if (override && override.trim() !== '') return resolve(override.trim())
  return join(SERVER_ROOT_PATH, 'database', 'diagnostics')
}

export function getBelotHandJournalDatabasePath(directory: string): string {
  return join(directory, 'belot-hand-journal.sqlite')
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
  profileId?: string
  sinceMs?: number
  untilMs?: number
  anomaliesOnly?: boolean
  limit?: number
}

export type BelotHandJournalScoredHandClaim =
  | { duplicate: false }
  | { duplicate: true; previous: { roomId: string; matchId: string; scoredAtMs: number; matchBefore: string; matchAfter: string } }

export type BelotHandJournalDuplicateAnomalyBuilder = (
  event: BelotHandJournalEvent,
  claim: Extract<BelotHandJournalScoredHandClaim, { duplicate: true }>,
) => BelotHandJournalEvent

export type BelotHandJournalRetentionConfig = {
  retentionDays: number
  maxDbBytes: number
  archiveRetentionDays: number
  maxArchiveBytes: number
}

export type BelotHandJournalMaintenanceReport = {
  archivedDays: string[]
  archivedRows: number
  deletedRows: number
  deletedArchiveFiles: string[]
  dbUsedBytesBefore: number
  dbUsedBytesAfter: number
  sizeLimitExceeded: boolean
}

export type BelotHandJournalStore = {
  readonly databasePath: string
  readonly archiveDirectory: string
  // Записва batch-а в ЕДНА транзакция. За всяко hand_scored в същата
  // транзакция минава пазачът срещу повторно начисляване (първото
  // hand_scored за handId печели); при дубликат се добавя anomaly ред от
  // buildDuplicateAnomaly. При грешка всичко (вкл. пазача) се rollback-ва.
  insertEvents: (
    events: readonly BelotHandJournalEvent[],
    buildDuplicateAnomaly?: BelotHandJournalDuplicateAnomalyBuilder,
  ) => { inserted: number; duplicates: BelotHandJournalEvent[] }
  hasEventForHand: (handId: string, eventType: string) => boolean
  queryEvents: (query: BelotHandJournalQuery) => BelotHandJournalStoredEvent[]
  getUsedBytes: () => number
  runMaintenance: (config: BelotHandJournalRetentionConfig, nowMs?: number) => Promise<BelotHandJournalMaintenanceReport>
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

function rowToEvent(row: EventRow): BelotHandJournalStoredEvent {
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
    ...(row.profile_ids ? { profileIds: row.profile_ids.split(',').filter((id) => id !== '') } : {}),
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  }
}

function initializeSchema(database: SqliteDatabase): void {
  // auto_vacuum трябва да е зададен преди първата таблица — позволява
  // incremental_vacuum да връща място на диска след изтриване.
  database.exec('PRAGMA auto_vacuum = INCREMENTAL;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA synchronous = NORMAL;')
  database.exec('PRAGMA busy_timeout = 5000;')
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

async function listArchiveFiles(archiveDirectory: string): Promise<{ name: string; day: string; bytes: number }[]> {
  let names: string[]
  try {
    names = await readdir(archiveDirectory)
  } catch {
    return []
  }
  const files: { name: string; day: string; bytes: number }[] = []
  for (const name of names) {
    const match = ARCHIVE_FILE_RE.exec(name)
    if (!match) continue
    try {
      const info = await stat(join(archiveDirectory, name))
      files.push({ name, day: match[1]!, bytes: info.size })
    } catch {
      // изчезнал между readdir и stat
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

export async function readBelotHandJournalArchive(filePath: string): Promise<BelotHandJournalStoredEvent[]> {
  const events: BelotHandJournalStoredEvent[] = []
  const lines = createInterface({ input: createReadStream(filePath).pipe(createGunzip()), crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim() === '') continue
    events.push(JSON.parse(line) as BelotHandJournalStoredEvent)
  }
  return events
}

export async function listBelotHandJournalArchiveFiles(archiveDirectory: string): Promise<string[]> {
  return (await listArchiveFiles(archiveDirectory)).map((file) => join(archiveDirectory, file.name))
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

  const insertEventStatement = options.readOnly
    ? null
    : database.prepare(`
        INSERT INTO belot_hand_journal_events
          (schema_version, occurred_at_ms, day, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)

  function getUsedBytes(): number {
    const pageSize = Number((database.prepare('PRAGMA page_size').get() as { page_size: number }).page_size)
    const pageCount = Number((database.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    const freePages = Number((database.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)
    return (pageCount - freePages) * pageSize
  }

  function insertEvents(
    events: readonly BelotHandJournalEvent[],
    buildDuplicateAnomaly?: BelotHandJournalDuplicateAnomalyBuilder,
  ): { inserted: number; duplicates: BelotHandJournalEvent[] } {
    const duplicates: BelotHandJournalEvent[] = []
    if (insertEventStatement === null || events.length === 0) return { inserted: 0, duplicates }
    const insertOne = (event: BelotHandJournalEvent) =>
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
        JSON.stringify(event.payload),
      )
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
      return { inserted, duplicates }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // вече rollback-нато
      }
      throw error
    }
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
    const limit = Math.max(1, Math.min(query.limit ?? 50000, 500000))
    const sql = `
      SELECT id, schema_version, occurred_at_ms, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json
      FROM belot_hand_journal_events
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id ASC
      LIMIT ${limit}
    `
    return (database.prepare(sql).all(...params) as EventRow[]).map(rowToEvent)
  }

  async function archiveDay(day: string, nowMs: number): Promise<number> {
    await mkdir(archiveDirectory, { recursive: true })
    const finalPath = join(archiveDirectory, `belot-hand-journal-${day}-${nowMs}.jsonl.gz`)
    const tmpPath = `${finalPath}.tmp`
    const gzip = createGzip({ level: 6 })
    const output = createWriteStream(tmpPath)
    const finished = once(output, 'close')
    gzip.pipe(output)
    const selectPage = database.prepare(`
      SELECT id, schema_version, occurred_at_ms, event_type, severity, room_id, match_id, hand_id, profile_ids, payload_json
      FROM belot_hand_journal_events WHERE day = ? AND id > ? ORDER BY id ASC LIMIT ${ARCHIVE_PAGE_SIZE}
    `)
    let lastId = 0
    let archived = 0
    let maxId = 0
    for (;;) {
      const rows = selectPage.all(day, lastId) as EventRow[]
      if (rows.length === 0) break
      const chunk = rows.map((row) => JSON.stringify(rowToEvent(row))).join('\n') + '\n'
      if (!gzip.write(chunk)) {
        await once(gzip, 'drain')
      }
      archived += rows.length
      lastId = rows[rows.length - 1]!.id
      maxId = lastId
      // дава ход на event loop-а между страниците
      await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    }
    gzip.end()
    await finished
    if (archived === 0) {
      await rm(tmpPath, { force: true })
      return 0
    }
    await rename(tmpPath, finalPath)
    // Трие само архивираните редове (id <= maxId) — нови редове за същия
    // ден не са възможни, защото архивираме само минали дни.
    database.prepare('DELETE FROM belot_hand_journal_events WHERE day = ? AND id <= ?').run(day, maxId)
    return archived
  }

  async function runMaintenance(
    config: BelotHandJournalRetentionConfig,
    nowMs: number = Date.now(),
  ): Promise<BelotHandJournalMaintenanceReport> {
    const report: BelotHandJournalMaintenanceReport = {
      archivedDays: [],
      archivedRows: 0,
      deletedRows: 0,
      deletedArchiveFiles: [],
      dbUsedBytesBefore: getUsedBytes(),
      dbUsedBytesAfter: 0,
      sizeLimitExceeded: false,
    }
    const today = toUtcDay(nowMs)
    const cutoffDay = toUtcDay(nowMs - config.retentionDays * DAY_MS)

    const listDays = () =>
      (database.prepare('SELECT DISTINCT day FROM belot_hand_journal_events ORDER BY day ASC').all() as { day: string }[]).map(
        (row) => row.day,
      )

    for (const day of listDays()) {
      if (day >= cutoffDay) break
      const archived = await archiveDay(day, nowMs)
      report.archivedDays.push(day)
      report.archivedRows += archived
      report.deletedRows += archived
    }

    // Контрол на размера: при надвишаване архивираме най-старите дни преди
    // да са изтекли 30-те дни (без днешния).
    while (getUsedBytes() > config.maxDbBytes) {
      report.sizeLimitExceeded = true
      const oldest = listDays().find((day) => day < today)
      if (oldest === undefined) break
      const archived = await archiveDay(oldest, nowMs)
      report.archivedDays.push(oldest)
      report.archivedRows += archived
      report.deletedRows += archived
      database.exec('PRAGMA incremental_vacuum;')
    }

    database
      .prepare('DELETE FROM belot_hand_journal_scored_hands WHERE scored_at_ms < ?')
      .run(nowMs - config.retentionDays * DAY_MS)
    database.exec('PRAGMA incremental_vacuum;')
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      // checkpoint е оптимизация
    }

    // Архиви: по възраст и по общ размер (най-старите първи).
    const archiveCutoffDay = toUtcDay(nowMs - config.archiveRetentionDays * DAY_MS)
    let archives = await listArchiveFiles(archiveDirectory)
    for (const file of archives.filter((item) => item.day < archiveCutoffDay)) {
      await rm(join(archiveDirectory, file.name), { force: true })
      report.deletedArchiveFiles.push(file.name)
    }
    archives = await listArchiveFiles(archiveDirectory)
    let totalArchiveBytes = archives.reduce((sum, file) => sum + file.bytes, 0)
    for (const file of archives) {
      if (totalArchiveBytes <= config.maxArchiveBytes) break
      await rm(join(archiveDirectory, file.name), { force: true })
      report.deletedArchiveFiles.push(file.name)
      totalArchiveBytes -= file.bytes
    }

    report.dbUsedBytesAfter = getUsedBytes()
    return report
  }

  return {
    databasePath,
    archiveDirectory,
    insertEvents,
    hasEventForHand,
    queryEvents,
    getUsedBytes,
    runMaintenance,
    close: () => {
      database.close()
    },
  }
}

import { randomUUID } from 'node:crypto'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type TopicStatus = 'active' | 'locked' | 'removed'

export type TopicSnapshot = {
  topicId: string
  slug: string
  title: string
  description: string | null
  isGeneral: boolean
  createdByProfileId: string | null
  status: TopicStatus
  sortOrder: number
  createdAt: string
  /** Moderation (Етап 4) — null докато темата никога не е била заключвана/премахвана. Виж topicModerationStore.ts за пълния rationale (isLocked computed at read time, expiry server-authoritative). */
  lockedUntil: string | null
  lockedReason: string | null
}

export type CreateTopicResult =
  | { ok: true; topic: TopicSnapshot }
  | { ok: false; code: 'title_exists' }

export type TopicStore = {
  listActiveTopics: () => TopicSnapshot[]
  getTopicById: (topicId: string) => TopicSnapshot | null
  getGeneralTopic: () => TopicSnapshot | null
  /**
   * Duplicate-check (case+trim-insensitive, спрямо active/locked теми) и
   * insert в ЕДНА BEGIN IMMEDIATE транзакция (mirror на toggleLike в
   * topicMessageStore.ts) — SQLite-ият writer lock сериализира конкурентни
   * connections, затова две едновременни create заявки със same normalized
   * title НЕ могат и двете да минат SELECT-then-INSERT gap-а: втората чака
   * IMMEDIATE lock-а на първата, вижда вече insert-натия ред при своя SELECT
   * и се проваля с 'title_exists'. `slug UNIQUE` (topic_id-базиран, винаги
   * уникален по конструкция) НЕ е duplicate defense тук — единствената
   * защита е тази транзакция.
   */
  createTopic: (input: { title: string; createdByProfileId: string }) => CreateTopicResult
  /**
   * Cross-instance realtime cursor (mirror на lobbyChatStore.pollNewMessages
   * / topicMessageStore.pollNewMessages) — multiple PM2 процеса споделят
   * тази SQLite база, insert от ЕДИН процес не стига автоматично до
   * WS subscribers на друг, затова index.ts периодично poll-ва тук.
   * `topics` няма explicit auto-increment seq (за разлика от topic_messages),
   * но `topic_id TEXT PRIMARY KEY` НЕ е `WITHOUT ROWID` — SQLite поддържа
   * implicit `rowid`, гарантирано insertion-order монотонен. Cursor-ът е
   * непрозрачен `string` (сериализиран rowid) — НЕ `created_at`/`topic_id`
   * композит: `created_at` (секундна granularity) tie-break-нат по random
   * UUID topic_id няма ГАРАНЦИЯ за chronological ред при same-second
   * inserts (lexicographic UUID сравнение е ~50/50 coin flip спрямо
   * insertion order — виж regression fix-а). Връща explicit `nextCursor`
   * (НЕ derived от TopicSnapshot полета от caller-а — rowid не е част от
   * public snapshot shape-а) — `nextCursor === cursor`, ако няма нови редове.
   */
  pollNewActiveTopicsCreatedAfter: (cursor: string, limit: number) => { topics: TopicSnapshot[]; nextCursor: string }
  /** Cursor baseline при startup — rowid на последния СЪЩЕСТВУВАЩ ред (или '0' ако таблицата е празна), за да не се replay-ва цялата история (established convention, mirror на topicMessagePollCursor baseline-а). */
  getLatestActiveTopicCursor: () => string
  close: () => void
}

type TopicRow = {
  rowid?: number
  topic_id: string
  slug: string
  title: string
  description: string | null
  is_general: number
  created_by_profile_id: string | null
  status: TopicStatus
  sort_order: number
  created_at: string
  locked_until: string | null
  locked_reason: string | null
}

function toSnapshot(row: TopicRow): TopicSnapshot {
  return {
    topicId: row.topic_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    isGeneral: row.is_general === 1,
    createdByProfileId: row.created_by_profile_id,
    status: row.status,
    sortOrder: row.sort_order,
    createdAt: dbDateToUtc(row.created_at),
    lockedUntil: row.locked_until ? dbDateToUtc(row.locked_until) : null,
    lockedReason: row.locked_reason,
  }
}

export async function createTopicStore(databaseFilePath: string): Promise<TopicStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // 'locked' темите ОСТАВАТ видими в списъка (само писането е блокирано,
  // четенето не — виж брифа т.3: "МОЖЕ да се отвори темата, да се четат
  // старите съобщения"). Само 'removed' се изключва тук.
  const selectActiveTopicsStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at, locked_until, locked_reason
    FROM topics
    WHERE status IN ('active', 'locked')
    ORDER BY sort_order ASC, created_at ASC;
  `)

  const selectByIdStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at, locked_until, locked_reason
    FROM topics
    WHERE topic_id = ?
    LIMIT 1;
  `)

  const selectGeneralStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at, locked_until, locked_reason
    FROM topics
    WHERE is_general = 1
    LIMIT 1;
  `)

  // 'removed' теми НЕ блокират title reuse (spec — премахната тема освобождава
  // името си) — само active/locked се проверяват тук, симетрично на
  // listActiveTopics-a четящия обхват (locked остава видима/четима, значи
  // титлата ѝ все още е "заета").
  //
  // САМО TRIM в SQL, БЕЗ LOWER — SQLite-ият вграден LOWER() е ASCII-only
  // (виж https://sqlite.org/lang_corefunc.html#lower — "only characters
  // ASCII... are folded"), кирилицата минава low НЕПРОМЕНЕНА. Case-fold-ване
  // на кирилица/латиница правим в JS (String.prototype.toLowerCase(), пълен
  // Unicode case folding) — сравнението по-долу в createTopic е JS-side,
  // тази заявка само стеснява candidate set-а по TRIM-нат текст.
  const selectActiveTrimmedTitleCandidatesStatement = database.prepare(`
    SELECT topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at
    FROM topics
    WHERE status IN ('active', 'locked');
  `)

  const insertTopicStatement = database.prepare(`
    INSERT INTO topics (topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order)
    VALUES (?, ?, ?, NULL, 0, ?, 'active', 0);
  `)

  // rowid-based cursor — гарантирано insertion-order монотонен (за разлика
  // от created_at+topic_id композита, виж коментара при
  // pollNewActiveTopicsCreatedAfter в TopicStore типа). `status = 'active'`
  // тук нарочно НЕ включва 'locked' (за разлика от
  // selectActiveTrimmedTitleCandidatesStatement) — poll-ът е за directory
  // broadcast на НОВОСЪЗДАДЕНИ теми, а нова тема винаги стартира 'active'.
  const selectNewActiveTopicsStatement = database.prepare(`
    SELECT rowid, topic_id, slug, title, description, is_general, created_by_profile_id, status, sort_order, created_at
    FROM topics
    WHERE status = 'active' AND rowid > ?
    ORDER BY rowid ASC
    LIMIT ?;
  `)

  const selectMaxRowidStatement = database.prepare(`SELECT COALESCE(MAX(rowid), 0) as maxRowid FROM topics;`)

  function listActiveTopics(): TopicSnapshot[] {
    const rows = selectActiveTopicsStatement.all() as TopicRow[]
    return rows.map(toSnapshot)
  }

  function getTopicById(topicId: string): TopicSnapshot | null {
    const row = selectByIdStatement.get(topicId) as TopicRow | undefined
    return row ? toSnapshot(row) : null
  }

  function getGeneralTopic(): TopicSnapshot | null {
    const row = selectGeneralStatement.get() as TopicRow | undefined
    return row ? toSnapshot(row) : null
  }

  function pollNewActiveTopicsCreatedAfter(cursor: string, limit: number): { topics: TopicSnapshot[]; nextCursor: string } {
    const cursorRowid = Number.parseInt(cursor, 10)
    const rows = selectNewActiveTopicsStatement.all(Number.isFinite(cursorRowid) ? cursorRowid : 0, limit) as TopicRow[]
    if (rows.length === 0) {
      return { topics: [], nextCursor: cursor }
    }
    const lastRowid = rows[rows.length - 1]!.rowid!
    return { topics: rows.map(toSnapshot), nextCursor: String(lastRowid) }
  }

  function getLatestActiveTopicCursor(): string {
    const row = selectMaxRowidStatement.get() as { maxRowid: number }
    return String(row.maxRowid)
  }

  function createTopic(input: { title: string; createdByProfileId: string }): CreateTopicResult {
    const normalizedTitle = input.title.trim().toLowerCase()
    const topicId = randomUUID()

    database.exec('BEGIN IMMEDIATE;')
    try {
      // JS-side case-fold сравнение (виж коментара при statement-а по-горе —
      // SQL LOWER() е ASCII-only, недостатъчен за кирилица). Все още вътре в
      // BEGIN IMMEDIATE транзакцията — SQLite writer lock-ът вече е взет
      // ПРЕДИ тази SELECT, затова конкурентна заявка не може да insert-не
      // между тази проверка и insert-а по-долу.
      const candidates = selectActiveTrimmedTitleCandidatesStatement.all() as TopicRow[]
      const existing = candidates.find((row) => row.title.trim().toLowerCase() === normalizedTitle)
      if (existing !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'title_exists' }
      }
      // slug = topic_id (UUID) — уникален по конструкция, чисто вътрешен
      // uniqueness key, никога показван в UI (виж TopicSnapshot.slug usage).
      insertTopicStatement.run(topicId, topicId, input.title, input.createdByProfileId)
      database.exec('COMMIT;')
    } catch (error) {
      database.exec('ROLLBACK;')
      throw error
    }

    const row = selectByIdStatement.get(topicId) as TopicRow
    return { ok: true, topic: toSnapshot(row) }
  }

  function close(): void {
    database.close()
  }

  return {
    listActiveTopics,
    getTopicById,
    getGeneralTopic,
    createTopic,
    pollNewActiveTopicsCreatedAfter,
    getLatestActiveTopicCursor,
    close,
  }
}

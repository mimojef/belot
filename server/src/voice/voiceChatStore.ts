// Гласов чат — SQLite store (Етапи 2а и 2б).
//
// Отговаря за: режим и лимит (с одит), атомарните слотове на гласовите маси,
// генерациите на LiveKit стаите (само имена и статуси — без LiveKit заявки),
// durable опашката за DeleteRoom и участията с правото за говорене
// (voice_table_memberships, Етап 2б — замества match-scoped grace от 2а).
//
// Писане има САМО при lifecycle промени (създаване/старт/край на маса,
// сядане/напускане, ротация, придобито право, опит за DeleteRoom) — никога
// при издаване на токен, говорене, audio level или lease.
//
// Event loop защита: node:sqlite е синхронен, а busy_timeout чака
// СИНХРОННО. Затова тази връзка е с КРАТЪК busy_timeout (200 ms, срещу
// 5000 ms на останалите store-ове): при заключена база от друг процес
// операцията се отказва бързо с { ok: false, code: 'busy' } (fail-closed —
// без нова гласова маса), вместо да блокира главния thread до 5 s. В рамките
// на един процес няма конкурентни writer-и (синхронно изпълнение), затова
// busy е възможно само при друг процес (PM2 instance, скрипт). Четенията не
// се блокират от writer при WAL.

import { randomUUID } from 'node:crypto'
import {
  VOICE_CHAT_DEFAULT_MAX_TABLES,
  VOICE_CHAT_DEFAULT_MODE,
  VOICE_CHAT_MAX_TABLES_UPPER_BOUND,
  isVoiceChatMode,
  type VoiceChatActor,
  type VoiceChatAdminChange,
  type VoiceChatAdminSetting,
  type VoiceChatMode,
  type VoiceChatSettingsSnapshot,
  type VoiceRoomGenerationRecord,
  type VoiceRoomGenerationStatus,
  type VoiceMembershipEndReason,
  type VoiceRoomRetireReason,
  type VoiceTableId,
  type VoiceTableMembership,
  type VoiceTablePhase,
  type VoiceTableRecord,
  type VoiceTableReleaseReason,
  type VoiceTableStatus,
} from './voiceChatTypes.js'
import { buildVoiceRoomName } from './voiceRoomNaming.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const VOICE_CHAT_STORE_BUSY_TIMEOUT_MS = 200

const LAST_DELETE_ERROR_MAX_LENGTH = 300

export type VoiceStoreBusy = { ok: false; code: 'busy' }

export type CreateVoiceChatStoreOptions = {
  /** Само за тестове — production ползва VOICE_CHAT_STORE_BUSY_TIMEOUT_MS. */
  busyTimeoutMs?: number
}

export type ReserveVoiceTableResult =
  | { ok: true; table: VoiceTableRecord; activeCount: number; maxTables: number }
  | { ok: false; code: 'voice_off' | 'admin_only_mode'; mode: VoiceChatMode }
  | { ok: false; code: 'capacity_reached'; activeCount: number; maxTables: number }
  | VoiceStoreBusy

export type SetModeResult =
  | {
      ok: true
      changed: boolean
      previousMode: VoiceChatMode
      settings: VoiceChatSettingsSnapshot
      /** Освободени при превключване към 'off'. */
      releasedVoiceTableIds: VoiceTableId[]
      /** Оттеглени живи стаи при превключване към 'off' (чакат DeleteRoom в Етап 2б). */
      retiredRoomNames: string[]
    }
  | { ok: false; code: 'invalid_mode' }
  | VoiceStoreBusy

export type SetMaxTablesResult =
  | { ok: true; changed: boolean; previousMaxTables: number; settings: VoiceChatSettingsSnapshot; activeCount: number }
  | { ok: false; code: 'invalid_limit' }
  | VoiceStoreBusy

export type ReleaseVoiceTableResult =
  | { ok: true; released: boolean; table: VoiceTableRecord | null; retiredRoomNames: string[] }
  | VoiceStoreBusy

export type BindVoiceTableResult =
  | { ok: true; table: VoiceTableRecord }
  | { ok: false; code: 'not_found' | 'not_active' | 'conflict' }
  | VoiceStoreBusy

export type StartMembershipResult =
  | { ok: true; membership: VoiceTableMembership; supersededMembershipId: string | null }
  | { ok: false; code: 'not_found' | 'not_active' | 'duplicate_id' }
  | VoiceStoreBusy

export type EndMembershipResult =
  | { ok: true; ended: boolean }
  | VoiceStoreBusy

export type EntitleMembershipResult =
  | { ok: true; entitled: boolean }
  | { ok: false; code: 'not_found' | 'ended' }
  | VoiceStoreBusy

export type AllocateGenerationResult =
  | { ok: true; roomName: string; generation: number; retiredRoomName: string | null }
  | { ok: false; code: 'not_found' | 'not_active' }
  | VoiceStoreBusy

export type RecordRoomDeletionAttemptResult =
  | { ok: true; status: VoiceRoomGenerationStatus }
  | { ok: false; code: 'not_found' | 'not_pending' }
  | VoiceStoreBusy

export type ReconcileOnBootResult =
  | {
      ok: true
      releasedVoiceTableIds: VoiceTableId[]
      retainedVoiceTableIds: VoiceTableId[]
      /** Живите стаи на ВСИЧКИ активни маси преди рестарта — оттеглени (boot_rotation/освобождаване). */
      retiredRoomNames: string[]
      /** Участия, приключени защото профилът не е активен участник във възстановената стая. */
      endedMembershipIds: string[]
    }
  | VoiceStoreBusy

export type ReconcileOnBootInput = {
  /** ServerRoom.id на възстановените от snapshot игрови стаи с гласова маса. */
  restoredServerRoomIds: ReadonlySet<string>
  /**
   * serverRoomId -> profileId-тата на АКТИВНИТЕ човешки участници (без
   * окончателно напуснали). Участията на останалите се приключват. Липсващ
   * ключ = всички участия на масата се пазят (консервативно само при тест).
   */
  restoredActiveProfileIds?: ReadonlyMap<string, ReadonlySet<string>>
  /** Авариен стоп при старт: освобождава ВСИЧКИ активни маси ('mode_off'). */
  releaseAll?: boolean
  now?: Date
}

export type VoiceChatStore = {
  getSettings: () => VoiceChatSettingsSnapshot
  setMode: (mode: unknown, actor: VoiceChatActor, now?: Date) => SetModeResult
  setMaxTables: (maxTables: unknown, actor: VoiceChatActor, now?: Date) => SetMaxTablesResult
  listAdminChanges: (limit?: number) => VoiceChatAdminChange[]

  /** Режим + свободен слот се проверяват АТОМАРНО (BEGIN IMMEDIATE). VIP/бан — от caller-а (evaluateVoiceTableCreation). */
  reserveVoiceTable: (input: { emergencyStop: boolean; requesterIsFullAdmin: boolean; now?: Date }) => ReserveVoiceTableResult
  bindPrivateRoom: (voiceTableId: VoiceTableId, privateRoomId: string) => BindVoiceTableResult
  /** waiting -> in_game на СЪЩИЯ ред (никога второ резервиране); идемпотентно за същия serverRoomId. */
  markInGame: (voiceTableId: VoiceTableId, serverRoomId: string, now?: Date) => BindVoiceTableResult
  /** Идемпотентно; освобождава слота, приключва участията и оттегля живата стая. */
  releaseVoiceTable: (voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason, now?: Date) => ReleaseVoiceTableResult

  getVoiceTable: (voiceTableId: VoiceTableId) => VoiceTableRecord | null
  findActiveVoiceTableByPrivateRoomId: (privateRoomId: string) => VoiceTableRecord | null
  findActiveVoiceTableByServerRoomId: (serverRoomId: string) => VoiceTableRecord | null
  listActiveVoiceTables: () => VoiceTableRecord[]
  countActiveVoiceTables: () => number

  /**
   * Ново непрекъснато участие. В една транзакция: приключва предишното
   * активно участие на профила в масата ('superseded') и вмъква новото.
   * entitled=true -> правото за говорене е придобито от самото начало
   * (VIP при сядането).
   */
  startMembership: (input: {
    membershipId: string
    voiceTableId: VoiceTableId
    profileId: string
    entitled: boolean
    now?: Date
  }) => StartMembershipResult
  /** Приключва САМО посоченото участие (идемпотентно). */
  endMembership: (membershipId: string, reason: VoiceMembershipEndReason, now?: Date) => EndMembershipResult
  /** Записва придобито право за говорене в активно участие (идемпотентно). */
  entitleMembership: (membershipId: string, now?: Date) => EntitleMembershipResult
  getMembership: (membershipId: string) => VoiceTableMembership | null
  getActiveMembership: (voiceTableId: VoiceTableId, profileId: string) => VoiceTableMembership | null
  /** Активните участия на активните маси (зареждане в паметта при старт). */
  listActiveMemberships: () => VoiceTableMembership[]

  /**
   * Нова 'live' генерация; текущата 'live' (ако има) става 'delete_pending'
   * с retireReason. retireReason=null -> само ако масата още няма жива
   * генерация (първи токен / след boot_rotation); иначе връща текущата.
   */
  allocateGeneration: (voiceTableId: VoiceTableId, retireReason: VoiceRoomRetireReason | null, now?: Date) => AllocateGenerationResult
  getLiveGeneration: (voiceTableId: VoiceTableId) => VoiceRoomGenerationRecord | null
  getGeneration: (roomName: string) => VoiceRoomGenerationRecord | null
  /** Единствената проверка "може ли да се издаде токен за това име". */
  isLiveRoomName: (roomName: string) => boolean
  /** Има ли масата оттеглена генерация, чийто DeleteRoom още не е потвърден (fencing). */
  hasPendingRoomDeletion: (voiceTableId: VoiceTableId) => boolean
  listDueRoomDeletions: (input: { now?: Date; limit?: number }) => VoiceRoomGenerationRecord[]
  /** Най-ранното next_delete_attempt_at сред чакащите (null = няма чакащи). */
  nextRoomDeletionDueAt: () => string | null
  countPendingRoomDeletions: () => number
  recordRoomDeletionAttempt: (
    roomName: string,
    attempt: { outcome: 'deleted' } | { outcome: 'failed'; error: string; nextAttemptAt: Date },
    now?: Date,
  ) => RecordRoomDeletionAttemptResult

  reconcileOnBoot: (input: ReconcileOnBootInput) => ReconcileOnBootResult
  /** Ограничено чистене на стари освободени маси без чакащи DeleteRoom. */
  purgeReleasedVoiceTables: (input: { releasedBefore: Date; limit?: number }) => { ok: true; purged: number } | VoiceStoreBusy

  close: () => void
}

type AdminChangeRow = {
  change_id: string
  setting: VoiceChatAdminSetting
  new_value: string
  previous_value: string
  changed_by_profile_id: string | null
  changed_at: string
}

type VoiceTableRow = {
  voice_table_id: string
  status: VoiceTableStatus
  phase: VoiceTablePhase
  private_room_id: string | null
  server_room_id: string | null
  match_seq: number
  created_at: string
  in_game_at: string | null
  released_at: string | null
  release_reason: VoiceTableReleaseReason | null
}

type GenerationRow = {
  livekit_room_name: string
  voice_table_id: string
  generation: number
  status: VoiceRoomGenerationStatus
  created_at: string
  retire_requested_at: string | null
  retire_reason: VoiceRoomRetireReason | null
  delete_attempts: number
  next_delete_attempt_at: string | null
  last_delete_error: string | null
  deleted_confirmed_at: string | null
}

function toVoiceTableRecord(row: VoiceTableRow): VoiceTableRecord {
  return {
    voiceTableId: row.voice_table_id,
    status: row.status,
    phase: row.phase,
    privateRoomId: row.private_room_id,
    serverRoomId: row.server_room_id,
    matchSeq: Number(row.match_seq),
    createdAt: row.created_at,
    inGameAt: row.in_game_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  }
}

function toGenerationRecord(row: GenerationRow): VoiceRoomGenerationRecord {
  return {
    livekitRoomName: row.livekit_room_name,
    voiceTableId: row.voice_table_id,
    generation: Number(row.generation),
    status: row.status,
    createdAt: row.created_at,
    retireRequestedAt: row.retire_requested_at,
    retireReason: row.retire_reason,
    deleteAttempts: Number(row.delete_attempts),
    nextDeleteAttemptAt: row.next_delete_attempt_at,
    lastDeleteError: row.last_delete_error,
    deletedConfirmedAt: row.deleted_confirmed_at,
  }
}

type MembershipRow = {
  membership_id: string
  voice_table_id: string
  profile_id: string
  started_at: string
  speaking_entitled_at: string | null
  ended_at: string | null
  end_reason: VoiceMembershipEndReason | null
}

function toMembership(row: MembershipRow): VoiceTableMembership {
  return {
    membershipId: row.membership_id,
    voiceTableId: row.voice_table_id,
    profileId: row.profile_id,
    startedAt: row.started_at,
    speakingEntitledAt: row.speaking_entitled_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  }
}

function toAdminChange(row: AdminChangeRow): VoiceChatAdminChange {
  return {
    changeId: row.change_id,
    setting: row.setting,
    newValue: row.new_value,
    previousValue: row.previous_value,
    changedByProfileId: row.changed_by_profile_id,
    changedAt: row.changed_at,
  }
}

function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { errcode?: unknown; message?: unknown }
  // SQLITE_BUSY = 5, SQLITE_LOCKED = 6 (+ разширени кодове в долните 8 бита).
  if (typeof candidate.errcode === 'number' && ((candidate.errcode & 0xff) === 5 || (candidate.errcode & 0xff) === 6)) return true
  return typeof candidate.message === 'string' && /database is locked|database table is locked|SQLITE_BUSY/i.test(candidate.message)
}

function parseMaxTables(value: string): number {
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= VOICE_CHAT_MAX_TABLES_UPPER_BOUND
    ? parsed
    : VOICE_CHAT_DEFAULT_MAX_TABLES
}

export async function createVoiceChatStore(
  databaseFilePath: string,
  options: CreateVoiceChatStoreOptions = {},
): Promise<VoiceChatStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  const busyTimeoutMs = options.busyTimeoutMs ?? VOICE_CHAT_STORE_BUSY_TIMEOUT_MS
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`)

  // ─── Statements ─────────────────────────────────────────────────────────
  const selectLatestChangeStatement = database.prepare(`
    SELECT change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at
    FROM voice_chat_admin_changes
    WHERE setting = ?
    ORDER BY changed_at DESC, rowid DESC
    LIMIT 1;
  `)
  const insertChangeStatement = database.prepare(`
    INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at)
    VALUES (?, ?, ?, ?, ?, ?);
  `)
  const listChangesStatement = database.prepare(`
    SELECT change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at
    FROM voice_chat_admin_changes
    ORDER BY changed_at DESC, rowid DESC
    LIMIT ?;
  `)

  const tableColumns = `voice_table_id, status, phase, private_room_id, server_room_id, match_seq, created_at, in_game_at, released_at, release_reason`
  const countActiveStatement = database.prepare(`SELECT COUNT(*) AS c FROM voice_tables WHERE status = 'active';`)
  const insertTableStatement = database.prepare(`
    INSERT INTO voice_tables (voice_table_id, status, phase, match_seq, created_at)
    VALUES (?, 'active', 'waiting', 1, ?);
  `)
  const selectTableStatement = database.prepare(`SELECT ${tableColumns} FROM voice_tables WHERE voice_table_id = ?;`)
  const selectActiveByPrivateRoomStatement = database.prepare(`
    SELECT ${tableColumns} FROM voice_tables WHERE status = 'active' AND private_room_id = ? LIMIT 1;
  `)
  const selectActiveByServerRoomStatement = database.prepare(`
    SELECT ${tableColumns} FROM voice_tables WHERE status = 'active' AND server_room_id = ? LIMIT 1;
  `)
  const listActiveTablesStatement = database.prepare(`
    SELECT ${tableColumns} FROM voice_tables WHERE status = 'active' ORDER BY created_at ASC, voice_table_id ASC;
  `)
  const bindPrivateRoomStatement = database.prepare(`
    UPDATE voice_tables SET private_room_id = ? WHERE voice_table_id = ? AND status = 'active' AND private_room_id IS NULL;
  `)
  const markInGameStatement = database.prepare(`
    UPDATE voice_tables SET phase = 'in_game', server_room_id = ?, in_game_at = ?
    WHERE voice_table_id = ? AND status = 'active' AND phase = 'waiting';
  `)
  const releaseTableStatement = database.prepare(`
    UPDATE voice_tables SET status = 'released', released_at = ?, release_reason = ?
    WHERE voice_table_id = ? AND status = 'active';
  `)

  const generationColumns = `livekit_room_name, voice_table_id, generation, status, created_at, retire_requested_at, retire_reason, delete_attempts, next_delete_attempt_at, last_delete_error, deleted_confirmed_at`
  const selectLiveGenerationStatement = database.prepare(`
    SELECT ${generationColumns} FROM voice_room_generations WHERE voice_table_id = ? AND status = 'live' LIMIT 1;
  `)
  const selectGenerationStatement = database.prepare(`SELECT ${generationColumns} FROM voice_room_generations WHERE livekit_room_name = ?;`)
  const selectMaxGenerationStatement = database.prepare(`
    SELECT COALESCE(MAX(generation), 0) AS g FROM voice_room_generations WHERE voice_table_id = ?;
  `)
  const insertGenerationStatement = database.prepare(`
    INSERT INTO voice_room_generations (livekit_room_name, voice_table_id, generation, status, created_at)
    VALUES (?, ?, ?, 'live', ?);
  `)
  const retireGenerationStatement = database.prepare(`
    UPDATE voice_room_generations
    SET status = 'delete_pending', retire_requested_at = ?, retire_reason = ?, next_delete_attempt_at = ?
    WHERE livekit_room_name = ? AND status = 'live';
  `)
  const selectPendingForTableStatement = database.prepare(`
    SELECT 1 AS p FROM voice_room_generations WHERE voice_table_id = ? AND status = 'delete_pending' LIMIT 1;
  `)
  const selectNextDeletionDueStatement = database.prepare(`
    SELECT MIN(next_delete_attempt_at) AS due FROM voice_room_generations WHERE status = 'delete_pending';
  `)
  const selectIsLiveRoomStatement = database.prepare(`
    SELECT 1 AS live FROM voice_room_generations g
    JOIN voice_tables t ON t.voice_table_id = g.voice_table_id
    WHERE g.livekit_room_name = ? AND g.status = 'live' AND t.status = 'active'
    LIMIT 1;
  `)
  const listDueDeletionsStatement = database.prepare(`
    SELECT ${generationColumns} FROM voice_room_generations
    WHERE status = 'delete_pending' AND next_delete_attempt_at <= ?
    ORDER BY next_delete_attempt_at ASC, livekit_room_name ASC
    LIMIT ?;
  `)
  const countPendingDeletionsStatement = database.prepare(`
    SELECT COUNT(*) AS c FROM voice_room_generations WHERE status = 'delete_pending';
  `)
  const markGenerationDeletedStatement = database.prepare(`
    UPDATE voice_room_generations
    SET status = 'deleted', deleted_confirmed_at = ?, delete_attempts = delete_attempts + 1,
        next_delete_attempt_at = NULL, last_delete_error = NULL
    WHERE livekit_room_name = ? AND status = 'delete_pending';
  `)
  const markGenerationDeleteFailedStatement = database.prepare(`
    UPDATE voice_room_generations
    SET delete_attempts = delete_attempts + 1, next_delete_attempt_at = ?, last_delete_error = ?
    WHERE livekit_room_name = ? AND status = 'delete_pending';
  `)

  const membershipColumns = `membership_id, voice_table_id, profile_id, started_at, speaking_entitled_at, ended_at, end_reason`
  const insertMembershipStatement = database.prepare(`
    INSERT INTO voice_table_memberships (membership_id, voice_table_id, profile_id, started_at, speaking_entitled_at)
    VALUES (?, ?, ?, ?, ?);
  `)
  const selectMembershipStatement = database.prepare(`SELECT ${membershipColumns} FROM voice_table_memberships WHERE membership_id = ?;`)
  const selectActiveMembershipStatement = database.prepare(`
    SELECT ${membershipColumns} FROM voice_table_memberships
    WHERE voice_table_id = ? AND profile_id = ? AND ended_at IS NULL LIMIT 1;
  `)
  const listActiveMembershipsStatement = database.prepare(`
    SELECT m.membership_id, m.voice_table_id, m.profile_id, m.started_at, m.speaking_entitled_at, m.ended_at, m.end_reason
    FROM voice_table_memberships m
    JOIN voice_tables t ON t.voice_table_id = m.voice_table_id
    WHERE m.ended_at IS NULL AND t.status = 'active'
    ORDER BY m.started_at ASC, m.membership_id ASC;
  `)
  const listActiveMembershipsForTableStatement = database.prepare(`
    SELECT ${membershipColumns} FROM voice_table_memberships WHERE voice_table_id = ? AND ended_at IS NULL;
  `)
  const endMembershipStatement = database.prepare(`
    UPDATE voice_table_memberships SET ended_at = ?, end_reason = ? WHERE membership_id = ? AND ended_at IS NULL;
  `)
  const endTableMembershipsStatement = database.prepare(`
    UPDATE voice_table_memberships SET ended_at = ?, end_reason = ? WHERE voice_table_id = ? AND ended_at IS NULL;
  `)
  const entitleMembershipStatement = database.prepare(`
    UPDATE voice_table_memberships SET speaking_entitled_at = ?
    WHERE membership_id = ? AND ended_at IS NULL AND speaking_entitled_at IS NULL;
  `)

  const purgeReleasedStatement = database.prepare(`
    DELETE FROM voice_tables WHERE voice_table_id IN (
      SELECT t.voice_table_id FROM voice_tables t
      WHERE t.status = 'released' AND t.released_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM voice_room_generations g
          WHERE g.voice_table_id = t.voice_table_id AND g.status <> 'deleted'
        )
      LIMIT ?
    );
  `)

  // ─── Транзакции ─────────────────────────────────────────────────────────

  /**
   * BEGIN IMMEDIATE (writer lock веднага — без upgrade deadlock между
   * процеси). busy -> { ok:false, code:'busy' } без частични промени; всяка
   * друга грешка -> ROLLBACK + rethrow.
   */
  function runWriteTransaction<T>(fn: () => T): { ok: true; value: T } | VoiceStoreBusy {
    try {
      database.exec('BEGIN IMMEDIATE;')
    } catch (error) {
      if (isSqliteBusyError(error)) return { ok: false, code: 'busy' }
      throw error
    }
    try {
      const value = fn()
      database.exec('COMMIT;')
      return { ok: true, value }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // оригиналната грешка е по-важна
      }
      if (isSqliteBusyError(error)) return { ok: false, code: 'busy' }
      throw error
    }
  }

  function readLatestChange(setting: VoiceChatAdminSetting): AdminChangeRow | undefined {
    return selectLatestChangeStatement.get(setting) as AdminChangeRow | undefined
  }

  function readSettings(): VoiceChatSettingsSnapshot {
    const modeRow = readLatestChange('mode')
    const limitRow = readLatestChange('max_tables')
    const mode = modeRow !== undefined && isVoiceChatMode(modeRow.new_value) ? modeRow.new_value : VOICE_CHAT_DEFAULT_MODE
    return {
      mode,
      modeChangedAt: modeRow?.changed_at ?? null,
      modeChangedByProfileId: modeRow?.changed_by_profile_id ?? null,
      maxTables: limitRow !== undefined ? parseMaxTables(limitRow.new_value) : VOICE_CHAT_DEFAULT_MAX_TABLES,
      maxTablesChangedAt: limitRow?.changed_at ?? null,
      maxTablesChangedByProfileId: limitRow?.changed_by_profile_id ?? null,
    }
  }

  function readCountActive(): number {
    return Number((countActiveStatement.get() as { c: number }).c)
  }

  function readTable(voiceTableId: VoiceTableId): VoiceTableRecord | null {
    const row = selectTableStatement.get(voiceTableId) as VoiceTableRow | undefined
    return row === undefined ? null : toVoiceTableRecord(row)
  }

  /** Вътре в транзакция: оттегля живата генерация (ако има) и връща името ѝ. */
  function retireLiveGenerationInTransaction(voiceTableId: VoiceTableId, reason: VoiceRoomRetireReason, nowIso: string): string | null {
    const live = selectLiveGenerationStatement.get(voiceTableId) as GenerationRow | undefined
    if (live === undefined) return null
    retireGenerationStatement.run(nowIso, reason, nowIso, live.livekit_room_name)
    return live.livekit_room_name
  }

  /** Вътре в транзакция: освобождава активна маса; null ако вече не е активна. */
  function releaseTableInTransaction(
    voiceTableId: VoiceTableId,
    reason: VoiceTableReleaseReason,
    retireReason: VoiceRoomRetireReason,
    nowIso: string,
  ): string | null | false {
    const changes = Number(releaseTableStatement.run(nowIso, reason, voiceTableId).changes)
    if (changes === 0) return false
    // Освободената маса прекратява всички участия и правата за говорене в тях.
    endTableMembershipsStatement.run(nowIso, 'table_released', voiceTableId)
    return retireLiveGenerationInTransaction(voiceTableId, retireReason, nowIso)
  }

  // ─── Настройки ──────────────────────────────────────────────────────────

  function getSettings(): VoiceChatSettingsSnapshot {
    return readSettings()
  }

  function setMode(mode: unknown, actor: VoiceChatActor, now: Date = new Date()): SetModeResult {
    if (!isVoiceChatMode(mode)) return { ok: false, code: 'invalid_mode' }
    const nowIso = now.toISOString()
    const result = runWriteTransaction(() => {
      const before = readSettings()
      const releasedVoiceTableIds: VoiceTableId[] = []
      const retiredRoomNames: string[] = []
      if (before.mode === mode) {
        return { changed: false, previousMode: before.mode, releasedVoiceTableIds, retiredRoomNames }
      }
      insertChangeStatement.run(randomUUID(), 'mode', mode, before.mode, actor.profileId, nowIso)
      if (mode === 'off') {
        for (const row of listActiveTablesStatement.all() as VoiceTableRow[]) {
          const retired = releaseTableInTransaction(row.voice_table_id, 'mode_off', 'mode_off', nowIso)
          if (retired === false) continue
          releasedVoiceTableIds.push(row.voice_table_id)
          if (retired !== null) retiredRoomNames.push(retired)
        }
      }
      return { changed: true, previousMode: before.mode, releasedVoiceTableIds, retiredRoomNames }
    })
    if (!result.ok) return result
    return { ok: true, ...result.value, settings: readSettings() }
  }

  function setMaxTables(maxTables: unknown, actor: VoiceChatActor, now: Date = new Date()): SetMaxTablesResult {
    if (
      typeof maxTables !== 'number' ||
      !Number.isInteger(maxTables) ||
      maxTables < 0 ||
      maxTables > VOICE_CHAT_MAX_TABLES_UPPER_BOUND
    ) {
      return { ok: false, code: 'invalid_limit' }
    }
    const nowIso = now.toISOString()
    const result = runWriteTransaction(() => {
      const before = readSettings()
      if (before.maxTables === maxTables) return { changed: false, previousMaxTables: before.maxTables }
      insertChangeStatement.run(randomUUID(), 'max_tables', String(maxTables), String(before.maxTables), actor.profileId, nowIso)
      return { changed: true, previousMaxTables: before.maxTables }
    })
    if (!result.ok) return result
    return { ok: true, ...result.value, settings: readSettings(), activeCount: readCountActive() }
  }

  function listAdminChanges(limit = 50): VoiceChatAdminChange[] {
    const bounded = Math.max(1, Math.min(200, Math.trunc(Number.isFinite(limit) ? limit : 50)))
    return (listChangesStatement.all(bounded) as AdminChangeRow[]).map(toAdminChange)
  }

  // ─── Слотове ────────────────────────────────────────────────────────────

  function reserveVoiceTable(input: { emergencyStop: boolean; requesterIsFullAdmin: boolean; now?: Date }): ReserveVoiceTableResult {
    const nowIso = (input.now ?? new Date()).toISOString()
    const result = runWriteTransaction((): ReserveVoiceTableResult => {
      const settings = readSettings()
      const effectiveMode: VoiceChatMode = input.emergencyStop ? 'off' : settings.mode
      if (effectiveMode === 'off') return { ok: false, code: 'voice_off', mode: effectiveMode }
      if (effectiveMode === 'admin_only' && !input.requesterIsFullAdmin) {
        return { ok: false, code: 'admin_only_mode', mode: effectiveMode }
      }
      const activeCount = readCountActive()
      if (activeCount >= settings.maxTables) {
        return { ok: false, code: 'capacity_reached', activeCount, maxTables: settings.maxTables }
      }
      const voiceTableId = randomUUID()
      insertTableStatement.run(voiceTableId, nowIso)
      return { ok: true, table: readTable(voiceTableId)!, activeCount: activeCount + 1, maxTables: settings.maxTables }
    })
    return result.ok ? result.value : result
  }

  function bindPrivateRoom(voiceTableId: VoiceTableId, privateRoomId: string): BindVoiceTableResult {
    const result = runWriteTransaction((): BindVoiceTableResult => {
      const current = readTable(voiceTableId)
      if (current === null) return { ok: false, code: 'not_found' }
      if (current.status !== 'active') return { ok: false, code: 'not_active' }
      if (current.privateRoomId === privateRoomId) return { ok: true, table: current }
      if (current.privateRoomId !== null) return { ok: false, code: 'conflict' }
      try {
        bindPrivateRoomStatement.run(privateRoomId, voiceTableId)
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : '')) return { ok: false, code: 'conflict' }
        throw error
      }
      return { ok: true, table: readTable(voiceTableId)! }
    })
    return result.ok ? result.value : result
  }

  function markInGame(voiceTableId: VoiceTableId, serverRoomId: string, now: Date = new Date()): BindVoiceTableResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction((): BindVoiceTableResult => {
      const current = readTable(voiceTableId)
      if (current === null) return { ok: false, code: 'not_found' }
      if (current.status !== 'active') return { ok: false, code: 'not_active' }
      if (current.phase === 'in_game') {
        return current.serverRoomId === serverRoomId ? { ok: true, table: current } : { ok: false, code: 'conflict' }
      }
      try {
        markInGameStatement.run(serverRoomId, nowIso, voiceTableId)
      } catch (error) {
        if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : '')) return { ok: false, code: 'conflict' }
        throw error
      }
      return { ok: true, table: readTable(voiceTableId)! }
    })
    return result.ok ? result.value : result
  }

  function releaseVoiceTable(voiceTableId: VoiceTableId, reason: VoiceTableReleaseReason, now: Date = new Date()): ReleaseVoiceTableResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction((): ReleaseVoiceTableResult => {
      const retired = releaseTableInTransaction(voiceTableId, reason, 'table_released', nowIso)
      return {
        ok: true,
        released: retired !== false,
        table: readTable(voiceTableId),
        retiredRoomNames: retired === false || retired === null ? [] : [retired],
      }
    })
    return result.ok ? result.value : result
  }

  function getVoiceTable(voiceTableId: VoiceTableId): VoiceTableRecord | null {
    return readTable(voiceTableId)
  }

  function findActiveVoiceTableByPrivateRoomId(privateRoomId: string): VoiceTableRecord | null {
    const row = selectActiveByPrivateRoomStatement.get(privateRoomId) as VoiceTableRow | undefined
    return row === undefined ? null : toVoiceTableRecord(row)
  }

  function findActiveVoiceTableByServerRoomId(serverRoomId: string): VoiceTableRecord | null {
    const row = selectActiveByServerRoomStatement.get(serverRoomId) as VoiceTableRow | undefined
    return row === undefined ? null : toVoiceTableRecord(row)
  }

  function listActiveVoiceTables(): VoiceTableRecord[] {
    return (listActiveTablesStatement.all() as VoiceTableRow[]).map(toVoiceTableRecord)
  }

  // ─── Участия и право за говорене (Етап 2б) ──────────────────────────────

  function startMembership(input: {
    membershipId: string
    voiceTableId: VoiceTableId
    profileId: string
    entitled: boolean
    now?: Date
  }): StartMembershipResult {
    const nowIso = (input.now ?? new Date()).toISOString()
    const result = runWriteTransaction((): StartMembershipResult => {
      const current = readTable(input.voiceTableId)
      if (current === null) return { ok: false, code: 'not_found' }
      if (current.status !== 'active') return { ok: false, code: 'not_active' }
      if (selectMembershipStatement.get(input.membershipId) !== undefined) return { ok: false, code: 'duplicate_id' }
      const previous = selectActiveMembershipStatement.get(input.voiceTableId, input.profileId) as MembershipRow | undefined
      if (previous !== undefined) endMembershipStatement.run(nowIso, 'superseded', previous.membership_id)
      insertMembershipStatement.run(input.membershipId, input.voiceTableId, input.profileId, nowIso, input.entitled ? nowIso : null)
      return {
        ok: true,
        membership: toMembership(selectMembershipStatement.get(input.membershipId) as MembershipRow),
        supersededMembershipId: previous?.membership_id ?? null,
      }
    })
    return result.ok ? result.value : result
  }

  function endMembership(membershipId: string, reason: VoiceMembershipEndReason, now: Date = new Date()): EndMembershipResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction(() => Number(endMembershipStatement.run(nowIso, reason, membershipId).changes) > 0)
    return result.ok ? { ok: true, ended: result.value } : result
  }

  function entitleMembership(membershipId: string, now: Date = new Date()): EntitleMembershipResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction((): EntitleMembershipResult => {
      const row = selectMembershipStatement.get(membershipId) as MembershipRow | undefined
      if (row === undefined) return { ok: false, code: 'not_found' }
      if (row.ended_at !== null) return { ok: false, code: 'ended' }
      if (row.speaking_entitled_at !== null) return { ok: true, entitled: false }
      entitleMembershipStatement.run(nowIso, membershipId)
      return { ok: true, entitled: true }
    })
    return result.ok ? result.value : result
  }

  function getMembership(membershipId: string): VoiceTableMembership | null {
    const row = selectMembershipStatement.get(membershipId) as MembershipRow | undefined
    return row === undefined ? null : toMembership(row)
  }

  function getActiveMembership(voiceTableId: VoiceTableId, profileId: string): VoiceTableMembership | null {
    const row = selectActiveMembershipStatement.get(voiceTableId, profileId) as MembershipRow | undefined
    return row === undefined ? null : toMembership(row)
  }

  function listActiveMemberships(): VoiceTableMembership[] {
    return (listActiveMembershipsStatement.all() as MembershipRow[]).map(toMembership)
  }

  // ─── Генерации ──────────────────────────────────────────────────────────

  function allocateGeneration(voiceTableId: VoiceTableId, retireReason: VoiceRoomRetireReason | null, now: Date = new Date()): AllocateGenerationResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction((): AllocateGenerationResult => {
      const current = readTable(voiceTableId)
      if (current === null) return { ok: false, code: 'not_found' }
      if (current.status !== 'active') return { ok: false, code: 'not_active' }
      // Без причина -> не се оттегля нищо; ако все пак има жива, тя се пази
      // (идемпотентно: втори "първи токен" не създава нова генерация).
      if (retireReason === null) {
        const live = selectLiveGenerationStatement.get(voiceTableId) as GenerationRow | undefined
        if (live !== undefined) return { ok: true, roomName: live.livekit_room_name, generation: Number(live.generation), retiredRoomName: null }
      }
      const retiredRoomName = retireReason === null ? null : retireLiveGenerationInTransaction(voiceTableId, retireReason, nowIso)
      const generation = Number((selectMaxGenerationStatement.get(voiceTableId) as { g: number }).g) + 1
      const roomName = buildVoiceRoomName(voiceTableId, generation)
      insertGenerationStatement.run(roomName, voiceTableId, generation, nowIso)
      return { ok: true, roomName, generation, retiredRoomName }
    })
    return result.ok ? result.value : result
  }

  function getLiveGeneration(voiceTableId: VoiceTableId): VoiceRoomGenerationRecord | null {
    const row = selectLiveGenerationStatement.get(voiceTableId) as GenerationRow | undefined
    return row === undefined ? null : toGenerationRecord(row)
  }

  function getGeneration(roomName: string): VoiceRoomGenerationRecord | null {
    const row = selectGenerationStatement.get(roomName) as GenerationRow | undefined
    return row === undefined ? null : toGenerationRecord(row)
  }

  function isLiveRoomName(roomName: string): boolean {
    return selectIsLiveRoomStatement.get(roomName) !== undefined
  }

  function hasPendingRoomDeletion(voiceTableId: VoiceTableId): boolean {
    return selectPendingForTableStatement.get(voiceTableId) !== undefined
  }

  function nextRoomDeletionDueAt(): string | null {
    const row = selectNextDeletionDueStatement.get() as { due: string | null } | undefined
    return row?.due ?? null
  }

  function listDueRoomDeletions(input: { now?: Date; limit?: number }): VoiceRoomGenerationRecord[] {
    const nowIso = (input.now ?? new Date()).toISOString()
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)))
    return (listDueDeletionsStatement.all(nowIso, limit) as GenerationRow[]).map(toGenerationRecord)
  }

  function countPendingRoomDeletions(): number {
    return Number((countPendingDeletionsStatement.get() as { c: number }).c)
  }

  function recordRoomDeletionAttempt(
    roomName: string,
    attempt: { outcome: 'deleted' } | { outcome: 'failed'; error: string; nextAttemptAt: Date },
    now: Date = new Date(),
  ): RecordRoomDeletionAttemptResult {
    const nowIso = now.toISOString()
    const result = runWriteTransaction((): RecordRoomDeletionAttemptResult => {
      const current = selectGenerationStatement.get(roomName) as GenerationRow | undefined
      if (current === undefined) return { ok: false, code: 'not_found' }
      if (current.status !== 'delete_pending') return { ok: false, code: 'not_pending' }
      if (attempt.outcome === 'deleted') {
        markGenerationDeletedStatement.run(nowIso, roomName)
        return { ok: true, status: 'deleted' }
      }
      // Грешката е техническо описание от LiveKit клиента; съкратена, без токени.
      const error = attempt.error.replace(/\s+/g, ' ').slice(0, LAST_DELETE_ERROR_MAX_LENGTH)
      markGenerationDeleteFailedStatement.run(attempt.nextAttemptAt.toISOString(), error, roomName)
      return { ok: true, status: 'delete_pending' }
    })
    return result.ok ? result.value : result
  }

  // ─── Рестарт ────────────────────────────────────────────────────────────

  function reconcileOnBoot(input: ReconcileOnBootInput): ReconcileOnBootResult {
    const nowIso = (input.now ?? new Date()).toISOString()
    const result = runWriteTransaction(() => {
      const releasedVoiceTableIds: VoiceTableId[] = []
      const retainedVoiceTableIds: VoiceTableId[] = []
      const retiredRoomNames: string[] = []
      const endedMembershipIds: string[] = []
      for (const row of listActiveTablesStatement.all() as VoiceTableRow[]) {
        if (
          input.releaseAll === true ||
          row.phase === 'waiting' ||
          row.server_room_id === null ||
          !input.restoredServerRoomIds.has(row.server_room_id)
        ) {
          const reason: VoiceTableReleaseReason =
            input.releaseAll === true ? 'mode_off' : row.phase === 'waiting' ? 'boot_waiting_room_lost' : 'boot_server_room_missing'
          const retired = releaseTableInTransaction(row.voice_table_id, reason, 'table_released', nowIso)
          if (retired === false) continue
          releasedVoiceTableIds.push(row.voice_table_id)
          if (retired !== null) retiredRoomNames.push(retired)
          continue
        }
        // Масата оцелява (слотът се пази), но издадените преди рестарта
        // токени не са известни -> живата стая се оттегля; нова генерация
        // се създава lazy при първата заявка за токен (Етап 2б).
        retainedVoiceTableIds.push(row.voice_table_id)
        const retired = retireLiveGenerationInTransaction(row.voice_table_id, 'boot_rotation', nowIso)
        if (retired !== null) retiredRoomNames.push(retired)
        // Участията оцеляват само за профилите, които все още са активни
        // участници във възстановената игрова стая (окончателно напусналите
        // и изчезналите — край на участието и на правото за говорене).
        const activeProfiles = input.restoredActiveProfileIds?.get(row.server_room_id)
        if (activeProfiles !== undefined) {
          for (const membership of listActiveMembershipsForTableStatement.all(row.voice_table_id) as MembershipRow[]) {
            if (activeProfiles.has(membership.profile_id)) continue
            endMembershipStatement.run(nowIso, 'boot_not_restored', membership.membership_id)
            endedMembershipIds.push(membership.membership_id)
          }
        }
      }
      return { releasedVoiceTableIds, retainedVoiceTableIds, retiredRoomNames, endedMembershipIds }
    })
    return result.ok ? { ok: true, ...result.value } : result
  }

  function purgeReleasedVoiceTables(input: { releasedBefore: Date; limit?: number }): { ok: true; purged: number } | VoiceStoreBusy {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 200)))
    const result = runWriteTransaction(() => Number(purgeReleasedStatement.run(input.releasedBefore.toISOString(), limit).changes))
    return result.ok ? { ok: true, purged: result.value } : result
  }

  function close(): void {
    database.close()
  }

  return {
    getSettings,
    setMode,
    setMaxTables,
    listAdminChanges,
    reserveVoiceTable,
    bindPrivateRoom,
    markInGame,
    releaseVoiceTable,
    getVoiceTable,
    findActiveVoiceTableByPrivateRoomId,
    findActiveVoiceTableByServerRoomId,
    listActiveVoiceTables,
    countActiveVoiceTables: readCountActive,
    startMembership,
    endMembership,
    entitleMembership,
    getMembership,
    getActiveMembership,
    listActiveMemberships,
    allocateGeneration,
    getLiveGeneration,
    getGeneration,
    isLiveRoomName,
    hasPendingRoomDeletion,
    listDueRoomDeletions,
    nextRoomDeletionDueAt,
    countPendingRoomDeletions,
    recordRoomDeletionAttempt,
    reconcileOnBoot,
    purgeReleasedVoiceTables,
    close,
  }
}

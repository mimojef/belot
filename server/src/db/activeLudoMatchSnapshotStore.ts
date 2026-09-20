import type { LudoMatchSnapshot } from '../game/ludoMatchRuntime.js'

// Mirrors db/activeRoomSnapshotStore.ts for Ludo (виж task spec §1) —
// durable authoritative snapshot на всеки STARTED Ludo match (stake вече
// debit-нат), за да преживее backend process restart. Waiting rooms (без
// debit) НЕ минават оттук — виж task spec §9, scope-ът е ограничен само до
// started match recovery, защото само там вече има реален паричен риск.

export const ACTIVE_LUDO_MATCH_SNAPSHOT_VERSION = 1

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type ActiveLudoMatchSnapshotStore = {
  loadActiveMatches: () => LudoMatchSnapshot[]
  upsertMatch: (snapshot: LudoMatchSnapshot) => void
  markMatchRemoved: (matchId: string) => void
  close: () => void
}

type ActiveLudoMatchSnapshotRow = {
  snapshot_version: number
  snapshot_json: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `events` е чисто presentation-only (dice_accepted/piece_moved и т.н. — виж
// createLudoFlowController.ts::presentAuthoritativeMove) — не се използва
// за reconstruct-ване на runtime state, затова НЕ се персистира.
// `serverNow` е момента, в който snapshot() е бил извикан — безполезен след
// restart (нов процес, нов "now"), пресмята се наново при всяко зареждане.
// players е ВЕЧЕ Omit<LudoMatchPlayer,'connectionId'> в LudoMatchSnapshot-а
// (виж ludoMatchRuntime.ts) — никога не носи stale WebSocket connection id.
export type PersistableLudoMatchSnapshot = Omit<LudoMatchSnapshot, 'events' | 'serverNow'>

export type LudoMatchSnapshotRow = {
  matchId: string
  snapshotVersion: number
  ludoRoomId: string
  matchStatus: 'in_progress' | 'finished'
  revision: number
  snapshotJson: string
}

// Споделен row-builder — reuse-нат и от ludoEconomyStore.ts's atomic-start
// transaction (виж task spec §3), за да остане ЕДНО canonical място за
// serialization shape-а на snapshot_json, дори при две различни DB
// connections, пишещи в СЪЩАТА таблица (SQLite транзакциите са per-connection,
// затова atomic-start-ът неизбежно ползва собствената си connection — виж
// коментара в ludoEconomyStore.ts за пълния rationale).
export function buildLudoMatchSnapshotRow(snapshot: LudoMatchSnapshot): LudoMatchSnapshotRow {
  const { events: _events, serverNow: _serverNow, ...persistable } = snapshot
  return {
    matchId: snapshot.matchId,
    snapshotVersion: ACTIVE_LUDO_MATCH_SNAPSHOT_VERSION,
    ludoRoomId: snapshot.ludoRoomId,
    matchStatus: snapshot.state.status,
    revision: snapshot.revision,
    snapshotJson: JSON.stringify(persistable),
  }
}

function parseMatchSnapshot(row: ActiveLudoMatchSnapshotRow): PersistableLudoMatchSnapshot | null {
  if (row.snapshot_version !== ACTIVE_LUDO_MATCH_SNAPSHOT_VERSION) {
    console.warn(`[ludo-match-snapshot] skipped unsupported version=${row.snapshot_version}`)
    return null
  }

  try {
    const parsed = JSON.parse(row.snapshot_json) as unknown

    if (!isPlainObject(parsed) || typeof parsed.matchId !== 'string') {
      console.warn('[ludo-match-snapshot] skipped malformed match snapshot')
      return null
    }

    return parsed as PersistableLudoMatchSnapshot
  } catch (error) {
    console.warn('[ludo-match-snapshot] skipped invalid JSON snapshot', error)
    return null
  }
}

// Canonical INSERT..ON CONFLICT SQL текст — reuse-нат ТЕКСТУАЛНО (не през
// runtime import, различни DB connections) от ludoEconomyStore.ts's
// atomic-start transaction. Промяна тук изисква огледална промяна там —
// коментарът на другия call site реферира точно към този файл.
export const UPSERT_LUDO_MATCH_SNAPSHOT_SQL = `
  INSERT INTO active_ludo_match_snapshots (
    match_id, snapshot_version, ludo_room_id, match_status, revision,
    snapshot_json, is_active, finished_at, removed_at
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    1,
    CASE WHEN ? = 'finished' THEN CURRENT_TIMESTAMP ELSE NULL END,
    NULL
  )
  ON CONFLICT(match_id) DO UPDATE SET
    snapshot_version = excluded.snapshot_version,
    ludo_room_id = excluded.ludo_room_id,
    match_status = excluded.match_status,
    revision = excluded.revision,
    snapshot_json = excluded.snapshot_json,
    is_active = 1,
    updated_at = CURRENT_TIMESTAMP,
    finished_at = CASE
      WHEN excluded.match_status = 'finished' THEN COALESCE(active_ludo_match_snapshots.finished_at, CURRENT_TIMESTAMP)
      ELSE NULL
    END,
    removed_at = NULL;
`

export async function createActiveLudoMatchSnapshotStore(
  databaseFilePath: string,
): Promise<ActiveLudoMatchSnapshotStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  // ВАЖНО разлика спрямо activeRoomSnapshotStore.loadActiveRooms(): тук НЕ
  // филтрираме room_status != 'finished' — boot recovery трябва да вижда и
  // finished-но-още-не-cleanup-нати редове, за да довърши прекъснат payout
  // (виж task spec §7, crash window "finished snapshot persisted, restart
  // ПРЕДИ payout"). is_active=1 е достатъчен филтър — markMatchRemoved()
  // изтрива реда (не просто маркира is_active=0), затова "все още в
  // таблицата" вече значи "все още се нуждае от internal recovery внимание".
  const loadActiveMatchesStatement = database.prepare(`
    SELECT snapshot_version, snapshot_json
    FROM active_ludo_match_snapshots
    WHERE is_active = 1
    ORDER BY updated_at ASC;
  `)

  const upsertMatchStatement = database.prepare(UPSERT_LUDO_MATCH_SNAPSHOT_SQL)

  const markMatchRemovedStatement = database.prepare(`
    DELETE FROM active_ludo_match_snapshots WHERE match_id = ?;
  `)

  function loadActiveMatches(): LudoMatchSnapshot[] {
    const rows = loadActiveMatchesStatement.all() as ActiveLudoMatchSnapshotRow[]
    const now = Date.now()
    return rows.flatMap((row) => {
      const parsed = parseMatchSnapshot(row)
      return parsed === null ? [] : [{ ...parsed, events: [], serverNow: now }]
    })
  }

  function upsertMatch(snapshot: LudoMatchSnapshot): void {
    const row = buildLudoMatchSnapshotRow(snapshot)
    upsertMatchStatement.run(
      row.matchId, row.snapshotVersion, row.ludoRoomId, row.matchStatus,
      row.revision, row.snapshotJson, row.matchStatus,
    )
  }

  function markMatchRemoved(matchId: string): void {
    markMatchRemovedStatement.run(matchId)
  }

  function close(): void {
    database.close()
  }

  return {
    loadActiveMatches,
    upsertMatch,
    markMatchRemoved,
    close,
  }
}

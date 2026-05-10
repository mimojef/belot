import type { ServerRoom } from '../core/serverTypes.js'

export const ACTIVE_ROOM_SNAPSHOT_VERSION = 1

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type ActiveRoomSnapshotStore = {
  loadActiveRooms: () => ServerRoom[]
  upsertRoom: (room: ServerRoom) => void
  markRoomRemoved: (roomId: string) => void
  close: () => void
}

type ActiveRoomSnapshotRow = {
  snapshot_version: number
  snapshot_json: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRoomSnapshot(row: ActiveRoomSnapshotRow): ServerRoom | null {
  if (row.snapshot_version !== ACTIVE_ROOM_SNAPSHOT_VERSION) {
    console.warn(
      `[room-snapshot] skipped unsupported version=${row.snapshot_version}`,
    )
    return null
  }

  try {
    const parsed = JSON.parse(row.snapshot_json) as unknown

    if (!isPlainObject(parsed) || typeof parsed.id !== 'string') {
      console.warn('[room-snapshot] skipped malformed room snapshot')
      return null
    }

    return parsed as ServerRoom
  } catch (error) {
    console.warn('[room-snapshot] skipped invalid JSON snapshot', error)
    return null
  }
}

export async function createActiveRoomSnapshotStore(
  databaseFilePath: string,
): Promise<ActiveRoomSnapshotStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const loadActiveRoomsStatement = database.prepare(`
    SELECT snapshot_version, snapshot_json
    FROM active_room_snapshots
    WHERE is_active = 1
      AND room_status != 'finished'
    ORDER BY updated_at ASC;
  `)

  const upsertRoomStatement = database.prepare(`
    INSERT INTO active_room_snapshots (
      room_id,
      snapshot_version,
      room_status,
      game_phase,
      state_version,
      snapshot_json,
      is_active,
      finished_at,
      removed_at
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      CASE WHEN ? = 'finished' THEN 0 ELSE 1 END,
      CASE WHEN ? = 'finished' THEN CURRENT_TIMESTAMP ELSE NULL END,
      NULL
    )
    ON CONFLICT(room_id) DO UPDATE SET
      snapshot_version = excluded.snapshot_version,
      room_status = excluded.room_status,
      game_phase = excluded.game_phase,
      state_version = excluded.state_version,
      snapshot_json = excluded.snapshot_json,
      is_active = CASE
        WHEN excluded.room_status = 'finished' THEN 0
        ELSE 1
      END,
      updated_at = CURRENT_TIMESTAMP,
      finished_at = CASE
        WHEN excluded.room_status = 'finished' THEN COALESCE(active_room_snapshots.finished_at, CURRENT_TIMESTAMP)
        ELSE NULL
      END,
      removed_at = NULL;
  `)

  const markRoomRemovedStatement = database.prepare(`
    DELETE FROM active_room_snapshots
    WHERE room_id = ?;
  `)

  function loadActiveRooms(): ServerRoom[] {
    const rows = loadActiveRoomsStatement.all() as ActiveRoomSnapshotRow[]

    return rows.flatMap((row) => {
      const room = parseRoomSnapshot(row)
      return room === null ? [] : [room]
    })
  }

  function upsertRoom(room: ServerRoom): void {
    if (room.status === 'finished') {
      markRoomRemoved(room.id)
      return
    }

    upsertRoomStatement.run(
      room.id,
      ACTIVE_ROOM_SNAPSHOT_VERSION,
      room.status,
      room.game.phase,
      room.game.stateVersion,
      JSON.stringify(room),
      room.status,
      room.status,
    )
  }

  function markRoomRemoved(roomId: string): void {
    markRoomRemovedStatement.run(roomId)
  }

  function close(): void {
    database.close()
  }

  return {
    loadActiveRooms,
    upsertRoom,
    markRoomRemoved,
    close,
  }
}

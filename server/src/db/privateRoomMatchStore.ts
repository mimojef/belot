// Persistent history за private-table игри (waiting -> playing -> finished),
// захранва "Играещи"/"Приключили" lobby табовете. Виж миграцията
// (20260820_001_create_private_room_matches.sql) за пълния rationale защо е
// отделна таблица от active_room_snapshots (runtime crash-recovery кеш,
// изтрива finished редове) и profile_match_results (per-profile win/loss,
// без room-level score/timestamps). Никога не трие редове — 2-часовият
// "Приключили" visibility прозорец е WHERE filter на read пътя
// (listFinishedMatches), не retention job.

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type PrivateRoomMatchOccupant = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  isBot: boolean
}

export type PrivateRoomMatchRecord = {
  roomId: string
  privateRoomId: string
  status: 'playing' | 'finished'
  stake: number
  teamA: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
  teamB: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
  teamAScore: number | null
  teamBScore: number | null
  startedAt: string
  finishedAt: string | null
}

export type PrivateRoomMatchStore = {
  recordMatchStarted: (input: {
    roomId: string
    privateRoomId: string
    stake: number
    teamA: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
    teamB: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
  }) => void
  recordMatchScoreUpdate: (roomId: string, teamAScore: number, teamBScore: number) => void
  recordMatchFinished: (roomId: string, teamAScore: number, teamBScore: number) => void
  listPlayingMatches: () => PrivateRoomMatchRecord[]
  /** finished_at >= now - visibilityHours (SQLite native datetime('now', ...) сравнение — виж likeStore.ts/yellowCoinGiftStore.ts за established конвенцията, избягва JS<->SQLite timezone/format mismatch). */
  listFinishedMatches: (visibilityHours: number) => PrivateRoomMatchRecord[]
  getMatch: (roomId: string) => PrivateRoomMatchRecord | null
  close: () => void
}

type PrivateRoomMatchRow = {
  room_id: string
  private_room_id: string
  status: 'playing' | 'finished'
  stake: number
  team_a_json: string
  team_b_json: string
  team_a_score: number | null
  team_b_score: number | null
  started_at: string
  finished_at: string | null
}

function rowToRecord(row: PrivateRoomMatchRow): PrivateRoomMatchRecord {
  return {
    roomId: row.room_id,
    privateRoomId: row.private_room_id,
    status: row.status,
    stake: row.stake,
    teamA: JSON.parse(row.team_a_json) as [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant],
    teamB: JSON.parse(row.team_b_json) as [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant],
    teamAScore: row.team_a_score,
    teamBScore: row.team_b_score,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export async function createPrivateRoomMatchStore(
  databaseFilePath: string,
): Promise<PrivateRoomMatchStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const insertMatchStatement = database.prepare(`
    INSERT INTO private_room_matches (
      room_id, private_room_id, status, stake, team_a_json, team_b_json
    ) VALUES (?, ?, 'playing', ?, ?, ?)
    ON CONFLICT(room_id) DO NOTHING;
  `)

  const updateScoreStatement = database.prepare(`
    UPDATE private_room_matches
    SET team_a_score = ?, team_b_score = ?
    WHERE room_id = ? AND status = 'playing';
  `)

  const finishMatchStatement = database.prepare(`
    UPDATE private_room_matches
    SET status = 'finished',
        team_a_score = ?,
        team_b_score = ?,
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE room_id = ?;
  `)

  const listPlayingStatement = database.prepare(`
    SELECT room_id, private_room_id, status, stake, team_a_json, team_b_json,
           team_a_score, team_b_score, started_at, finished_at
    FROM private_room_matches
    WHERE status = 'playing'
    ORDER BY started_at DESC;
  `)

  const listFinishedSinceStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getListFinishedSinceStatement(visibilityHours: number): ReturnType<typeof database.prepare> {
    const cached = listFinishedSinceStatementCache.get(visibilityHours)
    if (cached) return cached
    // Параметризиран hours literal не се поддържа от SQLite datetime() modifier
    // синтаксиса (изисква string literal, не bound parameter) — visibilityHours
    // идва само от сървърен constant (PRIVATE_ROOM_FINISHED_VISIBILITY_HOURS),
    // никога от client input, safe за string interpolation тук.
    const statement = database.prepare(`
      SELECT room_id, private_room_id, status, stake, team_a_json, team_b_json,
             team_a_score, team_b_score, started_at, finished_at
      FROM private_room_matches
      WHERE status = 'finished' AND finished_at >= datetime('now', '-${visibilityHours} hours')
      ORDER BY finished_at DESC;
    `)
    listFinishedSinceStatementCache.set(visibilityHours, statement)
    return statement
  }

  const getMatchStatement = database.prepare(`
    SELECT room_id, private_room_id, status, stake, team_a_json, team_b_json,
           team_a_score, team_b_score, started_at, finished_at
    FROM private_room_matches
    WHERE room_id = ?;
  `)

  function recordMatchStarted(input: {
    roomId: string
    privateRoomId: string
    stake: number
    teamA: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
    teamB: [PrivateRoomMatchOccupant, PrivateRoomMatchOccupant]
  }): void {
    insertMatchStatement.run(
      input.roomId,
      input.privateRoomId,
      input.stake,
      JSON.stringify(input.teamA),
      JSON.stringify(input.teamB),
    )
  }

  function recordMatchScoreUpdate(roomId: string, teamAScore: number, teamBScore: number): void {
    updateScoreStatement.run(teamAScore, teamBScore, roomId)
  }

  function recordMatchFinished(roomId: string, teamAScore: number, teamBScore: number): void {
    finishMatchStatement.run(teamAScore, teamBScore, roomId)
  }

  function listPlayingMatches(): PrivateRoomMatchRecord[] {
    const rows = listPlayingStatement.all() as PrivateRoomMatchRow[]
    return rows.map(rowToRecord)
  }

  function listFinishedMatches(visibilityHours: number): PrivateRoomMatchRecord[] {
    const rows = getListFinishedSinceStatement(visibilityHours).all() as PrivateRoomMatchRow[]
    return rows.map(rowToRecord)
  }

  function getMatch(roomId: string): PrivateRoomMatchRecord | null {
    const row = getMatchStatement.get(roomId) as PrivateRoomMatchRow | undefined
    return row ? rowToRecord(row) : null
  }

  function close(): void {
    database.close()
  }

  return {
    recordMatchStarted,
    recordMatchScoreUpdate,
    recordMatchFinished,
    listPlayingMatches,
    listFinishedMatches,
    getMatch,
    close,
  }
}

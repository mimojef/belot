// Persistent history за Ludo игри (playing -> finished), захранва
// "Играещи"/"Приключили" lobby табовете на /games/ludo. Виж миграцията
// (20260925_001_create_ludo_room_matches.sql) за rationale защо е отделна
// таблица от active_ludo_match_snapshots (runtime crash-recovery кеш,
// изтрива редове при settle). Никога не трие редове — "Приключили"
// visibility прозорецът е WHERE filter на read пътя (listFinishedMatches),
// не retention job (mirror на privateRoomMatchStore.ts конвенцията).

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type LudoRoomMatchOccupant = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  color: 'red' | 'blue' | 'green' | 'yellow'
}

export type LudoRoomMatchRecord = {
  matchId: string
  ludoRoomId: string
  status: 'playing' | 'finished'
  stake: number
  playerCount: 2 | 4
  players: LudoRoomMatchOccupant[]
  winnerProfileId: string | null
  startedAt: string
  finishedAt: string | null
}

export type LudoRoomMatchStore = {
  recordMatchStarted: (input: {
    matchId: string
    ludoRoomId: string
    stake: number
    playerCount: 2 | 4
    players: LudoRoomMatchOccupant[]
  }) => void
  recordMatchFinished: (matchId: string, winnerProfileId: string | null) => void
  listPlayingMatches: () => LudoRoomMatchRecord[]
  /** finished_at >= now - visibilityHours (SQLite native datetime('now', ...) сравнение — виж privateRoomMatchStore.ts за established конвенцията). */
  listFinishedMatches: (visibilityHours: number) => LudoRoomMatchRecord[]
  getMatch: (matchId: string) => LudoRoomMatchRecord | null
  close: () => void
}

type LudoRoomMatchRow = {
  match_id: string
  ludo_room_id: string
  status: 'playing' | 'finished'
  stake: number
  player_count: 2 | 4
  players_json: string
  winner_profile_id: string | null
  started_at: string
  finished_at: string | null
}

function rowToRecord(row: LudoRoomMatchRow): LudoRoomMatchRecord {
  return {
    matchId: row.match_id,
    ludoRoomId: row.ludo_room_id,
    status: row.status,
    stake: row.stake,
    playerCount: row.player_count,
    players: JSON.parse(row.players_json) as LudoRoomMatchOccupant[],
    winnerProfileId: row.winner_profile_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export async function createLudoRoomMatchStore(
  databaseFilePath: string,
): Promise<LudoRoomMatchStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const insertMatchStatement = database.prepare(`
    INSERT INTO ludo_room_matches (
      match_id, ludo_room_id, status, stake, player_count, players_json
    ) VALUES (?, ?, 'playing', ?, ?, ?)
    ON CONFLICT(match_id) DO NOTHING;
  `)

  const finishMatchStatement = database.prepare(`
    UPDATE ludo_room_matches
    SET status = 'finished',
        winner_profile_id = ?,
        finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
    WHERE match_id = ?;
  `)

  const listPlayingStatement = database.prepare(`
    SELECT match_id, ludo_room_id, status, stake, player_count, players_json,
           winner_profile_id, started_at, finished_at
    FROM ludo_room_matches
    WHERE status = 'playing'
    ORDER BY started_at DESC;
  `)

  const listFinishedSinceStatementCache = new Map<number, ReturnType<typeof database.prepare>>()
  function getListFinishedSinceStatement(visibilityHours: number): ReturnType<typeof database.prepare> {
    const cached = listFinishedSinceStatementCache.get(visibilityHours)
    if (cached) return cached
    // Параметризиран hours literal не се поддържа от SQLite datetime()
    // modifier синтаксиса (изисква string literal, не bound parameter) —
    // visibilityHours идва само от сървърен constant, никога от client
    // input, safe за string interpolation тук (mirror на
    // privateRoomMatchStore.ts).
    const statement = database.prepare(`
      SELECT match_id, ludo_room_id, status, stake, player_count, players_json,
             winner_profile_id, started_at, finished_at
      FROM ludo_room_matches
      WHERE status = 'finished' AND finished_at >= datetime('now', '-${visibilityHours} hours')
      ORDER BY finished_at DESC;
    `)
    listFinishedSinceStatementCache.set(visibilityHours, statement)
    return statement
  }

  const getMatchStatement = database.prepare(`
    SELECT match_id, ludo_room_id, status, stake, player_count, players_json,
           winner_profile_id, started_at, finished_at
    FROM ludo_room_matches
    WHERE match_id = ?;
  `)

  function recordMatchStarted(input: {
    matchId: string
    ludoRoomId: string
    stake: number
    playerCount: 2 | 4
    players: LudoRoomMatchOccupant[]
  }): void {
    insertMatchStatement.run(
      input.matchId,
      input.ludoRoomId,
      input.stake,
      input.playerCount,
      JSON.stringify(input.players),
    )
  }

  function recordMatchFinished(matchId: string, winnerProfileId: string | null): void {
    finishMatchStatement.run(winnerProfileId, matchId)
  }

  function listPlayingMatches(): LudoRoomMatchRecord[] {
    const rows = listPlayingStatement.all() as LudoRoomMatchRow[]
    return rows.map(rowToRecord)
  }

  function listFinishedMatches(visibilityHours: number): LudoRoomMatchRecord[] {
    const rows = getListFinishedSinceStatement(visibilityHours).all() as LudoRoomMatchRow[]
    return rows.map(rowToRecord)
  }

  function getMatch(matchId: string): LudoRoomMatchRecord | null {
    const row = getMatchStatement.get(matchId) as LudoRoomMatchRow | undefined
    return row ? rowToRecord(row) : null
  }

  function close(): void {
    database.close()
  }

  return {
    recordMatchStarted,
    recordMatchFinished,
    listPlayingMatches,
    listFinishedMatches,
    getMatch,
    close,
  }
}

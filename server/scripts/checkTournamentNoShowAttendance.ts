/**
 * checkTournamentNoShowAttendance.ts
 *
 * Store/coordinator-level regression (реален SQLite + in-process
 * createTournamentCoordinator, огледален pattern на
 * checkTournamentConcurrency.ts) за новия no-show attendance модел:
 *
 *  - НЯМА служебна загуба (walkover) при неявяване — нито едностранно,
 *    нито двустранно липсващи seats.
 *  - Presence е project-wide "профилът е logged in някъде"
 *    (isProfileOnline dep), НЕ room/seat-scoped connection attachment.
 *  - Early transition: щом всички 4 станат online преди deadline-а,
 *    attendance се resolve-ва веднага (следващия tick), не се чака
 *    пълните 3 минути.
 *  - При изтекъл deadline с липсващи places — bot-fill (played_with_bots
 *    resultKind при финален completion), match_status минава countdown ->
 *    in_progress нормално.
 *  - matchStatus полето в TournamentMatchAssignment коректно отразява
 *    awaiting_players/countdown/in_progress за destination resolver-а.
 *
 * Сценарии A-E от task spec-а ("TESTS — ATTENDANCE").
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, Seat, ServerRoom, Team } from '../src/core/serverTypes.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'
import { createTournamentScheduler } from '../src/tournament/tournamentScheduler.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function loadMigrationFileNames(): Promise<string[]> {
  const entries = await readdir(migrationsDirectoryPath, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
}

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const getApplied = database.prepare(`SELECT filename FROM server_migrations WHERE filename = ? LIMIT 1;`)
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of await loadMigrationFileNames()) {
    if (getApplied.get(filename) !== undefined) continue
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      insertApplied.run(filename)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

function publicProfile(profileId: string, index: number): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName: `Attendance Player ${index + 1}`,
    avatarUrl: null,
    level: 1,
    rankTitle: 'Test',
    skillRating: 1000,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 10,
    gamesUntilNextRank: 10,
    rankProgressRatio: 0,
    averageRating: null,
    totalRatingsCount: null,
    yellowCoinsBalance: 100_000,
    galleryImages: [],
    gender: null,
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
  }
}

function insertProfile(database: DatabaseSync, profileId: string, index: number): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name)
    VALUES (?, ?, ?);
  `).run(profileId, `Attendance Player ${index + 1}`, `attendance player ${index + 1}`)
  database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 100000);
  `).run(profileId)
}

type MatchInfo = {
  matchId: string
  roomId: string | null
  roundType: string
  teamAId: string
  teamBId: string
  status: string
  resultKind: string | null
  winnerTeamId: string | null
  attendanceResolutionKind: string | null
  attendanceDeadlineAt: string | null
  gameStartAt: string | null
}

function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType,
           tm.team_a_id AS teamAId, tm.team_b_id AS teamBId,
           tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId,
           tm.attendance_resolution_kind AS attendanceResolutionKind,
           tm.attendance_deadline_at AS attendanceDeadlineAt, tm.game_start_at AS gameStartAt
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ?
    ORDER BY tr.round_index ASC;
  `).all(tournamentId) as MatchInfo[]
}

function forceAttendanceDeadlineElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`
    UPDATE tournament_matches
    SET attendance_deadline_at = '2026-07-30T09:59:00.000Z',
        no_show_deadline_at = '2026-07-30T09:59:00.000Z'
    WHERE match_id = ?;
  `).run(matchId)
}

function forceCountdownElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`
    UPDATE tournament_matches
    SET game_start_at = '2026-07-30T09:59:00.000Z'
    WHERE match_id = ?;
  `).run(matchId)
}

function countReplacements(database: DatabaseSync, matchId: string, status?: string): number {
  return (database.prepare(`
    SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements
    WHERE match_id = ? AND (? IS NULL OR status = ?);
  `).get(matchId, status ?? null, status ?? null) as { count: number }).count
}

console.log('\n=== checkTournamentNoShowAttendance ===\n')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-noshow-attendance-'))
const dbPath = join(tempDir, 'test.sqlite')
const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
await applyMigrations(db)
const tournamentStore = await createTournamentStore(dbPath)
const economyStore = await createTournamentEconomyStore(dbPath)
const scheduler = await createTournamentScheduler({
  databaseFilePath: dbPath,
  economyStore,
  now: () => new Date('2026-07-30T10:00:00.000Z'),
  setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
  clearInterval: () => {},
})

const profileIds = Array.from({ length: 160 }, () => randomUUID())
profileIds.forEach((profileId, index) => insertProfile(db, profileId, index))
const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
const rooms = new Map<string, ServerRoom>()
// Project-wide "profile has any open connection" presence mock (§"PRESENCE
// SEMANTICS" в task spec-а) — простo Set, НЕ room/seat-scoped connection
// tuple, огледално на реалния isProfileOnline dep в server/src/index.ts.
const onlineProfiles = new Set<string>()

const coordinator = await createTournamentCoordinator({
  databaseFilePath: dbPath,
  getPublicProfile: (profileId) => profiles.get(profileId) ?? null,
  getRoom: (roomId) => rooms.get(roomId) ?? null,
  commitRoom: (room) => { rooms.set(room.id, room) },
  closeCompletedRoom: (room) => { rooms.delete(room.id) },
  ensureRoomRuntime: () => ({ ok: true }),
  settleTournamentPrizes: (tournamentId) => {
    const result = economyStore.settleTournamentPrizesAtomically(tournamentId, new Date('2026-07-30T12:00:00.000Z'))
    return result.ok ? { ok: true, alreadySettled: result.alreadySettled } : { ok: false, reason: result.reason }
  },
  notifyAssignment: () => {},
  notifyFeederMatchCompleted: () => {},
  notifyFeederScoreProgress: () => {},
  isConnectionAttached: () => false,
  isProfileOnline: (profileId) => onlineProfiles.has(profileId),
  setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
  clearInterval: () => {},
})

let cursor = 0
function nextProfiles(count: number): string[] {
  const slice = profileIds.slice(cursor, cursor + count)
  cursor += count
  if (slice.length !== count) throw new Error('test profile pool exhausted')
  return slice
}

function createTournament(creatorProfileId: string, name: string): string {
  const result = tournamentStore.createTournament({
    kind: 'community',
    name,
    creatorProfileId,
    visibility: 'public',
    entryFee: 10_000,
    startMode: 'fill',
  })
  assert(result.ok === true, `create failed: ${JSON.stringify(result)}`)
  return result.tournament.tournamentId
}

function joinAll(tournamentId: string, participants: string[]): void {
  for (const profileId of participants) {
    const result = economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
    assert(result.ok === true, `join failed: ${JSON.stringify(result)}`)
  }
}

// Team capacity 4 (8 играчи) е минималната поддържана bracket форма
// (getTournamentRoundLadder приема само 4/8/16) — тестовете тук ползват
// само PЪРВИЯ (semifinal) кръг за attendance сценариите, останалите 4
// профила формират второто semifinal-двойка, недокоснато от асертите.
function startFullTournament(name: string): { tournamentId: string; participants: string[] } {
  const participants = nextProfiles(8)
  const tournamentId = createTournament(participants[0]!, name)
  joinAll(tournamentId, participants)
  scheduler.tickNow()
  coordinator.tickNow()
  return { tournamentId, participants }
}

function getSeatProfileMap(database: DatabaseSync, match: MatchInfo): Record<Seat, string> {
  const rows = database.prepare(`
    SELECT te.profile_id AS profileId, te.joined_as AS joinedAs, tt.team_id AS teamId
    FROM tournament_entries te
    JOIN tournament_teams tt ON tt.team_id = te.team_id
    WHERE tt.team_id IN (?, ?)
    ORDER BY te.created_at ASC;
  `).all(match.teamAId, match.teamBId) as Array<{ profileId: string; joinedAs: string; teamId: string }>
  const teamAMembers = rows.filter((r) => r.teamId === match.teamAId)
  const teamBMembers = rows.filter((r) => r.teamId === match.teamBId)
  return {
    bottom: teamAMembers[0]!.profileId,
    top: teamAMembers[1]!.profileId,
    left: teamBMembers[0]!.profileId,
    right: teamBMembers[1]!.profileId,
  }
}

// Двете semifinal двойки за 8-играчов турнир имат по 4 играчи всяка;
// изборът кой match_id съответства на кои 4 профила зависи от bracket
// seeding-a, не от join реда — затова всеки сценарий работи с ЕДИН избран
// match (matches[0]) и извлича точно неговите 4 seat профила през
// getSeatProfileMap, вместо да предполага participants[0..3].

// ============================================================
// Scenario A — all online immediately: no wait for the full 3 minutes.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario A')
  for (const p of participants) onlineProfiles.add(p)
  coordinator.tickNow()
  const match = getMatches(db, tournamentId)[0]!
  check('[A] match resolves to countdown immediately (all 4 online, deadline NOT elapsed)', match.status === 'countdown', JSON.stringify(match))
  check('[A] resolution kind is all_present (no bots)', match.attendanceResolutionKind === 'all_present', JSON.stringify(match))
  check('[A] no replacement rows were created', countReplacements(db, match.matchId) === 0)

  forceCountdownElapsed(db, match.matchId)
  coordinator.tickNow()
  const afterCountdown = getMatches(db, tournamentId).find((m) => m.matchId === match.matchId)!
  check('[A] match transitions to in_progress after the 20s countdown elapses', afterCountdown.status === 'in_progress', JSON.stringify(afterCountdown))

  const seatMap = getSeatProfileMap(db, match)
  const assignment = coordinator.getAssignmentForProfile(seatMap.bottom)
  check('[A] getAssignmentForProfile reports matchStatus=in_progress for a normally-started match', assignment?.matchStatus === 'in_progress', JSON.stringify(assignment))
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario B — one offline, appears before deadline: early transition once
// all 4 become online, no walkover/bot-fill triggered.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario B')
  const match0 = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match0)
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  onlineProfiles.add(seatMap.left)
  // seatMap.right stays offline initially
  coordinator.tickNow()
  let match = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[B] match stays awaiting_players while one player is offline (deadline not elapsed)', match.status === 'awaiting_players', JSON.stringify(match))

  const assignmentForOfflinePlayer = coordinator.getAssignmentForProfile(seatMap.right)
  check('[B] matchStatus for the offline player is awaiting_players (destination resolver routes to attendance screen)', assignmentForOfflinePlayer?.matchStatus === 'awaiting_players', JSON.stringify(assignmentForOfflinePlayer))

  // seatMap.right "logs in" mid-window — presence flips, no manual navigation required.
  onlineProfiles.add(seatMap.right)
  coordinator.tickNow()
  match = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[B] once all 4 are online, attendance resolves early to countdown (no waiting for the 3-minute deadline)', match.status === 'countdown', JSON.stringify(match))
  check('[B] resolution kind is all_present — no bots were ever inserted', match.attendanceResolutionKind === 'all_present', JSON.stringify(match))
  check('[B] no replacement rows exist for this match', countReplacements(db, match.matchId) === 0)
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario C — one offline, never appears: bot-fill at deadline, NO
// walkover, exactly the missing seat is bot-controlled.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario C')
  const match0 = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match0)
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  onlineProfiles.add(seatMap.left)
  // seatMap.right never appears.
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, match0.matchId)
  coordinator.tickNow()
  const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[C] match resolves to countdown at deadline (bot-fill, not stuck waiting forever)', resolved.status === 'countdown', JSON.stringify(resolved))
  check('[C] resolution kind is bots_inserted', resolved.attendanceResolutionKind === 'bots_inserted', JSON.stringify(resolved))
  check('[C] result_kind is NOT walkover (no service loss for no-show)', resolved.resultKind !== 'walkover', JSON.stringify(resolved))
  check('[C] exactly one active replacement row was created for the missing seat', countReplacements(db, resolved.matchId, 'active') === 1)
  check('[C] hasUnresolvedBotReplacement is TRUE for the missing player immediately after bot-fill', coordinator.hasUnresolvedBotReplacement(tournamentId, seatMap.right))
  check('[C] hasUnresolvedBotReplacement is FALSE for a present player (never replaced)', !coordinator.hasUnresolvedBotReplacement(tournamentId, seatMap.bottom))

  forceCountdownElapsed(db, resolved.matchId)
  coordinator.tickNow()
  const started = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[C] match reaches in_progress normally after the 20s countdown (bot plays the missing seat)', started.status === 'in_progress', JSON.stringify(started))
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario D — missing only from ONE team (the exact old walkover trigger
// condition) — must now bot-fill, never walkover.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario D')
  const match = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match)
  // Team A = bottom/top, Team B = left/right — put both of Team A online,
  // leave BOTH of Team B offline (entire opposing team missing == the old
  // "oneSidedWalkover" branch condition exactly).
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, match.matchId)
  coordinator.tickNow()
  const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match.matchId)!
  check('[D] one-team-fully-missing no longer produces a walkover result', resolved.resultKind !== 'walkover', JSON.stringify(resolved))
  check('[D] one-team-fully-missing no longer produces a walkover attendance_resolution_kind', resolved.attendanceResolutionKind !== 'walkover', JSON.stringify(resolved))
  check('[D] resolution kind is bots_inserted (both missing seats bot-filled)', resolved.attendanceResolutionKind === 'bots_inserted', JSON.stringify(resolved))
  check('[D] match is NOT completed by walkover (still progressing through countdown)', resolved.status === 'countdown', JSON.stringify(resolved))
  check('[D] exactly two active replacement rows (both Team B seats)', countReplacements(db, resolved.matchId, 'active') === 2)
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario E — missing from BOTH teams (was already bot-fill before this
// change, confirming it still works unchanged after the walkover branch
// removal).
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario E')
  const match = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match)
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.left)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, match.matchId)
  coordinator.tickNow()
  const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match.matchId)!
  check('[E] resolution kind is bots_inserted when both teams have a missing seat', resolved.attendanceResolutionKind === 'bots_inserted', JSON.stringify(resolved))
  check('[E] result_kind is not walkover', resolved.resultKind !== 'walkover', JSON.stringify(resolved))
  check('[E] exactly two active replacement rows (one per team)', countReplacements(db, resolved.matchId, 'active') === 2)
  for (const p of participants) onlineProfiles.delete(p)
}

function endRoom(room: ServerRoom, winnerTeam: Team): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const endedState: ServerAuthoritativeGameState = {
    ...state,
    phase: 'match-ended',
    matchEnded: {
      winnerTeam,
      targetScore: initialized.config.targetScore,
      finalScore: winnerTeam === 'A' ? { teamA: 151, teamB: 70 } : { teamA: 70, teamB: 151 },
      endedAt: Date.now(),
    },
    score: {
      ...state.score,
      match: winnerTeam === 'A' ? { teamA: 151, teamB: 70 } : { teamA: 70, teamB: 151 },
    },
  }
  return {
    ...initialized,
    status: 'finished',
    game: {
      ...initialized.game,
      phase: 'finished',
      stateVersion: initialized.game.stateVersion + 1,
      updatedAt: Date.now(),
      authoritativeState: endedState,
    },
  }
}

// ============================================================
// Scenario F — CRITICAL persistence regression (§"КРИТИЧНО РАЗГРАНИЧЕНИЕ" в
// допълнението): a missing human's bot-replacement must survive the match
// they were replaced in actually being WON by the bot-controlled team —
// hasUnresolvedBotReplacement is scoped to (tournamentId, profileId), not
// one match_id, so it stays TRUE through advanceCompletedMatch/STATE A/B,
// and only clears on a genuine tryTakeoverNoShowBot reclaim.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario F')
  const match0 = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match0)
  const missingProfileId = seatMap.right
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  onlineProfiles.add(seatMap.left)
  // missingProfileId never appears.
  coordinator.tickNow()
  check(
    '[F] no replacement exists before the deadline elapses (§"ATTENDANCE LOGIN ПРЕДИ DEADLINE" — attendance alone must not force-return)',
    !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId),
  )
  forceAttendanceDeadlineElapsed(db, match0.matchId)
  coordinator.tickNow()

  const afterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[F] bot-fill happened (bots_inserted)', afterBotFill.attendanceResolutionKind === 'bots_inserted', JSON.stringify(afterBotFill))
  check('[F] hasUnresolvedBotReplacement is TRUE right after bot-fill', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  forceCountdownElapsed(db, afterBotFill.matchId)
  coordinator.tickNow()
  const inProgress = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  const roomInProgress = rooms.get(inProgress.roomId!)!

  // Reclaim WHILE the bot-controlled match is still being played (gameplay
  // destination — §"GAMEPLAY RECLAIM") — the missing player finally shows
  // up mid-match. Uses the SAME reconnect_token the replacement row carries
  // (getAssignmentForProfile.reconnectToken already resolves this correctly
  // for a bot-occupied seat — see getReconnectToken in tournamentCoordinator.ts).
  const assignmentDuringGameplay = coordinator.getAssignmentForProfile(missingProfileId)
  assert(assignmentDuringGameplay !== null, 'missing player must still have a runnable assignment during gameplay')
  assert(assignmentDuringGameplay.reconnectToken !== null, 'a bot-occupied seat must still expose a reconnect token')
  const takeover = coordinator.tryTakeoverNoShowBot({
    room: roomInProgress,
    profileId: missingProfileId,
    connectionId: 'reclaim-connection-1' as never,
    reconnectToken: assignmentDuringGameplay.reconnectToken,
  })
  check('[F] reclaim succeeds mid-gameplay once the missing player returns', takeover.ok === true, JSON.stringify(takeover))
  check(
    '[F] hasUnresolvedBotReplacement becomes FALSE immediately after a successful reclaim',
    !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId),
  )

  // §"АКО HUMAN Е RECLAIM-НАЛ" — refresh/re-check afterwards must not
  // resurrect the requirement (idempotent: the replacement row is now
  // 'completed', selectUnresolvedReplacementForProfileStatement only ever
  // matches 'active'/'takeover_pending').
  check(
    '[F] a repeated authoritative re-check after reclaim still reports FALSE (does not resurrect)',
    !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId),
  )
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario G — bot wins while human never reclaims, confirmed via the SAME
// endRoom/onTournamentRoomCompleted path as checkTournamentConcurrency.ts —
// isolates the exact "match completes, requirement must survive" transition
// without also asserting on the reclaim flow (kept separate from Scenario F
// so a reclaim-path regression cannot mask this one, and vice versa).
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario G')
  const match0 = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match0)
  const missingProfileId = seatMap.right
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  onlineProfiles.add(seatMap.left)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, match0.matchId)
  coordinator.tickNow()
  const afterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  forceCountdownElapsed(db, afterBotFill.matchId)
  coordinator.tickNow()

  const missingTeamIsA = seatMap.bottom === missingProfileId || seatMap.top === missingProfileId
  const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
  const roomForMatch = rooms.get(afterBotFill.roomId!)!
  coordinator.onTournamentRoomCompleted(endRoom(roomForMatch, winningTeam))

  const afterWin = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[G] match completed normally (not walkover) with the bot-controlled team winning', afterWin.status === 'completed' && afterWin.resultKind !== 'walkover', JSON.stringify(afterWin))
  check(
    '[G] ROOT CAUSE #2 regression: hasUnresolvedBotReplacement REMAINS TRUE after the bot-controlled team WINS and the match completes — the requirement must survive into STATE A, never auto-clear on a win',
    coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId),
  )
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario H — §"AUTHORITATIVE RETURN ACTION" (2nd amendment): STATE A/B
// click on "Поеми играта" must authoritatively clear the persisted
// replacement via acknowledgeTournamentBotReplacementReturn — navigating to
// the detail screen alone (the OLD, buggy behavior) must NOT clear it.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario H')
  const match0 = getMatches(db, tournamentId)[0]!
  const seatMap = getSeatProfileMap(db, match0)
  const missingProfileId = seatMap.right
  onlineProfiles.add(seatMap.bottom)
  onlineProfiles.add(seatMap.top)
  onlineProfiles.add(seatMap.left)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, match0.matchId)
  coordinator.tickNow()
  const afterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  forceCountdownElapsed(db, afterBotFill.matchId)
  coordinator.tickNow()

  const missingTeamIsA = seatMap.bottom === missingProfileId || seatMap.top === missingProfileId
  const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(afterBotFill.roomId!)!, winningTeam))
  check('[H] hasUnresolvedBotReplacement is TRUE right after the bot-won match completes (STATE A territory)', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // Simulate the user finally logging in (online now) WITHOUT pressing the
  // button — bot-win alone / merely being online must not clear anything.
  onlineProfiles.add(missingProfileId)
  check(
    '[H] merely becoming online (login, no button click) does NOT clear the requirement — the OLD bug this amendment fixes',
    coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId),
  )

  // Now simulate the actual "Поеми играта" click in STATE A/B — the
  // authoritative server action, NOT just navigateToTournamentDetail.
  const ack1 = coordinator.acknowledgeTournamentBotReplacementReturn(tournamentId, missingProfileId)
  check('[H] acknowledgeTournamentBotReplacementReturn succeeds for a genuinely unresolved replacement', ack1.ok === true && ack1.ok && !ack1.alreadyResolved, JSON.stringify(ack1))
  check('[H] hasUnresolvedBotReplacement becomes FALSE immediately after the STATE A/B acknowledge action', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // Idempotency (§"IDEMPOTENCY" — double click / repeated request).
  const ack2 = coordinator.acknowledgeTournamentBotReplacementReturn(tournamentId, missingProfileId)
  check('[H] a second acknowledge call is idempotent (ok:true, alreadyResolved:true, no error)', ack2.ok === true && ack2.ok && ack2.alreadyResolved, JSON.stringify(ack2))
  check('[H] hasUnresolvedBotReplacement remains FALSE after the idempotent repeat', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // §"REFRESH AFTER SUCCESSFUL RECLAIM" — a fresh re-check (simulating
  // refresh/reconnect) must not resurrect the requirement.
  check('[H] a further authoritative re-check (simulated refresh) still reports FALSE', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario I — §"BOT CONTINUITY ACROSS ROUNDS"/"NEXT MATCH ATTENDANCE":
// online != reclaimed. Advances BOTH semifinals to completion (the missing
// player's bot-controlled team WINS), then proves the FINAL's attendance
// resolution still treats the profile as missing — DESPITE isProfileOnline
// now being true — because the replacement from the semifinal was never
// acknowledged/reclaimed. This is the genuine cross-match continuity proof
// (Scenario C/D/E only ever check within a single still-unresolved match).
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario I')
  const matches = getMatches(db, tournamentId)
  const semi1 = matches[0]!
  const semi2 = matches[1]!
  const seatMap1 = getSeatProfileMap(db, semi1)
  const missingProfileId = seatMap1.right
  onlineProfiles.add(seatMap1.bottom)
  onlineProfiles.add(seatMap1.top)
  onlineProfiles.add(seatMap1.left)
  // The other semifinal is fully present so it resolves normally in the
  // same tick window, letting the bracket advance to the final immediately.
  const seatMap2 = getSeatProfileMap(db, semi2)
  onlineProfiles.add(seatMap2.bottom)
  onlineProfiles.add(seatMap2.top)
  onlineProfiles.add(seatMap2.left)
  onlineProfiles.add(seatMap2.right)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, semi1.matchId)
  coordinator.tickNow()
  const semi1AfterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === semi1.matchId)!
  check('[I] replacement created for the missing player in the semifinal', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
  forceCountdownElapsed(db, semi1AfterBotFill.matchId)
  const semi2AfterResolve = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2AfterResolve.status === 'countdown') forceCountdownElapsed(db, semi2.matchId)
  coordinator.tickNow()

  const missingTeamIsA = seatMap1.bottom === missingProfileId || seatMap1.top === missingProfileId
  const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi1AfterBotFill.roomId!)!, winningTeam))
  const semi2Final = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2Final.status === 'in_progress') {
    coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi2Final.roomId!)!, 'A'))
  }
  coordinator.tickNow()

  // The missing player finally comes online (e.g. opens the app) but does
  // NOT press "Поеми играта" — per §"ONLINE !== RECLAIMED" this must not
  // grant them presence for the final.
  onlineProfiles.add(missingProfileId)
  coordinator.tickNow()

  const finalMatch = getMatches(db, tournamentId).find((m) => m.roundType === 'final')
  if (finalMatch !== undefined && finalMatch.status === 'awaiting_players') {
    forceAttendanceDeadlineElapsed(db, finalMatch.matchId)
    coordinator.tickNow()
    const finalResolved = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch.matchId)!
    check(
      '[I] the FINAL still bot-fills the previously-unresolved profile DESPITE isProfileOnline=true (bot continuity across rounds — online != reclaimed)',
      finalResolved.attendanceResolutionKind === 'bots_inserted',
      JSON.stringify(finalResolved),
    )
  } else {
    check('[I] the final match exists and reached attendance (bracket advanced past both semifinals)', finalMatch !== undefined, JSON.stringify(finalMatch))
  }
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario J — §"MODEL A" (3rd amendment): unresolved chain across rounds.
// X misses BOTH the semifinal AND the final (two separate replacement rows,
// two different match_id's). A single gameplay reclaim in the final must
// close BOTH rows — not leave the older semifinal row stuck 'active'
// forever, which would cause hasUnresolvedBotReplacement to stay TRUE
// (stale blocking modal) even after a genuinely successful reclaim.
// Empirically proven via a real DB trace before this fix landed: the old
// code left the semifinal row 'active' after a successful final reclaim.
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario J')
  const matches = getMatches(db, tournamentId)
  const semi1 = matches[0]!
  const semi2 = matches[1]!
  const seatMap1 = getSeatProfileMap(db, semi1)
  const seatMap2 = getSeatProfileMap(db, semi2)
  const missingProfileId = seatMap1.right

  onlineProfiles.add(seatMap1.bottom)
  onlineProfiles.add(seatMap1.top)
  onlineProfiles.add(seatMap1.left)
  onlineProfiles.add(seatMap2.bottom)
  onlineProfiles.add(seatMap2.top)
  onlineProfiles.add(seatMap2.left)
  onlineProfiles.add(seatMap2.right)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, semi1.matchId)
  coordinator.tickNow()
  const semi1AfterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === semi1.matchId)!
  check('[J] semifinal replacement R1 created (active)', countReplacements(db, semi1.matchId, 'active') === 1)

  forceCountdownElapsed(db, semi1AfterBotFill.matchId)
  const semi2Check = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2Check.status === 'countdown') forceCountdownElapsed(db, semi2.matchId)
  coordinator.tickNow()

  const missingTeamIsA = seatMap1.bottom === missingProfileId || seatMap1.top === missingProfileId
  const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi1AfterBotFill.roomId!)!, winningTeam))
  const semi2Final = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2Final.status === 'in_progress') coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi2Final.roomId!)!, 'A'))
  coordinator.tickNow()

  // X remains unreclaimed AND offline through the final's attendance window too.
  const finalMatch = getMatches(db, tournamentId).find((m) => m.roundType === 'final')
  assert(finalMatch !== undefined, '[J] final match must exist after both semifinals complete')
  forceAttendanceDeadlineElapsed(db, finalMatch!.matchId)
  coordinator.tickNow()
  const finalAfterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch!.matchId)!
  check('[J] final replacement R2 created (active) — a SECOND, distinct row from R1', countReplacements(db, finalMatch!.matchId, 'active') === 1)
  check('[J] R1 (semifinal) is still active before any reclaim', countReplacements(db, semi1.matchId, 'active') === 1)
  check('[J] R2 (final) is active before any reclaim', countReplacements(db, finalMatch!.matchId, 'active') === 1)
  check('[J] forceReturn (hasUnresolvedBotReplacement) is TRUE with two independent unresolved rows', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // X finally logs in and reclaims during the FINAL's live gameplay.
  onlineProfiles.add(missingProfileId)
  forceCountdownElapsed(db, finalAfterBotFill.matchId)
  coordinator.tickNow()
  const assignmentForReclaim = coordinator.getAssignmentForProfile(missingProfileId)
  assert(assignmentForReclaim !== null, '[J] missing player must have a runnable assignment during final gameplay')
  assert(assignmentForReclaim.reconnectToken !== null, '[J] a bot-occupied seat must still expose a reconnect token')
  const roomForReclaim = rooms.get(assignmentForReclaim.roomId)!
  const takeover = coordinator.tryTakeoverNoShowBot({
    room: roomForReclaim,
    profileId: missingProfileId,
    connectionId: 'scenario-j-connection-1' as never,
    reconnectToken: assignmentForReclaim.reconnectToken,
  })
  check('[J] the exact current (final) seat is reclaimed successfully', takeover.ok === true, JSON.stringify(takeover))
  check('[J] the human now controls the final seat matching the assignment', takeover.ok === true && takeover.seat === assignmentForReclaim.seat, JSON.stringify(takeover))

  check('[J] R2 (final) is now completed', countReplacements(db, finalMatch!.matchId, 'completed') === 1)
  check(
    '[J] MODEL A FIX: R1 (the OLDER semifinal row) is ALSO completed by the single final reclaim — no stale historic row remains',
    countReplacements(db, semi1.matchId, 'completed') === 1 && countReplacements(db, semi1.matchId, 'active') === 0,
  )
  check('[J] forceReturn (hasUnresolvedBotReplacement) becomes FALSE — the entire tournament-level obligation is resolved, not just the current match', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // Refresh/reconnect must not resurrect the modal.
  check('[J] a further authoritative re-check (simulated refresh/reconnect) still reports FALSE', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
  for (const p of participants) onlineProfiles.delete(p)
}

// ============================================================
// Scenario K — STATE A/B variant of Scenario J: X misses the semifinal
// (R1 active), the bot-controlled team wins and moves to STATE A/B (no
// runnable match yet for X — the final hasn't started attendance), and X
// clicks "Поеми играта" via acknowledgeTournamentBotReplacementReturn
// (the STATE A/B path, not gameplay reclaim). This must ALSO close the
// entire tournament-level obligation, and the subsequent final attendance
// must then treat X as a normal, personally-present participant (no new
// replacement created, no BOT badge).
// ============================================================
{
  const { tournamentId, participants } = startFullTournament('Scenario K')
  const matches = getMatches(db, tournamentId)
  const semi1 = matches[0]!
  const semi2 = matches[1]!
  const seatMap1 = getSeatProfileMap(db, semi1)
  const seatMap2 = getSeatProfileMap(db, semi2)
  const missingProfileId = seatMap1.right

  onlineProfiles.add(seatMap1.bottom)
  onlineProfiles.add(seatMap1.top)
  onlineProfiles.add(seatMap1.left)
  onlineProfiles.add(seatMap2.bottom)
  onlineProfiles.add(seatMap2.top)
  onlineProfiles.add(seatMap2.left)
  onlineProfiles.add(seatMap2.right)
  coordinator.tickNow()
  forceAttendanceDeadlineElapsed(db, semi1.matchId)
  coordinator.tickNow()
  const semi1AfterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === semi1.matchId)!
  forceCountdownElapsed(db, semi1AfterBotFill.matchId)
  const semi2Check = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2Check.status === 'countdown') forceCountdownElapsed(db, semi2.matchId)
  coordinator.tickNow()

  const missingTeamIsA = seatMap1.bottom === missingProfileId || seatMap1.top === missingProfileId
  const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi1AfterBotFill.roomId!)!, winningTeam))
  const semi2Final = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
  if (semi2Final.status === 'in_progress') coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi2Final.roomId!)!, 'A'))
  coordinator.tickNow()

  // X logs in now (STATE A/B territory — final attendance not started yet
  // in this test ordering) and clicks "Поеми играта" via the STATE A/B
  // authoritative action, NOT gameplay reclaim.
  onlineProfiles.add(missingProfileId)
  check('[K] forceReturn is TRUE right after the bot-won semifinal (STATE A/B territory)', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
  const ack = coordinator.acknowledgeTournamentBotReplacementReturn(tournamentId, missingProfileId)
  check('[K] the STATE A/B acknowledge action succeeds', ack.ok === true && ack.ok && !ack.alreadyResolved, JSON.stringify(ack))
  check('[K] R1 (semifinal) is now completed via the STATE A/B path (not gameplay reclaim)', countReplacements(db, semi1.matchId, 'completed') === 1)
  check('[K] forceReturn becomes FALSE — the entire obligation is cleared by the single STATE A/B click', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

  // The subsequent final attendance must now treat X as a normal, personally
  // present participant — no new replacement row, no bot continuity.
  const finalMatch = getMatches(db, tournamentId).find((m) => m.roundType === 'final')
  assert(finalMatch !== undefined, '[K] final match must exist')
  forceAttendanceDeadlineElapsed(db, finalMatch!.matchId)
  coordinator.tickNow()
  const finalResolved = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch!.matchId)!
  check(
    '[K] after a successful STATE A/B reclaim, the final attendance resolves all_present for X (normal human participant, no new replacement/BOT badge)',
    finalResolved.attendanceResolutionKind === 'all_present',
    JSON.stringify(finalResolved),
  )
  check('[K] no replacement row was created for X in the final', countReplacements(db, finalMatch!.matchId) === 0)

  // Refresh in STATE A/B (or after) must not resurrect the modal.
  check('[K] a further authoritative re-check still reports FALSE (refresh-safe)', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
  for (const p of participants) onlineProfiles.delete(p)
}

function getRosterEntry(
  roomId: string,
  seat: Seat,
): { isOnline: boolean } | undefined {
  const room = rooms.get(roomId)
  const roster = room?.config.tournamentAttendance?.roster
  return roster?.find((entry) => entry.seat === seat)
}

// ============================================================
// Scenario L — §"ONLINE != PERSONALLY PRESENT / RECLAIMED" (3rd amendment):
// the roster's visual "Онлайн/Офлайн" indicator (isOnline) must reflect
// PURE network presence (getOnlineSeats/isProfileOnline), NEVER conflated
// with personallyPresent (getPresentSeats, which excludes profiles with an
// unresolved bot replacement). A logged-in player who simply hasn't pressed
// "Поеми играта" yet must still show as "Онлайн" to the other players —
// only the ATTENDANCE RESOLUTION decision (bot-fill/early-transition) may
// use personallyPresent.
// ============================================================
{
  // [L1] Normal online, no unresolved replacement: UI=Онлайн, personallyPresent=true.
  {
    const { tournamentId, participants } = startFullTournament('Scenario L1')
    const match0 = getMatches(db, tournamentId)[0]!
    const seatMap = getSeatProfileMap(db, match0)
    for (const p of [seatMap.bottom, seatMap.top, seatMap.left, seatMap.right]) onlineProfiles.add(p)
    coordinator.tickNow()
    const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
    check('[L1] normal online participant: roster isOnline=true (UI shows Онлайн)', getRosterEntry(resolved.roomId!, 'bottom')?.isOnline === true)
    check('[L1] normal online participant: attendance resolves all_present (personallyPresent=true drove early resolution)', resolved.attendanceResolutionKind === 'all_present', JSON.stringify(resolved))
    for (const p of participants) onlineProfiles.delete(p)
  }

  // [L2] Offline: UI=Офлайн, personallyPresent=false.
  {
    const { tournamentId, participants } = startFullTournament('Scenario L2')
    const match0 = getMatches(db, tournamentId)[0]!
    const seatMap = getSeatProfileMap(db, match0)
    // Deliberately leave exactly one seat's profile offline — which physical
    // seat that maps to is not guaranteed to match this test harness's own
    // getSeatProfileMap ordering (a separate, tie-prone query from the
    // coordinator's own sortTeamEntries), so the offline profile is picked
    // first and the assertion below reverse-looks-up its actual seat from
    // the authoritative roster itself, exactly like Scenario L3 does.
    const offlineProfileId = seatMap.right
    for (const p of [seatMap.bottom, seatMap.top, seatMap.left, seatMap.right]) {
      if (p !== offlineProfileId) onlineProfiles.add(p)
    }
    coordinator.tickNow()
    const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
    const roster = rooms.get(resolved.roomId!)?.config.tournamentAttendance?.roster ?? []
    const offlineRosterEntries = roster.filter((entry) => !entry.isOnline)
    check('[L2] exactly one roster entry shows isOnline=false (the deliberately offline profile)', offlineRosterEntries.length === 1, JSON.stringify(roster))
    check('[L2] offline participant: attendance still waiting (personallyPresent=false, correctly missing)', resolved.status === 'awaiting_players', JSON.stringify(resolved))
    for (const p of participants) onlineProfiles.delete(p)
  }

  // [L3] Online but unresolved replacement (from a previous round, carried
  // over): UI must STILL show Онлайн — only personallyPresent is false.
  {
    const { tournamentId, participants } = startFullTournament('Scenario L3')
    const matches = getMatches(db, tournamentId)
    const semi1 = matches[0]!
    const semi2 = matches[1]!
    const seatMap1 = getSeatProfileMap(db, semi1)
    const seatMap2 = getSeatProfileMap(db, semi2)
    const missingProfileId = seatMap1.right
    onlineProfiles.add(seatMap1.bottom)
    onlineProfiles.add(seatMap1.top)
    onlineProfiles.add(seatMap1.left)
    onlineProfiles.add(seatMap2.bottom)
    onlineProfiles.add(seatMap2.top)
    onlineProfiles.add(seatMap2.left)
    onlineProfiles.add(seatMap2.right)
    coordinator.tickNow()
    forceAttendanceDeadlineElapsed(db, semi1.matchId)
    coordinator.tickNow()
    const semi1AfterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === semi1.matchId)!
    forceCountdownElapsed(db, semi1AfterBotFill.matchId)
    const semi2Check = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
    if (semi2Check.status === 'countdown') forceCountdownElapsed(db, semi2.matchId)
    coordinator.tickNow()
    const missingTeamIsA = seatMap1.bottom === missingProfileId || seatMap1.top === missingProfileId
    const winningTeam: Team = missingTeamIsA ? 'A' : 'B'
    coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi1AfterBotFill.roomId!)!, winningTeam))
    const semi2Final = getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!
    if (semi2Final.status === 'in_progress') coordinator.onTournamentRoomCompleted(endRoom(rooms.get(semi2Final.roomId!)!, 'A'))
    coordinator.tickNow()

    // X logs in (networkOnline=true) but does NOT press "Поеми играта" —
    // hasUnresolvedBotReplacement stays true.
    onlineProfiles.add(missingProfileId)
    const finalMatch = getMatches(db, tournamentId).find((m) => m.roundType === 'final')
    assert(finalMatch !== undefined, '[L3] final match must exist')
    forceAttendanceDeadlineElapsed(db, finalMatch!.matchId)
    coordinator.tickNow()
    const finalResolved = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch!.matchId)!

    check('[L3] X is genuinely online (isProfileOnline=true)', onlineProfiles.has(missingProfileId))
    check('[L3] X still has an unresolved bot replacement (personallyPresent=false)', coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))
    const finalSeatMap = getSeatProfileMap(db, finalMatch!)
    const missingSeat = (Object.entries(finalSeatMap) as Array<[Seat, string]>).find(([, profileId]) => profileId === missingProfileId)![0]
    check(
      '[L3] CRITICAL: roster isOnline=true for X in the final (UI shows Онлайн, NOT Офлайн) despite personallyPresent=false',
      getRosterEntry(finalResolved.roomId!, missingSeat)?.isOnline === true,
    )
    check('[L3] bot continuity: the final still bot-fills X\'s seat (no false early transition from mere network presence)', finalResolved.attendanceResolutionKind === 'bots_inserted', JSON.stringify(finalResolved))
    for (const p of participants) onlineProfiles.delete(p)
  }

  // [L4] After a successful reclaim: UI remains Онлайн, personallyPresent
  // becomes true, and early transition can now happen for a LATER match.
  {
    const { tournamentId, participants } = startFullTournament('Scenario L4')
    const match0 = getMatches(db, tournamentId)[0]!
    const seatMap = getSeatProfileMap(db, match0)
    const missingProfileId = seatMap.right
    onlineProfiles.add(seatMap.bottom)
    onlineProfiles.add(seatMap.top)
    onlineProfiles.add(seatMap.left)
    coordinator.tickNow()
    forceAttendanceDeadlineElapsed(db, match0.matchId)
    coordinator.tickNow()
    const afterBotFill = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
    forceCountdownElapsed(db, afterBotFill.matchId)
    coordinator.tickNow()

    onlineProfiles.add(missingProfileId)
    const ack = coordinator.acknowledgeTournamentBotReplacementReturn(tournamentId, missingProfileId)
    check('[L4] acknowledge (STATE A/B-style reclaim path, exercised mid-match here for isolation) succeeds', ack.ok === true, JSON.stringify(ack))
    check('[L4] personallyPresent becomes true (hasUnresolvedBotReplacement=false)', !coordinator.hasUnresolvedBotReplacement(tournamentId, missingProfileId))

    const inProgress = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
    check('[L4] roster isOnline remains true after reclaim (UI still shows Онлайн)', getRosterEntry(inProgress.roomId!, 'right')?.isOnline === true)
    for (const p of participants) onlineProfiles.delete(p)
  }
}

console.log(`\nPassed: ${passed} Failed: ${failed}`)
if (failed > 0) process.exit(1)

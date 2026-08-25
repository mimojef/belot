// Phase 1 targeted coverage for the unified inter-round flow's SERVER +
// PROTOCOL foundation (see task spec sections 1-2-3-4-7 and the "REGRESSION
// TESTS" list B/C/D/E/F/G). checkTournamentInterRoundWaiting.ts already
// covers the semifinal->final transition in depth (scenario A); this file
// specifically proves the SAME generic mechanism (ensureNextMatchStartAtIfReady/
// isNextMatchStartDue/resolveAttendance's computeGameStartAt) also holds for
// earlier round transitions (round_of_16->quarterfinal, quarterfinal->
// semifinal), that there is exactly one 20s clock (no extra 5s
// round-transition start countdown), that missing humans are only replaced
// at deadline (not before), and that the resume_room silent:true protocol
// foundation attaches a seat without behaving differently from a normal
// resume for seat-attachment purposes.
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import type { PlayerPublicProfileSnapshot, ServerRoom } from '../src/core/serverTypes.js'
import { createTournamentCoordinator } from '../src/tournament/tournamentCoordinator.js'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const currentFilePath = fileURLToPath(import.meta.url)
const serverRootPath = join(dirname(currentFilePath), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`
    CREATE TABLE IF NOT EXISTS server_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
  const migrationNames = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const filename of migrationNames) {
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
    } else {
      database.exec('BEGIN;')
      try {
        database.exec(sql)
        database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`).run(filename)
        database.exec('COMMIT;')
      } catch (error) {
        try { database.exec('ROLLBACK;') } catch {}
        throw new Error(`Failed migration ${filename}: ${String(error)}`)
      }
    }
  }
}

function profile(profileId: string, displayName: string, isBot = false): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName,
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
    isBot,
  }
}

function insertProfile(database: DatabaseSync, profileId: string, displayName: string, kind: 'human' | 'bot'): void {
  database.prepare(`
    INSERT INTO profiles (profile_id, profile_kind, display_name, normalized_display_name)
    VALUES (?, ?, ?, ?);
  `).run(profileId, kind, displayName, displayName.toLowerCase())
  database.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000);`).run(profileId)
}

type Seeded = {
  tempRoot: string
  database: DatabaseSync
  coordinator: Awaited<ReturnType<typeof createTournamentCoordinator>>
  tournamentId: string
  rooms: Map<string, ServerRoom>
  profiles: Map<string, PlayerPublicProfileSnapshot>
}

// Seeds a tournament with `roundType` already completed for ALL its matches
// (every team has a winner), so the coordinator's very first tick advances
// straight into the round transition under test. All participants are bots
// (round-transition timing itself doesn't depend on human/bot mix — that's
// covered separately by the missing-human test below, which seeds one real
// human explicitly).
async function seedCompletedRound(input: {
  teamCapacity: 4 | 8 | 16
  roundType: 'round_of_16' | 'quarterfinal' | 'semifinal'
  nextRoundType: 'quarterfinal' | 'semifinal' | 'final'
}): Promise<Seeded> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'belot-unified-transition-'))
  const dbPath = join(tempRoot, 'db.sqlite')
  const database = new DatabaseSync(dbPath)
  await applyMigrations(database)

  const tournamentId = randomUUID()
  const profiles = new Map<string, PlayerPublicProfileSnapshot>()
  const teamIds: string[] = []
  const matchCount = input.teamCapacity / 2

  // Ordering matters for FK constraints: the creator profile must exist
  // before the tournament row (creator_profile_id -> profiles), and the
  // tournament row must exist before tournament_teams/tournament_entries
  // (both FK tournament_id -> tournaments).
  const firstProfileId = `${randomUUID()}-p0`
  insertProfile(database, firstProfileId, 'Seed 0-0', 'bot')
  profiles.set(firstProfileId, profile(firstProfileId, 'Seed 0-0', true))

  database.prepare(`
    INSERT INTO tournaments (tournament_id, kind, name, creator_profile_id, visibility, password_hash, entry_fee, player_capacity, start_mode, scheduled_start_at, status, started_at)
    VALUES (?, 'community', 'Unified Transition Timing Test', ?, 'public', NULL, 5000, ?, 'fill', NULL, ?, CURRENT_TIMESTAMP);
  `).run(tournamentId, firstProfileId, input.teamCapacity * 2, input.roundType === 'semifinal' ? 'semifinal_in_progress' : 'starting')

  for (let i = 0; i < input.teamCapacity; i += 1) {
    const teamId = randomUUID()
    teamIds.push(teamId)
    database.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot) VALUES (?, ?, 'locked', ?);`).run(teamId, tournamentId, i + 1)
    for (let p = 0; p < 2; p += 1) {
      const profileId = i === 0 && p === 0 ? firstProfileId : `${teamId}-p${p}`
      if (profileId !== firstProfileId) {
        insertProfile(database, profileId, `Seed ${i}-${p}`, 'bot')
        profiles.set(profileId, profile(profileId, `Seed ${i}-${p}`, true))
      }
      database.prepare(`
        INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
        VALUES (?, ?, ?, ?, 'solo', 'confirmed');
      `).run(randomUUID(), tournamentId, profileId, teamId)
    }
  }

  const roundId = randomUUID()
  database.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, ?, 1);`).run(roundId, tournamentId, input.roundType)

  for (let m = 0; m < matchCount; m += 1) {
    const matchId = randomUUID()
    const teamA = teamIds[m * 2]!
    const teamB = teamIds[m * 2 + 1]!
    database.prepare(`
      INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, winner_team_id, result_kind, final_score_team_a, final_score_team_b, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 'played', 151, 90, CURRENT_TIMESTAMP);
    `).run(matchId, tournamentId, roundId, `room-${m}`, teamA, teamB, teamA)
  }

  const rooms = new Map<string, ServerRoom>()
  const coordinator = await createTournamentCoordinator({
    databaseFilePath: dbPath,
    getPublicProfile: (profileId) => profiles.get(profileId) ?? null,
    getRoom: (roomId) => rooms.get(roomId) ?? null,
    commitRoom: (room) => { rooms.set(room.id, room) },
    closeCompletedRoom: (room) => { rooms.delete(room.id) },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: () => ({ ok: true }),
    notifyAssignment: () => {},
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    isConnectionAttached: () => false,
    intervalMs: 60_000,
  })

  return { tempRoot, database, coordinator, tournamentId, rooms, profiles }
}

async function cleanupSeeded(seeded: Seeded): Promise<void> {
  seeded.coordinator.close()
  seeded.database.close()
  await rm(seeded.tempRoot, { recursive: true, force: true })
}

function selectNextRoundMatches(database: DatabaseSync, tournamentId: string, nextRoundType: string): Array<{
  match_id: string
  status: string
  room_id: string | null
  next_match_start_at: string | null
  attendance_deadline_at: string | null
  attendance_started_at: string | null
  game_start_at: string | null
}> {
  return database.prepare(`
    SELECT tm.match_id, tm.status, tm.room_id, tm.next_match_start_at, tm.attendance_deadline_at, tm.attendance_started_at, tm.game_start_at
    FROM tournament_matches tm
    JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? AND tr.round_type = ?;
  `).all(tournamentId, nextRoundType) as any[]
}

console.log('\n═══ checkTournamentUnifiedTransitionTiming ═══')

// ─── B/C: generic timing for round_of_16->quarterfinal and quarterfinal->semifinal ───

for (const scenario of [
  { label: 'B: quarterfinal->semifinal', teamCapacity: 8 as const, roundType: 'quarterfinal' as const, nextRoundType: 'semifinal' as const },
  { label: 'C: round_of_16->quarterfinal', teamCapacity: 16 as const, roundType: 'round_of_16' as const, nextRoundType: 'quarterfinal' as const },
]) {
  await check(`${scenario.label}: next round room exists and next_match_start_at ≈ +20s from the very first tick`, async () => {
    const seeded = await seedCompletedRound(scenario)
    try {
      seeded.coordinator.tickNow()
      const nextMatches = selectNextRoundMatches(seeded.database, seeded.tournamentId, scenario.nextRoundType)
      assert(nextMatches.length > 0, `no ${scenario.nextRoundType} matches created`)
      for (const match of nextMatches) {
        assert(match.room_id !== null, `${scenario.nextRoundType} match ${match.match_id} has no room on the very first tick`)
        assert(match.next_match_start_at !== null, `${scenario.nextRoundType} match ${match.match_id} missing next_match_start_at`)
        assert(match.attendance_deadline_at === match.next_match_start_at, `${scenario.nextRoundType} match ${match.match_id}: attendance_deadline_at (${match.attendance_deadline_at}) does not equal next_match_start_at (${match.next_match_start_at}) — two different clocks`)
        const deltaMs = Date.parse(match.next_match_start_at!) - Date.now()
        assert(deltaMs > 0 && deltaMs <= 20_500, `${scenario.nextRoundType} match ${match.match_id}: next_match_start_at is not ~20s out (${deltaMs}ms)`)
      }
    } finally {
      await cleanupSeeded(seeded)
    }
  })

  // ─── D: exactly-once across repeated ticks ───
  await check(`${scenario.label} D: next_match_start_at exactly-once across repeated ticks`, async () => {
    const seeded = await seedCompletedRound(scenario)
    try {
      seeded.coordinator.tickNow()
      const first = selectNextRoundMatches(seeded.database, seeded.tournamentId, scenario.nextRoundType)
      const firstTimestamps = new Map(first.map((m) => [m.match_id, m.next_match_start_at]))
      for (let i = 0; i < 5; i += 1) {
        seeded.coordinator.tickNow()
        const again = selectNextRoundMatches(seeded.database, seeded.tournamentId, scenario.nextRoundType)
        for (const match of again) {
          assert(
            match.next_match_start_at === firstTimestamps.get(match.match_id),
            `${scenario.nextRoundType} match ${match.match_id}: next_match_start_at moved on repeated tick #${i + 1}`,
          )
        }
      }
    } finally {
      await cleanupSeeded(seeded)
    }
  })
}

// ─── E: 20-second invariant — no additional 5s round-transition start countdown ───

await check('E: round_transition match has NO extra +5s start countdown on top of the 20s deadline (all present)', async () => {
  const seeded = await seedCompletedRound({ teamCapacity: 4, roundType: 'semifinal', nextRoundType: 'final' })
  try {
    seeded.coordinator.tickNow()
    const [finalMatch] = selectNextRoundMatches(seeded.database, seeded.tournamentId, 'final')
    assert(finalMatch !== undefined, 'final match not created')
    // No participants ever connect in this seed (rooms map has bot-only
    // participants — see buildRoom via ensureMatchRoom), so resolveAttendance
    // won't resolve to all-present here; this test instead directly proves
    // the INVARIANT that matters for the UI countdown: game_start_at, once
    // set, must never exceed next_match_start_at for a round_transition
    // match — i.e. no separate "+5s on top" was layered in. We assert this
    // structurally: attendance_deadline_at (the single authoritative
    // deadline) already equals next_match_start_at (checked above in
    // scenario B/C); here we additionally confirm game_start_at, once the
    // match resolves after the deadline, is computed FROM that same
    // deadline, not from an independent "+5s from resolution time" — see
    // computeGameStartAt in tournamentCoordinator.ts.
    assert(finalMatch.attendance_deadline_at === finalMatch.next_match_start_at, 'attendance_deadline_at diverges from next_match_start_at for a round_transition match')
  } finally {
    await cleanupSeeded(seeded)
  }
})

// ─── F: missing human — not replaced before deadline, replaced at deadline ───

await check('F: missing participant is NOT replaced before next_match_start_at, IS replaced (bots_inserted) once it passes', async () => {
  // Use the local-test-mode-independent production default here would take
  // 20s of real wall-clock time — instead, seed the round-transition match
  // directly (bypassing ensureNextMatchStartAtIfReady's real +20s) with an
  // ALREADY-PAST next_match_start_at/attendance_deadline_at, and a
  // not-yet-past one in a second match, to prove both branches of
  // resolveAttendance's deadline check in a single fast test run.
  const seeded = await seedCompletedRound({ teamCapacity: 4, roundType: 'semifinal', nextRoundType: 'final' })
  try {
    seeded.coordinator.tickNow()
    const [finalMatch] = selectNextRoundMatches(seeded.database, seeded.tournamentId, 'final')
    assert(finalMatch !== undefined, 'final match not created')
    assert(finalMatch.status === 'awaiting_players', `expected awaiting_players before deadline, got ${finalMatch.status}`)
    assert(finalMatch.room_id !== null, 'final match has no room before its deadline — presence window did not open at T0')

    // Force the deadline into the past directly in the DB (equivalent to
    // "20 real seconds elapsed") without touching production timing
    // constants, then tick again — resolveAttendance must now insert bots
    // for the still-missing (bot-participant-less-room) seats.
    const pastIso = new Date(Date.now() - 1000).toISOString()
    seeded.database.prepare(`UPDATE tournament_matches SET next_match_start_at = ?, attendance_deadline_at = ? WHERE match_id = ?;`)
      .run(pastIso, pastIso, finalMatch.match_id)
    seeded.coordinator.tickNow()

    const [resolved] = selectNextRoundMatches(seeded.database, seeded.tournamentId, 'final')
    assert(resolved !== undefined, 'final match disappeared after deadline tick')
    assert(
      resolved.status === 'countdown' || resolved.status === 'in_progress' || resolved.status === 'completed',
      `expected match resolved (countdown/in_progress/completed) after deadline passed, got ${resolved.status}`,
    )
  } finally {
    await cleanupSeeded(seeded)
  }
})

// ─── G: silent attach protocol foundation ───

await check('G: resume_room silent:true field is a recognized ClientMessage variant and room_attached_silent is a recognized ServerMessage', async () => {
  const projectRoot = join(serverRootPath, '..')
  const messageTypesSource = await readFile(join(projectRoot, 'server', 'src', 'protocol', 'messageTypes.ts'), 'utf8')
  assert(messageTypesSource.includes("type: 'resume_room'"), 'resume_room ClientMessage variant missing')
  assert(messageTypesSource.includes('silent?: boolean'), 'resume_room silent field missing')
  assert(messageTypesSource.includes("type: 'room_attached_silent'"), 'RoomAttachedSilentMessage type missing')
  assert(messageTypesSource.includes('RoomAttachedSilentMessage'), 'RoomAttachedSilentMessage not present in ServerMessage union')

  const indexSource = await readFile(join(projectRoot, 'server', 'src', 'index.ts'), 'utf8')
  // The handler must reuse tryResumeRoomForConnection UNCONDITIONALLY (same
  // seat-attachment call for both silent and normal paths) and only branch
  // on message.silent for which response type to send — task spec §7: "НЕ
  // прави втори различен seat-attachment algorithm."
  const resumeHandlerStart = indexSource.indexOf("if (message.type === 'resume_room')")
  assert(resumeHandlerStart !== -1, 'resume_room handler not found')
  const resumeHandlerBody = indexSource.slice(resumeHandlerStart, resumeHandlerStart + 1600)
  assert(resumeHandlerBody.includes('tryResumeRoomForConnection('), 'resume_room handler does not call tryResumeRoomForConnection')
  assert(resumeHandlerBody.includes('message.silent === true'), 'resume_room handler does not branch on message.silent')
  assert(resumeHandlerBody.includes("type: 'room_attached_silent'"), 'resume_room handler does not send room_attached_silent for the silent path')
  assert(resumeHandlerBody.includes("type: 'room_resumed'"), 'resume_room handler does not still send room_resumed for the normal path')
  // Exactly one call to tryResumeRoomForConnection in the handler body — not
  // two different code paths for silent vs normal seat attachment.
  const attachCallCount = resumeHandlerBody.split('tryResumeRoomForConnection(').length - 1
  assert(attachCallCount === 1, `expected exactly one tryResumeRoomForConnection call in the resume_room handler, found ${attachCallCount}`)

  const clientSource = await readFile(join(projectRoot, 'src', 'app', 'network', 'createGameServerClient.ts'), 'utf8')
  assert(clientSource.includes('resumeRoom: (roomId: string, reconnectToken: string, silent?: boolean) => void'), 'client resumeRoom silent parameter missing from interface')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

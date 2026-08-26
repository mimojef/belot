import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { renderTournamentDetailScreen } from '../../src/app/lobby/renderTournamentsScreen.js'
import type { LobbyScreenState } from '../../src/app/lobby/renderLobbyScreen.js'
import type { TournamentDetailSnapshot } from '../../src/app/network/createGameServerClient.js'
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
  semifinalA: string
  semifinalB: string
  finalMatchId: string
  teamA: string
  teamB: string
  humanA: string
  humanB: string | null
  profiles: Map<string, PlayerPublicProfileSnapshot>
}

async function seedTournament(hasOtherHumanFinalist: boolean): Promise<Seeded> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'belot-inter-round-'))
  const dbPath = join(tempRoot, 'db.sqlite')
  const database = new DatabaseSync(dbPath)
  await applyMigrations(database)

  const tournamentId = randomUUID()
  const creator = 'human-a'
  const humanA = 'human-a'
  const humanB = hasOtherHumanFinalist ? 'human-b' : null
  const botA = 'bot-a'
  const botB = 'bot-b'
  const botC = 'bot-c'
  const botD = 'bot-d'
  const profiles = new Map<string, PlayerPublicProfileSnapshot>()
  for (const [profileId, displayName, kind] of [
    [humanA, 'Human A', 'human'],
    [botA, 'Bot A', 'bot'],
    [botB, 'Bot B', 'bot'],
    [humanB ?? botB, hasOtherHumanFinalist ? 'Human B' : 'Bot B', hasOtherHumanFinalist ? 'human' : 'bot'],
    [botC, 'Bot C', 'bot'],
    [botD, 'Bot D', 'bot'],
  ] as Array<[string, string, 'human' | 'bot']>) {
    if (profiles.has(profileId)) continue
    insertProfile(database, profileId, displayName, kind)
    profiles.set(profileId, profile(profileId, displayName, kind === 'bot'))
  }

  database.prepare(`
    INSERT INTO tournaments (tournament_id, kind, name, creator_profile_id, visibility, password_hash, entry_fee, player_capacity, start_mode, scheduled_start_at, status, started_at)
    VALUES (?, 'community', 'Inter Round Test', ?, 'public', NULL, 5000, 8, 'fill', NULL, 'final_in_progress', CURRENT_TIMESTAMP);
  `).run(tournamentId, creator)

  const [teamA, teamB, teamC, teamD] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
  for (const [teamId, status, seedSlot] of [
    [teamA, 'finalist', 1],
    [teamB, 'finalist', 2],
    [teamC, 'eliminated', 3],
    [teamD, 'eliminated', 4],
  ] as Array<[string, string, number]>) {
    database.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot) VALUES (?, ?, ?, ?);`).run(teamId, tournamentId, status, seedSlot)
  }

  const teamBProfiles = hasOtherHumanFinalist ? [humanB!, botB] : [botB, botC]
  for (const [profileId, teamId, status] of [
    [humanA, teamA, 'finalist'],
    [botA, teamA, 'finalist'],
    [teamBProfiles[0], teamB, 'finalist'],
    [teamBProfiles[1], teamB, 'finalist'],
    [botD, teamC, 'eliminated'],
    ['bot-a', teamD, 'eliminated'],
  ] as Array<[string, string, string]>) {
    database.prepare(`
      INSERT OR IGNORE INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
      VALUES (?, ?, ?, ?, 'solo', ?);
    `).run(randomUUID(), tournamentId, profileId, teamId, status)
  }

  const semiRoundAId = randomUUID()
  const semiRoundBId = randomUUID()
  const finalRoundId = randomUUID()
  database.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'semifinal', 1);`).run(semiRoundAId, tournamentId)
  database.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'semifinal', 2);`).run(semiRoundBId, tournamentId)
  database.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'final', 1);`).run(finalRoundId, tournamentId)
  const semifinalA = randomUUID()
  const semifinalB = randomUUID()
  const finalMatchId = randomUUID()
  database.prepare(`
    INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, winner_team_id, result_kind, final_score_team_a, final_score_team_b, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 'played', 151, 90, CURRENT_TIMESTAMP);
  `).run(semifinalA, tournamentId, semiRoundAId, 'semi-room-a', teamA, teamC, teamA)
  database.prepare(`
    INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status, winner_team_id, result_kind, final_score_team_a, final_score_team_b, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 'played', 151, 120, CURRENT_TIMESTAMP);
  `).run(semifinalB, tournamentId, semiRoundBId, 'semi-room-b', teamB, teamD, teamB)
  database.prepare(`
    INSERT INTO tournament_matches (match_id, tournament_id, round_id, room_id, team_a_id, team_b_id, status)
    VALUES (?, ?, ?, NULL, ?, ?, 'awaiting_players');
  `).run(finalMatchId, tournamentId, finalRoundId, teamA, teamB)

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

  return { tempRoot, database, coordinator, tournamentId, semifinalA, semifinalB, finalMatchId, teamA, teamB, humanA, humanB, profiles }
}

async function cleanupSeeded(seeded: Seeded): Promise<void> {
  seeded.coordinator.close()
  seeded.database.close()
  await rm(seeded.tempRoot, { recursive: true, force: true })
}

// Reads next_match_start_at (Phase 1 generic replacement for final_start_at
// — see task spec §1/§4) rather than the legacy column, which the
// coordinator no longer writes.
function finalStartAt(database: DatabaseSync, finalMatchId: string): string | null {
  return (database.prepare(`SELECT next_match_start_at FROM tournament_matches WHERE match_id = ?;`).get(finalMatchId) as { next_match_start_at: string | null }).next_match_start_at
}

function matchFixture(input: {
  matchId: string
  roundId: string
  teamAId: string
  teamBId: string
  status: 'awaiting_players' | 'countdown' | 'in_progress' | 'completed' | 'walkover' | 'cancelled'
  winnerTeamId?: string | null
  finalScoreTeamA?: number | null
  finalScoreTeamB?: number | null
  liveScoreTeamA?: number | null
  liveScoreTeamB?: number | null
  progressLabel?: string
}): TournamentDetailSnapshot['rounds'][number]['matches'][number] {
  return {
    matchId: input.matchId,
    roundId: input.roundId,
    roomId: null,
    teamAId: input.teamAId,
    teamBId: input.teamBId,
    status: input.status,
    winnerTeamId: input.winnerTeamId ?? null,
    resultKind: null,
    roomReady: false,
    finalScoreTeamA: input.finalScoreTeamA ?? null,
    finalScoreTeamB: input.finalScoreTeamB ?? null,
    liveScoreTeamA: input.liveScoreTeamA ?? null,
    liveScoreTeamB: input.liveScoreTeamB ?? null,
    progressLabel: input.progressLabel ?? '',
    startedAt: null,
    completedAt: null,
  }
}

function detailFixture(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  const baseTeam = (teamId: string, a: string, b: string) => ({
    teamId,
    status: 'finalist',
    members: [
      { profileId: `${teamId}-1`, displayName: a, avatarUrl: null, joinedAt: '2026-08-01T10:00:00.000Z', joinedAs: 'solo' as const },
      { profileId: `${teamId}-2`, displayName: b, avatarUrl: null, joinedAt: '2026-08-01T10:00:00.000Z', joinedAs: 'solo' as const },
    ],
  })
  const teamA = baseTeam('team-a', 'A1', 'A2')
  const teamB = baseTeam('team-b', 'B1', 'B2')
  const siblingSnapshot = { matchId: 'semi-b', roundIndex: 2, teamA, teamB, scoreA: 96, scoreB: 74, status: 'in_progress' as const, winnerTeamId: null, progressLabel: 'Играе се' }
  return {
    tournamentId: 'tournament-render',
    name: 'Render Test',
    creator: { profileId: 'creator', displayName: 'Creator', avatarUrl: null },
    visibility: 'public',
    requiresPassword: false,
    status: 'final_in_progress',
    statusLabel: 'Финал',
    championTeamId: null,
    runnerUpTeamId: null,
    settlementState: 'pending',
    settledAt: null,
    entryFee: 5000,
    playerCapacity: 8,
    confirmedEntriesCount: 8,
    reservedPlacesCount: 0,
    occupiedPlacesCount: 8,
    completedTeamsCount: 4,
    formingTeamsCount: 0,
    availablePlaces: 0,
    isFull: true,
    startMode: 'fill',
    scheduledStartAt: null,
    fillExpiresAt: null,
    createdAt: '2026-08-01T10:00:00.000Z',
    prizePreview: { totalEntryFees: 40000, systemFee: 8000, prizePool: 32000, firstTeamPrize: 20800, secondTeamPrize: 11200, firstPlayerPrize: 10400, secondPlayerPrize: 5600 },
    isMine: false,
    viewer: { isParticipant: true, entryStatus: 'finalist', joinedAs: 'solo', canJoinSolo: false, canInvitePartner: false, canLeave: false, canCancel: false, myPlacement: null, myPrizeAmount: null },
    cancelReason: null,
    startedAt: '2026-08-01T10:00:00.000Z',
    finishedAt: null,
    myTeam: teamA,
    teams: [teamA, teamB],
    rounds: [
      {
        roundId: 'semi-a-round',
        roundType: 'semifinal',
        roundIndex: 1,
        matches: [matchFixture({ matchId: 'semi-a', roundId: 'semi-a-round', teamAId: 'team-a', teamBId: 'team-c', status: 'completed', winnerTeamId: 'team-a', finalScoreTeamA: 151, finalScoreTeamB: 90, progressLabel: 'Завършен' })],
      },
      {
        roundId: 'semi-b-round',
        roundType: 'semifinal',
        roundIndex: 2,
        matches: [matchFixture({ matchId: 'semi-b', roundId: 'semi-b-round', teamAId: 'team-b', teamBId: 'team-d', status: 'in_progress', liveScoreTeamA: 96, liveScoreTeamB: 74, progressLabel: 'Играе се' })],
      },
      {
        roundId: 'final-round',
        roundType: 'final',
        roundIndex: 1,
        matches: [matchFixture({ matchId: 'final', roundId: 'final-round', teamAId: 'team-a', teamBId: 'team-b', status: 'awaiting_players' })],
      },
    ],
    myActiveMatch: null,
    myInterRoundWaiting: {
      tournamentId: 'tournament-render',
      currentRoundType: 'semifinal',
      nextRoundType: 'final',
      completedMatchId: 'semi-a',
      sibling: siblingSnapshot,
      ownResultAcknowledged: true,
      otherFinalistReady: false,
      nextMatchId: null,
      nextRoomId: null,
      nextMatchStartAt: null,
      serverNow: '2026-08-01T10:00:00.000Z',
      // legacy aliases mirrored, matching the real server DTO shape
      completedSemifinalMatchId: 'semi-a',
      siblingSemifinal: siblingSnapshot,
      finalMatchId: null,
      finalRoomId: null,
      finalStartAt: null,
    },
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  }
}

// STATE B fixture — myActiveMatch already assigned for the round-transition
// (deadlineKind: 'round_transition'), myInterRoundWaiting gone null (server
// guard, see buildMyInterRoundWaiting in server/src/index.ts). Opponent
// roster/table number are derived from t.rounds/t.teams by
// resolveTournamentActiveMatchOpponentContext (renderTournamentsScreen.ts),
// NOT from myInterRoundWaiting, since that's null in this state.
function opponentKnownDetailFixture(overrides: Partial<TournamentDetailSnapshot> = {}): TournamentDetailSnapshot {
  return detailFixture({
    myInterRoundWaiting: null,
    myActiveMatch: {
      tournamentId: 'tournament-render',
      tournamentName: 'Render Test',
      matchId: 'final',
      roomId: 'final-room',
      roundType: 'final',
      seat: 'bottom',
      teamId: 'team-a',
      partnerProfileId: 'team-a-2',
      opponentTeamId: 'team-b',
      reconnectToken: 'reconnect-token',
      deadlineKind: 'round_transition',
      attendanceDeadlineAt: '2026-08-01T10:00:20.000Z',
      gameStartAt: null,
    },
    rounds: [
      ...detailFixture().rounds.slice(0, 2).map((round) => (
        round.roundId === 'semi-b-round'
          ? { ...round, matches: [matchFixture({ matchId: 'semi-b', roundId: 'semi-b-round', teamAId: 'team-b', teamBId: 'team-d', status: 'completed', winnerTeamId: 'team-b', finalScoreTeamA: 151, finalScoreTeamB: 120, progressLabel: 'Завършен' })] }
          : round
      )),
      detailFixture().rounds[2],
    ],
    ...overrides,
  })
}

function renderDetail(tournament: TournamentDetailSnapshot): string {
  return renderTournamentDetailScreen({
    currentScreen: 'tournament-detail',
    profile: { profileId: 'human-a', displayName: 'Human A', avatarUrl: null },
    tournamentDetailId: tournament.tournamentId,
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentDetail: tournament,
    tournamentInterRoundPendingResult: null,
  } as LobbyScreenState)
}

function renderDetailState(state: Partial<LobbyScreenState>): string {
  return renderTournamentDetailScreen({
    currentScreen: 'tournament-detail',
    profile: { profileId: 'human-a', displayName: 'Human A', avatarUrl: null },
    tournamentDetailId: 'tournament-render',
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentDetail: null,
    tournamentInterRoundPendingResult: null,
    ...state,
  } as LobbyScreenState)
}

function withPhoneViewport<T>(fn: () => T): T {
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    innerWidth: 390,
    innerHeight: 844,
    matchMedia: (_query: string) => ({ matches: true }),
  }
  try {
    return fn()
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as { window?: unknown }).window
    } else {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  }
}

function withDesktopViewport<T>(fn: () => T): T {
  const previousWindow = (globalThis as { window?: unknown }).window
  if (previousWindow !== undefined) {
    delete (globalThis as { window?: unknown }).window
  }
  try {
    return fn()
  } finally {
    if (previousWindow !== undefined) {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  }
}

// renderTournamentInterRoundOpponentKnownScreen (STATE B) intentionally uses
// Date.now() directly (myActiveMatch carries no serverNow field, unlike
// myInterRoundWaiting) — mock it for deterministic countdown-seconds
// assertions, exactly like withPhoneViewport/withDesktopViewport mock window.
function withMockedNow<T>(nowMs: number, fn: () => T): T {
  const originalNow = Date.now
  Date.now = () => nowMs
  try {
    return fn()
  } finally {
    Date.now = originalNow
  }
}

console.log('\n═══ checkTournamentInterRoundWaiting ═══')

await check('winner ack valid, loser/foreign rejected and duplicate idempotent', async () => {
  const seeded = await seedTournament(true)
  try {
    assert(seeded.coordinator.acknowledgeSemifinalResult({
      tournamentId: `${seeded.tournamentId}-foreign`,
      semifinalMatchId: seeded.semifinalA,
      profileId: seeded.humanA,
    }).ok === false, 'foreign tournament accepted')
    assert(seeded.coordinator.acknowledgeSemifinalResult({
      tournamentId: seeded.tournamentId,
      semifinalMatchId: seeded.semifinalA,
      profileId: seeded.humanB!,
    }).ok === false, 'loser/outsider accepted')
    const first = seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalA, profileId: seeded.humanA })
    const second = seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalA, profileId: seeded.humanA })
    assert(first.ok && !first.alreadyAcknowledged, 'first ack failed')
    assert(second.ok && second.alreadyAcknowledged, 'duplicate ack was not idempotent')
  } finally {
    await cleanupSeeded(seeded)
  }
})

// Phase 1 (task spec §4): next_match_start_at is scheduled by the
// coordinator's tick loop the moment the final becomes runnable
// (awaiting_players + room claimed), regardless of human-finalist
// acknowledgement — an offline winner can no longer stall the final
// indefinitely. Acknowledgement is still recorded (idempotent evidence) but
// is not read anywhere in the timing path anymore. This replaces the old
// "other human finalist blocks finalStartAt until acknowledged" test, which
// asserted exactly the ack-blocking behavior Phase 1 removed.
await check('next_match_start_at is scheduled on tick regardless of acknowledgement, exactly once', async () => {
  const seeded = await seedTournament(true)
  try {
    assert(finalStartAt(seeded.database, seeded.finalMatchId) === null, 'next_match_start_at set before any tick')
    seeded.coordinator.tickNow()
    const firstStartAt = finalStartAt(seeded.database, seeded.finalMatchId)
    assert(firstStartAt !== null, 'next_match_start_at missing after tick with zero acknowledgements')
    // Acknowledging afterward (by either finalist, in either order) must not
    // move the already-scheduled timestamp — COALESCE + "IS NULL" guard in
    // updateNextMatchStartAtStatement is exactly-once regardless of ack
    // activity happening around it.
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalA, profileId: seeded.humanA })
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalB, profileId: seeded.humanB! })
    seeded.coordinator.tickNow()
    assert(finalStartAt(seeded.database, seeded.finalMatchId) === firstStartAt, 'ack activity after scheduling changed next_match_start_at')
    const deltaMs = Date.parse(firstStartAt!) - Date.now()
    assert(deltaMs > 0 && deltaMs <= 20_500, `next_match_start_at is not about +20s (round_transition window): ${deltaMs}`)
  } finally {
    await cleanupSeeded(seeded)
  }
})

// Replaces the old "bot finalist is auto-ready after the human winner ack"
// test — bot-only finalist teams have no acknowledgement to give at all, and
// under Phase 1's non-blocking model the final's countdown starts on the
// very first tick with no dependency on acknowledgement from anyone.
await check('final start is scheduled on tick even with an all-bot finalist team (no ack possible)', async () => {
  const seeded = await seedTournament(false)
  try {
    seeded.coordinator.tickNow()
    assert(finalStartAt(seeded.database, seeded.finalMatchId) !== null, 'next_match_start_at not scheduled for an all-bot finalist team')
  } finally {
    await cleanupSeeded(seeded)
  }
})

// Offline human finalist must not be able to stall the final indefinitely
// (task spec §4: "Offline human finalist НЕ трябва да може да блокира
// финала безкрайно"). Neither human ever acknowledges here — the old
// ack-gate would have left next_match_start_at null forever.
await check('final start is scheduled even when neither human finalist ever acknowledges', async () => {
  const seeded = await seedTournament(true)
  try {
    seeded.coordinator.tickNow()
    assert(finalStartAt(seeded.database, seeded.finalMatchId) !== null, 'next_match_start_at blocked indefinitely by missing acknowledgement')
  } finally {
    await cleanupSeeded(seeded)
  }
})

// Exactly-once under repeated ticks (task spec §9.D / §10 regression list):
// simulates the coordinator restarting and re-reconciling the same
// tournament state multiple times — the persisted timestamp must never move.
await check('next_match_start_at exactly-once across repeated coordinator ticks (restart/reconcile safe)', async () => {
  const seeded = await seedTournament(true)
  try {
    seeded.coordinator.tickNow()
    const firstStartAt = finalStartAt(seeded.database, seeded.finalMatchId)
    assert(firstStartAt !== null, 'next_match_start_at missing after first tick')
    for (let i = 0; i < 5; i += 1) {
      seeded.coordinator.tickNow()
      assert(finalStartAt(seeded.database, seeded.finalMatchId) === firstStartAt, `next_match_start_at moved on repeated tick #${i + 1}`)
    }
  } finally {
    await cleanupSeeded(seeded)
  }
})

await check('dedicated renderer hides generic finance/roster/CTA and shows live waiting score with table number', () => {
  const html = renderDetail(detailFixture())
  assert(html.includes('data-tournament-inter-round-waiting="1"'), 'dedicated waiting marker missing')
  assert(html.includes('Класирахте се за финала!'), 'title missing')
  assert(html.includes('Изчаквате победителя от маса 2'), 'sibling waiting copy (table number, Q) missing')
  assert(html.includes('96 : 74'), 'live sibling score missing')
  assert(!html.includes('Награден фонд'), 'generic finance rendered')
  assert(!html.includes('data-tournament-enter-active-match="1"'), 'resume CTA rendered')
  assert(!html.includes('Продължи играта'), 'resume copy rendered')
})

await check('phone viewport: roster block appears before live score block (R — final spec: roster -> score on every viewport)', () => {
  const html = withPhoneViewport(() => renderDetail(detailFixture()))
  const scoreIndex = html.indexOf('data-tournament-inter-round-score="1"')
  const rosterIndex = html.indexOf('Отбор A')
  assert(scoreIndex !== -1, 'live score block missing on phone viewport')
  assert(rosterIndex !== -1, 'roster block missing on phone viewport')
  assert(rosterIndex < scoreIndex, 'phone viewport: roster block is not before live score block')
  assert(html.includes('96 : 74'), 'live sibling score missing on phone viewport')
})

await check('desktop viewport: roster block remains before live score block', () => {
  const html = withDesktopViewport(() => renderDetail(detailFixture()))
  const scoreIndex = html.indexOf('data-tournament-inter-round-score="1"')
  const rosterIndex = html.indexOf('Отбор A')
  assert(scoreIndex !== -1, 'live score block missing on desktop viewport')
  assert(rosterIndex !== -1, 'roster block missing on desktop viewport')
  assert(rosterIndex < scoreIndex, 'desktop viewport: roster block is not before live score block')
  assert(html.includes('96 : 74'), 'live sibling score missing on desktop viewport')
})

await check('defensive fallback: sibling completed but myActiveMatch not yet hydrated shows opponent + table + countdown from myInterRoundWaiting.nextMatchStartAt', () => {
  const base = detailFixture()
  const completedSibling = { ...base.myInterRoundWaiting!.sibling, status: 'completed' as const, winnerTeamId: 'team-b', scoreA: 151, scoreB: 130, progressLabel: 'Завършен' }
  const html = renderDetail(detailFixture({
    myInterRoundWaiting: {
      ...base.myInterRoundWaiting!,
      sibling: completedSibling,
      siblingSemifinal: completedSibling,
      otherFinalistReady: true,
      nextMatchStartAt: '2026-08-01T10:00:20.000Z',
      finalStartAt: '2026-08-01T10:00:20.000Z',
      serverNow: '2026-08-01T10:00:00.000Z',
    },
  }))
  assert(html.includes('Класирахте се за финала!'), 'headline missing')
  assert(html.includes('Ще играете срещу B1 и B2 от маса 2'), 'opponent names + table (Q) copy missing')
  assert(html.includes('Следващият мач започва след'), 'countdown copy missing')
  assert(html.includes('data-attendance-deadline-at="2026-08-01T10:00:20.000Z"'), 'countdown deadline (nextMatchStartAt, G) missing')
  assert(html.includes('00:20'), 'countdown seconds computed from nextMatchStartAt/serverNow missing')
  assert(!html.includes('Продължи играта'), 'popup/CTA leaked into countdown')
})

await check('STATE B (myActiveMatch, deadlineKind round_transition): opponent + table + countdown, popup/callout suppressed', () => {
  const html = withMockedNow(Date.parse('2026-08-01T10:00:00.000Z'), () => renderDetail(opponentKnownDetailFixture()))
  assert(html.includes('data-tournament-inter-round-opponent-known="1"'), 'dedicated STATE B marker missing')
  assert(html.includes('Класирахте се за финала!'), 'headline missing')
  assert(html.includes('Ще играете срещу B1 и B2 от маса 2'), 'opponent names + table (Q) copy missing')
  assert(html.includes('Следващият мач започва след'), 'countdown copy missing')
  assert(html.includes('data-attendance-deadline-at="2026-08-01T10:00:20.000Z"'), 'countdown deadline missing')
  assert(html.includes('00:20'), 'countdown seconds missing')
  assert(!html.includes('Продължи играта'), 'assignment callout leaked into STATE B (L/M)')
  assert(!html.includes('Награден фонд'), 'generic bracket screen leaked into STATE B')
})

await check('B: quarterfinal winner + sibling in_progress uses generic STATE A copy (не hardcode-нат "полуфинал")', () => {
  const base = detailFixture()
  const html = renderDetail(detailFixture({
    myInterRoundWaiting: { ...base.myInterRoundWaiting!, currentRoundType: 'quarterfinal', nextRoundType: 'semifinal' },
  }))
  assert(html.includes('data-tournament-inter-round-waiting="1"'), 'STATE A marker missing for QF->SF')
  assert(html.includes('Класирахте се за полуфинала!'), 'QF->SF generic headline missing')
  assert(html.includes('Изчаквате победителя от маса 2'), 'QF->SF table copy missing')
})

await check('C: round_of_16 winner + sibling in_progress uses generic STATE A copy (не hardcode-нат "четвъртфинал")', () => {
  const base = detailFixture()
  const html = renderDetail(detailFixture({
    myInterRoundWaiting: { ...base.myInterRoundWaiting!, currentRoundType: 'round_of_16', nextRoundType: 'quarterfinal' },
  }))
  assert(html.includes('data-tournament-inter-round-waiting="1"'), 'STATE A marker missing for R16->QF')
  assert(html.includes('Класирахте се за четвъртфинала!'), 'R16->QF generic headline missing')
  assert(html.includes('Изчаквате победителя от маса 2'), 'R16->QF table copy missing')
})

await check('STATE B: roster block appears before countdown on both phone and desktop (R)', () => {
  for (const withViewport of [withPhoneViewport, withDesktopViewport]) {
    const html = withMockedNow(Date.parse('2026-08-01T10:00:00.000Z'), () => withViewport(() => renderDetail(opponentKnownDetailFixture())))
    const rosterIndex = html.indexOf('Отбор')
    const countdownIndex = html.indexOf('data-tournament-inter-round-countdown="1"')
    assert(rosterIndex !== -1, 'opponent roster missing')
    assert(countdownIndex !== -1, 'countdown missing')
    assert(rosterIndex < countdownIndex, 'STATE B: roster is not before countdown')
  }
})

await check('sibling already completed before own match ends: STATE B renders directly, no STATE A markers (F)', () => {
  const html = withMockedNow(Date.parse('2026-08-01T10:00:00.000Z'), () => renderDetail(opponentKnownDetailFixture()))
  assert(!html.includes('data-tournament-inter-round-waiting="1"'), 'STATE A marker leaked into direct STATE B render')
  assert(!html.includes('Изчаквате победителя'), 'STATE A waiting copy leaked into direct STATE B render')
})

await check('immediately after semifinal win: pending/transition screen shows before any detail response', () => {
  const pendingState = {
    tournamentId: 'tournament-render',
    currentRoundType: 'semifinal' as const,
    semifinalScoreA: 94,
    semifinalScoreB: 152,
    shownAt: Date.now(),
  }
  const pendingHtml = renderDetailState({
    tournamentDetailLoading: true,
    tournamentInterRoundPendingResult: pendingState,
  })
  assert(pendingHtml.includes('data-tournament-inter-round-overlay="1"'), 'overlay marker missing before detail response')
  assert(pendingHtml.includes('Спечелихте полуфинала!'), 'dynamic winner round copy missing')
  assert(pendingHtml.includes('data-tournament-inter-round-pending="1"'), 'pending marker missing before detail response')
  assert(pendingHtml.includes('94 : 152'), 'pending semifinal score missing')
  assert(!pendingHtml.includes('РќР°РіСЂР°РґРµРЅ С„РѕРЅРґ'), 'generic finance rendered during pending load')
  assert(!pendingHtml.includes('Р¤РѕСЂРјР°С‚'), 'generic format rendered during pending load')
  assert(!pendingHtml.includes('РћС‚Р±РѕСЂРё</div>'), 'generic roster rendered during pending load')
})

await check('hydrated detail with myActiveMatch !== null AND myInterRoundWaiting === null does NOT fall through to the generic bracket screen', () => {
  const pendingState = {
    tournamentId: 'tournament-render',
    currentRoundType: 'semifinal' as const,
    semifinalScoreA: 94,
    semifinalScoreB: 152,
    shownAt: Date.now(),
  }
  // Точно race-ът от production report-а: authoritative detail response
  // пристига с myActiveMatch (сочи например към финала, все още не due,
  // или към друг активен турнир на профила — виж коментара при
  // shouldKeepTournamentInterRoundPendingResult), докато myInterRoundWaiting
  // все още не е готов на сървъра. tournamentInterRoundPendingResult
  // умишлено остава non-null тук (симулира shouldKeepTournamentInterRoundPendingResult
  // все още връщащ true, защото повече не проверява myActiveMatch).
  const raceDetail = detailFixture({
    status: 'semifinal_in_progress',
    statusLabel: 'Полуфинал',
    viewer: { ...detailFixture().viewer, entryStatus: 'confirmed' },
    myInterRoundWaiting: null,
    myActiveMatch: {
      tournamentId: 'tournament-render',
      tournamentName: 'Render Test',
      matchId: 'final',
      roomId: 'final-room',
      roundType: 'final',
      seat: 'bottom',
      teamId: 'team-a',
      partnerProfileId: 'team-a-2',
      opponentTeamId: 'team-b',
      reconnectToken: null,
      deadlineKind: null,
      attendanceDeadlineAt: null,
      gameStartAt: null,
    },
  })
  const raceHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: raceDetail,
    tournamentInterRoundPendingResult: pendingState,
  })
  assert(raceHtml.includes('data-tournament-inter-round-pending="1"'), 'transition/pending presentation lost while myActiveMatch !== null but myInterRoundWaiting === null')
  assert(!raceHtml.includes('data-tournament-inter-round-waiting="1"'), 'waiting marker rendered before myInterRoundWaiting is authoritative')
  assert(!raceHtml.includes('РќР°РіСЂР°РґРµРЅ С„РѕРЅРґ'), 'generic finance (bracket screen) leaked during the myActiveMatch/myInterRoundWaiting race')
  assert(!raceHtml.includes('Р¤РѕСЂРјР°С‚'), 'generic format (bracket screen) leaked during the myActiveMatch/myInterRoundWaiting race')
  assert(!raceHtml.includes('РћС‚Р±РѕСЂРё</div>'), 'generic roster (bracket screen) leaked during the myActiveMatch/myInterRoundWaiting race')

  // Terminal states (C) трябва да продължат нормално да прекъсват pending —
  // само myActiveMatch сам по себе си вече не го прекъсва.
  const terminalDetail = detailFixture({ status: 'finished', myInterRoundWaiting: null, myActiveMatch: null })
  const terminalHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: terminalDetail,
    tournamentInterRoundPendingResult: null,
  })
  assert(!terminalHtml.includes('data-tournament-inter-round-pending="1"'), 'terminal tournament status still shows pending screen')

  // Unlike the deadlineKind:null race above, a READY round-transition
  // myActiveMatch (deadlineKind: 'round_transition') DOES bypass pending —
  // straight to STATE B, no bracket/pending flash in between (F/§ "INITIAL
  // STATE — SIBLING ALREADY COMPLETED").
  const readyHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: opponentKnownDetailFixture({
      status: 'semifinal_in_progress',
      statusLabel: 'Полуфинал',
      viewer: { ...detailFixture().viewer, entryStatus: 'confirmed' },
    }),
    tournamentInterRoundPendingResult: pendingState,
  })
  assert(!readyHtml.includes('data-tournament-inter-round-pending="1"'), 'pending screen not bypassed once STATE B (round_transition) is ready')
  assert(readyHtml.includes('data-tournament-inter-round-opponent-known="1"'), 'STATE B not shown once ready, despite pending still being set')
})

await check('when a later detail response carries myInterRoundWaiting: waiting screen appears immediately (no artificial delay)', () => {
  const hydratedHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: detailFixture({
      status: 'semifinal_in_progress',
      statusLabel: 'Полуфинал',
      viewer: { ...detailFixture().viewer, entryStatus: 'confirmed' },
    }),
    tournamentInterRoundPendingResult: null,
  })
  assert(hydratedHtml.includes('data-tournament-inter-round-waiting="1"'), 'hydrated waiting marker missing')
  assert(hydratedHtml.includes('Класирахте се за финала!'), 'qualification headline missing from merged waiting screen')
  assert(hydratedHtml.includes('Изчаквате победителя от маса 2'), 'sibling waiting copy (table number) missing from merged waiting screen')
  assert(hydratedHtml.includes('96 : 74'), 'hydrated sibling live score missing')
  assert(!hydratedHtml.includes('РќР°РіСЂР°РґРµРЅ С„РѕРЅРґ'), 'generic finance rendered after hydrated waiting')
})

await check('transition/state-machine wiring: no artificial wall-clock delay, bounded authoritative refetch, final auto-enter unconditional, generic bracket unreachable mid-transition', async () => {
  const projectRoot = resolve(join(serverRootPath, '..'))
  const lobbyController = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  const mainTs = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')

  assert(lobbyController.includes('function shouldKeepTournamentInterRoundPendingResult'), 'pending retention helper missing')
  assert(lobbyController.includes('detail.myInterRoundWaiting === null'), 'pending retention does not cover null waiting detail (A)')
  // 4/5 — никакъв artificial wall-clock minimum-display gate. Старата
  // 3000ms grace period е премахната изцяло, не заменена с друга стойност.
  assert(!lobbyController.includes('detail.myActiveMatch === null'), 'shouldKeepTournamentInterRoundPendingResult still terminates pending purely on myActiveMatch !== null')
  assert(!/pending\.shownAt|shownAt.*<\s*\d+|Date\.now\(\)\s*-\s*.*shownAt/.test(lobbyController), 'a wall-clock minimum-display comparison against shownAt still exists')
  assert(!lobbyController.includes('WinnerMinimumTimer'), 'old wall-clock winner-minimum timer scaffolding still present')

  // B — STATE B silent-attach trigger (generic across every round transition,
  // не само финала) трябва да е достижим независимо дали pending все още се
  // държи (преди беше gate-нат зад "if pending return" early-return, затова
  // никога не се достигаше, докато pending се пазеше).
  const roundTransitionIndex = lobbyController.indexOf('hasTournamentRoundTransitionAssignment(result.tournament.myActiveMatch)')
  const pendingEarlyReturnIndex = lobbyController.indexOf('if (state.tournamentInterRoundPendingResult !== null) {', lobbyController.indexOf('async function fetchTournamentDetail'))
  assert(roundTransitionIndex !== -1, 'round-transition (STATE B) check missing from fetchTournamentDetail')
  assert(pendingEarlyReturnIndex !== -1, 'pending early-return branch missing from fetchTournamentDetail')
  assert(roundTransitionIndex < pendingEarlyReturnIndex, 'STATE B check is still gated behind the pending early-return (B unreachable while transitioning)')
  assert(lobbyController.includes('options.onTournamentRoundTransitionAssignment?.(result.tournament.myActiveMatch!)'), 'STATE B silent-attach trigger call missing')
  assert(!lobbyController.includes("myActiveMatch.roundType === 'final'"), 'STATE B trigger still special-cased to the final round only (should be generic, Q/generic round support)')

  // Bounded authoritative refetch (не безкраен tight polling loop) — огледало
  // на съществуващия scheduleTournamentInterRoundAckRefetch pattern.
  assert(lobbyController.includes('function scheduleTournamentInterRoundPendingRefetch'), 'bounded pending refetch mechanism missing')
  assert(lobbyController.includes('scheduleTournamentInterRoundPendingRefetch(tournamentId)'), 'pending refetch not scheduled from fetchTournamentDetail')
  const pendingRefetchBody = lobbyController.slice(
    lobbyController.indexOf('function scheduleTournamentInterRoundPendingRefetch'),
    lobbyController.indexOf('function scheduleTournamentInterRoundPendingRefetch') + 900,
  )
  assert(/},\s*350\)/.test(pendingRefetchBody), 'pending refetch is not a single bounded timeout (expected 350ms one-shot matching the existing ack-refetch pattern)')
  assert(!pendingRefetchBody.includes('setInterval'), 'pending refetch uses setInterval (unbounded tight polling) instead of a single bounded retry')

  // 8 — единственият renderer-gate за generic bracket, потвърден непроменен:
  // pending клонът предхожда loading/generic клона.
  const renderer = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8')
  assert(renderer.indexOf('state.tournamentInterRoundPendingResult != null') < renderer.indexOf('state.tournamentDetailLoading'), 'pending branch is not before loading/generic branch')

  // Regression: this guard used to be gated on lobby?.getCurrentScreen() ===
  // 'tournament-detail', which left the global popup's assignment set (and
  // clickable into a non-silent resumeRoom) whenever the push landed while
  // the player was on any other lobby screen — producing the raw activeRoom
  // attendance screen alongside STATE B. It is now unconditional for every
  // round_transition assignment, regardless of the current lobby screen.
  assert(mainTs.includes("if (message.assignment.deadlineKind === 'round_transition') {"), 'round-transition assignment detail guard missing (generic, not final-only)')
  assert(!mainTs.includes("message.assignment.deadlineKind === 'round_transition' && lobby?.getCurrentScreen() === 'tournament-detail'"), 'round-transition popup suppression is still gated on the current lobby screen instead of being unconditional')
  assert(!mainTs.includes('client.resumeRoom(message.assignment.roomId, message.assignment.reconnectToken)'), 'assignment still direct (non-silent) resumes before countdown')
})

await check('inter-round presentation uses one overlay and dynamic round labels', async () => {
  const projectRoot = resolve(join(serverRootPath, '..'))
  const labels = await readFile(join(projectRoot, 'src', 'app', 'tournaments', 'tournamentRoundLabels.ts'), 'utf8')
  const renderer = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'renderTournamentsScreen.ts'), 'utf8')
  const controller = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  assert(labels.includes("round_of_16") && labels.includes("осминафинал"), 'round_of_16 label missing')
  assert(labels.includes("quarterfinal") && labels.includes("четвъртфинал"), 'quarterfinal label missing')
  assert(labels.includes("semifinal") && labels.includes("полуфинал"), 'semifinal label missing')
  assert(labels.includes("final") && labels.includes("финал"), 'final label missing')
  assert(renderer.includes('renderTournamentInterRoundOverlay'), 'single overlay renderer missing')
  assert(renderer.indexOf('state.tournamentInterRoundPendingResult !== null') < renderer.indexOf('state.tournamentDetailLoading'), 'pending branch is not before loading/generic branch')
  assert(renderer.includes('getTournamentRoundLabel(waiting.nextRoundType)'), 'authoritative waiting does not use dynamic next round label')
  assert(renderer.includes('getTournamentRoundLabel(assignment.roundType)'), 'STATE B does not use dynamic round label')
  assert(renderer.includes('getNextTournamentRoundLabel(pending.currentRoundType)'), 'pending winner does not use dynamic next round label')
  assert(controller.includes('patchTournamentInterRoundSiblingDom'), 'DOM-only live score patch missing')
})

await check('authenticated detail DTO wiring exposes inter-round waiting and suppresses active final before start', async () => {
  const projectRoot = resolve(join(serverRootPath, '..'))
  const serverIndex = await readFile(join(projectRoot, 'server', 'src', 'index.ts'), 'utf8')
  const dto = await readFile(join(projectRoot, 'server', 'src', 'tournament', 'tournamentDto.ts'), 'utf8')
  const lobbyController = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  const mainTs = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')
  assert(dto.includes('myInterRoundWaiting: TournamentInterRoundWaitingDto | null'), 'DTO field missing')
  assert(dto.includes('currentRoundType: TournamentRoundType') && dto.includes('nextRoundType: TournamentRoundType'), 'round metadata fields missing')
  assert(serverIndex.includes("if (tournament.status === 'finished' || myActiveMatch !== null) return null"), 'finished/active guard missing')
  assert(serverIndex.includes("viewerEntry.status !== 'confirmed'") && serverIndex.includes("viewerEntry.status !== 'finalist'"), 'confirmed/finalist inter-round guard missing')
  // Phase 1 generalized buildMyInterRoundWaiting to walk the full team-
  // capacity ladder (round_of_16->quarterfinal->semifinal->final) instead of
  // hardcoding 'semifinal'/'final' literals — see task spec §5 ("не
  // hardcode-вай semifinal/final literals в архитектурата"). Assert the
  // generic ladder-walking shape instead of the old semifinal-only literals.
  assert(serverIndex.includes('getTournamentRoundLadder(teamCapacity)'), 'generic ladder walk missing')
  assert(serverIndex.includes('.filter((round) => round.roundType === currentRoundType)'), 'generic current-round lookup missing')
  assert(serverIndex.includes('.flatMap((round) => round.matches.map((match) => ({ roundIndex: round.roundIndex, match })))'), 'round match flatten missing')
  assert(serverIndex.includes('ownResultAcknowledged'), 'own acknowledgement field missing')
  assert(serverIndex.includes('otherFinalistReady'), 'other finalist readiness missing')
  // Phase 1 replaced the final-only finalStartAt write with the generic
  // nextMatchStartAt field (task spec §1/§5) — legacy finalStartAt alias is
  // still populated from the same generic value for backward compat.
  assert(serverIndex.includes('nextMatchStartAt: nextMatch?.nextMatchStartAt ?? null'), 'nextMatchStartAt not exposed')
  assert(serverIndex.includes('finalStartAt: nextMatch?.nextMatchStartAt ?? null'), 'legacy finalStartAt alias not exposed')
  assert(!serverIndex.includes("currentRoundType: 'semifinal'"), 'currentRoundType is still hardcoded to the semifinal literal instead of the generic ladder variable')
  assert(lobbyController.includes('onTournamentSemifinalResultAckNeeded'), 'detail ack recovery option missing')
  assert(lobbyController.includes('ownResultAcknowledged === false'), 'detail ack recovery guard missing')
  assert(lobbyController.includes('scheduleTournamentInterRoundAckRefetch'), 'detail ack recovery refetch missing')
  assert(mainTs.includes('onTournamentSemifinalResultAckNeeded: (tournamentId, semifinalMatchId) =>'), 'detail ack recovery not wired')
})

await check('loser/final/normal source wiring remains isolated', async () => {
  const projectRoot = resolve(join(serverRootPath, '..'))
  const activeRoom = await readFile(join(projectRoot, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')
  assert(activeRoom.includes("${wonRound ? 'Към турнира' : 'Към лобито'}"), 'loss flow button branch changed')
  assert(activeRoom.includes('Вие спечелихте турнира!'), 'final result champion copy missing')
  assert(activeRoom.includes('renderMatchEndedScreen('), 'normal match-ended renderer missing')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

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

function finalStartAt(database: DatabaseSync, finalMatchId: string): string | null {
  return (database.prepare(`SELECT final_start_at FROM tournament_matches WHERE match_id = ?;`).get(finalMatchId) as { final_start_at: string | null }).final_start_at
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
    rounds: [],
    myActiveMatch: null,
    myInterRoundWaiting: {
      tournamentId: 'tournament-render',
      completedSemifinalMatchId: 'semi-a',
      currentRoundType: 'semifinal',
      nextRoundType: 'final',
      siblingSemifinal: { matchId: 'semi-b', teamA, teamB, scoreA: 96, scoreB: 74, status: 'in_progress', winnerTeamId: null, progressLabel: 'Мачът е в ход' },
      ownResultAcknowledged: true,
      otherFinalistReady: false,
      finalMatchId: 'final',
      finalRoomId: 'final-room',
      finalStartAt: null,
      serverNow: '2026-08-01T10:00:00.000Z',
    },
    incomingPartnerInvite: null,
    outgoingPartnerInvite: null,
    ...overrides,
  }
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

await check('other human finalist blocks finalStartAt until acknowledged, then sets it exactly once', async () => {
  const seeded = await seedTournament(true)
  try {
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalA, profileId: seeded.humanA })
    assert(finalStartAt(seeded.database, seeded.finalMatchId) === null, 'finalStartAt set before other human ack')
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalB, profileId: seeded.humanB! })
    const firstStartAt = finalStartAt(seeded.database, seeded.finalMatchId)
    assert(firstStartAt !== null, 'finalStartAt missing after all human acks')
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalB, profileId: seeded.humanB! })
    assert(finalStartAt(seeded.database, seeded.finalMatchId) === firstStartAt, 'duplicate ack changed finalStartAt')
    const deltaMs = Date.parse(firstStartAt!) - Date.now()
    assert(deltaMs > 0 && deltaMs <= 5_500, `finalStartAt is not about +5s: ${deltaMs}`)
  } finally {
    await cleanupSeeded(seeded)
  }
})

await check('bot finalist is auto-ready after the human winner ack', async () => {
  const seeded = await seedTournament(false)
  try {
    seeded.coordinator.acknowledgeSemifinalResult({ tournamentId: seeded.tournamentId, semifinalMatchId: seeded.semifinalA, profileId: seeded.humanA })
    assert(finalStartAt(seeded.database, seeded.finalMatchId) !== null, 'bot finalist did not auto-ready')
  } finally {
    await cleanupSeeded(seeded)
  }
})

await check('dedicated renderer hides generic finance/roster/CTA and shows live waiting score', () => {
  const html = renderDetail(detailFixture())
  assert(html.includes('data-tournament-inter-round-waiting="1"'), 'dedicated waiting marker missing')
  assert(html.includes('Класирахте се за финала'), 'title missing')
  assert(html.includes('Изчаква се другият полуфинал'), 'sibling waiting copy missing')
  assert(html.includes('96 : 74'), 'live sibling score missing')
  assert(!html.includes('Награден фонд'), 'generic finance rendered')
  assert(!html.includes('data-tournament-enter-active-match="1"'), 'resume CTA rendered')
  assert(!html.includes('Продължи играта'), 'resume copy rendered')
})

await check('countdown renderer uses server finalStartAt/serverNow and keeps popup suppressed', () => {
  const html = renderDetail(detailFixture({
    myInterRoundWaiting: {
      ...detailFixture().myInterRoundWaiting!,
      siblingSemifinal: { ...detailFixture().myInterRoundWaiting!.siblingSemifinal, status: 'completed', winnerTeamId: 'team-b', scoreA: 151, scoreB: 130, progressLabel: 'Завършен' },
      otherFinalistReady: true,
      finalStartAt: '2026-08-01T10:00:05.000Z',
      serverNow: '2026-08-01T10:00:00.000Z',
    },
  }))
  assert(html.includes('Мачът започва след'), 'countdown copy missing')
  assert(html.includes('data-final-start-at="2026-08-01T10:00:05.000Z"'), 'server finalStartAt missing')
  assert(!html.includes('Продължи играта'), 'popup/CTA leaked into countdown')
})

await check('real browser race keeps pending winner screen while detail/assignment arrive out of order', async () => {
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

  const nullWaitingDetail = detailFixture({
    status: 'semifinal_in_progress',
    statusLabel: 'РџРѕР»СѓС„РёРЅР°Р»',
    viewer: { ...detailFixture().viewer, entryStatus: 'confirmed' },
    myInterRoundWaiting: null,
    myActiveMatch: null,
  })
  const pendingAfterNullDetailHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: nullWaitingDetail,
    tournamentInterRoundPendingResult: pendingState,
  })
  assert(pendingAfterNullDetailHtml.includes('data-tournament-inter-round-pending="1"'), 'pending screen lost after null waiting detail')
  assert(!pendingAfterNullDetailHtml.includes('РќР°РіСЂР°РґРµРЅ С„РѕРЅРґ'), 'generic finance rendered after null waiting detail')

  const hydratedHtml = renderDetailState({
    tournamentDetailLoading: false,
    tournamentDetail: detailFixture({
      status: 'semifinal_in_progress',
      statusLabel: 'РџРѕР»СѓС„РёРЅР°Р»',
      viewer: { ...detailFixture().viewer, entryStatus: 'confirmed' },
    }),
    tournamentInterRoundPendingResult: null,
  })
  assert(hydratedHtml.includes('data-tournament-inter-round-waiting="1"'), 'hydrated waiting marker missing')
  assert(hydratedHtml.includes('96 : 74'), 'hydrated sibling live score missing')
  assert(!hydratedHtml.includes('РќР°РіСЂР°РґРµРЅ С„РѕРЅРґ'), 'generic finance rendered after hydrated waiting')

  const projectRoot = resolve(join(serverRootPath, '..'))
  const lobbyController = await readFile(join(projectRoot, 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
  const mainTs = await readFile(join(projectRoot, 'src', 'main.ts'), 'utf8')
  assert(lobbyController.includes('function shouldKeepTournamentInterRoundPendingResult'), 'pending retention helper missing')
  assert(lobbyController.includes('3000 - (Date.now() - pending.shownAt)'), 'winner minimum 3000ms latch missing')
  assert(lobbyController.includes('detail.myInterRoundWaiting === null'), 'pending retention does not cover null waiting detail')
  assert(mainTs.includes("if (message.assignment.roundType === 'final' && lobby?.getCurrentScreen() === 'tournament-detail') {"), 'final assignment detail guard missing')
  assert(!mainTs.includes('client.resumeRoom(message.assignment.roomId, message.assignment.reconnectToken)'), 'final assignment still direct-resumes before countdown')
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
  assert(renderer.includes('getTournamentRoundLabel(waiting.currentRoundType)'), 'authoritative waiting does not use dynamic current round label')
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
  assert(serverIndex.includes(".filter((round) => round.roundType === 'semifinal')"), 'split semifinal round lookup missing')
  assert(serverIndex.includes(".flatMap((round) => round.matches.map((match) => ({ roundIndex: round.roundIndex, match })))"), 'split semifinal match flatten missing')
  assert(serverIndex.includes('ownResultAcknowledged'), 'own acknowledgement field missing')
  assert(serverIndex.includes('otherFinalistReady'), 'other finalist readiness missing')
  assert(serverIndex.includes('finalStartAt: finalMatch?.finalStartAt ?? null'), 'finalStartAt not exposed')
  assert(serverIndex.includes("currentRoundType: 'semifinal'") && serverIndex.includes("nextRoundType: 'final'"), 'inter-round round metadata not exposed')
  assert(lobbyController.includes('onTournamentSemifinalResultAckNeeded'), 'detail ack recovery option missing')
  assert(lobbyController.includes('ownResultAcknowledged === false'), 'detail ack recovery guard missing')
  assert(lobbyController.includes('scheduleTournamentInterRoundAckRefetch'), 'detail ack recovery refetch missing')
  assert(mainTs.includes('onTournamentSemifinalResultAckNeeded: (tournamentId, semifinalMatchId) =>'), 'detail ack recovery not wired')
})

await check('loser/final/normal source wiring remains isolated', async () => {
  const projectRoot = resolve(join(serverRootPath, '..'))
  const activeRoom = await readFile(join(projectRoot, 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')
  assert(activeRoom.includes("${wonRound ? 'Към турнира' : 'Към лобито'}"), 'loss flow button branch changed')
  assert(activeRoom.includes('Спечелихте турнира!'), 'final result champion copy missing')
  assert(activeRoom.includes('renderMatchEndedScreen('), 'normal match-ended renderer missing')
})

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)

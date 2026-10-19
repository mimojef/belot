/**
 * checkTournamentCoordinatorCost.ts
 *
 * Детерминиран regression за цената на tournament coordinator tick-а
 * (performance audit Phase 0 + Phase 1A). Реален SQLite (всички миграции в
 * temp директория) + реален playerProgressStore + in-process
 * createTournamentCoordinator върху 32-player турнир (8 round_of_16 мача).
 *
 * Бюджетите са БРОЙ операции (SQL statements, commitRoom, profile lookups),
 * не милисекунди — не зависят от хардуера.
 *
 * Проверява:
 *  [1] getPublicProfilesByIds === getPublicProfile (вкл. gallery и липсващ id)
 *  [2] start/countdown/game-start tick-овете пазят досегашната commit семантика
 *  [3] steady in_progress tick: 0 commitRoom, 32 assignment push-а (5s resend
 *      остава), SQL/profile бюджети
 *  [4] presence промяна по време на игра → точно 1 commit, после пак 0
 *  [5] getAssignmentForProfile (index) === legacy scan (студен coordinator)
 *  [6] match completion → следващ кръг; assignments за победители/загубили
 *  [7] no-show → bot replacement → game start → bot takeover
 *  [8] restart: нов coordinator със студен индекс дава същите резултати
 *  [9] serverNow/secondsRemaining се изчисляват при изпращане на snapshot
 */

import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sqlite from 'node:sqlite'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import {
  createTournamentCoordinator,
  type TournamentAssignmentLookupOutcome,
  type TournamentCoordinator,
  type TournamentMatchAssignment,
} from '../src/tournament/tournamentCoordinator.js'

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

// ─── SQL instrumentation (всички connections в процеса) ──────────────────────
const sqlTotals = { statements: 0 }
const statementPrototype = (sqlite as unknown as { StatementSync: { prototype: Record<string, (...args: unknown[]) => unknown> } }).StatementSync.prototype
for (const method of ['get', 'all', 'run']) {
  const original = statementPrototype[method]!
  statementPrototype[method] = function (this: unknown, ...args: unknown[]) {
    sqlTotals.statements += 1
    return original.apply(this, args)
  }
}

// ─── Temp DB with all migrations ─────────────────────────────────────────────
const serverRootPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')
const manualTransactionMarker = '-- MANUAL_TRANSACTION_MIGRATION'

async function applyMigrations(database: sqlite.DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  const files = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  for (const filename of files) {
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith(manualTransactionMarker)) {
      database.exec(sql)
      continue
    }
    database.exec('BEGIN;')
    try {
      database.exec(sql)
      database.exec('COMMIT;')
    } catch (error) {
      try { database.exec('ROLLBACK;') } catch {}
      throw new Error(`Failed to apply migration ${filename}: ${String(error)}`)
    }
  }
}

const tempDir = await mkdtemp(join(tmpdir(), 'belot-coordinator-cost-'))
const databaseFilePath = join(tempDir, 'belot-v2.sqlite')
const seed = new sqlite.DatabaseSync(databaseFilePath)
await applyMigrations(seed)

const TOURNAMENT_ID = 'cost-tournament-1'
const PROFILE_COUNT = 32
const profileIds = Array.from({ length: PROFILE_COUNT }, (_, index) => `cost-profile-${String(index).padStart(2, '0')}`)
const teamIds = Array.from({ length: 16 }, (_, index) => `cost-team-${String(index).padStart(2, '0')}`)

seed.exec('BEGIN;')
seed.prepare(`
  INSERT INTO tournaments (tournament_id, name, entry_fee, player_capacity, start_mode, status, started_at)
  VALUES (?, 'Cost 32', 10, 32, 'fill', 'starting', CURRENT_TIMESTAMP);
`).run(TOURNAMENT_ID)
teamIds.forEach((teamId, index) => {
  seed.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status, seed_slot) VALUES (?, ?, 'locked', ?);`)
    .run(teamId, TOURNAMENT_ID, index + 1)
})
profileIds.forEach((profileId, index) => {
  seed.prepare(`
    INSERT INTO profiles (profile_id, display_name, normalized_display_name, avatar_url, level, rank_title)
    VALUES (?, ?, ?, ?, 7, 'Тест');
  `).run(profileId, `Cost Player ${index}`, `cost player ${index}`, `/uploads/avatars/cost-${index}.webp`)
  seed.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000);`).run(profileId)
  for (let image = 0; image < 3; image += 1) {
    seed.prepare(`
      INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order)
      VALUES (?, ?, ?, ?, ?);
    `).run(`${profileId}-img-${image}`, profileId, `/uploads/g/${profileId}-${image}.webp`, `/uploads/g/t-${profileId}-${image}.webp`, 2 - image)
  }
  seed.prepare(`
    INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status)
    VALUES (?, ?, ?, ?, ?, 'confirmed');
  `).run(`cost-entry-${index}`, TOURNAMENT_ID, profileId, teamIds[Math.floor(index / 2)]!, index % 2 === 0 ? 'partner_inviter' : 'partner_invitee')
})
for (let roundIndex = 1; roundIndex <= 8; roundIndex += 1) {
  seed.prepare(`INSERT INTO tournament_rounds (round_id, tournament_id, round_type, round_index) VALUES (?, ?, 'round_of_16', ?);`)
    .run(`cost-r16-${roundIndex}`, TOURNAMENT_ID, roundIndex)
  seed.prepare(`INSERT INTO tournament_matches (match_id, tournament_id, round_id, team_a_id, team_b_id) VALUES (?, ?, ?, ?, ?);`)
    .run(`cost-match-${roundIndex}`, TOURNAMENT_ID, `cost-r16-${roundIndex}`, teamIds[(roundIndex - 1) * 2]!, teamIds[(roundIndex - 1) * 2 + 1]!)
}
seed.exec('COMMIT;')

const playerProgressStore = await createPlayerProgressStore(databaseFilePath)

// ─── Coordinator harness ─────────────────────────────────────────────────────
const rooms = new Map<string, ServerRoom>()
const offlineProfiles = new Set<string>()
const counters = { commitRoom: 0, notifyAssignment: 0, getPublicProfile: 0, getPublicProfiles: 0 }
const lookupOutcomes: TournamentAssignmentLookupOutcome[] = []

async function createCoordinator(): Promise<TournamentCoordinator> {
  return createTournamentCoordinator({
    databaseFilePath,
    getPublicProfile: (profileId) => {
      counters.getPublicProfile += 1
      return playerProgressStore.getPublicProfile(profileId)
    },
    getPublicProfiles: (ids) => {
      counters.getPublicProfiles += 1
      return playerProgressStore.getPublicProfilesByIds(ids)
    },
    getRoom: (roomId) => rooms.get(roomId) ?? null,
    commitRoom: (room) => {
      counters.commitRoom += 1
      rooms.set(room.id, room)
      JSON.stringify(room)
    },
    closeCompletedRoom: (room) => {
      rooms.delete(room.id)
    },
    ensureRoomRuntime: () => ({ ok: true }),
    settleTournamentPrizes: () => ({ ok: true }),
    notifyAssignment: () => {
      counters.notifyAssignment += 1
    },
    notifyFeederMatchCompleted: () => {},
    notifyFeederScoreProgress: () => {},
    isConnectionAttached: () => false,
    isProfileOnline: (profileId) => !offlineProfiles.has(profileId),
    onAssignmentLookup: (outcome) => {
      lookupOutcomes.push(outcome)
    },
    setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
    clearInterval: () => {},
    logError: (message, error) => console.error(message, error),
  })
}

function resetCounters(): void {
  counters.commitRoom = 0
  counters.notifyAssignment = 0
  counters.getPublicProfile = 0
  counters.getPublicProfiles = 0
  sqlTotals.statements = 0
}

type TickResult = {
  commitRoom: number
  notifyAssignment: number
  profileQueries: number
  totalSql: number
  coordinatorSql: number
  skipped: number
  lastError: string | null
}

function tick(coordinator: TournamentCoordinator, label: string): TickResult {
  resetCounters()
  coordinator.tickNow()
  const health = coordinator.getHealth()
  const metrics = health.lastTickMetrics
  const result: TickResult = {
    commitRoom: counters.commitRoom,
    notifyAssignment: counters.notifyAssignment,
    profileQueries: counters.getPublicProfile + counters.getPublicProfiles,
    totalSql: sqlTotals.statements,
    coordinatorSql: metrics?.sqlStatements ?? -1,
    skipped: metrics?.skippedUnchangedCommits ?? -1,
    lastError: health.lastError,
  }
  console.log(
    `    [${label}] commitRoom=${result.commitRoom} skippedUnchanged=${result.skipped} notifyAssignment=${result.notifyAssignment} ` +
    `profileLookups=${result.profileQueries} (single=${counters.getPublicProfile} batch=${counters.getPublicProfiles}) ` +
    `coordinatorSql=${result.coordinatorSql} totalSql=${result.totalSql} maxMatchMs=${metrics?.maxMatchMs.toFixed(2) ?? '-'}`,
  )
  return result
}

function matchStatuses(): Record<string, string> {
  const rows = seed.prepare(`SELECT match_id, status FROM tournament_matches WHERE tournament_id = ? ORDER BY match_id;`)
    .all(TOURNAMENT_ID) as Array<{ match_id: string; status: string }>
  return Object.fromEntries(rows.map((row) => [row.match_id, row.status]))
}

function roomIdForMatch(matchId: string): string {
  return (seed.prepare(`SELECT room_id FROM tournament_matches WHERE match_id = ?;`).get(matchId) as { room_id: string }).room_id
}

function completeRoom(coordinator: TournamentCoordinator, matchId: string, winner: 'A' | 'B'): void {
  const room = rooms.get(roomIdForMatch(matchId))!
  const state = room.game.authoritativeState as Record<string, unknown>
  coordinator.onTournamentRoomCompleted({
    ...room,
    game: {
      ...room.game,
      authoritativeState: {
        ...state,
        matchEnded: { winnerTeam: winner, finalScore: { teamA: winner === 'A' ? 151 : 90, teamB: winner === 'A' ? 90 : 151 } },
      } as unknown as ServerRoom['game']['authoritativeState'],
    },
  })
}

function stableAssignment(assignment: TournamentMatchAssignment | null): string {
  return JSON.stringify(assignment)
}

// Сравнява новия (index) path с legacy scan-а на СТУДЕН coordinator (индексът
// му е празен до първия tick, затова getAssignmentForProfile минава изцяло
// през legacy кода) върху същата DB и същите runtime стаи.
async function compareAssignments(warm: TournamentCoordinator, label: string, extraProfiles: string[] = []): Promise<void> {
  const cold = await createCoordinator()
  const mismatches: string[] = []
  lookupOutcomes.length = 0
  for (const profileId of [...profileIds, ...extraProfiles]) {
    const fast = stableAssignment(warm.getAssignmentForProfile(profileId))
    const legacy = stableAssignment(cold.getAssignmentForProfile(profileId))
    if (fast !== legacy) mismatches.push(`${profileId}: fast=${fast} legacy=${legacy}`)
  }
  cold.close()
  check(`${label}: getAssignmentForProfile index path === legacy scan for ${profileIds.length + extraProfiles.length} profiles`, mismatches.length === 0, mismatches.slice(0, 3).join(' | '))
}

try {
  console.log('\n[1] getPublicProfilesByIds === getPublicProfile')
  {
    const batch = playerProgressStore.getPublicProfilesByIds([...profileIds, 'missing-profile', profileIds[0]!])
    const mismatched = profileIds.filter((profileId) => JSON.stringify(batch.get(profileId)) !== JSON.stringify(playerProgressStore.getPublicProfile(profileId)))
    check('batch returns identical snapshots (incl. gallery order)', mismatched.length === 0, mismatched.join(','))
    check('missing id is absent (getPublicProfile → null)', !batch.has('missing-profile') && playerProgressStore.getPublicProfile('missing-profile') === null)
    check('duplicate ids collapse', batch.size === PROFILE_COUNT)
  }

  const coordinator = await createCoordinator()

  console.log('\n[2] start / countdown / game start keep the existing commit semantics')
  const startTick = tick(coordinator, 'start')
  check('start tick: no error', startTick.lastError === null, String(startTick.lastError))
  check('start tick: 8 rooms created', rooms.size === 8)
  check('start tick: all 8 matches in countdown (all present)', Object.values(matchStatuses()).every((status) => status === 'countdown'))
  check('start tick: unchanged commit count for awaiting/countdown (16)', startTick.commitRoom === 16, String(startTick.commitRoom))
  check('start tick: one batch profile lookup instead of per-player lookups', startTick.profileQueries <= 2, String(startTick.profileQueries))

  const countdownTick = tick(coordinator, 'countdown')
  check('countdown tick: unchanged commit count (16)', countdownTick.commitRoom === 16, String(countdownTick.commitRoom))
  check('countdown tick: 5-second assignment resend unchanged (32)', countdownTick.notifyAssignment === 32, String(countdownTick.notifyAssignment))

  seed.prepare(`UPDATE tournament_matches SET game_start_at = '2000-01-01T00:00:00.000Z' WHERE status = 'countdown';`).run()
  const gameStartTick = tick(coordinator, 'game start')
  check('game start tick: all 8 matches in_progress', Object.values(matchStatuses()).every((status) => status === 'in_progress'))
  check('game start tick: rooms have a real game state', [...rooms.values()].every((room) => room.game.authoritativeState !== null && !('kind' in room.game.authoritativeState)))
  check('game start tick: unchanged commit count (16)', gameStartTick.commitRoom === 16, String(gameStartTick.commitRoom))

  console.log('\n[3] steady in_progress tick')
  const steadyTicks = [tick(coordinator, 'steady #1'), tick(coordinator, 'steady #2')]
  for (const [index, steady] of steadyTicks.entries()) {
    check(`steady #${index + 1}: 0 commitRoom for unchanged in_progress rooms`, steady.commitRoom === 0, String(steady.commitRoom))
    check(`steady #${index + 1}: 8 unchanged commits skipped`, steady.skipped === 8, String(steady.skipped))
    check(`steady #${index + 1}: assignment resend unchanged (32)`, steady.notifyAssignment === 32, String(steady.notifyAssignment))
    check(`steady #${index + 1}: ≤ 1 profile batch lookup (baseline 224 single lookups)`, steady.profileQueries <= 1, String(steady.profileQueries))
    check(`steady #${index + 1}: coordinator SQL ≤ 80 (baseline 616)`, steady.coordinatorSql > 0 && steady.coordinatorSql <= 80, String(steady.coordinatorSql))
    check(`steady #${index + 1}: total SQL incl. profile store ≤ 90`, steady.totalSql <= 90, String(steady.totalSql))
  }

  console.log('\n[4] presence change during a game commits exactly once')
  offlineProfiles.add(profileIds[0]!)
  const presenceTick = tick(coordinator, 'presence offline')
  check('one player offline → exactly 1 commit (roster isOnline changed)', presenceTick.commitRoom === 1, String(presenceTick.commitRoom))
  const roomOne = rooms.get(roomIdForMatch('cost-match-1'))!
  check('committed roster shows the player offline', roomOne.config.tournamentAttendance?.roster.some((entry) => entry.isOnline === false) === true)
  const presenceStableTick = tick(coordinator, 'presence stable')
  check('no further commit while presence is unchanged', presenceStableTick.commitRoom === 0, String(presenceStableTick.commitRoom))
  offlineProfiles.delete(profileIds[0]!)
  const presenceBackTick = tick(coordinator, 'presence back')
  check('player back online → exactly 1 commit', presenceBackTick.commitRoom === 1, String(presenceBackTick.commitRoom))

  console.log('\n[5] getAssignmentForProfile: index path vs legacy scan')
  await compareAssignments(coordinator, 'in_progress', ['not-a-participant', 'missing-profile'])
  lookupOutcomes.length = 0
  resetCounters()
  for (const profileId of profileIds) coordinator.getAssignmentForProfile(profileId)
  coordinator.getAssignmentForProfile('not-a-participant')
  check('32 index hits + 1 no_match, no legacy scan', lookupOutcomes.filter((o) => o === 'index_hit').length === 32 && lookupOutcomes.filter((o) => o === 'no_match').length === 1 && !lookupOutcomes.includes('legacy'), lookupOutcomes.join(','))
  check(`33 lookups cost ≤ 70 SQL (baseline ~6784 for 32)`, sqlTotals.statements <= 70, String(sqlTotals.statements))
  check('index lookups do not call getPublicProfile', counters.getPublicProfile + counters.getPublicProfiles === 0)

  console.log('\n[6] match completion → next round')
  completeRoom(coordinator, 'cost-match-1', 'A')
  completeRoom(coordinator, 'cost-match-2', 'B')
  const qf = seed.prepare(`
    SELECT tm.match_id, tm.team_a_id, tm.team_b_id, tm.status, tm.room_id
    FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? AND tr.round_type = 'quarterfinal';
  `).all(TOURNAMENT_ID) as Array<{ match_id: string; team_a_id: string; team_b_id: string; status: string; room_id: string | null }>
  check('QF1 created from the two R16 winners', qf.length === 1 && qf[0]!.team_a_id === teamIds[0] && qf[0]!.team_b_id === teamIds[3], JSON.stringify(qf))
  check('QF1 room exists from T0', qf[0]?.room_id !== null && rooms.has(qf[0]!.room_id!))
  const eliminated = seed.prepare(`SELECT team_id FROM tournament_teams WHERE tournament_id = ? AND status = 'eliminated' ORDER BY team_id;`).all(TOURNAMENT_ID) as Array<{ team_id: string }>
  check('R16 losers eliminated', JSON.stringify(eliminated.map((row) => row.team_id)) === JSON.stringify([teamIds[1], teamIds[2]]))
  check('winner now resolves to QF1 (index path)', coordinator.getAssignmentForProfile(profileIds[0]!)?.matchId === qf[0]!.match_id)
  check('loser resolves to null', coordinator.getAssignmentForProfile(profileIds[2]!) === null)
  await compareAssignments(coordinator, 'after completion (before next tick)')
  // QF1 играчите са офлайн → attendance остава 'awaiting_players' до deadline-а.
  const qfProfiles = [profileIds[0]!, profileIds[1]!, profileIds[6]!, profileIds[7]!]
  for (const profileId of qfProfiles) offlineProfiles.add(profileId)
  const awaitingTick = tick(coordinator, 'after completion')
  check('QF1 waits for attendance (awaiting_players)', matchStatuses()[qf[0]!.match_id] === 'awaiting_players')
  check('awaiting QF1 keeps the unconditional commits (ensureMatchRoom + resolveAttendance)', awaitingTick.commitRoom === 2, String(awaitingTick.commitRoom))
  await compareAssignments(coordinator, 'after completion (after tick)')

  console.log('\n[7] no-show → bot replacement → game start → takeover')
  seed.prepare(`
    UPDATE tournament_matches
    SET attendance_deadline_at = '2000-01-01T00:00:00.000Z', no_show_deadline_at = '2000-01-01T00:00:00.000Z', next_match_start_at = '2000-01-01T00:00:00.000Z'
    WHERE match_id = ?;
  `).run(qf[0]!.match_id)
  const qfStatusBefore = matchStatuses()[qf[0]!.match_id]
  const botTick = tick(coordinator, 'bots inserted')
  const qfStatusAfterBots = matchStatuses()[qf[0]!.match_id]
  // round_transition: game_start_at = next_match_start_at (вече в миналото
  // тук) → startResolvedMatchIfDue стартира мача в същия tick.
  check(`QF1 resolved by bot insertion and started (${qfStatusBefore} → ${qfStatusAfterBots})`, qfStatusBefore === 'awaiting_players' && qfStatusAfterBots === 'in_progress')
  const resolutionKind = (seed.prepare(`SELECT attendance_resolution_kind AS kind FROM tournament_matches WHERE match_id = ?;`).get(qf[0]!.match_id) as { kind: string }).kind
  check('resolution kind is bots_inserted', resolutionKind === 'bots_inserted', resolutionKind)
  const replacementCount = (seed.prepare(`SELECT COUNT(*) AS count FROM tournament_match_no_show_replacements WHERE match_id = ?;`).get(qf[0]!.match_id) as { count: number }).count
  check('4 replacement rows inserted', replacementCount === 4, String(replacementCount))
  check('hasUnresolvedBotReplacement true for a replaced player', coordinator.hasUnresolvedBotReplacement(TOURNAMENT_ID, qfProfiles[0]!) === true)
  check('bot tick had no error', botTick.lastError === null, String(botTick.lastError))
  seed.prepare(`UPDATE tournament_matches SET game_start_at = '2000-01-01T00:00:00.000Z' WHERE match_id = ? AND status = 'countdown';`).run(qf[0]!.match_id)
  tick(coordinator, 'QF1 game start')
  check('QF1 in_progress', matchStatuses()[qf[0]!.match_id] === 'in_progress')
  const qfRoom = rooms.get(qf[0]!.room_id!)!
  check('QF1 seats are tournament bots', ['bottom', 'right', 'top', 'left'].every((seat) => qfRoom.seats[seat as 'bottom'].participant?.kind === 'bot'))
  const qfSteady = tick(coordinator, 'QF1 steady')
  check('steady with bots: no commit', qfSteady.commitRoom === 0, String(qfSteady.commitRoom))
  await compareAssignments(coordinator, 'with bot replacements')
  const takeoverAssignment = coordinator.getAssignmentForProfile(qfProfiles[0]!)
  check('replaced player gets the replacement reconnect token', typeof takeoverAssignment?.reconnectToken === 'string')
  offlineProfiles.delete(qfProfiles[0]!)
  const takeover = coordinator.tryTakeoverNoShowBot({
    room: rooms.get(qf[0]!.room_id!)!,
    profileId: qfProfiles[0]!,
    connectionId: 'cost-connection-0' as never,
    reconnectToken: takeoverAssignment!.reconnectToken!,
  })
  check('bot takeover succeeds', takeover.ok === true, JSON.stringify(takeover))
  check('hasUnresolvedBotReplacement false after takeover', coordinator.hasUnresolvedBotReplacement(TOURNAMENT_ID, qfProfiles[0]!) === false)
  const afterTakeover = tick(coordinator, 'after takeover')
  check('after takeover: tick has no error', afterTakeover.lastError === null, String(afterTakeover.lastError))
  const afterTakeoverStable = tick(coordinator, 'after takeover stable')
  check('after takeover: stable tick commits nothing', afterTakeoverStable.commitRoom === 0, String(afterTakeoverStable.commitRoom))
  await compareAssignments(coordinator, 'after takeover')

  console.log('\n[8] restart with an empty cache')
  const restarted = await createCoordinator()
  await compareAssignments(restarted, 'restarted (cold index)')
  check('cold index uses the legacy path', restarted.getHealth().assignmentIndexWarm === false)
  const restartTick = tick(restarted, 'restart first tick')
  check('restart first tick: no error', restartTick.lastError === null, String(restartTick.lastError))
  check('restart warms the index', restarted.getHealth().assignmentIndexWarm === true)
  check('restart first tick: unchanged in_progress rooms are not recommitted', restartTick.commitRoom === 0, String(restartTick.commitRoom))
  await compareAssignments(restarted, 'restarted (warm index)')
  restarted.close()

  console.log('\n[9] serverNow / secondsRemaining computed at send time')
  {
    const awaitingRoom = [...rooms.values()].find((room) => room.config.tournamentAttendance !== null && room.config.tournamentAttendance !== undefined)!
    const deadlineAt = new Date(Date.now() + 42_500).toISOString()
    const staleRoom: ServerRoom = {
      ...awaitingRoom,
      config: {
        ...awaitingRoom.config,
        tournamentAttendance: {
          ...awaitingRoom.config.tournamentAttendance!,
          serverNow: '2000-01-01T00:00:00.000Z',
          deadlineAt,
          secondsRemaining: 999,
          gameStartAt: null,
          startSecondsRemaining: 999,
        },
      },
    }
    const before = Date.now()
    const snapshot = createRoomSnapshotMessage(staleRoom, 'bottom')
    const sentAttendance = snapshot.tournamentAttendance!
    check('serverNow reflects send time, not the persisted value', Date.parse(sentAttendance.serverNow) >= before)
    check('secondsRemaining recomputed from deadlineAt', sentAttendance.secondsRemaining === 43 || sentAttendance.secondsRemaining === 42, String(sentAttendance.secondsRemaining))
    check('startSecondsRemaining is 0 without gameStartAt', sentAttendance.startSecondsRemaining === 0)
    check('persisted room config is not mutated', staleRoom.config.tournamentAttendance!.secondsRemaining === 999)
  }

  coordinator.close()
} finally {
  playerProgressStore.close()
  seed.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0

/**
 * checkTournamentBusyParticipantAttendance.ts — Едно Белот участие (Вариант Б).
 *
 * Coordinator-level (реален SQLite + in-process createTournamentCoordinator,
 * огледален pattern на checkTournamentNoShowAttendance.ts):
 *
 *  [B1] играч, зает в друг Belot мач, се брои за неявил се (онлайн, но не
 *       „явил се“) — мачът не тръгва без него преди срока;
 *  [B2] освободи ли се преди срока -> all_present, без бот;
 *  [B3] зает при изтичане на срока -> съществуващият бот „вместо X“ само за
 *       него; поемане по време на игра запазва картите/резултата;
 *  [B4] onMatchRoomCreated — веднъж за построена стая, с нейните участници;
 *  [B5] елиминиран отбор -> notifyParticipationEnded; между кръговете
 *       финалистите нямат текущ турнирен мач (без ограничение);
 *  [B6] финал (20 s прозорец): зает финалист -> бот „вместо X“ на срока;
 *       след края на другия мач поема от бота;
 *  [B7] край на финала -> notifyParticipationEnded за четиримата.
 *
 *   cd server && node node_modules/tsx/dist/cli.mjs scripts/checkTournamentBusyParticipantAttendance.ts
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
function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const serverRootPath = join(dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDirectoryPath = join(serverRootPath, 'database', 'migrations')

async function applyMigrations(database: DatabaseSync): Promise<void> {
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec(`CREATE TABLE IF NOT EXISTS server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`)
  const files = (await readdir(migrationsDirectoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.sql')
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
  const insertApplied = database.prepare(`INSERT INTO server_migrations (filename) VALUES (?);`)
  for (const filename of files) {
    const sql = (await readFile(join(migrationsDirectoryPath, filename), 'utf8')).trim()
    if (sql.length === 0) continue
    if (sql.startsWith('-- MANUAL_TRANSACTION_MIGRATION')) { database.exec(sql); continue }
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
    profileId, displayName: `Busy Player ${index + 1}`, avatarUrl: null, level: 1, rankTitle: 'Test', skillRating: 1000,
    completedGamesCount: 0, wonGamesCount: 0, currentRankGames: 0, nextRankGames: 10, gamesUntilNextRank: 10,
    rankProgressRatio: 0, averageRating: null, totalRatingsCount: null, yellowCoinsBalance: 100_000, galleryImages: [],
    gender: null, likesCount: null, hasLikedByMe: null, isBlockedByMe: null,
  }
}

type MatchInfo = {
  matchId: string; roomId: string | null; roundType: string; teamAId: string; teamBId: string; status: string
  resultKind: string | null; winnerTeamId: string | null; attendanceResolutionKind: string | null
}
function getMatches(database: DatabaseSync, tournamentId: string): MatchInfo[] {
  return database.prepare(`
    SELECT tm.match_id AS matchId, tm.room_id AS roomId, tr.round_type AS roundType, tm.team_a_id AS teamAId,
           tm.team_b_id AS teamBId, tm.status, tm.result_kind AS resultKind, tm.winner_team_id AS winnerTeamId,
           tm.attendance_resolution_kind AS attendanceResolutionKind
    FROM tournament_matches tm JOIN tournament_rounds tr ON tr.round_id = tm.round_id
    WHERE tm.tournament_id = ? ORDER BY tr.round_index ASC, tm.created_at ASC;
  `).all(tournamentId) as MatchInfo[]
}
function forceAttendanceDeadlineElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`UPDATE tournament_matches SET attendance_deadline_at = '2026-07-30T09:59:00.000Z', no_show_deadline_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(matchId)
}
function forceCountdownElapsed(database: DatabaseSync, matchId: string): void {
  database.prepare(`UPDATE tournament_matches SET game_start_at = '2026-07-30T09:59:00.000Z' WHERE match_id = ?;`).run(matchId)
}
function replacementsFor(database: DatabaseSync, matchId: string): Array<{ profileId: string; status: string }> {
  return database.prepare(`SELECT assigned_profile_id AS profileId, status FROM tournament_match_no_show_replacements WHERE match_id = ?;`).all(matchId) as Array<{ profileId: string; status: string }>
}
function getSeatProfileMap(database: DatabaseSync, match: MatchInfo): Record<Seat, string> {
  const rows = database.prepare(`
    SELECT te.profile_id AS profileId, tt.team_id AS teamId FROM tournament_entries te
    JOIN tournament_teams tt ON tt.team_id = te.team_id WHERE tt.team_id IN (?, ?) ORDER BY te.created_at ASC;
  `).all(match.teamAId, match.teamBId) as Array<{ profileId: string; teamId: string }>
  const a = rows.filter((r) => r.teamId === match.teamAId)
  const b = rows.filter((r) => r.teamId === match.teamBId)
  return { bottom: a[0]!.profileId, top: a[1]!.profileId, left: b[0]!.profileId, right: b[1]!.profileId }
}
function endRoom(room: ServerRoom, winnerTeam: Team): ServerRoom {
  const initialized = initializeRoomAuthoritativeGameState(room)
  const state = initialized.game.authoritativeState as ServerAuthoritativeGameState
  const finalScore = winnerTeam === 'A' ? { teamA: 151, teamB: 70 } : { teamA: 70, teamB: 151 }
  return {
    ...initialized,
    status: 'finished',
    game: {
      ...initialized.game, phase: 'finished', stateVersion: initialized.game.stateVersion + 1, updatedAt: Date.now(),
      authoritativeState: {
        ...state, phase: 'match-ended',
        matchEnded: { winnerTeam, targetScore: initialized.config.targetScore, finalScore, endedAt: Date.now() },
        score: { ...state.score, match: finalScore },
      },
    },
  }
}

console.log('\n=== checkTournamentBusyParticipantAttendance ===\n')

const tempDir = await mkdtemp(join(tmpdir(), 'belot-busy-attendance-'))
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

const profileIds = Array.from({ length: 64 }, () => randomUUID())
profileIds.forEach((profileId, index) => {
  db.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(profileId, `Busy Player ${index + 1}`, `busy player ${index + 1}`)
  db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000);`).run(profileId)
})
const profiles = new Map(profileIds.map((profileId, index) => [profileId, publicProfile(profileId, index)]))
const rooms = new Map<string, ServerRoom>()
const onlineProfiles = new Set<string>()
// Профили, които реално управляват друг Belot мач (Вариант Б).
const busyProfiles = new Set<string>()
const createdRoomCalls: Array<{ roomId: string; profileIds: string[] }> = []
const endedCalls: Array<{ tournamentId: string; profileIds: string[] }> = []

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
  isProfileBusyInOtherBelotMatch: (profileId) => busyProfiles.has(profileId),
  onMatchRoomCreated: (room) => {
    createdRoomCalls.push({
      roomId: room.id,
      profileIds: (['bottom', 'right', 'top', 'left'] as Seat[])
        .map((seat) => room.seats[seat].participant)
        .map((participant) => participant?.identity.profileId ?? null)
        .filter((id): id is string => id !== null),
    })
  },
  notifyParticipationEnded: (ids, tournamentId) => { endedCalls.push({ tournamentId, profileIds: ids }) },
  setInterval: () => ({ unref() {} }) as ReturnType<typeof globalThis.setInterval>,
  clearInterval: () => {},
})

let cursor = 0
function startFullTournament(name: string): { tournamentId: string; participants: string[] } {
  const participants = profileIds.slice(cursor, cursor + 8)
  cursor += 8
  const created = tournamentStore.createTournament({ kind: 'community', name, creatorProfileId: participants[0]!, visibility: 'public', entryFee: 10_000, startMode: 'fill' })
  assert(created.ok === true, `create failed: ${JSON.stringify(created)}`)
  const tournamentId = created.tournament.tournamentId
  for (const profileId of participants) {
    const joined = economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
    assert(joined.ok === true, `join failed: ${JSON.stringify(joined)}`)
  }
  for (const p of participants) onlineProfiles.add(p)
  scheduler.tickNow()
  coordinator.tickNow()
  return { tournamentId, participants }
}
function clearPresence(participants: string[]): void {
  for (const p of participants) { onlineProfiles.delete(p); busyProfiles.delete(p) }
}

// ── B1/B2: зает -> неявил се; освобождаване преди срока ────────────────────
{
  const { tournamentId, participants } = startFullTournament('Busy B1')
  // startFullTournament вече направи tick с всички онлайн и никой зает —
  // контролата: мачовете вече са all_present. За сценария — нов турнир по-долу.
  const control = getMatches(db, tournamentId)[0]!
  check('[B1-control] без зает играч всички онлайн -> all_present веднага', control.attendanceResolutionKind === 'all_present', JSON.stringify(control))
  clearPresence(participants)
}
{
  const participants = profileIds.slice(cursor, cursor + 8)
  cursor += 8
  const created = tournamentStore.createTournament({ kind: 'community', name: 'Busy B2', creatorProfileId: participants[0]!, visibility: 'public', entryFee: 10_000, startMode: 'fill' })
  assert(created.ok === true, 'create B2')
  const tournamentId = created.tournament.tournamentId
  for (const profileId of participants) economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
  for (const p of participants) onlineProfiles.add(p)
  scheduler.tickNow()
  // Стаите още не са построени — правилото за присъствие се прилага при първия tick.
  const busyProfileId = participants[3]!
  busyProfiles.add(busyProfileId)
  coordinator.tickNow()
  const busyMatch = getMatches(db, tournamentId).find((m) => Object.values(getSeatProfileMap(db, m)).includes(busyProfileId))!
  check('[B1] онлайн, но зает в друг мач -> мачът чака (awaiting_players), не тръгва без него', busyMatch.status === 'awaiting_players' && busyMatch.attendanceResolutionKind === null, JSON.stringify(busyMatch))
  check('[B1] без бот преди срока', replacementsFor(db, busyMatch.matchId).length === 0)
  const other = getMatches(db, tournamentId).find((m) => m.matchId !== busyMatch.matchId)!
  check('[B1] другият полуфинал (без зает играч) тръгва нормално', other.attendanceResolutionKind === 'all_present', JSON.stringify(other))

  busyProfiles.delete(busyProfileId)
  coordinator.tickNow()
  const freed = getMatches(db, tournamentId).find((m) => m.matchId === busyMatch.matchId)!
  check('[B2] освободил се преди срока -> all_present, без бот', freed.status === 'countdown' && freed.attendanceResolutionKind === 'all_present' && replacementsFor(db, freed.matchId).length === 0, JSON.stringify(freed))

  const seatsCreated = createdRoomCalls.filter((call) => getMatches(db, tournamentId).some((m) => m.roomId === call.roomId))
  check('[B4] onMatchRoomCreated — веднъж за всяка от двете построени стаи', seatsCreated.length === 2 && new Set(seatsCreated.map((c) => c.roomId)).size === 2, JSON.stringify(seatsCreated.map((c) => c.roomId)))
  check('[B4] onMatchRoomCreated — с четиримата участници на стаята', seatsCreated.every((c) => c.profileIds.length === 4) && seatsCreated.some((c) => c.profileIds.includes(busyProfileId)))
  coordinator.tickNow()
  check('[B4] следващ tick не вика onMatchRoomCreated повторно', createdRoomCalls.filter((call) => seatsCreated.some((c) => c.roomId === call.roomId)).length === 2)
  clearPresence(participants)
}

// ── B3: зает при изтичане на срока -> бот „вместо X“; поемане ───────────────
{
  const participants = profileIds.slice(cursor, cursor + 8)
  cursor += 8
  const created = tournamentStore.createTournament({ kind: 'community', name: 'Busy B3', creatorProfileId: participants[0]!, visibility: 'public', entryFee: 10_000, startMode: 'fill' })
  assert(created.ok === true, 'create B3')
  const tournamentId = created.tournament.tournamentId
  for (const profileId of participants) economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
  for (const p of participants) onlineProfiles.add(p)
  const busyProfileId = participants[5]!
  busyProfiles.add(busyProfileId)
  scheduler.tickNow()
  coordinator.tickNow()
  const match0 = getMatches(db, tournamentId).find((m) => Object.values(getSeatProfileMap(db, m)).includes(busyProfileId))!
  forceAttendanceDeadlineElapsed(db, match0.matchId)
  coordinator.tickNow()
  const resolved = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  const rows = replacementsFor(db, resolved.matchId)
  check('[B3] срокът изтече, докато е зает -> bots_inserted (съществуващият механизъм)', resolved.attendanceResolutionKind === 'bots_inserted' && resolved.status === 'countdown', JSON.stringify(resolved))
  check('[B3] бот „вместо X“ само за заетия играч', rows.length === 1 && rows[0]!.profileId === busyProfileId && rows[0]!.status === 'active', JSON.stringify(rows))
  check('[B3] не е служебна загуба', resolved.resultKind !== 'walkover')

  forceCountdownElapsed(db, resolved.matchId)
  coordinator.tickNow()
  const inProgress = getMatches(db, tournamentId).find((m) => m.matchId === match0.matchId)!
  check('[B3] мачът тече с бота (in_progress)', inProgress.status === 'in_progress', JSON.stringify(inProgress))

  // Освобождава се СЛЕД срока и поема управлението по време на играта.
  busyProfiles.delete(busyProfileId)
  const assignment = coordinator.getAssignmentForProfile(busyProfileId)
  assert(assignment !== null && assignment.reconnectToken !== null, 'assignment with token during gameplay')
  const room = rooms.get(inProgress.roomId!)!
  const seat = assignment.seat
  const stateBefore = JSON.parse(JSON.stringify(room.game.authoritativeState)) as ServerAuthoritativeGameState
  const takeover = coordinator.tryTakeoverNoShowBot({ room, profileId: busyProfileId, connectionId: 'busy-b3-connection' as never, reconnectToken: assignment.reconnectToken })
  check('[B3] поемане от бота след изтичане на срока -> успешно', takeover.ok === true, JSON.stringify(takeover))
  if (takeover.ok) {
    const after = takeover.room
    const participant = after.seats[seat].participant
    check('[B3] мястото е отново на човека (същият профил)', participant?.kind === 'human' && participant.identity.profileId === busyProfileId)
    const stateAfter = after.game.authoritativeState as ServerAuthoritativeGameState
    const strip = (state: ServerAuthoritativeGameState) => JSON.stringify({ ...state, players: Object.fromEntries(Object.entries(state.players).map(([s, p]) => [s, s === seat ? { ...p, mode: null, controlledByBot: null } : p])) })
    check('[B3] картите, резултатът и състоянието на мача са запазени', strip(stateAfter) === strip(stateBefore))
    check('[B3] управлението е човешко (controlledByBot=false)', stateAfter.players[seat].controlledByBot === false && stateAfter.players[seat].mode === 'human')
  }
  check('[B3] заместването е затворено (completed)', replacementsFor(db, resolved.matchId).every((r) => r.status === 'completed'))
  clearPresence(participants)
}

// ── B5–B7: елиминиране, финал с 20 s прозорец, край на турнира ─────────────
{
  const participants = profileIds.slice(cursor, cursor + 8)
  cursor += 8
  const created = tournamentStore.createTournament({ kind: 'community', name: 'Busy B5', creatorProfileId: participants[0]!, visibility: 'public', entryFee: 10_000, startMode: 'fill' })
  assert(created.ok === true, 'create B5')
  const tournamentId = created.tournament.tournamentId
  for (const profileId of participants) economyStore.joinTournamentSoloAtomically(tournamentId, profileId)
  for (const p of participants) onlineProfiles.add(p)
  scheduler.tickNow()
  coordinator.tickNow()
  const [semi1, semi2] = getMatches(db, tournamentId)
  assert(semi1 !== undefined && semi2 !== undefined, 'two semifinals')
  for (const m of [semi1, semi2]) forceCountdownElapsed(db, m.matchId)
  coordinator.tickNow()
  const map1 = getSeatProfileMap(db, semi1)
  const map2 = getSeatProfileMap(db, semi2)

  const endedBefore = endedCalls.length
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(getMatches(db, tournamentId)[0]!.roomId!)!, 'A'))
  const eliminatedCall = endedCalls.slice(endedBefore).find((call) => call.tournamentId === tournamentId)
  check('[B5] елиминиран отбор -> notifyParticipationEnded за двамата му играчи', eliminatedCall !== undefined && eliminatedCall.profileIds.length === 2 && eliminatedCall.profileIds.includes(map1.left) && eliminatedCall.profileIds.includes(map1.right), JSON.stringify(eliminatedCall))
  check('[B5] елиминираните нямат турнирен мач (могат да играят веднага)', coordinator.getAssignmentForProfile(map1.left) === null && coordinator.getAssignmentForProfile(map1.right) === null)
  check('[B5] победителите между кръговете нямат текущ турнирен мач (без ограничение, докато чакат финала)', coordinator.getAssignmentForProfile(map1.bottom) === null && coordinator.getAssignmentForProfile(map1.top) === null)

  // Финалист, зает в друг мач при откриването на финала.
  const busyFinalist = map2.left
  busyProfiles.add(busyFinalist)
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(getMatches(db, tournamentId).find((m) => m.matchId === semi2.matchId)!.roomId!)!, 'B'))
  coordinator.tickNow()
  const finalMatch = getMatches(db, tournamentId).find((m) => m.roundType === 'final')
  assert(finalMatch !== undefined, 'final created')
  check('[B6] финалът (20 s прозорец) чака заетия финалист', finalMatch.status === 'awaiting_players' && finalMatch.attendanceResolutionKind === null, JSON.stringify(finalMatch))
  forceAttendanceDeadlineElapsed(db, finalMatch.matchId)
  coordinator.tickNow()
  const finalResolved = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch.matchId)!
  const finalRows = replacementsFor(db, finalMatch.matchId)
  check('[B6] на срока -> бот „вместо X“ само за заетия финалист', finalResolved.attendanceResolutionKind === 'bots_inserted' && finalRows.length === 1 && finalRows[0]!.profileId === busyFinalist, JSON.stringify(finalRows))
  forceCountdownElapsed(db, finalMatch.matchId)
  coordinator.tickNow()
  const finalInProgress = getMatches(db, tournamentId).find((m) => m.matchId === finalMatch.matchId)!
  // Обикновеният мач приключи -> финалистът се включва и поема от бота.
  busyProfiles.delete(busyFinalist)
  const finalAssignment = coordinator.getAssignmentForProfile(busyFinalist)
  assert(finalAssignment !== null && finalAssignment.reconnectToken !== null, 'final assignment with token')
  const finalRoomBefore = rooms.get(finalInProgress.roomId!)!
  const finalTakeover = coordinator.tryTakeoverNoShowBot({ room: finalRoomBefore, profileId: busyFinalist, connectionId: 'busy-final-connection' as never, reconnectToken: finalAssignment.reconnectToken })
  check('[B6] след края на другия мач финалистът поема от бота във финала', finalTakeover.ok === true && finalTakeover.room.seats[finalTakeover.seat].participant?.kind === 'human', JSON.stringify(finalTakeover.ok))
  const endedBeforeFinal = endedCalls.length
  coordinator.onTournamentRoomCompleted(endRoom(rooms.get(finalInProgress.roomId!)!, 'A'))
  const finalCall = endedCalls.slice(endedBeforeFinal).find((call) => call.tournamentId === tournamentId)
  const finalists = [map1.bottom, map1.top, map2.left, map2.right]
  check('[B7] край на финала -> notifyParticipationEnded за четиримата финалисти', finalCall !== undefined && finalists.every((id) => finalCall.profileIds.includes(id)), JSON.stringify(finalCall))
  check('[B7] след края никой няма турнирен мач', finalists.every((id) => coordinator.getAssignmentForProfile(id) === null))
  clearPresence(participants)
}

console.log(`\n${passed} passed, ${failed} failed`)
coordinator.close()
process.exit(failed > 0 ? 1 : 0)

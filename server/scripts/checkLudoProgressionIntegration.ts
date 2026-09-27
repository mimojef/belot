/**
 * checkLudoProgressionIntegration.ts
 *
 * Regression test за task-а "Ludo -> level/rank progression" — завършени
 * Ludo мачове вече дават +1 към СЪЩИЯ profile_progress.completed_games_count
 * brojач, който Belot вече захранва (СЪЩИТЕ level/rank thresholds,
 * rankProgression.ts недокоснат). НЕ добавя отделни Ludo нива/XP.
 *
 * Архитектура под тест (виж playerProgressStore.ts и
 * server/src/index.ts::ludoMatchRuntime.onSnapshot за пълния doc коментар):
 *
 *   - playerProgressStore.recordCompletedGameForProfile(scopeId, profileId,
 *     source) — нов, game-agnostic idempotent "+1 completed game" helper.
 *     Идемпотентен чрез profile_completed_game_ledger PRIMARY KEY
 *     (scope_id, profile_id) — миграция 20260927_001. НИКОГА не пипа
 *     won_games_count (винаги didWin:false вътрешно towards
 *     incrementCompletedGame() — Belot's съществуваща "Победи"/"Успех %"
 *     семантика остава недокосната от Ludo резултати).
 *   - server/src/index.ts::ludoMatchRuntime's onSnapshot callback вика тая
 *     функция за ВСЕКИ snapshot.players запис, ЕДИНСТВЕНО когато
 *     snapshot.state.status === 'finished' — точката, в която Ludo мач
 *     structurally преминава във финално състояние ТОЧНО ВЕДНЪЖ (виж
 *     ludoMatchRuntime.ts::commit()/validate()/leave() doc коментарите).
 *   - recordCompletedMatch() (Belot-specific: team/did_win/is_guest_trial,
 *     profile_match_results) остава НАПЪЛНО непроменен — отделен writer,
 *     отделна таблица, нулев overlap с новия helper.
 *
 * Покрива:
 *   [A1] Fresh profile, единичен recordCompletedGameForProfile call ->
 *        completed_games_count 0->1, recorded:true
 *   [A2] Втори call СЪЩИЯ (scopeId, profileId) -> recorded:false,
 *        completed_games_count ОСТАВА 1 (duplicate completion guard)
 *   [A3] Различен scopeId (нов match), СЪЩИЯ profile -> recorded:true,
 *        completed_games_count 1->2 (scope isolation — не permanent block)
 *   [A4] Двама РЕАЛНИ участници на един match (различен profileId, СЪЩИЯ
 *        scopeId) -> и двамата получават точно +1, независимо
 *   [A5] won_games_count НИКОГА не се пипа от recordCompletedGameForProfile
 *        (нито за "победителя", нито за "губещия" — функцията изобщо няма
 *        didWin параметър)
 *   [A6] Threshold case: profile на 299 completed games -> един Ludo call ->
 *        300 -> level 26, rankTitle остава "Напреднал" (level 26 е още в
 *        20-29 диапазона — самата rank/level формула е недокосната)
 *
 *   [B1] Real ludoMatchRuntime: forfeit-triggered finish (last-player-
 *        standing) -> onSnapshot с status:'finished' се извиква ТОЧНО ВЕДНЪЖ
 *   [B2] След финала: reconnect() + requestState() + duplicate leave()
 *        (пост-финален ack idempotent клон) -> finished-onSnapshot броят
 *        ОСТАВА 1 (runtime-ово доказателство за "точно веднъж" инварианта,
 *        не просто твърдение)
 *
 *   [C1] End-to-end: РЕАЛЕН finished snapshot от createLudoMatchRuntime,
 *        подаден през СЪЩАТА wiring логика като index.ts (итерация по
 *        snapshot.players + recordCompletedGameForProfile per player) към
 *        РЕАЛЕН playerProgressStore -> и двамата участници +1
 *   [C2] Същия finished snapshot, обработен ВТОРИ път (симулира duplicate
 *        finalization/resend) -> НЕ дава второ +1 (end-to-end idempotency)
 *   [C3] Трети profileId, НИКОГА не участвал в snapshot.players (spectator/
 *        non-participant симулация) -> completed_games_count му остава
 *        непроменен (структурно изключен, само по това, че не е в масива)
 *
 *   [D1] Belot regression: recordCompletedMatch(room) продължава да дава
 *        точно +1 completed_games_count на всеки от 4-те seats, +1
 *        won_games_count само на печелившия отбор — напълно недокоснато от
 *        новия Ludo helper/таблица
 *
 *   [E1] Source review — server/src/index.ts's ludoMatchRuntime onSnapshot
 *        вика playerProgressStore.recordCompletedGameForProfile(...) вътре
 *        в status==='finished' guard-а
 *   [E2] Source review — тоя конкретен нов блок НЕ реферира won_games_count/
 *        didWin (доказва, че wiring-ът никога не се опитва да пипа победи)
 *   [E3] Source review — миграцията 20260927_001 дефинира
 *        profile_completed_game_ledger с PRIMARY KEY (scope_id, profile_id)
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createLudoMatchRuntime, type LudoMatchSnapshot } from '../src/game/ludoMatchRuntime.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'
import type { ServerRoom, Seat, Team } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON;')
  const migrationFiles = readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()
  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }
  db.close()
}

console.log('\ncheckLudoProgressionIntegration\n')

const dbDir = await mkdtemp(join(tmpdir(), 'belot-ludo-progression-'))
const dbPath = join(dbDir, 'test.db')
await applyMigrations(dbPath)

const store = await createPlayerProgressStore(dbPath)
const rawDb = new DatabaseSync(dbPath, { open: true })

function insertProfile(profileId: string, displayName: string): void {
  rawDb
    .prepare(
      `INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status
      ) VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active')`,
    )
    .run(profileId, displayName, displayName.toLowerCase())
}

type ProgressRow = { completed_games_count: number; won_games_count: number }
function getProgress(profileId: string): ProgressRow {
  const row = rawDb
    .prepare(`SELECT completed_games_count, won_games_count FROM profile_progress WHERE profile_id = ?`)
    .get(profileId) as ProgressRow | undefined
  return row ?? { completed_games_count: 0, won_games_count: 0 }
}

function getLevelAndTitle(profileId: string): { level: number; rankTitle: string | null } {
  const row = rawDb
    .prepare(`SELECT level, rank_title FROM profiles WHERE profile_id = ?`)
    .get(profileId) as { level: number; rank_title: string | null }
  return { level: row.level, rankTitle: row.rank_title }
}

function seedProgress(profileId: string, completedGamesCount: number, wonGamesCount: number, rankLevel: number): void {
  rawDb
    .prepare(
      `INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         completed_games_count = excluded.completed_games_count,
         won_games_count = excluded.won_games_count,
         rank_level = excluded.rank_level`,
    )
    .run(profileId, completedGamesCount, wonGamesCount, rankLevel)
}

// ═══════════════════════════════════════════════════════════════════════
// A1-A6: playerProgressStore.recordCompletedGameForProfile — DB-level
// ═══════════════════════════════════════════════════════════════════════
console.log('=== A1-A6: recordCompletedGameForProfile (DB-level) ===')

await check('[A1] Fresh profile, единичен call -> completed_games_count 0->1, recorded:true', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A1 Player')
  const result = store.recordCompletedGameForProfile('match-a1', profileId, 'ludo_match')
  assert.equal(result.recorded, true)
  assert.equal(getProgress(profileId).completed_games_count, 1)
})

await check('[A2] Втори call СЪЩИЯ (scopeId, profileId) -> recorded:false, count ОСТАВА 1', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A2 Player')
  store.recordCompletedGameForProfile('match-a2', profileId, 'ludo_match')
  const second = store.recordCompletedGameForProfile('match-a2', profileId, 'ludo_match')
  assert.equal(second.recorded, false)
  assert.equal(getProgress(profileId).completed_games_count, 1, 'duplicate completion не бива да дава второ +1')
})

await check('[A3] Различен scopeId (нов match), СЪЩИЯ profile -> recorded:true, count 1->2', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A3 Player')
  store.recordCompletedGameForProfile('match-a3-first', profileId, 'ludo_match')
  const second = store.recordCompletedGameForProfile('match-a3-second', profileId, 'ludo_match')
  assert.equal(second.recorded, true, 'нов match за същия profile трябва да дава ново +1 (idempotency е per-scope, не permanent block)')
  assert.equal(getProgress(profileId).completed_games_count, 2)
})

await check('[A4] Двама реални участници на един match -> и двамата +1', () => {
  const profileA = randomUUID()
  const profileB = randomUUID()
  insertProfile(profileA, 'A4 Player A')
  insertProfile(profileB, 'A4 Player B')
  const scopeId = 'match-a4'
  store.recordCompletedGameForProfile(scopeId, profileA, 'ludo_match')
  store.recordCompletedGameForProfile(scopeId, profileB, 'ludo_match')
  assert.equal(getProgress(profileA).completed_games_count, 1)
  assert.equal(getProgress(profileB).completed_games_count, 1)
})

await check('[A5] won_games_count НИКОГА не се пипа от recordCompletedGameForProfile', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A5 Player')
  seedProgress(profileId, 10, 5, 10)
  store.recordCompletedGameForProfile('match-a5', profileId, 'ludo_match')
  const progress = getProgress(profileId)
  assert.equal(progress.completed_games_count, 11, 'completed_games_count трябва да се качи')
  assert.equal(progress.won_games_count, 5, 'won_games_count трябва да остане НЕПРОМЕНЕН от Ludo резултат')
})

await check('[A6] Threshold: profile на 299 completed games -> Ludo завършва -> 300 -> level 26, rankTitle "Напреднал"', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A6 Player')
  seedProgress(profileId, 299, 0, 25)
  rawDb.prepare(`UPDATE profiles SET level = 25, rank_title = 'Напреднал' WHERE profile_id = ?`).run(profileId)
  const result = store.recordCompletedGameForProfile('match-a6', profileId, 'ludo_match')
  assert.equal(result.recorded, true)
  assert.equal(getProgress(profileId).completed_games_count, 300)
  const { level, rankTitle } = getLevelAndTitle(profileId)
  assert.equal(level, 26, '300 кумулативни игри трябва да дадат ниво 26 (виж rankProgression.ts getCompletedGamesRequiredForRank(26)===300)')
  assert.equal(rankTitle, 'Напреднал', 'ниво 26 е още в 20-29 диапазона — рангът НЕ се сменя тук')
})

// ═══════════════════════════════════════════════════════════════════════
// B1-B2: real ludoMatchRuntime — "finished onSnapshot fires exactly once"
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== B1-B2: ludoMatchRuntime finished-snapshot invocation count ===')

let roomSerial = 0
function makeLudoRoom(): LudoRoom {
  roomSerial += 1
  return {
    id: `ludo-room-${roomSerial}`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: 'ludo-p1', createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: 'ludo-p1', displayName: 'Ludo Player 1', avatarUrl: null },
      { connectionId: 'c2', profileId: 'ludo-p2', displayName: 'Ludo Player 2', avatarUrl: null },
    ],
  }
}
function freshLudoMatchId(): string {
  roomSerial += 1
  return `ludo-match-${roomSerial}`
}

await check('[B1] Forfeit-triggered finish (last-player-standing) -> onSnapshot(status=finished) се извиква ТОЧНО ВЕДНЪЖ', () => {
  const finishedSnapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    now: () => 500_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => {
      if (snapshot.state.status === 'finished') finishedSnapshots.push(snapshot)
    },
  })
  const started = runtime.createMatch(makeLudoRoom(), freshLudoMatchId())
  const leaveResult = runtime.leave(started.matchId, 'ludo-p2')
  assert.equal(leaveResult.ok, true)
  assert.equal(finishedSnapshots.length, 1, 'last-player-standing forfeit трябва да произведе ТОЧНО 1 finished snapshot')
  assert.equal(finishedSnapshots[0]!.state.status, 'finished')
  runtime.destroy()
  return { runtime, started, finishedSnapshots }
})

await check('[B2] След финала: reconnect()/requestState()/duplicate leave() НЕ произвеждат допълнителен finished onSnapshot', () => {
  const finishedSnapshots: LudoMatchSnapshot[] = []
  const runtime = createLudoMatchRuntime({
    now: () => 600_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => {
      if (snapshot.state.status === 'finished') finishedSnapshots.push(snapshot)
    },
  })
  const started = runtime.createMatch(makeLudoRoom(), freshLudoMatchId())
  runtime.leave(started.matchId, 'ludo-p2')
  assert.equal(finishedSnapshots.length, 1)

  runtime.reconnect('ludo-p1', 'new-conn')
  runtime.requestState('ludo-p1')
  // Пост-финален "ack" leave (played остава finished) — идемпотентен клон,
  // не бива да commit-ва/onSnapshot отново.
  const secondLeave = runtime.leave(started.matchId, 'ludo-p1')
  assert.equal(secondLeave.ok, true)

  assert.equal(finishedSnapshots.length, 1, 'reconnect/requestState/post-final leave НЕ бива да добавят нов finished snapshot')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// C1-C3: end-to-end wiring (real runtime finished snapshot -> real store)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== C1-C3: end-to-end wiring (runtime finished snapshot -> playerProgressStore) ===')

// Mirror ТОЧНО на server/src/index.ts's ludoMatchRuntime onSnapshot wiring
// (виж index.ts коментара "Level/rank progression"): итерира
// snapshot.players, вика recordCompletedGameForProfile per player, само
// когато snapshot.state.status === 'finished'.
function applyProgressionWiring(snapshot: LudoMatchSnapshot): void {
  if (snapshot.state.status !== 'finished') return
  for (const player of snapshot.players) {
    store.recordCompletedGameForProfile(snapshot.matchId, player.profileId, 'ludo_match')
  }
}

await check('[C1] Реален finished snapshot -> и двамата участници получават +1', () => {
  const profileWinner = `ludo-c1-winner-${randomUUID()}`
  const profileLoser = `ludo-c1-loser-${randomUUID()}`
  insertProfile(profileWinner, 'C1 Winner')
  insertProfile(profileLoser, 'C1 Loser')

  let finished: LudoMatchSnapshot | null = null
  const runtime = createLudoMatchRuntime({
    now: () => 700_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => { if (snapshot.state.status === 'finished') finished = snapshot },
  })
  const room: LudoRoom = {
    id: `ludo-room-c1`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: profileWinner, createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: profileWinner, displayName: 'Winner', avatarUrl: null },
      { connectionId: 'c2', profileId: profileLoser, displayName: 'Loser', avatarUrl: null },
    ],
  }
  const started = runtime.createMatch(room, `ludo-match-c1-${randomUUID()}`)
  runtime.leave(started.matchId, profileLoser)
  assert.ok(finished !== null, 'мачът трябва реално да завърши (last-player-standing forfeit)')

  applyProgressionWiring(finished!)

  assert.equal(getProgress(profileWinner).completed_games_count, 1)
  assert.equal(getProgress(profileLoser).completed_games_count, 1, 'forfeit-налият участник СЪЩО получава +1 (мачът реално приключи според текущите правила, по аналогия с Belot controlledByBot)')
  runtime.destroy()
})

await check('[C2] Същия finished snapshot, обработен ВТОРИ път (duplicate finalization/resend) -> НЕ дава второ +1', () => {
  const profileWinner = `ludo-c2-winner-${randomUUID()}`
  const profileLoser = `ludo-c2-loser-${randomUUID()}`
  insertProfile(profileWinner, 'C2 Winner')
  insertProfile(profileLoser, 'C2 Loser')

  let finished: LudoMatchSnapshot | null = null
  const runtime = createLudoMatchRuntime({
    now: () => 800_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => { if (snapshot.state.status === 'finished') finished = snapshot },
  })
  const room: LudoRoom = {
    id: `ludo-room-c2`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: profileWinner, createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: profileWinner, displayName: 'Winner', avatarUrl: null },
      { connectionId: 'c2', profileId: profileLoser, displayName: 'Loser', avatarUrl: null },
    ],
  }
  const started = runtime.createMatch(room, `ludo-match-c2-${randomUUID()}`)
  runtime.leave(started.matchId, profileLoser)
  assert.ok(finished !== null)

  applyProgressionWiring(finished!)
  applyProgressionWiring(finished!) // Симулира duplicate resend/finalization на СЪЩИЯ snapshot

  assert.equal(getProgress(profileWinner).completed_games_count, 1, 'втора обработка на СЪЩИЯ finished snapshot не бива да дава второ +1')
  assert.equal(getProgress(profileLoser).completed_games_count, 1)
  runtime.destroy()
})

await check('[C3] Профил, никога неучаствал в snapshot.players (spectator/non-participant) -> completed_games_count НЕ се променя', () => {
  const profileWinner = `ludo-c3-winner-${randomUUID()}`
  const profileLoser = `ludo-c3-loser-${randomUUID()}`
  const spectatorProfile = `ludo-c3-spectator-${randomUUID()}`
  insertProfile(profileWinner, 'C3 Winner')
  insertProfile(profileLoser, 'C3 Loser')
  insertProfile(spectatorProfile, 'C3 Spectator')
  seedProgress(spectatorProfile, 42, 10, 20)

  let finished: LudoMatchSnapshot | null = null
  const runtime = createLudoMatchRuntime({
    now: () => 900_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => { if (snapshot.state.status === 'finished') finished = snapshot },
  })
  const room: LudoRoom = {
    id: `ludo-room-c3`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: profileWinner, createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: profileWinner, displayName: 'Winner', avatarUrl: null },
      { connectionId: 'c2', profileId: profileLoser, displayName: 'Loser', avatarUrl: null },
    ],
  }
  const started = runtime.createMatch(room, `ludo-match-c3-${randomUUID()}`)
  runtime.leave(started.matchId, profileLoser)
  assert.ok(finished !== null)
  assert.ok(
    !finished!.players.some((p) => p.profileId === spectatorProfile),
    'spectator профилът структурно не трябва да е в snapshot.players',
  )

  applyProgressionWiring(finished!)

  assert.equal(getProgress(spectatorProfile).completed_games_count, 42, 'spectator/non-participant completed_games_count трябва да остане НЕПРОМЕНЕН')
  runtime.destroy()
})

// ═══════════════════════════════════════════════════════════════════════
// D1: Belot regression — recordCompletedMatch() недокоснато
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== D1: Belot regression (recordCompletedMatch unaffected) ===')

function makeHumanParticipant(profileId: string) {
  return {
    kind: 'human' as const,
    playerId: randomUUID(),
    connectionId: null,
    isConnected: true,
    joinedAt: 0,
    lastSeenAt: 0,
    reconnectToken: null,
    identity: {
      accountId: null, profileId, username: null, displayName: 'Player',
      avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null,
    },
  }
}
function makeSeat(seat: Seat, team: Team, participant: ReturnType<typeof makeHumanParticipant>) {
  return { seat, team, participant }
}
function makeMatchEndedState(winnerTeam: Team): ServerAuthoritativeGameState {
  const emptyScore = { teamA: 0, teamB: 0 }
  const emptyHands = { bottom: [], right: [], top: [], left: [] }
  const emptyWonTricks = { A: [], B: [] }
  const emptyTrick = { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 }
  const pts = winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 }
  return {
    phase: 'match-ended', phaseEnteredAt: 0, targetScore: 151,
    players: {
      bottom: { seat: 'bottom', team: 'A', mode: 'human', controlledByBot: false },
      right: { seat: 'right', team: 'B', mode: 'human', controlledByBot: false },
      top: { seat: 'top', team: 'A', mode: 'human', controlledByBot: false },
      left: { seat: 'left', team: 'B', mode: 'human', controlledByBot: false },
    },
    round: { dealerSeat: 'bottom', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [], hands: emptyHands,
    bidding: { entries: [], currentSeat: null, winningBid: null, hasStarted: false, hasEnded: false, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: undefined as any,
    matchDeclarationMissionCountsBySeat: undefined as any,
    currentTrick: emptyTrick, wonTricks: emptyWonTricks, playing: null,
    scoring: {
      winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
      rawHandPoints: emptyScore, rawHandTricksWon: emptyScore, declarationPoints: emptyScore,
      belotePoints: emptyScore, sumPoints: emptyScore, officialRoundPoints: pts, matchTotals: pts,
      carryOver: { teamA: 0, teamB: 0 }, isCapotRound: false, isNonCapotRound: true,
      outcomeLabel: 'Направена', outcomeShortLabel: 'Направена', outcome: 'made', counterMultiplier: 1,
    },
    matchEnded: { winnerTeam, targetScore: 151, finalScore: pts, endedAt: Date.now() },
    score: {
      round: { tricks: emptyScore, declarations: emptyScore, belote: emptyScore, lastTen: emptyScore, capot: emptyScore, total: emptyScore },
      match: pts, carryOver: { teamA: 0, teamB: 0 },
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  } as unknown as ServerAuthoritativeGameState
}
function makeBelotRoom(roomId: string, seatProfiles: Record<Seat, string>): ServerRoom {
  return {
    id: roomId, status: 'playing', createdAt: 0, updatedAt: 0, hostPlayerId: null,
    config: {
      maxPlayers: 4, allowBots: true, isPrivate: false, joinCode: null,
      stakeAmount: null, targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 30000,
    },
    seats: {
      bottom: makeSeat('bottom', 'A', makeHumanParticipant(seatProfiles.bottom)),
      top: makeSeat('top', 'A', makeHumanParticipant(seatProfiles.top)),
      right: makeSeat('right', 'B', makeHumanParticipant(seatProfiles.right)),
      left: makeSeat('left', 'B', makeHumanParticipant(seatProfiles.left)),
    },
    game: {
      phase: 'match-ended', stateVersion: 1, startedAt: 0, updatedAt: 0,
      activeTimerId: null, timerDeadlineAt: null, authoritativeState: makeMatchEndedState('A'),
    },
    replayVotes: [], leaveVotes: [],
  } as unknown as ServerRoom
}

await check('[D1] recordCompletedMatch(room) продължава да дава +1 completed / +1 won само за печелившия отбор', () => {
  const seatProfiles: Record<Seat, string> = {
    bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID(),
  }
  for (const [seat, profileId] of Object.entries(seatProfiles)) {
    insertProfile(profileId, `D1 ${seat}`)
  }
  const room = makeBelotRoom(`belot-room-${randomUUID()}`, seatProfiles)
  store.recordCompletedMatch(room)

  // Team A (bottom/top) спечели (winnerTeam:'A' в makeMatchEndedState)
  assert.equal(getProgress(seatProfiles.bottom).completed_games_count, 1)
  assert.equal(getProgress(seatProfiles.bottom).won_games_count, 1)
  assert.equal(getProgress(seatProfiles.top).completed_games_count, 1)
  assert.equal(getProgress(seatProfiles.top).won_games_count, 1)
  // Team B (right/left) загуби
  assert.equal(getProgress(seatProfiles.right).completed_games_count, 1)
  assert.equal(getProgress(seatProfiles.right).won_games_count, 0)
  assert.equal(getProgress(seatProfiles.left).completed_games_count, 1)
  assert.equal(getProgress(seatProfiles.left).won_games_count, 0)
})

// ═══════════════════════════════════════════════════════════════════════
// E1-E3: source review (index.ts wiring + migration)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== E1-E3: source review ===')

const projectServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? serverRoot)
const indexSrc = readFileSync(resolve(projectServerRoot, 'src/index.ts'), 'utf8')

await check('[E1] index.ts вика recordCompletedGameForProfile(...) вътре в status===\'finished\' guard-а', () => {
  const finishedBlockMatch = /if \(snapshot\.state\.status === 'finished'\) \{\s*for \(const player of snapshot\.players\) \{\s*playerProgressStore\.recordCompletedGameForProfile\(snapshot\.matchId, player\.profileId, 'ludo_match'\)/.exec(indexSrc)
  assert.ok(finishedBlockMatch, 'очакван е блок, който итерира snapshot.players и вика recordCompletedGameForProfile само при status===finished')
})

await check('[E2] Новият progression блок НЕ реферира won_games_count/didWin в РЕАЛЕН код (doc коментарите, обясняващи why-not, са ОК)', () => {
  const blockStart = indexSrc.indexOf('// Level/rank progression (виж task-а')
  assert.ok(blockStart >= 0, 'очакван е doc коментар за Level/rank progression блока')
  const blockEnd = indexSrc.indexOf('const protocolSnapshot = toLudoGameProtocolSnapshot(snapshot)', blockStart)
  const block = indexSrc.slice(blockStart, blockEnd)
  // [^\n]* (не \r\n-aware `.*$` per-line split) — файлът е CRLF, а `.`/`$`
  // без `m` flag не третират \r специално, значи наивен per-line `.*$` strip
  // мълчаливо не съвпада на редове, завършващи с \r, и оставя коментара
  // недокоснат.
  const codeOnly = block.replace(/\/\/[^\n]*/g, '')
  assert.ok(!/won_games_count/.test(codeOnly), 'progression блокът не бива да реферира won_games_count в реален код (извън коментари)')
  assert.ok(!/didWin\s*:\s*true/.test(codeOnly), 'progression блокът не бива да подава didWin:true никъде')
})

await check('[E3] Миграция 20260927_001 дефинира profile_completed_game_ledger с PRIMARY KEY (scope_id, profile_id)', () => {
  const migrationPath = resolve(migrationsDir, '20260927_001_create_profile_completed_game_ledger.sql')
  const migrationSrc = readFileSync(migrationPath, 'utf8')
  assert.ok(/CREATE TABLE IF NOT EXISTS profile_completed_game_ledger/.test(migrationSrc))
  assert.ok(/PRIMARY KEY \(scope_id, profile_id\)/.test(migrationSrc))
})

rawDb.close()
store.close()
await rm(dbDir, { recursive: true, force: true })

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1

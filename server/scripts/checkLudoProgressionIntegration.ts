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
 *     source, didWin) — game-agnostic idempotent completed/won helper.
 *     Идемпотентен чрез profile_completed_game_ledger PRIMARY KEY
 *     (scope_id, profile_id) — миграция 20260927_001 — и did_win флага —
 *     миграция 20260928_002 (did_win 0->1 дава само won +1).
 *   - server/src/index.ts::recordLudoMatchProgression(snapshot) вика тая
 *     функция за ВСЕКИ snapshot.players запис с
 *     didWin = player.color === winnerColor, ЕДИНСТВЕНО когато
 *     snapshot.state.status === 'finished' — от onSnapshot (normal finish)
 *     И от boot recovery за вече finished snapshot.
 *   - playerProgressStore.reconcileLudoMatchWins() — backfill само за
 *     съществуващи Ludo ledger редове (мачове отпреди 007130f не влизат).
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
 *   [A5] Губещ (didWin:false) -> completed +1, won_games_count НЕ се пипа
 *   [A7] Победител (didWin:true) -> completed +1, won +1; повторен call -> no-op
 *   [A8] Ledger ред с did_win=0, после didWin:true -> само won +1; трети
 *        call -> пълен no-op
 *   [A9] Съществуващ ред + didWin:false -> no-op (не "отнема" победа)
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
 *   [C4] Forfeit winner -> won +1, forfeit-нал губещ -> won +0
 *   [C5] Нормална победа (4 играча, winnerColor) -> само победителят won +1
 *   [C6] Recovery: finished snapshot, обработен от normal finish И от boot
 *        recovery -> completed/won точно веднъж
 *   [C7] Recovery: crash ПРЕДИ progression записа -> recovery записва точно веднъж
 *
 *   [E1] Source review — index.ts::recordLudoMatchProgression вика
 *        recordCompletedGameForProfile(..., player.color === winnerColor)
 *        вътре в status==='finished' guard-а (без hardcoded false)
 *   [E2] Source review — onSnapshot И boot recovery викат
 *        recordLudoMatchProgression ПРЕДИ markMatchRemoved; старият inline
 *        блок е премахнат (единствен call site към store-а). Фаза 3
 *        (кампании) добавя campaignCredited като трети, успореден gate на
 *        СЪЩИЯ markMatchRemoved call — проверката е обновена да го очаква.
 *   [E3] Source review — миграцията 20260927_001 дефинира
 *        profile_completed_game_ledger с PRIMARY KEY (scope_id, profile_id)
 *   [E4] Source review — миграцията 20260928_002 добавя did_win
 *        INTEGER NOT NULL DEFAULT 0
 *
 *   [F1] Reconciliation "Shtura": 2 Ludo ledger реда (1 спечелен) ->
 *        preview 1 победа -> apply -> 2 completed / 1 won
 *   [F2] Второ reconciliation изпълнение -> 0 промени
 *   [F3] Finished Ludo мач БЕЗ ledger ред (pre-007130f) -> не се backfill-ва
 *   [F4] winner_profile_id=NULL -> не се пипа
 *   [F5] Loser ledger ред -> не получава win
 *   [F6] Не-Ludo source със същия scope_id -> не се пипа
 *   [F7] Preview е read-only (нищо не се променя)
 *
 *   [G1] Progression DB failure -> ok:false, rollback, finished snapshot
 *        остава в active_ludo_match_snapshots; следващ recovery записва
 *        точно веднъж и маха snapshot-а
 *   [G2] Повторен fail при recovery -> snapshot остава; после успех ->
 *        точно веднъж; допълнителен boot -> no-op
 *   [G3] Частичен fail (един от участниците) -> recovery довършва само
 *        липсващия, без второ +1 за вече записания
 *   [G4] Hard-deleted profile -> ok:true no-op, не задържа snapshot-а завинаги
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
import { createActiveLudoMatchSnapshotStore } from '../src/db/activeLudoMatchSnapshotStore.js'
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
  // Plain object — node:sqlite връща null-prototype редове, които
  // assert.deepEqual не приема за равни на литерал.
  return {
    completed_games_count: row?.completed_games_count ?? 0,
    won_games_count: row?.won_games_count ?? 0,
  }
}

function getLevelAndTitle(profileId: string): { level: number; rankTitle: string | null } {
  const row = rawDb
    .prepare(`SELECT level, rank_title FROM profiles WHERE profile_id = ?`)
    .get(profileId) as { level: number; rank_title: string | null }
  return { level: row.level, rankTitle: row.rank_title }
}

function getLedgerDidWin(scopeId: string, profileId: string): number | null {
  const row = rawDb
    .prepare(`SELECT did_win FROM profile_completed_game_ledger WHERE scope_id = ? AND profile_id = ?`)
    .get(scopeId, profileId) as { did_win: number } | undefined
  return row?.did_win ?? null
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
  const result = store.recordCompletedGameForProfile('match-a1', profileId, 'ludo_match', false)
  assert.equal(result.recorded, true)
  assert.equal(getProgress(profileId).completed_games_count, 1)
})

await check('[A2] Втори call СЪЩИЯ (scopeId, profileId) -> recorded:false, count ОСТАВА 1', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A2 Player')
  store.recordCompletedGameForProfile('match-a2', profileId, 'ludo_match', false)
  const second = store.recordCompletedGameForProfile('match-a2', profileId, 'ludo_match', false)
  assert.equal(second.recorded, false)
  assert.equal(getProgress(profileId).completed_games_count, 1, 'duplicate completion не бива да дава второ +1')
})

await check('[A3] Различен scopeId (нов match), СЪЩИЯ profile -> recorded:true, count 1->2', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A3 Player')
  store.recordCompletedGameForProfile('match-a3-first', profileId, 'ludo_match', false)
  const second = store.recordCompletedGameForProfile('match-a3-second', profileId, 'ludo_match', false)
  assert.equal(second.recorded, true, 'нов match за същия profile трябва да дава ново +1 (idempotency е per-scope, не permanent block)')
  assert.equal(getProgress(profileId).completed_games_count, 2)
})

await check('[A4] Двама реални участници на един match -> и двамата +1', () => {
  const profileA = randomUUID()
  const profileB = randomUUID()
  insertProfile(profileA, 'A4 Player A')
  insertProfile(profileB, 'A4 Player B')
  const scopeId = 'match-a4'
  store.recordCompletedGameForProfile(scopeId, profileA, 'ludo_match', false)
  store.recordCompletedGameForProfile(scopeId, profileB, 'ludo_match', false)
  assert.equal(getProgress(profileA).completed_games_count, 1)
  assert.equal(getProgress(profileB).completed_games_count, 1)
})

await check('[A5] Губещ (didWin:false) -> completed +1, won_games_count НЕ се пипа', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A5 Player')
  seedProgress(profileId, 10, 5, 10)
  const result = store.recordCompletedGameForProfile('match-a5', profileId, 'ludo_match', false)
  assert.deepEqual(result, { ok: true, recorded: true, winRecorded: false })
  const progress = getProgress(profileId)
  assert.equal(progress.completed_games_count, 11, 'completed_games_count трябва да се качи')
  assert.equal(progress.won_games_count, 5, 'губещ не получава победа')
  assert.equal(getLedgerDidWin('match-a5', profileId), 0)
})

await check('[A7] Победител (didWin:true) -> completed +1 / won +1; повторен call -> no-op', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A7 Player')
  seedProgress(profileId, 10, 5, 10)
  const first = store.recordCompletedGameForProfile('match-a7', profileId, 'ludo_match', true)
  assert.deepEqual(first, { ok: true, recorded: true, winRecorded: true })
  assert.deepEqual(getProgress(profileId), { completed_games_count: 11, won_games_count: 6 })
  assert.equal(getLedgerDidWin('match-a7', profileId), 1)
  const second = store.recordCompletedGameForProfile('match-a7', profileId, 'ludo_match', true)
  assert.deepEqual(second, { ok: true, recorded: false, winRecorded: false })
  assert.deepEqual(getProgress(profileId), { completed_games_count: 11, won_games_count: 6 })
})

await check('[A8] Ledger ред did_win=0, после didWin:true -> само won +1; трети call -> no-op', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A8 Player')
  store.recordCompletedGameForProfile('match-a8', profileId, 'ludo_match', false)
  assert.deepEqual(getProgress(profileId), { completed_games_count: 1, won_games_count: 0 })
  const upgrade = store.recordCompletedGameForProfile('match-a8', profileId, 'ludo_match', true)
  assert.deepEqual(upgrade, { ok: true, recorded: false, winRecorded: true })
  assert.deepEqual(getProgress(profileId), { completed_games_count: 1, won_games_count: 1 }, 'completed НЕ се променя, само won +1')
  assert.equal(getLedgerDidWin('match-a8', profileId), 1)
  const third = store.recordCompletedGameForProfile('match-a8', profileId, 'ludo_match', true)
  assert.deepEqual(third, { ok: true, recorded: false, winRecorded: false })
  assert.deepEqual(getProgress(profileId), { completed_games_count: 1, won_games_count: 1 })
})

await check('[A9] Съществуващ ред did_win=1 + didWin:false -> no-op (не отнема победа)', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A9 Player')
  store.recordCompletedGameForProfile('match-a9', profileId, 'ludo_match', true)
  const again = store.recordCompletedGameForProfile('match-a9', profileId, 'ludo_match', false)
  assert.deepEqual(again, { ok: true, recorded: false, winRecorded: false })
  assert.deepEqual(getProgress(profileId), { completed_games_count: 1, won_games_count: 1 })
  assert.equal(getLedgerDidWin('match-a9', profileId), 1)
})

await check('[A6] Threshold: profile на 299 completed games -> Ludo завършва -> 300 -> level 26, rankTitle "Напреднал"', () => {
  const profileId = randomUUID()
  insertProfile(profileId, 'A6 Player')
  seedProgress(profileId, 299, 0, 25)
  rawDb.prepare(`UPDATE profiles SET level = 25, rank_title = 'Напреднал' WHERE profile_id = ?`).run(profileId)
  const result = store.recordCompletedGameForProfile('match-a6', profileId, 'ludo_match', false)
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

// Mirror ТОЧНО на server/src/index.ts::recordLudoMatchProgression (викан от
// onSnapshot И от boot recovery): итерира snapshot.players, вика
// recordCompletedGameForProfile per player с didWin = color === winnerColor,
// само когато snapshot.state.status === 'finished'.
function applyProgressionWiring(snapshot: LudoMatchSnapshot): boolean {
  if (snapshot.state.status !== 'finished') return true
  let allRecorded = true
  for (const player of snapshot.players) {
    const result = store.recordCompletedGameForProfile(
      snapshot.matchId,
      player.profileId,
      'ludo_match',
      player.color === snapshot.state.winnerColor,
    )
    if (!result.ok) allRecorded = false
  }
  return allRecorded
}

// Реален forfeit-finished snapshot (loser напуска -> winner остава).
function createForfeitFinishedSnapshot(label: string, winnerProfile: string, loserProfile: string): LudoMatchSnapshot {
  let finished: LudoMatchSnapshot | null = null
  const runtime = createLudoMatchRuntime({
    now: () => 950_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => { if (snapshot.state.status === 'finished') finished = snapshot },
  })
  const room: LudoRoom = {
    id: `ludo-room-${label}`, stake: 100, playerCount: 2, manualStart: false,
    hostProfileId: winnerProfile, createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: winnerProfile, displayName: 'Winner', avatarUrl: null },
      { connectionId: 'c2', profileId: loserProfile, displayName: 'Loser', avatarUrl: null },
    ],
  }
  const started = runtime.createMatch(room, `ludo-match-${label}-${randomUUID()}`)
  runtime.leave(started.matchId, loserProfile)
  runtime.destroy()
  assert.ok(finished !== null, 'мачът трябва реално да завърши (last-player-standing forfeit)')
  return finished!
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

await check('[C4] Forfeit winner -> won +1; forfeit-нал губещ -> won +0', () => {
  const profileWinner = `ludo-c4-winner-${randomUUID()}`
  const profileLoser = `ludo-c4-loser-${randomUUID()}`
  insertProfile(profileWinner, 'C4 Winner')
  insertProfile(profileLoser, 'C4 Loser')
  const finished = createForfeitFinishedSnapshot('c4', profileWinner, profileLoser)
  const winnerColor = finished.state.winnerColor
  assert.ok(winnerColor !== null, 'forfeit трябва да зададе winnerColor')
  assert.equal(finished.players.find((p) => p.color === winnerColor)?.profileId, profileWinner)

  applyProgressionWiring(finished)

  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
})

await check('[C5] Нормална победа (4 играча) -> само winnerColor получава won +1', () => {
  const colors = ['red', 'green', 'yellow', 'blue'] as const
  const profiles = colors.map((color) => `ludo-c5-${color}-${randomUUID()}`)
  profiles.forEach((profileId, index) => insertProfile(profileId, `C5 ${colors[index]}`))
  const snapshot = {
    matchId: `ludo-match-c5-${randomUUID()}`,
    players: colors.map((color, index) => ({ profileId: profiles[index]!, color })),
    state: { status: 'finished', winnerColor: 'yellow' },
  } as unknown as LudoMatchSnapshot

  applyProgressionWiring(snapshot)

  profiles.forEach((profileId, index) => {
    assert.deepEqual(
      getProgress(profileId),
      { completed_games_count: 1, won_games_count: colors[index] === 'yellow' ? 1 : 0 },
      `${colors[index]} progression`,
    )
  })
})

await check('[C6] Recovery: normal finish + boot recovery на СЪЩИЯ finished snapshot -> точно веднъж', () => {
  const profileWinner = `ludo-c6-winner-${randomUUID()}`
  const profileLoser = `ludo-c6-loser-${randomUUID()}`
  insertProfile(profileWinner, 'C6 Winner')
  insertProfile(profileLoser, 'C6 Loser')
  const finished = createForfeitFinishedSnapshot('c6', profileWinner, profileLoser)

  applyProgressionWiring(finished) // onSnapshot
  // Boot recovery получава snapshot-а от active_ludo_match_snapshots (JSON round-trip)
  applyProgressionWiring(JSON.parse(JSON.stringify(finished)) as LudoMatchSnapshot)

  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
})

await check('[C7] Recovery: crash ПРЕДИ progression записа -> recovery записва точно веднъж', () => {
  const profileWinner = `ludo-c7-winner-${randomUUID()}`
  const profileLoser = `ludo-c7-loser-${randomUUID()}`
  insertProfile(profileWinner, 'C7 Winner')
  insertProfile(profileLoser, 'C7 Loser')
  const finished = createForfeitFinishedSnapshot('c7', profileWinner, profileLoser)
  const persisted = JSON.parse(JSON.stringify(finished)) as LudoMatchSnapshot

  applyProgressionWiring(persisted) // първи boot
  applyProgressionWiring(persisted) // повторен boot (напр. markMatchRemoved е fail-нал)

  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
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

await check('[E1] index.ts::recordLudoMatchProgression вика recordCompletedGameForProfile(..., player.color === winnerColor) само при status===finished', () => {
  const helperMatch = /function recordLudoMatchProgression\(snapshot: LudoMatchSnapshot\): boolean \{\s*if \(snapshot\.state\.status !== 'finished'\) return true\s*let allRecorded = true\s*for \(const player of snapshot\.players\) \{\s*const result = playerProgressStore\.recordCompletedGameForProfile\(\s*snapshot\.matchId,\s*player\.profileId,\s*'ludo_match',\s*player\.color === snapshot\.state\.winnerColor,\s*\)/.exec(indexSrc)
  assert.ok(helperMatch, 'очакван е helper, който итерира snapshot.players и подава didWin = player.color === winnerColor')
  // [^\n]* strip на коментари — файлът е CRLF, виж коментара в E2.
  const codeOnly = indexSrc.replace(/\/\/[^\n]*/g, '')
  assert.ok(!/recordCompletedGameForProfile\([^)]*'ludo_match',\s*false\s*\)/.test(codeOnly), 'hardcoded didWin=false не бива да съществува')
})

await check('[E2] onSnapshot И boot recovery викат recordLudoMatchProgression ПРЕДИ markMatchRemoved; единствен store call site', () => {
  // [^\n]* (не `.*$`) — файлът е CRLF, `.`/`$` без `m` flag не третират \r
  // специално.
  const codeOnly = indexSrc.replace(/\/\/[^\n]*/g, '')
  const storeCalls = codeOnly.match(/playerProgressStore\.recordCompletedGameForProfile\(/g) ?? []
  assert.equal(storeCalls.length, 1, 'recordCompletedGameForProfile трябва да се вика само от recordLudoMatchProgression')

  const onSnapshotStart = codeOnly.indexOf('const ludoMatchRuntime = createLudoMatchRuntime({')
  assert.ok(onSnapshotStart >= 0)
  const onSnapshotProgression = codeOnly.indexOf('const progressionRecorded = recordLudoMatchProgression(snapshot)', onSnapshotStart)
  // Фаза 3 (кампании) добавя трети, успореден gate (campaignCredited) върху
  // СЪЩИЯ markMatchRemoved call — виж campaignGameHooks.ts doc коментара:
  // reuse-ва точно тоя "пази реда, ако side effect fail-не" trick, за да
  // наследи campaign crediting-ът СЪЩАТА boot-recovery retry гаранция,
  // без нов отделен механизъм. progressionRecorded продължава да е ЕДИН от
  // гейтовете (не е заменен), затова проверката тук си остава валидна.
  const onSnapshotRemoveGuard = codeOnly.indexOf("if (snapshot.state.status === 'finished' && winnerPayout !== null && progressionRecorded && campaignCredited) {", onSnapshotStart)
  const onSnapshotRemove = codeOnly.indexOf('activeLudoMatchSnapshotStore.markMatchRemoved(snapshot.matchId)', onSnapshotStart)
  assert.ok(onSnapshotProgression > onSnapshotStart && onSnapshotProgression < onSnapshotRemove, 'onSnapshot: progression трябва да е преди snapshot cleanup-а')
  assert.ok(onSnapshotRemoveGuard > onSnapshotProgression && onSnapshotRemoveGuard < onSnapshotRemove, 'onSnapshot: markMatchRemoved трябва да е guard-нат и от progressionRecorded (и Фаза 3: campaignCredited)')

  const recoveryStart = codeOnly.indexOf('for (const persisted of restoredLudoMatches) {')
  assert.ok(recoveryStart >= 0)
  const recoveryProgression = codeOnly.indexOf('const progressionRecorded = recordLudoMatchProgression(persisted)', recoveryStart)
  const recoveryRemoveGuard = codeOnly.indexOf('if (winnerPayout !== null && progressionRecorded && campaignCredited) {', recoveryStart)
  const recoveryRemove = codeOnly.indexOf('activeLudoMatchSnapshotStore.markMatchRemoved(persisted.matchId)', recoveryStart)
  assert.ok(recoveryProgression > recoveryStart && recoveryProgression < recoveryRemove, 'recovery: progression трябва да е преди snapshot cleanup-а')
  assert.ok(recoveryRemoveGuard > recoveryProgression && recoveryRemoveGuard < recoveryRemove, 'recovery: markMatchRemoved трябва да е guard-нат и от progressionRecorded (и Фаза 3: campaignCredited)')

  const helperBody = codeOnly.slice(codeOnly.indexOf('function recordLudoMatchProgression('), onSnapshotStart)
  assert.ok(/if \(!result\.ok\) allRecorded = false/.test(helperBody), 'helper-ът трябва да връща false при ok:false')
})

await check('[E3] Миграция 20260927_001 дефинира profile_completed_game_ledger с PRIMARY KEY (scope_id, profile_id)', () => {
  const migrationPath = resolve(migrationsDir, '20260927_001_create_profile_completed_game_ledger.sql')
  const migrationSrc = readFileSync(migrationPath, 'utf8')
  assert.ok(/CREATE TABLE IF NOT EXISTS profile_completed_game_ledger/.test(migrationSrc))
  assert.ok(/PRIMARY KEY \(scope_id, profile_id\)/.test(migrationSrc))
})

await check('[E4] Миграция 20260928_002 добавя did_win INTEGER NOT NULL DEFAULT 0', () => {
  const migrationSrc = readFileSync(resolve(migrationsDir, '20260928_002_add_did_win_to_profile_completed_game_ledger.sql'), 'utf8')
  assert.ok(/ALTER TABLE profile_completed_game_ledger\s+ADD COLUMN did_win INTEGER NOT NULL DEFAULT 0/.test(migrationSrc))
  const columns = rawDb.prepare(`SELECT name, dflt_value, "notnull" AS not_null FROM pragma_table_info('profile_completed_game_ledger')`).all() as Array<{ name: string; dflt_value: string | null; not_null: number }>
  const didWin = columns.find((column) => column.name === 'did_win')
  assert.ok(didWin, 'did_win колоната трябва да съществува')
  assert.equal(didWin!.dflt_value, '0')
  assert.equal(didWin!.not_null, 1)
})

// ═══════════════════════════════════════════════════════════════════════
// F1-F7: reconciliation на вече записаните Ludo мачове
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== F1-F7: reconcileLudoMatchWins ===')

// F-тестовете ползват собствена изолирана база — reconciliation-ът е
// глобален (всички ledger редове), а A/C секциите по-горе умишлено оставят
// did_win=0 ledger редове без ludo_room_matches ред.
const reconDbPath = join(dbDir, 'reconciliation.db')
await applyMigrations(reconDbPath)
const reconStore = await createPlayerProgressStore(reconDbPath)
const reconDb = new DatabaseSync(reconDbPath, { open: true })

function reconInsertProfile(profileId: string, displayName: string): void {
  reconDb
    .prepare(
      `INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status
      ) VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active')`,
    )
    .run(profileId, displayName, displayName.toLowerCase())
  reconDb
    .prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 0, 0, 1)`)
    .run(profileId)
}

function reconInsertLudoMatch(matchId: string, playerIds: string[], winnerProfileId: string | null, status: 'playing' | 'finished' = 'finished'): void {
  reconDb
    .prepare(
      `INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at)
       VALUES (?, ?, ?, 100, 2, ?, ?, CASE WHEN ? = 'finished' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    )
    .run(matchId, `room-${matchId}`, status, JSON.stringify(playerIds.map((profileId) => ({ profileId }))), winnerProfileId, status)
}

// Симулира 007130f поведението: ledger ред + completed +1, did_win=0.
function reconRecordLegacyLudoCompletion(matchId: string, profileId: string, source = 'ludo_match'): void {
  reconStore.recordCompletedGameForProfile(matchId, profileId, source, false)
}

function reconGetProgress(profileId: string): ProgressRow {
  const row = reconDb
    .prepare(`SELECT completed_games_count, won_games_count FROM profile_progress WHERE profile_id = ?`)
    .get(profileId) as ProgressRow
  return { completed_games_count: row.completed_games_count, won_games_count: row.won_games_count }
}

function reconSnapshotTables(): string {
  const ledger = reconDb.prepare(`SELECT scope_id, profile_id, source, did_win FROM profile_completed_game_ledger ORDER BY scope_id, profile_id`).all()
  const progress = reconDb.prepare(`SELECT profile_id, completed_games_count, won_games_count, rank_level FROM profile_progress ORDER BY profile_id`).all()
  return JSON.stringify({ ledger, progress })
}

const shtura = 'recon-shtura'
const trento = 'recon-trento76'
const moriss = 'recon-moriss88'
const preOldMatchPlayer = 'recon-pre-007130f'
const nullWinnerPlayerA = 'recon-null-winner-a'
const nullWinnerPlayerB = 'recon-null-winner-b'
const otherSourcePlayer = 'recon-other-source'
reconInsertProfile(shtura, 'Shtura')
reconInsertProfile(trento, 'Trento76')
reconInsertProfile(moriss, 'Moriss88')
reconInsertProfile(preOldMatchPlayer, 'PreOld')
reconInsertProfile(nullWinnerPlayerA, 'NullA')
reconInsertProfile(nullWinnerPlayerB, 'NullB')
reconInsertProfile(otherSourcePlayer, 'OtherSource')

// Shtura vs Trento76 — Shtura печели; Shtura vs Moriss88 — Moriss88 печели.
reconInsertLudoMatch('recon-match-1', [shtura, trento], shtura)
reconInsertLudoMatch('recon-match-2', [shtura, moriss], moriss)
for (const [matchId, players] of [['recon-match-1', [shtura, trento]], ['recon-match-2', [shtura, moriss]]] as const) {
  for (const profileId of players) reconRecordLegacyLudoCompletion(matchId, profileId)
}
// Pre-007130f мач: finished с победител, но БЕЗ ledger ред.
reconInsertLudoMatch('recon-match-pre-007130f', [preOldMatchPlayer, trento], preOldMatchPlayer)
// winner_profile_id = NULL.
reconInsertLudoMatch('recon-match-null-winner', [nullWinnerPlayerA, nullWinnerPlayerB], null)
reconRecordLegacyLudoCompletion('recon-match-null-winner', nullWinnerPlayerA)
reconRecordLegacyLudoCompletion('recon-match-null-winner', nullWinnerPlayerB)
// Не-Ludo source със scope_id, който съвпада с Ludo match_id.
reconInsertLudoMatch('recon-match-other-source', [otherSourcePlayer], otherSourcePlayer)
reconRecordLegacyLudoCompletion('recon-match-other-source', otherSourcePlayer, 'other_source')

await check('[F7] Preview е read-only и показва точно липсващите победи', () => {
  const before = reconSnapshotTables()
  const preview = reconStore.previewLudoMatchWinReconciliation()
  assert.deepEqual(preview, {
    profiles: [
      { profileId: moriss, displayName: 'Moriss88', missingWins: 1 },
      { profileId: shtura, displayName: 'Shtura', missingWins: 1 },
    ],
    totalProfiles: 2,
    totalMissingWins: 2,
  })
  assert.equal(reconSnapshotTables(), before, 'preview не бива да променя DB')
})

await check('[F1] Reconciliation "Shtura": 2 completed / 0 won -> 2 completed / 1 won', () => {
  assert.deepEqual(reconGetProgress(shtura), { completed_games_count: 2, won_games_count: 0 }, 'изходно състояние като в production')
  const result = reconStore.reconcileLudoMatchWins()
  assert.deepEqual(result, { profilesAffected: 2, winsReconciled: 2 })
  assert.deepEqual(reconGetProgress(shtura), { completed_games_count: 2, won_games_count: 1 })
  assert.deepEqual(reconGetProgress(moriss), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(reconGetProgress(trento), { completed_games_count: 1, won_games_count: 0 })
})

await check('[F2] Второ reconciliation изпълнение -> 0 промени', () => {
  const before = reconSnapshotTables()
  assert.deepEqual(reconStore.reconcileLudoMatchWins(), { profilesAffected: 0, winsReconciled: 0 })
  assert.equal(reconSnapshotTables(), before)
  assert.equal(reconStore.previewLudoMatchWinReconciliation().totalMissingWins, 0)
})

await check('[F3] Finished Ludo мач без ledger ред (pre-007130f) -> НЕ се backfill-ва', () => {
  assert.deepEqual(reconGetProgress(preOldMatchPlayer), { completed_games_count: 0, won_games_count: 0 })
  const ledgerRows = reconDb.prepare(`SELECT COUNT(*) AS n FROM profile_completed_game_ledger WHERE scope_id = 'recon-match-pre-007130f'`).get() as { n: number }
  assert.equal(ledgerRows.n, 0, 'reconciliation не бива да създава нови ledger редове')
})

await check('[F4] winner_profile_id = NULL -> не се пипа', () => {
  assert.deepEqual(reconGetProgress(nullWinnerPlayerA), { completed_games_count: 1, won_games_count: 0 })
  assert.deepEqual(reconGetProgress(nullWinnerPlayerB), { completed_games_count: 1, won_games_count: 0 })
})

await check('[F5] Loser ledger ред -> не получава win', () => {
  const loserRow = reconDb.prepare(`SELECT did_win FROM profile_completed_game_ledger WHERE scope_id = 'recon-match-1' AND profile_id = ?`).get(trento) as { did_win: number }
  assert.equal(loserRow.did_win, 0)
  const shturaLoss = reconDb.prepare(`SELECT did_win FROM profile_completed_game_ledger WHERE scope_id = 'recon-match-2' AND profile_id = ?`).get(shtura) as { did_win: number }
  assert.equal(shturaLoss.did_win, 0)
})

await check('[F6] Не-Ludo source със същия scope_id -> не се пипа', () => {
  assert.deepEqual(reconGetProgress(otherSourcePlayer), { completed_games_count: 1, won_games_count: 0 })
})

reconDb.close()
reconStore.close()

// ═══════════════════════════════════════════════════════════════════════
// G1-G4: progression DB failure -> finished snapshot остава recoverable
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== G1-G4: progression failure -> snapshot retention -> recovery ===')

const snapshotStore = await createActiveLudoMatchSnapshotStore(dbPath)

// Mirror на index.ts finished lifecycle-а (onSnapshot И boot recovery):
// persist -> settle -> progression -> markMatchRemoved само ако payout И
// progression са успешни. payoutOk симулира settleLudoMatchIfNeeded() !== null
// (ledger-guarded idempotent payout, покрит от checkLudoEconomy).
function applyFinishedLifecycle(snapshot: LudoMatchSnapshot, options: { persist: boolean; payoutOk?: boolean }): boolean {
  if (options.persist) snapshotStore.upsertMatch(snapshot)
  const progressionRecorded = applyProgressionWiring(snapshot)
  if (snapshot.state.status === 'finished' && (options.payoutOk ?? true) && progressionRecorded) {
    snapshotStore.markMatchRemoved(snapshot.matchId)
  }
  return progressionRecorded
}

function simulateBootRecovery(): void {
  for (const persisted of snapshotStore.loadActiveMatches()) {
    if (persisted.state.status === 'finished') applyFinishedLifecycle(persisted, { persist: false })
  }
}

function isSnapshotRetained(matchId: string): boolean {
  return snapshotStore.loadActiveMatches().some((snapshot) => snapshot.matchId === matchId)
}

// Симулирана временна DB грешка — SQLite trigger, който abort-ва ledger
// insert-а за конкретен profile; DROP-ът симулира "грешката отмина".
function injectLedgerFailure(profileId: string): () => void {
  const triggerName = `fail_ledger_${randomUUID().replace(/-/g, '')}`
  rawDb.exec(`
    CREATE TRIGGER ${triggerName}
    BEFORE INSERT ON profile_completed_game_ledger
    WHEN NEW.profile_id = '${profileId}'
    BEGIN SELECT RAISE(ABORT, 'simulated transient DB failure'); END;
  `)
  return () => rawDb.exec(`DROP TRIGGER ${triggerName};`)
}

await check('[G1] progression DB failure -> ok:false, нищо не е записано, finished snapshot остава recoverable', () => {
  const profileWinner = `ludo-g1-winner-${randomUUID()}`
  const profileLoser = `ludo-g1-loser-${randomUUID()}`
  insertProfile(profileWinner, 'G1 Winner')
  insertProfile(profileLoser, 'G1 Loser')
  const finished = createForfeitFinishedSnapshot('g1', profileWinner, profileLoser)
  const clearWinnerFailure = injectLedgerFailure(profileWinner)
  const clearLoserFailure = injectLedgerFailure(profileLoser)
  try {
    const recorded = applyFinishedLifecycle(finished, { persist: true })
    assert.equal(recorded, false)
  } finally {
    clearWinnerFailure()
    clearLoserFailure()
  }
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 0, won_games_count: 0 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 0, won_games_count: 0 })
  assert.equal(getLedgerDidWin(finished.matchId, profileWinner), null, 'rollback — ledger ред не трябва да съществува')
  assert.ok(isSnapshotRetained(finished.matchId), 'finished snapshot НЕ бива да се маха при progression failure')

  // [G2] следващ boot recovery -> записва точно веднъж и маха snapshot-а
  simulateBootRecovery()
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
  assert.ok(!isSnapshotRetained(finished.matchId), 'след успешен recovery snapshot-ът трябва да е премахнат')
})

await check('[G2] Следващ recovery записва точно веднъж; трети boot -> no-op', () => {
  const profileWinner = `ludo-g2-winner-${randomUUID()}`
  const profileLoser = `ludo-g2-loser-${randomUUID()}`
  insertProfile(profileWinner, 'G2 Winner')
  insertProfile(profileLoser, 'G2 Loser')
  const finished = createForfeitFinishedSnapshot('g2', profileWinner, profileLoser)
  const clearFailure = injectLedgerFailure(profileWinner)
  try {
    applyFinishedLifecycle(finished, { persist: true })
    simulateBootRecovery() // грешката още е налице -> пак fail, snapshot остава
    assert.ok(isSnapshotRetained(finished.matchId), 'при повторен fail snapshot-ът остава за следващия boot')
  } finally {
    clearFailure()
  }
  simulateBootRecovery()
  simulateBootRecovery()
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
  assert.ok(!isSnapshotRetained(finished.matchId))
})

await check('[G3] Частичен fail (само победителят) -> губещият записан веднъж, победителят довършен при recovery', () => {
  const profileWinner = `ludo-g3-winner-${randomUUID()}`
  const profileLoser = `ludo-g3-loser-${randomUUID()}`
  insertProfile(profileWinner, 'G3 Winner')
  insertProfile(profileLoser, 'G3 Loser')
  const finished = createForfeitFinishedSnapshot('g3', profileWinner, profileLoser)
  const clearFailure = injectLedgerFailure(profileWinner)
  try {
    assert.equal(applyFinishedLifecycle(finished, { persist: true }), false)
  } finally {
    clearFailure()
  }
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 })
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 0, won_games_count: 0 })
  assert.ok(isSnapshotRetained(finished.matchId))

  simulateBootRecovery()
  assert.deepEqual(getProgress(profileLoser), { completed_games_count: 1, won_games_count: 0 }, 'губещият НЕ получава второ +1')
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.ok(!isSnapshotRetained(finished.matchId))
})

await check('[G4] Изтрит (hard delete) profile -> ok:true no-op, не блокира премахването на snapshot-а', () => {
  const profileWinner = `ludo-g4-winner-${randomUUID()}`
  const deletedProfile = `ludo-g4-deleted-${randomUUID()}`
  insertProfile(profileWinner, 'G4 Winner')
  insertProfile(deletedProfile, 'G4 Deleted')
  const finished = createForfeitFinishedSnapshot('g4', profileWinner, deletedProfile)
  rawDb.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run(deletedProfile)
  assert.deepEqual(
    store.recordCompletedGameForProfile(finished.matchId, deletedProfile, 'ludo_match', false),
    { ok: true, recorded: false, winRecorded: false },
  )
  assert.equal(applyFinishedLifecycle(finished, { persist: true }), true)
  assert.deepEqual(getProgress(profileWinner), { completed_games_count: 1, won_games_count: 1 })
  assert.ok(!isSnapshotRetained(finished.matchId))
})

snapshotStore.close()

rawDb.close()
store.close()
await rm(dbDir, { recursive: true, force: true })

console.log('\n' + '═'.repeat(75))
console.log(`Passed: ${passed}  Failed: ${failed}`)
console.log('═'.repeat(75) + '\n')
if (failed > 0) process.exitCode = 1

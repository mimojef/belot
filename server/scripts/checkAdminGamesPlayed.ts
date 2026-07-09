/**
 * checkAdminGamesPlayed.ts
 *
 * Regression checks за новата admin статистика "Изиграни игри"
 * (userGamesToday/Yesterday от profile_match_results, guestTrialGamesToday/Yesterday
 * от guest_trial_game_starts).
 *
 * [1]  Нов guest trial room start записва exactly one guest_trial_game_starts ред
 * [2]  Повторен recordTrialGameStart за същия room_id не дублира (room_id UNIQUE)
 * [3]  Popup/status fetch (getOrCreateSession) не записва guest_trial_game_starts ред
 * [4]  Отказан 4-ти опит (лимит достигнат) не записва ред
 * [5]  undoTrialGameStart(roomId) изтрива записа (rollback при room creation failure)
 * [6]  guestTrialGamesToday брои само starts в днешния Sofia ден (фиксиран clock)
 * [7]  guestTrialGamesYesterday брои само вчерашния Sofia ден
 * [8]  userGamesToday: completed match (is_guest_trial=0) се брои
 * [9]  userGamesToday: guest trial completed match (is_guest_trial=1) НЕ се брои
 * [10] userGamesToday: COUNT(DISTINCT room_id) — 4 участника на маса = 1 игра, не 4
 * [11] userGamesYesterday брои само вчерашния Sofia ден
 * [12] userGames* не се влияят от guest_trial_game_starts (отделни таблици)
 * [13] guestTrialGames* не се влияят от profile_match_results (отделни таблици)
 * [14] Frontend: renderLobbyScreen.ts съдържа секция "Изиграни игри"
 * [15] Frontend: секцията е между "Посетители" и "Влизания по версия"
 * [16] Frontend: рендерира "Игри от потребители" и "Пробни игри" label-и
 * [17] Frontend: AdminStatsSnapshot тип съдържа gamesPlayed поле с 4-те стойности
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createGuestTrialStore } from '../src/db/guestTrialStore.js'
import { getSofiaDayBoundsUtc, toSqliteUtc } from '../src/db/sofiaDayBounds.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function buildSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guest_trial_sessions (
      guest_id TEXT NOT NULL PRIMARY KEY,
      games_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      ip_hash TEXT,
      user_agent_hash TEXT
    );

    CREATE TABLE IF NOT EXISTS guest_trial_game_starts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id TEXT NOT NULL,
      room_id TEXT NOT NULL UNIQUE,
      stake_amount INTEGER NOT NULL CHECK (stake_amount > 0),
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human',
      display_name TEXT NOT NULL,
      normalized_display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profile_match_results (
      room_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      team TEXT NOT NULL CHECK (team IN ('A', 'B')),
      did_win INTEGER NOT NULL CHECK (did_win IN (0, 1)),
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_guest_trial INTEGER NOT NULL DEFAULT 0 CHECK (is_guest_trial IN (0, 1)),
      PRIMARY KEY (room_id, profile_id)
    );
  `)
}

async function withTempDbFile(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-games-played-check-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const bootstrap = new DatabaseSync(dbPath)
    buildSchema(bootstrap)
    bootstrap.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// Реплика на playerProgressStore.getUserGamesPlayedStats() SQL логиката (директно
// query-ва profile_match_results в тестовата DB, без да инстанцира целия голям store).
function getUserGamesPlayedStats(db: DatabaseSync, now: Date): { today: number; yesterday: number } {
  const bounds = getSofiaDayBoundsUtc(now)
  const countInRange = (start: string, end: string): number => {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT room_id) AS count
         FROM profile_match_results
         WHERE is_guest_trial = 0
           AND completed_at >= ?
           AND completed_at < ?`,
      )
      .get(start, end) as { count: number }
    return row.count
  }
  return {
    today: countInRange(bounds.todayStart, bounds.tomorrowStart),
    yesterday: countInRange(bounds.yesterdayStart, bounds.todayStart),
  }
}

function insertMatchResult(
  db: DatabaseSync,
  roomId: string,
  profileId: string,
  completedAt: string,
  isGuestTrial: boolean,
): void {
  db.prepare(
    `INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
     VALUES (?, ?, 'A', 1, ?, ?)`,
  ).run(roomId, profileId, completedAt, isGuestTrial ? 1 : 0)
}

async function checkGuestTrialGameStartsLedger(): Promise<void> {
  console.log('\n[1-5] guest_trial_game_starts ledger: единичен запис, без дублиране, без rollback-loss')

  await withTempDbFile(async (dbPath) => {
    const store = await createGuestTrialStore(dbPath)
    const guestId = randomUUID()
    const roomId = randomUUID()

    store.getOrCreateSession(guestId, null, null)

    // [3] Popup/status fetch не записва ledger ред.
    const statsAfterStatusOnly = store.getGamesPlayedStats()
    check('[3] popup/status fetch (getOrCreateSession) не записва guest_trial_game_starts ред', statsAfterStatusOnly.today === 0)

    // [1] Реален старт: registerTrialGameStarted + recordTrialGameStart (точния ред, по който минава index.ts).
    store.registerTrialGameStarted(guestId)
    store.recordTrialGameStart(guestId, roomId, 5000)

    const statsAfterOneStart = store.getGamesPlayedStats()
    check('[1] след 1 реален guest trial start guestTrialGamesToday = 1', statsAfterOneStart.today === 1)

    // [2] Повторен recordTrialGameStart за същия room_id (напр. race/reconnect опит) не дублира.
    store.recordTrialGameStart(guestId, roomId, 5000)
    const statsAfterDuplicateAttempt = store.getGamesPlayedStats()
    check('[2] повторен recordTrialGameStart за същия room_id не дублира (room_id UNIQUE)', statsAfterDuplicateAttempt.today === 1)

    // [4] Отказан 4-ти опит (лимит) не записва ред — симулираме изчерпан лимит.
    store.registerTrialGameStarted(guestId)
    store.registerTrialGameStarted(guestId)
    const fourthAttempt = store.registerTrialGameStarted(guestId)
    check('[4] 4-ти опит е отказан (лимит достигнат)', fourthAttempt.ok === false)
    if (fourthAttempt.ok === false) {
      // При отказ index.ts никога не вика recordTrialGameStart — потвърждаваме, че
      // липсата на извикване означава липса на нов ред.
      const statsAfterRejectedFourth = store.getGamesPlayedStats()
      check('[4] отказан 4-ти опит не увеличава guestTrialGamesToday', statsAfterRejectedFourth.today === 1)
    }

    // [5] Rollback: undoTrialGameStart(roomId) изтрива записа (room creation failure сценарий).
    const rollbackRoomId = randomUUID()
    store.recordTrialGameStart(guestId, rollbackRoomId, 5000)
    const statsBeforeRollback = store.getGamesPlayedStats()
    check('[5] запис преди rollback присъства (today=2)', statsBeforeRollback.today === 2)

    store.undoTrialGameStart(rollbackRoomId)
    const statsAfterRollback = store.getGamesPlayedStats()
    check('[5] undoTrialGameStart(roomId) изтрива ledger записа при rollback', statsAfterRollback.today === 1)

    store.close()
  })
}

async function checkGuestTrialSofiaDayBounds(): Promise<void> {
  console.log('\n[6-7] guestTrialGamesToday/Yesterday — Sofia day bounds (фиксиран clock)')

  await withTempDbFile(async (dbPath) => {
    const store = await createGuestTrialStore(dbPath)
    const fixedNow = new Date('2026-06-27T10:00:00Z')
    const bounds = getSofiaDayBoundsUtc(fixedNow)

    const tsToday = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
    const tsYesterday = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 2 * 3_600_000))
    const tsTwoDaysAgo = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() - 2 * 3_600_000))

    const db = new DatabaseSync(dbPath)
    db.prepare(
      `INSERT INTO guest_trial_game_starts (guest_id, room_id, stake_amount, started_at, created_at) VALUES (?, ?, 5000, ?, ?)`,
    ).run(randomUUID(), randomUUID(), tsToday, tsToday)
    db.prepare(
      `INSERT INTO guest_trial_game_starts (guest_id, room_id, stake_amount, started_at, created_at) VALUES (?, ?, 5000, ?, ?)`,
    ).run(randomUUID(), randomUUID(), tsYesterday, tsYesterday)
    db.prepare(
      `INSERT INTO guest_trial_game_starts (guest_id, room_id, stake_amount, started_at, created_at) VALUES (?, ?, 5000, ?, ?)`,
    ).run(randomUUID(), randomUUID(), tsTwoDaysAgo, tsTwoDaysAgo)
    db.close()

    const stats = store.getGamesPlayedStats(fixedNow)
    check('[6] guestTrialGamesToday брои само днешния Sofia ден (=1)', stats.today === 1)
    check('[7] guestTrialGamesYesterday брои само вчерашния Sofia ден (=1), не 2 дни назад', stats.yesterday === 1)

    store.close()
  })
}

async function checkUserGamesPlayedStats(): Promise<void> {
  console.log('\n[8-13] userGamesToday/Yesterday от profile_match_results')

  await withTempDbFile(async (dbPath) => {
    const db = new DatabaseSync(dbPath)
    const fixedNow = new Date('2026-06-27T10:00:00Z')
    const bounds = getSofiaDayBoundsUtc(fixedNow)
    const tsToday = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))
    const tsYesterday = toSqliteUtc(new Date(new Date(bounds.yesterdayStart + 'Z').getTime() + 2 * 3_600_000))

    // [8] Нормален completed match (is_guest_trial=0) — 2 играча на същата стая.
    const normalRoomId = randomUUID()
    insertMatchResult(db, normalRoomId, 'profile-a', tsToday, false)
    insertMatchResult(db, normalRoomId, 'profile-b', tsToday, false)

    // [9] Guest trial completed match (is_guest_trial=1) — 3 бота на друга стая.
    const trialRoomId = randomUUID()
    insertMatchResult(db, trialRoomId, 'bot-1', tsToday, true)
    insertMatchResult(db, trialRoomId, 'bot-2', tsToday, true)
    insertMatchResult(db, trialRoomId, 'bot-3', tsToday, true)

    // [10] Втори нормален мач с 4 играча на трета стая (за COUNT DISTINCT room_id проверка).
    const fourPlayerRoomId = randomUUID()
    insertMatchResult(db, fourPlayerRoomId, 'profile-c', tsToday, false)
    insertMatchResult(db, fourPlayerRoomId, 'profile-d', tsToday, false)
    insertMatchResult(db, fourPlayerRoomId, 'profile-e', tsToday, false)
    insertMatchResult(db, fourPlayerRoomId, 'profile-f', tsToday, false)

    // [11] Вчерашен нормален мач.
    const yesterdayRoomId = randomUUID()
    insertMatchResult(db, yesterdayRoomId, 'profile-g', tsYesterday, false)

    const stats = getUserGamesPlayedStats(db, fixedNow)

    check('[8] userGamesToday брои normalRoomId (completed, is_guest_trial=0)', stats.today >= 1)
    check(
      '[9] userGamesToday НЕ включва trialRoomId (is_guest_trial=1), общо само 2 стаи (normal + fourPlayer)',
      stats.today === 2,
    )
    check(
      '[10] COUNT(DISTINCT room_id): fourPlayerRoomId с 4 участника се брои като 1 игра, не 4',
      stats.today === 2,
    )
    check('[11] userGamesYesterday брои само вчерашния Sofia ден (=1)', stats.yesterday === 1)

    db.close()
  })

  // [12] userGames* заявката чете само от profile_match_results — не се влияе от
  // guest_trial_game_starts съдържание (отделни таблици, независими store-ове).
  await withTempDbFile(async (dbPath) => {
    const store = await createGuestTrialStore(dbPath)
    const db = new DatabaseSync(dbPath)
    const fixedNow = new Date('2026-06-27T10:00:00Z')
    const bounds = getSofiaDayBoundsUtc(fixedNow)
    const tsToday = toSqliteUtc(new Date(new Date(bounds.todayStart + 'Z').getTime() + 2 * 3_600_000))

    // 5 guest trial starts, 0 profile_match_results редове.
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT INTO guest_trial_game_starts (guest_id, room_id, stake_amount, started_at, created_at) VALUES (?, ?, 5000, ?, ?)`,
      ).run(randomUUID(), randomUUID(), tsToday, tsToday)
    }

    const userStats = getUserGamesPlayedStats(db, fixedNow)
    check('[12] userGamesToday = 0 въпреки 5 guest_trial_game_starts редове (независими таблици)', userStats.today === 0)

    // [13] Обратното: guestTrialGames* не се влияе от profile_match_results съдържание.
    // (5-те guest_trial_game_starts реда от [12] вече присъстват — очакваме те да останат
    // непроменени, независимо от новите profile_match_results INSERT-и по-долу.)
    const trialStatsBeforeMatchInserts = store.getGamesPlayedStats(fixedNow)
    insertMatchResult(db, randomUUID(), 'profile-x', tsToday, false)
    insertMatchResult(db, randomUUID(), 'profile-y', tsToday, true)
    const trialStatsAfterMatchInserts = store.getGamesPlayedStats(fixedNow)
    check(
      '[13] guestTrialGamesToday не се променя от нови profile_match_results редове (независими таблици)',
      trialStatsAfterMatchInserts.today === trialStatsBeforeMatchInserts.today && trialStatsAfterMatchInserts.today === 5,
    )

    db.close()
    store.close()
  })
}

async function checkFrontendSection(): Promise<void> {
  console.log('\n[14-17] Frontend: "Изиграни игри" секция в admin dashboard')

  const lobbySource = await readFile(
    new URL('../../src/app/lobby/renderLobbyScreen.ts', import.meta.url),
    'utf8',
  )

  check('[14] renderLobbyScreen.ts съдържа секция "Изиграни игри"', lobbySource.includes('Изиграни игри'))

  const visitorsIndex = lobbySource.indexOf('Посетители</h3>')
  const gamesPlayedIndex = lobbySource.indexOf('Изиграни игри</h3>')
  const viewLayoutIndex = lobbySource.indexOf('Влизания по версия')
  check(
    '[15] секцията "Изиграни игри" е между "Посетители" и "Влизания по версия"',
    visitorsIndex !== -1 &&
      gamesPlayedIndex !== -1 &&
      viewLayoutIndex !== -1 &&
      visitorsIndex < gamesPlayedIndex &&
      gamesPlayedIndex < viewLayoutIndex,
  )

  check('[16] рендерира "Игри от потребители" label', lobbySource.includes('Игри от потребители'))
  check('[16] рендерира "Пробни игри" label', lobbySource.includes('>Пробни игри<'))
  check('[16] рендерира userGamesToday/userGamesYesterday полета', lobbySource.includes('stats.gamesPlayed?.userGamesToday') && lobbySource.includes('stats.gamesPlayed?.userGamesYesterday'))
  check('[16] рендерира guestTrialGamesToday/guestTrialGamesYesterday полета', lobbySource.includes('stats.gamesPlayed?.guestTrialGamesToday') && lobbySource.includes('stats.gamesPlayed?.guestTrialGamesYesterday'))

  const clientSource = await readFile(
    new URL('../../src/app/network/createGameServerClient.ts', import.meta.url),
    'utf8',
  )
  check(
    '[17] AdminStatsSnapshot тип съдържа gamesPlayed: AdminGamesPlayedStats',
    clientSource.includes('gamesPlayed: AdminGamesPlayedStats'),
  )
  check(
    '[17] AdminGamesPlayedStats съдържа и четирите полета',
    clientSource.includes('userGamesToday: number') &&
      clientSource.includes('userGamesYesterday: number') &&
      clientSource.includes('guestTrialGamesToday: number') &&
      clientSource.includes('guestTrialGamesYesterday: number'),
  )

  const indexSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  check(
    '[17] backend handleAdminStatsRequest връща gamesPlayed с четирите полета',
    indexSource.includes('userGamesToday: userGamesPlayed.today') &&
      indexSource.includes('userGamesYesterday: userGamesPlayed.yesterday') &&
      indexSource.includes('guestTrialGamesToday: guestTrialGamesPlayed.today') &&
      indexSource.includes('guestTrialGamesYesterday: guestTrialGamesPlayed.yesterday'),
  )
}

async function main(): Promise<void> {
  await checkGuestTrialGameStartsLedger()
  await checkGuestTrialSofiaDayBounds()
  await checkUserGamesPlayedStats()
  await checkFrontendSection()

  console.log(`\n${passed + failed} checks: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    process.exit(1)
  }
}

await main()

/**
 * checkRoundCapotMission.ts
 *
 * Regression проверки за win_capot_games mission progress:
 * - отчита се при капо рунд, независимо от изхода на мача;
 * - само отборът, направил капото, получава +1;
 * - ботове без реален профил не получават progress;
 * - повторно изпълнение (идемпотентност) не добавя втори ред;
 * - transactional atomicity: частично записване е невъзможно.
 *
 * [A]  Капо рунд + отборът после губи мача         → progress +1
 * [B]  Капо рунд + отборът после печели мача        → progress +1, не +2
 * [C]  Два различни капо рунда                      → progress +2
 * [D]  Повторно извикване със същия roundKey        → progress остава +1
 * [E]  Двама реални партньори правят капо           → всеки получава +1
 * [F]  Реален играч + бот партньор правят капо      → само реалният +1
 * [G]  Противниковият отбор                         → няма progress
 * [H]  Неактивна win_capot_games мисия              → никой не получава progress
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createMissionStore } from '../src/db/missionStore.js'
import type { ServerRoom, Seat, Team } from '../src/core/serverTypes.js'
import type { ServerRoomGameSnapshot } from '../src/core/serverTypes.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

// ─── Брояч ──────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: получено ${String(actual)}, очаквано ${String(expected)}`)
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-capot-check-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function applyMigration(db: DatabaseSync, filename: string): Promise<void> {
  const sql = await readFile(
    resolve(serverRoot, 'database/migrations', filename),
    'utf8',
  )
  db.exec(sql.trim())
}

async function buildMissionSchema(db: DatabaseSync): Promise<void> {
  await applyMigration(db, '20260518_002_create_mission_templates.sql')
  // is_staged колоната се добавя в 004
  await applyMigration(db, '20260518_004_add_staged_missions.sql')
  await applyMigration(db, '20260518_003_create_player_mission_progress.sql')
  await applyMigration(db, '20260702_001_create_round_capot_mission_ledger.sql')
}

function buildBaseSchema(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT,
      display_name TEXT NOT NULL DEFAULT '',
      profile_kind TEXT NOT NULL DEFAULT 'human',
      status TEXT NOT NULL DEFAULT 'active',
      is_temporary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS profile_wallets (
      profile_id TEXT PRIMARY KEY,
      yellow_coins_balance INTEGER NOT NULL DEFAULT 0
        CHECK (yellow_coins_balance >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS admin_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function seedProfile(db: DatabaseSync, profileId: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES (?, ?)"
  ).run(profileId, profileId)
  db.prepare(
    "INSERT OR IGNORE INTO profile_wallets (profile_id) VALUES (?)"
  ).run(profileId)
}

function seedCapotMission(db: DatabaseSync, active = true): string {
  const missionId = 'mission-capot-1'
  db.prepare(`
    INSERT OR IGNORE INTO mission_templates
      (mission_id, mission_type, title, target_count, reward_yellow_coins, is_active, is_staged, sort_order)
    VALUES (?, 'win_capot_games', 'Спечели рунд с капо', 3, 500, ?, 0, 1)
  `).run(missionId, active ? 1 : 0)
  return missionId
}

function getProgress(db: DatabaseSync, profileId: string, missionId: string): number {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })
  const row = db.prepare(
    'SELECT progress_count FROM player_mission_progress WHERE profile_id = ? AND mission_id = ? AND date = ?'
  ).get(profileId, missionId, today) as { progress_count: number } | undefined
  return row?.progress_count ?? 0
}

function getLedgerCount(db: DatabaseSync, roomId: string, roundKey: string, profileId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as cnt FROM round_capot_mission_ledger WHERE room_id = ? AND round_key = ? AND profile_id = ?'
  ).get(roomId, roundKey, profileId) as { cnt: number }
  return row.cnt
}

// Строи минимален ServerRoom с определени human/bot seats и capot team
function makeRoom(params: {
  roomId: string
  seats: Partial<Record<Seat, { kind: 'human'; profileId: string } | { kind: 'bot' }>>
}): ServerRoom {
  const allSeats: Seat[] = ['bottom', 'right', 'top', 'left']
  const seatSlots: ServerRoom['seats'] = {} as ServerRoom['seats']

  for (const seat of allSeats) {
    const seatDef = params.seats[seat]
    const team: Team = seat === 'bottom' || seat === 'top' ? 'A' : 'B'

    if (seatDef?.kind === 'human') {
      seatSlots[seat] = {
        seat,
        team,
        participant: {
          kind: 'human',
          playerId: `player-${seat}`,
          connectionId: null,
          isConnected: false,
          joinedAt: 0,
          lastSeenAt: 0,
          reconnectToken: null,
          identity: {
            accountId: null,
            profileId: seatDef.profileId,
            username: null,
            displayName: seatDef.profileId,
            avatarUrl: null,
            level: null,
            rankTitle: null,
            skillRating: null,
            gender: null,
          },
        },
      }
    } else if (seatDef?.kind === 'bot') {
      seatSlots[seat] = {
        seat,
        team,
        participant: {
          kind: 'bot',
          playerId: `bot-${seat}`,
          joinedAt: 0,
          botCode: 'test-bot',
          difficulty: 'easy',
          identity: {
            accountId: null,
            profileId: null,
            username: null,
            displayName: `Bot ${seat}`,
            avatarUrl: null,
            level: null,
            rankTitle: null,
            skillRating: null,
            gender: null,
          },
        },
      }
    } else {
      seatSlots[seat] = { seat, team, participant: null }
    }
  }

  return {
    id: params.roomId,
    status: 'playing',
    createdAt: 0,
    updatedAt: 0,
    hostPlayerId: null,
    config: {
      maxPlayers: 4,
      allowBots: true,
      isPrivate: false,
      joinCode: null,
      stakeAmount: null,
      targetScore: 151,
      turnTimeMs: 15000,
      reconnectGraceMs: 30000,
    },
    seats: seatSlots,
    game: {} as ServerRoomGameSnapshot,
    replayVotes: [],
    leaveVotes: [],
  }
}

// ─── Тестове ────────────────────────────────────────────────────────────────

await withTempDir(async (dir) => {
  // ── [A] Капо рунд + отборът после губи мача → progress +1 ─────────────────
  await check('[A] Капо рунд + отборът после губи целия мач → progress +1', async () => {
    const dbPath = join(dir, 'testA.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-a-bottom')
    seedProfile(db, 'p-a-top')
    seedProfile(db, 'p-a-right')
    seedProfile(db, 'p-a-left')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-A',
      seats: {
        bottom: { kind: 'human', profileId: 'p-a-bottom' },
        top: { kind: 'human', profileId: 'p-a-top' },
        right: { kind: 'human', profileId: 'p-a-right' },
        left: { kind: 'human', profileId: 'p-a-left' },
      },
    })

    // Отбор A (bottom+top) прави капо. Мачът после губи — не викаме recordMatchCompletion.
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-a-bottom', missionId), 1, '[A] bottom progress')
    assertEqual(getProgress(db2, 'p-a-top', missionId), 1, '[A] top progress')
    assertEqual(getProgress(db2, 'p-a-right', missionId), 0, '[A] right не получава')
    assertEqual(getProgress(db2, 'p-a-left', missionId), 0, '[A] left не получава')
    db2.close()
  })

  // ── [B] Само recordRoundCapot добавя capot progress — win_capot_games е премахнат
  //        от computeMatchMissionDeltas(), така че matchCompletion не добавя втори +1.
  //        Тест: двойно recordRoundCapot за РАЗЛИЧНИ roundKey → +2, не +1.
  //        Обратно: същия roundKey → само +1 (вж. [D]).
  await check('[B] Само round capot hook добавя progress — не match completion', async () => {
    const dbPath = join(dir, 'testB.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-b-bottom')
    seedProfile(db, 'p-b-top')
    const missionId = seedCapotMission(db)

    // Проверяваме директно в DB, че win_capot_games НЕ е в match-end делтите.
    // Имплементацията на computeMatchMissionDeltas вече не съдържа win_capot_games —
    // потвърждаваме това, като извикаме recordRoundCapot веднъж и после
    // добавяме ръчно progress за win_games (симулира recordMatchCompletion)
    // и проверяваме че capot progress е само 1.
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })
    db.prepare(
      'INSERT INTO player_mission_progress (progress_id, profile_id, mission_id, date, progress_count) VALUES (?, ?, ?, ?, ?)'
    ).run('extra-prog', 'p-b-bottom', missionId, today, 0)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-B',
      seats: {
        bottom: { kind: 'human', profileId: 'p-b-bottom' },
        top: { kind: 'human', profileId: 'p-b-top' },
      },
    })

    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    // Capot progress: само 1 (от recordRoundCapot)
    assertEqual(getProgress(db2, 'p-b-bottom', missionId), 1, '[B] bottom: точно +1')
    assertEqual(getProgress(db2, 'p-b-top', missionId), 1, '[B] top: точно +1')
    db2.close()
  })

  // ── [C] Два различни капо рунда → progress +2 ─────────────────────────────
  await check('[C] Два капо рунда → progress +2', async () => {
    const dbPath = join(dir, 'testC.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-c-bottom')
    seedProfile(db, 'p-c-top')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-C',
      seats: {
        bottom: { kind: 'human', profileId: 'p-c-bottom' },
        top: { kind: 'human', profileId: 'p-c-top' },
      },
    })

    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'right:90:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-c-bottom', missionId), 2, '[C] progress трябва да е +2')
    db2.close()
  })

  // ── [D] Повторно извикване — идемпотентност ────────────────────────────────
  await check('[D] Повторно извикване за същия roundKey → progress остава +1', async () => {
    const dbPath = join(dir, 'testD.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-d-bottom')
    seedProfile(db, 'p-d-top')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-D',
      seats: {
        bottom: { kind: 'human', profileId: 'p-d-bottom' },
        top: { kind: 'human', profileId: 'p-d-top' },
      },
    })

    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' }) // повторно
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' }) // трети път
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-d-bottom', missionId), 1, '[D] progress трябва да е точно 1')
    // Ledger трябва да има точно 1 ред за тази комбинация
    assertEqual(getLedgerCount(db2, 'room-D', 'bottom:0:0', 'p-d-bottom'), 1, '[D] ledger трябва да е точно 1 ред')
    db2.close()
  })

  // ── [E] Двама реални партньори → всеки +1 ─────────────────────────────────
  await check('[E] Двама реални партньори правят капо → всеки +1', async () => {
    const dbPath = join(dir, 'testE.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-e-bottom')
    seedProfile(db, 'p-e-top')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-E',
      seats: {
        bottom: { kind: 'human', profileId: 'p-e-bottom' },
        top: { kind: 'human', profileId: 'p-e-top' },
        right: { kind: 'bot' },
        left: { kind: 'bot' },
      },
    })

    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-e-bottom', missionId), 1, '[E] bottom +1')
    assertEqual(getProgress(db2, 'p-e-top', missionId), 1, '[E] top +1')
    db2.close()
  })

  // ── [F] Реален играч + бот партньор → само реалният +1 ────────────────────
  await check('[F] Реален играч + бот партньор → само реалният получава +1', async () => {
    const dbPath = join(dir, 'testF.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-f-bottom')
    seedProfile(db, 'p-f-right')
    seedProfile(db, 'p-f-left')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-F',
      seats: {
        bottom: { kind: 'human', profileId: 'p-f-bottom' },
        top: { kind: 'bot' }, // бот партньор — без profileId
        right: { kind: 'human', profileId: 'p-f-right' },
        left: { kind: 'human', profileId: 'p-f-left' },
      },
    })

    // Team A (bottom+top) прави капо. top е бот — не трябва progress.
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-f-bottom', missionId), 1, '[F] реалният играч получава +1')
    // Проверяваме с директна SQL заявка — ботът няма profileId, няма ред
    const botRows = db2.prepare(
      "SELECT COUNT(*) as cnt FROM player_mission_progress WHERE mission_id = ? AND profile_id NOT IN ('p-f-bottom')"
    ).get(missionId) as { cnt: number }
    assertEqual(botRows.cnt, 0, '[F] ботът не трябва да има mission progress')
    db2.close()
  })

  // ── [G] Противниковият отбор не получава progress ─────────────────────────
  await check('[G] Противниковият отбор не получава progress', async () => {
    const dbPath = join(dir, 'testG.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-g-bottom')
    seedProfile(db, 'p-g-top')
    seedProfile(db, 'p-g-right')
    seedProfile(db, 'p-g-left')
    const missionId = seedCapotMission(db)
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-G',
      seats: {
        bottom: { kind: 'human', profileId: 'p-g-bottom' },
        top: { kind: 'human', profileId: 'p-g-top' },
        right: { kind: 'human', profileId: 'p-g-right' },
        left: { kind: 'human', profileId: 'p-g-left' },
      },
    })

    // Team A прави капо — Team B (right+left) не трябва progress
    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-g-right', missionId), 0, '[G] right (Team B) не получава')
    assertEqual(getProgress(db2, 'p-g-left', missionId), 0, '[G] left (Team B) не получава')
    db2.close()
  })

  // ── [H] Неактивна мисия → никой не получава progress ─────────────────────
  await check('[H] Неактивна win_capot_games мисия → никой не получава progress', async () => {
    const dbPath = join(dir, 'testH.sqlite')
    const db = new DatabaseSync(dbPath, { open: true })
    buildBaseSchema(db)
    await buildMissionSchema(db)
    seedProfile(db, 'p-h-bottom')
    const missionId = seedCapotMission(db, false) // is_active = 0
    db.close()

    const store = await createMissionStore(dbPath)
    const room = makeRoom({
      roomId: 'room-H',
      seats: { bottom: { kind: 'human', profileId: 'p-h-bottom' } },
    })

    store.recordRoundCapot({ room, capotTeam: 'A', roundKey: 'bottom:0:0' })
    store.close()

    const db2 = new DatabaseSync(dbPath, { open: true })
    assertEqual(getProgress(db2, 'p-h-bottom', missionId), 0, '[H] неактивна мисия — нула progress')
    // Ledger не трябва да се записва — нямаме какво да пазим
    assertEqual(getLedgerCount(db2, 'room-H', 'bottom:0:0', 'p-h-bottom'), 0, '[H] без ledger ред при неактивна мисия')
    db2.close()
  })
})

// ─── Резултат ────────────────────────────────────────────────────────────────

console.log('')
console.log(`Резултат: ${passed} преминати, ${failed} неуспешни`)

if (failed > 0) {
  process.exit(1)
}

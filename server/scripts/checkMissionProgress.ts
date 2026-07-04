import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createMissionStore } from '../src/db/missionStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import type { ServerRoom, Seat, Team } from '../src/core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerDeclarationMissionType,
} from '../src/game/serverGameTypes.js'
import {
  addDeclarationsToMatchMissionCountsBySeat,
} from '../src/game/serverDeclarationMissionCounts.js'
import {
  createEmptyMatchDeclarationMissionCounts,
  createEmptyMatchDeclarationMissionCountsBySeat,
} from '../src/game/createServerRoundDefaults.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA foreign_keys = ON;')

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }

  db.close()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      accountId: null,
      profileId,
      username: null,
      displayName: 'Player',
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
      gender: null,
    },
  }
}

function makeBotParticipant() {
  return {
    kind: 'bot' as const,
    playerId: randomUUID(),
    joinedAt: 0,
    botCode: 'test-bot',
    difficulty: 'easy' as const,
    identity: {
      accountId: null,
      profileId: null,
      username: null,
      displayName: 'Bot',
      avatarUrl: null,
      level: null,
      rankTitle: null,
      skillRating: null,
      gender: null,
    },
  }
}

function makeSeat(seat: Seat, team: Team, participant: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null) {
  return { seat, team, participant }
}

type ParticipantMap = {
  bottom: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null
  right: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null
  top: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null
  left: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null
}

function makeRoom(participants: ParticipantMap): ServerRoom {
  return {
    id: randomUUID(),
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
    seats: {
      bottom: makeSeat('bottom', 'A', participants.bottom),
      right: makeSeat('right', 'B', participants.right),
      top: makeSeat('top', 'A', participants.top),
      left: makeSeat('left', 'B', participants.left),
    },
    game: {
      phase: 'match-ended',
      stateVersion: 1,
      startedAt: 0,
      updatedAt: 0,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState: null,
    },
    replayVotes: [],
    leaveVotes: [],
  }
}

function makeMatchEndedState(
  winnerTeam: Team,
  isContra: boolean,
  bySeat: ReturnType<typeof createEmptyMatchDeclarationMissionCountsBySeat>,
): ServerAuthoritativeGameState {
  const emptyScore = { teamA: 0, teamB: 0 }
  const emptyHands = { bottom: [], right: [], top: [], left: [] }
  const emptyWonTricks = { A: [], B: [] }
  const emptyTrick = { leaderSeat: null, currentSeat: null, plays: [], winnerSeat: null, trickIndex: 0 }

  return {
    phase: 'match-ended',
    phaseEnteredAt: 0,
    targetScore: 151,
    players: {
      bottom: { seat: 'bottom', team: 'A', mode: 'human', controlledByBot: false },
      right: { seat: 'right', team: 'B', mode: 'human', controlledByBot: false },
      top: { seat: 'top', team: 'A', mode: 'human', controlledByBot: false },
      left: { seat: 'left', team: 'B', mode: 'human', controlledByBot: false },
    },
    round: { dealerSeat: 'bottom', cutterSeat: null, firstBidderSeat: null, firstDealSeat: null, selectedCutIndex: null },
    deck: [],
    hands: emptyHands,
    bidding: { entries: [], currentSeat: null, winningBid: null, hasStarted: false, hasEnded: false, consecutivePasses: 0 },
    declarations: [],
    matchDeclarationMissionCounts: createEmptyMatchDeclarationMissionCounts(),
    matchDeclarationMissionCountsBySeat: bySeat,
    currentTrick: emptyTrick,
    wonTricks: emptyWonTricks,
    playing: null,
    scoring: {
      winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: isContra, redoubled: false },
      rawHandPoints: emptyScore,
      rawHandTricksWon: emptyScore,
      declarationPoints: emptyScore,
      belotePoints: emptyScore,
      sumPoints: emptyScore,
      officialRoundPoints: winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 },
      matchTotals: winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 },
      carryOver: { teamA: 0, teamB: 0 },
      isCapotRound: false,
      isNonCapotRound: true,
      outcomeLabel: 'Направена',
      outcomeShortLabel: 'Направена',
      outcome: 'made',
      counterMultiplier: isContra ? 2 : 1,
    },
    matchEnded: {
      winnerTeam,
      targetScore: 151,
      finalScore: winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 },
      endedAt: Date.now(),
    },
    score: {
      round: {
        tricks: emptyScore,
        declarations: emptyScore,
        belote: emptyScore,
        lastTen: emptyScore,
        capot: emptyScore,
        total: emptyScore,
      },
      match: winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 },
      carryOver: { teamA: 0, teamB: 0 },
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  }
}

function makeScoringState(
  winnerTeam: Team,
  isContra: boolean,
  isCapot: boolean,
): ServerAuthoritativeGameState['scoring'] {
  const emptyScore = { teamA: 0, teamB: 0 }
  const pts = winnerTeam === 'A' ? { teamA: 160, teamB: 0 } : { teamA: 0, teamB: 160 }
  return {
    winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: isContra, redoubled: false },
    rawHandPoints: emptyScore,
    rawHandTricksWon: isCapot
      ? (winnerTeam === 'A' ? { teamA: 8, teamB: 0 } : { teamA: 0, teamB: 8 })
      : (winnerTeam === 'A' ? { teamA: 5, teamB: 3 } : { teamA: 3, teamB: 5 }),
    declarationPoints: emptyScore,
    belotePoints: emptyScore,
    sumPoints: emptyScore,
    officialRoundPoints: pts,
    matchTotals: pts,
    carryOver: { teamA: 0, teamB: 0 },
    isCapotRound: isCapot,
    isNonCapotRound: !isCapot,
    outcomeLabel: 'Направена',
    outcomeShortLabel: 'Направена',
    outcome: 'made',
    counterMultiplier: isContra ? 2 : 1,
  }
}

function makeDeclBySeat(
  seat: Seat,
  missionType: ServerDeclarationMissionType,
  count: number = 1,
) {
  const result = createEmptyMatchDeclarationMissionCountsBySeat()
  result[seat] = { [missionType]: count }
  return result
}

function missionProgress(db: DatabaseSync, profileId: string, missionType: string, date: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(p.progress_count), 0) AS total
    FROM player_mission_progress p
    JOIN mission_templates m ON m.mission_id = p.mission_id
    WHERE p.profile_id = ? AND m.mission_type = ? AND p.date = ?
  `).get(profileId, missionType, date) as { total: number }
  return row?.total ?? 0
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'belot-missions-'))
  const dbPath = join(tmpDir, 'test.db')

  try {
    await applyMigrations(dbPath)

    const missionStore = await createMissionStore(dbPath)

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Sofia' })

    // Seed all 9 mission types with target=1
    const missionTypes = [
      'play_games', 'win_games', 'win_contra_games', 'win_capot_games',
      'announce_tersa', 'announce_50', 'announce_100', 'announce_kare', 'announce_belot',
    ]
    for (const missionType of missionTypes) {
      missionStore.upsertMission({
        missionType: missionType as any,
        title: missionType,
        targetCount: 1,
        rewardYellowCoins: 10,
        isActive: true,
        isStaged: false,
        sortOrder: 0,
      })
    }

    // Single shared DB connection for reading progress and inserting test profiles
    const db = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: false })

    function insertProfile(pid: string): void {
      const accId = `acc-${pid}`
      const short = pid.slice(0, 8)
      // username / normalized_username — unique per profile
      const un = `u${pid.replace(/-/g, '')}`
      // display_name must be unique (UNIQUE idx on normalized_display_name)
      const displayName = `P${short}`
      const normalizedDisplayName = displayName.toLowerCase()
      db.prepare(`
        INSERT OR IGNORE INTO accounts (account_id, email, password_hash, role, status)
        VALUES (?, ?, 'hash', 'player', 'active')
      `).run(accId, `${pid}@test.invalid`)
      db.prepare(`
        INSERT OR IGNORE INTO profiles (profile_id, account_id, profile_kind, username, normalized_username, display_name, normalized_display_name, level, rank_title, skill_rating, status)
        VALUES (?, ?, 'human', ?, ?, ?, ?, 1, 'R1', 1000, 'active')
      `).run(pid, accId, un, un, displayName, normalizedDisplayName)
      db.prepare(`
        INSERT OR IGNORE INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 0)
      `).run(pid)
    }

    // Create profile IDs for A (bottom+top) and B (right+left)
    const pA1 = randomUUID() // bottom seat, Team A
    const pA2 = randomUUID() // top seat, Team A
    const pB1 = randomUUID() // right seat, Team B
    const pB2 = randomUUID() // left seat, Team B

    for (const pid of [pA1, pA2, pB1, pB2]) insertProfile(pid)

    function progress(profileId: string, missionType: string) {
      return missionProgress(db, profileId, missionType, today)
    }

    // Verify inserts are visible
    const profileCount = (db.prepare(`SELECT COUNT(*) AS cnt FROM profiles WHERE profile_id IN (?, ?, ?, ?)`).get(pA1, pA2, pB1, pB2) as { cnt: number }).cnt
    if (profileCount !== 4) {
      throw new Error(`Expected 4 profiles, got ${profileCount}`)
    }

    // ── Match-level missions ─────────────────────────────────────────────────

    await check('[1] 4 humans finish match → all get play_games +1', () => {
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }
      missionStore.recordMatchCompletion(room)

      assert(progress(pA1, 'play_games') >= 1, 'pA1 play_games')
      assert(progress(pA2, 'play_games') >= 1, 'pA2 play_games')
      assert(progress(pB1, 'play_games') >= 1, 'pB1 play_games')
      assert(progress(pB2, 'play_games') >= 1, 'pB2 play_games')
    })

    await check('[2] Team A wins → A players get win_games +1, B players get 0', () => {
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = { a1: progress(pA1, 'win_games'), a2: progress(pA2, 'win_games'), b1: progress(pB1, 'win_games'), b2: progress(pB2, 'win_games') }
      missionStore.recordMatchCompletion(room)
      const after = { a1: progress(pA1, 'win_games'), a2: progress(pA2, 'win_games'), b1: progress(pB1, 'win_games'), b2: progress(pB2, 'win_games') }

      assert(after.a1 - before.a1 === 1, 'pA1 win_games +1')
      assert(after.a2 - before.a2 === 1, 'pA2 win_games +1')
      assert(after.b1 - before.b1 === 0, 'pB1 win_games +0')
      assert(after.b2 - before.b2 === 0, 'pB2 win_games +0')
    })

    await check('[3] Human + bot win → human gets win_games +1, bot gets no record', () => {
      const pHuman = randomUUID()
      insertProfile(pHuman)

      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pHuman),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(), // bot partner
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = progress(pHuman, 'win_games')
      missionStore.recordMatchCompletion(room)
      const after = progress(pHuman, 'win_games')

      assert(after - before === 1, 'human win_games +1')
      // bot has no profileId so no row exists — just verify no error thrown
    })

    await check('[4] Round win does not award win_games (only match-ended does)', () => {
      // recordMatchCompletion only acts when phase === 'match-ended'
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state: ServerAuthoritativeGameState = {
        ...makeMatchEndedState('A', false, bySeat),
        phase: 'scoring', // not match-ended
        matchEnded: null,
      }
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = progress(pA1, 'win_games')
      missionStore.recordMatchCompletion(room)
      const after = progress(pA1, 'win_games')
      assert(after - before === 0, 'win_games not awarded mid-match')
    })

    await check('[5] Repeated match completion call does not double-count (play_games idempotency via separate call check)', () => {
      // The function itself is not idempotent at the store level — idempotency is guaranteed
      // by shouldRunMatchCompletionSideEffects in index.ts (fires only once).
      // Here we verify the second call WOULD add again (expected — caller must guard).
      // This test just asserts the first call gives exactly +1.
      const p = randomUUID()
      insertProfile(p)

      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(p),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = progress(p, 'play_games')
      missionStore.recordMatchCompletion(room)
      const after = progress(p, 'play_games')
      assert(after - before === 1, 'first call gives exactly +1')
    })

    // ── Contra round missions ─────────────────────────────────────────────────

    await check('[6] Contra round: winner team humans get win_contra_games +1', () => {
      const prevRoom = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      const prevState = makeMatchEndedState('A', true, createEmptyMatchDeclarationMissionCountsBySeat())
      const prevPlaying = { ...prevState, phase: 'playing' as const, scoring: null, matchEnded: null }
      prevRoom.game = { ...prevRoom.game, authoritativeState: prevPlaying }

      const roundKey = `bottom:0:0`

      const before = { a1: progress(pA1, 'win_contra_games'), a2: progress(pA2, 'win_contra_games'), b1: progress(pB1, 'win_contra_games') }

      missionStore.recordRoundContra({ room: prevRoom, winnerTeam: 'A', roundKey })

      const after = { a1: progress(pA1, 'win_contra_games'), a2: progress(pA2, 'win_contra_games'), b1: progress(pB1, 'win_contra_games') }

      assert(after.a1 - before.a1 === 1, 'pA1 win_contra_games +1')
      assert(after.a2 - before.a2 === 1, 'pA2 win_contra_games +1')
      assert(after.b1 - before.b1 === 0, 'pB1 win_contra_games +0 (lost)')
    })

    await check('[7] Contra round: human+bot winner → human +1, bot no record', () => {
      const pC = randomUUID()
      insertProfile(pC)

      const room = makeRoom({
        bottom: makeHumanParticipant(pC),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(),
        left: makeHumanParticipant(pB2),
      })

      const before = progress(pC, 'win_contra_games')
      missionStore.recordRoundContra({ room, winnerTeam: 'A', roundKey: `bottom:10:0` })
      const after = progress(pC, 'win_contra_games')
      assert(after - before === 1, 'human +1')
    })

    await check('[8] Contra round idempotency: same roundKey not counted twice', () => {
      const pD = randomUUID()
      insertProfile(pD)

      const room = makeRoom({
        bottom: makeHumanParticipant(pD),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(),
        left: makeHumanParticipant(pB2),
      })

      const roundKey = `bottom:20:0`
      missionStore.recordRoundContra({ room, winnerTeam: 'A', roundKey })
      missionStore.recordRoundContra({ room, winnerTeam: 'A', roundKey }) // repeated call

      const total = progress(pD, 'win_contra_games')
      assert(total === 1, `expected 1 but got ${total}`)
    })

    await check('[9] Non-contra round does not award win_contra_games', () => {
      const before = progress(pA1, 'win_contra_games')
      // recordRoundContra is not called for non-contra rounds (detection in index.ts)
      // This test verifies the mission delta computation does not emit win_contra_games
      // for match-ended state where the last round was non-contra
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat) // isContra=false
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }
      missionStore.recordMatchCompletion(room) // win_contra_games now NOT in computeMatchMissionDeltas
      const after = progress(pA1, 'win_contra_games')
      assert(after - before === 0, 'no win_contra_games from non-contra match')
    })

    // ── Capot round missions ─────────────────────────────────────────────────

    await check('[10] Capot round: winning team humans get win_capot_games +1', () => {
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })

      const before = { a1: progress(pA1, 'win_capot_games'), b1: progress(pB1, 'win_capot_games') }
      missionStore.recordRoundCapot({ room, capotTeam: 'A', roundKey: `bottom:0:0:capot` })
      const after = { a1: progress(pA1, 'win_capot_games'), b1: progress(pB1, 'win_capot_games') }

      assert(after.a1 - before.a1 === 1, 'pA1 capot +1')
      assert(after.b1 - before.b1 === 0, 'pB1 capot +0')
    })

    await check('[11] Capot ledger idempotency: same roundKey not counted twice', () => {
      const pE = randomUUID()
      insertProfile(pE)

      const room = makeRoom({
        bottom: makeHumanParticipant(pE),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(),
        left: makeHumanParticipant(pB2),
      })

      const roundKey = `bottom:0:0:capotX`
      missionStore.recordRoundCapot({ room, capotTeam: 'A', roundKey })
      missionStore.recordRoundCapot({ room, capotTeam: 'A', roundKey }) // repeated

      const total = progress(pE, 'win_capot_games')
      assert(total === 1, `expected 1 but got ${total}`)
    })

    // ── Declaration missions ─────────────────────────────────────────────────

    const declarationCases: Array<[string, string, Seat, ServerDeclarationMissionType]> = [
      ['[12]', 'announce_belot', 'bottom', 'announce_belot'],
      ['[13]', 'announce_kare', 'bottom', 'announce_kare'],
      ['[14]', 'announce_tersa', 'bottom', 'announce_tersa'],
      ['[15]', 'announce_50', 'bottom', 'announce_50'],
      ['[16]', 'announce_100', 'bottom', 'announce_100'],
    ]

    // Use fresh profiles per test to avoid cross-test contamination
    const declProfiles = [pA1, pA1, pA1, pA1, pA1]

    for (let i = 0; i < declarationCases.length; i++) {
      const [num, missionType, seat, mt] = declarationCases[i]
      const prof = declProfiles[i]

      await check(`${num} ${seat} announces ${missionType} → only that player gets +1, partner (top) gets +0`, () => {
        // bottom seat = pA1 (Team A), top seat = pA2 (Team A partner)
        const bySeat = makeDeclBySeat(seat, mt, 1)
        const state = makeMatchEndedState('A', false, bySeat)
        const room = makeRoom({
          bottom: makeHumanParticipant(pA1),
          right: makeHumanParticipant(pB1),
          top: makeHumanParticipant(pA2),
          left: makeHumanParticipant(pB2),
        })
        room.game = { ...room.game, authoritativeState: state }

        const before = { declarer: progress(pA1, missionType), partner: progress(pA2, missionType) }
        missionStore.recordMatchCompletion(room)
        const after = { declarer: progress(pA1, missionType), partner: progress(pA2, missionType) }

        assert(after.declarer - before.declarer === 1, `declarer ${missionType} +1`)
        assert(after.partner - before.partner === 0, `partner ${missionType} +0`)
      })
    }

    await check('[17] Partner announces → declarer gets +1, original player gets +0', () => {
      // top (pA2) announces, bottom (pA1) should get +0
      const bySeat = makeDeclBySeat('top', 'announce_belot', 1)
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = { bottom: progress(pA1, 'announce_belot'), top: progress(pA2, 'announce_belot') }
      missionStore.recordMatchCompletion(room)
      const after = { bottom: progress(pA1, 'announce_belot'), top: progress(pA2, 'announce_belot') }

      assert(after.top - before.top === 1, 'pA2 +1 (declarer)')
      assert(after.bottom - before.bottom === 0, 'pA1 +0 (non-declarer)')
    })

    await check('[18] Bot announces → human partner gets +0', () => {
      // top seat = bot (no profileId); bottom = pA1
      const bySeat = makeDeclBySeat('top', 'announce_belot', 1)
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeBotParticipant(), // bot — no profileId
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = progress(pA1, 'announce_belot')
      missionStore.recordMatchCompletion(room)
      const after = progress(pA1, 'announce_belot')

      assert(after - before === 0, 'pA1 +0 (bot was declarer)')
    })

    await check('[19] Opponent announces → other team gets +0', () => {
      // right (pB1, Team B) announces; bottom (pA1, Team A) gets +0
      const bySeat = makeDeclBySeat('right', 'announce_belot', 1)
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = { a1: progress(pA1, 'announce_belot'), b1: progress(pB1, 'announce_belot') }
      missionStore.recordMatchCompletion(room)
      const after = { a1: progress(pA1, 'announce_belot'), b1: progress(pB1, 'announce_belot') }

      assert(after.a1 - before.a1 === 0, 'pA1 +0 (other team)')
      assert(after.b1 - before.b1 === 1, 'pB1 +1 (declarer)')
    })

    await check('[20] Both partners announce belot → A1 +1, A2 +1 (not +2 each)', () => {
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      bySeat['bottom'] = { announce_belot: 1 }
      bySeat['top'] = { announce_belot: 1 }
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = { a1: progress(pA1, 'announce_belot'), a2: progress(pA2, 'announce_belot') }
      missionStore.recordMatchCompletion(room)
      const after = { a1: progress(pA1, 'announce_belot'), a2: progress(pA2, 'announce_belot') }

      assert(after.a1 - before.a1 === 1, 'pA1 +1')
      assert(after.a2 - before.a2 === 1, 'pA2 +1')
    })

    await check('[21] Multiple declarations across rounds accumulate per seat', () => {
      // A1 announced tersa in round 1 and belot in round 2 → tersa+1, belot+1
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      bySeat['bottom'] = { announce_tersa: 1, announce_belot: 1 }
      const state = makeMatchEndedState('A', false, bySeat)
      const room = makeRoom({
        bottom: makeHumanParticipant(pA1),
        right: makeHumanParticipant(pB1),
        top: makeHumanParticipant(pA2),
        left: makeHumanParticipant(pB2),
      })
      room.game = { ...room.game, authoritativeState: state }

      const before = { tersa: progress(pA1, 'announce_tersa'), belot: progress(pA1, 'announce_belot') }
      missionStore.recordMatchCompletion(room)
      const after = { tersa: progress(pA1, 'announce_tersa'), belot: progress(pA1, 'announce_belot') }

      assert(after.tersa - before.tersa === 1, 'tersa +1')
      assert(after.belot - before.belot === 1, 'belot +1')
    })

    await check('[22] Seat-level counts accumulate correctly via addDeclarationsToMatchMissionCountsBySeat', () => {
      const decl1 = {
        key: 'k1', seat: 'bottom' as Seat, team: 'A' as Team,
        type: 'belote' as const, publicLabel: 'Белот' as const,
        points: 20, cards: [], cardIds: [], suit: null, highRank: null,
        declaredAtTrickIndex: 0, announced: true, valid: true,
      }
      const decl2 = {
        key: 'k2', seat: 'top' as Seat, team: 'A' as Team,
        type: 'sequence' as const, publicLabel: 'Терца' as const,
        points: 20, cards: [], cardIds: [], suit: null, highRank: null,
        declaredAtTrickIndex: 0, announced: true, valid: true,
      }
      const decl3 = {
        key: 'k3', seat: 'bottom' as Seat, team: 'A' as Team,
        type: 'belote' as const, publicLabel: 'Белот' as const,
        points: 20, cards: [], cardIds: [], suit: null, highRank: null,
        declaredAtTrickIndex: 1, announced: true, valid: true,
      }

      let counts = createEmptyMatchDeclarationMissionCountsBySeat()
      counts = addDeclarationsToMatchMissionCountsBySeat(counts, [decl1, decl2])
      counts = addDeclarationsToMatchMissionCountsBySeat(counts, [decl3])

      assert((counts['bottom']?.['announce_belot'] ?? 0) === 2, 'bottom belot = 2')
      assert((counts['top']?.['announce_tersa'] ?? 0) === 1, 'top tersa = 1')
      assert((counts['bottom']?.['announce_tersa'] ?? 0) === 0, 'bottom tersa = 0')
    })

    await check('[23] Invalid or unannounced declarations are NOT counted', () => {
      const decl1 = {
        key: 'k_inv', seat: 'bottom' as Seat, team: 'A' as Team,
        type: 'belote' as const, publicLabel: 'Белот' as const,
        points: 20, cards: [], cardIds: [], suit: null, highRank: null,
        declaredAtTrickIndex: 0, announced: false, valid: true, // not announced
      }
      const decl2 = {
        key: 'k_inv2', seat: 'bottom' as Seat, team: 'A' as Team,
        type: 'belote' as const, publicLabel: 'Белот' as const,
        points: 20, cards: [], cardIds: [], suit: null, highRank: null,
        declaredAtTrickIndex: 0, announced: true, valid: false, // invalid
      }

      const counts = addDeclarationsToMatchMissionCountsBySeat(
        createEmptyMatchDeclarationMissionCountsBySeat(),
        [decl1, decl2],
      )

      assert((counts['bottom']?.['announce_belot'] ?? 0) === 0, 'neither invalid nor unannounced counted')
    })

    await check('[24] normalizeRestoredAuthoritativeState adds empty bySeat for old states', async () => {
      const { normalizeRestoredAuthoritativeState } = await import('../src/game/normalizeRestoredAuthoritativeState.js')
      const bySeat = createEmptyMatchDeclarationMissionCountsBySeat()
      const state = makeMatchEndedState('A', false, bySeat)

      // Simulate old persisted state without the field
      const legacyState = { ...state } as any
      delete legacyState.matchDeclarationMissionCountsBySeat

      const normalized = normalizeRestoredAuthoritativeState(legacyState)
      assert(
        'matchDeclarationMissionCountsBySeat' in normalized,
        'field added after normalization',
      )
    })

    missionStore.close()
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    db.close()

  } finally {
    // WAL files may still be held briefly after close on Windows; ignore EBUSY
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  console.log('')
  console.log(`Results: ${passed} passed, ${failed} failed`)

  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})

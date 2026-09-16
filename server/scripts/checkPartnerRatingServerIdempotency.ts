/**
 * checkPartnerRatingServerIdempotency.ts
 *
 * Server-side data-integrity проверка за partner rating (R7 от client-side
 * task-а checkMatchEndedPartnerRatingPersistence.ts) — доказва, че
 * playerProgressStore.submitPartnerRating() е ВЕЧЕ идемпотентен на DB ниво
 * (UNIQUE constraint (room_id, rated_by_profile_id, rated_profile_id) в
 * profile_partner_ratings, миграция 20260510_002), независимо от client UI
 * fix-а в renderMatchEndedScreen.ts/createActiveRoomFlowController.ts.
 *
 * room_id, подаван към INSERT-а, е `${room.id}:v${room.game.stateVersion}`
 * (виж playerProgressStore.ts submitPartnerRating), НЕ голия room.id —
 * stateVersion остава стабилен през целия match-ended lifecycle (leave/
 * replay vote мутират само room.leaveVotes/replayVotes, не game.stateVersion
 * — виж server/src/index.ts leave-vote handler-а), значи duplicate detection
 * работи коректно и за re-render/vote-предизвикани повторни опити, не само
 * за буквално двоен клик в рамките на един render.
 *
 * [S1] Първи submit -> ok:true, 1 ред в profile_partner_ratings.
 * [S2] Втори submit (същия room/rater/partner) -> ok:false, error съобщение,
 *      броят редове в profile_partner_ratings ОСТАВА 1 (няма duplicate INSERT).
 * [S3] Втори submit -> average_rating/total_ratings_count на partner-а НЕ се
 *      променят допълнително спрямо след първия submit (статистиката не се
 *      "покачва" втори път от един и същи мач).
 * [S4] Различен room (различен stateVersion) от същия rater/partner чифт ->
 *      позволен нов ред (нормален случай — рейтинг за друг мач).
 * [S5] Различна ratingValue при втория опит все пак се отхвърля (доказва
 *      защитата е по (room,rater,partner), не по rating стойност).
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import type { ServerRoom, Seat, Team } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'

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
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
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
    matchDeclarationMissionCounts: undefined as any,
    matchDeclarationMissionCountsBySeat: undefined as any,
    currentTrick: emptyTrick,
    wonTricks: emptyWonTricks,
    playing: null,
    scoring: {
      winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'clubs', doubled: false, redoubled: false },
      rawHandPoints: emptyScore,
      rawHandTricksWon: emptyScore,
      declarationPoints: emptyScore,
      belotePoints: emptyScore,
      sumPoints: emptyScore,
      officialRoundPoints: pts,
      matchTotals: pts,
      carryOver: { teamA: 0, teamB: 0 },
      isCapotRound: false,
      isNonCapotRound: true,
      outcomeLabel: 'Направена',
      outcomeShortLabel: 'Направена',
      outcome: 'made',
      counterMultiplier: 1,
    },
    matchEnded: {
      winnerTeam,
      targetScore: 151,
      finalScore: pts,
      endedAt: Date.now(),
    },
    score: {
      round: { tricks: emptyScore, declarations: emptyScore, belote: emptyScore, lastTen: emptyScore, capot: emptyScore, total: emptyScore },
      match: pts,
      carryOver: { teamA: 0, teamB: 0 },
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  } as unknown as ServerAuthoritativeGameState
}

function makeRoom(roomId: string, stateVersion: number, raterProfileId: string, partnerProfileId: string): ServerRoom {
  return {
    id: roomId,
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
    // getPartnerSeat('bottom') === 'top' (виж playerProgressStore.ts) — партньорът
    // е срещуположната седалка от СЪЩИЯ отбор, не съседната (противник).
    seats: {
      bottom: makeSeat('bottom', 'A', makeHumanParticipant(raterProfileId)),
      top: makeSeat('top', 'A', makeHumanParticipant(partnerProfileId)),
      right: makeSeat('right', 'B', makeHumanParticipant(randomUUID())),
      left: makeSeat('left', 'B', makeHumanParticipant(randomUUID())),
    },
    game: {
      phase: 'match-ended',
      stateVersion,
      startedAt: 0,
      updatedAt: 0,
      activeTimerId: null,
      timerDeadlineAt: null,
      authoritativeState: makeMatchEndedState('A'),
    },
    replayVotes: [],
    leaveVotes: [],
  } as unknown as ServerRoom
}

async function run(): Promise<void> {
  console.log('\ncheckPartnerRatingServerIdempotency\n')

  const dbDir = await mkdtemp(join(tmpdir(), 'belot-partner-rating-'))
  const dbPath = join(dbDir, 'test.db')
  await applyMigrations(dbPath)

  const store = await createPlayerProgressStore(dbPath)
  const rawDb = new DatabaseSync(dbPath, { open: true })

  function countRatings(roomId: string, raterProfileId: string, partnerProfileId: string): number {
    const row = rawDb
      .prepare(
        `SELECT COUNT(*) AS count FROM profile_partner_ratings
         WHERE room_id = ? AND rated_by_profile_id = ? AND rated_profile_id = ?`,
      )
      .get(roomId, raterProfileId, partnerProfileId) as { count: number }
    return row.count
  }

  function getAggregate(partnerProfileId: string): { average: number; count: number } {
    const row = rawDb
      .prepare(
        `SELECT COALESCE(AVG(rating_value), 0) AS average_rating, COUNT(*) AS total_ratings_count
         FROM profile_partner_ratings WHERE rated_profile_id = ?`,
      )
      .get(partnerProfileId) as { average_rating: number; total_ratings_count: number }
    return { average: row.average_rating, count: row.total_ratings_count }
  }

  const raterProfileId = randomUUID()
  const partnerProfileId = randomUUID()
  const roomId = randomUUID()

  // Insert profiles directly (FK constraint on profile_partner_ratings needs them to exist).
  // normalized_display_name has a UNIQUE constraint - each profile needs a distinct value.
  const profileNames: Array<[string, string]> = [
    [raterProfileId, 'Rater'],
    [partnerProfileId, 'Partner'],
  ]
  for (const [profileId, displayName] of profileNames) {
    rawDb
      .prepare(
        `INSERT INTO profiles (
          profile_id, account_id, profile_kind, username, normalized_username,
          display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status
        ) VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active')`,
      )
      .run(profileId, displayName, displayName.toLowerCase())
  }

  const room = makeRoom(roomId, 1, raterProfileId, partnerProfileId)

  await check('[S1] Първи submit -> ok:true, 1 ред в DB', () => {
    const result = store.submitPartnerRating(room, 'bottom', 4)
    assert(result.ok === true, `Очаквах ok:true, получих ${JSON.stringify(result)}`)
    const scopedRoomId = `${roomId}:v1`
    const count = countRatings(scopedRoomId, raterProfileId, partnerProfileId)
    assert(count === 1, `Очаквах 1 ред след първи submit, получих ${count}`)
  })

  await check('[S2] Втори submit (същия room/rater/partner) -> ok:false, БЕЗ duplicate ред', () => {
    const result = store.submitPartnerRating(room, 'bottom', 4)
    assert(result.ok === false, `Очаквах ok:false при duplicate submit, получих ${JSON.stringify(result)}`)
    const scopedRoomId = `${roomId}:v1`
    const count = countRatings(scopedRoomId, raterProfileId, partnerProfileId)
    assert(count === 1, `Очаквах броят редове да ОСТАНЕ 1 след duplicate опит, получих ${count}`)
  })

  // S6: alreadyRated:true флагът в резултатния обект (добавен при client-side
  // "false-success UI" audit fix-а) — client-ът различава duplicate
  // (alreadyRated:true, safe да третира като completed) от generic failure
  // (alreadyRated:false, retry-able) само по този флаг, не по message текста.
  await check('[S6] Duplicate submit -> alreadyRated:true в резултата (client разчита на това поле)', () => {
    const result = store.submitPartnerRating(room, 'bottom', 4)
    assert(result.ok === false, 'Очаквах ok:false при duplicate submit')
    assert(
      !result.ok && result.alreadyRated === true,
      `Очаквах alreadyRated:true при duplicate submit, получих ${JSON.stringify(result)}`,
    )
  })

  await check('[S7] Non-duplicate failure (невалидна ratingValue) -> alreadyRated:false', () => {
    const room4 = makeRoom(randomUUID(), 1, raterProfileId, partnerProfileId)
    const result = store.submitPartnerRating(room4, 'bottom', 99) // извън 1-6 диапазона
    assert(result.ok === false, 'Очаквах ok:false за невалидна ratingValue')
    assert(
      !result.ok && result.alreadyRated === false,
      `Очаквах alreadyRated:false за non-duplicate грешка, получих ${JSON.stringify(result)}`,
    )
  })

  await check('[S3] Втори submit -> статистиката (average/count) НЕ се променя допълнително', () => {
    const before = getAggregate(partnerProfileId)
    store.submitPartnerRating(room, 'bottom', 6) // втори опит, различна стойност
    const after = getAggregate(partnerProfileId)
    assert(
      before.count === after.count && before.average === after.average,
      `Очаквах статистиката да остане непроменена (${JSON.stringify(before)}), получих ${JSON.stringify(after)}`,
    )
    assert(after.count === 1, `Очаквах total_ratings_count=1 (само първия submit), получих ${after.count}`)
  })

  await check('[S4] Различен room (нов stateVersion) от същия чифт -> позволен нов ред', () => {
    const room2 = makeRoom(roomId, 2, raterProfileId, partnerProfileId)
    const result = store.submitPartnerRating(room2, 'bottom', 5)
    assert(result.ok === true, `Очаквах ok:true за нов match (нов stateVersion), получих ${JSON.stringify(result)}`)
    const scopedRoomId2 = `${roomId}:v2`
    const count = countRatings(scopedRoomId2, raterProfileId, partnerProfileId)
    assert(count === 1, `Очаквах 1 ред за новия match scope, получих ${count}`)
  })

  await check('[S5] Различна ratingValue при повторен опит пак се отхвърля (защита е по room/rater/partner)', () => {
    const room3 = makeRoom(roomId, 3, raterProfileId, partnerProfileId)
    const first = store.submitPartnerRating(room3, 'bottom', 1)
    assert(first.ok === true, 'Очаквах първия submit за нов room да мине')
    const second = store.submitPartnerRating(room3, 'bottom', 6)
    assert(second.ok === false, 'Очаквах втория submit (различна стойност) да се отхвърли')
    const scopedRoomId3 = `${roomId}:v3`
    const count = countRatings(scopedRoomId3, raterProfileId, partnerProfileId)
    assert(count === 1, `Очаквах 1 ред (само първата стойност запазена), получих ${count}`)
  })

  store.close()
  rawDb.close()
  await rm(dbDir, { recursive: true, force: true })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * checkCampaignGameHooks.ts
 *
 * Фаза 3 на системата "Кампании" — автоматично начисляване на тематични
 * единици при РЕАЛНИ победи в Белот и Ludo (server/src/campaigns/
 * campaignGameHooks.ts). Изолирана temp SQLite база, реални миграции,
 * реален campaignsStore/campaignCreditStore. ServerRoom/LudoMatchSnapshot
 * fixtures mirror-ват checkLudoProgressionIntegration.ts's established
 * builders (makeHumanParticipant/makeSeat/makeMatchEndedState/makeBelotRoom),
 * за реалистична форма без да се вдига целият WS сървър.
 *
 * Покрива (виж task spec §12):
 *   [1]  Белот победа с активна кампания -> печелившият отбор начислен
 *   [2]  Губещ отбор -> нищо начислено
 *   [3]  Бот участник (ВСЕКИ kind='bot', не само temp-bot-*) -> изключен
 *   [4]  Guest Trial room (config.isGuestTrial) -> никой не се начислява
 *   [5]  Турнирен мач (isTournamentMatch:true) -> никой не се начислява
 *   [6]  Липсваща/недостоверна stake информация -> no-op, без ledger ред
 *   [7]  Различни stakes -> различни earn rules прилагат се коректно
 *   [8]  Доказана нулева ставка (stakeAmount:0, конфигурирано rule) -> credited
 *   [9]  Без активна/елигибилна кампания -> no-op (no_eligible_campaign), без throw
 *   [10] Feature flag OFF -> пълен no-op, нулеви DB промени
 *   [11] Повторно извикване за СЪЩИЯ room (двоен onApplied) -> идемпотентно
 *   [12] Темпорален (is_temporary=1) профил -> ineligible_profile, изключен
 *   [13] Грешка в campaignCreditStore (затворена connection) -> hook не хвърля
 *   [14] source_id/campaign_id/event_at коректно записани в ledger
 *   [15] Ludo реална победа (real runtime forfeit-finish) -> печелившият начислен, губещият не (loserRow===undefined)
 *   [17] Ludo winnerColor===null (status finished без winner) -> no-op
 *   [18] Ludo hook грешка -> връща false (за markMatchRemoved gate-а)
 *   [19] activeLudoMatchSnapshotStore.getFinishedAt — стабилен след повторен upsert
 *   [20] Reconciliation: липсващ ledger ред с доказан stake -> backfill-ва се
 *   [21] Reconciliation: вече начислен мач -> НЕ се пипа повторно (0 credited)
 *   [22] Reconciliation: доказана нулева ставка (без stake_debit за никого) -> credited at stake 0
 *   [23] Reconciliation: аномален частичен debit -> skipped, НЕ се познава ставка
 *   [24] Reconciliation: Guest Trial ред -> изключен от скенирането
 *   [25] Source review — index.ts викa recordBelotMatchForCampaign СЛЕД payout-match-winners, вътре в shouldRunMatchCompletionSideEffects guard-а
 *   [26] Source review — index.ts гейтва markMatchRemoved (onSnapshot И boot recovery) с campaignCredited
 *
 * Изход: process.exit(0) при успех, process.exit(1) иначе.
 */

import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createCampaignsStore, type CampaignsStore } from '../src/campaigns/campaignsStore.js'
import { createCampaignCreditStore, type CampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'
import {
  recordBelotMatchForCampaign,
  recordLudoMatchForCampaign,
  reconcileMissingBelotCampaignCredits,
} from '../src/campaigns/campaignGameHooks.js'
import { createActiveLudoMatchSnapshotStore } from '../src/db/activeLudoMatchSnapshotStore.js'
import { createLudoMatchRuntime, type LudoMatchSnapshot } from '../src/game/ludoMatchRuntime.js'
import type { LudoRoom } from '../src/game/ludoRoomsStore.js'
import type { ServerRoom, Seat, Team } from '../src/core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../src/game/serverGameTypes.js'

process.env.CAMPAIGNS_FEATURE_ENABLED = '1'

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

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

console.log('\ncheckCampaignGameHooks\n')

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

const dbDir = await mkdtemp(join(tmpdir(), 'belot-campaign-game-hooks-'))
const dbPath = join(dbDir, 'test.db')
await applyMigrations(dbPath)

const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
rawDb.exec('PRAGMA foreign_keys = ON;')

function insertProfile(
  profileId: string,
  displayName: string,
  opts: { kind?: 'human' | 'bot'; isTemporary?: boolean } = {},
): void {
  rawDb
    .prepare(
      `INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary
      ) VALUES (?, NULL, ?, NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', ?)`,
    )
    .run(profileId, opts.kind ?? 'human', displayName, displayName.toLowerCase(), opts.isTemporary ? 1 : 0)
}

const campaignsStore: CampaignsStore = await createCampaignsStore(dbPath)
const campaignCreditStore: CampaignCreditStore = await createCampaignCreditStore(dbPath)
const ADMIN_ACTOR = { type: 'admin' as const, profileId: randomUUID() }
insertProfile(ADMIN_ACTOR.profileId, 'Admin')

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

// Overlap guard-ът (campaignsStore.ts::hasOverlap) проверява САМО срещу
// status IN ('scheduled','active') кампании — 'finished' никога не блокира
// бъдещи overlap-ващи прозорци. Понеже ТУК веднага преминаваме
// schedule->activate->finish синхронно (виж по-долу, mirror на
// checkCampaignCreditStore.ts's seedCampaign() прецедент — Фаза 1 налага
// ГЛОБАЛНО максимум 1 "жива" (scheduled/active) кампания едновременно), всяка
// следваща seedActiveCampaign() може безопасно да ползва СЪЩИЯ [now-1h,
// now+1000h) прозорец — предишната вече е 'finished' преди следващият
// draft/schedule дори да стартира. eventAt=now е валиден sample В рамките на
// тоя прозорец за всички тестове по-долу (makeBelotRoom's default endedAt е
// Date.now()).
function seedActiveCampaign(earnRules: Array<{ gameKind: 'belot' | 'ludo'; stake: number; units: number }>): { campaignId: string; eventAt: Date } {
  const eventAt = new Date()
  const startsAt = hoursFromNow(-1)
  const endsAt = hoursFromNow(1000)

  const draft = campaignsStore.createDraftCampaign(
    { name: `Hooks Test Campaign ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
    ADMIN_ACTOR,
  )
  if (!draft.ok) throw new Error('seedActiveCampaign: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId

  for (const rule of earnRules) {
    rawDb.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, ?, ?, ?);`).run(
      campaignId, rule.gameKind, rule.stake, rule.units,
    )
  }

  const scheduled = campaignsStore.scheduleCampaign(campaignId, ADMIN_ACTOR)
  if (!scheduled.ok) throw new Error('seedActiveCampaign: scheduleCampaign failed')
  const activated = campaignsStore.activateCampaign(campaignId, new Date(), ADMIN_ACTOR)
  if (!activated.ok) throw new Error('seedActiveCampaign: activateCampaign failed')
  const finished = campaignsStore.finishCampaign(campaignId, new Date(new Date(endsAt).getTime() + 3_600_000), ADMIN_ACTOR)
  if (!finished.ok) throw new Error('seedActiveCampaign: finishCampaign failed')

  return { campaignId, eventAt }
}

function getLedgerRow(campaignId: string, profileId: string, sourceType: string, sourceId: string):
  { units_amount: number; event_at: string } | undefined {
  return rawDb
    .prepare(`SELECT units_amount, event_at FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_type = ? AND source_id = ?;`)
    .get(campaignId, profileId, sourceType, sourceId) as { units_amount: number; event_at: string } | undefined
}

function countLedgerRowsForSource(sourceType: string, sourceId: string): number {
  const row = rawDb
    .prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_type = ? AND source_id = ?;`)
    .get(sourceType, sourceId) as { c: number }
  return row.c
}

// ─── Белот fixtures (mirror checkLudoProgressionIntegration.ts's builders) ───

function makeHumanParticipant(profileId: string) {
  return {
    kind: 'human' as const,
    playerId: randomUUID(), connectionId: null, isConnected: true,
    joinedAt: 0, lastSeenAt: 0, reconnectToken: null, permanentlyLeftAt: null,
    identity: { accountId: null, profileId, username: null, displayName: 'Player', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
  }
}
function makeBotParticipant(botProfileId: string) {
  return {
    kind: 'bot' as const,
    playerId: randomUUID(), joinedAt: 0, botCode: 'balanced-easy', difficulty: 'easy' as const,
    botProfileId,
    identity: { accountId: null, profileId: null, username: null, displayName: 'Bot', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
  }
}
function makeSeat(seat: Seat, team: Team, participant: ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null) {
  return { seat, team, participant }
}
function makeMatchEndedState(winnerTeam: Team, endedAt: number): ServerAuthoritativeGameState {
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
    matchEnded: { winnerTeam, targetScore: 151, finalScore: pts, endedAt },
    score: {
      round: { tricks: emptyScore, declarations: emptyScore, belote: emptyScore, lastTen: emptyScore, capot: emptyScore, total: emptyScore },
      match: pts, carryOver: { teamA: 0, teamB: 0 },
    },
    timer: { activeSeat: null, startedAt: null, durationMs: null, expiresAt: null },
  } as unknown as ServerAuthoritativeGameState
}

type MakeBelotRoomOptions = {
  stakeAmount?: number | null
  isGuestTrial?: boolean
  winnerTeam?: Team
  endedAt?: number
  seatParticipants?: Partial<Record<Seat, ReturnType<typeof makeHumanParticipant> | ReturnType<typeof makeBotParticipant> | null>>
}
function makeBelotRoom(roomId: string, seatProfiles: Record<Seat, string>, options: MakeBelotRoomOptions = {}): ServerRoom {
  const winnerTeam = options.winnerTeam ?? 'A'
  const endedAt = options.endedAt ?? Date.now()
  const defaultParticipants: Record<Seat, ReturnType<typeof makeHumanParticipant>> = {
    bottom: makeHumanParticipant(seatProfiles.bottom),
    top: makeHumanParticipant(seatProfiles.top),
    right: makeHumanParticipant(seatProfiles.right),
    left: makeHumanParticipant(seatProfiles.left),
  }
  const participants = { ...defaultParticipants, ...options.seatParticipants }
  return {
    id: roomId, status: 'playing', createdAt: 0, updatedAt: 0, hostPlayerId: null,
    config: {
      maxPlayers: 4, allowBots: true, isPrivate: false, joinCode: null,
      stakeAmount: options.stakeAmount === undefined ? 100 : options.stakeAmount,
      targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 30000,
      isGuestTrial: options.isGuestTrial ?? false,
    },
    seats: {
      bottom: makeSeat('bottom', 'A', participants.bottom),
      top: makeSeat('top', 'A', participants.top),
      right: makeSeat('right', 'B', participants.right),
      left: makeSeat('left', 'B', participants.left),
    },
    game: {
      phase: 'match-ended', stateVersion: 1, startedAt: 0, updatedAt: 0,
      activeTimerId: null, timerDeadlineAt: null, authoritativeState: makeMatchEndedState(winnerTeam, endedAt),
    },
    replayVotes: [], leaveVotes: [],
  } as unknown as ServerRoom
}

// ═══════════════════════════════════════════════════════════════════════
// [1]-[2] Нормална победа/загуба
// ═══════════════════════════════════════════════════════════════════════
console.log('=== [1]-[2] Нормална Белот победа/загуба ===')

await check('[1] Белот победа (отбор A, stake=100): и двамата печеливши начислени, губещите не', async () => {
  const seatProfiles: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, profileId] of Object.entries(seatProfiles)) insertProfile(profileId, `T1 ${seat}`)
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seatProfiles, { stakeAmount: 100, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  const bottomRow = getLedgerRow(campaignId, seatProfiles.bottom, 'belot_win', roomId)
  const topRow = getLedgerRow(campaignId, seatProfiles.top, 'belot_win', roomId)
  assert.ok(bottomRow !== undefined && bottomRow.units_amount === 25, 'bottom (team A, winner) трябва да е credited 25')
  assert.ok(topRow !== undefined && topRow.units_amount === 25, 'top (team A, winner) трябва да е credited 25')
})

await check('[2] Губещ отбор (B) не получава ledger ред', () => {
  const seatProfiles: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, profileId] of Object.entries(seatProfiles)) insertProfile(profileId, `T2 ${seat}`)
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seatProfiles, { stakeAmount: 100, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 2, 'само 2-та печеливши (team A) seats трябва да имат ledger редове')
  const rightRow = rawDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE profile_id = ? AND source_id = ?;`).get(seatProfiles.right, roomId)
  assert.equal(rightRow, undefined, 'губещ (team B) не бива да е в ledger-а изобщо')
})

// ═══════════════════════════════════════════════════════════════════════
// [3]-[6] Изключения
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [3]-[6] Изключения (бот/guest-trial/турнир/липсваща ставка) ===')

await check('[3] Бот участник (kind=bot, НЕ temp-bot-*) на печелившия отбор -> изключен', () => {
  const humanBottom = randomUUID()
  const botTop = `bot-${randomUUID()}`
  const right = randomUUID()
  const left = randomUUID()
  insertProfile(humanBottom, 'T3 human', { kind: 'human' })
  insertProfile(botTop, 'T3 bot', { kind: 'bot' })
  insertProfile(right, 'T3 right')
  insertProfile(left, 'T3 left')
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, { bottom: humanBottom, top: botTop, right, left }, {
    stakeAmount: 100, winnerTeam: 'A',
    seatParticipants: { top: makeBotParticipant(botTop) },
  })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 1, 'само human bottom трябва да е credited, ботът на top изключен')
  const humanRow = rawDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE profile_id = ? AND source_id = ?;`).get(humanBottom, roomId)
  assert.ok(humanRow !== undefined, 'човешкия победител трябва да е credited')
})

await check('[4] Guest Trial room (config.isGuestTrial=true) -> никой не се начислява', () => {
  const seatProfiles: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, profileId] of Object.entries(seatProfiles)) insertProfile(profileId, `T4 ${seat}`)
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seatProfiles, { stakeAmount: 100, winnerTeam: 'A', isGuestTrial: true })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 0, 'guest trial room -> нулево начисление')
})

await check('[5] Турнирен мач (isTournamentMatch:true) -> никой не се начислява', () => {
  const seatProfiles: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, profileId] of Object.entries(seatProfiles)) insertProfile(profileId, `T5 ${seat}`)
  seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seatProfiles, { stakeAmount: 0, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: true })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 0, 'турнирен мач -> нулево начисление, независимо от stake=0 rule')
})

await check('[6] stakeAmount null/undefined (недостоверна информация) -> no-op, без ledger ред', () => {
  const seatProfiles: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, profileId] of Object.entries(seatProfiles)) insertProfile(profileId, `T6 ${seat}`)
  seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 25 }])
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seatProfiles, { stakeAmount: null, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 0, 'липсваща ставка не бива да се третира като 0')
})

// ═══════════════════════════════════════════════════════════════════════
// [7]-[8] Stake-specific rules
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [7]-[8] Stake-specific earn rules ===')

await check('[7] Различни stakes -> различни units_per_win rules прилагат се коректно', () => {
  const { campaignId } = seedActiveCampaign([
    { gameKind: 'belot', stake: 50, units: 10 },
    { gameKind: 'belot', stake: 200, units: 60 },
  ])

  const seatsA: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seatsA)) insertProfile(id, `T7a ${seat}`)
  const roomA = `belot-room-${randomUUID()}`
  recordBelotMatchForCampaign({ campaignCreditStore, room: makeBelotRoom(roomA, seatsA, { stakeAmount: 50, winnerTeam: 'A' }), isTournamentMatch: false })

  const seatsB: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seatsB)) insertProfile(id, `T7b ${seat}`)
  const roomB = `belot-room-${randomUUID()}`
  recordBelotMatchForCampaign({ campaignCreditStore, room: makeBelotRoom(roomB, seatsB, { stakeAmount: 200, winnerTeam: 'A' }), isTournamentMatch: false })

  assert.equal(getLedgerRow(campaignId, seatsA.bottom, 'belot_win', roomA)?.units_amount, 10)
  assert.equal(getLedgerRow(campaignId, seatsB.bottom, 'belot_win', roomB)?.units_amount, 60)
})

await check('[8] Доказана нулева ставка (stakeAmount:0) с конфигурирано rule -> credited', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 5 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T8 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  recordBelotMatchForCampaign({ campaignCreditStore, room: makeBelotRoom(roomId, seats, { stakeAmount: 0, winnerTeam: 'A' }), isTournamentMatch: false })
  assert.equal(getLedgerRow(campaignId, seats.bottom, 'belot_win', roomId)?.units_amount, 5)
})

// ═══════════════════════════════════════════════════════════════════════
// [9]-[14] Edge cases
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [9]-[14] Edge cases (без кампания/flag off/repeat/temp-профил/грешки) ===')

await check('[9] Без елигибилна кампания (eventAt извън всеки прозорец) -> no-op, без throw', () => {
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T9 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  // Далеч в бъдещето — извън всеки seedActiveCampaign() прозорец досега.
  const farFutureEndedAt = Date.now() + 5000 * 3_600_000
  assert.doesNotThrow(() => {
    recordBelotMatchForCampaign({
      campaignCreditStore,
      room: makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt: farFutureEndedAt }),
      isTournamentMatch: false,
    })
  })
  assert.equal(countLedgerRowsForSource('belot_win', roomId), 0)
})

await check('[10] Feature flag OFF -> пълен no-op', () => {
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T10 ${seat}`)
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 99 }])
  const roomId = `belot-room-${randomUUID()}`
  const previous = process.env.CAMPAIGNS_FEATURE_ENABLED
  delete process.env.CAMPAIGNS_FEATURE_ENABLED
  try {
    recordBelotMatchForCampaign({ campaignCreditStore, room: makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' }), isTournamentMatch: false })
  } finally {
    process.env.CAMPAIGNS_FEATURE_ENABLED = previous
  }
  assert.equal(countLedgerRowsForSource('belot_win', roomId), 0, 'flag OFF -> нулеви DB промени')
})

await check('[11] Повторно извикване за СЪЩИЯ room (двоен onApplied) -> идемпотентно, без двойно начисление', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T11 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  const room = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })
  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })

  assert.equal(countLedgerRowsForSource('belot_win', roomId), 2, 'двоен call не бива да дублира редове')
  assert.equal(campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom), 25, 'total не бива да се удвои')
})

await check('[12] Временен/guest профил (is_temporary=1) -> ineligible_profile, изключен (defense-in-depth)', () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const tempProfileId = randomUUID()
  insertProfile(tempProfileId, 'T12 temp', { isTemporary: true })
  const result = campaignCreditStore.creditCampaignUnits({
    profileId: tempProfileId, sourceType: 'belot_win', sourceId: `belot-room-${randomUUID()}`,
    eventAt: new Date(), stakeAmount: 100,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'ineligible_profile')
})

await check('[13] campaignCreditStore грешка (затворена connection) -> recordBelotMatchForCampaign не хвърля', async () => {
  const isolatedStore = await createCampaignCreditStore(dbPath)
  isolatedStore.close()
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T13 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  assert.doesNotThrow(() => {
    recordBelotMatchForCampaign({ campaignCreditStore: isolatedStore, room: makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' }), isTournamentMatch: false })
  })
})

await check('[14] source_id/campaign_id/event_at коректно записани в ledger редa', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `T14 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  const endedAt = Date.now() - 60_000
  recordBelotMatchForCampaign({ campaignCreditStore, room: makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt }), isTournamentMatch: false })
  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', roomId)
  assert.ok(row !== undefined, 'ledger редът трябва да съществува')
  assert.equal(new Date(row!.event_at).getTime(), endedAt, 'event_at трябва да е точно matchEnded.endedAt, не "сега"')
})

// ═══════════════════════════════════════════════════════════════════════
// [15]-[19] Ludo
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [15]-[19] Ludo ===')

let ludoRoomSerial = 0
function makeLudoRoom(): LudoRoom {
  ludoRoomSerial += 1
  const hostProfileId = `ludo-p1-${ludoRoomSerial}`
  return {
    // hostProfileId MUST match players[0].profileId — computeInitialMatchData
    // (ludoMatchRuntime.ts) assigns randomTwoPlayerCreatorColor() ONLY to
    // whichever player's profileId === hostProfileId; a mismatch silently
    // gives BOTH players the same (opposite) color.
    id: `ludo-room-${ludoRoomSerial}`, stake: 150, playerCount: 2, manualStart: false,
    hostProfileId, createdAt: 1,
    players: [
      { connectionId: 'c1', profileId: hostProfileId, displayName: 'Ludo Player 1', avatarUrl: null },
      { connectionId: 'c2', profileId: `ludo-p2-${ludoRoomSerial}`, displayName: 'Ludo Player 2', avatarUrl: null },
    ],
  }
}

await check('[15] Ludo реална победа (real runtime forfeit-finish) -> печелившият начислен коректно по stake', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'ludo', stake: 150, units: 40 }])
  const ludoRoom = makeLudoRoom()
  insertProfile(ludoRoom.players[0]!.profileId, 'Ludo Winner')
  insertProfile(ludoRoom.players[1]!.profileId, 'Ludo Loser')

  let finished: LudoMatchSnapshot | null = null
  const runtime = createLudoMatchRuntime({
    now: () => 1_000_000,
    randomTwoPlayerCreatorColor: () => 'red',
    onSnapshot: (snapshot) => { if (snapshot.state.status === 'finished') finished = snapshot },
  })
  const started = runtime.createMatch(ludoRoom, `ludo-match-${randomUUID()}`)
  // p2 напуска -> p1 (red) остава last-player-standing победител.
  runtime.leave(started.matchId, ludoRoom.players[1]!.profileId)
  runtime.destroy()

  assert.ok(finished !== null, 'очаква се finished snapshot')
  const credited = recordLudoMatchForCampaign({ campaignCreditStore, snapshot: finished!, eventAt: new Date() })
  assert.equal(credited, true)
  const winnerRow = getLedgerRow(campaignId, ludoRoom.players[0]!.profileId, 'ludo_win', finished!.matchId)
  assert.ok(winnerRow !== undefined && winnerRow.units_amount === 40, 'победителят трябва да е credited 40 единици по stake=150 rule')
  const loserRow = getLedgerRow(campaignId, ludoRoom.players[1]!.profileId, 'ludo_win', finished!.matchId)
  assert.equal(loserRow, undefined, 'губещият не бива да е в ledger-а')
})

await check('[17] winnerColor===null (finished без winner) -> no-op, без throw', () => {
  const ludoRoom = makeLudoRoom()
  insertProfile(ludoRoom.players[0]!.profileId, 'Ludo A')
  insertProfile(ludoRoom.players[1]!.profileId, 'Ludo B')
  const fakeSnapshot = {
    matchId: `ludo-match-${randomUUID()}`,
    ludoRoomId: ludoRoom.id,
    stake: 150,
    revision: 1,
    serverNow: Date.now(),
    deadlineAt: null,
    players: ludoRoom.players.map((p, i) => ({ profileId: p.profileId, displayName: p.displayName, avatarUrl: null, color: i === 0 ? 'red' : 'blue' as const })),
    state: { status: 'finished', winnerColor: null } as any,
    events: [],
    botControlledColors: [],
    diceLuckByColor: {},
  } as unknown as LudoMatchSnapshot
  assert.doesNotThrow(() => {
    const credited = recordLudoMatchForCampaign({ campaignCreditStore, snapshot: fakeSnapshot, eventAt: new Date() })
    assert.equal(credited, true)
  })
  assert.equal(countLedgerRowsForSource('ludo_win', fakeSnapshot.matchId), 0)
})

await check('[18] Ludo hook грешка (затворена connection) -> връща false, не хвърля', async () => {
  const isolatedStore = await createCampaignCreditStore(dbPath)
  isolatedStore.close()
  const ludoRoom = makeLudoRoom()
  insertProfile(ludoRoom.players[0]!.profileId, 'Ludo C')
  insertProfile(ludoRoom.players[1]!.profileId, 'Ludo D')
  const fakeSnapshot = {
    matchId: `ludo-match-${randomUUID()}`, ludoRoomId: ludoRoom.id, stake: 150, revision: 1,
    serverNow: Date.now(), deadlineAt: null,
    players: [
      { profileId: ludoRoom.players[0]!.profileId, displayName: 'A', avatarUrl: null, color: 'red' as const },
      { profileId: ludoRoom.players[1]!.profileId, displayName: 'B', avatarUrl: null, color: 'blue' as const },
    ],
    state: { status: 'finished', winnerColor: 'red' } as any,
    events: [], botControlledColors: [], diceLuckByColor: {},
  } as unknown as LudoMatchSnapshot
  let credited: boolean | undefined
  assert.doesNotThrow(() => {
    credited = recordLudoMatchForCampaign({ campaignCreditStore: isolatedStore, snapshot: fakeSnapshot, eventAt: new Date() })
  })
  assert.equal(credited, false, 'грешка в credit store-а трябва да върне false (за markMatchRemoved gate-а в index.ts)')
})

await check('[19] activeLudoMatchSnapshotStore.getFinishedAt — стабилен "оригинален момент" след повторен upsert', async () => {
  const snapshotStore = await createActiveLudoMatchSnapshotStore(dbPath)
  try {
    const ludoRoom = makeLudoRoom()
    const matchId = `ludo-match-${randomUUID()}`
    const snapshot = {
      matchId, ludoRoomId: ludoRoom.id, stake: 150, revision: 1, serverNow: Date.now(), deadlineAt: null,
      players: [{ profileId: 'p1', displayName: 'A', avatarUrl: null, color: 'red' as const }],
      state: { status: 'finished', winnerColor: 'red' } as any,
      events: [], botControlledColors: [], diceLuckByColor: {},
    } as unknown as LudoMatchSnapshot
    snapshotStore.upsertMatch(snapshot)
    const firstFinishedAt = snapshotStore.getFinishedAt(matchId)
    assert.ok(firstFinishedAt !== null)
    // Повторен upsert (симулира boot-recovery re-persist) -> finished_at НЕ се мести.
    snapshotStore.upsertMatch({ ...snapshot, revision: 2 })
    const secondFinishedAt = snapshotStore.getFinishedAt(matchId)
    assert.equal(secondFinishedAt, firstFinishedAt, 'finished_at трябва да остане ОРИГИНАЛНИЯТ момент, не да се обновява при повторен upsert')
    snapshotStore.markMatchRemoved(matchId)
    assert.equal(snapshotStore.getFinishedAt(matchId), null, 'след markMatchRemoved -> null')
  } finally {
    snapshotStore.close()
  }
})

// ═══════════════════════════════════════════════════════════════════════
// [20]-[24] Reconciliation (§8 crash recovery)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [20]-[24] Boot-time reconciliation (reconcileMissingBelotCampaignCredits) ===')

function seedMatchResult(roomId: string, profileId: string, opts: { didWin: boolean; isGuestTrial?: boolean; completedAtIso?: string }): void {
  rawDb.prepare(`
    INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
    VALUES (?, ?, 'A', ?, ?, ?);
  `).run(roomId, profileId, opts.didWin ? 1 : 0, opts.completedAtIso ?? new Date().toISOString().slice(0, 19).replace('T', ' '), opts.isGuestTrial ? 1 : 0)
}
function seedStakeDebit(roomId: string, profileId: string, amount: number): void {
  rawDb.prepare(`
    INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
    VALUES (?, ?, ?, 'stake_debit', ?, 0);
  `).run(randomUUID(), roomId, profileId, amount)
}

await check('[20] Липсващ ledger ред с доказан stake (stake_debit съществува) -> backfill-ва се коректно', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 75, units: 15 }])
  const winnerId = randomUUID()
  insertProfile(winnerId, 'T20 winner')
  const roomId = `belot-room-${randomUUID()}`
  seedMatchResult(roomId, winnerId, { didWin: true })
  seedStakeDebit(roomId, winnerId, 75)

  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  assert.ok(result.credited >= 1, `очакваше се поне 1 credited, got ${JSON.stringify(result)}`)
  const row = getLedgerRow(campaignId, winnerId, 'belot_win', roomId)
  assert.ok(row !== undefined && row.units_amount === 15, 'reconciliation трябва да ползва реалния stake_debit=75 -> rule за 75 -> 15 units')
})

await check('[21] Вече начислен мач -> НЕ се пипа повторно при следващо reconciliation изпълнение', async () => {
  const winnerId = randomUUID()
  insertProfile(winnerId, 'T21 winner')
  seedActiveCampaign([{ gameKind: 'belot', stake: 75, units: 15 }])
  const roomId = `belot-room-${randomUUID()}`
  seedMatchResult(roomId, winnerId, { didWin: true })
  seedStakeDebit(roomId, winnerId, 75)

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const second = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const touchedThisRoom = rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE source_id = ?;`).get(roomId) as { c: number }
  assert.equal(touchedThisRoom.c, 1, 'втори reconciliation run не бива да създаде втори ред за същия мач')
  assert.equal(second.scanned, 0, 'вече backfill-натият мач вече не е "missing", не бива да се сканира отново')
})

await check('[22] Доказана нулева ставка (НИКОЙ в room-а няма stake_debit) -> reconciled at stake 0', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 8 }])
  const winnerId = randomUUID()
  insertProfile(winnerId, 'T22 winner')
  const roomId = `belot-room-${randomUUID()}`
  seedMatchResult(roomId, winnerId, { didWin: true })
  // Съзнателно БЕЗ seedStakeDebit — доказана нулева ставка (турнир/free-play).

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const row = getLedgerRow(campaignId, winnerId, 'belot_win', roomId)
  assert.ok(row !== undefined && row.units_amount === 8, 'липса на ВСЯКАКЪВ stake_debit за room-а -> stake=0 (доказан факт, не 0 units)')
})

await check('[23] Аномален частичен debit (друг участник има stake_debit, този не) -> skipped, НЕ се credit-ва', async () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 50, units: 12 }])
  const winnerId = randomUUID()
  const otherParticipantId = randomUUID()
  insertProfile(winnerId, 'T23 winner')
  insertProfile(otherParticipantId, 'T23 other')
  const roomId = `belot-room-${randomUUID()}`
  seedMatchResult(roomId, winnerId, { didWin: true })
  // winnerId НЯМА stake_debit, но otherParticipantId (загубилия partner) има.
  seedStakeDebit(roomId, otherParticipantId, 50)

  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  assert.ok(result.skippedInsufficientStakeInfo >= 1, 'аномалията трябва да се broji като skipped')
  const row = rawDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE profile_id = ? AND source_id = ?;`).get(winnerId, roomId)
  assert.equal(row, undefined, 'не бива да се измисля ставка за профила без собствен stake_debit')
})

await check('[24] Guest Trial ред в profile_match_results -> изключен от reconciliation скенирането', async () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 99 }])
  const guestId = randomUUID()
  insertProfile(guestId, 'T24 guest')
  const roomId = `belot-room-${randomUUID()}`
  seedMatchResult(roomId, guestId, { didWin: true, isGuestTrial: true })

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const row = rawDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE profile_id = ? AND source_id = ?;`).get(guestId, roomId)
  assert.equal(row, undefined, 'guest trial match никога не влиза в reconciliation-а')
})

// ═══════════════════════════════════════════════════════════════════════
// [25]-[26] Source review — wiring в index.ts (mirror на checkLudoProgressionIntegration.ts's [E1]/[E2])
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [25]-[26] Source review (index.ts wiring) ===')

const indexTsSource = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')

await check('[25] index.ts вика recordBelotMatchForCampaign СЛЕД payout-match-winners, вътре в shouldRunMatchCompletionSideEffects guard-а', () => {
  const payoutIdx = indexTsSource.indexOf("'payout-match-winners'")
  const campaignIdx = indexTsSource.indexOf("'record-campaign-belot-win'")
  const guardIdx = indexTsSource.lastIndexOf('shouldRunMatchCompletionSideEffects(previousRoom, room)', campaignIdx)
  assert.ok(payoutIdx !== -1 && campaignIdx !== -1, 'очаквани call sites не намерени в index.ts')
  assert.ok(campaignIdx > payoutIdx, 'campaign hook трябва да е СЛЕД payout-match-winners')
  assert.ok(guardIdx !== -1 && guardIdx < campaignIdx, 'campaign hook трябва да е след shouldRunMatchCompletionSideEffects guard-а')
})

await check('[26] index.ts гейтва markMatchRemoved (onSnapshot И boot recovery) с campaignCredited', () => {
  const occurrences = indexTsSource.split('&& campaignCredited').length - 1
  assert.equal(occurrences, 2, 'очакват се точно 2 call sites, гейтващи markMatchRemoved с campaignCredited (normal onSnapshot + boot recovery)')
})

// ═══════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed\n`)
campaignCreditStore.close()
campaignsStore.close()
rawDb.close()
await rm(dbDir, { recursive: true, force: true })
if (failed > 0) process.exit(1)

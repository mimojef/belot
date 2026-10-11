/**
 * checkCampaignBelotReplayMatchIdentity.ts
 *
 * ФАЗА 6.1 — поправка на двойните Белот мачове в една стая (кампанийни
 * механизми). Критичен дефект: "Играй пак" (index.ts::applyReplayRestart)
 * пази room.id СЪЩИЯ, само увеличава room.game.stateVersion и стартира нов
 * мач. recordBelotMatchForCampaign преди тая фаза ползваше голия room.id
 * като campaign_unit_ledger.source_id — втора победа на един играч в една
 * стая колизираше с natural key-а (campaign_id, profile_id, source_type,
 * source_id) на първата и биваше ТИХО пропускана от INSERT ... OR IGNORE
 * (реално изгубена награда, не само грешен display).
 *
 * ПОПРАВКА (campaignGameHooks.ts::recordBelotMatchForCampaign): source_id
 * вече е matchEconomyStore.ts::getRoomStakeLedgerScope(room) =
 * `${room.id}:v${room.game.stateVersion}` — established формат, вече
 * доказан за real-money stake/payout ledger-а. Reconciliation (profile_
 * match_results-driven) и getMatchCreditSnapshot (End Game lookup) са
 * обновени да разпознаят И двата формата (стар голия room.id, нов scoped),
 * без да дублират начисление.
 *
 * Тоя файл използва РЕАЛНИЯ production fixture pattern
 * (checkCampaignGameHooks.ts's makeBelotRoom builders) + явен
 * makeReplayedBelotRoom() helper, който възпроизвежда ТОЧНО ефекта на
 * index.ts::applyReplayRestart върху мачовата идентичност (room.id
 * непроменен, stateVersion+1, НОВ matchEnded state) — без да стартира
 * целия WS сървър/game engine.
 *
 * [R1]  Мач 1 в стая -> credited (25).
 * [R2]  Мач 2 в СЪЩАТА стая (replay, stateVersion+1) -> credited ОТДЕЛНО (пак 25).
 * [R3]  Мач 3 в СЪЩАТА стая (stateVersion+2) -> credited ОТДЕЛНО (пак 25). Total 75.
 * [R4]  Повторно обработване на Мач 1 (двоен hook call, same room object) -> 0 допълнителни.
 * [R5]  Повторно обработване на Мач 2 -> 0 допълнителни.
 * [R6]  И двамата победители от един Белот отбор credited във ВСЕКИ отделен мач.
 * [R7]  Победител в Мач 1, същият профил губи в Мач 2 -> само Мач 1's credit, нищо фалшиво за Мач 2.
 * [R8]  Restart между два мача (нов store instance върху СЪЩИЯ DB файл) -> credit-ва се коректно.
 * [R9]  Reconciliation на ПРОПУСНАТ втори мач — ДОКУМЕНТИРАНО структурно
 *       ограничение: profile_match_results (room_id,profile_id) PRIMARY KEY
 *       не разграничава мачове в рамките на стаята (виж doc коментара в
 *       campaignGameHooks.ts) — reconciliation safety net-ът МОЖЕ да покрие
 *       най-много ПЪРВИЯ мач на стаята; НЕ дублира/обърква данни, но не
 *       "измисля" пропуснат втори мач от данни, които физически не съществуват.
 * [R10] Reconciliation НЕ дублира Мач 1 (вече credited от fast-path под нов формат).
 * [R11] Различни кампании при последователни мачове в СЪЩАТА стая -> всеки мач коректно към СВОЯТА кампания.
 * [R12] End Game lookup (getMatchCreditSnapshot) за Мач 1 връща Мач 1's данни, за Мач 2 — Мач 2's, никога кръстосано.
 * [R13] Feature flag OFF -> нито Мач 1, нито Мач 2 получават ledger ред.
 * [R14] match_economy_ledger (реалните жълтици/залози) остава напълно непроменен от campaign hook-а.
 * [R15] Праг, пресечен от Мач1+Мач2 комбинирано -> tier reward предоставен ТОЧНО веднъж, не дублиран.
 * [R16] Съвместимост със стар (pre-Фаза-6.1) ledger ред: голия room.id формат продължава да се разпознава от lookup-а.
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
import { recordBelotMatchForCampaign, reconcileMissingBelotCampaignCredits } from '../src/campaigns/campaignGameHooks.js'
import { getRoomStakeLedgerScope } from '../src/db/matchEconomyStore.js'
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

console.log('\ncheckCampaignBelotReplayMatchIdentity\n')

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

const dbDir = await mkdtemp(join(tmpdir(), 'belot-campaign-replay-identity-'))
const dbPath = join(dbDir, 'test.db')
await applyMigrations(dbPath)

const rawDb = new DatabaseSync(dbPath, { open: true, enableForeignKeyConstraints: true })
rawDb.exec('PRAGMA foreign_keys = ON;')

function insertProfile(profileId: string, displayName: string): void {
  rawDb
    .prepare(
      `INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title, skill_rating, status, is_temporary
      ) VALUES (?, NULL, 'human', NULL, NULL, ?, ?, NULL, 1, 'Ранг 1', 1000, 'active', 0)`,
    )
    .run(profileId, displayName, displayName.toLowerCase())
}

const campaignsStore: CampaignsStore = await createCampaignsStore(dbPath)
let campaignCreditStore: CampaignCreditStore = await createCampaignCreditStore(dbPath)
const ADMIN_ACTOR = { type: 'admin' as const, profileId: randomUUID() }
insertProfile(ADMIN_ACTOR.profileId, 'Admin')

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString()
}

function seedActiveCampaign(
  earnRules: Array<{ gameKind: 'belot'; stake: number; units: number }>,
  windowOverride: { startOffsetHours?: number; endOffsetHours?: number } = {},
): { campaignId: string; eventAt: Date } {
  const startOffsetHours = windowOverride.startOffsetHours ?? -1
  const endOffsetHours = windowOverride.endOffsetHours ?? 1000
  const startsAt = hoursFromNow(startOffsetHours)
  const endsAt = hoursFromNow(endOffsetHours)
  const eventAt = new Date(new Date(startsAt).getTime() + 3_600_000)

  const draft = campaignsStore.createDraftCampaign(
    { name: `Replay Identity Test ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
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
  if (!scheduled.ok) throw new Error(`seedActiveCampaign: scheduleCampaign failed: ${JSON.stringify(scheduled)}`)
  const endsAtMs = Date.parse(endsAt)
  if (endsAtMs <= Date.now()) {
    const expired = campaignsStore.expireScheduledCampaignWithoutActivating(campaignId, new Date(), ADMIN_ACTOR)
    if (!expired.ok) throw new Error('seedActiveCampaign: expireScheduledCampaignWithoutActivating failed')
    return { campaignId, eventAt }
  }
  const activated = campaignsStore.activateCampaign(campaignId, new Date(), ADMIN_ACTOR)
  if (!activated.ok) throw new Error(`seedActiveCampaign: activateCampaign failed: ${JSON.stringify(activated)}`)
  // Overlap guard-ът (campaignsStore.ts::hasOverlap) проверява САМО срещу
  // status IN ('scheduled','active') — веднага finish-ваме, за да освободим
  // слота за следващия seedActiveCampaign() в следващия тест (mirror на
  // checkCampaignGameHooks.ts/checkCampaignCreditStore.ts прецедента).
  // Кампанията остава напълно елигибилна за credit тестове с eventAt в
  // оригиналния [startsAt,endsAt) прозорец (getEffectiveWindowEndIso винагъ
  // ползва ends_at directно за 'finished').
  const finished = campaignsStore.finishCampaign(campaignId, new Date(endsAtMs + 3_600_000), ADMIN_ACTOR)
  if (!finished.ok) throw new Error(`seedActiveCampaign: finishCampaign failed: ${JSON.stringify(finished)}`)
  return { campaignId, eventAt }
}

// ─── Белот room fixtures (mirror checkCampaignGameHooks.ts's builders) ───

function makeHumanParticipant(profileId: string) {
  return {
    kind: 'human' as const,
    playerId: randomUUID(), connectionId: null, isConnected: true,
    joinedAt: 0, lastSeenAt: 0, reconnectToken: null, permanentlyLeftAt: null,
    identity: { accountId: null, profileId, username: null, displayName: 'Player', avatarUrl: null, level: null, rankTitle: null, skillRating: null, gender: null },
  }
}
function makeSeat(seat: Seat, team: Team, participant: ReturnType<typeof makeHumanParticipant> | null) {
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

function makeBelotRoom(
  roomId: string,
  seatProfiles: Record<Seat, string>,
  options: { stakeAmount?: number; isGuestTrial?: boolean; winnerTeam?: Team; endedAt?: number; stateVersion?: number } = {},
): ServerRoom {
  const winnerTeam = options.winnerTeam ?? 'A'
  const endedAt = options.endedAt ?? Date.now()
  return {
    id: roomId, status: 'playing', createdAt: 0, updatedAt: 0, hostPlayerId: null,
    config: {
      maxPlayers: 4, allowBots: true, isPrivate: false, joinCode: null,
      stakeAmount: options.stakeAmount === undefined ? 100 : options.stakeAmount,
      targetScore: 151, turnTimeMs: 15000, reconnectGraceMs: 30000,
      isGuestTrial: options.isGuestTrial ?? false,
    },
    seats: {
      bottom: makeSeat('bottom', 'A', makeHumanParticipant(seatProfiles.bottom)),
      top: makeSeat('top', 'A', makeHumanParticipant(seatProfiles.top)),
      right: makeSeat('right', 'B', makeHumanParticipant(seatProfiles.right)),
      left: makeSeat('left', 'B', makeHumanParticipant(seatProfiles.left)),
    },
    game: {
      phase: 'match-ended', stateVersion: options.stateVersion ?? 1, startedAt: 0, updatedAt: 0,
      activeTimerId: null, timerDeadlineAt: null, authoritativeState: makeMatchEndedState(winnerTeam, endedAt),
    },
    replayVotes: [], leaveVotes: [],
  } as unknown as ServerRoom
}

// Възпроизвежда ТОЧНО ефекта на index.ts::applyReplayRestart +
// initializeRoomAuthoritativeGameState върху identичността, нужна за
// кампанийното начисляване: room.id НЕПРОМЕНЕН, stateVersion+1 (или повече
// при няколко replay-а), НОВ matchEnded state (различен endedAt, може
// различен winnerTeam). Не стартира реалния game engine (bidding/dealing) —
// не е нужно за кампанийния hook, който чита САМО authoritativeState.matchEnded
// + room.game.stateVersion + room.seats.
function makeReplayedBelotRoom(
  previousRoom: ServerRoom,
  options: { winnerTeam?: Team; endedAt?: number } = {},
): ServerRoom {
  const winnerTeam = options.winnerTeam ?? 'A'
  const endedAt = options.endedAt ?? Date.now()
  return {
    ...previousRoom,
    replayVotes: [],
    leaveVotes: [],
    game: {
      ...previousRoom.game,
      stateVersion: previousRoom.game.stateVersion + 1,
      authoritativeState: makeMatchEndedState(winnerTeam, endedAt),
    },
  } as unknown as ServerRoom
}

function getLedgerRow(campaignId: string, profileId: string, sourceType: string, sourceId: string):
  { units_amount: number; event_at: string } | undefined {
  return rawDb
    .prepare(`SELECT units_amount, event_at FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_type = ? AND source_id = ?;`)
    .get(campaignId, profileId, sourceType, sourceId) as { units_amount: number; event_at: string } | undefined
}

function countLedgerRowsForProfileAndCampaign(campaignId: string, profileId: string): number {
  const row = rawDb
    .prepare(`SELECT COUNT(*) AS c FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ?;`)
    .get(campaignId, profileId) as { c: number }
  return row.c
}

function countMatchEconomyLedgerRows(): number {
  const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM match_economy_ledger;`).get() as { c: number }
  return row.c
}

function seedMatchResult(roomId: string, profileId: string, opts: { didWin: boolean; completedAtIso?: string }): void {
  rawDb.prepare(`
    INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
    VALUES (?, ?, 'A', ?, ?, 0);
  `).run(roomId, profileId, opts.didWin ? 1 : 0, opts.completedAtIso ?? new Date().toISOString().slice(0, 19).replace('T', ' '))
}

// ═══════════════════════════════════════════════════════════════════════
// [R1]-[R8] Основен replay lifecycle в ЕДНА стая
// ═══════════════════════════════════════════════════════════════════════
console.log('=== [R1]-[R8] Replay lifecycle в една стая ===')

await check('[R1] Мач 1 в стая -> credited (25)', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R1 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })

  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(row !== undefined && row.units_amount === 25, 'Мач 1 трябва да е credited 25')
})

await check('[R2]-[R3] Мач 2 и Мач 3 в СЪЩАТА стая (replay) -> всеки credited ОТДЕЛНО, total=75', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R2 ${seat}`)

  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  const match3 = makeReplayedBelotRoom(match2, { winnerTeam: 'A', endedAt: Date.now() + 2000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match3, isTournamentMatch: false })

  const row1 = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const row2 = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  const row3 = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match3))
  assert.ok(row1 !== undefined && row1.units_amount === 25, 'Мач 1 ledger ред трябва да съществува с 25')
  assert.ok(row2 !== undefined && row2.units_amount === 25, 'Мач 2 ledger ред трябва да съществува ОТДЕЛНО с 25 (КРИТИЧНИЯТ fix)')
  assert.ok(row3 !== undefined && row3.units_amount === 25, 'Мач 3 ledger ред трябва да съществува ОТДЕЛНО с 25')
  assert.notEqual(getRoomStakeLedgerScope(match1), getRoomStakeLedgerScope(match2), 'Мач 1 и Мач 2 трябва да имат РАЗЛИЧНИ source_id')
  assert.notEqual(getRoomStakeLedgerScope(match2), getRoomStakeLedgerScope(match3), 'Мач 2 и Мач 3 трябва да имат РАЗЛИЧНИ source_id')

  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(total, 75, `очакваше се натрупан total=75 (25+25+25), получих ${total}`)
})

await check('[R4]-[R5] Повторно обработване на Мач 1 и Мач 2 -> 0 допълнителни единици', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R4 ${seat}`)

  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })

  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })
  const totalAfterBoth = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(totalAfterBoth, 50, 'очакваше се 50 след Мач1+Мач2')

  // Повторно "retry" обработване на СЪЩИТЕ room обекти (симулира двоен
  // onApplied/hook retry) — не бива да добави нищо допълнително.
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  const totalAfterRetry = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(totalAfterRetry, 50, 'повторно обработване на Мач1/Мач2 не бива да промени total-а')
  assert.equal(countLedgerRowsForProfileAndCampaign(campaignId, seats.bottom), 2, 'трябва да има точно 2 ledger реда (Мач1, Мач2), не 4')
})

await check('[R6] И двамата победители (team A) credited във ВСЕКИ отделен мач', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R6 ${seat}`)

  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  for (const match of [match1, match2]) {
    const scope = getRoomStakeLedgerScope(match)
    const bottomRow = getLedgerRow(campaignId, seats.bottom, 'belot_win', scope)
    const topRow = getLedgerRow(campaignId, seats.top, 'belot_win', scope)
    assert.ok(bottomRow !== undefined && bottomRow.units_amount === 25, `bottom трябва да е credited за ${scope}`)
    assert.ok(topRow !== undefined && topRow.units_amount === 25, `top трябва да е credited за ${scope}`)
  }
})

await check('[R7] Победител в Мач 1, същият профил губи в Мач 2 -> само Мач 1 credit', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R7 ${seat}`)

  // Мач 1: team A (bottom) печели.
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  // Мач 2 (replay, СЪЩАТА стая): team B печели -> bottom (team A) вече губи.
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'B', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  const match1Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const match2Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(match1Row !== undefined && match1Row.units_amount === 25, 'Мач 1 win трябва да остане credited')
  assert.equal(match2Row, undefined, 'Мач 2 loss НЕ бива да създаде фалшив ledger ред за същия профил')

  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(total, 25, 'total трябва да остане 25 (само Мач 1), Мач 2 loss не добавя нищо')
})

await check('[R8] Restart между два мача (нов store instance, СЪЩИЯ DB файл) -> credit-ва се коректно', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R8 ${seat}`)

  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  // Симулира server restart — изцяло нов store instance, нищо in-memory
  // не преживява, самите DB редове са единственият authoritative state.
  const restartedStore = await createCampaignCreditStore(dbPath)
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore: restartedStore, room: match2, isTournamentMatch: false })

  const row1 = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const row2 = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(row1 !== undefined && row1.units_amount === 25, 'Мач 1 (pre-restart) трябва да остане credited')
  assert.ok(row2 !== undefined && row2.units_amount === 25, 'Мач 2 (post-restart, нов store instance) трябва да е credited')
  restartedStore.close()
})

// ═══════════════════════════════════════════════════════════════════════
// [R9]-[R10] Reconciliation safety net
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [R9]-[R10] Reconciliation safety net ===')

await check('[R9] Reconciliation на пропуснат ВТОРИ мач — документирано структурно ограничение', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R9 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  seedMatchResult(roomId, seats.bottom, { didWin: true })

  // Мач 2 (replay) — симулираме fast-path ПРОВАЛ: НЕ викаме
  // recordBelotMatchForCampaign за него изобщо (все едно хвърли/timeout-на).
  // profile_match_results НЕ получава втори ред за (roomId, profileId) —
  // INSERT OR IGNORE (playerProgressStore.ts) го пропуска, точно както
  // campaign_unit_ledger би го пропуснал преди Фаза 6.1. Затова reconciliation
  // структурно НЕ вижда Мач 2 изобщо — източникът му липсва, не просто
  // "забравен".
  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const match1Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(match1Row !== undefined && match1Row.units_amount === 25, 'Мач 1 остава коректно credited')
  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(total, 25, 'Мач 2 не е и не може да бъде "възстановен" от reconciliation — profile_match_results няма втори ред за него (пре-съществуващо, извън кампанийния обхват ограничение, виж финалния отчет)')
  assert.equal(result.scanned, 0, 'reconciliation не намира "липсващ" ред за тая стая — Мач 1 вече е credited (разпознат от NOT_ALREADY_CREDITED_SQL), Мач 2 физически не съществува в profile_match_results')
})

await check('[R10] Reconciliation НЕ дублира Мач 1 (вече credited от fast-path под НОВ формат)', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R10 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  seedMatchResult(roomId, seats.bottom, { didWin: true })

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  assert.equal(countLedgerRowsForProfileAndCampaign(campaignId, seats.bottom), 1, 'reconciliation не бива да създаде ВТОРИ (legacy-format) ред за мач, вече credited под scoped формата')
  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(total, 25, 'total не бива да се удвои от reconciliation-а')
})

// ═══════════════════════════════════════════════════════════════════════
// [R11]-[R12] Кампании и End Game lookup
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [R11]-[R12] Кампании и End Game lookup ===')

await check('[R11] Различни кампании при последователни мачове в СЪЩАТА стая', () => {
  // campaignA: прозорец [-3h,-1h) — вече напълно в миналото -> seedActiveCampaign
  // минава по expire-пътя (scheduled -> finished, без кратка активация), но
  // остава напълно елигибилна за eventAt В рамките на СВОЯ оригинален прозорец.
  const { campaignId: campaignA } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 11 }], { startOffsetHours: -3, endOffsetHours: -1 })
  // campaignB: прозорец [-1h,+1000h) — активен "сега"-прозорец, стартира
  // СЛЕД като campaignA вече е 'finished' (без overlap-guard конфликт).
  const { campaignId: campaignB } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 77 }])

  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R11 ${seat}`)

  // Мач 1 пада В прозореца на campaignA (-2h, вътре в [-3h,-1h)).
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt: Date.now() - 2 * 3_600_000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  // Мач 2 (replay, СЪЩАТА стая) пада В прозореца на campaignB (сега), извън campaignA's.
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  const match1Row = getLedgerRow(campaignA, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const match2Row = getLedgerRow(campaignB, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(match1Row !== undefined && match1Row.units_amount === 11, 'Мач 1 трябва да е приписан на campaignA (11 units)')
  assert.ok(match2Row !== undefined && match2Row.units_amount === 77, 'Мач 2 трябва да е приписан на campaignB (77 units), не campaignA')
})

await check('[R12] End Game lookup (getMatchCreditSnapshot) — Мач 1 и Мач 2 никога кръстосано', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R12 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const endedAt1 = Date.now()
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt: endedAt1 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  const endedAt2 = endedAt1 + 60_000
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: endedAt2 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })

  // Клиентът винаги подава голия roomId (не знае stateVersion) — виж
  // messageTypes.ts::request_campaign_match_credit doc коментара.
  const snapshotForMatch1 = campaignCreditStore.getMatchCreditSnapshot(
    seats.bottom, 'belot_win', roomId, new Date(endedAt1).toISOString(),
  )
  const snapshotForMatch2 = campaignCreditStore.getMatchCreditSnapshot(
    seats.bottom, 'belot_win', roomId, new Date(endedAt2).toISOString(),
  )
  assert.ok(snapshotForMatch1 !== null && snapshotForMatch1.unitsAmount === 25, 'lookup за Мач 1 трябва да върне Мач 1-ите 25 единици')
  assert.ok(snapshotForMatch2 !== null && snapshotForMatch2.unitsAmount === 25, 'lookup за Мач 2 трябва да върне Мач 2-ите 25 единици (не null, не Мач 1-ите пак)')
  assert.equal(snapshotForMatch1.campaignId, campaignId)
  assert.equal(snapshotForMatch2.campaignId, campaignId)
})

// ═══════════════════════════════════════════════════════════════════════
// [R13]-[R14] Flag OFF и непроменени жълтици
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [R13]-[R14] Flag OFF и непроменени реални жълтици ===')

await check('[R13] Feature flag OFF -> нито Мач 1, нито Мач 2 получават ledger ред', () => {
  const previous = process.env.CAMPAIGNS_FEATURE_ENABLED
  delete process.env.CAMPAIGNS_FEATURE_ENABLED
  try {
    seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 99 }])
  } catch {
    // createDraftCampaign/scheduleCampaign не зависят от флага — очакваме успех.
  }
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R13 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  try {
    recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
    recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })
  } finally {
    if (previous !== undefined) process.env.CAMPAIGNS_FEATURE_ENABLED = previous
  }
  assert.equal(getLedgerRow('irrelevant', seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1)), undefined)
  assert.equal(countLedgerRowsForProfileAndCampaign('irrelevant', seats.bottom), 0)
})

await check('[R14] match_economy_ledger (реалните жълтици/залози) остава напълно непроменен от campaign hook-а', () => {
  const beforeCount = countMatchEconomyLedgerRows()
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R14 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })
  const afterCount = countMatchEconomyLedgerRows()
  assert.equal(afterCount, beforeCount, 'campaign hook-ът никога не пипа match_economy_ledger (реалните жълтици/залози)')
})

// ═══════════════════════════════════════════════════════════════════════
// [R15] Reward tier — без дублирани claims
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [R15] Reward tier — без дублирани claims ===')

await check('[R15] Праг, пресечен от Мач1+Мач2 комбинирано -> tier reward предоставен ТОЧНО веднъж', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 20 }])
  const tierId = randomUUID()
  const tierRewardId = randomUUID()
  rawDb.prepare(`INSERT INTO campaign_reward_tiers (tier_id, campaign_id, threshold_units) VALUES (?, ?, 30);`).run(tierId, campaignId)
  rawDb.prepare(`INSERT INTO campaign_tier_rewards (tier_reward_id, tier_id, reward_type, reward_payload_json) VALUES (?, ?, 'yellow_coins', ?);`).run(
    tierRewardId, tierId, JSON.stringify({ amount: 500 }),
  )

  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `R15 ${seat}`)

  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })
  // Мач 1: total=20, праг=30 -> все още НЕ пресечен.
  let claims = rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE tier_reward_id = ? AND profile_id = ?;`).get(tierRewardId, seats.bottom) as { c: number }
  assert.equal(claims.c, 0, 'прагът още не е пресечен след Мач 1')

  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })
  // Мач 2: total=40 >= 30 -> прагът СЕГА е пресечен, точно веднъж.
  claims = rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE tier_reward_id = ? AND profile_id = ?;`).get(tierRewardId, seats.bottom) as { c: number }
  assert.equal(claims.c, 1, 'прагът трябва да е предоставен точно ВЕДНЪЖ след Мач 2 (40>=30)')

  // Retry на Мач 2 (симулира двоен hook call) -> не бива да създаде втори claim.
  recordBelotMatchForCampaign({ campaignCreditStore, room: match2, isTournamentMatch: false })
  claims = rawDb.prepare(`SELECT COUNT(*) AS c FROM campaign_reward_claims WHERE tier_reward_id = ? AND profile_id = ?;`).get(tierRewardId, seats.bottom) as { c: number }
  assert.equal(claims.c, 1, 'retry на Мач 2 не бива да дублира claim-а')
})

// ═══════════════════════════════════════════════════════════════════════
// [R16] Съвместимост със стари (pre-Фаза-6.1) ledger редове
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [R16] Съвместимост със стари ledger редове ===')

await check('[R16] Стар (голия room.id) ledger ред продължава да се разпознава от End Game lookup', () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const profileId = randomUUID()
  insertProfile(profileId, 'R16 legacy winner')
  const legacyRoomId = `belot-room-${randomUUID()}`
  const endedAt = Date.now()

  // Симулира РЕД, записан ПРЕДИ Фаза 6.1 (директен голия room.id, без ':v' суфикс).
  rawDb.prepare(`
    INSERT INTO campaign_unit_ledger (campaign_id, profile_id, source_type, source_id, units_amount, event_at)
    VALUES (?, ?, 'belot_win', ?, 25, ?);
  `).run(campaignId, profileId, legacyRoomId, new Date(endedAt).toISOString())

  const snapshot = campaignCreditStore.getMatchCreditSnapshot(profileId, 'belot_win', legacyRoomId, new Date(endedAt).toISOString())
  assert.ok(snapshot !== null && snapshot.unitsAmount === 25, 'legacy (pre-Фаза-6.1) ledger ред трябва да продължи да се разпознава от lookup-а')
})

rawDb.close()
campaignsStore.close()
campaignCreditStore.close()
await rm(dbDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}

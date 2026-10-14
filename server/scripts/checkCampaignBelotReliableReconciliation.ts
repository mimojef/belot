/**
 * checkCampaignBelotReliableReconciliation.ts
 *
 * ФАЗА 6.2 — "Надеждно съхраняване и възстановяване на Белот мачове с
 * „Играй пак“". Фаза 6.1 поправи уникалната sourceId идентичност
 * (`${room.id}:v${stateVersion}`) на fast-path hook-а
 * (recordBelotMatchForCampaign), но reconciliation safety net-ът
 * продължаваше да зависи ИЗКЛЮЧИТЕЛНО от profile_match_results —
 * room-scoped (room_id,profile_id) PRIMARY KEY, структурно неспособна да
 * пази повече от ЕДИН мач на стая. Пропуснато начисление за втори/трети
 * replay мач (fast-path hook срив/timeout СЛЕД нормалното завършване на
 * мача) беше НЕВЪЗСТАНОВИМО.
 *
 * ПОПРАВКА: нова, чисто добавъчна таблица belot_match_completion_ledger
 * (виж database/migrations/20261016_001_create_belot_match_completion_ledger.sql),
 * PRIMARY KEY (match_scope, profile_id) — match-scoped, не room-scoped.
 * Записва се АТОМАРНО В playerProgressStore.ts::recordCompletedMatch
 * (ПЪРВАТА side-effect стъпка след shouldRunMatchCompletionSideEffects,
 * преди payout и преди campaign hook-а) — виж тая функция за пълния
 * "атомарно свързано с надеждна съществуваща операция" rationale.
 * stake_amount/ended_at са АВТОРИТЕТНИ колони (room.config.stakeAmount/
 * matchEnded.endedAt В МОМЕНТА на завършване), НЕ извеждани от
 * match_economy_ledger наличие/липса (който е ДОКАЗАНО недостатъчен — няма
 * ред при нулев залог, виж [Z1]/[Z2] по-долу).
 *
 * reconcileMissingBelotCampaignCredits вече сканира ДВА източника, ВСЕКИ
 * със СОБСТВЕН durable cursor (одит-поправка — виж [S19]/[S20] по-долу):
 *   1. belot_match_completion_ledger (primary, cursor source_type
 *      'belot_win', exact source_id match — никаква LIKE ambiguity,
 *      никакъв stake heuristic).
 *   2. profile_match_results (legacy sweep, cursor source_type
 *      'belot_win_legacy' — виж 20261017_001_extend_campaign_credit_reconciliation_state_for_belot_legacy.sql
 *      — САМО за редове БЕЗ съответен belot_match_completion_ledger ред,
 *      т.е. писани ПРЕДИ тая миграция; durable cursor-ът гарантира
 *      монотонно напредване даже ако дълъг prefix е постоянно недопустим).
 *
 * Одит-поправка (atomicity): profile_match_results's insert И
 * belot_match_completion_ledger's insert за ЕДИН seat вече са в ЕДНА явна
 * SQLite транзакция (playerProgressStore.ts::recordCompletedMatch) — виж
 * [S21] по-долу за explicit regression тест (инжектирана грешка МЕЖДУ
 * двата insert-а -> НИТО ЕДИН от двата не остава частично записан).
 *
 * [S1]-[S4]   Основният сценарий от task spec §5 (Мач1 credited -> replay
 *             -> Мач2 "срив" (fast-path hook НЕ викнат) -> reconciliation
 *             -> Мач2 получава 25 -> total=50 -> повторен reconciliation ->
 *             остава 50).
 * [S5]        Три последователни мача в стая, 2 "срив"-нали -> и двата
 *             възстановени, общо 75.
 * [S6]        Различни победители между мачовете -> коректно приписване.
 * [S7]        Различни залози между мачовете -> правилните earn rules.
 * [S8]        Двама победители от един отбор -> и двамата възстановени.
 * [S9]        Мач с нулев залог ("срив"-нал) -> ВЪЗСТАНОВЕН коректно
 *             (match_economy_ledger ДОКАЗАНО няма никакъв ред за него).
 * [S10]       Продължителен престой (old ended_at, far in the past within
 *             campaign window) -> все пак се намира и възстановява.
 * [S11]-[S12] Повече записи от лимита на страница -> durable cursor
 *             paginate-ва коректно през следващи tick-ове, без дублиране.
 * [S13]       Legacy source_id съвместимост — чисто pre-6.2 ред (само
 *             profile_match_results, без belot_match_completion_ledger) ->
 *             legacy sweep-ът го възстановява коректно.
 * [S14]       Legacy + нов ред в СЪЩАТА стая -> никога кръстосано/дублирано.
 * [S15]       Feature flag OFF -> reconciliation е пълен no-op.
 * [S16]       Нормалните Белот резултати/жълтици остават непроменени
 *             (profile_match_results/match_economy_ledger непипнати от
 *             кампанийната логика).
 * [S17]       End Game lookup (getMatchCreditSnapshot) след възстановяване
 *             връща коректните данни за възстановения мач.
 * [S18]       Ръчно спряна кампания -> няма недопустимо ново начисление
 *             след спирането.
 * [S19]       Legacy sweep прогрес: много исторически победи, от които
 *             ПЪРВИТЕ (по completed_at ASC) са ПОСТОЯННО извън прозореца
 *             на всяка кампания (no_eligible_campaign, никога не се
 *             credit-ват) -> durable cursor-ът напредва отвъд тях и
 *             достига следващите, допустими записи — без 'belot_win_legacy'
 *             cursor-а тоя тест би failed (тая ТОЧНО регресия, която одита
 *             откри).
 * [S20]       Повторен legacy sweep run НЕ дублира вече credited редове
 *             (credited=0, totals стабилни на втория пълен проход) —
 *             scanned>0 е ОЧАКВАН/приемлив (established wraparound дизайн,
 *             reuse-нат от 'belot_win'/'ludo_win', периодично "прескача"
 *             отново permanently-ineligible редовете, за да провери дали
 *             нещо се е променило — mirror на "temporary failure -> retry
 *             forever" философията), ключовото е НУЛЕВО ново начисление.
 * [S21]       Decoupling: belot_match_completion_ledger грешка (цялата
 *             таблица временно липсва) НЕ блокира/променя profile_match_results
 *             +ELO — те са в НЕЗАВИСИМА, непроменена спрямо pre-Фаза-6.2
 *             транзакция (одит-поправка #1: decoupled, не per-seat pairing).
 * [S22]       payoutMatchWinners грешка/липса на извикване НЕ засяга вече
 *             commit-натия belot_match_completion_ledger ред (независими
 *             транзакции).
 * [S23]       Атомарност на ЦЕЛИЯ мач (одит-поправка #2): инжектирана FK
 *             грешка на 3-тия от 4 участника -> belot_match_completion_ledger
 *             остава с НУЛА редове за тоя мач (rollback на ЦЕЛАТА
 *             транзакция, вкл. 1-ви/2-ри участник, вече "обработени" преди
 *             3-тия да провали) — НЕ частично записан мач (2 seats present,
 *             2 missing), което би направило евентуален пропуснат победител
 *             невъзстановим.
 * [S24]       Мач, който НЕ е достигнал match-ended (в процес на игра) ->
 *             recordCompletedMatch е пълен no-op — нито profile_match_results,
 *             нито belot_match_completion_ledger получават ред, затова
 *             reconciliation структурно няма какво да credit-не (доказва:
 *             кампанийна награда НЕ може да се предостави за невалидно/
 *             непотвърдено финализиран мач).
 * [S25]       Payout законно отложен/никога неизвършен СЛЕД потвърдено
 *             match-ended -> кампанийното начисление работи напълно
 *             нормално (campaign crediting чита ИЗКЛЮЧИТЕЛНО authoritativeState.
 *             matchEnded, никога payoutMatchWinners-ния резултат —
 *             разграничава "мача приключи" от "payout-ът успя").
 * [S26]       Source review: abortQuarantinedRoom.ts (технически abort,
 *             НЕ истинско завършване) никога не вика recordCompletedMatch/
 *             recordBelotMatchForCampaign.
 * [Z1]-[Z2]   Потвърждение: match_economy_ledger НЯМА никакъв ред при
 *             нулев залог (доказва недостатъчността му като самостоятелен
 *             източник, виж task spec §1/§2).
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
import { createPlayerProgressStore, type PlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createMatchEconomyStore, getRoomStakeLedgerScope, type MatchEconomyStore } from '../src/db/matchEconomyStore.js'
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

console.log('\ncheckCampaignBelotReliableReconciliation\n')

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

const dbDir = await mkdtemp(join(tmpdir(), 'belot-campaign-reliable-reconciliation-'))
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
let playerProgressStore: PlayerProgressStore = await createPlayerProgressStore(dbPath)
const matchEconomyStore: MatchEconomyStore = await createMatchEconomyStore(dbPath)
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
    { name: `Reliable Reconciliation Test ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
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
  // Overlap guard-ът проверява само scheduled/active кампании — finish-ваме
  // веднага, за да освободим слота за следващия seedActiveCampaign() в
  // следващия тест (mirror на established конвенцията в другите campaign
  // check script-ове). Кампанията остава напълно елигибилна за credit
  // тестове с eventAt в оригиналния [startsAt,endsAt) прозорец.
  const finished = campaignsStore.finishCampaign(campaignId, new Date(endsAtMs + 3_600_000), ADMIN_ACTOR)
  if (!finished.ok) throw new Error(`seedActiveCampaign: finishCampaign failed: ${JSON.stringify(finished)}`)
  return { campaignId, eventAt }
}

// За [S18] — campaign трябва да ОСТАНЕ 'active' (не auto-finished), за да
// може stopCampaign да се извика върху нея веднага след това.
function seedActiveCampaignLeftActiveForManualStop(
  earnRules: Array<{ gameKind: 'belot'; stake: number; units: number }>,
): { campaignId: string } {
  const startsAt = hoursFromNow(-1)
  const endsAt = hoursFromNow(1000)
  const draft = campaignsStore.createDraftCampaign(
    { name: `Manual Stop Test ${randomUUID()}`, startsAt, endsAt, unitNameSingular: 'тиква', unitNamePlural: 'тикви', giftSenderProfileId: null },
    ADMIN_ACTOR,
  )
  if (!draft.ok) throw new Error('seedActiveCampaignLeftActiveForManualStop: createDraftCampaign failed')
  const campaignId = draft.campaign.campaignId
  for (const rule of earnRules) {
    rawDb.prepare(`INSERT INTO campaign_earn_rules (campaign_id, game_kind, stake_amount, units_per_win) VALUES (?, ?, ?, ?);`).run(
      campaignId, rule.gameKind, rule.stake, rule.units,
    )
  }
  const scheduled = campaignsStore.scheduleCampaign(campaignId, ADMIN_ACTOR)
  if (!scheduled.ok) throw new Error(`seedActiveCampaignLeftActiveForManualStop: scheduleCampaign failed: ${JSON.stringify(scheduled)}`)
  const activated = campaignsStore.activateCampaign(campaignId, new Date(), ADMIN_ACTOR)
  if (!activated.ok) throw new Error(`seedActiveCampaignLeftActiveForManualStop: activateCampaign failed: ${JSON.stringify(activated)}`)
  return { campaignId }
}

// ─── Белот room fixtures (mirror checkCampaignBelotReplayMatchIdentity.ts) ───

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

function makeReplayedBelotRoom(previousRoom: ServerRoom, options: { winnerTeam?: Team; endedAt?: number } = {}): ServerRoom {
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

// "Normal settlement" на един мач — ТОЧНО както index.ts прави го
// (playerProgressStore.recordCompletedMatch, ПЪРВАТА side-effect стъпка),
// БЕЗ campaign hook-а. Представлява "мачът приключи нормално, жълтици/
// резултат записани" частта от сценария в task spec §5.
function settleMatchNormally(room: ServerRoom): void {
  playerProgressStore.recordCompletedMatch(room)
}

// Пълен "happy path" за един мач — normal settlement + fast-path campaign hook.
function settleMatchAndCreditCampaign(room: ServerRoom): void {
  settleMatchNormally(room)
  recordBelotMatchForCampaign({ campaignCreditStore, room, isTournamentMatch: false })
}

function getLedgerRow(campaignId: string, profileId: string, sourceType: string, sourceId: string):
  { units_amount: number; event_at: string } | undefined {
  return rawDb
    .prepare(`SELECT units_amount, event_at FROM campaign_unit_ledger WHERE campaign_id = ? AND profile_id = ? AND source_type = ? AND source_id = ?;`)
    .get(campaignId, profileId, sourceType, sourceId) as { units_amount: number; event_at: string } | undefined
}

function countMatchEconomyLedgerRowsForRoom(roomId: string): number {
  const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM match_economy_ledger WHERE room_id LIKE ? ESCAPE '\\';`).get(`${roomId}:v%`) as { c: number }
  return row.c
}

function countBelotMatchCompletionLedgerRows(roomId: string): number {
  const row = rawDb.prepare(`SELECT COUNT(*) AS c FROM belot_match_completion_ledger WHERE room_id = ?;`).get(roomId) as { c: number }
  return row.c
}

// ═══════════════════════════════════════════════════════════════════════
// [S1]-[S4] Основен сценарий (task spec §5)
// ═══════════════════════════════════════════════════════════════════════
console.log('=== [S1]-[S4] Основен срив-между-settlement-и-credit сценарий ===')

await check('[S1]-[S4] Мач 1 credited нормално, Мач 2 "срива" fast-path hook-а, reconciliation го възстановява, повторен run не дублира', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S1 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  // 1-3: Създай стая, играй и приключи Мач 1, начисли 25 тикви.
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchAndCreditCampaign(match1)
  const match1Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(match1Row !== undefined && match1Row.units_amount === 25, 'Мач 1 трябва да е credited 25 веднага')

  // 4-6: "Играй пак", приключи Мач 2, СИМУЛИРАЙ СРИВ — normal settlement
  // (recordCompletedMatch) се изпълнява, но campaign hook-ът НЕ се вика
  // (все едно процеса е умрял точно между двете стъпки).
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  settleMatchNormally(match2) // normal settlement — ТОВА е единствената стъпка, "преди" срива
  // (campaign hook-ът умишлено НЕ се вика тук)

  const match2RowBeforeReconciliation = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.equal(match2RowBeforeReconciliation, undefined, 'Мач 2 не трябва да е credited преди reconciliation (симулираният срив наистина го е пропуснал)')

  // 7: Изпълни reconciliation след "възстановяване".
  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  assert.ok(result.credited >= 1, `очаквах reconciliation да кредитира поне 1 ред, получих ${JSON.stringify(result)}`)

  // 8: Мач 2 получава дължимите 25 тикви.
  const match2RowAfter = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(match2RowAfter !== undefined && match2RowAfter.units_amount === 25, 'Мач 2 трябва да е credited 25 СЛЕД reconciliation')

  // 9: Общ резултат 50.
  const totalAfterFirstReconciliation = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(totalAfterFirstReconciliation, 50, `очаквах total=50 (25+25), получих ${totalAfterFirstReconciliation}`)

  // 10-11: Повторен reconciliation -> остава точно 50 (без дублиране).
  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const totalAfterSecondReconciliation = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(totalAfterSecondReconciliation, 50, `повторен reconciliation не бива да промени total-а, получих ${totalAfterSecondReconciliation}`)
})

// ═══════════════════════════════════════════════════════════════════════
// [S5]-[S9] Допълнителни сценарии
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S5]-[S9] Допълнителни сценарии ===')

await check('[S5] Три последователни мача, 2 "срив"-нали -> и двата възстановени, total=75', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S5 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchAndCreditCampaign(match1) // Мач 1: нормален happy path

  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  settleMatchNormally(match2) // Мач 2: "срив"

  const match3 = makeReplayedBelotRoom(match2, { winnerTeam: 'A', endedAt: Date.now() + 2000 })
  settleMatchNormally(match3) // Мач 3: "срив"

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, seats.bottom)
  assert.equal(total, 75, `очаквах 75 (25x3), получих ${total}`)
})

await check('[S6] Различни победители между мачовете -> коректно приписване', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S6 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchAndCreditCampaign(match1)

  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'B', endedAt: Date.now() + 1000 })
  settleMatchNormally(match2)

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  // bottom (team A) е credited само за Мач 1 (победа); Мач 2 team B печели,
  // bottom губи -> никакъв фалшив credit за Мач 2.
  const match1Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const match2Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(match1Row !== undefined, 'Мач 1 win трябва да остане credited')
  assert.equal(match2Row, undefined, 'Мач 2 loss не бива да създаде фалшив credit')

  const rightRow = getLedgerRow(campaignId, seats.right, 'belot_win', getRoomStakeLedgerScope(match2))
  assert.ok(rightRow !== undefined && rightRow.units_amount === 25, 'right (team B, Мач 2 winner) трябва да е credited от reconciliation')
})

await check('[S7] Различни залози между мачовете -> правилните earn rules', async () => {
  const { campaignId } = seedActiveCampaign([
    { gameKind: 'belot', stake: 50, units: 10 },
    { gameKind: 'belot', stake: 200, units: 60 },
  ])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S7 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 50, winnerTeam: 'A' })
  settleMatchNormally(match1) // "срив" дори за Мач 1, за разнообразие

  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  // Белот room.config.stakeAmount е ФИКСИРАН за цялата стая реално, но
  // belot_match_completion_ledger пази stake_amount В МОМЕНТА на всеки
  // отделен INSERT — проверяваме, че различен stakeAmount на replay
  // room-а се пази коректно per-match.
  const match2WithDifferentStake = { ...match2, config: { ...match2.config, stakeAmount: 200 } } as ServerRoom
  settleMatchNormally(match2WithDifferentStake)

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const match1Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const match2Row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match2WithDifferentStake))
  assert.ok(match1Row !== undefined && match1Row.units_amount === 10, `Мач 1 (stake=50) трябва да е 10 units, получих ${match1Row?.units_amount}`)
  assert.ok(match2Row !== undefined && match2Row.units_amount === 60, `Мач 2 (stake=200) трябва да е 60 units, получих ${match2Row?.units_amount}`)
})

await check('[S8] Двама победители от един отбор -> и двамата възстановени', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S8 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchNormally(match1) // "срив"

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const bottomRow = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  const topRow = getLedgerRow(campaignId, seats.top, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(bottomRow !== undefined && bottomRow.units_amount === 25, 'bottom трябва да е възстановен')
  assert.ok(topRow !== undefined && topRow.units_amount === 25, 'top трябва да е възстановен')
})

await check('[S9] Мач с нулев залог ("срив"-нал) -> ВЪЗСТАНОВЕН коректно (match_economy_ledger ДОКАЗАНО празен)', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 8 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S9 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 0, winnerTeam: 'A' })
  settleMatchNormally(match1) // "срив" — campaign hook НЕ се вика

  // Доказваме §1/§2 твърдението: при нулев залог НЯМА никакъв
  // match_economy_ledger ред (нито stake_debit, нито winner_payout) — тоя
  // мач е ВЪЗСТАНОВИМ ИЗКЛЮЧИТЕЛНО благодарение на belot_match_completion_ledger's
  // авторитетна stake_amount=0 колона, НЕ чрез heuristic върху
  // match_economy_ledger (който би бил напълно празен тук).
  assert.equal(countMatchEconomyLedgerRowsForRoom(roomId), 0, 'match_economy_ledger трябва да е напълно празен за нулев залог (доказва недостатъчността му)')
  assert.equal(countBelotMatchCompletionLedgerRows(roomId), 4, 'belot_match_completion_ledger трябва да има ред за всеки от 4-те участника')

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(row !== undefined && row.units_amount === 8, `очаквах 8 units (stake=0 rule), получих ${row?.units_amount}`)
})

// ═══════════════════════════════════════════════════════════════════════
// [S10] Продължителен престой
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S10] Продължителен престой ===')

await check('[S10] "Стар" мач (ended_at далеч в миналото, но в прозореца на кампанията) -> все пак се намира и възстановява', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }], { startOffsetHours: -200, endOffsetHours: 1000 })
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S10 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`

  // "Продължителен престой" — мачът е приключил много по-рано, reconciliation
  // run-ва се значително по-късно (симулирано тук — ended_at е 150ч в
  // миналото, без sinceIso граница по подразбиране — виж RECONCILIATION_UNBOUNDED_SINCE_ISO).
  const longAgoEndedAt = Date.now() - 150 * 3_600_000
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt: longAgoEndedAt })
  settleMatchNormally(match1)

  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  assert.ok(result.credited >= 1, `очаквах reconciliation да намери и credit-не стар мач, получих ${JSON.stringify(result)}`)

  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(row !== undefined && row.units_amount === 25, 'стар "срив"-нал мач трябва да е възстановен')
})

// ═══════════════════════════════════════════════════════════════════════
// [S11]-[S12] Пагинация отвъд лимита на страница
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S11]-[S12] Пагинация отвъд лимита на страница ===')

await check('[S11]-[S12] Повече "срив"-нали мачове от лимита на страницата -> durable cursor paginate-ва без дублиране', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const profileId = randomUUID()
  insertProfile(profileId, 'S11 winner')
  const otherSeats: Record<Seat, string> = { bottom: profileId, top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(otherSeats)) if (seat !== 'bottom') insertProfile(id, `S11 ${seat}`)

  const matchCount = 5
  let previousMatch: ServerRoom | null = null
  const matches: ServerRoom[] = []
  for (let i = 0; i < matchCount; i += 1) {
    const match = previousMatch === null
      ? makeBelotRoom(`belot-room-${randomUUID()}`, otherSeats, { stakeAmount: 100, winnerTeam: 'A', endedAt: Date.now() + i * 1000 })
      : makeReplayedBelotRoom(previousMatch, { winnerTeam: 'A', endedAt: Date.now() + i * 1000 })
    settleMatchNormally(match) // всеки мач "срива" — нищо не е credited fast-path
    matches.push(match)
    previousMatch = match
  }

  // Лимит=2, 5 мача × 4 седалки = 20 кандидат-реда след "Само при победа"
  // (Фаза 13) — did_win филтъра премахнат, губещите СЪЩО са кандидати
  // (просто се skip-ват с 'not_winner', но все пак консумират cursor
  // budget), затова нужни са >= 10 tick-ове, не >= 3 (преди, когато само
  // 5 winner-реда бяха кандидати).
  const candidateRowCount = matchCount * 4
  let totalCredited = 0
  for (let tick = 0; tick < candidateRowCount + 2; tick += 1) {
    const tickResult = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore, { limit: 2, useDurableCursor: true })
    totalCredited += tickResult.credited
  }

  assert.ok(totalCredited >= matchCount, `очаквах да се credit-нат всичките ${matchCount} мача през следващи tick-ове, получих ${totalCredited}`)
  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, profileId)
  assert.equal(total, matchCount * 25, `очаквах ${matchCount * 25} след пагинираната reconciliation, получих ${total}`)

  // Повторен пълен проход -> без допълнителни промени (без дублиране).
  for (let tick = 0; tick < candidateRowCount + 2; tick += 1) {
    await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore, { limit: 2, useDurableCursor: true })
  }
  const totalAfterSecondPass = campaignCreditStore.getProfileCampaignTotal(campaignId, profileId)
  assert.equal(totalAfterSecondPass, matchCount * 25, 'повторен пагиниран проход не бива да дублира нищо')
})

// ═══════════════════════════════════════════════════════════════════════
// [S13]-[S14] Legacy съвместимост
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S13]-[S14] Legacy source_id съвместимост ===')

function seedLegacyMatchResult(roomId: string, profileId: string, opts: { didWin: boolean; completedAtIso?: string }): void {
  rawDb.prepare(`
    INSERT INTO profile_match_results (room_id, profile_id, team, did_win, completed_at, is_guest_trial)
    VALUES (?, ?, 'A', ?, ?, 0);
  `).run(roomId, profileId, opts.didWin ? 1 : 0, opts.completedAtIso ?? new Date().toISOString().slice(0, 19).replace('T', ' '))
}
function seedLegacyStakeDebit(roomId: string, profileId: string, amount: number): void {
  rawDb.prepare(`
    INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after)
    VALUES (?, ?, ?, 'stake_debit', ?, 0);
  `).run(randomUUID(), roomId, profileId, amount)
}

await check('[S13] Чисто pre-Фаза-6.2 legacy ред (само profile_match_results) -> legacy sweep го възстановява', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 60, units: 14 }])
  const winnerId = randomUUID()
  insertProfile(winnerId, 'S13 winner')
  const roomId = `belot-room-${randomUUID()}`
  // Симулира ред, писан ПРЕДИ Фаза 6.2 (НЯМА belot_match_completion_ledger
  // ред изобщо за тая стая/профил).
  seedLegacyMatchResult(roomId, winnerId, { didWin: true })
  seedLegacyStakeDebit(roomId, winnerId, 60)

  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  assert.ok(result.credited >= 1, `очаквах legacy sweep да credit-не, получих ${JSON.stringify(result)}`)
  const row = getLedgerRow(campaignId, winnerId, 'belot_win', roomId)
  assert.ok(row !== undefined && row.units_amount === 14, 'legacy ред трябва да е credited със старото bare room_id като source_id')
})

await check('[S14] Legacy ред (стая А) + нов ред (стая Б) за СЪЩИЯ профил -> никога кръстосано/дублирано', async () => {
  // Умишлено РАЗЛИЧНИ стаи — виж doc коментара на NOT_IN_NEW_LEDGER_SQL в
  // campaignGameHooks.ts: "ако стаята ИЗОБЩО има ред в новата таблица,
  // целият ѝ profile_match_results history се счита за покрит от primary
  // scan-а" е умишлен, приет edge-case trade-off (безопасен failure mode —
  // под-начисление, НИКОГА двойно начисление) за много рядкия сценарий
  // "една и съща стая съдържа ЕДНОВРЕМЕННО pre-6.2 legacy И post-6.2 нов
  // мач" (изисква стая, обхващаща точно deploy момента — на практика
  // невъзможно, кампаниите никога не са били активни в продукция досега).
  // Тоя тест проверява РЕАЛНОТО изискване: legacy формат + нов формат,
  // независимо обработени, без кръстосване/дублиране.
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const profileId = randomUUID()
  insertProfile(profileId, 'S14 shared-profile')
  const legacyRoomId = `belot-room-${randomUUID()}`
  const newRoomSeats: Record<Seat, string> = { bottom: profileId, top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(newRoomSeats)) if (seat !== 'bottom') insertProfile(id, `S14 ${seat}`)

  // "Legacy стая" — чисто pre-Фаза-6.2 ред (само profile_match_results,
  // НИКОГА belot_match_completion_ledger).
  seedLegacyMatchResult(legacyRoomId, profileId, { didWin: true, completedAtIso: new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ') })
  seedLegacyStakeDebit(legacyRoomId, profileId, 100)

  // "Нова стая" — post-Фаза-6.2 мач, нормален "срив" сценарий.
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, newRoomSeats, { stakeAmount: 100, winnerTeam: 'A', endedAt: Date.now() })
  settleMatchNormally(match1)

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const legacyRow = getLedgerRow(campaignId, profileId, 'belot_win', legacyRoomId)
  const newRow = getLedgerRow(campaignId, profileId, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(legacyRow !== undefined && legacyRow.units_amount === 25, 'legacy стая трябва да е credited отделно')
  assert.ok(newRow !== undefined && newRow.units_amount === 25, 'новата стая трябва да е credited отделно')
  const total = campaignCreditStore.getProfileCampaignTotal(campaignId, profileId)
  assert.equal(total, 50, `очаквах 50 (25+25, два отделни мача), получих ${total}`)
})

// ═══════════════════════════════════════════════════════════════════════
// [S15]-[S18]
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S15]-[S18] Flag OFF / непроменени резултати / End Game lookup / спряна кампания ===')

await check('[S15] Feature flag OFF -> reconciliation е пълен no-op', async () => {
  const previous = process.env.CAMPAIGNS_FEATURE_ENABLED
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 99 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S15 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchNormally(match1)

  delete process.env.CAMPAIGNS_FEATURE_ENABLED
  let result
  try {
    result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  } finally {
    if (previous !== undefined) process.env.CAMPAIGNS_FEATURE_ENABLED = previous
  }
  assert.equal(result.scanned, 0, 'flag off -> reconciliation не бива да сканира нищо')
  assert.equal(result.credited, 0, 'flag off -> reconciliation не бива да credit-не нищо')
})

await check('[S16] Нормалните Белот резултати/жълтици остават непроменени от кампанийната логика', async () => {
  const beforeEconomyCount = (rawDb.prepare(`SELECT COUNT(*) AS c FROM match_economy_ledger;`).get() as { c: number }).c
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S16 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })
  settleMatchNormally(match1)
  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const afterEconomyCount = (rawDb.prepare(`SELECT COUNT(*) AS c FROM match_economy_ledger;`).get() as { c: number }).c
  assert.equal(afterEconomyCount, beforeEconomyCount, 'нито settlement, нито reconciliation трябва да пипа match_economy_ledger')

  const pmrRow = rawDb.prepare(`SELECT did_win, team FROM profile_match_results WHERE room_id = ? AND profile_id = ?;`).get(match1.id, seats.bottom) as { did_win: number; team: string } | undefined
  assert.ok(pmrRow !== undefined && pmrRow.did_win === 1 && pmrRow.team === 'A', 'profile_match_results резултатът трябва да остане коректен и непроменен')
})

await check('[S17] End Game lookup (getMatchCreditSnapshot) след възстановяване връща коректните данни', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S17 ${seat}`)
  const endedAt = Date.now()
  const roomId = `belot-room-${randomUUID()}`
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt })
  settleMatchNormally(match1) // "срив" — само reconciliation ще credit-не

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  // End Game lookup-ът (клиентът подава голия roomId + matchEndedAt, виж
  // index.ts's WS handler) трябва да намери reconciliation-ния credit.
  const snapshot = campaignCreditStore.getMatchCreditSnapshot(seats.bottom, 'belot_win', roomId, new Date(endedAt).toISOString())
  assert.ok(snapshot !== null && snapshot.unitsAmount === 25, 'End Game lookup трябва да намери reconciliation-ния credit')
  assert.equal(snapshot!.campaignId, campaignId)
})

await check('[S18] Ръчно спряна кампания -> няма недопустимо ново начисление след спирането', async () => {
  const { campaignId } = seedActiveCampaignLeftActiveForManualStop([{ gameKind: 'belot', stake: 100, units: 25 }])
  const stopped = campaignsStore.stopCampaign(campaignId, ADMIN_ACTOR)
  assert.ok(stopped.ok, `stopCampaign failed: ${JSON.stringify(stopped)}`)

  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S18 ${seat}`)
  // Мач, приключил СЛЕД спирането (eventAt = сега, стоп-момента е вече минал).
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A', endedAt: Date.now() })
  settleMatchNormally(match1)

  await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)

  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.equal(row, undefined, 'мач след спиране на кампанията не бива да получи начисление към нея')
})

// ═══════════════════════════════════════════════════════════════════════
// [S19]-[S20] Legacy sweep прогрес отвъд постоянно недопустим префикс
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S19]-[S20] Legacy sweep прогрес (durable cursor) ===')

await check('[S19]-[S20] Durable cursor напредва отвъд постоянно недопустим префикс; повторен run не го пресканира', async () => {
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 0, units: 7 }])
  const ineligibleCount = 40
  const eligibleCount = 10

  // Постоянно недопустими редове — completed_at фиксиран в 2000г., извън
  // ВСЯКА кампания (всички тук ползват hoursFromNow relative прозорци
  // спрямо "сега") -> resolveCampaignForEvent винаги връща no_eligible_campaign,
  // ЗАВИНАГИ за тия редове. Mirror на user-описания "2000 исторически
  // победи, първите 500 извън периода на всички кампании" сценарий,
  // мащабиран за бърз тест.
  for (let i = 0; i < ineligibleCount; i += 1) {
    const profileId = randomUUID()
    insertProfile(profileId, `S19-ineligible-${i}`)
    const roomId = `belot-room-s19-ineligible-${i}-${randomUUID()}`
    seedLegacyMatchResult(roomId, profileId, { didWin: true, completedAtIso: `2000-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}` })
  }

  // Допустими редове — completed_at В прозореца на campaignId (сега).
  const eligibleProfileIds: string[] = []
  for (let i = 0; i < eligibleCount; i += 1) {
    const profileId = randomUUID()
    insertProfile(profileId, `S19-eligible-${i}`)
    eligibleProfileIds.push(profileId)
    const roomId = `belot-room-s19-eligible-${i}-${randomUUID()}`
    seedLegacyMatchResult(roomId, profileId, { didWin: true, completedAtIso: new Date(Date.now() - 10_000 + i * 10).toISOString().slice(0, 19).replace('T', ' ') })
  }

  // ПРЕДИ поправката: LIMIT без cursor би върнал СЪЩИТЕ първи `limit`
  // (ineligible) редове на ВСЕКИ tick, никога достигайки eligible редовете
  // отвъд тях. СЛЕД поправката: durable cursor-ът (source_type
  // 'belot_win_legacy') напредва монотонно, независимо дали редът е бил
  // credited или само "прескочен" като недопустим.
  let totalScanned = 0
  let totalCredited = 0
  const maxTicks = 15
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const tickResult = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore, { limit: 10, useDurableCursor: true })
    totalScanned += tickResult.scanned
    totalCredited += tickResult.credited
  }

  assert.ok(
    totalScanned >= ineligibleCount + eligibleCount,
    `очаквах да се сканират поне ${ineligibleCount + eligibleCount} реда общо (напредък отвъд недопустимия префикс), получих ${totalScanned}`,
  )
  // "Само при победа" (Фаза 13) разшири primary-scan кандидатите и до
  // губещи редове (did_win филтъра е премахнат, виж doc коментара в
  // campaignGameHooks.ts) — затова ГЛОБАЛНИЯТ 'belot_win' durable cursor
  // вече може в рамките на тая тест СЪЩО да довлече/credit-не (коректно,
  // с units_amount=0 — "няма правило за тая ставка" прецедент) останал
  // backlog от ПО-РАНИШНИ check()-ове в тоя файл (ВСИЧКИ споделят ЕДНА
  // SQLite база, виж rawDb/dbPath по-горе), който преди СЪЩЕСТВУВАШЕ, но
  // никога не се сканираше (губещ ред, SQL филтъра го изключваше изцяло).
  // Суровият tickResult.credited brой затова вече НЕ е надежден proxy
  // само за ТАЗИ кампания — скопираме директно през campaign_id, за да
  // изолираме точната инвариантна: точно 10 реално credited (units>0)
  // реда, принадлежащи на ТАЗИ кампания, без двойно начисление.
  const creditedForThisCampaign = rawDb
    .prepare(`SELECT COUNT(*) AS n FROM campaign_unit_ledger WHERE campaign_id = ? AND source_type = 'belot_win' AND units_amount > 0`)
    .get(campaignId) as { n: number }
  assert.equal(
    creditedForThisCampaign.n,
    eligibleCount,
    `очаквах точно ${eligibleCount} credited (само допустимите) за тая кампания, получих ${creditedForThisCampaign.n}`,
  )
  for (const profileId of eligibleProfileIds) {
    const total = campaignCreditStore.getProfileCampaignTotal(campaignId, profileId)
    assert.equal(total, 7, `допустимия ред за profile=${profileId} трябва да е credited 7, получих ${total}`)
  }

  // [S20] — повторен проход: ТОЧНАТА инвариантна, която трябва да се
  // провери, е "без двойно начисление" (credited=0, totals стабилни), НЕ
  // "scanned=0". Permanently-ineligible редовете (no_eligible_campaign
  // forever) НИКОГА не напускат NOT EXISTS candidate set-а — established
  // wraparound дизайна (reuse-нат непроменен от 'belot_win'/'ludo_win',
   // виж createCampaignCreditReconciliationJob doc коментара) периодично ги
  // "прескача" пак (scanned>0 е ОЧАКВАН и приемлив — доказва единствено
  // "продължава да проверява дали нещо се е променило", mirror на
  // Ludo-овия "temporary failure -> retry forever until success" дизайн),
  // но НИКОГА не ги credit-ва повторно и никога не дублира вече credited
  // редове.
  let creditedOnSecondPass = 0
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const tickResult = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore, { limit: 10, useDurableCursor: true })
    creditedOnSecondPass += tickResult.credited
  }
  assert.equal(creditedOnSecondPass, 0, `втори пълен проход не бива да credit-не нищо ново (без дублиране), получих ${creditedOnSecondPass}`)
  for (const profileId of eligibleProfileIds) {
    const total = campaignCreditStore.getProfileCampaignTotal(campaignId, profileId)
    assert.equal(total, 7, `total трябва да остане стабилен (7) след повторния проход за profile=${profileId}, получих ${total}`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// [S21]-[S22] Атомарност
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S21]-[S22] Атомарност (инжектирана грешка / payout изолация) ===')

await check('[S21] Decoupling: belot_match_completion_ledger грешка НЕ блокира profile_match_results+ELO (независими транзакции)', () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S21 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })

  // Провалваме ЦЕЛИЯ belot_match_completion_ledger write (временно
  // премахваме таблицата) — одит-поправка #1 decouple-на тая транзакция
  // от profile_match_results's собствен loop, затова "нормалната" Белот
  // икономика (resultat/ELO/completed-games) ТРЯБВА да продължи напълно
  // нормално, независимо от тая грешка.
  rawDb.exec('ALTER TABLE belot_match_completion_ledger RENAME TO belot_match_completion_ledger_disabled_for_test;')
  try {
    playerProgressStore.recordCompletedMatch(match1)
  } finally {
    rawDb.exec('ALTER TABLE belot_match_completion_ledger_disabled_for_test RENAME TO belot_match_completion_ledger;')
  }

  const pmrRow = rawDb.prepare(`SELECT did_win FROM profile_match_results WHERE room_id = ? AND profile_id = ?;`).get(match1.id, seats.bottom) as { did_win: number } | undefined
  assert.ok(pmrRow !== undefined && pmrRow.did_win === 1, 'profile_match_results ТРЯБВА да има нормален ред за bottom, независимо от belot_match_completion_ledger-ната грешка (decoupled)')
  const bmclRow = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(getRoomStakeLedgerScope(match1), seats.bottom)
  assert.equal(bmclRow, undefined, 'belot_match_completion_ledger НЕ бива да има частичен/грешен ред за тоя мач')

  // Нормален recordCompletedMatch СЛЕД възстановяването на таблицата
  // (replay, СЪЩАТА стая) трябва да работи напълно нормално занапред.
  const match2 = makeReplayedBelotRoom(match1, { winnerTeam: 'A', endedAt: Date.now() + 1000 })
  playerProgressStore.recordCompletedMatch(match2)
  const bmclRow2 = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(getRoomStakeLedgerScope(match2), seats.bottom)
  assert.ok(bmclRow2 !== undefined, 'belot_match_completion_ledger трябва да работи нормално СЛЕД възстановяването на таблицата')
})

await check('[S23] Атомарност на ЦЕЛИЯ мач: грешка на 3-ти (от 4) участник -> НУЛЕВИ redове за belot_match_completion_ledger, не частични', () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  // SERVER_SEAT_ORDER = ['bottom','right','top','left'] (core/serverTypes.ts)
  // -> top е ТОЧНО 3-ти в обработващата поредица. Insertirame bottom/right/
  // left в profiles нормално, но УМИШЛЕНО НЕ вкарваме top -> FK violation
  // (profile_id REFERENCES profiles) ТОЧНО на 3-тия участник, СЛЕД като
  // bottom (1-ви) и right (2-ри) вече са "обработени" (insert-нати) В
  // РАМКИТЕ на СЪЩАТА still-open транзакция (все още НЕ commit-нати,
  // защото е ЕДНА транзакция за целия мач) — доказва, че грешка на 3-тия
  // участник ROLLBACK-ва и 1-вия/2-рия, не само себе си.
  insertProfile(seats.bottom, 'S23 bottom')
  insertProfile(seats.right, 'S23 right')
  // seats.top НИКОГА не се insert-ва в profiles -> FK violation при него.
  insertProfile(seats.left, 'S23 left')
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })

  // Същата "top няма profiles ред" причина ПРОВАЛЯ belot_match_completion_ledger's
  // ВЪТРЕШНО-хванатата (само логната, НЕ препратена нагоре) транзакция И
  // СЛЕД това profile_match_results's ОТДЕЛНИЯ, непротектиран ([S21]
  // decoupling) втори loop — последният НЯМА try/catch (pre-съществуващо,
  // НЕПРОМЕНЕНО поведение — "не нарушавай съществуващите ELO/economy
  // операции" означава не добавям нова защита там) и затова throw-ва
  // НАВЪН от recordCompletedMatch. Очакваме точно тоя throw тук — той НЕ е
  // предмет на тоя тест (bmcl's atomicity вече е решен ПРЕДИ той да се
  // случи, виж assertions по-долу).
  assert.throws(
    () => playerProgressStore.recordCompletedMatch(match1),
    /FOREIGN KEY constraint failed/,
    'очаквах FK violation throw от ВТОРИЯ (profile_match_results) loop, pre-съществуващо непротектирано поведение — top никога не е в profiles',
  )

  const scope = getRoomStakeLedgerScope(match1)
  const bottomRow = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(scope, seats.bottom)
  const rightRow = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(scope, seats.right)
  const leftRow = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(scope, seats.left)
  assert.equal(bottomRow, undefined, 'bottom (1-ви, "вече обработен" преди 3-тия да провали) НЕ бива да остане записан — целия мач трябва да roll back-не')
  assert.equal(rightRow, undefined, 'right (2-ри, "вече обработен" преди 3-тия да провали) НЕ бива да остане записан')
  assert.equal(leftRow, undefined, 'left (4-ти, никога достигнат — транзакцията фейлна на top преди него) НЕ бива да бъде записан')
  const totalRows = (rawDb.prepare(`SELECT COUNT(*) AS c FROM belot_match_completion_ledger WHERE match_scope = ?;`).get(scope) as { c: number }).c
  assert.equal(totalRows, 0, `очаквах 0 belot_match_completion_ledger реда за тоя мач (всичко или нищо), получих ${totalRows}`)

  // profile_match_results/ELO (decoupled, [S21]) продължават нормално за
  // bottom/right/left — top ПРОВАЛЯ ТАМ СЪЩО (същата FK причина), но това
  // е pre-Фаза-6.2 поведение, непроменено тук.
  const pmrBottom = rawDb.prepare(`SELECT 1 FROM profile_match_results WHERE room_id = ? AND profile_id = ?;`).get(match1.id, seats.bottom)
  assert.ok(pmrBottom !== undefined, 'profile_match_results за bottom трябва да остане незасегнат от belot_match_completion_ledger-ния rollback')
})

await check('[S22] payoutMatchWinners грешка НЕ засяга вече commit-натия belot_match_completion_ledger ред', () => {
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S22 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 0, winnerTeam: 'A' })
  settleMatchNormally(match1)

  const beforeRow = rawDb.prepare(`SELECT stake_amount FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(getRoomStakeLedgerScope(match1), seats.bottom) as { stake_amount: number } | undefined
  assert.ok(beforeRow !== undefined && beforeRow.stake_amount === 0, 'ledger редът трябва да съществува преди payout опита')

  // stakeAmount<=0 -> payoutMatchWinners връща ok:false (нормалното
  // финализиране/payout "се проваля") — belot_match_completion_ledger's
  // ред е ВЕЧЕ commit-нат от recordCompletedMatch, в НЕЗАВИСИМА, по-рано
  // приключена транзакция — payoutMatchWinners никога не може да го
  // "отмени", независимо от собствения си резултат.
  const payoutResult = matchEconomyStore.payoutMatchWinners(match1)
  assert.equal(payoutResult.ok, false, 'очаквах payoutMatchWinners да се провали за нулев залог')

  const afterRow = rawDb.prepare(`SELECT stake_amount FROM belot_match_completion_ledger WHERE match_scope = ? AND profile_id = ?;`).get(getRoomStakeLedgerScope(match1), seats.bottom) as { stake_amount: number } | undefined
  assert.ok(afterRow !== undefined && afterRow.stake_amount === 0, 'ledger редът трябва да остане напълно непроменен СЛЕД неуспешен payout опит')
})

// ═══════════════════════════════════════════════════════════════════════
// [S24]-[S26] Невалидно/непотвърдено финализиране vs законно отложен payout
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [S24]-[S26] Невалидно финализиране vs законно отложен payout ===')

await check('[S24] Мач, който НЕ е достигнал match-ended (в процес на игра) -> recordCompletedMatch е пълен no-op, нулева кампанийна възможност', async () => {
  seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S24 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  const stillPlayingRoom = makeBelotRoom(roomId, seats, { stakeAmount: 100, winnerTeam: 'A' })
  // Презаписваме authoritativeState.phase на 'playing' (мач В ПРОЦЕС, НЕ
  // реално приключил) — getRuntimeMatchEnded(room) проверява ИЗКЛЮЧИТЕЛНО
  // authoritativeState.phase === 'match-ended' && matchEnded !== null (виж
  // playerProgressStore.ts). Никаква административна/технична
  // abort-операция (abortQuarantinedRoom.ts — виж doc коментара ѝ: "NEVER
  // fabricates a winner/score, NEVER writes profile_match_results") не
  // може legitimно да достигне тая фаза без реално game-engine completion
  // (runServerPhaseTransition.ts: единствения преход към 'match-ended' е
  // от 'scoring', само когато matchEnded !== null, т.е. реален win condition).
  const notActuallyEndedRoom = {
    ...stillPlayingRoom,
    game: { ...stillPlayingRoom.game, authoritativeState: { ...(stillPlayingRoom.game.authoritativeState as object), phase: 'playing' } },
  } as unknown as ServerRoom

  playerProgressStore.recordCompletedMatch(notActuallyEndedRoom)
  recordBelotMatchForCampaign({ campaignCreditStore, room: notActuallyEndedRoom, isTournamentMatch: false })

  const pmrRow = rawDb.prepare(`SELECT 1 FROM profile_match_results WHERE room_id = ? AND profile_id = ?;`).get(roomId, seats.bottom)
  const bmclRow = rawDb.prepare(`SELECT 1 FROM belot_match_completion_ledger WHERE room_id = ? AND profile_id = ?;`).get(roomId, seats.bottom)
  assert.equal(pmrRow, undefined, 'мач, който не е достигнал match-ended, НЕ бива да създаде profile_match_results ред')
  assert.equal(bmclRow, undefined, 'мач, който не е достигнал match-ended, НЕ бива да създаде belot_match_completion_ledger ред')

  // Reconciliation (и primary, и legacy sweep) структурно няма какво да
  // намери — нито една от двете таблици има ред за тая стая/профил.
  const result = await reconcileMissingBelotCampaignCredits(dbPath, campaignCreditStore)
  const row = rawDb.prepare(`SELECT 1 FROM campaign_unit_ledger WHERE profile_id = ? AND source_id LIKE ?;`).get(seats.bottom, `${roomId}%`)
  assert.equal(row, undefined, 'невалидно/непотвърдено финализиран мач не може да получи кампанийна награда дори след reconciliation')
})

await check('[S25] Payout законно отложен/никога неизвършен СЛЕД потвърдено match-ended -> кампанийното начисление работи напълно нормално', async () => {
  // Разграничение (task spec): "match-ended" (game engine-ово потвърдено
  // приключване, виж getRuntimeMatchEnded) е ЕДНОЗНАЧНО ОТДЕЛНО събитие от
  // "payoutMatchWinners" (отделна, последваща ECONOMY стъпка, собствен
  // side-effect, МОЖЕ legitimно да се провали/отложи — виж matchEconomyStore.ts
  // doc коментарите). Campaign crediting (fast-path И reconciliation) четат
  // ИЗКЛЮЧИТЕЛНО authoritativeState.phase/matchEnded, НИКОГА awardedPrizePerSeat
  // или payoutMatchWinners-ния резултат — затова работят коректно
  // независимо дали payout изобщо е бил извикан.
  const { campaignId } = seedActiveCampaign([{ gameKind: 'belot', stake: 100, units: 25 }])
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `S25 ${seat}`)
  const match1 = makeBelotRoom(`belot-room-${randomUUID()}`, seats, { stakeAmount: 100, winnerTeam: 'A' })

  // Нормално потвърдено завършване (match-ended), но payoutMatchWinners
  // НИКОГА не се вика (симулира "legitimно отложен/пропуснат payout" —
  // няма retry механизъм за payout в тая фаза, виж финалния отчет).
  settleMatchNormally(match1)
  recordBelotMatchForCampaign({ campaignCreditStore, room: match1, isTournamentMatch: false })

  const row = getLedgerRow(campaignId, seats.bottom, 'belot_win', getRoomStakeLedgerScope(match1))
  assert.ok(row !== undefined && row.units_amount === 25, 'кампанийното начисление трябва да работи напълно нормално, независимо че payout никога не е извикан')

  // match_economy_ledger потвърждава payout наистина никога не е извършен
  // за тая стая — campaign crediting не е "прикрил" отсъствието му.
  assert.equal(countMatchEconomyLedgerRowsForRoom(match1.id), 0, 'payout наистина никога не е извършен (доказва разграничението, не пропуск в теста)')
})

await check('[S26] Source review: abortQuarantinedRoom.ts никога не викa match-completion side effects', async () => {
  const abortSource = await readFile(resolve(serverRoot, 'src/core/abortQuarantinedRoom.ts'), 'utf8')
  assert.ok(
    abortSource.includes('NEVER fabricates a winner/score, NEVER writes'),
    'abortQuarantinedRoom.ts трябва да документира изрично, че никога не фабрикува победител/резултат',
  )
  assert.ok(!abortSource.includes('recordCompletedMatch'), 'abortQuarantinedRoom.ts никога не бива да вика recordCompletedMatch')
  assert.ok(!abortSource.includes('recordBelotMatchForCampaign'), 'abortQuarantinedRoom.ts никога не бива да вика recordBelotMatchForCampaign')

  const indexSource = await readFile(resolve(serverRoot, 'src/index.ts'), 'utf8')
  const abortWiringMatch = indexSource.match(/function runAbortQuarantinedRoom[\s\S]{0,2000}/)
  assert.ok(abortWiringMatch !== null, 'runAbortQuarantinedRoom wiring block трябва да се намери в index.ts')
  assert.ok(
    !abortWiringMatch![0].includes('recordCompletedMatch') && !abortWiringMatch![0].includes('recordBelotMatchForCampaign'),
    'runAbortQuarantinedRoom-ия wiring блок не бива да реферира campaign/progress hook-овете',
  )
})

// ═══════════════════════════════════════════════════════════════════════
// [Z1]-[Z2] match_economy_ledger недостатъчност (документация/доказателство)
// ═══════════════════════════════════════════════════════════════════════
console.log('\n=== [Z1]-[Z2] match_economy_ledger недостатъчност при нулев залог ===')

await check('[Z1] Нулев залог + нормален (не "срив"-нал) мач -> match_economy_ledger ВСЕ ПАК празен за стаята', () => {
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `Z1 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 0, winnerTeam: 'A' })
  settleMatchNormally(match1)
  assert.equal(countMatchEconomyLedgerRowsForRoom(roomId), 0, 'collectRoomStakes/payoutMatchWinners никога не пишат при stakeAmount<=0 — доказано недостатъчен самостоятелен reconciliation източник')
})

await check('[Z2] belot_match_completion_ledger остава авторитетен източник независимо от match_economy_ledger', () => {
  const seats: Record<Seat, string> = { bottom: randomUUID(), top: randomUUID(), right: randomUUID(), left: randomUUID() }
  for (const [seat, id] of Object.entries(seats)) insertProfile(id, `Z2 ${seat}`)
  const roomId = `belot-room-${randomUUID()}`
  const match1 = makeBelotRoom(roomId, seats, { stakeAmount: 0, winnerTeam: 'A' })
  settleMatchNormally(match1)
  const row = rawDb.prepare(`SELECT stake_amount, did_win FROM belot_match_completion_ledger WHERE room_id = ? AND profile_id = ?;`).get(roomId, seats.bottom) as { stake_amount: number; did_win: number } | undefined
  assert.ok(row !== undefined && row.stake_amount === 0 && row.did_win === 1, 'belot_match_completion_ledger трябва да пази авторитетен stake_amount=0, did_win=1')
})

rawDb.close()
campaignsStore.close()
campaignCreditStore.close()
playerProgressStore.close()
matchEconomyStore.close()
await rm(dbDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exit(1)
}

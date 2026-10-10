// Фаза 3 на системата "Кампании": автоматично начисляване на тематични
// единици при РЕАЛНИ победи в Белот и Ludo. Единствените три call sites,
// от които `campaignCreditStore.creditCampaignUnits()` се вика извън
// admin/retry пътищата (виж campaignCreditStore.ts): двата live-completion
// hook-а по-долу + периодичния reconciliation job (§8 одит, виж doc
// коментара при createCampaignCreditReconciliationJob).
//
// Дизайн принципи (виж task spec §7/§8/§13):
// - Клиентът НИКОГА не определя units/stake/winner — всичко идва от вече
//   authoritative server state (ServerRoom.game.authoritativeState.matchEnded
//   за Белот, LudoMatchSnapshot.state за Ludo), СЛЕД като нормалният резултат
//   (recordCompletedMatch/payoutMatchWinners, settleLudoMatchIfNeeded/
//   recordLudoMatchProgression) вече е финализиран от caller-а.
// - И двете hook функции НИКОГА не хвърлят — вътрешен try/catch, log и
//   безопасен no-op/false return. Белот call site-ът ДОПЪЛНИТЕЛНО е обвит в
//   runMatchCompletionSideEffect() (виж index.ts) — defense in depth, не
//   заместване.
// - Синтетични ботове (kind==='bot', ВСЕКИ, не само temp-bot-* както
//   recordCompletedMatch) и Guest Trial никога не получават начисление.
//   Guest Trial за Белот се проверява тук на room-ниво (config.isGuestTrial);
//   универсалната per-profile defense-in-depth проверка (profile_kind/
//   is_temporary) живее в campaignCreditStore.creditCampaignUnits самата
//   (приложима и за Ludo, което няма room-level guest-trial концепция).
// - Турнирни мачове (isTournamentMatchOrigin) са изрично ИЗКЛЮЧЕНИ от
//   автоматично начисляване в тая фаза — stakeAmount:0 за тях е "без реална
//   икономика" маркер (виж tournamentCoordinator.ts), не "доказана нулева
//   залог-кампания" — да им се задели campaign earn rule e отделно бизнес
//   решение, невзето досега, затова не го предполагаме едностранно тук.
//
// ВАЖНА КОРЕКЦИЯ (одит след първия Фаза 3 commit, виж §1/§2 от одитната
// задача): recordLudoMatchForCampaign-ия булев резултат ВЕЧЕ НЕ гейтва
// activeLudoMatchSnapshotStore.markMatchRemoved в index.ts (виж коментара
// там). Причина: при ПЕРСИСТЕНТНА (не еднократна) кампанийна грешка това
// щеше да остави finished snapshot-и ДА СЕ ТРУПАТ безкрайно в
// active_ludo_match_snapshots, докато не дойде restart — директно противно
// на §7 ("кампаниите никога не блокират нормалното приключване"). Вместо
// това recovery-то за Ludo (точно като за Белот) минава изцяло през
// createCampaignCreditReconciliationJob по-долу, който ползва
// ludo_room_matches (пише се БЕЗУСЛОВНО при всеки finished match,
// независимо от campaign резултата, виж index.ts — никога не се трие) като
// durable source of truth. recordLudoMatchForCampaign продължава да се вика
// от onSnapshot/boot-recovery (fast-path: веднага начислява при успех, без
// да чака следващия reconciliation tick) — булевия резултат се ползва само
// за diagnostic логване, не за да блокира нищо.

import type { Seat } from '../core/serverTypes.js'
import { SERVER_SEAT_ORDER, type ServerRoom } from '../core/serverTypes.js'
import { getTeamBySeat } from '../game/serverStateHelpers.js'
import type { LudoMatchSnapshot } from '../game/ludoMatchRuntime.js'
import { dbDateToUtc } from '../db/dbDate.js'
import { isCampaignsFeatureEnabled } from './campaignsFeatureFlag.js'
import type { CampaignCreditStore } from './campaignCreditStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

function getHumanWinnerProfileId(room: ServerRoom, seat: Seat): string | null {
  const participant = room.seats[seat].participant
  if (participant === null || participant.kind === 'bot') return null
  return participant.identity.profileId ?? participant.publicProfile?.profileId ?? null
}

/**
 * Белот — извиква се ОТ ВЪТРЕ в shouldRunMatchCompletionSideEffects guard-а
 * (index.ts), СЛЕД playerProgressStore.recordCompletedMatch/
 * matchEconomyStore.payoutMatchWinners. `isTournamentMatch` се подава от
 * caller-а (isTournamentMatchRoom(room) е private helper в index.ts) — не го
 * дублираме тук, за да няма drift риск между двете копия на логиката.
 */
export function recordBelotMatchForCampaign(deps: {
  campaignCreditStore: CampaignCreditStore
  room: ServerRoom
  isTournamentMatch: boolean
}): void {
  try {
    if (!isCampaignsFeatureEnabled()) return
    const { room, isTournamentMatch, campaignCreditStore } = deps
    if (room.config.isGuestTrial === true) return
    if (isTournamentMatch) return

    const state = room.game.authoritativeState
    if (
      state === null ||
      !('phase' in state) ||
      state.phase !== 'match-ended' ||
      state.matchEnded === null
    ) {
      return
    }

    const stakeAmount = room.config.stakeAmount
    if (typeof stakeAmount !== 'number' || !Number.isFinite(stakeAmount)) {
      console.error(
        `[campaign-game-hooks] belot room=${room.id} missing numeric stakeAmount — skipping campaign credit (insufficient info, not defaulting to 0)`,
      )
      return
    }

    const eventAt = new Date(state.matchEnded.endedAt)
    const winnerTeam = state.matchEnded.winnerTeam

    for (const seat of SERVER_SEAT_ORDER) {
      if (getTeamBySeat(seat) !== winnerTeam) continue
      const profileId = getHumanWinnerProfileId(room, seat)
      if (profileId === null) continue

      const result = campaignCreditStore.creditCampaignUnits({
        profileId,
        sourceType: 'belot_win',
        sourceId: room.id,
        eventAt,
        stakeAmount,
      })

      if (!result.ok && result.reason !== 'no_eligible_campaign' && result.reason !== 'ineligible_profile') {
        console.error(
          `[campaign-game-hooks] belot campaign credit failed room=${room.id} profile=${profileId} reason=${result.reason}`,
        )
      }
    }
  } catch (error) {
    console.error('[campaign-game-hooks] unexpected error crediting belot match', error)
  }
}

/**
 * Ludo — извиква се ОТ ВЪТРЕ в ludoMatchRuntime onSnapshot callback-а (и от
 * съответния boot-recovery блок), СЛЕД settleLudoMatchIfNeeded/
 * recordLudoMatchProgression. Връща `false` само за DIAGNOSTIC логване в
 * index.ts — виж doc коментара най-отгоре: резултатът НЕ гейтва
 * markMatchRemoved (за да не се трупат finished snapshots при персистентна
 * грешка). `no_eligible_campaign`/`ineligible_profile` са валидни, ОЧАКВАНИ
 * изходи (не грешки) — връщат true.
 */
export function recordLudoMatchForCampaign(deps: {
  campaignCreditStore: CampaignCreditStore
  snapshot: LudoMatchSnapshot
  eventAt: Date
}): boolean {
  try {
    if (!isCampaignsFeatureEnabled()) return true
    const { snapshot, eventAt, campaignCreditStore } = deps
    if (snapshot.state.status !== 'finished') return true
    if (snapshot.state.winnerColor === null) return true

    const winner = snapshot.players.find((player) => player.color === snapshot.state.winnerColor)
    if (winner === undefined) return true

    const result = campaignCreditStore.creditCampaignUnits({
      profileId: winner.profileId,
      sourceType: 'ludo_win',
      sourceId: snapshot.matchId,
      eventAt,
      stakeAmount: snapshot.stake,
    })

    if (!result.ok && result.reason !== 'no_eligible_campaign' && result.reason !== 'ineligible_profile') {
      console.error(
        `[campaign-game-hooks] ludo campaign credit failed match=${snapshot.matchId} profile=${winner.profileId} reason=${result.reason} (fast-path miss — reconciliation job ще го довърши)`,
      )
      return false
    }
    return true
  } catch (error) {
    console.error('[campaign-game-hooks] unexpected error crediting ludo match (fast-path miss — reconciliation job ще го довърши)', error)
    return false
  }
}

// ─── Reconciliation (§8 "възстановяване на пропуснати кампанийни
// начисления", §2 от одитната задача "безопасен, ограничен и идемпотентен
// retry механизъм") ───
//
// И двете функции по-долу са ЧИСТО READ-ONLY на изходните results-таблици
// (profile_match_results / ludo_room_matches) + делегират самото начисление
// на campaignCreditStore.creditCampaignUnits (което вече е идемпотентно,
// archived-aware, window-aware — виж campaignCreditStore.ts). Нито Белот,
// нито Ludo completion логиката зависи от тях — те са чисто ДОПЪЛНИТЕЛНА
// защитна мрежа за случаите, когато live hook-ът (recordBelotMatchForCampaign/
// recordLudoMatchForCampaign) е fail-нал временно, СЛЕД като реалният мач
// (пари/ELO/статистика) вече е коректно финализиран.
//
// Ограничения (виж §2 от одитната задача):
//   - `sinceIso` long-bounds заявката до последните N часа (виж
//     createCampaignCreditReconciliationJob — default 48ч) — НЕ пълно
//     историческо сканиране при всеки tick, независимо колко расте
//     таблицата с времето. И двете WHERE клаузи са index-backed
//     (idx_profile_match_results_is_guest_trial / idx_ludo_room_matches_finished_at).
//   - `limit` cap-ва броя редове за обработка в един run (defense-in-depth
//     срещу неочакван backlog).
//   - Никога не инвентира ставка (Белот: доказана чрез match_economy_ledger
//     или explicit "недостоверно, пропусни"; Ludo: stake е директна NOT NULL
//     колона в ludo_room_matches — няма ambiguous случай).
//   - Никога не начислява архивирана/грешна кампания — изцяло делегирано на
//     campaignCreditStore.resolveCampaignForEvent (archived_at IS NULL filter
//     + eventAt-window lookup, непроменено от Фаза 2), затова един стар мач
//     никога не се приписва на по-нова кампания.

export type BelotCampaignReconciliationResult = {
  scanned: number
  credited: number
  skippedInsufficientStakeInfo: number
}

export type ReconciliationBounds = {
  /** ISO timestamp — само редове с completed_at/finished_at >= тоя момент се сканират. */
  sinceIso?: string
  /** Максимален брой редове за обработка в тоя извикване. */
  limit?: number
}

const RECONCILIATION_UNBOUNDED_SINCE_ISO = '1970-01-01T00:00:00.000Z'
const RECONCILIATION_DEFAULT_LIMIT = 10_000

export async function reconcileMissingBelotCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
  bounds: ReconciliationBounds = {},
): Promise<BelotCampaignReconciliationResult> {
  const result: BelotCampaignReconciliationResult = {
    scanned: 0,
    credited: 0,
    skippedInsufficientStakeInfo: 0,
  }

  if (!isCampaignsFeatureEnabled()) return result

  const sinceIso = bounds.sinceIso ?? RECONCILIATION_UNBOUNDED_SINCE_ISO
  const limit = bounds.limit ?? RECONCILIATION_DEFAULT_LIMIT

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    // completed_at е TEXT ISO; lexicographic >= работи коректно за ISO 8601.
    const selectMissingCreditsStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND pmr.completed_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'belot_win'
            AND cul.source_id = pmr.room_id
            AND cul.profile_id = pmr.profile_id
        )
      ORDER BY pmr.completed_at ASC
      LIMIT ?;
    `)

    const selectOwnStakeDebitStatement = database.prepare(`
      SELECT amount FROM match_economy_ledger
      WHERE room_id = ? AND profile_id = ? AND entry_type = 'stake_debit'
      LIMIT 1;
    `)

    const selectAnyStakeDebitForRoomStatement = database.prepare(`
      SELECT 1 FROM match_economy_ledger WHERE room_id = ? AND entry_type = 'stake_debit' LIMIT 1;
    `)

    const rows = selectMissingCreditsStatement.all(sinceIso, limit) as Array<{
      room_id: string
      profile_id: string
      completed_at: string
    }>

    for (const row of rows) {
      result.scanned += 1

      const ownStakeRow = selectOwnStakeDebitStatement.get(row.room_id, row.profile_id) as
        | { amount: number }
        | undefined

      let stakeAmount: number
      if (ownStakeRow !== undefined) {
        stakeAmount = ownStakeRow.amount
      } else {
        const anyStakeRow = selectAnyStakeDebitForRoomStatement.get(row.room_id) as { [key: string]: unknown } | undefined
        if (anyStakeRow !== undefined) {
          // Друг участник в стаята е дебитиран, този — не: аномалия, не
          // познаваме реалната ставка за ТОЗИ профил.
          console.error(
            `[campaign-game-hooks] belot reconciliation: room=${row.room_id} profile=${row.profile_id} has no stake_debit while another participant does — insufficient info, skipping`,
          )
          result.skippedInsufficientStakeInfo += 1
          continue
        }
        // Никой в стаята няма stake_debit ред -> доказана нулева ставка.
        stakeAmount = 0
      }

      const creditResult = campaignCreditStore.creditCampaignUnits({
        profileId: row.profile_id,
        sourceType: 'belot_win',
        sourceId: row.room_id,
        eventAt: new Date(dbDateToUtc(row.completed_at)),
        stakeAmount,
      })

      if (creditResult.ok) {
        result.credited += 1
      } else if (creditResult.reason !== 'no_eligible_campaign' && creditResult.reason !== 'ineligible_profile') {
        console.error(
          `[campaign-game-hooks] belot reconciliation credit failed room=${row.room_id} profile=${row.profile_id} reason=${creditResult.reason}`,
        )
      }
    }
  } finally {
    database.close()
  }

  return result
}

export type LudoCampaignReconciliationResult = {
  scanned: number
  credited: number
}

/**
 * Ludo reconciliation — mirror на Белот-ия, но по-просто: ludo_room_matches
 * (server/database/migrations/20260925_001_create_ludo_room_matches.sql) е
 * additive read-model таблица, пишеща се БЕЗУСЛОВНО за всеки finished match
 * (виж index.ts::ludoRoomMatchStore.recordMatchFinished call site-а — извън
 * payout/progression/campaign гейтовете), НИКОГА не се трие, и носи `stake`
 * като директна NOT NULL колона (за разлика от Белот, тук няма нужда от
 * derivation през match_economy_ledger — stake е ВИНАГИ доказан факт).
 */
export async function reconcileMissingLudoCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
  bounds: ReconciliationBounds = {},
): Promise<LudoCampaignReconciliationResult> {
  const result: LudoCampaignReconciliationResult = { scanned: 0, credited: 0 }

  if (!isCampaignsFeatureEnabled()) return result

  const sinceIso = bounds.sinceIso ?? RECONCILIATION_UNBOUNDED_SINCE_ISO
  const limit = bounds.limit ?? RECONCILIATION_DEFAULT_LIMIT

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    const selectMissingCreditsStatement = database.prepare(`
      SELECT lrm.match_id AS match_id, lrm.winner_profile_id AS winner_profile_id,
             lrm.stake AS stake, lrm.finished_at AS finished_at
      FROM ludo_room_matches lrm
      WHERE lrm.status = 'finished'
        AND lrm.winner_profile_id IS NOT NULL
        AND lrm.finished_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'ludo_win'
            AND cul.source_id = lrm.match_id
            AND cul.profile_id = lrm.winner_profile_id
        )
      ORDER BY lrm.finished_at ASC
      LIMIT ?;
    `)

    const rows = selectMissingCreditsStatement.all(sinceIso, limit) as Array<{
      match_id: string
      winner_profile_id: string
      stake: number
      finished_at: string
    }>

    for (const row of rows) {
      result.scanned += 1

      const creditResult = campaignCreditStore.creditCampaignUnits({
        profileId: row.winner_profile_id,
        sourceType: 'ludo_win',
        sourceId: row.match_id,
        eventAt: new Date(dbDateToUtc(row.finished_at)),
        stakeAmount: row.stake,
      })

      if (creditResult.ok) {
        result.credited += 1
      } else if (creditResult.reason !== 'no_eligible_campaign' && creditResult.reason !== 'ineligible_profile') {
        console.error(
          `[campaign-game-hooks] ludo reconciliation credit failed match=${row.match_id} profile=${row.winner_profile_id} reason=${creditResult.reason}`,
        )
      }
    }
  } finally {
    database.close()
  }

  return result
}

// ─── Периодичен reconciliation job (§2 от одитната задача) ───
//
// Архитектурен модел — mirror на campaignScheduler.ts: setInterval tick,
// inFlight guard (предотвратява overlapping runs), error isolation (грешка в
// един tick не събаря сървъра/следващите tick-ове), .unref() (не държи
// процеса жив), tickNow() връща Promise (await-able за тестове и за
// незабавния boot-time first run). Feature flag-ът НЕ спира стартирането на
// job-а самия (mirror на campaignScheduler.ts доктрината) — проверява се
// ВЪТРЕ във всеки reconcile* извикване (евтино, без DB connection, ако е
// изключен — виж §3 от одитната задача "без съществена допълнителна работа,
// докато флагът е изключен").
//
// НЕ е същото като campaignScheduler.ts (campaign lifecycle активиране/
// приключване) — тоя job е изцяло в обхвата на Фаза 3 (credit retry), не
// активира/приключва кампании. getHealth() дава diagnostic видимост за
// пропуснати/неуспешни начисления (§2: "Осигури диагностична видимост").
export type CampaignCreditReconciliationHealth = {
  state: 'idle' | 'running' | 'stopped'
  inFlight: boolean
  lastTickAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  lastBelotResult: BelotCampaignReconciliationResult | null
  lastLudoResult: LudoCampaignReconciliationResult | null
}

export type CampaignCreditReconciliationJob = {
  start: () => void
  stop: () => void
  /** Връща Promise, await-able за тестове/boot-time immediate run. */
  tickNow: () => Promise<void>
  getHealth: () => CampaignCreditReconciliationHealth
  close: () => void
}

export type CampaignCreditReconciliationJobDeps = {
  databaseFilePath: string
  campaignCreditStore: CampaignCreditStore
  intervalMs?: number
  lookbackHours?: number
  limit?: number
  now?: () => Date
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  clearInterval?: (id: ReturnType<typeof globalThis.setInterval>) => void
}

const DEFAULT_RECONCILIATION_INTERVAL_MS = 300_000
const DEFAULT_RECONCILIATION_LOOKBACK_HOURS = 48
const DEFAULT_RECONCILIATION_LIMIT = 500

function sanitizeReconciliationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCampaignCreditReconciliationJob(
  deps: CampaignCreditReconciliationJobDeps,
): CampaignCreditReconciliationJob {
  const intervalMs = deps.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS
  const lookbackHours = deps.lookbackHours ?? DEFAULT_RECONCILIATION_LOOKBACK_HOURS
  const limit = deps.limit ?? DEFAULT_RECONCILIATION_LIMIT
  const now = deps.now ?? (() => new Date())
  const setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((id) => globalThis.clearInterval(id))

  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let inFlight = false
  let stopped = false
  let lastTickAt: string | null = null
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let lastBelotResult: BelotCampaignReconciliationResult | null = null
  let lastLudoResult: LudoCampaignReconciliationResult | null = null

  async function runTickBody(): Promise<void> {
    if (!isCampaignsFeatureEnabled()) return
    const sinceIso = new Date(now().getTime() - lookbackHours * 3_600_000).toISOString()
    const belotResult = await reconcileMissingBelotCampaignCredits(
      deps.databaseFilePath, deps.campaignCreditStore, { sinceIso, limit },
    )
    lastBelotResult = belotResult
    const ludoResult = await reconcileMissingLudoCampaignCredits(
      deps.databaseFilePath, deps.campaignCreditStore, { sinceIso, limit },
    )
    lastLudoResult = ludoResult
    if (belotResult.scanned > 0 || ludoResult.scanned > 0) {
      console.log(
        `[campaign-credit-reconciliation] belot scanned=${belotResult.scanned} credited=${belotResult.credited} skippedInsufficientStakeInfo=${belotResult.skippedInsufficientStakeInfo} | ludo scanned=${ludoResult.scanned} credited=${ludoResult.credited}`,
      )
    }
  }

  function runTick(): Promise<void> {
    if (stopped || inFlight) return Promise.resolve()
    inFlight = true
    lastTickAt = now().toISOString()
    return runTickBody()
      .then(() => {
        lastSuccessAt = new Date().toISOString()
        lastError = null
      })
      .catch((error: unknown) => {
        lastError = sanitizeReconciliationError(error)
        console.error('[campaign-credit-reconciliation] tick failed', error)
      })
      .finally(() => {
        inFlight = false
      })
  }

  function start(): void {
    if (intervalId !== null) return
    stopped = false
    void runTick()
    intervalId = setTimer(() => { void runTick() }, intervalMs)
    if (typeof intervalId === 'object' && intervalId !== null && 'unref' in intervalId) {
      ;(intervalId as { unref: () => void }).unref()
    }
  }

  function stop(): void {
    stopped = true
    if (intervalId !== null) {
      clearTimer(intervalId)
      intervalId = null
    }
  }

  return {
    start,
    stop,
    tickNow: () => runTick(),
    getHealth: () => ({
      state: stopped ? 'stopped' : intervalId === null ? 'idle' : 'running',
      inFlight,
      lastTickAt,
      lastSuccessAt,
      lastError,
      lastBelotResult,
      lastLudoResult,
    }),
    close: () => stop(),
  }
}

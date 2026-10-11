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
// Фаза 6.1 — reuse на ЕДИНСТВЕНИЯ authoritative формат за "уникален mач в
// рамките на тая стая" (`${room.id}:v${room.game.stateVersion}`), вместо да
// дублираме шаблона тук. Същата функция вече е доказана за real-money stake/
// payout ledger-а (matchEconomyStore.ts::collectRoomStakes/payoutMatchWinners)
// — виж doc коментара при recordBelotMatchForCampaign по-долу за пълния root
// cause/rationale на Фаза 6.1.
import { getRoomStakeLedgerScope } from '../db/matchEconomyStore.js'
import { isCampaignsFeatureEnabled } from './campaignsFeatureFlag.js'
import type { CampaignCreditStore } from './campaignCreditStore.js'
// type-only — campaignPurchaseHooks.ts самата ИМПОРТИРА cursor helper-ите
// от тоя файл (виж по-долу); пълен VALUE import тук би създал circular
// runtime dependency между двата модула. Самата reconcile функция се
// инжектира отвън (виж CampaignCreditReconciliationJobDeps.reconcilePurchases
// по-долу) — index.ts е единствената точка, която импортира ОБЕ стойности.
import type { PurchaseCampaignReconciliationResult } from './campaignPurchaseHooks.js'

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
 *
 * ФАЗА 6.1 ПОПРАВКА (критичен дефект, открит при Фаза 6 финалния одит):
 * sourceId ТУК беше `room.id` directно — но „Играй пак“ (applyReplayRestart
 * в index.ts) ПАЗИ room.id СЪЩИЯ, само увеличава room.game.stateVersion и
 * стартира нов мач в СЪЩАТА стая. campaign_unit_ledger's natural key е
 * (campaign_id, profile_id, source_type, source_id) — с голия room.id като
 * source_id, Мач 2's INSERT ... OR IGNORE колизираше със Мач 1's ВЕЧЕ
 * съществуващ ред и биваше ТИХО пропуснат: Мач 2 НИКОГА не получаваше
 * своите тикви (не просто грешен display — реално изгубена награда).
 *
 * ПОПРАВКА: sourceId вече е getRoomStakeLedgerScope(room) =
 * `${room.id}:v${room.game.stateVersion}` — ТОЧНО същия established формат,
 * който matchEconomyStore.ts вече ползва за РЕАЛНИТЕ пари (stake_debit/
 * winner_payout в match_economy_ledger), доказано коректен за replay-in-
 * same-room сценария (stateVersion се увеличава при всеки
 * applyReplayRestart/initializeRoomAuthoritativeGameState, но остава
 * СТАБИЛЕН през целия match-ended lifecycle на дадения мач — виж
 * syncRoomWithAuthoritativeState.ts/advanceRoomAuthoritativeGame.ts
 * reference-equality short circuit-а). Мач 1 и Мач 2 вече получават РАЗЛИЧНИ
 * source_id стойности -> и двата коректно се начисляват, без колизия.
 *
 * Обратна съвместимост: стари ledger редове с source_id=голия room.id
 * ОСТАВАТ непипнати (без миграция) — reconciliation-ът по-долу разпознава
 * И двата формата (виж doc коментара там), а getMatchCreditSnapshot в
 * campaignCreditStore.ts приема и двата при lookup.
 */
export function recordBelotMatchForCampaign(deps: {
  campaignCreditStore: CampaignCreditStore
  room: ServerRoom
  isTournamentMatch: boolean
  /**
   * Фаза 9 — извиква се ВЕДНАГА след успешно (не alreadyCredited) записан
   * durable notification ред, за realtime WS push към играча, АКО е online
   * в момента (виж index.ts::pushCampaignRewardNotificationRealtime).
   * Чисто side-channel callback — campaignGameHooks.ts остава без директен
   * import на WS/socket слоя, mirror на вече установеното decoupling
   * (campaignCreditStore.ts doc коментара за "чист DB модул"). Опционален —
   * тестове без този callback продължават непроменени.
   */
  onRewardNotification?: (profileId: string, notification: import('./campaignCreditStore.js').CampaignRewardNotificationForPush) => void
}): void {
  try {
    if (!isCampaignsFeatureEnabled()) return
    const { room, isTournamentMatch, campaignCreditStore, onRewardNotification } = deps
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
    const matchSourceId = getRoomStakeLedgerScope(room)

    for (const seat of SERVER_SEAT_ORDER) {
      if (getTeamBySeat(seat) !== winnerTeam) continue
      const profileId = getHumanWinnerProfileId(room, seat)
      if (profileId === null) continue

      const result = campaignCreditStore.creditCampaignUnits({
        profileId,
        sourceType: 'belot_win',
        sourceId: matchSourceId,
        eventAt,
        stakeAmount,
      })

      if (!result.ok && result.reason !== 'no_eligible_campaign' && result.reason !== 'ineligible_profile') {
        console.error(
          `[campaign-game-hooks] belot campaign credit failed room=${room.id} match=${matchSourceId} profile=${profileId} reason=${result.reason}`,
        )
      }

      if (result.ok && result.notification !== null) {
        onRewardNotification?.(profileId, result.notification)
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
  /** Фаза 9 — виж doc коментара на recordBelotMatchForCampaign-ия еднакъв параметър по-горе. */
  onRewardNotification?: (profileId: string, notification: import('./campaignCreditStore.js').CampaignRewardNotificationForPush) => void
}): boolean {
  try {
    if (!isCampaignsFeatureEnabled()) return true
    const { snapshot, eventAt, campaignCreditStore, onRewardNotification } = deps
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
    if (result.ok && result.notification !== null) {
      onRewardNotification?.(winner.profileId, result.notification)
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
//   - production job-ът пази durable cursor за Belot и Ludo поотделно и
//     сканира малка страница след cursor-а; когато стигне края, wrap-ва към
//     началото. Така няма 48ч прозорец, който да изгуби валидни печалби, и
//     няма първи 500 "заседнали" реда, които да блокират останалите.
//   - `limit` cap-ва броя редове за обработка в един run (defense-in-depth
//     срещу неочакван backlog) и cursor-ът се мести след всеки опит; crash
//     преди cursor update просто води до идемпотентен retry.
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
  failed: number
  cursorWrapped: boolean
}

export type ReconciliationBounds = {
  /** ISO timestamp — само редове с completed_at/finished_at >= тоя момент се сканират. */
  sinceIso?: string
  /** Максимален брой редове за обработка в тоя извикване. */
  limit?: number
  /**
   * Production job mode: persist a stable cursor per source table and advance
   * through the backlog in small pages. Direct/manual calls stay stateless by
   * default, which keeps existing one-shot maintenance checks predictable.
   */
  useDurableCursor?: boolean
}

const RECONCILIATION_UNBOUNDED_SINCE_ISO = '1970-01-01T00:00:00.000Z'
const RECONCILIATION_DEFAULT_LIMIT = 10_000
const RECONCILIATION_INITIAL_CURSOR = { eventAt: '', sourceId: '', profileId: '' }

// Фаза 5 добавя 3 нови source_type ключове (purchase reconciliation,
// campaignPurchaseHooks.ts) — виж migration
// 20261015_001_extend_campaign_credit_reconciliation_state_source_types.sql
// за CHECK constraint rebuild-а. Hелпърите по-долу са export-нати изрично
// за да ги преизползва campaignPurchaseHooks.ts — "не създавай втори
// независим и противоречив механизъм" (виж Фаза 5 §7).
// Фаза 6.2 — 'belot_win_legacy' е ОТДЕЛЕН durable cursor за legacy sweep-а
// (profile_match_results, pre-belot_match_completion_ledger редове) — виж
// 20261017_001_extend_campaign_credit_reconciliation_state_for_belot_legacy.sql
// doc коментара за пълния "защо" (без собствен cursor, постоянно
// недопустим prefix на пагинацията би блокирал напредването към следващи,
// допустими редове).
export type ReconciliationSourceType = 'belot_win' | 'belot_win_legacy' | 'ludo_win' | 'package_purchase_coin' | 'package_purchase_bundle' | 'package_purchase_vip'

export type ReconciliationCursor = {
  eventAt: string
  sourceId: string
  profileId: string
}

export function normalizeReconciliationLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return RECONCILIATION_DEFAULT_LIMIT
  return Math.max(1, Math.floor(limit))
}

export function getReconciliationCursor(
  database: SqliteDatabase,
  sourceType: ReconciliationSourceType,
): ReconciliationCursor {
  database.prepare(`
    INSERT OR IGNORE INTO campaign_credit_reconciliation_state (
      source_type, cursor_event_at, cursor_source_id, cursor_profile_id
    ) VALUES (?, '', '', '');
  `).run(sourceType)

  const row = database.prepare(`
    SELECT cursor_event_at, cursor_source_id, cursor_profile_id
    FROM campaign_credit_reconciliation_state
    WHERE source_type = ?
    LIMIT 1;
  `).get(sourceType) as
    | { cursor_event_at: string; cursor_source_id: string; cursor_profile_id: string }
    | undefined

  return row === undefined
    ? RECONCILIATION_INITIAL_CURSOR
    : { eventAt: row.cursor_event_at, sourceId: row.cursor_source_id, profileId: row.cursor_profile_id }
}

export function saveReconciliationCursor(
  database: SqliteDatabase,
  sourceType: ReconciliationSourceType,
  cursor: ReconciliationCursor,
): void {
  database.prepare(`
    INSERT INTO campaign_credit_reconciliation_state (
      source_type, cursor_event_at, cursor_source_id, cursor_profile_id, updated_at
    ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source_type) DO UPDATE SET
      cursor_event_at = excluded.cursor_event_at,
      cursor_source_id = excluded.cursor_source_id,
      cursor_profile_id = excluded.cursor_profile_id,
      updated_at = CURRENT_TIMESTAMP;
  `).run(sourceType, cursor.eventAt, cursor.sourceId, cursor.profileId)
}

export function resetReconciliationCursor(database: SqliteDatabase, sourceType: ReconciliationSourceType): void {
  saveReconciliationCursor(database, sourceType, RECONCILIATION_INITIAL_CURSOR)
}

export async function reconcileMissingBelotCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
  bounds: ReconciliationBounds = {},
): Promise<BelotCampaignReconciliationResult> {
  const result: BelotCampaignReconciliationResult = {
    scanned: 0,
    credited: 0,
    skippedInsufficientStakeInfo: 0,
    failed: 0,
    cursorWrapped: false,
  }

  if (!isCampaignsFeatureEnabled()) return result

  const sinceIso = bounds.sinceIso ?? RECONCILIATION_UNBOUNDED_SINCE_ISO
  const limit = normalizeReconciliationLimit(bounds.limit ?? RECONCILIATION_DEFAULT_LIMIT)

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    // ─── Фаза 6.2 — ПЪРВИЧЕН източник: belot_match_completion_ledger ───
    // match-scoped (PRIMARY KEY (match_scope, profile_id)), пише се атомарно
    // В playerProgressStore.ts::recordCompletedMatch (ПЪРВАТА side-effect
    // стъпка след shouldRunMatchCompletionSideEffects guard-а, преди payout
    // и преди тоя campaign hook) — виж 20261016_001_create_belot_match_completion_ledger.sql
    // doc коментара за пълния design rationale (защо не match_economy_ledger
    // — няма ред при нулев залог; защо не разширение на profile_match_results
    // — би пипнало admin "изиграни игри" статистика).
    //
    // stake_amount/ended_at ТУК са АВТОРИТЕТНИ колони (записани В МОМЕНТА на
    // приключване), НЕ извеждани от match_economy_ledger наличие/липса —
    // точно изискването от task spec §1/§2. match_scope е ТОЧНО същия
    // формат, който fast-path hook-ът (recordBelotMatchForCampaign) пише
    // като source_id — точно равенство е достатъчно, НЕ LIKE prefix.
    type BelotNewMissingCreditRow = {
      match_scope: string
      profile_id: string
      room_id: string
      stake_amount: number
      ended_at: string
    }

    const NOT_ALREADY_CREDITED_NEW_SQL = `
          NOT EXISTS (
            SELECT 1 FROM campaign_unit_ledger cul
            WHERE cul.source_type = 'belot_win'
              AND cul.profile_id = bmcl.profile_id
              AND cul.source_id = bmcl.match_scope
          )`

    const selectNewMissingCreditsSinceStatement = database.prepare(`
      SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.room_id AS room_id,
             bmcl.stake_amount AS stake_amount, bmcl.ended_at AS ended_at
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.did_win = 1
        AND bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL
        AND bmcl.ended_at >= ?
        AND ${NOT_ALREADY_CREDITED_NEW_SQL}
      ORDER BY bmcl.ended_at ASC, bmcl.match_scope ASC, bmcl.profile_id ASC
      LIMIT ?;
    `)

    const selectNewMissingCreditsAfterCursorStatement = database.prepare(`
      SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.room_id AS room_id,
             bmcl.stake_amount AS stake_amount, bmcl.ended_at AS ended_at
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.did_win = 1
        AND bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL
        AND (
          bmcl.ended_at > ?
          OR (bmcl.ended_at = ? AND bmcl.match_scope > ?)
          OR (bmcl.ended_at = ? AND bmcl.match_scope = ? AND bmcl.profile_id > ?)
        )
        AND ${NOT_ALREADY_CREDITED_NEW_SQL}
      ORDER BY bmcl.ended_at ASC, bmcl.match_scope ASC, bmcl.profile_id ASC
      LIMIT ?;
    `)

    const selectNewMissingCreditsFromStartStatement = database.prepare(`
      SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.room_id AS room_id,
             bmcl.stake_amount AS stake_amount, bmcl.ended_at AS ended_at
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.did_win = 1
        AND bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL
        AND ${NOT_ALREADY_CREDITED_NEW_SQL}
      ORDER BY bmcl.ended_at ASC, bmcl.match_scope ASC, bmcl.profile_id ASC
      LIMIT ?;
    `)

    const selectNewMissingCreditsThroughCursorStatement = database.prepare(`
      SELECT bmcl.match_scope AS match_scope, bmcl.profile_id AS profile_id, bmcl.room_id AS room_id,
             bmcl.stake_amount AS stake_amount, bmcl.ended_at AS ended_at
      FROM belot_match_completion_ledger bmcl
      WHERE bmcl.did_win = 1
        AND bmcl.is_guest_trial = 0
        AND bmcl.profile_id IS NOT NULL
        AND (
          bmcl.ended_at < ?
          OR (bmcl.ended_at = ? AND bmcl.match_scope < ?)
          OR (bmcl.ended_at = ? AND bmcl.match_scope = ? AND bmcl.profile_id <= ?)
        )
        AND ${NOT_ALREADY_CREDITED_NEW_SQL}
      ORDER BY bmcl.ended_at ASC, bmcl.match_scope ASC, bmcl.profile_id ASC
      LIMIT ?;
    `)

    let newRows: BelotNewMissingCreditRow[]
    if (bounds.useDurableCursor === true) {
      const cursor = getReconciliationCursor(database, 'belot_win')
      if (cursor.eventAt === '') {
        newRows = selectNewMissingCreditsFromStartStatement.all(limit) as BelotNewMissingCreditRow[]
      } else {
        newRows = selectNewMissingCreditsAfterCursorStatement.all(
          cursor.eventAt,
          cursor.eventAt,
          cursor.sourceId,
          cursor.eventAt,
          cursor.sourceId,
          cursor.profileId,
          limit,
        ) as BelotNewMissingCreditRow[]
        if (newRows.length < limit) {
          const wrappedRows = selectNewMissingCreditsThroughCursorStatement.all(
            cursor.eventAt,
            cursor.eventAt,
            cursor.sourceId,
            cursor.eventAt,
            cursor.sourceId,
            cursor.profileId,
            limit - newRows.length,
          ) as BelotNewMissingCreditRow[]
          if (wrappedRows.length > 0) {
            result.cursorWrapped = true
            newRows = newRows.concat(wrappedRows)
          } else if (newRows.length === 0) {
            resetReconciliationCursor(database, 'belot_win')
          }
        }
      }
    } else {
      // ended_at е TEXT ISO; lexicographic >= работи за форматите, които
      // тая кодова база произвежда. Stateless/manual извиквания пазят старата
      // sinceIso escape hatch; production job-ът ползва durable cursor-а.
      newRows = selectNewMissingCreditsSinceStatement.all(sinceIso, limit) as BelotNewMissingCreditRow[]
    }

    for (const row of newRows) {
      result.scanned += 1

      try {
        const creditResult = campaignCreditStore.creditCampaignUnits({
          profileId: row.profile_id,
          sourceType: 'belot_win',
          sourceId: row.match_scope,
          eventAt: new Date(dbDateToUtc(row.ended_at)),
          stakeAmount: row.stake_amount,
        })

        if (creditResult.ok) {
          result.credited += 1
        } else if (creditResult.reason !== 'no_eligible_campaign' && creditResult.reason !== 'ineligible_profile') {
          console.error(
            `[campaign-game-hooks] belot reconciliation credit failed match=${row.match_scope} profile=${row.profile_id} reason=${creditResult.reason}`,
          )
        }
      } catch (error) {
        result.failed += 1
        console.error(
          `[campaign-game-hooks] belot reconciliation unexpected failure match=${row.match_scope} profile=${row.profile_id}`,
          error,
        )
      } finally {
        if (bounds.useDurableCursor === true) {
          saveReconciliationCursor(database, 'belot_win', {
            eventAt: row.ended_at,
            sourceId: row.match_scope,
            profileId: row.profile_id,
          })
        }
      }
    }

    // ─── Фаза 6.1/6.2 — LEGACY sweep: profile_match_results ───
    // СОБСТВЕН durable cursor ('belot_win_legacy', виж
    // 20261017_001_extend_campaign_credit_reconciliation_state_for_belot_legacy.sql) —
    // КРИТИЧНА поправка (одит след първия Фаза 6.2 diff): чист LIMIT БЕЗ
    // cursor би спрял да напредва, ако префикса по completed_at ASC е
    // ПОСТОЯННО недопустим (напр. извън прозореца на ВСЯКА кампания) — NOT
    // EXISTS филтъра никога не маха такъв ред от "липсващи", затова
    // следващия tick би върнал СЪЩИТЕ редове отново, вместо да напредне
    // towards следващите, допустими редове отвъд тях. Durable cursor-ът
    // (идентичен 4-statement cursor/wrap pattern на primary scan-а по-горе)
    // напредва МОНОТОННО през (completed_at, room_id, profile_id)
    // подредбата на ВСЕКИ обработен ред — независимо дали в крайна сметка
    // се credit-ва, или само се "прескача" (no_eligible_campaign/
    // ineligible_profile/insufficient stake info) — виж checkCampaignBelotReliableReconciliation.ts
    // [S19]/[S20] за explicit regression тест на "2000 исторически реда,
    // първите 500 извън прозорец" сценария.
    //
    // Покрива ИЗКЛЮЧИТЕЛНО исторически мачове, за които НИКОГА не е писан
    // ред в belot_match_completion_ledger (т.е. completed-match side
    // effect-ът е run-нал ПРЕДИ тая миграция да съществува) — НЕ дублира
    // нищо, което primary scan-ът по-горе вече ще/е обработил, защото
    // изключваме всеки (room_id, profile_id), който ИМА ред в новата
    // таблица, дори ако тоя ред още чака reconciliation (ще се обработи от
    // primary scan-а).
    //
    // ПРИЕТ edge-case trade-off (виж checkCampaignBelotReliableReconciliation.ts
    // [S14] за explicit тест на границата): проверката е по (room_id,
    // profile_id), не по конкретен мач — ако ЕДНА И СЪЩА стая/профил
    // двойка съдържа И pre-6.2 legacy мач, И post-6.2 нов мач (изисква
    // стаята да е "жива" точно през deploy момента на тая миграция — на
    // практика невъзможно, кампаниите никога не са били активни в
    // продукция), legacy частта остава ПОСТОЯННО непокрита от тоя sweep.
    // Failure mode-ът е БЕЗОПАСЕН (под-начисление, НИКОГА двойно
    // начисление) — съзнателно предпочетено пред риска от double-credit
    // race (primary scan-ът cursor/limit-paginира, legacy sweep-ът има
    // СОБСТВЕН независим cursor — без тая изключваща проверка, двата биха
    // могли да credit-нат ЕДИН И СЪЩИ реален мач под ДВА различни
    // source_id формата в рамките на един tick).
    type BelotLegacyMissingCreditRow = {
      room_id: string
      profile_id: string
      completed_at: string
    }

    const NOT_ALREADY_CREDITED_LEGACY_SQL = `
          NOT EXISTS (
            SELECT 1 FROM campaign_unit_ledger cul
            WHERE cul.source_type = 'belot_win'
              AND cul.profile_id = pmr.profile_id
              AND (cul.source_id = pmr.room_id OR cul.source_id LIKE pmr.room_id || ':v%')
          )`
    const NOT_IN_NEW_LEDGER_SQL = `
          NOT EXISTS (
            SELECT 1 FROM belot_match_completion_ledger bmcl2
            WHERE bmcl2.room_id = pmr.room_id AND bmcl2.profile_id = pmr.profile_id
          )`

    const selectLegacyMissingCreditsSinceStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND pmr.profile_id IS NOT NULL
        AND pmr.completed_at >= ?
        AND ${NOT_ALREADY_CREDITED_LEGACY_SQL}
        AND ${NOT_IN_NEW_LEDGER_SQL}
      ORDER BY pmr.completed_at ASC, pmr.room_id ASC, pmr.profile_id ASC
      LIMIT ?;
    `)

    const selectLegacyMissingCreditsAfterCursorStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND pmr.profile_id IS NOT NULL
        AND (
          pmr.completed_at > ?
          OR (pmr.completed_at = ? AND pmr.room_id > ?)
          OR (pmr.completed_at = ? AND pmr.room_id = ? AND pmr.profile_id > ?)
        )
        AND ${NOT_ALREADY_CREDITED_LEGACY_SQL}
        AND ${NOT_IN_NEW_LEDGER_SQL}
      ORDER BY pmr.completed_at ASC, pmr.room_id ASC, pmr.profile_id ASC
      LIMIT ?;
    `)

    const selectLegacyMissingCreditsFromStartStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND pmr.profile_id IS NOT NULL
        AND ${NOT_ALREADY_CREDITED_LEGACY_SQL}
        AND ${NOT_IN_NEW_LEDGER_SQL}
      ORDER BY pmr.completed_at ASC, pmr.room_id ASC, pmr.profile_id ASC
      LIMIT ?;
    `)

    const selectLegacyMissingCreditsThroughCursorStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND pmr.profile_id IS NOT NULL
        AND (
          pmr.completed_at < ?
          OR (pmr.completed_at = ? AND pmr.room_id < ?)
          OR (pmr.completed_at = ? AND pmr.room_id = ? AND pmr.profile_id <= ?)
        )
        AND ${NOT_ALREADY_CREDITED_LEGACY_SQL}
        AND ${NOT_IN_NEW_LEDGER_SQL}
      ORDER BY pmr.completed_at ASC, pmr.room_id ASC, pmr.profile_id ASC
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

    let legacyRows: BelotLegacyMissingCreditRow[]
    if (bounds.useDurableCursor === true) {
      const legacyCursor = getReconciliationCursor(database, 'belot_win_legacy')
      if (legacyCursor.eventAt === '') {
        legacyRows = selectLegacyMissingCreditsFromStartStatement.all(limit) as BelotLegacyMissingCreditRow[]
      } else {
        legacyRows = selectLegacyMissingCreditsAfterCursorStatement.all(
          legacyCursor.eventAt,
          legacyCursor.eventAt,
          legacyCursor.sourceId,
          legacyCursor.eventAt,
          legacyCursor.sourceId,
          legacyCursor.profileId,
          limit,
        ) as BelotLegacyMissingCreditRow[]
        if (legacyRows.length < limit) {
          const wrappedLegacyRows = selectLegacyMissingCreditsThroughCursorStatement.all(
            legacyCursor.eventAt,
            legacyCursor.eventAt,
            legacyCursor.sourceId,
            legacyCursor.eventAt,
            legacyCursor.sourceId,
            legacyCursor.profileId,
            limit - legacyRows.length,
          ) as BelotLegacyMissingCreditRow[]
          if (wrappedLegacyRows.length > 0) {
            result.cursorWrapped = true
            legacyRows = legacyRows.concat(wrappedLegacyRows)
          } else if (legacyRows.length === 0) {
            resetReconciliationCursor(database, 'belot_win_legacy')
          }
        }
      }
    } else {
      // Stateless/manual извиквания (без durable cursor) пазят старата
      // sinceIso-bounded еднократна страница — production job-ът винаги
      // ползва useDurableCursor:true (виж createCampaignCreditReconciliationJob).
      legacyRows = selectLegacyMissingCreditsSinceStatement.all(sinceIso, limit) as BelotLegacyMissingCreditRow[]
    }

    for (const row of legacyRows) {
      result.scanned += 1

      try {
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
              `[campaign-game-hooks] belot reconciliation (legacy sweep): room=${row.room_id} profile=${row.profile_id} has no stake_debit while another participant does — insufficient info, skipping`,
            )
            result.skippedInsufficientStakeInfo += 1
            continue
          }
          // Никой в стаята няма stake_debit ред -> доказана нулева ставка
          // (ТОЗИ heuristic е ограничен до pre-Фаза-6.2 исторически редове
          // без belot_match_completion_ledger еквивалент — новите редове
          // по-горе вече ползват авторитетния stake_amount, без heuristic).
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
            `[campaign-game-hooks] belot reconciliation (legacy sweep) credit failed room=${row.room_id} profile=${row.profile_id} reason=${creditResult.reason}`,
          )
        }
      } catch (error) {
        result.failed += 1
        console.error(
          `[campaign-game-hooks] belot reconciliation (legacy sweep) unexpected failure room=${row.room_id} profile=${row.profile_id}`,
          error,
        )
      } finally {
        // Cursor-ът напредва на ВСЕКИ обработен ред — credited, skipped
        // (no_eligible_campaign/ineligible_profile/insufficient stake
        // info), ИЛИ failed — виж doc коментара най-отгоре за пълния "защо"
        // (иначе постоянно недопустим prefix блокира напредването).
        if (bounds.useDurableCursor === true) {
          saveReconciliationCursor(database, 'belot_win_legacy', {
            eventAt: row.completed_at,
            sourceId: row.room_id,
            profileId: row.profile_id,
          })
        }
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
  failed: number
  cursorWrapped: boolean
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
  const result: LudoCampaignReconciliationResult = { scanned: 0, credited: 0, failed: 0, cursorWrapped: false }

  if (!isCampaignsFeatureEnabled()) return result

  const sinceIso = bounds.sinceIso ?? RECONCILIATION_UNBOUNDED_SINCE_ISO
  const limit = normalizeReconciliationLimit(bounds.limit ?? RECONCILIATION_DEFAULT_LIMIT)

  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    type LudoMissingCreditRow = {
      match_id: string
      winner_profile_id: string
      stake: number
      finished_at: string
    }

    const selectMissingCreditsSinceStatement = database.prepare(`
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
      ORDER BY lrm.finished_at ASC, lrm.match_id ASC, lrm.winner_profile_id ASC
      LIMIT ?;
    `)

    const selectMissingCreditsAfterCursorStatement = database.prepare(`
      SELECT lrm.match_id AS match_id, lrm.winner_profile_id AS winner_profile_id,
             lrm.stake AS stake, lrm.finished_at AS finished_at
      FROM ludo_room_matches lrm
      WHERE lrm.status = 'finished'
        AND lrm.winner_profile_id IS NOT NULL
        AND lrm.finished_at IS NOT NULL
        AND (
          lrm.finished_at > ?
          OR (lrm.finished_at = ? AND lrm.match_id > ?)
          OR (lrm.finished_at = ? AND lrm.match_id = ? AND lrm.winner_profile_id > ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'ludo_win'
            AND cul.source_id = lrm.match_id
            AND cul.profile_id = lrm.winner_profile_id
        )
      ORDER BY lrm.finished_at ASC, lrm.match_id ASC, lrm.winner_profile_id ASC
      LIMIT ?;
    `)

    const selectMissingCreditsFromStartStatement = database.prepare(`
      SELECT lrm.match_id AS match_id, lrm.winner_profile_id AS winner_profile_id,
             lrm.stake AS stake, lrm.finished_at AS finished_at
      FROM ludo_room_matches lrm
      WHERE lrm.status = 'finished'
        AND lrm.winner_profile_id IS NOT NULL
        AND lrm.finished_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'ludo_win'
            AND cul.source_id = lrm.match_id
            AND cul.profile_id = lrm.winner_profile_id
        )
      ORDER BY lrm.finished_at ASC, lrm.match_id ASC, lrm.winner_profile_id ASC
      LIMIT ?;
    `)

    const selectMissingCreditsThroughCursorStatement = database.prepare(`
      SELECT lrm.match_id AS match_id, lrm.winner_profile_id AS winner_profile_id,
             lrm.stake AS stake, lrm.finished_at AS finished_at
      FROM ludo_room_matches lrm
      WHERE lrm.status = 'finished'
        AND lrm.winner_profile_id IS NOT NULL
        AND lrm.finished_at IS NOT NULL
        AND (
          lrm.finished_at < ?
          OR (lrm.finished_at = ? AND lrm.match_id < ?)
          OR (lrm.finished_at = ? AND lrm.match_id = ? AND lrm.winner_profile_id <= ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'ludo_win'
            AND cul.source_id = lrm.match_id
            AND cul.profile_id = lrm.winner_profile_id
        )
      ORDER BY lrm.finished_at ASC, lrm.match_id ASC, lrm.winner_profile_id ASC
      LIMIT ?;
    `)

    let rows: LudoMissingCreditRow[]
    if (bounds.useDurableCursor === true) {
      const cursor = getReconciliationCursor(database, 'ludo_win')
      if (cursor.eventAt === '') {
        rows = selectMissingCreditsFromStartStatement.all(limit) as LudoMissingCreditRow[]
      } else {
        rows = selectMissingCreditsAfterCursorStatement.all(
          cursor.eventAt,
          cursor.eventAt,
          cursor.sourceId,
          cursor.eventAt,
          cursor.sourceId,
          cursor.profileId,
          limit,
        ) as LudoMissingCreditRow[]
        if (rows.length < limit) {
          const wrappedRows = selectMissingCreditsThroughCursorStatement.all(
            cursor.eventAt,
            cursor.eventAt,
            cursor.sourceId,
            cursor.eventAt,
            cursor.sourceId,
            cursor.profileId,
            limit - rows.length,
          ) as LudoMissingCreditRow[]
          if (wrappedRows.length > 0) {
            result.cursorWrapped = true
            rows = rows.concat(wrappedRows)
          } else if (rows.length === 0) {
            resetReconciliationCursor(database, 'ludo_win')
          }
        }
      }
    } else {
      rows = selectMissingCreditsSinceStatement.all(sinceIso, limit) as LudoMissingCreditRow[]
    }

    for (const row of rows) {
      result.scanned += 1

      try {
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
      } catch (error) {
        result.failed += 1
        console.error(
          `[campaign-game-hooks] ludo reconciliation unexpected failure match=${row.match_id} profile=${row.winner_profile_id}`,
          error,
        )
      } finally {
        if (bounds.useDurableCursor === true) {
          saveReconciliationCursor(database, 'ludo_win', {
            eventAt: row.finished_at,
            sourceId: row.match_id,
            profileId: row.winner_profile_id,
          })
        }
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
  lastPurchaseResult: PurchaseCampaignReconciliationResult | null
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
  /**
   * Фаза 5 — инжектирана зависимост (не статичен import, виж доc коментара
   * най-отгоре за circular-import rationale). index.ts подава
   * campaignPurchaseHooks.js::reconcileMissingPurchaseCampaignCredits тук.
   * Optional — ако не е подадена (напр. по-стари тестове), purchase
   * reconciliation просто не се изпълнява в тоя job instance.
   */
  reconcilePurchases?: (
    databaseFilePath: string,
    campaignCreditStore: CampaignCreditStore,
    bounds: { limit?: number },
  ) => Promise<PurchaseCampaignReconciliationResult>
}

const DEFAULT_RECONCILIATION_INTERVAL_MS = 300_000
const DEFAULT_RECONCILIATION_LIMIT = 500

function sanitizeReconciliationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createCampaignCreditReconciliationJob(
  deps: CampaignCreditReconciliationJobDeps,
): CampaignCreditReconciliationJob {
  const intervalMs = deps.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS
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
  let lastPurchaseResult: PurchaseCampaignReconciliationResult | null = null

  async function runTickBody(): Promise<void> {
    if (!isCampaignsFeatureEnabled()) return
    const belotResult = await reconcileMissingBelotCampaignCredits(
      deps.databaseFilePath, deps.campaignCreditStore, { limit, useDurableCursor: true },
    )
    lastBelotResult = belotResult
    const ludoResult = await reconcileMissingLudoCampaignCredits(
      deps.databaseFilePath, deps.campaignCreditStore, { limit, useDurableCursor: true },
    )
    lastLudoResult = ludoResult
    const purchaseResult = deps.reconcilePurchases
      ? await deps.reconcilePurchases(deps.databaseFilePath, deps.campaignCreditStore, { limit })
      : null
    lastPurchaseResult = purchaseResult
    if (belotResult.scanned > 0 || ludoResult.scanned > 0) {
      console.log(
        `[campaign-credit-reconciliation] belot scanned=${belotResult.scanned} credited=${belotResult.credited} skippedInsufficientStakeInfo=${belotResult.skippedInsufficientStakeInfo} failed=${belotResult.failed} wrapped=${belotResult.cursorWrapped ? 1 : 0} | ludo scanned=${ludoResult.scanned} credited=${ludoResult.credited} failed=${ludoResult.failed} wrapped=${ludoResult.cursorWrapped ? 1 : 0}`,
      )
    }
    if (purchaseResult !== null && (purchaseResult.coin.scanned > 0 || purchaseResult.bundle.scanned > 0 || purchaseResult.vip.scanned > 0)) {
      console.log(
        `[campaign-credit-reconciliation] coin scanned=${purchaseResult.coin.scanned} credited=${purchaseResult.coin.credited} failed=${purchaseResult.coin.failed} wrapped=${purchaseResult.coin.cursorWrapped ? 1 : 0} | bundle scanned=${purchaseResult.bundle.scanned} credited=${purchaseResult.bundle.credited} failed=${purchaseResult.bundle.failed} wrapped=${purchaseResult.bundle.cursorWrapped ? 1 : 0} | vip scanned=${purchaseResult.vip.scanned} credited=${purchaseResult.vip.credited} failed=${purchaseResult.vip.failed} wrapped=${purchaseResult.vip.cursorWrapped ? 1 : 0}`,
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
      lastPurchaseResult,
    }),
    close: () => stop(),
  }
}

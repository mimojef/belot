// Фаза 3 на системата "Кампании": автоматично начисляване на тематични
// единици при РЕАЛНИ победи в Белот и Ludo. Единствените два call sites,
// от които `campaignCreditStore.creditCampaignUnits()` се вика извън
// admin/retry пътищата (виж campaignCreditStore.ts).
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

import type { Seat } from '../core/serverTypes.js'
import { SERVER_SEAT_ORDER, type ServerRoom } from '../core/serverTypes.js'
import { getTeamBySeat } from '../game/serverStateHelpers.js'
import type { LudoMatchSnapshot } from '../game/ludoMatchRuntime.js'
import { dbDateToUtc } from '../db/dbDate.js'
import { isCampaignsFeatureEnabled } from './campaignsFeatureFlag.js'
import type { CampaignCreditStore } from './campaignCreditStore.js'

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
 * recordLudoMatchProgression. Връща `false` при неуспех, ЗА ДА (виж
 * index.ts): markMatchRemoved се извика само при success — точно както
 * progressionRecorded вече прави за recordLudoMatchProgression — Ludo's
 * СЪЩЕСТВУВАЩ boot-recovery retry loop автоматично "наследява" същата
 * crash-recovery гаранция и за тая проверка, без нов отделен механизъм.
 * `no_eligible_campaign`/`ineligible_profile` са валидни, ОЧАКВАНИ изходи
 * (не грешки) — третират се като success (не блокират markMatchRemoved).
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
        `[campaign-game-hooks] ludo campaign credit failed match=${snapshot.matchId} profile=${winner.profileId} reason=${result.reason}`,
      )
      return false
    }
    return true
  } catch (error) {
    console.error('[campaign-game-hooks] unexpected error crediting ludo match', error)
    return false
  }
}

// ─── Белот boot-time reconciliation (§8 "възстановяване на пропуснати
// кампанийни начисления") ───
//
// Белот, за разлика от Ludo, НЯМА explicit "запази finished snapshot-а, ако
// side effect-ът е fail-нал" gate (виж index.ts::isRoomAtMatchEndedPhase/
// shouldRunMatchCompletionSideEffects — чисто in-memory edge-transition
// detector между ДВЕ състояния на СЪЩИЯ worker-tick, не persisted retry
// queue). Ако процесът умре точно в тая синхронна функция (между
// recordCompletedMatch и тук), или ТАЗИ функция сама fail-не по ВРЕМЕННА
// причина (DB lock contention), няма вграден автоматичен retry — точно
// същата характеристика, която ВЕЧЕ важи за recordCompletedMatch/
// payoutMatchWinners самите (ELO/пари), не нова, по-слаба гаранция,
// въведена от кампаниите. Тая функция е ДОПЪЛНИТЕЛНА защитна мрежа, не
// заместител: скенира profile_match_results (вече надеждно попълнена от
// playerProgressStore.recordCompletedMatch за ВСЯКА завършила игра,
// независимо от кампаниите) за победи без съответен campaign_unit_ledger
// ред, и ги backfill-ва. Извиква се ЕДНОКРАТНО при server boot (НЕ на
// таймер/campaignScheduler — виж task spec §6 "не свързвай
// campaignScheduler, ако не е нужно"), извън критичния gameplay път.
//
// Stake reconstruction: match_economy_ledger.amount > 0 е SCHEMA-level
// constraint (виж 20260510_012_create_match_economy_ledger.sql) — ОТСЪСТВИЕТО
// на stake_debit ред за дадена (room_id, profile_id) двойка е ДОКАЗАТЕЛСТВО
// (не предположение), че тоя участник никога не е бил debit-нат положителна
// сума за тоя room. Ако НИКОЙ участник в room-а няма stake_debit ред, се
// третира като доказана нулева ставка (турнирен мач ИЛИ free-play частна
// маса — реконсилацията не може да ги различи само от тия две таблици, но и
// двата случая са легитимно stake=0, не "липсваща информация"). Ако САМО
// някои участници имат stake_debit (а не този профил) — това е аномалия
// (частичен debit failure), пропуска се с warning, НЕ се познава ставка.
export type BelotCampaignReconciliationResult = {
  scanned: number
  credited: number
  skippedInsufficientStakeInfo: number
}

export async function reconcileMissingBelotCampaignCredits(
  databaseFilePath: string,
  campaignCreditStore: CampaignCreditStore,
): Promise<BelotCampaignReconciliationResult> {
  const result: BelotCampaignReconciliationResult = {
    scanned: 0,
    credited: 0,
    skippedInsufficientStakeInfo: 0,
  }

  if (!isCampaignsFeatureEnabled()) return result

  const sqliteModule = await import('node:sqlite')
  const database = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA busy_timeout = 5000;')

  try {
    const selectMissingCreditsStatement = database.prepare(`
      SELECT pmr.room_id AS room_id, pmr.profile_id AS profile_id, pmr.completed_at AS completed_at
      FROM profile_match_results pmr
      WHERE pmr.did_win = 1
        AND pmr.is_guest_trial = 0
        AND NOT EXISTS (
          SELECT 1 FROM campaign_unit_ledger cul
          WHERE cul.source_type = 'belot_win'
            AND cul.source_id = pmr.room_id
            AND cul.profile_id = pmr.profile_id
        )
      ORDER BY pmr.completed_at ASC;
    `)

    const selectOwnStakeDebitStatement = database.prepare(`
      SELECT amount FROM match_economy_ledger
      WHERE room_id = ? AND profile_id = ? AND entry_type = 'stake_debit'
      LIMIT 1;
    `)

    const selectAnyStakeDebitForRoomStatement = database.prepare(`
      SELECT 1 FROM match_economy_ledger WHERE room_id = ? AND entry_type = 'stake_debit' LIMIT 1;
    `)

    const rows = selectMissingCreditsStatement.all() as Array<{
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
            `[campaign-game-hooks] reconciliation: room=${row.room_id} profile=${row.profile_id} has no stake_debit while another participant does — insufficient info, skipping`,
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
          `[campaign-game-hooks] reconciliation credit failed room=${row.room_id} profile=${row.profile_id} reason=${creditResult.reason}`,
        )
      }
    }
  } finally {
    database.close()
  }

  return result
}

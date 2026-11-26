/**
 * checkHeldPayoutsStage3B2.ts — целеви проверки за Етап 3Б.2:
 * устойчив регистър на задържаните изплащания (belot_held_payouts) и
 * ръчното им уреждане (matchEconomyStore.settleHeldPayout).
 *
 * Реален matchEconomyStore върху ВРЕМЕННА база (пълният migration runner).
 * Пускане: npx tsx scripts/checkHeldPayoutsStage3B2.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import type { Seat, ServerRoom } from '../src/core/serverTypes.js'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, getRoomStakeLedgerScope, setMatchPrizeResolver } from '../src/db/matchEconomyStore.js'
import { pinLegacyBelotFinancialTerms, type BelotFinancialTerms } from '../src/economy/belotFinancialTerms.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const SEATS: Seat[] = ['bottom', 'right', 'top', 'left']
const WINNER_SEATS: Seat[] = ['bottom', 'top']
const START = 1_000_000
const silence = <T>(fn: () => T): T => {
  const original = console.error
  console.error = () => {}
  try { return fn() } finally { console.error = original }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'held-payouts-3b2-'))
  const dbPath = join(dir, 'economy.sqlite')
  try {
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const economy = await createMatchEconomyStore(dbPath)
    const raw = new DatabaseSync(dbPath)
    setMatchPrizeResolver((stake) => ({ 5_000: 8_000, 20_000: 30_000 } as Record<number, number>)[stake] ?? null)

    let counter = 0
    const profile = (id: string) => {
      raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
      raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, START)
    }
    const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
    const ledgerCount = (scope: string, type: string) => (raw.prepare('SELECT COUNT(*) AS n FROM match_economy_ledger WHERE room_id = ? AND entry_type = ?').get(scope, type) as { n: number }).n
    const pidOf = (room: ServerRoom, seat: Seat) => (room.seats[seat].participant as { identity: { profileId: string } }).identity.profileId
    const registryCount = () => (raw.prepare('SELECT COUNT(*) AS n FROM belot_held_payouts').get() as { n: number }).n

    /** 4 човека; queue=true → дебит по опашката (като случайна маса), иначе room-scoped (частна маса). */
    const buildRoom = (stake: number, options: { queue?: boolean; stateVersion?: number } = {}): ServerRoom => {
      counter += 1
      let room = createServerRoom({ config: { allowBots: false, isPrivate: !options.queue, stakeAmount: stake } })
      for (const seat of SEATS) {
        const profileId = `h${counter}-${seat}`
        profile(profileId)
        const scope = options.queue ? `queue:e${counter}-${seat}` : null
        if (scope !== null) {
          const r = economy.collectQueueStake(scope.slice('queue:'.length), profileId, stake)
          if (!r.ok) throw new Error(r.message)
        }
        room = seatParticipantInRoom(room, seat, createHumanParticipant({ identity: { profileId, displayName: profileId }, stakeLedgerScope: scope }))
      }
      room = { ...room, game: { ...room.game, stateVersion: options.stateVersion ?? 3 } }
      if (!options.queue) {
        const r = economy.collectRoomStakes(room, stake)
        if (!r.ok) throw new Error(r.message)
      }
      return room
    }
    const endMatch = (room: ServerRoom, versionBump = 40): ServerRoom => ({
      ...room,
      game: { ...room.game, stateVersion: room.game.stateVersion + versionBump, authoritativeState: { phase: 'match-ended', matchEnded: { winnerTeam: 'A' } } as never },
    })
    const withTerms = (room: ServerRoom, terms: unknown): ServerRoom => ({ ...room, config: { ...room.config, financialTerms: terms as BelotFinancialTerms } })

    console.log('\n[1] Задържано изплащане се записва в регистъра')
    const roomA = withTerms(buildRoom(20_000), { rulesVersion: 'belot-legacy-fixed-prize-v1', entryFee: 20_000, prizePerWinner: 'x', pinnedAt: 1, pinSource: 'boot-backfill' })
    const debitScopeA = getRoomStakeLedgerScope(roomA)
    const endedA = endMatch(roomA)
    const scopeA = getRoomStakeLedgerScope(endedA)
    {
      const balancesBefore = SEATS.map((s) => balance(pidOf(endedA, s)))
      const p = silence(() => economy.payoutMatchWinners(endedA))
      check('payout → ok:false, held.recorded=true', !p.ok && p.held?.recorded === true && p.held.matchScope === scopeA, p)
      const row = economy.getHeldPayout(scopeA)
      check('ред: pending_review, invalid, 20 000, rules_version четим', row?.status === 'pending_review' && row.holdReason === 'invalid' && row.stakeAmount === 20_000 && row.rulesVersion === 'belot-legacy-fixed-prize-v1')
      check('ред: room_id, winner_team A, 4 участници, 2 победители', row?.roomId === endedA.id && row.winnerTeam === 'A' && row.participants.length === 4 && row.winners.length === 2
        && row.winners.every((w) => WINNER_SEATS.includes(w.seat)))
      check('ред: 4 входа на ТОЗИ мач (room scope от момента на дебита)', row?.stakeDebits.length === 4 && row.stakeDebits.every((d) => d.scope === debitScopeA && d.amount === 20_000), row?.stakeDebits)
      check('ред: суровите financialTerms са запазени', row?.financialTermsJson.includes('"prizePerWinner":"x"') === true)
      check('без движение на жълтици и без winner_payout', JSON.stringify(SEATS.map((s) => balance(pidOf(endedA, s)))) === JSON.stringify(balancesBefore) && ledgerCount(scopeA, 'winner_payout') === 0)
    }

    console.log('\n[2] Повторно регистриране — един случай, без ново задължение')
    {
      silence(() => economy.payoutMatchWinners(endedA))
      const r = economy.registerHeldPayoutForRestoredRoom(endedA)
      const row = economy.getHeldPayout(scopeA)
      check('registerHeldPayoutForRestoredRoom → recorded (идемпотентно)', r.status === 'recorded')
      check('пак 1 ред, hold_count = 3, доказателствата непроменени', registryCount() === 1 && row?.holdCount === 3 && row.stakeDebits.length === 4)
      check('валидни условия → not-held', economy.registerHeldPayoutForRestoredRoom(withTerms(endMatch(buildRoom(5_000)), pinLegacyBelotFinancialTerms(5_000, () => 8_000, 'matchmaking-room-created'))).status === 'not-held')
      check('неприключил мач → not-held', economy.registerHeldPayoutForRestoredRoom(withTerms(buildRoom(5_000), { bad: 1 })).status === 'not-held')
      check('историческа маса без поле → not-held', economy.registerHeldPayoutForRestoredRoom(endMatch(buildRoom(5_000))).status === 'not-held')
    }

    console.log('\n[3] Рестарт и премахната маса — записът остава')
    {
      const fresh = await createMatchEconomyStore(dbPath)
      const row = fresh.getHeldPayout(scopeA)
      check('нова връзка (рестарт) вижда случая без масата', row?.status === 'pending_review' && row.winners.length === 2)
      check('listHeldPayouts({pending_review}) го съдържа', fresh.listHeldPayouts({ status: 'pending_review' }).some((r) => r.matchScope === scopeA))
      fresh.close()
    }

    console.log('\n[4] Неуспешен запис в регистъра → пълни данни за повторен опит, без частичен ред')
    let roomB: ServerRoom
    {
      roomB = endMatch(withTerms(buildRoom(20_000, { queue: true }), { ...pinLegacyBelotFinancialTerms(20_000, () => 30_000, 'matchmaking-room-created')!, entryFee: 5_000 }))
      raw.exec(`CREATE TRIGGER fail_held BEFORE INSERT ON belot_held_payouts BEGIN SELECT RAISE(ABORT, 'simulated registry failure'); END;`)
      const before = registryCount()
      const p = silence(() => economy.payoutMatchWinners(roomB))
      check('held.recorded=false + грешка', !p.ok && p.held?.recorded === false && p.held.error.includes('simulated'), p)
      check('без частичен ред', registryCount() === before)
      const record = !p.ok && p.held?.recorded === false ? p.held.record : null
      check('записът за повторен опит е самодостатъчен (stake-mismatch, 4 queue входа, 2 победители)',
        record !== null && record.holdReason === 'stake-mismatch' && record.stakeDebits.length === 4 && record.stakeDebits.every((d) => d.scope.startsWith('queue:')) && record.winners.length === 2)
      raw.exec('DROP TRIGGER fail_held;')
      check('повторният опит записва случая', record !== null && economy.recordHeldPayout(record).ok && economy.getHeldPayout(getRoomStakeLedgerScope(roomB))?.status === 'pending_review')
    }

    console.log('\n[5] Ръчно уреждане с изплащане')
    {
      const w = WINNER_SEATS.map((s) => pidOf(endedA, s))
      const l = ['right', 'left'].map((s) => pidOf(endedA, s as Seat))
      const wb = w.map(balance)
      const bad = [
        economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'admin-1', note: 'проверено', evidence: '' }),
        economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 0, resolvedBy: 'admin-1', note: 'x', evidence: 'y' }),
        economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 40_001, resolvedBy: 'admin-1', note: 'x', evidence: 'y' }),
        economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 30_000, resolvedBy: ' ', note: 'x', evidence: 'y' }),
        economy.settleHeldPayout({ matchScope: 'nope:v1', action: 'payout', prizePerWinner: 30_000, resolvedBy: 'a', note: 'x', evidence: 'y' }),
      ]
      check('без доказателство / 0 / над фонда / без автор / непознат → отказ',
        bad.map((r) => (r.ok ? 'ok' : r.code)).join(',') === 'invalid-input,invalid-input,prize-exceeds-pot,invalid-input,not-found', bad.map((r) => (r.ok ? 'ok' : r.code)))
      check('след отказите: pending, без движения', economy.getHeldPayout(scopeA)?.status === 'pending_review' && JSON.stringify(w.map(balance)) === JSON.stringify(wb) && ledgerCount(scopeA, 'winner_payout') === 0)

      // Прекъсване по средата: 2-рият winner_payout гърми → нищо не остава.
      raw.exec(`CREATE TRIGGER fail_second_payout BEFORE INSERT ON match_economy_ledger
        WHEN NEW.entry_type = 'winner_payout' AND NEW.profile_id = '${w[1]}' BEGIN SELECT RAISE(ABORT, 'simulated mid-settlement crash'); END;`)
      const mid = economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'admin-1', note: 'проверено', evidence: 'match_rooms към момента: 30 000' })
      check('грешка по средата → db-error', !mid.ok && mid.code === 'db-error')
      check('без частично уреждане: портфейли, ledger и статус непроменени',
        JSON.stringify(w.map(balance)) === JSON.stringify(wb) && ledgerCount(scopeA, 'winner_payout') === 0 && economy.getHeldPayout(scopeA)?.status === 'pending_review')
      raw.exec('DROP TRIGGER fail_second_payout;')

      const ok = economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'admin-1', note: 'проверено', evidence: 'match_rooms към момента: 30 000' })
      check('изплащане: ok, 2 движения × 30 000', ok.ok && ok.status === 'settled_payout' && ok.movements.length === 2 && ok.movements.every((m) => m.amount === 30_000 && m.scope === scopeA))
      check('портфейлите на победителите +30 000; загубилите без промяна', w.every((p, i) => balance(p) === wb[i]! + 30_000) && l.every((p) => balance(p) === START - 20_000))
      const row = economy.getHeldPayout(scopeA)
      check('статус settled_payout + автор/бележка/награда/доказателство', row?.status === 'settled_payout' && row.resolvedBy === 'admin-1' && row.resolutionPrizePerWinner === 30_000 && row.resolutionEvidence?.includes('30 000') === true && row.resolvedAt !== null)

      const again = economy.settleHeldPayout({ matchScope: scopeA, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'admin-2', note: 'отново', evidence: 'x' })
      const refundAfter = economy.settleHeldPayout({ matchScope: scopeA, action: 'refund', resolvedBy: 'admin-2', note: 'отново' })
      check('второ уреждане (payout/refund) → not-pending', !again.ok && again.code === 'not-pending' && !refundAfter.ok && refundAfter.code === 'not-pending')
      const auto = silence(() => economy.payoutMatchWinners(withTerms(endedA, pinLegacyBelotFinancialTerms(20_000, () => 30_000, 'boot-backfill'))))
      check('автоматичен payout след уреждане (дори с „поправени“ условия) → отказ', !auto.ok && !('held' in auto && auto.held !== undefined))
      check('общо точно 2 winner_payout реда, без stake_refund', ledgerCount(scopeA, 'winner_payout') === 2 && ledgerCount(debitScopeA, 'stake_refund') === 0)
    }

    console.log('\n[6] Ръчно уреждане с възстановяване (входове от опашката)')
    {
      const scopeB = getRoomStakeLedgerScope(roomB)
      const pids = SEATS.map((s) => pidOf(roomB, s))
      check('преди: всички удържани', pids.every((p) => balance(p) === START - 20_000))
      const r = economy.settleHeldPayout({ matchScope: scopeB, action: 'refund', resolvedBy: 'admin-1', note: 'невалидни условия — връщаме входовете' })
      check('refund: 4 движения × 20 000 по queue scope', r.ok && r.status === 'settled_refund' && r.movements.length === 4 && r.movements.every((m) => m.entryType === 'stake_refund' && m.amount === 20_000 && m.scope.startsWith('queue:')))
      check('всички портфейли възстановени', pids.every((p) => balance(p) === START))
      check('без winner_payout за мача', ledgerCount(scopeB, 'winner_payout') === 0)
      const payoutAfter = economy.settleHeldPayout({ matchScope: scopeB, action: 'payout', prizePerWinner: 30_000, resolvedBy: 'a', note: 'x', evidence: 'y' })
      check('изплащане след възстановяване → not-pending', !payoutAfter.ok && payoutAfter.code === 'not-pending')
      // Startup reconcile на опашката (3Б.1) не бива да ги върне втори път.
      const reconcile = economy.reconcileOrphanedQueueStakes({ activeRooms: [] })
      check('3Б.1 reconcile не връща повторно', !reconcile.refunded.some((i) => pids.includes(i.profileId ?? '')) && pids.every((p) => balance(p) === START))
    }

    console.log('\n[7] Изключване на изплащане и възстановяване едновременно')
    {
      const roomC = endMatch(withTerms(buildRoom(5_000, { queue: true }), { broken: true }))
      silence(() => economy.payoutMatchWinners(roomC))
      const scopeC = getRoomStakeLedgerScope(roomC)
      const first = economy.getHeldPayout(scopeC)!.stakeDebits[0]!
      // Външно (напр. стар refund път) върнат вход от мача.
      check('външен refund на един вход', economy.refundParticipantScopedStake(first.scope, first.profileId).ok)
      const p = economy.settleHeldPayout({ matchScope: scopeC, action: 'payout', prizePerWinner: 8_000, resolvedBy: 'a', note: 'x', evidence: 'y' })
      const rf = economy.settleHeldPayout({ matchScope: scopeC, action: 'refund', resolvedBy: 'a', note: 'x' })
      check('payout → already-refunded; refund → already-refunded; статус pending', !p.ok && p.code === 'already-refunded' && !rf.ok && rf.code === 'already-refunded' && economy.getHeldPayout(scopeC)?.status === 'pending_review')
      const closeNoNote = economy.settleHeldPayout({ matchScope: scopeC, action: 'close', resolvedBy: 'a', note: ' ' })
      const close = economy.settleHeldPayout({ matchScope: scopeC, action: 'close', resolvedBy: 'a', note: 'уредено ръчно извън системата — тикет #12' })
      check('close без бележка → отказ; с бележка → closed_no_action без движения', !closeNoNote.ok && close.ok && close.status === 'closed_no_action' && close.movements.length === 0)

      const roomD = endMatch(withTerms(buildRoom(5_000, { queue: true }), { broken: true }))
      silence(() => economy.payoutMatchWinners(roomD))
      const scopeD = getRoomStakeLedgerScope(roomD)
      raw.prepare(`INSERT INTO match_economy_ledger (ledger_id, room_id, profile_id, entry_type, amount, balance_after) VALUES ('ext-payout', ?, ?, 'winner_payout', 8000, 0)`).run(scopeD, pidOf(roomD, 'bottom'))
      const rfD = economy.settleHeldPayout({ matchScope: scopeD, action: 'refund', resolvedBy: 'a', note: 'x' })
      check('вече има winner_payout → refund отказан (already-paid)', !rfD.ok && rfD.code === 'already-paid' && economy.getHeldPayout(scopeD)?.status === 'pending_review')
    }

    console.log('\n[8] „Преиграй“: записват се входовете само на ТОЗИ мач')
    {
      let room = buildRoom(5_000, { stateVersion: 1 })
      room = { ...room, game: { ...room.game, stateVersion: 50 } }
      if (!economy.collectRoomStakes(room, 5_000).ok) throw new Error('replay debit')
      const ended = endMatch(withTerms(room, { broken: true }), 30)
      silence(() => economy.payoutMatchWinners(ended))
      const row = economy.getHeldPayout(getRoomStakeLedgerScope(ended))
      check('избран е дебитът на v50 (не v1 от предишния мач)', row?.stakeDebits.length === 4 && row.stakeDebits.every((d) => d.scope === `${room.id}:v50`), row?.stakeDebits)
    }

    console.log('\n[9] Нормалното изплащане е непроменено')
    {
      const valid = endMatch(withTerms(buildRoom(5_000), pinLegacyBelotFinancialTerms(5_000, () => 8_000, 'private-room-created')))
      const before = registryCount()
      const p = economy.payoutMatchWinners(valid)
      check('валидни условия → 2 × 8 000, без запис в регистъра', p.ok && Object.values(p.awardedPerSeat).every((a) => a === 8_000) && Object.keys(p.awardedPerSeat).length === 2 && registryCount() === before)
      const historical = endMatch(buildRoom(20_000))
      const h = economy.payoutMatchWinners(historical)
      check('историческа маса без поле → текущата награда 30 000', h.ok && Object.values(h.awardedPerSeat).every((a) => a === 30_000))
      const again = economy.payoutMatchWinners(valid)
      check('идемпотентно повторно извикване → същите суми, без нови редове', again.ok && ledgerCount(getRoomStakeLedgerScope(valid), 'winner_payout') === 2)
    }

    console.log('\n[10] Свързване в index.ts (статично)')
    {
      const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
      check('незаписано задържане → повторни опити (RAM + лог)', /payoutResult\.held !== undefined && !payoutResult\.held\.recorded[\s\S]{0,200}enqueueHeldPayoutRegistrationRetry\(payoutResult\.held\.record/.test(src))
      const guardSrc = readFileSync(join(import.meta.dirname, '../src/economy/heldPayoutRegistrationGuard.ts'), 'utf8')
      check('пълният запис се логва', guardSrc.includes('HELD PAYOUT NOT RECORDED scope=${record.matchScope}: ${reason} — retrying; record=${JSON.stringify(record)}'))
      const reconcileAt = src.indexOf('reconcileOrphanedQueueStakesOnBoot(serverState)')
      const heldBootAt = src.indexOf('registerHeldPayoutsForRestoredRoomsOnBoot(serverState)')
      check('старт: регистриране за възстановените маси след възстановяването и преди runtime-а', heldBootAt > reconcileAt && reconcileAt > 0 && heldBootAt < src.indexOf('const activeRoomRuntime ='))
      check('settleHeldPayout не е изложен през HTTP (без админ UI в този етап)', !src.includes('settleHeldPayout'))
    }
    raw.close()
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows: отворени SQLite файлове */ }
  }

  console.log(`\nРезултат: ${passed} PASS, ${failed} FAIL`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

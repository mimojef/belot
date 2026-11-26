/**
 * checkOrphanedQueueStakesStage3B1.ts — целеви проверки за Етап 3Б.1:
 * възстановяване на осиротели входове от случайната опашка (queue:<id>).
 *
 * Реален matchEconomyStore върху ВРЕМЕННА база (пълният migration runner).
 * „Рестарт“ = ново извикване на reconcileOrphanedQueueStakes с активните
 * маси, които биха били възстановени. Не пипа реалната база.
 *
 * Пускане: npx tsx scripts/checkOrphanedQueueStakesStage3B1.ts
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createMatchEconomyStore, MATCHMAKING_STAKE_BINDINGS_MIGRATION, type QueueStakeReconciliationReport } from '../src/db/matchEconomyStore.js'

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

const STAKE = 5_000
const START_BALANCE = 100_000
type ActiveRooms = Parameters<Awaited<ReturnType<typeof createMatchEconomyStore>>['reconcileOrphanedQueueStakes']>[0]['activeRooms']

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'queue-stakes-3b1-'))
  const dbPath = join(dir, 'economy.sqlite')
  try {
    await ensureServerDatabaseReady({ databaseFilePathOverride: dbPath })
    const economy = await createMatchEconomyStore(dbPath)
    const raw = new DatabaseSync(dbPath)

    // Проследяването е започнало „преди час“, за да са входовете в теста
    // строго след epoch-а (секундна точност на CURRENT_TIMESTAMP).
    raw.prepare(`UPDATE server_migrations SET applied_at = datetime('now', '-1 hour') WHERE filename = ?`).run(MATCHMAKING_STAKE_BINDINGS_MIGRATION)
    const epoch = (raw.prepare('SELECT applied_at FROM server_migrations WHERE filename = ?').get(MATCHMAKING_STAKE_BINDINGS_MIGRATION) as { applied_at: string } | undefined)?.applied_at
    check('миграцията е приложена от runner-а (epoch съществува)', typeof epoch === 'string')

    const profile = (id: string) => {
      raw.prepare('INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)').run(id, id, id)
      raw.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance').run(id, START_BALANCE)
    }
    const balance = (id: string) => (raw.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(id) as { b: number }).b
    const ledger = (scope: string, type: string) => raw.prepare('SELECT COUNT(*) AS n FROM match_economy_ledger WHERE room_id = ? AND entry_type = ?').get(scope, type) as { n: number }
    const debit = (entryId: string, profileId: string) => {
      profile(profileId)
      const r = economy.collectQueueStake(entryId, profileId, STAKE)
      if (!r.ok) throw new Error(`debit failed ${entryId}: ${r.message}`)
    }
    const boot = (activeRooms: ActiveRooms = []): QueueStakeReconciliationReport => economy.reconcileOrphanedQueueStakes({ activeRooms })
    const scopes = (items: Array<{ queueScope: string }>) => items.map((i) => i.queueScope).sort()

    console.log('\n[1] Осиротял вход се връща; втори рестарт не връща повторно')
    {
      debit('orphan-1', 'p-orphan')
      check('удържан: баланс 95 000', balance('p-orphan') === START_BALANCE - STAKE)
      const r1 = boot()
      check('рестарт 1: върнат', scopes(r1.refunded).includes('queue:orphan-1'))
      check('баланс възстановен 100 000', balance('p-orphan') === START_BALANCE)
      check('ledger: точно 1 stake_refund', ledger('queue:orphan-1', 'stake_refund').n === 1)
      const r2 = boot()
      check('рестарт 2: нищо не се връща повторно', r2.refunded.length === 0 && r2.refundFailed.length === 0)
      check('баланс непроменен след рестарт 2', balance('p-orphan') === START_BALANCE && ledger('queue:orphan-1', 'stake_refund').n === 1)
    }

    console.log('\n[2] Започнал мач не получава refund')
    {
      debit('active-1', 'p-active')
      // Маса, възстановена от active_room_snapshots (участник със stakeLedgerScope).
      const activeRooms: ActiveRooms = [{ roomId: 'room-active', queueStakes: [{ queueScope: 'queue:active-1', profileId: 'p-active' }] }]
      const r = boot(activeRooms)
      check('в активна маса → inActiveRoom, без refund', scopes(r.inActiveRoom).includes('queue:active-1') && !scopes(r.refunded).includes('queue:active-1'))
      check('баланс остава удържан', balance('p-active') === START_BALANCE - STAKE)

      // Нова маса от опашката: връзката е записана, масата е активна.
      debit('bound-active-1', 'p-bound-active')
      check('bindQueueStakesToRoom ok', economy.bindQueueStakesToRoom('room-bound-active', [{ queueScope: 'queue:bound-active-1', profileId: 'p-bound-active' }]).ok)
      check('bindQueueStakesToRoom идемпотентно', economy.bindQueueStakesToRoom('room-bound-active', [{ queueScope: 'queue:bound-active-1', profileId: 'p-bound-active' }]).ok)
      const r2 = boot([{ roomId: 'room-bound-active', queueStakes: [] }])
      check('свързан + масата е активна → без refund', scopes(r2.inActiveRoom).includes('queue:bound-active-1') && balance('p-bound-active') === START_BALANCE - STAKE)
    }

    console.log('\n[3] Завършен мач (връзка + запис за завършен мач) → използван, без refund')
    {
      debit('done-1', 'p-done')
      economy.bindQueueStakesToRoom('room-done', [{ queueScope: 'queue:done-1', profileId: 'p-done' }])
      raw.prepare(`INSERT INTO belot_match_completion_ledger (match_scope, profile_id, room_id, team, did_win, stake_amount, ended_at)
        VALUES ('room-done:v3', 'p-done', 'room-done', 'A', 0, ?, datetime('now'))`).run(STAKE)
      const r = boot()
      check('consumedByCompletedMatch, без refund', scopes(r.consumedByCompletedMatch).includes('queue:done-1') && !scopes(r.refunded).includes('queue:done-1'))
      check('баланс остава удържан (загубен мач)', balance('p-done') === START_BALANCE - STAKE)
    }

    console.log('\n[4] Вече върнат вход не се връща отново')
    {
      debit('left-1', 'p-left')
      check('нормално напускане на опашката (refundQueueStake)', economy.refundQueueStake('left-1', 'p-left', STAKE).ok)
      const r = boot()
      const all = [...r.refunded, ...r.inActiveRoom, ...r.consumedByCompletedMatch, ...r.ambiguous, ...r.refundFailed]
      check('не участва в класификацията', !scopes(all).includes('queue:left-1'))
      check('баланс 100 000, 1 refund ред', balance('p-left') === START_BALANCE && ledger('queue:left-1', 'stake_refund').n === 1)
    }

    console.log('\n[5] Неясни случаи → само доклад, без refund')
    {
      debit('bound-missing-1', 'p-bound-missing')
      economy.bindQueueStakesToRoom('room-vanished', [{ queueScope: 'queue:bound-missing-1', profileId: 'p-bound-missing' }])
      debit('historic-1', 'p-historic')
      raw.prepare(`UPDATE match_economy_ledger SET created_at = datetime('now', '-2 hours') WHERE room_id = 'queue:historic-1'`).run()
      debit('same-second-1', 'p-same-second')
      raw.prepare(`UPDATE match_economy_ledger SET created_at = ? WHERE room_id = 'queue:same-second-1'`).run(epoch!)
      const r = boot()
      const reasonOf = (scope: string) => r.ambiguous.find((i) => i.queueScope === scope)?.reason
      check('свързан с изчезнала маса без запис за завършен мач → bound-room-missing-without-completion', reasonOf('queue:bound-missing-1') === 'bound-room-missing-without-completion')
      check('удържан преди проследяването → pre-tracking-debit', reasonOf('queue:historic-1') === 'pre-tracking-debit')
      check('в същата секунда като epoch → pre-tracking-debit (строго „след“)', reasonOf('queue:same-second-1') === 'pre-tracking-debit')
      check('нито един от тях не е върнат', ['p-bound-missing', 'p-historic', 'p-same-second'].every((p) => balance(p) === START_BALANCE - STAKE))

      raw.prepare(`UPDATE match_economy_ledger SET profile_id = NULL, deleted_profile_id_snapshot = 'p-deleted' WHERE room_id = 'queue:historic-1'`).run()
      check('изтрит профил → deleted-profile', boot().ambiguous.find((i) => i.queueScope === 'queue:historic-1')?.reason === 'deleted-profile')

      const savedEpoch = epoch!
      raw.prepare('DELETE FROM server_migrations WHERE filename = ?').run(MATCHMAKING_STAKE_BINDINGS_MIGRATION)
      debit('no-epoch-1', 'p-no-epoch')
      const rNoEpoch = boot()
      check('без epoch → no-tracking-epoch, без refund', rNoEpoch.ambiguous.find((i) => i.queueScope === 'queue:no-epoch-1')?.reason === 'no-tracking-epoch' && balance('p-no-epoch') === START_BALANCE - STAKE)
      raw.prepare('INSERT INTO server_migrations (filename, applied_at) VALUES (?, ?)').run(MATCHMAKING_STAKE_BINDINGS_MIGRATION, savedEpoch)
      const rBack = boot()
      check('epoch възстановен → no-epoch-1 вече е доказано осиротял и се връща', scopes(rBack.refunded).includes('queue:no-epoch-1') && balance('p-no-epoch') === START_BALANCE)
    }

    console.log('\n[6] Прекъсване / грешка в базата по средата на refund')
    {
      debit('crash-1', 'p-crash')
      // Кредитът към портфейла минава, ledger записът гърми → транзакцията трябва да се отмени изцяло.
      raw.exec(`CREATE TRIGGER fail_refund BEFORE INSERT ON match_economy_ledger
        WHEN NEW.entry_type = 'stake_refund' AND NEW.room_id = 'queue:crash-1'
        BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;`)
      const r1 = boot()
      check('refundFailed съдържа входа', scopes(r1.refundFailed).includes('queue:crash-1'), r1.refundFailed)
      check('няма частично състояние: баланс непроменен, 0 refund реда', balance('p-crash') === START_BALANCE - STAKE && ledger('queue:crash-1', 'stake_refund').n === 0)
      raw.exec('DROP TRIGGER fail_refund;')
      const r2 = boot()
      check('следващ рестарт: върнат точно веднъж', scopes(r2.refunded).includes('queue:crash-1') && balance('p-crash') === START_BALANCE && ledger('queue:crash-1', 'stake_refund').n === 1)
      check('трети рестарт: нищо', !scopes(boot().refunded).includes('queue:crash-1'))

      // Заключена база (друг writer) → busy → transient, без частично състояние.
      debit('busy-1', 'p-busy')
      const locker = new DatabaseSync(dbPath)
      locker.exec('PRAGMA busy_timeout = 0;')
      raw.exec('PRAGMA busy_timeout = 0;')
      locker.exec('BEGIN IMMEDIATE;')
      let busyReport: QueueStakeReconciliationReport | null = null
      let busyThrew = false
      try { busyReport = boot() } catch { busyThrew = true }
      locker.exec('ROLLBACK;')
      locker.close()
      check('заключена база: или хвърля, или refundFailed — без частичен кредит',
        (busyThrew || (busyReport !== null && scopes(busyReport.refundFailed).includes('queue:busy-1'))) && balance('p-busy') === START_BALANCE - STAKE && ledger('queue:busy-1', 'stake_refund').n === 0,
        { busyThrew, failed: busyReport?.refundFailed })
      const rAfter = boot()
      check('след освобождаване: върнат веднъж', scopes(rAfter.refunded).includes('queue:busy-1') && balance('p-busy') === START_BALANCE)
    }

    console.log('\n[7] Записът на връзката е атомарен')
    {
      raw.exec(`CREATE TRIGGER fail_binding BEFORE INSERT ON matchmaking_stake_bindings
        WHEN NEW.profile_id = 'p-bind-2' BEGIN SELECT RAISE(ABORT, 'simulated binding failure'); END;`)
      const res = economy.bindQueueStakesToRoom('room-bind', [
        { queueScope: 'queue:bind-1', profileId: 'p-bind-1' },
        { queueScope: 'queue:bind-2', profileId: 'p-bind-2' },
      ])
      const rows = (raw.prepare(`SELECT COUNT(*) AS n FROM matchmaking_stake_bindings WHERE room_id = 'room-bind'`).get() as { n: number }).n
      check('грешка на 2-ри ред → ok:false и 0 записани реда', !res.ok && rows === 0)
      raw.exec('DROP TRIGGER fail_binding;')
      check('CHECK: невалиден scope се отхвърля', !economy.bindQueueStakesToRoom('room-x', [{ queueScope: 'room-x:v1', profileId: 'p' }]).ok)
    }

    console.log('\n[8] Свързване в index.ts (статично)')
    {
      const src = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8')
      const bindAt = src.indexOf('matchEconomyStore.bindQueueStakesToRoom(\n        initializedRoom.id,')
      const bindAtCrlf = bindAt >= 0 ? bindAt : src.indexOf('matchEconomyStore.bindQueueStakesToRoom(\r\n        initializedRoom.id,')
      const failAt = src.indexOf('    if (stakeCollectionFailed) {', bindAtCrlf)
      const commitAt = src.indexOf('let nextServerState = commitServerRoomWithSnapshot(initializedRoom)', bindAtCrlf)
      check('опашка: връзката се записва преди записа на стаята', bindAtCrlf > 0 && commitAt > bindAtCrlf)
      check('опашка: неуспешна връзка → масата не се създава (stakeCollectionFailed)', /if \(!bindResult\.ok\) \{[\s\S]{0,200}stakeCollectionFailed = true/.test(src) && failAt > bindAtCrlf && failAt < commitAt)
      const restoreAt = src.indexOf('let serverState: ServerState = loadPersistedServerState()')
      const reconcileAt = src.indexOf('reconcileOrphanedQueueStakesOnBoot(serverState)')
      check('старт: след възстановяването на масите', restoreAt > 0 && reconcileAt > restoreAt)
      check('старт: преди runtime-а и опашката да тръгнат', reconcileAt < src.indexOf('const activeRoomRuntime =') && reconcileAt < src.indexOf('httpServer.listen(PORT'))
      check('старт: допълва връзки за възстановените маси', /bindQueueStakesToRoom\(room\.roomId, room\.queueStakes\)/.test(src))
      check('refund само през съществуващия refundParticipantScopedStake', /const refund = refundParticipantScopedStake\(row\.queue_scope, row\.profile_id\)/.test(readFileSync(join(import.meta.dirname, '../src/db/matchEconomyStore.ts'), 'utf8')))
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

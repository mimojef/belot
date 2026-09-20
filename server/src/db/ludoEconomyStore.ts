import { randomUUID } from 'node:crypto'
import type { ProfileId } from '../core/serverTypes.js'
import { buildLudoMatchSnapshotRow, UPSERT_LUDO_MATCH_SNAPSHOT_SQL } from './activeLudoMatchSnapshotStore.js'
import type { LudoMatchSnapshot } from '../game/ludoMatchRuntime.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

// Чист economy API за Ludo — НЕ форсира Ludo обекти (LudoRoom/Match, LudoColor)
// в matchEconomyStore.ts-ите Белот-specific функции (те приемат ServerRoom/
// Team/Seat и четат room.game.authoritativeState.phase==='match-ended', което
// Ludo обекти структурно нямат). Огледало на matchEconomyStore.ts/
// tournamentEconomyStore.ts архитектурата (виж audit-а в тикета) — всеки
// domain си има собствен economy store със собствени prepared statements
// срещу СЪЩАТА canonical profile_wallets таблица + собствена ledger таблица
// (ludo_match_economy_ledger, виж 20260919_001 миграцията).
//
// matchEconomyStore.hasEnoughBalance() е вече 100% generic (само profileId +
// amount, никаква ServerRoom зависимост) — преизползва се директно от Ludo
// кода вместо да се дублира тук.

export type LudoEconomyStore = {
  getWalletBalance: (profileId: ProfileId) => number
  /**
   * Атомарен ALL-OR-NOTHING debit на stake-а от ВСЕКИ profileId в списъка.
   * Ако дори един debit не може да се извърши (недостатъчен баланс в
   * последния момент — TOCTOU race след pre-check-а на caller-а), ЦЯЛАТА
   * транзакция се rollback-ва и никой не е debit-нат. Идемпотентно per
   * (matchId, profileId, 'ludo_stake_debit') — повторен опит за същия match
   * е no-op за вече debit-натите profiles.
   */
  collectLudoMatchStakes: (
    matchId: string,
    profileIds: ProfileId[],
    stakeAmount: number,
  ) =>
    | { ok: true }
    | { ok: false; message: string; insufficientProfileId: ProfileId | null }
  /**
   * КРИТИЧНА start transaction (виж task spec §3 "ЗАТВОРИ ТОЗИ ПРОЗОРЕЦ") —
   * ЕДНА atomic DB transaction, СЪЩАТА semantics като collectLudoMatchStakes
   * (all-or-nothing debit, идемпотентно per (matchId, profileId,
   * 'ludo_stake_debit')), плюс insert-ва initialSnapshot-а (виж
   * activeLudoMatchSnapshotStore.ts) в СЪЩАТА транзакция. Инвариант: ако
   * stake debit-ът е commit-нат, initial active match snapshot ЗАДЪЛЖИТЕЛНО
   * съществува в DB — ако snapshot insert-ът fail-не, ЦЕЛИЯТ debit се
   * rollback-ва (никой не е задебитиран за match, който няма persisted
   * snapshot). Reuse-ва СЪЩАТА connection като debit-а (не отделен store) —
   * SQLite транзакциите са per-connection, затова activeLudoMatchSnapshotStore
   * (собствена connection) не може да участва в ТАЗИ transaction; вместо това
   * пише директно тук през UPSERT_LUDO_MATCH_SNAPSHOT_SQL (canonical текст,
   * споделен от activeLudoMatchSnapshotStore.ts, за да остане ЕДНО място,
   * което дефинира snapshot row shape-а).
   */
  collectLudoMatchStakesWithInitialSnapshot: (
    matchId: string,
    profileIds: ProfileId[],
    stakeAmount: number,
    initialSnapshot: LudoMatchSnapshot,
  ) =>
    | { ok: true }
    | { ok: false; message: string; insufficientProfileId: ProfileId | null }
  /**
   * Сумата от всички успешно debit-нати 'ludo_stake_debit' ledger записи за
   * този match — authoritative pot, независим от текущия in-memory
   * match.players state (forfeit премахва quitter-а от players array-я, но
   * ledger записът му остава завинаги — pot-ът не бива да "свие" заради
   * forfeit).
   */
  getLudoMatchTotalPot: (matchId: string) => number
  /**
   * Idempotent payout — 80% от totalPot (integer floor) към winner-а, точно
   * веднъж per matchId. Ако вече е платено (duplicate finished transition,
   * reconnect replay), връща historical amount от ledger-а вместо да
   * credit-не отново.
   */
  payoutLudoMatchWinner: (
    matchId: string,
    winnerProfileId: ProfileId,
  ) =>
    | { ok: true; totalPot: number; prizeAmount: number; alreadyPaid: boolean }
    | { ok: false; message: string }
  close: () => void
}

type WalletRow = { yellow_coins_balance: number }
type LudoLedgerEntryType = 'ludo_stake_debit' | 'ludo_winner_payout'

// Integer-only arithmetic — виж task spec-а. Remainder-ът винаги остава в
// platformShare (никога не се credit-ва на никого, никакъв fiktiven platform
// profile — виж §8 в task spec-а).
export function computeLudoWinnerPrize(totalPot: number): number {
  return Math.floor((totalPot * 80) / 100)
}

export async function createLudoEconomyStore(
  databaseFilePath: string,
): Promise<LudoEconomyStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 0)
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const selectWalletStatement = database.prepare(`
    SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ? LIMIT 1;
  `)

  const debitWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance - ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND yellow_coins_balance >= ?;
  `)

  const creditWalletStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance + ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const insertLedgerStatement = database.prepare(`
    INSERT INTO ludo_match_economy_ledger (
      ledger_id, match_id, profile_id, entry_type, amount, balance_after
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(match_id, profile_id, entry_type) DO NOTHING;
  `)

  const selectLedgerStatement = database.prepare(`
    SELECT ledger_id FROM ludo_match_economy_ledger
    WHERE match_id = ? AND profile_id = ? AND entry_type = ? LIMIT 1;
  `)

  const selectLedgerAmountStatement = database.prepare(`
    SELECT amount FROM ludo_match_economy_ledger
    WHERE match_id = ? AND profile_id = ? AND entry_type = ? LIMIT 1;
  `)

  const selectPotStatement = database.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM ludo_match_economy_ledger
    WHERE match_id = ? AND entry_type = 'ludo_stake_debit';
  `)

  // Реализира ТОЧНО активния критичен start transaction (виж
  // collectLudoMatchStakesWithInitialSnapshot doc коментара по-горе) — СЪЩИЯТ
  // SQL текст като activeLudoMatchSnapshotStore.ts's upsertMatch, за да
  // остане редът в active_ludo_match_snapshots идентичен независимо коя от
  // двете connections го е записала.
  const insertInitialMatchSnapshotStatement = database.prepare(UPSERT_LUDO_MATCH_SNAPSHOT_SQL)

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as WalletRow | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function hasLedgerEntry(matchId: string, profileId: ProfileId, entryType: LudoLedgerEntryType): boolean {
    return Boolean(selectLedgerStatement.get(matchId, profileId, entryType))
  }

  function getLedgerAmount(matchId: string, profileId: ProfileId, entryType: LudoLedgerEntryType): number | null {
    const row = selectLedgerAmountStatement.get(matchId, profileId, entryType) as { amount: number } | undefined
    return row?.amount ?? null
  }

  function getLudoMatchTotalPot(matchId: string): number {
    const row = selectPotStatement.get(matchId) as { total: number } | undefined
    return row?.total ?? 0
  }

  function collectLudoMatchStakes(
    matchId: string,
    profileIds: ProfileId[],
    stakeAmount: number,
  ): { ok: true } | { ok: false; message: string; insufficientProfileId: ProfileId | null } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return { ok: false, message: 'Невалиден залог за Ludo игра.', insufficientProfileId: null }
    }
    if (profileIds.length === 0) {
      return { ok: true }
    }

    try {
      database.exec('BEGIN;')

      for (const profileId of profileIds) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(matchId, profileId, 'ludo_stake_debit')) {
          continue
        }

        const debitResult = debitWalletStatement.run(stakeAmount, profileId, stakeAmount) as { changes?: number }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return {
            ok: false,
            message: 'Недостатъчен баланс за залога.',
            insufficientProfileId: profileId,
          }
        }

        insertLedgerStatement.run(
          randomUUID(),
          matchId,
          profileId,
          'ludo_stake_debit',
          stakeAmount,
          getWalletBalance(profileId),
        )
      }

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Залозите не бяха начислени.',
        insufficientProfileId: null,
      }
    }

    return { ok: true }
  }

  // Виж collectLudoMatchStakesWithInitialSnapshot doc коментара в
  // LudoEconomyStore типа по-горе — ИДЕНТИЧЕН debit loop като
  // collectLudoMatchStakes (нарочно дублиран тук, не reuse чрез helper,
  // защото трябва да сподели ЕДНА транзакция с snapshot insert-а долу; общ
  // helper би или разбил транзакцията на два BEGIN/COMMIT блока, или изисквал
  // caller-ите на collectLudoMatchStakes да минават през "in transaction"
  // флаг параметър навсякъде — по-рисково от контролирано дублиране на ~15
  // реда добре тестван код), плюс insert на initialSnapshot-а В СЪЩАТА
  // транзакция.
  function collectLudoMatchStakesWithInitialSnapshot(
    matchId: string,
    profileIds: ProfileId[],
    stakeAmount: number,
    initialSnapshot: LudoMatchSnapshot,
  ): { ok: true } | { ok: false; message: string; insufficientProfileId: ProfileId | null } {
    if (!Number.isInteger(stakeAmount) || stakeAmount <= 0) {
      return { ok: false, message: 'Невалиден залог за Ludo игра.', insufficientProfileId: null }
    }
    if (profileIds.length === 0) {
      return { ok: false, message: 'Ludo match без играчи.', insufficientProfileId: null }
    }

    try {
      database.exec('BEGIN;')

      for (const profileId of profileIds) {
        ensureWalletStatement.run(profileId)

        if (hasLedgerEntry(matchId, profileId, 'ludo_stake_debit')) {
          continue
        }

        const debitResult = debitWalletStatement.run(stakeAmount, profileId, stakeAmount) as { changes?: number }

        if ((debitResult.changes ?? 0) === 0) {
          database.exec('ROLLBACK;')
          return {
            ok: false,
            message: 'Недостатъчен баланс за залога.',
            insufficientProfileId: profileId,
          }
        }

        insertLedgerStatement.run(
          randomUUID(),
          matchId,
          profileId,
          'ludo_stake_debit',
          stakeAmount,
          getWalletBalance(profileId),
        )
      }

      // Инвариант (виж task spec §3): "Ако stake debit е commit-нат, initial
      // active match snapshot ЗАДЪЛЖИТЕЛНО съществува." Insert-ът е В СЪЩАТА
      // транзакция като debit-а по-горе — ако ТОЗИ statement fail-не (напр.
      // CHECK constraint violation от повреден snapshot_json), catch блокът
      // долу ROLLBACK-ва ЦЕЛИЯ debit заедно с него, не само snapshot-а.
      const row = buildLudoMatchSnapshotRow(initialSnapshot)
      insertInitialMatchSnapshotStatement.run(
        row.matchId, row.snapshotVersion, row.ludoRoomId, row.matchStatus,
        row.revision, row.snapshotJson, row.matchStatus,
      )

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Играта не можа да стартира.',
        insufficientProfileId: null,
      }
    }

    return { ok: true }
  }

  function payoutLudoMatchWinner(
    matchId: string,
    winnerProfileId: ProfileId,
  ): { ok: true; totalPot: number; prizeAmount: number; alreadyPaid: boolean } | { ok: false; message: string } {
    const totalPot = getLudoMatchTotalPot(matchId)

    if (totalPot <= 0) {
      return { ok: false, message: 'Няма събран залог за този Ludo match.' }
    }

    const prizeAmount = computeLudoWinnerPrize(totalPot)

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(winnerProfileId)

      if (hasLedgerEntry(matchId, winnerProfileId, 'ludo_winner_payout')) {
        database.exec('COMMIT;')
        const historicalAmount = getLedgerAmount(matchId, winnerProfileId, 'ludo_winner_payout')
        return { ok: true, totalPot, prizeAmount: historicalAmount ?? prizeAmount, alreadyPaid: true }
      }

      creditWalletStatement.run(prizeAmount, winnerProfileId)
      insertLedgerStatement.run(
        randomUUID(),
        matchId,
        winnerProfileId,
        'ludo_winner_payout',
        prizeAmount,
        getWalletBalance(winnerProfileId),
      )
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Наградата не беше изплатена.',
      }
    }

    return { ok: true, totalPot, prizeAmount, alreadyPaid: false }
  }

  function close(): void {
    database.close()
  }

  return {
    getWalletBalance,
    collectLudoMatchStakes,
    collectLudoMatchStakesWithInitialSnapshot,
    getLudoMatchTotalPot,
    payoutLudoMatchWinner,
    close,
  }
}

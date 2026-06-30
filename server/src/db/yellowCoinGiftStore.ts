import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'

// Преобразува SQLite "YYYY-MM-DD HH:MM:SS" в строг ISO 8601 UTC "YYYY-MM-DDTHH:MM:SS.000Z"
// Използва се само за nextReleaseAt — не засяга глобалното dbDateToUtc поведение.
function sqliteDateToIso(value: string): string {
  return value.replace(' ', 'T') + '.000Z'
}

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type YellowCoinGiftSnapshot = {
  giftId: string
  friendshipId: string | null
  senderProfileId: ProfileId
  recipientProfileId: ProfileId
  amount: number
  senderBalanceAfter: number
  recipientBalanceAfter: number
  createdAt: string
}

export type PendingGiftNotification = {
  giftId: string
  amount: number
  fromDisplayName: string
}

export type GiftLimitError = {
  ok: false
  code: 'RECIPIENT_WINDOW_LIMIT_PARTIAL' | 'RECIPIENT_WINDOW_LIMIT_FULL'
  message: string
  receivedInWindow: number
  remainingAllowance: number
  attemptedAmount: number
  nextReleaseAt: string | null
  nextReleaseAmount: number
}

export type YellowCoinGiftStore = {
  sendGift: (
    senderProfileId: ProfileId,
    friendshipId: string,
    amount: number,
  ) =>
    | {
        ok: true
        gift: YellowCoinGiftSnapshot
        senderProfile: PlayerPublicProfileSnapshot
        recipientProfile: PlayerPublicProfileSnapshot
      }
    | GiftLimitError
    | { ok: false; message: string }
  createGiftNotification: (giftId: string, recipientProfileId: ProfileId, fromDisplayName: string, amount: number) => void
  getPendingGiftNotifications: (profileId: ProfileId) => PendingGiftNotification[]
  markGiftNotificationRead: (giftId: string, profileId: ProfileId) => void
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
}

type WalletRow = {
  yellow_coins_balance: number
}

type GiftRow = {
  gift_id: string
  friendship_id: string | null
  sender_profile_id: string
  recipient_profile_id: string
  amount: number
  sender_balance_after: number
  recipient_balance_after: number
  created_at: string
}

type RecipientWindowRow = {
  received_in_window: number
  next_release_at: string | null
  next_release_amount: number
}

const MIN_GIFT_AMOUNT = 100
const MAX_GIFT_AMOUNT = 50_000
const DAILY_GIFT_LIMIT = 200_000
const RECIPIENT_GIFT_WINDOW_LIMIT = 30_000
const RECIPIENT_GIFT_WINDOW_DAYS = 60

function normalizeGiftAmount(value: number): number | null {
  if (!Number.isInteger(value) || value < MIN_GIFT_AMOUNT || value > MAX_GIFT_AMOUNT) {
    return null
  }

  return value
}

function getRecipientProfileId(
  friendship: FriendshipRow,
  senderProfileId: ProfileId,
): ProfileId {
  return friendship.requester_profile_id === senderProfileId
    ? friendship.addressee_profile_id
    : friendship.requester_profile_id
}

function toGiftSnapshot(row: GiftRow): YellowCoinGiftSnapshot {
  return {
    giftId: row.gift_id,
    friendshipId: row.friendship_id,
    senderProfileId: row.sender_profile_id,
    recipientProfileId: row.recipient_profile_id,
    amount: row.amount,
    senderBalanceAfter: row.sender_balance_after,
    recipientBalanceAfter: row.recipient_balance_after,
    createdAt: dbDateToUtc(row.created_at),
  }
}

function formatBgNumber(value: number): string {
  return value.toLocaleString('bg-BG')
}

export async function createYellowCoinGiftStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<YellowCoinGiftStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  database.exec(`
    CREATE TABLE IF NOT EXISTS gift_notification_log (
      gift_id TEXT PRIMARY KEY,
      recipient_profile_id TEXT NOT NULL,
      from_display_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      read_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)

  const insertGiftNotificationStatement = database.prepare(`
    INSERT OR IGNORE INTO gift_notification_log (gift_id, recipient_profile_id, from_display_name, amount)
    VALUES (?, ?, ?, ?);
  `)

  const selectPendingGiftNotificationsStatement = database.prepare(`
    SELECT gift_id, amount, from_display_name
    FROM gift_notification_log
    WHERE recipient_profile_id = ? AND read_at IS NULL
    ORDER BY created_at ASC;
  `)

  const markGiftNotificationReadStatement = database.prepare(`
    UPDATE gift_notification_log
    SET read_at = CURRENT_TIMESTAMP
    WHERE gift_id = ? AND recipient_profile_id = ?;
  `)

  const selectAcceptedFriendshipStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id
    FROM profile_friendships
    WHERE friendship_id = ?
      AND status = 'accepted'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      )
    LIMIT 1;
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (
      profile_id,
      yellow_coins_balance
    ) VALUES (
      ?,
      0
    )
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const selectWalletStatement = database.prepare(`
    SELECT yellow_coins_balance
    FROM profile_wallets
    WHERE profile_id = ?
    LIMIT 1;
  `)

  const selectSentTodayStatement = database.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS sent_amount
    FROM yellow_coin_gift_ledger
    WHERE sender_profile_id = ?
      AND created_at >= datetime('now', '-24 hours');
  `)

  // Единична заявка за съгласуван snapshot на 60-дневния прозорец по получател
  const selectRecipientWindowStatement = database.prepare(`
    WITH window_gifts AS (
      SELECT amount, created_at
      FROM yellow_coin_gift_ledger
      WHERE recipient_profile_id = ?
        AND created_at > datetime('now', '-${RECIPIENT_GIFT_WINDOW_DAYS} days')
    ),
    oldest AS (
      SELECT MIN(created_at) AS oldest_created_at
      FROM window_gifts
    )
    SELECT
      COALESCE((SELECT SUM(amount) FROM window_gifts), 0) AS received_in_window,
      datetime(
        (SELECT oldest_created_at FROM oldest),
        '+${RECIPIENT_GIFT_WINDOW_DAYS} days'
      ) AS next_release_at,
      COALESCE(
        (
          SELECT SUM(amount)
          FROM window_gifts
          WHERE created_at = (SELECT oldest_created_at FROM oldest)
        ),
        0
      ) AS next_release_amount;
  `)

  const debitSenderStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance - ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?
      AND yellow_coins_balance >= ?;
  `)

  const creditRecipientStatement = database.prepare(`
    UPDATE profile_wallets
    SET
      yellow_coins_balance = yellow_coins_balance + ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ?;
  `)

  const insertGiftStatement = database.prepare(`
    INSERT INTO yellow_coin_gift_ledger (
      gift_id,
      friendship_id,
      sender_profile_id,
      recipient_profile_id,
      amount,
      sender_balance_after,
      recipient_balance_after
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectGiftStatement = database.prepare(`
    SELECT
      gift_id,
      friendship_id,
      sender_profile_id,
      recipient_profile_id,
      amount,
      sender_balance_after,
      recipient_balance_after,
      created_at
    FROM yellow_coin_gift_ledger
    WHERE gift_id = ?
    LIMIT 1;
  `)

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as WalletRow | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function sendGift(
    senderProfileId: ProfileId,
    friendshipId: string,
    amountRaw: number,
  ):
    | {
        ok: true
        gift: YellowCoinGiftSnapshot
        senderProfile: PlayerPublicProfileSnapshot
        recipientProfile: PlayerPublicProfileSnapshot
      }
    | GiftLimitError
    | { ok: false; message: string } {
    // Чиста TypeScript валидация преди базата
    const amount = normalizeGiftAmount(amountRaw)

    if (amount === null) {
      return {
        ok: false,
        message: `Сумата трябва да е между ${MIN_GIFT_AMOUNT} и ${MAX_GIFT_AMOUNT} жълтици.`,
      }
    }

    const giftId = randomUUID()
    let recipientProfileId: ProfileId = '' as ProfileId

    try {
      database.exec('BEGIN IMMEDIATE;')

      // 1. Проверка за прието приятелство
      const friendship = selectAcceptedFriendshipStatement.get(
        friendshipId,
        senderProfileId,
        senderProfileId,
      ) as FriendshipRow | undefined

      if (!friendship) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Можеш да подаряваш жълтици само на приятели.',
        }
      }

      // 2. Определяне на получателя
      recipientProfileId = getRecipientProfileId(friendship, senderProfileId)

      // 3. Защита срещу подарък към себе си
      if (recipientProfileId === senderProfileId) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Не можеш да подариш жълтици на себе си.',
        }
      }

      // 4. Sender 24-часов лимит
      const sentTodayRow = selectSentTodayStatement.get(senderProfileId) as
        | { sent_amount: number }
        | undefined
      const sentToday = sentTodayRow?.sent_amount ?? 0

      if (sentToday + amount > DAILY_GIFT_LIMIT) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: `Дневният лимит за подаръци е ${DAILY_GIFT_LIMIT} жълтици.`,
        }
      }

      // 5. Recipient 60-дневен лимит
      const windowRow = selectRecipientWindowStatement.get(recipientProfileId) as
        | RecipientWindowRow
        | undefined
      const receivedInWindow = windowRow?.received_in_window ?? 0
      const nextReleaseAtRaw = windowRow?.next_release_at ?? null
      const nextReleaseAmount = windowRow?.next_release_amount ?? 0
      const nextReleaseAt = nextReleaseAtRaw !== null ? sqliteDateToIso(nextReleaseAtRaw) : null

      const remainingAllowance = Math.max(0, RECIPIENT_GIFT_WINDOW_LIMIT - receivedInWindow)

      if (amount > remainingAllowance) {
        database.exec('ROLLBACK;')

        if (remainingAllowance === 0) {
          return {
            ok: false,
            code: 'RECIPIENT_WINDOW_LIMIT_FULL',
            message: `Този играч вече е получил максималния размер от ${formatBgNumber(RECIPIENT_GIFT_WINDOW_LIMIT)} подарени жълтици за последните ${RECIPIENT_GIFT_WINDOW_DAYS} дни.`,
            receivedInWindow,
            remainingAllowance: 0,
            attemptedAmount: amount,
            nextReleaseAt,
            nextReleaseAmount,
          }
        }

        return {
          ok: false,
          code: 'RECIPIENT_WINDOW_LIMIT_PARTIAL',
          message: `Този играч може да получи още най-много ${formatBgNumber(remainingAllowance)} жълтици в текущия ${RECIPIENT_GIFT_WINDOW_DAYS}-дневен период.`,
          receivedInWindow,
          remainingAllowance,
          attemptedAmount: amount,
          nextReleaseAt,
          nextReleaseAmount,
        }
      }

      // 6. Ensure wallet и за двамата
      ensureWalletStatement.run(senderProfileId)
      ensureWalletStatement.run(recipientProfileId)

      // 7. Атомарен debit на изпращача
      const debitResult = debitSenderStatement.run(
        amount,
        senderProfileId,
        amount,
      ) as { changes?: number }

      if ((debitResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Нямаш достатъчно жълтици за този подарък.',
        }
      }

      // 8. Credit на получателя
      creditRecipientStatement.run(amount, recipientProfileId)

      // 9. Четене на новите баланси
      const senderBalanceAfter = getWalletBalance(senderProfileId)
      const recipientBalanceAfter = getWalletBalance(recipientProfileId)

      // 10. Insert в yellow_coin_gift_ledger
      insertGiftStatement.run(
        giftId,
        friendshipId,
        senderProfileId,
        recipientProfileId,
        amount,
        senderBalanceAfter,
        recipientBalanceAfter,
      )

      // 11. COMMIT
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface the original failure
      }

      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Подаръкът не беше изпратен.',
      }
    }

    const giftRow = selectGiftStatement.get(giftId) as GiftRow | undefined
    const senderProfile = playerProgressStore.getPublicProfile(senderProfileId)
    const recipientProfile = playerProgressStore.getPublicProfile(recipientProfileId)

    if (!giftRow || senderProfile === null || recipientProfile === null) {
      return {
        ok: false,
        message: 'Подаръкът беше записан, но профилите не се обновиха.',
      }
    }

    return {
      ok: true,
      gift: toGiftSnapshot(giftRow),
      senderProfile,
      recipientProfile,
    }
  }

  function createGiftNotification(giftId: string, recipientProfileId: ProfileId, fromDisplayName: string, amount: number): void {
    insertGiftNotificationStatement.run(giftId, recipientProfileId, fromDisplayName, amount)
  }

  function getPendingGiftNotifications(profileId: ProfileId): PendingGiftNotification[] {
    const rows = selectPendingGiftNotificationsStatement.all(profileId) as Array<{
      gift_id: string
      amount: number
      from_display_name: string
    }>
    return rows.map((r) => ({ giftId: r.gift_id, amount: r.amount, fromDisplayName: r.from_display_name }))
  }

  function markGiftNotificationRead(giftId: string, profileId: ProfileId): void {
    markGiftNotificationReadStatement.run(giftId, profileId)
  }

  function close(): void {
    database.close()
  }

  return {
    sendGift,
    createGiftNotification,
    getPendingGiftNotifications,
    markGiftNotificationRead,
    close,
  }
}

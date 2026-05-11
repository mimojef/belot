import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type YellowCoinGiftSnapshot = {
  giftId: string
  friendshipId: string
  senderProfileId: ProfileId
  recipientProfileId: ProfileId
  amount: number
  senderBalanceAfter: number
  recipientBalanceAfter: number
  createdAt: string
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
    | { ok: false; message: string }
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
  friendship_id: string
  sender_profile_id: string
  recipient_profile_id: string
  amount: number
  sender_balance_after: number
  recipient_balance_after: number
  created_at: string
}

const MIN_GIFT_AMOUNT = 100
const MAX_GIFT_AMOUNT = 50_000
const DAILY_GIFT_LIMIT = 200_000

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
    createdAt: row.created_at,
  }
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
    | { ok: false; message: string } {
    const amount = normalizeGiftAmount(amountRaw)

    if (amount === null) {
      return {
        ok: false,
        message: `Сумата трябва да е между ${MIN_GIFT_AMOUNT} и ${MAX_GIFT_AMOUNT} жълтици.`,
      }
    }

    const friendship = selectAcceptedFriendshipStatement.get(
      friendshipId,
      senderProfileId,
      senderProfileId,
    ) as FriendshipRow | undefined

    if (!friendship) {
      return {
        ok: false,
        message: 'Можеш да подаряваш жълтици само на приятели.',
      }
    }

    const recipientProfileId = getRecipientProfileId(friendship, senderProfileId)

    if (recipientProfileId === senderProfileId) {
      return {
        ok: false,
        message: 'Не можеш да подариш жълтици на себе си.',
      }
    }

    const sentTodayRow = selectSentTodayStatement.get(senderProfileId) as
      | { sent_amount: number }
      | undefined
    const sentToday = sentTodayRow?.sent_amount ?? 0

    if (sentToday + amount > DAILY_GIFT_LIMIT) {
      return {
        ok: false,
        message: `Дневният лимит за подаръци е ${DAILY_GIFT_LIMIT} жълтици.`,
      }
    }

    const giftId = randomUUID()

    try {
      database.exec('BEGIN;')
      ensureWalletStatement.run(senderProfileId)
      ensureWalletStatement.run(recipientProfileId)

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

      creditRecipientStatement.run(amount, recipientProfileId)

      const senderBalanceAfter = getWalletBalance(senderProfileId)
      const recipientBalanceAfter = getWalletBalance(recipientProfileId)

      insertGiftStatement.run(
        giftId,
        friendshipId,
        senderProfileId,
        recipientProfileId,
        amount,
        senderBalanceAfter,
        recipientBalanceAfter,
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

  function close(): void {
    database.close()
  }

  return {
    sendGift,
    close,
  }
}

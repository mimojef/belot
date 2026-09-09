import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type GiftItemSnapshot = {
  giftItemId: string
  name: string
  imageUrl: string
  price: number
  isActive: boolean
  sortOrder: number
}

export type GiftItemInput = {
  giftItemId?: string | null
  name: string
  imageUrl: string
  price: number
  sortOrder: number
  isActive: boolean
}

export type GiftItemTransactionSnapshot = {
  transactionId: string
  giftItemId: string
  senderProfileId: ProfileId
  recipientProfileId: ProfileId
  chargedPrice: number
  context: string
  roomId: string | null
  requestId: string
  createdAt: string
}

export type PendingGiftItemDelivery = {
  transactionId: string
  giftItemId: string
  itemName: string
  imageUrl: string
  fromDisplayName: string
}

export type SendGiftItemResult =
  | {
      ok: true
      transaction: GiftItemTransactionSnapshot
      giftItem: GiftItemSnapshot | null
      senderProfile: PlayerPublicProfileSnapshot
      recipientProfile: PlayerPublicProfileSnapshot
      senderBalanceAfter: number
    }
  | { ok: false; message: string }

export type GiftItemStore = {
  listActiveGiftItems: () => GiftItemSnapshot[]
  listAdminGiftItems: () => GiftItemSnapshot[]
  upsertGiftItem: (
    input: GiftItemInput,
  ) =>
    | { ok: true; item: GiftItemSnapshot; previousImageUrl: string | null }
    | { ok: false; message: string }
  setGiftItemActive: (
    giftItemId: string,
    isActive: boolean,
  ) => { ok: true; item: GiftItemSnapshot } | { ok: false; message: string }
  deleteGiftItem: (
    giftItemId: string,
  ) =>
    | { ok: true; items: GiftItemSnapshot[]; deletedImageUrl: string }
    | { ok: false; message: string }
  /**
   * Reference-safe delete guard (виж index.ts route за §2/§3/§4 от Image
   * Cleanup брифа) — true ако imageUrl все още се използва от някой АКТИВЕН
   * или ИСТОРИЧЕСКИ gift reference (gift_items.image_url ИЛИ
   * gift_item_delivery_log.image_url). Delete helper-ът (deleteUploadFileByUrl,
   * index.ts) трябва да се извиква ЕДИНСТВЕНО когато това връща false —
   * иначе рискуваме да изтрием файл, все още показван в стар offline
   * delivery notification.
   */
  isImageUrlReferenced: (imageUrl: string) => boolean
  sendGiftItem: (
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
    giftItemId: string,
    requestId: string,
    context?: string,
    roomId?: string | null,
  ) => SendGiftItemResult
  createDeliveryNotification: (
    transactionId: string,
    recipientProfileId: ProfileId,
    giftItemId: string,
    itemName: string,
    imageUrl: string,
    fromDisplayName: string,
  ) => void
  getPendingDeliveries: (profileId: ProfileId) => PendingGiftItemDelivery[]
  markDeliveryShown: (transactionId: string, profileId: ProfileId) => void
  close: () => void
}

type GiftItemRow = {
  gift_item_id: string
  name: string
  image_url: string
  price: number
  is_active: number
  sort_order: number
}

type GiftItemTransactionRow = {
  transaction_id: string
  gift_item_id: string
  sender_profile_id: string
  recipient_profile_id: string
  charged_price: number
  context: string
  room_id: string | null
  request_id: string
  created_at: string
}

function rowToSnapshot(row: GiftItemRow): GiftItemSnapshot {
  return {
    giftItemId: row.gift_item_id,
    name: row.name,
    imageUrl: row.image_url,
    price: row.price,
    isActive: row.is_active !== 0,
    sortOrder: row.sort_order,
  }
}

function rowToTransactionSnapshot(row: GiftItemTransactionRow): GiftItemTransactionSnapshot {
  return {
    transactionId: row.transaction_id,
    giftItemId: row.gift_item_id,
    senderProfileId: row.sender_profile_id,
    recipientProfileId: row.recipient_profile_id,
    chargedPrice: row.charged_price,
    context: row.context,
    roomId: row.room_id,
    requestId: row.request_id,
    createdAt: row.created_at,
  }
}

function normalizeText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength)
}

function normalizeInteger(value: number, min: number, max: number): number | null {
  if (!Number.isInteger(value) || value < min || value > max) {
    return null
  }

  return value
}

export async function createGiftItemStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<GiftItemStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const selectActiveItemsStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, sort_order
    FROM gift_items
    WHERE is_active = 1
    ORDER BY sort_order ASC, name ASC;
  `)

  const selectAdminItemsStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, sort_order
    FROM gift_items
    ORDER BY sort_order ASC, name ASC;
  `)

  const selectItemByIdStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, sort_order
    FROM gift_items
    WHERE gift_item_id = ?
    LIMIT 1;
  `)

  const insertItemStatement = database.prepare(`
    INSERT INTO gift_items (
      gift_item_id, name, image_url, price, is_active, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  const updateItemStatement = database.prepare(`
    UPDATE gift_items
    SET name = ?, image_url = ?, price = ?, is_active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE gift_item_id = ?;
  `)

  const updateItemActiveStatement = database.prepare(`
    UPDATE gift_items
    SET is_active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE gift_item_id = ?;
  `)

  const deleteItemStatement = database.prepare(`
    DELETE FROM gift_items WHERE gift_item_id = ?;
  `)

  const countTransactionsForItemStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_item_transactions WHERE gift_item_id = ?;
  `)

  const selectTransactionByRequestIdStatement = database.prepare(`
    SELECT transaction_id, gift_item_id, sender_profile_id, recipient_profile_id,
           charged_price, context, room_id, request_id, created_at
    FROM gift_item_transactions
    WHERE request_id = ?
    LIMIT 1;
  `)

  const ensureWalletStatement = database.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, 0)
    ON CONFLICT(profile_id) DO NOTHING;
  `)

  const selectWalletStatement = database.prepare(`
    SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ? LIMIT 1;
  `)

  const debitSenderStatement = database.prepare(`
    UPDATE profile_wallets
    SET yellow_coins_balance = yellow_coins_balance - ?, updated_at = CURRENT_TIMESTAMP
    WHERE profile_id = ? AND yellow_coins_balance >= ?;
  `)

  const insertTransactionStatement = database.prepare(`
    INSERT INTO gift_item_transactions (
      transaction_id, gift_item_id, sender_profile_id, recipient_profile_id,
      charged_price, context, room_id, request_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
  `)

  const insertDeliveryStatement = database.prepare(`
    INSERT INTO gift_item_delivery_log (
      transaction_id, recipient_profile_id, gift_item_id, item_name, image_url, from_display_name
    ) VALUES (?, ?, ?, ?, ?, ?);
  `)

  // ORDER BY created_at ASC, rowid ASC — created_at е secondна прецизност
  // (SQLite CURRENT_TIMESTAMP), затова 2-3 бързи последователни подаръка
  // (точно "изпрати 3 подаръка на offline получател" сценарий) могат да
  // получат ИДЕНТИЧЕН timestamp. rowid tie-break гарантира deterministic
  // insertion-order fallback (SQLite implicit column, без schema промяна —
  // gift_item_delivery_log няма WITHOUT ROWID) вместо недетерминистичен ред
  // между redове със същия created_at.
  const selectPendingDeliveriesStatement = database.prepare(`
    SELECT transaction_id, gift_item_id, item_name, image_url, from_display_name
    FROM gift_item_delivery_log
    WHERE recipient_profile_id = ? AND shown_at IS NULL
    ORDER BY created_at ASC, rowid ASC;
  `)

  const markDeliveryShownStatement = database.prepare(`
    UPDATE gift_item_delivery_log
    SET shown_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND recipient_profile_id = ?;
  `)

  // Reference-safe delete guard (виж isImageUrlReferenced по-долу) — двете
  // места, откъдето имидж URL може все още да е "жив": текущия каталог ред
  // (включително друг gift item, ако admin ръчно е copy-paste-нал същия URL
  // — виж audit т.13) и историческия snapshot в delivery log-а (стар/офлайн
  // notification все още сочи към старата картинка след replace).
  const countGiftItemsByImageUrlStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_items WHERE image_url = ?;
  `)
  const countDeliveryLogByImageUrlStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_item_delivery_log WHERE image_url = ?;
  `)

  function listActiveGiftItems(): GiftItemSnapshot[] {
    return (selectActiveItemsStatement.all() as GiftItemRow[]).map(rowToSnapshot)
  }

  function listAdminGiftItems(): GiftItemSnapshot[] {
    return (selectAdminItemsStatement.all() as GiftItemRow[]).map(rowToSnapshot)
  }

  function getItemById(giftItemId: string): GiftItemSnapshot | null {
    const row = selectItemByIdStatement.get(giftItemId) as GiftItemRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  function upsertGiftItem(
    input: GiftItemInput,
  ):
    | { ok: true; item: GiftItemSnapshot; previousImageUrl: string | null }
    | { ok: false; message: string } {
    const giftItemId = normalizeText(input.giftItemId ?? '', 96) || randomUUID()
    const name = normalizeText(input.name, 80)
    const imageUrl = normalizeText(input.imageUrl, 500)
    const price = normalizeInteger(input.price, 1, 100_000_000)
    const sortOrder = normalizeInteger(input.sortOrder, 0, 1_000_000)

    if (name.length < 1) {
      return { ok: false, message: 'Името на подаръка трябва да е поне 1 символ.' }
    }

    if (imageUrl.length < 1) {
      return { ok: false, message: 'Подаръкът трябва да има картинка.' }
    }

    if (price === null) {
      return { ok: false, message: 'Цената трябва да е цяло положително число.' }
    }

    if (sortOrder === null) {
      return { ok: false, message: 'Подредбата трябва да е цяло число между 0 и 1 000 000.' }
    }

    const existing = getItemById(giftItemId)

    if (existing === null) {
      insertItemStatement.run(giftItemId, name, imageUrl, price, input.isActive ? 1 : 0, sortOrder)
    } else {
      updateItemStatement.run(name, imageUrl, price, input.isActive ? 1 : 0, sortOrder, giftItemId)
    }

    const savedItem = getItemById(giftItemId)

    if (savedItem === null) {
      return { ok: false, message: 'Подаръкът не беше записан.' }
    }

    // previousImageUrl е non-null САМО при реален edit с реално различен URL —
    // caller-ът (index.ts route, §3 Image Replace) го ползва за reference-safe
    // cleanup на СТАРИЯ файл СЛЕД успешния DB update. При create (existing===
    // null) или "edit без смяна на картинка" (existing.imageUrl===imageUrl)
    // връщаме null — няма стар файл за проверка/трене.
    const previousImageUrl =
      existing !== null && existing.imageUrl !== imageUrl ? existing.imageUrl : null

    return { ok: true, item: savedItem, previousImageUrl }
  }

  function setGiftItemActive(
    giftItemId: string,
    isActive: boolean,
  ): { ok: true; item: GiftItemSnapshot } | { ok: false; message: string } {
    const normalizedId = normalizeText(giftItemId, 96)

    if (normalizedId.length === 0) {
      return { ok: false, message: 'Невалиден ID на подарък.' }
    }

    updateItemActiveStatement.run(isActive ? 1 : 0, normalizedId)

    const updatedItem = getItemById(normalizedId)

    if (updatedItem === null) {
      return { ok: false, message: 'Подаръкът не беше намерен.' }
    }

    return { ok: true, item: updatedItem }
  }

  function deleteGiftItem(
    giftItemId: string,
  ):
    | { ok: true; items: GiftItemSnapshot[]; deletedImageUrl: string }
    | { ok: false; message: string } {
    const normalizedId = normalizeText(giftItemId, 96)

    if (normalizedId.length === 0) {
      return { ok: false, message: 'Невалиден ID на подарък.' }
    }

    const existing = getItemById(normalizedId)

    if (existing === null) {
      return { ok: false, message: 'Подаръкът не беше намерен.' }
    }

    const countRow = countTransactionsForItemStatement.get(normalizedId) as { cnt: number } | undefined

    if ((countRow?.cnt ?? 0) > 0) {
      return {
        ok: false,
        message: 'Подаръкът има история и не може да бъде изтрит — деактивирай го вместо това.',
      }
    }

    try {
      deleteItemStatement.run(normalizedId)
    } catch (error) {
      return {
        ok: false,
        message: 'Подаръкът има история и не може да бъде изтрит — деактивирай го вместо това.',
      }
    }

    // deletedImageUrl се връща за caller-а (index.ts route, §4 Hard Delete) да
    // прецени file cleanup СЛЕД успешния DELETE — самият DELETE вече мина
    // (§2 гарантира нула transactions за тоя giftItemId), но delivery log
    // редове от ПРЕДИШНИ (сега изтрити от history гледна точка невъзможно,
    // тъй като >0 transactions блокира delete — все пак isImageUrlReferenced
    // проверява и delivery_log за пълна защита, ако друг активен gift
    // item ръчно споделя същия image_url, виж audit т.13).
    return { ok: true, items: listAdminGiftItems(), deletedImageUrl: existing.imageUrl }
  }

  function isImageUrlReferenced(imageUrl: string): boolean {
    const normalizedUrl = imageUrl.trim()

    if (normalizedUrl.length === 0) {
      return false
    }

    const activeCount = (countGiftItemsByImageUrlStatement.get(normalizedUrl) as { cnt: number }).cnt
    if (activeCount > 0) {
      return true
    }

    const deliveryCount = (countDeliveryLogByImageUrlStatement.get(normalizedUrl) as { cnt: number }).cnt
    return deliveryCount > 0
  }

  function getWalletBalance(profileId: ProfileId): number {
    const row = selectWalletStatement.get(profileId) as { yellow_coins_balance: number } | undefined
    return row?.yellow_coins_balance ?? 0
  }

  function sendGiftItem(
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
    giftItemId: string,
    requestId: string,
    context: string = 'profile',
    roomId: string | null = null,
  ): SendGiftItemResult {
    const normalizedRequestId = normalizeText(requestId, 96)

    if (normalizedRequestId.length === 0) {
      return { ok: false, message: 'Невалидна заявка (requestId липсва).' }
    }

    try {
      database.exec('BEGIN IMMEDIATE;')

      // 1. Idempotency check FIRST — replay на успешен резултат при double-click,
      // не грешка. Нищо не е променено от тук нататък при replay.
      const existingTxRow = selectTransactionByRequestIdStatement.get(
        normalizedRequestId,
      ) as GiftItemTransactionRow | undefined

      if (existingTxRow) {
        database.exec('ROLLBACK;')

        const senderProfile = playerProgressStore.getPublicProfile(senderProfileId)
        const recipientProfile = playerProgressStore.getPublicProfile(recipientProfileId)
        const giftItem = getItemById(existingTxRow.gift_item_id)

        if (!senderProfile || !recipientProfile) {
          return { ok: false, message: 'Подаръкът беше изпратен, но профилите не се заредиха.' }
        }

        return {
          ok: true,
          transaction: rowToTransactionSnapshot(existingTxRow),
          giftItem,
          senderProfile,
          recipientProfile,
          senderBalanceAfter: getWalletBalance(senderProfileId),
        }
      }

      // 2. sender profile съществува
      const senderProfile = playerProgressStore.getPublicProfile(senderProfileId)

      if (senderProfile === null) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Изпращачът не е намерен.' }
      }

      // 3. recipient profile съществува
      const recipientProfile = playerProgressStore.getPublicProfile(recipientProfileId)

      if (recipientProfile === null) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Играчът не е намерен.' }
      }

      // 4. sender !== recipient
      if (senderProfileId === recipientProfileId) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Не можеш да си изпратиш подарък сам на себе си.' }
      }

      // 5-6. gift item съществува, активен е, цената се чете от DB в реално време
      const giftItem = getItemById(giftItemId)

      if (giftItem === null || !giftItem.isActive) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Подаръкът не е наличен.' }
      }

      const price = giftItem.price

      // 7. Ensure wallet за sender
      ensureWalletStatement.run(senderProfileId)

      // 8. Атомарен debit
      const debitResult = debitSenderStatement.run(price, senderProfileId, price) as { changes?: number }

      if ((debitResult.changes ?? 0) === 0) {
        database.exec('ROLLBACK;')
        return { ok: false, message: 'Нямаш достатъчно жълтици.' }
      }

      // 9. INSERT transaction
      const transactionId = randomUUID()
      insertTransactionStatement.run(
        transactionId,
        giftItem.giftItemId,
        senderProfileId,
        recipientProfileId,
        price,
        context,
        roomId,
        normalizedRequestId,
      )

      // 10. COMMIT
      database.exec('COMMIT;')

      // 11. Read updated balance, build response
      const senderBalanceAfter = getWalletBalance(senderProfileId)
      const txRow = selectTransactionByRequestIdStatement.get(normalizedRequestId) as
        | GiftItemTransactionRow
        | undefined

      if (!txRow) {
        return { ok: false, message: 'Подаръкът беше записан, но не можа да се прочете обратно.' }
      }

      return {
        ok: true,
        transaction: rowToTransactionSnapshot(txRow),
        giftItem,
        senderProfile,
        recipientProfile,
        senderBalanceAfter,
      }
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // surface original error
      }

      return {
        ok: false,
        message: error instanceof Error ? error.message : 'Подаръкът не беше изпратен.',
      }
    }
  }

  function createDeliveryNotification(
    transactionId: string,
    recipientProfileId: ProfileId,
    giftItemId: string,
    itemName: string,
    imageUrl: string,
    fromDisplayName: string,
  ): void {
    insertDeliveryStatement.run(transactionId, recipientProfileId, giftItemId, itemName, imageUrl, fromDisplayName)
  }

  function getPendingDeliveries(profileId: ProfileId): PendingGiftItemDelivery[] {
    const rows = selectPendingDeliveriesStatement.all(profileId) as Array<{
      transaction_id: string
      gift_item_id: string
      item_name: string
      image_url: string
      from_display_name: string
    }>

    return rows.map((r) => ({
      transactionId: r.transaction_id,
      giftItemId: r.gift_item_id,
      itemName: r.item_name,
      imageUrl: r.image_url,
      fromDisplayName: r.from_display_name,
    }))
  }

  function markDeliveryShown(transactionId: string, profileId: ProfileId): void {
    markDeliveryShownStatement.run(transactionId, profileId)
  }

  function close(): void {
    database.close()
  }

  return {
    listActiveGiftItems,
    listAdminGiftItems,
    upsertGiftItem,
    setGiftItemActive,
    deleteGiftItem,
    isImageUrlReferenced,
    sendGiftItem,
    createDeliveryNotification,
    getPendingDeliveries,
    markDeliveryShown,
    close,
  }
}

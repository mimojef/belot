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

/**
 * Причина за deleteGiftItem success резултата — гарантира, че callers
 * (index.ts route) недвусмислено знаят дали редът реално е изтрит logically
 * (нов finalize check е уместен) или вече е бил в deleted състояние преди
 * тоя request (idempotent повторен Delete click — все още success, но
 * finalize check-ът вече е бил направен от първия request).
 */
export type DeleteGiftItemOutcome = 'deleted' | 'already-deleted'

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
      /**
       * true САМО когато резултатът е реконструиран от вече съществуващ ред
       * със същия requestId (idempotent replay при double-click/retry), false
       * при реален нов INSERT. Caller-ите ползват това, за да НЕ произведат
       * втори side effect (room broadcast, delivery notification) за един и
       * същ transaction — виж table gift handler-а в index.ts.
       */
      isReplay: boolean
    }
  | { ok: false; message: string }

export type GiftItemStore = {
  /** Изключва И is_active=0, И deleted_at IS NOT NULL redове. */
  listActiveGiftItems: () => GiftItemSnapshot[]
  /** Admin catalog — изключва logically deleted redове (tombstones са
   * server-side невидими навсякъде, включително admin UI, виж брифа §9). */
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
  /**
   * Logical delete (tombstone) — ВИНАГИ позволен, независимо от transaction
   * history (gift_item_transactions.gift_item_id FK е ON DELETE RESTRICT,
   * затова реален DELETE тук никога не е опция за ред с история). Задава
   * само deleted_at; редът остава в DB за FK/historical snapshot цели.
   * Idempotent — повторен delete на вече-deleted ред е "already-deleted"
   * success, не грешка (double-click safe).
   */
  deleteGiftItem: (
    giftItemId: string,
  ) =>
    | { ok: true; items: GiftItemSnapshot[]; deletedImageUrl: string; outcome: DeleteGiftItemOutcome }
    | { ok: false; message: string }
  /**
   * Catalog/reference semantics — true ако imageUrl принадлежи на НЕ-изтрит
   * (deleted_at IS NULL) gift_items ред. Ползва се за upsert/image-replace
   * safe-cleanup решения (§10 от брифа, image replace логиката остава
   * непроменена): не трием "стар" URL, ако друг ЖИВ catalog ред все още го
   * реферира. НЕ брои delivery log rows — виж isImageUrlRetentionReferenced
   * за physical-retention semantics (delete finalize).
   */
  isImageUrlReferenced: (imageUrl: string) => boolean
  /**
   * Physical-retention semantics (§4 от брифа "PENDING DELIVERY Е SOURCE OF
   * TRUTH") — true ако файлът все още трябва да остане на диска: (a) ИМА
   * НЕ-изтрит catalog ред с тоя imageUrl, ИЛИ (b) има поне един
   * gift_item_delivery_log ред с тоя imageUrl и shown_at IS NULL (все още
   * непоказан offline notification). Вече ПОКАЗАНИ (shown_at NOT NULL)
   * historical delivery redове НЕ броят тук — те не пазят файла завинаги.
   * Table gift runtime references (room.config.activeTableGifts) са
   * orthogonal, in-memory state — проверяват се отделно в index.ts
   * (tryFinalizeDeletedGiftImage), не тук (store-ът няма достъп до
   * serverState.rooms).
   */
  isImageUrlRetentionReferenced: (imageUrl: string) => boolean
  /** Gift item id по image URL, само сред logically deleted redове — за
   * finalize reconciliation (§7D startup) да намери tombstone-и с
   * потенциално orphaned файлове. */
  listDeletedGiftItemImageUrls: () => string[]
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
  /** Връща imageUrl на markнатия ред (или null ако не е намерен) — за
   * caller-а (index.ts) да реши дали да опита finalize cleanup СЛЕД
   * mark-shown (§7B от брифа). */
  markDeliveryShown: (transactionId: string, profileId: ProfileId) => string | null
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
    WHERE is_active = 1 AND deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC;
  `)

  const selectAdminItemsStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, sort_order
    FROM gift_items
    WHERE deleted_at IS NULL
    ORDER BY sort_order ASC, name ASC;
  `)

  // БЕЗ deleted_at филтър умишлено — sendGiftItem трябва да "вижда"
  // tombstone redове, за да ги отхвърли explicit (giftItem.deletedAt !==
  // null проверка по-долу), не просто да ги третира като "не съществува".
  const selectItemByIdStatement = database.prepare(`
    SELECT gift_item_id, name, image_url, price, is_active, sort_order, deleted_at
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

  // Logical delete (tombstone) — заменя стария реален DELETE. Идемпотентен
  // по конструкция (WHERE deleted_at IS NULL means повторен опит е no-op
  // UPDATE, changes=0, детектнато explicit в deleteGiftItem по-долу за
  // "already-deleted" outcome-а).
  const softDeleteItemStatement = database.prepare(`
    UPDATE gift_items
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE gift_item_id = ? AND deleted_at IS NULL;
  `)

  const countTransactionsForItemStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_item_transactions WHERE gift_item_id = ?;
  `)

  // §4 Physical-retention semantics — само NE-изтрити catalog redове.
  const countLiveGiftItemsByImageUrlStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_items WHERE image_url = ? AND deleted_at IS NULL;
  `)

  // §4 — само НЕпоказани (still-pending) delivery redове пазят файла;
  // shown_at NOT NULL historical redове не броят тук.
  const countUnseenDeliveryByImageUrlStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM gift_item_delivery_log WHERE image_url = ? AND shown_at IS NULL;
  `)

  // §7D startup reconciliation — намира tombstone redове (за re-check дали
  // image-ите им вече могат безопасно да се финализират).
  const selectDeletedGiftItemImageUrlsStatement = database.prepare(`
    SELECT DISTINCT image_url FROM gift_items WHERE deleted_at IS NOT NULL;
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

  const selectDeliveryImageUrlStatement = database.prepare(`
    SELECT image_url FROM gift_item_delivery_log
    WHERE transaction_id = ? AND recipient_profile_id = ?
    LIMIT 1;
  `)

  function listActiveGiftItems(): GiftItemSnapshot[] {
    return (selectActiveItemsStatement.all() as GiftItemRow[]).map(rowToSnapshot)
  }

  function listAdminGiftItems(): GiftItemSnapshot[] {
    return (selectAdminItemsStatement.all() as GiftItemRow[]).map(rowToSnapshot)
  }

  function getItemById(giftItemId: string): GiftItemSnapshot | null {
    const row = selectItemByIdStatement.get(giftItemId) as (GiftItemRow & { deleted_at: string | null }) | undefined
    return row ? rowToSnapshot(row) : null
  }

  // Вътрешен helper — единственото място, което чете deleted_at directно
  // (публичният GiftItemSnapshot умишлено не го излага, виж isDeletedGiftItemById
  // caller-ите: sendGiftItem explicit reject на tombstone target, вместо да
  // го третира като "не съществува" — по-ясно server-side съобщение).
  function isDeletedGiftItemById(giftItemId: string): boolean {
    const row = selectItemByIdStatement.get(giftItemId) as { deleted_at: string | null } | undefined
    return row?.deleted_at !== null && row?.deleted_at !== undefined
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
    | { ok: true; items: GiftItemSnapshot[]; deletedImageUrl: string; outcome: DeleteGiftItemOutcome }
    | { ok: false; message: string } {
    const normalizedId = normalizeText(giftItemId, 96)

    if (normalizedId.length === 0) {
      return { ok: false, message: 'Невалиден ID на подарък.' }
    }

    // getItemById вече НЕ филтрира по deleted_at (виж selectItemByIdStatement
    // коментара) — тук explicit различаваме "не съществува изобщо" от "вече
    // logically deleted", за да върнем ясен idempotent outcome, не грешка.
    const existingRow = selectItemByIdStatement.get(normalizedId) as
      | (GiftItemRow & { deleted_at: string | null })
      | undefined

    if (existingRow === undefined) {
      return { ok: false, message: 'Подаръкът не беше намерен.' }
    }

    if (existingRow.deleted_at !== null) {
      // Idempotent double-click — вече е tombstone. Success (не грешка),
      // items списъкът вече не го съдържа (изключен от listAdminGiftItems).
      return {
        ok: true,
        items: listAdminGiftItems(),
        deletedImageUrl: existingRow.image_url,
        outcome: 'already-deleted',
      }
    }

    // Logical delete — ВИНАГИ позволен, независимо от transaction history
    // (заданието: "Admin трябва да може да изтрие подарък независимо дали е
    // бил изпращан"). Старото "RESTRICT ако >0 transactions" правило е
    // премахнато изцяло — реален DELETE вече не се опитва тук.
    softDeleteItemStatement.run(normalizedId)

    return {
      ok: true,
      items: listAdminGiftItems(),
      deletedImageUrl: existingRow.image_url,
      outcome: 'deleted',
    }
  }

  // Catalog/reference semantics (§10 от брифа, image replace логиката) —
  // само НЕ-изтрити catalog redове. Виж isImageUrlRetentionReferenced за
  // physical-retention (delete finalize) semantics — умишлено разделени
  // concept-и, различен въпрос ("има ли жив catalog ред" vs. "трябва ли
  // файлът физически да остане").
  function isImageUrlReferenced(imageUrl: string): boolean {
    const normalizedUrl = imageUrl.trim()

    if (normalizedUrl.length === 0) {
      return false
    }

    return (countLiveGiftItemsByImageUrlStatement.get(normalizedUrl) as { cnt: number }).cnt > 0
  }

  // Physical-retention semantics (§4 брифа) — файлът остава, докато (a) жив
  // catalog ред го реферира, ИЛИ (b) поне един pending (shown_at IS NULL)
  // delivery log ред все още го цитира. Table gift runtime references са
  // orthogonal in-memory state, проверени отделно в index.ts
  // (tryFinalizeDeletedGiftImage) — store-ът няма достъп до serverState.rooms.
  function isImageUrlRetentionReferenced(imageUrl: string): boolean {
    const normalizedUrl = imageUrl.trim()

    if (normalizedUrl.length === 0) {
      return false
    }

    if ((countLiveGiftItemsByImageUrlStatement.get(normalizedUrl) as { cnt: number }).cnt > 0) {
      return true
    }

    return (countUnseenDeliveryByImageUrlStatement.get(normalizedUrl) as { cnt: number }).cnt > 0
  }

  function listDeletedGiftItemImageUrls(): string[] {
    const rows = selectDeletedGiftItemImageUrlsStatement.all() as Array<{ image_url: string }>
    return rows.map((r) => r.image_url)
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
          isReplay: true,
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

      // 5-6. gift item съществува, активен е, НЕ е logically deleted, цената
      // се чете от DB в реално време. isDeletedGiftItemById explicit, защото
      // getItemById вече "вижда" tombstone redове (не ги филтрира) — deleted
      // gift никога не може да бъде купен наново, независимо от is_active.
      const giftItem = getItemById(giftItemId)

      if (giftItem === null || !giftItem.isActive || isDeletedGiftItemById(giftItemId)) {
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
        isReplay: false,
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

  // §7B от брифа — caller-ът (index.ts route) трябва да знае imageUrl-а на
  // markнатия ред, за да опита finalize cleanup СЛЕД mark-shown (проверява
  // дали е бил последният pending unseen delivery за тоя URL).
  function markDeliveryShown(transactionId: string, profileId: ProfileId): string | null {
    const row = selectDeliveryImageUrlStatement.get(transactionId, profileId) as
      | { image_url: string }
      | undefined
    markDeliveryShownStatement.run(transactionId, profileId)
    return row?.image_url ?? null
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
    isImageUrlRetentionReferenced,
    listDeletedGiftItemImageUrls,
    sendGiftItem,
    createDeliveryNotification,
    getPendingDeliveries,
    markDeliveryShown,
    close,
  }
}

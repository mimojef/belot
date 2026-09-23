/**
 * paidGiftNotificationStore.ts
 *
 * "Подари авоари" (Paid Gift Shop) — READ/ACK страна на
 * paid_gift_notification_log (20260923_003 migration). WRITE страната
 * (INSERT) е inline във всеки от трите purchase store-а
 * (coin/vip/bundlePurchaseStore.ts fulfillByInternalRow), ВЪТРЕ в
 * fulfillment транзакцията им (durable-first invariant, Round 3 §5) — този
 * store НЕ пише в таблицата, само чете/ACK-ва. Собствена DatabaseSync
 * connection към СЪЩИЯ физически файл (WAL mode, established pattern —
 * mirror на vip_grants/vip_status: shared schema, множество connections).
 *
 * Reuse-ва established bootstrap-fetch + ACK-ownership pattern от
 * yellowCoinGiftStore.ts (gift_notification_log)/giftItemStore.ts
 * (gift_item_delivery_log) — getPendingPaidGiftNotifications (WS connect/
 * reconnect bootstrap) + acknowledgePaidGiftNotification (ownership-scoped
 * idempotent ACK, WHERE recipient_profile_id=? гарантира profile A не може
 * да ACK-не notification на profile B чрез подаден произволен id).
 */

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type PendingPaidGiftNotification = {
  purchaseId: string
  purchaseType: 'coin' | 'vip' | 'bundle'
  bodyText: string
}

export type PaidGiftNotificationStore = {
  /** Bootstrap fetch (WS connect/reconnect) — unread-only, FIFO ред (mirror на established selectPendingGiftNotificationsStatement/selectPendingDeliveriesStatement). */
  getPendingNotifications: (recipientProfileId: string) => PendingPaidGiftNotification[]
  /**
   * Ownership-scoped, idempotent ACK — WHERE (purchase_id, purchase_type,
   * recipient_profile_id) гарантира caller-ят може да ACK-не САМО собствени
   * notifications; несъществуващ/чужд id е тих no-op (changes=0), НЕ грешка
   * (established pattern, mirror на giftItemStore.markDeliveryShown).
   * Повторен ACK на вече-ACK-нат ред е no-op (UPDATE presence guard),
   * идемпотентно by construction.
   */
  acknowledgeNotification: (
    purchaseId: string,
    purchaseType: 'coin' | 'vip' | 'bundle',
    recipientProfileId: string,
  ) => void
  close: () => void
}

export async function createPaidGiftNotificationStore(
  databaseFilePath: string,
): Promise<PaidGiftNotificationStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  // ORDER BY created_at ASC, rowid ASC — mirror на established
  // gift_item_delivery_log коментара: secondна прецизност timestamp-и могат
  // да съвпаднат за бързи последователни gift-ове, rowid tie-break дава
  // deterministic insertion-order fallback.
  const selectPendingStatement = database.prepare(`
    SELECT purchase_id, purchase_type, body_text
    FROM paid_gift_notification_log
    WHERE recipient_profile_id = ? AND read_at IS NULL
    ORDER BY created_at ASC, rowid ASC;
  `)

  const acknowledgeStatement = database.prepare(`
    UPDATE paid_gift_notification_log
    SET read_at = CURRENT_TIMESTAMP
    WHERE purchase_id = ? AND purchase_type = ? AND recipient_profile_id = ? AND read_at IS NULL;
  `)

  function getPendingNotifications(recipientProfileId: string): PendingPaidGiftNotification[] {
    const rows = selectPendingStatement.all(recipientProfileId) as Array<{
      purchase_id: string
      purchase_type: 'coin' | 'vip' | 'bundle'
      body_text: string
    }>

    return rows.map((r) => ({
      purchaseId: r.purchase_id,
      purchaseType: r.purchase_type,
      bodyText: r.body_text,
    }))
  }

  function acknowledgeNotification(
    purchaseId: string,
    purchaseType: 'coin' | 'vip' | 'bundle',
    recipientProfileId: string,
  ): void {
    acknowledgeStatement.run(purchaseId, purchaseType, recipientProfileId)
  }

  function close(): void {
    database.close()
  }

  return {
    getPendingNotifications,
    acknowledgeNotification,
    close,
  }
}

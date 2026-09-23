/**
 * paidGiftNotificationText.ts
 *
 * "Подари авоари" (Paid Gift Shop) — server-composed текст за durable
 * recipient notification body_text (paid_gift_notification_log) И payer
 * success popup (не се персистира, връща се директно в fulfillPaidPurchase
 * резултата). ЕДНО място за текстовата логика на трите продукта (coin/VIP/
 * bundle) — reuse-вано от coinPurchaseStore.ts/vipPurchaseStore.ts/
 * bundlePurchaseStore.ts, за да не се дублира pluralization/formatting
 * логика три пъти. bg-BG toLocaleString mirror на established
 * yellowCoinGiftStore.ts formatBgNumber private helper (established
 * thousands separator, non-breaking space).
 *
 * Текстовете тук стават IMMUTABLE SNAPSHOT в момента на извикване —
 * caller-ите (fulfillByInternalRow в трите store-а) ги композират ОТ
 * ledger row snapshot полетата (title_snapshot/yellow_coins_amount/
 * days_snapshot/vip_days_snapshot), НИКОГА от текущия Shop каталог — Admin
 * може да е редактирал продукта между checkout и fulfillment (review Round
 * 3 §3/§13 explicit изискване).
 */

export function formatBgThousands(value: number): string {
  return value.toLocaleString('bg-BG')
}

export function formatVipDaysLabel(days: number): string {
  const word = days === 1 ? 'ден' : 'дни'
  return `${formatBgThousands(days)} ${word} VIP`
}

export function formatCoinsLabel(coins: number): string {
  return `${formatBgThousands(coins)} жълтици`
}

/**
 * Payer success popup текст (§3 в брифа) — "Вие успешно подарихте на
 * <recipient> <reward>."
 */
export function composePayerCoinGiftSuccessText(recipientDisplayName: string, coins: number): string {
  return `Вие успешно подарихте на ${recipientDisplayName} ${formatCoinsLabel(coins)}.`
}

export function composePayerVipGiftSuccessText(recipientDisplayName: string, days: number): string {
  return `Вие успешно подарихте на ${recipientDisplayName} ${formatVipDaysLabel(days)}.`
}

export function composePayerBundleGiftSuccessText(
  recipientDisplayName: string,
  packageTitle: string,
  coins: number,
  days: number,
): string {
  return `Вие успешно подарихте на ${recipientDisplayName}:\n${packageTitle} — ${formatCoinsLabel(coins)} + ${formatVipDaysLabel(days)}.`
}

/**
 * Recipient durable notification текст (§4 в брифа) — "<PAYER> ви подари
 * <reward>." Цена НИКОГА не се включва тук (§15 explicit: "recipient не
 * трябва да вижда колко е платил sender-ът").
 */
export function composeRecipientCoinGiftNotificationText(senderDisplayName: string, coins: number): string {
  return `${senderDisplayName} ви подари ${formatCoinsLabel(coins)}.`
}

export function composeRecipientVipGiftNotificationText(senderDisplayName: string, days: number): string {
  return `${senderDisplayName} ви подари ${formatVipDaysLabel(days)}.`
}

export function composeRecipientBundleGiftNotificationText(
  senderDisplayName: string,
  packageTitle: string,
  coins: number,
  days: number,
): string {
  return `${senderDisplayName} ви подари:\n${packageTitle} — ${formatCoinsLabel(coins)} + ${formatVipDaysLabel(days)}.`
}

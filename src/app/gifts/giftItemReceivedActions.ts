// "Подари и ти" — общи бутони ("OK" + "Подари и ти") за received-gift
// UI-ите: lobby модала (offline опашка, renderLobbyScreen.ts), live push
// popup-а (main.ts::showGiftItemReceivedPopup) и in-game top банера
// (createLobbyFlowController.ts::showGiftItemReceivedBanner). "Подари и ти"
// НЕ е отделна система — само отваря съществуващ gift picker (lobby
// openGiftItemModal извън игра, createGiftPickerModal по време на игра) с
// recipient = подателя, идентифициран по стабилния fromProfileId (никога по
// display name). Изпращането винаги минава през POST
// /api/profile/:id/send-gift-item (giftItemStore.sendGiftItem).

// In-game "Подари и ти" picker (createGiftPickerModal, document.body) — общ
// слой за Белот и Ludo: над масата/HUD-а/анимациите (Belot ≤ 9401, collect
// overlay 9000; Ludo effects ≤ 9_100), но ПОД игровите модали — Belot
// declaration prompt/reaction pickers (9999), bot takeover (10000), leave
// warning (11000) и Ludo modal layer (10_000) — така игров модал, появил се
// докато picker-ът е отворен, остава видим и достъпен.
export const GIFT_BACK_IN_GAME_PICKER_Z_INDEX = 9_997

export type GiftItemReceivedEntry = {
  transactionId: string
  itemName: string
  imageUrl: string
  fromDisplayName: string
  /** Стабилен sender profile_id; null → "Подари и ти" не се показва. */
  fromProfileId: string | null
}

export type GiftBackResolution =
  | { status: 'opened' }
  | { status: 'busy' }
  | { status: 'error'; message: string }

export function canOfferGiftBack(
  fromProfileId: string | null | undefined,
  ownProfileId: string | null | undefined,
): fromProfileId is string {
  return typeof fromProfileId === 'string'
    && fromProfileId.length > 0
    && fromProfileId !== (ownProfileId ?? null)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buttonBaseStyle(compact: boolean): string {
  return [
    `flex:1 1 ${compact ? 130 : 150}px`,
    'min-width:0',
    `height:${compact ? 36 : 44}px`,
    'border-radius:8px',
    `font-size:${compact ? 14 : 15}px`,
    'font-weight:900',
    'cursor:pointer',
    'font-family:inherit',
    'white-space:nowrap',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'box-sizing:border-box',
  ].join(';')
}

// flex-wrap: на много тесен popup бутоните падат един под друг, вместо да
// излизат извън него; иначе стоят един до друг с равна ширина.
export function renderGiftItemReceivedActionsHtml(options: {
  okAttribute: string
  giftBackAttribute: string
  showGiftBack: boolean
  isGiftBackPending?: boolean
  errorText?: string | null
  /** Компактен вариант (36px) за in-game top банера. */
  compact?: boolean
}): string {
  const baseStyle = buttonBaseStyle(options.compact === true)
  const okButton = `<button type="button" ${options.okAttribute}="1" style="${baseStyle};border:0;padding:0 12px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;">OK</button>`
  const giftBackButton = options.showGiftBack
    ? `<button type="button" ${options.giftBackAttribute}="1" ${options.isGiftBackPending ? 'disabled aria-busy="true"' : ''} style="${baseStyle};border:2px solid rgba(244,201,91,0.85);padding:0 12px;background:rgba(244,201,91,0.08);color:#f4c95b;${options.isGiftBackPending ? 'opacity:0.6;cursor:default;' : ''}">${options.isGiftBackPending ? 'Зареждане…' : 'Подари и ти'}</button>`
    : ''
  const errorHtml = options.errorText
    ? `<div data-gift-item-received-error="1" style="width:100%;border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;box-sizing:border-box;">${escapeHtml(options.errorText)}</div>`
    : ''

  return `
    ${errorHtml}
    <div data-gift-item-received-actions="1" style="display:flex;flex-wrap:wrap;gap:${options.compact ? 8 : 10}px;width:100%;">
      ${okButton}
      ${giftBackButton}
    </div>
  `
}

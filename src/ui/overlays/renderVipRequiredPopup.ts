// VIP-required popup за "Теми" composer (Етап 2). Отваря се при tap върху
// composer-а от Non-VIP регистриран потребител. Композицията следва
// конвенцията на renderPlayerProfilePopup.ts (inline стилове, escapeHtml,
// data-* атрибути за wiring в renderLobbyScreen.ts).
//
// Три състояния:
//   A) Статусът все още не е зареден (isVipGateLoaded=false) -> "Зареждане..."
//   B) hasClaimedLaunchGift===false && launchGiftDays>0 -> "Вземи X дни
//      безплатно" (X е server-side admin-configurable стойност, виж
//      adminSettingsStore.ts freeTopicsVipDays)
//   C) hasClaimedLaunchGift===true ИЛИ launchGiftDays===0 -> само "Вземи VIP",
//      отваря Shop -> VIP tab директно (виж openVipShopFromTopicsPopup в
//      createLobbyFlowController.ts) — БЕЗ inert "ще бъдат налични скоро"
//      съобщение, магазинът вече работи.

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export type VipRequiredPopupState = {
  open: boolean
  /** null = VIP gate статусът все още не е зареден — показваме кратко "Зареждане...". */
  hasClaimedLaunchGift: boolean | null
  /** null = все още не е зареден. 0 = безплатният подарък е изключен от admin настройка (виж freeTopicsVipDays). */
  launchGiftDays: number | null
  claimSubmitting: boolean
  claimErrorText: string | null
}

export function renderVipRequiredPopup(state: VipRequiredPopupState): string {
  if (!state.open) return ''

  const isLoaded = state.hasClaimedLaunchGift !== null && state.launchGiftDays !== null
  const giftAvailable = isLoaded && state.hasClaimedLaunchGift === false && (state.launchGiftDays as number) > 0

  const body = !isLoaded
    ? `<div style="padding:24px 0;text-align:center;color:rgba(248,250,252,0.5);font-size:14px;">Зареждане...</div>`
    : giftAvailable
      ? `
        <p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#f8fafc;font-weight:700;">Писането в „Теми“ е достъпно само за VIP.</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.72);">Pika.bg ви подарява ${state.launchGiftDays} дни безплатен VIP.</p>
        <button
          type="button"
          data-topics-vip-popup-claim="1"
          ${state.claimSubmitting ? 'disabled' : ''}
          style="
            width:100%;padding:12px 16px;border:0;border-radius:10px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;font-size:15px;font-weight:900;cursor:pointer;
            opacity:${state.claimSubmitting ? '0.6' : '1'};
          "
        >${state.claimSubmitting ? 'Изчакай...' : `Вземи ${state.launchGiftDays} дни безплатно`}</button>
        <p style="margin:10px 0 0;font-size:12px;color:rgba(248,250,252,0.42);text-align:center;">Подаръкът е еднократен за профил.</p>
        ${state.claimErrorText ? `<p style="margin:12px 0 0;font-size:13px;color:#f87171;text-align:center;">${escapeHtml(state.claimErrorText)}</p>` : ''}
      `
      : `
        <p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#f8fafc;font-weight:700;">Писането в „Теми“ изисква активен VIP.</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.72);">${state.hasClaimedLaunchGift ? 'Безплатният подарък вече е използван за този профил.' : 'Разгледай VIP офертите в магазина.'}</p>
        <button
          type="button"
          data-topics-vip-popup-go-to-shop="1"
          style="
            width:100%;padding:12px 16px;border:0;border-radius:10px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;font-size:15px;font-weight:900;cursor:pointer;
          "
        >Вземи VIP</button>
        ${state.claimErrorText ? `<p style="margin:12px 0 0;font-size:13px;color:#f87171;text-align:center;">${escapeHtml(state.claimErrorText)}</p>` : ''}
      `

  return `
    <div data-topics-vip-popup-backdrop="1" style="
      position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;padding:16px;
    ">
      <div data-topics-vip-popup-card="1" style="
        width:100%;max-width:360px;box-sizing:border-box;
        background:#141414;border:1px solid rgba(212,165,32,0.24);border-radius:16px;
        padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.5);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <span style="font-size:13px;font-weight:900;letter-spacing:0.04em;color:#d4a520;text-transform:uppercase;">VIP</span>
          <button
            type="button"
            data-topics-vip-popup-close="1"
            aria-label="Затвори"
            style="border:0;background:transparent;color:rgba(248,250,252,0.6);font-size:20px;line-height:1;cursor:pointer;padding:4px;"
          >&times;</button>
        </div>
        ${body}
      </div>
    </div>
  `
}

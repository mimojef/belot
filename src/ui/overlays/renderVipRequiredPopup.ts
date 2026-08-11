// VIP-required popup за "Теми" composer (Етап 2) — отваря се при tap върху
// composer-а от Non-VIP регистриран потребител. Композицията следва
// конвенцията на renderPlayerProfilePopup.ts (inline стилове, escapeHtml,
// data-* атрибути за wiring в renderLobbyScreen.ts).
//
// Три състояния:
//   1) Никога не е claim-вал launch gift -> "Вземи 30 дни безплатно"
//   2) Claim-нал е, но VIP е изтекъл -> "Виж VIP плановете" (inert, Етап 2
//      корекция т.5 — само кратко съобщение "ще бъдат налични скоро", БЕЗ
//      Stripe/checkout/навигация)
//   3) claimSubmitting/claimErrorText управляват inline feedback по време на
//      claim заявката.

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
  claimSubmitting: boolean
  claimErrorText: string | null
  seePlansMessageVisible: boolean
}

export function renderVipRequiredPopup(state: VipRequiredPopupState): string {
  if (!state.open) return ''

  const body = state.hasClaimedLaunchGift === null
    ? `<div style="padding:24px 0;text-align:center;color:rgba(248,250,252,0.5);font-size:14px;">Зареждане...</div>`
    : !state.hasClaimedLaunchGift
      ? `
        <p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#f8fafc;font-weight:700;">Писането в „Теми“ е достъпно само за VIP.</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.72);">Pika.bg ви подарява 30 дни безплатен VIP.</p>
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
        >${state.claimSubmitting ? 'Изчакай...' : 'Вземи 30 дни безплатно'}</button>
        <p style="margin:10px 0 0;font-size:12px;color:rgba(248,250,252,0.42);text-align:center;">Подаръкът е еднократен за профил.</p>
        ${state.claimErrorText ? `<p style="margin:12px 0 0;font-size:13px;color:#f87171;text-align:center;">${escapeHtml(state.claimErrorText)}</p>` : ''}
      `
      : `
        <p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#f8fafc;font-weight:700;">Писането в „Теми“ изисква активен VIP.</p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.72);">Безплатният подарък вече е използван за този профил.</p>
        <button
          type="button"
          data-topics-vip-popup-see-plans="1"
          style="
            width:100%;padding:12px 16px;border:1px solid rgba(212,165,32,0.4);border-radius:10px;
            background:rgba(212,165,32,0.08);color:#d4a520;font-size:15px;font-weight:900;cursor:pointer;
          "
        >Виж VIP плановете</button>
        ${state.seePlansMessageVisible ? `<p style="margin:12px 0 0;font-size:13px;color:rgba(248,250,252,0.72);text-align:center;">VIP плановете ще бъдат налични скоро.</p>` : ''}
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

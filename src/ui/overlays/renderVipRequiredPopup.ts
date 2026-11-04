// VIP-required popup — общ, reusable компонент (първоначално само за "Теми"
// composer, Етап 2; от Phase 3A го ползва и Belot Spectator "Гледай" flow-а).
// Отваря се при tap/click от Non-VIP регистриран потребител. Композицията
// следва конвенцията на renderPlayerProfilePopup.ts (inline стилове,
// escapeHtml, data-* атрибути за wiring в renderLobbyScreen.ts).
//
// `namespace` генерира data-${namespace}-vip-popup-* атрибутите — всеки
// caller (Topics, Belot spectator, ...) wire-ва собствен independent popup
// instance, без DOM collision, дори ако theoretically и двата биха били в
// markup-а едновременно. `featureLabel` е subject-ът на двете заглавни
// изречения ("${featureLabel} е достъпно само за VIP." / "${featureLabel}
// изисква активен VIP.") — единствената content разлика между caller-и.
//
// Три състояния:
//   A) Статусът все още не е зареден (isVipGateLoaded=false) -> "Зареждане..."
//   B) hasClaimedLaunchGift===false && launchGiftDays>0 -> "Вземи X дни
//      безплатно" (X е server-side admin-configurable стойност, виж
//      adminSettingsStore.ts freeTopicsVipDays)
//   C) hasClaimedLaunchGift===true ИЛИ launchGiftDays===0 -> само "Вземи VIP",
//      отваря Shop -> VIP tab директно (виж openVipShopFromTopicsPopup /
//      openVipShopFromBelotSpectatorPopup в createLobbyFlowController.ts) —
//      БЕЗ inert "ще бъдат налични скоро" съобщение, магазинът вече работи.

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
  /** Drives data-${namespace}-vip-popup-* attribute names — виж file header. */
  namespace: string
  /** Subject на "${featureLabel} е достъпно само за VIP." / "... изисква активен VIP." */
  featureLabel: string
  /** null = VIP gate статусът все още не е зареден — показваме кратко "Зареждане...". */
  hasClaimedLaunchGift: boolean | null
  /** null = все още не е зареден. 0 = безплатният подарък е изключен от admin настройка (виж freeTopicsVipDays). */
  launchGiftDays: number | null
  claimSubmitting: boolean
  claimErrorText: string | null
  /** Светъл мобилен вариант (само визия — същите състояния, текстове и data-* атрибути). */
  light?: boolean
}

// Lucide "crown" — до заглавието "VIP" в светлия вариант.
const VIP_POPUP_CROWN_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z"/><path d="M5 21h14"/></svg>'
const VIP_POPUP_CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

export function renderVipRequiredPopup(state: VipRequiredPopupState): string {
  if (!state.open) return ''

  const ns = state.namespace
  const isLoaded = state.hasClaimedLaunchGift !== null && state.launchGiftDays !== null
  const giftAvailable = isLoaded && state.hasClaimedLaunchGift === false && (state.launchGiftDays as number) > 0
  const light = state.light === true
  // Цветове/размери на двата варианта — тъмният е досегашният 1:1.
  const t = light
    ? {
        loading: '#667085',
        title: 'margin:0 0 6px;font-size:16px;line-height:1.45;color:#17233C;font-weight:800;',
        text: 'margin:0 0 16px;font-size:14px;line-height:1.5;color:#667085;',
        button: 'width:100%;min-height:48px;padding:12px 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#F7D774 0%,#E0A526 100%);color:#17233C;font-family:inherit;font-size:16px;font-weight:800;cursor:pointer;',
        note: 'margin:10px 0 0;font-size:12px;color:#667085;text-align:center;',
        error: 'margin:12px 0 0;font-size:13px;color:#B42318;text-align:center;',
      }
    : {
        loading: 'rgba(248,250,252,0.5)',
        title: 'margin:0 0 4px;font-size:15px;line-height:1.5;color:#f8fafc;font-weight:700;',
        text: 'margin:0 0 16px;font-size:14px;line-height:1.5;color:rgba(248,250,252,0.72);',
        button: 'width:100%;padding:12px 16px;border:0;border-radius:10px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;',
        note: 'margin:10px 0 0;font-size:12px;color:rgba(248,250,252,0.42);text-align:center;',
        error: 'margin:12px 0 0;font-size:13px;color:#f87171;text-align:center;',
      }

  const body = !isLoaded
    ? `<div style="padding:24px 0;text-align:center;color:${t.loading};font-size:14px;">Зареждане...</div>`
    : giftAvailable
      ? `
        <p style="${t.title}">${escapeHtml(state.featureLabel)} е достъпно само за VIP.</p>
        <p style="${t.text}">Pika.bg ви подарява ${state.launchGiftDays} дни безплатен VIP.</p>
        <button
          type="button"
          data-${ns}-vip-popup-claim="1"
          ${state.claimSubmitting ? 'disabled' : ''}
          style="${t.button}opacity:${state.claimSubmitting ? '0.6' : '1'};"
        >${state.claimSubmitting ? 'Изчакай...' : `Вземи ${state.launchGiftDays} дни безплатно`}</button>
        <p style="${t.note}">Подаръкът е еднократен за профил.</p>
        ${state.claimErrorText ? `<p style="${t.error}">${escapeHtml(state.claimErrorText)}</p>` : ''}
      `
      : `
        <p style="${t.title}">${escapeHtml(state.featureLabel)} изисква активен VIP.</p>
        <p style="${t.text}">${state.hasClaimedLaunchGift ? 'Безплатният подарък вече е използван за този профил.' : 'Разгледай VIP офертите в магазина.'}</p>
        <button
          type="button"
          data-${ns}-vip-popup-go-to-shop="1"
          style="${t.button}"
        >Вземи VIP</button>
        ${state.claimErrorText ? `<p style="${t.error}">${escapeHtml(state.claimErrorText)}</p>` : ''}
      `

  if (light) {
    return `
      <div data-${ns}-vip-popup-backdrop="1" style="
        position:fixed;inset:0;z-index:1200;background:rgba(16,24,40,0.55);
        display:flex;align-items:center;justify-content:center;padding:16px;
        font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
      ">
        <div data-${ns}-vip-popup-card="1" style="
          width:100%;max-width:360px;box-sizing:border-box;
          background:#FFFFFF;border-radius:12px;
          padding:16px 18px 20px;box-shadow:0 20px 48px rgba(16,24,40,0.22);
        ">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
            <span style="display:inline-flex;align-items:center;gap:6px;font-size:14px;font-weight:800;letter-spacing:0.04em;color:#B7791F;">${VIP_POPUP_CROWN_ICON}VIP</span>
            <button
              type="button"
              data-${ns}-vip-popup-close="1"
              aria-label="Затвори"
              style="width:40px;height:40px;flex:0 0 auto;border:0;border-radius:8px;background:#F2F4F7;color:#475467;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer;"
            >${VIP_POPUP_CLOSE_ICON}</button>
          </div>
          ${body}
        </div>
      </div>
    `
  }

  return `
    <div data-${ns}-vip-popup-backdrop="1" style="
      position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,0.6);
      display:flex;align-items:center;justify-content:center;padding:16px;
    ">
      <div data-${ns}-vip-popup-card="1" style="
        width:100%;max-width:360px;box-sizing:border-box;
        background:#141414;border:1px solid rgba(212,165,32,0.24);border-radius:16px;
        padding:22px 20px;box-shadow:0 20px 60px rgba(0,0,0,0.5);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
          <span style="font-size:13px;font-weight:900;letter-spacing:0.04em;color:#d4a520;text-transform:uppercase;">VIP</span>
          <button
            type="button"
            data-${ns}-vip-popup-close="1"
            aria-label="Затвори"
            style="border:0;background:transparent;color:rgba(248,250,252,0.6);font-size:20px;line-height:1;cursor:pointer;padding:4px;"
          >&times;</button>
        </div>
        ${body}
      </div>
    </div>
  `
}

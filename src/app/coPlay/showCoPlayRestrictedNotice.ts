// „Забрана за съвместна игра“ (Етап 5) — информационен прозорец при машинния
// код 'co_play_restricted' от сървъра (случайна маса, частна маса, турнир,
// повторен мач). Сървърът е единственият източник на истината: прозорецът
// само визуализира отказа/известието. Никога не показва ника на другия играч
// и административната причина — текстът идва от сървъра (без имена), а при
// липсващ текст се ползва общият текст за контекста.
//
// Монтира се в document.body (по шаблона на protectedStaffBlockNotice) над
// lobby / турнирните / in-game popup-и (до 99998 и 9500–9600), но под
// системните session/reclaim overlay-и (200000+). Едно копие наведнъж — ново
// известие замества предишното (без натрупване при повторни съобщения).
//
// Две теми, избрани в момента на показване:
//   * desktop — тъмно-златният прозорец (непроменен);
//   * mobile  — светлият мобилен дизайн (бяла карта, тъмен текст, виолетовият
//     3D бутон .lobby-violet-btn.violet-3d-btn). Мобилният интерфейс се
//     разпознава със съществуващите механизми: getMobileLightUiContext()
//     (светлата рамка на лобито / светлата чакалня на частна маса) или
//     мобилните екрани на случайната чакалня и на масата (data-mobile-layout,
//     само при isPhoneLayoutViewport()). Desktop интерфейсът на телефон
//     остава тъмен.

import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'
import { getMobileLightUiContext, MOBILE_LIGHT_FONT_FAMILY } from '../../ui/layout/mobileLightUi'
import { VIOLET_3D_BUTTON_CLASS } from '../../ui/layout/violet3dButton'

export const CO_PLAY_RESTRICTED_CODE = 'co_play_restricted'

export const CO_PLAY_RESTRICTED_TITLE = 'Административно ограничение'

export const CO_PLAY_RESTRICTED_TEXTS = {
  matchmaking: 'В тази чакалня има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.',
  private_room: 'На тази маса има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.',
  tournament: 'В този турнир има играч, с когото нямате право да участвате поради наложено административно наказание.',
  replay: 'Не можете да участвате в повторен мач с играч, спрямо когото имате наложено административно ограничение.',
} as const

export type CoPlayRestrictedContext = keyof typeof CO_PLAY_RESTRICTED_TEXTS

export type CoPlayRestrictedNoticeTheme = 'desktop' | 'mobile'

const HOST_ATTRIBUTE = 'data-co-play-restricted-notice'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Текстът за показване: сървърният (без имена), иначе общият за контекста. */
export function resolveCoPlayRestrictedText(serverMessage: string | null | undefined, context: CoPlayRestrictedContext): string {
  const trimmed = typeof serverMessage === 'string' ? serverMessage.trim() : ''
  return trimmed !== '' ? trimmed : CO_PLAY_RESTRICTED_TEXTS[context]
}

/** Активният интерфейс в момента на показване (виж коментара горе). */
export function resolveCoPlayRestrictedNoticeTheme(): CoPlayRestrictedNoticeTheme {
  if (getMobileLightUiContext() !== null) return 'mobile'
  if (isPhoneLayoutViewport() && document.querySelector('[data-mobile-layout="1"]') !== null) return 'mobile'
  return 'desktop'
}

function renderDesktopCard(text: string, title: string): string {
  return `
    <div
      data-co-play-restricted-notice-backdrop="1"
      style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"
    ></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:none;overflow-y:auto;">
      <div style="
        position:relative;
        pointer-events:auto;
        width:min(100%,440px);
        box-sizing:border-box;
        border-radius:8px;
        background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
        border:2px solid rgba(212,165,32,0.72);
        box-shadow:0 34px 80px rgba(0,0,0,0.42);
        padding:24px 22px 22px;
        text-align:center;
      ">
        <div aria-hidden="true" style="font-size:34px;line-height:1;margin-bottom:12px;">🛡️</div>
        <div
          id="co-play-restricted-notice-title"
          data-co-play-restricted-notice-title="1"
          style="font-size:19px;font-weight:900;color:#f4c95b;line-height:1.3;margin-bottom:12px;"
        >${escapeHtml(title)}</div>
        <div
          data-co-play-restricted-notice-text="1"
          style="font-size:15px;font-weight:700;color:#f8fafc;line-height:1.55;margin-bottom:22px;"
        >${escapeHtml(text)}</div>
        <button
          type="button"
          data-co-play-restricted-notice-ok="1"
          style="
            min-height:44px;min-width:140px;padding:0 24px;
            border:1px solid rgba(212,165,32,0.55);border-radius:8px;
            background:linear-gradient(180deg,rgba(244,201,91,0.96) 0%,rgba(201,143,19,0.96) 100%);
            color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;
          "
        >Разбрах</button>
      </div>
    </div>
  `
}

// Светлият мобилен вид — стойностите на светлите попъпи (бяла карта, рамка
// #E4E7EC, сянка, тъмен текст #17233C / #475467, виолетовият 3D бутон).
// Текстовете и data-* атрибутите са същите като при desktop.
function renderMobileCard(text: string, title: string): string {
  return `
    <div
      data-co-play-restricted-notice-backdrop="1"
      style="position:absolute;inset:0;background:rgba(16,24,40,0.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);"
    ></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;pointer-events:none;overflow-y:auto;">
      <div style="
        position:relative;
        pointer-events:auto;
        width:min(100%,400px);
        box-sizing:border-box;
        max-height:calc(100dvh - 32px);
        overflow-y:auto;
        overscroll-behavior:contain;
        border-radius:16px;
        border:1px solid #E4E7EC;
        background:#FFFFFF;
        box-shadow:0 20px 48px rgba(16,24,40,0.18);
        padding:24px 20px 20px;
        text-align:center;
      ">
        <div aria-hidden="true" style="width:60px;height:60px;margin:0 auto 14px;border-radius:999px;background:#F4F0FF;border:1px solid #D9CCFF;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;">🛡️</div>
        <div
          id="co-play-restricted-notice-title"
          data-co-play-restricted-notice-title="1"
          style="font-size:20px;font-weight:800;color:#17233C;line-height:1.3;margin-bottom:10px;"
        >${escapeHtml(title)}</div>
        <div
          data-co-play-restricted-notice-text="1"
          style="font-size:15px;font-weight:600;color:#475467;line-height:1.5;margin-bottom:20px;overflow-wrap:anywhere;"
        >${escapeHtml(text)}</div>
        <button
          type="button"
          class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}"
          data-co-play-restricted-notice-ok="1"
          style="width:100%;height:46px;padding:0 24px;border:0;border-radius:8px;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:900;cursor:pointer;"
        >Разбрах</button>
      </div>
    </div>
  `
}

export function closeCoPlayRestrictedNotice(): void {
  document.querySelectorAll(`[${HOST_ATTRIBUTE}="1"]`).forEach((element) => element.remove())
}

/** title — по подразбиране „Административно ограничение“; друг текст само за не-административни откази (напр. задържано изплащане). */
export function showCoPlayRestrictedNotice(serverMessage: string | null | undefined, context: CoPlayRestrictedContext, title: string = CO_PLAY_RESTRICTED_TITLE): void {
  closeCoPlayRestrictedNotice()
  const text = resolveCoPlayRestrictedText(serverMessage, context)
  const theme = resolveCoPlayRestrictedNoticeTheme()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '1')
  host.setAttribute('data-co-play-restricted-context', context)
  host.setAttribute('data-co-play-restricted-theme', theme)
  host.setAttribute('role', 'alertdialog')
  host.setAttribute('aria-modal', 'true')
  host.setAttribute('aria-labelledby', 'co-play-restricted-notice-title')
  host.style.cssText = `position:fixed;inset:0;z-index:100001;pointer-events:auto;font-family:${theme === 'mobile' ? MOBILE_LIGHT_FONT_FAMILY : 'Arial,Helvetica,sans-serif'};`
  host.innerHTML = theme === 'mobile' ? renderMobileCard(text, title) : renderDesktopCard(text, title)

  const close = (): void => {
    host.remove()
  }
  host.querySelector('[data-co-play-restricted-notice-ok="1"]')?.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
  })
  // Не позволяваме кликове вътре в прозореца да стигнат до document-level
  // "click outside" handler-и на popup-ите под него. Затваря се само с „Разбрах“.
  host.addEventListener('click', (event) => event.stopPropagation())

  document.body.appendChild(host)
  host.querySelector<HTMLButtonElement>('[data-co-play-restricted-notice-ok="1"]')?.focus()
}

// Самостоятелен, self-mounted cookie consent banner + настройки modal.
// Монтира се веднъж директно в document.body (извън #app), за да не бъде
// изтриван от re-render цикъла на лобито/активната игра и да работи еднакво
// на всеки екран (начална страница, lobby, login/register, guest flow,
// правни страници, активна игра).
//
// Banner-ът е компактна карта, центрирана долу (bottom-center), с margin от
// левия/десния ръб — не e edge-to-edge sticky bar. Seat панелите в активна
// игра са закотвени по центъра на всеки ръб на viewport-а (виж
// cuttingSeatLayout.ts: top/bottom: 5px + left:50%, left/right: 5px +
// top:50%), така че при активна игра без направен избор banner-ът остава
// нисък и компактен, за да минимизира евентуално припокриване с долния seat
// панел — при съмнение направи ръчна визуална проверка на активния геймплей.

import {
  acceptAllConsent,
  getConsent,
  hasRecordedChoice,
  saveConsentChoice,
  subscribeToConsentChanges,
} from './consentState'

const ROOT_ID = 'pika-consent-root'
const BANNER_Z_INDEX = 4000
const MODAL_Z_INDEX = 20000

let rootEl: HTMLElement | null = null
let isModalOpen = false
let modalDraftAnalytics = false
let modalDraftMarketing = false
let modalOpenerElement: HTMLElement | null = null

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

function renderBannerHtml(): string {
  return `
    <div
      data-consent-banner="1"
      role="region"
      aria-label="Известие за бисквитки"
      style="
        position:fixed;
        z-index:${BANNER_Z_INDEX};
        left:16px;
        right:16px;
        bottom:16px;
        margin:0 auto;
        max-width:620px;
        border-radius:10px;
        border:1px solid rgba(212,165,32,0.6);
        background:linear-gradient(180deg,rgba(64,64,64,0.98) 0%,rgba(38,38,38,0.99) 100%);
        box-shadow:0 18px 48px rgba(0,0,0,0.5);
        backdrop-filter:blur(6px);
        -webkit-backdrop-filter:blur(6px);
        padding:16px 18px;
        color:#f8fafc;
        font-family:Arial, Helvetica, sans-serif;
      "
      class="pika-consent-banner"
    >
      <div class="pika-consent-banner-inner" style="display:flex;align-items:center;gap:18px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:900;color:#ffffff;margin-bottom:4px;">Този сайт използва бисквитки</div>
          <div style="font-size:13px;line-height:1.4;font-weight:600;color:rgba(255,255,255,0.72);">Използваме бисквитки, за да улесним работата на сайта и да показваме по-подходящо съдържание и функционалности.</div>
        </div>
        <div class="pika-consent-banner-actions" style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-consent-accept-all="1" style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;white-space:nowrap;">Приеми всички</button>
          <button type="button" data-consent-open-settings="1" style="height:42px;padding:0 16px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;white-space:nowrap;">Настройки</button>
        </div>
      </div>
    </div>
    <style>
      @media (max-width: 640px) {
        .pika-consent-banner { left:12px !important; right:12px !important; bottom:12px !important; max-width:none !important; padding:14px !important; }
        .pika-consent-banner-inner { flex-direction:column;align-items:stretch;gap:12px; }
        .pika-consent-banner-actions { flex-direction:column; }
        .pika-consent-banner-actions button { width:100%;height:46px; }
      }
      [data-consent-open-settings="1"]:hover { border-color:#f4c95b; }
      [data-consent-accept-all="1"]:hover { filter:brightness(1.05); }
    </style>
  `
}

function renderCheckboxCardHtml(options: {
  title: string
  description: string
  checked: boolean
  disabled: boolean
  dataAttribute: string
}): string {
  const { title, description, checked, disabled, dataAttribute } = options
  return `
    <div style="display:flex;align-items:flex-start;gap:12px;border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:12px 14px;background:rgba(255,255,255,0.03);">
      <input
        type="checkbox"
        ${dataAttribute}="1"
        ${checked ? 'checked' : ''}
        ${disabled ? 'disabled' : ''}
        aria-describedby="${dataAttribute}-desc"
        style="width:20px;height:20px;margin-top:2px;flex-shrink:0;accent-color:#d4a520;cursor:${disabled ? 'not-allowed' : 'pointer'};"
      >
      <div style="min-width:0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div style="font-size:14px;font-weight:900;color:#ffffff;">${escapeHtml(title)}</div>
          ${disabled ? '<span style="font-size:10px;font-weight:900;letter-spacing:0.02em;color:#080808;background:rgba(212,165,32,0.85);border-radius:999px;padding:2px 8px;">ВИНАГИ АКТИВНО</span>' : ''}
        </div>
        <div id="${dataAttribute}-desc" style="margin-top:3px;font-size:13px;line-height:1.4;font-weight:600;color:rgba(255,255,255,0.68);">${escapeHtml(description)}</div>
      </div>
    </div>
  `
}

function renderModalHtml(): string {
  return `
    <div data-consent-modal-root="1" style="position:fixed;inset:0;z-index:${MODAL_Z_INDEX};display:flex;align-items:center;justify-content:center;padding:20px;">
      <div data-consent-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pika-consent-modal-title"
        aria-describedby="pika-consent-modal-subtitle"
        data-consent-modal-dialog="1"
        style="position:relative;width:min(92vw,520px);max-height:88vh;overflow-y:auto;border-radius:10px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(28,28,28,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.5);padding:24px;color:#f8fafc;font-family:Arial, Helvetica, sans-serif;"
      >
        <button type="button" data-consent-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">&times;</button>
        <div style="display:grid;gap:16px;">
          <div>
            <h2 id="pika-consent-modal-title" style="margin:0 0 6px;font-size:19px;font-weight:900;color:#ffffff;">Настройки на бисквитките</h2>
            <p id="pika-consent-modal-subtitle" style="margin:0;font-size:13px;font-weight:700;color:rgba(255,255,255,0.62);">Избери кои бисквитки да останат активни.</p>
          </div>
          <div style="display:grid;gap:10px;">
            ${renderCheckboxCardHtml({
              title: 'Задължителни',
              description: 'Необходими са за правилната работа на сайта, вход, сесия и сигурност.',
              checked: true,
              disabled: true,
              dataAttribute: 'data-consent-necessary-checkbox',
            })}
            ${renderCheckboxCardHtml({
              title: 'Аналитични',
              description: 'Помагат ни да разберем как се използва сайтът и да подобряваме съдържанието и функционалностите.',
              checked: modalDraftAnalytics,
              disabled: false,
              dataAttribute: 'data-consent-analytics-checkbox',
            })}
            ${renderCheckboxCardHtml({
              title: 'Маркетинг',
              description: 'Управляват показването на реклами и измерването на ефективността им (Google AdSense, Meta Pixel).',
              checked: modalDraftMarketing,
              disabled: false,
              dataAttribute: 'data-consent-marketing-checkbox',
            })}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;">
            <button type="button" data-consent-save-choice="1" style="height:44px;padding:0 18px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Запази избора</button>
            <button type="button" data-consent-accept-all-modal="1" style="height:44px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Приеми всички</button>
          </div>
        </div>
      </div>
    </div>
    <style>
      @media (max-width: 480px) {
        [data-consent-modal-root="1"] > div[role="dialog"] { padding:18px; }
      }
    </style>
  `
}

function render(): void {
  if (rootEl === null) return

  if (isModalOpen) {
    rootEl.innerHTML = renderModalHtml()
    attachModalListeners()
    focusFirstModalElement()
    return
  }

  if (!hasRecordedChoice()) {
    rootEl.innerHTML = renderBannerHtml()
    attachBannerListeners()
    return
  }

  rootEl.innerHTML = ''
}

function focusFirstModalElement(): void {
  if (rootEl === null) return
  const dialog = rootEl.querySelector<HTMLElement>('[data-consent-modal-dialog="1"]')
  if (dialog === null) return
  const focusable = getFocusableElements(dialog)
  ;(focusable[0] ?? dialog).focus()
}

function openModal(opener: HTMLElement): void {
  modalOpenerElement = opener
  const consent = getConsent()
  // И двете категории стартират false при първо посещение (consent === null)
  // — стандартен opt-in default. При реално вече записан избор винаги
  // отразяват точно него, независимо едно от друго.
  modalDraftAnalytics = consent?.analytics === true
  modalDraftMarketing = consent?.marketing === true
  isModalOpen = true
  render()
}

function closeModal(): void {
  isModalOpen = false
  render()
  modalOpenerElement?.focus()
  modalOpenerElement = null
}

function attachBannerListeners(): void {
  if (rootEl === null) return
  rootEl.querySelector('[data-consent-accept-all="1"]')?.addEventListener('click', () => {
    acceptAllConsent()
  })
  // "Настройки" отваряне се обработва от глобалния delegated listener по-долу
  // (data-consent-open-settings споделя маркер с постоянната връзка в footer-а).
}

function attachModalListeners(): void {
  if (rootEl === null) return

  const dialog = rootEl.querySelector<HTMLElement>('[data-consent-modal-dialog="1"]')

  rootEl.querySelector('[data-consent-modal-close="1"]')?.addEventListener('click', () => {
    closeModal()
  })

  rootEl.querySelector<HTMLInputElement>('[data-consent-analytics-checkbox="1"]')?.addEventListener('change', (event) => {
    modalDraftAnalytics = (event.target as HTMLInputElement).checked
  })

  rootEl.querySelector<HTMLInputElement>('[data-consent-marketing-checkbox="1"]')?.addEventListener('change', (event) => {
    modalDraftMarketing = (event.target as HTMLInputElement).checked
  })

  rootEl.querySelector('[data-consent-save-choice="1"]')?.addEventListener('click', () => {
    saveConsentChoice(modalDraftAnalytics, modalDraftMarketing)
    closeModal()
  })

  rootEl.querySelector('[data-consent-accept-all-modal="1"]')?.addEventListener('click', () => {
    acceptAllConsent()
    closeModal()
  })

  if (dialog !== null) {
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeModal()
        return
      }

      if (event.key !== 'Tab') return

      const focusable = getFocusableElements(dialog)
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    })
  }
}

function handleGlobalOpenSettingsClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null
  const trigger = target?.closest<HTMLElement>('[data-consent-open-settings]')
  if (trigger === null || trigger === undefined) return
  event.preventDefault()
  openModal(trigger)
}

/** Монтира banner/modal контейнера веднъж. Безопасно за повторни извиквания. */
export function mountConsentUi(): void {
  if (rootEl !== null) return

  rootEl = document.createElement('div')
  rootEl.id = ROOT_ID
  document.body.appendChild(rootEl)

  document.addEventListener('click', handleGlobalOpenSettingsClick)
  subscribeToConsentChanges(() => render())

  render()
}

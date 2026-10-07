// Belot viewer-indicator ("{име} гледа вашата игра") — само за реалните
// участници на масата. Отделен Belot модул (Ludo аналогът в
// app/games/ludo/renderLudoSpectatorViewersPopover.ts е само reference, не се
// споделя код). Иконата и popover-ът са body-level fixed елементи, sync-нати
// отделно от phase render-а — промяна в списъка НИКОГА не rebuild-ва
// cutting/bidding/playing/scoring екрана (таймери/карти/взятки не се пипат).
//
// Asset-ът вече гледа към долния ляв ъгъл — НЕ се mirror-ва/rotate-ва с CSS.

import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'

export const BELOT_SPECTATOR_VIEWER_ICON_URL = '/images/belot/belot-spectator-viewer.webp'
export const BELOT_SPECTATOR_VIEWER_APPEARS_SOUND_SRC = '/audio/game-sounds/spectator-viewer-appears.mp3'

const ICON_ATTR = 'data-belot-spectator-viewer-icon'
const POPOVER_ATTR = 'data-belot-spectator-viewers-popover'
const DESKTOP_ICON_SIZE_PX = 52
const MOBILE_MAX_ICON_SIZE_PX = 48
const MOBILE_MIN_ICON_SIZE_PX = 32
const EDGE_GAP_PX = 10
const PROFILE_GAP_PX = 8
const POPOVER_GAP_PX = 8

export type BelotSpectatorViewer = { profileId: string; displayName: string }

export type SyncBelotSpectatorViewersOverlayOptions = {
  visible: boolean
  viewers: BelotSpectatorViewer[]
  popoverOpen: boolean
  onIconClick: () => void
  onOutsideClick: () => void
}

const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!)

export function renderBelotSpectatorViewersPopoverRowsHtml(viewers: BelotSpectatorViewer[]): string {
  return viewers
    .map(
      (viewer) =>
        `<div data-belot-spectator-viewer-row="1" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08);color:#f0e6cf;font-size:13px;line-height:1.4;"><span style="font-weight:700;color:#d4a520;">${escapeHtml(viewer.displayName)}</span> гледа вашата игра.</div>`,
    )
    .join('')
}

// Горният профил (визуално най-горният seat panel) — иконата стои вдясно от
// него, огледално на score HUD-а, който стои вляво от него.
function measureTopProfileRightEdge(): number | null {
  let topMost: DOMRect | null = null
  for (const card of Array.from(document.body.querySelectorAll<HTMLElement>('[data-seat-profile-card]'))) {
    const rect = card.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    if (topMost === null || rect.top < topMost.top) topMost = rect
  }
  return topMost?.right ?? null
}

function computeIconLayout(): { sizePx: number; topCss: string; rightCss: string } {
  const topCss = `max(${EDGE_GAP_PX}px, env(safe-area-inset-top))`
  const rightCss = `max(${EDGE_GAP_PX}px, env(safe-area-inset-right))`
  if (!isPhoneLayoutViewport()) return { sizePx: DESKTOP_ICON_SIZE_PX, topCss, rightCss }
  // Mobile: размерът се побира между горния профил и десния ръб.
  const profileRight = measureTopProfileRightEdge()
  const available = profileRight === null
    ? MOBILE_MAX_ICON_SIZE_PX
    : window.innerWidth - profileRight - PROFILE_GAP_PX - EDGE_GAP_PX
  const sizePx = Math.round(Math.max(MOBILE_MIN_ICON_SIZE_PX, Math.min(MOBILE_MAX_ICON_SIZE_PX, available)))
  return { sizePx, topCss, rightCss }
}

function iconPositionCss(layout: { sizePx: number; topCss: string; rightCss: string }): string[] {
  return [
    'position:fixed',
    `top:${layout.topCss}`,
    `right:${layout.rightCss}`,
    `width:${layout.sizePx}px`,
    `height:${layout.sizePx}px`,
  ]
}

/**
 * Origin rect за полет на подарък от Belot spectator — ТОЧНО позицията и
 * размерът на viewer иконата горе вдясно. Ако иконата е в DOM-а (участник с
 * видими зрители) -> нейният rect. Иначе (spectator viewer: иконата нарочно
 * не се рендерира) -> временен НЕВИДИМ probe със същите CSS правила (вкл.
 * env(safe-area-inset-*)), измерен и веднага премахнат. Никаква видима икона.
 */
export function getBelotSpectatorViewerOriginRect(): DOMRect {
  const icon = document.body.querySelector<HTMLElement>(`[${ICON_ATTR}]`)
  if (icon) return icon.getBoundingClientRect()
  const probe = document.createElement('div')
  probe.setAttribute('data-belot-spectator-viewer-anchor-probe', '1')
  probe.style.cssText = [...iconPositionCss(computeIconLayout()), 'visibility:hidden', 'pointer-events:none'].join(';')
  document.body.appendChild(probe)
  const rect = probe.getBoundingClientRect()
  probe.remove()
  return rect
}

let outsideClickHandler: ((event: MouseEvent) => void) | null = null
let resizeHandler: (() => void) | null = null

function detachOutsideClick(): void {
  if (outsideClickHandler !== null) {
    document.removeEventListener('click', outsideClickHandler, { capture: true })
    outsideClickHandler = null
  }
}

function detachResize(): void {
  if (resizeHandler !== null) {
    window.removeEventListener('resize', resizeHandler)
    resizeHandler = null
  }
}

export function removeBelotSpectatorViewersOverlay(): void {
  detachOutsideClick()
  detachResize()
  document.body.querySelector(`[${ICON_ATTR}]`)?.remove()
  document.body.querySelector(`[${POPOVER_ATTR}]`)?.remove()
}

export function syncBelotSpectatorViewersOverlay(options: SyncBelotSpectatorViewersOverlayOptions): void {
  if (!options.visible || options.viewers.length === 0) {
    removeBelotSpectatorViewersOverlay()
    return
  }

  const layout = computeIconLayout()
  let icon = document.body.querySelector<HTMLButtonElement>(`[${ICON_ATTR}]`)
  if (!icon) {
    icon = document.createElement('button')
    icon.type = 'button'
    icon.setAttribute(ICON_ATTR, '1')
    icon.setAttribute('aria-label', 'Зрители гледат играта')
    icon.innerHTML = `<img src="${BELOT_SPECTATOR_VIEWER_ICON_URL}" alt="" draggable="false" style="width:100%;height:100%;object-fit:contain;display:block;pointer-events:none;">`
    document.body.appendChild(icon)
  }
  // onclick (не addEventListener) — винаги сочи текущия callback, без натрупване.
  icon.onclick = (event) => {
    event.stopPropagation()
    options.onIconClick()
  }
  icon.style.cssText = [
    ...iconPositionCss(layout),
    'border:0',
    'background:transparent',
    'padding:0',
    'margin:0',
    'cursor:pointer',
    'z-index:25',
    '-webkit-tap-highlight-color:transparent',
  ].join(';')

  // Re-layout при resize/rotate (mobile размерът зависи от горния профил).
  detachResize()
  resizeHandler = () => syncBelotSpectatorViewersOverlay(options)
  window.addEventListener('resize', resizeHandler)

  if (!options.popoverOpen) {
    document.body.querySelector(`[${POPOVER_ATTR}]`)?.remove()
    detachOutsideClick()
    return
  }

  let popover = document.body.querySelector<HTMLElement>(`[${POPOVER_ATTR}]`)
  if (!popover) {
    popover = document.createElement('div')
    popover.setAttribute(POPOVER_ATTR, '1')
    document.body.appendChild(popover)
  }
  popover.style.cssText = [
    'position:fixed',
    `top:calc(${layout.topCss} + ${layout.sizePx + POPOVER_GAP_PX}px)`,
    `right:${layout.rightCss}`,
    'z-index:26',
    'max-width:min(280px, calc(100vw - 16px))',
    `max-height:min(320px, calc(100vh - ${layout.sizePx + POPOVER_GAP_PX + 2 * EDGE_GAP_PX}px))`,
    'overflow-y:auto',
    'background:rgba(15,23,42,0.98)',
    'border:1px solid rgba(212,165,32,0.4)',
    'border-radius:12px',
    'padding:10px 14px',
    'box-shadow:0 12px 32px rgba(0,0,0,0.5)',
    '-webkit-backdrop-filter:blur(12px)',
    'backdrop-filter:blur(12px)',
    'box-sizing:border-box',
    'pointer-events:auto',
    'font-family:Inter, system-ui, sans-serif',
  ].join(';')
  popover.innerHTML = renderBelotSpectatorViewersPopoverRowsHtml(options.viewers)

  detachOutsideClick()
  outsideClickHandler = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest(`[${POPOVER_ATTR}]`) || target.closest(`[${ICON_ATTR}]`)) return
    options.onOutsideClick()
  }
  document.addEventListener('click', outsideClickHandler, { capture: true })
}

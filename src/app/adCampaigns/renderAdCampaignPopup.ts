import type { AdCampaignDispatchClientDto } from '../network/createGameServerClient'

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Затъмнен backdrop + рамка (flex-column trick — X и "Виж" остават достъпни
// дори при много висока картинка, без JS изчисления на viewport height):
// image получава flex:1 1 auto; min-height:0, така че се свива автоматично
// ако max-height:90dvh на frame-а не стига, вместо да избутва бутона извън
// екрана. width:min(calc(100vw - 20px), 650px) — mobile safe margin, desktop cap.
export function renderAdCampaignPopup(dispatch: AdCampaignDispatchClientDto | null): string {
  if (dispatch === null) {
    return ''
  }

  // Кампания без target (dispatch.targetUrl === null) — само изображение +
  // X + backdrop dismiss, БЕЗ бутон "Виж". Бутонът не се рендва изобщо (не
  // disabled/скрит), за да не остане празно пространство, запазено за него —
  // image-ът получава пълната flex:1 1 auto височина на frame-а.
  const viewButton = dispatch.targetUrl !== null
    ? `<button type="button" data-ad-campaign-popup-view="1" style="flex-shrink:0;width:100%;min-height:52px;border:0;background:#d4a520;color:#080808;font-weight:900;font-size:16px;cursor:pointer;">Виж</button>`
    : ''

  return `
    <div data-ad-campaign-popup-backdrop="1" style="position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px;">
      <div data-ad-campaign-popup-frame="1" style="position:relative;width:min(calc(100vw - 20px), 650px);max-height:90dvh;background:#111;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5);">
        <button type="button" data-ad-campaign-popup-close="1" aria-label="Затвори" style="position:absolute;top:10px;right:10px;z-index:1;width:34px;height:34px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;font-size:18px;line-height:1;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
        <img src="${escapeHtml(dispatch.imageUrl)}" alt="" style="flex:1 1 auto;min-height:0;width:100%;height:auto;object-fit:contain;display:block;">
        ${viewButton}
      </div>
    </div>
  `
}

export function attachAdCampaignPopupHandlers(root: HTMLElement, handlers: {
  onDismiss: () => void
  onView: () => void
}): void {
  const backdrop = root.querySelector<HTMLElement>('[data-ad-campaign-popup-backdrop="1"]')
  if (!backdrop) {
    return
  }

  backdrop.addEventListener('click', (event) => {
    // Click ИЗВЪН рамката = dismiss; click ВЪТРЕ в рамката не трябва да
    // затваря popup-а — target===currentTarget е вярно само когато click-ът
    // е директно върху backdrop-а, не върху дете (frame или съдържанието му).
    if (event.target === event.currentTarget) {
      handlers.onDismiss()
    }
  })

  const frame = root.querySelector<HTMLElement>('[data-ad-campaign-popup-frame="1"]')
  frame?.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  root.querySelector<HTMLButtonElement>('[data-ad-campaign-popup-close="1"]')?.addEventListener('click', handlers.onDismiss)
  root.querySelector<HTMLButtonElement>('[data-ad-campaign-popup-view="1"]')?.addEventListener('click', handlers.onView)

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') handlers.onDismiss()
  })
}

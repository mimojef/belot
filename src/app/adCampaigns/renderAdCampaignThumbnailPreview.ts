function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Management-only image preview lightbox — САМО визуален преглед на
// campaign изображението от admin/pika_team списъка. Умишлено ОТДЕЛЕН от
// renderAdCampaignPopup.ts (production delivery popup) — тук НЯМА "Виж"
// бутон, НЕ маркира clicked/shown/dismissed receipt, НЕ навигира към target.
// Работи еднакво за campaign с/без target, защото зависи само от imageUrl.
// Затваря се с X / backdrop click / Escape; click вътре в рамката не затваря
// (същия target===currentTarget + stopPropagation pattern като popup-а).
export function renderAdCampaignThumbnailPreview(imageUrl: string | null): string {
  if (imageUrl === null) {
    return ''
  }

  // Close бутонът е position:fixed СПРЯМО viewport-а (не спрямо image frame-а)
  // — established convention от renderImageViewerOverlay (chat/Topics
  // lightbox) в renderLobbyScreen.ts: image-и с различно aspect ratio (тесни/
  // портретни vs широки) иначе биха оставили бутона на различно място спрямо
  // екрана всеки път. Така "горе вдясно" винаги е буквално горе вдясно на
  // екрана, независимо от размера/пропорциите на конкретното изображение.
  return `
    <div data-ad-campaign-thumbnail-preview-backdrop="1" style="position:fixed;inset:0;z-index:2100;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;padding:16px;">
      <div data-ad-campaign-thumbnail-preview-frame="1" style="position:relative;max-width:min(94vw, 900px);max-height:90dvh;display:flex;">
        <img src="${escapeHtml(imageUrl)}" alt="" style="max-width:100%;max-height:85dvh;width:auto;height:auto;object-fit:contain;border-radius:8px;box-shadow:0 24px 64px rgba(0,0,0,0.6);display:block;">
      </div>
      <button type="button" data-ad-campaign-thumbnail-preview-close="1" aria-label="Затвори" style="position:fixed;top:calc(12px + env(safe-area-inset-top,0));right:calc(12px + env(safe-area-inset-right,0));z-index:2120;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,0.24);background:rgba(10,10,10,0.78);color:#f8fafc;font-size:20px;line-height:1;font-weight:900;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
    </div>
  `
}

export function attachAdCampaignThumbnailPreviewHandlers(root: HTMLElement, handlers: {
  onClose: () => void
}): void {
  const backdrop = root.querySelector<HTMLElement>('[data-ad-campaign-thumbnail-preview-backdrop="1"]')
  if (!backdrop) {
    return
  }

  backdrop.addEventListener('click', (event) => {
    // Click ИЗВЪН рамката = затвори; click ВЪТРЕ в рамката (образа) не
    // трябва да затваря — target===currentTarget е вярно само за click
    // директно върху backdrop-а, не върху дете (frame/image/close бутона).
    if (event.target === event.currentTarget) {
      handlers.onClose()
    }
  })

  const frame = root.querySelector<HTMLElement>('[data-ad-campaign-thumbnail-preview-frame="1"]')
  frame?.addEventListener('click', (event) => {
    event.stopPropagation()
  })

  root.querySelector<HTMLButtonElement>('[data-ad-campaign-thumbnail-preview-close="1"]')?.addEventListener('click', handlers.onClose)

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') handlers.onClose()
  })
}

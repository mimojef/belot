// Виджет за едно тематично изображение (преглед + Качи/Замени + Премахни) —
// споделен между "Тематична визия" на кампаниите (renderAdminCampaignsPanel)
// и "Визия на Белот" (renderAdminBelotVisualSection). dataPrefix държи
// data-* атрибутите отделни, защото attach handler-ите и на двата панела се
// закачат върху целия root при всеки render.

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderThemeAssetWidget(params: {
  dataPrefix: string
  kind: string
  label: string
  url: string | null
  accept: string
  /** Текст в празния преглед. Default "По подразбиране" (кампании). */
  emptyLabel?: string
  disabled?: boolean
}): string {
  const { dataPrefix, kind, label, url } = params
  const disabledAttr = params.disabled === true ? ' disabled' : ''
  const previewHtml = url
    ? `<img src="${esc(url)}" alt="${esc(label)}" style="max-width:170px;max-height:96px;border-radius:6px;border:1px solid rgba(255,255,255,0.18);object-fit:cover;background:#000;">`
    : `<div style="width:170px;height:96px;border-radius:6px;border:1px dashed rgba(255,255,255,0.22);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.35);font-size:11px;font-weight:800;">${esc(params.emptyLabel ?? 'По подразбиране')}</div>`

  return `
    <div data-${dataPrefix}-widget="${kind}" style="display:flex;flex-direction:column;gap:8px;min-width:170px;">
      <div style="font-size:11px;font-weight:900;color:rgba(255,255,255,0.6);">${esc(label)}</div>
      ${previewHtml}
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        <label style="height:30px;display:inline-flex;align-items:center;padding:0 10px;border:1px solid rgba(147,197,253,0.35);border-radius:6px;background:rgba(30,64,175,0.22);color:#bfdbfe;font-size:11px;font-weight:900;cursor:pointer;">
          ${url ? 'Замени' : 'Качи'}
          <input data-${dataPrefix}-upload="${kind}" type="file" accept="${params.accept}" style="display:none;"${disabledAttr}>
        </label>
        ${url ? `<button type="button" data-${dataPrefix}-remove="${kind}" style="height:30px;border:1px solid rgba(248,113,113,0.35);border-radius:6px;background:rgba(127,29,29,0.30);color:#fecaca;font-size:11px;font-weight:900;cursor:pointer;"${disabledAttr}>Премахни</button>` : ''}
      </div>
    </div>
  `
}

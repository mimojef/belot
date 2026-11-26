// Етап 4В — „Стаи за мач → Свара“ в съществуващия админ панел.
//
// Показва и редактира входовете на „Свара“ от общата финансова
// конфигурация на сървъра (GET/POST /api/admin/svara/entries). Сървърът е
// единственият източник: валидира, изчислява наградите и записва. Нищо не се
// трие — входът се изключва. Белот частта на „Стаи за мач“ не се променя.

export type AdminSvaraEntry = {
  entryFee: number
  isEnabled: boolean
  commissionBps: number
  commissionSource: 'default' | 'entry'
  prizeByCapacity: Record<'2' | '3' | '4', number | null>
}

export type AdminSvaraEntries = {
  configVersion: string
  defaultCommissionBps: number
  entries: AdminSvaraEntry[]
}

export type AdminMatchRoomsGame = 'belot' | 'svara'

export type AdminSvaraState = {
  game: AdminMatchRoomsGame
  entries: AdminSvaraEntries | null
  loading: boolean
  errorText: string | null
  /** Входът в редакция, 'new' за нов, null — без форма. */
  edit: AdminSvaraEntry | 'new' | null
}

export type AdminSvaraEntryInput = { entryFee: number; isEnabled: boolean; commissionPercent: string | null }

export type AdminSvaraCallbacks = {
  onAdminMatchRoomsGameSelect: (game: AdminMatchRoomsGame) => void
  onAdminSvaraEditStart: (entry: AdminSvaraEntry | null) => void
  onAdminSvaraEditCancel: () => void
  onAdminSvaraEntrySubmit: (input: AdminSvaraEntryInput) => void
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const amount = (value: number) => new Intl.NumberFormat('bg-BG', { useGrouping: 'always' } as Intl.NumberFormatOptions).format(value)
/** 2000 → „20“, 1250 → „12,50“ */
export function formatCommissionPercent(bps: number): string {
  const whole = Math.trunc(bps / 100)
  const frac = bps % 100
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(2, '0')}`
}

const tabStyle = (active: boolean) => `height:32px;padding:0 14px;border-radius:8px;border:1px solid ${active ? 'rgba(52,211,153,0.7)' : 'rgba(255,255,255,0.18)'};background:${active ? 'rgba(52,211,153,0.16)' : 'transparent'};color:${active ? '#34d399' : 'rgba(255,255,255,0.7)'};font-size:12px;font-weight:900;cursor:pointer;`
const fieldStyle = 'width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(52,211,153,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;'
const labelStyle = 'display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(52,211,153,0.8);'

export function renderAdminMatchRoomsTabs(game: AdminMatchRoomsGame): string {
  return `<div data-admin-match-game-tabs="1" style="display:flex;gap:8px;margin-bottom:16px;">
    <button type="button" data-admin-match-game="belot" style="${tabStyle(game === 'belot')}">Белот</button>
    <button type="button" data-admin-match-game="svara" style="${tabStyle(game === 'svara')}">Свара</button>
  </div>`
}

export function renderAdminSvaraEntriesSection(state: AdminSvaraState): string {
  const data = state.entries
  const header = data
    ? `<div style="font-size:12px;color:rgba(255,255,255,0.55);margin-bottom:12px;">Комисиона по подразбиране: ${formatCommissionPercent(data.defaultCommissionBps)}%. Промените важат само за нови маси — започнатите мачове пазят своите условия.</div>`
    : ''
  const status = state.loading
    ? '<div style="color:#34d399;font-size:13px;font-weight:800;margin-bottom:16px;">Зареждане...</div>'
    : state.errorText
      ? `<div data-admin-svara-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;margin-bottom:14px;">${esc(state.errorText)}</div>`
      : ''
  const rows = (data?.entries ?? []).map((entry) => {
    const prizes = (['2', '3', '4'] as const).map((n) => `${n} играчи: ${entry.prizeByCapacity[n] === null ? '—' : amount(entry.prizeByCapacity[n]!)}`).join(' · ')
    return `<div data-admin-svara-entry="${entry.entryFee}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 12px;border-radius:8px;border:1px solid ${entry.isEnabled ? 'rgba(52,211,153,0.22)' : 'rgba(255,255,255,0.08)'};background:${entry.isEnabled ? 'rgba(52,211,153,0.04)' : 'rgba(255,255,255,0.02)'};margin-bottom:8px;">
      <div style="flex:1;min-width:0;display:flex;align-items:center;gap:18px;flex-wrap:wrap;">
        <div style="font-size:13px;font-weight:800;color:${entry.isEnabled ? '#f8fafc' : 'rgba(255,255,255,0.45)'};">Вход: ${amount(entry.entryFee)}</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">Комисиона: ${formatCommissionPercent(entry.commissionBps)}%${entry.commissionSource === 'default' ? ' (по подразбиране)' : ''}</div>
        <div data-admin-svara-prizes="${entry.entryFee}" style="font-size:12px;color:rgba(255,255,255,0.6);">Награда — ${prizes}</div>
        ${entry.isEnabled ? '' : '<span style="font-size:10px;font-weight:900;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 7px;letter-spacing:0.06em;">ИЗКЛЮЧЕН</span>'}
      </div>
      <div style="display:flex;gap:6px;">
        <button type="button" data-admin-svara-edit="${entry.entryFee}" style="height:30px;padding:0 10px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:transparent;color:rgba(52,211,153,0.9);font-size:11px;font-weight:800;cursor:pointer;">Редакция</button>
        <button type="button" data-admin-svara-toggle="${entry.entryFee}" style="height:30px;padding:0 10px;border:1px solid rgba(255,255,255,0.18);border-radius:6px;background:transparent;color:rgba(255,255,255,0.75);font-size:11px;font-weight:800;cursor:pointer;">${entry.isEnabled ? 'Изключи' : 'Включи'}</button>
      </div>
    </div>`
  }).join('')
  const edit = state.edit
  const form = edit === null
    ? `<button type="button" data-admin-svara-new="1" style="height:38px;padding:0 14px;border:1px solid rgba(52,211,153,0.48);border-radius:8px;background:#050505;color:#34d399;font-size:13px;font-weight:900;cursor:pointer;">+ Добави вход</button>`
    : (() => {
        const entry = edit === 'new' ? null : edit
        return `<form data-admin-svara-form="1" style="display:grid;gap:12px;padding:14px;border-radius:10px;border:1px solid rgba(52,211,153,0.28);background:rgba(0,0,0,0.35);">
          <div style="font-size:15px;font-weight:900;color:#34d399;">${entry ? `Редакция — вход: ${amount(entry.entryFee)}` : 'Нов вход за „Свара“'}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">
            <label style="${labelStyle}">Вход (жълтици)
              <input name="entryFee" type="number" min="5000" step="1000" required value="${entry?.entryFee ?? ''}" ${entry ? 'readonly' : ''} style="${fieldStyle}">
            </label>
            <label style="${labelStyle}">Комисиона (%)
              <input name="commissionPercent" type="text" inputmode="decimal" placeholder="по подразбиране" value="${entry && entry.commissionSource === 'entry' ? formatCommissionPercent(entry.commissionBps) : ''}" style="${fieldStyle}">
            </label>
            <label style="${labelStyle}">Активен
              <select name="isEnabled" style="${fieldStyle}">
                <option value="1" ${(entry?.isEnabled ?? true) ? 'selected' : ''}>Да</option>
                <option value="0" ${!(entry?.isEnabled ?? true) ? 'selected' : ''}>Не</option>
              </select>
            </label>
          </div>
          <div style="font-size:11px;color:rgba(255,255,255,0.45);">Входът е от 5 000 до 1 000 000 000, кратен на 1 000. Комисиона 10%–50% (празно = по подразбиране). Наградата се изчислява от сървъра.</div>
          <div style="display:flex;gap:8px;">
            <button type="submit" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#34d399 0%,#059669 100%);color:#000000;font-size:13px;font-weight:900;cursor:pointer;">Запази</button>
            <button type="button" data-admin-svara-form-cancel="1" style="height:40px;padding:0 14px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">Отказ</button>
          </div>
        </form>`
      })()
  return `<div data-admin-svara-entries="1">${status}${header}<div style="margin-bottom:14px;">${rows || (state.loading ? '' : '<div style="color:rgba(255,255,255,0.35);font-size:13px;font-weight:700;padding:8px 0;">Няма входове.</div>')}</div>${form}</div>`
}

export function bindAdminSvaraEntries(root: HTMLElement, state: AdminSvaraState, callbacks: AdminSvaraCallbacks): void {
  root.querySelectorAll<HTMLButtonElement>('[data-admin-match-game]').forEach((button) => {
    button.addEventListener('click', () => {
      const game = button.dataset.adminMatchGame === 'svara' ? 'svara' : 'belot'
      if (game !== state.game) callbacks.onAdminMatchRoomsGameSelect(game)
    })
  })
  const find = (fee: number) => state.entries?.entries.find((entry) => entry.entryFee === fee) ?? null
  root.querySelectorAll<HTMLButtonElement>('[data-admin-svara-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = find(Number(button.dataset.adminSvaraEdit))
      if (entry) callbacks.onAdminSvaraEditStart(entry)
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-admin-svara-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const entry = find(Number(button.dataset.adminSvaraToggle))
      if (!entry) return
      callbacks.onAdminSvaraEntrySubmit({
        entryFee: entry.entryFee,
        isEnabled: !entry.isEnabled,
        commissionPercent: entry.commissionSource === 'entry' ? formatCommissionPercent(entry.commissionBps) : null,
      })
    })
  })
  root.querySelector<HTMLButtonElement>('[data-admin-svara-new="1"]')?.addEventListener('click', () => callbacks.onAdminSvaraEditStart(null))
  root.querySelector<HTMLButtonElement>('[data-admin-svara-form-cancel="1"]')?.addEventListener('click', () => callbacks.onAdminSvaraEditCancel())
  root.querySelector<HTMLFormElement>('[data-admin-svara-form="1"]')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget as HTMLFormElement)
    const entryFee = Number(data.get('entryFee'))
    const commission = String(data.get('commissionPercent') ?? '').trim()
    if (!Number.isSafeInteger(entryFee) || entryFee <= 0) return
    // Сървърът валидира и смята; клиентът само подава стойностите.
    callbacks.onAdminSvaraEntrySubmit({ entryFee, isEnabled: String(data.get('isEnabled') ?? '1') === '1', commissionPercent: commission === '' ? null : commission })
  })
}

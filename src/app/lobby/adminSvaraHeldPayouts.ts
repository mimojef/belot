// „Свара“ — задържани изплащания (Админ → Настройки).
//
// Преглед и ръчно уреждане на доказаните случаи през
// GET/POST /api/admin/svara/held-payouts[/settle]. Сървърът е единственият
// източник: сумите идват САМО от фиксираните условия на мача (изплащане на
// победителя) или от удържаните входове (връщане); клиентът не подава суми.
// Всяко уреждане изисква бележка, а изплащането — и доказателство (одит).

export type AdminSvaraHeldCase = {
  matchId: string
  status: 'collected' | 'paid' | 'refunded' | 'held'
  heldReason: string | null
  participants: string[]
  debits: Array<{ profileId: string; amount: number }>
  terms: { entryFee: number; pot: number; prize: number; commissionBps: number; siteCommission: number } | null
  winnerProfileId: string | null
  createdAt: string
  updatedAt: string
  resolution: { action: 'payout' | 'refund'; resolvedAt: string; resolvedBy: string; note: string; evidence: string | null; heldReason: string | null } | null
}

export type AdminSvaraHeldData = {
  paidMatchesEnabled: boolean
  held: AdminSvaraHeldCase[]
  resolved: AdminSvaraHeldCase[]
  names: Record<string, string | null>
}

export type AdminSvaraHeldState = {
  data: AdminSvaraHeldData | null
  loading: boolean
  errorText: string | null
  pending: boolean
}

export type AdminSvaraHeldSettleInput = { matchId: string; action: 'payout' | 'refund'; winnerProfileId?: string; note: string; evidence: string }

export type AdminSvaraHeldCallbacks = {
  onAdminSvaraHeldReload: () => void
  onAdminSvaraHeldSettle: (input: AdminSvaraHeldSettleInput) => void
}

const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const amount = (value: number) => new Intl.NumberFormat('bg-BG').format(value)
const HELD_REASON: Record<string, string> = {
  'no-winner': 'Няма победител',
  'invalid-terms': 'Невалидни фиксирани условия',
  'winner-not-participant': 'Победителят не е участник',
  'match-unrecoverable': 'Мачът не може да се възстанови',
}
const fieldStyle = 'width:100%;box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:8px 10px;font-size:13px;font-weight:700;outline:none;font-family:inherit;'

function nameOf(data: AdminSvaraHeldData, profileId: string): string {
  const name = data.names[profileId]
  return name ? `${esc(name)} <span style="color:rgba(255,255,255,0.4);">(${esc(profileId)})</span>` : esc(profileId)
}

function heldCaseHtml(data: AdminSvaraHeldData, item: AdminSvaraHeldCase, pending: boolean): string {
  const terms = item.terms
  const debits = item.debits.map((debit) => `${nameOf(data, debit.profileId)} — ${amount(debit.amount)}`).join('<br>')
  const options = item.participants.map((id) => `<option value="${esc(id)}">${esc(data.names[id] ?? id)}</option>`).join('')
  return `<form data-admin-svara-held-form="${esc(item.matchId)}" style="display:grid;gap:10px;padding:12px;border-radius:10px;border:1px solid rgba(248,113,113,0.35);background:rgba(127,29,29,0.18);">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:13px;font-weight:800;color:#f8fafc;">
      <span>Мач ${esc(item.matchId)}</span>
      <span style="color:#fecaca;">${esc(HELD_REASON[item.heldReason ?? ''] ?? item.heldReason ?? '')}</span>
    </div>
    <div style="font-size:12px;color:rgba(255,255,255,0.7);line-height:1.5;">
      <div><b>Удържани входове:</b><br>${debits || '—'}</div>
      <div style="margin-top:6px;">${terms
        ? `<b>Фиксирани условия:</b> вход ${amount(terms.entryFee)} · фонд ${amount(terms.pot)} · награда ${amount(terms.prize)} · комисиона ${amount(terms.siteCommission)} (${(terms.commissionBps / 100).toString().replace('.', ',')}%)`
        : '<b style="color:#fecaca;">Фиксираните условия са невалидни — допустимо е само връщане на входовете.</b>'}</div>
      <div style="margin-top:6px;color:rgba(255,255,255,0.45);">Създаден: ${esc(item.createdAt)} · Задържан: ${esc(item.updatedAt)}</div>
    </div>
    ${terms ? `<label style="display:grid;gap:5px;font-size:11px;font-weight:900;color:#d4a520;">ПОБЕДИТЕЛ (САМО ПРИ ИЗПЛАЩАНЕ)
      <select name="winnerProfileId" style="${fieldStyle}height:38px;"><option value="">— избери —</option>${options}</select>
    </label>` : ''}
    <label style="display:grid;gap:5px;font-size:11px;font-weight:900;color:#d4a520;">БЕЛЕЖКА (ЗАДЪЛЖИТЕЛНА)
      <textarea name="note" rows="2" maxlength="2000" style="${fieldStyle}"></textarea>
    </label>
    <label style="display:grid;gap:5px;font-size:11px;font-weight:900;color:#d4a520;">ДОКАЗАТЕЛСТВО (ЗАДЪЛЖИТЕЛНО ПРИ ИЗПЛАЩАНЕ)
      <textarea name="evidence" rows="2" maxlength="2000" style="${fieldStyle}"></textarea>
    </label>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${terms ? `<button type="submit" data-admin-svara-held-action="payout" ${pending ? 'disabled' : ''} style="height:38px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#34d399 0%,#059669 100%);color:#000;font-size:13px;font-weight:900;cursor:pointer;">Изплати наградата (${amount(terms.prize)})</button>` : ''}
      <button type="submit" data-admin-svara-held-action="refund" ${pending ? 'disabled' : ''} style="height:38px;padding:0 14px;border:1px solid rgba(255,255,255,0.25);border-radius:8px;background:transparent;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Върни входовете</button>
    </div>
  </form>`
}

function resolvedHtml(data: AdminSvaraHeldData, item: AdminSvaraHeldCase): string {
  const r = item.resolution
  if (!r) return ''
  const what = r.action === 'payout'
    ? `Изплатено на ${item.winnerProfileId ? nameOf(data, item.winnerProfileId) : '—'}${item.terms ? ` (${amount(item.terms.prize)})` : ''}`
    : 'Върнати входове'
  return `<div style="font-size:12px;color:rgba(255,255,255,0.7);padding:8px 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);">
    <b>${esc(item.matchId)}</b> — ${what} · ${esc(r.resolvedAt)} · ${esc(r.resolvedBy)}<br>
    <span style="color:rgba(255,255,255,0.5);">Причина: ${esc(HELD_REASON[r.heldReason ?? ''] ?? r.heldReason ?? '—')} · Бележка: ${esc(r.note)}${r.evidence ? ` · Доказателство: ${esc(r.evidence)}` : ''}</span>
  </div>`
}

export function renderAdminSvaraHeldSection(state: AdminSvaraHeldState): string {
  const data = state.data
  const status = state.loading ? '<div style="color:#d4a520;font-size:13px;font-weight:800;">Зареждане...</div>' : ''
  const error = state.errorText ? `<div data-admin-svara-held-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">${esc(state.errorText)}</div>` : ''
  const body = !data ? '' : `
    <div style="font-size:12px;color:rgba(255,255,255,0.6);">Платени маси: <b style="color:${data.paidMatchesEnabled ? '#34d399' : 'rgba(255,255,255,0.75)'};">${data.paidMatchesEnabled ? 'включени' : 'изключени'}</b> (SVARA_PAID_MATCHES_ENABLED). Сумите идват само от фиксираните условия на мача — двойно уреждане не е възможно.</div>
    ${data.held.length === 0 ? '<div style="color:rgba(255,255,255,0.45);font-size:13px;font-weight:700;">Няма задържани изплащания.</div>' : data.held.map((item) => heldCaseHtml(data, item, state.pending)).join('')}
    ${data.resolved.length === 0 ? '' : `<div style="font-size:12px;font-weight:900;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.06em;margin-top:6px;">Уредени ръчно (последни ${data.resolved.length})</div>${data.resolved.map((item) => resolvedHtml(data, item)).join('')}`}`
  return `<section data-admin-svara-held="1" style="display:grid;gap:12px;margin-top:20px;border-top:1px solid rgba(212,165,32,0.22);padding-top:14px;">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div style="font-size:15px;font-weight:900;color:#f8fafc;">Свара — задържани изплащания</div>
      <button type="button" data-admin-svara-held-reload="1" style="height:32px;padding:0 12px;border:1px solid rgba(212,165,32,0.45);border-radius:8px;background:transparent;color:#d4a520;font-size:12px;font-weight:900;cursor:pointer;">Обнови</button>
    </div>
    ${status}${error}${body}
  </section>`
}

export function bindAdminSvaraHeldSection(root: HTMLElement, state: AdminSvaraHeldState, callbacks: AdminSvaraHeldCallbacks): void {
  root.querySelector<HTMLButtonElement>('[data-admin-svara-held-reload="1"]')?.addEventListener('click', () => callbacks.onAdminSvaraHeldReload())
  root.querySelectorAll<HTMLFormElement>('[data-admin-svara-held-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (state.pending) return
      const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null
      const action = submitter?.dataset.adminSvaraHeldAction === 'payout' ? 'payout' : 'refund'
      const data = new FormData(form)
      const matchId = form.dataset.adminSvaraHeldForm ?? ''
      const note = String(data.get('note') ?? '').trim()
      const evidence = String(data.get('evidence') ?? '').trim()
      const winnerProfileId = String(data.get('winnerProfileId') ?? '').trim()
      if (!note) { alert('Бележката е задължителна.'); return }
      if (action === 'payout' && (!winnerProfileId || !evidence)) { alert('Изплащането изисква победител и доказателство.'); return }
      const question = action === 'payout' ? `Изплащане на наградата за мач ${matchId}? Действието е окончателно.` : `Връщане на всички входове за мач ${matchId}? Действието е окончателно.`
      if (!confirm(question)) return
      callbacks.onAdminSvaraHeldSettle({ matchId, action, ...(action === 'payout' ? { winnerProfileId } : {}), note, evidence })
    })
  })
}

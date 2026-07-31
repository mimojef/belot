import type {
  AdminTournamentDetailRow,
  AdminTournamentFilters,
  AdminTournamentSummaryRow,
} from './adminTournamentTypes'

type ListState = {
  isAdminOrSubadmin: boolean
  canWrite: boolean
  loading: boolean
  errorText: string | null
  rows: AdminTournamentSummaryRow[]
  total: number
  filters: AdminTournamentFilters
}

type DetailState = {
  isAdminOrSubadmin: boolean
  canWrite: boolean
  loading: boolean
  errorText: string | null
  tournament: AdminTournamentDetailRow | null
  actionBusy: boolean
  actionErrorText: string | null
  actionInfoText: string | null
  cancelConfirmOpen: boolean
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDate(value: string | null): string {
  if (value === null) return '-'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })
}

function fmtCoins(value: number | null): string {
  if (value === null) return '-'
  return value.toLocaleString('bg-BG')
}

function badge(label: string, tone: 'green' | 'yellow' | 'red' | 'blue' | 'gray'): string {
  const colors = {
    green: ['#14532d', '#86efac'],
    yellow: ['#422006', '#facc15'],
    red: ['#450a0a', '#fca5a5'],
    blue: ['#082f49', '#7dd3fc'],
    gray: ['#18181b', '#d4d4d8'],
  }[tone]
  return `<span style="display:inline-flex;align-items:center;min-height:24px;padding:3px 8px;border-radius:6px;background:${colors[0]};color:${colors[1]};font-size:12px;font-weight:800;white-space:nowrap;">${escapeHtml(label)}</span>`
}

function integrityBadge(state: string): string {
  if (state === 'healthy') return badge('healthy', 'green')
  if (state === 'warning') return badge('warning', 'yellow')
  return badge('error', 'red')
}

function shell(title: string, body: string): string {
  return `
    <section style="min-height:620px;background:#050505;color:#f5f5f5;padding:20px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;">
        <h1 style="font-size:24px;line-height:1.2;margin:0;font-weight:900;">${escapeHtml(title)}</h1>
        <button type="button" data-admin-tournaments-back="1" style="min-height:38px;border:1px solid rgba(255,255,255,0.18);background:#111;color:#fff;border-radius:6px;padding:0 12px;font-weight:800;cursor:pointer;">Назад</button>
      </div>
      ${body}
    </section>
  `
}

export function renderAdminTournamentsPanel(state: ListState): string {
  if (!state.isAdminOrSubadmin) {
    return shell('Турнири', '<div style="color:#fecaca;font-weight:800;">Нямаш достъп.</div>')
  }
  const filters = state.filters
  const rows = state.rows.map((row) => `
    <button type="button" data-admin-tournament-open="${escapeHtml(row.tournamentId)}" style="
      display:grid;grid-template-columns:minmax(180px,1.6fr) minmax(160px,1fr) repeat(5,minmax(92px,.7fr));
      gap:10px;align-items:center;width:100%;text-align:left;background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);
      border-radius:8px;padding:12px;color:#f5f5f5;cursor:pointer;overflow:hidden;
    ">
      <span style="min-width:0;">
        <strong style="display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(row.name)}</strong>
        <code style="display:block;font-size:11px;color:#a3a3a3;overflow-wrap:anywhere;">${escapeHtml(row.tournamentId)}</code>
      </span>
      <span style="min-width:0;color:#d4d4d8;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(row.creator.displayName)}</span>
      <span>${row.visibility === 'password' ? badge('password', 'blue') : badge('public', 'gray')}</span>
      <span style="font-weight:800;">${fmtCoins(row.entryFee)}</span>
      <span>${row.participantsCount}/8</span>
      <span>${badge(row.status, row.status === 'finished' ? 'green' : row.status.includes('cancelled') ? 'red' : 'yellow')}</span>
      <span>${integrityBadge(row.integrity.state)}</span>
    </button>
  `).join('')

  return shell('Турнири', `
    <form data-admin-tournaments-filters="1" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px;">
      <input name="search" value="${escapeHtml(filters.search)}" maxlength="80" placeholder="ID, име, създател" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
      <select name="status" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
        ${['', 'open', 'starting', 'semifinal_in_progress', 'final_in_progress', 'finished', 'cancelled', 'admin_cancelled', 'auto_cancelled', 'failed'].map((v) => `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${v || 'status'}</option>`).join('')}
      </select>
      <select name="settlementState" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
        ${['', 'pending', 'settled'].map((v) => `<option value="${v}" ${filters.settlementState === v ? 'selected' : ''}>${v || 'settlement'}</option>`).join('')}
      </select>
      <select name="visibility" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
        ${['', 'public', 'password'].map((v) => `<option value="${v}" ${filters.visibility === v ? 'selected' : ''}>${v || 'visibility'}</option>`).join('')}
      </select>
      <select name="integrityState" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
        ${['', 'healthy', 'warning', 'error'].map((v) => `<option value="${v}" ${filters.integrityState === v ? 'selected' : ''}>${v || 'integrity'}</option>`).join('')}
      </select>
      <button type="submit" style="min-height:38px;border:0;background:#d4a520;color:#080808;border-radius:6px;font-weight:900;cursor:pointer;">Филтрирай</button>
    </form>
    ${state.loading ? '<div style="padding:24px;color:#d4a520;font-weight:900;">Зареждане...</div>' : ''}
    ${state.errorText ? `<div style="padding:12px;border:1px solid #7f1d1d;color:#fecaca;border-radius:8px;margin-bottom:12px;">${escapeHtml(state.errorText)}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;overflow-x:auto;">${rows || '<div style="color:#a3a3a3;">Няма турнири.</div>'}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;flex-wrap:wrap;">
      <span style="color:#a3a3a3;font-size:12px;">Общо: ${state.total.toLocaleString('bg-BG')}</span>
      <div style="display:flex;gap:8px;">
        <button type="button" data-admin-tournaments-page="${Math.max(1, filters.page - 1)}" ${filters.page <= 1 ? 'disabled' : ''} style="min-height:34px;border:1px solid rgba(255,255,255,0.18);background:#111;color:#fff;border-radius:6px;padding:0 10px;">‹</button>
        <button type="button" data-admin-tournaments-page="${filters.page + 1}" ${filters.page * filters.limit >= state.total ? 'disabled' : ''} style="min-height:34px;border:1px solid rgba(255,255,255,0.18);background:#111;color:#fff;border-radius:6px;padding:0 10px;">›</button>
      </div>
    </div>
  `)
}

export function renderAdminTournamentDetailPanel(state: DetailState): string {
  if (!state.isAdminOrSubadmin) return shell('Турнир', '<div style="color:#fecaca;font-weight:800;">Нямаш достъп.</div>')
  if (state.loading) return shell('Турнир', '<div style="color:#d4a520;font-weight:900;">Зареждане...</div>')
  if (state.errorText) return shell('Турнир', `<div style="color:#fecaca;font-weight:800;">${escapeHtml(state.errorText)}</div>`)
  const t = state.tournament
  if (!t) return shell('Турнир', '')

  const stat = (label: string, value: string) => `
    <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px;">
      <div style="font-size:11px;color:#a3a3a3;font-weight:800;text-transform:uppercase;">${escapeHtml(label)}</div>
      <div style="font-size:15px;font-weight:900;margin-top:5px;overflow-wrap:anywhere;">${escapeHtml(value)}</div>
    </div>
  `
  const teams = t.teams.map((team) => `
    <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px;">
      <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px;">${badge(`seed ${team.seedSlot ?? '-'}`, 'gray')}${badge(team.status, 'blue')}</div>
      ${team.members.map((m) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;"><span>${escapeHtml(m.displayName)}</span><span>${m.paidEntry ? badge('paid', 'green') : badge('no debit', 'yellow')}</span></div>`).join('') || '<span style="color:#a3a3a3;">Няма членове.</span>'}
    </div>
  `).join('')
  const bracket = t.bracket.map((m) => `
    <div style="background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px;">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">${badge(`${m.roundType} ${m.roundIndex}`, 'gray')}${badge(m.status, m.status === 'completed' ? 'green' : 'yellow')}${m.walkover ? badge('walkover', 'yellow') : ''}${m.playedWithBots ? badge('bots', 'blue') : ''}</div>
      <code style="display:block;color:#a3a3a3;overflow-wrap:anywhere;">${escapeHtml(m.matchId)}</code>
      <div style="margin-top:8px;color:#d4d4d8;">room: ${m.roomReady ? 'ready' : 'not ready'} · attendance: ${escapeHtml(m.attendanceResolution ?? '-')}</div>
      <div style="margin-top:4px;color:#d4d4d8;">replacements: ${m.replacementCount} · takeovers: ${m.takeoverCount}</div>
    </div>
  `).join('')
  const issues = t.integrity.issues.map((issue) => `<li><strong>${escapeHtml(issue.code)}</strong> · ${escapeHtml(issue.summary)}</li>`).join('')

  return shell(t.name, `
    ${state.actionErrorText ? `<div style="padding:10px;border:1px solid #7f1d1d;color:#fecaca;border-radius:8px;margin-bottom:12px;">${escapeHtml(state.actionErrorText)}</div>` : ''}
    ${state.actionInfoText ? `<div style="padding:10px;border:1px solid #14532d;color:#bbf7d0;border-radius:8px;margin-bottom:12px;">${escapeHtml(state.actionInfoText)}</div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;">
      ${integrityBadge(t.integrity.state)}
      ${badge(t.status, t.status === 'finished' ? 'green' : t.status.includes('cancelled') ? 'red' : 'yellow')}
      ${state.canWrite ? `<button type="button" data-admin-tournament-reconcile="1" ${!t.actions.canReconcile || state.actionBusy ? 'disabled' : ''} style="min-height:34px;border:0;background:#2563eb;color:#fff;border-radius:6px;padding:0 10px;font-weight:900;cursor:pointer;">Синхронизирай</button>` : badge('read-only', 'gray')}
      ${state.canWrite && t.actions.canCancelOpen ? `<button type="button" data-admin-tournament-cancel-open="1" ${state.actionBusy ? 'disabled' : ''} style="min-height:34px;border:0;background:#991b1b;color:#fff;border-radius:6px;padding:0 10px;font-weight:900;cursor:pointer;">Отмени open</button>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:14px;">
      ${stat('ID', t.tournamentId)}
      ${stat('Създател', t.creator.displayName)}
      ${stat('Участници', `${t.participantsCount}/8`)}
      ${stat('Вход', fmtCoins(t.entryFee))}
      ${stat('Създаден', fmtDate(t.createdAt))}
      ${stat('Старт', fmtDate(t.startedAt ?? t.scheduledStartAt))}
      ${stat('Финал', fmtDate(t.finishedAt))}
      ${stat('Rules', t.rulesVersion ?? '-')}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:14px;">
      <section><h2 style="font-size:16px;margin:0 0 8px;">Отбори</h2><div style="display:grid;gap:8px;">${teams || '<div style="color:#a3a3a3;">Няма отбори.</div>'}</div></section>
      <section><h2 style="font-size:16px;margin:0 0 8px;">Bracket</h2><div style="display:grid;gap:8px;">${bracket || '<div style="color:#a3a3a3;">Няма мачове.</div>'}</div></section>
    </div>
    <section style="margin-bottom:14px;"><h2 style="font-size:16px;margin:0 0 8px;">Финанси</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;">
        ${stat('Total entry', fmtCoins(t.finance.totalEntry))}
        ${stat('System fee', fmtCoins(t.finance.systemFee))}
        ${stat('Prize pool', fmtCoins(t.finance.prizePool))}
        ${stat('Debits', `${t.finance.entryDebitCount} / ${fmtCoins(t.finance.entryDebitSum)}`)}
        ${stat('Refunds', `${t.finance.refundCount} / ${fmtCoins(t.finance.refundSum)}`)}
        ${stat('Payouts', `${t.finance.prizePayoutCount} / ${fmtCoins(t.finance.prizePayoutSum)}`)}
      </div>
    </section>
    <section style="margin-bottom:14px;"><h2 style="font-size:16px;margin:0 0 8px;">Integrity</h2>${issues ? `<ul style="margin:0;padding-left:20px;color:#d4d4d8;">${issues}</ul>` : '<div style="color:#bbf7d0;">Няма активни проблеми.</div>'}</section>
    <section><h2 style="font-size:16px;margin:0 0 8px;">Events</h2>
      <div style="display:grid;gap:6px;">${t.events.rows.map((e) => `<div style="padding:8px;border:1px solid rgba(255,255,255,0.10);border-radius:6px;color:#d4d4d8;"><strong>${escapeHtml(e.eventType)}</strong> · ${fmtDate(e.createdAt)}<br>${escapeHtml(e.summary)}</div>`).join('') || '<div style="color:#a3a3a3;">Няма events.</div>'}</div>
    </section>
    ${state.cancelConfirmOpen ? `
      <div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;">
        <div style="width:min(520px,100%);background:#111;border:1px solid rgba(239,68,68,.45);border-radius:8px;padding:18px;color:#fff;">
          <h2 style="margin:0 0 10px;font-size:18px;">Отмени турнира?</h2>
          <p style="margin:0 0 12px;color:#d4d4d8;">Това ще отмени само open турнира и ще възстанови входните такси на записаните участници.</p>
          <div style="margin-bottom:12px;color:#fca5a5;font-weight:800;">${escapeHtml(t.name)} · ${t.participantsCount} участници · ${fmtCoins(t.actions.cancelRefundTotal)} монети</div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" data-admin-tournament-cancel-dismiss="1" style="min-height:36px;border:1px solid rgba(255,255,255,.2);background:#181818;color:#fff;border-radius:6px;padding:0 12px;">Отказ</button>
            <button type="button" data-admin-tournament-cancel-confirm="1" style="min-height:36px;border:0;background:#dc2626;color:#fff;border-radius:6px;padding:0 12px;font-weight:900;">Отмени турнира</button>
          </div>
        </div>
      </div>
    ` : ''}
  `)
}

export function attachAdminTournamentsHandlers(root: HTMLElement, handlers: {
  onBack: () => void
  onFilter: (filters: Partial<AdminTournamentFilters>) => void
  onPage: (page: number) => void
  onOpen: (tournamentId: string) => void
  onReconcile: () => void
  onCancelOpen: () => void
  onCancelConfirm: () => void
  onCancelDismiss: () => void
}): void {
  root.querySelector<HTMLButtonElement>('[data-admin-tournaments-back="1"]')?.addEventListener('click', handlers.onBack)
  root.querySelector<HTMLFormElement>('[data-admin-tournaments-filters="1"]')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    const data = new FormData(form)
    handlers.onFilter({
      page: 1,
      search: String(data.get('search') ?? ''),
      status: String(data.get('status') ?? ''),
      settlementState: String(data.get('settlementState') ?? ''),
      visibility: String(data.get('visibility') ?? ''),
      integrityState: String(data.get('integrityState') ?? ''),
    })
  })
  root.querySelectorAll<HTMLButtonElement>('[data-admin-tournaments-page]').forEach((button) => {
    button.addEventListener('click', () => handlers.onPage(Number(button.dataset.adminTournamentsPage ?? '1')))
  })
  root.querySelectorAll<HTMLButtonElement>('[data-admin-tournament-open]').forEach((button) => {
    button.addEventListener('click', () => handlers.onOpen(button.dataset.adminTournamentOpen ?? ''))
  })
  root.querySelector<HTMLButtonElement>('[data-admin-tournament-reconcile="1"]')?.addEventListener('click', handlers.onReconcile)
  root.querySelector<HTMLButtonElement>('[data-admin-tournament-cancel-open="1"]')?.addEventListener('click', handlers.onCancelOpen)
  root.querySelector<HTMLButtonElement>('[data-admin-tournament-cancel-confirm="1"]')?.addEventListener('click', handlers.onCancelConfirm)
  root.querySelector<HTMLButtonElement>('[data-admin-tournament-cancel-dismiss="1"]')?.addEventListener('click', handlers.onCancelDismiss)
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') handlers.onCancelDismiss()
  })
}

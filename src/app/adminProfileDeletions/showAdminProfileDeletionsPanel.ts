// Самоизтриване, Етап 4J — "Заявки за изтриване" (само пълен admin).
//
// Лек самостоятелен overlay: списък с последните 300 заявки/операции (лимитът
// и правата са на сървъра — GET /api/admin/profile-deletions), филтри по вид и
// статус, и отмяна САМО на доброволна заявка, която сървърът е отбелязал като
// отменима (canCancel). Отварянето на прозореца за отмяна не променя нищо;
// промяната е единствено след "Потвърди отмяната" и сървърът проверява
// всичко отново (роля, статус, lease, регистър) — тук няма бизнес правила.
//
// Всички данни идват от сървъра и се показват само като текст (escape).
// Нищо не се записва в браузъра.

import { formatPendingDeletionDeadline } from '../profileDeletion/showPendingDeletionPrompt'

export type AdminProfileDeletionRow = {
  kind: 'voluntary' | 'admin'
  operationId: string
  category: string
  status: string
  profile: { profileId: string; displayName: string } | null
  requestedAt: string | null
  scheduledFor: string | null
  gracePeriodDays: number | null
  cancelledAt: string | null
  cancelledBy: 'user' | 'system' | 'admin' | null
  completedAt: string | null
  dbDeletedAt: string | null
  lastErrorCode: string | null
  nextAttemptAt: string | null
  attemptCount: number | null
  filesPending: number
  filesFailed: number
  fileCleanupStatus: string | null
  awaitingOffsite: boolean
  adminCancellation: { reason: string; createdAt: string; actorDisplayName: string | null } | null
  canCancel: boolean
  cancelBlocker: string | null
}

export type AdminProfileDeletionFilters = { kind: '' | 'voluntary' | 'admin'; category: string }

export type AdminProfileDeletionsPanelDeps = {
  fetchList: (filters: AdminProfileDeletionFilters) => Promise<{ ok: true; rows: AdminProfileDeletionRow[]; limit: number } | { ok: false; message: string }>
  cancelRequest: (requestId: string, reason: string) => Promise<{ ok: true } | { ok: false; code: string | null; message: string }>
}

export const ADMIN_PROFILE_DELETION_REASON_MAX = 500

export const ADMIN_PROFILE_DELETION_CATEGORY_LABELS: Record<string, string> = {
  pending_cancellable: 'Чака — в срока за отмяна',
  pending_overdue: 'Срокът изтече — чака изпълнение',
  blocked_ban: 'Блокирана — активен бан',
  blocked_participation: 'Блокирана — игра или турнир',
  awaiting_offsite: 'Чака копие на регистъра извън сървъра',
  blocked_other: 'Блокирана — друга зависимост',
  failed: 'Неуспешен опит',
  executing: 'Изпълнява се',
  files_pending: 'Изтрита от базата — чакат файлове',
  cancelled: 'Отменена',
  completed: 'Изтрита',
  admin_scheduled: 'Насрочено административно изтриване',
}

const CATEGORY_COLORS: Record<string, string> = {
  pending_cancellable: '#fde68a',
  pending_overdue: '#fdba74',
  blocked_ban: '#fca5a5',
  blocked_participation: '#fdba74',
  awaiting_offsite: '#93c5fd',
  blocked_other: '#fdba74',
  failed: '#fca5a5',
  executing: '#93c5fd',
  files_pending: '#c4b5fd',
  cancelled: '#86efac',
  completed: 'rgba(226,232,240,0.7)',
  admin_scheduled: '#f9a8d4',
}

const DELAY_REASONS: Record<string, string> = {
  active_ban: 'Активен бан',
  ledger_offsite_pending: 'Чака потвърждение, че регистърът е копиран извън сървъра',
  active_game: 'Активна игра',
  active_game_local: 'Активна игра',
  active_tournament: 'Незавършен турнир',
  pending_tournament_invite: 'Чакаща покана за турнир',
  campaign_gift_sender_protected: 'Изпращач на кампанийни награди',
  role_not_allowed: 'Служебна роля',
  ledger_write_failed: 'Неуспешен запис в регистъра на изтриванията',
  files_pending: 'Неизтрити файлове',
  identity_profile_missing: 'Профилът липсва',
}

export const ADMIN_PROFILE_DELETION_BLOCKER_TEXTS: Record<string, string> = {
  not_voluntary: 'Административните изтривания са само за преглед — не се отменят оттук.',
  status_not_cancellable: 'Заявката вече е приключила, отменена или се изпълнява.',
  irreversible: 'Профилът вече е изтрит от базата — отмяната не е възможна.',
  lease_held: 'Заявката се обработва в момента от автоматичното изтриване. Обнови след малко.',
  profile_missing: 'Профилът вече не съществува — отмяната не е възможна.',
  ledger_intent_recorded: 'Намерението за окончателно изтриване вече е записано в регистъра на изтриванията и се копира извън сървъра. Безопасна отмяна на този етап не е възможна.',
  ledger_unavailable: 'Регистърът на изтриванията не може да бъде проверен — отмяната е спряна от съображения за безопасност.',
}

const CANCELLED_BY_LABELS: Record<string, string> = {
  user: 'от потребителя',
  system: 'от системата (активна игра)',
  admin: 'от администратор',
}

const HOST_ID = 'admin-profile-deletions-panel'
const DIALOG_ID = 'admin-profile-deletion-cancel-dialog'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDate(iso: string | null): string {
  return formatPendingDeletionDeadline(iso ?? undefined) ?? '—'
}

const BTN_PRIMARY = 'min-height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit;'
const BTN_SECONDARY = 'min-height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;'
const BTN_DANGER = 'min-height:40px;padding:0 14px;border:1px solid rgba(248,113,113,0.55);border-radius:8px;background:rgba(248,113,113,0.12);color:#fecaca;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;'
const SELECT_STYLE = 'min-height:40px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:#1a1a1a;color:#f8fafc;font-size:14px;font-family:inherit;max-width:100%;'

function profileLabel(row: AdminProfileDeletionRow): string {
  if (row.profile !== null) return escapeHtml(row.profile.displayName)
  return `<span style="color:rgba(226,232,240,0.6);">Изтрит или недостъпен профил</span>`
}

function field(label: string, value: string): string {
  return `<div style="min-width:0;"><div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:rgba(226,232,240,0.55);">${escapeHtml(label)}</div><div style="font-size:13px;color:#f1f5f9;overflow-wrap:anywhere;">${value}</div></div>`
}

function renderRow(row: AdminProfileDeletionRow): string {
  const color = CATEGORY_COLORS[row.category] ?? '#e2e8f0'
  const label = ADMIN_PROFILE_DELETION_CATEGORY_LABELS[row.category] ?? row.category
  const fields: string[] = []
  fields.push(field('Вид', row.kind === 'voluntary' ? 'Доброволна' : 'Административна'))
  if (row.requestedAt !== null) fields.push(field('Подадена', escapeHtml(formatDate(row.requestedAt))))
  if (row.scheduledFor !== null) {
    fields.push(field('Краен срок', `${escapeHtml(formatDate(row.scheduledFor))}${row.gracePeriodDays !== null ? ` <span style="color:rgba(226,232,240,0.6);">(${row.gracePeriodDays} дни)</span>` : ''}`))
  }
  if (row.cancelledAt !== null) {
    fields.push(field('Отменена', `${escapeHtml(formatDate(row.cancelledAt))}${row.cancelledBy !== null ? ` ${escapeHtml(CANCELLED_BY_LABELS[row.cancelledBy] ?? '')}` : ''}`))
  }
  if (row.completedAt !== null) fields.push(field('Изтрита', escapeHtml(formatDate(row.completedAt))))
  else if (row.dbDeletedAt !== null) fields.push(field('Изтрита от базата', escapeHtml(formatDate(row.dbDeletedAt))))
  if (row.lastErrorCode !== null && row.category !== 'cancelled' && row.category !== 'completed') {
    fields.push(field('Причина за забавяне', escapeHtml(DELAY_REASONS[row.lastErrorCode] ?? row.lastErrorCode)))
  }
  if (row.nextAttemptAt !== null) fields.push(field('Следващ опит', escapeHtml(formatDate(row.nextAttemptAt))))
  if (row.filesPending > 0 || row.filesFailed > 0) {
    fields.push(field('Файлове', `${row.filesPending} неизтрити${row.filesFailed > 0 ? `, ${row.filesFailed} с грешка` : ''}`))
  }
  if (row.kind === 'admin' && row.category === 'admin_scheduled') {
    fields.push(field('Регистър', row.awaitingOffsite ? 'Чака копие извън сървъра' : 'Потвърдено извън сървъра'))
  }
  const technical = [
    `статус ${escapeHtml(row.status)}`,
    row.lastErrorCode !== null ? `код ${escapeHtml(row.lastErrorCode)}` : null,
    row.attemptCount !== null && row.attemptCount > 0 ? `опити ${row.attemptCount}` : null,
    row.fileCleanupStatus !== null ? `файлове ${escapeHtml(row.fileCleanupStatus)}` : null,
    `ID ${escapeHtml(row.operationId)}`,
  ].filter((part): part is string => part !== null).join(' · ')

  const adminCancellation = row.adminCancellation !== null ? `
    <div data-admin-deletion-cancel-audit="1" style="margin-top:10px;padding:8px 10px;border-radius:8px;border:1px solid rgba(134,239,172,0.3);background:rgba(134,239,172,0.06);font-size:13px;line-height:1.45;color:#dcfce7;">
      Отменена от ${escapeHtml(row.adminCancellation.actorDisplayName ?? 'администратор')} на ${escapeHtml(formatDate(row.adminCancellation.createdAt))}.<br>
      Причина: <span style="overflow-wrap:anywhere;">${escapeHtml(row.adminCancellation.reason)}</span>
    </div>` : ''

  const isTerminal = row.category === 'cancelled' || row.category === 'completed'
  let action = ''
  if (row.canCancel && row.kind === 'voluntary') {
    action = `<button type="button" data-admin-deletion-cancel-open="${escapeHtml(row.operationId)}" style="${BTN_DANGER}">Отмени заявката</button>`
  } else if (!isTerminal && row.cancelBlocker !== null) {
    const text = ADMIN_PROFILE_DELETION_BLOCKER_TEXTS[row.cancelBlocker] ?? 'Отмяната не е възможна.'
    action = `<div data-admin-deletion-blocker="${escapeHtml(row.cancelBlocker)}" style="font-size:12px;line-height:1.45;color:rgba(226,232,240,0.7);max-width:420px;">${escapeHtml(text)}</div>`
  }

  return `
    <li data-admin-deletion-row="${escapeHtml(row.operationId)}" data-admin-deletion-category="${escapeHtml(row.category)}" data-admin-deletion-kind="${escapeHtml(row.kind)}"
      style="list-style:none;margin:0 0 10px;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);">
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <div style="font-size:15px;font-weight:800;color:#f8fafc;min-width:0;overflow-wrap:anywhere;">${profileLabel(row)}</div>
        <span data-admin-deletion-status-label="1" style="display:inline-block;padding:3px 8px;border-radius:999px;border:1px solid ${color};color:${color};font-size:12px;font-weight:800;">${escapeHtml(label)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 14px;">${fields.join('')}</div>
      ${adminCancellation}
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;">
        <div style="font-size:11px;color:rgba(226,232,240,0.45);overflow-wrap:anywhere;min-width:0;">${technical}</div>
        ${action}
      </div>
    </li>`
}

export function showAdminProfileDeletionsPanel(deps: AdminProfileDeletionsPanelDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  document.getElementById(DIALOG_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:200000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  const filters: AdminProfileDeletionFilters = { kind: '', category: '' }
  let rows: AdminProfileDeletionRow[] = []
  let loading = false
  let loadSeq = 0

  const categoryOptions = Object.entries(ADMIN_PROFILE_DELETION_CATEGORY_LABELS)
    .map(([value, text]) => `<option value="${value}">${escapeHtml(text)}</option>`).join('')

  host.innerHTML = `
    <div style="min-height:100%;display:flex;justify-content:center;padding:16px;box-sizing:border-box;">
      <section role="dialog" aria-modal="true" aria-labelledby="admin-profile-deletions-title"
        style="width:min(100%,980px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:#111111;box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:18px;align-self:flex-start;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;">
          <h2 id="admin-profile-deletions-title" style="margin:0;font-size:20px;font-weight:900;color:#d4a520;letter-spacing:0.02em;">Заявки за изтриване</h2>
          <button type="button" data-admin-deletions-close="1" aria-label="Затвори" style="${BTN_SECONDARY}">Затвори</button>
        </div>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.5;color:rgba(226,232,240,0.7);">Последните 300 заявки и операции, най-новите първи. За изтрити профили се показват само технически данни.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:rgba(226,232,240,0.6);">Вид
            <select data-admin-deletions-filter-kind="1" style="${SELECT_STYLE}">
              <option value="">Всички</option>
              <option value="voluntary">Доброволни</option>
              <option value="admin">Административни</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:rgba(226,232,240,0.6);flex:1 1 220px;min-width:0;">Статус
            <select data-admin-deletions-filter-category="1" style="${SELECT_STYLE}">
              <option value="">Всички</option>
              ${categoryOptions}
            </select>
          </label>
          <button type="button" data-admin-deletions-refresh="1" style="${BTN_SECONDARY};align-self:flex-end;">Обнови</button>
        </div>
        <div data-admin-deletions-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.45;"></div>
        <div data-admin-deletions-summary="1" style="font-size:12px;color:rgba(226,232,240,0.55);margin-bottom:8px;"></div>
        <ul data-admin-deletions-list="1" style="margin:0;padding:0;"></ul>
      </section>
    </div>`

  const listEl = host.querySelector<HTMLUListElement>('[data-admin-deletions-list="1"]')!
  const summaryEl = host.querySelector<HTMLElement>('[data-admin-deletions-summary="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-admin-deletions-notice="1"]')!
  const kindSelect = host.querySelector<HTMLSelectElement>('[data-admin-deletions-filter-kind="1"]')!
  const categorySelect = host.querySelector<HTMLSelectElement>('[data-admin-deletions-filter-category="1"]')!

  const showNotice = (text: string | null, tone: 'ok' | 'error' = 'ok') => {
    if (text === null) { noticeEl.style.display = 'none'; return }
    noticeEl.textContent = text
    noticeEl.style.display = ''
    noticeEl.style.border = tone === 'ok' ? '1px solid rgba(134,239,172,0.35)' : '1px solid rgba(248,113,113,0.45)'
    noticeEl.style.background = tone === 'ok' ? 'rgba(134,239,172,0.08)' : 'rgba(248,113,113,0.08)'
    noticeEl.style.color = tone === 'ok' ? '#dcfce7' : '#fecaca'
  }

  const renderList = () => {
    if (loading && rows.length === 0) {
      listEl.innerHTML = `<li style="list-style:none;padding:20px 0;color:rgba(226,232,240,0.7);font-size:14px;">Зареждане…</li>`
      summaryEl.textContent = ''
      return
    }
    summaryEl.textContent = loading ? 'Обновяване…' : `Показани: ${rows.length}`
    listEl.innerHTML = rows.length === 0
      ? `<li data-admin-deletions-empty="1" style="list-style:none;padding:20px 0;color:rgba(226,232,240,0.7);font-size:14px;">Няма заявки по избраните филтри.</li>`
      : rows.map(renderRow).join('')
  }

  const load = async () => {
    const seq = ++loadSeq
    loading = true
    renderList()
    const result = await deps.fetchList({ ...filters })
    if (seq !== loadSeq || !host.isConnected) return
    loading = false
    if (result.ok) {
      rows = result.rows
    } else {
      rows = []
      showNotice(result.message, 'error')
    }
    renderList()
  }

  const closeDialog = () => {
    document.getElementById(DIALOG_ID)?.remove()
  }

  const close = () => {
    closeDialog()
    document.removeEventListener('keydown', onKeydown, true)
    host.remove()
    previouslyFocused?.focus?.()
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const dialog = document.getElementById(DIALOG_ID)
    event.preventDefault()
    if (dialog !== null) {
      if (dialog.getAttribute('data-busy') !== '1') {
        closeDialog()
      }
      return
    }
    close()
  }
  document.addEventListener('keydown', onKeydown, true)

  const openCancelDialog = (row: AdminProfileDeletionRow) => {
    closeDialog()
    const dialogHost = document.createElement('div')
    dialogHost.id = DIALOG_ID
    dialogHost.style.cssText = 'position:fixed;inset:0;z-index:210000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.6);font-family:Arial,Helvetica,sans-serif;'
    dialogHost.innerHTML = `
      <div style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;">
        <div role="dialog" aria-modal="true" aria-labelledby="admin-deletion-cancel-title"
          style="width:min(100%,480px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.45);background:#151515;box-shadow:0 34px 80px rgba(0,0,0,0.55);padding:20px;">
          <h3 id="admin-deletion-cancel-title" style="margin:0 0 12px;font-size:18px;font-weight:900;color:#f8fafc;">Отмяна на заявка за изтриване</h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 14px;margin-bottom:12px;">
            ${field('Профил', profileLabel(row))}
            ${field('Подадена', escapeHtml(formatDate(row.requestedAt)))}
            ${field('Статус', escapeHtml(ADMIN_PROFILE_DELETION_CATEGORY_LABELS[row.category] ?? row.category))}
            ${field('Краен срок', escapeHtml(formatDate(row.scheduledFor)))}
          </div>
          <div style="margin:0 0 12px;padding:10px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.08);font-size:13px;line-height:1.5;color:#fde68a;">
            Профилът ще бъде запазен и няма да бъде изтрит по тази заявка. Активните ограничения (например бан) остават. Потребителят трябва да влезе отново с имейла и паролата си.
          </div>
          <label for="admin-deletion-cancel-reason" style="display:block;margin:0 0 6px;font-size:14px;font-weight:800;color:#f8fafc;">Причина за отмяната</label>
          <textarea id="admin-deletion-cancel-reason" data-admin-deletion-cancel-reason="1" maxlength="${ADMIN_PROFILE_DELETION_REASON_MAX}" rows="3" required
            style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#f8fafc;font-size:15px;font-family:inherit;resize:vertical;"></textarea>
          <div style="display:flex;justify-content:space-between;gap:8px;margin:4px 0 12px;font-size:12px;color:rgba(226,232,240,0.55);">
            <span>Записва се в одита. Не въвеждай лични данни (имейл, телефон).</span>
            <span data-admin-deletion-cancel-counter="1">0/${ADMIN_PROFILE_DELETION_REASON_MAX}</span>
          </div>
          <div data-admin-deletion-cancel-error="1" role="alert" style="display:none;margin:0 0 12px;font-size:13px;line-height:1.5;color:#fca5a5;"></div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;">
            <button type="button" data-admin-deletion-cancel-back="1" style="${BTN_SECONDARY}">Назад</button>
            <button type="button" data-admin-deletion-cancel-confirm="1" disabled style="${BTN_PRIMARY}">Потвърди отмяната</button>
          </div>
        </div>
      </div>`
    document.body.appendChild(dialogHost)

    const reasonEl = dialogHost.querySelector<HTMLTextAreaElement>('[data-admin-deletion-cancel-reason="1"]')!
    const counterEl = dialogHost.querySelector<HTMLElement>('[data-admin-deletion-cancel-counter="1"]')!
    const errorEl = dialogHost.querySelector<HTMLElement>('[data-admin-deletion-cancel-error="1"]')!
    const confirmEl = dialogHost.querySelector<HTMLButtonElement>('[data-admin-deletion-cancel-confirm="1"]')!
    const backEl = dialogHost.querySelector<HTMLButtonElement>('[data-admin-deletion-cancel-back="1"]')!
    let busy = false

    const refresh = () => {
      const trimmed = reasonEl.value.trim()
      counterEl.textContent = `${reasonEl.value.length}/${ADMIN_PROFILE_DELETION_REASON_MAX}`
      confirmEl.disabled = busy || trimmed.length === 0 || reasonEl.value.length > ADMIN_PROFILE_DELETION_REASON_MAX
      confirmEl.style.opacity = confirmEl.disabled ? '0.5' : '1'
      confirmEl.style.cursor = confirmEl.disabled ? 'not-allowed' : 'pointer'
    }
    reasonEl.addEventListener('input', refresh)
    backEl.addEventListener('click', () => { if (!busy) closeDialog() })
    dialogHost.addEventListener('click', (event) => {
      if (busy) return
      if (event.target === dialogHost || (event.target as HTMLElement).parentElement === dialogHost) closeDialog()
    })
    confirmEl.addEventListener('click', () => {
      const reason = reasonEl.value.trim()
      if (busy || reason.length === 0) return
      busy = true
      dialogHost.setAttribute('data-busy', '1')
      reasonEl.disabled = true
      backEl.disabled = true
      confirmEl.textContent = 'Изпращане…'
      errorEl.style.display = 'none'
      refresh()
      void deps.cancelRequest(row.operationId, reason).then((result) => {
        busy = false
        dialogHost.removeAttribute('data-busy')
        if (result.ok) {
          closeDialog()
          showNotice('Заявката е отменена. Профилът е запазен.', 'ok')
          void load()
          return
        }
        reasonEl.disabled = false
        backEl.disabled = false
        confirmEl.textContent = 'Потвърди отмяната'
        errorEl.textContent = result.message
        errorEl.style.display = ''
        refresh()
        // Състоянието може да се е променило междувременно — списъкът се обновява.
        void load()
      })
    })
    refresh()
    reasonEl.focus()
  }

  host.querySelector<HTMLButtonElement>('[data-admin-deletions-close="1"]')!.addEventListener('click', close)
  host.querySelector<HTMLButtonElement>('[data-admin-deletions-refresh="1"]')!.addEventListener('click', () => {
    showNotice(null)
    void load()
  })
  kindSelect.addEventListener('change', () => {
    filters.kind = kindSelect.value === 'voluntary' || kindSelect.value === 'admin' ? kindSelect.value : ''
    void load()
  })
  categorySelect.addEventListener('change', () => {
    filters.category = categorySelect.value
    void load()
  })
  listEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-admin-deletion-cancel-open]')
    if (button === null) return
    const row = rows.find((candidate) => candidate.operationId === button.getAttribute('data-admin-deletion-cancel-open'))
    if (row !== undefined && row.canCancel) openCancelDialog(row)
  })

  void load()
  host.querySelector<HTMLButtonElement>('[data-admin-deletions-close="1"]')!.focus()
  return { close }
}

/** Съобщение по кода на сървъра при неуспешна отмяна (иначе — съобщението на сървъра). */
export function describeAdminProfileDeletionCancelError(code: string | null, message: string | null): string {
  if (code !== null && ADMIN_PROFILE_DELETION_BLOCKER_TEXTS[code] !== undefined) return ADMIN_PROFILE_DELETION_BLOCKER_TEXTS[code]!
  if (code === 'invalid_reason') return 'Причината за отмяната е задължителна (до 500 символа).'
  if (code === 'forbidden') return 'Само администратор може да отменя заявки за изтриване.'
  if (code === 'not_found') return 'Заявката не е намерена.'
  return message ?? 'Няма връзка със сървъра. Заявката не е отменена.'
}


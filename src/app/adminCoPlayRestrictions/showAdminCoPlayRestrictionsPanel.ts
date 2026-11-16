// „Забрани за съвместна игра“ (Етап 5) — Admin → Забрани за съвместна игра.
//
// САМО пълен администратор (role=admin); сървърът проверява ролята при всяка
// заявка (/api/admin/co-play-restrictions — Етап 1/4). Самостоятелен overlay
// (по шаблона на „Заявки за изтриване“ / „Гласови разговори“), зареждан с
// dynamic import само при отваряне:
//   * Глобален превключвател — CO_PLAY_RESTRICTIONS_ENABLED (в базата, не в
//     env); включване/изключване само след потвърждение; отказ 409 при общ
//     незапочнал турнир -> конфликтните турнири от отговора.
//   * Нова забрана — два профила (съществуващото търсене /api/players/search),
//     срок в дни (ръчно, 1..3650) или „Безсрочно“, задължителна причина (до
//     500 знака), потвърждение, защита от двойно изпращане.
//   * Забрани — филтри по статус, търсене по ник, страниране (limit/offset от
//     API-то), изчакващи забрани с общите турнири, предсрочна отмяна.
//   * Одит — всички записи (или само за една забрана): кой, кога, какво.
//
// Тук няма бизнес правила: всичко (права, валидност, статуси, срокове) решава
// сървърът; клиентската проверка е само за удобство. Всички данни се показват
// като текст (escape). Нищо не се записва в браузъра. Датите — Europe/Sofia.

export type CoPlayRestrictionStatus = 'active' | 'pending_activation' | 'expired' | 'lifted'

export type CoPlayRestrictionProfileRef = {
  profileId: string
  accountId: string
  displayNameSnapshot: string
  currentDisplayName: string | null
}

export type CoPlayPendingTournamentRef = { tournamentId: string; name: string | null; status: string | null }

export type CoPlayRestrictionView = {
  restrictionId: string
  gameScope: string
  status: CoPlayRestrictionStatus
  profiles: [CoPlayRestrictionProfileRef, CoPlayRestrictionProfileRef]
  reason: string
  durationDays: number | null
  isIndefinite: boolean
  createdAt: string
  createdByProfileId: string | null
  createdByDisplayName: string | null
  activatedAt: string | null
  pendingReason: 'shared_tournament' | null
  pendingTournaments: CoPlayPendingTournamentRef[]
  expiresAt: string | null
  endedAt: string | null
  endKind: 'lifted' | 'expired' | null
  liftedByProfileId: string | null
  liftedByDisplayName: string | null
  liftReason: string | null
}

export type CoPlayRestrictionAuditView = {
  auditId: string
  restrictionId: string | null
  action: string
  actorProfileId: string | null
  actorDisplayName: string | null
  createdAt: string
  details: Record<string, unknown> | null
}

export type CoPlayRestrictionSettings = { enabled: boolean; updatedAt: string | null; updatedByProfileId: string | null }

export type CoPlayTournamentConflict = {
  restrictionId: string
  tournamentId: string
  tournamentName: string | null
  tournamentStatus: string | null
}

type SearchProfile = { profileId: string; displayName: string; avatarUrl: string | null; level: number | null }

export type AdminCoPlayRestrictionsPanelDeps = {
  getApiBaseUrl: () => string
  /** Само за тестовия harness — по подразбиране window.fetch. */
  fetchImpl?: typeof fetch
  /** Брой забрани на страница (по подразбиране 20). */
  pageSize?: number
}

export const CO_PLAY_MAX_DURATION_DAYS = 3650
export const CO_PLAY_MAX_REASON_LENGTH = 500
const MS_PER_DAY = 24 * 60 * 60 * 1000
const AUDIT_PAGE_SIZE = 50
const SEARCH_MIN_LENGTH = 2
const SEARCH_DEBOUNCE_MS = 300

export const CO_PLAY_STATUS_LABELS: Record<CoPlayRestrictionStatus, string> = {
  active: 'Активна',
  pending_activation: 'Изчаква активиране',
  expired: 'Изтекла',
  lifted: 'Отменена',
}

const STATUS_COLORS: Record<CoPlayRestrictionStatus, { fg: string; bg: string }> = {
  active: { fg: '#fca5a5', bg: 'rgba(248,113,113,0.12)' },
  pending_activation: { fg: '#fde68a', bg: 'rgba(251,191,36,0.12)' },
  expired: { fg: 'rgba(226,232,240,0.72)', bg: 'rgba(148,163,184,0.12)' },
  lifted: { fg: '#93c5fd', bg: 'rgba(96,165,250,0.12)' },
}

const FILTERS: Array<[CoPlayRestrictionStatus | 'all', string]> = [
  ['all', 'Всички'],
  ['active', 'Активни'],
  ['pending_activation', 'Изчакващи активиране'],
  ['expired', 'Изтекли'],
  ['lifted', 'Отменени'],
]

const TOURNAMENT_STATUS_LABELS: Record<string, string> = {
  open: 'Записване',
  starting: 'Стартира',
  semifinal_in_progress: 'Полуфинал',
  final_in_progress: 'Финал',
  finished: 'Приключил',
  cancelled: 'Отменен',
  admin_cancelled: 'Отменен от администратор',
  auto_cancelled: 'Отменен автоматично',
  failed: 'Неуспешен',
}

export const CO_PLAY_AUDIT_ACTION_LABELS: Record<string, string> = {
  impose: 'Налагане',
  activate: 'Автоматично активиране',
  lift: 'Отмяна',
  close_expired: 'Изтичане',
  settings_update: 'Глобален превключвател',
  enforcement_removed: 'Прилагане: премахване от чакалня/маса',
  tournament_conflict_detected: 'Засечен конфликт в турнир',
}

const ENFORCEMENT_CONTEXT_LABELS: Record<string, string> = {
  matchmaking: 'Случайна маса',
  private_room: 'Частна маса',
}

const ENFORCEMENT_TRIGGER_LABELS: Record<string, string> = {
  restriction_imposed: 'при налагане на забрана',
  flag_enabled: 'при включване на системата',
  restriction_activated: 'при активиране на забрана',
  pre_start: 'при проверка преди старт',
}

const IMPOSE_ERROR_TEXTS: Record<string, string> = {
  invalid_profiles: 'Изберете два профила.',
  same_profile: 'Избран е два пъти един и същ профил. Изберете два различни профила.',
  profile_not_found: 'Някой от избраните профили не беше намерен (възможно е да е изтрит).',
  profile_not_eligible: 'Забрана може да се наложи само между профили на регистрирани акаунти (не на бот или гост).',
  same_account: 'Двата профила са от един и същ потребителски акаунт.',
  invalid_reason: `Причината е задължителна (до ${CO_PLAY_MAX_REASON_LENGTH} знака).`,
  invalid_duration: `Срокът трябва да е цяло число дни от 1 до ${CO_PLAY_MAX_DURATION_DAYS} или безсрочен.`,
  invalid_game: 'Невалидна игра.',
  already_restricted: 'Между двата акаунта вече има активна или изчакваща забрана.',
}

const LIFT_ERROR_TEXTS: Record<string, string> = {
  not_found: 'Забраната не беше намерена.',
  not_active: 'Забраната вече не е активна (изтекла или отменена). Списъкът е обновен.',
  invalid_reason: `Причината за отмяна е до ${CO_PLAY_MAX_REASON_LENGTH} знака.`,
}

export const CO_PLAY_FLAG_OFF_TEXT = 'Системата е изключена. Записаните забрани не се прилагат в игрите.'
export const CO_PLAY_PENDING_TEXTS = [
  'Забраната ще се активира автоматично, когато общото участие в незавършилите турнири приключи.',
  'Срокът на наказанието започва да тече от момента на активиране.',
] as const
export const CO_PLAY_SCOPE_NOTE = 'Забраната обхваща всички профили на двата потребителски акаунта.'

const HOST_ID = 'admin-co-play-restrictions-panel'
const DIALOG_ID = 'admin-co-play-restrictions-dialog'

const BTN_PRIMARY = 'min-height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;font-family:inherit;'
const BTN_SECONDARY = 'min-height:40px;padding:0 14px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;'
const BTN_SMALL = 'min-height:34px;padding:0 12px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;'
const BTN_DANGER = 'min-height:34px;padding:0 12px;border:1px solid rgba(248,113,113,0.55);border-radius:8px;background:rgba(248,113,113,0.12);color:#fecaca;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;'
const INPUT_STYLE = 'min-height:40px;box-sizing:border-box;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#f8fafc;font-size:15px;font-family:inherit;'
const LABEL_STYLE = 'display:block;margin:0 0 6px;font-size:13px;font-weight:800;color:#f8fafc;'
const CARD_STYLE = 'margin:0 0 14px;padding:14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Българско време (Europe/Sofia), както в останалия админ панел. */
export function formatCoPlayDate(iso: string | null | undefined): string {
  if (typeof iso !== 'string') return '—'
  const parsed = new Date(iso)
  if (!Number.isFinite(parsed.getTime())) return '—'
  return parsed.toLocaleString('bg-BG', {
    timeZone: 'Europe/Sofia',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function pluralDays(days: number): string {
  return days === 1 ? '1 ден' : `${days} дни`
}

export function formatCoPlayDuration(durationDays: number | null, isIndefinite: boolean): string {
  if (isIndefinite || durationDays === null) return 'Безсрочно'
  return pluralDays(durationDays)
}

/** Оставащ срок само за активна забрана със срок (никога за изчакваща). */
export function formatCoPlayRemaining(view: Pick<CoPlayRestrictionView, 'status' | 'expiresAt' | 'isIndefinite'>, nowMs: number): string {
  if (view.status !== 'active') return '—'
  if (view.isIndefinite || view.expiresAt === null) return 'Безсрочно'
  const remaining = Date.parse(view.expiresAt) - nowMs
  if (!Number.isFinite(remaining)) return '—'
  if (remaining <= 0) return 'Изтича сега'
  const days = Math.floor(remaining / MS_PER_DAY)
  const hours = Math.floor((remaining % MS_PER_DAY) / 3_600_000)
  if (days > 0) return `${pluralDays(days)}${hours > 0 ? ` и ${hours} ч` : ''}`
  const minutes = Math.max(1, Math.floor((remaining % 3_600_000) / 60_000))
  return hours > 0 ? `${hours} ч и ${minutes} мин` : `${minutes} мин`
}

function tournamentStatusLabel(status: string | null): string {
  if (status === null) return 'Неизвестен статус'
  return TOURNAMENT_STATUS_LABELS[status] ?? status
}

function profileName(ref: CoPlayRestrictionProfileRef): string {
  const current = ref.currentDisplayName
  if (current === null) {
    return `${escapeHtml(ref.displayNameSnapshot)} <span style="color:rgba(226,232,240,0.55);font-weight:600;">(изтрит профил)</span>`
  }
  if (current !== ref.displayNameSnapshot) {
    return `${escapeHtml(current)} <span style="color:rgba(226,232,240,0.55);font-weight:600;">(при налагане: ${escapeHtml(ref.displayNameSnapshot)})</span>`
  }
  return escapeHtml(current)
}

function plainProfileName(ref: CoPlayRestrictionProfileRef): string {
  return ref.currentDisplayName ?? ref.displayNameSnapshot
}

function field(label: string, valueHtml: string, key?: string): string {
  return `<div style="min-width:0;"${key ? ` data-co-play-field="${key}"` : ''}><div style="font-size:11px;letter-spacing:0.04em;text-transform:uppercase;color:rgba(226,232,240,0.55);">${escapeHtml(label)}</div><div style="font-size:13px;color:#f1f5f9;overflow-wrap:anywhere;line-height:1.4;">${valueHtml}</div></div>`
}

function statusBadge(status: CoPlayRestrictionStatus): string {
  const color = STATUS_COLORS[status]
  return `<span data-co-play-status-badge="${status}" style="display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid ${color.fg};background:${color.bg};color:${color.fg};font-size:12px;font-weight:900;white-space:nowrap;">${escapeHtml(CO_PLAY_STATUS_LABELS[status])}</span>`
}

function avatarHtml(name: string, avatarUrl: string | null, size: number): string {
  const letter = escapeHtml((name.trim().slice(0, 1) || '?').toUpperCase())
  return `<span style="width:${size}px;height:${size}px;flex:0 0 auto;border-radius:999px;overflow:hidden;background:#1f1f1f;border:1px solid rgba(212,165,32,0.45);display:inline-flex;align-items:center;justify-content:center;color:#d4a520;font-size:${Math.round(size * 0.42)}px;font-weight:900;">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : letter}</span>`
}

function describeAuditDetails(entry: CoPlayRestrictionAuditView): string {
  const d = entry.details ?? {}
  const parts: string[] = []
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  switch (entry.action) {
    case 'impose': {
      const days = num(d.durationDays)
      parts.push(`Срок: ${days === null ? 'безсрочно' : pluralDays(days)}`)
      if (d.status === 'pending_activation') parts.push('изчаква активиране (общ незавършил турнир)')
      const reason = str(d.reason)
      if (reason !== null) parts.push(`Причина: ${reason}`)
      break
    }
    case 'activate': {
      const days = num(d.durationDays)
      parts.push(`Срок: ${days === null ? 'безсрочно' : pluralDays(days)}`)
      const expiresAt = str(d.expiresAt)
      if (expiresAt !== null) parts.push(`изтича на ${formatCoPlayDate(expiresAt)}`)
      break
    }
    case 'lift': {
      const previous = str(d.previousStatus)
      if (previous !== null && previous in CO_PLAY_STATUS_LABELS) parts.push(`Предишен статус: ${CO_PLAY_STATUS_LABELS[previous as CoPlayRestrictionStatus]}`)
      const reason = str(d.reason)
      parts.push(reason !== null ? `Причина: ${reason}` : 'Без посочена причина')
      break
    }
    case 'close_expired': {
      const expiresAt = str(d.expiresAt)
      if (expiresAt !== null) parts.push(`Изтекла на ${formatCoPlayDate(expiresAt)}`)
      break
    }
    case 'settings_update':
      if (typeof d.to === 'boolean') parts.push(d.to ? 'Системата е включена' : 'Системата е изключена')
      break
    case 'enforcement_removed': {
      const context = str(d.context)
      const trigger = str(d.trigger)
      if (context !== null) parts.push(ENFORCEMENT_CONTEXT_LABELS[context] ?? context)
      if (trigger !== null) parts.push(ENFORCEMENT_TRIGGER_LABELS[trigger] ?? trigger)
      const stake = num(d.stake)
      if (stake !== null) parts.push(`залог ${stake}`)
      if (d.stakeRefunded === true) parts.push('залогът е възстановен')
      break
    }
    case 'tournament_conflict_detected': {
      const tournamentId = str(d.tournamentId)
      if (tournamentId !== null) parts.push(`Турнир ${tournamentId.slice(0, 8)}`)
      parts.push('стартът не е спрян')
      break
    }
    default:
      break
  }
  return parts.map(escapeHtml).join(' · ')
}

export function showAdminCoPlayRestrictionsPanel(deps: AdminCoPlayRestrictionsPanelDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  document.getElementById(DIALOG_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const doFetch: typeof fetch = deps.fetchImpl ?? ((input, init) => window.fetch(input, init))
  const pageSize = deps.pageSize ?? 20
  const apiBase = () => `${deps.getApiBaseUrl()}/api/admin/co-play-restrictions`

  type ApiResult = { status: number; body: any }
  const api = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<ApiResult> => {
    try {
      const response = await doFetch(`${apiBase()}${path}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const data = await response.json().catch(() => null)
      return { status: response.status, body: data }
    } catch {
      return { status: 0, body: null }
    }
  }
  const failureText = (result: ApiResult, fallback: string): string => {
    if (result.status === 0) return 'Няма връзка със сървъра.'
    if (result.status === 401) return 'Сесията е изтекла. Влезте отново.'
    if (result.status === 403) return typeof result.body?.message === 'string' ? result.body.message : 'Само администратор има достъп.'
    return typeof result.body?.message === 'string' && result.body.message !== '' ? result.body.message : fallback
  }

  // ─── Състояние ─────────────────────────────────────────────────────────
  let activeTab: 'list' | 'create' | 'audit' = 'list'
  let settings: CoPlayRestrictionSettings | null = null
  let settingsError: string | null = null
  let settingsConflicts: CoPlayTournamentConflict[] | null = null
  let settingsConflictMessage: string | null = null

  let filter: CoPlayRestrictionStatus | 'all' = 'all'
  let query = ''
  let page = 0
  let items: CoPlayRestrictionView[] = []
  let total = 0
  let listLoading = false
  let listError: string | null = null
  let listSeq = 0
  const historyOpen = new Set<string>()
  const historyCache = new Map<string, CoPlayRestrictionAuditView[] | 'loading' | { error: string }>()

  let auditItems: CoPlayRestrictionAuditView[] = []
  let auditTotal = 0
  let auditPage = 0
  let auditLoading = false
  let auditError: string | null = null
  let auditFilterId: string | null = null
  let auditFilterRestriction: CoPlayRestrictionView | null = null
  let auditSeq = 0
  let auditLoaded = false

  const picks: [SearchProfile | null, SearchProfile | null] = [null, null]
  let submitBusy = false

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:200000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  const tabButton = (tab: 'list' | 'create' | 'audit', label: string) =>
    `<button type="button" role="tab" data-co-play-tab="${tab}" style="min-height:38px;padding:0 14px;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:transparent;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;">${escapeHtml(label)}</button>`

  host.innerHTML = `
    <div style="min-height:100%;display:flex;justify-content:center;padding:12px;box-sizing:border-box;">
      <section role="dialog" aria-modal="true" aria-labelledby="admin-co-play-title" data-co-play-panel="1"
        style="width:min(100%,1000px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:#111111;box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:16px;align-self:flex-start;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;">
          <h2 id="admin-co-play-title" style="margin:0;font-size:20px;font-weight:900;color:#d4a520;letter-spacing:0.02em;line-height:1.25;">Забрани за съвместна игра</h2>
          <button type="button" data-co-play-close="1" aria-label="Затвори" style="${BTN_SECONDARY}">Затвори</button>
        </div>
        <div data-co-play-settings="1" style="${CARD_STYLE}"></div>
        <div role="tablist" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;">
          ${tabButton('list', 'Забрани')}
          ${tabButton('create', 'Нова забрана')}
          ${tabButton('audit', 'Одит')}
        </div>
        <div data-co-play-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 12px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:1.5;"></div>
        <div data-co-play-tab-panel="list"></div>
        <div data-co-play-tab-panel="create" style="display:none;"></div>
        <div data-co-play-tab-panel="audit" style="display:none;"></div>
      </section>
    </div>`

  const settingsEl = host.querySelector<HTMLElement>('[data-co-play-settings="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-co-play-notice="1"]')!
  const listPanel = host.querySelector<HTMLElement>('[data-co-play-tab-panel="list"]')!
  const createPanel = host.querySelector<HTMLElement>('[data-co-play-tab-panel="create"]')!
  const auditPanel = host.querySelector<HTMLElement>('[data-co-play-tab-panel="audit"]')!

  const showNotice = (html: string | null, tone: 'ok' | 'warn' | 'error' = 'ok') => {
    if (html === null) { noticeEl.style.display = 'none'; noticeEl.innerHTML = ''; noticeEl.removeAttribute('data-tone'); return }
    noticeEl.innerHTML = html
    noticeEl.setAttribute('data-tone', tone)
    noticeEl.style.display = ''
    const palette = tone === 'ok'
      ? ['rgba(134,239,172,0.35)', 'rgba(134,239,172,0.08)', '#dcfce7']
      : tone === 'warn'
        ? ['rgba(251,191,36,0.45)', 'rgba(251,191,36,0.08)', '#fde68a']
        : ['rgba(248,113,113,0.45)', 'rgba(248,113,113,0.08)', '#fecaca']
    noticeEl.style.border = `1px solid ${palette[0]}`
    noticeEl.style.background = palette[1]!
    noticeEl.style.color = palette[2]!
  }

  // ─── Глобален превключвател ─────────────────────────────────────────────
  const renderSettings = () => {
    if (settings === null) {
      settingsEl.innerHTML = settingsError !== null
        ? `<div data-co-play-settings-error="1" style="font-size:13px;color:#fecaca;">${escapeHtml(settingsError)}</div>
           <button type="button" data-co-play-settings-retry="1" style="${BTN_SMALL};margin-top:8px;">Опитай отново</button>`
        : `<div style="font-size:13px;color:rgba(226,232,240,0.7);">Зареждане на настройката…</div>`
      return
    }
    const on = settings.enabled
    const conflicts = settingsConflicts !== null && settingsConflicts.length > 0
      ? `<div data-co-play-settings-conflicts="1" role="alert" style="margin-top:12px;padding:10px 12px;border-radius:8px;border:1px solid rgba(248,113,113,0.45);background:rgba(248,113,113,0.08);color:#fecaca;font-size:13px;line-height:1.5;">
          <div style="font-weight:900;margin-bottom:4px;">Системата НЕ беше включена.</div>
          <div style="margin-bottom:6px;">${escapeHtml(settingsConflictMessage ?? 'Има активни забрани между участници в общ незапочнал турнир.')}</div>
          <ul style="margin:0;padding-left:18px;">
            ${settingsConflicts.map((c) => `<li data-co-play-conflict-tournament="${escapeHtml(c.tournamentId)}">${escapeHtml(c.tournamentName ?? `Турнир ${c.tournamentId.slice(0, 8)}`)} — ${escapeHtml(tournamentStatusLabel(c.tournamentStatus))} <span style="color:rgba(254,202,202,0.7);">(забрана ${escapeHtml(c.restrictionId.slice(0, 8))})</span></li>`).join('')}
          </ul>
          <div style="margin-top:6px;color:rgba(254,202,202,0.85);">Никой не е премахнат автоматично. Системата може да бъде включена след приключване на тези турнири или след отмяна на съответните забрани.</div>
        </div>`
      : ''
    settingsEl.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;">
        <div style="min-width:0;">
          <div style="font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:rgba(226,232,240,0.6);margin-bottom:4px;">Системата за забрани</div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span data-co-play-flag-state="${on ? 'on' : 'off'}" style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;font-size:14px;font-weight:900;border:1px solid ${on ? 'rgba(134,239,172,0.6)' : 'rgba(248,113,113,0.6)'};background:${on ? 'rgba(134,239,172,0.12)' : 'rgba(248,113,113,0.12)'};color:${on ? '#bbf7d0' : '#fecaca'};">
              <span aria-hidden="true" style="width:9px;height:9px;border-radius:999px;background:${on ? '#4ade80' : '#f87171'};"></span>${on ? 'Включена' : 'Изключена'}
            </span>
            ${settings.updatedAt !== null ? `<span style="font-size:12px;color:rgba(226,232,240,0.55);">последна промяна: ${escapeHtml(formatCoPlayDate(settings.updatedAt))}</span>` : ''}
          </div>
        </div>
        <button type="button" data-co-play-flag-toggle="${on ? 'off' : 'on'}" style="${on ? BTN_SECONDARY : BTN_PRIMARY}">${on ? 'Изключи системата' : 'Включи системата'}</button>
      </div>
      ${on ? '' : `<div data-co-play-flag-off-note="1" style="margin-top:10px;padding:8px 10px;border-radius:8px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.08);color:#fde68a;font-size:13px;line-height:1.5;">${escapeHtml(CO_PLAY_FLAG_OFF_TEXT)}</div>`}
      ${settingsError !== null ? `<div data-co-play-settings-error="1" role="alert" style="margin-top:10px;font-size:13px;color:#fecaca;">${escapeHtml(settingsError)}</div>` : ''}
      ${conflicts}`
  }

  const loadSettings = async () => {
    const result = await api('GET', '/settings')
    if (!host.isConnected) return
    if (result.status === 200 && result.body?.ok === true && typeof result.body.settings?.enabled === 'boolean') {
      settings = result.body.settings as CoPlayRestrictionSettings
      settingsError = null
    } else {
      settingsError = failureText(result, 'Настройката не може да бъде заредена.')
    }
    renderSettings()
    renderList()
  }

  // ─── Диалози ────────────────────────────────────────────────────────────
  const closeDialog = () => {
    document.getElementById(DIALOG_ID)?.remove()
  }

  /**
   * Диалог за потвърждение. onConfirm връща null при успех (диалогът се
   * затваря) или текст на грешка (остава отворен). Докато чака — бутоните
   * са неактивни и Escape/backdrop не го затварят (без двойно изпращане).
   */
  const openConfirmDialog = (input: {
    key: string
    title: string
    bodyHtml: string
    confirmLabel: string
    danger?: boolean
    withReason?: { label: string; optional: boolean }
    onConfirm: (reason: string) => Promise<string | null>
  }) => {
    closeDialog()
    // Нова операция (превключвател / отмяна): старото съобщение се изчиства.
    showNotice(null)
    const dialogHost = document.createElement('div')
    dialogHost.id = DIALOG_ID
    dialogHost.setAttribute('data-co-play-dialog', input.key)
    dialogHost.style.cssText = 'position:fixed;inset:0;z-index:210000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.6);font-family:Arial,Helvetica,sans-serif;'
    dialogHost.innerHTML = `
      <div data-co-play-dialog-backdrop="1" style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:14px;box-sizing:border-box;">
        <div role="dialog" aria-modal="true" aria-labelledby="admin-co-play-dialog-title"
          style="width:min(100%,500px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.45);background:#151515;box-shadow:0 34px 80px rgba(0,0,0,0.55);padding:18px;">
          <h3 id="admin-co-play-dialog-title" style="margin:0 0 12px;font-size:18px;font-weight:900;color:#f8fafc;">${escapeHtml(input.title)}</h3>
          <div style="font-size:14px;line-height:1.5;color:rgba(226,232,240,0.88);margin-bottom:12px;">${input.bodyHtml}</div>
          ${input.withReason ? `
            <label for="admin-co-play-dialog-reason" style="${LABEL_STYLE}">${escapeHtml(input.withReason.label)}${input.withReason.optional ? ' <span style="font-weight:600;color:rgba(226,232,240,0.55);">(по желание)</span>' : ''}</label>
            <textarea id="admin-co-play-dialog-reason" data-co-play-dialog-reason="1" maxlength="${CO_PLAY_MAX_REASON_LENGTH}" rows="3"
              style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#f8fafc;font-size:15px;font-family:inherit;resize:vertical;"></textarea>
            <div style="text-align:right;margin:4px 0 10px;font-size:12px;color:rgba(226,232,240,0.55);" data-co-play-dialog-counter="1">0/${CO_PLAY_MAX_REASON_LENGTH}</div>` : ''}
          <div data-co-play-dialog-error="1" role="alert" style="display:none;margin:0 0 12px;font-size:13px;line-height:1.5;color:#fca5a5;"></div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end;">
            <button type="button" data-co-play-dialog-cancel="1" style="${BTN_SECONDARY}">Назад</button>
            <button type="button" data-co-play-dialog-confirm="1" style="${input.danger ? BTN_DANGER.replace('min-height:34px', 'min-height:40px') : BTN_PRIMARY}">${escapeHtml(input.confirmLabel)}</button>
          </div>
        </div>
      </div>`
    document.body.appendChild(dialogHost)
    const confirmEl = dialogHost.querySelector<HTMLButtonElement>('[data-co-play-dialog-confirm="1"]')!
    const cancelEl = dialogHost.querySelector<HTMLButtonElement>('[data-co-play-dialog-cancel="1"]')!
    const errorEl = dialogHost.querySelector<HTMLElement>('[data-co-play-dialog-error="1"]')!
    const reasonEl = dialogHost.querySelector<HTMLTextAreaElement>('[data-co-play-dialog-reason="1"]')
    const counterEl = dialogHost.querySelector<HTMLElement>('[data-co-play-dialog-counter="1"]')
    let busy = false
    reasonEl?.addEventListener('input', () => {
      if (counterEl !== null) counterEl.textContent = `${reasonEl.value.length}/${CO_PLAY_MAX_REASON_LENGTH}`
    })
    cancelEl.addEventListener('click', () => { if (!busy) closeDialog() })
    dialogHost.addEventListener('click', (event) => {
      if (busy) return
      if ((event.target as HTMLElement).getAttribute('data-co-play-dialog-backdrop') === '1') closeDialog()
    })
    confirmEl.addEventListener('click', () => {
      if (busy) return
      const reason = reasonEl?.value.trim() ?? ''
      if (reasonEl !== null && reasonEl.value.length > CO_PLAY_MAX_REASON_LENGTH) {
        errorEl.textContent = `Причината е до ${CO_PLAY_MAX_REASON_LENGTH} знака.`
        errorEl.style.display = ''
        return
      }
      busy = true
      dialogHost.setAttribute('data-busy', '1')
      confirmEl.disabled = true
      cancelEl.disabled = true
      if (reasonEl !== null) reasonEl.disabled = true
      confirmEl.style.opacity = '0.6'
      const originalLabel = confirmEl.textContent
      confirmEl.textContent = 'Изпращане…'
      errorEl.style.display = 'none'
      void input.onConfirm(reason).then((error) => {
        if (error === null) {
          closeDialog()
          return
        }
        busy = false
        dialogHost.removeAttribute('data-busy')
        confirmEl.disabled = false
        cancelEl.disabled = false
        if (reasonEl !== null) reasonEl.disabled = false
        confirmEl.style.opacity = '1'
        confirmEl.textContent = originalLabel
        errorEl.textContent = error
        errorEl.style.display = ''
      })
    })
    ;(reasonEl ?? confirmEl).focus()
  }

  const openFlagDialog = (enable: boolean) => {
    if (settings === null) return
    openConfirmDialog({
      key: enable ? 'flag-on' : 'flag-off',
      title: enable ? 'Включване на системата' : 'Изключване на системата',
      bodyHtml: enable
        ? `<p style="margin:0 0 8px;">Записаните <b>активни</b> забрани ще започнат да се прилагат в случайните маси, частните маси, повторните мачове и турнирните регистрации.</p>
           <p style="margin:0 0 8px;">Ако двама ограничени играчи в момента чакат на една и съща незапочнала маса, по-късно влезлият ще бъде изведен от нея (създателят на частна маса остава; удържан залог се възстановява). Започнатите игри и турнири не се прекъсват.</p>
           <p style="margin:0;">Изчакващите забрани ще спрат нови общи турнирни регистрации.</p>`
        : `<p style="margin:0 0 8px;">Записаните забрани и историята им се запазват, но <b>няма да се прилагат</b> в игрите, докато системата не бъде включена отново.</p>
           <p style="margin:0;">Изчакващите забрани също няма да ограничават турнирните регистрации.</p>`,
      confirmLabel: enable ? 'Включи системата' : 'Изключи системата',
      danger: !enable,
      onConfirm: async () => {
        const result = await api('PUT', '/settings', { enabled: enable })
        if (!host.isConnected) return null
        if (result.status === 200 && result.body?.ok === true && typeof result.body.settings?.enabled === 'boolean') {
          settings = result.body.settings as CoPlayRestrictionSettings
          settingsError = null
          settingsConflicts = null
          settingsConflictMessage = null
          renderSettings()
          renderList()
          if (settings.enabled === enable) {
            showNotice(escapeHtml(enable ? 'Системата е включена. Активните забрани се прилагат.' : 'Системата е изключена. Записаните забрани не се прилагат в игрите.'), 'ok')
          }
          if (auditLoaded) void loadAudit()
          return null
        }
        if (result.status === 409 && result.body?.code === 'tournament_conflicts') {
          // Отказ: флагът остава какъвто е на сървъра (settings от отговора).
          if (typeof result.body.settings?.enabled === 'boolean') settings = result.body.settings as CoPlayRestrictionSettings
          settingsConflicts = Array.isArray(result.body.conflicts) ? (result.body.conflicts as CoPlayTournamentConflict[]) : []
          settingsConflictMessage = typeof result.body.message === 'string' ? result.body.message : null
          settingsError = null
          renderSettings()
          renderList()
          showNotice(null)
          return null
        }
        return failureText(result, 'Настройката не беше променена.')
      },
    })
  }

  // ─── Списък ─────────────────────────────────────────────────────────────
  const renderHistory = (restrictionId: string): string => {
    if (!historyOpen.has(restrictionId)) return ''
    const entry = historyCache.get(restrictionId)
    let content: string
    if (entry === undefined || entry === 'loading') content = '<div style="color:rgba(226,232,240,0.7);">Зареждане…</div>'
    else if ('error' in entry) content = `<div style="color:#fecaca;">${escapeHtml(entry.error)}</div>`
    else if (entry.length === 0) content = '<div style="color:rgba(226,232,240,0.7);">Няма записи.</div>'
    else content = `<ol style="margin:0;padding-left:18px;">${entry.map((a) => `<li data-co-play-history-entry="${escapeHtml(a.action)}" style="margin:0 0 4px;">${escapeHtml(formatCoPlayDate(a.createdAt))} — <b>${escapeHtml(CO_PLAY_AUDIT_ACTION_LABELS[a.action] ?? a.action)}</b>${a.actorDisplayName !== null ? ` · ${escapeHtml(a.actorDisplayName)}` : a.actorProfileId === null ? ' · системата' : ''}${describeAuditDetails(a) !== '' ? ` · <span style="color:rgba(226,232,240,0.75);">${describeAuditDetails(a)}</span>` : ''}</li>`).join('')}</ol>`
    return `<div data-co-play-history="${escapeHtml(restrictionId)}" style="margin-top:10px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.25);font-size:12px;line-height:1.5;color:#e2e8f0;">${content}</div>`
  }

  const renderRow = (view: CoPlayRestrictionView): string => {
    const nowMs = Date.now()
    const [a, b] = view.profiles
    const flagOff = settings !== null && !settings.enabled
    const fields: string[] = []
    fields.push(field('Причина', escapeHtml(view.reason), 'reason'))
    fields.push(field('Наложена от', escapeHtml(view.createdByDisplayName ?? (view.createdByProfileId === null ? '—' : 'Изтрит профил')), 'created-by'))
    fields.push(field('Наложена на', escapeHtml(formatCoPlayDate(view.createdAt)), 'created-at'))
    fields.push(field('Активирана на', view.activatedAt === null ? '<span style="color:#fde68a;">Още не е активирана</span>' : escapeHtml(formatCoPlayDate(view.activatedAt)), 'activated-at'))
    fields.push(field(view.status === 'pending_activation' ? 'Заявен срок' : 'Срок', escapeHtml(formatCoPlayDuration(view.durationDays, view.isIndefinite)), 'duration'))
    // Изчакваща: няма дата на изтичане и оставащ срок (тече от активирането).
    fields.push(field('Изтича на', view.status === 'pending_activation'
      ? '<span style="color:rgba(226,232,240,0.6);">след активиране</span>'
      : escapeHtml(view.isIndefinite ? 'Безсрочно' : formatCoPlayDate(view.expiresAt)), 'expires-at'))
    fields.push(field('Оставащ срок', escapeHtml(formatCoPlayRemaining(view, nowMs)), 'remaining'))
    if (view.status === 'lifted') {
      fields.push(field('Отменена от', escapeHtml(view.liftedByDisplayName ?? (view.liftedByProfileId === null ? '—' : 'Изтрит профил')), 'lifted-by'))
      fields.push(field('Отменена на', escapeHtml(formatCoPlayDate(view.endedAt)), 'lifted-at'))
      fields.push(field('Причина за отмяна', view.liftReason !== null && view.liftReason !== '' ? escapeHtml(view.liftReason) : '<span style="color:rgba(226,232,240,0.6);">Не е посочена</span>', 'lift-reason'))
    }
    if (view.status === 'expired') {
      fields.push(field('Изтекла на', escapeHtml(formatCoPlayDate(view.endedAt ?? view.expiresAt)), 'expired-at'))
    }

    const pending = view.status === 'pending_activation' ? `
      <div data-co-play-pending="1" style="margin-top:10px;padding:10px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.07);font-size:13px;line-height:1.5;color:#fde68a;">
        <div style="font-weight:900;margin-bottom:4px;">Общи незавършили турнири</div>
        ${view.pendingTournaments.length > 0
          ? `<ul style="margin:0 0 6px;padding-left:18px;color:#fef3c7;">${view.pendingTournaments.map((t) => `<li data-co-play-pending-tournament="${escapeHtml(t.tournamentId)}">${escapeHtml(t.name ?? `Турнир ${t.tournamentId.slice(0, 8)}`)} — <span data-co-play-pending-tournament-status="1">${escapeHtml(tournamentStatusLabel(t.status))}</span></li>`).join('')}</ul>`
          : '<div style="margin:0 0 6px;color:#fef3c7;">Турнирите вече не са налични — забраната ще се активира при следващата проверка.</div>'}
        ${CO_PLAY_PENDING_TEXTS.map((text) => `<div>${escapeHtml(text)}</div>`).join('')}
      </div>` : ''

    const enforcement = flagOff && (view.status === 'active' || view.status === 'pending_activation')
      ? `<span data-co-play-not-enforced="1" style="display:inline-block;padding:3px 9px;border-radius:999px;border:1px dashed rgba(251,191,36,0.6);color:#fde68a;font-size:11px;font-weight:800;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;">Не се прилага — системата е изключена</span>`
      : ''
    const canLift = view.status === 'active' || view.status === 'pending_activation'

    return `
      <li data-co-play-row="${escapeHtml(view.restrictionId)}" data-co-play-row-status="${view.status}"
        style="list-style:none;${CARD_STYLE}margin-bottom:10px;">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
          <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:15px;font-weight:800;color:#f8fafc;min-width:0;overflow-wrap:anywhere;">
            <span data-co-play-profile-a="1">${profileName(a)}</span>
            <span aria-hidden="true" style="color:#d4a520;">⇄</span>
            <span data-co-play-profile-b="1">${profileName(b)}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">${statusBadge(view.status)}${enforcement}</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 14px;">${fields.join('')}</div>
        ${pending}
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;">
          <div style="font-size:11px;color:rgba(226,232,240,0.45);overflow-wrap:anywhere;min-width:0;">ID ${escapeHtml(view.restrictionId)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">
            <button type="button" data-co-play-history-toggle="${escapeHtml(view.restrictionId)}" aria-expanded="${historyOpen.has(view.restrictionId) ? 'true' : 'false'}" style="${BTN_SMALL}">${historyOpen.has(view.restrictionId) ? 'Скрий историята' : 'История'}</button>
            ${canLift ? `<button type="button" data-co-play-lift-open="${escapeHtml(view.restrictionId)}" style="${BTN_DANGER}">Отмени забраната</button>` : ''}
          </div>
        </div>
        ${renderHistory(view.restrictionId)}
      </li>`
  }

  const renderListShell = () => {
    listPanel.innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px;" role="group" aria-label="Филтър по статус">
        ${FILTERS.map(([value, label]) => `<button type="button" data-co-play-filter="${value}" aria-pressed="false" style="min-height:34px;padding:0 12px;border-radius:999px;border:1px solid rgba(255,255,255,0.22);background:transparent;color:#f8fafc;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;">${escapeHtml(label)}</button>`).join('')}
      </div>
      <form data-co-play-search-form="1" style="display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px;">
        <input type="search" data-co-play-search="1" placeholder="Търсене по ник" aria-label="Търсене по ник" maxlength="64" style="${INPUT_STYLE};flex:1 1 220px;min-width:0;">
        <button type="submit" style="${BTN_SECONDARY}">Търси</button>
        <button type="button" data-co-play-refresh="1" style="${BTN_SECONDARY}">Обнови</button>
      </form>
      <div data-co-play-list-summary="1" style="font-size:12px;color:rgba(226,232,240,0.55);margin-bottom:8px;"></div>
      <ul data-co-play-list="1" style="margin:0;padding:0;"></ul>
      <div data-co-play-pagination="1" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;margin-top:6px;"></div>`
  }

  const renderList = () => {
    const listEl = listPanel.querySelector<HTMLElement>('[data-co-play-list="1"]')
    const summaryEl = listPanel.querySelector<HTMLElement>('[data-co-play-list-summary="1"]')
    const paginationEl = listPanel.querySelector<HTMLElement>('[data-co-play-pagination="1"]')
    if (listEl === null || summaryEl === null || paginationEl === null) return
    listPanel.querySelectorAll<HTMLButtonElement>('[data-co-play-filter]').forEach((button) => {
      const selected = button.getAttribute('data-co-play-filter') === filter
      button.setAttribute('aria-pressed', selected ? 'true' : 'false')
      button.style.background = selected ? 'rgba(212,165,32,0.18)' : 'transparent'
      button.style.borderColor = selected ? 'rgba(212,165,32,0.7)' : 'rgba(255,255,255,0.22)'
      button.style.color = selected ? '#f4c95b' : '#f8fafc'
    })
    if (listError !== null) {
      summaryEl.textContent = ''
      listEl.innerHTML = `<li data-co-play-list-error="1" style="list-style:none;padding:14px 0;color:#fecaca;font-size:14px;">${escapeHtml(listError)}</li>`
      paginationEl.innerHTML = ''
      return
    }
    if (listLoading && items.length === 0) {
      summaryEl.textContent = ''
      listEl.innerHTML = '<li style="list-style:none;padding:18px 0;color:rgba(226,232,240,0.7);font-size:14px;">Зареждане…</li>'
      paginationEl.innerHTML = ''
      return
    }
    const pages = Math.max(1, Math.ceil(total / pageSize))
    summaryEl.textContent = listLoading ? 'Обновяване…' : `Общо: ${total}${total > 0 ? ` · страница ${page + 1} от ${pages}` : ''}`
    listEl.innerHTML = items.length === 0
      ? `<li data-co-play-list-empty="1" style="list-style:none;padding:18px 0;color:rgba(226,232,240,0.7);font-size:14px;">Няма забрани по избраните критерии.</li>`
      : items.map(renderRow).join('')
    paginationEl.innerHTML = total > pageSize ? `
      <button type="button" data-co-play-page="prev" ${page === 0 ? 'disabled' : ''} style="${BTN_SMALL}${page === 0 ? 'opacity:0.4;cursor:not-allowed;' : ''}">← Предишна</button>
      <span style="font-size:13px;color:rgba(226,232,240,0.7);">${page + 1} / ${pages}</span>
      <button type="button" data-co-play-page="next" ${page + 1 >= pages ? 'disabled' : ''} style="${BTN_SMALL}${page + 1 >= pages ? 'opacity:0.4;cursor:not-allowed;' : ''}">Следваща →</button>` : ''
  }

  const loadList = async () => {
    const seq = ++listSeq
    listLoading = true
    listError = null
    renderList()
    const params = new URLSearchParams({ status: filter, limit: String(pageSize), offset: String(page * pageSize) })
    if (query !== '') params.set('q', query)
    const result = await api('GET', `?${params.toString()}`)
    if (seq !== listSeq || !host.isConnected) return
    listLoading = false
    if (result.status === 200 && result.body?.ok === true && Array.isArray(result.body.items)) {
      items = result.body.items as CoPlayRestrictionView[]
      total = typeof result.body.total === 'number' ? result.body.total : items.length
      // Страница след последната (напр. след отмяна) -> последната налична.
      if (items.length === 0 && page > 0 && total > 0) {
        page = Math.max(0, Math.ceil(total / pageSize) - 1)
        void loadList()
        return
      }
      if (typeof result.body.enabled === 'boolean' && settings !== null && settings.enabled !== result.body.enabled) {
        settings = { ...settings, enabled: result.body.enabled }
        renderSettings()
      }
    } else {
      items = []
      total = 0
      listError = failureText(result, 'Списъкът не може да бъде зареден.')
    }
    renderList()
  }

  const loadHistory = async (restrictionId: string) => {
    historyCache.set(restrictionId, 'loading')
    renderList()
    const result = await api('GET', `/audit?${new URLSearchParams({ restrictionId, limit: '100' }).toString()}`)
    if (!host.isConnected) return
    if (result.status === 200 && result.body?.ok === true && Array.isArray(result.body.items)) {
      historyCache.set(restrictionId, result.body.items as CoPlayRestrictionAuditView[])
    } else {
      historyCache.set(restrictionId, { error: failureText(result, 'Историята не може да бъде заредена.') })
    }
    renderList()
  }

  const openLiftDialog = (view: CoPlayRestrictionView) => {
    const [a, b] = view.profiles
    openConfirmDialog({
      key: 'lift',
      title: 'Отмяна на забраната',
      bodyHtml: `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 14px;margin-bottom:10px;">
          ${field('Първи профил', escapeHtml(plainProfileName(a)))}
          ${field('Втори профил', escapeHtml(plainProfileName(b)))}
          ${field('Статус', escapeHtml(CO_PLAY_STATUS_LABELS[view.status]))}
          ${field(view.status === 'pending_activation' ? 'Заявен срок' : 'Срок', escapeHtml(formatCoPlayDuration(view.durationDays, view.isIndefinite)))}
        </div>
        <div style="padding:8px 10px;border-radius:8px;border:1px solid rgba(251,191,36,0.35);background:rgba(251,191,36,0.08);color:#fde68a;font-size:13px;">След отмяната двата акаунта отново ще могат да играят на обща маса. Историята се запазва.</div>`,
      confirmLabel: 'Отмени забраната',
      danger: true,
      withReason: { label: 'Причина за отмяната', optional: true },
      onConfirm: async (reason) => {
        const result = await api('POST', `/${encodeURIComponent(view.restrictionId)}/lift`, reason !== '' ? { reason } : {})
        if (!host.isConnected) return null
        if (result.status === 200 && result.body?.ok === true) {
          historyCache.delete(view.restrictionId)
          showNotice(escapeHtml(`Забраната между ${plainProfileName(a)} и ${plainProfileName(b)} е отменена.`), 'ok')
          void loadList()
          if (auditLoaded) void loadAudit()
          return null
        }
        const code = typeof result.body?.code === 'string' ? result.body.code : null
        if (code === 'not_active' || code === 'not_found') void loadList()
        return code !== null && LIFT_ERROR_TEXTS[code] !== undefined ? LIFT_ERROR_TEXTS[code]! : failureText(result, 'Забраната не беше отменена.')
      },
    })
  }

  // ─── Нова забрана ───────────────────────────────────────────────────────
  const renderPickerSlot = (index: 0 | 1): string => {
    const label = index === 0 ? 'Първи профил' : 'Втори профил'
    const pick = picks[index]
    if (pick !== null) {
      return `
        <div data-co-play-picker="${index}" style="min-width:0;">
          <div style="${LABEL_STYLE}">${label}</div>
          <div data-co-play-picked="${escapeHtml(pick.profileId)}" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid rgba(212,165,32,0.45);background:rgba(212,165,32,0.06);">
            ${avatarHtml(pick.displayName, pick.avatarUrl, 40)}
            <div style="min-width:0;flex:1 1 auto;">
              <div data-co-play-picked-name="1" style="font-size:15px;font-weight:900;color:#f8fafc;overflow-wrap:anywhere;">${escapeHtml(pick.displayName)}</div>
              ${pick.level !== null ? `<div style="font-size:12px;color:rgba(226,232,240,0.6);">Ниво ${pick.level}</div>` : ''}
            </div>
            <button type="button" data-co-play-pick-change="${index}" style="${BTN_SMALL}">Смени</button>
          </div>
        </div>`
    }
    return `
      <div data-co-play-picker="${index}" style="min-width:0;position:relative;">
        <label for="co-play-search-${index}" style="${LABEL_STYLE}">${label}</label>
        <input id="co-play-search-${index}" type="search" autocomplete="off" data-co-play-pick-search="${index}" placeholder="Търсене по ник (поне ${SEARCH_MIN_LENGTH} знака)" maxlength="64" style="${INPUT_STYLE};width:100%;">
        <div data-co-play-pick-results="${index}" style="margin-top:6px;"></div>
      </div>`
  }

  const renderCreate = () => {
    createPanel.innerHTML = `
      <form data-co-play-create-form="1" novalidate style="${CARD_STYLE}">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:14px;margin-bottom:14px;">
          ${renderPickerSlot(0)}
          ${renderPickerSlot(1)}
        </div>
        <div data-co-play-scope-note="1" style="margin:0 0 14px;padding:8px 10px;border-radius:8px;border:1px solid rgba(147,197,253,0.35);background:rgba(147,197,253,0.07);color:#dbeafe;font-size:13px;line-height:1.5;">${escapeHtml(CO_PLAY_SCOPE_NOTE)}</div>
        <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 18px;margin-bottom:14px;">
          <div>
            <label for="co-play-duration" style="${LABEL_STYLE}">Срок</label>
            <div style="display:flex;align-items:center;gap:8px;">
              <input id="co-play-duration" type="number" inputmode="numeric" min="1" max="${CO_PLAY_MAX_DURATION_DAYS}" step="1" data-co-play-duration="1" value="30" style="${INPUT_STYLE};width:110px;">
              <span style="font-size:15px;color:#f8fafc;font-weight:800;">дни</span>
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;min-height:40px;font-size:14px;font-weight:800;color:#f8fafc;cursor:pointer;">
            <input type="checkbox" data-co-play-indefinite="1" style="width:18px;height:18px;accent-color:#d4a520;cursor:pointer;"> Безсрочно
          </label>
        </div>
        <label for="co-play-reason" style="${LABEL_STYLE}">Причина за наказанието</label>
        <textarea id="co-play-reason" data-co-play-reason="1" maxlength="${CO_PLAY_MAX_REASON_LENGTH}" rows="3" placeholder="Задължително"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#f8fafc;font-size:15px;font-family:inherit;resize:vertical;"></textarea>
        <div style="display:flex;justify-content:space-between;gap:8px;margin:4px 0 12px;font-size:12px;color:rgba(226,232,240,0.55);">
          <span>Записва се в административния одит. Не се показва на играчите.</span>
          <span data-co-play-reason-counter="1">0/${CO_PLAY_MAX_REASON_LENGTH}</span>
        </div>
        <div data-co-play-create-error="1" role="alert" style="display:none;margin:0 0 12px;padding:8px 10px;border-radius:8px;border:1px solid rgba(248,113,113,0.45);background:rgba(248,113,113,0.08);font-size:13px;line-height:1.5;color:#fecaca;"></div>
        <div style="display:flex;justify-content:flex-end;">
          <button type="submit" data-co-play-submit="1" style="${BTN_PRIMARY}">Наложи забрана</button>
        </div>
      </form>`
    bindCreate()
  }

  const createErrorEl = () => createPanel.querySelector<HTMLElement>('[data-co-play-create-error="1"]')
  const setCreateError = (text: string | null) => {
    const el = createErrorEl()
    if (el === null) return
    if (text === null) { el.style.display = 'none'; el.textContent = ''; return }
    el.textContent = text
    el.style.display = ''
  }

  const searchControllers: [AbortController | null, AbortController | null] = [null, null]
  const searchTimers: [ReturnType<typeof setTimeout> | null, ReturnType<typeof setTimeout> | null] = [null, null]

  const renderSearchResults = (index: 0 | 1, html: string) => {
    const el = createPanel.querySelector<HTMLElement>(`[data-co-play-pick-results="${index}"]`)
    if (el !== null) el.innerHTML = html
  }

  let lastResults: [SearchProfile[], SearchProfile[]] = [[], []]

  const runSearch = async (index: 0 | 1, term: string) => {
    searchControllers[index]?.abort()
    const controller = new AbortController()
    searchControllers[index] = controller
    renderSearchResults(index, '<div style="font-size:13px;color:rgba(226,232,240,0.7);padding:4px 2px;">Търсене…</div>')
    try {
      const response = await doFetch(`${deps.getApiBaseUrl()}/api/players/search?q=${encodeURIComponent(term)}`, {
        method: 'GET', credentials: 'include', signal: controller.signal,
      })
      const data = await response.json().catch(() => null) as { ok?: boolean; players?: Array<Record<string, unknown>>; message?: string } | null
      if (controller.signal.aborted || !host.isConnected) return
      if (!response.ok || data?.ok !== true || !Array.isArray(data.players)) {
        renderSearchResults(index, `<div style="font-size:13px;color:#fecaca;padding:4px 2px;">${escapeHtml(data?.message ?? 'Търсенето не беше успешно.')}</div>`)
        return
      }
      const other = picks[index === 0 ? 1 : 0]
      const results: SearchProfile[] = data.players
        .filter((p) => typeof p.profileId === 'string' && p.isBot !== true)
        .map((p) => ({
          profileId: p.profileId as string,
          displayName: typeof p.displayName === 'string' ? p.displayName : '',
          avatarUrl: typeof p.avatarUrl === 'string' && p.avatarUrl !== '' ? p.avatarUrl : null,
          level: typeof p.level === 'number' ? p.level : null,
        }))
        .slice(0, 12)
      lastResults[index] = results
      renderSearchResults(index, results.length === 0
        ? '<div data-co-play-pick-empty="1" style="font-size:13px;color:rgba(226,232,240,0.7);padding:4px 2px;">Няма намерени профили.</div>'
        : `<ul role="listbox" style="margin:0;padding:0;max-height:260px;overflow-y:auto;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:#181818;">
            ${results.map((p) => {
              const isOther = other !== null && other.profileId === p.profileId
              return `<li role="option" style="list-style:none;">
                <button type="button" data-co-play-pick-option="${escapeHtml(p.profileId)}" data-co-play-pick-slot="${index}" ${isOther ? 'disabled' : ''}
                  style="display:flex;align-items:center;gap:10px;width:100%;min-height:48px;padding:6px 10px;border:0;border-bottom:1px solid rgba(255,255,255,0.06);background:transparent;color:#f8fafc;text-align:left;cursor:${isOther ? 'not-allowed' : 'pointer'};font-family:inherit;${isOther ? 'opacity:0.45;' : ''}">
                  ${avatarHtml(p.displayName, p.avatarUrl, 32)}
                  <span style="min-width:0;flex:1 1 auto;font-size:14px;font-weight:800;overflow-wrap:anywhere;">${escapeHtml(p.displayName)}</span>
                  <span style="font-size:12px;color:rgba(226,232,240,0.55);white-space:nowrap;">${isOther ? 'вече избран' : p.level !== null ? `ниво ${p.level}` : ''}</span>
                </button>
              </li>`
            }).join('')}
          </ul>`)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (host.isConnected) renderSearchResults(index, '<div style="font-size:13px;color:#fecaca;padding:4px 2px;">Няма връзка със сървъра.</div>')
    }
  }

  /** Търсене с debounce (300 ms), минимум 2 знака; предишната заявка се прекъсва. */
  const bindPickerInput = (index: 0 | 1) => {
    const input = createPanel.querySelector<HTMLInputElement>(`[data-co-play-pick-search="${index}"]`)
    if (input === null) return
    input.addEventListener('input', () => {
      const term = input.value.trim()
      if (searchTimers[index] !== null) clearTimeout(searchTimers[index]!)
      searchControllers[index]?.abort()
      if (term.length < SEARCH_MIN_LENGTH) {
        renderSearchResults(index, '')
        return
      }
      searchTimers[index] = setTimeout(() => { void runSearch(index, term) }, SEARCH_DEBOUNCE_MS)
    })
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') event.preventDefault() })
  }

  const readDuration = (): { ok: true; days: number | null } | { ok: false; message: string } => {
    const indefinite = createPanel.querySelector<HTMLInputElement>('[data-co-play-indefinite="1"]')?.checked === true
    if (indefinite) return { ok: true, days: null }
    const raw = (createPanel.querySelector<HTMLInputElement>('[data-co-play-duration="1"]')?.value ?? '').trim()
    if (!/^\d{1,4}$/.test(raw)) return { ok: false, message: `Въведете срок — цяло число дни от 1 до ${CO_PLAY_MAX_DURATION_DAYS} — или изберете „Безсрочно“.` }
    const days = Number(raw)
    if (days < 1 || days > CO_PLAY_MAX_DURATION_DAYS) return { ok: false, message: `Срокът трябва да е от 1 до ${CO_PLAY_MAX_DURATION_DAYS} дни.` }
    return { ok: true, days }
  }

  const bindCreate = () => {
    const form = createPanel.querySelector<HTMLFormElement>('[data-co-play-create-form="1"]')!
    const durationEl = form.querySelector<HTMLInputElement>('[data-co-play-duration="1"]')!
    const indefiniteEl = form.querySelector<HTMLInputElement>('[data-co-play-indefinite="1"]')!
    const reasonEl = form.querySelector<HTMLTextAreaElement>('[data-co-play-reason="1"]')!
    const counterEl = form.querySelector<HTMLElement>('[data-co-play-reason-counter="1"]')!
    const syncIndefinite = () => {
      durationEl.disabled = indefiniteEl.checked
      durationEl.style.opacity = indefiniteEl.checked ? '0.4' : '1'
    }
    indefiniteEl.addEventListener('change', syncIndefinite)
    syncIndefinite()
    reasonEl.addEventListener('input', () => { counterEl.textContent = `${reasonEl.value.length}/${CO_PLAY_MAX_REASON_LENGTH}` })

    ;([0, 1] as const).forEach((index) => bindPickerInput(index))

    form.addEventListener('click', (event) => {
      const target = event.target as HTMLElement
      const option = target.closest<HTMLButtonElement>('[data-co-play-pick-option]')
      if (option !== null && !option.disabled) {
        const index = option.getAttribute('data-co-play-pick-slot') === '1' ? 1 : 0
        const profile = lastResults[index].find((p) => p.profileId === option.getAttribute('data-co-play-pick-option'))
        if (profile !== undefined) {
          picks[index] = profile
          setCreateError(null)
          rerenderPickers()
        }
        return
      }
      const change = target.closest<HTMLButtonElement>('[data-co-play-pick-change]')
      if (change !== null) {
        const index = change.getAttribute('data-co-play-pick-change') === '1' ? 1 : 0
        picks[index] = null
        lastResults[index] = []
        rerenderPickers()
        form.querySelector<HTMLInputElement>(`[data-co-play-pick-search="${index}"]`)?.focus()
      }
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      if (submitBusy) return
      // Нова операция: старото съобщение (напр. за успех) не остава видимо.
      showNotice(null)
      setCreateError(null)
      const [first, second] = picks
      if (first === null || second === null) { setCreateError('Изберете двата профила.'); return }
      if (first.profileId === second.profileId) { setCreateError(IMPOSE_ERROR_TEXTS.same_profile!); return }
      const duration = readDuration()
      if (!duration.ok) { setCreateError(duration.message); return }
      const reason = reasonEl.value.trim()
      if (reason.length === 0) { setCreateError('Причината за наказанието е задължителна.'); return }
      if (reasonEl.value.length > CO_PLAY_MAX_REASON_LENGTH || reason.length > CO_PLAY_MAX_REASON_LENGTH) {
        setCreateError(`Причината е до ${CO_PLAY_MAX_REASON_LENGTH} знака.`)
        return
      }
      openImposeConfirm(first, second, duration.days, reason)
    })
  }

  const rerenderPickers = () => {
    ;([0, 1] as const).forEach((index) => {
      const slot = createPanel.querySelector<HTMLElement>(`[data-co-play-picker="${index}"]`)
      if (slot === null) return
      const wrapper = document.createElement('div')
      wrapper.innerHTML = renderPickerSlot(index)
      const fresh = wrapper.firstElementChild
      if (fresh === null) return
      slot.replaceWith(fresh)
      bindPickerInput(index)
    })
  }

  const setSubmitBusy = (busy: boolean) => {
    submitBusy = busy
    const button = createPanel.querySelector<HTMLButtonElement>('[data-co-play-submit="1"]')
    if (button === null) return
    button.disabled = busy
    button.style.opacity = busy ? '0.6' : '1'
    button.textContent = busy ? 'Изпращане…' : 'Наложи забрана'
  }

  const openImposeConfirm = (first: SearchProfile, second: SearchProfile, days: number | null, reason: string) => {
    openConfirmDialog({
      key: 'impose',
      title: 'Потвърждение на забраната',
      bodyHtml: `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px 14px;margin-bottom:10px;">
          <div data-co-play-confirm-first="1" style="display:flex;align-items:center;gap:8px;min-width:0;">${avatarHtml(first.displayName, first.avatarUrl, 32)}<b style="overflow-wrap:anywhere;">${escapeHtml(first.displayName)}</b></div>
          <div data-co-play-confirm-second="1" style="display:flex;align-items:center;gap:8px;min-width:0;">${avatarHtml(second.displayName, second.avatarUrl, 32)}<b style="overflow-wrap:anywhere;">${escapeHtml(second.displayName)}</b></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr;gap:8px;margin-bottom:10px;">
          ${field('Срок', escapeHtml(days === null ? 'Безсрочно' : pluralDays(days)), 'confirm-duration')}
          ${field('Причина', escapeHtml(reason), 'confirm-reason')}
        </div>
        <div style="padding:8px 10px;border-radius:8px;border:1px solid rgba(147,197,253,0.35);background:rgba(147,197,253,0.07);color:#dbeafe;font-size:13px;">${escapeHtml(CO_PLAY_SCOPE_NOTE)} Двата акаунта няма да могат да участват на една маса нито като партньори, нито като противници.</div>`,
      confirmLabel: 'Наложи забрана',
      onConfirm: async () => {
        if (submitBusy) return 'Заявката вече се изпраща.'
        setSubmitBusy(true)
        const body = days === null
          ? { firstProfileId: first.profileId, secondProfileId: second.profileId, reason, indefinite: true }
          : { firstProfileId: first.profileId, secondProfileId: second.profileId, reason, durationDays: days }
        const result = await api('POST', '', body)
        if (!host.isConnected) return null
        setSubmitBusy(false)
        if ((result.status === 201 || result.status === 200) && result.body?.ok === true && result.body.restriction) {
          const restriction = result.body.restriction as CoPlayRestrictionView
          picks[0] = null
          picks[1] = null
          lastResults = [[], []]
          renderCreate()
          if (restriction.status === 'pending_activation') {
            const tournaments = restriction.pendingTournaments.map((t) => `${escapeHtml(t.name ?? `Турнир ${t.tournamentId.slice(0, 8)}`)} (${escapeHtml(tournamentStatusLabel(t.status))})`).join(', ')
            showNotice(`<div data-co-play-imposed="pending_activation" style="font-weight:900;margin-bottom:4px;">Забраната е записана успешно, но все още изчаква активиране.</div>
              ${tournaments !== '' ? `<div>Общи незавършили турнири: ${tournaments}.</div>` : ''}
              ${CO_PLAY_PENDING_TEXTS.map((text) => `<div>${escapeHtml(text)}</div>`).join('')}`, 'warn')
          } else {
            showNotice(`<div data-co-play-imposed="active" style="font-weight:900;">Забраната е наложена: ${escapeHtml(plainProfileName(restriction.profiles[0]))} ⇄ ${escapeHtml(plainProfileName(restriction.profiles[1]))}.</div>
              ${settings !== null && !settings.enabled ? `<div>${escapeHtml(CO_PLAY_FLAG_OFF_TEXT)}</div>` : ''}`, 'ok')
          }
          filter = 'all'
          page = 0
          query = ''
          const searchEl = listPanel.querySelector<HTMLInputElement>('[data-co-play-search="1"]')
          if (searchEl !== null) searchEl.value = ''
          setTab('list')
          void loadList()
          if (auditLoaded) void loadAudit()
          return null
        }
        const code = typeof result.body?.code === 'string' ? result.body.code : null
        const text = code !== null && IMPOSE_ERROR_TEXTS[code] !== undefined ? IMPOSE_ERROR_TEXTS[code]! : failureText(result, 'Забраната не беше наложена.')
        // Грешката остава и във формата (диалогът се затваря, данните се пазят).
        closeDialog()
        setCreateError(text)
        return null
      },
    })
  }

  // ─── Одит ───────────────────────────────────────────────────────────────
  const renderAudit = () => {
    const pages = Math.max(1, Math.ceil(auditTotal / AUDIT_PAGE_SIZE))
    const filterInfo = auditFilterId !== null ? `
      <div data-co-play-audit-filter="${escapeHtml(auditFilterId)}" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;padding:8px 10px;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:rgba(212,165,32,0.06);font-size:13px;color:#fef3c7;">
        <span>Само за забрана ${auditFilterRestriction !== null ? `<b>${escapeHtml(plainProfileName(auditFilterRestriction.profiles[0]))} ⇄ ${escapeHtml(plainProfileName(auditFilterRestriction.profiles[1]))}</b> (${escapeHtml(CO_PLAY_STATUS_LABELS[auditFilterRestriction.status])})` : `<b>${escapeHtml(auditFilterId.slice(0, 8))}</b>`}</span>
        <button type="button" data-co-play-audit-clear="1" style="${BTN_SMALL}">Всички записи</button>
      </div>` : ''
    let body: string
    if (auditError !== null) body = `<div data-co-play-audit-error="1" style="padding:14px 0;color:#fecaca;font-size:14px;">${escapeHtml(auditError)}</div>`
    else if (auditLoading && auditItems.length === 0) body = '<div style="padding:18px 0;color:rgba(226,232,240,0.7);font-size:14px;">Зареждане…</div>'
    else if (auditItems.length === 0) body = '<div data-co-play-audit-empty="1" style="padding:18px 0;color:rgba(226,232,240,0.7);font-size:14px;">Няма записи.</div>'
    else body = `<ul data-co-play-audit-list="1" style="margin:0;padding:0;">${auditItems.map((a) => {
      const details = describeAuditDetails(a)
      return `<li data-co-play-audit-entry="${escapeHtml(a.action)}" style="list-style:none;margin:0 0 8px;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);font-size:13px;line-height:1.5;color:#e2e8f0;">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;">
          <b style="color:#f8fafc;">${escapeHtml(CO_PLAY_AUDIT_ACTION_LABELS[a.action] ?? a.action)}</b>
          <span style="color:rgba(226,232,240,0.6);">${escapeHtml(formatCoPlayDate(a.createdAt))}</span>
        </div>
        <div>Извършил: ${a.actorDisplayName !== null ? escapeHtml(a.actorDisplayName) : a.actorProfileId === null ? 'системата (автоматично)' : 'изтрит профил'}</div>
        ${details !== '' ? `<div style="color:rgba(226,232,240,0.78);overflow-wrap:anywhere;">${details}</div>` : ''}
        ${a.restrictionId !== null && auditFilterId === null ? `<button type="button" data-co-play-audit-open="${escapeHtml(a.restrictionId)}" style="margin-top:4px;padding:0;border:0;background:none;color:#f4c95b;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit;text-decoration:underline;">Забрана ${escapeHtml(a.restrictionId.slice(0, 8))} — покажи историята ѝ</button>` : ''}
      </li>`
    }).join('')}</ul>`
    auditPanel.innerHTML = `
      ${filterInfo}
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin:0 0 10px;">
        <span data-co-play-audit-summary="1" style="font-size:12px;color:rgba(226,232,240,0.55);">${auditLoading ? 'Обновяване…' : `Общо записи: ${auditTotal}`}</span>
        <button type="button" data-co-play-audit-refresh="1" style="${BTN_SMALL}">Обнови</button>
      </div>
      ${body}
      ${auditTotal > AUDIT_PAGE_SIZE ? `
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;margin-top:6px;">
          <button type="button" data-co-play-audit-page="prev" ${auditPage === 0 ? 'disabled' : ''} style="${BTN_SMALL}${auditPage === 0 ? 'opacity:0.4;cursor:not-allowed;' : ''}">← Предишна</button>
          <span style="font-size:13px;color:rgba(226,232,240,0.7);">${auditPage + 1} / ${pages}</span>
          <button type="button" data-co-play-audit-page="next" ${auditPage + 1 >= pages ? 'disabled' : ''} style="${BTN_SMALL}${auditPage + 1 >= pages ? 'opacity:0.4;cursor:not-allowed;' : ''}">Следваща →</button>
        </div>` : ''}`
  }

  const loadAudit = async () => {
    const seq = ++auditSeq
    auditLoaded = true
    auditLoading = true
    auditError = null
    renderAudit()
    const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE), offset: String(auditPage * AUDIT_PAGE_SIZE) })
    if (auditFilterId !== null) params.set('restrictionId', auditFilterId)
    const result = await api('GET', `/audit?${params.toString()}`)
    if (seq !== auditSeq || !host.isConnected) return
    auditLoading = false
    if (result.status === 200 && result.body?.ok === true && Array.isArray(result.body.items)) {
      auditItems = result.body.items as CoPlayRestrictionAuditView[]
      auditTotal = typeof result.body.total === 'number' ? result.body.total : auditItems.length
    } else {
      auditItems = []
      auditTotal = 0
      auditError = failureText(result, 'Одитът не може да бъде зареден.')
    }
    renderAudit()
  }

  const openAuditFor = async (restrictionId: string) => {
    auditFilterId = restrictionId
    auditFilterRestriction = items.find((view) => view.restrictionId === restrictionId) ?? null
    auditPage = 0
    void loadAudit()
    if (auditFilterRestriction === null) {
      const result = await api('GET', `/${encodeURIComponent(restrictionId)}`)
      if (!host.isConnected || auditFilterId !== restrictionId) return
      if (result.status === 200 && result.body?.ok === true && result.body.restriction) {
        auditFilterRestriction = result.body.restriction as CoPlayRestrictionView
        renderAudit()
      }
    }
  }

  // ─── Табове и събития ───────────────────────────────────────────────────
  const setTab = (tab: 'list' | 'create' | 'audit') => {
    activeTab = tab
    host.querySelectorAll<HTMLButtonElement>('[data-co-play-tab]').forEach((button) => {
      const selected = button.getAttribute('data-co-play-tab') === tab
      button.setAttribute('aria-selected', selected ? 'true' : 'false')
      button.style.background = selected ? 'rgba(212,165,32,0.18)' : 'transparent'
      button.style.color = selected ? '#f4c95b' : '#f8fafc'
      button.style.borderColor = selected ? 'rgba(212,165,32,0.75)' : 'rgba(212,165,32,0.35)'
    })
    listPanel.style.display = tab === 'list' ? '' : 'none'
    createPanel.style.display = tab === 'create' ? '' : 'none'
    auditPanel.style.display = tab === 'audit' ? '' : 'none'
    if (tab === 'audit' && !auditLoaded) void loadAudit()
  }

  const close = () => {
    closeDialog()
    searchControllers.forEach((controller) => controller?.abort())
    searchTimers.forEach((timer) => { if (timer !== null) clearTimeout(timer) })
    document.removeEventListener('keydown', onKeydown, true)
    host.remove()
    previouslyFocused?.focus?.()
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    const dialog = document.getElementById(DIALOG_ID)
    event.preventDefault()
    if (dialog !== null) {
      if (dialog.getAttribute('data-busy') !== '1') closeDialog()
      return
    }
    close()
  }
  document.addEventListener('keydown', onKeydown, true)

  host.querySelector<HTMLButtonElement>('[data-co-play-close="1"]')!.addEventListener('click', close)
  host.querySelectorAll<HTMLButtonElement>('[data-co-play-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const tab = button.getAttribute('data-co-play-tab')
      if (tab === 'list' || tab === 'create' || tab === 'audit') setTab(tab)
    })
  })
  settingsEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const toggle = target.closest<HTMLButtonElement>('[data-co-play-flag-toggle]')
    if (toggle !== null) {
      openFlagDialog(toggle.getAttribute('data-co-play-flag-toggle') === 'on')
      return
    }
    if (target.closest('[data-co-play-settings-retry="1"]') !== null) {
      settingsError = null
      renderSettings()
      void loadSettings()
    }
  })

  renderListShell()
  listPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const filterButton = target.closest<HTMLButtonElement>('[data-co-play-filter]')
    if (filterButton !== null) {
      const value = filterButton.getAttribute('data-co-play-filter') as CoPlayRestrictionStatus | 'all'
      if (FILTERS.some(([candidate]) => candidate === value) && value !== filter) {
        filter = value
        page = 0
        void loadList()
      }
      return
    }
    if (target.closest('[data-co-play-refresh="1"]') !== null) {
      showNotice(null)
      void loadList()
      return
    }
    const pageButton = target.closest<HTMLButtonElement>('[data-co-play-page]')
    if (pageButton !== null && !pageButton.disabled) {
      page = Math.max(0, page + (pageButton.getAttribute('data-co-play-page') === 'next' ? 1 : -1))
      void loadList()
      return
    }
    const historyButton = target.closest<HTMLButtonElement>('[data-co-play-history-toggle]')
    if (historyButton !== null) {
      const id = historyButton.getAttribute('data-co-play-history-toggle')!
      if (historyOpen.has(id)) {
        historyOpen.delete(id)
        renderList()
      } else {
        historyOpen.add(id)
        void loadHistory(id)
      }
      return
    }
    const liftButton = target.closest<HTMLButtonElement>('[data-co-play-lift-open]')
    if (liftButton !== null) {
      const view = items.find((candidate) => candidate.restrictionId === liftButton.getAttribute('data-co-play-lift-open'))
      if (view !== undefined && (view.status === 'active' || view.status === 'pending_activation')) openLiftDialog(view)
    }
  })
  listPanel.querySelector<HTMLFormElement>('[data-co-play-search-form="1"]')!.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = listPanel.querySelector<HTMLInputElement>('[data-co-play-search="1"]')?.value.trim() ?? ''
    query = value
    page = 0
    void loadList()
  })
  auditPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-co-play-audit-refresh="1"]') !== null) { void loadAudit(); return }
    if (target.closest('[data-co-play-audit-clear="1"]') !== null) {
      auditFilterId = null
      auditFilterRestriction = null
      auditPage = 0
      void loadAudit()
      return
    }
    const pageButton = target.closest<HTMLButtonElement>('[data-co-play-audit-page]')
    if (pageButton !== null && !pageButton.disabled) {
      auditPage = Math.max(0, auditPage + (pageButton.getAttribute('data-co-play-audit-page') === 'next' ? 1 : -1))
      void loadAudit()
      return
    }
    const openButton = target.closest<HTMLButtonElement>('[data-co-play-audit-open]')
    if (openButton !== null) void openAuditFor(openButton.getAttribute('data-co-play-audit-open')!)
  })

  renderSettings()
  renderCreate()
  setTab(activeTab)
  void loadSettings()
  void loadList()
  host.querySelector<HTMLButtonElement>('[data-co-play-close="1"]')!.focus()
  return { close }
}

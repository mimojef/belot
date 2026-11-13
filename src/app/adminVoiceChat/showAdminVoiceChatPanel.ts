// „Гласови разговори“ — Admin → Гласови разговори (Етап 6; само пълен admin,
// сървърът проверява ролята при всяка заявка — /api/admin/voice-chat).
//
// Самостоятелен overlay (по шаблона на showAdminProfileCustomizationPanel),
// зареждан с dynamic import само при отваряне:
//   * Управление        — режим (Изключено / Само админ / Включено), лимит,
//                         аварийно изключване (игрите продължават), одит;
//   * Текущо състояние  — резервирани маси, активни стаи, участници
//                         (микрофон / само слушат), списък на масите;
//   * Статистика        — включвания и откази по причина, reconnect-и,
//                         TURN дял, RTT / jitter / загуба на пакети;
//   * Гласов VPS        — статус, версия, uptime, CPU (общо/по vCPU), steal,
//                         натоварване, RAM, мрежов трафик.
// Тук няма бизнес правила и няма аудио: само технически показатели без
// профили и имена. Липсваща/неналична стойност -> „Недостъпно“, никога 0.
// Обновява се на 15 s само докато панелът е отворен и табът е видим.

type VoiceMode = 'off' | 'admin_only' | 'public'

type AdminChange = { changeId: string; setting: 'mode' | 'max_tables'; newValue: string; previousValue: string | null; changedAt: string; changedByDisplayName: string | null }

type BaseSnapshot = {
  mode: VoiceMode
  effectiveMode: VoiceMode
  emergencyStop: boolean
  modeChangedAt: string | null
  modeChangedByDisplayName: string | null
  maxTables: number
  maxTablesUpperBound: number
  activeVoiceTables: number
  pendingRoomDeletions: number
  liveKit: { configured: boolean; missing: string[] }
  vpsMetrics?: { configured: boolean; missing: string[] }
  history: AdminChange[]
}

type Counts = { participants: number | null; microphoneOn: number | null; listening: number | null }

type LiveTable = {
  voiceTableId: string
  phase: 'waiting' | 'in_game'
  createdAt: string
  inGameAt: string | null
  liveRoomName: string | null
  generation: number | null
  seatedMembers: number
  activeVoiceSessions: number
  blocked: 'releasing' | 'rotation_pending' | null
  roomExists: boolean | null
  counts: Counts
}

type LiveSnapshot = {
  status: 'ok' | 'partial' | 'not_configured' | 'unavailable'
  reason: string | null
  sampledAt: string | null
  totals: { reservedTables: number; activeRooms: number | null; participants: number | null; microphoneOn: number | null; listening: number | null }
  tables: LiveTable[]
}

type QualityMetric = { intervalMean: number | null; lifetimeMean: number | null; intervalCount: number | null; current: number | null }
type SourceStatus = { status: 'ok' | 'not_configured' | 'unavailable'; reason: string | null; lastSuccessAt: string | null }

type VpsSnapshot = {
  configured: boolean
  sampledAt: string | null
  rateWindowSeconds: number | null
  liveKit: SourceStatus & {
    version: string | null
    processStartedAt: string | null
    uptimeSeconds: number | null
    rooms: number | null
    participants: number | null
    tracksPublished: number | null
    tracksSubscribed: number | null
    participantJoins: { total: number | null; byLabel: Array<{ label: string; value: number }> }
    quality: Record<'rttMs' | 'jitterUs' | 'packetLossPercent' | 'qualityScore' | 'qualityRating' | 'joinLatencyMs', QualityMetric>
  }
  host: SourceStatus & {
    bootedAt: string | null
    uptimeSeconds: number | null
    cpuCount: number | null
    cpuBusyPercent: number | null
    cpuStealPercent: number | null
    perCpu: Array<{ cpu: string; busyPercent: number | null; stealPercent: number | null }>
    cpuPressureWaitingPercent: number | null
    load: { one: number | null; five: number | null; fifteen: number | null }
    memory: { totalBytes: number | null; availableBytes: number | null; usedPercent: number | null; swapUsedBytes: number | null }
    network: Array<{ device: string; receiveBytesPerSecond: number | null; transmitBytesPerSecond: number | null; receiveBytesTotal: number; transmitBytesTotal: number }>
  }
}

type ServerStats = {
  since: string
  liveKitConfigured: boolean
  breaker: 'closed' | 'open' | 'half_open'
  activeVoiceSessions: number
  tokensIssued: number
  tokensDenied: number
  tokensDeniedByCode: Record<string, number>
  tokensDiscardedStale: number
  rotations: number
  createRoomFailures: number
  leaseExpired: number
  disconnectTimeouts: number
  speakUpgrades: number
  muteRevocations: number
  liveKitRequests: { succeeded: number; failed: number; rejectedBreakerOpen: number; rejectedQueueFull: number; breakerOpenedCount: number }
}

type ClientStats = {
  since: string
  events: Record<string, number>
  failures: Record<string, number>
  transport: {
    reports: number
    byCandidateType: Record<string, number>
    relayByProtocol: Record<string, number>
    relayPercent: number | null
    rttMs: { mean: number | null; reports: number }
    jitterMs: { mean: number | null; reports: number }
    packetLossPercent: { mean: number | null; reports: number }
  }
  rejectedReports: number
}

type Monitoring = { generatedAt: string; live: LiveSnapshot; vps: VpsSnapshot; server: ServerStats; clients: ClientStats }

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; code: string | null; message: string }

export type AdminVoiceChatPanelDeps = {
  getApiBaseUrl: () => string
  /** Само за визуалния harness — фиксирани данни вместо мрежа. */
  fetchImpl?: typeof fetch
  refreshIntervalMs?: number
}

type Tab = 'control' | 'live' | 'stats' | 'vps'

const HOST_ID = 'admin-voice-chat-panel'
const REFRESH_MS = 15_000
const UNAVAILABLE = 'Недостъпно'

const BTN_PRIMARY = 'min-height:36px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;'
const BTN_SECONDARY = 'min-height:36px;padding:0 14px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;'
const BTN_DANGER = 'min-height:40px;padding:0 16px;border:1px solid rgba(248,113,113,0.7);border-radius:8px;background:rgba(185,28,28,0.22);color:#fecaca;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;'
const INPUT_STYLE = 'min-height:36px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:#1a1a1a;color:#f8fafc;font-size:14px;font-family:inherit;box-sizing:border-box;max-width:100%;'
const CARD_STYLE = 'margin:0 0 10px;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);'
const MUTED = 'color:rgba(226,232,240,0.6);'
const H3 = 'margin:0 0 8px;font-size:14px;font-weight:900;color:#f4c95b;letter-spacing:0.02em;'

const MODE_LABELS: Record<VoiceMode, string> = { off: 'Изключено', admin_only: 'Само админ', public: 'Включено' }
const MODE_HINTS: Record<VoiceMode, string> = {
  off: 'Гласът не е достъпен. Всички текущи разговори се прекратяват, игрите продължават.',
  admin_only: 'Нови гласови маси създава само пълен администратор с активен VIP. Съществуващите маси продължават.',
  public: 'Всеки VIP играч може да създаде гласова маса.',
}

/** Отказите на токен — само кодове, без лични данни. */
const DENIAL_LABELS: Record<string, string> = {
  voice_off: 'Гласът е изключен',
  voice_unavailable: 'Гласовата услуга е недостъпна',
  voice_rotation_pending: 'Смяна на стаята (изчакване)',
  voice_starting: 'Сървърът стартира',
  voice_state_changed: 'Променено състояние по време на заявката',
  presence_required: 'Липсва присъствие на масата',
  invalid_session: 'Невалидна/сменена сесия',
  not_authenticated: 'Без вход',
  banned: 'Блокиран профил',
  table_not_found: 'Непозната маса',
  table_released: 'Масата е прекратена',
  spectator: 'Зрител',
  bot: 'Бот',
  not_a_player: 'Не е играч на масата',
  wrong_table: 'Друга маса',
  permanently_left: 'Напуснал окончателно',
  lease_expired: 'Изтекло присъствие',
  not_on_table_screen: 'Не е на екрана на масата',
}

const CLIENT_FAILURE_LABELS: Record<string, string> = {
  sdk_load_failed: 'Неуспешно зареждане на гласовия модул',
  presence_failed: 'Няма потвърждение от игровия сървър',
  token_unavailable: 'Няма достъп до гласа (токен)',
  livekit_connect_failed: 'Неуспешно свързване с гласовия сървър',
  mic_not_found: 'Микрофон: не е открит',
  mic_permission_denied: 'Микрофон: отказано разрешение',
  mic_unavailable: 'Микрофон: недостъпен',
  mic_not_permitted: 'Микрофон: няма право за говорене',
}

const SOURCE_REASON_LABELS: Record<string, string> = {
  timeout: 'няма отговор (timeout)',
  network: 'мрежова грешка',
  too_large: 'твърде голям отговор',
  empty: 'празен отговор',
  http_401: 'отказана автентикация (401)',
  http_403: 'отказан достъп (403)',
  http_404: 'липсващ маршрут (404)',
  http_502: 'Caddy не достига метриките (502)',
  breaker_open: 'LiveKit API временно спряно (circuit breaker)',
  queue_full: 'опашката към LiveKit е пълна',
  transient: 'временна грешка на LiveKit API',
  rejected: 'LiveKit отказа заявката',
  internal_error: 'вътрешна грешка',
  participant_breakdown_incomplete: 'част от стаите не са проверени',
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatTime(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
}

function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return UNAVAILABLE
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days} д ${hours} ч`
  if (hours > 0) return `${hours} ч ${minutes} мин`
  return `${Math.max(0, minutes)} мин`
}

function sinceDuration(iso: string, nowMs: number): string {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return '—'
  return formatDuration((nowMs - at) / 1000)
}

function formatNumber(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE
  return new Intl.NumberFormat('bg-BG', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)
}

function formatPercent(value: number | null, digits = 1): string {
  return value === null ? UNAVAILABLE : `${formatNumber(value, digits)} %`
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return UNAVAILABLE
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let unit = 0
  let size = value
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${formatNumber(size, unit === 0 ? 0 : 1)} ${units[unit]}`
}

function formatBitrate(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return UNAVAILABLE
  const bits = bytesPerSecond * 8
  if (bits >= 1_000_000) return `${formatNumber(bits / 1_000_000, 2)} Mbit/s`
  return `${formatNumber(bits / 1_000, 1)} kbit/s`
}

function reasonText(reason: string | null): string {
  if (reason === null) return ''
  return SOURCE_REASON_LABELS[reason] ?? reason
}

function unavailableBadge(text = UNAVAILABLE): string {
  return `<span data-avc-unavailable="1" style="color:rgba(226,232,240,0.55);font-weight:800;">${escapeHtml(text)}</span>`
}

/** Стойност или „Недостъпно“ (сив текст) — никога 0 за липсващо. */
function valueOrUnavailable(text: string): string {
  return text === UNAVAILABLE ? unavailableBadge() : escapeHtml(text)
}

function statusPill(tone: 'ok' | 'warn' | 'bad' | 'muted', label: string): string {
  const colors = {
    ok: ['#86efac', 'rgba(134,239,172,0.1)'],
    warn: ['#fcd34d', 'rgba(252,211,77,0.1)'],
    bad: ['#fca5a5', 'rgba(248,113,113,0.12)'],
    muted: ['rgba(226,232,240,0.7)', 'rgba(255,255,255,0.05)'],
  }[tone]
  return `<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid ${colors[0]};color:${colors[0]};background:${colors[1]};white-space:nowrap;">${escapeHtml(label)}</span>`
}

function tile(label: string, value: string, sub = ''): string {
  return `
    <div data-avc-tile="1" style="padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);min-width:0;">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;${MUTED}">${escapeHtml(label)}</div>
      <div style="margin-top:4px;font-size:22px;font-weight:900;line-height:1.15;">${value}</div>
      ${sub === '' ? '' : `<div style="margin-top:3px;font-size:12px;${MUTED}">${sub}</div>`}
    </div>`
}

function kvRows(rows: Array<[string, string]>): string {
  return `<div data-avc-kv="1" style="display:grid;gap:6px 14px;font-size:13px;">${rows
    .map(([label, value]) => `<div style="${MUTED}">${escapeHtml(label)}</div><div style="text-align:right;font-weight:800;overflow-wrap:anywhere;">${value}</div>`)
    .join('')}</div>`
}

function bar(percentValue: number | null): string {
  if (percentValue === null) return unavailableBadge('—')
  const clamped = Math.max(0, Math.min(100, percentValue))
  const color = clamped >= 85 ? '#f87171' : clamped >= 60 ? '#fbbf24' : '#86efac'
  return `<div style="display:flex;align-items:center;gap:8px;"><div style="flex:1;height:8px;border-radius:999px;background:rgba(255,255,255,0.08);overflow:hidden;min-width:60px;"><div style="width:${clamped.toFixed(1)}%;height:100%;background:${color};"></div></div><span style="font-size:12px;font-weight:800;min-width:52px;text-align:right;">${formatPercent(percentValue)}</span></div>`
}

export function showAdminVoiceChatPanel(deps: AdminVoiceChatPanelDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const doFetch = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const refreshMs = deps.refreshIntervalMs ?? REFRESH_MS

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:200000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  let base: BaseSnapshot | null = null
  let monitoring: Monitoring | null = null
  let monitoringError: string | null = null
  let loadError: string | null = null
  let tab: Tab = 'control'
  let pendingMode: VoiceMode | null = null
  let emergencyConfirmOpen = false
  /** След „Изключено“: чака се потвърдено изтриване на LiveKit стаите. */
  let awaitingRoomDeletion = false
  let offNoticeContext: { successText: string; released: number } | null = null
  let busy = false
  let loading = false
  let refreshTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false

  host.innerHTML = `
    <style>
      #${HOST_ID} [data-avc-tiles="1"] { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:10px; margin:0 0 12px; }
      #${HOST_ID} [data-avc-cols="1"] { display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; }
      #${HOST_ID} [data-avc-kv="1"] { grid-template-columns:minmax(110px, 1fr) auto; }
      #${HOST_ID} [data-avc-narrow-only="1"] { display:none; }
      #${HOST_ID} table { width:100%; border-collapse:collapse; font-size:13px; }
      #${HOST_ID} th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:0.04em; color:rgba(226,232,240,0.6); font-weight:800; padding:6px 8px; border-bottom:1px solid rgba(255,255,255,0.12); white-space:nowrap; }
      #${HOST_ID} td { padding:7px 8px; border-bottom:1px solid rgba(255,255,255,0.06); vertical-align:top; }
      @media (max-width: 640px) {
        #${HOST_ID} [data-avc-cols="1"] { grid-template-columns:minmax(0, 1fr); }
        #${HOST_ID} [data-avc-tiles="1"] { grid-template-columns:repeat(2, minmax(0, 1fr)); }
        #${HOST_ID} [data-avc-hide-narrow="1"] { display:none; }
        #${HOST_ID} [data-avc-kv="1"] { grid-template-columns:minmax(0, 1fr) auto; }
        #${HOST_ID} [data-avc-wide-only="1"] { display:none; }
        #${HOST_ID} [data-avc-narrow-only="1"] { display:block; }
      }
    </style>
    <div style="min-height:100%;display:flex;justify-content:center;padding:16px;box-sizing:border-box;">
      <section role="dialog" aria-modal="true" aria-labelledby="admin-voice-chat-title"
        style="width:min(100%,1040px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:#111111;box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:18px;align-self:flex-start;color:#f1f5f9;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;flex-wrap:wrap;">
          <h2 id="admin-voice-chat-title" style="margin:0;font-size:20px;font-weight:900;color:#d4a520;letter-spacing:0.02em;">Гласови разговори</h2>
          <div style="display:flex;gap:8px;align-items:center;">
            <span data-avc-updated="1" style="font-size:12px;${MUTED}"></span>
            <button type="button" data-avc-refresh="1" style="${BTN_SECONDARY}">Обнови</button>
            <button type="button" data-avc-close="1" aria-label="Затвори" style="${BTN_SECONDARY}">Затвори</button>
          </div>
        </div>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.5;${MUTED}">Гласов чат в частните маси на Белот. Само технически показатели — без слушане, без записи и без имена на участниците.</p>
        <div data-avc-banners="1"></div>
        <div data-avc-tabs="1" role="tablist" style="display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px;padding-bottom:2px;"></div>
        <div data-avc-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.45;"></div>
        <div data-avc-body="1"></div>
      </section>
    </div>`

  const tabsEl = host.querySelector<HTMLElement>('[data-avc-tabs="1"]')!
  const bannersEl = host.querySelector<HTMLElement>('[data-avc-banners="1"]')!
  const bodyEl = host.querySelector<HTMLElement>('[data-avc-body="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-avc-notice="1"]')!
  const updatedEl = host.querySelector<HTMLElement>('[data-avc-updated="1"]')!

  const showNotice = (text: string | null, tone: 'ok' | 'error' = 'ok') => {
    if (text === null) { noticeEl.style.display = 'none'; return }
    noticeEl.textContent = text
    noticeEl.style.display = ''
    noticeEl.style.border = tone === 'ok' ? '1px solid rgba(134,239,172,0.35)' : '1px solid rgba(248,113,113,0.45)'
    noticeEl.style.background = tone === 'ok' ? 'rgba(134,239,172,0.08)' : 'rgba(248,113,113,0.08)'
    noticeEl.style.color = tone === 'ok' ? '#dcfce7' : '#fecaca'
  }

  async function api(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const response = await doFetch(`${deps.getApiBaseUrl()}/api/admin/voice-chat${path}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (response.ok && data?.ok === true) return { ok: true, data }
      return {
        ok: false,
        status: response.status,
        code: typeof data?.code === 'string' ? data.code : null,
        message: typeof data?.message === 'string' ? data.message : 'Заявката не беше изпълнена.',
      }
    } catch {
      return { ok: false, status: 0, code: null, message: 'Няма връзка със сървъра.' }
    }
  }

  // ─── Рендиране ────────────────────────────────────────────────────────

  const renderTabs = () => {
    const tabs: Array<[Tab, string]> = [['control', 'Управление'], ['live', 'Текущо състояние'], ['stats', 'Статистика и качество'], ['vps', 'Гласов VPS']]
    tabsEl.innerHTML = tabs.map(([key, label]) => {
      const active = key === tab
      return `<button type="button" role="tab" aria-selected="${active}" data-avc-tab="${key}" style="flex:0 0 auto;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid ${active ? '#d4a520' : 'rgba(255,255,255,0.18)'};background:${active ? 'rgba(212,165,32,0.16)' : 'transparent'};color:${active ? '#f4c95b' : '#e2e8f0'};font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;">${escapeHtml(label)}</button>`
    }).join('')
  }

  const renderBanners = () => {
    const parts: string[] = []
    if (base?.emergencyStop === true) {
      parts.push(`<div style="${CARD_STYLE}border-color:rgba(248,113,113,0.5);background:rgba(248,113,113,0.08);color:#fecaca;font-size:13px;line-height:1.5;"><b>Авариен стоп от сървъра (VOICE_CHAT_ENABLED=0).</b> Гласът е изключен независимо от избрания режим. Отменя се само от средата на сървъра.</div>`)
    }
    if (loadError !== null) {
      parts.push(`<div style="${CARD_STYLE}border-color:rgba(248,113,113,0.45);color:#fecaca;font-size:13px;">${escapeHtml(loadError)}</div>`)
    }
    bannersEl.innerHTML = parts.join('')
  }

  const renderControl = (data: BaseSnapshot): string => {
    const modeButtons = (['off', 'admin_only', 'public'] as VoiceMode[]).map((mode) => {
      const active = data.mode === mode
      return `
        <button type="button" data-avc-mode="${mode}" aria-pressed="${active}" ${busy ? 'disabled' : ''} style="flex:1 1 160px;min-height:64px;padding:10px 12px;border-radius:8px;text-align:left;cursor:pointer;font-family:inherit;border:1px solid ${active ? '#d4a520' : 'rgba(255,255,255,0.16)'};background:${active ? 'rgba(212,165,32,0.14)' : 'rgba(255,255,255,0.02)'};color:#f8fafc;">
          <div style="font-size:14px;font-weight:900;color:${active ? '#f4c95b' : '#f8fafc'};">${escapeHtml(MODE_LABELS[mode])}${active ? ' · текущ' : ''}</div>
          <div style="margin-top:3px;font-size:12px;line-height:1.4;${MUTED}">${escapeHtml(MODE_HINTS[mode])}</div>
        </button>`
    }).join('')
    const confirm = pendingMode === null ? '' : `
      <div data-avc-mode-confirm="1" style="${CARD_STYLE}border-color:rgba(212,165,32,0.5);margin-top:10px;">
        <div style="font-size:14px;font-weight:800;margin-bottom:6px;">Смяна на режима: ${escapeHtml(MODE_LABELS[data.mode])} → ${escapeHtml(MODE_LABELS[pendingMode])}</div>
        <div style="font-size:13px;line-height:1.5;margin-bottom:10px;${MUTED}">${escapeHtml(MODE_HINTS[pendingMode])}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-avc-mode-apply="1" ${busy ? 'disabled' : ''} style="${BTN_PRIMARY}">Потвърди</button>
          <button type="button" data-avc-mode-cancel="1" style="${BTN_SECONDARY}">Отказ</button>
        </div>
      </div>`
    const effective = data.effectiveMode !== data.mode ? ` (ефективно: ${MODE_LABELS[data.effectiveMode]})` : ''
    const occupancy = `${data.activeVoiceTables} / ${data.maxTables}`
    const overLimit = data.activeVoiceTables > data.maxTables
    const emergency = emergencyConfirmOpen ? `
      <div data-avc-emergency-confirm="1" style="margin-top:10px;padding:12px;border-radius:8px;border:1px solid rgba(248,113,113,0.6);background:rgba(127,29,29,0.25);">
        <div style="font-size:14px;font-weight:900;color:#fecaca;margin-bottom:6px;">Аварийно изключване на гласа?</div>
        <div style="font-size:13px;line-height:1.5;color:#fde2e2;margin-bottom:10px;">Гласовите маси се прекратяват веднага и нови токени не се издават. LiveKit стаите се изтриват асинхронно — до потвърждението от гласовия сървър свързаните участници може още да се чуват. Игрите, масите и местата на играчите продължават без прекъсване. Режимът става „Изключено“ и се включва отново ръчно.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" data-avc-emergency-apply="1" ${busy ? 'disabled' : ''} style="${BTN_DANGER}">Изключи всички разговори</button>
          <button type="button" data-avc-emergency-cancel="1" style="${BTN_SECONDARY}">Отказ</button>
        </div>
      </div>` : ''
    const historyRows = data.history.length === 0
      ? `<tr><td colspan="4" style="${MUTED}">Няма промени — използват се стойностите по подразбиране (Изключено, лимит 10).</td></tr>`
      : data.history.map((change) => {
        const label = change.setting === 'mode' ? 'Режим' : 'Лимит'
        const show = (value: string | null) => value === null ? '—' : change.setting === 'mode' && value in MODE_LABELS ? MODE_LABELS[value as VoiceMode] : value
        return `<tr><td style="white-space:nowrap;">${escapeHtml(formatDate(change.changedAt))}</td><td>${label}</td><td>${escapeHtml(show(change.previousValue))} → <b>${escapeHtml(show(change.newValue))}</b></td><td data-avc-hide-narrow="1">${escapeHtml(change.changedByDisplayName ?? '—')}</td></tr>`
      }).join('')
    const configRow = (label: string, status: { configured: boolean; missing: string[] } | undefined) => {
      if (status === undefined) return `<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;"><span>${escapeHtml(label)}</span>${unavailableBadge()}</div>`
      const pill = status.configured ? statusPill('ok', 'Конфигурирано') : statusPill('muted', 'Не е конфигурирано')
      const missing = status.missing.length === 0 ? '' : `<div style="font-size:12px;margin-top:3px;${MUTED}">Липсват: ${status.missing.map((name) => `<code>${escapeHtml(name)}</code>`).join(', ')}</div>`
      return `<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;"><span>${escapeHtml(label)}</span>${pill}</div>${missing}</div>`
    }
    return `
      <div style="${CARD_STYLE}">
        <h3 style="${H3}">Режим${escapeHtml(effective)}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">${modeButtons}</div>
        ${confirm}
        <div style="margin-top:8px;font-size:12px;${MUTED}">Последна промяна: ${escapeHtml(formatDate(data.modeChangedAt))}${data.modeChangedByDisplayName === null ? '' : ` · ${escapeHtml(data.modeChangedByDisplayName)}`}</div>
      </div>
      <div data-avc-cols="1">
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Лимит на едновременните гласови маси</h3>
          <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;${MUTED}">Лимит (0–${data.maxTablesUpperBound})
              <input type="number" min="0" max="${data.maxTablesUpperBound}" step="1" inputmode="numeric" data-avc-limit-input="1" value="${data.maxTables}" style="${INPUT_STYLE}width:110px;">
            </label>
            <button type="button" data-avc-limit-save="1" ${busy ? 'disabled' : ''} style="${BTN_PRIMARY}">Запази</button>
          </div>
          <div style="margin-top:10px;font-size:13px;">Заети слотове: <b>${escapeHtml(occupancy)}</b>${overLimit ? ` ${statusPill('warn', 'над лимита — нови маси не се създават')}` : ''}</div>
          <div style="margin-top:4px;font-size:12px;line-height:1.45;${MUTED}">При намаляване съществуващите маси продължават; нови не се създават, докато броят не падне под лимита.</div>
        </div>
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Аварийно изключване</h3>
          <div style="font-size:13px;line-height:1.5;margin-bottom:10px;${MUTED}">Прекратява всички гласови маси без да прекъсва игрите и спира новите токени веднага, без deploy. Изтриването на LiveKit стаите се потвърждава от гласовия сървър.</div>
          <button type="button" data-avc-emergency="1" ${busy || data.mode === 'off' ? 'disabled' : ''} style="${BTN_DANGER}${data.mode === 'off' ? 'opacity:0.5;cursor:default;' : ''}">${data.mode === 'off' ? 'Гласът вече е изключен' : 'Аварийно изключване'}</button>
          ${emergency}
        </div>
      </div>
      <div data-avc-cols="1">
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Конфигурация на сървъра</h3>
          ${configRow('LiveKit (гласов сървър)', data.liveKit)}
          ${configRow('Метрики на гласовия VPS', data.vpsMetrics)}
          <div style="font-size:12px;line-height:1.45;${MUTED}">Показват се само имената на липсващите настройки — стойностите и ключовете никога не напускат сървъра.</div>
        </div>
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Чакащи прекратяване</h3>
          ${kvRows([
            ['Оттеглени LiveKit стаи, чакащи DeleteRoom', escapeHtml(String(data.pendingRoomDeletions))],
          ])}
          <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">Опашката е в базата и не се губи при рестарт или недостъпен LiveKit.</div>
        </div>
      </div>
      <div style="${CARD_STYLE}">
        <h3 style="${H3}">История на промените</h3>
        <div style="overflow-x:auto;"><table><thead><tr><th>Кога</th><th>Настройка</th><th>Промяна</th><th data-avc-hide-narrow="1">От</th></tr></thead><tbody>${historyRows}</tbody></table></div>
      </div>`
  }

  const monitoringUnavailable = (): string => `
    <div style="${CARD_STYLE}font-size:13px;line-height:1.5;">${monitoringError === null ? 'Зареждане на показателите…' : `${unavailableBadge()} — ${escapeHtml(monitoringError)}`}</div>`

  const liveStatusLine = (live: LiveSnapshot): string => {
    if (live.status === 'not_configured') return statusPill('muted', 'LiveKit не е конфигуриран — живите стойности са недостъпни')
    if (live.status === 'unavailable') return statusPill('bad', `LiveKit API недостъпно${live.reason === null ? '' : ` — ${reasonText(live.reason)}`}`)
    if (live.status === 'partial') return statusPill('warn', `Частични данни — ${reasonText(live.reason)}`)
    return statusPill('ok', `Актуално · ${formatTime(live.sampledAt)}`)
  }

  const renderLive = (data: BaseSnapshot, live: LiveSnapshot): string => {
    const nowMs = Date.now()
    const t = live.totals
    const describe = (table: LiveTable) => {
      const phase = table.phase === 'waiting' ? 'Чакалня' : 'Игра'
      let state: string
      if (table.blocked === 'rotation_pending') state = statusPill('warn', 'Смяна на стаята')
      else if (table.blocked === 'releasing') state = statusPill('warn', 'Прекратява се')
      else if (table.liveRoomName === null || table.roomExists === false) state = statusPill('muted', 'Без активна стая')
      else if (table.roomExists === null) state = unavailableBadge()
      else state = statusPill('ok', 'Активна стая')
      const cell = (value: number | null) => value === null ? unavailableBadge('—') : escapeHtml(String(value))
      return { phase, state, cell, id: escapeHtml(table.voiceTableId.slice(0, 8)) }
    }
    const rows = live.tables.length === 0
      ? `<tr><td colspan="8" style="${MUTED}">Няма активни гласови маси.</td></tr>`
      : live.tables.map((table) => {
        const { phase, state, cell, id } = describe(table)
        return `<tr data-avc-table-row="1">
          <td><code style="font-size:12px;">${id}</code></td>
          <td>${phase}</td>
          <td style="white-space:nowrap;">${escapeHtml(sinceDuration(table.createdAt, nowMs))}</td>
          <td>${table.generation === null ? '—' : escapeHtml(String(table.generation))}</td>
          <td>${escapeHtml(String(table.seatedMembers))}</td>
          <td>${cell(table.counts.participants)}</td>
          <td>${cell(table.counts.microphoneOn)} / ${cell(table.counts.listening)}</td>
          <td>${state}</td>
        </tr>`
      }).join('')
    // Тесен екран: компактни карти вместо таблица (без хоризонтален скрол).
    const cards = live.tables.length === 0
      ? `<div style="font-size:13px;${MUTED}">Няма активни гласови маси.</div>`
      : live.tables.map((table) => {
        const { phase, state, cell, id } = describe(table)
        return `<div data-avc-table-card="1" style="padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <div style="font-size:13px;"><code style="font-size:12px;">${id}</code> · ${phase} · <span style="${MUTED}">${escapeHtml(sinceDuration(table.createdAt, nowMs))}</span></div>
            ${state}
          </div>
          <div style="margin-top:6px;display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:4px;font-size:12px;">
            <div><div style="${MUTED}">Седнали</div><b>${escapeHtml(String(table.seatedMembers))}</b></div>
            <div><div style="${MUTED}">В гласа</div><b>${cell(table.counts.participants)}</b></div>
            <div><div style="${MUTED}">Микрофон</div><b>${cell(table.counts.microphoneOn)}</b></div>
            <div><div style="${MUTED}">Слушат</div><b>${cell(table.counts.listening)}</b></div>
          </div>
        </div>`
      }).join('')
    const showValue = (value: number | null) => value === null ? unavailableBadge() : escapeHtml(String(value))
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="font-size:13px;${MUTED}">Живи стойности от LiveKit (кеш до 20 s)</div>
        ${liveStatusLine(live)}
      </div>
      <div data-avc-tiles="1">
        ${tile('Резервирани маси', `${escapeHtml(String(t.reservedTables))} <span style="font-size:14px;${MUTED}">/ ${escapeHtml(String(data.maxTables))}</span>`, 'спрямо лимита')}
        ${tile('Активни гласови стаи', showValue(t.activeRooms), 'реално в LiveKit')}
        ${tile('Свързани участници', showValue(t.participants))}
        ${tile('С включен микрофон', showValue(t.microphoneOn))}
        ${tile('Само слушат', showValue(t.listening))}
      </div>
      <div style="${CARD_STYLE}">
        <h3 style="${H3}">Текущи гласови маси</h3>
        <div data-avc-wide-only="1" style="overflow-x:auto;"><table>
          <thead><tr><th>Маса</th><th>Фаза</th><th>Отворена от</th><th>Генерация</th><th>Седнали</th><th>В гласа</th><th>Микр. / слуша</th><th>Състояние</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        <div data-avc-narrow-only="1">${cards}</div>
        <div style="margin-top:8px;font-size:12px;line-height:1.45;${MUTED}">Без имена и идентичности на участниците. „Седнали“ — реални играчи на масата; „В гласа“ — свързани в LiveKit стаята.</div>
      </div>`
  }

  const qualityRow = (label: string, metric: QualityMetric, unit: string, scale = 1, digits = 1): [string, string] => {
    const pick = metric.intervalMean ?? metric.current
    const value = pick === null ? null : pick * scale
    const lifetime = metric.lifetimeMean === null ? '' : ` <span style="font-weight:400;${MUTED}">(общо ${formatNumber(metric.lifetimeMean * scale, digits)}${unit})</span>`
    if (value === null) {
      const hint = metric.lifetimeMean !== null ? 'няма нови данни' : UNAVAILABLE
      return [label, `${unavailableBadge(hint)}${lifetime}`]
    }
    return [label, `${escapeHtml(formatNumber(value, digits))}${escapeHtml(unit)}${lifetime}`]
  }

  const renderStats = (m: Monitoring): string => {
    const s = m.server
    const c = m.clients
    const q = m.vps.liveKit.quality
    const lkOk = m.vps.liveKit.status === 'ok'
    const denialRows = Object.entries(s.tokensDeniedByCode).sort((a, b) => b[1] - a[1])
    const denialTable = denialRows.length === 0
      ? `<div style="font-size:13px;${MUTED}">Няма откази.</div>`
      : `<table><tbody>${denialRows.map(([code, count]) => `<tr><td>${escapeHtml(DENIAL_LABELS[code] ?? code)} <code style="font-size:11px;${MUTED}">${escapeHtml(code)}</code></td><td style="text-align:right;font-weight:800;">${count}</td></tr>`).join('')}</tbody></table>`
    const failureRows = Object.entries(c.failures).sort((a, b) => b[1] - a[1])
    const failureTable = failureRows.length === 0
      ? `<div style="font-size:13px;${MUTED}">Няма отчетени грешки.</div>`
      : `<table><tbody>${failureRows.map(([code, count]) => `<tr><td>${escapeHtml(CLIENT_FAILURE_LABELS[code] ?? code)}</td><td style="text-align:right;font-weight:800;">${count}</td></tr>`).join('')}</tbody></table>`
    const attempts = c.events.connected! + c.events.connect_failed!
    const successRate = attempts === 0 ? null : (c.events.connected! / attempts) * 100
    const candidate = (key: string) => escapeHtml(String(c.transport.byCandidateType[key] ?? 0))
    const relayProtocols = Object.entries(c.transport.relayByProtocol).map(([protocol, count]) => `${protocol.toUpperCase()}: ${count}`).join(' · ')
    const lkNote = lkOk ? '' : `<div style="margin-bottom:8px;">${statusPill(m.vps.liveKit.status === 'not_configured' ? 'muted' : 'bad', m.vps.liveKit.status === 'not_configured' ? 'Метриките на гласовия VPS не са конфигурирани' : `Метриките на LiveKit са недостъпни — ${reasonText(m.vps.liveKit.reason)}`)}</div>`
    return `
      <div style="font-size:12px;margin-bottom:10px;${MUTED}">Броячите са от последния рестарт на игровия сървър (${escapeHtml(formatDate(s.since))}).</div>
      <div data-avc-tiles="1">
        ${tile('Успешни включвания', escapeHtml(String(c.events.connected)), `клиентски отчети${successRate === null ? '' : ` · ${formatPercent(successRate)}`}`)}
        ${tile('Неуспешни включвания', escapeHtml(String(c.events.connect_failed)), 'клиентски отчети')}
        ${tile('Издадени токени', escapeHtml(String(s.tokensIssued)), `отказани: ${s.tokensDenied}`)}
        ${tile('Reconnect събития', escapeHtml(String(c.events.reconnecting)), `успешни: ${c.events.reconnected} · загубени: ${c.events.connection_lost}`)}
        ${tile('През TURN', c.transport.relayPercent === null ? unavailableBadge() : escapeHtml(formatPercent(c.transport.relayPercent)), `${c.transport.reports} отчета за връзката`)}
      </div>
      <div data-avc-cols="1">
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Откази на сървъра (токен)</h3>
          ${denialTable}
        </div>
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Грешки при клиента</h3>
          ${failureTable}
          <div style="margin-top:8px;">${kvRows([
            ['Неуспешно възстановяване след загуба', escapeHtml(String(c.events.reconnect_failed))],
            ['Отхвърлени отчети (невалидни/лимит)', escapeHtml(String(c.rejectedReports))],
          ])}</div>
        </div>
      </div>
      <div data-avc-cols="1">
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Връзка на клиентите (WebRTC)</h3>
          ${kvRows([
            ['Директно (host)', candidate('host')],
            ['Директно през NAT (srflx/prflx)', escapeHtml(String((c.transport.byCandidateType.srflx ?? 0) + (c.transport.byCandidateType.prflx ?? 0)))],
            ['През TURN (relay)', `${candidate('relay')}${relayProtocols === '' ? '' : ` <span style="font-weight:400;${MUTED}">(${escapeHtml(relayProtocols)})</span>`}`],
            ['Неизвестно', candidate('unknown')],
            ['RTT (средно)', c.transport.rttMs.mean === null ? unavailableBadge() : `${escapeHtml(formatNumber(c.transport.rttMs.mean, 0))} ms`],
            ['Jitter (средно)', c.transport.jitterMs.mean === null ? unavailableBadge() : `${escapeHtml(formatNumber(c.transport.jitterMs.mean, 1))} ms`],
            ['Загуба на пакети (средно)', c.transport.packetLossPercent.mean === null ? unavailableBadge() : escapeHtml(formatPercent(c.transport.packetLossPercent.mean, 2))],
          ])}
          <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">По един отчет на връзка (getStats() в браузъра), средно от последните 200. Без адреси и IP.</div>
        </div>
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Качество според LiveKit сървъра</h3>
          ${lkNote}
          ${kvRows([
            qualityRow('RTT', q.rttMs, ' ms', 1, 0),
            qualityRow('Jitter', q.jitterUs, ' ms', 0.001, 1),
            qualityRow('Загуба на пакети', q.packetLossPercent, ' %', 1, 2),
            qualityRow('Оценка на качеството', q.qualityScore, '', 1, 2),
            qualityRow('Рейтинг на качеството', q.qualityRating, '', 1, 2),
            qualityRow('Време за влизане', q.joinLatencyMs, ' ms', 1, 0),
          ])}
          <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">Средно за интервала между двете последни четения; в скоби — от старта на LiveKit. Включва всички стаи на гласовия сървър.</div>
        </div>
      </div>
      <div style="${CARD_STYLE}">
        <h3 style="${H3}">Сървърни събития</h3>
        <div data-avc-cols="1">
          <div>${kvRows([
            ['Ротации на стаи', escapeHtml(String(s.rotations))],
            ['Неуспешни CreateRoom', escapeHtml(String(s.createRoomFailures))],
            ['Изтекло присъствие (lease)', escapeHtml(String(s.leaseExpired))],
            ['Прекратени след 120 s без игрова връзка', escapeHtml(String(s.disconnectTimeouts))],
            ['Отключено говорене (придобит VIP)', escapeHtml(String(s.speakUpgrades))],
            ['Отнето говорене (наказание)', escapeHtml(String(s.muteRevocations))],
          ])}</div>
          <div>${kvRows([
            ['LiveKit API — успешни заявки', escapeHtml(String(s.liveKitRequests.succeeded))],
            ['LiveKit API — неуспешни заявки', escapeHtml(String(s.liveKitRequests.failed))],
            ['Отказани (circuit breaker)', escapeHtml(String(s.liveKitRequests.rejectedBreakerOpen))],
            ['Отказани (пълна опашка)', escapeHtml(String(s.liveKitRequests.rejectedQueueFull))],
            ['Circuit breaker', s.breaker === 'closed' ? statusPill('ok', 'Затворен (нормално)') : s.breaker === 'open' ? statusPill('bad', 'Отворен') : statusPill('warn', 'Пробна заявка')],
          ])}</div>
        </div>
      </div>`
  }

  const sourceLine = (label: string, source: SourceStatus): string => {
    const pill = source.status === 'ok'
      ? statusPill('ok', 'Достъпно')
      : source.status === 'not_configured' ? statusPill('muted', 'Не е конфигурирано') : statusPill('bad', `Недостъпно${source.reason === null ? '' : ` — ${reasonText(source.reason)}`}`)
    const last = source.status !== 'ok' && source.lastSuccessAt !== null ? `<div style="font-size:12px;${MUTED}">Последно успешно: ${escapeHtml(formatDate(source.lastSuccessAt))}</div>` : ''
    return `<div style="margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;"><span>${escapeHtml(label)}</span>${pill}</div>${last}</div>`
  }

  const renderVps = (m: Monitoring): string => {
    const vps = m.vps
    const lk = vps.liveKit
    const hostData = vps.host
    if (!vps.configured) {
      return `
        <div style="${CARD_STYLE}font-size:13px;line-height:1.55;">
          ${statusPill('muted', 'Метриките на гласовия VPS не са конфигурирани')}
          <div style="margin-top:8px;">Всички показатели са ${unavailableBadge()}. За да се появят, на игровия сървър трябва да се зададат <code>VOICE_VPS_METRICS_URL</code>, <code>VOICE_VPS_METRICS_USERNAME</code> и <code>VOICE_VPS_METRICS_PASSWORD</code>, а на гласовия VPS — защитеният Caddy маршрут (ops/voice-metrics-caddy).</div>
        </div>`
    }
    const computing = hostData.status === 'ok' && vps.rateWindowSeconds === null ? 'Изчислява се…' : UNAVAILABLE
    const rateValue = (value: number | null, format: (v: number | null) => string) => value === null ? unavailableBadge(hostData.status === 'ok' ? computing : UNAVAILABLE) : escapeHtml(format(value))
    const perCpu = hostData.perCpu.length === 0
      ? `<div style="font-size:13px;">${unavailableBadge()}</div>`
      : `<div style="display:grid;grid-template-columns:52px minmax(0,1fr) 78px;gap:6px 8px;align-items:center;font-size:12px;margin-bottom:4px;"><span></span><span style="${MUTED}">заетост</span><span style="text-align:right;${MUTED}">steal</span></div>` +
        hostData.perCpu.map((cpu) => `<div data-avc-cpu-row="1" style="display:grid;grid-template-columns:52px minmax(0,1fr) 78px;gap:6px 8px;align-items:center;margin-bottom:6px;font-size:12px;"><span style="${MUTED}">vCPU ${escapeHtml(cpu.cpu)}</span>${cpu.busyPercent === null ? unavailableBadge(computing) : bar(cpu.busyPercent)}<span style="text-align:right;font-weight:800;">${cpu.stealPercent === null ? unavailableBadge('—') : escapeHtml(formatPercent(cpu.stealPercent))}</span></div>`).join('')
    const networkRows = hostData.network.length === 0
      ? `<tr><td colspan="3">${unavailableBadge()}</td></tr>`
      : hostData.network.map((device) => `<tr><td><code>${escapeHtml(device.device)}</code></td><td>${rateValue(device.receiveBytesPerSecond, formatBitrate)}<div style="font-size:11px;${MUTED}">общо ${escapeHtml(formatBytes(device.receiveBytesTotal))}</div></td><td>${rateValue(device.transmitBytesPerSecond, formatBitrate)}<div style="font-size:11px;${MUTED}">общо ${escapeHtml(formatBytes(device.transmitBytesTotal))}</div></td></tr>`).join('')
    const memoryUsed = hostData.memory.totalBytes !== null && hostData.memory.availableBytes !== null ? hostData.memory.totalBytes - hostData.memory.availableBytes : null
    const overall = lk.status === 'ok' && hostData.status === 'ok' ? statusPill('ok', 'Работи') : lk.status === 'ok' || hostData.status === 'ok' ? statusPill('warn', 'Частично достъпно') : statusPill('bad', 'Недостъпно')
    return `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <div style="font-size:13px;${MUTED}">Четене: ${escapeHtml(formatTime(vps.sampledAt))}${vps.rateWindowSeconds === null ? '' : ` · интервал ${formatNumber(vps.rateWindowSeconds, 0)} s`} (кеш до 20 s)</div>
        ${overall}
      </div>
      <div data-avc-tiles="1">
        ${tile('CPU общо', hostData.cpuBusyPercent === null ? unavailableBadge(hostData.status === 'ok' ? computing : UNAVAILABLE) : escapeHtml(formatPercent(hostData.cpuBusyPercent)), hostData.cpuCount === null ? '' : `${hostData.cpuCount} vCPU`)}
        ${tile('CPU steal', hostData.cpuStealPercent === null ? unavailableBadge(hostData.status === 'ok' ? computing : UNAVAILABLE) : escapeHtml(formatPercent(hostData.cpuStealPercent)), 'отнето от хипервайзора')}
        ${tile('RAM', hostData.memory.usedPercent === null ? unavailableBadge() : escapeHtml(formatPercent(hostData.memory.usedPercent)), memoryUsed === null ? '' : `${escapeHtml(formatBytes(memoryUsed))} / ${escapeHtml(formatBytes(hostData.memory.totalBytes))}`)}
        ${tile('Uptime на VPS', valueOrUnavailable(formatDuration(hostData.uptimeSeconds)), hostData.bootedAt === null ? '' : `старт ${escapeHtml(formatDate(hostData.bootedAt))}`)}
        ${tile('LiveKit', lk.version === null ? unavailableBadge('Версия: недостъпно') : `v${escapeHtml(lk.version)}`, lk.uptimeSeconds === null ? '' : `работи ${escapeHtml(formatDuration(lk.uptimeSeconds))}`)}
      </div>
      <div data-avc-cols="1">
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">Статус</h3>
          ${sourceLine('LiveKit метрики (127.0.0.1:6789)', lk)}
          ${sourceLine('Node Exporter (127.0.0.1:9100)', hostData)}
          ${kvRows([
            ['Версия на LiveKit', lk.version === null ? unavailableBadge() : escapeHtml(lk.version)],
            ['Uptime на LiveKit', valueOrUnavailable(formatDuration(lk.uptimeSeconds))],
            ['Последен рестарт на LiveKit', lk.processStartedAt === null ? unavailableBadge() : escapeHtml(formatDate(lk.processStartedAt))],
            ['Последен рестарт на VPS', hostData.bootedAt === null ? unavailableBadge() : escapeHtml(formatDate(hostData.bootedAt))],
            ['Стаи / участници (целият сървър)', lk.rooms === null ? unavailableBadge() : `${escapeHtml(formatNumber(lk.rooms))} / ${escapeHtml(formatNumber(lk.participants))}`],
            ['Публикувани / абонирани потоци', lk.tracksPublished === null ? unavailableBadge() : `${escapeHtml(formatNumber(lk.tracksPublished))} / ${escapeHtml(formatNumber(lk.tracksSubscribed))}`],
          ])}
        </div>
        <div style="${CARD_STYLE}">
          <h3 style="${H3}">CPU по vCPU</h3>
          ${perCpu}
          <div style="margin-top:8px;">${kvRows([
            ['Натиск върху CPU (PSI)', hostData.cpuPressureWaitingPercent === null ? unavailableBadge() : escapeHtml(formatPercent(hostData.cpuPressureWaitingPercent))],
            ['Натоварване (1 / 5 / 15 мин)', hostData.load.one === null ? unavailableBadge() : escapeHtml(`${formatNumber(hostData.load.one, 2)} / ${formatNumber(hostData.load.five, 2)} / ${formatNumber(hostData.load.fifteen, 2)}`)],
            ['Swap в употреба', hostData.memory.swapUsedBytes === null ? unavailableBadge() : escapeHtml(formatBytes(hostData.memory.swapUsedBytes))],
          ])}</div>
          <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">Контейнерът на LiveKit е без CPU quota, затова cgroup throttling не се прилага; показва се натискът върху CPU (PSI), ако Node Exporter го събира.</div>
        </div>
      </div>
      <div style="${CARD_STYLE}">
        <h3 style="${H3}">Мрежов трафик</h3>
        <div style="overflow-x:auto;"><table><thead><tr><th>Интерфейс</th><th>Входящ</th><th>Изходящ</th></tr></thead><tbody>${networkRows}</tbody></table></div>
      </div>`
  }

  const render = () => {
    if (closed) return
    renderTabs()
    renderBanners()
    updatedEl.textContent = monitoring === null ? '' : `Обновено ${formatTime(monitoring.generatedAt)}`
    if (base === null) {
      bodyEl.innerHTML = `<div style="${CARD_STYLE}font-size:13px;">${loadError === null ? 'Зареждане…' : 'Данните не са заредени.'}</div>`
      return
    }
    if (tab === 'control') bodyEl.innerHTML = renderControl(base)
    else if (monitoring === null) bodyEl.innerHTML = monitoringUnavailable()
    else if (tab === 'live') bodyEl.innerHTML = renderLive(base, monitoring.live)
    else if (tab === 'stats') bodyEl.innerHTML = renderStats(monitoring)
    else bodyEl.innerHTML = renderVps(monitoring)
  }

  // ─── Данни ────────────────────────────────────────────────────────────

  function scheduleRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    if (closed || refreshMs <= 0) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (document.visibilityState === 'hidden') {
        scheduleRefresh()
        return
      }
      void load()
    }, refreshMs)
  }

  async function load(): Promise<void> {
    if (loading || closed) return
    loading = true
    const [baseResult, monitoringResult] = await Promise.all([api('GET', ''), api('GET', '/monitoring')])
    loading = false
    if (closed) return
    if (baseResult.ok) {
      base = baseResult.data as unknown as BaseSnapshot
      loadError = null
      // След изключване: съобщението се сменя едва при потвърдено изтриване.
      if (awaitingRoomDeletion && base.pendingRoomDeletions === 0 && offNoticeContext !== null) {
        awaitingRoomDeletion = false
        showNotice(`${offNoticeContext.successText} Прекратени гласови маси: ${offNoticeContext.released}. LiveKit стаите са изтрити (потвърдено).`)
      }
    } else {
      loadError = baseResult.status === 403 ? 'Нямаш достъп до този панел.' : baseResult.message
    }
    if (monitoringResult.ok) {
      monitoring = monitoringResult.data as unknown as Monitoring
      monitoringError = null
    } else {
      monitoringError = monitoringResult.message
    }
    render()
    scheduleRefresh()
  }

  async function applyMode(mode: VoiceMode, successText: string): Promise<void> {
    busy = true
    render()
    const result = await api('POST', '/mode', { mode, confirm: true })
    busy = false
    if (closed) return
    if (result.ok) {
      base = result.data as unknown as BaseSnapshot
      pendingMode = null
      emergencyConfirmOpen = false
      if (mode === 'off') {
        // Реалният резултат: масите са освободени и токените спрени веднага, но
        // DeleteRoom е асинхронен — потвърждението идва с pendingRoomDeletions.
        const released = typeof result.data.releasedVoiceTables === 'number' ? result.data.releasedVoiceTables : 0
        const retired = typeof result.data.retiredRooms === 'number' ? result.data.retiredRooms : 0
        const pending = typeof result.data.pendingRoomDeletions === 'number' ? result.data.pendingRoomDeletions : null
        offNoticeContext = { successText, released }
        if (retired > 0 && (pending === null || pending > 0)) {
          awaitingRoomDeletion = true
          showNotice(`${successText} Прекратени гласови маси: ${released}; нови токени не се издават. Изтриването на ${retired} LiveKit ${retired === 1 ? 'стая чака' : 'стаи чака'} потвърждение от гласовия сървър — дотогава свързаните участници може още да се чуват.`)
        } else {
          awaitingRoomDeletion = false
          showNotice(`${successText} Прекратени гласови маси: ${released}. ${retired === 0 ? 'Нямаше активни LiveKit стаи.' : 'LiveKit стаите са изтрити (потвърдено).'}`)
        }
      } else {
        awaitingRoomDeletion = false
        showNotice(successText)
      }
      void load()
    } else {
      showNotice(result.message, 'error')
    }
    render()
  }

  // ─── Събития ──────────────────────────────────────────────────────────

  const close = () => {
    if (closed) return
    closed = true
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    document.removeEventListener('keydown', onKeyDown)
    host.remove()
    previouslyFocused?.focus?.()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKeyDown)

  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (target === null) return
    if (target.closest('[data-avc-close="1"]') !== null) { close(); return }
    if (target.closest('[data-avc-refresh="1"]') !== null) { void load(); return }
    const tabButton = target.closest<HTMLElement>('[data-avc-tab]')
    if (tabButton !== null) {
      tab = tabButton.dataset.avcTab as Tab
      showNotice(null)
      render()
      return
    }
    const modeButton = target.closest<HTMLElement>('[data-avc-mode]')
    if (modeButton !== null && base !== null && !busy) {
      const mode = modeButton.dataset.avcMode as VoiceMode
      pendingMode = mode === base.mode ? null : mode
      emergencyConfirmOpen = false
      render()
      return
    }
    if (target.closest('[data-avc-mode-cancel="1"]') !== null) { pendingMode = null; render(); return }
    if (target.closest('[data-avc-mode-apply="1"]') !== null && pendingMode !== null && !busy) {
      void applyMode(pendingMode, `Режимът е сменен на „${MODE_LABELS[pendingMode]}“.`)
      return
    }
    if (target.closest('[data-avc-emergency="1"]') !== null && base !== null && base.mode !== 'off' && !busy) {
      emergencyConfirmOpen = true
      pendingMode = null
      render()
      return
    }
    if (target.closest('[data-avc-emergency-cancel="1"]') !== null) { emergencyConfirmOpen = false; render(); return }
    if (target.closest('[data-avc-emergency-apply="1"]') !== null && !busy) {
      void applyMode('off', 'Гласът е изключен аварийно. Игрите продължават.')
      return
    }
    if (target.closest('[data-avc-limit-save="1"]') !== null && !busy) {
      const input = host.querySelector<HTMLInputElement>('[data-avc-limit-input="1"]')
      const value = Number(input?.value ?? '')
      if (!Number.isInteger(value) || value < 0 || (base !== null && value > base.maxTablesUpperBound)) {
        showNotice(`Лимитът трябва да е цяло число от 0 до ${base?.maxTablesUpperBound ?? 200}.`, 'error')
        return
      }
      busy = true
      render()
      void api('POST', '/limit', { maxTables: value }).then((result) => {
        busy = false
        if (closed) return
        if (result.ok) {
          base = result.data as unknown as BaseSnapshot
          showNotice(`Лимитът е ${value}.`)
        } else {
          showNotice(result.message, 'error')
        }
        render()
      })
      return
    }
    // Клик върху фона (извън диалога) затваря панела.
    if (target === host || (target.parentElement === host && target.closest('section') === null)) close()
  })

  render()
  void load()
  return { close }
}

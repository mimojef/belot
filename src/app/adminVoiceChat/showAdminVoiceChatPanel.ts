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
  /** Липсва при по-стар сървър. */
  rotationsByReason?: Record<string, number>
  /** Диагностика на прекратяванията (липсват при по-стар сървър). */
  sessionEndsByReason?: Record<string, number>
  bindingEndsByReason?: Record<string, number>
  presenceDeniedByCode?: Record<string, number>
  tokenLeaseMargin?: Record<string, number>
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
  /** Липсват при по-стар сървър. */
  mic?: {
    attempts: Record<string, Record<string, number>>
    interruptions: Record<string, { recovered: number; lost: number; other: number }>
    failures: Record<string, number>
    gum: Record<string, number>
    lost: Record<string, number>
  }
  liveKitDisconnects?: Record<string, number>
  sessionEnds?: { byReason: Record<string, number>; failStages: Record<string, number> }
  /** Етап H — липсват при по-стар сървър. */
  media?: {
    input: Record<string, number>
    inputEvidence: Record<string, number>
    output: Record<string, number>
    recovery: Record<string, number>
    micRecovery?: Record<string, number>
    byPlatform: Record<string, number>
  }
  recent?: Array<{ at: string; event: string; detail: string; platform: string }>
  recentLimit?: number
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

const MIC_SOURCE_LABELS: Record<string, string> = {
  initial: 'Първоначално включване',
  panel: 'Ръчно през панела',
}

const MIC_INTERRUPTION_LABELS: Record<string, string> = {
  sdk_reconnect: 'Възстановяване на връзката (LiveKit)',
  connection_lost: 'Загубена връзка (нова сесия)',
  rotation: 'Ротация на стаята',
  room_deleted: 'Изтрита стая (LiveKit)',
}

const MIC_FAILURE_LABELS: Record<string, string> = {
  permission_denied: 'Отказано разрешение',
  not_found: 'Няма микрофон',
  device_busy: 'Устройството е заето',
  gum_failed: 'Друга грешка на устройството',
  publish_failed: 'Публикуване — друга грешка',
  publish_cancelled: 'Публикуване — отменено от reconnect',
  publish_timeout: 'Публикуване — няма отговор (timeout)',
  publish_negotiation: 'Публикуване — неуспешно договаряне (WebRTC)',
  publish_not_connected: 'Публикуване — няма връзка',
  not_permitted: 'Няма право за говорене',
  acquired_not_published: 'Придобит, но непубликуван (изгубено намерение)',
  session_failed: 'Гласовата сесия не се възстанови',
}

const MIC_GUM_LABELS: Record<string, string> = {
  lt1s: 'под 1 s',
  '1to5s': '1–5 s',
  '5to15s': '5–15 s',
  gt15s: 'над 15 s',
}

const MIC_LOST_LABELS: Record<string, string> = {
  track_ended: 'Спрял track (устройство/OS)',
  republish_failed: 'Неуспешно републикуване след reconnect',
  server_unpublished: 'Премахнат от сървъра',
  device_removed: 'Изключено устройство',
  rotation: 'При ротация',
  connection_lost: 'При загубена връзка',
}

// Етап H — медийно здраве (затворени стойности от клиентите).
const MEDIA_INPUT_LABELS: Record<string, string> = {
  system_muted: 'Микрофонът е прекъснат от устройството',
  system_unmuted: 'Устройството освободи микрофона',
  stall_suspected: 'Подозрение: микрофонът не предава (RTP стои)',
  stall_cleared: 'Предаването се възстанови',
}
const MEDIA_EVIDENCE_LABELS: Record<string, string> = {
  packets_only: 'Само по пакетите (без media-source)',
  capture_stalled: 'Capture-ът не дава кадри',
  capture_active: 'Capture-ът дава кадри, RTP стои',
}
const MEDIA_OUTPUT_LABELS: Record<string, string> = {
  element_paused: 'Неочаквано спрян звук (пауза)',
  element_missing: 'Неправилно прикачен звук',
  playback_blocked: 'Нужно е натискане („Включи звука“)',
  remote_stall_suspected: 'Говори, но звукът не пристига (допълнителен сигнал)',
}
const MEDIA_RECOVERY_LABELS: Record<string, string> = {
  'play:success': 'Пуснат отново — успех',
  'play:failed': 'Пуснат отново — неуспех',
  'play:gesture_required': 'Пуснат отново — нужно натискане',
  'play:limited': 'Пуснат отново — лимит',
  'reattach:success': 'Прикачен отново — успех',
  'reattach:failed': 'Прикачен отново — неуспех',
  'reattach:gesture_required': 'Прикачен отново — нужно натискане',
  'reattach:limited': 'Прикачен отново — лимит',
  'start_audio:success': '„Включи звука“ — успех',
}
const MIC_RECOVERY_OUTCOME_LABELS: Record<string, string> = {
  recovered: 'възстановен', no_rtp: 'без звук след замяната', gum_failed: 'грешка на микрофона', gum_denied: 'отказано разрешение',
  replace_failed: 'неуспешна замяна', aborted: 'отменено', not_confirmed: 'спирането не е потвърдено', unavailable: 'няма показатели',
  permission_required: 'нужно натискане (разрешение)', cooldown: 'пауза след неуспех', limit: 'лимит (3 за 10 мин)',
  capture_active: 'микрофонът дава звук, предаването стои', disabled: 'автоматичното е изключено',
}
const MIC_RECOVERY_LABELS: Record<string, string> = Object.fromEntries(
  ['auto', 'manual'].flatMap((mode) => Object.entries(MIC_RECOVERY_OUTCOME_LABELS).map(([outcome, label]) => [`${mode}:${outcome}`, `${mode === 'auto' ? 'Автоматично' : 'Ръчно'} — ${label}`])),
)
const PLATFORM_LABELS: Record<string, string> = {
  ios_safari: 'iPhone/iPad · Safari', ios_pwa: 'iPhone/iPad · приложение (PWA)', ios_other: 'iPhone/iPad · друг браузър',
  android_chrome: 'Android · Chrome', android_samsung: 'Android · Samsung Internet', android_pwa: 'Android · приложение (PWA)', android_other: 'Android · друг',
  desktop_chrome: 'Компютър · Chrome', desktop_edge: 'Компютър · Edge', desktop_safari: 'Компютър · Safari', desktop_firefox: 'Компютър · Firefox', desktop_other: 'Компютър · друг',
  unknown: 'Неизвестна',
}
const LIVEKIT_DISCONNECT_LABELS: Record<string, string> = {
  network: 'Мрежа / неизвестна',
  server_shutdown: 'Спиране на сървъра',
  room_deleted: 'Изтрита стая',
  participant_removed: 'Премахнат участник',
  duplicate_identity: 'Същият участник влезе отново',
  join_failure: 'Неуспешно влизане',
  signal_close: 'Затворен сигнален канал',
  state_mismatch: 'Несъответствие в състоянието',
  migration: 'Миграция',
  client: 'Клиентът',
  other: 'Друга',
}

const SESSION_END_LABELS: Record<string, string> = {
  leave_voice: '„Напусни гласа“',
  off_table: 'Извън масата („Изчакай в лоби“ / друг екран)',
  page_hide: 'Затваряне или скриване на страницата',
  page_restored: 'Страница от кеша (назад/напред)',
  context_changed: 'Смяна на масата / контекста',
  fail_connection: 'Неуспешно свързване („недостъпен“)',
  disabled: 'Изключен глас',
  access_ended: 'Прекратен от сървъра',
  removed: 'Отстранен в LiveKit',
  duplicate_identity: 'Същият участник влезе отново',
  game_connection_timeout: '120 s без игрова връзка',
  disposed: 'Затворен гласов модул',
  unspecified: 'Без посочена причина (стар клиент)',
}

const SERVER_SESSION_END_LABELS: Record<string, string> = {
  lease_expired: 'Изтекло присъствие (lease)',
  game_connection_lost: '120 s без игрова връзка',
}

const FAIL_STAGE_LABELS: Record<string, string> = {
  sdk_load: 'Зареждане на гласовия модул',
  presence: 'Присъствие (presence)',
  token: 'Токен',
  connect: 'Свързване с LiveKit',
  reconnect_exhausted: 'Изчерпани опити за възстановяване',
  rotation_resume: 'Свързване след ротация',
  permissions_reconnect: 'Нов токен за говорене',
}

const ACCESS_END_LABELS: Record<string, string> = {
  left_table: 'Напуснал масата',
  kicked: 'Изгонен',
  banned: 'Бан',
  session_replaced: 'Нова страница на същия играч',
  session_displaced: 'Изместена игрова сесия',
}

const PRESENCE_DENIAL_LABELS: Record<string, string> = {
  not_seat_connection: 'Не е връзката на мястото',
  not_a_player: 'Не е играч на масата',
  table_not_found: 'Няма такава маса',
  table_released: 'Освободена маса',
  voice_off: 'Изключен глас',
  banned: 'Бан',
  not_authenticated: 'Без вход',
  client_instance_conflict: 'Конфликт на страницата',
}

const LEASE_MARGIN_LABELS: Record<string, string> = {
  lt5s: 'под 5 s',
  '5to15s': '5–15 s',
  '15to30s': '15–30 s',
  gt30s: 'над 30 s',
}

/** server: left_table:<причина от клиента> / lease_expired / game_connection_lost */
function serverSessionEndLabel(key: string): string {
  if (key.startsWith('left_table:')) return `Напуснал екрана — ${SESSION_END_LABELS[key.slice('left_table:'.length)] ?? key}`
  return SERVER_SESSION_END_LABELS[key] ?? key
}

/** <причина>:rotation|no_rotation */
function bindingEndLabel(key: string): string {
  const [reason = key, rotation] = key.split(':')
  return `${ACCESS_END_LABELS[reason] ?? reason}${rotation === 'rotation' ? ' — с ротация' : ''}`
}

const ROTATION_REASON_LABELS: Record<string, string> = {
  listen_revoked: 'Отнето право за слушане (напускане/изгонване/бан)',
  speak_revoked: 'Отнето право за говорене',
  session_displaced: 'Изместена игрова сесия',
  table_released: 'Освободена маса',
  mode_off: 'Изключен глас',
  boot_rotation: 'След рестарт на сървъра',
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

/** UTC минута от сървъра -> българско време (дд.мм, чч:мм). */
function formatSofiaMinute(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

type RecentEntry = NonNullable<ClientStats['recent']>[number]

/** Идентичност на ред от „Последни събития“ (за котвата на скрола). */
function recentSignature(entry: RecentEntry): string {
  return `${entry.at}\u0001${entry.event}\u0001${entry.platform}\u0001${entry.detail}`
}

/**
 * С колко реда е изместен старият списък в новия (най-новите са първи, така че
 * новите събития се добавят отгоре, а при пълен буфер най-старите отпадат отдолу).
 * null — няма съвпадение (напр. рестарт на сървъра).
 */
function recentShift(previous: readonly string[], next: readonly string[]): number | null {
  if (previous.length === 0 || next.length === 0) return null
  for (let shift = 0; shift < next.length; shift += 1) {
    const overlap = Math.min(previous.length, next.length - shift)
    let same = true
    for (let index = 0; index < overlap; index += 1) {
      if (next[shift + index] !== previous[index]) { same = false; break }
    }
    if (same) return shift
  }
  return null
}

/** „Копирай лога“: цялата секция „Медийно здраве“ като четим текст (без DOM). */
function buildMediaHealthLogText(m: Monitoring): string {
  const c = m.clients
  const media = c.media
  const recent = c.recent ?? []
  const lines: string[] = [
    'Гласови разговори — Медийно здраве',
    `Генерирано: ${formatDate(m.generatedAt)} (${m.generatedAt})`,
    `Броячи от: ${formatDate(c.since)}`,
    '',
  ]
  const counts = (title: string, entries: Record<string, number> | undefined, labels: Record<string, string>) => {
    lines.push(`${title}:`)
    const rows = Object.entries(entries ?? {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
    if (rows.length === 0) lines.push('  няма')
    for (const [code, count] of rows) lines.push(`  ${labels[code] ?? code} [${code}]: ${count}`)
  }
  if (media === undefined) {
    lines.push('Броячи: сървърът още не отчита медийното здраве.')
  } else {
    counts('Микрофон (собствен поток)', media.input, MEDIA_INPUT_LABELS)
    counts('Допълнително при подозрение', media.inputEvidence, MEDIA_EVIDENCE_LABELS)
    counts('Възстановяване на микрофона', media.micRecovery, MIC_RECOVERY_LABELS)
    counts('Входящ звук', media.output, MEDIA_OUTPUT_LABELS)
    counts('Автоматично възстановяване на звука', media.recovery, MEDIA_RECOVERY_LABELS)
    counts('По платформа (медийни събития)', media.byPlatform, PLATFORM_LABELS)
  }
  lines.push('')
  lines.push(`Последни събития: ${recent.length} (до ${c.recentLimit ?? 500}, най-новите първи; време до минута)`)
  if (recent.length === 0) lines.push('  няма')
  for (const entry of recent) {
    const platform = PLATFORM_LABELS[entry.platform] ?? entry.platform
    lines.push(`${formatSofiaMinute(entry.at)} (${entry.at} UTC) | ${entry.event} | ${platform}${entry.detail === '' ? '' : ` | ${entry.detail}`}`)
  }
  return `${lines.join('\n')}\n`
}

type ViewState = {
  hostTop: number
  /** Котва на външния скрол: индекс на първия видим пряк наследник на тялото. */
  anchor: { index: number; count: number; top: number } | null
  scrolls: Map<string, { top: number; left: number }>
  /** Котва на „Последни събития“: първият видим ред и отместването му. */
  recent: { index: number; offset: number } | null
  inputs: Map<string, { value: string; rendered: string; focused: boolean }>
  details: Map<string, boolean>
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
  /** „Пауза на обновяването“: без автоматично обновяване; „Обнови“ работи. */
  let refreshPaused = false
  /** Автоматичното обновяване чака, докато в панела има маркиран текст. */
  let renderDeferred = false
  let renderedTabsHtml = ''
  let renderedBannersHtml = ''
  let renderedBodyHtml = ''
  let renderedTab: Tab | null = null
  let renderedRecent: string[] = []
  let shownGeneratedAt: string | null = null
  let copyStatus: { text: string; tone: 'ok' | 'error' } | null = null
  let copyStatusTimer: ReturnType<typeof setTimeout> | null = null

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
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
            <span data-avc-updated="1" role="status" aria-live="polite" style="font-size:12px;${MUTED}"></span>
            <button type="button" data-avc-pause="1" aria-pressed="false" style="${BTN_SECONDARY}">Пауза на обновяването</button>
            <button type="button" data-avc-refresh="1" style="${BTN_SECONDARY}">Обнови</button>
            <button type="button" data-avc-close="1" aria-label="Затвори" style="${BTN_SECONDARY}">Затвори</button>
          </div>
        </div>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.5;${MUTED}">Гласов чат в частните маси на Белот. Само технически показатели — без слушане, без записи и без имена на участниците.</p>
        <div data-avc-banners="1"></div>
        <div data-avc-tabs="1" data-avc-scroll="tabs" role="tablist" style="display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px;padding-bottom:2px;"></div>
        <div data-avc-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.45;"></div>
        <div data-avc-body="1"></div>
      </section>
    </div>`

  const tabsEl = host.querySelector<HTMLElement>('[data-avc-tabs="1"]')!
  const bannersEl = host.querySelector<HTMLElement>('[data-avc-banners="1"]')!
  const bodyEl = host.querySelector<HTMLElement>('[data-avc-body="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-avc-notice="1"]')!
  const updatedEl = host.querySelector<HTMLElement>('[data-avc-updated="1"]')!
  const pauseEl = host.querySelector<HTMLButtonElement>('[data-avc-pause="1"]')!

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

  const renderTabs = (): string => {
    const tabs: Array<[Tab, string]> = [['control', 'Управление'], ['live', 'Текущо състояние'], ['stats', 'Статистика и качество'], ['vps', 'Гласов VPS']]
    return tabs.map(([key, label]) => {
      const active = key === tab
      return `<button type="button" role="tab" aria-selected="${active}" data-avc-tab="${key}" style="flex:0 0 auto;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid ${active ? '#d4a520' : 'rgba(255,255,255,0.18)'};background:${active ? 'rgba(212,165,32,0.16)' : 'transparent'};color:${active ? '#f4c95b' : '#e2e8f0'};font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;">${escapeHtml(label)}</button>`
    }).join('')
  }

  const renderBanners = (): string => {
    const parts: string[] = []
    if (base?.emergencyStop === true) {
      parts.push(`<div style="${CARD_STYLE}border-color:rgba(248,113,113,0.5);background:rgba(248,113,113,0.08);color:#fecaca;font-size:13px;line-height:1.5;"><b>Авариен стоп от сървъра (VOICE_CHAT_ENABLED=0).</b> Гласът е изключен независимо от избрания режим. Отменя се само от средата на сървъра.</div>`)
    }
    if (loadError !== null) {
      parts.push(`<div style="${CARD_STYLE}border-color:rgba(248,113,113,0.45);color:#fecaca;font-size:13px;">${escapeHtml(loadError)}</div>`)
    }
    return parts.join('')
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
              <input type="number" min="0" max="${data.maxTablesUpperBound}" step="1" inputmode="numeric" data-avc-limit-input="1" data-avc-input="limit" value="${data.maxTables}" style="${INPUT_STYLE}width:110px;">
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
        <div data-avc-scroll="control-history" style="overflow-x:auto;"><table><thead><tr><th>Кога</th><th>Настройка</th><th>Промяна</th><th data-avc-hide-narrow="1">От</th></tr></thead><tbody>${historyRows}</tbody></table></div>
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
        <div data-avc-wide-only="1" data-avc-scroll="live-tables" style="overflow-x:auto;"><table>
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
    const countRows = (entries: Record<string, number> | undefined, labels: Record<string, string>, empty: string): string => {
      const rows = Object.entries(entries ?? {}).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1])
      return rows.length === 0
        ? `<div style="font-size:13px;${MUTED}">${escapeHtml(empty)}</div>`
        : `<table><tbody>${rows.map(([code, count]) => `<tr><td>${escapeHtml(labels[code] ?? code)}</td><td style="text-align:right;font-weight:800;">${count}</td></tr>`).join('')}</tbody></table>`
    }
    const mic = c.mic
    const MIC_RESULT_LABELS: Array<[string, string]> = [
      ['enabled', 'Включен'], ['recovered', 'Възстановен'], ['lost', 'Изгубен'], ['failed', 'Грешка'], ['cancelled', 'Отказан'],
    ]
    const micAttemptsTable = mic === undefined
      ? `<div style="font-size:13px;${MUTED}">Няма данни (по-стар сървър).</div>`
      : `<div style="margin-bottom:6px;font-size:12px;${MUTED}">Заявки: ${escapeHtml(MIC_SOURCE_LABELS.initial!)} / ${escapeHtml(MIC_SOURCE_LABELS.panel!)}</div>${
        kvRows(MIC_RESULT_LABELS.map(([result, label]): [string, string] => [label, `${mic.attempts.initial?.[result] ?? 0} / ${mic.attempts.panel?.[result] ?? 0}`]))
      }`
    const interruptionRows = Object.entries(mic?.interruptions ?? {})
    const micInterruptionTable = interruptionRows.length === 0
      ? `<div style="font-size:13px;${MUTED}">Няма прекъсвания по време на включване.</div>`
      : kvRows(interruptionRows.map(([kind, value]): [string, string] => [
        MIC_INTERRUPTION_LABELS[kind] ?? kind,
        `${value.recovered} / ${value.lost}${value.other > 0 ? ` / ${value.other}` : ''}`,
      ]))
    const gumRows = ['lt1s', '1to5s', '5to15s', 'gt15s'].map((bucket): [string, string] => [MIC_GUM_LABELS[bucket] ?? bucket, escapeHtml(String(mic?.gum[bucket] ?? 0))])
    const subTitle = (text: string, first = false): string => `<h4 style="margin:${first ? '0' : '10px'} 0 6px;font-size:13px;">${escapeHtml(text)}</h4>`
    // Етап H: медийно здраве — броячи и последните събития (UTC минута -> показва се в българско време).
    const media = c.media
    const recent = c.recent ?? []
    const recentRows = recent.length === 0
      ? `<div style="font-size:13px;${MUTED}">Няма събития.</div>`
      : `<div data-avc-media-recent="1" data-avc-scroll="media-recent" style="max-height:300px;overflow-y:auto;overflow-x:hidden;font-size:12px;">${recent.map((entry, index) => `<div data-avc-media-recent-row="1" data-avc-recent-index="${index}" style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);min-width:0;"><div style="display:flex;flex-wrap:wrap;gap:2px 10px;font-weight:800;"><span title="${escapeHtml(entry.at)} UTC" style="white-space:nowrap;">${escapeHtml(formatSofiaMinute(entry.at))}</span><span>${escapeHtml(entry.event)}</span><span style="font-weight:400;${MUTED}">${escapeHtml(PLATFORM_LABELS[entry.platform] ?? entry.platform)}</span></div>${entry.detail === '' ? '' : `<div style="overflow-wrap:anywhere;${MUTED}">${escapeHtml(entry.detail)}</div>`}</div>`).join('')}</div>`
    const copyStatusHtml = copyStatus === null
      ? ''
      : `<span style="font-size:12px;font-weight:800;color:${copyStatus.tone === 'ok' ? '#86efac' : '#fca5a5'};">${escapeHtml(copyStatus.text)}</span>`
    const mediaCard = `
      <div style="${CARD_STYLE}" data-avc-media="1">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
          <h3 style="${H3}margin:0;">Медийно здраве</h3>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span data-avc-media-copy-status="1" role="status" aria-live="polite">${copyStatusHtml}</span>
            <button type="button" data-avc-media-copy="1" style="${BTN_SECONDARY}">Копирай лога</button>
          </div>
        </div>
        ${media === undefined ? `<div style="font-size:13px;${MUTED}">Сървърът още не отчита медийното здраве.</div>` : `
        <div data-avc-cols="1">
          <div>
            ${subTitle('Микрофон (собствен поток)', true)}
            ${countRows(media.input, MEDIA_INPUT_LABELS, 'Няма събития.')}
            ${subTitle('Допълнително при подозрение')}
            ${countRows(media.inputEvidence, MEDIA_EVIDENCE_LABELS, 'Няма.')}
            ${subTitle('Възстановяване на микрофона')}
            ${countRows(media.micRecovery, MIC_RECOVERY_LABELS, 'Няма опити.')}
          </div>
          <div>
            ${subTitle('Входящ звук', true)}
            ${countRows(media.output, MEDIA_OUTPUT_LABELS, 'Няма събития.')}
            ${subTitle('Автоматично възстановяване на звука')}
            ${countRows(media.recovery, MEDIA_RECOVERY_LABELS, 'Няма опити.')}
            ${subTitle('По платформа (медийни събития)')}
            ${countRows(media.byPlatform, PLATFORM_LABELS, 'Няма.')}
          </div>
        </div>`}
        ${subTitle(`Последни събития (до ${c.recentLimit ?? 500}, най-новите първи)`)}
        ${recentRows}
        <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">„Подозрение“ не е доказан дефект: при него микрофонът не се възстановява автоматично. Без профили, IP, устройства и аудио; само в паметта на сървъра (последните ${c.recentLimit ?? 500} събития, време до минута).</div>
      </div>`
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
      <div style="${CARD_STYLE}" data-avc-mic="1">
        <h3 style="${H3}">Микрофон</h3>
        ${micAttemptsTable}
        <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">„Възстановен“ — включен след прекъсване/ротация по време на заявката (не е грешка). „Изгубен“ — окончателно изгубено намерение („Микрофонът не беше включен“). „Отказан“ — доброволно изключване/напускане.</div>
        <div data-avc-cols="1" style="margin-top:10px;">
          <div>
            ${subTitle('Прекъсвания по време на включване (възстановени / изгубени)', true)}
            ${micInterruptionTable}
            ${subTitle('Причини за неуспех')}
            ${countRows(mic?.failures, MIC_FAILURE_LABELS, 'Няма неуспехи.')}
          </div>
          <div>
            ${subTitle('Време за разрешение (getUserMedia)', true)}
            ${kvRows(gumRows)}
            ${subTitle('Загубен включен микрофон')}
            ${countRows(mic?.lost, MIC_LOST_LABELS, 'Няма загубени.')}
          </div>
        </div>
        <div data-avc-cols="1" style="margin-top:10px;">
          <div>
            ${subTitle('Прекъсвания на LiveKit (клиенти)', true)}
            ${countRows(c.liveKitDisconnects, LIVEKIT_DISCONNECT_LABELS, 'Няма прекъсвания.')}
          </div>
          <div>
            ${subTitle('Ротации на стаи по причина (сървър)', true)}
            ${countRows(s.rotationsByReason, ROTATION_REASON_LABELS, 'Няма ротации.')}
          </div>
        </div>
        <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">Анонимни броячи от браузърите (без аудио, токени, IP и имена на устройства).</div>
      </div>
      ${mediaCard}
      <div style="${CARD_STYLE}" data-avc-session-ends="1">
        <h3 style="${H3}">Прекратяване на гласови сесии</h3>
        <div data-avc-cols="1">
          <div>
            ${subTitle('Сървър: прекратени без ротация', true)}
            ${countRows(Object.fromEntries(Object.entries(s.sessionEndsByReason ?? {}).map(([key, count]) => [serverSessionEndLabel(key), count])), {}, 'Няма прекратени сесии.')}
            ${subTitle('Сървър: край на участието в гласа')}
            ${countRows(Object.fromEntries(Object.entries(s.bindingEndsByReason ?? {}).map(([key, count]) => [bindingEndLabel(key), count])), {}, 'Няма.')}
            ${subTitle('Отказано присъствие (presence)')}
            ${countRows(s.presenceDeniedByCode, PRESENCE_DENIAL_LABELS, 'Няма откази.')}
          </div>
          <div>
            ${subTitle('Браузъри: защо е прекратена сесията', true)}
            ${countRows(c.sessionEnds?.byReason, SESSION_END_LABELS, 'Няма отчети.')}
            ${subTitle('Неуспешно свързване — на кой етап')}
            ${countRows(c.sessionEnds?.failStages, FAIL_STAGE_LABELS, 'Няма.')}
            ${subTitle('Оставащо присъствие при издаден токен')}
            ${countRows(s.tokenLeaseMargin, LEASE_MARGIN_LABELS, 'Няма издадени токени.')}
          </div>
        </div>
        <div style="margin-top:6px;font-size:12px;line-height:1.45;${MUTED}">Без имена, токени и IP. Подробностите (маса, епоха, време от последното присъствие и токен) са в лога на игровия сървър: <code>[voice-chat] session_end</code>, <code>binding_end</code>, <code>presence_denied</code>, <code>token_denied</code>, <code>token_near_lease_expiry</code>.</div>
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
        <div data-avc-scroll="vps-network" style="overflow-x:auto;"><table><thead><tr><th>Интерфейс</th><th>Входящ</th><th>Изходящ</th></tr></thead><tbody>${networkRows}</tbody></table></div>
      </div>`
  }

  const renderBody = (): string => {
    if (base === null) return `<div style="${CARD_STYLE}font-size:13px;">${loadError === null ? 'Зареждане…' : 'Данните не са заредени.'}</div>`
    if (tab === 'control') return renderControl(base)
    if (monitoring === null) return monitoringUnavailable()
    if (tab === 'live') return renderLive(base, monitoring.live)
    if (tab === 'stats') return renderStats(monitoring)
    return renderVps(monitoring)
  }

  const renderHeader = () => {
    const parts: string[] = []
    if (shownGeneratedAt !== null) parts.push(`Обновено ${formatTime(shownGeneratedAt)}`)
    if (refreshPaused) parts.push('обновяването е на пауза')
    else if (renderDeferred) parts.push('новите данни изчакват маркирания текст')
    updatedEl.textContent = parts.join(' · ')
    pauseEl.textContent = refreshPaused ? 'Възобнови обновяването' : 'Пауза на обновяването'
    pauseEl.setAttribute('aria-pressed', String(refreshPaused))
  }

  /** Маркиран (непразен) текст в панела — подмяната на DOM-а би го изтрила. */
  const hasSelectionInPanel = (): boolean => {
    const selection = window.getSelection?.() ?? null
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return false
    return host.contains(selection.getRangeAt(0).commonAncestorContainer)
  }

  const captureView = (): ViewState => {
    const hostRect = host.getBoundingClientRect()
    let anchor: ViewState['anchor'] = null
    if (host.scrollTop > 0) {
      const children = Array.from(bodyEl.children)
      const index = children.findIndex((child) => child.getBoundingClientRect().bottom > hostRect.top)
      if (index >= 0) anchor = { index, count: children.length, top: children[index]!.getBoundingClientRect().top }
    }
    const scrolls = new Map<string, { top: number; left: number }>()
    for (const element of host.querySelectorAll<HTMLElement>('[data-avc-scroll]')) {
      scrolls.set(element.dataset.avcScroll!, { top: element.scrollTop, left: element.scrollLeft })
    }
    let recent: ViewState['recent'] = null
    const list = bodyEl.querySelector<HTMLElement>('[data-avc-media-recent="1"]')
    if (list !== null && list.scrollTop > 0) {
      const listTop = list.getBoundingClientRect().top
      for (const row of list.querySelectorAll<HTMLElement>('[data-avc-recent-index]')) {
        const rect = row.getBoundingClientRect()
        if (rect.bottom > listTop) { recent = { index: Number(row.dataset.avcRecentIndex), offset: rect.top - listTop }; break }
      }
    }
    const inputs = new Map<string, { value: string; rendered: string; focused: boolean }>()
    for (const input of bodyEl.querySelectorAll<HTMLInputElement>('input[data-avc-input]')) {
      inputs.set(input.dataset.avcInput!, { value: input.value, rendered: input.defaultValue, focused: document.activeElement === input })
    }
    const details = new Map<string, boolean>()
    for (const element of bodyEl.querySelectorAll<HTMLDetailsElement>('details[data-avc-details]')) details.set(element.dataset.avcDetails!, element.open)
    return { hostTop: host.scrollTop, anchor, scrolls, recent, inputs, details }
  }

  const restoreView = (view: ViewState, previousRecent: readonly string[], nextRecent: readonly string[]) => {
    for (const element of bodyEl.querySelectorAll<HTMLDetailsElement>('details[data-avc-details]')) {
      const open = view.details.get(element.dataset.avcDetails!)
      if (open !== undefined) element.open = open
    }
    for (const input of bodyEl.querySelectorAll<HTMLInputElement>('input[data-avc-input]')) {
      const saved = view.inputs.get(input.dataset.avcInput!)
      if (saved === undefined) continue
      // Въведената (незапазена) стойност остава, освен ако сървърната се е сменила.
      if (saved.value !== saved.rendered && input.defaultValue === saved.rendered) input.value = saved.value
      if (saved.focused) input.focus({ preventScroll: true })
    }
    for (const element of host.querySelectorAll<HTMLElement>('[data-avc-scroll]')) {
      const saved = view.scrolls.get(element.dataset.avcScroll!)
      if (saved === undefined) continue
      element.scrollLeft = saved.left
      element.scrollTop = saved.top
    }
    // „Последни събития“: новите редове идват отгоре — котвата пази същия ред на същото място.
    const list = bodyEl.querySelector<HTMLElement>('[data-avc-media-recent="1"]')
    if (list !== null && view.recent !== null) {
      const shift = recentShift(previousRecent, nextRecent)
      const row = shift === null ? null : list.querySelector<HTMLElement>(`[data-avc-recent-index="${view.recent.index + shift}"]`)
      if (row !== null) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - view.recent.offset
    }
    host.scrollTop = view.hostTop
    if (view.anchor !== null && bodyEl.children.length === view.anchor.count) {
      const child = bodyEl.children[view.anchor.index]
      if (child !== undefined) host.scrollTop += child.getBoundingClientRect().top - view.anchor.top
    }
  }

  /**
   * Подменя само променения HTML и пази изгледа (скрол, котви, въведени
   * стойности). fromRefresh: автоматично обновяване — при маркиран текст в
   * панела се отлага, докато маркирането не бъде премахнато.
   */
  const render = (fromRefresh = false) => {
    if (closed) return
    if (fromRefresh && hasSelectionInPanel()) {
      renderDeferred = true
      renderHeader()
      return
    }
    renderDeferred = false
    const sameTab = renderedTab === tab
    const view = captureView()
    const tabsHtml = renderTabs()
    if (tabsHtml !== renderedTabsHtml) { tabsEl.innerHTML = tabsHtml; renderedTabsHtml = tabsHtml }
    const bannersHtml = renderBanners()
    if (bannersHtml !== renderedBannersHtml) { bannersEl.innerHTML = bannersHtml; renderedBannersHtml = bannersHtml }
    const bodyHtml = renderBody()
    const nextRecent = tab === 'stats' && monitoring !== null ? (monitoring.clients.recent ?? []).map(recentSignature) : []
    if (bodyHtml !== renderedBodyHtml) {
      bodyEl.innerHTML = bodyHtml
      renderedBodyHtml = bodyHtml
      if (sameTab) restoreView(view, renderedRecent, nextRecent)
      else {
        // Друг таб: позицията на тялото започва отначало, но табовете остават видими.
        const tabsSaved = view.scrolls.get('tabs')
        if (tabsSaved !== undefined) tabsEl.scrollLeft = tabsSaved.left
      }
    }
    renderedTab = tab
    renderedRecent = nextRecent
    shownGeneratedAt = monitoring?.generatedAt ?? null
    renderHeader()
  }

  const onSelectionChange = () => {
    if (renderDeferred && !hasSelectionInPanel()) render(true)
  }
  document.addEventListener('selectionchange', onSelectionChange)

  async function copyText(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
        return true
      }
    } catch {
      // Отказан достъп/несигурен контекст — резервният вариант по-долу.
    }
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;'
    host.appendChild(area)
    let ok = false
    try {
      area.select()
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    area.remove()
    active?.focus({ preventScroll: true })
    return ok
  }

  const setCopyStatus = (status: { text: string; tone: 'ok' | 'error' } | null) => {
    copyStatus = status
    if (copyStatusTimer !== null) clearTimeout(copyStatusTimer)
    copyStatusTimer = status === null ? null : setTimeout(() => { copyStatusTimer = null; setCopyStatus(null) }, 5_000)
    // Само статуса до бутона — без пълно прерисуване (маркирането и скролът не се пипат).
    const statusEl = bodyEl.querySelector<HTMLElement>('[data-avc-media-copy-status="1"]')
    if (statusEl !== null) {
      statusEl.innerHTML = status === null ? '' : `<span style="font-size:12px;font-weight:800;color:${status.tone === 'ok' ? '#86efac' : '#fca5a5'};">${escapeHtml(status.text)}</span>`
    }
    // Кешираният HTML вече не отговаря на DOM-а — следващото прерисуване го подменя изцяло.
    renderedBodyHtml = ''
  }

  async function copyMediaLog(): Promise<void> {
    if (monitoring === null) return
    const count = monitoring.clients.recent?.length ?? 0
    const ok = await copyText(buildMediaHealthLogText(monitoring))
    if (closed) return
    setCopyStatus(ok
      ? { text: `Копирано: ${count} ${count === 1 ? 'събитие' : 'събития'} и броячите.`, tone: 'ok' }
      : { text: 'Копирането не успя — браузърът не разреши достъп до клипборда.', tone: 'error' })
  }

  // ─── Данни ────────────────────────────────────────────────────────────

  function scheduleRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer)
    refreshTimer = null
    if (closed || refreshMs <= 0 || refreshPaused) return
    refreshTimer = setTimeout(() => {
      refreshTimer = null
      if (refreshPaused) return
      if (document.visibilityState === 'hidden') {
        scheduleRefresh()
        return
      }
      void load(true)
    }, refreshMs)
  }

  /** fromRefresh: автоматично (по таймер) — прерисуването уважава маркирания текст. */
  async function load(fromRefresh = false): Promise<void> {
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
    render(fromRefresh)
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
    if (copyStatusTimer !== null) clearTimeout(copyStatusTimer)
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('selectionchange', onSelectionChange)
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
    if (target.closest('[data-avc-pause="1"]') !== null) {
      refreshPaused = !refreshPaused
      if (refreshPaused) {
        if (refreshTimer !== null) clearTimeout(refreshTimer)
        refreshTimer = null
        renderHeader()
      } else {
        // Възобновяване: веднага нови данни (с пазене на изгледа), после обичайният интервал.
        renderHeader()
        void load(true)
      }
      return
    }
    if (target.closest('[data-avc-media-copy="1"]') !== null) { void copyMediaLog(); return }
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

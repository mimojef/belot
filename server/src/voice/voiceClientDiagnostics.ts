// Гласов чат — Етап 6: клиентска диагностика за админ статистиката.
//
//   POST /api/voice/client-report  { event, reason?, transport? }
//
// Браузърът праща кратко събитие при: свързване, неуспешно свързване,
// reconnect, загуба на връзката, грешка на микрофона и веднъж на връзка —
// вида на избраната ICE двойка (директна/TURN) и мрежовите показатели от
// getStats(). Пазят се САМО натрупващи се броячи и ограничени агрегати в
// паметта на процеса (от старта му): без профил, IP, identity, име на стая,
// токен или аудио. Нищо не се записва в базата и нищо не се логва.
// Строга валидация (затворени изброявания, числа в граници) и лимит на
// заявките по профил — злонамерен клиент може само да изкриви броячите в
// малки граници, не и да вкара произволен текст.
//
// Етап H (медийно здраве): събития media_input / media_output /
// media_recovery (само при промяна на състоянието), груба платформа
// (затворено изброяване — без пълен User-Agent и устройства) и ограничен
// ring buffer с последните VOICE_CLIENT_RECENT_LIMIT приети събития с UTC
// време до минута. Само в паметта: без профил, IP, SQL и постоянни логове.

export const VOICE_CLIENT_REPORT_PATH = '/api/voice/client-report'
export const VOICE_CLIENT_REPORT_LIMIT_PER_MINUTE = 30
const RATE_WINDOW_MS = 60_000
const MAX_TRACKED_PROFILES = 5_000
const RECENT_TRANSPORT_LIMIT = 200
/** Етап H: последните приети събития (RAM), с UTC минута и груба платформа. */
export const VOICE_CLIENT_RECENT_LIMIT = 500

export const VOICE_CLIENT_EVENTS = ['connected', 'connect_failed', 'reconnecting', 'reconnected', 'connection_lost', 'reconnect_failed', 'mic_failed', 'transport', 'mic_attempt', 'mic_lost', 'livekit_disconnect', 'session_end', 'media_input', 'media_output', 'media_recovery', 'mic_recovery', 'media_context'] as const
export type VoiceClientEvent = (typeof VOICE_CLIENT_EVENTS)[number]

export const VOICE_CLIENT_FAILURE_REASONS = [
  // connect_failed
  'sdk_load_failed', 'presence_failed', 'token_unavailable', 'livekit_connect_failed',
  // mic_failed
  'mic_not_found', 'mic_permission_denied', 'mic_unavailable', 'mic_not_permitted',
] as const
export type VoiceClientFailureReason = (typeof VOICE_CLIENT_FAILURE_REASONS)[number]

// Микрофон (затворени изброявания; без устройства, аудио или идентичност).
export const VOICE_MIC_SOURCES = ['initial', 'panel'] as const
export const VOICE_MIC_RESULTS = ['enabled', 'recovered', 'lost', 'failed', 'cancelled'] as const
export const VOICE_MIC_INTERRUPTIONS = ['none', 'sdk_reconnect', 'connection_lost', 'rotation', 'room_deleted'] as const
export const VOICE_MIC_FAILURES = ['none', 'permission_denied', 'not_found', 'device_busy', 'gum_failed', 'publish_failed', 'publish_cancelled', 'publish_timeout', 'publish_negotiation', 'publish_not_connected', 'not_permitted', 'acquired_not_published', 'session_failed'] as const
export const VOICE_MIC_GUM_BUCKETS = ['none', 'lt1s', '1to5s', '5to15s', 'gt15s'] as const
export const VOICE_MIC_LOST_REASONS = ['track_ended', 'republish_failed', 'server_unpublished', 'device_removed', 'rotation', 'connection_lost'] as const
// Прекратяване на гласовата сесия на страницата (етап А): защо и, при
// failConnection, на кой етап. Затворени изброявания.
export const VOICE_SESSION_END_REASONS = [
  'leave_voice', 'off_table', 'page_hide', 'page_restored', 'context_changed', 'fail_connection',
  'disabled', 'access_ended', 'removed', 'duplicate_identity', 'game_connection_timeout', 'disposed',
] as const
export const VOICE_FAIL_STAGES = [
  'none', 'sdk_load', 'presence', 'token', 'connect', 'reconnect_exhausted', 'rotation_resume', 'permissions_reconnect',
] as const
// Етап H — медийно здраве (затворени изброявания; виж src/app/voice/voiceAdapter.ts).
export const VOICE_MEDIA_INPUT_STATES = ['system_muted', 'system_unmuted', 'stall_suspected', 'stall_cleared'] as const
export const VOICE_MEDIA_INPUT_EVIDENCE = ['none', 'packets_only', 'capture_stalled', 'capture_active'] as const
export const VOICE_MEDIA_DURATION_BUCKETS = ['none', 'lt10s', '10to60s', 'gt60s'] as const
export const VOICE_MEDIA_OUTPUT_STATES = ['element_paused', 'element_missing', 'playback_blocked', 'remote_stall_suspected'] as const
export const VOICE_MEDIA_RECOVERY_TARGETS = ['output'] as const
export const VOICE_MEDIA_RECOVERY_STEPS = ['play', 'reattach', 'start_audio'] as const
export const VOICE_MEDIA_RECOVERY_RESULTS = ['success', 'failed', 'gesture_required', 'limited'] as const
export const VOICE_MEDIA_TRIGGERS = ['pause', 'visible', 'focus', 'pageshow', 'devicechange', 'attach_check', 'gesture'] as const
// W1 (експериментално) — входящо аудио през Web Audio: състояние на AudioContext и
// възстановяването му (виж src/app/voice/voiceWebAudioOutput.ts). Без аудио/устройства.
export const VOICE_MEDIA_CONTEXT_STATES = ['running', 'suspended', 'interrupted', 'closed', 'unsupported'] as const
export const VOICE_MEDIA_CONTEXT_ACTIONS = ['start', 'resume', 'replace', 'gesture'] as const
export const VOICE_MEDIA_CONTEXT_RESULTS = ['success', 'failed', 'blocked', 'limited'] as const
// Етап H3 — възстановяване на микрофона (нов capture + replaceTrack).
export const VOICE_MIC_RECOVERY_MODES = ['auto', 'manual'] as const
export const VOICE_MIC_RECOVERY_OUTCOMES = [
  'recovered', 'no_rtp', 'gum_failed', 'gum_denied', 'replace_failed', 'aborted',
  'not_confirmed', 'unavailable', 'permission_required', 'cooldown', 'limit', 'capture_active', 'disabled',
] as const
/** Груба платформа (същият списък като src/app/voice/voiceMediaHealth.ts VOICE_PLATFORMS). */
export const VOICE_CLIENT_PLATFORMS = [
  'ios_safari', 'ios_pwa', 'ios_other',
  'android_chrome', 'android_samsung', 'android_pwa', 'android_other',
  'desktop_chrome', 'desktop_edge', 'desktop_safari', 'desktop_firefox', 'desktop_other',
  'unknown',
] as const
export type VoiceClientPlatform = (typeof VOICE_CLIENT_PLATFORMS)[number]
export const VOICE_LIVEKIT_DISCONNECT_REASONS = ['network', 'server_shutdown', 'room_deleted', 'participant_removed', 'duplicate_identity', 'join_failure', 'signal_close', 'state_mismatch', 'migration', 'client', 'other'] as const

type OneOf<T extends readonly string[]> = T[number]

export type VoiceClientMicAttempt = {
  source: OneOf<typeof VOICE_MIC_SOURCES>
  result: OneOf<typeof VOICE_MIC_RESULTS>
  interruption: OneOf<typeof VOICE_MIC_INTERRUPTIONS>
  gum: OneOf<typeof VOICE_MIC_GUM_BUCKETS>
  failure: OneOf<typeof VOICE_MIC_FAILURES>
}

function pickOne<T extends readonly string[]>(value: unknown, allowed: T): OneOf<T> | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as OneOf<T>) : null
}

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay', 'unknown'] as const
const PROTOCOLS = ['udp', 'tcp', 'tls', 'unknown'] as const

export type VoiceClientTransport = {
  candidateType: (typeof CANDIDATE_TYPES)[number]
  /** Протокол на кандидата; за relay — протоколът до TURN сървъра (udp/tcp/tls). */
  protocol: (typeof PROTOCOLS)[number]
  rttMs: number | null
  jitterMs: number | null
  packetLossPercent: number | null
}

type DetailedEvent = 'connect_failed' | 'mic_failed' | 'transport' | 'mic_attempt' | 'mic_lost' | 'livekit_disconnect' | 'session_end' | 'media_input' | 'media_output' | 'media_recovery' | 'mic_recovery' | 'media_context'

export type VoiceClientReport =
  | { event: Exclude<VoiceClientEvent, DetailedEvent> }
  | { event: 'connect_failed' | 'mic_failed'; reason: VoiceClientFailureReason }
  | { event: 'transport'; transport: VoiceClientTransport }
  | ({ event: 'mic_attempt' } & VoiceClientMicAttempt)
  | { event: 'mic_lost'; reason: OneOf<typeof VOICE_MIC_LOST_REASONS> }
  | { event: 'livekit_disconnect'; reason: OneOf<typeof VOICE_LIVEKIT_DISCONNECT_REASONS> }
  | { event: 'session_end'; reason: OneOf<typeof VOICE_SESSION_END_REASONS>; stage: OneOf<typeof VOICE_FAIL_STAGES> }
  | { event: 'media_input'; state: OneOf<typeof VOICE_MEDIA_INPUT_STATES>; evidence: OneOf<typeof VOICE_MEDIA_INPUT_EVIDENCE>; duration: OneOf<typeof VOICE_MEDIA_DURATION_BUCKETS> }
  | { event: 'media_output'; state: OneOf<typeof VOICE_MEDIA_OUTPUT_STATES> }
  | {
      event: 'media_recovery'
      target: OneOf<typeof VOICE_MEDIA_RECOVERY_TARGETS>
      step: OneOf<typeof VOICE_MEDIA_RECOVERY_STEPS>
      result: OneOf<typeof VOICE_MEDIA_RECOVERY_RESULTS>
      trigger: OneOf<typeof VOICE_MEDIA_TRIGGERS>
    }
  | { event: 'mic_recovery'; mode: OneOf<typeof VOICE_MIC_RECOVERY_MODES>; outcome: OneOf<typeof VOICE_MIC_RECOVERY_OUTCOMES> }
  | { event: 'media_context'; state: OneOf<typeof VOICE_MEDIA_CONTEXT_STATES>; action: OneOf<typeof VOICE_MEDIA_CONTEXT_ACTIONS>; result: OneOf<typeof VOICE_MEDIA_CONTEXT_RESULTS> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedNumber(value: unknown, max: number): number | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return undefined
  return Math.round(value * 100) / 100
}

/** null -> невалидно тяло (400). Непознати полета се игнорират. */
export function parseVoiceClientReport(body: unknown): VoiceClientReport | null {
  if (!isRecord(body) || typeof body.event !== 'string') return null
  const event = body.event as VoiceClientEvent
  if (!(VOICE_CLIENT_EVENTS as readonly string[]).includes(event)) return null
  if (event === 'connect_failed' || event === 'mic_failed') {
    const reason = body.reason
    if (typeof reason !== 'string' || !(VOICE_CLIENT_FAILURE_REASONS as readonly string[]).includes(reason)) return null
    const isMic = reason.startsWith('mic_')
    if (isMic !== (event === 'mic_failed')) return null
    return { event, reason: reason as VoiceClientFailureReason }
  }
  if (event === 'mic_attempt') {
    const source = pickOne(body.source, VOICE_MIC_SOURCES)
    const result = pickOne(body.result, VOICE_MIC_RESULTS)
    const interruption = pickOne(body.interruption, VOICE_MIC_INTERRUPTIONS)
    const gum = pickOne(body.gum, VOICE_MIC_GUM_BUCKETS)
    const failure = pickOne(body.failure, VOICE_MIC_FAILURES)
    if (source === null || result === null || interruption === null || gum === null || failure === null) return null
    return { event, source, result, interruption, gum, failure }
  }
  if (event === 'mic_lost') {
    const reason = pickOne(body.reason, VOICE_MIC_LOST_REASONS)
    return reason === null ? null : { event, reason }
  }
  if (event === 'session_end') {
    const reason = pickOne(body.reason, VOICE_SESSION_END_REASONS)
    const stage = pickOne(body.stage, VOICE_FAIL_STAGES)
    if (reason === null || stage === null) return null
    return { event, reason, stage }
  }
  if (event === 'livekit_disconnect') {
    const reason = pickOne(body.reason, VOICE_LIVEKIT_DISCONNECT_REASONS)
    return reason === null ? null : { event, reason }
  }
  if (event === 'media_input') {
    const state = pickOne(body.state, VOICE_MEDIA_INPUT_STATES)
    const evidence = pickOne(body.evidence, VOICE_MEDIA_INPUT_EVIDENCE)
    const duration = pickOne(body.duration, VOICE_MEDIA_DURATION_BUCKETS)
    if (state === null || evidence === null || duration === null) return null
    return { event, state, evidence, duration }
  }
  if (event === 'media_output') {
    const state = pickOne(body.state, VOICE_MEDIA_OUTPUT_STATES)
    return state === null ? null : { event, state }
  }
  if (event === 'mic_recovery') {
    const mode = pickOne(body.mode, VOICE_MIC_RECOVERY_MODES)
    const outcome = pickOne(body.outcome, VOICE_MIC_RECOVERY_OUTCOMES)
    if (mode === null || outcome === null) return null
    return { event, mode, outcome }
  }
  if (event === 'media_context') {
    const state = pickOne(body.state, VOICE_MEDIA_CONTEXT_STATES)
    const action = pickOne(body.action, VOICE_MEDIA_CONTEXT_ACTIONS)
    const result = pickOne(body.result, VOICE_MEDIA_CONTEXT_RESULTS)
    if (state === null || action === null || result === null) return null
    return { event, state, action, result }
  }
  if (event === 'media_recovery') {
    const target = pickOne(body.target, VOICE_MEDIA_RECOVERY_TARGETS)
    const step = pickOne(body.step, VOICE_MEDIA_RECOVERY_STEPS)
    const result = pickOne(body.result, VOICE_MEDIA_RECOVERY_RESULTS)
    const trigger = pickOne(body.trigger, VOICE_MEDIA_TRIGGERS)
    if (target === null || step === null || result === null || trigger === null) return null
    return { event, target, step, result, trigger }
  }
  if (event === 'transport') {
    const transport = body.transport
    if (!isRecord(transport)) return null
    const candidateType = transport.candidateType
    const protocol = transport.protocol
    if (typeof candidateType !== 'string' || !(CANDIDATE_TYPES as readonly string[]).includes(candidateType)) return null
    if (typeof protocol !== 'string' || !(PROTOCOLS as readonly string[]).includes(protocol)) return null
    const rttMs = boundedNumber(transport.rttMs, 60_000)
    const jitterMs = boundedNumber(transport.jitterMs, 60_000)
    const packetLossPercent = boundedNumber(transport.packetLossPercent, 100)
    if (rttMs === undefined || jitterMs === undefined || packetLossPercent === undefined) return null
    return {
      event,
      transport: {
        candidateType: candidateType as VoiceClientTransport['candidateType'],
        protocol: protocol as VoiceClientTransport['protocol'],
        rttMs,
        jitterMs,
        packetLossPercent,
      },
    }
  }
  return { event: event as Exclude<VoiceClientEvent, DetailedEvent> }
}

/** Липсваща/непозната платформа -> 'unknown' (старите клиенти не я пращат; не е грешка). */
export function parseVoiceClientPlatform(body: unknown): VoiceClientPlatform {
  if (!isRecord(body)) return 'unknown'
  return pickOne(body.platform, VOICE_CLIENT_PLATFORMS) ?? 'unknown'
}

/** Кратко описание от затворените стойности (без свободен текст). */
function describeReport(report: VoiceClientReport): string {
  switch (report.event) {
    case 'connect_failed':
    case 'mic_failed':
    case 'mic_lost':
    case 'livekit_disconnect':
      return report.reason
    case 'mic_attempt':
      return `${report.source}/${report.result}/${report.interruption}/${report.failure}`
    case 'session_end':
      return `${report.reason}/${report.stage}`
    case 'transport':
      return `${report.transport.candidateType}/${report.transport.protocol}`
    case 'media_input':
      return `${report.state}/${report.evidence}/${report.duration}`
    case 'media_output':
      return report.state
    case 'media_recovery':
      return `${report.target}/${report.step}/${report.result}/${report.trigger}`
    case 'mic_recovery':
      return `${report.mode}/${report.outcome}`
    case 'media_context':
      return `${report.state}/${report.action}/${report.result}`
    default:
      return ''
  }
}

export type VoiceClientRecentEvent = {
  /** UTC, точност до минута (YYYY-MM-DDTHH:MMZ). */
  at: string
  event: VoiceClientEvent
  detail: string
  platform: VoiceClientPlatform
}

type MeanAccumulator = { sum: number; count: number }

export type VoiceClientDiagnosticsSnapshot = {
  /** Начало на броенето (старт на процеса) — броячите не се пазят между рестарти. */
  since: string
  events: Record<VoiceClientEvent, number>
  failures: Record<string, number>
  transport: {
    reports: number
    /** Брой връзки по вид кандидат (relay = през TURN). */
    byCandidateType: Record<string, number>
    /** Само за relay: протокол до TURN (udp/tcp/tls). */
    relayByProtocol: Record<string, number>
    /** null = няма отчети (не 0). */
    relayPercent: number | null
    rttMs: { mean: number | null; reports: number }
    jitterMs: { mean: number | null; reports: number }
    packetLossPercent: { mean: number | null; reports: number }
  }
  /** Микрофон: първоначално / от панела; резултати, прекъсвания, грешки, време за разрешение. */
  mic: {
    /** source -> result -> брой. */
    attempts: Record<string, Record<string, number>>
    /** Прекъсване ДОКАТО включването чака: възстановено / окончателно изгубено / друго. */
    interruptions: Record<string, { recovered: number; lost: number; other: number }>
    failures: Record<string, number>
    /** Продължителност на getUserMedia (диапазони). */
    gum: Record<string, number>
    /** Вече включен микрофон, загубен по-късно. */
    lost: Record<string, number>
  }
  /** Причини за прекъсване на LiveKit връзката (клиентски отчети). */
  liveKitDisconnects: Record<string, number>
  /** Прекратени гласови сесии по причина; при failConnection — по етап. */
  sessionEnds: { byReason: Record<string, number>; failStages: Record<string, number> }
  /** Етап H: медийно здраве (броячи от последния рестарт). */
  media: {
    input: Record<string, number>
    inputEvidence: Record<string, number>
    output: Record<string, number>
    /** step:result -> брой. */
    recovery: Record<string, number>
    /** Етап H3: mode:outcome -> брой. */
    micRecovery: Record<string, number>
    /** W1 (експериментално): state:action:result -> брой (само при входящо аудио през Web Audio). */
    context: Record<string, number>
    /** Медийни събития по груба платформа. */
    byPlatform: Record<string, number>
  }
  /** Етап H: последните приети събития (най-новите първи), до VOICE_CLIENT_RECENT_LIMIT. */
  recent: VoiceClientRecentEvent[]
  recentLimit: number
  rejectedReports: number
}

export type VoiceClientDiagnostics = {
  /** 'limited' -> 429; 'invalid' -> 400. */
  record: (profileId: string, body: unknown) => 'ok' | 'invalid' | 'limited'
  snapshot: () => VoiceClientDiagnosticsSnapshot
}

export function createVoiceClientDiagnostics(deps: { now?: () => number; limitPerMinute?: number } = {}): VoiceClientDiagnostics {
  const now = deps.now ?? (() => Date.now())
  const limitPerMinute = deps.limitPerMinute ?? VOICE_CLIENT_REPORT_LIMIT_PER_MINUTE
  const since = new Date(now()).toISOString()
  const events = Object.fromEntries(VOICE_CLIENT_EVENTS.map((event) => [event, 0])) as Record<VoiceClientEvent, number>
  const failures: Record<string, number> = {}
  const byCandidateType: Record<string, number> = {}
  const relayByProtocol: Record<string, number> = {}
  let transportReports = 0
  let rejectedReports = 0
  const micAttempts: Record<string, Record<string, number>> = Object.fromEntries(
    VOICE_MIC_SOURCES.map((source) => [source, Object.fromEntries(VOICE_MIC_RESULTS.map((result) => [result, 0]))]),
  )
  const micInterruptions: Record<string, { recovered: number; lost: number; other: number }> = {}
  const micFailures: Record<string, number> = {}
  const micGum: Record<string, number> = {}
  const micLost: Record<string, number> = {}
  const liveKitDisconnects: Record<string, number> = {}
  const sessionEndReasons: Record<string, number> = {}
  const sessionFailStages: Record<string, number> = {}
  const mediaInput: Record<string, number> = {}
  const mediaInputEvidence: Record<string, number> = {}
  const mediaOutput: Record<string, number> = {}
  const mediaRecovery: Record<string, number> = {}
  const micRecovery: Record<string, number> = {}
  const mediaContext: Record<string, number> = {}
  const mediaByPlatform: Record<string, number> = {}
  const recentEvents: VoiceClientRecentEvent[] = []
  const bump = (target: Record<string, number>, key: string): void => {
    target[key] = (target[key] ?? 0) + 1
  }
  // Скорошните мрежови показатели (последните N отчета) — средни стойности.
  const recent: Array<{ rttMs: number | null; jitterMs: number | null; packetLossPercent: number | null }> = []
  const windows = new Map<string, { start: number; count: number }>()

  function allow(profileId: string): boolean {
    const at = now()
    const window = windows.get(profileId)
    if (window === undefined || at - window.start >= RATE_WINDOW_MS) {
      if (window === undefined && windows.size >= MAX_TRACKED_PROFILES) {
        // Ограничена памет: изчистване на изтеклите прозорци; при пълно — отказ.
        for (const [key, value] of windows) if (at - value.start >= RATE_WINDOW_MS) windows.delete(key)
        if (windows.size >= MAX_TRACKED_PROFILES) return false
      }
      windows.set(profileId, { start: at, count: 1 })
      return true
    }
    if (window.count >= limitPerMinute) return false
    window.count += 1
    return true
  }

  const mean = (pick: (entry: (typeof recent)[number]) => number | null): { mean: number | null; reports: number } => {
    const accumulator: MeanAccumulator = { sum: 0, count: 0 }
    for (const entry of recent) {
      const value = pick(entry)
      if (value === null) continue
      accumulator.sum += value
      accumulator.count += 1
    }
    return { mean: accumulator.count === 0 ? null : Math.round((accumulator.sum / accumulator.count) * 100) / 100, reports: accumulator.count }
  }

  return {
    record(profileId, body) {
      const report = parseVoiceClientReport(body)
      if (report === null) {
        rejectedReports += 1
        return 'invalid'
      }
      if (!allow(profileId)) {
        rejectedReports += 1
        return 'limited'
      }
      events[report.event] += 1
      const platform = parseVoiceClientPlatform(body)
      recentEvents.push({ at: `${new Date(now()).toISOString().slice(0, 16)}Z`, event: report.event, detail: describeReport(report), platform })
      if (recentEvents.length > VOICE_CLIENT_RECENT_LIMIT) recentEvents.splice(0, recentEvents.length - VOICE_CLIENT_RECENT_LIMIT)
      if (report.event === 'media_input' || report.event === 'media_output' || report.event === 'media_recovery' || report.event === 'mic_recovery' || report.event === 'media_context') bump(mediaByPlatform, platform)
      if (report.event === 'mic_recovery') bump(micRecovery, `${report.mode}:${report.outcome}`)
      if (report.event === 'media_context') bump(mediaContext, `${report.state}:${report.action}:${report.result}`)
      if (report.event === 'media_input') {
        bump(mediaInput, report.state)
        if (report.evidence !== 'none') bump(mediaInputEvidence, report.evidence)
      } else if (report.event === 'media_output') {
        bump(mediaOutput, report.state)
      } else if (report.event === 'media_recovery') {
        bump(mediaRecovery, `${report.step}:${report.result}`)
      } else if (report.event === 'connect_failed' || report.event === 'mic_failed') {
        failures[report.reason] = (failures[report.reason] ?? 0) + 1
      } else if (report.event === 'mic_attempt') {
        bump(micAttempts[report.source]!, report.result)
        if (report.interruption !== 'none') {
          const bucket = micInterruptions[report.interruption] ?? { recovered: 0, lost: 0, other: 0 }
          if (report.result === 'recovered') bucket.recovered += 1
          else if (report.result === 'lost') bucket.lost += 1
          else bucket.other += 1
          micInterruptions[report.interruption] = bucket
        }
        if (report.failure !== 'none') bump(micFailures, report.failure)
        if (report.gum !== 'none') bump(micGum, report.gum)
      } else if (report.event === 'mic_lost') {
        bump(micLost, report.reason)
      } else if (report.event === 'session_end') {
        bump(sessionEndReasons, report.reason)
        if (report.stage !== 'none') bump(sessionFailStages, report.stage)
      } else if (report.event === 'livekit_disconnect') {
        bump(liveKitDisconnects, report.reason)
      } else if (report.event === 'transport') {
        transportReports += 1
        const { candidateType, protocol, rttMs, jitterMs, packetLossPercent } = report.transport
        byCandidateType[candidateType] = (byCandidateType[candidateType] ?? 0) + 1
        if (candidateType === 'relay') relayByProtocol[protocol] = (relayByProtocol[protocol] ?? 0) + 1
        recent.push({ rttMs, jitterMs, packetLossPercent })
        if (recent.length > RECENT_TRANSPORT_LIMIT) recent.shift()
      }
      return 'ok'
    },
    snapshot() {
      const known = transportReports - (byCandidateType.unknown ?? 0)
      return {
        since,
        events: { ...events },
        failures: { ...failures },
        transport: {
          reports: transportReports,
          byCandidateType: { ...byCandidateType },
          relayByProtocol: { ...relayByProtocol },
          relayPercent: known > 0 ? Math.round(((byCandidateType.relay ?? 0) / known) * 1000) / 10 : null,
          rttMs: mean((entry) => entry.rttMs),
          jitterMs: mean((entry) => entry.jitterMs),
          packetLossPercent: mean((entry) => entry.packetLossPercent),
        },
        mic: {
          attempts: Object.fromEntries(Object.entries(micAttempts).map(([source, results]) => [source, { ...results }])),
          interruptions: Object.fromEntries(Object.entries(micInterruptions).map(([kind, value]) => [kind, { ...value }])),
          failures: { ...micFailures },
          gum: { ...micGum },
          lost: { ...micLost },
        },
        liveKitDisconnects: { ...liveKitDisconnects },
        sessionEnds: { byReason: { ...sessionEndReasons }, failStages: { ...sessionFailStages } },
        media: {
          input: { ...mediaInput },
          inputEvidence: { ...mediaInputEvidence },
          output: { ...mediaOutput },
          recovery: { ...mediaRecovery },
          micRecovery: { ...micRecovery },
          context: { ...mediaContext },
          byPlatform: { ...mediaByPlatform },
        },
        recent: recentEvents.slice().reverse().map((entry) => ({ ...entry })),
        recentLimit: VOICE_CLIENT_RECENT_LIMIT,
        rejectedReports,
      }
    },
  }
}

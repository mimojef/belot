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

export const VOICE_CLIENT_REPORT_PATH = '/api/voice/client-report'
export const VOICE_CLIENT_REPORT_LIMIT_PER_MINUTE = 30
const RATE_WINDOW_MS = 60_000
const MAX_TRACKED_PROFILES = 5_000
const RECENT_TRANSPORT_LIMIT = 200

export const VOICE_CLIENT_EVENTS = ['connected', 'connect_failed', 'reconnecting', 'reconnected', 'connection_lost', 'reconnect_failed', 'mic_failed', 'transport'] as const
export type VoiceClientEvent = (typeof VOICE_CLIENT_EVENTS)[number]

export const VOICE_CLIENT_FAILURE_REASONS = [
  // connect_failed
  'sdk_load_failed', 'presence_failed', 'token_unavailable', 'livekit_connect_failed',
  // mic_failed
  'mic_not_found', 'mic_permission_denied', 'mic_unavailable', 'mic_not_permitted',
] as const
export type VoiceClientFailureReason = (typeof VOICE_CLIENT_FAILURE_REASONS)[number]

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

export type VoiceClientReport =
  | { event: Exclude<VoiceClientEvent, 'connect_failed' | 'mic_failed' | 'transport'> }
  | { event: 'connect_failed' | 'mic_failed'; reason: VoiceClientFailureReason }
  | { event: 'transport'; transport: VoiceClientTransport }

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
  return { event: event as Exclude<VoiceClientEvent, 'connect_failed' | 'mic_failed' | 'transport'> }
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
      if (report.event === 'connect_failed' || report.event === 'mic_failed') {
        failures[report.reason] = (failures[report.reason] ?? 0) + 1
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
        rejectedReports,
      }
    },
  }
}

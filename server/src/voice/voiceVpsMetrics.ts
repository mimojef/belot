// Гласов чат — Етап 6: технически показатели на гласовия VPS за админ панела.
//
// Източник: защитени HTTPS маршрути през съществуващия Caddy на гласовия VPS
// (виж ops/voice-metrics-caddy/README.md). Метриките остават на loopback
// портовете (127.0.0.1:6789 LiveKit, 127.0.0.1:9100 Node Exporter); Caddy ги
// проксира само към IP-то на игровия VPS и само с отделна автентикация
// (HTTP Basic, bcrypt хеш на гласовия VPS). Без Prometheus/Grafana/SSH тунел.
//
// Правила:
//   * извличането е асинхронно, с timeout, само при отворен админ панел —
//     никога от игровия hot path; резултатът се кешира (по подразбиране 20 s)
//     и едновременните заявки споделят едно извличане (single-flight);
//   * липсваща конфигурация / недостъпен сървър / липсваща метрика -> null
//     („Недостъпно“), никога 0 или измислена стойност;
//   * скоростите (CPU %, steal, трафик) са разлика между две поредни четения;
//     до второто четене са null („изчислява се“);
//   * паролата живее само в server-side env, не се логва и не се връща.

export const VOICE_VPS_METRICS_ENV_NAMES = ['VOICE_VPS_METRICS_URL', 'VOICE_VPS_METRICS_USERNAME', 'VOICE_VPS_METRICS_PASSWORD'] as const
export const VOICE_VPS_METRICS_PATHS = { livekit: '/pika-ops/livekit-metrics', node: '/pika-ops/node-metrics' } as const
export const VOICE_VPS_METRICS_CACHE_TTL_MS = 20_000
export const VOICE_VPS_METRICS_TIMEOUT_MS = 4_000
/** Защита от неочаквано голям отговор (Node Exporter с филтър е ~20–60 KB). */
export const VOICE_VPS_METRICS_MAX_BYTES = 2 * 1024 * 1024
/** Четене, по-старо от това, не се използва за скорости. */
const MAX_RATE_WINDOW_MS = 180_000

type EnvSource = Readonly<Record<string, string | undefined>>

export type VoiceVpsMetricsConfig = { baseUrl: string; username: string; password: string }

/** null -> не е конфигурирано („Недостъпно“). https задължително (http само за loopback тестове). */
export function readVoiceVpsMetricsConfig(env: EnvSource = process.env): VoiceVpsMetricsConfig | null {
  const baseUrl = env.VOICE_VPS_METRICS_URL?.trim() ?? ''
  const username = env.VOICE_VPS_METRICS_USERNAME?.trim() ?? ''
  const password = env.VOICE_VPS_METRICS_PASSWORD ?? ''
  if (baseUrl === '' || username === '' || password === '' || username.includes(':')) return null
  try {
    const url = new URL(baseUrl)
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null
  } catch {
    return null
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), username, password }
}

export function getVoiceVpsMetricsConfigStatus(env: EnvSource = process.env): { configured: boolean; missing: string[] } {
  const missing = VOICE_VPS_METRICS_ENV_NAMES.filter((name) => (env[name]?.trim() ?? '') === '')
  return { configured: readVoiceVpsMetricsConfig(env) !== null, missing: [...missing] }
}

// ─── Prometheus text format ───────────────────────────────────────────────

export type PromSample = { labels: Readonly<Record<string, string>>; value: number }
export type PromFamilyType = 'counter' | 'gauge' | 'histogram' | 'summary' | 'untyped'
export type PromMetrics = {
  samples: ReadonlyMap<string, readonly PromSample[]>
  types: ReadonlyMap<string, PromFamilyType>
}

function parseLabels(text: string): Record<string, string> | null {
  const labels: Record<string, string> = {}
  let index = 0
  while (index < text.length) {
    while (text[index] === ' ' || text[index] === ',') index += 1
    if (index >= text.length) break
    const eq = text.indexOf('=', index)
    if (eq < 0) return null
    const name = text.slice(index, eq).trim()
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || text[eq + 1] !== '"') return null
    let value = ''
    let cursor = eq + 2
    for (;;) {
      if (cursor >= text.length) return null
      const char = text[cursor]!
      if (char === '\\') {
        const next = text[cursor + 1]
        value += next === 'n' ? '\n' : (next ?? '')
        cursor += 2
        continue
      }
      if (char === '"') break
      value += char
      cursor += 1
    }
    labels[name] = value
    index = cursor + 1
  }
  return labels
}

function parseValue(text: string): number | null {
  if (text === '+Inf') return Number.POSITIVE_INFINITY
  if (text === '-Inf') return Number.NEGATIVE_INFINITY
  if (text === 'NaN') return Number.NaN
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

/** Толерантен парсер: невалидните редове се пропускат, не се хвърля. */
export function parsePrometheusText(text: string): PromMetrics {
  const samples = new Map<string, PromSample[]>()
  const types = new Map<string, PromFamilyType>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      const match = /^#\s+TYPE\s+([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(counter|gauge|histogram|summary|untyped)\s*$/.exec(line)
      if (match !== null) types.set(match[1]!, match[2] as PromFamilyType)
      continue
    }
    let name: string
    let labels: Record<string, string> = {}
    let rest: string
    const brace = line.indexOf('{')
    const space = line.indexOf(' ')
    if (brace >= 0 && (space < 0 || brace < space)) {
      name = line.slice(0, brace)
      const close = line.lastIndexOf('}')
      if (close < brace) continue
      const parsed = parseLabels(line.slice(brace + 1, close))
      if (parsed === null) continue
      labels = parsed
      rest = line.slice(close + 1).trim()
    } else {
      if (space < 0) continue
      name = line.slice(0, space)
      rest = line.slice(space + 1).trim()
    }
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) continue
    const value = parseValue(rest.split(/\s+/)[0] ?? '')
    if (value === null) continue
    const list = samples.get(name)
    if (list === undefined) samples.set(name, [{ labels, value }])
    else list.push({ labels, value })
  }
  return { samples, types }
}

type LabelFilter = (labels: Readonly<Record<string, string>>) => boolean

function sumOf(metrics: PromMetrics | null, name: string, filter: LabelFilter = () => true): number | null {
  const list = metrics?.samples.get(name)
  if (list === undefined) return null
  let total = 0
  let found = false
  for (const sample of list) {
    if (!filter(sample.labels) || !Number.isFinite(sample.value)) continue
    total += sample.value
    found = true
  }
  return found ? total : null
}

function firstValue(metrics: PromMetrics | null, name: string): number | null {
  const sample = metrics?.samples.get(name)?.[0]
  return sample !== undefined && Number.isFinite(sample.value) ? sample.value : null
}

// ─── Снимка за админ панела ───────────────────────────────────────────────

export type VoiceVpsSourceStatus = {
  status: 'ok' | 'not_configured' | 'unavailable'
  /** http_401, http_403, timeout, network, too_large… — без тайни. */
  reason: string | null
  /** Последно успешно четене (ISO) — дори при текуща грешка. */
  lastSuccessAt: string | null
}

export type VoiceVpsQualityMetric = {
  /** Средна стойност за интервала между двете последни четения (null = няма нови наблюдения/данни). */
  intervalMean: number | null
  /** Средна стойност от старта на LiveKit процеса. */
  lifetimeMean: number | null
  /** Брой наблюдения в интервала. */
  intervalCount: number | null
  /** Текуща стойност — само ако метриката е gauge. */
  current: number | null
}

export type VoiceVpsSnapshot = {
  configured: boolean
  sampledAt: string | null
  /** Секунди между двете четения, от които са изчислени скоростите. */
  rateWindowSeconds: number | null
  liveKit: VoiceVpsSourceStatus & {
    /** Само ако реално присъства в метриките (етикет version на livekit_* метрика). */
    version: string | null
    processStartedAt: string | null
    uptimeSeconds: number | null
    rooms: number | null
    participants: number | null
    tracksPublished: number | null
    tracksSubscribed: number | null
    participantJoins: { total: number | null; byLabel: Array<{ label: string; value: number }> }
    quality: {
      rttMs: VoiceVpsQualityMetric
      jitterUs: VoiceVpsQualityMetric
      packetLossPercent: VoiceVpsQualityMetric
      qualityScore: VoiceVpsQualityMetric
      qualityRating: VoiceVpsQualityMetric
      joinLatencyMs: VoiceVpsQualityMetric
    }
  }
  host: VoiceVpsSourceStatus & {
    bootedAt: string | null
    uptimeSeconds: number | null
    cpuCount: number | null
    /** Обща заетост на CPU в % (100 = всички ядра) за интервала. */
    cpuBusyPercent: number | null
    cpuStealPercent: number | null
    perCpu: Array<{ cpu: string; busyPercent: number | null; stealPercent: number | null }>
    /** Node Exporter pressure collector (PSI) — % от времето със задачи, чакащи CPU. */
    cpuPressureWaitingPercent: number | null
    load: { one: number | null; five: number | null; fifteen: number | null }
    memory: { totalBytes: number | null; availableBytes: number | null; usedPercent: number | null; swapUsedBytes: number | null }
    network: Array<{ device: string; receiveBytesPerSecond: number | null; transmitBytesPerSecond: number | null; receiveBytesTotal: number; transmitBytesTotal: number }>
  }
}

export type VoiceVpsMetricsCollector = {
  getSnapshot: () => Promise<VoiceVpsSnapshot>
}

type FetchLike = (input: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error'; cache: 'no-store' }) => Promise<{
  status: number
  headers: { get: (name: string) => string | null }
  body: ReadableStream<Uint8Array> | null
  text: () => Promise<string>
}>

type SourceSample = { at: number; metrics: PromMetrics }

class FetchFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

async function readLimited(response: Awaited<ReturnType<FetchLike>>, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new FetchFailure('too_large')
  if (response.body === null) return response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new FetchFailure('too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')
}

function describeFetchError(error: unknown): string {
  if (error instanceof FetchFailure) return error.reason
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout'
  return 'network'
}

const DEVICE_EXCLUDE = /^(lo|docker\d*|veth.*|br-.*|virbr.*|cni.*|flannel.*|tun.*|wg.*)$/

function qualityMetric(current: PromMetrics | null, previous: PromMetrics | null, name: string, filter: LabelFilter = () => true): VoiceVpsQualityMetric {
  const type = current?.types.get(name)
  if (current === null || type === undefined && !current.samples.has(name) && !current.samples.has(`${name}_sum`)) {
    return { intervalMean: null, lifetimeMean: null, intervalCount: null, current: null }
  }
  if (type === 'gauge' || type === 'untyped' || (type === undefined && current.samples.has(name))) {
    const list = current.samples.get(name)?.filter((sample) => filter(sample.labels) && Number.isFinite(sample.value)) ?? []
    const value = list.length === 0 ? null : list.reduce((acc, sample) => acc + sample.value, 0) / list.length
    return { intervalMean: null, lifetimeMean: null, intervalCount: null, current: value }
  }
  const sum = sumOf(current, `${name}_sum`, filter)
  const count = sumOf(current, `${name}_count`, filter)
  const lifetimeMean = sum !== null && count !== null && count > 0 ? sum / count : null
  let intervalMean: number | null = null
  let intervalCount: number | null = null
  if (previous !== null && sum !== null && count !== null) {
    const previousSum = sumOf(previous, `${name}_sum`, filter)
    const previousCount = sumOf(previous, `${name}_count`, filter)
    if (previousSum !== null && previousCount !== null && count >= previousCount) {
      intervalCount = count - previousCount
      intervalMean = intervalCount > 0 ? (sum - previousSum) / intervalCount : null
    }
  }
  return { intervalMean, lifetimeMean, intervalCount, current: null }
}

function findLiveKitVersion(metrics: PromMetrics | null): string | null {
  if (metrics === null) return null
  for (const [name, list] of metrics.samples) {
    if (!name.startsWith('livekit_')) continue
    for (const sample of list) {
      const version = sample.labels.version
      if (version !== undefined && /^v?\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) return version.replace(/^v/, '')
    }
  }
  return null
}

function toIso(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

function percent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null
  return Math.max(0, Math.min(100, (part / whole) * 100))
}

/** CPU по ядра от node_cpu_seconds_total (разлика между две четения). */
function cpuUsage(current: PromMetrics, previous: PromMetrics | null): {
  cpuCount: number | null
  busy: number | null
  steal: number | null
  perCpu: VoiceVpsSnapshot['host']['perCpu']
} {
  const list = current.samples.get('node_cpu_seconds_total')
  if (list === undefined) return { cpuCount: null, busy: null, steal: null, perCpu: [] }
  const byCpu = (metrics: PromMetrics | null): Map<string, Map<string, number>> => {
    const result = new Map<string, Map<string, number>>()
    for (const sample of metrics?.samples.get('node_cpu_seconds_total') ?? []) {
      const cpu = sample.labels.cpu
      const mode = sample.labels.mode
      if (cpu === undefined || mode === undefined) continue
      let modes = result.get(cpu)
      if (modes === undefined) result.set(cpu, (modes = new Map()))
      modes.set(mode, sample.value)
    }
    return result
  }
  const now = byCpu(current)
  const before = byCpu(previous)
  const cpus = [...now.keys()].sort((a, b) => Number(a) - Number(b))
  let totalDelta = 0
  let busyDelta = 0
  let stealDelta = 0
  let complete = previous !== null
  const perCpu = cpus.map((cpu) => {
    const modes = now.get(cpu)!
    const old = before.get(cpu)
    if (old === undefined) {
      complete = false
      return { cpu, busyPercent: null, stealPercent: null }
    }
    let total = 0
    let idle = 0
    let steal = 0
    for (const [mode, value] of modes) {
      const delta = value - (old.get(mode) ?? value)
      if (delta < 0) {
        complete = false
        return { cpu, busyPercent: null, stealPercent: null }
      }
      total += delta
      if (mode === 'idle' || mode === 'iowait') idle += delta
      if (mode === 'steal') steal += delta
    }
    totalDelta += total
    busyDelta += total - idle
    stealDelta += steal
    return { cpu, busyPercent: percent(total - idle, total), stealPercent: modes.has('steal') ? percent(steal, total) : null }
  })
  const hasSteal = cpus.some((cpu) => now.get(cpu)!.has('steal'))
  return {
    cpuCount: cpus.length === 0 ? null : cpus.length,
    busy: complete ? percent(busyDelta, totalDelta) : null,
    steal: complete && hasSteal ? percent(stealDelta, totalDelta) : null,
    perCpu,
  }
}

function rate(current: number | null, previous: number | null, seconds: number | null): number | null {
  if (current === null || previous === null || seconds === null || seconds <= 0 || current < previous) return null
  return (current - previous) / seconds
}

export function buildVoiceVpsSnapshot(input: {
  configured: boolean
  liveKit: { status: VoiceVpsSourceStatus; current: SourceSample | null; previous: SourceSample | null }
  node: { status: VoiceVpsSourceStatus; current: SourceSample | null; previous: SourceSample | null }
  sampledAt: number | null
}): VoiceVpsSnapshot {
  const lk = input.liveKit.status.status === 'ok' ? input.liveKit.current?.metrics ?? null : null
  const lkPrev = lk !== null ? input.liveKit.previous?.metrics ?? null : null
  const host = input.node.status.status === 'ok' ? input.node.current?.metrics ?? null : null
  const hostPrevSample = host !== null ? input.node.previous : null
  const hostPrev = hostPrevSample?.metrics ?? null
  const hostSeconds = host !== null && hostPrevSample !== null && input.node.current !== null
    ? (() => {
        const nowTime = firstValue(host, 'node_time_seconds')
        const prevTime = firstValue(hostPrev, 'node_time_seconds')
        if (nowTime !== null && prevTime !== null && nowTime > prevTime) return nowTime - prevTime
        return (input.node.current.at - hostPrevSample.at) / 1000
      })()
    : null

  const processStart = firstValue(lk, 'process_start_time_seconds')
  const nodeTime = firstValue(host, 'node_time_seconds')
  const bootTime = firstValue(host, 'node_boot_time_seconds')
  const referenceNow = nodeTime ?? (input.sampledAt === null ? null : input.sampledAt / 1000)

  const joins = lk?.samples.get('livekit_participant_join_total') ?? []
  const joinsByLabel = new Map<string, number>()
  for (const sample of joins) {
    const label = Object.entries(sample.labels).map(([key, value]) => `${key}=${value}`).join(', ') || 'общо'
    joinsByLabel.set(label, (joinsByLabel.get(label) ?? 0) + sample.value)
  }

  const cpu = host === null ? { cpuCount: null, busy: null, steal: null, perCpu: [] } : cpuUsage(host, hostPrev)
  const memTotal = firstValue(host, 'node_memory_MemTotal_bytes')
  const memAvailable = firstValue(host, 'node_memory_MemAvailable_bytes')
  const swapTotal = firstValue(host, 'node_memory_SwapTotal_bytes')
  const swapFree = firstValue(host, 'node_memory_SwapFree_bytes')
  const pressureNow = firstValue(host, 'node_pressure_cpu_waiting_seconds_total')
  const pressurePrev = firstValue(hostPrev, 'node_pressure_cpu_waiting_seconds_total')
  const pressureRate = rate(pressureNow, pressurePrev, hostSeconds)

  const network: VoiceVpsSnapshot['host']['network'] = []
  for (const sample of host?.samples.get('node_network_receive_bytes_total') ?? []) {
    const device = sample.labels.device
    if (device === undefined || DEVICE_EXCLUDE.test(device)) continue
    const transmit = sumOf(host, 'node_network_transmit_bytes_total', (labels) => labels.device === device)
    network.push({
      device,
      receiveBytesTotal: sample.value,
      transmitBytesTotal: transmit ?? 0,
      receiveBytesPerSecond: rate(sample.value, sumOf(hostPrev, 'node_network_receive_bytes_total', (labels) => labels.device === device), hostSeconds),
      transmitBytesPerSecond: rate(transmit, sumOf(hostPrev, 'node_network_transmit_bytes_total', (labels) => labels.device === device), hostSeconds),
    })
  }

  return {
    configured: input.configured,
    sampledAt: input.sampledAt === null ? null : new Date(input.sampledAt).toISOString(),
    rateWindowSeconds: hostSeconds,
    liveKit: {
      ...input.liveKit.status,
      version: findLiveKitVersion(lk),
      processStartedAt: toIso(processStart),
      uptimeSeconds: processStart !== null && referenceNow !== null && referenceNow > processStart ? referenceNow - processStart : null,
      rooms: sumOf(lk, 'livekit_room_total'),
      participants: sumOf(lk, 'livekit_participant_total'),
      tracksPublished: sumOf(lk, 'livekit_track_published_total'),
      tracksSubscribed: sumOf(lk, 'livekit_track_subscribed_total'),
      participantJoins: { total: sumOf(lk, 'livekit_participant_join_total'), byLabel: [...joinsByLabel].map(([label, value]) => ({ label, value })) },
      quality: {
        rttMs: qualityMetric(lk, lkPrev, 'livekit_rtt_ms'),
        jitterUs: qualityMetric(lk, lkPrev, 'livekit_jitter_us'),
        packetLossPercent: qualityMetric(lk, lkPrev, 'livekit_packet_loss_percent'),
        qualityScore: qualityMetric(lk, lkPrev, 'livekit_quality_score'),
        qualityRating: qualityMetric(lk, lkPrev, 'livekit_quality_rating'),
        joinLatencyMs: qualityMetric(lk, lkPrev, 'livekit_session_join_latency_ms'),
      },
    },
    host: {
      ...input.node.status,
      bootedAt: toIso(bootTime),
      uptimeSeconds: bootTime !== null && nodeTime !== null && nodeTime > bootTime ? nodeTime - bootTime : null,
      cpuCount: cpu.cpuCount,
      cpuBusyPercent: cpu.busy,
      cpuStealPercent: cpu.steal,
      perCpu: cpu.perCpu,
      cpuPressureWaitingPercent: pressureRate === null ? null : Math.min(100, pressureRate * 100),
      load: { one: firstValue(host, 'node_load1'), five: firstValue(host, 'node_load5'), fifteen: firstValue(host, 'node_load15') },
      memory: {
        totalBytes: memTotal,
        availableBytes: memAvailable,
        usedPercent: memTotal !== null && memAvailable !== null ? percent(memTotal - memAvailable, memTotal) : null,
        swapUsedBytes: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
      },
      network,
    },
  }
}

export function createVoiceVpsMetricsCollector(deps: {
  config: VoiceVpsMetricsConfig | null
  fetch?: FetchLike
  now?: () => number
  cacheTtlMs?: number
  timeoutMs?: number
  maxBytes?: number
}): VoiceVpsMetricsCollector {
  const config = deps.config
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const now = deps.now ?? (() => Date.now())
  const cacheTtlMs = deps.cacheTtlMs ?? VOICE_VPS_METRICS_CACHE_TTL_MS
  const timeoutMs = deps.timeoutMs ?? VOICE_VPS_METRICS_TIMEOUT_MS
  const maxBytes = deps.maxBytes ?? VOICE_VPS_METRICS_MAX_BYTES
  const authorization = config === null ? '' : `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`

  type SourceState = { status: VoiceVpsSourceStatus; current: SourceSample | null; previous: SourceSample | null }
  const freshState = (): SourceState => ({
    status: { status: config === null ? 'not_configured' : 'unavailable', reason: null, lastSuccessAt: null },
    current: null,
    previous: null,
  })
  const sources: Record<'livekit' | 'node', SourceState> = { livekit: freshState(), node: freshState() }
  let cached: { at: number; snapshot: VoiceVpsSnapshot } | null = null
  let inFlight: Promise<VoiceVpsSnapshot> | null = null

  async function fetchSource(key: 'livekit' | 'node'): Promise<void> {
    if (config === null) return
    const state = sources[key]
    try {
      const response = await doFetch(`${config.baseUrl}${VOICE_VPS_METRICS_PATHS[key]}`, {
        headers: { Authorization: authorization, Accept: 'text/plain' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        cache: 'no-store',
      })
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => {})
        throw new FetchFailure(`http_${response.status}`)
      }
      const text = await readLimited(response, maxBytes)
      const metrics = parsePrometheusText(text)
      if (metrics.samples.size === 0) throw new FetchFailure('empty')
      const at = now()
      // Предишното четене се пази само ако е достатъчно ново за скорост.
      state.previous = state.current !== null && at - state.current.at <= MAX_RATE_WINDOW_MS ? state.current : null
      state.current = { at, metrics }
      state.status = { status: 'ok', reason: null, lastSuccessAt: new Date(at).toISOString() }
    } catch (error) {
      // Грешка -> без стари стойности като „актуални“; скоростите се рестартират.
      state.current = null
      state.previous = null
      state.status = { status: 'unavailable', reason: describeFetchError(error), lastSuccessAt: state.status.lastSuccessAt }
    }
  }

  async function collect(): Promise<VoiceVpsSnapshot> {
    await Promise.all([fetchSource('livekit'), fetchSource('node')])
    return buildVoiceVpsSnapshot({
      configured: config !== null,
      liveKit: sources.livekit,
      node: sources.node,
      sampledAt: config === null ? null : now(),
    })
  }

  return {
    async getSnapshot() {
      if (cached !== null && now() - cached.at < cacheTtlMs) return cached.snapshot
      if (inFlight !== null) return inFlight
      inFlight = collect()
        .then((snapshot) => {
          cached = { at: now(), snapshot }
          return snapshot
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}

/**
 * checkVoiceChatStage6.ts
 *
 * Гласов чат, Етап 6 — backend на админ панела „Гласови разговори“:
 *   P*  Prometheus парсер;
 *   V*  метрики на гласовия VPS (конфигурация, fake fetch, скорости, кеш,
 *       timeout, 401, голям отговор, „Недостъпно“ вместо 0, без тайни);
 *   L*  живо състояние на стаите (ListRooms/ListParticipants през dispatcher-а);
 *   D*  клиентска диагностика (валидация, лимит, агрегати, без лични данни);
 *   H*  HTTP: /api/voice/client-report и /api/admin/voice-chat/monitoring
 *       през реален node:http;
 *   W*  статични проверки на index.ts (без hot path извиквания).
 * Без мрежа, без LiveKit, без база.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceChatStage6.ts
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createVoiceAdminLiveProbe } from '../src/voice/voiceAdminLiveProbe.js'
import { createVoiceAdminMonitoring } from '../src/voice/voiceAdminMonitoring.js'
import { createVoiceChatAdminRequestHandler } from '../src/voice/voiceChatAdminApi.js'
import { createVoiceChatHttpRequestHandler } from '../src/voice/voiceChatHttpApi.js'
import type { VoiceAdminTableRow, VoiceRuntimeStats } from '../src/voice/voiceChatService.js'
import type { VoiceChatStore } from '../src/voice/voiceChatStore.js'
import { createVoiceClientDiagnostics, parseVoiceClientReport } from '../src/voice/voiceClientDiagnostics.js'
import { createVoiceLiveKitDispatcher } from '../src/voice/voiceLiveKitDispatcher.js'
import type { VoiceLiveKitParticipantSummary, VoiceLiveKitRoomSummary } from '../src/voice/voiceLiveKitApi.js'
import {
  createVoiceVpsMetricsCollector,
  getVoiceVpsMetricsConfigStatus,
  parsePrometheusText,
  readVoiceVpsMetricsConfig,
} from '../src/voice/voiceVpsMetrics.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}
function near(actual: number | null, expected: number, message: string, tolerance = 0.05): void {
  if (actual === null || Math.abs(actual - expected) > tolerance) throw new Error(`${message}: очаквано ~${expected}, получено ${String(actual)}`)
}

const SECRET = 'sup3r-S3cret-metrics-pass'
const CONFIG = { baseUrl: 'https://voice.pika.test:8443', username: 'pika-metrics', password: SECRET }

// ─── Fixture метрики ──────────────────────────────────────────────────────
function nodeMetrics(t: number, cpu: { idle: number; user: number; steal: number }[], rx: number, tx: number, pressure: number): string {
  const lines = [
    '# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.',
    '# TYPE node_cpu_seconds_total counter',
  ]
  cpu.forEach((c, index) => {
    lines.push(`node_cpu_seconds_total{cpu="${index}",mode="idle"} ${c.idle}`)
    lines.push(`node_cpu_seconds_total{cpu="${index}",mode="user"} ${c.user}`)
    lines.push(`node_cpu_seconds_total{cpu="${index}",mode="steal"} ${c.steal}`)
    lines.push(`node_cpu_seconds_total{cpu="${index}",mode="iowait"} 1`)
  })
  lines.push(
    '# TYPE node_memory_MemTotal_bytes gauge', 'node_memory_MemTotal_bytes 8.0e+09',
    '# TYPE node_memory_MemAvailable_bytes gauge', 'node_memory_MemAvailable_bytes 6.0e+09',
    'node_memory_SwapTotal_bytes 0', 'node_memory_SwapFree_bytes 0',
    'node_load1 0.5', 'node_load5 0.4', 'node_load15 0.3',
    `node_time_seconds ${t}`, 'node_boot_time_seconds 1.7e+09',
    `node_network_receive_bytes_total{device="eth0"} ${rx}`,
    `node_network_transmit_bytes_total{device="eth0"} ${tx}`,
    'node_network_receive_bytes_total{device="lo"} 999999',
    'node_network_transmit_bytes_total{device="lo"} 999999',
    'node_network_receive_bytes_total{device="veth12ab"} 5',
    'node_network_transmit_bytes_total{device="veth12ab"} 5',
    `node_pressure_cpu_waiting_seconds_total ${pressure}`,
  )
  return `${lines.join('\n')}\n`
}

function liveKitMetrics(rttSum: number, rttCount: number): string {
  return [
    '# TYPE livekit_room_total gauge', 'livekit_room_total{node_id="n1"} 3',
    '# TYPE livekit_participant_total gauge', 'livekit_participant_total{node_id="n1"} 7',
    '# TYPE livekit_track_published_total gauge', 'livekit_track_published_total{kind="audio"} 4',
    '# TYPE livekit_track_subscribed_total gauge', 'livekit_track_subscribed_total{kind="audio"} 12',
    '# TYPE livekit_participant_join_total counter', 'livekit_participant_join_total{state="joined"} 20', 'livekit_participant_join_total{state="signal_failed"} 1',
    '# TYPE livekit_rtt_ms histogram',
    'livekit_rtt_ms_bucket{le="50"} 1', 'livekit_rtt_ms_bucket{le="+Inf"} 2',
    `livekit_rtt_ms_sum ${rttSum}`, `livekit_rtt_ms_count ${rttCount}`,
    '# TYPE livekit_quality_score gauge', 'livekit_quality_score 4.5',
    '# TYPE process_start_time_seconds gauge', 'process_start_time_seconds 1.70000001e+09',
    '',
  ].join('\n')
}

type FakeResponse = { status: number; body: string }
function fakeFetch(routes: { livekit: () => FakeResponse | Promise<FakeResponse>; node: () => FakeResponse | Promise<FakeResponse> }) {
  const calls: Array<{ url: string; authorization: string | undefined }> = []
  const impl = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    calls.push({ url, authorization: init.headers.Authorization })
    const route = url.endsWith('/pika-ops/livekit-metrics') ? routes.livekit : url.endsWith('/pika-ops/node-metrics') ? routes.node : () => ({ status: 404, body: '' })
    const result = await Promise.race([
      Promise.resolve(route()),
      new Promise<never>((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), { once: true })
      }),
    ])
    const bytes = new TextEncoder().encode(result.body)
    return {
      status: result.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null) },
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }),
      text: async () => result.body,
    }
  }
  return { impl, calls }
}

console.log('\ncheckVoiceChatStage6\n')

// ═══ P — Prometheus парсер ═════════════════════════════════════════════════
await check('[P1] Парсер: TYPE, етикети с escape, histogram суфикси, +Inf, невалидни редове се пропускат', () => {
  const metrics = parsePrometheusText([
    '# TYPE x_total counter',
    'x_total{a="1",b="q\\"u\\\\o"} 5 1700000000000',
    'x_total{a="2"} 7',
    'broken{a="1" 3',
    'no_value',
    'h_bucket{le="+Inf"} 9',
    'g NaN',
    '',
  ].join('\n'))
  assertEqual(metrics.types.get('x_total'), 'counter', 'тип')
  assertEqual(metrics.samples.get('x_total')?.length, 2, 'два sample-а')
  assertEqual(metrics.samples.get('x_total')?.[0]?.labels.b, 'q"u\\o', 'escape в етикет')
  assertEqual(metrics.samples.get('h_bucket')?.[0]?.labels.le, '+Inf', '+Inf етикет')
  assert(!metrics.samples.has('broken') && !metrics.samples.has('no_value'), 'невалидните редове са пропуснати')
})

// ═══ V — гласов VPS ════════════════════════════════════════════════════════
await check('[V1] Конфигурация: само https (http само loopback); без потребител/query в URL; статус само с имена', () => {
  assert(readVoiceVpsMetricsConfig({}) === null, 'празно -> null')
  assert(readVoiceVpsMetricsConfig({ VOICE_VPS_METRICS_URL: 'http://voice.pika.bg:8443', VOICE_VPS_METRICS_USERNAME: 'u', VOICE_VPS_METRICS_PASSWORD: 'p' }) === null, 'http към публичен хост -> null')
  assert(readVoiceVpsMetricsConfig({ VOICE_VPS_METRICS_URL: 'https://u:p@voice.pika.bg:8443', VOICE_VPS_METRICS_USERNAME: 'u', VOICE_VPS_METRICS_PASSWORD: 'p' }) === null, 'креденшъли в URL -> null')
  assert(readVoiceVpsMetricsConfig({ VOICE_VPS_METRICS_URL: 'https://voice.pika.bg:8443/?x=1', VOICE_VPS_METRICS_USERNAME: 'u', VOICE_VPS_METRICS_PASSWORD: 'p' }) === null, 'query -> null')
  assert(readVoiceVpsMetricsConfig({ VOICE_VPS_METRICS_URL: 'http://127.0.0.1:9', VOICE_VPS_METRICS_USERNAME: 'u', VOICE_VPS_METRICS_PASSWORD: 'p' }) !== null, 'loopback http -> ok')
  const ok = readVoiceVpsMetricsConfig({ VOICE_VPS_METRICS_URL: 'https://voice.pika.bg:8443/', VOICE_VPS_METRICS_USERNAME: 'pika-metrics', VOICE_VPS_METRICS_PASSWORD: SECRET })
  assertEqual(ok?.baseUrl, 'https://voice.pika.bg:8443', 'без наклонена черта')
  const status = getVoiceVpsMetricsConfigStatus({ VOICE_VPS_METRICS_URL: 'https://voice.pika.bg:8443', VOICE_VPS_METRICS_PASSWORD: SECRET })
  assertEqual(status.configured, false, 'непълно')
  assertEqual(status.missing.join(','), 'VOICE_VPS_METRICS_USERNAME', 'само името на липсващото')
  assert(!JSON.stringify(status).includes(SECRET), 'без стойности')
})

await check('[V2] Не е конфигурирано -> без заявки; всички стойности null („Недостъпно“), не 0', async () => {
  const fake = fakeFetch({ livekit: () => ({ status: 200, body: liveKitMetrics(10, 1) }), node: () => ({ status: 200, body: '' }) })
  const collector = createVoiceVpsMetricsCollector({ config: null, fetch: fake.impl as never })
  const snapshot = await collector.getSnapshot()
  assertEqual(fake.calls.length, 0, 'без мрежа')
  assertEqual(snapshot.configured, false, 'configured')
  assertEqual(snapshot.liveKit.status, 'not_configured', 'livekit статус')
  assertEqual(snapshot.host.status, 'not_configured', 'host статус')
  for (const value of [snapshot.liveKit.rooms, snapshot.liveKit.version, snapshot.host.cpuBusyPercent, snapshot.host.cpuStealPercent, snapshot.host.memory.usedPercent, snapshot.host.uptimeSeconds]) {
    assert(value === null, 'стойност null')
  }
  assertEqual(snapshot.host.network.length, 0, 'без мрежови интерфейси')
})

await check('[V3] Две четения: CPU общо/по vCPU, steal, PSI, трафик (без lo/veth), RAM, uptime, рестарт на LiveKit, качество за интервала', async () => {
  let now = 1_000_000
  let step = 0
  const fake = fakeFetch({
    livekit: () => ({ status: 200, body: step === 0 ? liveKitMetrics(100, 2) : liveKitMetrics(160, 4) }),
    node: () => ({
      status: 200,
      body: step === 0
        ? nodeMetrics(1_700_000_100, [{ idle: 100, user: 10, steal: 0 }, { idle: 100, user: 10, steal: 0 }], 1_000_000, 2_000_000, 1)
        // 20 s: cpu0 -> 10 busy (user) + 10 idle; cpu1 -> 2 steal + 18 idle
        : nodeMetrics(1_700_000_120, [{ idle: 110, user: 20, steal: 0 }, { idle: 118, user: 10, steal: 2 }], 1_250_000, 2_500_000, 3),
    }),
  })
  const collector = createVoiceVpsMetricsCollector({ config: CONFIG, fetch: fake.impl as never, now: () => now, cacheTtlMs: 20_000 })
  const first = await collector.getSnapshot()
  assertEqual(first.host.status, 'ok', 'host ok')
  assertEqual(first.host.cpuBusyPercent, null, 'първо четене: CPU % се изчислява (null, не 0)')
  assertEqual(first.host.network[0]?.receiveBytesPerSecond ?? null, null, 'първо четене: трафик null')
  assertEqual(first.host.cpuCount, 2, 'брой vCPU')
  near(first.host.memory.usedPercent, 25, 'RAM %')
  near(first.host.uptimeSeconds, 100, 'uptime', 0.5)
  assertEqual(first.liveKit.processStartedAt, new Date(1_700_000_010 * 1000).toISOString(), 'рестарт на LiveKit')
  assertEqual(first.liveKit.version, null, 'версия: само ако е в метриките (иначе null)')
  assertEqual(first.liveKit.rooms, 3, 'стаи')
  near(first.liveKit.quality.rttMs.lifetimeMean, 50, 'RTT от старта')
  assertEqual(first.liveKit.quality.rttMs.intervalMean, null, 'RTT за интервала — още няма')
  near(first.liveKit.quality.qualityScore.current, 4.5, 'gauge качество')
  assertEqual(first.liveKit.participantJoins.total, 21, 'joins общо')

  step = 1
  now += 20_000
  const second = await collector.getSnapshot()
  near(second.rateWindowSeconds, 20, 'интервал')
  near(second.host.perCpu[0]?.busyPercent ?? null, 50, 'vCPU 0 busy')
  near(second.host.perCpu[1]?.busyPercent ?? null, 10, 'vCPU 1 busy (steal е заетост)')
  near(second.host.perCpu[1]?.stealPercent ?? null, 10, 'vCPU 1 steal')
  near(second.host.cpuBusyPercent, 30, 'CPU общо')
  near(second.host.cpuStealPercent, 5, 'steal общо')
  near(second.host.cpuPressureWaitingPercent, 10, 'PSI %')
  assertEqual(second.host.network.length, 1, 'само eth0 (без lo/veth)')
  near(second.host.network[0]!.receiveBytesPerSecond, 12_500, 'rx B/s')
  near(second.host.network[0]!.transmitBytesPerSecond, 25_000, 'tx B/s')
  near(second.liveKit.quality.rttMs.intervalMean, 30, 'RTT за интервала (60/2)')
  assertEqual(second.liveKit.quality.rttMs.intervalCount, 2, 'наблюдения в интервала')
})

await check('[V4] Кеш 20 s + single-flight: едновременни/повторни заявки -> едно извличане на източник; Basic auth; паролата не е в снимката', async () => {
  let now = 5_000
  const fake = fakeFetch({ livekit: () => ({ status: 200, body: liveKitMetrics(1, 1) }), node: () => ({ status: 200, body: nodeMetrics(1_700_000_000, [{ idle: 1, user: 1, steal: 0 }], 1, 1, 0) }) })
  const collector = createVoiceVpsMetricsCollector({ config: CONFIG, fetch: fake.impl as never, now: () => now })
  await Promise.all([collector.getSnapshot(), collector.getSnapshot(), collector.getSnapshot()])
  assertEqual(fake.calls.length, 2, 'single-flight: по едно на източник')
  now += 19_000
  await collector.getSnapshot()
  assertEqual(fake.calls.length, 2, 'в рамките на кеша — без заявки')
  now += 2_000
  const snapshot = await collector.getSnapshot()
  assertEqual(fake.calls.length, 4, 'след кеша — ново извличане')
  const expected = `Basic ${Buffer.from(`pika-metrics:${SECRET}`).toString('base64')}`
  assert(fake.calls.every((call) => call.authorization === expected), 'Basic auth на всяка заявка')
  assert(fake.calls.every((call) => call.url.startsWith('https://voice.pika.test:8443/pika-ops/')), 'само двата маршрута')
  const text = JSON.stringify(snapshot)
  assert(!text.includes(SECRET) && !text.includes(Buffer.from(`pika-metrics:${SECRET}`).toString('base64')), 'без парола/хедър в снимката')
})

await check('[V5] 401 / timeout / твърде голям отговор -> „Недостъпно“ с причина, стойностите null (не стари, не 0); последното успешно се пази', async () => {
  let now = 0
  let mode: 'ok' | '401' | 'hang' | 'large' = 'ok'
  const fake = fakeFetch({
    livekit: () => (mode === '401' ? { status: 401, body: 'no' } : mode === 'hang' ? new Promise<FakeResponse>(() => {}) : mode === 'large' ? { status: 200, body: 'x'.repeat(2_000) } : { status: 200, body: liveKitMetrics(1, 1) }),
    node: () => ({ status: 200, body: nodeMetrics(1_700_000_000, [{ idle: 1, user: 1, steal: 0 }], 1, 1, 0) }),
  })
  const collector = createVoiceVpsMetricsCollector({ config: CONFIG, fetch: fake.impl as never, now: () => now, cacheTtlMs: 1, timeoutMs: 50, maxBytes: 1_000 })
  const ok = await collector.getSnapshot()
  assertEqual(ok.liveKit.status, 'ok', 'ok')
  mode = '401'
  now += 10
  const denied = await collector.getSnapshot()
  assertEqual(denied.liveKit.status, 'unavailable', '401 -> unavailable')
  assertEqual(denied.liveKit.reason, 'http_401', 'причина')
  assertEqual(denied.liveKit.rooms, null, 'стаи null (не старата стойност)')
  assertEqual(denied.liveKit.lastSuccessAt, ok.liveKit.lastSuccessAt, 'последно успешно')
  assertEqual(denied.host.status, 'ok', 'другият източник е независим')
  mode = 'hang'
  now += 10
  const started = Date.now()
  // AbortSignal.timeout е unref-нат: в теста няма други активни handle-и.
  const keepAlive = setInterval(() => {}, 1_000)
  const hung = await collector.getSnapshot().finally(() => clearInterval(keepAlive))
  assertEqual(hung.liveKit.reason, 'timeout', 'timeout')
  assert(Date.now() - started < 2_000, 'timeout-ът ограничава чакането')
  mode = 'large'
  now += 10
  const large = await collector.getSnapshot()
  assertEqual(large.liveKit.reason, 'too_large', 'твърде голям')
})

// ═══ L — живо състояние на стаите ══════════════════════════════════════════
function table(id: string, live: string | null, extra: Partial<VoiceAdminTableRow> = {}): VoiceAdminTableRow {
  return { voiceTableId: id, phase: 'in_game', createdAt: '2026-11-13T10:00:00.000Z', inGameAt: '2026-11-13T10:05:00.000Z', liveRoomName: live, generation: live === null ? null : 1, seatedMembers: 4, activeVoiceSessions: 0, blocked: null, ...extra }
}

await check('[L1] Без LiveKit конфигурация -> not_configured, броевете null; резервираните маси са известни', async () => {
  const probe = createVoiceAdminLiveProbe({ listTables: () => [table('a', 'pv_dev_a_g1_x')], api: null, dispatcher: createVoiceLiveKitDispatcher() })
  const snapshot = await probe.getSnapshot()
  assertEqual(snapshot.status, 'not_configured', 'статус')
  assertEqual(snapshot.totals.reservedTables, 1, 'резервирани')
  assertEqual(snapshot.totals.participants, null, 'участници null')
  assertEqual(snapshot.tables[0]?.counts.microphoneOn, null, 'микрофон null')
})

await check('[L2] ListRooms + ListParticipants: участници, с микрофон, само слушат; несъздадена стая = 0; без идентичности', async () => {
  const calls: string[] = []
  const api = {
    listRooms: async (names?: string[]): Promise<VoiceLiveKitRoomSummary[]> => {
      calls.push(`rooms:${(names ?? []).join(',')}`)
      return [{ name: 'pv_dev_a_g1_x', numParticipants: 3 }]
    },
    listParticipants: async (room: string): Promise<VoiceLiveKitParticipantSummary[]> => {
      calls.push(`participants:${room}`)
      return [
        { state: 'active', microphonePublished: true, microphoneMuted: false },
        { state: 'active', microphonePublished: false, microphoneMuted: false },
        { state: 'joined', microphonePublished: true, microphoneMuted: true },
        { state: 'disconnected', microphonePublished: true, microphoneMuted: false },
      ]
    },
  }
  const probe = createVoiceAdminLiveProbe({ listTables: () => [table('a', 'pv_dev_a_g1_x'), table('b', 'pv_dev_b_g1_y', { phase: 'waiting' }), table('c', null)], api, dispatcher: createVoiceLiveKitDispatcher() })
  const snapshot = await probe.getSnapshot()
  assertEqual(snapshot.status, 'ok', 'ok')
  assertEqual(snapshot.totals.activeRooms, 1, 'активни стаи')
  assertEqual(snapshot.totals.participants, 3, 'свързани (без disconnected)')
  assertEqual(snapshot.totals.microphoneOn, 1, 'с микрофон (заглушеният не се брои)')
  assertEqual(snapshot.totals.listening, 2, 'само слушат')
  assertEqual(snapshot.tables.find((t) => t.voiceTableId === 'b')?.roomExists, false, 'несъздадена стая')
  assertEqual(calls.filter((c) => c.startsWith('participants:')).length, 1, 'ListParticipants само за стаи с участници')
  assert(!JSON.stringify(snapshot).includes('identity'), 'без identity')
})

await check('[L3] LiveKit недостъпен -> unavailable с причина, броевете null (не 0); кешът пази breaker-а от натиск', async () => {
  let listCalls = 0
  let now = 0
  const api = {
    listRooms: async (): Promise<VoiceLiveKitRoomSummary[]> => {
      listCalls += 1
      throw Object.assign(new Error('503 upstream'), { status: 503 })
    },
  }
  const probe = createVoiceAdminLiveProbe({ listTables: () => [table('a', 'pv_dev_a_g1_x')], api, dispatcher: createVoiceLiveKitDispatcher({ maxAttempts: 1 }), now: () => now })
  const snapshot = await probe.getSnapshot()
  assertEqual(snapshot.status, 'unavailable', 'unavailable')
  assert(snapshot.reason !== null, 'причина')
  assertEqual(snapshot.totals.participants, null, 'null, не 0')
  const before = listCalls
  now += 5_000
  await probe.getSnapshot()
  assertEqual(listCalls, before, 'в рамките на кеша — без нова заявка')
})

await check('[L4] Ограничение на ListParticipants на обновяване -> partial; разделянето е null, общият брой е от ListRooms', async () => {
  const names = ['r1', 'r2', 'r3']
  const api = {
    listRooms: async (): Promise<VoiceLiveKitRoomSummary[]> => names.map((name) => ({ name, numParticipants: 2 })),
    listParticipants: async (): Promise<VoiceLiveKitParticipantSummary[]> => [
      { state: 'active', microphonePublished: true, microphoneMuted: false },
      { state: 'active', microphonePublished: false, microphoneMuted: false },
    ],
  }
  const probe = createVoiceAdminLiveProbe({ listTables: () => names.map((name) => table(name, name)), api, dispatcher: createVoiceLiveKitDispatcher(), maxParticipantQueries: 2 })
  const snapshot = await probe.getSnapshot()
  assertEqual(snapshot.status, 'partial', 'partial')
  assertEqual(snapshot.totals.participants, 6, 'общо от ListRooms')
  assertEqual(snapshot.totals.microphoneOn, null, 'разделянето не е пълно -> null')
  assertEqual(snapshot.tables[2]?.counts.microphoneOn, null, 'непроверената стая')
})

await check('[L5] Кешират се само LiveKit данните: прекратена маса изчезва веднага (резервирани = свеж брой); нова — „непроверена“; invalidate() -> ново четене', async () => {
  let now = 0
  let listCalls = 0
  let tables = [table('a', 'ra'), table('b', 'rb')]
  const api = {
    listRooms: async (names?: string[]): Promise<VoiceLiveKitRoomSummary[]> => {
      listCalls += 1
      return (names ?? []).map((name) => ({ name, numParticipants: 0 }))
    },
  }
  const probe = createVoiceAdminLiveProbe({ listTables: () => tables, api, dispatcher: createVoiceLiveKitDispatcher(), now: () => now })
  const first = await probe.getSnapshot()
  assertEqual(first.totals.reservedTables, 2, 'две маси')
  assertEqual(first.totals.activeRooms, 2, 'две стаи')
  tables = []
  now += 1_000
  const afterOff = await probe.getSnapshot()
  assertEqual(listCalls, 1, 'в рамките на кеша — без нова LiveKit заявка')
  assertEqual(afterOff.totals.reservedTables, 0, 'резервираните са 0 веднага (без остарели данни)')
  assertEqual(afterOff.tables.length, 0, 'без прекратените маси')
  assertEqual(afterOff.totals.activeRooms, 0, 'без остарели стаи')
  tables = [table('c', 'rc')]
  const withNew = await probe.getSnapshot()
  assertEqual(withNew.tables[0]?.roomExists, null, 'новата маса е непроверена')
  assertEqual(withNew.totals.participants, null, 'непроверено -> null, не 0')
  probe.invalidate()
  const fresh = await probe.getSnapshot()
  assertEqual(listCalls, 2, 'invalidate -> ново четене')
  assertEqual(fresh.tables[0]?.roomExists, true, 'проверена след invalidate')
})

await check('[A1] POST /mode off: releasedVoiceTables + retiredRooms; pendingRoomDeletions идва от базата (не се представя като потвърдено)', async () => {
  const store = {
    ...fakeStore(),
    setMode: () => ({
      ok: true, changed: true, previousMode: 'admin_only',
      settings: { mode: 'off', maxTables: 10, modeChangedAt: null, modeChangedByProfileId: null, maxTablesChangedAt: null, maxTablesChangedByProfileId: null },
      releasedVoiceTableIds: ['t1', 't2', 't3'], retiredRoomNames: ['r1', 'r2'],
    }),
    countActiveVoiceTables: () => 0,
    countPendingRoomDeletions: () => 2,
  } as unknown as VoiceChatStore
  let invalidated = 0
  const handle = createVoiceChatAdminRequestHandler({
    store,
    getFullAdminProfileId: () => 'admin-profile',
    isAllowedOrigin: () => true,
    readJsonBody: readBody,
    onModeChanged: () => { invalidated += 1 },
    log: () => {},
  })
  await withServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end() }
  }, async (base) => {
    const response = await fetch(`${base}/api/admin/voice-chat/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'off', confirm: true }) })
    const body = await response.json() as Record<string, unknown>
    assertEqual(body.releasedVoiceTables, 3, 'прекратени маси')
    assertEqual(body.retiredRooms, 2, 'оттеглени стаи')
    assertEqual(body.activeVoiceTables, 0, 'резервирани 0 след изключването')
    assertEqual(body.pendingRoomDeletions, 2, 'чакащи DeleteRoom')
  })
  assertEqual(invalidated, 1, 'onModeChanged (index.ts изчиства кеша на live probe-а)')
  const index = await readFile('src/index.ts', 'utf8')
  assert(/onModeChanged: \(result\) => \{[\s\S]{0,200}voiceAdminLiveProbe\.invalidate\(\)/.test(index), 'index.ts: invalidate при смяна на режима')
})

// ═══ D — клиентска диагностика ═════════════════════════════════════════════
await check('[D1] Валидация: затворени изброявания, числа в граници, mic/connect причини само към своето събитие', () => {
  assert(parseVoiceClientReport({ event: 'connected' }) !== null, 'connected')
  assert(parseVoiceClientReport({ event: 'connect_failed', reason: 'token_unavailable' }) !== null, 'connect_failed')
  assert(parseVoiceClientReport({ event: 'connect_failed', reason: 'mic_not_found' }) === null, 'mic причина към connect_failed')
  assert(parseVoiceClientReport({ event: 'mic_failed', reason: 'livekit_connect_failed' }) === null, 'connect причина към mic_failed')
  assert(parseVoiceClientReport({ event: 'mic_failed', reason: 'free text <script>' }) === null, 'свободен текст')
  assert(parseVoiceClientReport({ event: 'unknown' }) === null, 'непознато събитие')
  assert(parseVoiceClientReport({ event: 'transport', transport: { candidateType: 'relay', protocol: 'tls', rttMs: 40, jitterMs: 2, packetLossPercent: 0.5 } }) !== null, 'transport')
  assert(parseVoiceClientReport({ event: 'transport', transport: { candidateType: 'relay', protocol: 'tls', rttMs: -1, jitterMs: null, packetLossPercent: null } }) === null, 'отрицателно RTT')
  assert(parseVoiceClientReport({ event: 'transport', transport: { candidateType: 'relay', protocol: 'tls', rttMs: null, jitterMs: null, packetLossPercent: 101 } }) === null, 'загуба > 100')
  assert(parseVoiceClientReport('x') === null && parseVoiceClientReport(null) === null, 'не-обект')
})

await check('[D2] Агрегати и лимит на профил; без профили в снимката; TURN % null без отчети', () => {
  let now = 0
  const diagnostics = createVoiceClientDiagnostics({ now: () => now, limitPerMinute: 3 })
  assertEqual(diagnostics.snapshot().transport.relayPercent, null, 'без отчети -> null')
  diagnostics.record('profile-secret-1', { event: 'connected' })
  diagnostics.record('profile-secret-1', { event: 'transport', transport: { candidateType: 'relay', protocol: 'tls', rttMs: 40, jitterMs: 2, packetLossPercent: 1 } })
  diagnostics.record('profile-secret-1', { event: 'mic_failed', reason: 'mic_permission_denied' })
  assertEqual(diagnostics.record('profile-secret-1', { event: 'connected' }), 'limited', 'лимит')
  assertEqual(diagnostics.record('profile-secret-2', { event: 'transport', transport: { candidateType: 'host', protocol: 'udp', rttMs: 20, jitterMs: null, packetLossPercent: 0 } }), 'ok', 'друг профил')
  assertEqual(diagnostics.record('profile-secret-2', { event: 'bogus' }), 'invalid', 'невалиден')
  now += 61_000
  assertEqual(diagnostics.record('profile-secret-1', { event: 'reconnecting' }), 'ok', 'новият прозорец')
  const snapshot = diagnostics.snapshot()
  assertEqual(snapshot.events.connected, 1, 'connected')
  assertEqual(snapshot.events.reconnecting, 1, 'reconnecting')
  assertEqual(snapshot.failures.mic_permission_denied, 1, 'причина')
  assertEqual(snapshot.transport.relayPercent, 50, 'TURN %')
  assertEqual(snapshot.transport.relayByProtocol.tls, 1, 'relay по протокол')
  near(snapshot.transport.rttMs.mean, 30, 'средно RTT')
  near(snapshot.transport.jitterMs.mean, 2, 'jitter (само наличните)')
  assertEqual(snapshot.rejectedReports, 2, 'отхвърлени')
  assert(!JSON.stringify(snapshot).includes('profile-secret'), 'без профили')
})

// ═══ H — HTTP през реален node:http ════════════════════════════════════════
async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, fn: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    await fn(base)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
}

await check('[H1] POST /api/voice/client-report: 405/403/401/400/200/429, Cache-Control: no-store', async () => {
  const diagnostics = createVoiceClientDiagnostics({ limitPerMinute: 2 })
  const handle = createVoiceChatHttpRequestHandler({
    service: { handleTokenRequest: async () => {}, handleSpeakAccessRequest: async () => {}, describeCreationOption: () => ({ visible: false, canCreate: false, reason: 'voice_off' }) } as never,
    getSessionProfileId: (req) => (req.headers.cookie === 'session=ok' ? 'p1' : null),
    isFullAdminProfile: () => false,
    isAllowedOrigin: (req) => req.headers.origin !== 'https://evil.test',
    readJsonBody: readBody,
    clientDiagnostics: diagnostics,
  })
  await withServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end() }
  }, async (base) => {
    const post = (body: unknown, headers: Record<string, string> = { cookie: 'session=ok' }) => fetch(`${base}/api/voice/client-report`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    assertEqual((await fetch(`${base}/api/voice/client-report`)).status, 405, 'GET')
    assertEqual((await post({ event: 'connected' }, { cookie: 'session=ok', origin: 'https://evil.test' })).status, 403, 'чужд origin')
    assertEqual((await post({ event: 'connected' }, {})).status, 401, 'без сесия')
    assertEqual((await post({ event: 'nope' })).status, 400, 'невалидно')
    const ok = await post({ event: 'connected' })
    assertEqual(ok.status, 200, 'ok')
    assertEqual(ok.headers.get('cache-control'), 'no-store', 'no-store')
    await post({ event: 'reconnecting' })
    assertEqual((await post({ event: 'connected' })).status, 429, 'лимит')
  })
  assertEqual(diagnostics.snapshot().events.connected, 1, 'отчетено')
})

function fakeStore(): VoiceChatStore {
  return {
    getSettings: () => ({ mode: 'admin_only', maxTables: 10, modeChangedAt: null, modeChangedByProfileId: null, maxTablesChangedAt: null, maxTablesChangedByProfileId: null }),
    countActiveVoiceTables: () => 2,
    countPendingRoomDeletions: () => 1,
    listAdminChanges: () => [],
  } as unknown as VoiceChatStore
}

const runtimeStats: VoiceRuntimeStats = {
  bootComplete: true,
  liveKitConfigured: true,
  bindings: 2,
  activeVoiceSessions: 2,
  blockedTables: 0,
  memberships: 4,
  pendingStoreWrites: 0,
  dispatcher: { breaker: 'closed', consecutiveFailures: 0, inFlight: 0, queuedHigh: 0, queuedNormal: 0, succeeded: 9, failed: 1, rejectedBreakerOpen: 0, rejectedQueueFull: 0, breakerOpenedCount: 0 },
  reconciler: { uncertainWatches: 0, pendingUncertainMarks: 0, bootSweepPending: false, createsInFlight: 0 },
  counters: { tokensIssued: 5, tokensDenied: 2, rotations: 1 },
  tokensDeniedByCode: { voice_rotation_pending: 1, spectator: 1 },
}

await check('[H2] GET /api/admin/voice-chat/monitoring: само пълен admin, GET, no-store; live/vps/server/clients без тайни', async () => {
  const monitoring = createVoiceAdminMonitoring({
    liveProbe: createVoiceAdminLiveProbe({ listTables: () => [table('a', null)], api: null, dispatcher: createVoiceLiveKitDispatcher() }),
    vpsCollector: createVoiceVpsMetricsCollector({ config: null }),
    clientDiagnostics: createVoiceClientDiagnostics(),
    getRuntimeStats: () => runtimeStats,
    processStartedAt: '2026-11-13T09:00:00.000Z',
  })
  const handle = createVoiceChatAdminRequestHandler({
    store: fakeStore(),
    getFullAdminProfileId: (req) => (req.headers.cookie === 'admin=1' ? 'admin-profile' : null),
    isAllowedOrigin: () => true,
    readJsonBody: readBody,
    getMonitoring: monitoring,
    env: { LIVEKIT_API_SECRET: 'lk-secret-value', VOICE_VPS_METRICS_PASSWORD: SECRET },
  })
  await withServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end() }
  }, async (base) => {
    assertEqual((await fetch(`${base}/api/admin/voice-chat/monitoring`)).status, 403, 'не-admin')
    assertEqual((await fetch(`${base}/api/admin/voice-chat/monitoring`, { method: 'POST', headers: { cookie: 'admin=1' } })).status, 405, 'POST')
    const response = await fetch(`${base}/api/admin/voice-chat/monitoring`, { headers: { cookie: 'admin=1' } })
    assertEqual(response.status, 200, 'admin')
    assertEqual(response.headers.get('cache-control'), 'no-store', 'no-store')
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, any>
    assertEqual(body.live.status, 'not_configured', 'live')
    assertEqual(body.vps.configured, false, 'vps')
    assertEqual(body.server.tokensIssued, 5, 'server броячи')
    assertEqual(body.server.tokensDeniedByCode.voice_rotation_pending, 1, 'откази по код')
    assertEqual(body.clients.events.connected, 0, 'clients')
    assert(!text.includes('lk-secret-value') && !text.includes(SECRET), 'без тайни')
    const baseSnapshot = await (await fetch(`${base}/api/admin/voice-chat`, { headers: { cookie: 'admin=1' } })).json() as Record<string, any>
    assertEqual(baseSnapshot.vpsMetrics.configured, false, 'статус на конфигурацията в основния snapshot')
    assert(baseSnapshot.vpsMetrics.missing.includes('VOICE_VPS_METRICS_URL'), 'имена на липсващите')
    assert(!JSON.stringify(baseSnapshot).includes(SECRET), 'основният snapshot без тайни')
  })
})

await check('[H3] /monitoring при бавен източник -> 503 след таймаута (не виси)', async () => {
  const handle = createVoiceChatAdminRequestHandler({
    store: fakeStore(),
    getFullAdminProfileId: () => 'admin-profile',
    isAllowedOrigin: () => true,
    readJsonBody: readBody,
    getMonitoring: () => new Promise(() => {}),
    monitoringBudgetMs: 80,
  })
  await withServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!(await handle(req, res, url))) { res.writeHead(404); res.end() }
  }, async (base) => {
    const started = Date.now()
    const response = await fetch(`${base}/api/admin/voice-chat/monitoring`)
    assertEqual(response.status, 503, '503')
    assert(Date.now() - started < 2_000, 'бърз отказ')
  })
})

// ═══ W — статични проверки ═════════════════════════════════════════════════
await check('[W1] index.ts: мониторингът е само в админ handler-а; client-report е включен; без извиквания от игровите пътища', async () => {
  const index = await readFile('src/index.ts', 'utf8')
  assert(index.includes('getMonitoring: voiceAdminMonitoring'), 'admin API получава getMonitoring')
  assert(index.includes('clientDiagnostics: voiceClientDiagnostics'), 'HTTP API получава clientDiagnostics')
  const uses = index.split('\n').filter((line) => /voiceAdminMonitoring|vpsCollector|liveProbe/.test(line) && !/^\s*\/\//.test(line))
  assert(uses.length <= 5, `ограничени места: ${uses.length}`)
  assert(!/voiceAdminMonitoring\(\)/.test(index), 'никъде не се вика директно (само от админ handler-а)')
  const vps = await readFile('src/voice/voiceVpsMetrics.ts', 'utf8')
  assert(!/console\.(log|info|warn|error)/.test(vps), 'VPS модулът не логва (без риск за паролата)')
  const diagnostics = await readFile('src/voice/voiceClientDiagnostics.ts', 'utf8')
  assert(!/console\.|createWriteStream|prepare\(/.test(diagnostics), 'диагностиката не логва и не пише в база')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

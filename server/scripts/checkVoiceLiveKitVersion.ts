/**
 * checkVoiceLiveKitVersion.ts
 *
 * Целеви проверки: версията на LiveKit в админ панела идва от Node Exporter
 * textfile метриката pika_livekit_build_info (ops/voice-livekit-version), с
 * проверка за успех и актуалност. Останалите показатели не се променят.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceLiveKitVersion.ts   (от server/)
 */

import { deepStrictEqual } from 'node:assert'
import { LIVEKIT_VERSION_TEXTFILE_MAX_AGE_SECONDS, buildVoiceVpsSnapshot, parsePrometheusText, type VoiceVpsSnapshot } from '../src/voice/voiceVpsMetrics'

let passed = 0
let failed = 0
function check(label: string, fn: () => void): void {
  try {
    fn()
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

const NODE_TIME = 1_794_700_000
const SAMPLED_AT = NODE_TIME * 1000

const NODE_BASE = [
  '# TYPE node_time_seconds gauge',
  `node_time_seconds ${NODE_TIME}`,
  `node_boot_time_seconds ${NODE_TIME - 86_400}`,
  'node_cpu_seconds_total{cpu="0",mode="idle"} 1000',
  'node_cpu_seconds_total{cpu="0",mode="user"} 100',
  'node_cpu_seconds_total{cpu="0",mode="steal"} 2',
  'node_load1 0.5',
  'node_memory_MemTotal_bytes 8000000000',
  'node_memory_MemAvailable_bytes 6000000000',
  'node_network_receive_bytes_total{device="eth0"} 12345',
  'node_network_transmit_bytes_total{device="eth0"} 54321',
  'node_textfile_scrape_error 0',
].join('\n')

const LIVEKIT_BASE = [
  '# TYPE livekit_room_total gauge',
  'livekit_room_total 2',
  'livekit_participant_total 5',
  `process_start_time_seconds ${NODE_TIME - 3600}`,
  'go_info{version="go1.24.4"} 1',
].join('\n')

function textfile(options: { version?: string | null; success?: number; checkedAt?: number | null; extra?: string } = {}): string {
  const lines: string[] = []
  const version = options.version === undefined ? '1.13.11' : options.version
  if (version !== null) lines.push('# TYPE pika_livekit_build_info gauge', `pika_livekit_build_info{version="${version}"} 1`)
  lines.push('# TYPE pika_livekit_version_check_success gauge', `pika_livekit_version_check_success ${options.success ?? 1}`)
  const checkedAt = options.checkedAt === undefined ? NODE_TIME - 60 : options.checkedAt
  if (checkedAt !== null) lines.push('# TYPE pika_livekit_version_check_timestamp_seconds gauge', `pika_livekit_version_check_timestamp_seconds ${checkedAt}`)
  if (options.extra !== undefined) lines.push(options.extra)
  return lines.join('\n')
}

const ok = { status: 'ok' as const, reason: null, lastSuccessAt: new Date(SAMPLED_AT).toISOString() }
const down = { status: 'unavailable' as const, reason: 'timeout', lastSuccessAt: null }

function snapshot(nodeText: string | null, liveKitText: string | null = LIVEKIT_BASE): VoiceVpsSnapshot {
  return buildVoiceVpsSnapshot({
    configured: true,
    liveKit: { status: liveKitText === null ? down : ok, current: liveKitText === null ? null : { at: SAMPLED_AT, metrics: parsePrometheusText(liveKitText) }, previous: null },
    node: { status: nodeText === null ? down : ok, current: nodeText === null ? null : { at: SAMPLED_AT, metrics: parsePrometheusText(nodeText) }, previous: null },
    sampledAt: SAMPLED_AT,
  })
}

const versionOf = (nodeText: string | null, liveKitText?: string | null): string | null => snapshot(nodeText, liveKitText).liveKit.version

console.log('\ncheckVoiceLiveKitVersion\n')

check('[V1] Актуална успешна проверка -> версията от pika_livekit_build_info (без „v“); go_info не се бърка с LiveKit', () => {
  assert(versionOf(`${NODE_BASE}\n${textfile()}`) === '1.13.11', 'версия 1.13.11')
  assert(versionOf(`${NODE_BASE}\n${textfile({ version: 'v1.14.0-rc.1' })}`) === '1.14.0-rc.1', 'префиксът v се маха')
  assert(versionOf(NODE_BASE) === null, 'без textfile метрика -> null (go_info в LiveKit метриките не е версия на LiveKit)')
})

check('[V2] Неуспешна последна проверка (success 0, без build_info) -> null; success 0 дори със стара build_info -> null', () => {
  assert(versionOf(`${NODE_BASE}\n${textfile({ version: null, success: 0 })}`) === null, 'success 0 без версия')
  assert(versionOf(`${NODE_BASE}\n${textfile({ success: 0 })}`) === null, 'success 0 + build_info')
})

check(`[V3] Актуалност: до ${LIVEKIT_VERSION_TEXTFILE_MAX_AGE_SECONDS / 60} мин спрямо node_time_seconds; по-стара, от бъдещето (>2 мин) или без timestamp -> null`, () => {
  assert(versionOf(`${NODE_BASE}\n${textfile({ checkedAt: NODE_TIME - LIVEKIT_VERSION_TEXTFILE_MAX_AGE_SECONDS })}`) === '1.13.11', 'точно на границата')
  assert(versionOf(`${NODE_BASE}\n${textfile({ checkedAt: NODE_TIME - LIVEKIT_VERSION_TEXTFILE_MAX_AGE_SECONDS - 1 })}`) === null, 'остаряла (таймерът е спрял)')
  assert(versionOf(`${NODE_BASE}\n${textfile({ checkedAt: NODE_TIME + 60 })}`) === '1.13.11', 'малко разминаване на часовника')
  assert(versionOf(`${NODE_BASE}\n${textfile({ checkedAt: NODE_TIME + 600 })}`) === null, 'от бъдещето')
  assert(versionOf(`${NODE_BASE}\n${textfile({ checkedAt: null })}`) === null, 'без timestamp')
  const noNodeTime = NODE_BASE.split('\n').filter((line) => !line.includes('node_time_seconds')).join('\n')
  assert(versionOf(`${noNodeTime}\n${textfile()}`) === null, 'без node_time_seconds няма надеждна референция')
})

check('[V4] Невалидни/двусмислени данни -> null (невалиден етикет, стойност ≠ 1, две версии, дублиран success)', () => {
  assert(versionOf(`${NODE_BASE}\n${textfile({ version: 'latest' })}`) === null, 'невалиден етикет')
  assert(versionOf(`${NODE_BASE}\n${textfile({ version: '1.13.11 <b>x</b>' })}`) === null, 'произволен текст в етикета')
  assert(versionOf(`${NODE_BASE}\n${textfile().replace('{version="1.13.11"} 1', '{version="1.13.11"} 0')}`) === null, 'стойност 0')
  assert(versionOf(`${NODE_BASE}\n${textfile({ extra: 'pika_livekit_build_info{version="1.12.0"} 1' })}`) === null, 'две различни версии')
  assert(versionOf(`${NODE_BASE}\n${textfile({ extra: 'pika_livekit_version_check_success 1' })}`) === null, 'дублиран success')
})

check('[V5] Node Exporter източникът е недостъпен -> null (няма кеширана стара версия); LiveKit източникът не е нужен', () => {
  assert(versionOf(null) === null, 'node недостъпен')
  assert(versionOf(`${NODE_BASE}\n${textfile()}`, null) === '1.13.11', 'LiveKit метриките недостъпни -> версията все пак е от работещия контейнер')
})

check('[V6] Етикет version на livekit_* метрика (ако някога се появи) остава с приоритет', () => {
  assert(versionOf(`${NODE_BASE}\n${textfile()}`, `${LIVEKIT_BASE}\nlivekit_build_info{version="1.20.0"} 1`) === '1.20.0', 'приоритет на LiveKit метриките')
})

check('[V7] Останалите показатели са идентични със и без textfile метриката', () => {
  const withVersion = snapshot(`${NODE_BASE}\n${textfile()}`)
  const without = snapshot(NODE_BASE)
  assert(withVersion.liveKit.version === '1.13.11' && without.liveKit.version === null, 'разликата е само във версията')
  deepStrictEqual({ ...withVersion.liveKit, version: null }, without.liveKit)
  deepStrictEqual(withVersion.host, without.host)
  deepStrictEqual(withVersion.rateWindowSeconds, without.rateWindowSeconds)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

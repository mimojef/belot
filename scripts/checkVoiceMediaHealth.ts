/**
 * checkVoiceMediaHealth.ts — Гласов чат, Етап H1/H2: чистата логика за
 * медийното здраве (src/app/voice/voiceMediaHealth.ts) и UI състоянията на
 * собствения микрофон. Детерминистично, без браузър и без LiveKit; реалното
 * поведение е в scripts/checkVoiceMediaHealthE2E.ts (реален LiveKit).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMediaHealth.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceSnapshot } from '../src/app/voice/createVoiceController'
import {
  classifyVoicePlatform,
  createCoalescedTask,
  createInputHealthEvaluator,
  createRecoveryLimiter,
  createRemoteStallEvaluator,
  durationBucket,
  VOICE_PLATFORMS,
  type VoiceOutboundSample,
} from '../src/app/voice/voiceMediaHealth'
import { describeMicHealth, describeVoiceStatus, voiceMicState } from '../src/app/voice/ui/voiceUiStatus'
import { renderVoicePanel } from '../src/app/voice/ui/renderVoicePanel'

console.log('\ncheckVoiceMediaHealth\n')

let passed = 0
let failed = 0
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}

/** Поредица измервания на 3 s: packets(i) дава брояча за i-тото измерване. */
function series(count: number, packets: (index: number) => number, extra: (index: number) => Partial<VoiceOutboundSample> = () => ({})): VoiceOutboundSample[] {
  return Array.from({ length: count }, (_, index) => ({
    at: 10_000 + index * 3_000,
    statsTimestamp: 1_000_000 + index * 3_000,
    rtpStreamId: 'OT01',
    packetsSent: packets(index),
    sourceSamplesDuration: 100 + index * 3,
    senderHasCapture: true,
    captureLive: true,
    captureEnabled: true,
    captureMuted: false,
    upstreamPaused: false,
    ...extra(index),
  }))
}

function run(samples: VoiceOutboundSample[]) {
  const evaluator = createInputHealthEvaluator()
  const verdicts = samples.map((sample) => evaluator.push(sample))
  return { evaluator, verdicts, changes: verdicts.flatMap((v) => (v.change === null ? [] : [v.change])) }
}

// ─── Изходящо аудио ──────────────────────────────────────────────────────

await check('[U1] Нормален говор (50 пакета/s) -> ok, без промени', () => {
  const { verdicts, changes } = run(series(40, (i) => i * 150))
  assert(verdicts.every((v) => v.health === 'ok'), 'винаги ok')
  assertEqual(changes.length, 0, 'без докладвани промени')
  assertEqual(verdicts.at(-1)!.packetsPerSecond, 50, 'измерена честота')
})

await check('[U2] DTX/тишина (~2,5 пакета/s) и много рядко изпращане (на всеки 6 s) -> никога подозрение', () => {
  const dtx = run(series(60, (i) => i * 7))
  assert(dtx.verdicts.every((v) => v.health === 'ok'), 'DTX ok')
  // Нов пакет само на всяко второ измерване (6 s без пакет) — пак не е подозрение.
  const sparse = run(series(60, (i) => Math.floor(i / 2)))
  assert(sparse.verdicts.every((v) => v.health === 'ok'), 'рядко изпращане ok')
  assertEqual(dtx.changes.length + sparse.changes.length, 0, 'без промени')
})

await check('[U3] RTP стои ≥3 измервания и ≥9 s -> stall_suspected веднъж (capture дава кадри); нов пакет -> stall_cleared с продължителност', () => {
  const samples = series(20, (i) => (i < 5 ? i * 150 : i < 15 ? 600 : 600 + (i - 14) * 150))
  const { verdicts, changes } = run(samples)
  // Последният нов пакет е при измерване 4; 5 и 6 — 1 и 2 измервания (3 и 6 s) без пакет.
  assertEqual(verdicts[6]!.health, 'ok', '2 измервания / 6 s без пакет — още ok')
  const firstStall = verdicts.findIndex((v) => v.health === 'stall_suspected')
  assertEqual(firstStall, 7, 'подозрение при 3-тото измерване без пакет (9 s от последния пакет)')
  assertEqual(changes.filter((c) => c.state === 'stall_suspected').length, 1, 'едно докладвано подозрение')
  assertEqual(changes.find((c) => c.state === 'stall_suspected')!.evidence, 'capture_active', 'media-source напредва')
  const cleared = changes.find((c) => c.state === 'stall_cleared')
  assert(cleared !== undefined && cleared.duration === '10to60s', `stall_cleared с продължителност: ${JSON.stringify(cleared)}`)
  assertEqual(verdicts.at(-1)!.health, 'ok', 'отново ok')
})

await check('[U4] Остаряла статистика (stats timestamp не напредва) -> без решение', () => {
  const { verdicts } = run(series(20, () => 600, () => ({ statsTimestamp: 5_000 })))
  assert(verdicts.every((v) => v.health === 'ok' && v.decision === 'no_decision'), 'без решение')
})

await check('[U5] Нулиран брояч и нов RTP поток -> нова база, без фалшиво подозрение', () => {
  const reset = run(series(12, (i) => (i < 4 ? 1000 + i * 150 : 10 + (i - 4) * 150)))
  assert(reset.verdicts.every((v) => v.health === 'ok'), 'нулиран брояч')
  const newStream = run(series(12, (i) => 500 + i * 100, (i) => ({ rtpStreamId: i < 6 ? 'OT01' : 'OT02', packetsSent: i < 6 ? 500 + i * 100 : 5 + (i - 6) * 100 })))
  assert(newStream.verdicts.every((v) => v.health === 'ok'), 'нов поток')
})

await check('[U5b] Подозрение + НОВ RTP поток с изпратени пакети (официален reconnect на LiveKit) -> веднага stall_cleared; същият поток без пакети -> подозрението остава', () => {
  const stalled = series(10, (i) => (i < 2 ? i * 150 : 150))
  const evaluator = createInputHealthEvaluator()
  for (const sample of stalled) evaluator.push(sample)
  assertEqual(evaluator.health(), 'stall_suspected', 'подготвено подозрение')
  const fresh = evaluator.push({ ...stalled.at(-1)!, at: stalled.at(-1)!.at + 3_000, statsTimestamp: stalled.at(-1)!.statsTimestamp! + 3_000, rtpStreamId: 'OT02', packetsSent: 40 })
  assert(fresh.health === 'ok' && fresh.change?.state === 'stall_cleared', `нов поток: ${JSON.stringify(fresh)}`)
  const other = createInputHealthEvaluator()
  for (const sample of stalled) other.push(sample)
  // Reconnect (resetBaseline) между двете измервания — пак се разпознава новият поток.
  const third = createInputHealthEvaluator()
  for (const sample of stalled) third.push(sample)
  third.resetBaseline()
  const afterReconnect = third.push({ ...stalled.at(-1)!, at: stalled.at(-1)!.at + 3_000, statsTimestamp: stalled.at(-1)!.statsTimestamp! + 3_000, rtpStreamId: 'OT02', packetsSent: 30 })
  assert(afterReconnect.health === 'ok' && afterReconnect.change?.state === 'stall_cleared', `след reconnect: ${JSON.stringify(afterReconnect)}`)
  const stillZero = other.push({ ...stalled.at(-1)!, at: stalled.at(-1)!.at + 3_000, statsTimestamp: stalled.at(-1)!.statsTimestamp! + 3_000, rtpStreamId: 'OT02', packetsSent: 0 })
  assertEqual(stillZero.health, 'stall_suspected', 'нов поток без пакети не изчиства')
})

await check('[U6] Пауза в измерването > 7,5 s (фон, throttling) -> базата започва наново, без решение през паузата', () => {
  const samples = series(4, (i) => i * 150).concat(series(3, () => 450, (i) => ({ at: 40_000 + i * 3_000, statsTimestamp: 1_030_000 + i * 3_000 })))
  const { verdicts } = run(samples)
  assert(verdicts.every((v) => v.health === 'ok'), 'без подозрение след паузата (само 2 измервания в новата база)')
})

await check('[U7] Sender без нашия capture / липсващи показатели -> без решение (липсващ показател не е дефект)', () => {
  const noSender = run(series(20, () => 600, () => ({ senderHasCapture: false })))
  assert(noSender.verdicts.every((v) => v.health === 'ok' && v.decision === 'no_decision'), 'sender без capture')
  const noStats = run(series(20, () => 600, () => ({ packetsSent: null })))
  assert(noStats.verdicts.every((v) => v.health === 'ok'), 'без packetsSent')
})

await check('[U8] Системно mute -> system_muted веднага (дори при стоящи пакети, без stall); unmute -> system_unmuted с продължителност', () => {
  const samples = series(16, (i) => (i < 3 ? i * 150 : 300), (i) => ({ captureMuted: i >= 3 && i < 13 }))
  const { verdicts, changes } = run(samples)
  assertEqual(verdicts[3]!.health, 'system_muted', 'веднага при mute')
  assert(verdicts.slice(3, 13).every((v) => v.health === 'system_muted'), 'не се „бори“ и не става stall')
  assertEqual(changes[0]!.state, 'system_muted', 'докладвано mute')
  assert(changes[1]!.state === 'system_unmuted' && changes[1]!.duration === '10to60s', `unmute: ${JSON.stringify(changes[1])}`)
  assert(!changes.some((c) => c.state === 'stall_suspected'), 'без stall по време на mute')
})

await check('[U9] LiveKit спрял изходящото (upstreamPaused) -> system_muted', () => {
  const { verdicts } = run(series(6, (i) => i * 150, (i) => ({ upstreamPaused: i >= 2 })))
  assertEqual(verdicts.at(-1)!.health, 'system_muted', 'upstream paused')
})

await check('[U10] Доказателства при подозрение: capture_stalled (media-source стои) / packets_only (без media-source)', () => {
  const stalled = run(series(12, (i) => (i < 2 ? i * 150 : 150), (i) => ({ sourceSamplesDuration: i < 2 ? 100 + i * 3 : 103 })))
  assertEqual(stalled.changes.find((c) => c.state === 'stall_suspected')?.evidence, 'capture_stalled', 'capture стои')
  const unknown = run(series(12, (i) => (i < 2 ? i * 150 : 150), () => ({ sourceSamplesDuration: null })))
  assertEqual(unknown.changes.find((c) => c.state === 'stall_suspected')?.evidence, 'packets_only', 'без media-source')
})

await check('[U11] clear() (нов/спрян микрофон) -> ok без докладвана промяна; спрян capture -> без решение', () => {
  const { evaluator } = run(series(12, (i) => (i < 2 ? i * 150 : 150)))
  assertEqual(evaluator.health(), 'stall_suspected', 'подготвено подозрение')
  evaluator.clear()
  assertEqual(evaluator.health(), 'ok', 'след clear')
  const ended = run(series(20, () => 600, () => ({ captureLive: false })))
  assert(ended.verdicts.every((v) => v.decision === 'no_decision'), 'ended capture')
  assertEqual(durationBucket(5_000), 'lt10s', 'bucket')
  assertEqual(durationBucket(120_000), 'gt60s', 'bucket')
})

// ─── Отдалечен stall (допълнителен сигнал) ───────────────────────────────

await check('[U12] Отдалечен участник говори непрекъснато, а байтове не пристигат ≥6 s -> едно подозрение; cooldown; тишина/нови байтове -> нищо', () => {
  const evaluator = createRemoteStallEvaluator()
  const sample = (at: number, bytes: number, speakingSince: number | null) => ({ at, speakingSince, statsTimestamp: at, rtpStreamId: 'IT1', bytesReceived: bytes })
  const results = [0, 3_000, 6_000, 9_000, 12_000, 15_000].map((t) => evaluator.push('TR1', sample(10_000 + t, 500, 5_000)))
  assertEqual(results.filter(Boolean).length, 1, `едно подозрение: ${JSON.stringify(results)}`)
  // Нови байтове -> нищо.
  const flowing = createRemoteStallEvaluator()
  assert(![0, 3_000, 6_000, 9_000].some((t) => flowing.push('TR1', sample(10_000 + t, 500 + t, 5_000))), 'байтовете растат')
  // Не говори -> нищо.
  const silent = createRemoteStallEvaluator()
  assert(![0, 3_000, 6_000, 9_000, 12_000].some((t) => silent.push('TR1', sample(10_000 + t, 500, null))), 'не говори')
  // Започнал да говори СЛЕД първото измерване -> не се брои.
  const late = createRemoteStallEvaluator()
  const lateResults = [0, 3_000, 6_000].map((t) => late.push('TR1', sample(10_000 + t, 500, 9_500)))
  assert(!lateResults.some(Boolean), 'говорът не покрива целия прозорец')
})

// ─── H2: ограничение и обединяване ───────────────────────────────────────

await check('[U13] Лимит по track sid (3 за 60 s): повторното прикачване (същият sid) не дава нов бюджет; друг sid — да; общ таван 10', () => {
  const limiter = createRecoveryLimiter()
  const got = [0, 1, 2, 3, 4].map((i) => limiter.tryAcquire('TR_A', 1_000 + i))
  assertEqual(got.filter(Boolean).length, 3, 'най-много 3 на sid')
  assert(limiter.tryAcquire('TR_B', 1_010), 'друг sid')
  assert(limiter.tryAcquire('TR_A', 62_000), 'след прозореца отново')
  const global = createRecoveryLimiter()
  const all = Array.from({ length: 15 }, (_, i) => global.tryAcquire(`TR_${i}`, 1_000 + i))
  assertEqual(all.filter(Boolean).length, 10, 'общ таван')
  global.reset()
  assert(global.tryAcquire('TR_0', 2_000), 'reset (жест)')
})

function manualTimers() {
  let now = 0
  let seq = 0
  const queue = new Map<number, { at: number; fn: () => void }>()
  return {
    timers: {
      setTimeout: (fn: () => void, delayMs: number) => { seq += 1; queue.set(seq, { at: now + delayMs, fn }); return seq },
      clearTimeout: (handle: unknown) => { queue.delete(handle as number) },
      now: () => now,
    },
    async advance(ms: number) {
      const target = now + ms
      for (;;) {
        const next = [...queue.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (next === undefined || next[1].at > target) break
        queue.delete(next[0])
        now = next[1].at
        next[1].fn()
        for (let i = 0; i < 10; i += 1) await Promise.resolve()
      }
      now = target
    },
    size: () => queue.size,
  }
}

await check('[U14] Обединяване: visibility+focus+pageshow+devicechange+pause -> ЕДНА проверка; заявки по време на проверка -> една следваща; никога две едновременно; cancel -> нищо', async () => {
  const clock = manualTimers()
  const runs: string[][] = []
  let release: (() => void) | null = null
  const task = createCoalescedTask<string>(clock.timers, async (triggers) => {
    runs.push([...triggers].sort())
    if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
  })
  task.request('visible', 250)
  task.request('focus', 250)
  task.request('pageshow', 250)
  task.request('devicechange', 1_000)
  task.request('pause', 250)
  await clock.advance(300)
  assertEqual(runs.length, 1, 'една проверка')
  assertEqual(runs[0]!.join(','), 'devicechange,focus,pageshow,pause,visible', 'обединени тригери')
  task.request('pause', 250)
  task.request('focus', 250)
  await clock.advance(1_000)
  assertEqual(runs.length, 1, 'втората чака края на първата')
  release!()
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await clock.advance(10)
  assertEqual(runs.length, 2, 'точно една следваща')
  assertEqual(task.stats().maxConcurrent, 1, 'никога две едновременно')
  task.cancel()
  task.request('visible', 0)
  await clock.advance(1_000)
  assertEqual(runs.length, 2, 'след cancel — нищо')
  assertEqual(clock.size(), 0, 'без висящи таймери')
})

// ─── Груба платформа ─────────────────────────────────────────────────────

await check('[U15] Груба платформа: iPhone Safari/PWA, iPad (Macintosh+touch), Samsung, Android Chrome/PWA, desktop; празен UA -> unknown', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1'
  const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'
  const androidChrome = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Safari/605.1.15'
  const desktopChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const env = (standalone: boolean, touch = 0) => ({ standalone, maxTouchPoints: touch })
  assertEqual(classifyVoicePlatform(iphone, env(false, 5)), 'ios_safari', 'iPhone Safari')
  assertEqual(classifyVoicePlatform(iphone, env(true, 5)), 'ios_pwa', 'iPhone PWA')
  assertEqual(classifyVoicePlatform(ipad, env(false, 5)), 'ios_safari', 'iPad (desktop UA + touch)')
  assertEqual(classifyVoicePlatform(ipad, env(false, 0)), 'desktop_safari', 'Mac Safari')
  assertEqual(classifyVoicePlatform(samsung, env(false, 5)), 'android_samsung', 'Samsung Internet')
  assertEqual(classifyVoicePlatform(samsung, env(true, 5)), 'android_pwa', 'Samsung PWA')
  assertEqual(classifyVoicePlatform(androidChrome, env(false, 5)), 'android_chrome', 'Android Chrome')
  assertEqual(classifyVoicePlatform(desktopChrome, env(false)), 'desktop_chrome', 'desktop Chrome')
  assertEqual(classifyVoicePlatform('', env(false)), 'unknown', 'празен UA')
})

// ─── UI: собственият микрофон ────────────────────────────────────────────

function liveSnapshot(health: VoiceSnapshot['microphoneHealth'], extra: Partial<VoiceSnapshot> = {}): VoiceSnapshot {
  return {
    status: 'connected_speaking', voiceTableId: 'vt-1', screen: 'game', speak: { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: true, mutedUntil: null },
    wantsToSpeak: true, microphone: 'live', microphoneHealth: health, playbackBlocked: false, uiError: null, canRestore: false, offerDismissed: false,
    microphoneDevicesChanged: false, generation: 1, locallyMutedProfileIds: [], speakingProfileIds: [],
    participants: [{ profileId: 'self', isSelf: true, voiceConnected: true, microphonePublished: true, speaking: false, listening: false, locallyMuted: false, unknown: false }],
    ...extra,
  } as VoiceSnapshot
}
const seats = [{ profileId: 'self', displayName: 'Аз', avatarUrl: null, isBot: false, isSelf: true }]

await check('[U16] UI: ok -> зелен „Микрофон включен“; system_muted / stall_suspected -> кехлибарено „warn“ с реалното състояние (никога зелено)', () => {
  assertEqual(voiceMicState(liveSnapshot('ok')), 'on', 'ok')
  assertEqual(describeVoiceStatus(liveSnapshot('ok')).tone, 'ok', 'зелено при ok')
  for (const health of ['system_muted', 'stall_suspected'] as const) {
    const snap = liveSnapshot(health)
    assertEqual(voiceMicState(snap), 'warn', `${health} -> warn`)
    const status = describeVoiceStatus(snap)
    assert(status.tone === 'busy' && status.label !== 'Микрофон включен', `${health}: ${JSON.stringify(status)}`)
  }
  assertEqual(describeVoiceStatus(liveSnapshot('system_muted')).label, 'Микрофонът е прекъснат', 'етикет mute')
  assertEqual(describeVoiceStatus(liveSnapshot('stall_suspected')).label, 'Микрофонът не предава', 'етикет stall')
  // Без включен микрофон здравето не се показва.
  assertEqual(describeMicHealth(liveSnapshot('stall_suspected', { microphone: 'off', status: 'connected_listening' })), null, 'без микрофон')
  // Стар snapshot без полето -> ok (съвместимост).
  assertEqual(voiceMicState({ ...liveSnapshot('ok'), microphoneHealth: undefined } as unknown as VoiceSnapshot), 'on', 'липсващо поле')
})

await check('[U17] Панел: предупреждението и редът „Ти“ показват реалното състояние; без бутон за автоматично действие; при ok — нищо ново; „Включи звука“ остава', () => {
  const render = (snap: VoiceSnapshot) => renderVoicePanel({ snapshot: snap, seats, theme: 'light', joinOffer: 'speak', canOpenShop: false })
  const ok = render(liveSnapshot('ok'))
  assert(!ok.includes('прекъснат от устройството') && !ok.includes('може да не предава'), 'при ok без предупреждение')
  assert(ok.includes('Микрофон вкл.'), 'редът при ok')
  const muted = render(liveSnapshot('system_muted'))
  assert(muted.includes('Микрофонът е прекъснат от устройството') && muted.includes('pvp-notice--warn'), 'предупреждение mute')
  assert(muted.includes('Микрофонът е прекъснат') && !muted.includes('Микрофон вкл.'), 'редът показва прекъсването')
  const stall = render(liveSnapshot('stall_suspected'))
  assert(stall.includes('Микрофонът може да не предава звук'), 'предупреждение stall')
  // H3: при подозрение/неуспех — само изричното „Възстанови микрофона“ (никакво друго ново действие);
  // при системно прекъсване и по време на възстановяването — без бутон.
  const actions = (html: string) => (html.match(/data-voice-action="[^"]+"/g) ?? []).sort().join(',')
  assertEqual(actions(stall), [...(ok.match(/data-voice-action="[^"]+"/g) ?? []), 'data-voice-action="recover-mic"'].sort().join(','), 'само + „Възстанови микрофона“')
  assert(stall.includes('Възстанови микрофона'), 'бутонът')
  assert(!muted.includes('data-voice-action="recover-mic"'), 'системно -> без бутон')
  const recovering = render(liveSnapshot('stall_suspected', { microphoneRecovery: 'recovering' }))
  assert(recovering.includes('Микрофонът се възстановява') && !recovering.includes('data-voice-action="recover-mic"'), 'по време на възстановяването -> без бутон')
  const failedHtml = render(liveSnapshot('stall_suspected', { microphoneRecovery: 'failed' }))
  assert(failedHtml.includes('Микрофонът не можа да бъде възстановен') && failedHtml.includes('data-voice-action="recover-mic"'), 'failed -> текст + бутон')
  const blocked = render(liveSnapshot('ok', { playbackBlocked: true }))
  assert(blocked.includes('data-voice-action="unlock-audio"'), '„Включи звука“ при блокиран звук')
})

await check('[U19] Панелът „Диагностика на звука“: без мрежов код; storage само за собствените флагове; без токени/identity/имена в обобщението', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/voice/voiceDiagnosticsOverlay.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'EventSource']) assert(!code.includes(forbidden), `без ${forbidden}`)
  const keys = [...code.matchAll(/(?:local|session)Storage\.(?:getItem|setItem|removeItem)\(([^)]+)\)/g)].map((m) => m[1]!.trim())
  assert(keys.every((k) => k === 'VOICE_DIAGNOSTICS_STORAGE_KEY'), `storage само за флага на панела: ${keys.join(', ')}`)
  // Показваното/копираното обобщение (summary) — без токени, identity, имена и профили.
  const summaryBody = code.slice(code.indexOf('function summary()'), code.indexOf('function render()'))
  assert(summaryBody.length > 100, 'намерено обобщение')
  for (const forbidden of ['token', 'identity', 'displayName', 'profileId', 'trackSid']) assert(!summaryBody.includes(forbidden), `обобщението не съдържа ${forbidden}`)
})

await check('[U18] Платформите и медийните стойности на клиента са същите като затворените изброявания на сървъра', () => {
  const server = readFileSync(join(process.cwd(), 'server/src/voice/voiceClientDiagnostics.ts'), 'utf8')
  const block = server.slice(server.indexOf('export const VOICE_CLIENT_PLATFORMS'), server.indexOf('] as const', server.indexOf('export const VOICE_CLIENT_PLATFORMS')))
  const serverPlatforms = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  assertEqual(JSON.stringify(serverPlatforms), JSON.stringify([...VOICE_PLATFORMS]), 'платформи')
  for (const value of ['system_muted', 'system_unmuted', 'stall_suspected', 'stall_cleared', 'capture_stalled', 'capture_active', 'packets_only', 'element_paused', 'element_missing', 'playback_blocked', 'remote_stall_suspected', 'reattach', 'start_audio', 'gesture_required', 'limited', 'attach_check', 'devicechange', 'gesture',
    'mic_recovery', 'recovered', 'no_rtp', 'gum_failed', 'gum_denied', 'replace_failed', 'not_confirmed', 'permission_required', 'cooldown', 'limit', 'capture_active', 'disabled']) {
    assert(server.includes(`'${value}'`), `сървърът приема ${value}`)
  }
})

await check('[U20] Тестовото превключване на автоматичното: само пълен администратор, само в паметта, вързано за профила; production по подразбиране — изключено', async () => {
  const config = await import('../src/app/voice/voiceMicRecoveryConfig')
  const admin = { fullAdmin: true, profileId: 'admin-1' }
  config.resetVoiceMicAutoRecoveryOverride()
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(admin), false, 'production по подразбиране (без Vite dev) — изключено')
  assertEqual(config.setVoiceMicAutoRecoveryOverride(true, { fullAdmin: false, profileId: 'vip-1' }), false, 'не-администратор не може')
  assertEqual(config.setVoiceMicAutoRecoveryOverride(true, { fullAdmin: true, profileId: null }), false, 'без профил не може')
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(admin), false, 'отказът не променя нищо')
  assertEqual(config.setVoiceMicAutoRecoveryOverride(true, admin), true, 'пълен администратор')
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(admin), true, 'включено за този администратор')
  assertEqual(config.isVoiceMicAutoRecoveryEnabled({ fullAdmin: true, profileId: 'admin-2' }), false, 'друг профил -> не')
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(admin), false, 'смяната на профила го премахва окончателно')
  config.setVoiceMicAutoRecoveryOverride(true, admin)
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(null), false, 'излизане -> не')
  assertEqual(config.isVoiceMicAutoRecoveryEnabled(admin), false, 'и не се връща след ново влизане')
  config.setVoiceMicAutoRecoveryOverride(true, admin)
  assertEqual(config.isVoiceMicAutoRecoveryEnabled({ fullAdmin: false, profileId: 'admin-1' }), false, 'загубени права -> не')
  const source = readFileSync(join(process.cwd(), 'src/app/voice/voiceMicRecoveryConfig.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(source), 'без трайно записване (само паметта на страницата)')
})

await check('[U21] Панелът „Диагностика на звука“: заявката (?voicediag=1) сама не дава достъп — само пълен администратор с профил', async () => {
  const { canShowVoiceDiagnostics } = await import('../src/app/voice/voiceDiagnosticsOverlay')
  assertEqual(canShowVoiceDiagnostics(true, { fullAdmin: true, profileId: 'admin-1' }), true, 'пълен администратор + заявка')
  assertEqual(canShowVoiceDiagnostics(false, { fullAdmin: true, profileId: 'admin-1' }), false, 'без заявка')
  for (const [label, access] of [['играч/VIP/subadmin/служебна роля', { fullAdmin: false, profileId: 'p-1' }], ['без сесия', null], ['без профил', { fullAdmin: true, profileId: null }]] as const) {
    assertEqual(canShowVoiceDiagnostics(true, access), false, label)
  }
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8')
  assert(main.includes("diagnosticsAccess: () => ({ fullAdmin: currentAuthSession?.account.role === 'admin'"), 'достъпът = account.role === \'admin\' от текущата сесия')
})

await check('[U23] Заявката ?voicediag=1 оцелява след prerender (Chrome адресна лента): записва се и при активирането; адресът е резервен източник', async () => {
  const request = await import('../src/app/voice/voiceDiagnosticsRequest')
  const makeStorage = () => {
    const data = new Map<string, string>()
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) }, removeItem: (k: string) => { data.delete(k) } }
  }
  // Prerender: страницата пише в ОТДЕЛЕН sessionStorage, който се изхвърля при активирането.
  const prerenderStorage = makeStorage()
  const tabStorage = makeStorage()
  let active = prerenderStorage
  let search = '?voicediag=1'
  const env = { search: () => search, storage: () => active }
  const listeners: Array<() => void> = []
  const doc = { prerendering: true, addEventListener: (type: string, fn: () => void) => { if (type === 'prerenderingchange') listeners.push(fn) } }
  request.installVoiceDiagnosticsRequest(doc as never, env)
  assertEqual(prerenderStorage.getItem(request.VOICE_DIAGNOSTICS_STORAGE_KEY), '1', 'записано по време на prerender')
  active = tabStorage
  doc.prerendering = false
  for (const fn of listeners) fn()
  assertEqual(tabStorage.getItem(request.VOICE_DIAGNOSTICS_STORAGE_KEY), '1', 'записано отново в sessionStorage на таба при активирането')
  assertEqual(listeners.length, 1, 'един слушател (once)')
  // Рутерът махна адреса -> остава запомненото за таба.
  search = ''
  assertEqual(request.isVoiceDiagnosticsRequested(env), true, 'запомнено за таба')
  // Резервно: адресът все още е ?voicediag=1, а записът липсва.
  const empty = makeStorage()
  assertEqual(request.isVoiceDiagnosticsRequested({ search: () => '?voicediag=1', storage: () => empty }), true, 'адресът е достатъчен като заявка')
  assertEqual(request.isVoiceDiagnosticsRequested({ search: () => '?voicediag=0', storage: () => tabStorage }), false, '?voicediag=0 има предимство')
  request.recordVoiceDiagnosticsRequest({ search: () => '?voicediag=0', storage: () => tabStorage })
  assertEqual(tabStorage.getItem(request.VOICE_DIAGNOSTICS_STORAGE_KEY), null, '?voicediag=0 изтрива заявката')
  assertEqual(request.isVoiceDiagnosticsRequested({ search: () => '', storage: () => { throw new Error('blocked') } }), false, 'без sessionStorage и без адрес -> не')
  // Без prerender — без слушател.
  const plainListeners: unknown[] = []
  request.installVoiceDiagnosticsRequest({ prerendering: false, addEventListener: (...a: unknown[]) => { plainListeners.push(a) } } as never, { search: () => '?voicediag=1', storage: () => makeStorage() })
  assertEqual(plainListeners.length, 0, 'без prerender -> без слушател')
  // Заявката НЕ е достъп: само пълен администратор (U21) — и сега, и при заявка от адреса.
  const { canShowVoiceDiagnostics } = await import('../src/app/voice/voiceDiagnosticsOverlay')
  assertEqual(canShowVoiceDiagnostics(true, { fullAdmin: false, profileId: 'subadmin-1' }), false, 'заявка без права -> не')
  const main = readFileSync(join(process.cwd(), 'src/main.ts'), 'utf8')
  assert(main.includes('installVoiceDiagnosticsRequest()'), 'main.ts записва заявката през installVoiceDiagnosticsRequest')
  const source = readFileSync(join(process.cwd(), 'src/app/voice/voiceDiagnosticsRequest.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'localStorage']) assert(!source.includes(forbidden), `без ${forbidden}`)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

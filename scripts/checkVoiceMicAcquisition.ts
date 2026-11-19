/**
 * checkVoiceMicAcquisition.ts
 *
 * Гласов чат — изрично включване на микрофона: придобиването (getUserMedia /
 * разрешението) е отделено от публикуването в LiveKit. Истинският
 * createVoiceController (и lazy facade-ът за cold start) срещу FAKE адаптер с
 * acquireMicrophone, забавено разрешение и симулиран reconnect на LiveKit SDK
 * по време на публикуването. Без браузър, без livekit-client, без мрежа.
 *
 * Покрива:
 *   * създаване на гласова маса / присъединяване чрез покана;
 *   * забавено разрешение; прекъсване / ротация / изтрита стая / SDK reconnect
 *     ДОКАТО разрешението чака; няколко последователни прекъсвания;
 *   * вече дадено разрешение; cold start (нова страница: lazy зареждане) —
 *     вкл. SDK reconnect, който отменя първото публикуване;
 *   * доброволен отказ, напускане, административно заглушаване, лоби, друга
 *     маса докато разрешението чака; 20-секундният лимит;
 *   * отказано разрешение / липсващ микрофон (същите съобщения);
 *   * без дублирани audio tracks и без незатворен capture;
 *   * диагностичните отчети минават строгата сървърна валидация.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMicAcquisition.ts
 */

import type { VoiceDiagnosticReport } from '../src/app/voice/voiceAdapter'
import { classifyPublishError } from '../src/app/voice/voicePublishErrors'
import {
  INVITED_SEATS, JWT_MARK, MUTED, SEATS, TABLE, TABLE_B,
  createHarness, deleteRoom, flush, holdPermission, joinWithMic, loseConnection, micAttempts, rotate, snap,
  type Harness,
} from './fixtures/voiceControllerFakeHarness'
import { parseVoiceClientReport, createVoiceClientDiagnostics } from '../server/src/voice/voiceClientDiagnostics'

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


/** Инварианти: ≤1 стая, ≤1 публикуван микрофон, без незатворен capture. */
function assertClean(h: Harness, expectLive: boolean, label: string): void {
  assert(h.fake.state.activeRooms() <= 1, `${label}: повече от една активна стая`)
  assertEqual(h.fake.state.publishedMics(), expectLive ? 1 : 0, `${label}: публикувани микрофони (дублирани audio tracks)`)
  assertEqual(h.fake.state.liveCaptures(), expectLive ? 1 : 0, `${label}: активни capture-и`)
  assertEqual(snap(h).microphone, expectLive ? 'live' : 'off', `${label}: състояние на микрофона`)
}

function assertNoError(h: Harness, label: string): void {
  assertEqual(snap(h).uiError?.code ?? null, null, `${label}: съобщение`)
}

console.log('\ncheckVoiceMicAcquisition\n')

// ═══ Създаване / покана / забавено разрешение ═════════════════════════════

await check('[MA1] Създаване на гласова маса + „Включи микрофона“ при забавено разрешение (3 s) -> микрофонът е включен; диагностика initial/enabled/1to5s', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  assertEqual(snap(h).microphone, 'requesting', 'докато разрешението чака')
  assertEqual(snap(h).status, 'connected_listening', 'слушането вече работи')
  await h.clock.advance(3_000)
  await release()
  assertClean(h, true, 'след разрешението')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia')
  assertNoError(h, 'MA1')
  const attempt = micAttempts(h).at(-1)
  assert(attempt !== undefined && attempt.source === 'initial' && attempt.result === 'enabled' && attempt.interruption === 'none' && attempt.gum === '1to5s', `отчет: ${JSON.stringify(attempt)}`)
})

await check('[MA2] Присъединяване чрез покана (чужда маса, друго място) + ръчно включване от панела -> panel/enabled', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting', INVITED_SEATS, TABLE_B))
  await flush()
  h.voice.joinAsListener()
  await flush(30)
  assertEqual(snap(h).status, 'connected_listening', 'слушане')
  const release = holdPermission(h)
  h.voice.enableMicrophone()
  await flush(30)
  await h.clock.advance(800)
  await release()
  assertClean(h, true, 'покана')
  const attempt = micAttempts(h).at(-1)
  assert(attempt !== undefined && attempt.source === 'panel' && attempt.result === 'enabled' && attempt.gum === 'lt1s', `отчет: ${JSON.stringify(attempt)}`)
})

// ═══ Прекъсвания ДОКАТО разрешението чака ════════════════════════════════

for (const scenario of ['connection_lost', 'rotation', 'room_deleted', 'sdk_reconnect'] as const) {
  await check(`[MB-${scenario}] Прекъсване (${scenario}) докато разрешението чака -> намерението остава; след разрешението микрофонът е включен в актуалната стая (без втори getUserMedia)`, async () => {
    const h = createHarness()
    const release = holdPermission(h)
    await joinWithMic(h)
    const first = h.fake.state.last()
    if (scenario === 'connection_lost') await loseConnection(h)
    if (scenario === 'rotation') await rotate(h)
    if (scenario === 'room_deleted') await deleteRoom(h)
    if (scenario === 'sdk_reconnect') first.events.onReconnecting()
    await flush()
    assertEqual(snap(h).microphone, 'requesting', 'намерението е запазено')
    assertEqual(snap(h).wantsToSpeak, true, 'wantsToSpeak')
    await release()
    if (scenario === 'sdk_reconnect') {
      // Разрешението е дадено по време на reconnect-а -> публикуване след Reconnected.
      assertEqual(snap(h).microphone, 'requesting', 'чака Reconnected')
      first.events.onReconnected()
      await flush(30)
    }
    assertClean(h, true, scenario)
    assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia')
    if (scenario !== 'sdk_reconnect') assert(h.fake.state.last() !== first, 'нова стая')
    assertNoError(h, scenario)
    const attempt = micAttempts(h).at(-1)
    assert(attempt !== undefined && attempt.result === 'recovered' && attempt.interruption === scenario, `отчет: ${JSON.stringify(attempt)}`)
    // Възстановеният микрофон не е окончателна грешка.
    assert(!h.reports.some((r) => r.event === 'mic_failed'), 'без mic_failed')
  })
}

await check('[MB5] Няколко последователни прекъсвания (загуба -> ротация -> SDK reconnect) докато разрешението чака -> един capture, един публикуван микрофон', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  await loseConnection(h)
  await rotate(h)
  const current = h.fake.state.last()
  current.events.onReconnecting()
  await flush()
  current.events.onReconnected()
  await flush(30)
  assertEqual(snap(h).microphone, 'requesting', 'намерението е запазено')
  await release()
  assertClean(h, true, 'MB5')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia')
  assertEqual(micAttempts(h).length, 1, 'един отчет за заявката')
  assertEqual(micAttempts(h)[0]!.interruption, 'connection_lost', 'първото прекъсване')
})

// ═══ Вече дадено разрешение и cold start (нова страница) ═════════════════

await check('[MC1] Вече дадено разрешение (бързо getUserMedia) -> веднага включен; ротация след това го запазва', async () => {
  const h = createHarness()
  await joinWithMic(h)
  assertClean(h, true, 'бързо')
  await rotate(h)
  assertClean(h, true, 'след ротация')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia')
})

await check('[MC2] Cold start (нова страница, lazy зареждане) + вече дадено разрешение -> микрофонът е включен', async () => {
  const h = createHarness({ facade: true })
  await joinWithMic(h)
  await flush(30)
  assertEqual(h.lazyLoads(), 1, 'едно lazy зареждане')
  assertClean(h, true, 'cold start')
  assertNoError(h, 'MC2')
})

await check('[MC3] Cold start + вече дадено разрешение + SDK reconnect отменя ПЪРВОТО публикуване („Cancelled publication“) -> публикуване след Reconnected, без „Микрофонът не е достъпен“', async () => {
  const h = createHarness({ facade: true })
  h.fake.state.publishSteps = ['sdk_reconnect_cancel']
  await joinWithMic(h)
  await flush(30)
  assertEqual(snap(h).status, 'reconnecting', '„Възстановяване…“')
  assertEqual(snap(h).microphone, 'requesting', 'намерението е запазено')
  assertEqual(h.fake.state.liveCaptures(), 1, 'capture-ът е задържан (не спрян)')
  h.fake.state.last().events.onReconnected()
  await flush(30)
  assertClean(h, true, 'след Reconnected')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без втори getUserMedia')
  assertNoError(h, 'MC3')
  const attempt = micAttempts(h).at(-1)
  assert(attempt !== undefined && attempt.result === 'recovered' && attempt.interruption === 'sdk_reconnect', `отчет: ${JSON.stringify(attempt)}`)
})

await check('[MC4] SDK reconnect отменя публикуването и после пада окончателно (connection_lost) -> публикуване в новата сесия', async () => {
  const h = createHarness()
  h.fake.state.publishSteps = ['sdk_reconnect_cancel']
  await joinWithMic(h)
  await loseConnection(h)
  assertClean(h, true, 'нова сесия')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia')
  assertNoError(h, 'MC4')
})

await check('[MC5] SDK reconnect отменя публикуването повече от 2 пъти -> „Микрофонът не беше включен. Моля, опитайте отново.“, capture-ът е спрян', async () => {
  const h = createHarness()
  h.fake.state.publishSteps = ['sdk_reconnect_cancel', 'sdk_reconnect_cancel', 'sdk_reconnect_cancel']
  await joinWithMic(h)
  for (let index = 0; index < 3; index += 1) {
    h.fake.state.last().events.onReconnected()
    await flush(30)
  }
  assertClean(h, false, 'MC5')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_not_enabled', 'съобщение')
  assertEqual(snap(h).uiError?.message ?? null, 'Микрофонът не беше включен.', 'текст')
  assertEqual(snap(h).uiError?.detail ?? null, 'Моля, опитайте отново.', 'подробност')
  assertEqual(micAttempts(h).at(-1)?.failure, 'publish_cancelled', 'причина в диагностиката')
  // „Опитай отново“ работи (нов изричен getUserMedia).
  h.voice.retryMicrophone()
  await flush(40)
  assertClean(h, true, 'след „Опитай отново“')
})

await check('[MC6] Неуспешно публикуване без reconnect (timeout) -> същото съобщение като преди („Микрофонът е недостъпен“), диагностика publish_timeout', async () => {
  const h = createHarness()
  h.fake.state.publishSteps = ['fail_timeout']
  await joinWithMic(h)
  assertClean(h, false, 'MC6')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_unavailable', 'съобщение')
  assertEqual(micAttempts(h).at(-1)?.failure, 'publish_timeout', 'диагностика')
})

await check('[MC7] Общ 20-секунден срок от придобиването: повторните прекъсвания на публикуването НЕ го рестартират -> след 20 s capture-ът е спрян + „Микрофонът не беше включен“', async () => {
  const h = createHarness()
  h.fake.state.publishSteps = ['sdk_reconnect_cancel', 'sdk_reconnect_cancel']
  await joinWithMic(h) // придобит в t=0; първото публикуване е отменено -> задържан
  assertEqual(snap(h).microphone, 'requesting', 'чака Reconnected')
  await h.clock.advance(12_000)
  h.fake.state.last().events.onReconnected() // второто публикуване също е отменено (t=12 s)
  await flush(30)
  assertEqual(h.fake.state.liveCaptures(), 1, 'задържан след второто прекъсване')
  await h.clock.advance(7_900) // t=19,9 s — още в срока
  assertEqual(h.fake.state.liveCaptures(), 1, 'преди 20 s capture-ът е задържан')
  assertEqual(snap(h).microphone, 'requesting', 'преди 20 s намерението е запазено')
  await h.clock.advance(200) // t=20,1 s — общият срок изтече (без рестарт от второто задържане)
  assertClean(h, false, 'след общия срок')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_not_enabled', 'съобщение')
  assertEqual(snap(h).wantsToSpeak, false, 'намерението е изчистено')
  assertEqual(micAttempts(h).at(-1)?.result, 'lost', 'окончателно изгубено')
  // Закъснял Reconnected след срока -> нищо не се публикува.
  h.fake.state.last().events.onReconnected()
  await flush(30)
  assertClean(h, false, 'закъснял Reconnected')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
})

await check('[MC8] Общият срок изтича докато публикуване е в ход (бавно свързване след загуба) -> публикуването не оставя микрофон, capture-ът е спрян', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  let openToken!: () => void
  h.backend.tokenGate = new Promise<void>((resolve) => { openToken = resolve })
  await loseConnection(h)
  await release() // придобит; няма стая
  await h.clock.advance(15_000)
  assertEqual(h.fake.state.liveCaptures(), 1, 'задържан в срока')
  h.backend.tokenGate = null
  openToken()
  await flush(40)
  assertClean(h, true, 'публикуван преди срока')
  await h.clock.advance(10_000)
  assertClean(h, true, 'успешното публикуване не се отменя от срока')
  assertNoError(h, 'MC8')
})

await check('[MC9] Потвърден отказ на правото при публикуване (403) -> съобщението за правата („vip_required“), не „Микрофонът не е достъпен“; capture-ът е спрян', async () => {
  const h = createHarness()
  h.fake.state.publishSteps = ['fail_not_permitted']
  await joinWithMic(h)
  assertClean(h, false, 'MC9')
  assertEqual(snap(h).uiError?.code ?? null, 'vip_required', 'съобщение')
  assertEqual(micAttempts(h).at(-1)?.failure, 'not_permitted', 'диагностика')
  assert(h.reports.some((r) => r.event === 'mic_failed' && r.reason === 'mic_not_permitted'), 'mic_failed: mic_not_permitted')
  assertEqual(snap(h).speak?.canSpeak ?? null, true, 'правата в контролера не са променени')
})

await check('[MC10] Класификация на грешките на LiveKit SDK: PublishTrackError 403 -> not_permitted; отменено / timeout / договаряне / без връзка / друго', () => {
  const lk = (name: string, message: string, status?: number): Error => Object.assign(new Error(message), { name }, status === undefined ? {} : { status })
  assertEqual(classifyPublishError(lk('PublishTrackError', 'failed to publish track, insufficient permissions', 403)), 'not_permitted', '403')
  assertEqual(classifyPublishError(lk('Error', 'Cancelled publication by calling unpublish')), 'cancelled', 'cancelled')
  assertEqual(classifyPublishError(lk('PublishTrackError', 'publishing rejected as engine not connected within timeout', 408)), 'timeout', '408')
  assertEqual(classifyPublishError(lk('ConnectionError', 'publication of local track timed out, no response from server')), 'timeout', 'no response')
  assertEqual(classifyPublishError(lk('NegotiationError', 'PC manager is closed')), 'negotiation', 'negotiation')
  assertEqual(classifyPublishError(lk('UnexpectedConnectionState', 'cannot publish track when not connected')), 'not_connected', 'not connected')
  assertEqual(classifyPublishError(lk('TypeError', 'boom')), 'other', 'other')
})

// ═══ Изчистване на намерението докато разрешението чака ══════════════════

await check('[MD1] Доброволен отказ (изключване) докато разрешението чака -> без грешка; закъснелият track се спира, не се публикува', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  h.voice.disableMicrophone()
  await flush(30)
  await release()
  assertClean(h, false, 'MD1')
  assertNoError(h, 'MD1')
  assertEqual(micAttempts(h).at(-1)?.result, 'cancelled', 'cancelled')
})

await check('[MD2] Напускане на гласа докато разрешението чака -> без грешка, track-ът се спира', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  h.voice.leaveVoice()
  await flush(30)
  await release()
  assertEqual(h.fake.state.liveCaptures(), 0, 'capture-и')
  assertEqual(h.fake.state.publishedMics(), 0, 'публикувани')
  assertNoError(h, 'MD2')
})

await check('[MD3] Административно заглушаване докато разрешението чака -> „mic_blocked“, track-ът се спира, не се публикува', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  h.backend.speak = MUTED
  h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
  await flush(30)
  await release()
  assertClean(h, false, 'MD3')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_blocked', 'съобщение')
})

await check('[MD4] Преминаване към лобито докато разрешението чака -> сесията спира, track-ът се спира; при връщане — без автоматичен микрофон', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  h.voice.setContext(h.ctx('off_table'))
  await flush(30)
  await release()
  assertEqual(h.fake.state.liveCaptures(), 0, 'capture-и')
  assertEqual(h.fake.state.publishedMics(), 0, 'публикувани')
  h.voice.setContext(h.ctx('waiting'))
  await flush(30)
  assertEqual(snap(h).microphone, 'off', 'без автоматичен микрофон')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
})

await check('[MD5] Смяна на масата докато разрешението чака -> не се пренася към другата маса', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  h.voice.setContext(h.ctx('waiting', SEATS, TABLE_B))
  await flush(30)
  await release()
  assertEqual(h.fake.state.liveCaptures(), 0, 'capture-и')
  assertEqual(h.fake.state.publishedMics(), 0, 'публикувани')
})

await check('[MD6] 20-секундният лимит: разрешението е дадено, но няма свързана стая > 20 s -> track-ът се спира + „Микрофонът не беше включен“', async () => {
  const h = createHarness()
  const release = holdPermission(h)
  await joinWithMic(h)
  let openToken!: () => void
  h.backend.tokenGate = new Promise<void>((resolve) => { openToken = resolve })
  await loseConnection(h)
  await release()
  assertEqual(h.fake.state.liveCaptures(), 1, 'capture-ът е задържан')
  await h.clock.advance(20_100)
  await flush(30)
  assertEqual(h.fake.state.liveCaptures(), 0, 'след 20 s capture-ът е спрян')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_not_enabled', 'съобщение')
  assertEqual(micAttempts(h).at(-1)?.result, 'lost', 'окончателно изгубено')
  h.backend.tokenGate = null
  openToken()
  await flush(40)
  await h.clock.advance(5_000)
  assertEqual(snap(h).microphone, 'off', 'без автоматичен микрофон след свързването')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
})

// ═══ Конкретните съобщения остават ══════════════════════════════════════

for (const [failure, code] of [['permission_denied', 'mic_permission_denied'], ['not_found', 'mic_not_found'], ['busy', 'mic_unavailable']] as const) {
  await check(`[ME-${failure}] Грешка на getUserMedia (${failure}) -> същото съобщение (${code}), слушането продължава`, async () => {
    const h = createHarness()
    h.fake.state.micBehavior = failure
    await joinWithMic(h)
    assertClean(h, false, failure)
    assertEqual(snap(h).uiError?.code ?? null, code, 'съобщение')
    assertEqual(snap(h).status, 'connected_listening', 'слушане')
  })
}

// ═══ Диагностиката минава сървърната валидация ═══════════════════════════

// ═══ Неуспешно публикуване, докато адаптерът чака reconnect на SDK-то ═════
// (реалният адаптер: до PUBLISH_SETTLE_MS след отхвърления publish; тук — publishGate)

function gatedPublish(h: Harness, step: 'gate_interrupt' | 'gate_fail'): () => Promise<void> {
  let open!: () => void
  h.fake.state.publishGate = new Promise<void>((resolve) => { open = resolve })
  h.fake.state.publishSteps = [step]
  return async () => {
    h.fake.state.publishGate = null
    open()
    await flush(40)
  }
}

const cancellations: Array<[string, (h: Harness) => void, string | null]> = [
  ['ръчно изключване', (h) => h.voice.disableMicrophone(), null],
  ['напускане на гласа', (h) => h.voice.leaveVoice(), null],
  ['административно заглушаване', (h) => {
    h.backend.speak = MUTED
    h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
  }, 'mic_blocked'],
  ['преминаване към лобито', (h) => h.voice.setContext(h.ctx('off_table')), null],
]
for (const [label, cancel, code] of cancellations) {
  for (const step of ['gate_interrupt', 'gate_fail'] as const) {
    await check(`[MG-${step}] ${label} докато публикуването чака reconnect -> capture-ът е спрян, без публикуване${code === null ? ' и без грешка' : ` („${code}“)`}`, async () => {
      const h = createHarness()
      const release = gatedPublish(h, step)
      await joinWithMic(h)
      assertEqual(snap(h).microphone, 'requesting', 'публикуването чака')
      cancel(h)
      await flush(30)
      await release()
      assertEqual(h.fake.state.liveCaptures(), 0, 'capture-и')
      assertEqual(h.fake.state.publishedMics(), 0, 'публикувани')
      assertEqual(snap(h).microphone, 'off', 'микрофон')
      assertEqual(snap(h).uiError?.code ?? null, code, 'съобщение')
      assert(!h.reports.some((r) => r.event === 'mic_failed'), 'без mic_failed')
      // Закъснял Reconnected -> нищо.
      h.fake.state.last().events.onReconnected()
      await flush(30)
      assertEqual(h.fake.state.publishedMics(), 0, 'след закъснял Reconnected')
      assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
    })
  }
}

await check('[MG1] Потвърден reconnect (signal resume) след неуспешно публикуване -> контролерът НЕ публикува до Reconnected (и при външен kick); после — същият capture, един публикуван микрофон', async () => {
  const h = createHarness()
  const release = gatedPublish(h, 'gate_interrupt')
  await joinWithMic(h)
  await release()
  assertEqual(snap(h).status, 'reconnecting', '„Възстановяване…“')
  assertEqual(snap(h).microphone, 'requesting', 'намерението е запазено')
  assertEqual(h.fake.state.liveCaptures(), 1, 'capture-ът е задържан')
  // Външни kick-ове по време на възстановяването (контекст, готовност на масата).
  h.voice.setContext(h.ctx('waiting', [...SEATS]))
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
  assertEqual(h.fake.state.last().publishes, 0, 'без публикуване по време на възстановяването')
  h.fake.state.last().events.onReconnected()
  await flush(30)
  assertClean(h, true, 'след Reconnected')
  assertEqual(h.fake.state.last().publishes, 1, 'едно публикуване')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без втори getUserMedia')
  const attempt = micAttempts(h).at(-1)
  assert(attempt?.result === 'recovered' && attempt.interruption === 'sdk_reconnect', `отчет: ${JSON.stringify(attempt)}`)
  assertNoError(h, 'MG1')
})

await check('[MG2] Неуспешно публикуване без потвърден reconnect -> както досега: „Микрофонът не е достъпен“, без автоматично повтаряне', async () => {
  const h = createHarness()
  const release = gatedPublish(h, 'gate_fail')
  await joinWithMic(h)
  await release()
  assertClean(h, false, 'MG2')
  assertEqual(snap(h).uiError?.code ?? null, 'mic_unavailable', 'съобщение')
  assertEqual(micAttempts(h).at(-1)?.failure, 'publish_failed', 'диагностика')
  await h.clock.advance(30_000)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
  assertEqual(h.fake.state.last().publishes, 0, 'без автоматично повтаряне')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
})

await check('[MF1] Всички mic_attempt / mic_lost / livekit_disconnect отчети минават строгата сървърна валидация; без токени/идентичност; броячите в таблицата', async () => {
  const all: VoiceDiagnosticReport[] = []
  for (const scenario of ['connection_lost', 'rotation', 'room_deleted'] as const) {
    const h = createHarness()
    const release = holdPermission(h)
    await joinWithMic(h)
    if (scenario === 'connection_lost') await loseConnection(h)
    if (scenario === 'rotation') await rotate(h)
    if (scenario === 'room_deleted') await deleteRoom(h)
    await release()
    all.push(...h.reports)
  }
  const cold = createHarness({ facade: true })
  cold.fake.state.publishSteps = ['sdk_reconnect_cancel']
  await joinWithMic(cold)
  cold.fake.state.last().events.onReconnected()
  await flush(30)
  all.push(...cold.reports)
  const diagnostics = createVoiceClientDiagnostics({ limitPerMinute: 1_000 })
  for (const report of all) {
    assert(parseVoiceClientReport(report) !== null, `отхвърлен отчет: ${JSON.stringify(report)}`)
    assertEqual(diagnostics.record('p1', report), 'ok', 'record')
  }
  const serialized = JSON.stringify(all)
  assert(!serialized.includes(JWT_MARK) && !serialized.includes('p_self_1') && !serialized.includes(TABLE), 'без токен/identity/маса')
  const mic = diagnostics.snapshot().mic
  assertEqual(mic.attempts.initial!.recovered, 4, 'възстановени (първоначално)')
  assertEqual(mic.interruptions.sdk_reconnect?.recovered ?? 0, 1, 'SDK reconnect -> възстановен')
  assertEqual(diagnostics.snapshot().liveKitDisconnects.room_deleted ?? 0, 1, 'LiveKit: room_deleted')
  assert(Object.keys(mic.failures).length === 0, 'възстановените не са грешки')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)

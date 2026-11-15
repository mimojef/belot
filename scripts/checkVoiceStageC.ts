/**
 * Етап В — опростен жизнен цикъл на гласа (целеви проверки).
 *
 * Истинският createVoiceController (и lazy facade-ът) срещу fake LiveKit
 * адаптер, ръчен часовник и fake backend. Проверява:
 *   SC1  един собственик: каскада от едновременни събития -> никога втора стая
 *   SC2  докато SDK-то възстановява (Reconnecting) — без наша операция
 *   SC3  ротация / изтрита стая / загубена мрежа -> намерението за говорене остава
 *   SC4  capture освободен (>20 s) -> нов само ако браузърът разрешава без прозорец
 *   SC5  презареждане в същия таб -> автоматично слушане + микрофон
 *   SC6  без автоматично възстановяване: нов таб, друга маса/профил, напускане, лоби
 *   SC7  доброволно изключен микрофон -> не се включва сам (ротация, загуба, презареждане)
 *   SC8  потвърдена загуба на права -> спиране и изчистено намерение, без нови заявки
 *   SC9  едновременни прекъсване + ротация -> едно свързване, един микрофон
 *   SC10 временно липсваща маса в контекста -> затворена връзка; връщане в срока -> възстановяване
 *   SC11 последователни временни откази на токена -> backoff по подсказката, после свързан
 *   SC12 административен mute по време на прекъсване -> без микрофон и без автоматично включване след края
 *
 * Пускане: npx tsx scripts/checkVoiceStageC.ts
 */

import {
  TABLE,
  TABLE_B,
  MUTED,
  SPEAK,
  createHarness,
  createMemoryIntent,
  flush,
  serverDisconnect,
  snap,
  type Harness,
} from './fixtures/voiceControllerFakeHarness'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  if (process.env.VOICE_ONLY !== undefined && !process.env.VOICE_ONLY.split(',').some((key) => label.includes(key))) return
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

const tokens = (h: Harness): number => h.events.filter((e) => e.startsWith('token@')).length
const tableUpdated = (generation: number, ready: boolean) => ({ type: 'voice_table_updated', voiceTableId: TABLE, generation, ready }) as never

async function speaking(h: Harness): Promise<void> {
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinWithMicrophone()
  await flush(30)
  assertEqual(snap(h).status, 'connected_speaking', 'начално: говори')
}

function invariants(h: Harness, label: string): void {
  assertEqual(h.fake.state.prepareRejected, 0, `${label}: никога втора LiveKit стая`)
  assert(h.fake.state.activeRooms() <= 1, `${label}: ≤1 активна стая`)
  assert(h.fake.state.publishedMics() <= 1, `${label}: ≤1 публикуван микрофон`)
  assert(h.fake.state.liveCaptures() <= 1, `${label}: ≤1 жив capture`)
}

await check('[SC1] Един собственик: ротация + загуба + ready + игрова връзка + „Опитай отново“ едновременно -> никога втора стая, един микрофон', async () => {
  const h = createHarness()
  await speaking(h)
  const first = h.fake.state.last()
  h.backend.generation = 2
  // Всичко в един tick — както при край на мача с лоша мрежа.
  h.voice.handleServerMessage(tableUpdated(2, false))
  serverDisconnect(first, 'room_deleted', true)
  h.voice.handleServerMessage(tableUpdated(2, true))
  h.voice.setGameConnection(false)
  h.voice.setGameConnection(true)
  h.voice.retryConnection()
  h.voice.setContext(h.ctx('game'))
  await flush(60)
  invariants(h, 'каскада')
  assertEqual(snap(h).status, 'connected_speaking', 'говори в новата генерация')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
  assertEqual(h.fake.state.rooms.length, 2, 'точно една нова стая')
  assertEqual(h.voice.debugCounters().rotations, 1, 'една ротация')
})

await check('[SC2] SDK reconnect: докато трае — без нов токен, без нова стая и без публикуване, независимо от събитията', async () => {
  const h = createHarness()
  await speaking(h)
  const room = h.fake.state.last()
  const before = tokens(h)
  room.events.onReconnecting()
  assertEqual(snap(h).status, 'reconnecting', 'reconnecting')
  h.voice.handleServerMessage(tableUpdated(1, true))
  h.voice.setGameConnection(false)
  h.voice.setGameConnection(true)
  h.voice.retryConnection()
  await h.clock.advance(30_000)
  assertEqual(tokens(h), before, 'без нов токен')
  assertEqual(h.fake.state.rooms.length, 1, 'без нова стая')
  room.events.onReconnected()
  await flush(20)
  assertEqual(snap(h).status, 'connected_speaking', 'същата връзка продължава')
  invariants(h, 'sdk')
})

await check('[SC3] Технически прекъсвания (ротация с провален unpublish, изтрита стая, загубена мрежа, отстраняване) -> намерението остава, същият capture', async () => {
  for (const cause of ['rotation', 'room_deleted', 'connection_lost', 'removed'] as const) {
    const h = createHarness()
    await speaking(h)
    const capture = h.fake.state.last().capture
    if (cause === 'rotation') {
      h.backend.generation = 2
      h.voice.handleServerMessage(tableUpdated(2, false))
      await flush(30)
      h.voice.handleServerMessage(tableUpdated(2, true))
    } else {
      if (cause === 'room_deleted') h.backend.generation = 2
      serverDisconnect(h.fake.state.last(), cause, true)
      await flush(10)
      assertEqual(snap(h).wantsToSpeak, true, `${cause}: намерението остава по време на прекъсването`)
    }
    await h.clock.advance(1_000)
    await flush(30)
    assertEqual(snap(h).status, 'connected_speaking', `${cause}: говори отново`)
    assert(h.fake.state.last().capture === capture, `${cause}: същият capture`)
    assertEqual(h.fake.state.getUserMediaCalls, 1, `${cause}: без нов getUserMedia`)
    assertEqual(snap(h).uiError, null, `${cause}: без грешка`)
    invariants(h, cause)
  }
})

await check('[SC4] Capture-ът не се задържа > 20 s: при по-дълго прекъсване се освобождава; при разрешение без прозорец — нов capture, иначе „Микрофонът не беше включен“', async () => {
  for (const granted of [true, false]) {
    const h = createHarness()
    h.fake.state.permissionGranted = granted
    await speaking(h)
    h.backend.tokenFailures = Array.from({ length: 4 }, () => ({ status: 503, code: 'voice_unavailable' }))
    serverDisconnect(h.fake.state.last(), 'connection_lost', true)
    await h.clock.advance(20_000)
    assertEqual(h.fake.state.liveCaptures(), 0, `${granted}: capture освободен след 20 s`)
    assertEqual(snap(h).wantsToSpeak, true, `${granted}: намерението остава`)
    await h.clock.advance(60_000)
    await flush(30)
    if (granted) {
      assertEqual(snap(h).status, 'connected_speaking', 'разрешено -> говори (нов capture без прозорец)')
      assertEqual(h.fake.state.getUserMediaCalls, 2, 'един нов capture')
    } else {
      assertEqual(snap(h).status, 'connected_listening', 'без разрешение -> слуша')
      assertEqual(snap(h).uiError?.code, 'mic_not_enabled', '„Микрофонът не беше включен“')
      assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов capture (без прозорец без жест)')
    }
    invariants(h, String(granted))
  }
})

await check('[SC5] Презареждане в същия таб: автоматично слушане + микрофон (разрешен без прозорец); без говорене, ако разрешението липсва', async () => {
  for (const granted of [true, false]) {
    const memory = createMemoryIntent()
    const before = createHarness({ facade: true, intent: memory })
    await speaking(before)
    assert(memory.value !== null && memory.value.mic, 'намерението е записано (с микрофон)')
    before.voice.onPageHide()
    await flush(20)
    assert(memory.value !== null, 'pagehide не изчиства намерението')
    assert(before.presence.some((p) => !p.onTableScreen && p.reason === 'page_hide'), 'сървърът знае за pagehide')
    // Нова страница в същия таб.
    memory.reload = true
    const after = createHarness({ facade: true, intent: memory })
    after.fake.state.permissionGranted = granted
    after.voice.setContext(after.ctx('waiting'))
    await flush(60)
    assertEqual(after.lazyLoads(), 1, `${granted}: зареден автоматично`)
    assertEqual(after.events.filter((e) => e.startsWith('presence:on'))[0] !== undefined, true, `${granted}: присъствие преди токена`)
    if (granted) {
      assertEqual(snap(after).status, 'connected_speaking', 'говори след презареждането')
      assertEqual(after.fake.state.getUserMediaCalls, 1, 'един capture')
    } else {
      assertEqual(snap(after).status, 'connected_listening', 'слуша след презареждането')
      assertEqual(snap(after).uiError?.code, 'mic_not_enabled', 'молба за изрично включване')
      assertEqual(after.fake.state.getUserMediaCalls, 0, 'без getUserMedia без жест')
      assertEqual(memory.value?.mic, false, 'намерението за микрофон е изчистено')
    }
    // Еднократно: повторен snapshot не стартира ново възстановяване.
    after.voice.setContext(after.ctx('game'))
    await flush(30)
    assertEqual(after.fake.state.rooms.length, 1, 'една стая')
  }
})

await check('[SC6] Без автоматично възстановяване: нов таб (не reload), друга маса, друг профил, след „Напусни гласа“, „Изчакай в лоби“, изместена сесия', async () => {
  const cases: Array<{ name: string; prepare: (h: Harness) => Promise<void> | void; reload: boolean; ctx: (h: Harness) => ReturnType<Harness['ctx']> }> = [
    { name: 'нов таб', prepare: (h) => h.voice.onPageHide(), reload: false, ctx: (h) => h.ctx('waiting') },
    { name: 'друга маса', prepare: (h) => h.voice.onPageHide(), reload: true, ctx: (h) => h.ctx('waiting', undefined, TABLE_B) },
    { name: 'друг профил', prepare: (h) => h.voice.onPageHide(), reload: true, ctx: (h) => ({ ...h.ctx('waiting'), selfProfileId: 'alice' }) },
    { name: 'напуснат глас', prepare: (h) => { h.voice.leaveVoice(); h.voice.onPageHide() }, reload: true, ctx: (h) => h.ctx('waiting') },
    { name: 'лоби', prepare: (h) => { h.voice.setContext(h.ctx('off_table')); h.voice.onPageHide() }, reload: true, ctx: (h) => h.ctx('waiting') },
    { name: 'изместена сесия', prepare: (h) => { h.voice.endSession('displaced') }, reload: true, ctx: (h) => h.ctx('waiting') },
    { name: 'session_replaced', prepare: (h) => { h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: 'session_replaced' } as never) }, reload: true, ctx: (h) => h.ctx('waiting') },
  ]
  for (const entry of cases) {
    const memory = createMemoryIntent()
    const before = createHarness({ facade: true, intent: memory })
    await speaking(before)
    await entry.prepare(before)
    await flush(20)
    memory.reload = entry.reload
    const after = createHarness({ facade: true, intent: memory })
    after.fake.state.permissionGranted = true
    after.voice.setContext(entry.ctx(after))
    await flush(60)
    assertEqual(after.lazyLoads(), 0, `${entry.name}: не се зарежда`)
    assertEqual(after.presence.length, 0, `${entry.name}: без presence`)
    assertEqual(after.fake.state.getUserMediaCalls, 0, `${entry.name}: без микрофон`)
  }
})

await check('[SC7] Доброволно изключен микрофон: не се включва сам — нито след ротация, загуба на връзката, нито след презареждане', async () => {
  const memory = createMemoryIntent()
  const h = createHarness({ facade: true, intent: memory })
  h.fake.state.permissionGranted = true
  await speaking(h)
  h.voice.disableMicrophone()
  await flush(20)
  assertEqual(snap(h).microphone, 'off', 'изключен')
  assertEqual(memory.value?.mic, false, 'записано: без микрофон')
  h.backend.generation = 2
  h.voice.handleServerMessage(tableUpdated(2, false))
  await flush(20)
  h.voice.handleServerMessage(tableUpdated(2, true))
  await flush(30)
  serverDisconnect(h.fake.state.last(), 'connection_lost', true)
  await h.clock.advance(2_000)
  await flush(30)
  assertEqual(snap(h).status, 'connected_listening', 'слуша')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов capture')
  h.voice.onPageHide()
  memory.reload = true
  const after = createHarness({ facade: true, intent: memory })
  after.fake.state.permissionGranted = true
  after.voice.setContext(after.ctx('waiting'))
  await flush(60)
  assertEqual(snap(after).status, 'connected_listening', 'след презареждане — само слуша')
  assertEqual(after.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
})

await check('[SC8] Потвърдена загуба на права (permanently_left / table_released / not_a_player) -> спиране, изчистено намерение, без нови заявки', async () => {
  for (const code of ['permanently_left', 'table_released', 'not_a_player']) {
    const memory = createMemoryIntent()
    const h = createHarness({ intent: memory })
    await speaking(h)
    h.backend.tokenFailures = [{ status: 403, code }]
    h.backend.generation = 2
    h.voice.handleServerMessage(tableUpdated(2, false))
    await flush(30)
    await h.clock.advance(600_000)
    assertEqual(snap(h).status, 'disabled', `${code}: изключен`)
    assertEqual(memory.value, null, `${code}: намерението е изчистено`)
    assertEqual(tokens(h), 2, `${code}: без повторни заявки`)
    assertEqual(h.fake.state.liveCaptures(), 0, `${code}: микрофонът е спрян`)
    assertEqual(h.fake.state.activeRooms(), 0, `${code}: без стая`)
  }
})

await check('[SC9] Едновременни прекъсване и ротация (connection_lost, после ready:false и ready:true) -> едно ново свързване, един микрофон', async () => {
  const h = createHarness()
  await speaking(h)
  const capture = h.fake.state.last().capture
  h.backend.generation = 2
  serverDisconnect(h.fake.state.last(), 'connection_lost', true)
  h.voice.handleServerMessage(tableUpdated(2, false))
  h.voice.handleServerMessage(tableUpdated(2, true))
  await flush(60)
  await h.clock.advance(1_000)
  await flush(30)
  assertEqual(snap(h).status, 'connected_speaking', 'говори')
  assertEqual(h.fake.state.rooms.length, 2, 'една нова стая')
  assert(h.fake.state.last().capture === capture, 'същият capture')
  assertEqual(tokens(h), 2, 'един нов токен')
  invariants(h, 'race')
})

await check('[SC10] Масата временно липсва в контекста -> връзката се затваря веднага; връщане до 10 s -> възстановяване; след срока -> нищо', async () => {
  for (const delayMs of [3_000, 12_000]) {
    const memory = createMemoryIntent()
    const h = createHarness({ intent: memory })
    h.fake.state.permissionGranted = true
    await speaking(h)
    h.voice.setContext({ kind: 'none' })
    await flush(20)
    assertEqual(h.fake.state.activeRooms(), 0, `${delayMs}: веднага без звук извън масата`)
    assert(h.presence.some((p) => !p.onTableScreen && p.reason === 'context_changed'), `${delayMs}: сървърът е уведомен`)
    await h.clock.advance(delayMs)
    h.voice.setContext(h.ctx('game'))
    await flush(60)
    if (delayMs < 10_000) {
      assertEqual(snap(h).status, 'connected_speaking', 'същата маса в срока -> говори отново')
    } else {
      assertEqual(snap(h).status, 'idle', 'след срока -> без автоматично връщане')
      assertEqual(memory.value, null, 'намерението е изчистено')
    }
    invariants(h, String(delayMs))
  }
})

await check('[SC11] Последователни временни откази на токена (503 voice_rotation_pending) -> паузи 1/2/4/8 s, после свързан; без „недостъпен“', async () => {
  const h = createHarness()
  await speaking(h)
  h.backend.generation = 2
  h.backend.tokenFailures = Array.from({ length: 4 }, () => ({ status: 503, code: 'voice_rotation_pending' }))
  h.voice.handleServerMessage(tableUpdated(2, false))
  await flush(30)
  for (let index = 0; index < 8; index += 1) await h.clock.advance(2_000)
  await flush(30)
  assertEqual(snap(h).status, 'connected_speaking', 'свързан и говори')
  assertEqual(tokens(h), 1 + 5, '4 отказа + 1 успех')
  const presenceOn = h.events.filter((e) => e.startsWith('presence:on')).length
  assert(presenceOn >= 6, 'присъствие преди всеки токен')
  invariants(h, 'tokens')
})

await check('[SC12] Административен mute по време на прекъсване -> без микрофон в новата стая; след края на mute — без автоматично включване', async () => {
  const h = createHarness()
  h.fake.state.permissionGranted = true
  await speaking(h)
  h.backend.speak = MUTED
  serverDisconnect(h.fake.state.last(), 'connection_lost', true)
  h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
  await h.clock.advance(1_000)
  await flush(30)
  assertEqual(snap(h).status, 'connected_muted', 'заглушен')
  assertEqual(h.fake.state.publishedMics(), 0, 'без публикуван микрофон')
  assertEqual(h.fake.state.liveCaptures(), 0, 'capture-ът е спрян')
  h.backend.speak = SPEAK
  h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: SPEAK } as never)
  await flush(30)
  assertEqual(snap(h).microphone, 'off', 'без автоматично включване след края на mute')
})

await check('[SC13] LiveKit затваря стаята при напускане на страницата (disconnectOnPageLeave, cause=client): намерението остава, без незабавен нов опит; ако страницата остане — нов опит след паузата', async () => {
  const memory = createMemoryIntent()
  const h = createHarness({ intent: memory })
  await speaking(h)
  const before = tokens(h)
  serverDisconnect(h.fake.state.last(), 'client')
  await flush(30)
  assertEqual(tokens(h), before, 'без незабавен токен (страницата се затваря)')
  assertEqual(memory.value?.mic, true, 'намерението за говорене остава записано')
  // Реалната страница изпраща pagehide -> край на сесията, намерението остава за презареждането.
  h.voice.onPageHide()
  await h.clock.advance(5_000)
  assertEqual(tokens(h), before, 'без опити след pagehide')
  assertEqual(memory.value?.mic, true, 'pagehide не изчиства намерението')
  // Отменено напускане (без pagehide): нов опит след 1 s.
  const h2 = createHarness({ intent: createMemoryIntent() })
  h2.fake.state.permissionGranted = true
  await speaking(h2)
  serverDisconnect(h2.fake.state.last(), 'client')
  await h2.clock.advance(1_000)
  await flush(30)
  assertEqual(snap(h2).status, 'connected_speaking', 'страницата остана -> отново говори')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1

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

import { createVoiceController, type VoiceContext, type VoiceController, type VoiceSnapshot } from '../src/app/voice/createVoiceController'
import {
  VoiceMicrophoneError,
  type VoiceAdapter,
  type VoiceAdapterEvents,
  type VoiceConnectedRoom,
  type VoiceDiagnosticReport,
  type VoiceDisconnectCause,
  type VoiceMicrophoneFailure,
  type VoicePublishErrorKind,
  type VoiceRetainedMicrophone,
} from '../src/app/voice/voiceAdapter'
import { createLazyVoiceController } from '../src/app/voice/voiceFacade'
import { classifyPublishError } from '../src/app/voice/voicePublishErrors'
import type { VoicePresenceClientMessage, VoiceSpeakState } from '../src/app/voice/voiceProtocol'
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
const flush = async (rounds = 12): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

// ─── Ръчен часовник ───────────────────────────────────────────────────────
function createClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { due: number; cb: () => void }>()
  return {
    now: () => now,
    timers: {
      setTimeout: (cb: () => void, ms: number): unknown => {
        seq += 1
        timers.set(seq, { due: now + Math.max(0, ms), cb })
        return seq
      },
      clearTimeout: (handle: unknown): void => { timers.delete(handle as number) },
    },
    async advance(ms: number): Promise<void> {
      const target = now + ms
      for (;;) {
        let nextId: number | null = null
        let nextDue = Infinity
        for (const [id, timer] of timers) if (timer.due <= target && timer.due < nextDue) { nextDue = timer.due; nextId = id }
        if (nextId === null) break
        const timer = timers.get(nextId)!
        timers.delete(nextId)
        now = Math.max(now, timer.due)
        timer.cb()
        await flush(4)
      }
      now = target
      await flush()
    },
  }
}

// ─── Fake LiveKit адаптер с отделно придобиване ───────────────────────────
type FakeCapture = { id: number; stopped: boolean; ended: boolean }
type PublishStep = 'ok' | 'sdk_reconnect_cancel' | 'fail_timeout' | 'fail_not_permitted'

type FakeRoom = VoiceConnectedRoom & {
  events: VoiceAdapterEvents
  connected: boolean
  disconnected: boolean
  micLive: boolean
  capture: FakeCapture | null
  publishes: number
}

function createFakeAdapter() {
  const rooms: FakeRoom[] = []
  const captures: FakeCapture[] = []
  const retained = new Map<VoiceRetainedMicrophone, FakeCapture>()
  const state = {
    rooms,
    captures,
    getUserMediaCalls: 0,
    /** Разрешението „чака“, докато gate-ът не се освободи. */
    micGate: null as Promise<void> | null,
    micBehavior: 'ok' as 'ok' | VoiceMicrophoneFailure,
    /** Сценарий за следващите публикувания (по ред); празно -> 'ok'. */
    publishSteps: [] as PublishStep[],
    connectGate: null as Promise<void> | null,
    activeRooms: () => rooms.filter((r) => r.connected && !r.disconnected).length,
    liveCaptures: () => captures.filter((c) => !c.stopped).length,
    /** Публикувани микрофони във всички неизключени стаи (дублирани audio tracks). */
    publishedMics: () => rooms.filter((r) => !r.disconnected && r.micLive).length,
    last: () => rooms[rooms.length - 1]!,
  }
  const stop = (capture: FakeCapture | null): void => { if (capture !== null) capture.stopped = true }
  function retainHandle(capture: FakeCapture): VoiceRetainedMicrophone {
    const handle: VoiceRetainedMicrophone = {
      isLive: () => retained.has(handle) && !capture.stopped && !capture.ended,
      release: () => { if (retained.delete(handle)) capture.stopped = true },
    }
    retained.set(handle, capture)
    return handle
  }
  const adapter: VoiceAdapter = {
    async acquireMicrophone() {
      state.getUserMediaCalls += 1
      const capture: FakeCapture = { id: captures.length + 1, stopped: false, ended: false }
      captures.push(capture)
      if (state.micGate !== null) await state.micGate
      if (state.micBehavior !== 'ok') {
        stop(capture)
        throw new VoiceMicrophoneError(state.micBehavior)
      }
      return retainHandle(capture)
    },
    prepare(events) {
      if (rooms.some((r) => !r.disconnected)) throw new Error('voice_room_already_active')
      const room: FakeRoom = {
        events,
        connected: false,
        disconnected: false,
        micLive: false,
        capture: null,
        publishes: 0,
        async disconnect() {
          if (room.disconnected) return
          await Promise.resolve()
          room.disconnected = true
          room.micLive = false
          stop(room.capture)
          room.capture = null
        },
        async detachMicrophoneForReuse() {
          const capture = room.capture
          if (!room.micLive || capture === null || capture.stopped) {
            await room.disableMicrophone()
            return null
          }
          room.capture = null
          room.micLive = false
          return retainHandle(capture)
        },
        async enableMicrophone(reuse) {
          if (reuse === undefined) throw new Error('стар път: enableMicrophone() без reuse не трябва да се вика')
          const capture = retained.get(reuse)
          if (capture === undefined || capture.stopped || capture.ended) {
            reuse.release()
            throw new VoiceMicrophoneError('unavailable')
          }
          retained.delete(reuse)
          await Promise.resolve()
          const step = state.publishSteps.shift() ?? 'ok'
          if (step === 'sdk_reconnect_cancel') {
            // Като LiveKit 2.x: пълният reconnect (Reconnecting) отменя
            // незавършеното addTrack -> адаптерът връща живия capture.
            room.events.onReconnecting()
            const publishError: VoicePublishErrorKind = 'cancelled'
            throw new VoiceMicrophoneError('interrupted', { retained: retainHandle(capture), publishError })
          }
          if (step === 'fail_not_permitted') {
            // Като реалния адаптер при PublishTrackError 403 („insufficient permissions“).
            stop(capture)
            throw new VoiceMicrophoneError('not_permitted', { publishError: 'not_permitted' })
          }
          if (step === 'fail_timeout') {
            stop(capture)
            throw new VoiceMicrophoneError('unavailable', { publishError: 'timeout' })
          }
          if (room.disconnected) {
            stop(capture)
            throw new VoiceMicrophoneError('unavailable')
          }
          room.publishes += 1
          room.capture = capture
          room.micLive = true
        },
        async disableMicrophone() {
          room.micLive = false
          stop(room.capture)
          room.capture = null
        },
        isMicrophoneLive: () => room.micLive,
        async startAudio() {},
        canPlaybackAudio: () => true,
        listRemoteParticipants: () => [],
        setRemoteIdentityVolume() {},
      }
      rooms.push(room)
      return {
        async connect() {
          if (state.connectGate !== null) await state.connectGate
          room.connected = true
          return room
        },
        async abort() { await room.disconnect() },
      }
    },
  }
  return { adapter, state }
}

/** LiveKit прекъсва стаята сам (като реалния адаптер). */
function serverDisconnect(room: FakeRoom, cause: VoiceDisconnectCause): void {
  room.disconnected = true
  const capture = room.capture
  const wasLive = room.micLive
  room.micLive = false
  room.capture = null
  if (capture !== null && !(cause === 'room_deleted' && wasLive)) capture.stopped = true
  room.events.onDisconnected(cause, null, cause === 'room_deleted' ? 'room_deleted' : 'network')
}

// ─── Fake backend ─────────────────────────────────────────────────────────
const TABLE = '11111111-2222-4333-8444-555555555555'
const TABLE_B = '99999999-2222-4333-8444-555555555555'
const JWT_MARK = 'eyJFAKE.secret-token-value.sig'
const SPEAK: VoiceSpeakState = { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: true, mutedUntil: null }
const MUTED: VoiceSpeakState = { canSpeak: false, blockedReason: 'muted', hasSpeakingEntitlement: true, mutedUntil: '2027-01-01T00:00:00.000Z' }
const SEATS = [
  { profileId: 'self', isBot: false },
  { profileId: 'alice', isBot: false },
  { profileId: 'bob', isBot: false },
  { profileId: null, isBot: true },
]
/** Поканен играч — седнал на друго място на чужда маса. */
const INVITED_SEATS = [
  { profileId: 'host', isBot: false },
  { profileId: 'self', isBot: false },
  { profileId: null, isBot: true },
  { profileId: null, isBot: true },
]

type Harness = {
  voice: VoiceController
  clock: ReturnType<typeof createClock>
  fake: ReturnType<typeof createFakeAdapter>
  backend: { speak: VoiceSpeakState; generation: number; tokenGate: Promise<void> | null }
  reports: VoiceDiagnosticReport[]
  trace: string[]
  ctx: (screen?: 'waiting' | 'game' | 'off_table', seats?: typeof SEATS, tableId?: string) => VoiceContext
  lazyLoads: () => number
}

function createHarness(options: { facade?: boolean } = {}): Harness {
  const clock = createClock()
  const fake = createFakeAdapter()
  const reports: VoiceDiagnosticReport[] = []
  const trace: string[] = []
  const backend: Harness['backend'] = { speak: SPEAK, generation: 1, tokenGate: null }
  let lazyLoads = 0
  let voice!: VoiceController
  const sendPresence = (message: VoicePresenceClientMessage): boolean => {
    queueMicrotask(() => {
      voice.handleServerMessage({ type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: true, onTableScreen: message.onTableScreen, leaseTtlMs: 60_000, renewAfterMs: 20_000, ready: true, speak: backend.speak } as never)
    })
    return true
  }
  const controllerDeps = (send: typeof sendPresence) => ({
    loadAdapter: async () => fake.adapter,
    sendPresence: send,
    postJson: async (path: string, body: unknown) => {
      void body
      if (path === '/api/voice/token') {
        if (backend.tokenGate !== null) await backend.tokenGate
        const table = (body as { voiceTableId?: string }).voiceTableId ?? TABLE
        return { status: 200, body: { ok: true, url: 'wss://voice.test', token: JWT_MARK, identity: 'p_self_1', voiceTableId: table, generation: backend.generation, canSpeak: backend.speak.canSpeak, speak: backend.speak, expiresInSeconds: 600 } }
      }
      return backend.speak.canSpeak
        ? { status: 200, body: { ok: true, canSpeak: true, upgrade: 'updated' } }
        : { status: 200, body: { ok: true, canSpeak: false, code: backend.speak.blockedReason, speak: backend.speak } }
    },
    createClientInstanceId: () => 'inst_test_0000000000000001',
    timers: clock.timers,
    now: clock.now,
    log: () => {},
    reportDiagnostic: (report: VoiceDiagnosticReport) => { reports.push(report) },
  })
  if (options.facade) {
    // Cold start: нова страница — controller-ът и адаптерът се зареждат lazy.
    voice = createLazyVoiceController({
      sendPresence,
      apiBaseUrl: () => 'https://api.test',
      loadController: async () => {
        lazyLoads += 1
        await flush(2)
        return (runtimeDeps) => createVoiceController(controllerDeps(runtimeDeps.sendPresence))
      },
    })
  } else {
    voice = createVoiceController(controllerDeps(sendPresence))
  }
  let last = ''
  voice.subscribe((snap) => {
    const key = `${snap.status}/${snap.microphone}`
    if (key !== last) { trace.push(key); last = key }
  })
  const ctx: Harness['ctx'] = (screen = 'waiting', seats = SEATS, tableId = TABLE) => ({ kind: 'table', voiceTableId: tableId, screen, selfProfileId: 'self', seats })
  return { voice, clock, fake, backend, reports, trace, ctx, lazyLoads: () => lazyLoads }
}

const snap = (h: Harness): VoiceSnapshot => h.voice.getSnapshot()

/** Отваря „прозореца за разрешение“: getUserMedia виси до release(). */
function holdPermission(h: Harness): () => Promise<void> {
  let release!: () => void
  h.fake.state.micGate = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    h.fake.state.micGate = null
    release()
    await flush(30)
  }
}

async function joinWithMic(h: Harness, ctx = h.ctx('waiting')): Promise<void> {
  h.voice.setContext(ctx)
  await flush()
  h.voice.joinWithMicrophone()
  await flush(30)
}

async function rotate(h: Harness): Promise<void> {
  h.backend.generation += 1
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: false } as never)
  await flush(30)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
}

async function loseConnection(h: Harness): Promise<void> {
  serverDisconnect(h.fake.state.last(), 'connection_lost')
  await flush()
  await h.clock.advance(2_000)
  await flush(30)
}

async function deleteRoom(h: Harness): Promise<void> {
  h.backend.generation += 1
  serverDisconnect(h.fake.state.last(), 'room_deleted')
  await flush(30)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
}

const micAttempts = (h: Harness) => h.reports.filter((r): r is Extract<VoiceDiagnosticReport, { event: 'mic_attempt' }> => r.event === 'mic_attempt')

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

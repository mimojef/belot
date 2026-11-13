/**
 * checkVoiceController.ts
 *
 * Гласов чат, Етап 3 — frontend voice controller срещу FAKE LiveKit адаптер,
 * fake HTTPS (token/speak-access), fake voice_presence и ръчен часовник.
 * Без браузър, без livekit-client, без мрежа. Mock тестовете НЕ доказват,
 * че Safari/Chrome/PWA работят реално — виж плана за реални browser тестове
 * в docs/voice-chat/HANDOFF.md.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceController.ts
 */

import { readFile } from 'node:fs/promises'
import { createVoiceController, VOICE_UI_MESSAGES, type VoiceContext, type VoiceController, type VoiceSnapshot } from '../src/app/voice/createVoiceController'
import { VoiceMicrophoneError, type VoiceAdapter, type VoiceAdapterEvents, type VoiceConnectedRoom, type VoiceDisconnectCause, type VoiceMicrophoneFailure, type VoiceRetainedMicrophone } from '../src/app/voice/voiceAdapter'
import { createLazyVoiceController } from '../src/app/voice/voiceFacade'
import { createVoiceAudioSink } from '../src/app/voice/voiceAudioSink'
import type { VoicePresenceClientMessage, VoiceSpeakState } from '../src/app/voice/voiceProtocol'

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
    pending: () => timers.size,
  }
}

// ─── Fake LiveKit ─────────────────────────────────────────────────────────
/** Един getUserMedia capture (за проверка, че никой не остава активен). */
type FakeCapture = { id: number; stopped: boolean; ended: boolean }

type FakeRoom = VoiceConnectedRoom & {
  events: VoiceAdapterEvents
  connected: boolean
  disconnected: boolean
  /** Микрофонът е публикуван. */
  micLive: boolean
  capture: FakeCapture | null
  readonly captureReleased: boolean
  remotes: Map<string, { mic: boolean; volume: number }>
  playback: boolean
  startAudioCalls: number
  isMuted: (identity: string) => boolean
  /** Като адаптера: предаване на жив capture (ROOM_DELETED). */
  retain: (capture: FakeCapture) => VoiceRetainedMicrophone
}

function createFakeAdapter() {
  const rooms: FakeRoom[] = []
  const captures: FakeCapture[] = []
  const retained = new Map<VoiceRetainedMicrophone, FakeCapture>()
  const state = {
    rooms,
    captures,
    loads: 0,
    getUserMediaCalls: 0,
    reusedPublishes: 0,
    detaches: 0,
    /** Опит за втора стая, докато предишната не е изключена (нарушен инвариант). */
    violations: 0,
    micBehavior: 'ok' as 'ok' | VoiceMicrophoneFailure,
    micGate: null as Promise<void> | null,
    connectGate: null as Promise<void> | null,
    detachGate: null as Promise<void> | null,
    disconnectGate: null as Promise<void> | null,
    connectFails: false,
    initialPlayback: true,
    activeRooms: () => rooms.filter((r) => r.connected && !r.disconnected).length,
    liveCaptures: () => captures.filter((c) => !c.stopped).length,
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
    prepare(events, isMuted) {
      if (rooms.some((r) => !r.disconnected)) {
        state.violations += 1
        throw new Error('voice_room_already_active')
      }
      const room: FakeRoom = {
        events,
        connected: false,
        disconnected: false,
        micLive: false,
        capture: null,
        get captureReleased() { return room.capture === null || room.capture.stopped },
        remotes: new Map(),
        playback: state.initialPlayback,
        startAudioCalls: 1,
        isMuted,
        async disconnect() {
          if (room.disconnected) return
          await Promise.resolve() // реалният disconnect е асинхронен
          if (state.disconnectGate !== null) await state.disconnectGate
          room.disconnected = true
          room.micLive = false
          stop(room.capture)
          room.capture = null
        },
        async detachMicrophoneForReuse() {
          state.detaches += 1
          if (state.detachGate !== null) await state.detachGate
          const capture = room.capture
          if (!room.micLive || capture === null || capture.stopped || capture.ended) {
            await room.disableMicrophone()
            return null
          }
          room.capture = null
          room.micLive = false
          return retainHandle(capture)
        },
        retain: (capture) => retainHandle(capture),
        async enableMicrophone(reuse) {
          if (reuse !== undefined) {
            const capture = retained.get(reuse)
            if (capture === undefined || capture.stopped || capture.ended) {
              reuse.release()
              throw new VoiceMicrophoneError('unavailable')
            }
            retained.delete(reuse)
            state.reusedPublishes += 1
            room.capture = capture
            room.micLive = true
            return
          }
          state.getUserMediaCalls += 1
          const capture: FakeCapture = { id: captures.length + 1, stopped: false, ended: false }
          captures.push(capture)
          room.capture = capture
          if (state.micGate !== null) await state.micGate
          if (state.micBehavior !== 'ok') {
            stop(capture)
            if (room.capture === capture) room.capture = null
            throw new VoiceMicrophoneError(state.micBehavior)
          }
          room.micLive = true
        },
        async disableMicrophone() {
          room.micLive = false
          stop(room.capture)
          room.capture = null
        },
        isMicrophoneLive: () => room.micLive,
        async startAudio() {
          room.startAudioCalls += 1
          room.playback = true
        },
        canPlaybackAudio: () => room.playback,
        listRemoteParticipants: () => [...room.remotes.entries()].map(([identity, r]) => ({ identity, microphonePublished: r.mic })),
        setRemoteIdentityVolume(identity, volume) {
          const remote = room.remotes.get(identity)
          if (remote !== undefined) remote.volume = volume
        },
      }
      rooms.push(room)
      return {
        async connect() {
          if (state.connectGate !== null) await state.connectGate
          if (state.connectFails) throw new Error('connect failed')
          room.connected = true
          return room
        },
        async abort() { await room.disconnect() },
      }
    },
  }
  return { adapter, state }
}

/** Отдалечен участник (вкл. проверка за локално заглушаване при абониране). */
function addRemote(room: FakeRoom, identity: string, mic = true): void {
  room.remotes.set(identity, { mic, volume: room.isMuted(identity) ? 0 : 1 })
  room.events.onParticipantsChanged()
}

/**
 * LiveKit сам прекъсва стаята — като реалния адаптер (stopLocalTrackOnUnpublish:false):
 * ROOM_DELETED + жив публикуван capture -> capture-ът се предава; иначе се спира.
 */
function serverDisconnect(room: FakeRoom, cause: VoiceDisconnectCause): void {
  room.disconnected = true
  const capture = room.capture
  const wasLive = room.micLive
  room.micLive = false
  room.capture = null
  const live = capture !== null && !capture.stopped && !capture.ended
  const held = cause === 'room_deleted' && wasLive && live ? room.retain(capture) : null
  if (held === null && capture !== null) capture.stopped = true
  room.events.onDisconnected(cause, held)
}

// ─── Fake backend ─────────────────────────────────────────────────────────
const TABLE = '11111111-2222-4333-8444-555555555555'
const TABLE_B = '99999999-2222-4333-8444-555555555555'
const JWT_MARK = 'eyJFAKE.secret-token-value.sig'
const SPEAK: VoiceSpeakState = { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: true, mutedUntil: null }
const LISTEN: VoiceSpeakState = { canSpeak: false, blockedReason: 'vip_required', hasSpeakingEntitlement: false, mutedUntil: null }
const MUTED: VoiceSpeakState = { canSpeak: false, blockedReason: 'muted', hasSpeakingEntitlement: true, mutedUntil: '2027-01-01T00:00:00.000Z' }

type Harness = {
  voice: VoiceController
  clock: ReturnType<typeof createClock>
  fake: ReturnType<typeof createFakeAdapter>
  presence: VoicePresenceClientMessage[]
  posts: Array<{ path: string; body: unknown }>
  backend: {
    speak: VoiceSpeakState
    generation: number
    autoAck: boolean
    presenceCode: string | null
    tokenQueue: Array<{ status: number; body: unknown }>
    tokenGate: Promise<void> | null
    speakAccess: { status: number; body: unknown } | null
    wsOpen: boolean
  }
  /** Само при facade: true. */
  lazy: { loads: number; gate: Promise<void> | null; failNext: boolean; factories: number }
  logs: string[]
  snaps: VoiceSnapshot[]
  ctx: (screen?: 'waiting' | 'game' | 'off_table', seats?: Array<{ profileId: string | null; isBot: boolean }>, tableId?: string) => VoiceContext
  connect: (withMic?: boolean) => Promise<void>
}

const SEATS = [
  { profileId: 'self', isBot: false },
  { profileId: 'alice', isBot: false },
  { profileId: 'bob', isBot: false },
  { profileId: null, isBot: true },
]

/**
 * facade: true — production пътят: createLazyVoiceController (основен bundle)
 * + „lazy“ factory, която създава истинския createVoiceController с fake адаптер.
 */
function createHarness(options: { loadFails?: boolean; facade?: boolean } = {}): Harness {
  const clock = createClock()
  const fake = createFakeAdapter()
  const presence: VoicePresenceClientMessage[] = []
  const posts: Array<{ path: string; body: unknown }> = []
  const logs: string[] = []
  const snaps: VoiceSnapshot[] = []
  const backend: Harness['backend'] = {
    speak: SPEAK, generation: 1, autoAck: true, presenceCode: null, tokenQueue: [], tokenGate: null, speakAccess: null, wsOpen: true,
  }
  const lazy: Harness['lazy'] = { loads: 0, gate: null, failNext: false, factories: 0 }
  let loadAttempts = 0
  let voice!: VoiceController
  const sendPresence = (message: VoicePresenceClientMessage): boolean => {
    if (!backend.wsOpen) return false
    presence.push(message)
    if (backend.autoAck) {
      queueMicrotask(() => {
        voice.handleServerMessage(backend.presenceCode === null
          ? { type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: true, onTableScreen: message.onTableScreen, leaseTtlMs: 60_000, renewAfterMs: 20_000, ready: true, speak: backend.speak } as never
          : { type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: false, code: backend.presenceCode } as never)
      })
    }
    return true
  }
  const controllerDeps = (send: typeof sendPresence) => ({
    loadAdapter: async () => {
      loadAttempts += 1
      fake.state.loads = loadAttempts
      if (options.loadFails && loadAttempts === 1) throw new Error('chunk load failed')
      return fake.adapter
    },
    sendPresence: send,
    postJson: async (path: string, body: unknown) => {
      posts.push({ path, body })
      if (path === '/api/voice/token') {
        if (backend.tokenGate !== null) await backend.tokenGate
        const queued = backend.tokenQueue.shift()
        if (queued !== undefined) return queued
        return { status: 200, body: { ok: true, url: 'wss://voice.test', token: JWT_MARK, identity: 'p_self_1', voiceTableId: TABLE, generation: backend.generation, canSpeak: backend.speak.canSpeak, speak: backend.speak, expiresInSeconds: 600 } }
      }
      if (backend.speakAccess !== null) return backend.speakAccess
      return backend.speak.canSpeak
        ? { status: 200, body: { ok: true, canSpeak: true, upgrade: 'updated' } }
        : { status: 200, body: { ok: true, canSpeak: false, code: backend.speak.blockedReason, speak: backend.speak } }
    },
    createClientInstanceId: () => 'inst_test_0000000000000001',
    timers: clock.timers,
    log: (line: string) => logs.push(line),
  })
  if (options.facade) {
    voice = createLazyVoiceController({
      sendPresence,
      apiBaseUrl: () => 'https://api.test',
      loadController: async () => {
        lazy.loads += 1
        if (lazy.gate !== null) await lazy.gate
        if (lazy.failNext) {
          lazy.failNext = false
          throw new Error('chunk load failed')
        }
        return (runtimeDeps) => {
          lazy.factories += 1
          return createVoiceController(controllerDeps(runtimeDeps.sendPresence))
        }
      },
    })
  } else {
    voice = createVoiceController(controllerDeps(sendPresence))
  }
  voice.subscribe((snapshot) => snaps.push(snapshot))
  const ctx: Harness['ctx'] = (screen = 'waiting', seats = SEATS, tableId = TABLE) => ({ kind: 'table', voiceTableId: tableId, screen, selfProfileId: 'self', seats })
  const harness: Harness = {
    voice, clock, fake, presence, posts, backend, lazy, logs, snaps, ctx,
    async connect(withMic = false) {
      voice.setContext(ctx('waiting'))
      await flush()
      if (withMic) voice.joinWithMicrophone()
      else voice.joinAsListener()
      await flush(20)
    },
  }
  return harness
}

const s = (h: Harness): VoiceSnapshot => h.voice.getSnapshot()

// ═══ Тестове ═══════════════════════════════════════════════════════════════
console.log('\ncheckVoiceController\n')

await check('[F1] Функцията е изключена / няма гласова маса: disabled, SDK не се зарежда, няма presence', async () => {
  const h = createHarness()
  h.voice.setContext({ kind: 'none' })
  h.voice.joinAsListener()
  await flush()
  assertEqual(s(h).status, 'disabled', 'status')
  assertEqual(h.fake.state.loads, 0, 'SDK не е зареден')
  assertEqual(h.presence.length, 0, 'без presence')
})

await check('[F2] Обикновена игрална маса (без voiceTableId): нищо не се зарежда', async () => {
  const h = createHarness()
  h.voice.setContext({ kind: 'none' }) // resolveVoiceContext връща none без voiceTableId
  await flush()
  assertEqual(h.fake.state.loads, 0, 'SDK')
  assertEqual(h.posts.length, 0, 'без HTTPS')
})

await check('[F3] Гласова маса: lazy SDK (един път, на екрана на масата), без автоматично включване; неуспешно зареждане -> нов опит', async () => {
  const h = createHarness({ loadFails: true })
  h.voice.setContext(h.ctx('off_table'))
  await flush()
  assertEqual(h.fake.state.loads, 0, 'в лобито не се зарежда')
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  assertEqual(h.fake.state.loads, 1, 'prefetch на екрана на масата')
  assertEqual(s(h).status, 'idle', 'без автоматично включване')
  assertEqual(h.presence.length, 0, 'без presence преди изрично действие')
  h.voice.joinAsListener()
  await flush(20)
  assertEqual(h.fake.state.loads, 2, 'неуспешното зареждане не е кеширано')
  assertEqual(s(h).status, 'connected_listening', 'свързан след повторно зареждане')
})

await check('[J1] VIP: „Включи микрофона“ -> presence -> HTTPS token -> connect -> микрофон; токенът не е в state/логове/presence', async () => {
  const h = createHarness()
  await h.connect(true)
  assertEqual(s(h).status, 'connected_speaking', 'говори')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'getUserMedia веднъж')
  assert(h.presence.some((m) => m.onTableScreen && m.clientInstanceId === 'inst_test_0000000000000001'), 'presence с clientInstanceId')
  assert(h.posts.some((p) => p.path === '/api/voice/token'), 'HTTPS token')
  const everything = JSON.stringify([s(h), h.snaps, h.presence, h.logs])
  assert(!everything.includes(JWT_MARK), 'JWT не изтича в state/presence/логове')
  assertEqual(h.fake.state.activeRooms(), 1, 'една стая')
  assertEqual(h.fake.state.rooms[0]!.startAudioCalls >= 1, true, 'startAudio при подготовката (жест)')
})

await check('[J2] Non-VIP: слуша; „Включи микрофона“ -> backend отказ vip_required, БЕЗ заявка за микрофон', async () => {
  const h = createHarness()
  h.backend.speak = LISTEN
  await h.connect(false)
  assertEqual(s(h).status, 'connected_listening', 'слуша')
  h.voice.enableMicrophone()
  await flush()
  assertEqual(s(h).uiError?.code, 'vip_required', 'съобщение')
  assertEqual(s(h).uiError?.message, 'Говоренето е VIP привилегия.', 'текст')
  assertEqual(h.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
  const h2 = createHarness()
  h2.backend.speak = LISTEN
  await h2.connect(true) // „Включи микрофона“ от non-VIP
  assertEqual(h2.fake.state.getUserMediaCalls, 0, 'и при joinWithMicrophone')
  assertEqual(s(h2).uiError?.code, 'vip_required', 'съобщение')
})

await check('[J3] VIP с административен mute: слуша, connected_muted, „Микрофонът е блокиран“, без заявка за микрофон', async () => {
  const h = createHarness()
  h.backend.speak = MUTED
  await h.connect(true)
  assertEqual(s(h).status, 'connected_muted', 'status')
  assertEqual(s(h).uiError?.message, 'Микрофонът е блокиран.', 'текст')
  assertEqual(s(h).speak?.mutedUntil, MUTED.mutedUntil, 'срокът — само към самия играч')
  h.voice.enableMicrophone()
  await flush()
  assertEqual(h.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
})

await check('[M1] Липсващ / отказан / недостъпен микрофон: точни съобщения, слушането продължава, „Опитай отново“', async () => {
  for (const [failure, code, text] of [
    ['not_found', 'mic_not_found', 'Не е открит микрофон.'],
    ['permission_denied', 'mic_permission_denied', 'Разрешете достъпа до микрофона в настройките на браузъра.'],
    ['unavailable', 'mic_unavailable', 'Микрофонът е недостъпен.'],
  ] as const) {
    const h = createHarness()
    h.fake.state.micBehavior = failure
    await h.connect(true)
    assertEqual(s(h).uiError?.code, code, failure)
    assertEqual(s(h).uiError?.message, text, `${failure} текст`)
    assertEqual(s(h).status, 'connected_listening', `${failure}: слушането продължава`)
    assertEqual(h.fake.state.last().captureReleased, true, `${failure}: capture освободен`)
    h.fake.state.micBehavior = 'ok'
    h.voice.retryMicrophone()
    await flush()
    assertEqual(s(h).microphone, 'live', `${failure}: опитай отново`)
  }
})

await check('[M2] Нов микрофон по време на игра: само сигнал, без автоматично включване; изрично „Опитай отново“', async () => {
  const h = createHarness()
  h.fake.state.micBehavior = 'not_found'
  await h.connect(true)
  const calls = h.fake.state.getUserMediaCalls
  h.fake.state.micBehavior = 'ok'
  h.fake.state.last().events.onDevicesChanged()
  await flush()
  assertEqual(s(h).microphoneDevicesChanged, true, 'сигнал')
  assertEqual(h.fake.state.getUserMediaCalls, calls, 'без автоматично включване')
  h.voice.retryMicrophone()
  await flush()
  assertEqual(s(h).status, 'connected_speaking', 'изрично')
})

await check('[M3] Изключен микрофон по време на разговор: публикуването спира, слушането остава, без автоматичен нов capture', async () => {
  const h = createHarness()
  await h.connect(true)
  const calls = h.fake.state.getUserMediaCalls
  h.fake.state.last().micLive = false
  h.fake.state.last().events.onLocalMicrophoneLost()
  await flush()
  assertEqual(s(h).microphone, 'off', 'off')
  assertEqual(s(h).status, 'connected_listening', 'слуша')
  assertEqual(s(h).uiError?.code, 'mic_unavailable', 'съобщение')
  h.fake.state.last().events.onDevicesChanged()
  await flush()
  assertEqual(h.fake.state.getUserMediaCalls, calls, 'без автоматично записване от друго устройство')
})

await check('[M4] Доброволно изключване: unpublish + освобождаване на capture; слушането остава; повторно включване = нова проверка + нов capture', async () => {
  const h = createHarness()
  await h.connect(true)
  h.voice.disableMicrophone()
  await flush()
  const room = h.fake.state.last()
  assert(!room.micLive && room.captureReleased, 'capture освободен')
  assertEqual(s(h).status, 'connected_listening', 'слуша')
  assertEqual(s(h).wantsToSpeak, false, 'намерението е изчистено')
  const speakChecks = h.posts.filter((p) => p.path === '/api/voice/speak-access').length
  h.voice.enableMicrophone()
  await flush()
  assertEqual(h.posts.filter((p) => p.path === '/api/voice/speak-access').length, speakChecks + 1, 'нова backend проверка')
  assertEqual(h.fake.state.getUserMediaCalls, 2, 'нов capture')
})

await check('[V1] Придобит VIP: без автоматично включване; изрично -> speak-access (updated) -> микрофон; request_new_token -> кратък реконект', async () => {
  const h = createHarness()
  h.backend.speak = LISTEN
  await h.connect(false)
  h.backend.speak = SPEAK
  await flush()
  assertEqual(h.fake.state.getUserMediaCalls, 0, 'без автоматично включване')
  h.voice.enableMicrophone()
  await flush()
  assertEqual(s(h).status, 'connected_speaking', 'updated')
  const h2 = createHarness()
  h2.backend.speak = LISTEN
  await h2.connect(false)
  h2.backend.speak = SPEAK
  h2.backend.speakAccess = { status: 200, body: { ok: true, canSpeak: true, upgrade: 'request_new_token' } }
  h2.voice.enableMicrophone()
  await flush(30)
  assertEqual(s(h2).status, 'connected_speaking', 'нов токен + микрофон')
  assertEqual(h2.fake.state.activeRooms(), 1, 'една стая след реконекта')
  assertEqual(h2.fake.state.rooms[0]!.disconnected, true, 'старата стая е изключена')
})

await check('[V2] Изтекъл VIP при запазено право: backend връща canSpeak — controller не ползва клиентски VIP', async () => {
  const h = createHarness()
  h.backend.speak = { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: true, mutedUntil: null }
  await h.connect(true)
  assertEqual(s(h).status, 'connected_speaking', 'говори с правото от участието')
})

await check('[A1] Административен mute по време на говорене: микрофонът спира веднага; ротация -> само слушане; без автоматично включване след unmute', async () => {
  const h = createHarness()
  await h.connect(true)
  const firstRoom = h.fake.state.last()
  h.backend.speak = MUTED
  h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
  await flush()
  assert(!firstRoom.micLive && firstRoom.captureReleased, 'микрофонът е спрян и освободен')
  assertEqual(s(h).status, 'connected_muted', 'connected_muted')
  assertEqual(s(h).wantsToSpeak, false, 'намерението е изчистено')
  h.backend.generation = 2
  h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 1000 } })
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
  await flush()
  assertEqual(s(h).status, 'rotating', 'rotating')
  assertEqual(firstRoom.disconnected, true, 'старата стая е изключена')
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
  await flush(30)
  assertEqual(s(h).status, 'connected_muted', 'в новата стая само слушане')
  assertEqual(s(h).generation, 2, 'нова генерация')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов capture')
  h.backend.speak = SPEAK
  h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: SPEAK } as never)
  await flush()
  assertEqual(s(h).status, 'connected_listening', 'unmute -> слушане')
  assertEqual(s(h).uiError, null, 'грешката е изчистена')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без автоматично включване след unmute')
})

await check('[I1] Индивидуално заглушаване: само локално (volume 0), не влияе на други; не може за себе си; пази се при ротация', async () => {
  const h = createHarness()
  await h.connect(false)
  const room = h.fake.state.last()
  addRemote(room, 'p_alice_3')
  addRemote(room, 'p_bob_1')
  h.voice.muteRemoteParticipant('alice')
  h.voice.muteRemoteParticipant('self')
  await flush()
  assertEqual(room.remotes.get('p_alice_3')!.volume, 0, 'alice заглушена')
  assertEqual(room.remotes.get('p_bob_1')!.volume, 1, 'bob не е засегнат')
  assertEqual(s(h).locallyMutedProfileIds.join(','), 'alice', 'само alice (не и себе си)')
  assertEqual(s(h).participants.find((p) => p.profileId === 'alice')!.locallyMuted, true, 'participant state')
  assertEqual(h.posts.filter((p) => p.path !== '/api/voice/token').length, 0, 'без backend заявка')
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
  await flush(30)
  const second = h.fake.state.last()
  assert(second !== room, 'нова стая')
  addRemote(second, 'p_alice_4') // нова епоха след refresh на alice
  assertEqual(second.remotes.get('p_alice_4')!.volume, 0, 'заглушаването се пази по profileId')
  h.voice.unmuteRemoteParticipant('alice')
  assertEqual(second.remotes.get('p_alice_4')!.volume, 1, 'отглушаване')
})

await check('[S1] Говорещи: веднага при начало, ~400 ms задържане при край, без трептене при кратки паузи, само speaking listener', async () => {
  const h = createHarness()
  await h.connect(false)
  const changes: string[] = []
  h.voice.subscribeSpeaking((ids) => changes.push(ids.join(',')))
  const stateEmitsBefore = h.snaps.length
  const room = h.fake.state.last()
  room.events.onActiveSpeakersChanged(['p_alice_1'])
  assertEqual(s(h).speakingProfileIds.join(','), 'alice', 'веднага')
  room.events.onActiveSpeakersChanged([])
  await h.clock.advance(300)
  room.events.onActiveSpeakersChanged(['p_alice_1'])
  await h.clock.advance(500)
  assertEqual(changes.join('|'), 'alice', 'без трептене при пауза 300 ms')
  room.events.onActiveSpeakersChanged([])
  await h.clock.advance(399)
  assertEqual(s(h).speakingProfileIds.length, 1, 'още говори (задържане)')
  await h.clock.advance(1)
  assertEqual(s(h).speakingProfileIds.length, 0, 'край след 400 ms')
  assertEqual(h.snaps.length, stateEmitsBefore, 'speaking не предизвиква state emit (без прерисуване)')
})

await check('[P1] Participant state: 3 реални играча (без бот); неизвестно при несвързан; присъствие/микрофон при свързан', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  const before = s(h).participants
  assertEqual(before.length, 3, 'ботът не участва')
  assert(before.every((p) => p.unknown && p.voiceConnected === null && p.microphonePublished === null), 'неизвестно ≠ изключено')
  await h.connect(false)
  addRemote(h.fake.state.last(), 'p_alice_1', true)
  const after = s(h).participants
  const alice = after.find((p) => p.profileId === 'alice')!
  const bob = after.find((p) => p.profileId === 'bob')!
  assert(alice.voiceConnected === true && alice.microphonePublished === true && alice.listening === false, 'alice говори')
  assert(bob.voiceConnected === false && bob.microphonePublished === null, 'bob не е в гласа (микрофонът е неизвестен, не "изключен")')
  assert(after.find((p) => p.isSelf)!.listening === true, 'аз слушам')
})

await check('[L1] Чакалня -> игра: без прекъсване; „Преиграй“ (същият контекст): без промяна; микрофонът и заглушаванията се пазят', async () => {
  const h = createHarness()
  await h.connect(true)
  h.voice.muteRemoteParticipant('alice')
  h.voice.setContext(h.ctx('game'))
  await flush()
  assertEqual(h.fake.state.rooms[0]!.disconnected, false, 'стаята продължава')
  assertEqual(s(h).status, 'connected_speaking', 'микрофонът продължава')
  h.voice.setContext(h.ctx('game'))
  await flush()
  assertEqual(h.fake.state.rooms.length, 1, 'преиграване — същата стая')
  assertEqual(s(h).locallyMutedProfileIds.join(','), 'alice', 'заглушаването остава')
  assertEqual(h.posts.filter((p) => p.path === '/api/voice/speak-access').length, 0, 'без повторна VIP проверка')
})

await check('[L2] „Изчакай в лоби“ / магазин: presence false, гласът и микрофонът спират, мястото се пази; връщане -> без автоматично включване', async () => {
  const h = createHarness()
  await h.connect(true)
  h.voice.setContext(h.ctx('off_table'))
  await flush()
  const room = h.fake.state.last()
  assert(room.disconnected && room.captureReleased, 'изключен, микрофонът освободен')
  assert(h.presence.at(-1)!.onTableScreen === false, 'изрично известие към сървъра')
  assertEqual(s(h).status, 'idle', 'idle')
  assertEqual(s(h).canRestore, true, 'може да се възстанови изрично')
  const sent = h.presence.length
  await h.clock.advance(60_000)
  assertEqual(h.presence.length, sent, 'без подновяване на lease в лобито')
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  assertEqual(s(h).status, 'idle', 'без автоматично включване')
  assertEqual(h.fake.state.activeRooms(), 0, 'без нова стая')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без микрофон')
})

await check('[L3] Игра започва, докато играчът е в лобито: без автоматичен глас; „Към лобито“ след игра: гласът спира', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('off_table'))
  h.voice.setContext(h.ctx('game'))
  await flush()
  assertEqual(s(h).status, 'idle', 'без автоматичен глас')
  h.voice.joinAsListener()
  await flush(20)
  h.voice.setContext({ kind: 'none' }) // left_active_room
  await flush()
  assertEqual(h.fake.state.last().disconnected, true, 'изключен')
  assertEqual(s(h).status, 'disabled', 'пълен cleanup')
  assertEqual(s(h).locallyMutedProfileIds.length, 0, 'локалното състояние е изчистено')
})

await check('[Z1] Lease: подновяване на 20 s само докато гласът е в употреба на екрана на масата; спира след напускане', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await h.clock.advance(60_000)
  assertEqual(h.presence.length, 0, 'без lease за неизползващ гласа')
  h.voice.joinAsListener()
  await flush(20)
  const afterJoin = h.presence.length
  await h.clock.advance(20_000)
  assertEqual(h.presence.length, afterJoin + 1, 'подновяване след 20 s')
  await h.clock.advance(40_000)
  assertEqual(h.presence.length, afterJoin + 3, 'на всеки 20 s')
  h.voice.leaveVoice()
  await flush()
  assert(h.presence.at(-1)!.onTableScreen === false, 'известие при напускане')
  const final = h.presence.length
  await h.clock.advance(60_000)
  assertEqual(h.presence.length, final, 'без подновяване след напускане')
  assertEqual(s(h).status, 'idle', 'напускането на гласа не напуска масата')
})

await check('[Z2] Игровият WS пада: гласът продължава; възстановяване преди 120 s отменя таймера; повторни сигнали не рестартират таймера', async () => {
  const h = createHarness()
  await h.connect(true)
  h.backend.wsOpen = false
  h.voice.setGameConnection(false)
  await h.clock.advance(60_000)
  h.voice.setGameConnection(false) // повторен неуспешен опит — без рестарт
  await h.clock.advance(50_000)
  assertEqual(s(h).status, 'connected_speaking', 'гласът продължава до 120 s')
  h.backend.wsOpen = true
  const sent = h.presence.length
  h.voice.setGameConnection(true)
  await flush()
  assertEqual(h.presence.length, sent + 1, 'presence веднага след възстановяване')
  await h.clock.advance(30_000)
  assertEqual(s(h).status, 'connected_speaking', 'таймерът е отменен; микрофонът е запазен')
})

await check('[Z3] 120 s без игрова връзка: прекъсване, освободен микрофон, без автоматично връщане', async () => {
  const h = createHarness()
  await h.connect(true)
  h.backend.wsOpen = false
  h.voice.setGameConnection(false)
  await h.clock.advance(119_999)
  assertEqual(s(h).status, 'connected_speaking', 'преди срока')
  await h.clock.advance(1)
  const room = h.fake.state.last()
  assert(room.disconnected && room.captureReleased, 'изключен, микрофонът освободен')
  assertEqual(s(h).status, 'idle', 'idle')
  assertEqual(s(h).canRestore, true, '„Възстанови гласовия чат“')
  h.backend.wsOpen = true
  h.voice.setGameConnection(true)
  await flush()
  assertEqual(h.fake.state.activeRooms(), 0, 'без автоматично връщане')
})

await check('[R1] Официален LiveKit reconnect: reconnecting -> connected, без нова стая; изгубена връзка -> ограничени нови опити', async () => {
  const h = createHarness()
  await h.connect(true)
  const room = h.fake.state.last()
  room.events.onReconnecting()
  assertEqual(s(h).status, 'reconnecting', 'reconnecting')
  room.events.onReconnected()
  assertEqual(s(h).status, 'connected_speaking', 'обратно')
  assertEqual(h.fake.state.rooms.length, 1, 'без нова стая')
  serverDisconnect(room, 'connection_lost')
  await h.clock.advance(2_000)
  await flush(20)
  assertEqual(h.fake.state.activeRooms(), 1, 'нов опит с нов токен')
  // LiveKit е прекратил capture-а -> без автоматичен нов getUserMedia (само слушане).
  assertEqual(s(h).status, 'connected_listening', 'след окончателна загуба: слушане')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без автоматичен нов capture')
  assertEqual(h.fake.state.liveCaptures(), 0, 'няма активен capture')
  const h2 = createHarness()
  await h2.connect(false)
  h2.fake.state.connectFails = true
  serverDisconnect(h2.fake.state.last(), 'connection_lost')
  await h2.clock.advance(20_000)
  await flush(20)
  assertEqual(s(h2).status, 'unavailable', 'след ограничените опити')
  assertEqual(s(h2).uiError?.message, 'Гласовият чат временно е недостъпен.', 'съобщение')
})

await check('[R2] Ротация: старата стая се прекъсва преди новата (≤1 активна), изчакване на ready, нов токен, режимът се пази', async () => {
  const h = createHarness()
  await h.connect(true)
  const first = h.fake.state.last()
  h.backend.generation = 2
  h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 5000 } })
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
  await flush()
  assert(first.disconnected, 'старата е прекъсната')
  assertEqual(h.fake.state.activeRooms(), 0, 'няма две активни стаи')
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
  await flush(30)
  assertEqual(h.fake.state.activeRooms(), 1, 'новата е свързана')
  assertEqual(s(h).generation, 2, 'генерация 2')
  assertEqual(s(h).status, 'connected_speaking', 'говорещият остава говорещ (правото е валидно)')
  // слушател остава слушател; доброволно изключен остава изключен
  h.voice.disableMicrophone()
  await flush()
  h.backend.generation = 3
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 3, ready: false } as never)
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'доброволно изключеният микрофон остава изключен')
})

await check('[R3] Refresh: нов controller не се включва автоматично; не използва стари токени', async () => {
  const h1 = createHarness()
  await h1.connect(true)
  const h2 = createHarness()
  h2.voice.setContext(h2.ctx('game'))
  await flush()
  assertEqual(s(h2).status, 'idle', 'без автоматично присъединяване')
  assertEqual(h2.fake.state.getUserMediaCalls, 0, 'без микрофон')
  assertEqual(h2.posts.length, 0, 'без токен заявки')
})

await check('[X1] Изместена сесия / бан / voice OFF / освободена маса: незабавен пълен cleanup, без reconnect', async () => {
  for (const trigger of ['displaced', 'banned_msg', 'voice_off', 'table_released', 'presence_off'] as const) {
    const h = createHarness()
    await h.connect(true)
    const room = h.fake.state.last()
    if (trigger === 'displaced') h.voice.endSession('displaced')
    else if (trigger === 'banned_msg') h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: 'banned' } as never)
    else if (trigger === 'presence_off') h.voice.handleServerMessage({ type: 'voice_presence_result', voiceTableId: TABLE, ok: false, code: 'voice_off' } as never)
    else h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: trigger } as never)
    await flush()
    assert(room.disconnected && room.captureReleased, `${trigger}: изключен и освободен`)
    assertEqual(s(h).status, 'disabled', `${trigger}: disabled`)
    await h.clock.advance(30_000)
    assertEqual(h.fake.state.activeRooms(), 0, `${trigger}: без reconnect`)
    assertEqual(h.clock.pending(), 0, `${trigger}: без таймери`)
  }
})

await check('[X2] Изместена сесия по време на reconnect: спира опитите', async () => {
  const h = createHarness()
  await h.connect(false)
  const lost = h.fake.state.last()
  serverDisconnect(lost, 'connection_lost') // LiveKit: Disconnected = стаята вече е прекъсната
  await flush()
  assertEqual(s(h).status, 'reconnecting', 'reconnecting')
  h.voice.endSession('displaced')
  await h.clock.advance(30_000)
  assertEqual(h.fake.state.activeRooms(), 0, 'без нови опити')
  assertEqual(h.posts.filter((p) => p.path === '/api/voice/token').length, 1, 'без нови токени')
})

await check('[B1] Autoplay блокиран: състояние „Включи звука“; unlockAudio (жест) -> startAudio', async () => {
  const h = createHarness()
  h.fake.state.initialPlayback = false
  await h.connect(false)
  assertEqual(s(h).playbackBlocked, true, 'блокиран')
  h.voice.unlockAudio()
  await flush()
  assertEqual(s(h).playbackBlocked, false, 'отключен')
  h.fake.state.last().events.onPlaybackStatusChanged(false)
  assertEqual(s(h).playbackBlocked, true, 'събитие от браузъра')
})

await check('[C1] Races: двойно натискане; join -> leave -> join; бавен токен + leave; смяна на екрана по време на connect', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  h.voice.joinAsListener()
  h.voice.joinAsListener()
  await flush(20)
  assertEqual(h.posts.filter((p) => p.path === '/api/voice/token').length, 1, 'двойно натискане -> една сесия')
  h.voice.leaveVoice()
  h.voice.joinAsListener()
  await flush(20)
  assertEqual(h.fake.state.activeRooms(), 1, 'join->leave->join: една активна стая')
  const h2 = createHarness()
  h2.voice.setContext(h2.ctx('waiting'))
  await flush()
  let release: () => void = () => {}
  h2.backend.tokenGate = new Promise<void>((resolve) => { release = resolve })
  h2.voice.joinWithMicrophone()
  await flush()
  h2.voice.leaveVoice()
  release()
  await flush(20)
  assertEqual(h2.fake.state.activeRooms(), 0, 'бавен токен след leave -> без connect')
  assertEqual(h2.fake.state.getUserMediaCalls, 0, 'без микрофон')
  const h3 = createHarness()
  h3.voice.setContext(h3.ctx('waiting'))
  await flush()
  let releaseConnect: () => void = () => {}
  h3.fake.state.connectGate = new Promise<void>((resolve) => { releaseConnect = resolve })
  h3.voice.joinWithMicrophone()
  await flush()
  h3.voice.setContext(h3.ctx('off_table'))
  releaseConnect()
  await flush(20)
  assertEqual(h3.fake.state.activeRooms(), 0, 'смяна на екрана по време на connect -> изключено')
  assertEqual(h3.fake.state.getUserMediaCalls, 0, 'без микрофон')
})

await check('[C2] Stale async: изключване/mute/напускане/ротация по време на заявката за микрофон -> микрофонът НЕ остава включен', async () => {
  for (const interrupt of ['disable', 'mute', 'leave', 'rotation'] as const) {
    const h = createHarness()
    await h.connect(false)
    let releaseMic: () => void = () => {}
    h.fake.state.micGate = new Promise<void>((resolve) => { releaseMic = resolve })
    h.voice.enableMicrophone()
    await flush()
    const room = h.fake.state.last()
    if (interrupt === 'disable') h.voice.disableMicrophone()
    if (interrupt === 'mute') h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
    if (interrupt === 'leave') h.voice.leaveVoice()
    if (interrupt === 'rotation') h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
    releaseMic()
    await flush(20)
    assertEqual(room.micLive, false, `${interrupt}: микрофонът не е включен`)
    assertEqual(room.captureReleased, true, `${interrupt}: capture освободен`)
    assert(s(h).microphone !== 'live', `${interrupt}: state`)
  }
})

await check('[K1] Пълен cleanup: dispose -> стаята изключена, без таймери и слушатели; без дублирани audio елементи', async () => {
  const h = createHarness()
  await h.connect(true)
  h.voice.muteRemoteParticipant('alice')
  const unsubscribe = h.voice.subscribe(() => {})
  unsubscribe()
  h.voice.dispose()
  await flush()
  const room = h.fake.state.last()
  assert(room.disconnected && room.captureReleased, 'изключен и освободен')
  assertEqual(h.clock.pending(), 0, 'без таймери')
  assertEqual(h.voice.debugCounters().listeners, 0, 'без слушатели')
  assert(h.presence.at(-1)!.onTableScreen === false, 'известие към сървъра')
  // Audio sink: един елемент на trackSid, премахване при detach/clear.
  const appended: unknown[] = []
  const element = (sid: string) => ({ sid, attributes: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attributes[k] = v }, remove() { const i = appended.indexOf(this); if (i >= 0) appended.splice(i, 1) } })
  const container = { isConnected: true, style: { cssText: '' }, setAttribute() {}, appendChild(el: unknown) { appended.push(el) }, remove() {} }
  const fakeDoc = { createElement: () => container, body: { appendChild() {} } } as unknown as Document
  const sink = createVoiceAudioSink(fakeDoc)
  const a = element('TR_1')
  sink.attach('TR_1', a as unknown as HTMLMediaElement)
  sink.attach('TR_1', a as unknown as HTMLMediaElement)
  sink.attach('TR_1', element('TR_1') as unknown as HTMLMediaElement)
  assertEqual(sink.size(), 1, 'един елемент на track')
  assertEqual(appended.length, 1, 'без дублирани елементи в DOM')
  sink.clear()
  assertEqual(appended.length, 0, 'clear')
})

await check('[K2] Без натрупване на таймери и слушатели при многократни join/leave', async () => {
  const h = createHarness()
  h.voice.setContext(h.ctx('waiting'))
  await flush()
  for (let index = 0; index < 5; index += 1) {
    h.voice.joinAsListener()
    await flush(20)
    h.voice.leaveVoice()
    await flush()
  }
  assertEqual(h.clock.pending(), 0, 'без висящи таймери')
  assertEqual(h.fake.state.activeRooms(), 0, 'без активни стаи')
  assertEqual(h.fake.state.rooms.every((r) => r.disconnected), true, 'всички стаи са изключени')
  h.voice.joinAsListener()
  await flush(20)
  assertEqual(h.clock.pending(), 1, 'само lease таймерът')
})

await check('[W1] Интеграция: в основния bundle само посредникът (type-only импорти); runtime само чрез import(); precache изключение', async () => {
  const main = await readFile('src/main.ts', 'utf8')
  const vite = await readFile('vite.config.ts', 'utf8')
  const facade = await readFile('src/app/voice/voiceFacade.ts', 'utf8')
  const voiceFiles = ['createVoiceController', 'voiceRuntime', 'voiceFacade', 'voiceAdapter', 'voiceAudioSink', 'voiceProtocol']
  const sources = Object.fromEntries(await Promise.all(voiceFiles.map(async (name) => [name, await readFile(`src/app/voice/${name}.ts`, 'utf8')] as const)))
  // main.ts: само type импорти от createVoiceController + посредникът.
  const mainVoiceImports = main.split('\n').filter((line) => /from '\.\/app\/voice\//.test(line))
  assert(mainVoiceImports.every((line) => /^import type /.test(line) || /voiceFacade'/.test(line)), `main.ts voice импорти: ${mainVoiceImports.join(' | ')}`)
  // Посредникът: без runtime импорти; единственият път към runtime-а е import().
  assert(facade.split('\n').filter((line) => /^import /.test(line)).every((line) => /^import type /.test(line)), 'facade: само import type')
  assert(/import\('\.\/voiceRuntime'\)/.test(facade), 'dynamic import на runtime-а')
  for (const [name, source] of Object.entries(sources)) {
    assert(!/from 'livekit-client'/.test(source), `${name}: без livekit-client (само liveKitVoiceAdapter.ts)`)
    assert(!/localStorage|sessionStorage|indexedDB/.test(source), `${name}: без storage`)
    assert(!/console\.(log|info|debug)/.test(source), `${name}: без логове`)
  }
  assert(!/from 'livekit-client'/.test(main), 'main.ts без livekit-client')
  assert(vite.includes("'assets/voice-*'") && vite.includes('assets/voice-[name]-[hash].js') && vite.includes('(?!voiceFacade'), 'voice chunk извън precache; посредникът е изключен от префикса')
  for (const fragment of ['createLazyVoiceController({', 'voiceController?.setGameConnection(true)', 'voiceController?.setGameConnection(false)', "voiceController?.endSession('displaced')", "voiceController?.endSession('banned')", "voiceController?.endSession('deleted')", 'onBeforeRender: () => syncVoiceContext()', 'client.sendVoicePresence(message)', 'if (!isVoiceContextSyncQueued)']) {
    assert(main.includes(fragment), `main.ts: ${fragment}`)
  }
})

// ═══ Lazy посредник (voiceFacade) ═════════════════════════════════════════

const NON_VOICE_MESSAGES = [
  { type: 'room_snapshot' }, { type: 'play_card_result' }, { type: 'lobby_chat_message' }, { type: 'trick_completed' }, { type: 'pong' },
]

await check('[LZ1] Без зареждане: voice OFF / обикновена маса / сядане на гласова маса / лоби / WS трафик -> 0 chunk, 0 presence, 0 HTTPS, 0 таймери', async () => {
  const h = createHarness({ facade: true })
  h.voice.setContext({ kind: 'none' })
  for (let index = 0; index < 200; index += 1) {
    for (const message of NON_VOICE_MESSAGES) assertEqual(h.voice.handleServerMessage(message), false, 'не е гласово съобщение')
  }
  h.voice.setGameConnection(false)
  h.voice.setGameConnection(true)
  h.voice.setContext(h.ctx('waiting')) // сядане на гласова маса
  h.voice.setContext(h.ctx('game'))
  h.voice.setContext(h.ctx('off_table'))
  h.voice.setContext(h.ctx('game'))
  // гласови съобщения преди зареждането се поглъщат без ефект
  assertEqual(h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never), true, 'гласово съобщение')
  h.voice.muteRemoteParticipant('alice')
  h.voice.unlockAudio()
  h.voice.onPageShow(true)
  await h.clock.advance(180_000)
  assertEqual(h.lazy.loads, 0, 'controller/SDK chunk не е зареден')
  assertEqual(h.fake.state.loads, 0, 'адаптер')
  assertEqual(h.presence.length, 0, 'без presence')
  assertEqual(h.posts.length, 0, 'без HTTPS')
  assertEqual(h.clock.pending(), 0, 'без таймери')
  assertEqual(s(h).status, 'idle', 'idle')
  assertEqual(s(h).participants.length, 3, '3 реални играча')
  assert(s(h).participants.every((p) => p.unknown && p.voiceConnected === null), 'неизвестно (не „изключено“)')
  assertEqual(s(h).locallyMutedProfileIds.length, 0, 'заглушаване преди включване = no-op')
  assertEqual(h.voice.debugCounters().controllerLoaded, 0, 'debugCounters')
})

await check('[LZ2] Performance: еднакъв контекст / несвързани WS съобщения -> без state notifications (преди и след зареждане)', async () => {
  const h = createHarness({ facade: true })
  h.voice.setContext(h.ctx('game'))
  const before = h.snaps.length
  for (let index = 0; index < 1_000; index += 1) {
    h.voice.setContext(h.ctx('game', SEATS.map((seat) => ({ ...seat })))) // нов обект, същото съдържание
    for (const message of NON_VOICE_MESSAGES) h.voice.handleServerMessage(message)
  }
  assertEqual(h.snaps.length, before, 'без notifications преди зареждане')
  h.voice.setContext({ kind: 'none' })
  const none = h.snaps.length
  for (let index = 0; index < 1_000; index += 1) h.voice.setContext({ kind: 'none' })
  assertEqual(h.snaps.length, none, 'voice OFF / обикновена маса: без notifications')
  h.voice.setContext(h.ctx('game'))
  h.voice.joinAsListener()
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'свързан')
  const afterJoin = h.snaps.length
  const presenceAfterJoin = h.presence.length
  const tokenAfterJoin = h.posts.length
  for (let index = 0; index < 1_000; index += 1) {
    h.voice.setContext(h.ctx('game', SEATS.map((seat) => ({ ...seat }))))
    for (const message of NON_VOICE_MESSAGES) h.voice.handleServerMessage(message)
  }
  await flush()
  assertEqual(h.snaps.length, afterJoin, 'без notifications след зареждане')
  assertEqual(h.presence.length, presenceAfterJoin, 'без допълнителен presence')
  assertEqual(h.posts.length, tokenAfterJoin, 'без нови voice операции')
  assertEqual(h.lazy.loads, 1, 'едно зареждане')
})

await check('[LZ3] Lazy включване: „Само слушай“ -> connecting веднага, едно зареждане при двойно натискане, controller-ът получава АКТУАЛНИЯ контекст', async () => {
  const h = createHarness({ facade: true })
  h.voice.setContext(h.ctx('waiting'))
  let release: () => void = () => {}
  h.lazy.gate = new Promise<void>((resolve) => { release = resolve })
  h.voice.joinAsListener()
  h.voice.joinAsListener()
  assertEqual(s(h).status, 'connecting', 'connecting веднага')
  // по време на зареждането: чакалня -> игра и нов играч на мястото на бота
  const newSeats = [...SEATS.slice(0, 3), { profileId: 'carol', isBot: false }]
  h.voice.setContext(h.ctx('game', newSeats))
  release()
  await flush(30)
  assertEqual(h.lazy.loads, 1, 'едно зареждане')
  assertEqual(h.lazy.factories, 1, 'един controller')
  assertEqual(s(h).status, 'connected_listening', 'свързан')
  assertEqual(s(h).screen, 'game', 'актуален екран')
  assert(s(h).participants.some((p) => p.profileId === 'carol'), 'актуалните места')
  assertEqual(h.presence.filter((m) => m.onTableScreen).length, 1, 'един presence handshake')
  assertEqual(h.fake.state.getUserMediaCalls, 0, 'без микрофон')
  h.voice.leaveVoice()
  await flush()
  h.voice.setContext(h.ctx('waiting', newSeats, TABLE_B))
  h.voice.joinWithMicrophone()
  await flush(30)
  assertEqual(h.lazy.loads, 1, 'вече зареден — нова маса, същият controller')
  assertEqual(h.voice.debugCounters().controllerLoaded, 1, 'controllerLoaded')
})

await check('[LZ4] Races по време на lazy зареждането: напускане/лоби/смяна на маса/изместена сесия/бан/pagehide/край на масата/dispose -> без join, presence и микрофон', async () => {
  for (const interrupt of ['leave', 'off_table', 'table_change', 'displaced', 'banned_msg', 'pagehide', 'context_none', 'dispose'] as const) {
    const h = createHarness({ facade: true })
    h.voice.setContext(h.ctx('game'))
    let release: () => void = () => {}
    h.lazy.gate = new Promise<void>((resolve) => { release = resolve })
    h.voice.joinWithMicrophone()
    if (interrupt === 'leave') h.voice.leaveVoice()
    if (interrupt === 'off_table') h.voice.setContext(h.ctx('off_table'))
    if (interrupt === 'table_change') h.voice.setContext(h.ctx('waiting', SEATS, TABLE_B))
    if (interrupt === 'displaced') h.voice.endSession('displaced')
    if (interrupt === 'banned_msg') h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: 'banned' } as never)
    if (interrupt === 'pagehide') h.voice.onPageHide()
    if (interrupt === 'context_none') h.voice.setContext({ kind: 'none' })
    if (interrupt === 'dispose') h.voice.dispose()
    if (interrupt !== 'dispose') assertEqual(s(h).status === 'connecting', false, `${interrupt}: намерението е отменено веднага`)
    release()
    await flush(30)
    assertEqual(h.presence.length, 0, `${interrupt}: без presence`)
    assertEqual(h.posts.length, 0, `${interrupt}: без HTTPS`)
    assertEqual(h.fake.state.activeRooms(), 0, `${interrupt}: без стая`)
    assertEqual(h.fake.state.getUserMediaCalls, 0, `${interrupt}: без микрофон`)
    assertEqual(h.clock.pending(), 0, `${interrupt}: без таймери`)
    if (interrupt === 'table_change') assertEqual(s(h).voiceTableId, TABLE_B, 'новата маса (актуален контекст)')
    if (interrupt === 'context_none') assertEqual(s(h).status, 'disabled', 'disabled')
  }
})

await check('[LZ5] По време на зареждането: изключване на микрофона -> само слушане; mute -> само слушане; WS без връзка -> недостъпен без таймери', async () => {
  const h = createHarness({ facade: true })
  h.voice.setContext(h.ctx('game'))
  let release: () => void = () => {}
  h.lazy.gate = new Promise<void>((resolve) => { release = resolve })
  h.voice.joinWithMicrophone()
  assertEqual(s(h).wantsToSpeak, true, 'желание')
  h.voice.disableMicrophone()
  assertEqual(s(h).wantsToSpeak, false, 'изключено още преди зареждането')
  release()
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'слушане')
  assertEqual(h.fake.state.getUserMediaCalls, 0, 'без микрофон')
  const h2 = createHarness({ facade: true })
  h2.voice.setContext(h2.ctx('game'))
  let release2: () => void = () => {}
  h2.lazy.gate = new Promise<void>((resolve) => { release2 = resolve })
  h2.voice.joinWithMicrophone()
  // mute идва преди controller-а: authoritative стойността идва с presence ack-а
  h2.backend.speak = MUTED
  h2.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
  release2()
  await flush(30)
  assertEqual(s(h2).status, 'connected_muted', 'само слушане при mute')
  assertEqual(h2.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
  const h3 = createHarness({ facade: true })
  h3.voice.setContext(h3.ctx('game'))
  h3.backend.wsOpen = false
  h3.voice.setGameConnection(false)
  h3.voice.joinAsListener()
  await flush(30)
  assertEqual(s(h3).status, 'unavailable', 'без игрова връзка')
  assertEqual(h3.clock.pending(), 0, 'без 120 s таймер (гласът не е в употреба)')
})

await check('[LZ6] Неуспешно зареждане на chunk-а: „Гласовият чат временно е недостъпен.“; „Опитай отново“ зарежда наново; отказ междувременно -> без грешка', async () => {
  const h = createHarness({ facade: true })
  h.voice.setContext(h.ctx('game'))
  h.lazy.failNext = true
  h.voice.joinAsListener()
  await flush(30)
  assertEqual(s(h).status, 'unavailable', 'unavailable')
  assertEqual(s(h).uiError?.message, VOICE_UI_MESSAGES.service_unavailable.message, 'същото съобщение като controller-а')
  h.voice.retryConnection()
  await flush(30)
  assertEqual(h.lazy.loads, 2, 'нов опит за зареждане')
  assertEqual(s(h).status, 'connected_listening', 'свързан')
  const h2 = createHarness({ facade: true })
  h2.voice.setContext(h2.ctx('game'))
  h2.lazy.failNext = true
  h2.voice.joinAsListener()
  h2.voice.leaveVoice()
  await flush(30)
  assertEqual(s(h2).status, 'idle', 'отказаното включване не показва грешка')
  assertEqual(s(h2).uiError, null, 'без грешка')
})

await check('[LZ7] Autoplay при първо (lazy) включване: жестът е изтекъл -> връзката остава, playbackBlocked=true, unlockAudio() (нов жест) отключва', async () => {
  const h = createHarness({ facade: true })
  h.fake.state.initialPlayback = false // браузърът отказва възпроизвеждане извън жеста
  h.voice.setContext(h.ctx('game'))
  let release: () => void = () => {}
  h.lazy.gate = new Promise<void>((resolve) => { release = resolve })
  let releaseConnect: () => void = () => {}
  h.fake.state.connectGate = new Promise<void>((resolve) => { releaseConnect = resolve })
  h.voice.joinAsListener()
  release()
  await flush(30)
  // startAudio() при подготовката (извън жеста) е отказан: събитието преди
  // connect не променя състоянието — стойността се взима при свързване.
  assertEqual(s(h).status, 'connecting', 'свързва се')
  h.fake.state.last().events.onPlaybackStatusChanged(false)
  assertEqual(s(h).playbackBlocked, false, 'не се показва „Включи звука“ преди свързване')
  h.fake.state.connectGate = null
  releaseConnect()
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'връзката е активна')
  assertEqual(s(h).playbackBlocked, true, '„Включи звука“')
  addRemote(h.fake.state.last(), 'p_alice_1')
  assertEqual(s(h).status, 'connected_listening', 'отдалечен участник — връзката остава')
  h.voice.unlockAudio() // нов потребителски жест
  await flush()
  assertEqual(s(h).playbackBlocked, false, 'отключено')
  assertEqual(h.fake.state.last().startAudioCalls, 2, 'startAudio() при подготовката + при жеста')
  h.fake.state.last().events.onPlaybackStatusChanged(false)
  assertEqual(s(h).playbackBlocked, true, 'браузърът може да блокира отново')
  h.fake.state.last().events.onPlaybackStatusChanged(true)
  assertEqual(s(h).playbackBlocked, false, 'и да разреши')
  // Следващо включване (controller-ът вече е зареден): стаята се подготвя
  // СИНХРОННО в жеста (startAudio в същия жест).
  h.voice.leaveVoice()
  await flush()
  const roomsBefore = h.fake.state.rooms.length
  h.voice.joinAsListener()
  assertEqual(h.fake.state.rooms.length, roomsBefore + 1, 'синхронна подготовка в жеста')
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'свързан отново')
})

// ═══ Микрофон при ротация ══════════════════════════════════════════════════

async function rotate(h: Harness, generation: number, options: { pendingToken?: number } = {}): Promise<void> {
  h.backend.generation = generation
  for (let index = 0; index < (options.pendingToken ?? 0); index += 1) {
    h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 1000 } })
  }
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation, ready: false } as never)
  await flush(30)
}

await check('[RM1] Незасегнат говорещ: същият capture се публикува в новата стая — без нов getUserMedia, ≤1 стая, ≤1 capture', async () => {
  const h = createHarness({ facade: true })
  await h.connect(true)
  const first = h.fake.state.last()
  const capture = first.capture
  await rotate(h, 2)
  const second = h.fake.state.last()
  assert(second !== first && first.disconnected, 'старата стая е изключена')
  assertEqual(s(h).status, 'connected_speaking', 'говори в новата стая')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
  assertEqual(h.fake.state.reusedPublishes, 1, 'повторно публикуване')
  assert(second.capture === capture && second.micLive, 'същият capture')
  assertEqual(h.fake.state.liveCaptures(), 1, 'един capture')
  assertEqual(h.fake.state.violations, 0, 'никога две стаи едновременно')
  assertEqual(h.voice.debugCounters().retainedMicrophone, 0, 'няма висящ запазен capture')
})

await check('[RM2] Доброволно изключен остава изключен; наказан остава слушател; non-VIP остава слушател', async () => {
  const h = createHarness()
  await h.connect(true)
  h.voice.disableMicrophone()
  await flush()
  await rotate(h, 2)
  assertEqual(s(h).status, 'connected_listening', 'доброволно изключен')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без capture')
  assertEqual(h.fake.state.liveCaptures(), 0, 'няма активен capture')
  const h2 = createHarness()
  h2.backend.speak = MUTED
  await h2.connect(true)
  await rotate(h2, 2)
  assertEqual(s(h2).status, 'connected_muted', 'наказан')
  assertEqual(h2.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
  const h3 = createHarness()
  h3.backend.speak = LISTEN
  await h3.connect(false)
  await rotate(h3, 2)
  assertEqual(s(h3).status, 'connected_listening', 'non-VIP')
  assertEqual(h3.fake.state.getUserMediaCalls, 0, 'без getUserMedia')
})

await check('[RM3] Mute / напускане / изместена сесия / лоби ПО ВРЕМЕ на ротацията -> запазеният capture се освобождава, без микрофон', async () => {
  for (const interrupt of ['mute', 'leave', 'displaced', 'off_table', 'disable'] as const) {
    const h = createHarness()
    await h.connect(true)
    await rotate(h, 2, { pendingToken: 3 }) // ротацията чака ready
    assertEqual(h.voice.debugCounters().retainedMicrophone, 1, `${interrupt}: capture-ът е запазен`)
    if (interrupt === 'mute') {
      h.backend.speak = MUTED
      h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
    }
    if (interrupt === 'leave') h.voice.leaveVoice()
    if (interrupt === 'displaced') h.voice.endSession('displaced')
    if (interrupt === 'off_table') h.voice.setContext(h.ctx('off_table'))
    if (interrupt === 'disable') h.voice.disableMicrophone()
    await flush()
    assertEqual(h.fake.state.liveCaptures(), 0, `${interrupt}: capture освободен веднага`)
    await h.clock.advance(10_000)
    await flush(30)
    assertEqual(h.fake.state.getUserMediaCalls, 1, `${interrupt}: без нов capture`)
    assertEqual(h.fake.state.liveCaptures(), 0, `${interrupt}: няма активен capture`)
    assert(!h.fake.state.rooms.some((r) => r.micLive), `${interrupt}: микрофонът не е публикуван`)
    if (interrupt === 'mute') assertEqual(s(h).status, 'connected_muted', 'наказаният остава слушател')
    if (interrupt === 'disable') assertEqual(s(h).status, 'connected_listening', 'изключеният остава изключен')
  }
})

await check('[RM4] Прекратен capture по време на ротацията (track ended) -> слушане + „Микрофонът е недостъпен.“, без нов capture', async () => {
  const h = createHarness()
  await h.connect(true)
  const capture = h.fake.state.last().capture!
  await rotate(h, 2, { pendingToken: 1 })
  capture.ended = true // устройството е изключено докато сме без стая
  await h.clock.advance(5_000)
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'слушане')
  assertEqual(s(h).uiError?.message, 'Микрофонът е недостъпен.', 'съобщение')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без автоматичен нов capture')
  assertEqual(h.voice.debugCounters().retainedMicrophone, 0, 'няма запазен capture')
})

await check('[RM5] Ограничено задържане: ротацията продължава > 20 s -> capture-ът се освобождава, след това само слушане', async () => {
  const h = createHarness()
  await h.connect(true)
  await rotate(h, 2, { pendingToken: 5 })
  await h.clock.advance(20_000)
  assertEqual(h.fake.state.liveCaptures(), 0, 'освободен след 20 s')
  await h.clock.advance(30_000)
  await flush(30)
  assertEqual(s(h).status, 'connected_listening', 'новата стая — слушане')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов capture')
})

await check('[RM6] Забавено откачане + напускане/ротация междувременно -> capture-ът се спира, не се публикува', async () => {
  const h = createHarness()
  await h.connect(true)
  let release: () => void = () => {}
  h.fake.state.detachGate = new Promise<void>((resolve) => { release = resolve })
  h.backend.generation = 2
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: false } as never)
  await flush()
  h.voice.leaveVoice()
  release()
  await flush(30)
  assertEqual(h.fake.state.liveCaptures(), 0, 'спрян')
  assertEqual(h.fake.state.activeRooms(), 0, 'без стая')
  assertEqual(h.voice.debugCounters().retainedMicrophone, 0, 'не е запазен')
})

await check('[RM7] connection_lost / room_deleted с прекратен capture -> без автоматичен нов capture; изрично включване = нова backend проверка', async () => {
  for (const cause of ['room_deleted', 'connection_lost'] as const) {
    const h = createHarness()
    await h.connect(true)
    h.backend.generation = 2
    if (cause === 'room_deleted') h.fake.state.last().capture!.ended = true // устройството е спряло
    serverDisconnect(h.fake.state.last(), cause)
    if (cause === 'room_deleted') h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: 2, ready: true } as never)
    await h.clock.advance(5_000)
    await flush(30)
    assertEqual(s(h).status, 'connected_listening', `${cause}: слушане`)
    assertEqual(h.fake.state.getUserMediaCalls, 1, `${cause}: без нов capture`)
    assertEqual(h.fake.state.violations, 0, `${cause}: ≤1 стая`)
    const checks = h.posts.filter((p) => p.path === '/api/voice/speak-access').length
    h.voice.enableMicrophone()
    await flush(20)
    assertEqual(h.posts.filter((p) => p.path === '/api/voice/speak-access').length, checks + 1, `${cause}: backend проверка`)
    assertEqual(s(h).status, 'connected_speaking', `${cause}: изрично включване`)
  }
})

// ═══ ROOM_DELETED и ред на събитията при ротация ══════════════════════════

const tableUpdated = (generation: number, ready: boolean) =>
  ({ type: 'voice_table_updated', voiceTableId: TABLE, generation, ready }) as never

await check('[RD1] ROOM_DELETED ПРЕДИ voice_table_updated: живият capture се запазва и публикува в новата генерация (без нов getUserMedia, една ротация)', async () => {
  for (const sequence of ['deleted>notReady>ready', 'deleted>ready', 'deleted>ready>notReady(късно)'] as const) {
    const h = createHarness({ facade: true })
    await h.connect(true)
    const first = h.fake.state.last()
    const capture = first.capture
    h.backend.generation = 2
    h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 5000 } })
    serverDisconnect(first, 'room_deleted')
    await flush(10)
    assertEqual(s(h).status, 'rotating', `${sequence}: rotating`)
    assertEqual(h.voice.debugCounters().retainedMicrophone, 1, `${sequence}: capture-ът е запазен`)
    if (sequence === 'deleted>notReady>ready') h.voice.handleServerMessage(tableUpdated(2, false))
    h.voice.handleServerMessage(tableUpdated(2, true))
    await flush(30)
    if (sequence === 'deleted>ready>notReady(късно)') {
      h.voice.handleServerMessage(tableUpdated(2, false)) // закъсняло съобщение за вече активната генерация
      await flush(30)
    }
    const last = h.fake.state.last()
    assertEqual(s(h).status, 'connected_speaking', `${sequence}: говори`)
    assert(last.capture === capture && last.micLive, `${sequence}: същият capture`)
    assertEqual(h.fake.state.getUserMediaCalls, 1, `${sequence}: без нов getUserMedia`)
    assertEqual(h.fake.state.liveCaptures(), 1, `${sequence}: един capture`)
    assertEqual(h.fake.state.violations, 0, `${sequence}: ≤1 стая`)
    assertEqual(h.voice.debugCounters().rotations, 1, `${sequence}: една ротация`)
    assertEqual(h.fake.state.rooms.length, 2, `${sequence}: точно една нова стая`)
  }
})

await check('[RD2] voice_table_updated ПРЕДИ ROOM_DELETED: закъснелият ROOM_DELETED на старата стая не отменя запазването и не стартира втора ротация', async () => {
  const h = createHarness({ facade: true })
  await h.connect(true)
  const first = h.fake.state.last()
  const capture = first.capture
  h.backend.generation = 2
  h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 5000 } })
  h.voice.handleServerMessage(tableUpdated(2, false))
  await flush(10)
  assertEqual(h.voice.debugCounters().retainedMicrophone, 1, 'capture-ът е откачен и запазен')
  // Старата стая получава ROOM_DELETED (вече без наш capture) + симулиран
  // остарял handle — трябва само да се освободи.
  const stray: FakeCapture = { id: 999, stopped: false, ended: false }
  first.events.onDisconnected('room_deleted', first.retain(stray))
  first.events.onDisconnected('room_deleted', null)
  await flush(10)
  assertEqual(stray.stopped, true, 'остарелият handle е освободен')
  assertEqual(h.voice.debugCounters().rotations, 1, 'една ротация')
  assertEqual(h.voice.debugCounters().retainedMicrophone, 1, 'запазването не е отменено')
  h.voice.handleServerMessage(tableUpdated(2, true))
  await flush(30)
  assertEqual(s(h).status, 'connected_speaking', 'говори')
  assert(h.fake.state.last().capture === capture, 'същият capture')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов getUserMedia')
  assertEqual(h.fake.state.liveCaptures(), 1, 'един capture')
})

await check('[RD3] ROOM_DELETED първо + mute / край на масата / напускане / доброволно изключен / слушател -> без запазване, без нов capture', async () => {
  for (const variant of ['mute', 'table_released', 'leave', 'voluntarily_off', 'listener', 'timeout'] as const) {
    const h = createHarness()
    await h.connect(variant !== 'listener')
    if (variant === 'voluntarily_off') {
      h.voice.disableMicrophone()
      await flush()
    }
    h.backend.generation = 2
    for (let index = 0; index < 6; index += 1) h.backend.tokenQueue.push({ status: 503, body: { ok: false, code: 'voice_rotation_pending', retryAfterMs: 5000 } })
    serverDisconnect(h.fake.state.last(), 'room_deleted')
    await flush(10)
    if (variant === 'mute') {
      h.backend.speak = MUTED
      h.voice.handleServerMessage({ type: 'voice_speak_access_updated', voiceTableId: TABLE, speak: MUTED } as never)
    }
    if (variant === 'table_released') h.voice.handleServerMessage({ type: 'voice_access_ended', voiceTableId: TABLE, reason: 'table_released' } as never)
    if (variant === 'leave') h.voice.leaveVoice()
    if (variant === 'timeout') await h.clock.advance(20_000)
    await flush(10)
    assertEqual(h.fake.state.liveCaptures(), 0, `${variant}: няма активен capture`)
    h.backend.tokenQueue.length = 0
    h.voice.handleServerMessage(tableUpdated(2, true))
    await h.clock.advance(10_000)
    await flush(30)
    assertEqual(h.fake.state.getUserMediaCalls, variant === 'listener' ? 0 : 1, `${variant}: без нов getUserMedia`)
    assertEqual(h.fake.state.liveCaptures(), 0, `${variant}: без capture след ротацията`)
    if (variant === 'mute') assertEqual(s(h).status, 'connected_muted', 'наказаният остава слушател')
    if (variant === 'table_released') assertEqual(s(h).status, 'disabled', 'край на масата')
    if (variant === 'leave') assertEqual(s(h).status, 'idle', 'напуснал гласа')
    if (variant === 'voluntarily_off' || variant === 'listener' || variant === 'timeout') assertEqual(s(h).status, 'connected_listening', `${variant}: слушане`)
  }
})

await check('[RD4] Временен LiveKit reconnect (Reconnecting -> Reconnected) запазва микрофона без нов capture', async () => {
  const h = createHarness({ facade: true })
  await h.connect(true)
  const room = h.fake.state.last()
  room.events.onReconnecting()
  assertEqual(s(h).microphone, 'live', 'микрофонът остава по време на reconnect')
  room.events.onReconnected()
  assertEqual(s(h).status, 'connected_speaking', 'говори')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без нов capture')
  assertEqual(h.fake.state.rooms.length, 1, 'същата стая')
  // Адаптерът сигнализира изгубен capture след неуспешна повторна публикация.
  room.events.onLocalMicrophoneLost()
  assertEqual(s(h).status, 'connected_listening', 'слушане')
  assertEqual(h.fake.state.getUserMediaCalls, 1, 'без автоматичен нов capture')
})

await check('[RM8] Инвариант ≤1 стая при бързи join -> leave -> join (асинхронен disconnect)', async () => {
  const h = createHarness({ facade: true })
  await h.connect(false)
  for (let index = 0; index < 5; index += 1) {
    h.voice.leaveVoice()
    h.voice.joinAsListener() // в същия tick — старата стая още се изключва
  }
  await flush(40)
  assertEqual(h.fake.state.violations, 0, 'никога две стаи')
  assertEqual(h.fake.state.activeRooms(), 1, 'една активна стая')
  assertEqual(s(h).status, 'connected_listening', 'свързан')
  // Бавен disconnect (мрежа): новата стая чака старата, вместо да се провали.
  let release: () => void = () => {}
  h.fake.state.disconnectGate = new Promise<void>((resolve) => { release = resolve })
  h.voice.leaveVoice()
  h.voice.joinAsListener()
  await flush(40)
  assertEqual(s(h).status, 'connecting', 'чака старата стая')
  assertEqual(h.fake.state.violations, 0, 'без втора стая докато старата се изключва')
  h.fake.state.disconnectGate = null
  release()
  await flush(40)
  assertEqual(s(h).status, 'connected_listening', 'свързан след изключването на старата')
  assertEqual(h.fake.state.activeRooms(), 1, 'една активна стая')
  // Ротация с бавен disconnect: същото за новата генерация.
  let releaseRotation: () => void = () => {}
  h.fake.state.disconnectGate = new Promise<void>((resolve) => { releaseRotation = resolve })
  await rotate(h, 2)
  assertEqual(s(h).status, 'rotating', 'чака старата стая')
  h.fake.state.disconnectGate = null
  releaseRotation()
  await flush(40)
  assertEqual(s(h).status, 'connected_listening', 'новата генерация')
  assertEqual(h.fake.state.violations, 0, 'никога две стаи')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

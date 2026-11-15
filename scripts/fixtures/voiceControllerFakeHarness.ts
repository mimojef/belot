// Общ тестов харнес за гласовия контролер: истинският createVoiceController
// (и lazy facade-ът) срещу FAKE LiveKit адаптер с отделно придобиване на
// микрофона, ръчен часовник и fake backend (presence/token/speak-access).
// Без браузър, без livekit-client, без мрежа. Ползва се от
// checkVoiceMicAcquisition.ts и checkVoiceSessionEndDiagnostics.ts.

import { createVoiceController, type VoiceContext, type VoiceController, type VoiceSnapshot } from '../../src/app/voice/createVoiceController'
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
} from '../../src/app/voice/voiceAdapter'
import { createLazyVoiceController } from '../../src/app/voice/voiceFacade'
import type { VoicePresenceClientMessage, VoiceSpeakState } from '../../src/app/voice/voiceProtocol'

export const flush = async (rounds = 12): Promise<void> => {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

// ─── Ръчен часовник ───────────────────────────────────────────────────────
export function createClock() {
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
export type FakeCapture = { id: number; stopped: boolean; ended: boolean }
export type PublishStep = 'ok' | 'sdk_reconnect_cancel' | 'fail_timeout' | 'fail_not_permitted'

export type FakeRoom = VoiceConnectedRoom & {
  events: VoiceAdapterEvents
  connected: boolean
  disconnected: boolean
  micLive: boolean
  capture: FakeCapture | null
  publishes: number
}

export function createFakeAdapter() {
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
export function serverDisconnect(room: FakeRoom, cause: VoiceDisconnectCause): void {
  room.disconnected = true
  const capture = room.capture
  const wasLive = room.micLive
  room.micLive = false
  room.capture = null
  if (capture !== null && !(cause === 'room_deleted' && wasLive)) capture.stopped = true
  room.events.onDisconnected(cause, null, cause === 'room_deleted' ? 'room_deleted' : 'network')
}

// ─── Fake backend ─────────────────────────────────────────────────────────
export const TABLE = '11111111-2222-4333-8444-555555555555'
export const TABLE_B = '99999999-2222-4333-8444-555555555555'
export const JWT_MARK = 'eyJFAKE.secret-token-value.sig'
export const SPEAK: VoiceSpeakState = { canSpeak: true, blockedReason: null, hasSpeakingEntitlement: true, mutedUntil: null }
export const MUTED: VoiceSpeakState = { canSpeak: false, blockedReason: 'muted', hasSpeakingEntitlement: true, mutedUntil: '2027-01-01T00:00:00.000Z' }
export const SEATS = [
  { profileId: 'self', isBot: false },
  { profileId: 'alice', isBot: false },
  { profileId: 'bob', isBot: false },
  { profileId: null, isBot: true },
]
/** Поканен играч — седнал на друго място на чужда маса. */
export const INVITED_SEATS = [
  { profileId: 'host', isBot: false },
  { profileId: 'self', isBot: false },
  { profileId: null, isBot: true },
  { profileId: null, isBot: true },
]

export type Harness = {
  voice: VoiceController
  clock: ReturnType<typeof createClock>
  fake: ReturnType<typeof createFakeAdapter>
  backend: {
    speak: VoiceSpeakState
    generation: number
    tokenGate: Promise<void> | null
    /** null -> успешен ack; код -> отказ; 'silent' -> без отговор (ack timeout). */
    presenceFailure: string | null
    /** Следващите отговори за токен (статус/код); празно -> успех. */
    tokenFailures: Array<{ status: number; code: string }>
  }
  reports: VoiceDiagnosticReport[]
  /** Всички изпратени voice_presence (вкл. причината при onTableScreen:false). */
  presence: VoicePresenceClientMessage[]
  trace: string[]
  ctx: (screen?: 'waiting' | 'game' | 'off_table', seats?: typeof SEATS, tableId?: string) => VoiceContext
  lazyLoads: () => number
}

export function createHarness(options: { facade?: boolean } = {}): Harness {
  const clock = createClock()
  const fake = createFakeAdapter()
  const reports: VoiceDiagnosticReport[] = []
  const trace: string[] = []
  const backend: Harness['backend'] = { speak: SPEAK, generation: 1, tokenGate: null, presenceFailure: null, tokenFailures: [] }
  const presence: VoicePresenceClientMessage[] = []
  let lazyLoads = 0
  let voice!: VoiceController
  const sendPresence = (message: VoicePresenceClientMessage): boolean => {
    presence.push(message)
    if (backend.presenceFailure === 'silent') return true
    queueMicrotask(() => {
      voice.handleServerMessage(backend.presenceFailure === null
        ? { type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: true, onTableScreen: message.onTableScreen, leaseTtlMs: 60_000, renewAfterMs: 20_000, ready: true, speak: backend.speak } as never
        : { type: 'voice_presence_result', voiceTableId: message.voiceTableId, ok: false, code: backend.presenceFailure } as never)
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
        const failure = backend.tokenFailures.shift()
        if (failure !== undefined) return { status: failure.status, body: { ok: false, code: failure.code } }
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
  return { voice, clock, fake, backend, reports, presence, trace, ctx, lazyLoads: () => lazyLoads }
}

export const snap = (h: Harness): VoiceSnapshot => h.voice.getSnapshot()

/** Отваря „прозореца за разрешение“: getUserMedia виси до release(). */
export function holdPermission(h: Harness): () => Promise<void> {
  let release!: () => void
  h.fake.state.micGate = new Promise<void>((resolve) => { release = resolve })
  return async () => {
    h.fake.state.micGate = null
    release()
    await flush(30)
  }
}

export async function joinWithMic(h: Harness, ctx = h.ctx('waiting')): Promise<void> {
  h.voice.setContext(ctx)
  await flush()
  h.voice.joinWithMicrophone()
  await flush(30)
}

export async function rotate(h: Harness): Promise<void> {
  h.backend.generation += 1
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: false } as never)
  await flush(30)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
}

export async function loseConnection(h: Harness): Promise<void> {
  serverDisconnect(h.fake.state.last(), 'connection_lost')
  await flush()
  await h.clock.advance(2_000)
  await flush(30)
}

export async function deleteRoom(h: Harness): Promise<void> {
  h.backend.generation += 1
  serverDisconnect(h.fake.state.last(), 'room_deleted')
  await flush(30)
  h.voice.handleServerMessage({ type: 'voice_table_updated', voiceTableId: TABLE, generation: h.backend.generation, ready: true } as never)
  await flush(30)
}

export const micAttempts = (h: Harness) => h.reports.filter((r): r is Extract<VoiceDiagnosticReport, { event: 'mic_attempt' }> => r.event === 'mic_attempt')

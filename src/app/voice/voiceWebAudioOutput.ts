// Гласов чат — W1 (ЕКСПЕРИМЕНТАЛНО, изключено по подразбиране): входящото
// аудио през Web Audio (LiveKit webAudioMix) вместо през <audio> елементите.
//
// Кой го получава (сървърен kill switch с абсолютен приоритет, само Android
// PWA, изброен профил или локален тестов ключ само на localhost) — виж
// voiceExperimentalAudioConfig.ts. Иначе: сегашният елементен механизъм.
//
// Какво прави модулът (виж W0 — scripts/checkVoiceWebAudioMixE2E.ts):
//  - НАШ AudioContext за всяка стая (webAudioMix: { audioContext }) — SDK-то
//    никога не го затваря; затваряме го ние (dispose) при край на стаята;
//  - подклас, чийто createGain() започва от 0: SDK-то създава нов GainNode
//    при всяко свързване на графа (абонамент, H2/H4, reconnect, смяна на
//    контекста) и после го насочва плавно към силата на участника; от 1 това
//    пуска ~200 ms звук от локално заглушен участник, от 0 — нищо;
//  - възстановяване САМО по събития (statechange / видимост / жест), без
//    watchdog: едно resume() на епизод на спиране; неуспех -> „Включи звука“;
//  - ИЗОЛИРАНА смяна на неочаквано затворен контекст (разчита на
//    НЕДОКУМЕНТИРАНО поведение на livekit-client 2.23.0: room.options пази
//    референцията към webAudioMix обекта, а startAudio() -> acquireAudioContext
//    премества графите на всички входящи tracks в новия контекст);
//  - една операция наведнъж; изчаква ръчното H4 („Възстанови звука“).

// Кой получава режима (kill switch, профил, локален тестов ключ) —
// voiceExperimentalAudioConfig.ts.
export type VoiceIncomingAudioMode = 'element' | 'webaudio'

/** Диагностика (затворени стойности; виж server voiceClientDiagnostics VOICE_MEDIA_CONTEXT_*). */
export type VoiceMediaContextState = 'running' | 'suspended' | 'interrupted' | 'closed' | 'unsupported'
export type VoiceMediaContextAction = 'start' | 'resume' | 'replace' | 'gesture'
export type VoiceMediaContextResult = 'success' | 'failed' | 'blocked' | 'limited'
export type VoiceMediaContextReport = { event: 'media_context'; state: VoiceMediaContextState; action: VoiceMediaContextAction; result: VoiceMediaContextResult }

/** Колко чакаме resume() (неотговорен resume не държи операцията — после „Включи звука“). */
export const VOICE_CONTEXT_RESUME_TIMEOUT_MS = 1_500
/** Автоматични смени на затворен контекст за една стая (след това — само с жест). */
export const VOICE_CONTEXT_REPLACE_LIMIT = 2

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

/** Подклас на подадения AudioContext с createGain() от 0 (кешира се по базов клас). */
const zeroGainClasses = new WeakMap<AudioContextCtor, AudioContextCtor>()
export function zeroGainAudioContextClass(Base: AudioContextCtor): AudioContextCtor {
  let Zero = zeroGainClasses.get(Base)
  if (Zero === undefined) {
    Zero = class extends Base {
      override createGain(): GainNode {
        const gain = super.createGain()
        gain.gain.value = 0
        return gain
      }
    }
    zeroGainClasses.set(Base, Zero)
  }
  return Zero
}

export type VoiceWebAudioOutputDeps = {
  /** Базовият клас (window.AudioContext); null/undefined -> неподдържано. */
  AudioContextClass: AudioContextCtor | null | undefined
  report: (report: VoiceMediaContextReport) => void
  /** Промяна на blocked() — адаптерът преизчислява canPlayback и уведомява контролера. */
  onBlockedChange: () => void
  /** Стаята е свързана (не reconnect, не затворена). */
  isRoomConnected: () => boolean
  /** Текущото ръчно H4 (Promise) или null — възстановяването го изчаква. */
  incomingRestore: () => Promise<unknown> | null
  /** room.startAudio() — при смяна SDK-то премества графите в новия контекст. */
  startAudio: () => Promise<void>
  isPageVisible: () => boolean
  doc?: Pick<Document, 'addEventListener' | 'removeEventListener'>
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export type VoiceWebAudioOutput = {
  /** Подава се като RoomOptions.webAudioMix (СЪЩИЯТ обект за целия живот на стаята). */
  readonly settings: { audioContext: AudioContext }
  /** Звукът е спрян и автоматичното възстановяване не успя — чака жест („Включи звука“). */
  blocked: () => boolean
  /** Операция по възстановяване в ход (Promise) или null. */
  idle: () => Promise<void>
  /** Стаята е свързана (след connect / Reconnected) — отложена смяна, начален отчет. */
  onConnected: (initial: boolean) => void
  /** Жест („Включи звука“): смяна при затворен контекст, иначе resume. */
  gesture: () => Promise<void>
  /** Край на стаята: умишлено затваряне — НИКОГА нов контекст след това. Идемпотентно. */
  dispose: () => void
  debug: () => Record<string, number>
}

const CONTEXT_STATE_CODE: Record<string, number> = { running: 0, suspended: 1, interrupted: 2, closed: 3 }

/** null -> AudioContext не е наличен/не може да се създаде (адаптерът остава на елементите). */
export function createVoiceWebAudioOutput(deps: VoiceWebAudioOutputDeps): VoiceWebAudioOutput | null {
  const Base = deps.AudioContextClass
  if (Base === null || Base === undefined) return null
  const Zero = zeroGainAudioContextClass(Base)
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  const counters = {
    created: 0, closedByUs: 0, resumes: 0, resumeSuccess: 0, resumeFailed: 0,
    replaces: 0, replaceSuccess: 0, replaceFailed: 0, replaceLimited: 0, gestures: 0, deferred: 0,
  }
  let disposed = false
  let blocked = false
  /** Автоматичното resume за текущия епизод на спиране вече е изпитано (нулира се при 'running'). */
  let resumeSpent = false
  /** Затворен контекст, докато стаята не е свързана — смяната чака onConnected. */
  let replacePending = false
  let replacesUsed = 0
  let op: Promise<void> | null = null
  let connectedOnce = false

  function makeContext(): AudioContext | null {
    try {
      const ctx = new Zero({ latencyHint: 'interactive' })
      counters.created += 1
      ctx.addEventListener('statechange', () => onStateChange(ctx))
      return ctx
    } catch {
      return null
    }
  }

  const first = makeContext()
  if (first === null) return null
  const settings = { audioContext: first }
  const doc = deps.doc ?? document

  const stateOf = (ctx: AudioContext): VoiceMediaContextState => {
    const state = ctx.state as string
    return state === 'running' || state === 'suspended' || state === 'interrupted' || state === 'closed' ? state : 'suspended'
  }

  function setBlocked(value: boolean): void {
    if (blocked === value) return
    blocked = value
    deps.onBlockedChange()
  }

  function closeQuietly(ctx: AudioContext): void {
    if ((ctx.state as string) === 'closed') return
    counters.closedByUs += 1
    ctx.close().catch(() => {})
  }

  /** Една операция наведнъж; след нея — още една оценка на текущото състояние. */
  function run(task: () => Promise<void>): Promise<void> {
    if (op !== null) return op
    const current = (async () => {
      try {
        // Ръчното H4 пресъздава елементите (и графа) — първо то.
        const restore = deps.incomingRestore()
        if (restore !== null) {
          counters.deferred += 1
          await restore.catch(() => {})
        }
        if (!disposed) await task()
      } catch {
        /* всяка грешка е вече отчетена в задачата */
      }
    })()
    const tracked: Promise<void> = current.finally(() => {
      if (op === tracked) op = null
      if (!disposed) evaluate()
    })
    op = tracked
    return tracked
  }

  function onStateChange(ctx: AudioContext): void {
    if (disposed || ctx !== settings.audioContext) return
    if ((ctx.state as string) === 'running') {
      resumeSpent = false
      setBlocked(false)
      return
    }
    evaluate()
  }

  /** Решение по текущото състояние (само при събитие; без повторение по таймер). */
  function evaluate(): void {
    if (disposed || op !== null) return
    const ctx = settings.audioContext
    const state = ctx.state as string
    if (state === 'running') return
    if (state === 'closed') {
      if (!deps.isRoomConnected()) {
        replacePending = true
        return
      }
      // Неуспешна смяна -> чака жест (без автоматични повторения една след друга).
      if (blocked) return
      if (replacesUsed >= VOICE_CONTEXT_REPLACE_LIMIT) {
        counters.replaceLimited += 1
        deps.report({ event: 'media_context', state: 'closed', action: 'replace', result: 'limited' })
        setBlocked(true)
        return
      }
      replacesUsed += 1
      void run(() => replaceClosedContext('replace'))
      return
    }
    // suspended / interrupted: само при видима страница и свързана стая; едно resume на епизод.
    if (blocked || resumeSpent || !deps.isPageVisible() || !deps.isRoomConnected()) return
    resumeSpent = true
    void run(() => resumeContext(ctx, 'resume'))
  }

  function withTimeout(promise: Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimer(() => resolve(), VOICE_CONTEXT_RESUME_TIMEOUT_MS)
      promise.then(() => { clearTimer(timer); resolve() }, () => { clearTimer(timer); resolve() })
    })
  }

  async function resumeContext(ctx: AudioContext, action: 'resume' | 'gesture'): Promise<void> {
    const before = stateOf(ctx)
    counters.resumes += 1
    await withTimeout(ctx.resume())
    if (disposed || ctx !== settings.audioContext) return
    // Затворен междувременно -> не е „неуспешно resume“: оценката след операцията го сменя.
    if ((ctx.state as string) === 'closed') return
    if ((ctx.state as string) === 'running') {
      counters.resumeSuccess += 1
      resumeSpent = false
      setBlocked(false)
      deps.report({ event: 'media_context', state: before, action, result: 'success' })
      return
    }
    counters.resumeFailed += 1
    deps.report({ event: 'media_context', state: before, action, result: action === 'resume' ? 'blocked' : 'failed' })
    setBlocked(true)
  }

  /**
   * ИЗОЛИРАНО (недокументирано поведение на SDK-то): нов контекст в СЪЩИЯ
   * webAudioMix обект -> room.startAudio() -> SDK-то го приема и премества
   * графите. Микрофонът, абонаментите и стаята не се пипат. Никога след dispose.
   */
  async function replaceClosedContext(action: 'replace' | 'gesture'): Promise<void> {
    if (disposed) return
    counters.replaces += 1
    const fresh = makeContext()
    if (fresh === null) {
      counters.replaceFailed += 1
      deps.report({ event: 'media_context', state: 'closed', action, result: 'failed' })
      setBlocked(true)
      return
    }
    settings.audioContext = fresh
    resumeSpent = false
    let startFailed = false
    try {
      await deps.startAudio()
    } catch {
      startFailed = true
    }
    if (disposed) {
      // Стаята приключи по време на смяната: новият контекст не остава.
      closeQuietly(fresh)
      return
    }
    if (settings.audioContext !== fresh) return
    if (!startFailed && (fresh.state as string) === 'running') {
      counters.replaceSuccess += 1
      setBlocked(false)
      deps.report({ event: 'media_context', state: 'closed', action, result: 'success' })
      return
    }
    counters.replaceFailed += 1
    deps.report({ event: 'media_context', state: 'closed', action, result: action === 'replace' ? 'blocked' : 'failed' })
    setBlocked(true)
  }

  const onVisibility = (): void => {
    if (deps.isPageVisible()) evaluate()
  }
  doc.addEventListener('visibilitychange', onVisibility)

  return {
    settings,
    blocked: () => blocked,
    idle: () => op ?? Promise.resolve(),
    onConnected(initial) {
      if (disposed) return
      if (initial && !connectedOnce) {
        connectedOnce = true
        deps.report({ event: 'media_context', state: stateOf(settings.audioContext), action: 'start', result: 'success' })
      }
      if (replacePending) replacePending = false
      evaluate()
    },
    async gesture() {
      if (disposed) return
      counters.gestures += 1
      await (op ?? Promise.resolve())
      if (disposed) return
      const ctx = settings.audioContext
      const state = ctx.state as string
      if (state === 'running') {
        setBlocked(false)
        return
      }
      // Жестът не е ограничен от автоматичния лимит (всяко натискане е изрично).
      await run(() => (state === 'closed' ? replaceClosedContext('gesture') : resumeContext(ctx, 'gesture')))
    },
    dispose() {
      if (disposed) return
      disposed = true
      replacePending = false
      doc.removeEventListener('visibilitychange', onVisibility)
      closeQuietly(settings.audioContext)
      if (blocked) blocked = false
    },
    debug: () => ({
      audioMode: 1,
      ctxState: CONTEXT_STATE_CODE[settings.audioContext.state as string] ?? -1,
      ctxBlocked: blocked ? 1 : 0,
      ctxBusy: op === null ? 0 : 1,
      ctxCreated: counters.created,
      ctxClosedByUs: counters.closedByUs,
      ctxResumes: counters.resumes,
      ctxResumeSuccess: counters.resumeSuccess,
      ctxResumeFailed: counters.resumeFailed,
      ctxReplaces: counters.replaces,
      ctxReplaceSuccess: counters.replaceSuccess,
      ctxReplaceFailed: counters.replaceFailed,
      ctxReplaceLimited: counters.replaceLimited,
      ctxGestures: counters.gestures,
      ctxDeferredForRestore: counters.deferred,
    }),
  }
}

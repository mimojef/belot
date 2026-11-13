// Гласов чат — минимален посредник в ОСНОВНИЯ bundle (Етап 3).
//
// Имплементира същия типизиран VoiceController, но истинският controller
// (заедно с livekit-client) е в lazy chunk-а assets/voice-* (voiceRuntime.ts)
// и се зарежда САМО при изрично действие („Само слушай“ / „Включи микрофона“).
// Обикновени маси, voice OFF, лоби и сядане на гласова маса -> нищо не се
// зарежда, не се праща presence и няма таймери.
//
// Преди зареждането посредникът пази само: последния контекст, състоянието на
// игровия WS и намерението за включване (индивидуалното заглушаване става
// достъпно след включване — дотогава участниците в гласа са неизвестни). След
// зареждането подава на controller-а АКТУАЛНИЯ контекст (не този от момента
// на натискането), а намерението се изпълнява само ако е още валидно — всяко
// напускане/смяна на масата/лоби/бан/изместена сесия/voice_access_ended
// междувременно го отменя. Оттам нататък всичко се предава 1:1.
//
// Тук има само `import type` — runtime кодът на гласа не влиза в основния bundle.

import type { VoiceContext, VoiceController, VoiceSnapshot } from './createVoiceController'
import type { VoiceRuntimeDeps } from './voiceRuntime'

export type VoiceControllerFactory = (deps: VoiceRuntimeDeps) => VoiceController

export type VoiceFacadeDeps = VoiceRuntimeDeps & {
  /** Само за тестове; по подразбиране dynamic import на voiceRuntime. */
  loadController?: () => Promise<VoiceControllerFactory>
}

type TableContext = Extract<VoiceContext, { kind: 'table' }>
type PendingJoin = { withMic: boolean; table: TableContext } | null

const VOICE_SERVER_TYPES = new Set(['voice_presence_result', 'voice_table_updated', 'voice_access_ended', 'voice_speak_access_updated'])

/** Полетата, които преди зареждането винаги са по подразбиране. */
const IDLE_FIELDS = {
  speak: null, microphone: 'off', playbackBlocked: false, canRestore: false, microphoneDevicesChanged: false,
  generation: null, locallyMutedProfileIds: [], speakingProfileIds: [],
} as const

const sameTable = (a: TableContext | null, b: TableContext | null): boolean =>
  a !== null && b !== null && a.voiceTableId === b.voiceTableId && a.selfProfileId === b.selfProfileId

function sameContext(a: VoiceContext, b: VoiceContext): boolean {
  if (a.kind === 'none' || b.kind === 'none') return a.kind === b.kind
  return sameTable(a, b) && a.screen === b.screen && a.seats.length === b.seats.length
    && a.seats.every((seat, index) => seat.profileId === b.seats[index]!.profileId && seat.isBot === b.seats[index]!.isBot)
}

export function createLazyVoiceController(deps: VoiceFacadeDeps): VoiceController {
  const load = deps.loadController ?? (() => import('./voiceRuntime').then((module) => module.createVoiceRuntime))
  let context: VoiceContext = { kind: 'none' }
  let real: VoiceController | null = null
  let gameConnected = true
  let loading = false
  let loadFailed = false
  let disposed = false
  let offerDismissed = false
  let lastWithMic = false
  let pending: PendingJoin = null
  let cached: VoiceSnapshot | null = null
  const listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  const speakingListeners = new Set<(profileIds: readonly string[]) => void>()

  const table = (): TableContext | null => (context.kind === 'table' ? context : null)
  const onScreen = (current: TableContext | null): current is TableContext => current !== null && current.screen !== 'off_table'

  function emit<T>(targets: Set<(value: T) => void>, value: T): void {
    for (const listener of [...targets]) {
      try { listener(value) } catch { /* изолация на слушателите */ }
    }
  }

  function changed(): void {
    cached = null
    emit(listeners, getSnapshot())
  }

  function setPending(next: PendingJoin): void {
    if (next === pending) return
    pending = next
    changed()
  }

  function getSnapshot(): VoiceSnapshot {
    if (real !== null) return real.getSnapshot()
    const current = table()
    return cached ??= {
      ...IDLE_FIELDS,
      status: current === null ? 'disabled' : pending !== null ? 'connecting' : loadFailed ? 'unavailable' : 'idle',
      voiceTableId: current?.voiceTableId ?? null,
      screen: current?.screen ?? null,
      wantsToSpeak: pending?.withMic ?? false,
      uiError: loadFailed && current !== null ? { code: 'service_unavailable', message: 'Гласовият чат временно е недостъпен.', detail: null } : null,
      offerDismissed,
      // Неизвестно (не „изключено“) — както в controller-а преди свързване.
      participants: (current?.seats ?? []).flatMap((seat) => (seat.isBot || seat.profileId === null ? [] : [{
        profileId: seat.profileId, isSelf: seat.profileId === current!.selfProfileId, voiceConnected: null, microphonePublished: null,
        speaking: false, listening: null, locallyMuted: false, unknown: true,
      }])),
    }
  }

  function activate(factory: VoiceControllerFactory): void {
    const controller = factory({ sendPresence: deps.sendPresence, apiBaseUrl: deps.apiBaseUrl, onRequestVip: deps.onRequestVip })
    // Само актуалното състояние — нищо остаряло от момента на натискането.
    if (!gameConnected) controller.setGameConnection(false)
    controller.setContext(context)
    if (offerDismissed) controller.notNow()
    controller.subscribe((snapshot) => emit(listeners, snapshot))
    controller.subscribeSpeaking((profileIds) => emit(speakingListeners, profileIds))
    real = controller
    const intent = pending
    pending = null
    const current = table()
    if (intent !== null && onScreen(current) && sameTable(current, intent.table)) join(intent.withMic)
    else emit(listeners, controller.getSnapshot())
  }

  function join(withMic: boolean): void {
    if (disposed) return
    if (real !== null) {
      // Вече зареден: синхронно, в същия потребителски жест (autoplay).
      if (withMic) real.joinWithMicrophone()
      else real.joinAsListener()
      return
    }
    const current = table()
    if (!onScreen(current)) return
    lastWithMic = withMic
    loadFailed = false
    offerDismissed = true
    cached = null
    setPending({ withMic, table: current })
    if (loading) return // двойно натискане -> едно зареждане
    loading = true
    load().then(
      (factory) => {
        loading = false
        if (!disposed && real === null) activate(factory)
      },
      () => {
        // Неуспешното зареждане не се кешира (import() опитва отново).
        loading = false
        if (disposed || pending === null) return
        loadFailed = true
        setPending(null)
      },
    )
  }

  return {
    setContext(next) {
      if (disposed || sameContext(context, next)) return
      const previous = table()
      context = next
      if (real !== null) return real.setContext(next)
      if (!sameTable(previous, table())) {
        offerDismissed = false
        loadFailed = false
        pending = null
      } else if (!onScreen(table())) {
        pending = null
      }
      changed()
    },
    handleServerMessage(message) {
      if (!VOICE_SERVER_TYPES.has(message.type)) return false
      if (real !== null) return real.handleServerMessage(message)
      if (message.type === 'voice_access_ended') setPending(null)
      return true
    },
    setGameConnection(connected) {
      gameConnected = connected
      real?.setGameConnection(connected)
    },
    endSession(reason) {
      if (real !== null) return real.endSession(reason)
      loadFailed = false
      pending = null
      changed()
    },
    onPageHide: () => (real !== null ? real.onPageHide() : setPending(null)),
    onPageShow: (persisted) => real?.onPageShow(persisted),
    joinAsListener: () => join(false),
    joinWithMicrophone: () => join(true),
    notNow() {
      if (real !== null) return real.notNow()
      offerDismissed = true
      changed()
    },
    requestVip: () => (real !== null ? real.requestVip() : deps.onRequestVip?.()),
    leaveVoice: () => (real !== null ? real.leaveVoice() : setPending(null)),
    enableMicrophone: () => (real !== null ? real.enableMicrophone() : join(true)),
    // Изключване по време на зареждането: включването продължава само като слушане.
    disableMicrophone: () => (real !== null ? real.disableMicrophone() : setPending(pending?.withMic ? { ...pending, withMic: false } : pending)),
    retryMicrophone: () => (real !== null ? real.retryMicrophone() : join(true)),
    unlockAudio: () => real?.unlockAudio(),
    retryConnection: () => (real !== null ? real.retryConnection() : loadFailed ? join(lastWithMic) : undefined),
    // Преди първото включване участниците в гласа са неизвестни -> no-op.
    muteRemoteParticipant: (profileId) => real?.muteRemoteParticipant(profileId),
    unmuteRemoteParticipant: (profileId) => real?.unmuteRemoteParticipant(profileId),
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    subscribeSpeaking(listener) {
      speakingListeners.add(listener)
      return () => { speakingListeners.delete(listener) }
    },
    dispose() {
      disposed = true
      pending = null
      real?.dispose()
      listeners.clear()
      speakingListeners.clear()
    },
    debugCounters: () => ({ ...real?.debugCounters(), controllerLoaded: real === null ? 0 : 1 }),
  }
}

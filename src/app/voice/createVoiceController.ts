// Гласов чат — общ frontend controller (етап В: опростен жизнен цикъл).
//
// Един instance за цялото приложение. Живее в lazy chunk-а (voiceRuntime.ts)
// и се създава от посредника voiceFacade.ts при първото включване. Не зависи
// от DOM-а на екраните: получава КОНТЕКСТ (setContext) и сървърни съобщения,
// а LiveKit е зад VoiceAdapter. Интерфейсът само чете snapshot-а.
//
// Устройство (етап В):
//   * ЖЕЛАНО състояние (намерение): wantVoice (участие) и wantMic (говорене).
//     Променя се САМО от изрични действия на потребителя и от потвърдена
//     загуба на права. Техническо прекъсване (мрежа, рестарт на LiveKit,
//     ротация, отказан токен, изтрита стая) НЕ го променя.
//   * ДЕЙСТВИТЕЛНО състояние: LiveKit стаята (room), състоянието на връзката
//     (link), публикуваният микрофон (microphone) и задържаният capture (held).
//   * ЕДИН ДВИГАТЕЛ (drive -> step) привежда действителното към желаното.
//     Само той създава и затваря LiveKit стаи и публикува микрофона, по една
//     операция наведнъж — две едновременни LiveKit връзки са невъзможни.
//     Събитията (сървър, LiveKit, контекст) само сменят състояние и викат kick().
//   * Докато LiveKit SDK само възстановява връзката (Reconnecting), двигателят
//     НЕ започва своя операция; нова връзка — само след окончателно
//     Disconnected, ротация или изтекъл достъп.
//   * Временни грешки -> backoff (1-2-4-8-15-30 s) без край, докато
//     членството е валидно; неясно членство (not_seat_connection,
//     invalid_session) -> най-много 5 последователни опита, после спиране с
//     „Опитай отново“; потвърдена загуба на права -> спиране и изчистване.
//   * Микрофонът: getUserMedia е ОТДЕЛНО от стаята (разрешението не блокира
//     възстановяването); придобитият capture чака (≤20 s) свързана стая.
//     Нов capture БЕЗ изрично действие — само ако браузърът вече го разрешава
//     (без прозорец); иначе „Микрофонът не беше включен“ и изрично включване.
//   * Намерението се пази в sessionStorage на ТОЗИ таб (voiceIntentStore) —
//     след презареждане гласът се възстановява сам (facade).
//
// Инварианти: JWT само в локална променлива до connect; без polling и без
// автоматично повторно свързване по липса на аудиопакети.

import {
  VoiceMicrophoneError,
  type VoiceAdapter,
  type VoiceAdapterEvents,
  type VoiceAdapterLoader,
  type VoiceConnectedRoom,
  type VoiceDiagnosticReport,
  type VoiceDisconnectCause,
  type VoiceFailStage,
  type VoiceLiveKitDisconnectReason,
  type VoiceMicAttemptFailure,
  type VoiceMicAttemptResult,
  type VoiceMicGumBucket,
  type VoiceMicInterruption,
  type VoiceMicRequestSource,
  type VoicePublishErrorKind,
  type VoiceRetainedMicrophone,
  type VoiceSessionEndReason,
} from './voiceAdapter'
import { clearVoiceIntent, saveVoiceIntent } from './voiceIntentStore'
import {
  VOICE_SPEAK_ACCESS_PATH,
  VOICE_TOKEN_PATH,
  isVoiceServerMessage,
  profileIdFromVoiceIdentity,
  type VoicePresenceClientMessage,
  type VoicePresenceLeaveReason,
  type VoicePresenceResultMessage,
  type VoiceSpeakAccessResult,
  type VoiceSpeakState,
  type VoiceTokenSuccess,
} from './voiceProtocol'

// ─── Публични типове ──────────────────────────────────────────────────────

export type VoiceTableScreen = 'waiting' | 'game' | 'off_table'

export type VoiceSeatInfo = { profileId: string | null; isBot: boolean }

export type VoiceContext =
  | { kind: 'none' }
  | {
      kind: 'table'
      voiceTableId: string
      /** 'waiting'/'game' (вкл. финалния екран) = гласът е позволен; 'off_table' = лоби/магазин. */
      screen: VoiceTableScreen
      selfProfileId: string
      seats: readonly VoiceSeatInfo[]
    }

export type VoiceStatus =
  | 'disabled'
  | 'idle'
  | 'connecting'
  | 'connected_listening'
  | 'connected_speaking'
  | 'connected_muted'
  | 'reconnecting'
  | 'rotating'
  | 'disconnecting'
  | 'unavailable'
  | 'error'

export type VoiceMicrophoneState = 'off' | 'requesting' | 'live'

export type VoiceUiErrorCode =
  | 'mic_not_found'
  | 'mic_permission_denied'
  | 'mic_unavailable'
  | 'mic_blocked'
  | 'vip_required'
  | 'service_unavailable'
  /** Микрофонът не можа да бъде включен/възстановен без изрично действие. */
  | 'mic_not_enabled'

/** Безопасно за показване: никога не съдържа токени, URL-и или сурови грешки. */
export type VoiceUiError = { code: VoiceUiErrorCode; message: string; detail: string | null }

export const VOICE_UI_MESSAGES: Record<VoiceUiErrorCode, { message: string; detail: string | null }> = {
  mic_not_found: { message: 'Не е открит микрофон.', detail: 'Можете да продължите да слушате.' },
  mic_permission_denied: { message: 'Разрешете достъпа до микрофона в настройките на браузъра.', detail: 'Можете да продължите да слушате.' },
  mic_unavailable: { message: 'Микрофонът е недостъпен.', detail: 'Можете да продължите да слушате.' },
  mic_blocked: { message: 'Микрофонът е блокиран.', detail: 'Имате активно наказание за чат. Можете да слушате останалите участници.' },
  vip_required: { message: 'Говоренето е VIP привилегия.', detail: null },
  service_unavailable: { message: 'Гласовият чат временно е недостъпен.', detail: null },
  mic_not_enabled: { message: 'Микрофонът не беше включен.', detail: 'Моля, опитайте отново.' },
}

export type VoiceSeatParticipant = {
  profileId: string
  isSelf: boolean
  /** null = неизвестно (не сме свързани) — НЕ означава „изключен“. */
  voiceConnected: boolean | null
  microphonePublished: boolean | null
  speaking: boolean
  listening: boolean | null
  locallyMuted: boolean
  unknown: boolean
}

export type VoiceSnapshot = {
  status: VoiceStatus
  voiceTableId: string | null
  screen: VoiceTableScreen | null
  /** Правото за говорене от backend-а (само за този играч); null = още неизвестно. */
  speak: VoiceSpeakState | null
  wantsToSpeak: boolean
  microphone: VoiceMicrophoneState
  playbackBlocked: boolean
  uiError: VoiceUiError | null
  /** „Възстанови гласовия чат“ — гласът е бил спрян изрично (лоби/магазин), без автоматично връщане. */
  canRestore: boolean
  offerDismissed: boolean
  /** Ново аудио устройство след грешка — интерфейсът може да предложи „Опитай отново“. */
  microphoneDevicesChanged: boolean
  generation: number | null
  locallyMutedProfileIds: readonly string[]
  participants: readonly VoiceSeatParticipant[]
  speakingProfileIds: readonly string[]
}

export type VoiceController = {
  // контекст и вход
  setContext: (context: VoiceContext) => void
  handleServerMessage: (message: { type: string }) => boolean
  setGameConnection: (connected: boolean) => void
  /** Изместена сесия, бан, изтрит профил, logout — незабавен пълен cleanup. */
  endSession: (reason: 'displaced' | 'banned' | 'deleted' | 'logout') => void
  /** pagehide: страницата се скрива/затваря — връзката се затваря; намерението остава за презареждането. */
  onPageHide: () => void
  /** pageshow от bfcache: старата връзка е мъртва — възстановяване по запазеното намерение. */
  onPageShow: (persisted: boolean) => void
  // действия (от потребителски жест)
  joinAsListener: () => void
  joinWithMicrophone: () => void
  /** След презареждане в същия таб: участието и (ако е разрешено без прозорец) микрофонът. */
  resumeFromReload: (withMicrophone: boolean) => void
  notNow: () => void
  requestVip: () => void
  leaveVoice: () => void
  enableMicrophone: () => void
  disableMicrophone: () => void
  retryMicrophone: () => void
  unlockAudio: () => void
  retryConnection: () => void
  muteRemoteParticipant: (profileId: string) => void
  unmuteRemoteParticipant: (profileId: string) => void
  // четене
  getSnapshot: () => VoiceSnapshot
  subscribe: (listener: (snapshot: VoiceSnapshot) => void) => () => void
  subscribeSpeaking: (listener: (profileIds: readonly string[]) => void) => () => void
  dispose: () => void
  /** Само за тестове/диагностика (без токени). */
  debugCounters: () => Record<string, number>
}

export type VoiceTimers = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type VoiceControllerDeps = {
  loadAdapter: VoiceAdapterLoader
  /** Праща voice_presence по игровия WS; false = WS не е отворен. */
  sendPresence: (message: VoicePresenceClientMessage) => boolean
  /** HTTPS POST със съществуващата cookie сесия; хвърля при мрежова грешка. */
  postJson: (path: string, body: unknown) => Promise<{ status: number; body: unknown }>
  onRequestVip?: () => void
  /** Анонимна диагностика (best-effort); липсваща -> нищо не се изпраща. */
  reportDiagnostic?: (report: VoiceDiagnosticReport) => void
  createClientInstanceId?: () => string
  timers?: VoiceTimers
  /** Часовник за продължителността на getUserMedia (диагностика); по подразбиране Date.now. */
  now?: () => number
  log?: (line: string) => void
  /** Запис на намерението за презареждане (по подразбиране sessionStorage на таба). */
  intentStore?: { save: (intent: { voiceTableId: string; profileId: string; mic: boolean }) => void; clear: () => void }
  timing?: {
    speakingHoldMs?: number
    presenceAckTimeoutMs?: number
    defaultRenewMs?: number
    /** Максимално задържане на непубликуван capture (ротация/прекъсване). */
    retainMicMaxMs?: number
    /** Паузи между опитите за свързване при временни грешки (последната се повтаря). */
    backoffMs?: readonly number[]
    /** Последователни опити при неясно членство (not_seat_connection, invalid_session…). */
    uncertainMaxAttempts?: number
    /** Колко дълго временна липса на контекст (snapshot) не прекратява гласа. */
    contextGraceMs?: number
    /** Остарели (етап Б) — игнорират се. */
    disconnectGraceMs?: number
    tokenMaxAttempts?: number
    tokenBaseDelayMs?: number
    tokenMaxDelayMs?: number
    reconnectDelaysMs?: readonly number[]
  }
}

// ─── Имплементация ────────────────────────────────────────────────────────

function defaultClientInstanceId(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  let text = ''
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0')
  return `v${text}`
}

const defaultTimers: VoiceTimers = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Потвърдена загуба на права — без повторни опити. */
const TERMINAL_PRESENCE_CODES = new Set(['voice_off', 'not_authenticated', 'table_not_found', 'table_released', 'not_a_player', 'banned'])
const TERMINAL_TOKEN_CODES = new Set(['voice_off', 'not_authenticated', 'table_not_found', 'table_released', 'spectator', 'bot', 'not_a_player', 'wrong_table', 'permanently_left', 'banned', 'forbidden_origin'])
/** Неясно/остаряло членство — ограничен брой опити. */
const UNCERTAIN_PRESENCE_CODES = new Set(['not_seat_connection', 'client_instance_conflict'])
const UNCERTAIN_TOKEN_CODES = new Set(['invalid_session'])
/** Окончателен край на гласовия достъп от сървъра. */
const PERMANENT_ACCESS_END = new Set(['banned', 'session_displaced', 'voice_off', 'table_released', 'kicked'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

type Connector = { connect: (url: string, token: string) => Promise<VoiceConnectedRoom>; abort: () => Promise<void> }
type MicRequest = { source: VoiceMicRequestSource; startedAt: number; interruption: VoiceMicInterruption; gum: VoiceMicGumBucket }

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const timers = deps.timers ?? defaultTimers
  const log = deps.log ?? (() => {})
  const nowMs = deps.now ?? (() => Date.now())
  const speakingHoldMs = deps.timing?.speakingHoldMs ?? 400
  const presenceAckTimeoutMs = deps.timing?.presenceAckTimeoutMs ?? 5_000
  const defaultRenewMs = deps.timing?.defaultRenewMs ?? 20_000
  const retainMicMaxMs = deps.timing?.retainMicMaxMs ?? 20_000
  const backoffMs = deps.timing?.backoffMs ?? [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
  const uncertainMaxAttempts = deps.timing?.uncertainMaxAttempts ?? 5
  const contextGraceMs = deps.timing?.contextGraceMs ?? 10_000
  const intentStore = deps.intentStore ?? { save: (intent: { voiceTableId: string; profileId: string; mic: boolean }) => saveVoiceIntent(intent), clear: () => clearVoiceIntent() }
  // Една страница = един clientInstanceId (само в паметта; refresh -> нов).
  const clientInstanceId = (deps.createClientInstanceId ?? defaultClientInstanceId)()

  // ── контекст и интерфейс ──
  let context: VoiceContext = { kind: 'none' }
  /**
   * Масата изчезна от контекста при активен глас: връзката е затворена, а
   * намерението се пази contextGraceMs — ако СЪЩАТА маса се върне (временно
   * липсващ snapshot), гласът се възстановява сам; иначе се изчиства.
   */
  let suspended: { key: string; mic: boolean } | null = null
  let contextGraceTimer: unknown = null
  let speak: VoiceSpeakState | null = null
  let playbackBlocked = false
  let uiError: VoiceUiError | null = null
  let canRestore = false
  let offerDismissed = false
  let microphoneDevicesChanged = false
  let generation: number | null = null
  let gameConnected = true
  let disposed = false
  /** Сървърът е изключил гласа за тази маса (без опити до ново изрично включване). */
  let serverDisabled = false

  // ── желано състояние ──
  let wantVoice = false
  let wantMic = false
  /** Текущото желание за микрофон идва от изрично действие — разрешение може да се поиска. */
  let micExplicit = false
  /** Спрян след изчерпани опити (неясно членство) — „Опитай отново“. */
  let failed = false

  // ── действително състояние (само двигателят създава/затваря стаи) ──
  let adapter: VoiceAdapter | null = null
  let adapterPromise: Promise<VoiceAdapter> | null = null
  let room: VoiceConnectedRoom | null = null
  let link: 'none' | 'connected' | 'reconnecting' = 'none'
  /** Идентичност на текущата стая за събитията от адаптера (остарели се игнорират). */
  let roomOwner: object | null = null
  /** Подготвена в потребителския жест (autoplay) стая — ползва се от двигателя. */
  let preparedSlot: { owner: object; connector: Connector } | null = null
  let closing: Promise<void> = Promise.resolve()
  /** Затваряния в ход — докато има такива, нова стая не се подготвя. */
  let closingJobs = 0
  let everConnected = false
  let rotating = false
  /** Двигателят трябва да затвори текущата стая и да се свърже наново. */
  let closeRequested: 'rotate' | 'renew' | null = null
  let sessionSeq = 0
  let driving = false
  let driveAgain = false
  let attempts = 0
  let uncertainAttempts = 0
  let retryTimer: unknown = null

  // ── микрофон ──
  let microphone: VoiceMicrophoneState = 'off'
  let held: VoiceRetainedMicrophone | null = null
  let heldTimer: unknown = null
  let acquiring = false
  let acquireSeq = 0
  /** Придобиване на текущия (още непубликуван) първи опит — за общия 20 s срок. */
  let micStartedAt: number | null = null
  /** Микрофонът е бил публикуван при текущото желание (след това прекъсванията са технически). */
  let everLive = false
  let publishHandbacks = 0
  let micRequest: MicRequest | null = null
  let micRequestSource: VoiceMicRequestSource = 'initial'

  // ── присъствие ──
  let renewMs = defaultRenewMs
  let presenceTimer: unknown = null
  let pendingAck: { resolve: (result: VoicePresenceResultMessage | null) => void; timer: unknown } | null = null
  let pendingAckPromise: Promise<VoicePresenceResultMessage | null> | null = null

  // ── говорещи, заглушени, слушатели ──
  const locallyMuted = new Set<string>()
  let locallyMutedTableId: string | null = null
  const speakingProfiles = new Set<string>()
  const speakingHoldTimers = new Map<string, unknown>()
  const listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  const speakingListeners = new Set<(profileIds: readonly string[]) => void>()
  let cachedSnapshot: VoiceSnapshot | null = null
  let transportTimer: unknown = null
  const counters: Record<string, number> = {
    adapterLoads: 0,
    roomsCreated: 0,
    roomsDisconnected: 0,
    roomsOpenMax: 0,
    tokenRequests: 0,
    micEnableAttempts: 0,
    micEnabled: 0,
    micDisabled: 0,
    presenceSent: 0,
    rotations: 0,
    micReused: 0,
    retainedReleased: 0,
    connectAttempts: 0,
  }
  let roomsOpen = 0

  // ─── Помощни ──────────────────────────────────────────────────────────

  const tableContext = (): Extract<VoiceContext, { kind: 'table' }> | null => (context.kind === 'table' ? context : null)
  const onTableScreen = (): boolean => {
    const table = tableContext()
    return table !== null && (table.screen === 'waiting' || table.screen === 'game')
  }
  const tableKey = (): string | null => {
    const table = tableContext()
    return table === null ? null : `${table.voiceTableId}:${table.selfProfileId}`
  }
  const isConnected = (): boolean => room !== null && link === 'connected'

  function setUiError(code: VoiceUiErrorCode | null): void {
    uiError = code === null ? null : { code, ...VOICE_UI_MESSAGES[code] }
  }

  function computeStatus(): VoiceStatus {
    if (tableContext() === null) return 'disabled'
    if (serverDisabled) return 'disabled'
    if (!wantVoice) return 'idle'
    if (failed) return 'unavailable'
    if (room !== null && link === 'connected') {
      if (speak?.blockedReason === 'muted') return 'connected_muted'
      return microphone === 'live' ? 'connected_speaking' : 'connected_listening'
    }
    if (room !== null && link === 'reconnecting') return 'reconnecting'
    if (rotating) return 'rotating'
    return everConnected ? 'reconnecting' : 'connecting'
  }

  function invalidate(): void {
    cachedSnapshot = null
    if (disposed) return
    const snapshot = getSnapshot()
    for (const listener of [...listeners]) {
      try { listener(snapshot) } catch { /* изолация на слушателите */ }
    }
  }

  function emitSpeaking(): void {
    cachedSnapshot = null
    const profiles = [...speakingProfiles].sort()
    for (const listener of [...speakingListeners]) {
      try { listener(profiles) } catch { /* изолация */ }
    }
  }

  function clearTimer(handle: unknown): null {
    if (handle !== null) timers.clearTimeout(handle)
    return null
  }

  function report(event: VoiceDiagnosticReport): void {
    if (deps.reportDiagnostic === undefined) return
    try { deps.reportDiagnostic(event) } catch { /* никога не влияе на гласа */ }
  }

  function saveIntent(): void {
    const table = tableContext()
    if (table === null || !wantVoice) return
    intentStore.save({ voiceTableId: table.voiceTableId, profileId: table.selfProfileId, mic: wantMic })
  }

  function ensureAdapter(): Promise<VoiceAdapter> {
    if (adapter !== null) return Promise.resolve(adapter)
    adapterPromise ??= deps.loadAdapter().then(
      (loaded) => {
        counters.adapterLoads! += 1
        adapter = loaded
        return loaded
      },
      (error: unknown) => {
        adapterPromise = null
        throw error
      },
    )
    return adapterPromise
  }

  // ─── Говорещи ─────────────────────────────────────────────────────────

  function clearSpeaking(): void {
    for (const handle of speakingHoldTimers.values()) timers.clearTimeout(handle)
    speakingHoldTimers.clear()
    if (speakingProfiles.size > 0) {
      speakingProfiles.clear()
      emitSpeaking()
    }
  }

  function applyActiveSpeakers(identities: string[]): void {
    const nowSpeaking = new Set<string>()
    for (const identity of identities) {
      const profileId = profileIdFromVoiceIdentity(identity)
      if (profileId !== null) nowSpeaking.add(profileId)
    }
    let changed = false
    for (const profileId of nowSpeaking) {
      const hold = speakingHoldTimers.get(profileId)
      if (hold !== undefined) {
        timers.clearTimeout(hold)
        speakingHoldTimers.delete(profileId)
      }
      if (!speakingProfiles.has(profileId)) {
        speakingProfiles.add(profileId)
        changed = true
      }
    }
    for (const profileId of [...speakingProfiles]) {
      if (nowSpeaking.has(profileId) || speakingHoldTimers.has(profileId)) continue
      speakingHoldTimers.set(profileId, timers.setTimeout(() => {
        speakingHoldTimers.delete(profileId)
        if (speakingProfiles.delete(profileId)) emitSpeaking()
      }, speakingHoldMs))
    }
    if (changed) emitSpeaking()
  }

  // ─── Диагностика на изричното включване на микрофона ─────────────────

  function gumBucket(ms: number): VoiceMicGumBucket {
    if (ms < 1_000) return 'lt1s'
    if (ms < 5_000) return '1to5s'
    if (ms < 15_000) return '5to15s'
    return 'gt15s'
  }

  function noteMicInterruption(kind: VoiceMicInterruption): void {
    if (micRequest !== null && micRequest.interruption === 'none') micRequest.interruption = kind
  }

  function finishMicRequest(result: VoiceMicAttemptResult, failure: VoiceMicAttemptFailure = 'none'): void {
    const request = micRequest
    if (request === null) return
    micRequest = null
    const finalResult: VoiceMicAttemptResult = result === 'enabled' && request.interruption !== 'none' ? 'recovered' : result
    report({ event: 'mic_attempt', source: request.source, result: finalResult, interruption: request.interruption, gum: request.gum, failure })
  }

  function publishFailureOf(kind: VoicePublishErrorKind | null): VoiceMicAttemptFailure {
    if (kind === 'cancelled') return 'publish_cancelled'
    if (kind === 'timeout') return 'publish_timeout'
    if (kind === 'negotiation') return 'publish_negotiation'
    if (kind === 'not_connected') return 'publish_not_connected'
    if (kind === 'not_permitted') return 'not_permitted'
    return 'publish_failed'
  }

  function livekitReasonOf(cause: VoiceDisconnectCause): VoiceLiveKitDisconnectReason {
    if (cause === 'room_deleted') return 'room_deleted'
    if (cause === 'removed') return 'participant_removed'
    if (cause === 'duplicate_identity') return 'duplicate_identity'
    if (cause === 'client') return 'client'
    return 'network'
  }

  // ─── Задържан capture (непубликуван) ─────────────────────────────────

  function releaseHeld(): void {
    heldTimer = clearTimer(heldTimer)
    const capture = held
    held = null
    if (capture !== null) {
      counters.retainedReleased! += 1
      capture.release()
    }
  }

  /** Първото изрично включване не е стигнало до публикуване (и няма да чака безкрайно). */
  function failInitialAttempt(failure: VoiceMicAttemptFailure = 'acquired_not_published'): void {
    releaseHeld()
    micStartedAt = null
    publishHandbacks = 0
    wantMic = false
    if (microphone === 'requesting') microphone = 'off'
    setUiError('mic_not_enabled')
    finishMicRequest('lost', failure)
    saveIntent()
    invalidate()
  }

  /**
   * Capture, който чака свързана стая. Две правила:
   *  - първо включване (още непубликувано): ОБЩ срок retainMicMaxMs от
   *    придобиването — прекъсванията не го рестартират; след него — край на
   *    опита с „Микрофонът не беше включен“;
   *  - вече говорил (техническо прекъсване): capture-ът се освобождава след
   *    retainMicMaxMs, но НАМЕРЕНИЕТО остава — при свързване нов capture само
   *    ако браузърът го разрешава без прозорец.
   */
  function setHeld(capture: VoiceRetainedMicrophone, restartWindow = true): void {
    const keepTimer = !restartWindow && heldTimer !== null
    if (held !== null && held !== capture) {
      counters.retainedReleased! += 1
      held.release()
    }
    held = capture
    if (keepTimer) return
    heldTimer = clearTimer(heldTimer)
    const delay = micStartedAt !== null ? Math.max(0, micStartedAt + retainMicMaxMs - nowMs()) : retainMicMaxMs
    heldTimer = timers.setTimeout(() => {
      heldTimer = null
      if (held !== capture) return
      if (micStartedAt !== null) {
        failInitialAttempt()
        return
      }
      releaseHeld()
      if (microphone === 'requesting' && !acquiring) microphone = 'off'
      invalidate()
      kick()
    }, delay)
  }

  /** Изрично спиране на микрофона (без грешка): отменя придобиване, освобождава capture. */
  function dropMicrophone(): void {
    acquireSeq += 1
    acquiring = false
    micExplicit = false
    releaseHeld()
    micStartedAt = null
    publishHandbacks = 0
    everLive = false
    const current = room
    if (microphone !== 'off' && current !== null) counters.micDisabled! += 1
    if (current !== null) void current.disableMicrophone().catch(() => {})
    microphone = 'off'
  }

  /** Отказано право за говорене: без микрофон и с познатото съобщение. */
  function denySpeaking(): void {
    wantMic = false
    dropMicrophone()
    setUiError(speak?.blockedReason === 'muted' ? 'mic_blocked' : 'vip_required')
    finishMicRequest('failed', 'not_permitted')
    saveIntent()
  }

  // ─── Придобиване (getUserMedia) — извън двигателя ────────────────────

  function startAcquire(): void {
    if (acquiring || held !== null || adapter === null || adapter.acquireMicrophone === undefined) return
    const loaded = adapter
    acquiring = true
    acquireSeq += 1
    const seq = acquireSeq
    const key = tableKey()
    const startedAt = nowMs()
    counters.micEnableAttempts! += 1
    microphone = 'requesting'
    invalidate()
    loaded.acquireMicrophone!().then(
      (capture) => {
        if (seq !== acquireSeq) {
          capture.release() // отменено междувременно (изключване/напускане/друга маса)
          return
        }
        acquiring = false
        micExplicit = false
        if (micRequest !== null) micRequest.gum = gumBucket(nowMs() - startedAt)
        if (!everLive) micStartedAt = nowMs()
        if (disposed || !wantMic || !wantVoice || tableKey() !== key) {
          capture.release()
          finishMicRequest('cancelled')
          if (microphone === 'requesting') microphone = 'off'
          invalidate()
          return
        }
        setHeld(capture)
        kick()
      },
      (error: unknown) => {
        if (seq !== acquireSeq) return
        acquiring = false
        micExplicit = false
        if (micRequest !== null) micRequest.gum = gumBucket(nowMs() - startedAt)
        const failure = error instanceof VoiceMicrophoneError ? error.failure : 'unavailable'
        wantMic = false
        microphone = 'off'
        report({
          event: 'mic_failed',
          reason: failure === 'not_found' ? 'mic_not_found' : failure === 'permission_denied' ? 'mic_permission_denied' : 'mic_unavailable',
        })
        finishMicRequest('failed',
          failure === 'permission_denied' ? 'permission_denied'
            : failure === 'not_found' ? 'not_found'
              : failure === 'busy' ? 'device_busy'
                : 'gum_failed')
        setUiError(failure === 'not_found' ? 'mic_not_found' : failure === 'permission_denied' ? 'mic_permission_denied' : 'mic_unavailable')
        saveIntent()
        invalidate()
      },
    )
  }

  // ─── Присъствие / lease ───────────────────────────────────────────────

  function sendPresence(onScreen: boolean, reason?: VoicePresenceLeaveReason): boolean {
    const table = tableContext()
    if (table === null) return false
    const sent = deps.sendPresence({
      type: 'voice_presence', voiceTableId: table.voiceTableId, clientInstanceId, onTableScreen: onScreen,
      ...(!onScreen && reason !== undefined ? { reason } : {}),
    })
    if (sent) counters.presenceSent! += 1
    // Подновяването се отброява от последното изпратено присъствие.
    if (sent && onScreen) scheduleRenewal()
    return sent
  }

  function scheduleRenewal(): void {
    presenceTimer = clearTimer(presenceTimer)
    if (!wantVoice || !onTableScreen() || !gameConnected || disposed) return
    presenceTimer = timers.setTimeout(() => {
      presenceTimer = null
      if (!wantVoice || !onTableScreen() || !gameConnected) return
      sendPresence(true)
    }, renewMs)
  }

  function settleAck(result: VoicePresenceResultMessage | null): void {
    if (pendingAck === null) return
    const ack = pendingAck
    pendingAck = null
    pendingAckPromise = null
    timers.clearTimeout(ack.timer)
    ack.resolve(result)
  }

  /** Едно споделено потвърждение (втори опит не отменя първия). */
  function presenceHandshake(): Promise<VoicePresenceResultMessage | null | 'unsent'> {
    if (pendingAck !== null && pendingAckPromise !== null) return pendingAckPromise
    if (!sendPresence(true)) return Promise.resolve('unsent')
    pendingAckPromise = new Promise((resolve) => {
      pendingAck = { resolve, timer: timers.setTimeout(() => settleAck(null), presenceAckTimeoutMs) }
    })
    return pendingAckPromise
  }

  // ─── Събития от адаптера (само за текущата стая) ─────────────────────

  function adapterEvents(owner: object): VoiceAdapterEvents {
    const current = (): boolean => roomOwner === owner && !disposed
    return {
      onDisconnected: (cause, retained, reason) => {
        if (!current()) {
          retained?.release()
          return
        }
        if (cause !== 'client') report({ event: 'livekit_disconnect', reason: reason ?? livekitReasonOf(cause) })
        // Стаята е мъртва (LiveKit вече я е затворил) — двигателят решава какво следва.
        room = null
        link = 'none'
        roomOwner = null
        roomsOpen = Math.max(0, roomsOpen - 1)
        clearSpeaking()
        if (microphone === 'live') {
          if (retained !== null) setHeld(retained)
          else report({ event: 'mic_lost', reason: cause === 'room_deleted' ? 'rotation' : 'connection_lost' })
          microphone = held !== null || wantMic ? 'requesting' : 'off'
        } else {
          retained?.release()
        }
        if (cause === 'room_deleted') {
          if (!rotating) counters.rotations! += 1
          rotating = true
          noteMicInterruption('room_deleted')
        } else if (cause === 'connection_lost') {
          // SDK-то вече е опитало само и се е отказало: нов опит след първата пауза.
          report({ event: 'connection_lost' })
          noteMicInterruption('connection_lost')
          if (wantVoice) scheduleRetry(null)
        } else if (cause === 'client') {
          // Не сме я затворили ние (наш disconnect не стига дотук): LiveKit я е
          // затворил при напускане на страницата. Ако страницата остане (отменено
          // напускане) — нов опит след първата пауза, без бързане при unload.
          if (wantVoice) scheduleRetry(null)
        } else if (cause === 'duplicate_identity') {
          // Същият участник влезе отново от друго място — тук не се връщаме.
          stopSession({ reason: 'duplicate_identity', notifyServer: false, clearIntent: true, canRestore: false })
          return
        }
        // 'removed' (изтекъл lease, 120 s) и останалите: при запазено желание — ново свързване.
        invalidate()
        kick()
      },
      onReconnecting: () => {
        if (!current() || room === null) return
        link = 'reconnecting'
        noteMicInterruption('sdk_reconnect')
        report({ event: 'reconnecting' })
        invalidate()
      },
      onReconnected: () => {
        if (!current() || room === null) return
        link = 'connected'
        report({ event: 'reconnected' })
        invalidate()
        kick() // микрофонът (напр. отменено по време на reconnect публикуване)
      },
      onActiveSpeakersChanged: (identities) => { if (current()) applyActiveSpeakers(identities) },
      onParticipantsChanged: () => { if (current()) invalidate() },
      onPlaybackStatusChanged: (canPlayback) => {
        if (!current() || room === null) return
        playbackBlocked = !canPlayback
        invalidate()
      },
      onLocalMicrophoneLost: (reason) => {
        if (!current()) return
        if (microphone === 'live') report({ event: 'mic_lost', reason: reason ?? 'track_ended' })
        microphone = 'off'
        if (reason === 'republish_failed') {
          // Техническо (неуспешно републикуване след reconnect): желанието остава.
          invalidate()
          kick()
          return
        }
        // Изключено устройство / OS прекъсване / сървърно премахване:
        // без автоматично записване от друго устройство.
        wantMic = false
        dropMicrophone()
        setUiError(speak?.blockedReason === 'muted' ? 'mic_blocked' : 'mic_unavailable')
        saveIntent()
        invalidate()
      },
      onDevicesChanged: () => {
        if (!current()) return
        if (uiError !== null && (uiError.code === 'mic_not_found' || uiError.code === 'mic_unavailable')) {
          microphoneDevicesChanged = true
          invalidate()
        }
      },
    }
  }

  function prepareRoom(loaded: VoiceAdapter): { owner: object; connector: Connector } | null {
    const owner = {}
    try {
      const connector = loaded.prepare(adapterEvents(owner), (identity) => {
        const profileId = profileIdFromVoiceIdentity(identity)
        return profileId !== null && locallyMuted.has(profileId)
      })
      counters.roomsCreated! += 1
      return { owner, connector }
    } catch {
      return null
    }
  }

  /** Подготвя стаята синхронно в потребителския жест (отключване на аудиото), ако адаптерът е зареден. */
  function prepareInGesture(): void {
    if (adapter === null || room !== null || roomOwner !== null || preparedSlot !== null || closingJobs > 0) return
    preparedSlot = prepareRoom(adapter)
  }

  function scheduleTransportReport(connected: VoiceConnectedRoom): void {
    transportTimer = clearTimer(transportTimer)
    if (deps.reportDiagnostic === undefined || connected.getTransportInfo === undefined) return
    const attempt = (delayMs: number, retriesLeft: number): void => {
      transportTimer = timers.setTimeout(() => {
        transportTimer = null
        if (room !== connected || disposed) return
        void connected.getTransportInfo!().then((transport) => {
          if (room !== connected || disposed) return
          if (transport !== null) report({ event: 'transport', transport })
          else if (retriesLeft > 0) attempt(15_000, retriesLeft - 1)
        }).catch(() => {})
      }, delayMs)
    }
    attempt(5_000, 1)
  }

  // ─── ДВИГАТЕЛЯТ ───────────────────────────────────────────────────────

  function shouldConnect(): boolean {
    return !disposed && wantVoice && !failed && !serverDisabled && onTableScreen()
  }

  function kick(): void {
    if (disposed) return
    if (driving) {
      driveAgain = true
      return
    }
    void drive()
  }

  async function drive(): Promise<void> {
    driving = true
    try {
      do {
        driveAgain = false
        await step()
      } while (driveAgain && !disposed)
    } catch (error) {
      log(`[voice] drive: ${error instanceof Error ? error.name : 'error'}`)
    } finally {
      driving = false
      invalidate()
    }
  }

  async function step(): Promise<void> {
    if (!shouldConnect()) {
      if (room !== null || preparedSlot !== null) await closeRoom(false)
      releaseHeld()
      return
    }
    // Пауза: временно липсващ контекст или игрова връзка — без нови опити;
    // съществуващата връзка остава (сървърът сам прекратява след 120 s).
    if (!gameConnected) return
    if (closeRequested !== null) {
      const reason = closeRequested
      closeRequested = null
      if (room !== null) await closeRoom(reason === 'rotate' && wantMic)
    }
    if (room !== null) {
      // Докато SDK-то само възстановява връзката — без наша операция.
      if (link === 'connected') await ensureMicrophone()
      return
    }
    if (retryTimer !== null) return // чака паузата (ready/игрова връзка я съкращават)
    await connectOnce()
  }

  function trackClosing(job: Promise<void>): void {
    closingJobs += 1
    const done = job.then(() => { closingJobs -= 1 })
    closing = closing.then(() => done)
  }

  /** Затваряне на текущата стая; keepMic -> живият capture се задържа за следващата. */
  async function closeRoom(keepMic: boolean): Promise<void> {
    const old = room
    const slot = preparedSlot
    room = null
    link = 'none'
    roomOwner = null
    preparedSlot = null
    clearSpeaking()
    transportTimer = clearTimer(transportTimer)
    invalidate()
    const job = (async () => {
      if (old !== null) {
        counters.roomsDisconnected! += 1
        if (keepMic && microphone === 'live') {
          const seq = sessionSeq
          const capture = await old.detachMicrophoneForReuse().catch(() => null)
          if (capture !== null) {
            // Напускане/изключване по време на откачането -> capture-ът се спира.
            if (seq !== sessionSeq || !wantVoice || !wantMic) capture.release()
            else {
              counters.micReused! += 1
              setHeld(capture)
            }
          }
        }
        await old.disconnect().catch(() => {})
        roomsOpen = Math.max(0, roomsOpen - 1)
      }
      if (slot !== null) await slot.connector.abort().catch(() => {})
    })()
    trackClosing(job)
    await job
    microphone = held !== null && wantMic ? 'requesting' : 'off'
    invalidate()
  }

  function scheduleRetry(hintMs: number | null): void {
    attempts += 1
    const delay = hintMs ?? backoffMs[Math.min(attempts - 1, backoffMs.length - 1)]!
    retryTimer = clearTimer(retryTimer)
    retryTimer = timers.setTimeout(() => {
      retryTimer = null
      kick()
    }, delay)
  }

  function kickRetryNow(): void {
    if (retryTimer === null) return
    retryTimer = clearTimer(retryTimer)
    kick()
  }

  /** Неясно членство: ограничени опити, после спиране с „Опитай отново“. */
  function uncertainFailure(stage: VoiceFailStage, hintMs: number | null): void {
    uncertainAttempts += 1
    if (uncertainAttempts >= uncertainMaxAttempts) {
      failConnection(stage)
      return
    }
    scheduleRetry(hintMs)
  }

  function failConnection(stage: VoiceFailStage): void {
    report({ event: 'session_end', reason: 'fail_connection', stage })
    failed = true
    retryTimer = clearTimer(retryTimer)
    setUiError('service_unavailable')
    if (wantVoice) sendPresence(false, 'fail_connection')
    presenceTimer = clearTimer(presenceTimer)
    invalidate()
    kick() // затваря евентуална стая
  }

  async function connectOnce(): Promise<void> {
    const seq = sessionSeq
    const stale = (): boolean => seq !== sessionSeq || !shouldConnect() || !gameConnected
    counters.connectAttempts! += 1
    let loaded: VoiceAdapter
    try {
      loaded = await ensureAdapter()
    } catch {
      if (seq !== sessionSeq) return
      if (attempts === 0) report({ event: 'connect_failed', reason: 'sdk_load_failed' })
      uncertainFailure('sdk_load', null)
      return
    }
    if (stale()) return
    const ack = await presenceHandshake()
    if (stale()) return
    if (ack === 'unsent') {
      // Игровият WS не е отворен: връщането му ще задейства нов опит.
      scheduleRetry(null)
      return
    }
    if (ack === null) {
      // Сървърът не потвърди присъствието (5 s): неясно състояние — ограничени опити.
      if (attempts === 0) report({ event: 'connect_failed', reason: 'presence_failed' })
      uncertainFailure('presence', null)
      return
    }
    if (!ack.ok) {
      if (TERMINAL_PRESENCE_CODES.has(ack.code)) {
        disableEntirely('disabled')
        return
      }
      if (attempts === 0) report({ event: 'connect_failed', reason: 'presence_failed' })
      if (UNCERTAIN_PRESENCE_CODES.has(ack.code)) uncertainFailure('presence', null)
      else scheduleRetry(null)
      return
    }
    const table = tableContext()
    if (table === null) return
    counters.tokenRequests! += 1
    let response: { status: number; body: unknown } | null = null
    try {
      response = await deps.postJson(VOICE_TOKEN_PATH, { voiceTableId: table.voiceTableId, clientInstanceId })
    } catch {
      response = null
    }
    if (stale()) return
    const body = response !== null && isObject(response.body) ? response.body : null
    if (response === null || response.status !== 200 || body === null || body.ok !== true || typeof body.token !== 'string') {
      const code = body !== null && typeof body.code === 'string' ? body.code : 'network'
      if (TERMINAL_TOKEN_CODES.has(code)) {
        disableEntirely('disabled')
        return
      }
      if (attempts === 0) report({ event: 'connect_failed', reason: 'token_unavailable' })
      const hinted = body !== null && typeof body.retryAfterMs === 'number' ? Math.max(200, body.retryAfterMs) : null
      if (UNCERTAIN_TOKEN_CODES.has(code)) uncertainFailure('token', hinted)
      else scheduleRetry(hinted)
      return
    }
    const token = body as unknown as VoiceTokenSuccess
    // Старата стая е напълно затворена преди новата (≤1 LiveKit връзка).
    await closing
    if (stale()) return
    const slot = preparedSlot ?? prepareRoom(loaded)
    preparedSlot = null
    if (slot === null) {
      scheduleRetry(null)
      return
    }
    roomOwner = slot.owner
    roomsOpen += 1
    counters.roomsOpenMax = Math.max(counters.roomsOpenMax!, roomsOpen)
    let connected: VoiceConnectedRoom
    try {
      // Токенът се подава директно и не се пази никъде след това.
      connected = await slot.connector.connect(token.url, token.token)
    } catch {
      if (roomOwner === slot.owner) roomOwner = null
      roomsOpen = Math.max(0, roomsOpen - 1)
      void slot.connector.abort().catch(() => {})
      if (seq !== sessionSeq) return
      if (attempts === 0) report({ event: 'connect_failed', reason: 'livekit_connect_failed' })
      scheduleRetry(null)
      return
    }
    if (stale() || roomOwner !== slot.owner) {
      if (roomOwner === slot.owner) roomOwner = null
      const job = connected.disconnect().catch(() => {}).then(() => { roomsOpen = Math.max(0, roomsOpen - 1) })
      trackClosing(job)
      return
    }
    room = connected
    link = 'connected'
    everConnected = true
    rotating = false
    attempts = 0
    uncertainAttempts = 0
    generation = token.generation
    speak = token.speak
    playbackBlocked = !connected.canPlaybackAudio()
    if (uiError?.code === 'service_unavailable') setUiError(null)
    for (const participant of connected.listRemoteParticipants()) {
      const profileId = profileIdFromVoiceIdentity(participant.identity)
      if (profileId !== null && locallyMuted.has(profileId)) connected.setRemoteIdentityVolume(participant.identity, 0)
    }
    report({ event: 'connected' })
    scheduleTransportReport(connected)
    invalidate()
    await ensureMicrophone()
  }

  /** Публикуване в свързаната стая (capture === undefined -> адаптерът сам придобива). */
  async function publish(current: VoiceConnectedRoom, capture: VoiceRetainedMicrophone | undefined): Promise<void> {
    microphone = 'requesting'
    invalidate()
    // Както след собствен capture (iOS AudioSession): възпроизвеждането продължава.
    if (capture !== undefined) void current.startAudio().catch(() => {})
    try {
      await current.enableMicrophone(capture)
    } catch (error) {
      const handedBack = error instanceof VoiceMicrophoneError ? error.retained : null
      if (handedBack !== null) {
        // Прекъснато от SDK reconnect: публикуване след Reconnected (kick); общият срок тече.
        noteMicInterruption('sdk_reconnect')
        publishHandbacks += 1
        if (micStartedAt !== null && publishHandbacks > 2) {
          held = handedBack
          failInitialAttempt('publish_cancelled')
          return
        }
        setHeld(handedBack, false)
        return
      }
      if (room !== current) return // стаята е сменена; следващият цикъл решава
      microphone = 'off'
      const failure = error instanceof VoiceMicrophoneError ? error.failure : 'unavailable'
      const publishError = error instanceof VoiceMicrophoneError ? error.publishError : null
      if (failure === 'not_permitted') {
        report({ event: 'mic_failed', reason: 'mic_not_permitted' })
        denySpeaking()
        return
      }
      const code: VoiceUiErrorCode = failure === 'not_found' ? 'mic_not_found' : failure === 'permission_denied' ? 'mic_permission_denied' : 'mic_unavailable'
      report({ event: 'mic_failed', reason: code === 'mic_not_found' ? 'mic_not_found' : code === 'mic_permission_denied' ? 'mic_permission_denied' : 'mic_unavailable' })
      finishMicRequest('failed', capture === undefined
        ? (failure === 'permission_denied' ? 'permission_denied' : failure === 'not_found' ? 'not_found' : failure === 'busy' ? 'device_busy' : 'gum_failed')
        : publishFailureOf(publishError))
      // Неуспешно публикуване (не прекъсване): без автоматични повторения.
      wantMic = false
      setUiError(code)
      saveIntent()
      invalidate()
      return
    }
    if (room !== current || !wantMic) {
      void current.disableMicrophone().catch(() => {})
      if (microphone === 'requesting') microphone = 'off'
      return
    }
    counters.micEnabled! += 1
    microphone = 'live'
    everLive = true
    micStartedAt = null
    publishHandbacks = 0
    heldTimer = clearTimer(heldTimer)
    if (uiError !== null && (uiError.code === 'mic_not_enabled' || uiError.code === 'mic_unavailable')) setUiError(null)
    finishMicRequest('enabled')
    saveIntent()
    invalidate()
  }

  /** Микрофонът в свързаната стая — според желанието и правото (вътре в двигателя). */
  async function ensureMicrophone(): Promise<void> {
    const current = room
    if (current === null || link !== 'connected') return
    if (!wantMic) {
      if (microphone !== 'off' || held !== null) dropMicrophone()
      return
    }
    if (speak?.canSpeak !== true) {
      denySpeaking()
      return
    }
    if (microphone === 'live' && current.isMicrophoneLive()) return
    if (held !== null) {
      const capture = held
      heldTimer = clearTimer(heldTimer)
      held = null
      await publish(current, capture)
      return
    }
    if (adapter !== null && adapter.acquireMicrophone === undefined) {
      // Адаптер без отделно придобиване: capture и публикуване в една стъпка.
      if (micExplicit || (adapter.microphonePermissionGranted !== undefined && await adapter.microphonePermissionGranted().catch(() => false))) {
        micExplicit = false
        counters.micEnableAttempts! += 1
        await publish(current, undefined)
        return
      }
    }
    if (acquiring) {
      microphone = 'requesting'
      return
    }
    if (micExplicit) {
      startAcquire() // изрично действие — прозорецът за разрешение е позволен
      return
    }
    // Възстановяване без изрично действие: нов capture само без прозорец.
    const granted = adapter?.microphonePermissionGranted === undefined ? false : await adapter.microphonePermissionGranted().catch(() => false)
    if (room !== current || !wantMic || acquiring || held !== null) return
    if (granted) {
      startAcquire()
      return
    }
    wantMic = false
    microphone = 'off'
    setUiError('mic_not_enabled')
    finishMicRequest('lost', 'acquired_not_published')
    saveIntent()
    invalidate()
  }

  // ─── Край на сесията ──────────────────────────────────────────────────

  function presenceReasonOf(reason: VoiceSessionEndReason): VoicePresenceLeaveReason | undefined {
    switch (reason) {
      case 'leave_voice':
      case 'off_table':
      case 'page_hide':
      case 'page_restored':
      case 'context_changed':
      case 'fail_connection':
      case 'disposed':
        return reason
      default:
        return undefined
    }
  }

  function stopSession(options: { reason: VoiceSessionEndReason; notifyServer: boolean; clearIntent: boolean; canRestore: boolean }): void {
    if (wantVoice || room !== null || preparedSlot !== null) report({ event: 'session_end', reason: options.reason, stage: 'none' })
    if (options.notifyServer && wantVoice) sendPresence(false, presenceReasonOf(options.reason))
    sessionSeq += 1
    finishMicRequest('cancelled')
    wantVoice = false
    wantMic = false
    failed = false
    rotating = false
    everConnected = false
    closeRequested = null
    attempts = 0
    uncertainAttempts = 0
    presenceTimer = clearTimer(presenceTimer)
    retryTimer = clearTimer(retryTimer)
    transportTimer = clearTimer(transportTimer)
    settleAck(null)
    dropMicrophone()
    playbackBlocked = false
    generation = null
    canRestore = options.canRestore
    if (options.clearIntent) intentStore.clear()
    // Затварянето минава през двигателя (единственият собственик на стаята).
    invalidate()
    kick()
  }

  function disableEntirely(reason: VoiceSessionEndReason): void {
    stopSession({ reason, notifyServer: false, clearIntent: true, canRestore: false })
    serverDisabled = true
    speak = null
    setUiError(null)
    invalidate()
  }

  // ─── Действия ─────────────────────────────────────────────────────────

  function beginJoin(options: { mic: boolean; explicit: boolean; source: VoiceMicRequestSource }): void {
    if (disposed || !onTableScreen()) return
    suspended = null
    contextGraceTimer = clearTimer(contextGraceTimer)
    if (!wantVoice) {
      wantVoice = true
      sessionSeq += 1
      attempts = 0
      uncertainAttempts = 0
      everConnected = false
    }
    failed = false
    serverDisabled = false
    canRestore = false
    offerDismissed = true
    microphoneDevicesChanged = false
    setUiError(null)
    if (options.mic) {
      wantMic = true
      micExplicit = options.explicit
      if (options.explicit) micRequest ??= { source: options.source, startedAt: nowMs(), interruption: 'none', gum: 'none' }
    }
    retryTimer = clearTimer(retryTimer)
    // Ако SDK-то вече е заредено: стаята и отключването на аудиото са в СЪЩИЯ жест.
    prepareInGesture()
    saveIntent()
    invalidate()
    kick()
  }

  async function enableMicrophoneExplicit(): Promise<void> {
    if (disposed) return
    micRequestSource = 'panel'
    if (!wantVoice) {
      beginJoin({ mic: true, explicit: true, source: 'panel' })
      return
    }
    if (microphone === 'live' || acquiring) return
    wantMic = true
    micExplicit = true
    micRequest ??= { source: micRequestSource, startedAt: nowMs(), interruption: 'none', gum: 'none' }
    microphoneDevicesChanged = false
    setUiError(null)
    if (failed) {
      failed = false
      attempts = 0
      uncertainAttempts = 0
    }
    saveIntent()
    const table = tableContext()
    if (!isConnected() || table === null) {
      invalidate()
      kick() // ще се включи след свързването
      return
    }
    microphone = 'requesting'
    invalidate()
    // Авторитетна backend проверка — не се доверяваме на стар клиентски VIP статус.
    const seq = sessionSeq
    let response: { status: number; body: unknown } | null = null
    try {
      response = await deps.postJson(VOICE_SPEAK_ACCESS_PATH, { voiceTableId: table.voiceTableId, clientInstanceId })
    } catch {
      response = null
    }
    if (seq !== sessionSeq || !wantMic) return
    const body = response !== null && isObject(response.body) ? (response.body as VoiceSpeakAccessResult & Record<string, unknown>) : null
    if (response === null || response.status !== 200 || body === null || body.ok !== true) {
      wantMic = false
      dropMicrophone()
      finishMicRequest('failed', 'session_failed')
      setUiError('service_unavailable')
      saveIntent()
      invalidate()
      return
    }
    if (body.canSpeak === false) {
      if (body.speak !== undefined) speak = body.speak
      denySpeaking()
      invalidate()
      return
    }
    if (speak !== null) speak = { ...speak, canSpeak: true, blockedReason: null }
    // Правата в LiveKit не са повишени на място -> нов токен (двигателят).
    if (body.upgrade === 'request_new_token') closeRequested = 'renew'
    invalidate()
    kick()
  }

  function applySpeakState(next: VoiceSpeakState): void {
    speak = next
    if (!next.canSpeak && next.blockedReason === 'muted') {
      // Административен mute: веднага без микрофон; без автоматично включване след края му.
      if (wantMic || microphone !== 'off' || held !== null) {
        wantMic = false
        dropMicrophone()
        finishMicRequest('cancelled')
        saveIntent()
      }
      setUiError('mic_blocked')
    } else if (next.canSpeak && uiError !== null && (uiError.code === 'mic_blocked' || uiError.code === 'vip_required')) {
      setUiError(null)
    }
    invalidate()
  }

  // ─── Сървърни съобщения ───────────────────────────────────────────────

  function handleServerMessage(message: { type: string }): boolean {
    if (!isVoiceServerMessage(message)) return false
    const table = tableContext()
    if (table === null || message.voiceTableId !== table.voiceTableId) return true
    switch (message.type) {
      case 'voice_presence_result': {
        if (message.ok) {
          renewMs = Math.max(5_000, Math.min(message.renewAfterMs, message.leaseTtlMs / 2))
          if (message.onTableScreen) applySpeakState(message.speak)
        } else if (TERMINAL_PRESENCE_CODES.has(message.code) && pendingAck === null && wantVoice) {
          disableEntirely('disabled')
        }
        settleAck(message)
        return true
      }
      case 'voice_table_updated': {
        if (!wantVoice) return true
        if (!message.ready) {
          // Закъсняло съобщение за генерацията, в която вече сме -> без ротация.
          if (generation !== null && message.generation === generation && room !== null) return true
          if (!rotating) counters.rotations! += 1
          rotating = true
          noteMicInterruption('rotation')
          if (room !== null) closeRequested = 'rotate'
          invalidate()
          kick()
        } else {
          kickRetryNow()
          kick()
        }
        return true
      }
      case 'voice_access_ended': {
        if (PERMANENT_ACCESS_END.has(message.reason)) {
          disableEntirely('access_ended')
        } else if (message.reason === 'session_replaced') {
          // Друга страница на същия играч пое гласа — тази не се връща.
          stopSession({ reason: 'access_ended', notifyServer: false, clearIntent: true, canRestore: false })
        } else if (wantVoice) {
          // Технически край (lease, игрова връзка): ново свързване с потвърдено присъствие.
          report({ event: 'session_end', reason: 'access_ended', stage: 'none' })
          if (room !== null) closeRequested = 'renew'
          kick()
        }
        return true
      }
      case 'voice_speak_access_updated': {
        applySpeakState(message.speak)
        return true
      }
    }
    return true
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────

  function computeParticipants(status: VoiceStatus): VoiceSeatParticipant[] {
    const table = tableContext()
    if (table === null) return []
    const connectedNow = room !== null && (status === 'connected_listening' || status === 'connected_speaking' || status === 'connected_muted' || status === 'reconnecting')
    const remote = new Map<string, boolean>()
    if (connectedNow && room !== null) {
      for (const participant of room.listRemoteParticipants()) {
        const profileId = profileIdFromVoiceIdentity(participant.identity)
        if (profileId !== null) remote.set(profileId, participant.microphonePublished || remote.get(profileId) === true)
      }
    }
    const result: VoiceSeatParticipant[] = []
    for (const seat of table.seats) {
      if (seat.isBot || seat.profileId === null) continue
      const isSelf = seat.profileId === table.selfProfileId
      const locallyMutedSeat = locallyMuted.has(seat.profileId)
      if (!connectedNow) {
        result.push({ profileId: seat.profileId, isSelf, voiceConnected: null, microphonePublished: null, speaking: false, listening: null, locallyMuted: locallyMutedSeat, unknown: true })
        continue
      }
      if (isSelf) {
        result.push({
          profileId: seat.profileId, isSelf, voiceConnected: true, microphonePublished: microphone === 'live',
          speaking: speakingProfiles.has(seat.profileId), listening: microphone !== 'live', locallyMuted: false, unknown: false,
        })
        continue
      }
      const present = remote.has(seat.profileId)
      result.push({
        profileId: seat.profileId,
        isSelf,
        voiceConnected: present,
        microphonePublished: present ? remote.get(seat.profileId) === true : null,
        speaking: present && speakingProfiles.has(seat.profileId),
        listening: present ? remote.get(seat.profileId) !== true : null,
        locallyMuted: locallyMutedSeat,
        unknown: false,
      })
    }
    return result
  }

  function getSnapshot(): VoiceSnapshot {
    if (cachedSnapshot !== null) return cachedSnapshot
    const table = tableContext()
    const status = computeStatus()
    cachedSnapshot = {
      status,
      voiceTableId: table?.voiceTableId ?? null,
      screen: table?.screen ?? null,
      speak,
      wantsToSpeak: wantMic,
      microphone,
      playbackBlocked,
      uiError,
      canRestore,
      offerDismissed,
      microphoneDevicesChanged,
      generation,
      locallyMutedProfileIds: [...locallyMuted].sort(),
      participants: computeParticipants(status),
      speakingProfileIds: [...speakingProfiles].sort(),
    }
    return cachedSnapshot
  }

  // ─── Публичен API ─────────────────────────────────────────────────────

  function sameSeats(a: readonly VoiceSeatInfo[], b: readonly VoiceSeatInfo[]): boolean {
    return a.length === b.length && a.every((seat, index) => seat.profileId === b[index]!.profileId && seat.isBot === b[index]!.isBot)
  }

  function resetTableState(nextTable: Extract<VoiceContext, { kind: 'table' }> | null, keepMutes = false): void {
    speak = null
    setUiError(null)
    offerDismissed = false
    serverDisabled = false
    canRestore = false
    if (!keepMutes && locallyMutedTableId !== (nextTable?.voiceTableId ?? null)) {
      locallyMuted.clear()
      locallyMutedTableId = nextTable?.voiceTableId ?? null
    }
  }

  const controller: VoiceController = {
    setContext(next) {
      if (disposed) return
      const prevTable = tableContext()
      const nextTable = next.kind === 'table' ? next : null
      if (nextTable === null && prevTable !== null && wantVoice) {
        // Масата изчезна: връзката се затваря ВЕДНАГА (без звук извън масата —
        // реално напускане), а намерението се пази кратко за временно липсващ snapshot.
        const key = tableKey()!
        const mic = wantMic
        sendPresence(false, 'context_changed')
        stopSession({ reason: 'context_changed', notifyServer: false, clearIntent: false, canRestore: false })
        suspended = { key, mic }
        contextGraceTimer = clearTimer(contextGraceTimer)
        contextGraceTimer = timers.setTimeout(() => {
          contextGraceTimer = null
          suspended = null
          intentStore.clear()
        }, contextGraceMs)
        context = next
        resetTableState(null, true)
        invalidate()
        return
      }
      const resume = suspended
      if (resume !== null && nextTable !== null) {
        suspended = null
        contextGraceTimer = clearTimer(contextGraceTimer)
        if (resume.key !== `${nextTable.voiceTableId}:${nextTable.selfProfileId}`) {
          intentStore.clear()
          locallyMuted.clear()
        }
      }
      if (prevTable !== null && nextTable !== null
        && prevTable.voiceTableId === nextTable.voiceTableId
        && prevTable.selfProfileId === nextTable.selfProfileId
        && prevTable.screen === nextTable.screen
        && sameSeats(prevTable.seats, nextTable.seats)) {
        kick()
        return
      }
      const tableChanged = prevTable === null || nextTable === null
        || prevTable.voiceTableId !== nextTable.voiceTableId || prevTable.selfProfileId !== nextTable.selfProfileId
      if (tableChanged) {
        // Друга маса / край на масата / logout: пълно прекратяване.
        if (wantVoice && prevTable !== null) {
          sendPresence(false, 'context_changed')
          stopSession({ reason: 'context_changed', notifyServer: false, clearIntent: true, canRestore: false })
        }
        context = next
        resetTableState(nextTable)
      } else {
        const wasOnScreen = prevTable!.screen === 'waiting' || prevTable!.screen === 'game'
        const nowOnScreen = nextTable!.screen === 'waiting' || nextTable!.screen === 'game'
        if (wasOnScreen && !nowOnScreen && wantVoice) {
          // „Изчакай в лоби“, магазин: изрично прекратяване; мястото и правото се пазят.
          stopSession({ reason: 'off_table', notifyServer: true, clearIntent: true, canRestore: true })
        }
        context = next
      }
      // Адаптерът е в същия lazy chunk (без мрежа): следващото включване подготвя стаята синхронно в жеста (autoplay).
      if (onTableScreen()) void ensureAdapter().catch(() => {})
      invalidate()
      if (resume !== null && resume.key === tableKey() && onTableScreen() && !wantVoice) {
        // Същата маса се върна в срока: възстановяване без потребителско действие.
        beginJoin({ mic: resume.mic, explicit: false, source: 'initial' })
        return
      }
      kick()
    },
    handleServerMessage,
    setGameConnection(connected) {
      if (disposed || connected === gameConnected) return
      gameConnected = connected
      if (!connected) {
        // Без опити, докато игровата връзка липсва; LiveKit връзката остава.
        presenceTimer = clearTimer(presenceTimer)
        invalidate()
        return
      }
      if (wantVoice && onTableScreen()) {
        sendPresence(true)
        kickRetryNow()
      }
      kick()
    },
    endSession() {
      locallyMuted.clear()
      locallyMutedTableId = null
      disableEntirely('disabled')
    },
    onPageHide() {
      // Затваряне/презареждане: връзката се затваря, намерението остава за същия таб.
      if (wantVoice || room !== null || preparedSlot !== null) stopSession({ reason: 'page_hide', notifyServer: true, clearIntent: false, canRestore: true })
    },
    onPageShow(persisted) {
      if (!persisted) return
      if (wantVoice || room !== null) stopSession({ reason: 'page_restored', notifyServer: true, clearIntent: false, canRestore: true })
    },
    joinAsListener: () => beginJoin({ mic: false, explicit: false, source: 'initial' }),
    joinWithMicrophone: () => {
      micRequestSource = 'initial'
      beginJoin({ mic: true, explicit: true, source: 'initial' })
    },
    resumeFromReload(withMicrophone) {
      // Без прозорец за разрешение: микрофонът — само ако браузърът вече го разрешава.
      beginJoin({ mic: withMicrophone, explicit: false, source: 'initial' })
    },
    notNow() {
      offerDismissed = true
      invalidate()
    },
    requestVip() {
      deps.onRequestVip?.()
    },
    leaveVoice() {
      if (!wantVoice && room === null && preparedSlot === null) return
      // Напускането на гласа НЕ напуска масата.
      stopSession({ reason: 'leave_voice', notifyServer: true, clearIntent: true, canRestore: false })
    },
    enableMicrophone() {
      void enableMicrophoneExplicit()
    },
    disableMicrophone() {
      if (disposed) return
      wantMic = false
      finishMicRequest('cancelled')
      dropMicrophone()
      saveIntent()
      invalidate()
    },
    retryMicrophone() {
      controller.enableMicrophone()
    },
    unlockAudio() {
      const current = room
      if (current === null) return
      void current.startAudio().then(
        () => {
          if (room !== current) return
          playbackBlocked = !current.canPlaybackAudio()
          invalidate()
        },
        () => {},
      )
    },
    retryConnection() {
      if (failed) {
        failed = false
        attempts = 0
        uncertainAttempts = 0
        setUiError(null)
        invalidate()
        kick()
        return
      }
      if (!wantVoice) {
        beginJoin({ mic: false, explicit: false, source: 'initial' })
        return
      }
      // Изрично „Опитай отново“ по време на пауза: веднага, без да чака backoff-а.
      attempts = 0
      kickRetryNow()
    },
    muteRemoteParticipant(profileId) {
      const table = tableContext()
      if (table === null || profileId === table.selfProfileId || locallyMuted.has(profileId)) return
      locallyMuted.add(profileId)
      locallyMutedTableId = table.voiceTableId
      if (room !== null) {
        for (const participant of room.listRemoteParticipants()) {
          if (profileIdFromVoiceIdentity(participant.identity) === profileId) room.setRemoteIdentityVolume(participant.identity, 0)
        }
      }
      invalidate()
    },
    unmuteRemoteParticipant(profileId) {
      if (!locallyMuted.delete(profileId)) return
      if (room !== null) {
        for (const participant of room.listRemoteParticipants()) {
          if (profileIdFromVoiceIdentity(participant.identity) === profileId) room.setRemoteIdentityVolume(participant.identity, 1)
        }
      }
      invalidate()
    },
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
      if (disposed) return
      stopSession({ reason: 'disposed', notifyServer: true, clearIntent: false, canRestore: false })
      contextGraceTimer = clearTimer(contextGraceTimer)
      const old = room
      room = null
      roomOwner = null
      if (old !== null) void old.disconnect().catch(() => {})
      if (preparedSlot !== null) void preparedSlot.connector.abort().catch(() => {})
      preparedSlot = null
      disposed = true
      listeners.clear()
      speakingListeners.clear()
      locallyMuted.clear()
      adapter = null
      adapterPromise = null
    },
    debugCounters: () => ({
      ...counters,
      roomsOpen,
      listeners: listeners.size,
      speakingListeners: speakingListeners.size,
      pendingTimers: [presenceTimer, retryTimer, heldTimer, transportTimer, contextGraceTimer].filter((t) => t !== null).length + speakingHoldTimers.size + (pendingAck === null ? 0 : 1),
      retainedMicrophone: held === null ? 0 : 1,
      driving: driving ? 1 : 0,
    }),
  }

  void log
  return controller
}

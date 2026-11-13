// Гласов чат — общ frontend controller (Етап 3; мобилна и desktop версия).
//
// Един instance за цялото приложение. Живее в lazy chunk-а (voiceRuntime.ts)
// и се създава от посредника voiceFacade.ts при първото изрично включване.
// Не зависи от DOM-а на екраните: получава КОНТЕКСТ (setContext) и сървърни
// съобщения, а LiveKit е зад VoiceAdapter. Визуалният интерфейс (Етапи 4/5)
// само чете snapshot-а и вика действията (чрез посредника).
//
// Инварианти:
//   * най-много една LiveKit стая и един локален микрофонен поток;
//   * никакво автоматично включване в гласа (сядане, VIP, край на mute,
//     refresh, връщане от лоби/магазин) — само изрично действие;
//   * getUserMedia само при право за говорене (backend проверка) И изрично
//     действие; никога при „Само слушай“, без VIP или при mute;
//   * JWT само в локална променлива до connect — не в state, storage, логове,
//     WS или грешки;
//   * всяка асинхронна операция носи operation generation (sessionSeq /
//     micSeq) и след всяко await проверява дали още е актуална — остаряла
//     операция никога не включва микрофон;
//   * таймерите са само докато гласът е в употреба и се чистят при край.
//
// Състояния (status):
//   disabled            — няма гласова маса / функцията е изключена / не е играч
//   idle                — гласова маса, гласът не е включен (може да се включи)
//   connecting          — presence -> token (HTTPS) -> LiveKit connect
//   connected_listening — свързан, без публикуван микрофон
//   connected_speaking  — свързан, микрофонът е включен
//   connected_muted     — свързан, говоренето е блокирано от административен mute
//   reconnecting        — официалният LiveKit reconnect
//   rotating            — нова генерация на стаята (старата е прекъсната)
//   disconnecting       — изрично напускане на гласа
//   unavailable         — гласовият сървър/мрежата временно не отговарят (има „Опитай отново“)
//   error               — неочаквана вътрешна грешка (има „Опитай отново“)
// Отделно от status: speak (право/наказание от backend), wantsToSpeak
// (желание на потребителя), microphone (реално състояние на capture-а),
// locallyMutedProfileIds (индивидуално заглушени), playbackBlocked (autoplay).

import {
  VoiceMicrophoneError,
  type VoiceAdapter,
  type VoiceAdapterEvents,
  type VoiceAdapterLoader,
  type VoiceConnectedRoom,
  type VoiceDiagnosticReport,
  type VoiceDisconnectCause,
  type VoiceRetainedMicrophone,
} from './voiceAdapter'
import {
  VOICE_SPEAK_ACCESS_PATH,
  VOICE_TOKEN_PATH,
  isVoiceServerMessage,
  profileIdFromVoiceIdentity,
  type VoicePresenceClientMessage,
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

/** Безопасно за показване: никога не съдържа токени, URL-и или сурови грешки. */
export type VoiceUiError = { code: VoiceUiErrorCode; message: string; detail: string | null }

export const VOICE_UI_MESSAGES: Record<VoiceUiErrorCode, { message: string; detail: string | null }> = {
  mic_not_found: { message: 'Не е открит микрофон.', detail: 'Можете да продължите да слушате.' },
  mic_permission_denied: { message: 'Разрешете достъпа до микрофона в настройките на браузъра.', detail: 'Можете да продължите да слушате.' },
  mic_unavailable: { message: 'Микрофонът е недостъпен.', detail: 'Можете да продължите да слушате.' },
  mic_blocked: { message: 'Микрофонът е блокиран.', detail: 'Имате активно наказание за чат. Можете да слушате останалите участници.' },
  vip_required: { message: 'Говоренето е VIP привилегия.', detail: null },
  service_unavailable: { message: 'Гласовият чат временно е недостъпен.', detail: null },
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
  /** „Възстанови гласовия чат“ — гласът е бил прекъснат (лоби, 120 s, lease), без автоматично връщане. */
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
  /** pagehide: страницата се скрива/затваря — гласът се прекратява (без автоматично връщане). */
  onPageHide: () => void
  /** pageshow от bfcache: старата връзка е мъртва. */
  onPageShow: (persisted: boolean) => void
  // действия (от потребителски жест)
  joinAsListener: () => void
  joinWithMicrophone: () => void
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
  /**
   * Етап 6 (по избор): анонимна диагностика за админ статистиката —
   * best-effort, никога не влияе на гласа. Липсваща -> нищо не се изпраща и
   * не се планират таймери.
   */
  reportDiagnostic?: (report: VoiceDiagnosticReport) => void
  createClientInstanceId?: () => string
  timers?: VoiceTimers
  log?: (line: string) => void
  timing?: {
    disconnectGraceMs?: number
    speakingHoldMs?: number
    presenceAckTimeoutMs?: number
    defaultRenewMs?: number
    tokenMaxAttempts?: number
    tokenBaseDelayMs?: number
    tokenMaxDelayMs?: number
    reconnectDelaysMs?: readonly number[]
    /** Максимално задържане на непубликуван capture по време на ротация. */
    retainMicMaxMs?: number
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

const DISABLING_PRESENCE_CODES = new Set(['voice_off', 'not_authenticated', 'table_not_found', 'table_released', 'not_a_player', 'banned'])
const DISABLING_HTTP_CODES = new Set(['voice_off', 'not_authenticated', 'table_not_found', 'table_released', 'spectator', 'bot', 'not_a_player', 'wrong_table', 'permanently_left', 'banned', 'forbidden_origin'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  const timers = deps.timers ?? defaultTimers
  const log = deps.log ?? (() => {})
  const disconnectGraceMs = deps.timing?.disconnectGraceMs ?? 120_000
  const speakingHoldMs = deps.timing?.speakingHoldMs ?? 400
  const presenceAckTimeoutMs = deps.timing?.presenceAckTimeoutMs ?? 5_000
  const defaultRenewMs = deps.timing?.defaultRenewMs ?? 20_000
  const tokenMaxAttempts = deps.timing?.tokenMaxAttempts ?? 6
  const tokenBaseDelayMs = deps.timing?.tokenBaseDelayMs ?? 1_000
  const tokenMaxDelayMs = deps.timing?.tokenMaxDelayMs ?? 8_000
  const reconnectDelaysMs = deps.timing?.reconnectDelaysMs ?? [2_000, 5_000, 10_000]
  const retainMicMaxMs = deps.timing?.retainMicMaxMs ?? 20_000
  // Една страница = един clientInstanceId (само в паметта; refresh -> нов).
  const clientInstanceId = (deps.createClientInstanceId ?? defaultClientInstanceId)()

  let context: VoiceContext = { kind: 'none' }
  let status: VoiceStatus = 'disabled'
  let speak: VoiceSpeakState | null = null
  let wantsToSpeak = false
  let microphone: VoiceMicrophoneState = 'off'
  let playbackBlocked = false
  let uiError: VoiceUiError | null = null
  let canRestore = false
  let offerDismissed = false
  let microphoneDevicesChanged = false
  let generation: number | null = null
  let gameConnected = true
  let disposed = false

  /** Гласът е „в употреба“: потребителят го е включил (presence/lease се подновява). */
  let inUse = false
  let sessionSeq = 0
  let micSeq = 0
  let adapter: VoiceAdapter | null = null
  let adapterPromise: Promise<VoiceAdapter> | null = null
  let room: VoiceConnectedRoom | null = null
  let prepared: { connect: (url: string, token: string) => Promise<VoiceConnectedRoom>; abort: () => Promise<void> } | null = null
  /**
   * Микрофон след прекъсване/нов токен:
   *   'reuse' — контролирана ротация: същият (запазен) capture се публикува в
   *             новата стая, без нов getUserMedia; ако не е жив -> слушане;
   *   'fresh' — само след изрично „Включи микрофона“ (request_new_token);
   *   'none'  — слушане. Прекратен/изгубен capture НИКОГА не води до
   *             автоматичен нов capture (connection_lost, room_deleted, mute…).
   */
  let restoreMic: 'none' | 'reuse' | 'fresh' = 'none'
  let retained: VoiceRetainedMicrophone | null = null
  let retainTimer: unknown = null
  /** Етап 6: еднократно отчитане на вида връзка (TURN/директна) след свързване. */
  let transportTimer: unknown = null
  /** Изключващи се стари стаи — новата се подготвя едва след тях (≤1 активна). */
  let teardown: Promise<void> = Promise.resolve()
  let teardownCount = 0

  let renewMs = defaultRenewMs
  let presenceTimer: unknown = null
  let disconnectTimer: unknown = null
  let retryTimer: unknown = null
  let retryKick: (() => void) | null = null
  let pendingAck: { resolve: (result: VoicePresenceResultMessage | null) => void; timer: unknown } | null = null

  const locallyMuted = new Set<string>()
  let locallyMutedTableId: string | null = null
  const activeIdentities = new Set<string>()
  const speakingProfiles = new Set<string>()
  const speakingHoldTimers = new Map<string, unknown>()

  const listeners = new Set<(snapshot: VoiceSnapshot) => void>()
  const speakingListeners = new Set<(profileIds: readonly string[]) => void>()
  let cachedSnapshot: VoiceSnapshot | null = null
  const counters: Record<string, number> = {
    adapterLoads: 0,
    roomsCreated: 0,
    roomsDisconnected: 0,
    tokenRequests: 0,
    micEnableAttempts: 0,
    micEnabled: 0,
    micDisabled: 0,
    presenceSent: 0,
    rotations: 0,
    micReused: 0,
    retainedReleased: 0,
  }

  // ─── Помощни ──────────────────────────────────────────────────────────

  const tableContext = (): Extract<VoiceContext, { kind: 'table' }> | null => (context.kind === 'table' ? context : null)
  const onTableScreen = (): boolean => {
    const table = tableContext()
    return table !== null && (table.screen === 'waiting' || table.screen === 'game')
  }
  const isConnectedStatus = (value: VoiceStatus): boolean =>
    value === 'connected_listening' || value === 'connected_speaking' || value === 'connected_muted'

  function setUiError(code: VoiceUiErrorCode | null): void {
    uiError = code === null ? null : { code, ...VOICE_UI_MESSAGES[code] }
  }

  function connectedStatus(): VoiceStatus {
    if (speak?.blockedReason === 'muted') return 'connected_muted'
    return microphone === 'live' ? 'connected_speaking' : 'connected_listening'
  }

  function refreshConnectedStatus(): void {
    if (isConnectedStatus(status)) status = connectedStatus()
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

  // ─── Етап 6: анонимна диагностика (best-effort) ───────────────────────

  function report(event: VoiceDiagnosticReport): void {
    if (deps.reportDiagnostic === undefined) return
    try { deps.reportDiagnostic(event) } catch { /* никога не влияе на гласа */ }
  }

  /** Веднъж на връзка: вид на ICE двойката (relay = TURN) и мрежови показатели. */
  function scheduleTransportReport(seq: number, connected: VoiceConnectedRoom): void {
    transportTimer = clearTimer(transportTimer)
    if (deps.reportDiagnostic === undefined || connected.getTransportInfo === undefined) return
    const attempt = (delayMs: number, retriesLeft: number): void => {
      transportTimer = timers.setTimeout(() => {
        transportTimer = null
        if (seq !== sessionSeq || room !== connected || disposed) return
        void connected.getTransportInfo!().then((transport) => {
          if (seq !== sessionSeq || room !== connected || disposed) return
          if (transport !== null) report({ event: 'transport', transport })
          else if (retriesLeft > 0) attempt(15_000, retriesLeft - 1)
        }).catch(() => {})
      }, delayMs)
    }
    attempt(5_000, 1)
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
    activeIdentities.clear()
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
      // ~400 ms задържане — без трептене при кратки паузи.
      speakingHoldTimers.set(profileId, timers.setTimeout(() => {
        speakingHoldTimers.delete(profileId)
        if (speakingProfiles.delete(profileId)) emitSpeaking()
      }, speakingHoldMs))
    }
    if (changed) emitSpeaking()
  }

  // ─── Presence / lease ─────────────────────────────────────────────────

  function sendPresence(onScreen: boolean): boolean {
    const table = tableContext()
    if (table === null) return false
    const sent = deps.sendPresence({ type: 'voice_presence', voiceTableId: table.voiceTableId, clientInstanceId, onTableScreen: onScreen })
    if (sent) counters.presenceSent! += 1
    return sent
  }

  function scheduleRenewal(): void {
    presenceTimer = clearTimer(presenceTimer)
    if (!inUse || !onTableScreen() || !gameConnected || disposed) return
    presenceTimer = timers.setTimeout(() => {
      presenceTimer = null
      if (!inUse || !onTableScreen() || !gameConnected) return
      sendPresence(true)
      scheduleRenewal()
    }, renewMs)
  }

  function settleAck(result: VoicePresenceResultMessage | null): void {
    if (pendingAck === null) return
    const ack = pendingAck
    pendingAck = null
    timers.clearTimeout(ack.timer)
    ack.resolve(result)
  }

  function presenceHandshake(): Promise<VoicePresenceResultMessage | null> {
    settleAck(null)
    if (!sendPresence(true)) return Promise.resolve(null)
    return new Promise((resolve) => {
      pendingAck = {
        resolve,
        timer: timers.setTimeout(() => settleAck(null), presenceAckTimeoutMs),
      }
    })
  }

  function waitKickable(delayMs: number): Promise<void> {
    retryTimer = clearTimer(retryTimer)
    return new Promise((resolve) => {
      retryKick = () => {
        retryKick = null
        retryTimer = clearTimer(retryTimer)
        resolve()
      }
      retryTimer = timers.setTimeout(() => {
        retryTimer = null
        retryKick = null
        resolve()
      }, delayMs)
    })
  }

  // ─── Стари стаи и запазен capture ─────────────────────────────────────

  function releaseRetained(): void {
    retainTimer = clearTimer(retainTimer)
    const held = retained
    retained = null
    if (held !== null) {
      counters.retainedReleased! += 1
      held.release()
    }
  }

  function adoptRetained(held: VoiceRetainedMicrophone): void {
    releaseRetained()
    retained = held
    // Ограничено задържане: ротацията не завършва навреме -> освобождаване и слушане.
    retainTimer = timers.setTimeout(() => {
      retainTimer = null
      releaseRetained()
      if (restoreMic === 'reuse') {
        restoreMic = 'none'
        wantsToSpeak = false
        invalidate()
      }
    }, retainMicMaxMs)
  }

  /**
   * Асинхронно изключване на стара стая. retainForSeq: контролирана ротация —
   * живият capture се откача преди disconnect и се пази САМО ако ротацията
   * още е актуална и микрофонът още е желан и позволен; иначе веднага се спира.
   */
  function teardownRoom(oldRoom: VoiceConnectedRoom | null, oldPrepared: typeof prepared, retainForSeq: number | null): void {
    if (oldRoom === null && oldPrepared === null) return
    if (oldRoom !== null) counters.roomsDisconnected! += 1
    teardownCount += 1
    const job = (async () => {
      if (oldRoom !== null) {
        if (retainForSeq !== null) {
          const held = await oldRoom.detachMicrophoneForReuse().catch(() => null)
          if (held !== null) {
            if (!disposed && retainForSeq === sessionSeq && restoreMic === 'reuse' && wantsToSpeak) adoptRetained(held)
            else held.release()
          }
        }
        await oldRoom.disconnect().catch(() => {})
      } else if (oldPrepared !== null) {
        await oldPrepared.abort().catch(() => {})
      }
    })().finally(() => { teardownCount -= 1 })
    teardown = Promise.all([teardown, job]).then(() => undefined)
  }

  // ─── Край на сесия / cleanup ──────────────────────────────────────────

  /**
   * Спира гласа на тази страница (връзка, микрофон, аудио, таймери, токени).
   * notifyServer -> voice_presence{onTableScreen:false} (лоби/магазин/напускане).
   */
  function stopSession(next: VoiceStatus, options: { canRestore: boolean; notifyServer: boolean }): void {
    sessionSeq += 1
    micSeq += 1
    presenceTimer = clearTimer(presenceTimer)
    disconnectTimer = clearTimer(disconnectTimer)
    retryTimer = clearTimer(retryTimer)
    transportTimer = clearTimer(transportTimer)
    retryKick = null
    settleAck(null)
    if (options.notifyServer && inUse) sendPresence(false)
    teardownRoom(room, prepared, null)
    room = null
    prepared = null
    inUse = false
    wantsToSpeak = false
    restoreMic = 'none'
    releaseRetained()
    microphone = 'off'
    playbackBlocked = false
    generation = null
    canRestore = options.canRestore
    status = next
    clearSpeaking()
    invalidate()
  }

  function disableEntirely(): void {
    stopSession('disabled', { canRestore: false, notifyServer: false })
    speak = null
    setUiError(null)
    invalidate()
  }

  // ─── Свързване ────────────────────────────────────────────────────────

  function adapterEvents(seq: number): VoiceAdapterEvents {
    const current = (): boolean => seq === sessionSeq && !disposed
    return {
      onDisconnected: (cause, retained) => {
        // Остаряло събитие (напр. ROOM_DELETED на старата стая СЛЕД като
        // ротацията вече е започнала от voice_table_updated) -> само освобождаване.
        if (current()) handleRoomDisconnected(cause, retained)
        else retained?.release()
      },
      onReconnecting: () => {
        if (!current() || room === null) return
        status = 'reconnecting'
        report({ event: 'reconnecting' })
        invalidate()
      },
      onReconnected: () => {
        if (!current() || room === null) return
        status = connectedStatus()
        report({ event: 'reconnected' })
        invalidate()
      },
      onActiveSpeakersChanged: (identities) => { if (current()) applyActiveSpeakers(identities) },
      onParticipantsChanged: () => { if (current()) invalidate() },
      onPlaybackStatusChanged: (canPlayback) => {
        // Само за свързана стая: при първо (lazy) включване startAudio() се
        // вика извън жеста и може да откаже още при подготовката — тогава
        // стойността се взима при connect (canPlaybackAudio) и от това събитие.
        if (!current() || room === null) return
        playbackBlocked = !canPlayback
        invalidate()
      },
      onLocalMicrophoneLost: () => {
        if (!current()) return
        // Изключено устройство / OS прекъсване: слушането продължава, без
        // автоматично записване от друго устройство.
        micSeq += 1
        wantsToSpeak = false
        restoreMic = 'none'
        releaseRetained()
        microphone = 'off'
        // Сървърно отнета публикация при mute -> текстът за наказание.
        setUiError(speak?.blockedReason === 'muted' ? 'mic_blocked' : 'mic_unavailable')
        refreshConnectedStatus()
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

  function prepareRoomNow(seq: number): void {
    if (adapter === null || prepared !== null || room !== null || teardownCount > 0) return
    try {
      prepared = adapter.prepare(adapterEvents(seq), (identity) => {
        const profileId = profileIdFromVoiceIdentity(identity)
        return profileId !== null && locallyMuted.has(profileId)
      })
      counters.roomsCreated! += 1
    } catch {
      prepared = null
    }
  }

  type TokenOutcome = { kind: 'token'; token: VoiceTokenSuccess } | { kind: 'disabled' } | { kind: 'unavailable' } | { kind: 'stale' }

  async function fetchToken(seq: number): Promise<TokenOutcome> {
    const table = tableContext()
    if (table === null) return { kind: 'stale' }
    for (let attempt = 1; attempt <= tokenMaxAttempts; attempt += 1) {
      if (seq !== sessionSeq) return { kind: 'stale' }
      counters.tokenRequests! += 1
      let response: { status: number; body: unknown } | null = null
      try {
        response = await deps.postJson(VOICE_TOKEN_PATH, { voiceTableId: table.voiceTableId, clientInstanceId })
      } catch {
        response = null
      }
      if (seq !== sessionSeq) return { kind: 'stale' }
      const body = response !== null && isObject(response.body) ? response.body : null
      if (response !== null && response.status === 200 && body !== null && body.ok === true && typeof body.token === 'string') {
        return { kind: 'token', token: body as unknown as VoiceTokenSuccess }
      }
      const code = body !== null && typeof body.code === 'string' ? body.code : 'network'
      if (DISABLING_HTTP_CODES.has(code)) return { kind: 'disabled' }
      if (code === 'presence_required' || code === 'invalid_session') {
        await presenceHandshake()
        if (seq !== sessionSeq) return { kind: 'stale' }
      }
      if (attempt === tokenMaxAttempts) break
      const hinted = body !== null && typeof body.retryAfterMs === 'number' ? body.retryAfterMs : 0
      const delay = Math.min(tokenMaxDelayMs, Math.max(hinted, tokenBaseDelayMs * 2 ** (attempt - 1)))
      await waitKickable(delay)
    }
    return { kind: 'unavailable' }
  }

  /** presence -> token -> connect за текущата сесия. */
  async function connectSession(seq: number, options: { enableMicAfter: boolean }): Promise<void> {
    let loaded: VoiceAdapter
    try {
      loaded = await ensureAdapter()
    } catch {
      if (seq !== sessionSeq) return
      report({ event: 'connect_failed', reason: 'sdk_load_failed' })
      failConnection('service_unavailable')
      return
    }
    if (seq !== sessionSeq) return
    void loaded
    const ack = await presenceHandshake()
    if (seq !== sessionSeq) return
    if (ack === null) {
      report({ event: 'connect_failed', reason: 'presence_failed' })
      failConnection('service_unavailable')
      return
    }
    if (!ack.ok) {
      if (DISABLING_PRESENCE_CODES.has(ack.code)) disableEntirely()
      else {
        report({ event: 'connect_failed', reason: 'presence_failed' })
        failConnection('service_unavailable')
      }
      return
    }
    const outcome = await fetchToken(seq)
    if (seq !== sessionSeq) return
    if (outcome.kind === 'disabled') {
      disableEntirely()
      return
    }
    if (outcome.kind !== 'token') {
      if (outcome.kind === 'unavailable') {
        report({ event: 'connect_failed', reason: 'token_unavailable' })
        failConnection('service_unavailable')
      }
      return
    }
    await teardown // старата стая е напълно изключена преди новата
    if (seq !== sessionSeq) return
    prepareRoomNow(seq)
    const connector = prepared
    if (connector === null) {
      failConnection('service_unavailable')
      return
    }
    let connected: VoiceConnectedRoom
    try {
      // Токенът се подава директно и не се пази никъде след това.
      connected = await connector.connect(outcome.token.url, outcome.token.token)
    } catch {
      if (seq !== sessionSeq) return
      prepared = null
      void connector.abort().catch(() => {})
      report({ event: 'connect_failed', reason: 'livekit_connect_failed' })
      failConnection('service_unavailable')
      return
    }
    if (seq !== sessionSeq) {
      void connected.disconnect().catch(() => {})
      return
    }
    prepared = null
    room = connected
    generation = outcome.token.generation
    speak = outcome.token.speak
    playbackBlocked = !connected.canPlaybackAudio()
    microphone = 'off'
    status = connectedStatus()
    // Индивидуалните заглушавания важат и в новата стая.
    for (const participant of connected.listRemoteParticipants()) {
      const profileId = profileIdFromVoiceIdentity(participant.identity)
      if (profileId !== null && locallyMuted.has(profileId)) connected.setRemoteIdentityVolume(participant.identity, 0)
    }
    scheduleRenewal()
    report({ event: 'connected' })
    scheduleTransportReport(seq, connected)
    invalidate()
    if (options.enableMicAfter) {
      if (speak.canSpeak) {
        void startMicrophone(seq, { checkWithBackend: false })
      } else {
        wantsToSpeak = false
        setUiError(speak.blockedReason === 'muted' ? 'mic_blocked' : 'vip_required')
        invalidate()
      }
    }
  }

  function failConnection(code: VoiceUiErrorCode): void {
    teardownRoom(room, prepared, null)
    room = null
    prepared = null
    presenceTimer = clearTimer(presenceTimer)
    transportTimer = clearTimer(transportTimer)
    if (inUse) sendPresence(false)
    inUse = false
    microphone = 'off'
    wantsToSpeak = false
    restoreMic = 'none'
    releaseRetained()
    clearSpeaking()
    status = 'unavailable'
    setUiError(code)
    invalidate()
  }

  function beginJoin(withMicrophone: boolean): void {
    if (disposed || !onTableScreen()) return
    if (inUse || status === 'connecting' || status === 'disconnecting') return
    sessionSeq += 1
    const seq = sessionSeq
    inUse = true
    wantsToSpeak = withMicrophone
    canRestore = false
    offerDismissed = true
    microphoneDevicesChanged = false
    setUiError(null)
    status = 'connecting'
    // Ако SDK-то вече е заредено: стаята и отключването на аудиото са в
    // СЪЩИЯ потребителски жест (autoplay на iOS/Android).
    prepareRoomNow(seq)
    invalidate()
    void connectSession(seq, { enableMicAfter: withMicrophone })
  }

  // ─── Прекъсвания на стаята, ротация, reconnect ────────────────────────

  function handleRoomDisconnected(cause: VoiceDisconnectCause, held: VoiceRetainedMicrophone | null): void {
    if (cause === 'client') {
      held?.release()
      return
    }
    if (cause === 'room_deleted') {
      // Ротация, при която LiveKit е изтрил стаята ПРЕДИ voice_table_updated:
      // адаптерът е предал живия capture — същите правила като при
      // контролирана ротация (beginRotation решава дали да го задържи).
      beginRotation({ held })
      return
    }
    held?.release()
    room = null
    prepared = null
    // Адаптерът вече е спрял локалния capture — прекратен capture не води до
    // автоматичен нов: само слушане след връщане.
    microphone = 'off'
    wantsToSpeak = false
    restoreMic = 'none'
    clearSpeaking()
    if (cause === 'removed') {
      // Сървърът е прекратил достъпа (lease, напуснат екран, 120 s) —
      // voice_access_ended носи причината; без автоматично връщане.
      stopSession('idle', { canRestore: true, notifyServer: false })
      return
    }
    if (cause === 'duplicate_identity') {
      stopSession('idle', { canRestore: false, notifyServer: false })
      return
    }
    // connection_lost: официалният reconnect на LiveKit не е успял —
    // ограничени нови опити с нов токен (без втори паралелен цикъл).
    report({ event: 'connection_lost' })
    void reconnectWithBackoff()
  }

  /**
   * Ротация — и по двата реда на събитията:
   *   * voice_table_updated{ready:false} първо: стаята е жива -> capture-ът се
   *     откача преди нашия disconnect (teardownRoom);
   *   * ROOM_DELETED първо (`deleted`): стаята вече е изключена от сървъра,
   *     адаптерът е предал живия capture (`deleted.held`).
   * Последващото другото събитие не започва втора ротация (status 'rotating'
   * / остаряло събитие на старата стая -> само освобождаване).
   */
  function beginRotation(deleted?: { held: VoiceRetainedMicrophone | null }): void {
    if (!inUse) {
      deleted?.held?.release()
      return
    }
    counters.rotations! += 1
    sessionSeq += 1
    micSeq += 1
    const seq = sessionSeq
    // Незасегнат говорещ (жив capture, желан и позволен) запазва същия capture;
    // доброволно изключен, наказан или чакащ микрофон -> слушане.
    const micAllowed = microphone === 'live' && wantsToSpeak && speak?.canSpeak === true
    const keepMic = micAllowed && (deleted !== undefined ? deleted.held !== null : room !== null)
    restoreMic = keepMic ? 'reuse' : 'none'
    if (!keepMic) wantsToSpeak = false
    if (deleted === undefined) {
      teardownRoom(room, prepared, keepMic ? seq : null)
    } else if (keepMic) {
      adoptRetained(deleted.held!)
    } else {
      deleted.held?.release()
    }
    room = null
    prepared = null
    microphone = 'off'
    clearSpeaking()
    status = 'rotating'
    invalidate()
    void resumeAfterInterruption(seq)
  }

  async function reconnectWithBackoff(): Promise<void> {
    if (!inUse) return
    sessionSeq += 1
    micSeq += 1
    const seq = sessionSeq
    status = 'reconnecting'
    invalidate()
    for (const delay of reconnectDelaysMs) {
      await waitKickable(delay)
      if (seq !== sessionSeq) return
      if (!onTableScreen()) return
      const resumed = await tryResume(seq)
      if (resumed !== 'retry') return
    }
    if (seq === sessionSeq) {
      report({ event: 'reconnect_failed' })
      failConnection('service_unavailable')
    }
  }

  async function resumeAfterInterruption(seq: number): Promise<void> {
    const outcome = await tryResume(seq)
    if (outcome === 'retry' && seq === sessionSeq) failConnection('service_unavailable')
  }

  /** Нов токен за текущата генерация и свързване; запазва режима (слушане/микрофон). */
  async function tryResume(seq: number): Promise<'done' | 'retry'> {
    const outcome = await fetchToken(seq)
    if (seq !== sessionSeq) return 'done'
    if (outcome.kind === 'disabled') {
      disableEntirely()
      return 'done'
    }
    if (outcome.kind !== 'token') return outcome.kind === 'stale' ? 'done' : 'retry'
    await teardown // старата стая (и откачването на capture-а) е приключила
    if (seq !== sessionSeq) return 'done'
    prepareRoomNow(seq)
    const connector = prepared
    if (connector === null) return 'retry'
    try {
      const connected = await connector.connect(outcome.token.url, outcome.token.token)
      if (seq !== sessionSeq) {
        void connected.disconnect().catch(() => {})
        return 'done'
      }
      prepared = null
      room = connected
      generation = outcome.token.generation
      speak = outcome.token.speak
      playbackBlocked = !connected.canPlaybackAudio()
      for (const participant of connected.listRemoteParticipants()) {
        const profileId = profileIdFromVoiceIdentity(participant.identity)
        if (profileId !== null && locallyMuted.has(profileId)) connected.setRemoteIdentityVolume(participant.identity, 0)
      }
      status = connectedStatus()
      scheduleRenewal()
      report({ event: 'connected' })
      scheduleTransportReport(seq, connected)
      invalidate()
      // Микрофонът в новата стая: само при валидно право и запазено желание.
      //   reuse — същият жив capture (без getUserMedia); не е жив -> слушане;
      //   fresh — изрично „Включи микрофона“, изискало нов токен;
      //   none  — слушане (никога автоматичен нов capture).
      const mode = restoreMic
      restoreMic = 'none'
      const held = retained
      retained = null
      retainTimer = clearTimer(retainTimer)
      if (mode !== 'none' && wantsToSpeak && speak.canSpeak) {
        if (mode === 'fresh') {
          void startMicrophone(seq, { checkWithBackend: false })
        } else if (held !== null && held.isLive()) {
          void startMicrophone(seq, { checkWithBackend: false, reuse: held })
        } else {
          held?.release()
          wantsToSpeak = false
          setUiError('mic_unavailable')
          invalidate()
        }
      } else {
        if (held !== null) {
          counters.retainedReleased! += 1
          held.release()
        }
        wantsToSpeak = false
      }
      return 'done'
    } catch {
      prepared = null
      void connector.abort().catch(() => {})
      return 'retry'
    }
  }

  // ─── Микрофон ─────────────────────────────────────────────────────────

  async function startMicrophone(seq: number, options: { checkWithBackend: boolean; reuse?: VoiceRetainedMicrophone }): Promise<void> {
    micSeq += 1
    const mSeq = micSeq
    const stale = (): boolean => seq !== sessionSeq || mSeq !== micSeq || disposed
    const table = tableContext()
    if (room === null || table === null) {
      options.reuse?.release()
      return
    }
    wantsToSpeak = true
    microphone = 'requesting'
    microphoneDevicesChanged = false
    setUiError(null)
    invalidate()
    if (options.checkWithBackend) {
      // Авторитетна backend проверка — не се доверяваме на стар клиентски VIP статус.
      let response: { status: number; body: unknown } | null = null
      try {
        response = await deps.postJson(VOICE_SPEAK_ACCESS_PATH, { voiceTableId: table.voiceTableId, clientInstanceId })
      } catch {
        response = null
      }
      if (stale()) return
      const body = response !== null && isObject(response.body) ? (response.body as VoiceSpeakAccessResult & Record<string, unknown>) : null
      if (response === null || response.status !== 200 || body === null || body.ok !== true) {
        microphone = 'off'
        wantsToSpeak = false
        setUiError('service_unavailable')
        refreshConnectedStatus()
        invalidate()
        return
      }
      if (body.canSpeak === false) {
        microphone = 'off'
        wantsToSpeak = false
        if (body.speak !== undefined) speak = body.speak
        setUiError(body.code === 'muted' ? 'mic_blocked' : 'vip_required')
        refreshConnectedStatus()
        invalidate()
        return
      }
      if (speak !== null) speak = { ...speak, canSpeak: true, blockedReason: null }
      if (body.upgrade === 'request_new_token') {
        // Правата в LiveKit не са повишени на място -> нов токен (кратък реконект).
        await reconnectForPermissions(seq)
        return
      }
    }
    const currentRoom = room
    if (currentRoom === null || stale()) {
      options.reuse?.release()
      return
    }
    if (options.reuse !== undefined) counters.micReused! += 1
    else counters.micEnableAttempts! += 1
    try {
      await currentRoom.enableMicrophone(options.reuse)
    } catch (error) {
      if (stale()) return
      microphone = 'off'
      wantsToSpeak = false
      const failure = error instanceof VoiceMicrophoneError ? error.failure : 'unavailable'
      report({
        event: 'mic_failed',
        reason: failure === 'not_found' ? 'mic_not_found'
          : failure === 'permission_denied' ? 'mic_permission_denied'
            : failure === 'not_permitted' ? 'mic_not_permitted'
              : 'mic_unavailable',
      })
      setUiError(
        failure === 'not_found' ? 'mic_not_found'
          : failure === 'permission_denied' ? 'mic_permission_denied'
            : failure === 'not_permitted' ? (speak?.blockedReason === 'muted' ? 'mic_blocked' : 'vip_required')
              : 'mic_unavailable',
      )
      refreshConnectedStatus()
      invalidate()
      return
    }
    if (stale() || room !== currentRoom) {
      // Остаряла операция (изключване, напускане, mute) — никога не оставяме микрофона включен.
      void currentRoom.disableMicrophone().catch(() => {})
      return
    }
    counters.micEnabled! += 1
    microphone = 'live'
    refreshConnectedStatus()
    invalidate()
  }

  async function reconnectForPermissions(seq: number): Promise<void> {
    if (seq !== sessionSeq) return
    sessionSeq += 1
    const nextSeq = sessionSeq
    teardownRoom(room, prepared, null)
    room = null
    prepared = null
    await teardown
    if (nextSeq !== sessionSeq) return
    // Изрично „Включи микрофона“ (правото е потвърдено от backend-а) —
    // единственият случай на capture след нов токен.
    restoreMic = 'fresh'
    wantsToSpeak = true
    microphone = 'off'
    status = 'connecting'
    invalidate()
    const outcome = await tryResume(nextSeq)
    if (outcome === 'retry' && nextSeq === sessionSeq) failConnection('service_unavailable')
  }

  function stopMicrophone(): void {
    micSeq += 1
    wantsToSpeak = false
    restoreMic = 'none'
    releaseRetained()
    const currentRoom = room
    if (microphone !== 'off' && currentRoom !== null) counters.micDisabled! += 1
    microphone = 'off'
    if (currentRoom !== null) void currentRoom.disableMicrophone().catch(() => {})
    refreshConnectedStatus()
    invalidate()
  }

  // ─── Сървърни съобщения ───────────────────────────────────────────────

  function applySpeakState(next: VoiceSpeakState): void {
    speak = next
    if (!next.canSpeak && next.blockedReason === 'muted') {
      // Административен mute: незабавно спиране и освобождаване на
      // микрофона; слушането остава. Без автоматично включване след края му.
      if (microphone !== 'off' || wantsToSpeak) stopMicrophone()
      restoreMic = 'none'
      releaseRetained() // и запазеният capture по време на ротация
      setUiError('mic_blocked')
    } else if (next.canSpeak && uiError !== null && (uiError.code === 'mic_blocked' || uiError.code === 'vip_required')) {
      setUiError(null)
    }
    refreshConnectedStatus()
    invalidate()
  }

  function handleServerMessage(message: { type: string }): boolean {
    if (!isVoiceServerMessage(message)) return false
    const table = tableContext()
    if (table === null || message.voiceTableId !== table.voiceTableId) return true
    switch (message.type) {
      case 'voice_presence_result': {
        if (message.ok) {
          renewMs = Math.max(5_000, Math.min(message.renewAfterMs, message.leaseTtlMs / 2))
          if (message.onTableScreen) applySpeakState(message.speak)
        } else if (DISABLING_PRESENCE_CODES.has(message.code) && pendingAck === null) {
          disableEntirely()
        }
        settleAck(message)
        return true
      }
      case 'voice_table_updated': {
        if (!inUse) return true
        if (!message.ready) {
          // Закъсняло съобщение за генерацията, в която вече сме -> без втора ротация.
          if (generation !== null && message.generation === generation && room !== null) return true
          if (status !== 'rotating' && (room !== null || isConnectedStatus(status) || status === 'reconnecting')) {
            beginRotation()
          }
        } else if (retryKick !== null) {
          retryKick() // готово -> веднага нов токен
        } else if (status === 'rotating' && room === null) {
          void resumeAfterInterruption(sessionSeq)
        }
        return true
      }
      case 'voice_access_ended': {
        const permanent = message.reason === 'banned' || message.reason === 'session_displaced' || message.reason === 'voice_off'
          || message.reason === 'table_released' || message.reason === 'kicked'
        if (permanent) disableEntirely()
        else stopSession('idle', { canRestore: message.reason !== 'session_replaced', notifyServer: false })
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

  function computeParticipants(): VoiceSeatParticipant[] {
    const table = tableContext()
    if (table === null) return []
    const connectedNow = room !== null && (isConnectedStatus(status) || status === 'reconnecting')
    const remote = new Map<string, boolean>()
    if (connectedNow && room !== null) {
      for (const participant of room.listRemoteParticipants()) {
        const profileId = profileIdFromVoiceIdentity(participant.identity)
        if (profileId !== null) remote.set(profileId, participant.microphonePublished || remote.get(profileId) === true)
      }
    }
    const result: VoiceSeatParticipant[] = []
    for (const seat of table.seats) {
      if (seat.isBot || seat.profileId === null) continue // ботовете не участват
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
    cachedSnapshot = {
      status,
      voiceTableId: table?.voiceTableId ?? null,
      screen: table?.screen ?? null,
      speak,
      wantsToSpeak,
      microphone,
      playbackBlocked,
      uiError,
      canRestore,
      offerDismissed,
      microphoneDevicesChanged,
      generation,
      locallyMutedProfileIds: [...locallyMuted].sort(),
      participants: computeParticipants(),
      speakingProfileIds: [...speakingProfiles].sort(),
    }
    return cachedSnapshot
  }

  // ─── Публичен API ─────────────────────────────────────────────────────

  function sameSeats(a: readonly VoiceSeatInfo[], b: readonly VoiceSeatInfo[]): boolean {
    return a.length === b.length && a.every((seat, index) => seat.profileId === b[index]!.profileId && seat.isBot === b[index]!.isBot)
  }

  const controller: VoiceController = {
    setContext(next) {
      if (disposed) return
      const previous = context
      const prevTable = previous.kind === 'table' ? previous : null
      const nextTable = next.kind === 'table' ? next : null
      if (prevTable !== null && nextTable !== null
        && prevTable.voiceTableId === nextTable.voiceTableId
        && prevTable.selfProfileId === nextTable.selfProfileId
        && prevTable.screen === nextTable.screen
        && sameSeats(prevTable.seats, nextTable.seats)) {
        return
      }
      const tableChanged = prevTable === null || nextTable === null
        || prevTable.voiceTableId !== nextTable.voiceTableId || prevTable.selfProfileId !== nextTable.selfProfileId
      if (tableChanged) {
        // Друга маса / край на масата / logout: пълно прекратяване; локалните
        // заглушавания важат само за същата маса.
        if (inUse && prevTable !== null) sendPresence(false)
        context = next
        stopSession(nextTable === null ? 'disabled' : 'idle', { canRestore: false, notifyServer: false })
        speak = null
        setUiError(null)
        offerDismissed = false
        if (locallyMutedTableId !== (nextTable?.voiceTableId ?? null)) {
          locallyMuted.clear()
          locallyMutedTableId = nextTable?.voiceTableId ?? null
        }
      } else {
        const wasOnScreen = prevTable!.screen === 'waiting' || prevTable!.screen === 'game'
        context = next
        const nowOnScreen = nextTable!.screen === 'waiting' || nextTable!.screen === 'game'
        if (wasOnScreen && !nowOnScreen && inUse) {
          // „Изчакай в лоби“, магазин, „Към лобито“: прекратяване (сървърно
          // съобщение), мястото и правото за говорене се пазят.
          stopSession('idle', { canRestore: true, notifyServer: true })
        } else if (!wasOnScreen && nowOnScreen && status === 'disabled') {
          status = 'idle'
        }
        // чакалня -> игра: гласът продължава без прекъсване (същата маса).
      }
      if (nextTable !== null && status === 'disabled' && !tableChanged) status = 'idle'
      if (nextTable !== null && (nextTable.screen === 'waiting' || nextTable.screen === 'game')) {
        // Адаптерът вече е в паметта (същият lazy chunk) — без мрежа; така
        // следващите включвания подготвят стаята синхронно в жеста (autoplay).
        void ensureAdapter().catch(() => {})
      }
      invalidate()
    },
    handleServerMessage,
    setGameConnection(connected) {
      if (disposed || connected === gameConnected) return
      gameConnected = connected
      if (!connected) {
        presenceTimer = clearTimer(presenceTimer)
        // Един таймер за целия период без игрова връзка (не се рестартира при неуспешни опити).
        if (inUse && disconnectTimer === null) {
          disconnectTimer = timers.setTimeout(() => {
            disconnectTimer = null
            stopSession('idle', { canRestore: true, notifyServer: false })
          }, disconnectGraceMs)
        }
        return
      }
      disconnectTimer = clearTimer(disconnectTimer)
      if (inUse && onTableScreen()) {
        sendPresence(true)
        scheduleRenewal()
        if (retryKick !== null) retryKick()
      }
    },
    endSession() {
      locallyMuted.clear()
      locallyMutedTableId = null
      disableEntirely()
    },
    onPageHide() {
      if (inUse || room !== null || prepared !== null) stopSession('idle', { canRestore: true, notifyServer: true })
    },
    onPageShow(persisted) {
      if (persisted && (inUse || room !== null)) stopSession('idle', { canRestore: true, notifyServer: true })
    },
    joinAsListener: () => beginJoin(false),
    joinWithMicrophone: () => beginJoin(true),
    notNow() {
      offerDismissed = true
      invalidate()
    },
    requestVip() {
      deps.onRequestVip?.()
    },
    leaveVoice() {
      if (!inUse && room === null && prepared === null) return
      status = 'disconnecting'
      invalidate()
      // Напускането на гласа НЕ напуска масата.
      stopSession('idle', { canRestore: false, notifyServer: true })
    },
    enableMicrophone() {
      if (disposed) return
      if (room === null) {
        if (!inUse) beginJoin(true)
        return
      }
      if (microphone === 'requesting' || microphone === 'live') return
      void startMicrophone(sessionSeq, { checkWithBackend: true })
    },
    disableMicrophone() {
      if (disposed) return
      stopMicrophone()
    },
    retryMicrophone() {
      controller.enableMicrophone()
    },
    unlockAudio() {
      const currentRoom = room
      if (currentRoom === null) return
      void currentRoom.startAudio().then(
        () => {
          if (room !== currentRoom) return
          playbackBlocked = !currentRoom.canPlaybackAudio()
          invalidate()
        },
        () => {},
      )
    },
    retryConnection() {
      if (status === 'unavailable' || status === 'error') {
        status = 'idle'
        beginJoin(wantsToSpeak)
      }
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
      stopSession('disabled', { canRestore: false, notifyServer: true })
      disposed = true
      listeners.clear()
      speakingListeners.clear()
      locallyMuted.clear()
      adapter = null
      adapterPromise = null
    },
    debugCounters: () => ({
      ...counters,
      listeners: listeners.size,
      speakingListeners: speakingListeners.size,
      pendingTimers: [presenceTimer, disconnectTimer, retryTimer, retainTimer, transportTimer].filter((t) => t !== null).length + speakingHoldTimers.size + (pendingAck === null ? 0 : 1),
      retainedMicrophone: retained === null ? 0 : 1,
    }),
  }

  void log
  return controller
}

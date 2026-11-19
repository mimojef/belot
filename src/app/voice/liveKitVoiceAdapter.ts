// Гласов чат — реален LiveKit адаптер (Етап 3).
//
// ЕДИНСТВЕНИЯТ модул, който импортира livekit-client. Влиза само в lazy
// runtime chunk-а (voiceRuntime.ts -> assets/voice-*, vite.config.ts), извън
// PWA precache-а — потребител, който не включва гласа, никога не го изтегля.
//
// Аудио:
//   * echo cancellation, noise suppression, auto gain, моно (channelCount 1);
//   * AudioPresets.speech, DTX и RED (Opus) — стандартните WebRTC/LiveKit
//     механизми, без допълнителни библиотеки;
//   * без видео, без screen share, без data.
// Микрофон:
//   * включване само при изрично действие: getUserMedia (тук) -> publishTrack
//     като user-provided track — SDK-то никога не прави сам нов capture
//     (restartTrack при „track ended“ / пълен reconnect е изключен);
//   * изключване = unpublishTrack(track, stop=true) + MediaStreamTrack.stop
//     (индикаторът на OS изгасва);
//   * ротация: detachMicrophoneForReuse или ROOM_DELETED -> живият capture се
//     предава на контролера (VoiceRetainedMicrophone);
//   * изключено/изгубено устройство, сървърно премахване на публикацията ->
//     capture-ът се освобождава; НЕ се превключва автоматично към друго устройство;
//   * публикуване, прекъснато от reconnect на SDK-то (пълният reconnect отменя
//     незавършеното addTrack) -> живият capture се връща на контролера
//     (VoiceMicrophoneError('interrupted')) за публикуване след възстановяването.

import {
  AudioPresets,
  ConnectionState,
  DisconnectReason,
  LogLevel,
  MediaDeviceFailure,
  type LocalTrack,
  type Participant,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  TrackEvent,
  setLogLevel,
} from 'livekit-client'
import {
  VoiceMicrophoneError,
  type VoiceAdapter,
  type VoiceAdapterEvents,
  type VoiceConnectedRoom,
  type VoiceDisconnectCause,
  type VoiceLiveKitDisconnectReason,
  type VoiceCaptureStallConfirmation,
  type VoiceMediaDiagnosticReport,
  type VoiceMediaInputEvidence,
  type VoiceMediaRecoveryResult,
  type VoiceMicRecoveryResult,
  type VoiceMediaTrigger,
  type VoiceMicHealth,
  type VoiceMicrophoneFailure,
  type VoiceMicrophoneLossReason,
  type VoiceRetainedMicrophone,
} from './voiceAdapter'
import { classifyPublishError } from './voicePublishErrors'
import { isMicrophonePermissionGranted } from './voiceIntentStore'
import type { VoiceAudioSink } from './voiceAudioSink'
import { summarizeTransportStats } from './voiceTransportStats'
import {
  VOICE_MEDIA_SAMPLE_INTERVAL_MS,
  createCoalescedTask,
  createInputHealthEvaluator,
  createRecoveryLimiter,
  createRemoteStallEvaluator,
  type VoiceInputVerdict,
  type VoiceOutboundSample,
} from './voiceMediaHealth'

// SDK-то може да логва URL-и с токени на debug ниво — само предупреждения.
setLogLevel(LogLevel.warn)

const AUDIO_CAPTURE = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
} as const

/** Колко се чака Disconnected след сървърно премахване на микрофона (изтриване на стаята при ротация). */
const SERVER_UNPUBLISH_GRACE_MS = 2_000

function mapDisconnectReason(reason: DisconnectReason | undefined, clientInitiated: boolean): VoiceDisconnectCause {
  if (clientInitiated || reason === DisconnectReason.CLIENT_INITIATED) return 'client'
  if (reason === DisconnectReason.ROOM_DELETED) return 'room_deleted'
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) return 'removed'
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) return 'duplicate_identity'
  return 'connection_lost'
}

// Подробна причина — само за анонимната диагностика (затворено изброяване).
function describeDisconnectReason(reason: DisconnectReason | undefined, clientInitiated: boolean): VoiceLiveKitDisconnectReason {
  if (clientInitiated || reason === DisconnectReason.CLIENT_INITIATED) return 'client'
  switch (reason) {
    case DisconnectReason.ROOM_DELETED: return 'room_deleted'
    case DisconnectReason.PARTICIPANT_REMOVED: return 'participant_removed'
    case DisconnectReason.DUPLICATE_IDENTITY: return 'duplicate_identity'
    case DisconnectReason.SERVER_SHUTDOWN: return 'server_shutdown'
    case DisconnectReason.JOIN_FAILURE: return 'join_failure'
    case DisconnectReason.STATE_MISMATCH: return 'state_mismatch'
    case DisconnectReason.MIGRATION: return 'migration'
    case DisconnectReason.SIGNAL_CLOSE: return 'signal_close'
    case DisconnectReason.UNKNOWN_REASON:
    case undefined: return 'network'
    default: return 'other'
  }
}

function mapMicrophoneError(error: unknown): VoiceMicrophoneFailure {
  const failure = MediaDeviceFailure.getFailure(error)
  if (failure === MediaDeviceFailure.PermissionDenied) return 'permission_denied'
  if (failure === MediaDeviceFailure.NotFound) return 'not_found'
  if (failure === MediaDeviceFailure.DeviceInUse) return 'busy'
  if (failure === MediaDeviceFailure.Other) return 'unavailable'
  // Не е грешка на устройството: сървърът е отказал публикуването (права).
  const message = error instanceof Error ? error.message : String(error)
  if (/permission|not allowed|insufficient|unauthori[sz]ed/i.test(message)) return 'not_permitted'
  return 'unavailable'
}

function stopTrack(track: MediaStreamTrack): void {
  try { track.stop() } catch { /* вече спрян */ }
}

// Запазени capture-и (ротация): handle -> MediaStreamTrack. release() го спира.
const retainedCaptures = new WeakMap<VoiceRetainedMicrophone, MediaStreamTrack>()

function retainCapture(capture: MediaStreamTrack): VoiceRetainedMicrophone {
  const handle: VoiceRetainedMicrophone = {
    isLive: () => retainedCaptures.has(handle) && capture.readyState === 'live',
    release: () => {
      if (!retainedCaptures.delete(handle)) return
      try { capture.stop() } catch { /* вече спрян */ }
    },
  }
  retainedCaptures.set(handle, capture)
  return handle
}

// ─── Етап H1/H2: медийно здраве ─────────────────────────────────────────
//
// H1 (само наблюдение на собствения микрофон): на всеки 3 s, САМО при
// публикуван микрофон, свързана стая и видима страница — един
// sender.getStats() (без припокриване: следващото измерване се планира чак
// след края на текущото). Решенията са в voiceMediaHealth.ts. Адаптерът
// НИКОГА не придобива/публикува/сменя микрофона заради здравето му.
// Допълнително (само диагностика): receiver.getStats() за отдалечен track,
// само докато сървърът (ActiveSpeakers) отчита участника като говорещ ≥3 s.
//
// H2 (входящо аудио): неочаквана пауза, връщане на преден план (visibility /
// focus / pageshow), смяна на устройствата и неправилно прикачване ->
// ЕДНА обединена проверка наведнъж -> play() или повторно прикачване с НОВ
// елемент (стар/откачен елемент никога не се пуска отново). Лимит на track
// sid (повторното прикачване не дава нов бюджет). NotAllowedError / изчерпан
// лимит -> съществуващият бутон „Включи звука“ (жест). Локалното заглушаване
// (volume 0) се пази.

/** Активни таймери/слушатели във всички стаи (тестове за изтичане). */
const mediaGlobal = { monitorTimers: 0, pageListenerSets: 0, elementListeners: 0, captureListeners: 0, outputTasks: 0, recoveryOps: 0 }

/** Брояч на кадрите на capture-а (MediaStreamTrack.stats, Chromium) — независим от RTP; null — няма. */
function captureFrames(capture: MediaStreamTrack): number | null {
  try {
    const stats = (capture as MediaStreamTrack & { stats?: { totalFrames?: unknown } }).stats
    return typeof stats?.totalFrames === 'number' && Number.isFinite(stats.totalFrames) ? stats.totalFrames : null
  } catch {
    return null
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

type StatsEntry = Record<string, unknown> & { type?: unknown; id?: unknown; kind?: unknown; timestamp?: unknown }

function statsEntries(report: RTCStatsReport | null): StatsEntry[] {
  const entries: StatsEntry[] = []
  report?.forEach((entry: unknown) => { if (typeof entry === 'object' && entry !== null) entries.push(entry as StatsEntry) })
  return entries
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const isAudioEntry = (entry: StatsEntry): boolean => entry.kind === 'audio' || entry.mediaType === 'audio'

/**
 * outbound-rtp на sender-а и media-source на ТЕКУЩИЯ capture. След replaceTrack
 * статистиката може да съдържа и стари media-source записи (замръзнали броячи),
 * а mediaSourceId може да изостава — затова първо по trackIdentifier на capture-а,
 * после по outbound-rtp.mediaSourceId, и само ако е единствен.
 */
function pickOutboundAndSource(entries: StatsEntry[], capture: MediaStreamTrack | null): { outbound: StatsEntry | undefined; source: StatsEntry | undefined } {
  const outbound = entries.find((entry) => entry.type === 'outbound-rtp' && isAudioEntry(entry))
  const sources = entries.filter((entry) => entry.type === 'media-source' && isAudioEntry(entry))
  const linkedId = text(outbound?.mediaSourceId)
  let source = capture === null ? undefined : sources.find((entry) => entry.trackIdentifier === capture.id)
  if (source === undefined && linkedId !== null && sources.some((entry) => typeof entry.trackIdentifier !== 'string')) source = sources.find((entry) => entry.id === linkedId)
  if (source === undefined && sources.length === 1 && typeof sources[0]!.trackIdentifier !== 'string') source = sources[0]
  return { outbound, source }
}

/** getUserMedia при възстановяване — с краен срок (неотговорен прозорец не държи операцията). */
const RECOVERY_GUM_TIMEOUT_MS = 20_000

/** Приоритет при обединени тригери (за диагностиката — един тригер на проверка). */
const TRIGGER_PRIORITY: readonly VoiceMediaTrigger[] = ['pause', 'visible', 'pageshow', 'focus', 'devicechange', 'attach_check']

/** Еднократно предаване; невалиден/прекратен capture се освобождава -> null. */
function takeRetainedCapture(handle: VoiceRetainedMicrophone): MediaStreamTrack | null {
  const capture = retainedCaptures.get(handle)
  if (capture === undefined) return null
  if (capture.readyState !== 'live') {
    handle.release()
    return null
  }
  retainedCaptures.delete(handle)
  return capture
}

export function createLiveKitVoiceAdapter(sink: VoiceAudioSink): VoiceAdapter {
  let activeRoom: Room | null = null

  return {
    debugMediaGlobal: () => ({ ...mediaGlobal }),
    microphonePermissionGranted: () => isMicrophonePermissionGranted(),
    // Само придобиване (getUserMedia) — независимо от стаята; публикуването е
    // отделно (enableMicrophone(reuse) в текущата стая). release() спира track-а.
    async acquireMicrophone() {
      let capture: MediaStreamTrack | undefined
      try {
        if (navigator.mediaDevices?.getUserMedia === undefined) throw new VoiceMicrophoneError('unavailable')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CAPTURE } })
        capture = stream.getAudioTracks()[0]
        for (const other of stream.getTracks()) if (other !== capture) stopTrack(other)
      } catch (error) {
        throw error instanceof VoiceMicrophoneError ? error : new VoiceMicrophoneError(mapMicrophoneError(error))
      }
      if (capture === undefined) throw new VoiceMicrophoneError('not_found')
      return retainCapture(capture)
    },
    prepare(events: VoiceAdapterEvents, isIdentityLocallyMuted: (identity: string) => boolean) {
      if (activeRoom !== null) throw new Error('voice_room_already_active')
      const room = new Room({
        adaptiveStream: false,
        dynacast: false,
        // false: LiveKit не спира сам локалния capture (вкл. при ROOM_DELETED) —
        // адаптерът винаги спира изрично (unpublish(stop) + MediaStreamTrack.stop)
        // или го предава за ротация; виж Disconnected / LocalTrackUnpublished.
        stopLocalTrackOnUnpublish: false,
        disconnectOnPageLeave: true,
        audioCaptureDefaults: { ...AUDIO_CAPTURE },
        publishDefaults: { audioPreset: AudioPresets.speech, dtx: true, red: true, stopMicTrackOnMute: true },
      })
      activeRoom = room
      let clientDisconnect = false
      let disposed = false
      // Напускане на страницата: LiveKit (disconnectOnPageLeave) затваря стаята
      // при beforeunload/pagehide и отписва микрофона — това НЕ е сървърно
      // отнемане и не бива да изтрива намерението за говорене (то е нужно за
      // възстановяването след презареждане). Слушателите се регистрират тук,
      // ПРЕДИ тези на LiveKit (при connect), за да се изпълнят първи.
      let pageLeaving = false
      let serverUnpublishTimer: ReturnType<typeof setTimeout> | null = null
      const clearServerUnpublish = (): void => {
        if (serverUnpublishTimer !== null) clearTimeout(serverUnpublishTimer)
        serverUnpublishTimer = null
      }
      const markPageLeaving = (): void => { pageLeaving = true }
      const unwatchPageLeave = (): void => {
        window.removeEventListener('beforeunload', markPageLeaving)
        window.removeEventListener('pagehide', markPageLeaving)
      }
      window.addEventListener('beforeunload', markPageLeaving)
      window.addEventListener('pagehide', markPageLeaving)
      // Брояч на reconnect-ите на SDK-то — за разпознаване на публикуване,
      // прекъснато от reconnect (пълният reconnect отменя незавършеното addTrack).
      let reconnectEpoch = 0
      const attachedTrackSids = new Set<string>()

      // Отключване на аудиото в СЪЩИЯ потребителски жест (преди мрежата).
      void room.startAudio().catch(() => {})

      // H2: текущият (единствено валиден) елемент на всеки отдалечен аудио track.
      type AudioEntry = { element: HTMLMediaElement; track: RemoteTrack; onPause: () => void }
      const audioEntries = new Map<string, AudioEntry>()

      /** Слушателят се маха ПРЕДИ detach (track.detach паузира елемента). */
      function releaseEntry(sid: string, entry: AudioEntry): void {
        if (audioEntries.get(sid) !== entry) return
        entry.element.removeEventListener('pause', entry.onPause)
        mediaGlobal.elementListeners -= 1
        audioEntries.delete(sid)
      }

      function attachAudio(track: RemoteTrack, participant: RemoteParticipant): void {
        if (track.kind !== Track.Kind.Audio || track.sid === undefined) return
        const sid = track.sid
        const previous = audioEntries.get(sid)
        if (previous !== undefined) {
          releaseEntry(sid, previous)
          if (previous.track.attachedElements.includes(previous.element)) previous.track.detach(previous.element)
        }
        // Винаги НОВ елемент: track.attach() без аргумент може да вземе откачен
        // елемент от пула на SDK-то — стар елемент не се пуска отново.
        const element = track.attach(document.createElement('audio'))
        element.autoplay = true
        sink.attach(sid, element)
        attachedTrackSids.add(sid)
        ;(track as RemoteAudioTrack).setVolume(isIdentityLocallyMuted(participant.identity) ? 0 : 1)
        const entry: AudioEntry = { element, track, onPause: () => onElementPause(sid, entry) }
        element.addEventListener('pause', entry.onPause)
        mediaGlobal.elementListeners += 1
        audioEntries.set(sid, entry)
        ensureMonitor()
      }

      function detachAudio(track: RemoteTrack): void {
        if (track.sid === undefined) return
        const entry = audioEntries.get(track.sid)
        if (entry !== undefined && entry.track === track) releaseEntry(track.sid, entry)
        track.detach()
        sink.detach(track.sid)
        attachedTrackSids.delete(track.sid)
        remoteStall.forget(track.sid)
      }

      function releaseAllAudio(): void {
        for (const [sid, entry] of [...audioEntries]) releaseEntry(sid, entry)
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) {
            if (publication.track !== undefined) publication.track.detach()
          }
        }
        for (const sid of attachedTrackSids) sink.detach(sid)
        attachedTrackSids.clear()
      }

      // Собственият ни capture (getUserMedia от нас -> publishTrack като
      // user-provided track): LiveKit никога не го рестартира сам (нито при
      // „track ended“, нито при пълен reconnect), а stopLocalTrackOnUnpublish:false
      // означава, че и не го спира сам — всяко спиране/запазване е наше решение.
      // micCapture === null <=> няма наш активен/публикуван capture.
      let micCapture: MediaStreamTrack | null = null
      let micWatch: { track: LocalTrack; onEnded: () => void } | null = null
      const micTrack = () => room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track

      function stopCapture(track: MediaStreamTrack | null | undefined): void {
        try { track?.stop() } catch { /* вече спрян */ }
      }

      function unwatchMicrophone(): void {
        if (micWatch === null) return
        micWatch.track.off(TrackEvent.Ended, micWatch.onEnded)
        micWatch = null
      }

      /** Capture-ът е спрял/отнет извън нашия контрол -> спиране и сигнал (без нов capture). */
      function loseMicrophone(reason: VoiceMicrophoneLossReason): void {
        abortRecovery()
        stopCapture(micCapture)
        micCapture = null
        unwatchMicrophone()
        clearMicHealth()
        events.onLocalMicrophoneLost(reason)
      }

      function stopLocalMicrophone(): Promise<void> {
        abortRecovery()
        recoveryOrphaned = false
        const capture = micCapture
        micCapture = null
        unwatchMicrophone()
        clearMicHealth()
        const track = micTrack()
        if (track === undefined) {
          stopCapture(capture)
          return Promise.resolve()
        }
        return room.localParticipant
          .unpublishTrack(track, true)
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            // Гаранция за освободен capture дори при грешка в unpublish.
            stopCapture(track.mediaStreamTrack)
            stopCapture(capture)
          })
      }

      const isReconnectingState = (): boolean =>
        room.state === ConnectionState.Reconnecting || room.state === ConnectionState.SignalReconnecting

      // ─── Етап H1/H2: медийно здраве (виж коментара в началото на файла) ──
      const inputHealth = createInputHealthEvaluator()
      const remoteStall = createRemoteStallEvaluator()
      const outputLimiter = createRecoveryLimiter()
      let micHealth: VoiceMicHealth = 'ok'
      /** play() е отказан (NotAllowedError) или лимитът е изчерпан — чака жест („Включи звука“). */
      let outputBlocked = false
      /** Отдалечени identity -> от кога сървърът ги отчита като говорещи без прекъсване. */
      const speakingSince = new Map<string, number>()
      const pausedReportedAt = new Map<string, number>()
      const media = {
        monitorTicks: 0, inputSamples: 0, remoteSamples: 0,
        getStatsCalls: 0, getStatsTotalMs: 0, getStatsMaxMs: 0, statsInFlightMax: 0,
        outputChecks: 0, outputRecoveries: 0, outputReattaches: 0, outputLimited: 0, outputGestureRequired: 0, outputPauses: 0,
        outputSkipNotConnected: 0, outputSkipHidden: 0, outputSkipBlocked: 0,
        lastPacketsPerSecond: -1, minPacketsPerSecond: -1, maxPacketsPerSecond: -1,
        micRecoveryAttempts: 0, micRecoveryRecovered: 0, micConfirmations: 0,
        verifyPacketsDelta: -1, verifySourceDelta: -1, verifySenderOk: -1, verifyPolls: 0,
        // Измерване на устройства (панелът „Диагностика на звука“): -1 = неизвестно.
        sourceAvailable: -1, lastSourceRate: -1, trackFramesAvailable: -1, inputSamplesWithStats: 0,
      }
      let lastSourceSample: { statsTs: number; source: number } | null = null
      /** Последното доказателство при подозрение (за решението на контролера в H3). */
      let micStallEvidence: VoiceMediaInputEvidence = 'none'
      /** Всички getStats на стаята — една след друга (наблюдение, потвърждение, проверка). */
      let statsChain: Promise<unknown> = Promise.resolve()
      let statsInFlight = 0
      let mediaTornDown = false
      const monotonic = (): number => performance.now()
      const pageVisible = (): boolean => document.visibilityState === 'visible'
      const canPlayback = (): boolean => room.canPlaybackAudio && !outputBlocked

      function reportMedia(event: VoiceMediaDiagnosticReport): void {
        try { events.onMediaDiagnostic?.(event) } catch { /* диагностиката никога не влияе на гласа */ }
      }

      function timedStats(target: { getStats: () => Promise<RTCStatsReport> }): Promise<RTCStatsReport | null> {
        const run = statsChain.then(() => runStats(target), () => runStats(target))
        statsChain = run.catch(() => undefined)
        return run
      }

      async function runStats(target: { getStats: () => Promise<RTCStatsReport> }): Promise<RTCStatsReport | null> {
        statsInFlight += 1
        media.statsInFlightMax = Math.max(media.statsInFlightMax, statsInFlight)
        media.getStatsCalls += 1
        const started = monotonic()
        try {
          return await target.getStats()
        } catch {
          return null // липсващ показател не е дефект
        } finally {
          statsInFlight -= 1
          const took = monotonic() - started
          media.getStatsTotalMs += took
          media.getStatsMaxMs = Math.max(media.getStatsMaxMs, took)
        }
      }

      function setMicHealth(next: VoiceMicHealth): void {
        if (next === micHealth) return
        micHealth = next
        try { events.onMicHealthChanged?.(next, next === 'stall_suspected' ? micStallEvidence : 'none') } catch { /* изолация */ }
      }

      function applyInputVerdict(verdict: VoiceInputVerdict): void {
        const pps = verdict.packetsPerSecond
        if (pps !== null) {
          media.lastPacketsPerSecond = pps
          if (pps > 0) media.minPacketsPerSecond = media.minPacketsPerSecond < 0 ? pps : Math.min(media.minPacketsPerSecond, pps)
          media.maxPacketsPerSecond = Math.max(media.maxPacketsPerSecond, pps)
        }
        if (verdict.change !== null) {
          if (verdict.change.state === 'stall_suspected') micStallEvidence = verdict.change.evidence
          reportMedia({ event: 'media_input', ...verdict.change })
        }
        setMicHealth(verdict.health)
      }

      /** Нов/спрян/предаден микрофон: всичко отначало, без докладвана промяна. */
      function clearMicHealth(): void {
        unwatchCaptureMute()
        inputHealth.clear()
        micStallEvidence = 'none'
        setMicHealth('ok')
      }

      // ─── H3: възстановяване на микрофона (replaceTrack в СЪЩАТА публикация) ──
      // Само по искане на контролера (единствения собственик на решенията). Никога
      // две операции наведнъж; изключване/напускане/ротация/reconnect/disconnect
      // я отменят. Старият capture се спира ПРЕДИ новия getUserMedia — никога
      // два живи capture-а (на Safari е и задължително), вкл. при отмяна/грешка.
      let recovery: { aborted: boolean } | null = null
      /** Публикацията остана без жив capture (неуспех/отмяна след спирането) — заглушена; чака ръчно. */
      let recoveryOrphaned = false
      function abortRecovery(): void {
        if (recovery !== null) recovery.aborted = true
      }

      type FlowSample = { statsTs: number | null; packets: number | null; source: number | null; senderHasTrack: boolean }
      async function readFlow(track: LocalTrack, capture: MediaStreamTrack): Promise<FlowSample> {
        const sender = track.sender
        const stats = sender === undefined ? null : await timedStats(sender)
        const { outbound, source } = pickOutboundAndSource(statsEntries(stats), capture)
        return {
          statsTs: finite(outbound?.timestamp),
          packets: finite(outbound?.packetsSent),
          source: finite(source?.totalSamplesDuration),
          senderHasTrack: sender?.track === capture,
        }
      }

      /** Публикацията остава (същият sid), без жив capture — заглушена за останалите. */
      async function orphanPublication(track: LocalTrack): Promise<void> {
        micCapture = null
        recoveryOrphaned = true
        inputHealth.markSuspected(monotonic())
        micStallEvidence = 'none'
        setMicHealth('stall_suspected')
        if (!track.isMuted) await track.mute().catch(() => undefined)
      }

      async function confirmCaptureStall(): Promise<VoiceCaptureStallConfirmation> {
        const capture = micCapture
        const track = micTrack()
        if (capture === null || track === undefined || track.mediaStreamTrack !== capture || recovery !== null) return 'not_confirmed'
        if (capture.readyState !== 'live' || !capture.enabled || capture.muted || track.isUpstreamPaused) return 'not_confirmed'
        if (room.state !== ConnectionState.Connected || !pageVisible()) return 'not_confirmed'
        if (micHealth !== 'stall_suspected' || micStallEvidence !== 'capture_stalled') return 'not_confirmed'
        media.micConfirmations += 1
        const framesBefore = captureFrames(capture)
        const first = await readFlow(track, capture)
        await delay(2_500)
        if (micCapture !== capture || disposed || clientDisconnect || recovery !== null) return 'not_confirmed'
        const second = await readFlow(track, capture)
        const framesAfter = captureFrames(capture)
        if (capture.muted || track.isUpstreamPaused || capture.readyState !== 'live') return 'not_confirmed'
        if (!first.senderHasTrack || !second.senderHasTrack) return 'not_confirmed'
        if (first.statsTs === null || second.statsTs === null || second.statsTs - first.statsTs < 2_000) return 'unavailable'
        if (first.packets === null || second.packets === null || first.source === null || second.source === null) return 'unavailable'
        // Два НЕЗАВИСИМИ брояча (не енергия): изпратени RTP пакети и подадени от capture-а семпли.
        if (second.packets !== first.packets) return 'not_confirmed'
        if (second.source - first.source > 0.05) return 'not_confirmed'
        // Трети, ако браузърът го дава: кадрите на самия MediaStreamTrack.
        if (framesBefore !== null && framesAfter !== null && framesAfter > framesBefore) return 'not_confirmed'
        return 'confirmed'
      }

      /** Новият capture реално подава кадри и RTP пакетите отново растат (до 8 s). */
      async function verifyFlow(track: LocalTrack, capture: MediaStreamTrack, op: { aborted: boolean }): Promise<boolean> {
        const start = await readFlow(track, capture)
        for (let attempt = 0; attempt < 8; attempt += 1) {
          await delay(1_000)
          if (op.aborted || micCapture !== capture || disposed) return false
          const now = await readFlow(track, capture)
          media.verifyPolls += 1
          media.verifySenderOk = now.senderHasTrack ? 1 : 0
          media.verifyPacketsDelta = start.packets === null || now.packets === null ? -1 : now.packets - start.packets
          media.verifySourceDelta = start.source === null || now.source === null ? -1 : Math.round((now.source - start.source) * 100) / 100
          if (!now.senderHasTrack || start.packets === null || now.packets === null) continue
          const packetsOk = now.packets >= start.packets + 3
          const sourceOk = start.source === null || now.source === null || now.source - start.source >= 0.5
          if (packetsOk && sourceOk) return true
        }
        return false
      }

      async function recoverMicrophone(explicit: boolean): Promise<VoiceMicRecoveryResult> {
        if (recovery !== null) return 'busy'
        if (disposed || clientDisconnect || pageLeaving || room.state !== ConnectionState.Connected) return 'not_applicable'
        const track = micTrack()
        if (track === undefined) return 'not_applicable'
        const old = micCapture
        if (old === null ? !recoveryOrphaned : track.mediaStreamTrack !== old) return 'not_applicable'
        // Не се „борим“ със системата (обаждане, Siri, друго приложение) — дори ръчно.
        if (old !== null && (old.muted || track.isUpstreamPaused)) return 'system_muted'
        if (navigator.mediaDevices?.getUserMedia === undefined) return 'gum_failed'
        void explicit // разрешението вече е проверено от контролера (auto) или е жест (ръчно)
        const op = { aborted: false }
        recovery = op
        mediaGlobal.recoveryOps += 1
        media.micRecoveryAttempts += 1
        stopMonitor()
        const stillOurs = (): boolean => !op.aborted && !disposed && !clientDisconnect && micTrack() === track
        try {
          if (old !== null) {
            micCapture = null
            unwatchCaptureMute()
            stopCapture(old)
          }
          let next: MediaStreamTrack | undefined
          try {
            // Краен срок: неотговорен прозорец/залепнал getUserMedia не държи операцията;
            // закъснял резултат се спира веднага (никога два живи capture-а).
            let timedOut = false
            const request = navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CAPTURE } })
            void request.then((late) => { if (timedOut) for (const t of late.getTracks()) stopCapture(t) }, () => undefined)
            const stream = await Promise.race([
              request,
              delay(RECOVERY_GUM_TIMEOUT_MS).then(() => { timedOut = true; throw new VoiceMicrophoneError('unavailable') }),
            ])
            next = stream.getAudioTracks()[0]
            for (const other of stream.getTracks()) if (other !== next) stopCapture(other)
          } catch (error) {
            if (micTrack() === track && !disposed && !clientDisconnect) await orphanPublication(track)
            if (op.aborted) return 'aborted_orphaned'
            return mapMicrophoneError(error) === 'permission_denied' ? 'gum_denied' : 'gum_failed'
          }
          if (next === undefined) {
            if (micTrack() === track) await orphanPublication(track)
            return 'gum_failed'
          }
          if (!stillOurs()) {
            stopCapture(next)
            if (!disposed && !clientDisconnect && micTrack() === track) {
              await orphanPublication(track)
              return 'aborted_orphaned'
            }
            return 'aborted'
          }
          try {
            await track.replaceTrack(next, { userProvidedTrack: true })
          } catch {
            stopCapture(next)
            if (micTrack() === track && !disposed && !clientDisconnect) await orphanPublication(track)
            return op.aborted ? 'aborted_orphaned' : 'replace_failed'
          }
          if (!stillOurs()) {
            stopCapture(next)
            if (!disposed && !clientDisconnect && micTrack() === track) {
              await orphanPublication(track)
              return 'aborted_orphaned'
            }
            return 'aborted'
          }
          micCapture = next
          recoveryOrphaned = false
          if (track.isMuted) await track.unmute().catch(() => undefined)
          // Ново начало на наблюдението, БЕЗ да се обявява „ok“ преди проверката.
          inputHealth.clear()
          micStallEvidence = 'none'
          watchCaptureMute(next)
          const flowing = await verifyFlow(track, next, op)
          if (op.aborted || micCapture !== next) return 'aborted'
          if (!flowing) {
            inputHealth.markSuspected(monotonic())
            setMicHealth('stall_suspected')
            return 'no_rtp'
          }
          media.micRecoveryRecovered += 1
          setMicHealth('ok')
          return 'recovered'
        } finally {
          if (recovery === op) recovery = null
          mediaGlobal.recoveryOps -= 1
          ensureMonitor()
        }
      }

      // Системно mute/unmute на capture-а — веднага (без да чака измерването).
      let captureMuteWatch: { capture: MediaStreamTrack; listener: () => void } | null = null
      function unwatchCaptureMute(): void {
        if (captureMuteWatch === null) return
        captureMuteWatch.capture.removeEventListener('mute', captureMuteWatch.listener)
        captureMuteWatch.capture.removeEventListener('unmute', captureMuteWatch.listener)
        mediaGlobal.captureListeners -= 1
        captureMuteWatch = null
      }
      function watchCaptureMute(capture: MediaStreamTrack): void {
        unwatchCaptureMute()
        const listener = (): void => {
          if (micCapture !== capture || disposed) return
          const track = micTrack()
          applyInputVerdict(inputHealth.push({
            at: monotonic(), statsTimestamp: null, rtpStreamId: null, packetsSent: null, sourceSamplesDuration: null,
            senderHasCapture: track?.sender?.track === capture,
            captureLive: capture.readyState === 'live', captureEnabled: capture.enabled, captureMuted: capture.muted,
            upstreamPaused: track?.isUpstreamPaused ?? false,
          }))
        }
        capture.addEventListener('mute', listener)
        capture.addEventListener('unmute', listener)
        mediaGlobal.captureListeners += 1
        captureMuteWatch = { capture, listener }
      }

      // Един таймер, без припокриване: следващото измерване — след края на текущото.
      let monitorTimer: ReturnType<typeof setTimeout> | null = null
      let monitorBusy = false
      let monitorEpoch = 0
      const hasRemoteAudio = (): boolean => audioEntries.size > 0
      function stopMonitor(): void {
        monitorEpoch += 1
        if (monitorTimer === null) return
        clearTimeout(monitorTimer)
        monitorTimer = null
        mediaGlobal.monitorTimers -= 1
      }
      function ensureMonitor(): void {
        if (mediaTornDown || disposed || clientDisconnect || monitorTimer !== null || monitorBusy) return
        if (room.state !== ConnectionState.Connected || !pageVisible()) return
        if (micCapture === null && !hasRemoteAudio()) return
        mediaGlobal.monitorTimers += 1
        monitorTimer = setTimeout(() => {
          monitorTimer = null
          mediaGlobal.monitorTimers -= 1
          void monitorTick()
        }, VOICE_MEDIA_SAMPLE_INTERVAL_MS)
      }
      async function monitorTick(): Promise<void> {
        if (mediaTornDown || disposed || room.state !== ConnectionState.Connected || !pageVisible()) {
          inputHealth.resetBaseline() // подновява се при Reconnected / видима страница
          return
        }
        const epoch = monitorEpoch
        monitorBusy = true
        media.monitorTicks += 1
        try {
          await sampleInput(epoch)
          if (epoch === monitorEpoch) await sampleRemote(epoch)
        } finally {
          monitorBusy = false
        }
        ensureMonitor()
      }

      async function sampleInput(epoch: number): Promise<void> {
        const capture = micCapture
        const track = micTrack()
        if (capture === null || track === undefined || track.mediaStreamTrack !== capture) {
          inputHealth.resetBaseline()
          return
        }
        const sender = track.sender
        const upstreamPaused = track.isUpstreamPaused
        // При системно прекъснат микрофон статистиката не е нужна (не се „борим“ с ОС).
        const stats = sender !== undefined && !upstreamPaused && !capture.muted ? await timedStats(sender) : null
        if (epoch !== monitorEpoch || micCapture !== capture || disposed) return
        media.inputSamples += 1
        const { outbound, source } = pickOutboundAndSource(statsEntries(stats), capture)
        const sample: VoiceOutboundSample = {
          at: monotonic(),
          statsTimestamp: finite(outbound?.timestamp),
          rtpStreamId: text(outbound?.id),
          packetsSent: finite(outbound?.packetsSent),
          sourceSamplesDuration: finite(source?.totalSamplesDuration),
          senderHasCapture: sender?.track === capture,
          captureLive: capture.readyState === 'live',
          captureEnabled: capture.enabled,
          captureMuted: capture.muted,
          upstreamPaused: track.isUpstreamPaused,
        }
        // Само за измерване: има ли media-source/MediaStreamTrack.stats и колко секунди звук/s подава capture-ът.
        if (sample.statsTimestamp !== null) {
          media.inputSamplesWithStats += 1
          media.sourceAvailable = sample.sourceSamplesDuration === null ? 0 : 1
          media.trackFramesAvailable = captureFrames(capture) === null ? 0 : 1
          if (sample.sourceSamplesDuration !== null) {
            if (lastSourceSample !== null && sample.statsTimestamp > lastSourceSample.statsTs) {
              media.lastSourceRate = Math.round(((sample.sourceSamplesDuration - lastSourceSample.source) / ((sample.statsTimestamp - lastSourceSample.statsTs) / 1000)) * 100) / 100
            }
            lastSourceSample = { statsTs: sample.statsTimestamp, source: sample.sourceSamplesDuration }
          }
        }
        applyInputVerdict(inputHealth.push(sample))
      }

      async function sampleRemote(epoch: number): Promise<void> {
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.audioTrackPublications.values()) {
            const track = publication.track as RemoteAudioTrack | undefined
            const sid = publication.trackSid
            const at = monotonic()
            const since = speakingSince.get(participant.identity) ?? null
            if (track === undefined || publication.isMuted || since === null || at - since < 3_000 || track.receiver === undefined) {
              remoteStall.push(sid, { at, speakingSince: null, statsTimestamp: null, rtpStreamId: null, bytesReceived: null })
              continue
            }
            const stats = await timedStats(track.receiver)
            if (epoch !== monitorEpoch || disposed) return
            media.remoteSamples += 1
            const inbound = statsEntries(stats).find((entry) => entry.type === 'inbound-rtp' && isAudioEntry(entry))
            const suspected = remoteStall.push(sid, {
              at: monotonic(),
              speakingSince: speakingSince.get(participant.identity) ?? null,
              statsTimestamp: finite(inbound?.timestamp),
              rtpStreamId: text(inbound?.id),
              bytesReceived: finite(inbound?.bytesReceived),
            })
            // Само допълнителен сигнал — без действие (не доказва кой компонент е повреден).
            if (suspected) reportMedia({ event: 'media_output', state: 'remote_stall_suspected' })
          }
        }
      }

      // ─── H2: входящо аудио ───────────────────────────────────────────
      const outputTask = createCoalescedTask<VoiceMediaTrigger>(
        { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), now: monotonic },
        (triggers) => runOutputCheck(triggers),
      )
      mediaGlobal.outputTasks += 1

      function requestOutputCheck(trigger: VoiceMediaTrigger, delayMs = 250): void {
        if (mediaTornDown || disposed || clientDisconnect) return
        outputTask.request(trigger, delayMs)
      }

      function onElementPause(sid: string, entry: AudioEntry): void {
        // Само текущият елемент на track-а; нашите detach/disconnect махат слушателя преди паузата.
        if (audioEntries.get(sid) !== entry || disposed || clientDisconnect || pageLeaving) return
        media.outputPauses += 1
        const at = monotonic()
        const last = pausedReportedAt.get(sid)
        if (last === undefined || at - last >= 10_000) {
          pausedReportedAt.set(sid, at)
          reportMedia({ event: 'media_output', state: 'element_paused' })
        }
        requestOutputCheck('pause')
      }

      function markOutputBlocked(): void {
        if (outputBlocked) return
        outputBlocked = true
        media.outputGestureRequired += 1
        reportMedia({ event: 'media_output', state: 'playback_blocked' })
        events.onPlaybackStatusChanged(canPlayback())
      }

      async function playElement(element: HTMLMediaElement): Promise<VoiceMediaRecoveryResult> {
        try {
          await element.play()
          return 'success'
        } catch (error) {
          const name = (error as { name?: unknown } | null)?.name
          if (name === 'NotAllowedError') return 'gesture_required'
          // AbortError: прекъснато от друго play()/зареждане — успех, ако елементът свири.
          if (name === 'AbortError' && !element.paused) return 'success'
          return 'failed'
        }
      }

      function streamCarries(element: HTMLMediaElement, mediaTrack: MediaStreamTrack): boolean {
        const stream = element.srcObject
        return stream instanceof MediaStream && stream.getAudioTracks().includes(mediaTrack)
      }

      async function runOutputCheck(triggers: ReadonlySet<VoiceMediaTrigger>): Promise<void> {
        if (mediaTornDown || disposed || clientDisconnect || room.state !== ConnectionState.Connected) {
          media.outputSkipNotConnected += 1
          return
        }
        if (!pageVisible()) {
          media.outputSkipHidden += 1
          return // при връщане на преден план -> нова проверка ('visible')
        }
        media.outputChecks += 1
        const trigger = TRIGGER_PRIORITY.find((candidate) => triggers.has(candidate)) ?? 'attach_check'
        for (const participant of [...room.remoteParticipants.values()]) {
          for (const publication of [...participant.audioTrackPublications.values()]) {
            const track = publication.track
            const sid = publication.trackSid
            // Без абонамент няма какво да се възстановява (нищо не се „измисля“).
            if (track === undefined || track.sid === undefined || track.mediaStreamTrack.readyState !== 'live') continue
            const entry = audioEntries.get(sid)
            const broken = entry === undefined || entry.track !== track || !entry.element.isConnected
              || !streamCarries(entry.element, track.mediaStreamTrack) || !track.attachedElements.includes(entry.element)
            const paused = !broken && (entry.element.paused || entry.element.ended)
            if (!broken && !paused) continue
            if (outputBlocked) {
              media.outputSkipBlocked += 1
              continue // чака жест — без повторни опити
            }
            if (!outputLimiter.tryAcquire(sid, monotonic())) {
              media.outputLimited += 1
              reportMedia({ event: 'media_recovery', target: 'output', step: broken ? 'reattach' : 'play', result: 'limited', trigger })
              markOutputBlocked()
              continue
            }
            if (broken) {
              reportMedia({ event: 'media_output', state: 'element_missing' })
              attachAudio(track, participant) // нов елемент; старият се освобождава
              media.outputReattaches += 1
            }
            const current = audioEntries.get(sid)
            if (current === undefined) continue
            const result = await playElement(current.element)
            if (mediaTornDown || disposed) return
            if (audioEntries.get(sid) !== current) continue
            if (result === 'success') media.outputRecoveries += 1
            reportMedia({ event: 'media_recovery', target: 'output', step: broken ? 'reattach' : 'play', result, trigger })
            if (result === 'gesture_required') markOutputBlocked()
          }
        }
      }

      const onPageVisibility = (): void => {
        if (pageVisible()) {
          requestOutputCheck('visible')
          ensureMonitor()
        } else {
          stopMonitor()
          inputHealth.resetBaseline()
        }
      }
      const onPageFocus = (): void => requestOutputCheck('focus')
      const onPageShow = (): void => requestOutputCheck('pageshow')
      document.addEventListener('visibilitychange', onPageVisibility)
      window.addEventListener('focus', onPageFocus)
      window.addEventListener('pageshow', onPageShow)
      mediaGlobal.pageListenerSets += 1

      /** Идемпотентно: таймери, слушатели, проверки — нищо не остава след стаята. */
      function teardownMedia(): void {
        if (mediaTornDown) return
        mediaTornDown = true
        stopMonitor()
        outputTask.cancel()
        mediaGlobal.outputTasks -= 1
        document.removeEventListener('visibilitychange', onPageVisibility)
        window.removeEventListener('focus', onPageFocus)
        window.removeEventListener('pageshow', onPageShow)
        mediaGlobal.pageListenerSets -= 1
        unwatchCaptureMute()
        speakingSince.clear()
        pausedReportedAt.clear()
      }

      async function publishCapture(capture: MediaStreamTrack): Promise<void> {
        const epoch = reconnectEpoch
        try {
          await room.localParticipant.publishTrack(capture, { source: Track.Source.Microphone })
        } catch (error) {
          const publishError = classifyPublishError(error)
          // Прекъснато от reconnect на SDK-то (не от нас): живият capture НЕ се
          // спира — връща се на контролера за публикуване след Reconnected.
          // Потвърден отказ на правата никога не е прекъсване.
          const interrupted = publishError !== 'not_permitted' && !disposed && !clientDisconnect && capture.readyState === 'live'
            && (reconnectEpoch !== epoch || isReconnectingState())
          if (interrupted && micTrack()?.mediaStreamTrack !== capture) {
            throw new VoiceMicrophoneError('interrupted', { retained: retainCapture(capture), publishError })
          }
          stopCapture(capture)
          await stopLocalMicrophone()
          // Липса на право за говорене -> 'not_permitted' (съобщенията за правата);
          // MediaDeviceFailure.getFailure връща Other за всяка грешка с name.
          throw new VoiceMicrophoneError(publishError === 'not_permitted' ? 'not_permitted' : mapMicrophoneError(error), { publishError })
        }
        micCapture = capture
        // H1: само наблюдение на новия capture (без действия).
        clearMicHealth()
        watchCaptureMute(capture)
        ensureMonitor()
        const track = micTrack()
        if (track !== undefined) {
          const onEnded = () => { void stopLocalMicrophone().then(() => events.onLocalMicrophoneLost('track_ended')) }
          track.on(TrackEvent.Ended, onEnded)
          micWatch = { track, onEnded }
        }
      }

      async function checkMicrophoneDevicePresent(): Promise<void> {
        const publication = room.localParticipant.getTrackPublication(Track.Source.Microphone)
        const track = publication?.track
        if (track === undefined) return
        if (track.mediaStreamTrack.readyState === 'ended') {
          await stopLocalMicrophone()
          events.onLocalMicrophoneLost('track_ended')
          return
        }
        // Без заявка за разрешение: само изброяване на вече разрешените устройства.
        const deviceId = await track.getDeviceId(false).catch(() => undefined)
        if (deviceId === undefined || deviceId === 'default') return
        const devices = await Room.getLocalDevices('audioinput', false).catch(() => null)
        if (devices !== null && !devices.some((device) => device.deviceId === deviceId)) {
          await stopLocalMicrophone()
          events.onLocalMicrophoneLost('device_removed')
        }
      }

      room
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          unwatchPageLeave()
          clearServerUnpublish()
          abortRecovery()
          teardownMedia()
          releaseAllAudio()
          if (activeRoom === room) activeRoom = null
          const cause = mapDisconnectReason(reason, clientDisconnect)
          const detail = describeDisconnectReason(reason, clientDisconnect)
          // Техническо прекъсване (ROOM_DELETED при ротация — може да пристигне
          // ПРЕДИ voice_table_updated; окончателно загубена мрежа; отстраняване
          // от сървъра): живият capture не се спира, а се предава на контролера,
          // който го публикува в следващата връзка или го освобождава (≤20 s).
          // Собствено затваряне (вкл. page leave) и duplicate identity -> спиране.
          const capture = micCapture
          micCapture = null
          unwatchMicrophone()
          clearMicHealth()
          const technical = cause === 'room_deleted' || cause === 'connection_lost' || cause === 'removed'
          const held = technical && !disposed && capture !== null && capture.readyState === 'live' ? retainCapture(capture) : null
          if (held === null) stopCapture(capture)
          if (disposed) {
            held?.release()
            return
          }
          events.onDisconnected(cause, held, detail)
        })
        .on(RoomEvent.Reconnecting, () => {
          reconnectEpoch += 1
          abortRecovery()
          // Измерването през reconnect не е сравнимо — базата започва наново.
          stopMonitor()
          inputHealth.resetBaseline()
          events.onReconnecting()
        })
        .on(RoomEvent.Reconnected, () => {
          events.onReconnected()
          // Официалният пълен reconnect публикува същия track наново; ако не е
          // успял — capture-ът не остава активен без публикация.
          if (micCapture !== null && micTrack()?.mediaStreamTrack !== micCapture) loseMicrophone('republish_failed')
          ensureMonitor()
          requestOutputCheck('attach_check', 1_000)
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          // H1 (допълнителен сигнал): от кога всеки отдалечен участник говори без прекъсване.
          const at = monotonic()
          const speakingNow = new Set(speakers.map((speaker) => speaker.identity))
          for (const identity of [...speakingSince.keys()]) if (!speakingNow.has(identity)) speakingSince.delete(identity)
          for (const identity of speakingNow) if (!speakingSince.has(identity)) speakingSince.set(identity, at)
          events.onActiveSpeakersChanged(speakers.map((speaker) => speaker.identity))
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          attachAudio(track, participant)
          events.onParticipantsChanged()
        })
        .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
          detachAudio(track)
          events.onParticipantsChanged()
        })
        .on(RoomEvent.ParticipantConnected, () => events.onParticipantsChanged())
        .on(RoomEvent.ParticipantDisconnected, () => events.onParticipantsChanged())
        .on(RoomEvent.TrackPublished, () => events.onParticipantsChanged())
        .on(RoomEvent.TrackUnpublished, () => events.onParticipantsChanged())
        .on(RoomEvent.TrackMuted, () => events.onParticipantsChanged())
        .on(RoomEvent.TrackUnmuted, () => events.onParticipantsChanged())
        .on(RoomEvent.AudioPlaybackStatusChanged, () => events.onPlaybackStatusChanged(canPlayback()))
        .on(RoomEvent.MediaDevicesChanged, () => {
          events.onDevicesChanged()
          // H2: смяна на аудиоизхода може да спре елементите — една проверка след 1 s.
          requestOutputCheck('devicechange', 1_000)
          void checkMicrophoneDevicePresent()
        })
        .on(RoomEvent.LocalTrackUnpublished, (publication) => {
          if (publication.source !== Track.Source.Microphone) return
          events.onParticipantsChanged()
          // Нашите unpublish/detach първо нулират micCapture -> тук не стигат.
          // Сървърно премахване при свързана стая. При ИЗТРИВАНЕ на стаята
          // (ротация) LiveKit първо премахва публикацията и чак после изпраща
          // Disconnected(ROOM_DELETED) — тогава живият capture трябва да се
          // предаде (техническо прекъсване), а не да се спре. Затова решението
          // се отлага: ако до SERVER_UNPUBLISH_GRACE_MS стаята не е прекъсната и
          // същият capture не е публикуван наново -> отнето право -> спиране.
          if (pageLeaving || micCapture === null || room.state !== ConnectionState.Connected) return
          if (micTrack()?.mediaStreamTrack === micCapture) return
          const capture = micCapture
          if (serverUnpublishTimer !== null) clearTimeout(serverUnpublishTimer)
          serverUnpublishTimer = setTimeout(() => {
            serverUnpublishTimer = null
            if (disposed || micCapture !== capture || room.state !== ConnectionState.Connected) return
            if (micTrack()?.mediaStreamTrack === capture) return
            loseMicrophone('server_unpublished')
          }, SERVER_UNPUBLISH_GRACE_MS)
        })

      const connected: VoiceConnectedRoom = {
        async disconnect() {
          if (disposed) return
          unwatchPageLeave()
          clearServerUnpublish()
          clientDisconnect = true
          abortRecovery()
          teardownMedia()
          await stopLocalMicrophone()
          releaseAllAudio()
          await room.disconnect(true).catch(() => {})
          disposed = true
          if (activeRoom === room) activeRoom = null
        },
        async detachMicrophoneForReuse() {
          abortRecovery()
          const track = micTrack()
          if (track === undefined || track.mediaStreamTrack.readyState !== 'live') {
            await stopLocalMicrophone()
            return null
          }
          const capture = track.mediaStreamTrack
          // Първо нулиране -> LocalTrackUnpublished/Disconnected не го спират.
          micCapture = null
          unwatchMicrophone()
          clearMicHealth()
          try {
            // stop=false: публикуването спира, capture-ът остава за новата стая.
            await room.localParticipant.unpublishTrack(track, false)
          } catch {
            // SDK-то първо премахва публикацията и ЧАК ТОГАВА договаря наново;
            // ако стаята бъде изтрита междувременно (ротация), договарянето
            // пропада, но публикацията вече я няма. Живият capture е наш —
            // не се губи (реален тест: изгубен микрофон при ротация).
            if (capture.readyState !== 'live') return null
          }
          return retainCapture(capture)
        },
        async enableMicrophone(reuse) {
          abortRecovery()
          if (reuse !== undefined) {
            // Същият capture (EC/NS/AGC вече приложени) — без нов getUserMedia.
            const capture = takeRetainedCapture(reuse)
            if (capture === null) throw new VoiceMicrophoneError('unavailable')
            await publishCapture(capture)
            return
          }
          // Единственото място с getUserMedia — само при изрично действие и
          // потвърдено право за говорене (контролерът).
          let capture: MediaStreamTrack | undefined
          try {
            if (navigator.mediaDevices?.getUserMedia === undefined) throw new VoiceMicrophoneError('unavailable')
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO_CAPTURE } })
            capture = stream.getAudioTracks()[0]
            for (const other of stream.getTracks()) if (other !== capture) stopCapture(other)
          } catch (error) {
            throw error instanceof VoiceMicrophoneError ? error : new VoiceMicrophoneError(mapMicrophoneError(error))
          }
          if (capture === undefined) throw new VoiceMicrophoneError('not_found')
          if (disposed || clientDisconnect) {
            stopCapture(capture)
            throw new VoiceMicrophoneError('unavailable')
          }
          // Както LiveKit след собствен capture (iOS AudioSession): възпроизвеждането продължава.
          void room.startAudio().catch(() => {})
          await publishCapture(capture)
        },
        disableMicrophone: () => stopLocalMicrophone(),
        isMicrophoneLive() {
          const track = micTrack()
          return track !== undefined && track.mediaStreamTrack.readyState === 'live' && !track.isMuted
        },
        async startAudio() {
          // Първо: откачен/неправилно прикачен елемент -> НОВ елемент (иначе
          // room.startAudio би пуснал откачения). Синхронно — в същия жест.
          for (const participant of room.remoteParticipants.values()) {
            for (const publication of participant.audioTrackPublications.values()) {
              const track = publication.track
              if (track === undefined || track.sid === undefined || track.mediaStreamTrack.readyState !== 'live') continue
              const entry = audioEntries.get(publication.trackSid)
              const broken = entry === undefined || entry.track !== track || !entry.element.isConnected
                || !streamCarries(entry.element, track.mediaStreamTrack) || !track.attachedElements.includes(entry.element)
              if (broken) attachAudio(track, participant)
            }
          }
          // Жест (или след собствен capture): SDK-то пуска всички прикачени елементи.
          await room.startAudio()
          let allPlaying = true
          for (const entry of [...audioEntries.values()]) {
            if (entry.element.paused && (await playElement(entry.element)) !== 'success') allPlaying = false
          }
          if (outputBlocked && allPlaying) {
            outputBlocked = false
            outputLimiter.reset()
            reportMedia({ event: 'media_recovery', target: 'output', step: 'start_audio', result: 'success', trigger: 'gesture' })
          }
        },
        canPlaybackAudio: () => canPlayback(),
        listRemoteParticipants() {
          return [...room.remoteParticipants.values()].map((participant) => {
            const microphone = participant.getTrackPublication(Track.Source.Microphone)
            return { identity: participant.identity, microphonePublished: microphone !== undefined && !microphone.isMuted }
          })
        },
        setRemoteIdentityVolume(identity, volume) {
          const participant = [...room.remoteParticipants.values()].find((p) => p.identity === identity)
          if (participant === undefined) return
          for (const publication of participant.trackPublications.values()) {
            if (publication.kind === Track.Kind.Audio && publication.track !== undefined) {
              ;(publication.track as RemoteAudioTrack).setVolume(volume)
            }
          }
        },
        confirmCaptureStall: () => confirmCaptureStall(),
        recoverMicrophone: (options) => recoverMicrophone(options.explicit),
        debugMedia: () => ({
          ...media,
          micRecoveryRunning: recovery === null ? 0 : 1,
          micOrphaned: recoveryOrphaned ? 1 : 0,
          captureLive: micCapture !== null && micCapture.readyState === 'live' ? 1 : 0,
          captureMuted: micCapture?.muted === true ? 1 : 0,
          upstreamPaused: micTrack()?.isUpstreamPaused === true ? 1 : 0,
          micHealth: micHealth === 'ok' ? 0 : micHealth === 'system_muted' ? 1 : 2,
          outputBlocked: outputBlocked ? 1 : 0,
          audioEntries: audioEntries.size,
          limiterKeys: outputLimiter.size(),
          remoteTracked: remoteStall.size(),
          monitorTimerActive: monitorTimer === null ? 0 : 1,
          monitorBusy: monitorBusy ? 1 : 0,
          outputRequests: outputTask.stats().requests,
          outputRuns: outputTask.stats().runs,
          outputMaxConcurrent: outputTask.stats().maxConcurrent,
          outputPending: outputTask.pending() ? 1 : 0,
          roomState: room.state === ConnectionState.Connected ? 1 : 0,
        }),
        async getTransportInfo() {
          // Отдалечено аудио (subscriber връзката) или собственият микрофон (publisher).
          let track: RemoteTrack | LocalTrack | undefined
          for (const participant of room.remoteParticipants.values()) {
            const publication = participant.getTrackPublication(Track.Source.Microphone)
            if (publication?.track !== undefined) {
              track = publication.track
              break
            }
          }
          track ??= micTrack()
          if (track === undefined || disposed) return null
          try {
            const report = await track.getRTCStatsReport()
            return report === undefined ? null : summarizeTransportStats(report)
          } catch {
            return null
          }
        },
      }

      return {
        async connect(url, token) {
          await room.connect(url, token, { autoSubscribe: true })
          return connected
        },
        async abort() {
          await connected.disconnect()
        },
      }
    },
  }
}

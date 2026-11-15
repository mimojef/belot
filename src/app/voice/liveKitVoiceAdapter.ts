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
  type VoiceMicrophoneFailure,
  type VoiceMicrophoneLossReason,
  type VoiceRetainedMicrophone,
} from './voiceAdapter'
import { classifyPublishError } from './voicePublishErrors'
import { isMicrophonePermissionGranted } from './voiceIntentStore'
import type { VoiceAudioSink } from './voiceAudioSink'
import { summarizeTransportStats } from './voiceTransportStats'

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

      function attachAudio(track: RemoteTrack, participant: RemoteParticipant): void {
        if (track.kind !== Track.Kind.Audio || track.sid === undefined) return
        const element = track.attach()
        element.autoplay = true
        sink.attach(track.sid, element)
        attachedTrackSids.add(track.sid)
        ;(track as RemoteAudioTrack).setVolume(isIdentityLocallyMuted(participant.identity) ? 0 : 1)
      }

      function detachAudio(track: RemoteTrack): void {
        if (track.sid === undefined) return
        track.detach()
        sink.detach(track.sid)
        attachedTrackSids.delete(track.sid)
      }

      function releaseAllAudio(): void {
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
        stopCapture(micCapture)
        micCapture = null
        unwatchMicrophone()
        events.onLocalMicrophoneLost(reason)
      }

      function stopLocalMicrophone(): Promise<void> {
        const capture = micCapture
        micCapture = null
        unwatchMicrophone()
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
          events.onReconnecting()
        })
        .on(RoomEvent.Reconnected, () => {
          events.onReconnected()
          // Официалният пълен reconnect публикува същия track наново; ако не е
          // успял — capture-ът не остава активен без публикация.
          if (micCapture !== null && micTrack()?.mediaStreamTrack !== micCapture) loseMicrophone('republish_failed')
        })
        .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
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
        .on(RoomEvent.AudioPlaybackStatusChanged, () => events.onPlaybackStatusChanged(room.canPlaybackAudio))
        .on(RoomEvent.MediaDevicesChanged, () => {
          events.onDevicesChanged()
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
          await stopLocalMicrophone()
          releaseAllAudio()
          await room.disconnect(true).catch(() => {})
          disposed = true
          if (activeRoom === room) activeRoom = null
        },
        async detachMicrophoneForReuse() {
          const track = micTrack()
          if (track === undefined || track.mediaStreamTrack.readyState !== 'live') {
            await stopLocalMicrophone()
            return null
          }
          const capture = track.mediaStreamTrack
          // Първо нулиране -> LocalTrackUnpublished/Disconnected не го спират.
          micCapture = null
          unwatchMicrophone()
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
        startAudio: () => room.startAudio(),
        canPlaybackAudio: () => room.canPlaybackAudio,
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

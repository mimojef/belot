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
//     capture-ът се освобождава; НЕ се превключва автоматично към друго устройство.

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
  type VoiceMicrophoneFailure,
  type VoiceRetainedMicrophone,
} from './voiceAdapter'
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

function mapDisconnectReason(reason: DisconnectReason | undefined, clientInitiated: boolean): VoiceDisconnectCause {
  if (clientInitiated || reason === DisconnectReason.CLIENT_INITIATED) return 'client'
  if (reason === DisconnectReason.ROOM_DELETED) return 'room_deleted'
  if (reason === DisconnectReason.PARTICIPANT_REMOVED) return 'removed'
  if (reason === DisconnectReason.DUPLICATE_IDENTITY) return 'duplicate_identity'
  return 'connection_lost'
}

function mapMicrophoneError(error: unknown): VoiceMicrophoneFailure {
  const failure = MediaDeviceFailure.getFailure(error)
  if (failure === MediaDeviceFailure.PermissionDenied) return 'permission_denied'
  if (failure === MediaDeviceFailure.NotFound) return 'not_found'
  if (failure === MediaDeviceFailure.DeviceInUse) return 'unavailable'
  if (failure === MediaDeviceFailure.Other) return 'unavailable'
  // Не е грешка на устройството: сървърът е отказал публикуването (права).
  const message = error instanceof Error ? error.message : String(error)
  if (/permission|not allowed|insufficient|unauthori[sz]ed/i.test(message)) return 'not_permitted'
  return 'unavailable'
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
      function loseMicrophone(): void {
        stopCapture(micCapture)
        micCapture = null
        unwatchMicrophone()
        events.onLocalMicrophoneLost()
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

      async function publishCapture(capture: MediaStreamTrack): Promise<void> {
        try {
          await room.localParticipant.publishTrack(capture, { source: Track.Source.Microphone })
        } catch (error) {
          stopCapture(capture)
          await stopLocalMicrophone()
          throw new VoiceMicrophoneError(mapMicrophoneError(error))
        }
        micCapture = capture
        const track = micTrack()
        if (track !== undefined) {
          const onEnded = () => { void stopLocalMicrophone().then(() => events.onLocalMicrophoneLost()) }
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
          events.onLocalMicrophoneLost()
          return
        }
        // Без заявка за разрешение: само изброяване на вече разрешените устройства.
        const deviceId = await track.getDeviceId(false).catch(() => undefined)
        if (deviceId === undefined || deviceId === 'default') return
        const devices = await Room.getLocalDevices('audioinput', false).catch(() => null)
        if (devices !== null && !devices.some((device) => device.deviceId === deviceId)) {
          await stopLocalMicrophone()
          events.onLocalMicrophoneLost()
        }
      }

      room
        .on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
          releaseAllAudio()
          if (activeRoom === room) activeRoom = null
          const cause = mapDisconnectReason(reason, clientDisconnect)
          // ROOM_DELETED може да пристигне ПРЕДИ voice_table_updated (ротация):
          // живият capture не се спира, а се предава на контролера, който го
          // публикува в новата генерация или го освобождава (≤20 s). Всяка
          // друга причина (мрежа, премахване, page leave…) -> спиране.
          const capture = micCapture
          micCapture = null
          unwatchMicrophone()
          const held = cause === 'room_deleted' && !disposed && capture !== null && capture.readyState === 'live' ? retainCapture(capture) : null
          if (held === null) stopCapture(capture)
          if (disposed) {
            held?.release()
            return
          }
          events.onDisconnected(cause, held)
        })
        .on(RoomEvent.Reconnecting, () => events.onReconnecting())
        .on(RoomEvent.Reconnected, () => {
          events.onReconnected()
          // Официалният пълен reconnect публикува същия track наново; ако не е
          // успял — capture-ът не остава активен без публикация.
          if (micCapture !== null && micTrack()?.mediaStreamTrack !== micCapture) loseMicrophone()
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
          // Сървърно премахване (напр. отнето право) при свързана стая и без
          // повторна публикация на същия capture -> спиране (без нов capture).
          if (micCapture === null || room.state !== ConnectionState.Connected) return
          if (micTrack()?.mediaStreamTrack === micCapture) return
          loseMicrophone()
        })

      const connected: VoiceConnectedRoom = {
        async disconnect() {
          if (disposed) return
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
            stopCapture(capture)
            return null
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

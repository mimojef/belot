// Тестова подмяна на src/app/voice/liveKitVoiceAdapter.ts (само в e2e през
// Vite resolveId plugin): същият интерфейс, без livekit-client и без мрежа.
// Реалният гласов контролер, voice_presence/lease, токените и сървърът работят
// истински; „стаята“ просто остава свързана, докато контролерът не я изключи.
// Броячите (window.__fakeLiveKit) показват дали гласовата сесия е прекъсвана.
//
// Микрофон: acquireMicrophone връща истински MediaStreamTrack (WebAudio —
// без разрешение и без устройство), за да се проверява, че всеки capture се
// спира. По избор (window.__fakeLiveKitControl, задава се ПРЕДИ зареждането):
//   gumDelayMs           — „прозорецът за разрешение“ чака толкова ms;
//   dropDuringGum        — LiveKit връзката пада (connection_lost) по време на чакането;
//   cancelFirstPublish   — като LiveKit 2.x: пълен SDK reconnect отменя първото
//                          публикуване (Reconnecting -> отказ -> Reconnected след 600 ms).
import {
  VoiceMicrophoneError,
  type VoiceAdapter,
  type VoiceAdapterEvents,
  type VoiceConnectedRoom,
  type VoiceRetainedMicrophone,
} from '../../src/app/voice/voiceAdapter'

type FakeLiveKitStats = {
  prepares: number
  connects: number
  disconnects: number
  activeRooms: number
  lastUrl: string | null
  getUserMediaCalls: number
  publishes: number
  cancelledPublishes: number
  /** Неспрени capture-и (трябва да е 0 или 1). */
  liveCaptures: number
  /** Стаи с публикуван микрофон (дублирани audio tracks, ако > 1). */
  publishedMics: number
}
type FakeLiveKitControl = { gumDelayMs?: number; dropDuringGum?: boolean; cancelFirstPublish?: boolean }

const tracks: MediaStreamTrack[] = []
let audioContext: AudioContext | null = null
let publishedRooms = 0
let cancelUsed = false

function stats(): FakeLiveKitStats {
  const w = window as unknown as { __fakeLiveKit?: FakeLiveKitStats }
  w.__fakeLiveKit ??= {
    prepares: 0, connects: 0, disconnects: 0, activeRooms: 0, lastUrl: null,
    getUserMediaCalls: 0, publishes: 0, cancelledPublishes: 0, liveCaptures: 0, publishedMics: 0,
  }
  const s = w.__fakeLiveKit
  s.liveCaptures = tracks.filter((track) => track.readyState === 'live').length
  s.publishedMics = publishedRooms
  return s
}

function control(): FakeLiveKitControl {
  return (window as unknown as { __fakeLiveKitControl?: FakeLiveKitControl }).__fakeLiveKitControl ?? {}
}

function syntheticTrack(): MediaStreamTrack {
  audioContext ??= new AudioContext()
  const track = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0]!
  tracks.push(track)
  return track
}

const retained = new WeakMap<VoiceRetainedMicrophone, MediaStreamTrack>()
function retain(track: MediaStreamTrack): VoiceRetainedMicrophone {
  const handle: VoiceRetainedMicrophone = {
    isLive: () => retained.has(handle) && track.readyState === 'live',
    release: () => {
      if (!retained.has(handle)) return
      retained.delete(handle)
      track.stop()
    },
  }
  retained.set(handle, track)
  return handle
}

type ActiveRoom = { events: VoiceAdapterEvents; dropConnection: () => void }
let active: ActiveRoom | null = null

export function createLiveKitVoiceAdapter(_sink: unknown): VoiceAdapter {
  return {
    async acquireMicrophone() {
      stats().getUserMediaCalls += 1
      const track = syntheticTrack()
      const options = control()
      const delay = options.gumDelayMs ?? 0
      if (options.dropDuringGum === true && active !== null) {
        const room = active
        setTimeout(() => room.dropConnection(), Math.min(300, Math.max(0, delay / 3)))
      }
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      stats()
      return retain(track)
    },
    prepare(events) {
      stats().prepares += 1
      let aborted = false
      return {
        async connect(url: string, token: string): Promise<VoiceConnectedRoom> {
          if (aborted) throw new Error('aborted')
          if (typeof token !== 'string' || token.length === 0) throw new Error('no token')
          const s = stats()
          s.connects += 1
          s.activeRooms += 1
          s.lastUrl = url
          let disconnected = false
          let micTrack: MediaStreamTrack | null = null
          const unpublish = (): void => {
            if (micTrack !== null) {
              micTrack.stop()
              micTrack = null
              publishedRooms -= 1
            }
          }
          const close = (): void => {
            if (disconnected) return
            disconnected = true
            unpublish()
            s.disconnects += 1
            s.activeRooms -= 1
            if (active?.events === events) active = null
            stats()
          }
          active = {
            events,
            dropConnection: () => {
              if (disconnected) return
              close()
              events.onDisconnected('connection_lost', null, 'network')
            },
          }
          return {
            async disconnect() { close() },
            async detachMicrophoneForReuse() {
              unpublish()
              return null
            },
            async enableMicrophone(reuse) {
              if (reuse === undefined) {
                // Стар път (без acquireMicrophone) — не се използва.
                micTrack = syntheticTrack()
                publishedRooms += 1
                return
              }
              const track = retained.get(reuse)
              if (track === undefined || track.readyState !== 'live') {
                reuse.release()
                throw new VoiceMicrophoneError('unavailable')
              }
              retained.delete(reuse)
              await Promise.resolve()
              if (control().cancelFirstPublish === true && !cancelUsed) {
                cancelUsed = true
                stats().cancelledPublishes += 1
                events.onReconnecting()
                setTimeout(() => { if (!disconnected) events.onReconnected() }, 600)
                throw new VoiceMicrophoneError('interrupted', { retained: retain(track), publishError: 'cancelled' })
              }
              if (disconnected) {
                track.stop()
                throw new VoiceMicrophoneError('unavailable')
              }
              unpublish()
              micTrack = track
              publishedRooms += 1
              stats().publishes += 1
            },
            async disableMicrophone() {
              unpublish()
              stats()
            },
            isMicrophoneLive: () => micTrack !== null && micTrack.readyState === 'live',
            async startAudio() {},
            canPlaybackAudio: () => true,
            listRemoteParticipants: () => [],
            setRemoteIdentityVolume() {},
          }
        },
        async abort() { aborted = true },
      }
    },
  }
}

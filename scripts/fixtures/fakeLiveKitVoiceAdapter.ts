// Тестова подмяна на src/app/voice/liveKitVoiceAdapter.ts (само в e2e през
// Vite resolveId plugin): същият интерфейс, без livekit-client и без мрежа.
// Реалният гласов контролер, voice_presence/lease, токените и сървърът работят
// истински; „стаята“ просто остава свързана, докато контролерът не я изключи.
// Броячите (window.__fakeLiveKit) показват дали гласовата сесия е прекъсвана.
import type { VoiceAdapter, VoiceConnectedRoom } from '../../src/app/voice/voiceAdapter'

type FakeLiveKitStats = { prepares: number; connects: number; disconnects: number; activeRooms: number; lastUrl: string | null }

function stats(): FakeLiveKitStats {
  const w = window as unknown as { __fakeLiveKit?: FakeLiveKitStats }
  w.__fakeLiveKit ??= { prepares: 0, connects: 0, disconnects: 0, activeRooms: 0, lastUrl: null }
  return w.__fakeLiveKit
}

export function createLiveKitVoiceAdapter(_sink: unknown): VoiceAdapter {
  return {
    prepare() {
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
          let micLive = false
          return {
            async disconnect() {
              if (disconnected) return
              disconnected = true
              micLive = false
              s.disconnects += 1
              s.activeRooms -= 1
            },
            async detachMicrophoneForReuse() { return null },
            async enableMicrophone() { micLive = true },
            async disableMicrophone() { micLive = false },
            isMicrophoneLive: () => micLive,
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

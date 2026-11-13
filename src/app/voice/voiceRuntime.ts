// Гласов чат — lazy runtime (Етап 3).
//
// Входна точка на ЕДИНСТВЕНИЯ гласов chunk (assets/voice-*, извън PWA
// precache-а): controller + LiveKit адаптер + livekit-client + audio sink +
// HTTPS транспортът. Зарежда се само от voiceFacade.ts при изрично действие
// на потребителя („Само слушай“ / „Включи микрофона“) — никога при обикновени
// маси, при изключена функционалност или само заради сядане на гласова маса.

import { createVoiceController, type VoiceController, type VoiceControllerDeps } from './createVoiceController'
import { createLiveKitVoiceAdapter } from './liveKitVoiceAdapter'
import { createVoiceAudioSink } from './voiceAudioSink'

export type VoiceRuntimeDeps = Pick<VoiceControllerDeps, 'sendPresence' | 'onRequestVip'> & {
  /** База на API-то (същата като за останалите HTTPS заявки на приложението). */
  apiBaseUrl: () => string
}

export function createVoiceRuntime(deps: VoiceRuntimeDeps): VoiceController {
  const adapter = createLiveKitVoiceAdapter(createVoiceAudioSink(document))
  return createVoiceController({
    sendPresence: deps.sendPresence,
    onRequestVip: deps.onRequestVip,
    loadAdapter: () => Promise.resolve(adapter),
    // Етап 6: анонимна диагностика (броячи на сървъра) — best-effort, без
    // retry; грешка/429 никога не влияе на гласа.
    reportDiagnostic: (report) => {
      void fetch(`${deps.apiBaseUrl()}/api/voice/client-report`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      }).catch(() => {})
    },
    // HTTPS със съществуващата cookie сесия; отговорът (с токена) не се логва
    // и не се кешира.
    postJson: async (path, body) => {
      const response = await fetch(`${deps.apiBaseUrl()}${path}`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      let json: unknown = null
      try {
        json = await response.json()
      } catch {
        json = null
      }
      return { status: response.status, body: json }
    },
  })
}

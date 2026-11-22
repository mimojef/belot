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
import { classifyVoicePlatform, type VoicePlatform } from './voiceMediaHealth'
import { isVoiceMicAutoRecoveryEnabled, type VoiceDiagnosticsAccess } from './voiceMicRecoveryConfig'
import { isVoiceDiagnosticsRequested, mountVoiceDiagnosticsOverlay } from './voiceDiagnosticsOverlay'

/** Етап H: груба платформа (затворено изброяване) — пълният User-Agent не напуска браузъра. */
function detectPlatform(): VoicePlatform {
  try {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches === true
      || (navigator as Navigator & { standalone?: boolean }).standalone === true
    return classifyVoicePlatform(navigator.userAgent ?? '', { standalone, maxTouchPoints: navigator.maxTouchPoints ?? 0 })
  } catch {
    return 'unknown'
  }
}

export type VoiceRuntimeDeps = Pick<VoiceControllerDeps, 'sendPresence' | 'onRequestVip'> & {
  /** База на API-то (същата като за останалите HTTPS заявки на приложението). */
  apiBaseUrl: () => string
  /** Етап H3: текущата сесия (пълен администратор?) — за панела и тестовото превключване. */
  diagnosticsAccess?: () => VoiceDiagnosticsAccess | null
}

export function createVoiceRuntime(deps: VoiceRuntimeDeps): VoiceController {
  const adapter = createLiveKitVoiceAdapter(createVoiceAudioSink(document))
  const platform = detectPlatform()
  const controller = createVoiceController({
    sendPresence: deps.sendPresence,
    onRequestVip: deps.onRequestVip,
    loadAdapter: () => Promise.resolve(adapter),
    // Етап H3: в production — изключено по подразбиране (само бутон).
    micAutoRecovery: () => isVoiceMicAutoRecoveryEnabled(deps.diagnosticsAccess?.() ?? null),
    // Етап 6: анонимна диагностика (броячи на сървъра) — best-effort, без
    // retry; грешка/429 никога не влияе на гласа.
    reportDiagnostic: (report) => {
      void fetch(`${deps.apiBaseUrl()}/api/voice/client-report`, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        // Доставя се и при pagehide (прекратяване на сесията при затваряне/навигация).
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...report, platform }),
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
  // Етап H3: само при изричен ?voicediag=1 — локален панел за измерване на телефони.
  // Само пълен администратор (проверява се и при всяко обновяване на панела).
  if (isVoiceDiagnosticsRequested() && deps.diagnosticsAccess !== undefined) mountVoiceDiagnosticsOverlay(controller, platform, deps.diagnosticsAccess)
  return controller
}

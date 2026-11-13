// Гласов чат — Етап 6: събира показателите за админ панела „Гласови разговори“.
//
// Източници (всеки със собствен кеш/timeout, извличани паралелно):
//   * live    — живите LiveKit стаи и участниците (voiceAdminLiveProbe);
//   * vps     — гласовият VPS през защитения Caddy маршрут (voiceVpsMetrics);
//   * server  — броячи на Pika процеса (токени, откази по код, ротации, breaker);
//   * clients — анонимна клиентска диагностика (voiceClientDiagnostics).
// Без профили, имена, токени и аудио. Вика се само от админ API-то.

import type { VoiceAdminLiveProbe } from './voiceAdminLiveProbe.js'
import type { VoiceClientDiagnostics } from './voiceClientDiagnostics.js'
import type { VoiceRuntimeStats } from './voiceChatService.js'
import type { VoiceVpsMetricsCollector } from './voiceVpsMetrics.js'

export function createVoiceAdminMonitoring(deps: {
  liveProbe: VoiceAdminLiveProbe
  vpsCollector: VoiceVpsMetricsCollector
  clientDiagnostics: VoiceClientDiagnostics
  getRuntimeStats: () => VoiceRuntimeStats
  /** Старт на процеса — броячите са от този момент. */
  processStartedAt: string
}): () => Promise<Record<string, unknown>> {
  return async () => {
    const [live, vps] = await Promise.all([deps.liveProbe.getSnapshot(), deps.vpsCollector.getSnapshot()])
    const runtime = deps.getRuntimeStats()
    return {
      live,
      vps,
      server: {
        since: deps.processStartedAt,
        liveKitConfigured: runtime.liveKitConfigured,
        breaker: runtime.dispatcher.breaker,
        activeVoiceSessions: runtime.activeVoiceSessions,
        /** Наблюдение на неясни CreateRoom (чакащите DeleteRoom са в основния snapshot). */
        reconciler: runtime.reconciler,
        tokensIssued: runtime.counters.tokensIssued ?? 0,
        tokensDenied: runtime.counters.tokensDenied ?? 0,
        tokensDeniedByCode: runtime.tokensDeniedByCode,
        tokensDiscardedStale: runtime.counters.tokensDiscardedStale ?? 0,
        rotations: runtime.counters.rotations ?? 0,
        createRoomFailures: runtime.counters.createRoomFailures ?? 0,
        leaseExpired: runtime.counters.leaseExpired ?? 0,
        disconnectTimeouts: runtime.counters.disconnectTimeouts ?? 0,
        speakUpgrades: runtime.counters.speakUpgrades ?? 0,
        muteRevocations: runtime.counters.muteRevocations ?? 0,
        liveKitRequests: {
          succeeded: runtime.dispatcher.succeeded,
          failed: runtime.dispatcher.failed,
          rejectedBreakerOpen: runtime.dispatcher.rejectedBreakerOpen,
          rejectedQueueFull: runtime.dispatcher.rejectedQueueFull,
          breakerOpenedCount: runtime.dispatcher.breakerOpenedCount,
        },
      },
      clients: deps.clientDiagnostics.snapshot(),
    }
  }
}

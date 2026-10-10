// Scheduler за автоматичните преходи на кампании — архитектурен модел,
// mirror на server/src/tournament/tournamentScheduler.ts: periodic
// setInterval tick, inFlight guard (предотвратява overlapping tick-ове),
// per-item try/catch (грешка в една кампания не блокира останалите/не
// сваля сървъра), health diagnostics, .unref() (да не държи процеса жив),
// tickNow() за ръчно/тестово triggeр-ване.
//
// Съзнателна разлика от tournamentScheduler.ts: там scheduler-ът държи
// СВОЯ собствена DatabaseSync connection само за due-queries, отделно от
// economyStore-ната connection за самите мутации (историческа организация
// на оригиналния модул). Тук due-queries (listDueScheduledCampaignIds/
// listDueActiveCampaignIds) вече живеят В campaignsStore.ts (виж там) —
// scheduler-ът е чист orchestration/timing слой с НУЛЕВА директна DB
// зависимост, само извиква store функции. Архитектурният МОДЕЛ (tick/
// inFlight/health/error-isolation) е identичен; няма нужда от втора
// redundant connection към същия файл само за да се копира литерално.
//
// Feature flag: `isCampaignsFeatureEnabled()` НЕ се проверява вътре в този
// файл — scheduler-ът е чисто механичен и безопасен сам по себе си
// (due-queries просто не намират нищо, докато няма создадени кампании).
// Отговорността "не стартирай/не тиквай тази функционалност в продукция,
// докато флагът е изключен" е на WIRING ТОЧКАТА (бъдещ index.ts integration,
// извън обхвата на тази фаза) — виж checkCampaignScheduler.ts за явен тест
// на точно това разделение на отговорности.

import type { CampaignActionActor, CampaignId, CampaignsStore } from './campaignsStore.js'

export type CampaignSchedulerHealth = {
  state: 'idle' | 'running' | 'stopped'
  inFlight: boolean
  lastTickAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  processedLastTick: number
  nextTickIntervalMs: number
}

export type CampaignScheduler = {
  start: () => void
  stop: () => void
  tickNow: () => void
  getHealth: () => CampaignSchedulerHealth
  close: () => void
}

export type CampaignSchedulerDeps = {
  store: CampaignsStore
  intervalMs?: number
  batchSize?: number
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>
  clearInterval?: (id: ReturnType<typeof globalThis.setInterval>) => void
  now?: () => Date
  logError?: (message: string, error: unknown) => void
  // Monitoring-only, best-effort — mirror на tournamentScheduler.ts
  // onTickTiming: никога не хвърля, никога не влияе на scheduler логиката.
  onTickTiming?: (durationMs: number) => void
}

const DEFAULT_INTERVAL_MS = 15_000
const DEFAULT_BATCH_SIZE = 25
const SYSTEM_ACTOR: CampaignActionActor = { type: 'system' }

function sanitizeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function createCampaignScheduler(deps: CampaignSchedulerDeps): CampaignScheduler {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE
  const now = deps.now ?? (() => new Date())
  const logError = deps.logError ?? ((message, error) => console.error(message, error))
  const setTimer = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearTimer = deps.clearInterval ?? ((id) => globalThis.clearInterval(id))

  let intervalId: ReturnType<typeof globalThis.setInterval> | null = null
  let inFlight = false
  let stopped = false
  let lastTickAt: string | null = null
  let lastSuccessAt: string | null = null
  let lastError: string | null = null
  let processedLastTick = 0

  function handleDueScheduledCampaign(campaignId: CampaignId, tickNow: Date): void {
    const activateResult = deps.store.activateCampaign(campaignId, tickNow, SYSTEM_ACTOR)
    if (!activateResult.ok && activateResult.reason === 'already_expired') {
      // Цялият период (вкл. ends_at) вече е отминал преди сървърът да успее
      // да активира кампанията изобщо (напр. дълго прекъсване) — директно
      // scheduled -> finished, НИКОГА за кратко през 'active' (виж §5 от
      // task spec-а: "Не я активирай за кратко само за да я приключиш").
      deps.store.expireScheduledCampaignWithoutActivating(campaignId, tickNow, SYSTEM_ACTOR)
    }
    // 'another_campaign_active' / 'invalid_status' / 'campaign_not_found' —
    // мирa на tournamentScheduler-ния "not_ready" паттерн: не е грешка,
    // просто retry на следващия tick (напр. блокиращата активна кампания
    // още не е приключила — overlap guard-ът при scheduleCampaign вече
    // трябва да е предотвратил това да се случва в нормален режим).
  }

  function runTick(): void {
    if (stopped || inFlight) return
    inFlight = true
    const tickStartedAtMs = performance.now()
    const tickNow = now()
    lastTickAt = tickNow.toISOString()
    processedLastTick = 0
    try {
      const dueScheduledIds = deps.store.listDueScheduledCampaignIds(tickNow, batchSize)
      for (const campaignId of dueScheduledIds) {
        try {
          handleDueScheduledCampaign(campaignId, tickNow)
          processedLastTick += 1
        } catch (error) {
          lastError = sanitizeError(error)
          logError(`[campaign-scheduler] scheduled campaign transition failed: ${campaignId}`, error)
        }
      }

      const dueActiveIds = deps.store.listDueActiveCampaignIds(tickNow, batchSize)
      for (const campaignId of dueActiveIds) {
        try {
          deps.store.finishCampaign(campaignId, tickNow, SYSTEM_ACTOR)
          processedLastTick += 1
        } catch (error) {
          lastError = sanitizeError(error)
          logError(`[campaign-scheduler] finish campaign failed: ${campaignId}`, error)
        }
      }

      lastSuccessAt = new Date().toISOString()
      if (lastError === null || processedLastTick > 0) lastError = null
    } catch (error) {
      lastError = sanitizeError(error)
      logError('[campaign-scheduler] tick failed', error)
    } finally {
      inFlight = false
      try {
        deps.onTickTiming?.(performance.now() - tickStartedAtMs)
      } catch {
        // monitoring hook — никога не влияе на scheduler логиката
      }
    }
  }

  function start(): void {
    if (intervalId !== null) return
    stopped = false
    runTick()
    intervalId = setTimer(runTick, intervalMs)
    if (typeof intervalId === 'object' && intervalId !== null && 'unref' in intervalId) {
      ;(intervalId as { unref: () => void }).unref()
    }
  }

  function stop(): void {
    stopped = true
    if (intervalId !== null) {
      clearTimer(intervalId)
      intervalId = null
    }
  }

  return {
    start,
    stop,
    tickNow(): void {
      runTick()
    },
    getHealth(): CampaignSchedulerHealth {
      return {
        state: stopped ? 'stopped' : intervalId === null ? 'idle' : 'running',
        inFlight,
        lastTickAt,
        lastSuccessAt,
        lastError,
        processedLastTick,
        nextTickIntervalMs: intervalMs,
      }
    },
    // Mirror на tournamentScheduler.close(): затваря само собствените
    // ресурси на scheduler-а (тук — нулеви, виж коментара най-отгоре). Store
    // dependency-то е инжектирано отвън (не е owned тук) и неговия lifecycle
    // е отговорност на caller-а — точно както tournamentScheduler.close()
    // не затваря инжектираната economyStore connection.
    close(): void {
      stop()
    },
  }
}

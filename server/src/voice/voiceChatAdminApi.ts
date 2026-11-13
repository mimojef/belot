// Гласов чат — административно API (Етап 2а). Само пълен admin.
//
//   GET  /api/admin/voice-chat          -> режим, лимит, заети слотове, одит
//   POST /api/admin/voice-chat/mode     { mode: 'off'|'admin_only'|'public', confirm: true }
//   POST /api/admin/voice-chat/limit    { maxTables: 0..200 }
//   GET  /api/admin/voice-chat/monitoring  (Етап 6) -> живо състояние на
//        стаите, клиентска статистика, показатели на гласовия VPS. Асинхронно,
//        с кеш 15–30 s в модулите-източници; само при отворен админ панел.
//
// Зависимостите се инжектират (сесия, origin, четене на тялото) — модулът не
// импортира index.ts и се тества самостоятелно. Всички отговори са
// Cache-Control: no-store. Никакви LiveKit стойности/тайни не се връщат —
// само дали конфигурацията е подадена и имената на липсващите променливи.

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  getVoiceChatLiveKitConfigStatus,
  isVoiceChatEmergencyStopActive,
  resolveEffectiveVoiceChatMode,
} from './voiceChatFeatureFlag.js'
import type { SetModeResult, VoiceChatStore } from './voiceChatStore.js'
import { VOICE_CHAT_MAX_TABLES_UPPER_BOUND, isVoiceChatMode } from './voiceChatTypes.js'
import { getVoiceVpsMetricsConfigStatus } from './voiceVpsMetrics.js'

/** Общ таван за /monitoring — източниците са с timeout 3–4 s, отговорът не чака повече. */
export const VOICE_ADMIN_MONITORING_BUDGET_MS = 6_000

export const VOICE_CHAT_ADMIN_BASE_PATH = '/api/admin/voice-chat'

type EnvSource = Readonly<Record<string, string | undefined>>

export type VoiceChatAdminApiDeps = {
  store: VoiceChatStore
  /** profileId на пълен admin от СВЕЖА сесия (isFullAdminSession), иначе null. */
  getFullAdminProfileId: (req: IncomingMessage) => string | null
  /** Същият guard като останалите мутиращи endpoint-и (isAllowedVisitorRequestOrigin). */
  isAllowedOrigin: (req: IncomingMessage) => boolean
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  /** Имена за одита (live от профилите; липсващ/изтрит -> null). */
  resolveDisplayName?: (profileId: string) => string | null
  /** Етап 2б: прекратяване на гласовите сесии и LiveKit стаите след 'off'. */
  onModeChanged?: (result: Extract<SetModeResult, { ok: true }>) => void
  /**
   * Етап 2б: технически показатели на runtime-а (breaker, опашки, броячи) —
   * без тайни, токени или лични данни. Липсващ -> полето не се връща.
   */
  getRuntimeStats?: () => Record<string, unknown>
  /**
   * Етап 6: живо състояние (ListRooms/ListParticipants), клиентска
   * статистика и метрики на гласовия VPS. Липсващ -> /monitoring е 404.
   */
  getMonitoring?: () => Promise<Record<string, unknown>>
  /** Само за тестове (по подразбиране VOICE_ADMIN_MONITORING_BUDGET_MS). */
  monitoringBudgetMs?: number
  env?: EnvSource
  now?: () => Date
  log?: (line: string) => void
}

const NO_STORE_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }

function send(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, NO_STORE_HEADERS)
  res.end(JSON.stringify(payload))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildVoiceChatAdminSnapshot(deps: VoiceChatAdminApiDeps): Record<string, unknown> {
  const env = deps.env ?? process.env
  const settings = deps.store.getSettings()
  const emergencyStop = isVoiceChatEmergencyStopActive(env)
  const resolveName = (profileId: string | null): string | null =>
    profileId === null ? null : (deps.resolveDisplayName?.(profileId) ?? null)
  return {
    mode: settings.mode,
    effectiveMode: resolveEffectiveVoiceChatMode(settings.mode, emergencyStop),
    emergencyStop,
    modeChangedAt: settings.modeChangedAt,
    modeChangedByDisplayName: resolveName(settings.modeChangedByProfileId),
    maxTables: settings.maxTables,
    maxTablesUpperBound: VOICE_CHAT_MAX_TABLES_UPPER_BOUND,
    maxTablesChangedAt: settings.maxTablesChangedAt,
    maxTablesChangedByDisplayName: resolveName(settings.maxTablesChangedByProfileId),
    activeVoiceTables: deps.store.countActiveVoiceTables(),
    pendingRoomDeletions: deps.store.countPendingRoomDeletions(),
    liveKit: getVoiceChatLiveKitConfigStatus(env),
    vpsMetrics: getVoiceVpsMetricsConfigStatus(env),
    ...(deps.getRuntimeStats === undefined ? {} : { runtime: deps.getRuntimeStats() }),
    history: deps.store.listAdminChanges(50).map((change) => ({
      changeId: change.changeId,
      setting: change.setting,
      newValue: change.newValue,
      previousValue: change.previousValue,
      changedAt: change.changedAt,
      changedByDisplayName: resolveName(change.changedByProfileId),
    })),
  }
}

export function createVoiceChatAdminRequestHandler(
  deps: VoiceChatAdminApiDeps,
): (req: IncomingMessage, res: ServerResponse, requestUrl: URL) => Promise<boolean> {
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((line: string) => console.log(line))

  return async function handleAdminVoiceChatRequest(req, res, requestUrl): Promise<boolean> {
    const pathname = requestUrl.pathname
    if (pathname !== VOICE_CHAT_ADMIN_BASE_PATH && !pathname.startsWith(`${VOICE_CHAT_ADMIN_BASE_PATH}/`)) {
      return false
    }

    const adminProfileId = deps.getFullAdminProfileId(req)
    if (adminProfileId === null) {
      send(res, 403, { ok: false, code: 'forbidden', message: 'Нямаш достъп до гласовия чат.' })
      return true
    }

    const subPath = pathname.slice(VOICE_CHAT_ADMIN_BASE_PATH.length)

    if (subPath === '' || subPath === '/') {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, message: 'Method not allowed' })
        return true
      }
      send(res, 200, { ok: true, ...buildVoiceChatAdminSnapshot(deps) })
      return true
    }

    if (subPath === '/monitoring' && deps.getMonitoring !== undefined) {
      if (req.method !== 'GET') {
        send(res, 405, { ok: false, message: 'Method not allowed' })
        return true
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      try {
        const budget = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), deps.monitoringBudgetMs ?? VOICE_ADMIN_MONITORING_BUDGET_MS)
        })
        const monitoring = await Promise.race([deps.getMonitoring(), budget])
        if (monitoring === null) {
          send(res, 503, { ok: false, code: 'monitoring_timeout', message: 'Показателите не отговориха навреме. Опитай отново.' })
        } else {
          send(res, 200, { ok: true, generatedAt: now().toISOString(), ...monitoring })
        }
      } catch {
        send(res, 500, { ok: false, code: 'internal_error', message: 'Показателите не са достъпни.' })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      return true
    }

    if (subPath !== '/mode' && subPath !== '/limit') {
      send(res, 404, { ok: false, code: 'not_found', message: 'Not found' })
      return true
    }
    if (req.method !== 'POST') {
      send(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }
    if (!deps.isAllowedOrigin(req)) {
      send(res, 403, { ok: false, code: 'forbidden_origin', message: 'Невалиден произход на заявката.' })
      return true
    }

    let body: unknown
    try {
      body = await deps.readJsonBody(req)
    } catch {
      send(res, 400, { ok: false, code: 'invalid_body', message: 'Невалидно тяло.' })
      return true
    }
    if (!isRecord(body)) {
      send(res, 400, { ok: false, code: 'invalid_body', message: 'Невалидно тяло.' })
      return true
    }

    if (subPath === '/mode') {
      if (!isVoiceChatMode(body.mode)) {
        send(res, 400, { ok: false, code: 'invalid_mode', message: 'Невалиден режим.' })
        return true
      }
      if (body.confirm !== true) {
        send(res, 400, { ok: false, code: 'confirmation_required', message: 'Потвърди промяната на режима.' })
        return true
      }
      const result = deps.store.setMode(body.mode, { profileId: adminProfileId }, now())
      if (!result.ok) {
        send(res, result.code === 'busy' ? 503 : 400, {
          ok: false,
          code: result.code,
          message: result.code === 'busy' ? 'Базата е заета. Опитай отново.' : 'Невалиден режим.',
        })
        return true
      }
      log(
        `[voice-chat] mode ${result.changed ? 'changed' : 'unchanged'} ${result.previousMode} -> ${result.settings.mode}` +
          ` by profile=${adminProfileId} releasedTables=${result.releasedVoiceTableIds.length} retiredRooms=${result.retiredRoomNames.length}`,
      )
      if (result.changed) deps.onModeChanged?.(result)
      send(res, 200, {
        ok: true,
        changed: result.changed,
        releasedVoiceTables: result.releasedVoiceTableIds.length,
        // Оттеглени LiveKit стаи: DeleteRoom е асинхронен (durable опашка) —
        // потвърждението се вижда в pendingRoomDeletions, не тук.
        retiredRooms: result.retiredRoomNames.length,
        ...buildVoiceChatAdminSnapshot(deps),
      })
      return true
    }

    // /limit
    const requested = body.maxTables
    const result = deps.store.setMaxTables(requested, { profileId: adminProfileId }, now())
    if (!result.ok) {
      send(res, result.code === 'busy' ? 503 : 400, {
        ok: false,
        code: result.code,
        message:
          result.code === 'busy'
            ? 'Базата е заета. Опитай отново.'
            : `Лимитът трябва да е цяло число от 0 до ${VOICE_CHAT_MAX_TABLES_UPPER_BOUND}.`,
      })
      return true
    }
    log(
      `[voice-chat] max tables ${result.changed ? 'changed' : 'unchanged'} ${result.previousMaxTables} -> ${result.settings.maxTables}` +
        ` by profile=${adminProfileId} active=${result.activeCount}`,
    )
    send(res, 200, { ok: true, changed: result.changed, ...buildVoiceChatAdminSnapshot(deps) })
    return true
  }
}

// „Забрана за съвместна игра“ (Етап 1) — административно HTTP API.
//
// САМО пълен администратор (role=admin) може да преглежда, налага и отменя
// забрани и да сменя глобалния флаг CO_PLAY_RESTRICTIONS_ENABLED. Няма сесия
// -> 401; друга роля (вкл. subadmin/pika_team) -> 403. Ролята и profileId на
// извършителя идват от сървърната сесия, никога от тялото на заявката.
// Промените (POST/PUT) изискват допустим Origin (същата CSRF защита като
// останалите HTTPS действия).
//
//   GET  /api/admin/co-play-restrictions?status=active|expired|lifted|all&q=&limit=&offset=
//   POST /api/admin/co-play-restrictions           { firstProfileId, secondProfileId, reason, durationDays | indefinite:true }
//   GET  /api/admin/co-play-restrictions/settings
//   PUT  /api/admin/co-play-restrictions/settings  { enabled: boolean }
//   GET  /api/admin/co-play-restrictions/audit?restrictionId=&limit=&offset=
//   GET  /api/admin/co-play-restrictions/:id
//   POST /api/admin/co-play-restrictions/:id/lift  { reason? }

import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CoPlayRestrictionStatus,
  CoPlayRestrictionStore,
  ImposeCoPlayRestrictionErrorCode,
  LiftCoPlayRestrictionErrorCode,
} from '../db/coPlayRestrictionStore.js'

export const CO_PLAY_RESTRICTIONS_API_PATH = '/api/admin/co-play-restrictions'

export type CoPlayRestrictionAdminHttpApiDeps = {
  store: CoPlayRestrictionStore
  /** Сесията на заявката: null — няма сесия. */
  getSessionActor: (req: IncomingMessage) => { profileId: string; accountRole: string | null } | null
  isAllowedOrigin: (req: IncomingMessage) => boolean
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  /**
   * След успешно записана забрана (кешът вече е обновен) — прилагане в
   * текущите чакални. Грешка тук не отменя записаната забрана.
   */
  onRestrictionImposed?: (input: { actorProfileId: string }) => void
  /** След успешна промяна на глобалния флаг. */
  onEnabledChanged?: (input: { enabled: boolean; actorProfileId: string }) => void
  /**
   * Етап 4: преди четене на списък/забрана — идемпотентна проверка за
   * изчакващи забрани, чиито общи турнири вече са приключили (предпазна мрежа).
   */
  activatePendingBeforeRead?: () => void
}

function runAfterCommit(label: string, fn: (() => void) | undefined): void {
  if (fn === undefined) return
  try {
    fn()
  } catch (error) {
    console.error(`[co-play] ${label} failed`, error instanceof Error ? error.message : String(error))
  }
}

const IMPOSE_STATUS: Record<ImposeCoPlayRestrictionErrorCode, number> = {
  invalid_profiles: 400,
  same_profile: 400,
  profile_not_found: 404,
  profile_not_eligible: 400,
  same_account: 409,
  invalid_reason: 400,
  invalid_duration: 400,
  invalid_game: 400,
  already_restricted: 409,
}

const LIFT_STATUS: Record<LiftCoPlayRestrictionErrorCode, number> = {
  not_found: 404,
  not_active: 409,
  invalid_reason: 400,
}

const LIST_STATUSES = new Set<CoPlayRestrictionStatus | 'all'>(['active', 'pending_activation', 'expired', 'lifted', 'all'])

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function parseIntegerParam(value: string | null): number | undefined {
  if (value === null || !/^\d{1,6}$/.test(value)) return undefined
  return Number(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createCoPlayRestrictionAdminHttpRequestHandler(deps: CoPlayRestrictionAdminHttpApiDeps) {
  return async function handleCoPlayRestrictionAdminRequest(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    searchParams: URLSearchParams,
  ): Promise<boolean> {
    if (pathname !== CO_PLAY_RESTRICTIONS_API_PATH && !pathname.startsWith(`${CO_PLAY_RESTRICTIONS_API_PATH}/`)) {
      return false
    }
    const subPath = pathname.slice(CO_PLAY_RESTRICTIONS_API_PATH.length)
    const method = req.method ?? 'GET'

    const actor = deps.getSessionActor(req)
    if (actor === null) {
      sendJson(res, 401, { ok: false, message: 'Трябва да влезеш в профила си.' })
      return true
    }
    if (actor.accountRole !== 'admin') {
      sendJson(res, 403, { ok: false, message: 'Само администратор има достъп до забраните за съвместна игра.' })
      return true
    }
    const isMutation = method !== 'GET' && method !== 'HEAD'
    if (isMutation && !deps.isAllowedOrigin(req)) {
      sendJson(res, 403, { ok: false, message: 'Заявката е отхвърлена.' })
      return true
    }

    const readBody = async (): Promise<Record<string, unknown> | null> => {
      try {
        const body = await deps.readJsonBody(req)
        return isRecord(body) ? body : null
      } catch {
        return null
      }
    }

    // ─── Списък ─────────────────────────────────────────────────────────
    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        const rawStatus = searchParams.get('status') ?? 'active'
        if (!LIST_STATUSES.has(rawStatus as CoPlayRestrictionStatus | 'all')) {
          sendJson(res, 400, { ok: false, message: 'Невалиден статус.' })
          return true
        }
        runAfterCommit('activatePendingBeforeRead', deps.activatePendingBeforeRead)
        const result = deps.store.listRestrictions({
          status: rawStatus as CoPlayRestrictionStatus | 'all',
          profileQuery: searchParams.get('q'),
          limit: parseIntegerParam(searchParams.get('limit')),
          offset: parseIntegerParam(searchParams.get('offset')),
        })
        sendJson(res, 200, { ok: true, ...result, enabled: deps.store.isEnabled() })
        return true
      }
      if (method === 'POST') {
        const body = await readBody()
        if (body === null) {
          sendJson(res, 400, { ok: false, message: 'Невалидна заявка.' })
          return true
        }
        const indefinite = body.indefinite === true
        const hasDuration = body.durationDays !== undefined && body.durationDays !== null
        if (indefinite === hasDuration) {
          sendJson(res, 400, { ok: false, code: 'invalid_duration', message: 'Въведете срок в дни или изберете безсрочна забрана.' })
          return true
        }
        const result = deps.store.imposeRestriction({
          firstProfileId: typeof body.firstProfileId === 'string' ? body.firstProfileId : '',
          secondProfileId: typeof body.secondProfileId === 'string' ? body.secondProfileId : '',
          reason: typeof body.reason === 'string' ? body.reason : '',
          durationDays: indefinite ? null : (typeof body.durationDays === 'number' ? body.durationDays : Number.NaN),
          actorProfileId: actor.profileId,
        })
        if (!result.ok) {
          sendJson(res, IMPOSE_STATUS[result.code], {
            ok: false,
            code: result.code,
            message: result.message,
            existingRestrictionId: result.existingRestrictionId,
          })
          return true
        }
        runAfterCommit('onRestrictionImposed', deps.onRestrictionImposed && (() => deps.onRestrictionImposed!({ actorProfileId: actor.profileId })))
        sendJson(res, 201, { ok: true, restriction: result.restriction })
        return true
      }
      sendJson(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    // ─── Глобален флаг ──────────────────────────────────────────────────
    if (subPath === '/settings') {
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, settings: deps.store.getSettings() })
        return true
      }
      if (method === 'PUT') {
        const body = await readBody()
        if (body === null || typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, message: 'Полето enabled трябва да е true или false.' })
          return true
        }
        const result = deps.store.setEnabled({ enabled: body.enabled, actorProfileId: actor.profileId })
        if (!result.ok) {
          // Етап 4: активна забрана с общ незапочнал турнир — флагът НЕ се
          // включва; никой не се маха автоматично.
          sendJson(res, 409, {
            ok: false,
            code: result.code,
            message: 'Флагът не може да бъде включен: има активни забрани между участници в общ незапочнал турнир.',
            conflicts: result.conflicts,
            settings: result.settings,
          })
          return true
        }
        if (result.changed) {
          const enabled = result.settings.enabled
          runAfterCommit('onEnabledChanged', deps.onEnabledChanged && (() => deps.onEnabledChanged!({ enabled, actorProfileId: actor.profileId })))
        }
        sendJson(res, 200, { ok: true, changed: result.changed, settings: result.settings })
        return true
      }
      sendJson(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }

    // ─── Одит ───────────────────────────────────────────────────────────
    if (subPath === '/audit') {
      if (method !== 'GET') {
        sendJson(res, 405, { ok: false, message: 'Method not allowed' })
        return true
      }
      const result = deps.store.listAudit({
        restrictionId: searchParams.get('restrictionId'),
        limit: parseIntegerParam(searchParams.get('limit')),
        offset: parseIntegerParam(searchParams.get('offset')),
      })
      sendJson(res, 200, { ok: true, ...result })
      return true
    }

    // ─── Една забрана / отмяна ──────────────────────────────────────────
    const match = /^\/([A-Za-z0-9-]{1,64})(\/lift)?$/.exec(subPath)
    if (match === null) {
      sendJson(res, 404, { ok: false, message: 'Не е намерено.' })
      return true
    }
    const restrictionId = match[1] as string
    if (match[2] === undefined) {
      if (method !== 'GET') {
        sendJson(res, 405, { ok: false, message: 'Method not allowed' })
        return true
      }
      runAfterCommit('activatePendingBeforeRead', deps.activatePendingBeforeRead)
      const restriction = deps.store.getRestriction(restrictionId)
      if (restriction === null) {
        sendJson(res, 404, { ok: false, message: 'Забраната не беше намерена.' })
        return true
      }
      sendJson(res, 200, { ok: true, restriction })
      return true
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, message: 'Method not allowed' })
      return true
    }
    const body = (await readBody()) ?? {}
    const result = deps.store.liftRestriction({
      restrictionId,
      actorProfileId: actor.profileId,
      reason: typeof body.reason === 'string' ? body.reason : null,
    })
    if (!result.ok) {
      sendJson(res, LIFT_STATUS[result.code], { ok: false, code: result.code, message: result.message, status: result.status })
      return true
    }
    sendJson(res, 200, { ok: true, restriction: result.restriction })
    return true
  }
}

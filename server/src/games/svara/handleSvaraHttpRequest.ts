// HTTP вход за "Свара" (Етап 1): само проверка за достъп.
//
// SPA-то се сервира статично от nginx, затова /games/svara не може да бъде
// защитен на ниво HTML. Защитата е тук: клиентската страница рендира
// съдържание САМО след 200 от GET /api/games/svara/access, а всички бъдещи
// Свара операции минават през същия evaluateSvaraAccess().
//
// При изключен флаг отговорът е 404 — идентичен на непознат route, без да
// издава съществуването на функцията.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { evaluateSvaraAccess, type SvaraAccessSession } from './svaraAccess.js'

export const SVARA_ACCESS_PATH = '/api/games/svara/access'

export type SvaraHttpDeps = {
  getSessionFromRequest: (req: IncomingMessage) => SvaraAccessSession
  sendJsonResponse: (res: ServerResponse, statusCode: number, payload: unknown, headers?: Record<string, string>) => void
}

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' }

export function handleSvaraHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: SvaraHttpDeps,
): boolean {
  if (pathname !== SVARA_ACCESS_PATH) return false

  if (req.method !== 'GET') {
    deps.sendJsonResponse(res, 405, { ok: false, message: 'Method not allowed.' }, { ...NO_STORE_HEADERS, Allow: 'GET' })
    return true
  }

  const decision = evaluateSvaraAccess(deps.getSessionFromRequest(req))
  if (decision.allowed) {
    deps.sendJsonResponse(res, 200, { ok: true, access: 'granted' }, NO_STORE_HEADERS)
    return true
  }

  switch (decision.reason) {
    case 'feature_disabled':
      deps.sendJsonResponse(res, 404, { ok: false, message: 'Not found.' }, NO_STORE_HEADERS)
      return true
    case 'unauthenticated':
      deps.sendJsonResponse(res, 401, { ok: false, reason: 'unauthenticated', message: 'Трябва да влезеш в профила си.' }, NO_STORE_HEADERS)
      return true
    case 'forbidden_role':
      deps.sendJsonResponse(res, 403, { ok: false, reason: 'forbidden', message: 'Нямаш достъп.' }, NO_STORE_HEADERS)
      return true
  }
}

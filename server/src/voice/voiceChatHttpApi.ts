// Гласов чат — HTTPS API за клиента (Етап 2б).
//
//   POST /api/voice/token         { voiceTableId, clientInstanceId }
//   POST /api/voice/speak-access  { voiceTableId, clientInstanceId }
//   GET  /api/voice/create-option  (Етап 4) -> { visible, canCreate, reason }
//        само четене за формата „Нова маса“: не резервира слот и не издава
//        токени; лимитът се проверява атомарно едва при create_private_room.
//
// Токенът се издава САМО тук (никога през игровия WebSocket — клиентът логва
// всяко входящо WS съобщение). Всички отговори са Cache-Control: no-store.
// Токенът, тялото на отговора и тайните НЕ се логват. Проверки: сесия от
// HttpOnly cookie, origin guard (същият като останалите мутиращи
// endpoint-и), формат на тялото; останалото (режим, членство, сесия,
// генерация, права) — авторитетно във voiceChatService.

//   POST /api/voice/client-report  (Етап 6) — анонимна клиентска диагностика
//        (броячи в паметта; виж voiceClientDiagnostics.ts).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { VOICE_CLIENT_REPORT_PATH, type VoiceClientDiagnostics } from './voiceClientDiagnostics.js'
import { parseVoiceSessionClaimBody } from './voiceChatProtocol.js'
import type { VoiceChatService, VoiceHttpResult } from './voiceChatService.js'

export const VOICE_CHAT_API_BASE_PATH = '/api/voice'

export type VoiceChatHttpApiDeps = {
  service: Pick<VoiceChatService, 'handleTokenRequest' | 'handleSpeakAccessRequest' | 'describeCreationOption'>
  /** profileId от СВЕЖА сесия (cookie), иначе null. */
  getSessionProfileId: (req: IncomingMessage) => string | null
  /** Пълна роля admin (същата проверка като при create_private_room). */
  isFullAdminProfile: (profileId: string) => boolean
  isAllowedOrigin: (req: IncomingMessage) => boolean
  readJsonBody: (req: IncomingMessage) => Promise<unknown>
  /** Етап 6 — липсващ -> маршрутът не се обслужва (404 от общия router). */
  clientDiagnostics?: VoiceClientDiagnostics
}

const NO_STORE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
}

function send(res: ServerResponse, result: VoiceHttpResult): void {
  if (res.headersSent || res.writableEnded) return
  const headers: Record<string, string> = { ...NO_STORE_HEADERS }
  const retryAfterMs = result.body.retryAfterMs
  if (result.status === 503 && typeof retryAfterMs === 'number') headers['Retry-After'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  res.writeHead(result.status, headers)
  res.end(JSON.stringify(result.body))
}

export function createVoiceChatHttpRequestHandler(
  deps: VoiceChatHttpApiDeps,
): (req: IncomingMessage, res: ServerResponse, requestUrl: URL) => Promise<boolean> {
  return async function handleVoiceChatApiRequest(req, res, requestUrl): Promise<boolean> {
    const pathname = requestUrl.pathname
    if (pathname === `${VOICE_CHAT_API_BASE_PATH}/create-option`) {
      if (req.method !== 'GET') {
        send(res, { status: 405, body: { ok: false, code: 'method_not_allowed' } })
        return true
      }
      const profileId = deps.getSessionProfileId(req)
      if (profileId === null) {
        send(res, { status: 401, body: { ok: false, code: 'not_authenticated' } })
        return true
      }
      try {
        const option = deps.service.describeCreationOption({ profileId, isFullAdmin: deps.isFullAdminProfile(profileId) })
        send(res, { status: 200, body: { ok: true, ...option } })
      } catch {
        send(res, { status: 500, body: { ok: false, code: 'internal_error' } })
      }
      return true
    }
    if (pathname === VOICE_CLIENT_REPORT_PATH && deps.clientDiagnostics !== undefined) {
      if (req.method !== 'POST') {
        send(res, { status: 405, body: { ok: false, code: 'method_not_allowed' } })
        return true
      }
      if (!deps.isAllowedOrigin(req)) {
        send(res, { status: 403, body: { ok: false, code: 'forbidden_origin' } })
        return true
      }
      const profileId = deps.getSessionProfileId(req)
      if (profileId === null) {
        send(res, { status: 401, body: { ok: false, code: 'not_authenticated' } })
        return true
      }
      let body: unknown
      try {
        body = await deps.readJsonBody(req)
      } catch {
        send(res, { status: 400, body: { ok: false, code: 'invalid_body' } })
        return true
      }
      const outcome = deps.clientDiagnostics.record(profileId, body)
      if (outcome === 'invalid') send(res, { status: 400, body: { ok: false, code: 'invalid_body' } })
      else if (outcome === 'limited') send(res, { status: 429, body: { ok: false, code: 'rate_limited' } })
      else send(res, { status: 200, body: { ok: true } })
      return true
    }
    if (pathname !== `${VOICE_CHAT_API_BASE_PATH}/token` && pathname !== `${VOICE_CHAT_API_BASE_PATH}/speak-access`) return false

    if (req.method !== 'POST') {
      send(res, { status: 405, body: { ok: false, code: 'method_not_allowed' } })
      return true
    }
    if (!deps.isAllowedOrigin(req)) {
      send(res, { status: 403, body: { ok: false, code: 'forbidden_origin' } })
      return true
    }
    const profileId = deps.getSessionProfileId(req)
    if (profileId === null) {
      send(res, { status: 401, body: { ok: false, code: 'not_authenticated' } })
      return true
    }
    let body: unknown
    try {
      body = await deps.readJsonBody(req)
    } catch {
      send(res, { status: 400, body: { ok: false, code: 'invalid_body' } })
      return true
    }
    const claim = parseVoiceSessionClaimBody(body)
    if (claim === null) {
      send(res, { status: 400, body: { ok: false, code: 'invalid_body' } })
      return true
    }

    const respond = (result: VoiceHttpResult): void => send(res, result)
    try {
      if (pathname.endsWith('/token')) {
        await deps.service.handleTokenRequest({ profileId, ...claim }, respond)
      } else {
        await deps.service.handleSpeakAccessRequest({ profileId, ...claim }, respond)
      }
    } catch {
      send(res, { status: 500, body: { ok: false, code: 'internal_error' } })
    }
    // Защита: всеки път трябва да е отговорил.
    if (!res.writableEnded) send(res, { status: 500, body: { ok: false, code: 'internal_error' } })
    return true
  }
}

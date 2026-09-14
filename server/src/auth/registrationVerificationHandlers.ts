import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore, AuthSessionSnapshot } from '../db/authStore.js'
import { sendRegistrationVerificationEmail } from './sendRegistrationVerificationEmail.js'

// ─── Constraints ────────────────────────────────────────────────────────────

const CODE_LENGTH = 6
const PENDING_ID_MAX_LENGTH = 128

// ─── Response bodies ──────────────────────────────────────────────────────────

const RESP_RATE_LIMITED = {
  ok: false,
  code: 'RATE_LIMITED',
  message: 'Направени са твърде много опити. Моля, опитайте отново по-късно.',
} as const

const RESP_NOT_FOUND = {
  ok: false,
  code: 'REGISTRATION_NOT_FOUND',
  message: 'Заявката за регистрация не беше намерена. Моля, регистрирайте се отново.',
} as const

const RESP_EXPIRED = {
  ok: false,
  code: 'REGISTRATION_EXPIRED',
  message: 'Регистрацията ви е изтекла. Моля, регистрирайте се отново.',
} as const

const RESP_EMAIL_DELIVERY_FAILED = {
  ok: false,
  code: 'EMAIL_DELIVERY_FAILED',
  message: 'В момента не успяхме да изпратим кода за потвърждение. Моля, опитайте отново след няколко минути.',
} as const

// ─── Handler context ──────────────────────────────────────────────────────────

export type RegistrationVerificationHandlerContext = {
  store: AuthStore
  getRequestIp: (req: IncomingMessage) => string
  sendJson: (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>) => void
  readBody: (req: IncomingMessage) => Promise<unknown>
  getFirstHeaderValue: (value: string | string[] | undefined) => string | null
  createSessionCookieHeader: (sessionToken: string, rememberMe: boolean) => string
  withPikaTeamGiftBypassFlag: (session: AuthSessionSnapshot) => unknown
}

function getStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  return typeof value === 'string' ? value : ''
}

// ─── POST /api/auth/resend-registration-code ─────────────────────────────────

export async function handleResendRegistrationCode(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RegistrationVerificationHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const pendingRegistrationId = getStringField(body as Record<string, unknown>, 'pendingRegistrationId')
  if (pendingRegistrationId.length === 0 || pendingRegistrationId.length > PENDING_ID_MAX_LENGTH) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const requestIp = ctx.getRequestIp(req)
  const result = ctx.store.resendRegistrationVerificationCode({
    pendingRegistrationId,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
  })

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      ctx.sendJson(res, 429, RESP_RATE_LIMITED)
      return
    }
    if (result.reason === 'expired') {
      ctx.sendJson(res, 410, RESP_EXPIRED)
      return
    }
    ctx.sendJson(res, 404, RESP_NOT_FOUND)
    return
  }

  const emailResult = await sendRegistrationVerificationEmail({
    toEmail: result.email,
    code: result.rawCode,
    expiresAt: result.expiresAt,
  })

  if (!emailResult.ok) {
    // Кодът вече Е regenerated в DB (result по-горе) въпреки delivery
    // провала — maskedEmail/expiresAt се връщат за консистентност с
    // register()'s 503 response-а (hardening pass §4), макар клиентът вече
    // да е в popup-а тук (по-малко критично, но same recovery contract).
    console.error('[registration-resend] Email delivery failed:', emailResult.message)
    ctx.sendJson(res, 503, { ...RESP_EMAIL_DELIVERY_FAILED, maskedEmail: result.maskedEmail, expiresAt: result.expiresAt })
    return
  }

  ctx.sendJson(res, 200, {
    ok: true,
    maskedEmail: result.maskedEmail,
    expiresAt: result.expiresAt,
  })
}

// ─── POST /api/auth/verify-registration-email ────────────────────────────────

export async function handleVerifyRegistrationEmail(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RegistrationVerificationHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const record = body as Record<string, unknown>
  const pendingRegistrationId = getStringField(record, 'pendingRegistrationId')
  const code = getStringField(record, 'code')
  // DEFAULT = CHECKED (spec §"VERIFICATION POPUP") — само explicit `false`
  // от клиента изключва remember-me, липсващо/друго поле остава default true.
  const rememberMe = record.rememberMe !== false

  if (pendingRegistrationId.length === 0 || pendingRegistrationId.length > PENDING_ID_MAX_LENGTH) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }
  if (!/^[0-9]{6}$/.test(code)) {
    ctx.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_CODE',
      message: 'Невалиден код. Моля, въведете 6-цифрения код от имейла.',
    })
    return
  }

  const requestIp = ctx.getRequestIp(req)
  const result = ctx.store.verifyRegistrationEmail({
    pendingRegistrationId,
    code,
    rememberMe,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
    userAgent: ctx.getFirstHeaderValue(req.headers['user-agent']),
  })

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      ctx.sendJson(res, 429, RESP_RATE_LIMITED)
      return
    }
    if (result.reason === 'expired') {
      ctx.sendJson(res, 410, RESP_EXPIRED)
      return
    }
    if (result.reason === 'too_many_attempts') {
      ctx.sendJson(res, 429, {
        ok: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Твърде много грешни опити. Изпратете нов код и опитайте отново.',
      })
      return
    }
    if (result.reason === 'invalid_code') {
      ctx.sendJson(res, 400, {
        ok: false,
        code: 'INVALID_CODE',
        message: 'Грешен код. Моля, опитайте отново.',
        attemptsRemaining: result.attemptsRemaining,
      })
      return
    }
    if (result.reason === 'email_taken') {
      ctx.sendJson(res, 409, { ok: false, code: 'EMAIL_TAKEN', message: 'Вече има регистрация с този email.' })
      return
    }
    if (result.reason === 'display_name_taken') {
      // Recoverable in-place (hardening pass §1) — клиентът трябва да
      // покаже "смени името" UI, НЕ generic "регистрирай се отново"
      // (pendingRegistrationId/код/24-часов прозорец остават валидни, виж
      // handleUpdatePendingRegistrationDisplayName по-долу).
      ctx.sendJson(res, 409, {
        ok: false,
        code: 'DISPLAY_NAME_TAKEN',
        message: 'Това потребителско име вече е заето. Моля, изберете друго име.',
      })
      return
    }
    ctx.sendJson(res, 404, RESP_NOT_FOUND)
    return
  }

  ctx.sendJson(
    res,
    200,
    { ok: true, session: ctx.withPikaTeamGiftBypassFlag(result.session) },
    { 'Set-Cookie': ctx.createSessionCookieHeader(result.sessionToken, rememberMe) },
  )
}

// ─── POST /api/auth/update-pending-registration-display-name ────────────────

export async function handleUpdatePendingRegistrationDisplayName(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RegistrationVerificationHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const record = body as Record<string, unknown>
  const pendingRegistrationId = getStringField(record, 'pendingRegistrationId')
  const displayName = getStringField(record, 'displayName')

  if (pendingRegistrationId.length === 0 || pendingRegistrationId.length > PENDING_ID_MAX_LENGTH) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const requestIp = ctx.getRequestIp(req)
  const result = ctx.store.updatePendingRegistrationDisplayName({
    pendingRegistrationId,
    displayName,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
  })

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      ctx.sendJson(res, 429, RESP_RATE_LIMITED)
      return
    }
    if (result.reason === 'expired') {
      ctx.sendJson(res, 410, RESP_EXPIRED)
      return
    }
    if (result.reason === 'invalid_display_name') {
      ctx.sendJson(res, 400, { ok: false, code: result.code, message: result.message })
      return
    }
    if (result.reason === 'display_name_taken') {
      ctx.sendJson(res, 409, {
        ok: false,
        code: 'DISPLAY_NAME_TAKEN',
        message: 'Това потребителско име вече е заето. Моля, изберете друго име.',
      })
      return
    }
    ctx.sendJson(res, 404, RESP_NOT_FOUND)
    return
  }

  ctx.sendJson(res, 200, { ok: true, maskedEmail: result.maskedEmail, expiresAt: result.expiresAt })
}

// ─── POST /api/auth/cancel-pending-registration ──────────────────────────────

export async function handleCancelPendingRegistration(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RegistrationVerificationHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const pendingRegistrationId = getStringField(body as Record<string, unknown>, 'pendingRegistrationId')
  if (pendingRegistrationId.length === 0 || pendingRegistrationId.length > PENDING_ID_MAX_LENGTH) {
    // "Смени имейла" (hardening pass §3) — идемпотентно/best-effort, НЕ
    // разкрива дали редът съществуваше. Дори malformed id получава ok:true
    // (клиентът просто иска да продължи напред към register формата).
    ctx.sendJson(res, 200, { ok: true })
    return
  }

  ctx.store.cancelPendingRegistration(pendingRegistrationId)
  ctx.sendJson(res, 200, { ok: true })
}

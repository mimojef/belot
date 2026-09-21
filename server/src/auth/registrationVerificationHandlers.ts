import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuthStore, AuthSessionSnapshot } from '../db/authStore.js'
import { sendRegistrationVerificationEmail } from './sendRegistrationVerificationEmail.js'
import { resolveRegistrationVerificationToken } from './registrationVerificationLinkToken.js'

// ─── Constraints ────────────────────────────────────────────────────────────

const CODE_LENGTH = 6
const PENDING_ID_MAX_LENGTH = 128
const VERIFICATION_TOKEN_MAX_LENGTH = 512

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
  /** Email → dedicated registration verification page — виж sendRegistrationVerificationEmail.ts's verificationPageUrl doc коментара. '' ако не е конфигуриран (fail-safe, не fail-closed). */
  registrationVerificationPageUrl: string
  /** Encrypted verificationToken resolution (§"PREFERRED TOKEN DESIGN") — СЪЩИЯТ registrationSecret като authStore.ts's hashVerificationCode/hmacRateLimitSubject (index.ts вече го подава на createAuthStore()), reuse-нат тук directно за token decrypt/authenticate, БЕЗ да минава през authStore-a (чиста crypto операция, не DB access). */
  registrationSecret: string
}

function getStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  return typeof value === 'string' ? value : ''
}

// ─── Backward-compatible identifier resolution ──────────────────────────────
// §"TOKEN НЕ ТРЯБВА ДА ВРЪЩА RAW PENDING ID КЪМ CLIENT" — endpoint-ите приемат
// ИЛИ existing pendingRegistrationId (стария popup flow, непроменен
// contract), ИЛИ нов verificationToken (dedicated email-link страницата).
// Server-ът resolve-ва към действителния pending_registration_id ВЪТРЕ в
// handler-а — тази стойност НИКОГА не се сериализира обратно в HTTP
// response-а, когато request-ът е дошъл through token (виж всеки call site
// по-долу: resolved.pendingRegistrationId се подава directно на
// authStore-функциите, никога echo-ва се в sendJson()).
type ResolvedIdentifier =
  | { kind: 'id'; pendingRegistrationId: string }
  | { kind: 'token'; pendingRegistrationId: string }
  | { kind: 'invalid' }
  | { kind: 'expired' }

function resolveIdentifier(
  ctx: RegistrationVerificationHandlerContext,
  record: Record<string, unknown>,
): ResolvedIdentifier {
  const verificationToken = getStringField(record, 'verificationToken')
  if (verificationToken.length > 0) {
    if (verificationToken.length > VERIFICATION_TOKEN_MAX_LENGTH) {
      return { kind: 'invalid' }
    }
    const resolved = resolveRegistrationVerificationToken(ctx.registrationSecret, verificationToken)
    if (!resolved.ok) {
      return { kind: 'invalid' }
    }
    if (resolved.isExpired) {
      // Authenticated expiresAt е минал — EXPIRED, независимо дали
      // pending_registrations редът все още физически съществува (виж
      // task spec-а §9/§10 "Този state НЕ зависи от това дали pending row
      // все още физически съществува"). Никакъв DB lookup дори не е нужен.
      return { kind: 'expired' }
    }
    return { kind: 'token', pendingRegistrationId: resolved.pendingRegistrationId }
  }

  // Backward compatibility — старият popup flow праща raw pendingRegistrationId.
  const pendingRegistrationId = getStringField(record, 'pendingRegistrationId')
  if (pendingRegistrationId.length === 0 || pendingRegistrationId.length > PENDING_ID_MAX_LENGTH) {
    return { kind: 'invalid' }
  }
  return { kind: 'id', pendingRegistrationId }
}

// ─── POST /api/auth/registration-verification-status ─────────────────────────
// Email → dedicated registration verification page (§"EMAIL → DIRECT
// REGISTRATION VERIFICATION PAGE"). PURE read, no session/cookie side
// effects — bootstrap-ва dedicated page-a от server-side данни (maskedEmail/
// expiresAt/resend eligibility), без да разчита на in-memory state от друг
// таб/popup. POST (не GET) — §7: verificationToken пътува в body, не query
// string, mirror на resend/verify/update-name endpoints-ите по-долу.

export async function handleRegistrationVerificationStatus(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RegistrationVerificationHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }

  const resolved = resolveIdentifier(ctx, body as Record<string, unknown>)
  if (resolved.kind === 'invalid') {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }
  if (resolved.kind === 'expired') {
    ctx.sendJson(res, 200, { ok: true, status: 'expired' })
    return
  }

  const requestIp = ctx.getRequestIp(req)
  const result = ctx.store.getPendingRegistrationVerificationStatus({
    pendingRegistrationId: resolved.pendingRegistrationId,
    ipAddress: requestIp === 'unknown' ? null : requestIp,
  })

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      ctx.sendJson(res, 429, RESP_RATE_LIMITED)
      return
    }
    // §10 "MISSING ROW BEFORE EXPIRY" — тук стигаме само ако redът вече е
    // missing, НО token-ът (ако имаше такъв) authenticated-но твърди, че
    // expiresAt все още НЕ е минал (иначе щяхме да върнем 'expired' по-горе
    // без DB lookup изобщо). Missing row + non-expired token е НЕ "expired"
    // — това е neutral "inactive request" случая (already verified ИЛИ
    // cancelled, не можем надеждно да различим, виж task spec-а §10 explicit
    // забрана да third-ваме категорично "already verified"). За raw-id
    // (стар popup) заявки без token, същият missing-row случай остава
    // просто generic not_found (съществуващо поведение, непроменено).
    if (resolved.kind === 'token') {
      ctx.sendJson(res, 200, { ok: true, status: 'inactive' })
      return
    }
    ctx.sendJson(res, 404, RESP_NOT_FOUND)
    return
  }

  if (result.status === 'expired') {
    ctx.sendJson(res, 200, { ok: true, status: 'expired' })
    return
  }

  ctx.sendJson(res, 200, {
    ok: true,
    status: 'valid',
    maskedEmail: result.maskedEmail,
    expiresAt: result.expiresAt,
    resendAvailableAtMs: result.resendAvailableAtMs,
  })
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

  const resolved = resolveIdentifier(ctx, body as Record<string, unknown>)
  if (resolved.kind === 'invalid') {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }
  if (resolved.kind === 'expired') {
    ctx.sendJson(res, 410, RESP_EXPIRED)
    return
  }
  const pendingRegistrationId = resolved.pendingRegistrationId

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
    // Resend: нов token, издаден за СЪЩИЯ pendingRegistrationId + СЪЩИЯ
    // expiresAt (never extended, виж resendRegistrationVerificationCode()
    // doc коментара) — виж task spec-а §13.O "Resend email генерира валиден
    // token за същата pending registration и същия expiresAt". Старият
    // token (от предишен email) остава ВАЛИДЕН И СЛЕД resend-а (mirror на
    // старото pendingRegistrationId-based поведение) — encrypted payload-ът
    // сочи СЪЩИЯ id, resend не го сменя.
    verificationPageUrl: ctx.registrationVerificationPageUrl || undefined,
    pendingRegistrationId,
    registrationSecret: ctx.registrationSecret,
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
  const code = getStringField(record, 'code')
  // DEFAULT = CHECKED (spec §"VERIFICATION POPUP") — само explicit `false`
  // от клиента изключва remember-me, липсващо/друго поле остава default true.
  // Dedicated page (§13.I/J) вече изпраща explicit true/false, mirror на
  // popup-a — server default-ът тук остава непроменен само за backward
  // compatibility с каквито и да е стари клиенти, не разчита на него.
  const rememberMe = record.rememberMe !== false

  const resolved = resolveIdentifier(ctx, record)
  if (resolved.kind === 'invalid') {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }
  if (resolved.kind === 'expired') {
    ctx.sendJson(res, 410, RESP_EXPIRED)
    return
  }
  const pendingRegistrationId = resolved.pendingRegistrationId

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
    // §10 "MISSING ROW BEFORE EXPIRY" — same neutral-state distinction като
    // status endpoint-а: token authenticated-но твърди non-expired, но
    // редът вече липсва (already verified ИЛИ cancelled — не можем
    // надеждно да различим, виж doc коментара в handleRegistrationVerificationStatus).
    if (resolved.kind === 'token') {
      ctx.sendJson(res, 200, { ok: false, code: 'REGISTRATION_INACTIVE', status: 'inactive' })
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
  const displayName = getStringField(record, 'displayName')

  const resolved = resolveIdentifier(ctx, record)
  if (resolved.kind === 'invalid') {
    ctx.sendJson(res, 400, RESP_NOT_FOUND)
    return
  }
  if (resolved.kind === 'expired') {
    ctx.sendJson(res, 410, RESP_EXPIRED)
    return
  }
  const pendingRegistrationId = resolved.pendingRegistrationId

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

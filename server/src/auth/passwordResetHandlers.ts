import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PasswordResetStore } from '../db/passwordResetStore.js'
import { normalizeEmail } from '../db/authHelpers.js'
import { sendPasswordResetEmail } from './sendPasswordResetEmail.js'

// ─── Rate limit constants ─────────────────────────────────────────────────────

const FORGOT_IP_MAX_EVENTS = 5
const FORGOT_IP_WINDOW_SECONDS = 30 * 60
const FORGOT_ACCOUNT_MAX_EVENTS = 3
const FORGOT_ACCOUNT_WINDOW_SECONDS = 60 * 60
const RESET_IP_MAX_EVENTS = 10
const RESET_IP_WINDOW_SECONDS = 15 * 60

// ─── Token constraints ────────────────────────────────────────────────────────

// base64url(32 bytes) = 43 chars. Generous upper bound за safety.
const RAW_TOKEN_MAX_LENGTH = 256

// ─── Response bodies ──────────────────────────────────────────────────────────

const RESP_RATE_LIMITED = {
  ok: false,
  code: 'RATE_LIMITED',
  message: 'Направени са твърде много опити. Моля, опитайте отново по-късно.',
} as const

const RESP_EMAIL_SENT = {
  ok: true,
  code: 'EMAIL_SENT',
  message:
    'На посочения от Вас имейл адрес е изпратен линк за смяна на паролата. Линкът е активен 30 минути. Проверете входящата си поща или папката „Спам".',
} as const

const RESP_EMAIL_DELIVERY_FAILED = {
  ok: false,
  code: 'EMAIL_DELIVERY_FAILED',
  message:
    'В момента не успяхме да изпратим линка за смяна на паролата. Моля, опитайте отново след няколко минути.',
} as const

// ─── Handler context ──────────────────────────────────────────────────────────

export type PasswordResetHandlerContext = {
  store: PasswordResetStore
  resetUrl: string
  getRequestIp: (req: IncomingMessage) => string
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  readBody: (req: IncomingMessage) => Promise<unknown>
}

// ─── POST /api/auth/forgot-password ──────────────────────────────────────────

export async function handleForgotPassword(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PasswordResetHandlerContext,
): Promise<void> {
  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, { ok: false, code: 'INVALID_EMAIL', message: 'Въведете валиден имейл адрес.' })
    return
  }

  const rawEmail = (body as Record<string, unknown>).email
  const normalizedEmail = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : null

  if (normalizedEmail === null) {
    ctx.sendJson(res, 400, { ok: false, code: 'INVALID_EMAIL', message: 'Въведете валиден имейл адрес.' })
    return
  }

  // IP rate limit — проверяваме преди да търсим акаунт.
  const requestIp = ctx.getRequestIp(req)
  const ipLimit = ctx.store.checkAndRecordRateLimit({
    scope: 'forgot-password-ip',
    rawSubject: requestIp,
    windowSeconds: FORGOT_IP_WINDOW_SECONDS,
    maxEvents: FORGOT_IP_MAX_EVENTS,
  })
  if (ipLimit.ok && ipLimit.limited) {
    ctx.sendJson(res, 429, RESP_RATE_LIMITED)
    return
  }

  // Търсим active акаунт.
  const account = ctx.store.findActiveAccountByNormalizedEmail(normalizedEmail)

  if (!account.found) {
    ctx.sendJson(res, 404, {
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
      message:
        'Няма регистрация с посочения от Вас имейл адрес. Проверете дали сте го въвели правилно или опитайте с друг имейл адрес.',
    })
    return
  }

  // Account rate limit — само при намерен акаунт.
  const accountLimit = ctx.store.checkAndRecordRateLimit({
    scope: 'forgot-password-account',
    rawSubject: account.accountId,
    windowSeconds: FORGOT_ACCOUNT_WINDOW_SECONDS,
    maxEvents: FORGOT_ACCOUNT_MAX_EVENTS,
  })
  if (accountLimit.ok && accountLimit.limited) {
    ctx.sendJson(res, 429, RESP_RATE_LIMITED)
    return
  }

  // Създаваме token.
  const tokenResult = ctx.store.createPasswordResetToken(account.accountId)
  if (!tokenResult.ok) {
    ctx.sendJson(res, 503, RESP_EMAIL_DELIVERY_FAILED)
    return
  }

  // Изпращаме имейл.
  const emailResult = await sendPasswordResetEmail({
    toEmail: account.email,
    rawToken: tokenResult.rawToken,
    resetUrl: ctx.resetUrl,
  })

  if (!emailResult.ok) {
    // Brevo провали — обезсилваме token-а (одит trail).
    ctx.store.revokePasswordResetToken(tokenResult.tokenId)
    // Логваме само техническата грешка без token или email.
    console.error('[forgot-password] Email delivery failed:', emailResult.message)
    ctx.sendJson(res, 503, RESP_EMAIL_DELIVERY_FAILED)
    return
  }

  ctx.sendJson(res, 200, RESP_EMAIL_SENT)
}

// ─── POST /api/auth/reset-password ───────────────────────────────────────────

export async function handleResetPassword(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PasswordResetHandlerContext,
): Promise<void> {
  // IP rate limit — преди body parsing.
  const requestIp = ctx.getRequestIp(req)
  const ipLimit = ctx.store.checkAndRecordRateLimit({
    scope: 'reset-password-ip',
    rawSubject: requestIp,
    windowSeconds: RESET_IP_WINDOW_SECONDS,
    maxEvents: RESET_IP_MAX_EVENTS,
  })
  if (ipLimit.ok && ipLimit.limited) {
    ctx.sendJson(res, 429, RESP_RATE_LIMITED)
    return
  }

  const body = await ctx.readBody(req)

  if (typeof body !== 'object' || body === null) {
    ctx.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'Линкът е невалиден или е изтекъл. Моля, поискайте нов.',
    })
    return
  }

  const record = body as Record<string, unknown>
  const rawToken = record.token
  const newPassword = record.newPassword

  if (
    typeof rawToken !== 'string' ||
    rawToken.length === 0 ||
    rawToken.length > RAW_TOKEN_MAX_LENGTH
  ) {
    ctx.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'Линкът е невалиден или е изтекъл. Моля, поискайте нов.',
    })
    return
  }

  if (typeof newPassword !== 'string') {
    ctx.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_PASSWORD',
      message: 'Новата парола трябва да бъде между 6 и 256 символа.',
    })
    return
  }

  const consumeResult = ctx.store.consumePasswordResetTokenAndChangePassword({
    rawToken,
    newPassword,
  })

  if (!consumeResult.ok) {
    if (consumeResult.reason === 'invalid_password') {
      ctx.sendJson(res, 400, {
        ok: false,
        code: 'INVALID_PASSWORD',
        message: 'Новата парола трябва да бъде между 6 и 256 символа.',
      })
      return
    }

    // invalid_token — не разкриваме конкретната причина.
    ctx.sendJson(res, 400, {
      ok: false,
      code: 'INVALID_OR_EXPIRED_TOKEN',
      message: 'Линкът е невалиден или е изтекъл. Моля, поискайте нов.',
    })
    return
  }

  ctx.sendJson(res, 200, {
    ok: true,
    code: 'PASSWORD_CHANGED',
    message: 'Паролата е сменена успешно. Можете да влезете с новата парола.',
  })
}

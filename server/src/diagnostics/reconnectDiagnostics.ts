// Етап 0 — диагностика на WebSocket връзките и възстановяването на игрова
// сесия. САМО наблюдение: нищо тук не променя поведение, timeout-и,
// правила за бот или защитата срещу едновременна игра.
//
// Правила за съдържанието (виж и checkReconnectDiagnostics.ts):
//  - всеки ред се сглобява от ИЗРИЧЕН списък полета (whitelist) — никога
//    не се сериализира входящо съобщение или обект от състоянието като цяло;
//  - никога: cookies, session token, reconnectToken, attempt proof, email,
//    displayName, IP (освен вече съществуващия remoteAddress в connect реда,
//    който зад nginx е loopback);
//  - текстовете от грешки се почистват от контролни символи (един лог ред =
//    един запис) и се ограничават по дължина;
//  - редове се пишат само при connect/close/resume_room/изключение — не при
//    нормален игрови трафик.

export type ResumeRoomMode = 'silent_reconnect' | 'silent_attach' | 'explicit'

export type ResumeRoomDiagnostic = {
  connectionId: string
  profileId: string | null
  roomId: string
  mode: ResumeRoomMode
  /** connectionId на предишната връзка (само при silent_reconnect). */
  reconnectOf: string | null
  /** Номер на опита за тихо възстановяване в текущото прекъсване (от клиента). */
  reconnectAttempt: number | null
  result: 'attached' | 'refused'
  /** 'ok' при attached; иначе фиксиран код на причината. */
  reason: string
  /** Конкретизация на причината (фиксирана стойност или почистен сървърен текст). */
  detail?: string | null
  seat?: string | null
  previousConnection?: 'live' | 'recently_closed' | null
  blockingConnectionId?: string | null
  blockingConnectionAttached?: boolean | null
  displacedConnectionIds?: readonly string[]
  /** Етап 4: подадени priorAttempts (брой) и колко от тях сървърът е потвърдил. */
  priorAttemptCount?: number
  verifiedPriorAttemptCount?: number
  /** Етап 4: собствени предишни опити, които биха блокирали, но са доказани (само id, никога proof). */
  provenOwnConnectionIds?: readonly string[]
}

const MAX_TEXT_LENGTH = 200

/** Един лог ред = един запис: маха контролни символи/нови редове и ограничава дължината. */
export function sanitizeDiagnosticText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  const text = String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function iso(now: number): string {
  return new Date(now).toISOString()
}

/**
 * Редът при приет WebSocket. Префиксът и полетата до profile= са непроменени
 * (съществуващи скриптове ги разчитат); добавен е само точен UTC timestamp.
 */
export function formatWsConnectedLogLine(input: {
  connectionId: string
  remoteAddress: string | null
  profileId: string | null
  /** Етап 2: handshake-ът е с удостоверителна сесия (auth=session) или без (auth=none). */
  authenticated?: boolean
  now?: number
}): string {
  const auth = input.authenticated === undefined ? '' : ` auth=${input.authenticated ? 'session' : 'none'}`
  return `[ws] client connected: ${input.connectionId} (${input.remoteAddress ?? 'unknown'}) profile=${input.profileId ?? 'none'} at=${iso(input.now ?? Date.now())}${auth}`
}

export function formatResumeRoomLogLine(entry: ResumeRoomDiagnostic, now: number = Date.now()): string {
  const payload: Record<string, unknown> = {
    at: iso(now),
    connectionId: entry.connectionId,
    profileId: entry.profileId,
    roomId: entry.roomId,
    mode: entry.mode,
    result: entry.result,
    reason: sanitizeDiagnosticText(entry.reason, 64),
  }
  if (entry.detail != null && entry.detail !== '') payload.detail = sanitizeDiagnosticText(entry.detail, 160)
  if (entry.reconnectOf != null) payload.reconnectOf = sanitizeDiagnosticText(entry.reconnectOf, 128)
  if (entry.reconnectAttempt != null) payload.reconnectAttempt = entry.reconnectAttempt
  if (entry.seat != null) payload.seat = entry.seat
  if (entry.previousConnection != null) payload.previousConnection = entry.previousConnection
  if (entry.blockingConnectionId != null) payload.blockingConnectionId = entry.blockingConnectionId
  if (entry.blockingConnectionAttached != null) payload.blockingConnectionAttached = entry.blockingConnectionAttached
  if (entry.displacedConnectionIds !== undefined && entry.displacedConnectionIds.length > 0) {
    payload.displacedConnectionIds = entry.displacedConnectionIds.slice(0, 10)
  }
  if (entry.priorAttemptCount !== undefined && entry.priorAttemptCount > 0) {
    payload.priorAttemptCount = entry.priorAttemptCount
    payload.verifiedPriorAttemptCount = entry.verifiedPriorAttemptCount ?? 0
  }
  if (entry.provenOwnConnectionIds !== undefined && entry.provenOwnConnectionIds.length > 0) {
    payload.provenOwnConnectionIds = entry.provenOwnConnectionIds.slice(0, 10)
  }
  return `[resume] ${JSON.stringify(payload)}`
}

export function formatWsHandlerErrorLogLine(input: {
  connectionId: string
  messageType: string
  error: unknown
  now?: number
}): string {
  const error = input.error
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  // Само първият stack frame (място в кода) — без съдържание на съобщението.
  const frame = error instanceof Error && typeof error.stack === 'string'
    ? (error.stack.split('\n').find((line) => line.trim().startsWith('at ')) ?? '').trim()
    : ''
  const payload: Record<string, unknown> = {
    at: iso(input.now ?? Date.now()),
    connectionId: input.connectionId,
    messageType: sanitizeDiagnosticText(input.messageType, 64),
    error: sanitizeDiagnosticText(`${name}: ${message}`, 300),
  }
  if (frame !== '') payload.frame = sanitizeDiagnosticText(frame, 200)
  return `[ws-handler-error] ${JSON.stringify(payload)}`
}

/**
 * Ограничава броя редове в прозорец (защита от наводняване на лога, напр. при
 * клиент, който умишлено предизвиква изключения). Пропуснатите се отчитат с
 * един обобщаващ ред при следващия запис след края на прозореца.
 */
export function createRateLimitedLogWriter(options: {
  maxPerWindow: number
  windowMs: number
  write: (line: string) => void
  now?: () => number
  tag: string
}): (line: string) => void {
  const now = options.now ?? Date.now
  let windowStartedAt = now()
  let writtenInWindow = 0
  let suppressedInWindow = 0
  return (line: string) => {
    const current = now()
    if (current - windowStartedAt >= options.windowMs) {
      if (suppressedInWindow > 0) {
        options.write(`${options.tag} ${JSON.stringify({ at: iso(current), suppressed: suppressedInWindow, windowMs: options.windowMs })}`)
      }
      windowStartedAt = current
      writtenInWindow = 0
      suppressedInWindow = 0
    }
    if (writtenInWindow >= options.maxPerWindow) {
      suppressedInWindow += 1
      return
    }
    writtenInWindow += 1
    options.write(line)
  }
}

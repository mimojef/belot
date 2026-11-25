// Етап 2 — непрозрачен идентификатор на удостоверителната сесия в 'connected'.
//
// Клиентът сравнява authRef на новата WS връзка с този отпреди прекъсването,
// за да потвърди „същата сесия“ без да чака /api/auth/me. Сигурност:
//  - HMAC-SHA256 на account_sessions.session_id със случаен ключ, генериран
//    при всеки старт на процеса — не съдържа и не разкрива sessionId, session
//    token или cookie; не може да се използва за удостоверяване; не е
//    свързваем между рестарти (при рестарт клиентът така или иначе презарежда);
//  - изпраща се само по собствената връзка в 'connected';
//  - сървърът НЕ разчита на него за нищо — resume_room проверява както досега
//    (reconnectToken, reconnectOf, профил, маса, друго устройство, банове).

import { createHmac, randomBytes } from 'node:crypto'

const AUTH_REF_LENGTH = 32

export function createConnectedAuthRefFactory(key: Buffer = randomBytes(32)): (sessionId: string | null) => string | null {
  return (sessionId) => {
    if (sessionId === null || sessionId.length === 0) return null
    return createHmac('sha256', key).update(sessionId, 'utf8').digest('base64url').slice(0, AUTH_REF_LENGTH)
  }
}

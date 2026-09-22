// Email → dedicated registration verification page (§"EMAIL → DIRECT
// REGISTRATION VERIFICATION PAGE").
//
// SECURITY MODEL (revised — "PUBLIC LOCATOR, not bearer capability"): this
// value is an opaque, authenticated-encrypted LOCATOR, not a security
// credential. Its ONLY job is to let the server resolve which pending
// registration a page/request is about, without exposing the raw
// pendingRegistrationId (still true — see resolveRegistrationVerificationLocator()
// doc коментара). Possession of the locator ALONE must never be sufficient to
// verify a registration, create a session, update the pending display name,
// cancel a pending registration, or resend/rotate the verification code — all
// of those require the 6-digit code too (or, for cancel, are not reachable via
// the locator at all — виж registrationVerificationHandlers.ts). This is
// deliberately safe to travel in a URL QUERY parameter, to be seen/logged by
// Brevo click tracking, nginx access logs, or browser history — none of that
// grants any capability by itself (виж final report-а "Brevo" секцията).
//
// Still AES-256-GCM (Node built-in node:crypto, established primitive-ниво в
// тоя codebase — виж authHelpers.ts's scryptSync/createHmac/timingSafeEqual
// usage, mirror pattern, НЕ нов security framework) — kept not because the
// locator is secret, but because it must remain UNFORGEABLE (an attacker must
// not be able to mint a locator for an arbitrary pendingRegistrationId) and
// its embedded expiresAt must remain tamper-proof:
//   - random 12-byte IV (GCM nonce) на всеки нов locator — same plaintext
//     произвежда различен ciphertext всеки път, IV никога не се преизползва.
//   - 16-byte authentication tag — tampering (дори 1 бит) прави
//     decrypt-опита да хвърли (Unsupported state or unable to authenticate
//     data), верифицирано директно.
//   - purpose field ВЪТРЕ в encrypted payload-а — domain separation, за да
//     не може locator, издаден за друга цел (ако някога добавим такива), да
//     бъде reuse-нат тук.
//   - expiresAt ВЪТРЕ в encrypted payload-а, authenticated (не може да бъде
//     подправен) — позволява EXPIRED state дори ако pending_registrations
//     редът вече е физически изтрит (opportunistic cleanup/cancel/verify
//     consume-on-success), виж resolveRegistrationVerificationLocator() doc
//     коментара за пълния "missing row" rationale.
//
// Key derivation: scryptSync(registrationSecret, DOMAIN_SEPARATION_SALT, 32)
// — mirror на authStore.ts's hashSessionToken() pattern
// (scryptSync(token, 'belot-v2-session-v1', 32)), НЕ директен reuse на
// registrationSecret bytes без derivation. registrationSecret е вече
// established ≥32-символен env secret (validateRateLimitSecret), използван
// за HMAC другаде в registration flow-а (hashVerificationCode,
// hmacRateLimitSubject) — derivation-ът тук произвежда КРИПТОГРАФСКИ
// НЕЗАВИСИМ 32-byte AES ключ от него, domain-separated от тези други
// употреби чрез distinct salt string.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const KEY_DERIVATION_SALT = 'registration-verification-link-token-v1'
const AES_KEY_LENGTH = 32
const GCM_IV_LENGTH = 12
const GCM_AUTH_TAG_LENGTH = 16
const LOCATOR_PURPOSE = 'registration-verification-page'

function deriveLocatorKey(registrationSecret: string): Buffer {
  return scryptSync(registrationSecret, KEY_DERIVATION_SALT, AES_KEY_LENGTH)
}

type LocatorPayload = {
  /** pending_registration_id — НИКОГА не се връща обратно на клиента decrypted, виж resolveRegistrationVerificationLocator() call sites doc коментарите за "server resolves internally" contract-а. */
  id: string
  /** authenticated expiresAt (ISO string) — СЪЩАТА стойност като pending_registrations.expires_at в момента на издаване на locator-а (register()/resend()), никога после променяна. */
  exp: string
  purpose: typeof LOCATOR_PURPOSE
}

/**
 * Издава нов opaque locator за дадена pending registration. Извиква се от
 * sendRegistrationVerificationEmail() call sites-ите (register()/resend()) —
 * винаги СЪС същия expiresAt, който вече е committнат в DB-то за този ред
 * (никога преизчислен наново), за да остане authenticated expiry-то
 * consistent с реалния DB прозорец.
 */
export function createRegistrationVerificationLocator(
  registrationSecret: string,
  pendingRegistrationId: string,
  expiresAt: string,
): string {
  const key = deriveLocatorKey(registrationSecret)
  const iv = randomBytes(GCM_IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload: LocatorPayload = { id: pendingRegistrationId, exp: expiresAt, purpose: LOCATOR_PURPOSE }
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url')
}

export type ResolvedRegistrationVerificationLocator =
  | { ok: true; pendingRegistrationId: string; expiresAt: string; isExpired: boolean }
  | { ok: false; reason: 'invalid' }

/**
 * Decrypt + authenticate + purpose-check + (authenticated) expiry-check.
 * PURE, stateless — НЕ докосва DB-то, никакъв lookup тук. Server-side ONLY
 * извикваща точка — resolved-ият pendingRegistrationId НИКОГА не се
 * сериализира обратно в HTTP response-а, само се подава директно към
 * authStore-функциите вътре в handler-а.
 *
 * isExpired=true (authenticated expiresAt < now) е ВАЛИДНО, НЕ грешка —
 * caller-ът решава дали да покаже EXPIRED state вместо да прави DB lookup
 * изобщо (виж "missing row before expiry" doc коментара в
 * registrationVerificationHandlers.ts за защо това е важно: DB row-ът може
 * вече да е физически изтрит по причина, различна от expiry — cancel,
 * successful verify — locator-ът сам по себе си не може и не претендира да
 * различи тези случаи, само дали authenticated-ото expiresAt е минало).
 */
export function resolveRegistrationVerificationLocator(
  registrationSecret: string,
  locator: string,
): ResolvedRegistrationVerificationLocator {
  let decoded: Buffer
  try {
    decoded = Buffer.from(locator, 'base64url')
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  const minLength = GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH
  if (decoded.length <= minLength) {
    return { ok: false, reason: 'invalid' }
  }

  const iv = decoded.subarray(0, GCM_IV_LENGTH)
  const authTag = decoded.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH)
  const ciphertext = decoded.subarray(GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH)

  try {
    const key = deriveLocatorKey(registrationSecret)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = JSON.parse(plaintext.toString('utf8')) as Partial<LocatorPayload>

    if (
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      typeof payload.exp !== 'string' ||
      payload.purpose !== LOCATOR_PURPOSE
    ) {
      return { ok: false, reason: 'invalid' }
    }

    const expiresAtMs = new Date(payload.exp).getTime()
    if (Number.isNaN(expiresAtMs)) {
      return { ok: false, reason: 'invalid' }
    }

    return {
      ok: true,
      pendingRegistrationId: payload.id,
      expiresAt: payload.exp,
      isExpired: expiresAtMs <= Date.now(),
    }
  } catch {
    // GCM authentication failure (tampered ciphertext/tag/IV), malformed
    // JSON, или каквато и да е друга decode грешка — всички third-ват се
    // еднакво като invalid, никога leak-ват детайли за причината.
    return { ok: false, reason: 'invalid' }
  }
}

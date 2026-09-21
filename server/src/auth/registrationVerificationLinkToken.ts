// Email → dedicated registration verification page (§"EMAIL → DIRECT
// REGISTRATION VERIFICATION PAGE"). Stateless, scoped, AUTHENTICATED
// ENCRYPTION token — deliberately NOT a signed-but-readable payload (viж
// task spec-а: "HMAC гарантира integrity/authenticity, НО payload-ът остава
// четим... Искам URL token-ът да НЕ разкрива raw pendingRegistrationId").
//
// AES-256-GCM (Node built-in node:crypto, established primitive-ниво в тоя
// codebase — виж authHelpers.ts's scryptSync/createHmac/timingSafeEqual
// usage, mirror pattern, НЕ нов security framework):
//   - random 12-byte IV (GCM nonce) на всеки нов token — same plaintext
//     произвежда различен ciphertext всеки път, IV никога не се преизползва.
//   - 16-byte authentication tag — tampering (дори 1 бит) прави
//     decrypt-опита да хвърли (Unsupported state or unable to authenticate
//     data), верифицирано directно.
//   - purpose field ВЪТРЕ в encrypted payload-а — domain separation, за да
//     не може token, издаден за друга цел (ако някога добавим такива), да
//     бъде reuse-нат тук.
//   - expiresAt ВЪТРЕ в encrypted payload-а, authenticated (не може да бъде
//     подправен) — позволява EXPIRED state дори ако pending_registrations
//     редът вече е физически изтрит (opportunistic cleanup/cancel/verify
//     consume-on-success), виж resolveRegistrationVerificationToken() doc
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
const TOKEN_PURPOSE = 'registration-verification-page'

function deriveTokenKey(registrationSecret: string): Buffer {
  return scryptSync(registrationSecret, KEY_DERIVATION_SALT, AES_KEY_LENGTH)
}

type TokenPayload = {
  /** pending_registration_id — НИКОГА не се връща обратно на клиента decrypted, виж resolveRegistrationVerificationToken() call sites doc коментарите за "server resolves internally" contract-а. */
  id: string
  /** authenticated expiresAt (ISO string) — СЪЩАТА стойност като pending_registrations.expires_at в момента на издаване на token-а (register()/resend()), никога после променяна. */
  exp: string
  purpose: typeof TOKEN_PURPOSE
}

/**
 * Издава нов token за дадена pending registration. Извиква се от
 * sendRegistrationVerificationEmail() call sites-ите (register()/resend()) —
 * винаги СЪС същия expiresAt, който вече е committнат в DB-то за този ред
 * (никога преизчислен наново), за да остане authenticated expiry-то
 * consistent с реалния DB прозорец.
 */
export function createRegistrationVerificationToken(
  registrationSecret: string,
  pendingRegistrationId: string,
  expiresAt: string,
): string {
  const key = deriveTokenKey(registrationSecret)
  const iv = randomBytes(GCM_IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload: TokenPayload = { id: pendingRegistrationId, exp: expiresAt, purpose: TOKEN_PURPOSE }
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64url')
}

export type ResolvedRegistrationVerificationToken =
  | { ok: true; pendingRegistrationId: string; expiresAt: string; isExpired: boolean }
  | { ok: false; reason: 'invalid' }

/**
 * Decrypt + authenticate + purpose-check + (authenticated) expiry-check.
 * PURE, stateless — НЕ докосва DB-то, никакъв lookup тук. Server-side ONLY
 * извикваща точка (виж task spec-а §7 "Server трябва вътрешно да resolve-ва
 * token-а до pendingRegistrationId... Dedicated flow API трябва да работи с
 * token-а" — resolved-ият pendingRegistrationId НИКОГА не се сериализира
 * обратно в HTTP response-а, само се подава директно към
 * authStore-функциите вътре в handler-а).
 *
 * isExpired=true (authenticated expiresAt < now) е ВАЛИДНО, НЕ грешка —
 * caller-ът решава дали да покаже EXPIRED state вместо да прави DB lookup
 * изобщо (виж "missing row before expiry" doc коментара в
 * registrationVerificationHandlers.ts за защо това е важно: DB row-ът може
 * вече да е физически изтрит по причина, различна от expiry — cancel,
 * successful verify — token-ът сам по себе си не може и не претендира да
 * различи тези случаи, само дали authenticated-ото expiresAt е минало).
 */
export function resolveRegistrationVerificationToken(
  registrationSecret: string,
  token: string,
): ResolvedRegistrationVerificationToken {
  let decoded: Buffer
  try {
    decoded = Buffer.from(token, 'base64url')
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
    const key = deriveTokenKey(registrationSecret)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const payload = JSON.parse(plaintext.toString('utf8')) as Partial<TokenPayload>

    if (
      typeof payload.id !== 'string' ||
      payload.id.length === 0 ||
      typeof payload.exp !== 'string' ||
      payload.purpose !== TOKEN_PURPOSE
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
    // еднакво като invalid, никога leak-ват детайли за причината (виж task
    // spec-а Flow 6 "Не leak-вай дали конкретен email/account съществува").
    return { ok: false, reason: 'invalid' }
  }
}

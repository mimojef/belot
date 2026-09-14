import { createHash, createHmac, randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const EMAIL_MAX_LENGTH = 254
const PASSWORD_MIN_LENGTH = 6
const PASSWORD_MAX_LENGTH = 256
const SCRYPT_KEY_LENGTH = 64

const RATE_LIMIT_HMAC_PREFIX = 'password-reset-rate-limit-v1'
const RATE_LIMIT_SECRET_MIN_LENGTH = 32

// ─── Email ──────────────────────────────────────────────────────────────────

export function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLocaleLowerCase('en-US')
  if (!trimmed || trimmed.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(trimmed)) {
    return null
  }
  return trimmed
}

// ─── Password ────────────────────────────────────────────────────────────────

export function validatePassword(value: string): boolean {
  return value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH
}

export function createPasswordHash(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex')
  return `scrypt:${salt}:${hash}`
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false

  const [, salt, expectedHashHex] = parts
  if (!salt || !expectedHashHex) return false

  const actualHash = scryptSync(password, salt, SCRYPT_KEY_LENGTH)
  const expectedHash = Buffer.from(expectedHashHex, 'hex')

  if (actualHash.length !== expectedHash.length) return false
  return timingSafeEqual(actualHash, expectedHash)
}

// ─── Reset token ─────────────────────────────────────────────────────────────

export function generateRawResetToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashResetToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

// ─── Rate limit subject hash ─────────────────────────────────────────────────
// HMAC-SHA256 с domain separation.
// Защитава срещу offline guessing на IPv4 пространството (2^32 адреса).
// secret трябва да е минимум 32 символа и да идва от env config на store-а.

export function validateRateLimitSecret(secret: string): boolean {
  return secret.length >= RATE_LIMIT_SECRET_MIN_LENGTH
}

export function hmacRateLimitSubject(scope: string, rawSubject: string, secret: string): string {
  // domain-separated input: prefix:scope:rawSubject
  const input = `${RATE_LIMIT_HMAC_PREFIX}:${scope}:${rawSubject}`
  return createHmac('sha256', secret).update(input).digest('hex')
}

// ─── Email verification code (registration pending-first flow) ────────────────
// 6-цифрен код (000000-999999) — НИСКА ентропия (само 1 000 000 възможности),
// за разлика от reset token-а (32 random bytes) по-горе. Plain SHA-256 (без
// secret) би бил offline brute-forceable за <1 секунда от кой да е с DB read
// достъп — затова HMAC-SHA256 с domain separation, mirror на
// hmacRateLimitSubject по-горе (същия secret validation contract:
// validateRateLimitSecret, ≥32 символа от env).

const VERIFICATION_CODE_HMAC_PREFIX = 'email-verification-code-v1'
const VERIFICATION_CODE_MIN = 0
const VERIFICATION_CODE_MAX = 1_000_000

export function generateVerificationCode(): string {
  // crypto.randomInt е cryptographically secure и unbiased (за разлика от
  // Math.random() % 1_000_000) — виж Node.js crypto docs.
  return randomInt(VERIFICATION_CODE_MIN, VERIFICATION_CODE_MAX).toString().padStart(6, '0')
}

export function hashVerificationCode(code: string, secret: string): string {
  const input = `${VERIFICATION_CODE_HMAC_PREFIX}:${code}`
  return createHmac('sha256', secret).update(input).digest('hex')
}

export function verifyVerificationCode(code: string, secret: string, storedHash: string): boolean {
  const candidateHex = hashVerificationCode(code, secret)
  const candidate = Buffer.from(candidateHex, 'hex')
  let expected: Buffer
  try {
    expected = Buffer.from(storedHash, 'hex')
  } catch {
    return false
  }
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

// ─── Masked email (client-facing display, never reveals full address) ─────────

export function maskEmailForDisplay(normalizedEmail: string): string {
  const atIndex = normalizedEmail.indexOf('@')
  if (atIndex <= 0) return normalizedEmail
  const local = normalizedEmail.slice(0, atIndex)
  const domain = normalizedEmail.slice(atIndex)
  const visiblePrefix = local.slice(0, 1)
  return `${visiblePrefix}***${domain}`
}

// Публично само за тестване — не използвай в production код директно.
export { randomUUID as generateUUID }

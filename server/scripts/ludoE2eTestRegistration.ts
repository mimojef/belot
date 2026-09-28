/**
 * ludoE2eTestRegistration.ts — test-only helper за Ludo end-to-end тестовете
 * (checkLudoEconomy / checkLudoForfeitTurnSkip / checkLudoExplicitForfeit /
 * checkLudoServerRestartRecovery), които регистрират реални потребители през
 * POST /api/auth/register на изолиран spawn-нат сървър.
 *
 * Тези тестове тестват Ludo, не email verification. Текущият register flow
 * (authStore.register()) изисква:
 *   - конфигуриран registration secret (EMAIL_VERIFICATION_CODE_SECRET) —
 *     проверява се ПРЕДИ режима, т.е. и за 'direct';
 *   - валиден visitorId (UUID v1-5 формат, VISITOR_ID_FORMAT_RE);
 *   - registration_verification_mode = 'direct', за да върне сесия веднага
 *     (production default-ът 'email_code' връща pending регистрация).
 *
 * Режимът се задава в ИЗОЛИРАНАТА тестова база през официалния
 * adminSettingsStore.updateSettings() (същия writer като Админ панел ->
 * Настройки -> "Метод за регистрация"); настройката се чете live при всяка
 * register() заявка и е persisted, т.е. оцелява и тестовите restart-и.
 * Production код/default-и не се променят.
 */

import { createHash } from 'node:crypto'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'

// Test-only стойност (≥32 символа) само за изолирания spawn-нат сървър.
const LUDO_E2E_TEST_REGISTRATION_SECRET = 'ludo-e2e-test-only-registration-secret-0123456789'

export function withLudoE2eRegistrationEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, EMAIL_VERIFICATION_CODE_SECRET: LUDO_E2E_TEST_REGISTRATION_SECRET }
}

// Детерминистичен, уникален per (runId, tag) UUID v4-shaped visitorId —
// не е реален visitor ID.
export function createLudoE2eTestVisitorId(runId: string, tag: string): string {
  const hex = createHash('sha256').update(`ludo-e2e-visitor:${runId}:${tag}`).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// Direct регистрацията е rate-limit-ната per IP (REGISTRATION_DIRECT_IP_MAX_PER_WINDOW
// в authStore.ts), а всички тестови потребители идват от 127.0.0.1. Сървърът
// взима client IP-то от X-Forwarded-For (index.ts::getRequestIp — production
// е зад proxy), затова всеки тестов потребител подава уникален,
// детерминистичен адрес от 198.18.0.0/15 (RFC 2544 benchmark range — не е
// реален client адрес). Production rate limit-ът остава непроменен.
export function createLudoE2eTestRegistrationHeaders(runId: string, tag: string): Record<string, string> {
  const hash = createHash('sha256').update(`ludo-e2e-ip:${runId}:${tag}`).digest()
  const ip = `198.${18 + (hash[0]! & 0x1)}.${hash[1]!}.${1 + (hash[2]! % 254)}`
  return { 'X-Forwarded-For': ip }
}

export async function enableDirectRegistrationInIsolatedDb(dbFile: string): Promise<void> {
  const settingsStore = await createAdminSettingsStore(dbFile)
  try {
    const result = settingsStore.updateSettings({ registrationVerificationMode: 'direct' })
    if (!result.ok) throw new Error(`registration_verification_mode=direct failed: ${result.message}`)
    if (settingsStore.getSettings().registrationVerificationMode !== 'direct') {
      throw new Error('registration_verification_mode не е "direct" след updateSettings()')
    }
  } finally {
    settingsStore.close()
  }
}

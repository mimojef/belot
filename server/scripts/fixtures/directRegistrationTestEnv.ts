// Тестова среда за регистрация през реалния POST /api/auth/register.
//
// Production регистрацията изисква (и тук нищо не се заобикаля в кода):
//   * secret за кодовете за потвърждение (EMAIL_VERIFICATION_CODE_SECRET или
//     fallback PASSWORD_RESET_RATE_LIMIT_SECRET, ≥32 символа) — без него
//     сървърът отказва регистрация ("временно не е налична", fail-closed);
//   * visitorId (UUID) в тялото на заявката;
//   * режим на потвърждение от admin_settings: по подразбиране 'email_code';
//     'direct' е легитимен режим, който администраторът избира от панела.
//
// Тестовете, които проверяват игри/турнири (не самата регистрация), включват
// 'direct' в СОБСТВЕНАТА си временна база и подават visitorId. Лимитът за
// direct регистрации (10/час от IP) се нулира преди всяка регистрация — всички
// заявки идват от 127.0.0.1 и лимитът е извън обхвата на тези тестове.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const TEST_REGISTRATION_SECRET = 'test-registration-secret-0123456789abcdef'

let configuredDatabaseFile: string | null = null

/** Включва 'direct' режима във временната тестова база (след миграциите — т.е. след старта на сървъра). */
export function configureDirectRegistrationForTest(databaseFile: string): void {
  configuredDatabaseFile = databaseFile
  const db = new DatabaseSync(databaseFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()
  } finally {
    db.close()
  }
}

/** Вика се преди всяка регистрация: нулира лимита за direct регистрации от 127.0.0.1 и връща visitorId. */
export function prepareDirectRegistration(): { visitorId: string } {
  if (configuredDatabaseFile === null) throw new Error('configureDirectRegistrationForTest() не е извикан')
  const db = new DatabaseSync(configuredDatabaseFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
  } finally {
    db.close()
  }
  return { visitorId: randomUUID() }
}
